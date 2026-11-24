import test from 'node:test'
import assert from 'node:assert/strict'

import { parseInitFlags } from '../dist/lib/init-flags.js'

test('no flags keeps the profile default policy', () => {
  assert.deepEqual(parseInitFlags([]), { mode: undefined, force: false, error: null })
})

test('policy flags select the mode, case-insensitively', () => {
  assert.equal(parseInitFlags(['--latest']).mode, 'latest')
  assert.equal(parseInitFlags(['--pinned']).mode, 'pinned')
  assert.equal(parseInitFlags(['--LATEST']).mode, 'latest')
  assert.equal(parseInitFlags(['--Pinned']).mode, 'pinned')
})

test('--force requests a reinstall (so init cannot take the fast path)', () => {
  const parsed = parseInitFlags(['--force'])
  assert.deepEqual(parsed, { mode: undefined, force: true, error: null })
  assert.deepEqual(parseInitFlags(['--force', '--latest']), { mode: 'latest', force: true, error: null })
})

test('unknown or contradictory flags return an error instead of guessing', () => {
  assert.match(parseInitFlags(['--bogus']).error, /未知参数/)
  assert.match(parseInitFlags(['--latest', '--pinned']).error, /不能同时使用/)
  assert.equal(parseInitFlags(['--bogus']).mode, undefined)
})
