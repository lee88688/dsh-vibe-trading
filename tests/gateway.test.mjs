import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { compactSignature, createGatewayTools, isComplexTool } from '../dist/lib/gateway.js'

const TOOLS = [
  {
    name: 'search_symbol',
    description: 'Resolve a symbol.',
    readonly: true,
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'query' },
        limit: { type: 'integer', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_market_data',
    description: 'Fetch OHLCV.',
    readonly: true,
    inputSchema: {
      type: 'object',
      properties: {
        codes: { type: 'array', items: { type: 'string' } },
        start_date: { type: 'string' },
        end_date: { type: 'string' },
        source: { type: 'string', enum: ['auto', 'yfinance'] },
        interval: { type: 'string', default: '1D' },
        max_rows: { type: 'integer', default: 250 },
      },
      required: ['codes', 'start_date', 'end_date'],
    },
  },
  {
    name: 'add_goal_evidence',
    description: 'Complex tool with many parameters.',
    readonly: false,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(
        ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((key) => [key, { type: 'string' }]),
      ),
    },
  },
  { name: 'read_file', description: 'Read a file.', readonly: true, inputSchema: { type: 'object', properties: {} } },
  { name: 'write_file', description: 'Write a file.', readonly: false, inputSchema: { type: 'object', properties: {} } },
  { name: 'report_audit', description: 'Audit.', readonly: true, inputSchema: { type: 'object', properties: {} } },
]

const TOOLSETS = {
  staticCore: ['search_symbol'],
  groups: {
    research: ['search_symbol'],
    backtest: ['get_market_data'],
    quant: ['get_market_data'],
    verify: ['report_audit'],
    team: ['report_audit'],
    'trading-reads': ['report_audit'],
    goals: ['add_goal_evidence'],
    runio: ['read_file', 'write_file'],
    series: ['phantom_tool'],
  },
}

function makeWorker({ callResult } = {}) {
  const calls = []
  return {
    calls,
    async request(method, params = {}) {
      calls.push([method, params])
      if (method === 'tools/list') return { tools: TOOLS, count: TOOLS.length }
      if (method === 'skills/list') {
        return {
          skills: [
            { name: 'backtest-diagnose', description: 'Diagnose backtests.', category: 'strategy' },
            { name: 'tushare', description: 'A-share data.', category: 'data-source' },
          ],
        }
      }
      if (method === 'tools/call') return callResult ?? { text: '{"ok":true}', isError: false }
      if (method === 'skills/load') return { text: '# Skill\nbody', mode: 'document' }
      throw new Error(`unexpected method ${method}`)
    },
  }
}

function makeSession() {
  return { loaded: new Set() }
}

function tempEnv() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'vt-gw-')).then((dir) => ({ VIBE_TRADING_HOME: dir }))
}

test('compactSignature renders required/optional, enums and defaults', () => {
  const signature = compactSignature(TOOLS[1])
  assert.match(signature, /^get_market_data\(/)
  assert.match(signature, /codes: array/)
  assert.match(signature, /source\?: string = "auto"\|"yfinance"/)
  assert.match(signature, /interval\?: string = "1D"/)
  assert.match(signature, /max_rows\?: integer = 250/)
  assert.ok(signature.endsWith('-> JSON'))
})

test('isComplexTool flags wide schemas only', () => {
  assert.equal(isComplexTool(TOOLS[0]), false)
  assert.equal(isComplexTool(TOOLS[2]), true)
})

test('every gateway tool declares a DSH output contract', () => {
  const env = { VIBE_TRADING_HOME: '/tmp/vt-gw-output' }
  const tools = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  for (const definition of tools) {
    assert.ok(definition.output, `${definition.name} has no output declaration`)
    assert.ok(definition.output.schema, `${definition.name} output.schema missing`)
    assert.equal(typeof definition.output.render, 'function')
  }
})

test('vt_load_tools loads a toolset and marks tools callable', async () => {
  const env = await tempEnv()
  const session = makeSession()
  const [load, call] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'agent-1',
    session,
    cfg: { worker: { defaultTimeoutMs: 1000 } },
    env,
  })
  const text = await load.execute({ toolset: 'backtest' })
  assert.match(text, /get_market_data/)
  assert.ok(session.loaded.has('get_market_data'))

  const result = await call.execute({ name: 'get_market_data', arguments: { codes: ['AAPL.US'] } })
  assert.match(result, /"ok":true/)
})

test('vt_load_tools rejects unknown groups, blocked and unknown tools', async () => {
  const env = await tempEnv()
  const [load] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  assert.match(await load.execute({ toolset: 'nope' }), /未知工具组/)
  assert.match(await load.execute({ names: ['qveris_search'] }), /未在本部署开放/)
  assert.match(await load.execute({ names: ['phantom_tool'] }), /worker 未提供/)
  assert.match(await load.execute({}), /请提供 toolset 或 names/)
})

test('vt_load_tools defaults to the complete schema with descriptions', async () => {
  const env = await tempEnv()
  const [load] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  const text = await load.execute({ toolset: 'goals' })
  assert.match(text, /add_goal_evidence — Complex tool with many parameters/)
  assert.match(text, /inputSchema: \{/)
})

test('vt_load_tools full detail keeps every enum value and nested constraints', async () => {
  const env = await tempEnv()
  const [load] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  const text = await load.execute({ toolset: 'backtest' })
  assert.match(text, /get_market_data — Fetch OHLCV\./)
  assert.match(text, /"enum":\["auto","yfinance"\]/)
  assert.match(text, /"required":\["codes","start_date","end_date"\]/)
})

test('vt_load_tools compact detail keeps the legacy signature plus a short description', async () => {
  const env = await tempEnv()
  const [load] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  const text = await load.execute({ toolset: 'backtest', detail: 'compact' })
  assert.match(text, /get_market_data\(codes: array, start_date: string, end_date: string/)
  assert.match(text, /— Fetch OHLCV\./)
  assert.doesNotMatch(text, /"enum"/)
})

test('every advertised toolset loads through vt_load_tools', async () => {
  const env = await tempEnv()
  const [load] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  for (const group of Object.keys(TOOLSETS.groups)) {
    if (group === 'series') continue
    const text = await load.execute({ toolset: group })
    assert.ok(!/未知工具组|未在本部署开放|worker 未提供/.test(text), `group ${group} failed: ${text.slice(0, 120)}`)
  }
})

test('vt_call ingests the untruncated full_text when the worker provides one', async () => {
  const env = await tempEnv()
  const session = makeSession()
  session.loaded.add('get_market_data')
  const ingested = []
  const grounding = { beforeCall: async () => ({ allowed: true }), afterResult: async (name, args, raw) => ingested.push(raw) }
  const worker = makeWorker({ callResult: { text: 'capped', full_text: 'full payload', full_path: 'C:/tmp/x.json' } })
  const [, call] = createGatewayTools({ worker, toolsets: TOOLSETS, agentId: 'a', session, cfg: {}, env, grounding })
  await call.execute({ name: 'get_market_data', arguments: { codes: ['AAPL.US'] } })
  assert.deepEqual(ingested, ['full payload'])
})

test('vt_call returns the worker-capped text untouched when a full result was saved', async () => {
  const env = await tempEnv()
  const session = makeSession()
  session.loaded.add('get_market_data')
  const longText = `${'y'.repeat(9_000)}\n\n[FULL RESULT SAVED: C:/tmp/full.json]`
  const worker = makeWorker({ callResult: { text: longText, full_path: 'C:/tmp/full.json' } })
  const [, call] = createGatewayTools({ worker, toolsets: TOOLSETS, agentId: 'a', session, cfg: {}, env })
  const text = await call.execute({ name: 'get_market_data', arguments: { codes: ['AAPL.US'] } })
  assert.equal(text, longText)
})

test('vt_call refuses tools that were not loaded', async () => {
  const env = await tempEnv()
  const [, call] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  assert.match(await call.execute({ name: 'report_audit', arguments: {} }), /尚未加载/)
})

test('vt_call forwards session_id and reports worker errors as text', async () => {
  const env = await tempEnv()
  const worker = makeWorker()
  const session = makeSession()
  session.loaded.add('report_audit')
  const [, call] = createGatewayTools({ worker, toolsets: TOOLSETS, agentId: 'agent-9', session, cfg: {}, env })
  await call.execute({ name: 'report_audit', arguments: { mode: 'extract' } })
  const [, params] = worker.calls.at(-1)
  assert.equal(params.session_id, 'agent-9')

  const brokenWorker = {
    async request() {
      const error = new Error("unknown tool 'x'")
      error.data = { kind: 'unknown_tool' }
      throw error
    },
  }
  const [, brokenCall] = createGatewayTools({
    worker: brokenWorker,
    toolsets: TOOLSETS,
    agentId: 'a',
    session,
    cfg: {},
    env,
  })
  const text = await brokenCall.execute({ name: 'report_audit', arguments: {} })
  assert.match(text, /失败：unknown tool/)
  assert.match(text, /unknown_tool/)
})

test('vt_list_skills filters by category and keyword', async () => {
  const env = await tempEnv()
  const [, , list] = createGatewayTools({
    worker: makeWorker(),
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  const all = await list.execute({})
  assert.match(all, /backtest-diagnose/)
  assert.match(all, /tushare/)
  const filtered = await list.execute({ category: 'data-source' })
  assert.ok(filtered.includes('tushare'))
  assert.ok(!filtered.includes('backtest-diagnose'))
  const byQuery = await list.execute({ query: 'backtests' })
  assert.ok(byQuery.includes('backtest-diagnose'))
  assert.match(await list.execute({ query: 'zzz' }), /没有匹配/)
})

test('vt_load_skill forwards section and offset', async () => {
  const env = await tempEnv()
  const worker = makeWorker()
  const [, , , loadSkill] = createGatewayTools({
    worker,
    toolsets: TOOLSETS,
    agentId: 'a',
    session: makeSession(),
    cfg: {},
    env,
  })
  const text = await loadSkill.execute({ name: 'tushare', section: 'Tushare', offset: 100 })
  assert.match(text, /# Skill/)
  const [, params] = worker.calls.at(-1)
  assert.deepEqual(params, { name: 'tushare', section: 'Tushare', offset: 100 })
})
