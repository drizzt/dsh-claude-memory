/**
 * Plugin contract tests: what the loader does, exercised against a fake Cordis
 * context and a synthetic Claude home, so they pass on any machine.
 *
 *   node test/plugin.mjs
 *
 * @module dsh-claude-memory/test/plugin
 */

import assert from 'node:assert/strict'

import { apply, inject, name as pluginName } from '../src/index.js'
import { redactText } from '../src/redact.js'
import { byteLength } from '../src/render.js'
import { buildFixture, disposeFixture } from './fixtures.mjs'

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

async function checkAsync(label, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${label}\n      ${error?.message ?? error}`)
  }
}

/** Minimal stand-in for the harness services the plugin injects. */
function fakeCtx() {
  const sections = []
  const registeredTools = []
  const warnings = []
  const listeners = new Map()
  return {
    sections,
    registeredTools,
    warnings,
    listeners,
    logger: { warn: (m) => warnings.push(m), debug: () => {}, info: () => {} },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    /** Dispatch a captured event to its listener. */
    emit(event, payload) {
      const handler = listeners.get(event)
      if (handler !== undefined) handler(payload)
    },
    systemPrompt: {
      section(spec) {
        if (!Number.isFinite(spec.order)) throw new TypeError('order must be finite')
        sections.push(spec)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        registeredTools.push(definition)
        return () => {}
      },
    },
  }
}

/** Build a fake agent whose session records `cwd`, plus its own section sink. */
function fakeAgent(cwd) {
  const sections = []
  return {
    sections,
    agent: {
      session: { header: { cwd } },
      ctx: {
        systemPrompt: {
          section(spec) {
            sections.push(spec)
            return () => {}
          },
        },
      },
    },
  }
}

const fx = buildFixture()
process.on('exit', () => disposeFixture(fx))

const sectionText = (ctx, name) => ctx.sections.find((s) => s.name === name)?.text() ?? ''

console.log(`\n# dsh-claude-memory plugin contract\n  fixture=${fx.root}\n`)

check('module exports the loader contract', () => {
  assert.equal(pluginName, 'claude-memory')
  assert.deepEqual(inject, ['systemPrompt', 'tools'])
  assert.equal(typeof apply, 'function')
})

const ctx = fakeCtx()
apply(ctx, { claudeHome: fx.home, cwd: fx.ws, refreshMs: 0 })

check('registers exactly the two memory sections', () => {
  assert.deepEqual(ctx.sections.map((s) => s.name).sort(), [
    'claude-memory:global',
    'claude-memory:memory',
  ])
})

check('every prompt provider returns a string, never a promise', () => {
  for (const section of ctx.sections) {
    const value = section.text()
    assert.equal(typeof value, 'string', `${section.name} returned ${typeof value}`)
    assert.ok(!value.includes('[object Promise]'), `${section.name} leaked a promise`)
  }
})

check('sections have distinct finite orders', () => {
  const orders = ctx.sections.map((s) => s.order)
  assert.equal(new Set(orders).size, orders.length)
  for (const o of orders) assert.ok(Number.isFinite(o))
})

check('memory section carries the resolved project index', () => {
  const memory = sectionText(ctx, 'claude-memory:memory')
  assert.ok(memory.includes('Claude Code memory'), 'missing header')
  assert.ok(memory.includes(fx.wsProject.key), 'expected the current project key')
  assert.ok(memory.includes('first topic'), 'expected index content')
})

check('global section carries the inlined instructions', () => {
  const global = sectionText(ctx, 'claude-memory:global')
  assert.ok(global.includes('Claude Code global instructions'))
  assert.ok(global.includes('IMPORTED_MARKER_OK'), 'expected @import to be inlined')
  assert.ok(!/^@imported\.md$/m.test(global), 'import line must not survive')
})

check('no section leaks credential-shaped text', () => {
  for (const section of ctx.sections) {
    const { total, hits } = redactText(section.text())
    assert.equal(total, 0, `${section.name} leaks: ${JSON.stringify(hits)}`)
  }
})

check('injected prompt stays inside its byte budget', () => {
  assert.ok(byteLength(sectionText(ctx, 'claude-memory:memory')) <= 24000)
  assert.ok(byteLength(sectionText(ctx, 'claude-memory:global')) <= 6000)
})

check('registers the claude_memory tool', () => {
  assert.equal(ctx.registeredTools.length, 1)
  assert.equal(ctx.registeredTools[0].name, 'claude_memory')
  assert.equal(typeof ctx.registeredTools[0].execute, 'function')
  assert.equal(typeof ctx.registeredTools[0].output.render, 'function')
})

await checkAsync('tool executes and returns a registry-shaped value', async () => {
  const value = await ctx.registeredTools[0].execute({ action: 'projects' })
  assert.equal(typeof value.text, 'string')
  assert.ok(value.text.includes(fx.wsProject.key))
})

check('enableTool=false suppresses registration', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.ws, enableTool: false })
  assert.equal(bare.registeredTools.length, 0)
  assert.equal(bare.sections.length, 2)
})

check('enableMemory/enableGlobalInstructions=false produce empty sections', () => {
  const bare = fakeCtx()
  apply(bare, {
    claudeHome: fx.home,
    cwd: fx.ws,
    enableMemory: false,
    enableGlobalInstructions: false,
  })
  for (const section of bare.sections) assert.equal(section.text(), '')
})

check('a missing Claude home degrades to empty text without throwing', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: '/nonexistent-claude-home-xyz', cwd: fx.ws })
  for (const section of bare.sections) assert.equal(section.text(), '')
})

check('refreshMs=0 re-reads on every call and is stable for a static store', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.ws, refreshMs: 0 })
  const first = sectionText(bare, 'claude-memory:memory')
  const second = sectionText(bare, 'claude-memory:memory')
  assert.equal(first, second)
})

check('redactMode=report leaves text intact but is still counted', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.ws, redactMode: 'report' })
  const memory = sectionText(bare, 'claude-memory:memory')
  assert.ok(memory.includes('Claude Code memory'))
})

// --------------------------------------------------------------------------
// The server's cwd is not the session's cwd. These cover the agent-scoping fix.
// --------------------------------------------------------------------------

const SERVER_CWD = fx.hub

check('a fallback cwd with no matching project degrades gracefully', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: SERVER_CWD, refreshMs: 0 })
  const memory = sectionText(bare, 'claude-memory:memory')
  // hub has children, so a freshest guess is produced rather than nothing.
  assert.ok(memory.includes(fx.hubBProject.key), 'expected the freshest sibling')
})

check('agent/created shadows the global sections with the session cwd', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: SERVER_CWD, refreshMs: 0 })
  const { sections: agentSections, agent } = fakeAgent(fx.ws)
  bare.emit('agent/created', { agent })
  assert.deepEqual(agentSections.map((s) => s.name).sort(), [
    'claude-memory:global',
    'claude-memory:memory',
  ])
  const memory = agentSections.find((s) => s.name === 'claude-memory:memory').text()
  assert.equal(typeof memory, 'string')
  assert.ok(memory.includes(fx.wsProject.key), 'agent-scoped block must use the session cwd')
  assert.ok(!memory.includes('[object Promise]'))
})

check('an agent whose cwd equals the fallback is not shadowed', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.ws, refreshMs: 0 })
  const { sections: agentSections, agent } = fakeAgent(fx.ws)
  bare.emit('agent/created', { agent })
  assert.equal(agentSections.length, 0, 'global sections already cover this cwd')
})

check('an agent with no session cwd is ignored', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: SERVER_CWD, refreshMs: 0 })
  const { sections: agentSections, agent } = fakeAgent(undefined)
  bare.emit('agent/created', { agent })
  assert.equal(agentSections.length, 0)
})

check('a subdirectory of a git root resolves to the repo-level memory', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.repoWs, refreshMs: 0 })
  const memory = sectionText(bare, 'claude-memory:memory')
  assert.ok(memory.includes(fx.repoProject.key), 'expected the git-root project')
  assert.ok(memory.includes('enclosing git repository root'))
})

await checkAsync('the tool resolves against the calling agent cwd', async () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: SERVER_CWD, refreshMs: 0 })
  const tool = bare.registeredTools[0]
  const value = await tool.execute({ action: 'index' }, { agent: { session: { header: { cwd: fx.ws } } } })
  assert.ok(value.text.includes(fx.wsProject.key), value.text.slice(0, 200))
})

check('writing is off by default: no save action, no instructions section', () => {
  const tool = ctx.registeredTools[0]
  assert.ok(!tool.parameters.properties.action.enum.includes('save'))
  assert.ok(tool.description.includes('read-only'))
})

await checkAsync('enableWrite saves into the session git root and shows it next prompt', async () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: SERVER_CWD, refreshMs: 60000, enableWrite: true })
  const tool = bare.registeredTools[0]
  assert.ok(tool.parameters.properties.action.enum.includes('save'))
  assert.ok(!tool.description.includes('read-only'))

  const { sections: agentSections, agent } = fakeAgent(fx.repoWs)
  bare.emit('agent/created', { agent })
  assert.deepEqual(agentSections.map((s) => s.name).sort(), [
    'claude-memory:global',
    'claude-memory:instructions',
    'claude-memory:memory',
  ])
  const instructions = agentSections.find((s) => s.name === 'claude-memory:instructions').text()
  assert.ok(instructions.includes(`Saves go to project ${fx.repoProject.key}.`), instructions.slice(0, 600))

  const value = await tool.execute(
    { action: 'save', file: 'plugin-saved.md', name: 'Saved', description: 'saved via plugin', type: 'user', body: 'x' },
    { agent },
  )
  assert.ok(value.text.includes(`saved plugin-saved.md (${fx.repoProject.key})`), value.text)
  // refreshMs is long, so only the post-save refresh can make the entry visible.
  const memory = agentSections.find((s) => s.name === 'claude-memory:memory').text()
  assert.ok(memory.includes('saved via plugin'), 'saved entry must appear without waiting for refreshMs')
})

await checkAsync('enableWrite creates memory for a directory that has none', async () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.hub, refreshMs: 0, enableWrite: true })
  assert.ok(sectionText(bare, 'claude-memory:instructions').includes('has no memory yet'))
  const tool = bare.registeredTools[0]
  const value = await tool.execute({ action: 'save', file: 'hub.md', name: 'Hub', description: 'hub note', type: 'project', body: 'y' })
  assert.ok(value.text.includes(`(${fx.keyOf(fx.hub)})`), value.text)
  assert.ok(sectionText(bare, 'claude-memory:memory').includes('hub note'))
})

check('enableWrite without the tool stays read-only', () => {
  const bare = fakeCtx()
  apply(bare, { claudeHome: fx.home, cwd: fx.ws, refreshMs: 0, enableWrite: true, enableTool: false })
  assert.equal(bare.registeredTools.length, 0)
  assert.ok(!bare.sections.some((s) => s.name === 'claude-memory:instructions'))
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
