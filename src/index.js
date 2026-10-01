/**
 * dsh-claude-memory — surface Claude Code's existing memory inside DeepSeek Harness.
 *
 * Why this exists: when a Claude Code quota runs out mid-task, the next agent
 * should be able to pick the work up. Claude Code already wrote down what it
 * learned as markdown under `~/.claude/projects/<key>/memory/`. This plugin
 * reads that store and puts a bounded, redacted view of it in front of the DSH
 * model, plus a tool to open any memory on demand.
 *
 * Design constraints, in order:
 *  1. **Read-only by default.** Nothing under `~/.claude` is written unless
 *     `enableWrite` is on; then only the current project's memory directory.
 *  2. **Confined.** Every read resolves through `realpath` and must land inside
 *     the Claude Code home, so a symlinked memory file cannot escape.
 *  3. **Redacted.** Memory notes on this machine contain live credentials, and
 *     DSH sends context to a different provider than Claude Code does. Every
 *     contributed byte passes the redactor.
 *  4. **Small by default.** The system prompt carries only the index; full
 *     bodies arrive through the tool, one file at a time.
 *  5. **Zero dependencies.** No `@deepseek-ai/*` import, so the plugin resolves
 *     in a profile whose `node_modules` is empty, and the audit surface stays
 *     one small tree.
 *
 * Two harness contracts shape the implementation:
 *
 *  - Prompt providers are **synchronous**: `dsh-system-prompt` resolves `text`
 *    without awaiting it (`lib/index.js:330,337`), so this plugin keeps a
 *    synchronously refreshed cache and never returns a promise from `text`.
 *  - The directory that matters is the **session's** working directory, not the
 *    server process's. `process.cwd()` is wherever `dsh` was launched, so the
 *    plugin registers global sections as a fallback and shadows them per agent
 *    from `agent/created` using `agent.session.header.cwd` — the same source the
 *    first-party `dsh-agent-instructions` loader reads (`lib/index.js:1111`).
 *
 * @module dsh-claude-memory
 */

import { join, resolve } from 'node:path'
import {
  MEMORY_DIRNAME,
  encodeProjectKey,
  formatIndexDate,
  findGitRoot,
  listMemoryProjects,
  resolveClaudeHome,
  selectProjects,
} from './paths.js'
import { readInstructionsWithImports, readProjectIndex } from './store.js'
import { renderGlobalBlock, renderMemoryBlock, renderWriteInstructions } from './render.js'
import { redactText } from './redact.js'
import { createClaudeMemoryTool } from './tool.js'

export const name = 'claude-memory'

/** Services this plugin needs; absent, the plugin must not activate. */
export const inject = ['systemPrompt', 'tools']

/** Prompt placement: just after the deployment persona, before tool prose. */
const SECTION_ORDER = { global: 10, memory: 11, instructions: 12 }

/** Maximum distinct working directories cached at once. */
const MAX_CACHES = 32

const DEFAULTS = {
  includeDescendants: true,
  descendantLimit: 12,
  maxIndexBytes: 24000,
  maxGlobalBytes: 6000,
  enableGlobalInstructions: true,
  enableMemory: true,
  enableTool: true,
  enableWrite: false,
  redactMode: 'on',
  refreshMs: 20000,
}

/** Coerce a config value to a boolean with a default. */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/** Coerce a config value to a finite positive number with a default. */
function num(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Normalize raw plugin configuration.
 *
 * @param {object} raw - configuration from the profile patch.
 * @returns {object} fully defaulted configuration.
 */
function normalizeConfig(raw = {}) {
  const redactMode = ['on', 'report', 'off'].includes(raw.redactMode) ? raw.redactMode : DEFAULTS.redactMode
  return {
    claudeHome: resolveClaudeHome(raw),
    // Fallback only: a live agent's session cwd wins over this.
    cwd: resolve(String(raw.cwd ?? process.cwd())),
    includeDescendants: bool(raw.includeDescendants, DEFAULTS.includeDescendants),
    descendantLimit: num(raw.descendantLimit, DEFAULTS.descendantLimit),
    maxIndexBytes: num(raw.maxIndexBytes, DEFAULTS.maxIndexBytes),
    maxGlobalBytes: num(raw.maxGlobalBytes, DEFAULTS.maxGlobalBytes),
    enableGlobalInstructions: bool(raw.enableGlobalInstructions, DEFAULTS.enableGlobalInstructions),
    enableMemory: bool(raw.enableMemory, DEFAULTS.enableMemory),
    enableTool: bool(raw.enableTool, DEFAULTS.enableTool),
    // Writing needs the tool; without it there is no way to save.
    enableWrite: bool(raw.enableTool, DEFAULTS.enableTool) && bool(raw.enableWrite, DEFAULTS.enableWrite),
    redactMode,
    refreshMs: num(raw.refreshMs, DEFAULTS.refreshMs),
  }
}

/**
 * Read the working directory recorded on an agent's session.
 *
 * @param {object} agent - a live DSH agent.
 * @returns {string|null} absolute cwd, or null when unavailable.
 */
function agentCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? resolve(cwd) : null
}

/**
 * Where saves for a working directory land.
 *
 * The same rule the store's other writer uses: the git repository root (the
 * main worktree for a linked one), else the directory itself. Never a guessed
 * neighbour, so a save cannot end up in another project's memory.
 *
 * @param {string} claudeHome - resolved Claude home.
 * @param {string} cwd - session working directory.
 * @returns {{key: string, memoryDir: string}} write target.
 */
function writeTarget(claudeHome, cwd) {
  const key = encodeProjectKey(findGitRoot(cwd) ?? cwd)
  return { key, memoryDir: join(claudeHome, 'projects', key, MEMORY_DIRNAME) }
}

/**
 * Register the plugin.
 *
 * @param {object} ctx - Cordis context carrying `systemPrompt` and `tools`.
 * @param {object} [rawConfig] - profile configuration.
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)

  /** Per-working-directory render cache: cwd → block state. */
  const caches = new Map()

  /** Create (or fetch) the cache entry for one working directory. */
  function cacheFor(cwd) {
    let entry = caches.get(cwd)
    if (entry !== undefined) return entry
    if (caches.size >= MAX_CACHES) {
      const oldest = caches.keys().next()
      if (oldest.done !== true) caches.delete(oldest.value)
    }
    entry = { memoryBlock: '', globalBlock: '', instructionsBlock: '', projects: [], currentKey: null, lastRefreshAt: 0, error: null }
    caches.set(cwd, entry)
    return entry
  }

  /** Refresh one working directory's cache when it is older than `refreshMs`. */
  function refreshIfStale(cwd) {
    const entry = cacheFor(cwd)
    if (Date.now() - entry.lastRefreshAt >= config.refreshMs) refresh(cwd)
    return entry
  }

  /** Re-read the store for one working directory and rebuild both blocks. */
  function refresh(cwd) {
    const entry = cacheFor(cwd)
    entry.lastRefreshAt = Date.now()
    try {
      const projects = listMemoryProjects(config.claudeHome)
      // Claude Code files memory under the enclosing git repository root, so a
      // subdirectory of a repo must resolve to the same project Claude Code used.
      const gitRoot = findGitRoot(cwd)
      const { current, related, match } = selectProjects({
        projects,
        cwd,
        gitRoot,
        includeDescendants: config.includeDescendants,
        descendantLimit: config.descendantLimit,
      })

      // Annotate entry counts and dates so the catalog and the "other projects"
      // list are useful without reading every index body.
      const annotated = projects.map((p) => {
        const read = readProjectIndex(config.claudeHome, p)
        return { ...p, entries: read !== null ? read.entries : 0, date: formatIndexDate(p.mtimeMs) }
      })
      const annotatedByKey = new Map(annotated.map((p) => [p.key, p]))
      const currentProject = current === null ? null : annotatedByKey.get(current.key) ?? current
      const relatedProjects = related.map((p) => annotatedByKey.get(p.key) ?? p)

      if (config.enableMemory) {
        const index = currentProject === null ? null : readProjectIndex(config.claudeHome, currentProject)
        const rawIndex = index === null ? null : { text: redactText(index.text, { mode: config.redactMode }) }
        const redactedIndex = rawIndex === null ? null : { ...index, text: rawIndex.text.text }
        const hits = rawIndex === null ? {} : rawIndex.text.hits
        entry.memoryBlock = renderMemoryBlock({
          project: currentProject,
          index: redactedIndex,
          related: relatedProjects,
          all: annotated,
          match,
          cwd,
          gitRoot,
          maxBytes: config.maxIndexBytes,
          hits,
          writable: config.enableWrite,
        })
      } else {
        entry.memoryBlock = ''
      }

      if (config.enableGlobalInstructions) {
        const instructions = readInstructionsWithImports(config.claudeHome, resolve(config.claudeHome, 'CLAUDE.md'))
        const redacted = instructions === null ? null : redactText(instructions.text, { mode: config.redactMode })
        entry.globalBlock = renderGlobalBlock(
          instructions === null || redacted === null ? null : { ...instructions, text: redacted.text },
          config.maxGlobalBytes,
          redacted === null ? {} : redacted.hits,
        )
      } else {
        entry.globalBlock = ''
      }

      if (config.enableWrite) {
        const target = writeTarget(config.claudeHome, cwd)
        entry.instructionsBlock = renderWriteInstructions({
          key: target.key,
          exists: annotatedByKey.has(target.key),
        })
      }

      entry.projects = annotated
      entry.currentKey = currentProject === null ? null : currentProject.key
      entry.error = null
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error)
      entry.memoryBlock = ''
      entry.globalBlock = ''
      entry.instructionsBlock = ''
    }
  }

  /** Register the two sections into one prompt registry (global or agent-scoped). */
  function registerSections(systemPrompt, cwd) {
    systemPrompt.section({
      name: 'claude-memory:global',
      order: SECTION_ORDER.global,
      text: () => refreshIfStale(cwd).globalBlock,
    })
    systemPrompt.section({
      name: 'claude-memory:memory',
      order: SECTION_ORDER.memory,
      text: () => refreshIfStale(cwd).memoryBlock,
    })
    if (config.enableWrite) {
      systemPrompt.section({
        name: 'claude-memory:instructions',
        order: SECTION_ORDER.instructions,
        text: () => refreshIfStale(cwd).instructionsBlock,
      })
    }
  }

  // Seed the fallback before the first request so the first prompt is complete.
  refresh(config.cwd)
  registerSections(ctx.systemPrompt, config.cwd)

  // A session's working directory is authoritative and differs from the server's
  // cwd. Agent-scoped sections shadow the global ones with the same name.
  let shadowed = 0
  ctx.on('agent/created', ({ agent }) => {
    const cwd = agentCwd(agent)
    if (cwd === null || cwd === config.cwd) return
    try {
      registerSections(agent.ctx.systemPrompt, cwd)
      shadowed += 1
    } catch (error) {
      ctx.logger?.warn?.(
        `[claude-memory] could not register agent-scoped sections for ${cwd}: ${error?.message ?? error}`,
      )
    }
  })

  if (config.enableTool) {
    const tool = createClaudeMemoryTool({
      claudeHome: config.claudeHome,
      redactMode: config.redactMode,
      // Resolve against the calling agent's session so a subagent or a session
      // started elsewhere sees its own project's memory.
      cwd: (exec) => agentCwd(exec?.agent) ?? config.cwd,
      projects: (cwd) => refreshIfStale(cwd).projects,
      current: (cwd) => {
        const entry = refreshIfStale(cwd)
        if (entry.currentKey === null) return null
        return entry.projects.find((p) => p.key === entry.currentKey) ?? null
      },
      write: config.enableWrite
        ? {
            target: (cwd) => writeTarget(config.claudeHome, cwd),
            // A save can create the project or change its index: rebuild now
            // so the next prompt and tool call see it.
            changed: (cwd) => refresh(cwd),
          }
        : undefined,
    })
    try {
      ctx.tools.register(tool)
    } catch (error) {
      ctx.logger?.warn?.(`[claude-memory] could not register ${tool.name}: ${error?.message ?? error}`)
    }
  }

  ctx.logger?.debug?.(
    `[claude-memory] home=${config.claudeHome} fallbackCwd=${config.cwd} ` +
      `projects=${cacheFor(config.cwd).projects.length}`,
  )

  /** Test hook: inspect caches and how many agents shadowed the global sections. */
  apply.__debug = { caches, shadowedCount: () => shadowed }
}

export default { name, inject, apply }
