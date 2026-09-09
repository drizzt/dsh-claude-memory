/**
 * Optional live check against this machine's real Claude Code store.
 *
 * Unlike `smoke.mjs` and `plugin.mjs`, this reads `~/.claude`. It asserts only
 * environment-independent invariants (providers return strings, budgets hold,
 * and — the important one — no credential-shaped text reaches the prompt), so
 * it is safe to run anywhere and skips cleanly when no store exists.
 *
 *   node test/live.mjs
 *
 * @module dsh-claude-memory/test/live
 */

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { apply } from '../src/index.js'
import { listMemoryProjects, resolveClaudeHome } from '../src/paths.js'
import { redactText } from '../src/redact.js'
import { byteLength } from '../src/render.js'

const home = resolveClaudeHome({})

if (!existsSync(join(home, 'projects'))) {
  console.log(`skip: no Claude Code store at ${home}`)
  process.exit(0)
}

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

const projects = listMemoryProjects(home)
console.log(`\n# live check against ${home}\n  projects with memory: ${projects.length}\n`)

const ctx = { sections: [], logger: { warn() {}, debug() {} }, on() {}, systemPrompt: { section: (s) => ctx.sections.push(s) }, tools: { register: (t) => (ctx.tool = t) } }
apply(ctx, { refreshMs: 0 })

check('registers both sections against the live store', () => {
  assert.deepEqual(ctx.sections.map((s) => s.name).sort(), [
    'claude-memory:global',
    'claude-memory:memory',
  ])
})

check('providers return strings, never promises', () => {
  for (const section of ctx.sections) {
    const value = section.text()
    assert.equal(typeof value, 'string', `${section.name} returned ${typeof value}`)
    assert.ok(!value.includes('[object Promise]'))
  }
})

check('no credential-shaped text reaches the prompt', () => {
  for (const section of ctx.sections) {
    const { total, hits } = redactText(section.text())
    assert.equal(total, 0, `${section.name} leaks: ${JSON.stringify(hits)}`)
  }
})

check('injected prompt stays inside the configured budgets', () => {
  for (const section of ctx.sections) {
    const limit = section.name.endsWith('global') ? 6000 : 24000
    assert.ok(byteLength(section.text()) <= limit, `${section.name} exceeds ${limit} bytes`)
  }
})

check('the tool is registered', () => {
  assert.equal(ctx.tool?.name, 'claude_memory')
})

if (projects.length > 0) {
  check('the memory block names a real project', () => {
    const memory = ctx.sections.find((s) => s.name === 'claude-memory:memory').text()
    assert.ok(memory.includes('Claude Code memory'))
    assert.ok(projects.some((p) => memory.includes(p.key)), 'no known project key in the block')
  })
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
