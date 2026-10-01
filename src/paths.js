/**
 * Claude Code project-path encoding and memory-directory discovery.
 *
 * Claude Code stores per-project state under `~/.claude/projects/<key>/`, where
 * `<key>` is the absolute project path with every character other than an ASCII
 * letter or digit replaced by `-`. The encoding is lossy (a real `-` in a path is
 * indistinguishable from a separator), so this module never decodes a key to
 * make security decisions — it only decodes for human-readable display.
 *
 * @module dsh-claude-memory/paths
 */

import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { readdirSync, statSync } from 'node:fs'

/** Directory that holds one Claude Code memory set. */
export const MEMORY_DIRNAME = 'memory'

/** Index file inside a memory directory. */
export const MEMORY_INDEX_FILENAME = 'MEMORY.md'

/**
 * Encode an absolute filesystem path into a Claude Code project key.
 *
 * `C:\Users\me` becomes `C--Users-me`, `/home/me/.config` becomes `-home-me--config`.
 *
 * @param {string} absolutePath - absolute path to encode.
 * @returns {string} the encoded project key.
 */
export function encodeProjectKey(absolutePath) {
  return absolutePath.replace(/[^A-Za-z0-9]/g, '-')
}

/**
 * Resolve the Claude Code home directory from configuration.
 *
 * @param {{claudeHome?: string}} config - plugin configuration.
 * @returns {string} absolute Claude Code home.
 */
export function resolveClaudeHome(config = {}) {
  const raw = config.claudeHome ?? join(homedir(), '.claude')
  return resolve(expandHome(raw))
}

/**
 * Expand a leading `~` to the current user's home directory.
 *
 * @param {string} p - possibly home-relative path.
 * @returns {string} expanded path.
 */
export function expandHome(p) {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * Assert that a resolved path stays inside a root directory.
 *
 * Compares real (symlink-resolved) paths so a symlink cannot smuggle a target
 * out of the tree. Returns the real path when it is confined.
 *
 * @param {string} root - directory that must contain the target.
 * @param {string} target - path to check.
 * @returns {string|null} the real path, or null when it escapes or is missing.
 */
export function confinedRealPath(root, target) {
  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch {
    return null
  }
  let realTarget
  try {
    realTarget = realpathSync(target)
  } catch {
    return null
  }
  if (realTarget === realRoot) return realTarget
  return realTarget.startsWith(realRoot.endsWith(sep) ? realRoot : realRoot + sep) ? realTarget : null
}

/**
 * Count index entries in a `MEMORY.md` body.
 *
 * Claude Code's index is a list of `- [title](file.md) — summary` lines; other
 * lines (headings, blanks) are ignored.
 *
 * @param {string} text - index file contents.
 * @returns {number} number of pointer lines.
 */
export function countIndexEntries(text) {
  let n = 0
  for (const line of text.split('\n')) {
    if (/^\s*[-*]\s+\[[^\]]+\]\([^)]+\)/.test(line)) n += 1
  }
  return n
}

/**
 * List every project that has a memory directory under a Claude Code home.
 *
 * A project is included only when `<home>/projects/<key>/memory/MEMORY.md`
 * exists and is a regular file inside the home tree. The scan is one level deep
 * and never follows a memory directory out of the tree.
 *
 * @param {string} claudeHome - resolved Claude Code home.
 * @returns {Array<{key: string, memoryDir: string, indexFile: string, mtimeMs: number, size: number, entries: number}>}
 */
export function listMemoryProjects(claudeHome) {
  const projectsRoot = join(claudeHome, 'projects')
  let keys
  try {
    keys = readdirSync(projectsRoot, { withFileTypes: true })
  } catch {
    return []
  }

  const found = []
  for (const dirent of keys) {
    if (!dirent.isDirectory()) continue
    const key = dirent.name
    const memoryDir = join(projectsRoot, key, MEMORY_DIRNAME)
    const indexFile = join(memoryDir, MEMORY_INDEX_FILENAME)

    // The index must resolve inside the Claude home; this rejects a symlinked
    // memory directory pointing somewhere else on disk.
    const real = confinedRealPath(claudeHome, indexFile)
    if (real === null) continue

    let stat
    try {
      stat = statSync(real)
    } catch {
      continue
    }
    if (!stat.isFile()) continue

    found.push({
      key,
      memoryDir,
      indexFile,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      entries: 0, // filled lazily by the store when the index is read
    })
  }

  found.sort((a, b) => a.key.localeCompare(b.key))
  return found
}

/**
 * Find the enclosing git repository root for a directory.
 *
 * Claude Code files memory under the **git repository root**, not the raw
 * working directory: a session launched in a subdirectory that has no `.git` of
 * its own (for example a docs hub inside a larger repo) writes to the enclosing
 * repo's key, not the subdirectory's. Both a `.git` directory and a `.git` file
 * (worktrees and submodules) mark a root. A linked worktree resolves to its main
 * repository, because the memory store is shared across all worktrees of a repo.
 *
 * @param {string} startDir - directory to walk up from.
 * @returns {string|null} the repository root, or null when there is none.
 */
export function findGitRoot(startDir) {
  let current = resolve(expandHome(startDir))
  for (;;) {
    if (existsSync(join(current, '.git'))) return mainWorktreeRoot(current)
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Map a linked worktree to the root of its main repository.
 *
 * A worktree's `.git` is a file pointing at `<main>/.git/worktrees/<name>`, which
 * holds a `commondir` file pointing back at `<main>/.git`. A submodule's `.git`
 * file has no `commondir`, so a submodule stays its own root.
 *
 * @param {string} root - directory that contains `.git`.
 * @returns {string} the main repository root, or `root` itself.
 */
function mainWorktreeRoot(root) {
  try {
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, '.git'), 'utf8'))
    if (pointer === null) return root
    const gitDir = resolve(root, pointer[1].trim())
    const commonDir = resolve(gitDir, readFileSync(join(gitDir, 'commondir'), 'utf8').trim())
    return basename(commonDir) === '.git' ? dirname(commonDir) : root
  } catch {
    // `.git` is a directory, or not a worktree: the directory is the root.
    return root
  }
}

/**
 * Select the project whose memory is most relevant to a working directory.
 *
 * Resolution order mirrors how Claude Code itself files memory:
 *  1. **exact** — the encoded key for `cwd` has memory;
 *  2. **git-root** — the encoded key for the enclosing git repository root has
 *     memory (the common case for a subdirectory of a repo);
 *  3. **freshest** — otherwise, the most recently updated memory set among the
 *     containing ancestors and the child projects.
 *
 * Rule 3 is deliberately recency-based rather than "nearest ancestor": a hub
 * directory's own memory is often stale while the work that just ran is in one
 * of its children. The chosen rule is reported back so the model knows whether
 * the memory is certain or a best guess.
 *
 * @param {object} options - selection inputs.
 * @param {Array<object>} options.projects - result of {@link listMemoryProjects}.
 * @param {string} options.cwd - session working directory.
 * @param {string|null} [options.gitRoot] - enclosing git root, from {@link findGitRoot}.
 * @param {boolean} [options.includeDescendants] - also return sibling candidates.
 * @param {number} [options.descendantLimit] - maximum other candidates to return.
 * @returns {{current: object|null, related: Array<object>, match: 'exact'|'git-root'|'freshest'|'none'}} selection.
 */
export function selectProjects({
  projects,
  cwd,
  gitRoot = null,
  includeDescendants = true,
  descendantLimit = 12,
}) {
  const cwdKey = encodeProjectKey(resolve(expandHome(cwd)))
  const byKey = new Map(projects.map((p) => [p.key, p]))

  const exact = byKey.get(cwdKey) ?? null
  const descendants = projects.filter((p) => p.key.startsWith(cwdKey + '-'))
  const ancestors = projects.filter((p) => cwdKey.startsWith(p.key + '-'))

  const byRecency = (a, b) => b.mtimeMs - a.mtimeMs || a.key.localeCompare(b.key)

  const relatedFor = () =>
    includeDescendants ? descendants.sort(byRecency).slice(0, Math.max(0, descendantLimit)) : []

  if (exact !== null) return { current: exact, related: relatedFor(), match: 'exact' }

  if (gitRoot !== null) {
    const gitKey = encodeProjectKey(resolve(expandHome(gitRoot)))
    const fromRoot = byKey.get(gitKey) ?? null
    if (fromRoot !== null) {
      return {
        current: fromRoot,
        related: includeDescendants
          ? [...ancestors, ...descendants]
              .filter((p) => p.key !== fromRoot.key)
              .sort(byRecency)
              .slice(0, Math.max(0, descendantLimit))
          : [],
        match: 'git-root',
      }
    }
  }

  const candidates = [...ancestors, ...descendants].sort(byRecency)
  if (candidates.length === 0) return { current: null, related: [], match: 'none' }

  const [current, ...rest] = candidates
  return {
    current,
    related: includeDescendants ? rest.slice(0, Math.max(0, descendantLimit)) : [],
    match: 'freshest',
  }
}

/**
 * Format an index mtime as a short local date for prompt display.
 *
 * @param {number} mtimeMs - modification time in milliseconds.
 * @returns {string} `YYYY-MM-DD`, or `?` when unknown.
 */
export function formatIndexDate(mtimeMs) {
  if (typeof mtimeMs !== 'number' || !Number.isFinite(mtimeMs) || mtimeMs <= 0) return '?'
  const d = new Date(mtimeMs)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/**
 * Recover the original directory path from a project key by walking the filesystem.
 *
 * The encoding is lossy — `-` is both the separator and a legal character in a
 * directory name — so a naive decode turns `...-agent-harness-quality-pilot`
 * into `.../agent/harness/quality/pilot`. Walking the real tree and preferring
 * the longest matching join recovers the true path when it still exists.
 *
 * @param {string} key - encoded project key.
 * @returns {string|null} the real directory, or null when it cannot be recovered.
 */
export function resolveKeyToPath(key) {
  if (!key.startsWith('-')) return null // Windows drive keys have no leading dash
  const segments = key.slice(1).split('-')
  let current = sep
  let index = 0

  while (index < segments.length) {
    let matched = false
    for (let take = segments.length - index; take >= 1; take -= 1) {
      const candidate = join(current, segments.slice(index, index + take).join('-'))
      try {
        if (statSync(candidate).isDirectory()) {
          current = candidate
          index += take
          matched = true
          break
        }
      } catch {
        // not a directory: try a shorter join
      }
    }
    if (!matched) return null
  }

  return current
}

/**
 * Short, stable label for a project key.
 *
 * Prefers the real directory name recovered from disk; falls back to the last
 * two raw key segments, which is the best a lossy encoding allows.
 *
 * @param {string} key - encoded project key.
 * @returns {string} display label.
 */
export function projectLabel(key) {
  const real = resolveKeyToPath(key)
  if (real !== null) return basename(real) || key
  const segments = key.replace(/^-/, '').split('-')
  return segments.slice(-2).join('-')
}
