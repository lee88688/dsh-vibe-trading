import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { activate, createSessionRegistry, deactivate, sessionStatus } from '../dist/lib/activate.js'

const TOOLS = [
  { name: 'search_symbol', description: 'resolve', readonly: true, inputSchema: { type: 'object', properties: {} } },
  { name: 'get_market_data', description: 'ohlcv', readonly: true, inputSchema: { type: 'object', properties: {} } },
  { name: 'read_document', description: 'docs', readonly: true, inputSchema: { type: 'object', properties: {} } },
  { name: 'backtest', description: 'backtest', readonly: false, inputSchema: { type: 'object', properties: {} } },
  { name: 'financial_rigor', description: 'numbers', readonly: true, inputSchema: { type: 'object', properties: {} } },
]

const TOOLSETS = { staticCore: TOOLS.map((tool) => tool.name), groups: { research: ['x'] } }

function fakeAgent(id = 'agent-1') {
  const registered = []
  const sections = []
  const disposed = []
  return {
    id,
    registered,
    sections,
    disposed,
    ctx: {
      tools: {
        register(definition) {
          registered.push(definition)
          return () => disposed.push(definition.name)
        },
      },
      systemPrompt: {
        section(spec) {
          sections.push(spec)
          return () => disposed.push(`prompt:${spec.name}`)
        },
      },
    },
  }
}

function fakeWorker() {
  return {
    async request(method) {
      if (method === 'tools/list') return { tools: TOOLS, count: TOOLS.length }
      return {}
    },
  }
}

async function tempEnv() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-act-'))
  return { VIBE_TRADING_HOME: dir }
}

test('activate registers core tools, gateway tools and one prompt section', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  const sessions = createSessionRegistry()
  const result = await activate({
    agent,
    cfg: { worker: { defaultTimeoutMs: 1000, longTimeoutMs: 2000 } },
    worker: fakeWorker(),
    toolsets: TOOLSETS,
    promptText: 'PROMPT',
    sessions,
    env,
  })
  assert.equal(result.alreadyActive, false)
  assert.equal(result.coreTools.length, 5)
  assert.equal(result.toolCount, 5 + 4)
  const names = agent.registered.map((definition) => definition.name)
  for (const core of TOOLSETS.staticCore) assert.ok(names.includes(core), `missing ${core}`)
  for (const gateway of ['vt_load_tools', 'vt_call', 'vt_list_skills', 'vt_load_skill']) {
    assert.ok(names.includes(gateway), `missing ${gateway}`)
  }
  // DSH rejects tools without an output declaration ("must declare output").
  for (const definition of agent.registered) {
    assert.ok(definition.output, `${definition.name} has no output declaration`)
    assert.ok(definition.output.schema, `${definition.name} output.schema missing`)
    assert.equal(typeof definition.output.render, 'function', `${definition.name} output.render missing`)
    // DSH invokes isConcurrencySafe as a predicate over the call arguments; a
    // bare boolean is called and throws, which silently forces every call
    // exclusive (no error reaches the tool result).
    if (definition.isConcurrencySafe !== undefined) {
      assert.equal(typeof definition.isConcurrencySafe, 'function', `${definition.name} isConcurrencySafe must be a predicate`)
    }
  }
  const byName = new Map(agent.registered.map((definition) => [definition.name, definition]))
  assert.equal(byName.get('search_symbol').isConcurrencySafe({}), true)
  assert.equal(byName.get('backtest').isConcurrencySafe({}), false)
  assert.equal(agent.sections.length, 1)
  assert.equal(agent.sections[0].name, 'vibe-trading')
  assert.equal(agent.sections[0].interpolate, false)
  assert.equal(agent.sections[0].text(), 'PROMPT')
  assert.equal(sessions.size, 1)
})

test('activate registers plugin-provided extra tools (report_figures)', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  const sessions = createSessionRegistry()
  const extra = {
    name: 'report_figures',
    description: 'declare figures',
    parameters: { type: 'object', properties: { figures: { type: 'array', items: { type: 'string' } } } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] },
    async execute() { return 'ok' },
  }
  const result = await activate({
    agent,
    cfg: {},
    worker: fakeWorker(),
    toolsets: TOOLSETS,
    promptText: 'P',
    extraTools: [extra],
    sessions,
    env,
  })
  assert.equal(result.toolCount, 5 + 4 + 1)
  const names = agent.registered.map((definition) => definition.name)
  assert.ok(names.includes('report_figures'))
  assert.equal(agent.registered.length, 10)
})

test('activate is idempotent per session', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  const sessions = createSessionRegistry()
  const input = { agent, cfg: {}, worker: fakeWorker(), toolsets: TOOLSETS, promptText: 'P', sessions, env }
  await activate(input)
  const second = await activate(input)
  assert.equal(second.alreadyActive, true)
  assert.equal(agent.registered.length, 9)
})

test('sessions are independent', async () => {
  const env = await tempEnv()
  const sessions = createSessionRegistry()
  const worker = fakeWorker()
  const first = fakeAgent('a1')
  const second = fakeAgent('a2')
  await activate({ agent: first, cfg: {}, worker, toolsets: TOOLSETS, promptText: 'P', sessions, env })
  assert.equal(sessionStatus({ agentId: 'a1', sessions }).active, true)
  assert.equal(sessionStatus({ agentId: 'a2', sessions }).active, false)
  assert.equal(second.registered.length, 0)
})

test('deactivate disposes everything in reverse order and clears the session', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  const sessions = createSessionRegistry()
  await activate({ agent, cfg: {}, worker: fakeWorker(), toolsets: TOOLSETS, promptText: 'P', sessions, env })
  const result = await deactivate({ agentId: agent.id, sessions })
  assert.equal(result.wasActive, true)
  assert.equal(result.disposed, 9 + 1)
  assert.equal(agent.disposed.length, 10)
  // Reverse disposal: the prompt section (registered last) goes first.
  assert.equal(agent.disposed.at(0), 'prompt:vibe-trading')
  assert.equal(sessions.size, 0)
  const again = await deactivate({ agentId: agent.id, sessions })
  assert.equal(again.wasActive, false)
})

test('activate reports core tools the worker does not provide', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  const sessions = createSessionRegistry()
  const result = await activate({
    agent,
    cfg: {},
    worker: fakeWorker(),
    toolsets: { staticCore: ['search_symbol', 'ghost'], groups: {} },
    promptText: 'P',
    sessions,
    env,
  })
  assert.deepEqual(result.missingCore, ['ghost'])
  assert.deepEqual(result.coreTools, ['search_symbol'])
})

test('registration failures are recorded instead of thrown', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  agent.ctx.tools.register = () => {
    throw new Error('duplicate tool')
  }
  const sessions = createSessionRegistry()
  const result = await activate({
    agent,
    cfg: {},
    worker: fakeWorker(),
    toolsets: TOOLSETS,
    promptText: 'P',
    sessions,
    env,
  })
  assert.match(result.notice, /注册工具/)
  assert.equal(result.toolCount, 0)
})

test('worker tool results stay real text (await formatToolResult) and carry the call id', async () => {
  const env = await tempEnv()
  const agent = fakeAgent()
  const sessions = createSessionRegistry()
  const worker = {
    async request(method) {
      if (method === 'tools/list') return { tools: TOOLS, count: TOOLS.length }
      if (method === 'tools/call') return { text: '{"ok":true,"data":{"close":31.45}}', isError: false }
      return {}
    },
  }
  const grounding = {
    enabled: true,
    async beforeCall() {
      return { allowed: true }
    },
    async afterResult() {},
  }
  await activate({
    agent,
    cfg: {},
    worker,
    toolsets: TOOLSETS,
    promptText: 'P',
    grounding,
    sessions,
    env,
  })
  const definition = agent.registered.find((tool) => tool.name === 'search_symbol')
  const text = await definition.execute({ query: 'x' })
  assert.match(text, /"close":31.45/)
  assert.match(text, /\[tool_call_id: call-[0-9a-f]{8}\]/)
  assert.ok(!text.includes('[object Promise]'), 'tool result must not interpolate the format promise')
})
