/**
 * Portable unit tests for dsh-claude-memory.
 *
 * Everything runs against a synthetic fixture in the OS temp directory, so the
 * suite passes on any machine and never reads a real `~/.claude`. Live checks
 * against this machine's own store live in `test/live.mjs`.
 *
 *   node test/smoke.mjs
 *
 * @module dsh-claude-memory/test/smoke
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  confinedRealPath,
  countIndexEntries,
  encodeProjectKey,
  findGitRoot,
  formatIndexDate,
  listMemoryProjects,
  projectLabel,
  resolveClaudeHome,
  resolveKeyToPath,
  selectProjects,
} from '../src/paths.js'
import {
  deleteMemory,
  findProject,
  readConfined,
  readInstructionsWithImports,
  readProjectIndex,
  saveMemory,
  searchTopics,
} from '../src/store.js'
import { redactText, REDACTION_MARK } from '../src/redact.js'
import { byteLength, renderMemoryBlock, truncateToBytes } from '../src/render.js'
import { createClaudeMemoryTool } from '../src/tool.js'
import { buildFixture, disposeFixture } from './fixtures.mjs'

let passed = 0
let failed = 0

function test(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

async function asyncTest(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

const fx = buildFixture()
process.on('exit', () => disposeFixture(fx))

console.log(`\n# dsh-claude-memory smoke test\n  fixture=${fx.root}\n`)

// --------------------------------------------------------------------------
console.log('paths')
// --------------------------------------------------------------------------

test('encodeProjectKey matches the Claude Code slug format', () => {
  assert.equal(encodeProjectKey('/home/user/my-project'), '-home-user-my-project')
  assert.equal(encodeProjectKey(fx.ws), fx.wsProject.key)
})

test('encodeProjectKey maps a Windows drive colon to a dash', () => {
  assert.equal(encodeProjectKey('C:\\Users\\me'), 'C--Users-me')
})

test('encodeProjectKey maps every non-alphanumeric character to a dash', () => {
  assert.equal(encodeProjectKey('/home/me/.config/my_app (2)'), '-home-me--config-my-app--2-')
})

test('countIndexEntries counts pointer lines only', () => {
  const text = [
    '# Memory Index',
    '',
    '- [a](a.md) — one',
    '- [b](b.md) — two',
    'plain text',
    '* [c](c.md) — three',
  ].join('\n')
  assert.equal(countIndexEntries(text), 3)
})

test('confinedRealPath rejects a path outside the root', () => {
  assert.equal(confinedRealPath(fx.home, '/etc/passwd'), null)
})

test('confinedRealPath rejects a symlink that escapes the root', () => {
  const outside = mkdtempSync(join(tmpdir(), 'cm-out-'))
  writeFileSync(join(outside, 'secret.md'), 'top secret')
  const link = join(fx.home, 'escape-link.md')
  symlinkSync(join(outside, 'secret.md'), link)
  try {
    assert.equal(confinedRealPath(fx.home, link), null)
  } finally {
    rmSync(outside, { recursive: true, force: true })
    rmSync(link, { force: true })
  }
})

test('listMemoryProjects finds every indexed project inside the home', () => {
  const projects = listMemoryProjects(fx.home)
  const keys = projects.map((p) => p.key)
  for (const expected of [fx.wsProject.key, fx.repoProject.key, fx.hubBProject.key]) {
    assert.ok(keys.includes(expected), `missing ${expected}`)
  }
  for (const p of projects) {
    assert.notEqual(confinedRealPath(fx.home, p.indexFile), null, `${p.key} index escapes home`)
  }
})

test('listMemoryProjects ignores a projects directory that does not exist', () => {
  assert.deepEqual(listMemoryProjects(join(fx.root, 'no-such-home')), [])
})

test('findGitRoot walks up past a non-repo subdirectory', () => {
  assert.equal(findGitRoot(fx.repoWs), fx.repo)
  assert.equal(findGitRoot(fx.repo), fx.repo)
  assert.equal(findGitRoot(fx.hub), null)
})

test('findGitRoot resolves a linked worktree to its main repository', () => {
  const adminDir = join(fx.repo, '.git', 'worktrees', 'wt')
  const worktree = join(fx.root, 'repo-wt')
  mkdirSync(adminDir, { recursive: true })
  mkdirSync(join(worktree, 'sub'), { recursive: true })
  writeFileSync(join(adminDir, 'commondir'), '../..\n')
  writeFileSync(join(worktree, '.git'), `gitdir: ${adminDir}\n`)
  assert.equal(findGitRoot(join(worktree, 'sub')), fx.repo)
})

test('findGitRoot keeps a submodule as its own root', () => {
  const moduleDir = join(fx.repo, '.git', 'modules', 'sm')
  const submodule = join(fx.repo, 'sm')
  mkdirSync(moduleDir, { recursive: true })
  mkdirSync(submodule, { recursive: true })
  writeFileSync(join(submodule, '.git'), 'gitdir: ../.git/modules/sm\n')
  assert.equal(findGitRoot(submodule), submodule)
})

test('selectProjects resolves an exact project', () => {
  const projects = listMemoryProjects(fx.home)
  const { current, match } = selectProjects({ projects, cwd: fx.ws, includeDescendants: false })
  assert.equal(match, 'exact')
  assert.equal(current?.key, fx.wsProject.key)
})

test('selectProjects prefers the git-root project for a subdirectory', () => {
  const projects = listMemoryProjects(fx.home)
  const { current, match } = selectProjects({
    projects,
    cwd: fx.repoWs,
    gitRoot: findGitRoot(fx.repoWs),
    includeDescendants: false,
  })
  assert.equal(match, 'git-root')
  assert.equal(current?.key, fx.repoProject.key)
})

test('selectProjects falls back to the freshest candidate', () => {
  const projects = listMemoryProjects(fx.home)
  const { current, match } = selectProjects({
    projects,
    cwd: fx.hub,
    gitRoot: null,
    includeDescendants: true,
    descendantLimit: 10,
  })
  assert.equal(match, 'freshest')
  assert.equal(current?.key, fx.hubBProject.key, 'the newer sibling should win')
})

test('selectProjects lists other projects newest-first', () => {
  const projects = listMemoryProjects(fx.home)
  const { related } = selectProjects({
    projects,
    cwd: fx.hub,
    gitRoot: null,
    includeDescendants: true,
    descendantLimit: 10,
  })
  for (let i = 1; i < related.length; i += 1) {
    assert.ok(related[i - 1].mtimeMs >= related[i].mtimeMs, 'related must be newest-first')
  }
})

test('selectProjects reports match=none for an unrelated directory', () => {
  const projects = listMemoryProjects(fx.home)
  const { current, related, match } = selectProjects({
    projects,
    cwd: join(fx.root, 'unrelated', 'deep'),
    gitRoot: null,
    includeDescendants: true,
  })
  assert.equal(match, 'none')
  assert.equal(current, null)
  assert.deepEqual(related, [])
})

test('resolveKeyToPath recovers the real directory from a key', () => {
  assert.equal(resolveKeyToPath(fx.wsProject.key), fx.ws)
  assert.equal(resolveKeyToPath('-no-such-root-xyz'), null)
})

test('projectLabel returns the real trailing directory name', () => {
  assert.equal(projectLabel(fx.wsProject.key), 'ws')
  assert.equal(projectLabel('-no-such-root-xyz-my-project'), 'my-project')
})

test('formatIndexDate renders a stable local date', () => {
  assert.equal(formatIndexDate(0), '?')
  assert.match(formatIndexDate(Date.UTC(2026, 8, 9)), /^\d{4}-\d{2}-\d{2}$/)
})

test('resolveClaudeHome expands a leading tilde', () => {
  assert.ok(resolveClaudeHome({ claudeHome: '~/.claude' }).endsWith('/.claude'))
  assert.equal(resolveClaudeHome({ claudeHome: fx.home }), fx.home)
})

// --------------------------------------------------------------------------
console.log('\nredact')
// --------------------------------------------------------------------------

test('masks a known secret shape per rule', () => {
  const cases = [
    ['sk-abcdefghijklmnopqrstuvwx', 'openai-key'],
    ['ghp_abcdefghijklmnopqrstuvwxyz01', 'github-token'],
    ['glpat-abcdefghijklmnop', 'gitlab-token'],
    ['AKIAIOSFODNN7EXAMPLE', 'aws-key-id'],
    ['Authorization: Bearer abcdefghijklmnopqrstuvwx', 'bearer'],
    ['password: 10qMdWxy12', 'password'],
    ['pwd=`oP3nS3same12`', 'password'],
    ['Token: 4a000abcdefghij', 'api-secret'],
    ['api_key = sk_live_abcdefghijkl', 'api-secret'],
    ['mysql://root:hunter2xyz@10.0.0.1:3306/db', 'dsn'],
    ['jdbc:mysql://root:hunter2xyz@10.0.0.1:3306/db?x=1', 'dsn'],
    ['deadbeefdeadbeefdeadbeefdeadbeef', 'long-hex'],
  ]
  for (const [input, kind] of cases) {
    const { text, hits, total } = redactText(input)
    assert.ok(total > 0, `expected a hit for ${kind}: ${input}`)
    assert.ok(text.includes(REDACTION_MARK), `expected marker for ${kind}`)
    assert.ok(hits[kind] >= 1, `expected rule ${kind} to fire, got ${JSON.stringify(hits)}`)
  }
})

test('does not mask ordinary prose that merely mentions passwords', () => {
  const prose = 'password: stored in 1password, see the docs'
  const { text, total } = redactText(prose)
  assert.equal(total, 0, `over-redacted: ${text}`)
  assert.equal(text, prose)
})

test('report mode counts without altering text', () => {
  const input = 'token: abcdefghijklmnop'
  const { text, total } = redactText(input, { mode: 'report' })
  assert.equal(text, input)
  assert.ok(total >= 1)
})

test('off mode is a no-op', () => {
  const input = 'token: abcdefghijklmnop'
  assert.deepEqual(redactText(input, { mode: 'off' }), { text: input, hits: {}, total: 0 })
})

// --------------------------------------------------------------------------
console.log('\nstore')
// --------------------------------------------------------------------------

test('readConfined refuses an out-of-tree path', () => {
  assert.equal(readConfined(fx.home, '/etc/passwd'), null)
})

test('readProjectIndex returns the index and its entry count', () => {
  const project = listMemoryProjects(fx.home).find((p) => p.key === fx.wsProject.key)
  const index = readProjectIndex(fx.home, project)
  assert.ok(index !== null)
  assert.equal(index.entries, 2)
})

test('readInstructionsWithImports inlines @imports', () => {
  const instructions = readInstructionsWithImports(fx.home, join(fx.home, 'CLAUDE.md'))
  assert.ok(instructions !== null)
  assert.equal(instructions.files.length, 2, `expected the import to be followed: ${instructions.files}`)
  assert.ok(!/^@imported\.md$/m.test(instructions.text), 'import line should be replaced')
  assert.ok(instructions.text.includes('IMPORTED_MARKER_OK'), 'imported content should be present')
})

test('readInstructionsWithImports returns null when nothing is readable', () => {
  assert.equal(readInstructionsWithImports(fx.home, join(fx.home, 'nope.md')), null)
})

test('findProject resolves by exact key and by unique substring', () => {
  const projects = listMemoryProjects(fx.home)
  assert.equal(findProject(projects, fx.wsProject.key)?.key, fx.wsProject.key)
  assert.equal(findProject(projects, 'hub-b')?.key, fx.hubBProject.key)
  assert.equal(findProject(projects, 'no-such-project-xyz'), null)
})

test('searchTopics finds text in topic files', () => {
  const project = listMemoryProjects(fx.home).find((p) => p.key === fx.wsProject.key)
  const matches = searchTopics(fx.home, project, 'second body', 5)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].file, 'beta.md')
})

// --------------------------------------------------------------------------
console.log('\nrender')
// --------------------------------------------------------------------------

test('truncateToBytes respects a UTF-8 byte budget for CJK', () => {
  const text = '中文字符测试'.repeat(100)
  const { text: cut, truncated } = truncateToBytes(text, 90)
  assert.equal(truncated, true)
  assert.ok(byteLength(cut) <= 90, `got ${byteLength(cut)} bytes`)
  assert.ok(!cut.includes('\uFFFD'), 'must not split a character')
})

test('renderMemoryBlock stays inside the budget and marks truncation', () => {
  const block = renderMemoryBlock({
    project: { key: '-a-b-c' },
    index: { text: '- [x](x.md) — 中文内容'.repeat(200), entries: 200 },
    related: [],
    all: [{ key: '-a-b-c' }],
    maxBytes: 500,
  })
  assert.ok(byteLength(block) <= 500, `got ${byteLength(block)} bytes`)
  assert.ok(block.includes('truncated'), 'expected a truncation marker')
})

test('renderMemoryBlock returns empty text when there is nothing to say', () => {
  assert.equal(renderMemoryBlock({ project: null, index: null, related: [], all: [], maxBytes: 1000 }), '')
})

test('renderMemoryBlock explains a git-root resolution', () => {
  const block = renderMemoryBlock({
    project: { key: '-a-b' },
    index: { text: '- [x](x.md) — one', entries: 1 },
    related: [],
    all: [{ key: '-a-b' }],
    match: 'git-root',
    gitRoot: '/a/b',
    maxBytes: 4000,
  })
  assert.ok(block.includes('enclosing git repository root'))
  assert.ok(block.includes('/a/b'))
})

// --------------------------------------------------------------------------
console.log('\ntool')
// --------------------------------------------------------------------------

const tool = createClaudeMemoryTool({
  claudeHome: fx.home,
  redactMode: 'on',
  cwd: () => fx.ws,
  projects: () => listMemoryProjects(fx.home),
  current: () => {
    const projects = listMemoryProjects(fx.home)
    const { current } = selectProjects({ projects, cwd: fx.ws, includeDescendants: false })
    return current
  },
})

await asyncTest('projects action lists the store', async () => {
  const value = await tool.execute({ action: 'projects' })
  assert.ok(value.text.includes(fx.wsProject.key))
})

await asyncTest('index action returns an index', async () => {
  const value = await tool.execute({ action: 'index' })
  assert.ok(value.text.includes('MEMORY.md'))
})

await asyncTest('read action masks credentials in topic bodies', async () => {
  const value = await tool.execute({ action: 'read', file: 'alpha.md' })
  assert.ok(value.text.length > 0, 'expected file contents')
  assert.ok(value.text.includes(REDACTION_MARK), 'expected the fake key to be masked')
  assert.ok(!value.text.includes('sk-abcdefghijklmnopqrstuvwx'), 'raw key leaked')
  const { total } = redactText(value.text)
  assert.equal(total, 0, `tool output still matches secret patterns:\n${value.text.slice(0, 400)}`)
})

await asyncTest('read action without a file lists topics', async () => {
  const value = await tool.execute({ action: 'read' })
  assert.ok(value.text.includes('alpha.md'))
})

await asyncTest('search action returns matches', async () => {
  const value = await tool.execute({ action: 'search', query: 'body' })
  assert.ok(value.text.includes('matches'))
})

await asyncTest('an unknown project selector is reported, not thrown', async () => {
  const value = await tool.execute({ action: 'index', project: 'no-such-project-xyz' })
  assert.ok(value.text.includes('No single project matches'))
})

await asyncTest('unknown action is rejected without throwing', async () => {
  const value = await tool.execute({ action: 'nope' })
  assert.ok(value.text.includes('Unsupported action'))
})

await asyncTest('tool definition shape is registry-valid', async () => {
  assert.equal(tool.name, 'claude_memory')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.equal(tool.output.schema.type, 'object')
  assert.deepEqual(tool.output.render({}, { text: 'hello' }), [{ type: 'text', text: 'hello' }])
})

await asyncTest('tool output never exceeds the byte cap', async () => {
  const value = await tool.execute({ action: 'index' })
  assert.ok(byteLength(value.text) <= 20200, `got ${byteLength(value.text)} bytes`)
})

// --------------------------------------------------------------------------
console.log('\nwrite')
// --------------------------------------------------------------------------

const writeDir = join(fx.home, 'projects', '-write-test', 'memory')
const memo = { file: 'feedback-x.md', name: 'X rule', description: 'first hook', type: 'feedback', body: 'Do X.\n\n**Why:** y' }

test('saveMemory creates topic file, frontmatter and a new index', () => {
  const result = saveMemory(fx.home, writeDir, memo)
  assert.ok(result.ok, result.text)
  const topic = readFileSync(join(writeDir, 'feedback-x.md'), 'utf8')
  assert.ok(topic.startsWith('---\nname: X rule\ndescription: first hook\nmetadata:\n  type: feedback\n---\n\nDo X.'))
  const index = readFileSync(join(writeDir, 'MEMORY.md'), 'utf8')
  assert.ok(index.startsWith('# Memory Index\n\n- [X rule](feedback-x.md) '), index)
  assert.equal(countIndexEntries(index), 1)
})

test('saveMemory replaces only its own index line', () => {
  const indexFile = join(writeDir, 'MEMORY.md')
  const before = readFileSync(indexFile, 'utf8')
  writeFileSync(indexFile, `${before}- [Other](other.md) - hand written\nfree note line\n`)
  const result = saveMemory(fx.home, writeDir, { ...memo, description: 'second hook' })
  assert.ok(result.ok && result.text.startsWith('updated'), result.text)
  const lines = readFileSync(indexFile, 'utf8').split('\n')
  assert.ok(lines[2].includes('second hook'), lines.join('\n'))
  assert.ok(lines.includes('- [Other](other.md) - hand written'))
  assert.ok(lines.includes('free note line'))
  assert.equal(countIndexEntries(lines.join('\n')), 2)
})

test('saveMemory rejects bad file names and types', () => {
  for (const file of ['../escape.md', 'a/b.md', 'MEMORY.md', 'note.txt', '.hidden.md', '']) {
    assert.equal(saveMemory(fx.home, writeDir, { ...memo, file }).ok, false, file)
  }
  assert.equal(saveMemory(fx.home, writeDir, { ...memo, type: 'secret' }).ok, false)
  assert.equal(saveMemory(fx.home, writeDir, { ...memo, body: '  ' }).ok, false)
})

test('saveMemory refuses a memory directory symlinked out of the home', () => {
  const outside = mkdtempSync(join(tmpdir(), 'cm-out-'))
  const projectDir = join(fx.home, 'projects', '-escape-test')
  mkdirSync(projectDir, { recursive: true })
  symlinkSync(outside, join(projectDir, 'memory'))
  try {
    assert.equal(saveMemory(fx.home, join(projectDir, 'memory'), memo).ok, false)
    assert.equal(existsSync(join(outside, 'feedback-x.md')), false)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('deleteMemory removes the file and its line, keeps the rest', () => {
  const result = deleteMemory(fx.home, writeDir, 'feedback-x.md')
  assert.ok(result.ok, result.text)
  assert.equal(existsSync(join(writeDir, 'feedback-x.md')), false)
  const index = readFileSync(join(writeDir, 'MEMORY.md'), 'utf8')
  assert.ok(!index.includes('feedback-x.md'))
  assert.ok(index.includes('hand written'))
  assert.equal(deleteMemory(fx.home, writeDir, 'feedback-x.md').ok, false)
})

await asyncTest('read-only tool has no write actions', async () => {
  assert.ok(!tool.parameters.properties.action.enum.includes('save'))
  const value = await tool.execute({ action: 'save', file: 'a.md' })
  assert.ok(value.text.includes('Unsupported action'))
})

// --------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
