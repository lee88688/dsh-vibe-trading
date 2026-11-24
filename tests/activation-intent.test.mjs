import { test } from 'node:test'
import assert from 'node:assert/strict'

import { activationIntent, activationIntentFromEvents, shouldRestoreOnCreation } from '../dist/lib/activation-intent.js'

const command = (word) => ({ type: 'command/run', data: { name: 'vibe-trading', args: ` ${word}` } })

test('an on command is the auto-restore intent', () => {
  assert.equal(activationIntentFromEvents([command('on')]), true)
})

test('off clears the intent', () => {
  assert.equal(activationIntentFromEvents([command('on'), command('off')]), false)
})

test('an early off stays off even after status/config commands', () => {
  assert.equal(
    activationIntentFromEvents([command('on'), command('off'), command('status'), command('config get verification.enabled')]),
    false,
  )
})

test('other commands and malformed events are ignored', () => {
  assert.equal(activationIntentFromEvents([]), false)
  assert.equal(activationIntentFromEvents([{ type: 'command/run', data: { name: 'other', args: 'on' } }]), false)
  assert.equal(activationIntentFromEvents([{ type: 'command/run', data: { name: 'vibe-trading' } }]), false)
  assert.equal(activationIntentFromEvents([null, undefined, { type: 'turn/start' }]), false)
})

test('repeated on commands are idempotent', () => {
  assert.equal(activationIntentFromEvents([command('on'), command('on')]), true)
})

test('an off after the first turn is the refused one, so it keeps the intent', () => {
  // /vibe-trading off refuses once the conversation started; the invocation is
  // still committed as command/run, so folding it as "off" would make a reload
  // silently drop the session's tools.
  const turn = { type: 'turn/start', data: { turn: 1 } }
  assert.equal(activationIntentFromEvents([command('on'), turn, command('off')]), true)
  assert.equal(activationIntentFromEvents([command('off'), turn, command('on')]), true)
  assert.equal(activationIntentFromEvents([command('off'), turn]), false)
})

test('activationIntent folds a session snapshot', () => {
  const session = {
    snapshotEvents: () => [command('status'), command('on')],
  }
  assert.equal(activationIntent(session), true)
})

test('activationIntent is total for missing/foreign sessions', () => {
  assert.equal(activationIntent(undefined), false)
  assert.equal(activationIntent({}), false)
  assert.equal(
    activationIntent({
      snapshotEvents() {
        throw new Error('log unreadable')
      },
    }),
    false,
  )
})

// --- agent/created admission (A1) -----------------------------------------
// DSH has no 'fork' start source: a fork arrives as `startup` + `isSeeded`.
// These cases pin the distinction the listener relies on.
test('only a seeded fork gets a startup edge past the guard', () => {
  assert.equal(shouldRestoreOnCreation('startup', false), false)
  assert.equal(shouldRestoreOnCreation('startup', true), true)
  assert.equal(shouldRestoreOnCreation('resume', false), true)
  assert.equal(shouldRestoreOnCreation('resume', true), true)
  assert.equal(shouldRestoreOnCreation('clear', false), true)
  assert.equal(shouldRestoreOnCreation('compact', false), true)
})

test('a seeded fork inherits the on intent, so it is restorable', () => {
  const fork = {
    header: { isSeeded: true, delegationDepth: 0 },
    snapshotEvents: () => [command('on')],
  }
  assert.equal(activationIntent(fork), true)
  assert.equal(shouldRestoreOnCreation('startup', fork.header.isSeeded), true)
})

test('a brand-new session carries no intent, so the guard never suppresses it', () => {
  const fresh = { header: { isSeeded: false }, snapshotEvents: () => [] }
  assert.equal(activationIntent(fresh), false)
  assert.equal(shouldRestoreOnCreation('startup', false), false)
})
