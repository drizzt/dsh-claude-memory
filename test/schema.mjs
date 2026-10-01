/**
 * Validate this plugin's hand-written tool schemas against the real DSH
 * runtime validators (`@deepseek-ai/dsh-tools`), which is what
 * `ctx.tools.register()` calls before accepting a tool.
 *
 * The plugin deliberately imports no harness packages, so this test locates the
 * installed DSH copy at run time and skips (exit 0) when none is present.
 *
 *   node test/schema.mjs
 *
 * @module dsh-claude-memory/test/schema
 */

import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Find an installed @deepseek-ai/dsh-tools, preferring the npx cache. */
function findDshTools() {
  const candidates = []
  const npxRoot = join(homedir(), '.npm', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, entry, 'node_modules', '@deepseek-ai', 'dsh-tools'))
    }
  }
  candidates.push(join(homedir(), '.dsh', 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-tools'))
  return candidates.find((c) => existsSync(join(c, 'package.json'))) ?? null
}

const dshToolsDir = findDshTools()
if (dshToolsDir === null) {
  console.log('skip: no installed @deepseek-ai/dsh-tools found on this machine')
  process.exit(0)
}

const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(
  join(dshToolsDir, 'lib', 'index.js')
)
const { createClaudeMemoryTool } = await import('../src/tool.js')

const tool = createClaudeMemoryTool({
  claudeHome: '/nonexistent',
  redactMode: 'on',
  projects: () => [],
  current: () => null,
})

let passed = 0
let failed = 0

function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

console.log(`\n# schema validation against ${dshToolsDir}\n`)

check('output.schema passes assertSupportedJsonSchema (what register() enforces)', () => {
  assertSupportedJsonSchema(tool.output.schema)
})

check('parameters schema passes assertSupportedJsonSchema', () => {
  assertSupportedJsonSchema(tool.parameters)
})

check('parameters accepts a well-formed call', () => {
  const violations = validateJsonSchemaValue(tool.parameters, { action: 'projects' }, '')
  assert.deepEqual(violations, [], JSON.stringify(violations))
})

check('parameters accepts every action enum value', () => {
  for (const action of ['projects', 'index', 'read', 'search']) {
    const violations = validateJsonSchemaValue(tool.parameters, { action }, '')
    assert.deepEqual(violations, [], `${action}: ${JSON.stringify(violations)}`)
  }
})

check('parameters rejects a missing action', () => {
  const violations = validateJsonSchemaValue(tool.parameters, {}, '')
  assert.ok(violations.length > 0, 'expected a violation')
})

check('parameters rejects an unknown action', () => {
  const violations = validateJsonSchemaValue(tool.parameters, { action: 'destroy' }, '')
  assert.ok(violations.length > 0, 'expected a violation')
})

const writable = createClaudeMemoryTool({
  claudeHome: '/nonexistent',
  redactMode: 'on',
  projects: () => [],
  current: () => null,
  write: { target: () => ({ key: '-x', memoryDir: '/nonexistent' }), changed: () => {} },
})

check('write-enabled parameters pass assertSupportedJsonSchema', () => {
  assertSupportedJsonSchema(writable.parameters)
})

check('write-enabled parameters accept a full save call', () => {
  const call = { action: 'save', file: 'a.md', name: 'A', description: 'a', type: 'user', body: 'b' }
  const violations = validateJsonSchemaValue(writable.parameters, call, '')
  assert.deepEqual(violations, [], JSON.stringify(violations))
})

check('write-enabled parameters reject an unknown memory type', () => {
  const violations = validateJsonSchemaValue(writable.parameters, { action: 'save', type: 'secret' }, '')
  assert.ok(violations.length > 0, 'expected a violation')
})

check('parameters rejects an unknown property', () => {
  const violations = validateJsonSchemaValue(tool.parameters, { action: 'projects', extra: 1 }, '')
  assert.ok(violations.length > 0, 'expected a violation')
})

check('output value validates against output.schema', () => {
  const violations = validateJsonSchemaValue(tool.output.schema, { text: 'hello' }, '')
  assert.deepEqual(violations, [], JSON.stringify(violations))
})

check('rendered content is a model-facing text block', () => {
  const blocks = tool.output.render({}, { text: 'hello' })
  assert.deepEqual(blocks, [{ type: 'text', text: 'hello' }])
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
