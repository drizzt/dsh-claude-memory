/**
 * Access to Claude Code's memory store.
 *
 * Every read is confined to the resolved Claude Code home: a path is only
 * opened after its real (symlink-resolved) location is proven to live inside
 * that home. Writes (`saveMemory`, `deleteMemory`) are opt-in through the
 * plugin's `enableWrite` and touch only one project memory directory.
 *
 * @module dsh-claude-memory/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
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

/** Memory types the shared store understands. */
export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']

/** A topic file name: one plain `.md` basename, never the index. */
const TOPIC_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/

/** Index pointer separator, U+2014 between spaces, as the store's own entries use. */
const INDEX_SEPARATOR = ` ${String.fromCharCode(0x2014)} `

/** Collapse a frontmatter or index value to one line. */
function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/** Write a file atomically: a reader sees the old or the new body, never half. */
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/**
 * Create a memory directory and prove it lives inside the Claude home.
 *
 * @param {string} claudeHome - resolved Claude home.
 * @param {string} memoryDir - target memory directory.
 * @returns {string|null} error text, or null when the directory is usable.
 */
function prepareMemoryDir(claudeHome, memoryDir) {
  try {
    mkdirSync(memoryDir, { recursive: true })
  } catch (error) {
    return `cannot create ${memoryDir}: ${error?.message ?? error}`
  }
  return confinedRealPath(claudeHome, memoryDir) === null ? `${memoryDir} resolves outside ${claudeHome}` : null
}

/** Validate a topic file name; returns error text or null. */
function checkTopicName(file) {
  if (typeof file !== 'string' || !TOPIC_NAME.test(file) || file === MEMORY_INDEX_FILENAME) {
    return `invalid file ${JSON.stringify(file)}: use a plain name like "feedback-testing.md"`
  }
  return null
}

/** Read an index body, or start a new one. */
function loadIndex(claudeHome, indexFile) {
  if (!existsSync(indexFile)) return '# Memory Index\n'
  const read = readConfined(claudeHome, indexFile)
  if (read === null) throw new Error(`${indexFile} is unreadable or outside the Claude home`)
  return read.text
}

/** Does an index line point at `file`? */
function linksTo(line, file) {
  return /^\s*[-*]\s+\[/.test(line) && line.includes(`](${file})`)
}

/**
 * Save one memory: write its topic file and upsert its index line.
 *
 * Every other index line is kept byte for byte, so hand-written ordering and
 * notes survive. Saving an existing file replaces it whole.
 *
 * @param {string} claudeHome - resolved Claude home.
 * @param {string} memoryDir - the project's memory directory.
 * @param {{file: string, name: string, description: string, type: string, body: string}} memory
 * @returns {{ok: boolean, text: string}} outcome for the model.
 */
export function saveMemory(claudeHome, memoryDir, { file, name, description, type, body }) {
  const nameError = checkTopicName(file)
  if (nameError !== null) return { ok: false, text: nameError }
  if (!MEMORY_TYPES.includes(type)) return { ok: false, text: `type must be one of ${MEMORY_TYPES.join(', ')}` }
  const title = oneLine(name)
  const summary = oneLine(description)
  if (title.length === 0 || summary.length === 0 || typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, text: 'save requires non-empty "name", "description" and "body"' }
  }
  const dirError = prepareMemoryDir(claudeHome, memoryDir)
  if (dirError !== null) return { ok: false, text: dirError }

  const topic = [
    '---',
    `name: ${title}`,
    `description: ${summary}`,
    'metadata:',
    `  type: ${type}`,
    '---',
    '',
    body.trim(),
    '',
  ].join('\n')
  const indexFile = join(memoryDir, MEMORY_INDEX_FILENAME)
  const pointer = `- [${title}](${file})${INDEX_SEPARATOR}${summary}`
  try {
    const lines = loadIndex(claudeHome, indexFile).split('\n')
    const at = lines.findIndex((line) => linksTo(line, file))
    if (at >= 0) {
      lines[at] = pointer
    } else {
      while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
      // Keep a blank line between a heading and the first pointer.
      if (lines.length > 0 && lines[lines.length - 1].startsWith('#')) lines.push('')
      lines.push(pointer, '')
    }
    writeAtomic(join(memoryDir, file), topic)
    writeAtomic(indexFile, lines.join('\n'))
    return { ok: true, text: `${at >= 0 ? 'updated' : 'saved'} ${file}` }
  } catch (error) {
    return { ok: false, text: `save failed: ${error?.message ?? error}` }
  }
}

/**
 * Delete one memory: remove its topic file and its index line.
 *
 * @param {string} claudeHome - resolved Claude home.
 * @param {string} memoryDir - the project's memory directory.
 * @param {string} file - topic file name.
 * @returns {{ok: boolean, text: string}} outcome for the model.
 */
export function deleteMemory(claudeHome, memoryDir, file) {
  const nameError = checkTopicName(file)
  if (nameError !== null) return { ok: false, text: nameError }
  const topicFile = join(memoryDir, file)
  const indexFile = join(memoryDir, MEMORY_INDEX_FILENAME)
  try {
    let found = false
    if (confinedRealPath(claudeHome, topicFile) !== null) {
      unlinkSync(topicFile)
      found = true
    }
    if (existsSync(indexFile)) {
      const lines = loadIndex(claudeHome, indexFile).split('\n')
      const kept = lines.filter((line) => !linksTo(line, file))
      if (kept.length !== lines.length) {
        writeAtomic(indexFile, kept.join('\n'))
        found = true
      }
    }
    return found ? { ok: true, text: `deleted ${file}` } : { ok: false, text: `no memory ${JSON.stringify(file)}` }
  } catch (error) {
    return { ok: false, text: `delete failed: ${error?.message ?? error}` }
  }
}

/** Re-exported for callers that build paths next to a project's memory dir. */
export { MEMORY_DIRNAME, MEMORY_INDEX_FILENAME }
