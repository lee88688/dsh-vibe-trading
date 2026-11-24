import { test } from 'node:test'
import assert from 'node:assert/strict'

import { gateRecordOf, appendGateRecord, GATE_RECORD_TYPE } from '../dist/lib/gate-record.js'

const record = (data) => ({ type: GATE_RECORD_TYPE, ignorable: true, data })

test('the record type follows the plugin-record grammar', () => {
  assert.match(GATE_RECORD_TYPE, /^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/)
})

test('gateRecordOf reads a bounded panel and drops unknown fields', () => {
  const panel = gateRecordOf(
    record({
      v: 1,
      unverified: 2,
      details: [
        { value: ' 0.62 ', context: '建议买入价 0.62 元', reason: 'no_evidence', extra: 'x' },
        { value: '37%', context: 'a\nb', reason: '' },
        null,
      ],
      passed: 2,
      passedValues: ['0.666', '', '0.646'],
      suppressed: 3,
      suppressedRules: [{ rule: 'versions', count: 2 }, { rule: 'urls' }],
      stray: 'ignored',
    }),
  )
  assert.deepEqual(panel, {
    v: 1,
    unverified: 2,
    details: [
      { value: '0.62', context: '建议买入价 0.62 元', reason: 'no_evidence' },
      { value: '37%', context: 'a b', reason: 'unverified' },
    ],
    passed: 2,
    passedValues: ['0.666', '0.646'],
    suppressed: 3,
    suppressedRules: [{ rule: 'versions', count: 2 }, { rule: 'urls', count: 0 }],
  })
})

test('gateRecordOf is total: foreign events answer null', () => {
  assert.equal(gateRecordOf(undefined), null)
  assert.equal(gateRecordOf({}), null)
  assert.equal(gateRecordOf({ type: 'turn/start', data: {} }), null)
  assert.equal(gateRecordOf({ type: GATE_RECORD_TYPE, data: { unverified: 1 } }), null)
  assert.equal(gateRecordOf(record({ unverified: 'many' })), null)
  assert.equal(gateRecordOf(record(null)), null)
})

test('appendGateRecord degrades without the host bridge', async () => {
  let calls = 0
  const fakeSession = {
    append() {
      calls += 1
    },
  }
  const ok = await appendGateRecord(fakeSession, { v: 1, unverified: 1 })
  // The checkout has no @deepseek-ai/dsh-session module for the test process, so
  // the bridge must report failure instead of throwing or writing a plain event.
  assert.equal(ok, false)
  assert.equal(calls, 0)
})

test('appendGateRecord answers false without a session', async () => {
  assert.equal(await appendGateRecord(null, { v: 1, unverified: 1 }), false)
})
