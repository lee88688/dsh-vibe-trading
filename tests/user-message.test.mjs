import test from 'node:test'
import assert from 'node:assert/strict'

import { userMessage } from '../dist/index.js'

/**
 * Injected messages are persisted verbatim and validated on reload, so they must
 * look like a UI-submitted user message: identity + role + content + source.
 * A bare `{ content, source }` payload corrupts the Session on the next load
 * ("session event ... lacks an identified message").
 */
test('userMessage carries identity, role, content and source', () => {
  const message = userMessage('hello')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0, 'id must be a non-empty string')
  assert.equal(message.role, 'user')
  assert.deepEqual(message.content, [{ type: 'text', text: 'hello' }])
  assert.deepEqual(message.source, { kind: 'user' })
})

test('each injected message gets its own identity', () => {
  const first = userMessage('a')
  const second = userMessage('b')
  assert.notEqual(first.id, second.id)
})

test('empty text still produces a valid message', () => {
  const message = userMessage('')
  assert.equal(typeof message.id, 'string')
  assert.ok(message.id.length > 0)
  assert.deepEqual(message.content, [{ type: 'text', text: '' }])
})
