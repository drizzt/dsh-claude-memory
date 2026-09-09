/**
 * Synthetic Claude Code home for the test suite.
 *
 * The tests must pass on any machine, so they never touch a real `~/.claude`.
 * This module builds a disposable home in the OS temp directory that reproduces
 * every layout the plugin cares about:
 *
 *   <root>/home/                      ← claudeHome
 *     CLAUDE.md                       ← global instructions with an @import
 *     imported.md                     ← the imported file
 *     projects/<key>/memory/          ← one memory set per synthetic project
 *   <root>/ws                         ← cwd that has its own memory (exact)
 *   <root>/ws-child                   ← child of <root>/ws
 *   <root>/repo/.git                  ← synthetic git root
 *   <root>/repo/ws                    ← cwd whose memory lives at the repo root
 *   <root>/hub, hub-a, hub-b          ← no-memory hub with two children
 *
 * @module dsh-claude-memory/test/fixtures
 */

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeProjectKey } from '../src/paths.js'

/** Write a `MEMORY.md` index from `[title, file, summary]` triples. */
function writeIndex(dir, entries) {
  const body = entries.map(([title, file, summary]) => `- [${title}](${file}) — ${summary}`).join('\n')
  writeFileSync(join(dir, 'MEMORY.md'), `${body}\n`)
}

/**
 * Create one project's memory directory.
 *
 * @param {string} projectsRoot - `<home>/projects`.
 * @param {string} projectPath - the directory this memory set describes.
 * @param {Array<[string, string, string]>} entries - index rows.
 * @param {Record<string, string>} [topics] - topic file name → contents.
 * @param {Date} [mtime] - index modification time.
 * @returns {{key: string, dir: string, indexFile: string}} the created project.
 */
function createProject(projectsRoot, projectPath, entries, topics = {}, mtime) {
  const key = encodeProjectKey(projectPath)
  const dir = join(projectsRoot, key, 'memory')
  mkdirSync(dir, { recursive: true })
  writeIndex(dir, entries)
  for (const [name, body] of Object.entries(topics)) writeFileSync(join(dir, name), body)
  const indexFile = join(dir, 'MEMORY.md')
  if (mtime !== undefined) utimesSync(indexFile, mtime, mtime)
  return { key, dir, indexFile }
}

/**
 * Build a disposable fixture.
 *
 * @returns {object} paths and project records; call {@link disposeFixture} when done.
 */
export function buildFixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-claude-memory-'))
  const home = join(root, 'home')
  const projectsRoot = join(home, 'projects')
  const ws = join(root, 'ws')
  const wsChild = join(root, 'ws-child')
  const repo = join(root, 'repo')
  const repoWs = join(repo, 'ws')
  const hub = join(root, 'hub')
  const hubA = join(root, 'hub-a')
  const hubB = join(root, 'hub-b')

  for (const dir of [home, projectsRoot, ws, wsChild, join(repo, '.git'), repoWs, hub, hubA, hubB]) {
    mkdirSync(dir, { recursive: true })
  }

  // Global instructions plus one @import.
  writeFileSync(
    join(home, 'CLAUDE.md'),
    '# Personal preferences\n\nAlways answer in Chinese.\n\n@imported.md\n',
  )
  writeFileSync(
    join(home, 'imported.md'),
    '# Imported guidance\n\nMarker: IMPORTED_MARKER_OK\n',
  )

  const old = new Date('2026-01-01T00:00:00Z')
  const mid = new Date('2026-06-01T00:00:00Z')
  const fresh = new Date('2026-09-01T00:00:00Z')

  const wsProject = createProject(
    projectsRoot,
    ws,
    [
      ['Alpha', 'alpha.md', 'first topic'],
      ['Beta', 'beta.md', 'second topic'],
    ],
    {
      'alpha.md': [
        '---',
        'name: alpha',
        'description: alpha topic',
        'metadata:',
        '  type: feedback',
        '---',
        '',
        '# Alpha',
        '',
        'Plain body line.',
        'openai_key = sk-abcdefghijklmnopqrstuvwx',
        'password: hunter2secret',
        '',
      ].join('\n'),
      'beta.md': '---\nname: beta\n---\n\n# Beta\n\nsecond body\n',
    },
    fresh,
  )

  const wsChildProject = createProject(
    projectsRoot,
    wsChild,
    [['Child', 'child.md', 'child topic']],
    { 'child.md': '# Child\n\nchild body\n' },
    mid,
  )

  const repoProject = createProject(
    projectsRoot,
    repo,
    [['Repo', 'repo.md', 'repo-level topic']],
    { 'repo.md': '# Repo\n\nrepo body\n' },
    mid,
  )

  const hubAProject = createProject(
    projectsRoot,
    hubA,
    [['Hub A', 'a.md', 'older sibling']],
    {},
    old,
  )
  const hubBProject = createProject(
    projectsRoot,
    hubB,
    [['Hub B', 'b.md', 'newer sibling']],
    {},
    fresh,
  )

  return {
    root,
    home,
    projectsRoot,
    ws,
    wsChild,
    repo,
    repoWs,
    hub,
    hubA,
    hubB,
    wsProject,
    wsChildProject,
    repoProject,
    hubAProject,
    hubBProject,
    /** Project key for a synthetic directory. */
    keyOf: (p) => encodeProjectKey(p),
  }
}

/** Remove a fixture built by {@link buildFixture}. */
export function disposeFixture(fixture) {
  rmSync(fixture.root, { recursive: true, force: true })
}
