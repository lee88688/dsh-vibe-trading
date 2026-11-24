import test from 'node:test'
import assert from 'node:assert/strict'

import { extractAssistantText, wireAnswerGate } from '../dist/index.js'

function fakeAgent() {
  const listeners = new Map()
  const steers = []
  const agent = {
    // Real DSH Agent: id is the SessionId and session is the Session object.
    id: 'session-1',
    session: { id: 'session-1' },
    ctx: {
      on(event, listener) {
        listeners.set(event, listener)
        return () => listeners.delete(event)
      },
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
    },
    steer: (message) => steers.push(message),
  }
  const emit = (event, ...args) => listeners.get(event)?.(...args)
  return { agent, listeners, steers, emit }
}

function fakeGrounding(results) {
  let index = 0
  return {
    enabled: true,
    async checkAnswer() {
      const value = results[Math.min(index, results.length - 1)]
      index += 1
      return value
    },
  }
}

const INVALID = {
  valid: false,
  released: null,
  correction: 'Figure 999.99 has no evidence; remove it.',
  fallback: null,
  issues: [{ code: 'numeric_claim_conflict' }],
  exhausted: false,
}
const EXHAUSTED = {
  valid: false,
  released: null,
  correction: null,
  fallback: '本次回答有 2 处数字没有通过核实。请向用户说明。',
  fallbackFull:
    '本次回答有 2 处数字没有通过核实。请向用户说明。\n- 未核实 999.99 ｜ 上下文：AAPL closed at 999.99 ｜ 原因：numeric_claim_conflict',
  issues: [{ code: 'numeric_claim_conflict' }, { code: 'x' }],
  panel: { v: 1, unverified: 2, details: [{ value: '999.99', context: 'AAPL closed at 999.99', reason: 'numeric_claim_conflict' }] },
  exhausted: true,
}
const VALID = { valid: true, released: null, correction: null, fallback: null, issues: [], exhausted: false }

test('extractAssistantText accepts the committed-message shapes', () => {
  assert.equal(extractAssistantText({ message: { content: [{ type: 'text', text: 'hello' }] } }), 'hello')
  assert.equal(extractAssistantText({ content: 'plain' }), 'plain')
  assert.equal(extractAssistantText('  raw  '), 'raw')
  assert.equal(extractAssistantText({ message: { content: [{ type: 'image' }] } }), null)
})

test('the gate captures the committed assistant text from session/event', async () => {
  const { agent, emit, steers } = fakeAgent()
  wireAnswerGate(agent, fakeGrounding([VALID]), { disposers: [] }, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'answer' }] } } })
  const next = () => 'closed'
  assert.equal(await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, next), 'closed')
  assert.equal(steers.length, 0)
})

test('an invalid draft is steered a correction and keeps the turn open', async () => {
  const { agent, emit, steers } = fakeAgent()
  wireAnswerGate(agent, fakeGrounding([INVALID]), { disposers: [] }, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'AAPL closed at 999.99' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, undefined)
  assert.equal(steers.length, 1)
  assert.match(steers[0].content[0].text, /999\.99|evidence/)
})

test('an exhausted turn closes on the panel instead of spending another round', async () => {
  const { agent, emit, steers } = fakeAgent()
  const records = []
  const state = {
    disposers: [],
    async appendRecord(_session, panel) {
      records.push(panel)
      return true
    },
  }
  wireAnswerGate(agent, fakeGrounding([EXHAUSTED]), state, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'draft' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, 'closed', 'the turn closes: no disclosure steer')
  assert.equal(steers.length, 0)
  assert.deepEqual(records, [EXHAUSTED.panel], 'the footer panel is persisted for the turn tail')
})

test('panel mode falls back to the disclosure text when the record bridge is unavailable', async () => {
  const { agent, emit, steers } = fakeAgent()
  const state = { disposers: [], async appendRecord() { return false } }
  wireAnswerGate(agent, fakeGrounding([EXHAUSTED]), state, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'draft' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, undefined, 'without a panel the turn stays open for the text disclosure')
  assert.equal(steers.length, 1)
  assert.match(steers[0].content[0].text, /未核实 999\.99/, 'the full text carries the details')
})

test('onFailure=disclose keeps the caveat in the transcript text', async () => {
  const { agent, emit, steers } = fakeAgent()
  const grounding = {
    enabled: true,
    failureMode: 'disclose',
    async checkAnswer() {
      return EXHAUSTED
    },
  }
  const state = { disposers: [], async appendRecord() { return true } }
  wireAnswerGate(agent, grounding, state, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'draft' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, undefined)
  assert.equal(steers.length, 1)
  assert.match(steers[0].content[0].text, /本次回答有 2 处数字没有通过核实/)
  assert.doesNotMatch(steers[0].content[0].text, /未核实 999\.99/, 'the panel record carried the details')
})

test('the gate matches agent.id (the SessionId) when session is an object', async () => {
  const { agent, emit, steers } = fakeAgent()
  assert.equal(typeof agent.session, 'object')
  assert.equal(agent.session.id, agent.id)
  wireAnswerGate(agent, fakeGrounding([INVALID]), { disposers: [] }, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'draft' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, undefined)
  assert.equal(steers.length, 1)
})

test('events from another session are ignored', async () => {
  const { agent, emit, steers } = fakeAgent()
  wireAnswerGate(agent, fakeGrounding([INVALID]), { disposers: [] }, () => {})
  emit('session/event', { id: 'other-session' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'x' }] } } })
  assert.equal(await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed'), 'closed')
  assert.equal(steers.length, 0)
})

test('turn/start resets the per-turn grounding ledger', async () => {
  const { agent, emit } = fakeAgent()
  let resets = 0
  const grounding = {
    enabled: true,
    silent: false,
    async resetTurn() {
      resets += 1
    },
    async checkAnswer() {
      return VALID
    },
  }
  wireAnswerGate(agent, grounding, { disposers: [] }, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'turn/start', data: { turn: 2 } })
  assert.equal(resets, 1)
})

test('only the user-authored message seeds the identity gate', async () => {
  const { agent, emit } = fakeAgent()
  const seeded = []
  const grounding = {
    enabled: true,
    silent: false,
    async resetTurn() {},
    async checkAnswer() {
      return VALID
    },
    setUserMessage(text) {
      seeded.push(text)
    },
  }
  wireAnswerGate(agent, grounding, { disposers: [] }, () => {})
  // DSH 0.2.2-rc.5 injects host context as user-role records carrying a
  // non-user source; those must not become the gate's `user_message`.
  emit(
    'session/event',
    { id: 'session-1' },
    {
      type: 'user/message',
      data: {
        content: [{ type: 'text', text: '<system-reminder>runtime context</system-reminder>' }],
        source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
      },
    },
  )
  emit(
    'session/event',
    { id: 'session-1' },
    {
      type: 'user/message',
      data: { content: [{ type: 'text', text: '<system-reminder>time context</system-reminder>' }], source: { kind: 'time-context' } },
    },
  )
  assert.equal(seeded.length, 0)
  emit(
    'session/event',
    { id: 'session-1' },
    {
      type: 'user/message',
      data: { id: 'm1', role: 'user', content: [{ type: 'text', text: '查 AAPL 收盘价' }], source: { kind: 'user' } },
    },
  )
  assert.deepEqual(seeded, ['查 AAPL 收盘价'])
})

test('silent mode writes neither a panel nor a steer', async () => {
  const { agent, emit, steers } = fakeAgent()
  const records = []
  const grounding = {
    enabled: true,
    silent: true,
    async resetTurn() {},
    async checkAnswer() {
      return EXHAUSTED
    },
  }
  const state = { disposers: [], async appendRecord(_session, panel) { records.push(panel); return true } }
  wireAnswerGate(agent, grounding, state, () => {})
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'draft' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, 'closed')
  assert.equal(steers.length, 0)
  assert.equal(records.length, 0)
})

test('a disabled gate keeps the listeners wired but never checks or steers', async () => {
  const { agent, emit, listeners, steers } = fakeAgent()
  let checks = 0
  const grounding = {
    get enabled() {
      return false
    },
    async resetTurn() {},
    async checkAnswer() {
      checks += 1
      return INVALID
    },
  }
  wireAnswerGate(agent, grounding, { disposers: [] }, () => {})
  // Registered even while disabled: the setting is live, so switching the gate
  // on from the plugin page must not require a new activation.
  assert.equal(listeners.size, 2)
  emit('session/event', { id: 'session-1' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'draft' }] } } })
  const result = await emit('agent/turn-stopping', { agent, turn: 1, signal: new AbortController().signal }, () => 'closed')
  assert.equal(result, 'closed')
  assert.equal(steers.length, 0)
  assert.equal(checks, 0)
})
