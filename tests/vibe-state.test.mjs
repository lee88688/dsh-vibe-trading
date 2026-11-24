import { test } from 'node:test'
import assert from 'node:assert/strict'

import { vibeProjectionDefinition, disclosureTurnCount, VIBE_PROJECTION_KEY } from '../dist/lib/vibe-state.js'

const definition = () => vibeProjectionDefinition()
const command = (word) => ({ type: 'command/run', data: { name: 'vibe-trading', args: word } })
const turnStart = (turn) => ({ type: 'turn/start', data: { turn } })
const userText = (text) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

test('the projection key is stable', () => {
  assert.equal(VIBE_PROJECTION_KEY, 'vibeTrading')
})

test('activation folds on and off command intents', () => {
  const unit = definition()
  let state = unit.init()
  assert.deepEqual(unit.wire.view(state), { requested: null, gate: {} })
  state = unit.apply(state, command('on'))
  assert.equal(state.requested, 'on')
  state = unit.apply(state, command('off'))
  assert.equal(state.requested, 'off')
})

test('a post-turn off is the refused one, so the chip keeps the on intent', () => {
  const unit = definition()
  let state = unit.apply(unit.init(), command('on'))
  state = unit.apply(state, turnStart(1))
  state = unit.apply(state, command('off'))
  assert.equal(unit.wire.view(state).requested, 'on')
})

test('a disclosure message records the unverified count for its turn', () => {
  const unit = definition()
  let state = unit.init()
  state = unit.apply(state, turnStart(3))
  state = unit.apply(state, userText('本次回答有 2 处数字没有通过核实。请修正后重新提交。'))
  assert.deepEqual(unit.wire.view(state).gate, { '3': { unverified: 2 } })
})

test('a structured disclosure carries details, passed values and exempted rules', () => {
  const unit = definition()
  const disclosure = [
    '本次回答有 2 处数字没有通过核实。请用一句话向用户说明"部分数字未能核实、需要复核"。',
    '- 未核实 0.62 ｜ 上下文：建议买入价 0.62 元 ｜ 原因：no_evidence',
    '- 未核实 37% ｜ 上下文：(1.053 - 0.666) / 1.053 ｜ 原因：value_mismatch',
    '- 已核实 2 项：0.666、0.646',
    '- 自动豁免 3 项（versions 2、urls 1）',
  ].join('\n')
  let state = unit.apply(unit.init(), turnStart(7))
  state = unit.apply(state, userText(disclosure))
  const gate = unit.wire.view(state).gate['7']
  assert.equal(gate.unverified, 2)
  assert.deepEqual(gate.details, [
    { value: '0.62', context: '建议买入价 0.62 元', reason: 'no_evidence' },
    { value: '37%', context: '(1.053 - 0.666) / 1.053', reason: 'value_mismatch' },
  ])
  assert.equal(gate.passed, 2)
  assert.deepEqual(gate.passedValues, ['0.666', '0.646'])
  assert.equal(gate.suppressed, 3)
  assert.deepEqual(gate.suppressedRules, [
    { rule: 'versions', count: 2 },
    { rule: 'urls', count: 1 },
  ])
})

test('an ignorable gate record supplies panel data without any disclosure text', () => {
  const unit = definition()
  const record = {
    type: 'plugin:dsh-vibe-trading/gate',
    ignorable: true,
    data: {
      v: 1,
      unverified: 2,
      details: [
        { value: '42.42%', context: '测试组合的收益率为 42.42%', reason: 'numeric_claim_unavailable' },
        { value: '7.77%', context: '最大回撤为 7.77%。', reason: 'numeric_claim_unavailable' },
      ],
      passed: 2,
      passedValues: ['182.40', '28.5'],
      suppressed: 2,
      suppressedRules: [{ rule: 'versions', count: 1 }, { rule: 'dates', count: 1 }],
    },
  }
  let state = unit.apply(unit.init(), turnStart(1))
  state = unit.apply(state, record)
  // A short disclosure that follows the record must not erase the details.
  state = unit.apply(state, userText('本次回答有 2 处数字没有通过核实。请修正后重新提交。'))
  const gate = unit.wire.view(state).gate['1']
  assert.equal(gate.unverified, 2)
  assert.deepEqual(gate.details, record.data.details)
  assert.equal(gate.passed, 2)
  assert.deepEqual(gate.passedValues, ['182.40', '28.5'])
  assert.equal(gate.suppressed, 2)
  assert.deepEqual(gate.suppressedRules, record.data.suppressedRules)
})

test('a gate record without details still records the count', () => {
  const unit = definition()
  const record = { type: 'plugin:dsh-vibe-trading/gate', ignorable: true, data: { v: 1, unverified: 3 } }
  let state = unit.apply(unit.init(), turnStart(4))
  state = unit.apply(state, record)
  assert.deepEqual(unit.wire.view(state).gate['4'], { unverified: 3 })
})

test('foreign or malformed records are ignored', () => {
  const unit = definition()
  let state = unit.apply(unit.init(), turnStart(5))
  const before = state
  state = unit.apply(state, { type: 'plugin:other/gate', ignorable: true, data: { unverified: 9 } })
  state = unit.apply(state, { type: 'plugin:dsh-vibe-trading/gate', ignorable: false, data: { unverified: 9 } })
  state = unit.apply(state, { type: 'plugin:dsh-vibe-trading/gate', ignorable: true, data: { unverified: -1 } })
  assert.equal(state, before)
})

test('a correction steer without a disclosure does not flag the turn', () => {
  const unit = definition()
  let state = unit.init()
  state = unit.apply(state, turnStart(1))
  state = unit.apply(state, userText('[GROUNDING GATE] The previous draft was rejected. Fix figure 999.99.'))
  assert.deepEqual(unit.wire.view(state).gate, {})
})

test('compaction checkpoints quoting the disclosure do not paint a gate panel', () => {
  const unit = definition()
  const checkpoint = {
    type: 'user/message',
    data: {
      role: 'user',
      source: { kind: 'compact-checkpoint', compactionId: 'c1' },
      content: [{ type: 'text', text: 'Earlier context quoted: 本次回答有 2 处数字没有通过核实。请修正。' }],
    },
  }
  let state = unit.apply(unit.init(), turnStart(13))
  state = unit.apply(state, checkpoint)
  assert.deepEqual(unit.wire.view(state).gate, {})
})

test('a user message that only quotes the disclosure is not a gate steer', () => {
  const unit = definition()
  let state = unit.apply(unit.init(), turnStart(3))
  state = unit.apply(state, userText('我刚才看到一条提示：本次回答有 2 处数字没有通过核实。'))
  assert.deepEqual(unit.wire.view(state).gate, {})
})

test('repeated disclosures for one turn keep the higher count', () => {
  const unit = definition()
  let state = unit.init()
  state = unit.apply(state, turnStart(2))
  state = unit.apply(state, userText('本次回答有 1 处数字没有通过核实。'))
  state = unit.apply(state, userText('本次回答有 4 处数字没有通过核实。'))
  state = unit.apply(state, userText('本次回答有 2 处数字没有通过核实。'))
  assert.deepEqual(unit.wire.view(state).gate, { '2': { unverified: 4 } })
})

test('ignored events keep the same state reference', () => {
  const unit = definition()
  const state = unit.apply(unit.init(), turnStart(1))
  assert.equal(unit.apply(state, { type: 'assistant/message', data: {} }), state)
  assert.equal(unit.apply(state, command('status')), state)
})

test('the gate map is culled to the most recent 20 turns', () => {
  const unit = definition()
  let state = unit.init()
  for (let turn = 1; turn <= 25; turn += 1) {
    state = unit.apply(state, turnStart(turn))
    state = unit.apply(state, userText(`本次回答有 ${turn} 处数字没有通过核实。`))
  }
  const turns = Object.keys(unit.wire.view(state).gate).map(Number).sort((a, b) => a - b)
  assert.equal(turns.length, 20)
  assert.equal(turns[0], 6)
  assert.equal(turns.at(-1), 25)
})

test('disclosureTurnCount tolerates both disclosure wordings', () => {
  assert.equal(disclosureTurnCount('本次回答有 7 处数字没有通过核实。'), 7)
  assert.equal(disclosureTurnCount('注意：上一版回答中的部分数字没有通过核实。请用一句话说明。'), 1)
  assert.equal(disclosureTurnCount('普通消息'), null)
})
