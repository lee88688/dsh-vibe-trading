import test from 'node:test'
import assert from 'node:assert/strict'

import { advertisedToolNames, credentialGatedOff, filterToolsets, surfaceReport } from '../dist/lib/surface.js'

const toolsets = {
  staticCore: ['get_market_data', 'run_backtest'],
  groups: {
    core: ['get_market_data', 'get_financial_statements'],
    research: ['list_research_artifacts', 'save_research_artifact'],
  },
  localTools: [{ name: 'report_figures', description: 'local plugin tool' }],
}

test('advertisedToolNames deduplicates static core and group members', () => {
  const names = advertisedToolNames(toolsets)
  assert.deepEqual(
    [...names].sort(),
    ['get_financial_statements', 'get_market_data', 'list_research_artifacts', 'run_backtest', 'save_research_artifact'],
  )
  assert.equal(names.has('report_figures'), false, 'plugin-local tools are not worker tools')
})

test('surfaceReport passes when every advertised tool is live', () => {
  const tools = [...advertisedToolNames(toolsets)].map((name) => ({ name }))
  const report = surfaceReport(tools, toolsets)
  assert.deepEqual(report, {
    ok: true,
    expectedCount: 5,
    liveCount: 5,
    missing: [],
  })
})

test('surfaceReport reports renamed or dropped tools as drift', () => {
  const tools = [
    { name: 'get_market_data' },
    { name: 'run_backtest' },
    { name: 'get_financial_statements' },
    // 0.1.20 renamed the research tool: the catalog would be stale.
    { name: 'research_artifact_list' },
  ]
  const report = surfaceReport(tools, toolsets)
  assert.equal(report.ok, false)
  assert.equal(report.liveCount, 4)
  assert.deepEqual(report.missing.sort(), ['list_research_artifacts', 'save_research_artifact'])
})

test('surfaceReport tolerates missing or malformed input', () => {
  assert.deepEqual(surfaceReport(undefined, undefined), {
    ok: true,
    expectedCount: 0,
    liveCount: 0,
    missing: [],
  })
  const report = surfaceReport([{ name: 3 }, {}, null], { staticCore: ['x'], groups: {} })
  assert.equal(report.liveCount, 1)
  assert.deepEqual(report.missing, ['x'])

  // A typo'd toolsets.json must degrade to "no advertised names", not throw.
  assert.deepEqual(surfaceReport([], { staticCore: 'abc', groups: { core: 'not-an-array' } }).missing, [])
  assert.deepEqual(advertisedToolNames({ staticCore: 'abc', groups: { core: ['a'] } }), new Set(['a']))
})

const gated = {
  staticCore: ['get_market_data'],
  groups: { research: ['get_macro_series', 'get_stock_news'] },
  credentialGated: { get_macro_series: 'FRED_API_KEY' },
}

test('credentialGatedOff only reports documented gates the worker says are closed', () => {
  assert.deepEqual(
    credentialGatedOff(gated, { key_gated: { get_macro_series: { available: false } } }),
    ['get_macro_series'],
  )
  assert.deepEqual(
    credentialGatedOff(gated, { key_gated: { get_macro_series: { available: true } } }),
    [],
    'a configured credential keeps the tool advertised',
  )
  // An older worker (no capabilities) or an undocumented name must not hide tool.
  assert.deepEqual(credentialGatedOff(gated, null), [])
  assert.deepEqual(credentialGatedOff(gated, { key_gated: { get_stock_news: { available: false } } }), [])
})

test('filterToolsets removes unavailable names from groups only', () => {
  const filtered = filterToolsets(gated, ['get_macro_series'])
  assert.deepEqual(filtered.groups.research, ['get_stock_news'])
  assert.deepEqual(filtered.staticCore, ['get_market_data'])
  assert.equal(filtered.credentialGated.get_macro_series, 'FRED_API_KEY', 'metadata stays for reporting')
  // The input is not mutated, and an empty drop list returns the same object.
  assert.deepEqual(gated.groups.research, ['get_macro_series', 'get_stock_news'])
  assert.equal(filterToolsets(gated, []), gated)

  // A filtered view must not report drift for the tools it dropped.
  const tools = [{ name: 'get_market_data' }, { name: 'get_stock_news' }]
  assert.equal(surfaceReport(tools, filtered).ok, true)
})
