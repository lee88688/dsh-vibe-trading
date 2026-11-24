import test from 'node:test'
import assert from 'node:assert/strict'

import { sessionHasStarted } from '../dist/index.js'

/**
 * `/vibe-trading off` is refused once a session has run a turn; the probe reads
 * committed events through `ctx.agents.turnBoundaryOf(session)`. Any absent API
 * or unreadable session must answer "not started" so a probe failure never turns
 * into a refusal.
 */

const session = { id: 'session-1' }

function agentWith(value) {
  return { id: 'session-1', session: value }
}

test('no agent or session reports not started', () => {
  assert.equal(sessionHasStarted(undefined, { turnBoundaryOf: () => ({ lastTurn: 3 }) }), false)
  assert.equal(sessionHasStarted({ id: 'session-1' }, { turnBoundaryOf: () => ({ lastTurn: 3 }) }), false)
})

test('first turn marks the session as started', () => {
  const agents = { turnBoundaryOf: (s) => ({ lastTurn: s === session ? 1 : 0 }) }
  assert.equal(sessionHasStarted(agentWith(session), agents), true)
})

test('session without a finished turn stays closeable', () => {
  const agents = { turnBoundaryOf: () => ({ lastTurn: 0 }) }
  assert.equal(sessionHasStarted(agentWith(session), agents), false)
})

test('missing or throwing probe answers not started', () => {
  assert.equal(sessionHasStarted(agentWith(session), undefined), false)
  assert.equal(sessionHasStarted(agentWith(session), {}), false)
  assert.equal(
    sessionHasStarted(agentWith(session), {
      turnBoundaryOf: () => {
        throw new Error('event log unavailable')
      },
    }),
    false,
  )
  assert.equal(sessionHasStarted(agentWith(session), { turnBoundaryOf: () => undefined }), false)
})
