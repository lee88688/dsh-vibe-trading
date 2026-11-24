import test from 'node:test'
import assert from 'node:assert/strict'

import { createGrounding } from '../dist/lib/verify.js'

function fakeWorker(handlers = {}) {
  const calls = []
  return {
    calls,
    async request(method, params) {
      calls.push([method, params])
      const handler = handlers[method]
      if (handler) return handler(params)
      if (method === 'grounding/create') return { ok: true }
      return { ok: true }
    },
  }
}

test('disabled gate is a no-op', async () => {
  const worker = fakeWorker()
  const grounding = createGrounding({ worker, agentId: 'a', cfg: { verification: { enabled: false } }, env: {} })
  assert.equal(grounding.enabled, false)
  assert.deepEqual(await grounding.beforeCall('get_market_data', {}), { allowed: true })
  const verdict = await grounding.checkAnswer('anything 123')
  assert.equal(verdict.valid, true)
  assert.equal(worker.calls.length, 0)
})

test('identity gate blocks and returns the required action', async () => {
  const worker = fakeWorker({
    'grounding/authorize': () => ({
      allowed: false,
      error_code: 'identity_required',
      message: 'identity not locked',
      required_action: 'Call search_symbol first.',
    }),
  })
  const grounding = createGrounding({
    worker,
    agentId: 'a',
    cfg: { verification: { enabled: true } },
    env: {},
  })
  const decision = await grounding.beforeCall('get_market_data', { codes: ['AAPL.US'] })
  assert.equal(decision.allowed, false)
  assert.match(decision.message, /identity_required/)
  assert.match(decision.message, /search_symbol/)
  assert.equal(worker.calls[0][0], 'grounding/create')
  assert.equal(worker.calls[1][0], 'grounding/authorize')
})

test('ingest forwards the untruncated payload once per session', async () => {
  const worker = fakeWorker()
  const grounding = createGrounding({ worker, agentId: 's1', cfg: { verification: { enabled: true } }, env: {} })
  await grounding.afterResult('get_market_data', { codes: ['AAPL.US'] }, '{"data":[1,2,3]}', true)
  await grounding.afterResult('search_symbol', { query: 'x' }, '{}', true)
  const creates = worker.calls.filter(([method]) => method === 'grounding/create')
  assert.equal(creates.length, 1)
  const ingests = worker.calls.filter(([method]) => method === 'grounding/ingest')
  assert.equal(ingests.length, 2)
  assert.equal(ingests[0][1].result, '{"data":[1,2,3]}')
  assert.equal(ingests[0][1].success, true)
})

test('answer gate asks for a correction, then falls back after maxRevisions', async () => {
  let mode = 'invalid'
  const worker = fakeWorker({
    'grounding/validate': () =>
      mode === 'invalid'
        ? {
            valid: false,
            issues: [{ code: 'numeric_claim_conflict' }],
            released_text: 'AAPL.US closed at 999.99 USD.',
            correction_prompt: 'Figure 999.99 has no evidence; remove it or cite the tool.',
          }
        : { valid: true, issues: [], released_text: 'clean answer' },
  })
  const grounding = createGrounding({
    worker,
    agentId: 'a',
    cfg: { verification: { enabled: true, maxRevisions: 2 } },
    env: {},
  })

  const first = await grounding.checkAnswer('draft')
  assert.equal(first.valid, false)
  assert.match(first.correction, /no evidence/)

  const second = await grounding.checkAnswer('draft')
  assert.equal(second.valid, false)
  assert.equal(second.exhausted, true)
  assert.ok(second.fallback)
  assert.match(second.fallback, /未能核实|需要复核/)

  mode = 'valid'
  const recovered = await grounding.checkAnswer('clean answer')
  assert.equal(recovered.valid, true)
})

test('onFailure=disclose asks the model to disclose instead of fabricating', async () => {
  const worker = fakeWorker({
    'grounding/validate': () => ({ valid: false, issues: [{}], released_text: 'bad 1 2 3' }),
  })
  const grounding = createGrounding({
    worker,
    agentId: 'a',
    cfg: { verification: { enabled: true, maxRevisions: 0, onFailure: 'disclose' } },
    env: {},
  })
  const verdict = await grounding.checkAnswer('bad')
  assert.equal(verdict.exhausted, true)
  assert.match(verdict.fallback, /未能核实|需要复核/)
})

test('the short disclosure keeps details out of the steered message', async () => {
  const worker = fakeWorker({
    'grounding/validate': () => ({
      valid: false,
      issues: [{ code: 'no_evidence' }, { code: 'figure_undeclared' }],
      details: [
        { value: '0.62', context: '建议买入价 0.62 元', reason: 'no_evidence' },
        { value: '37%', context: '(1.053 - 0.666) / 1.053', reason: 'value_mismatch' },
      ],
      details_truncated: 0,
      passed_count: 2,
      passed_values: ['0.666', '0.646'],
      suppressed_count: 3,
      suppressed_rules: [{ rule: 'versions', count: 2 }, { rule: 'urls', count: 1 }],
    }),
  })
  const grounding = createGrounding({
    worker,
    agentId: 'a',
    cfg: { verification: { enabled: true, maxRevisions: 0, onFailure: 'disclose' } },
    env: {},
  })
  const verdict = await grounding.checkAnswer('bad')
  assert.equal(verdict.exhausted, true)
  assert.match(verdict.fallback, /本次回答有 2 处数字没有通过核实/)
  assert.doesNotMatch(verdict.fallback, /未核实 0\.62/)
  assert.doesNotMatch(verdict.fallback, /- 已核实/)
  // The fallback data source stays complete for hosts without the plugin-record bridge.
  assert.match(verdict.fallbackFull, /- 未核实 0\.62 ｜ 上下文：建议买入价 0\.62 元 ｜ 原因：no_evidence/)
  assert.match(verdict.fallbackFull, /- 未核实 37% ｜ 上下文：\(1\.053 - 0\.666\) \/ 1\.053 ｜ 原因：value_mismatch/)
  assert.match(verdict.fallbackFull, /- 已核实 2 项：0\.666、0\.646/)
  assert.match(verdict.fallbackFull, /- 自动豁免 3 项（versions 2、urls 1）/)
  assert.deepEqual(verdict.panel, {
    v: 1,
    unverified: 2,
    details: [
      { value: '0.62', context: '建议买入价 0.62 元', reason: 'no_evidence' },
      { value: '37%', context: '(1.053 - 0.666) / 1.053', reason: 'value_mismatch' },
    ],
    passed: 2,
    passedValues: ['0.666', '0.646'],
    suppressed: 3,
    suppressedRules: [
      { rule: 'versions', count: 2 },
      { rule: 'urls', count: 1 },
    ],
  })
})

test('worker failures degrade to allowed/valid instead of throwing', async () => {
  const worker = {
    async request() {
      throw new Error('worker exploded')
    },
  }
  const grounding = createGrounding({ worker, agentId: 'a', cfg: { verification: { enabled: true } }, env: {} })
  assert.deepEqual(await grounding.beforeCall('x', {}), { allowed: true })
  await grounding.afterResult('x', {}, '{}', true)
  const verdict = await grounding.checkAnswer('draft')
  assert.equal(verdict.valid, true)
  assert.match(grounding.state.degraded, /worker exploded/)
})

test('identityGate=false keeps only the figures gate', async () => {
  const worker = fakeWorker()
  const grounding = createGrounding({
    worker,
    agentId: 'a',
    cfg: { verification: { enabled: true, identityGate: false } },
    env: {},
  })
  assert.deepEqual(await grounding.beforeCall('x', {}), { allowed: true })
  assert.equal(worker.calls.length, 0)
})
