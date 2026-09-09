/**
 * Read-only access to Claude Code's memory store.
 *
 * Every read is confined to the resolved Claude Code home: a path is only
 * opened after its real (symlink-resolved) location is proven to live inside
 * that home. Nothing in this module writes.
 *
 * @module dsh-claude-memory/store
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  MEMORY_DIRNAME,
  MEMORY_INDEX_FILENAME,
  confinedRealPath,
  countIndexEntries,
  expandHome,
} from './paths.js'

/** Maximum `@import` recursion depth when expanding a global instructions file. */
const MAX_IMPORT_DEPTH = 3

/** Claude Code's own cap on an always-loaded memory index. */
export const CLAUDE_INDEX_LINE_CAP = 200
export const CLAUDE_INDEX_BYTE_CAP = 25 * 1024

/**
 * Read a file that must resolve inside `root`.
 *
 * @param {string} root - confining root (the Claude Code home).
 * @param {string} file - candidate file.
 * @returns {{text: string, mtimeMs: number, size: number}|null} contents or null.
 */
export function readConfined(root, file) {
  const real = confinedRealPath(root, file)
  if (real === null) return null
  try {
    const stat = statSync(real)
    if (!stat.isFile()) return null
    if (stat.size > 4 * 1024 * 1024) return null // refuse absurd files
    return { text: readFileSync(real, 'utf8'), mtimeMs: stat.mtimeMs, size: stat.size }
  } catch {
    return null
  }
}

/**
 * Read one project's `MEMORY.md` index.
 *
 * @param {string} claudeHome - resolved Claude Code home.
 * @param {{key: string, memoryDir: string, indexFile: string}} project - project record.
 * @returns {{text: string, mtimeMs: number, size: number, entries: number}|null} index or null.
 */
export function readProjectIndex(claudeHome, project) {
  const read = readConfined(claudeHome, project.indexFile)
  if (read === null) return null
  return { ...read, entries: countIndexEntries(read.text) }
}

/**
 * List the topic files that sit beside a project's `MEMORY.md` index.
 *
 * @param {string} claudeHome - resolved Claude Code home.
 * @param {{memoryDir: string}} project - project record.
 * @returns {Array<{name: string, file: string, mtimeMs: number, size: number}>} topic files.
 */
export function listTopicFiles(claudeHome, project) {
  let names
  try {
    names = readdirSync(project.memoryDir)
  } catch {
    return []
  }
  const out = []
  for (const name of names) {
    if (!name.endsWith('.md') || name === MEMORY_INDEX_FILENAME) continue
    const file = join(project.memoryDir, name)
    const real = confinedRealPath(claudeHome, file)
    if (real === null) continue
    try {
      const stat = statSync(real)
      if (!stat.isFile()) continue
      out.push({ name, file, mtimeMs: stat.mtimeMs, size: stat.size })
    } catch {
      // unreadable entry: skip
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name))
  return out
}

/**
 * Resolve one `@import` reference relative to the importing file.
 *
 * Supports the `@relative/path.md`, `@~/path.md`, and `@/absolute/path.md`
 * forms Claude Code documents. A bare `@name` with no extension is also
 * accepted and tried with `.md` appended.
 *
 * @param {string} fromFile - file containing the reference.
 * @param {string} reference - text after `@`.
 * @returns {string} candidate absolute path.
 */
function resolveImport(fromFile, reference) {
  const expanded = expandHome(reference)
  if (isAbsolute(expanded)) return expanded
  const base = dirname(fromFile)
  return resolve(base, expanded.includes('.') ? expanded : `${expanded}.md`)
}

/**
 * Read a global instructions file and inline its `@import` references.
 *
 * DSH's own workspace-instruction loader reads project `AGENTS.md`/`CLAUDE.md`
 * but deliberately does not interpret `@path` imports, so the user-global
 * `~/.claude/CLAUDE.md` (which is one import line plus prose on this machine)
 * would otherwise arrive half-resolved.
 *
 * @param {string} claudeHome - resolved Claude Code home.
 * @param {string} file - file to read (normally `<home>/CLAUDE.md`).
 * @returns {{text: string, files: string[], mtimeMs: number}|null} expanded text.
 */
export function readInstructionsWithImports(claudeHome, file) {
  const seen = new Set()
  const files = []

  /** @returns {string} */
  function expand(current, depth) {
    const real = confinedRealPath(claudeHome, current)
    if (real === null || seen.has(real) || depth > MAX_IMPORT_DEPTH) return ''
    seen.add(real)

    const read = readConfined(claudeHome, real)
    if (read === null) return ''
    files.push(real)

    const body = read.text.replace(/^[ \t]*@([^\s@]+)[ \t]*$/gm, (match, reference) => {
      const target = resolveImport(real, reference)
      const imported = expand(target, depth + 1)
      return imported.length > 0 ? imported : match
    })
    return body
  }

  const head = expand(file, 0)
  if (files.length === 0) return null
  let mtimeMs = 0
  for (const f of files) {
    try {
      mtimeMs = Math.max(mtimeMs, statSync(f).mtimeMs)
    } catch {
      // ignore
    }
  }
  return { text: head, files, mtimeMs }
}

/**
 * Read one topic file by name.
 *
 * @param {string} claudeHome - resolved Claude Code home.
 * @param {{memoryDir: string}} project - project record.
 * @param {string} name - topic file name (no directories).
 * @returns {{text: string, name: string}|null} contents or null.
 */
export function readTopic(claudeHome, project, name) {
  if (name.includes('/') || name.includes('\\') || name.includes('\0')) return null
  const read = readConfined(claudeHome, join(project.memoryDir, name))
  if (read === null) return null
  return { text: read.text, name }
}

/**
 * Case-insensitive line search across one project's topic files.
 *
 * @param {string} claudeHome - resolved Claude Code home.
 * @param {{memoryDir: string}} project - project record.
 * @param {string} query - substring to find.
 * @param {number} limit - maximum matching lines.
 * @returns {Array<{file: string, line: number, text: string}>} matches.
 */
export function searchTopics(claudeHome, project, query, limit = 40) {
  const needle = query.toLowerCase()
  const out = []
  for (const topic of listTopicFiles(claudeHome, project)) {
    const read = readConfined(claudeHome, topic.file)
    if (read === null) continue
    const lines = read.text.split('\n')
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].toLowerCase().includes(needle)) {
        out.push({ file: topic.name, line: i + 1, text: lines[i].trim() })
        if (out.length >= limit) return out
      }
    }
  }
  return out
}

/**
 * Locate a project record by exact key, key suffix, or label substring.
 *
 * @param {Array<object>} projects - result of `listMemoryProjects`.
 * @param {string} selector - user/model supplied selector.
 * @returns {object|null} the match, or null when ambiguous or absent.
 */
export function findProject(projects, selector) {
  if (typeof selector !== 'string' || selector.length === 0) return null
  const needle = selector.toLowerCase()
  const exact = projects.find((p) => p.key.toLowerCase() === needle)
  if (exact !== undefined) return exact
  const withPrefix = projects.find((p) => p.key.toLowerCase() === `-${needle}`)
  if (withPrefix !== undefined) return withPrefix
  const matches = projects.filter((p) => p.key.toLowerCase().includes(needle))
  return matches.length === 1 ? matches[0] : null
}

/** Re-exported for callers that build paths next to a project's memory dir. */
export { MEMORY_DIRNAME, MEMORY_INDEX_FILENAME }
