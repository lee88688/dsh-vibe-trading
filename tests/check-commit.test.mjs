import test from 'node:test'
import assert from 'node:assert/strict'

import { validateMessage } from '../scripts/dev/check-commit.mjs'

const check = (message, options = {}) => validateMessage(message, { version: '0.4.1', ...options })

test('accepts conventional messages', () => {
  for (const message of ['feat: add auto release', 'fix(gate): keep evidence', 'chore(deps): bump typescript']) {
    const result = check(message)
    assert.equal(result.ok, true, `${message}: ${result.errors.join('; ')}`)
  }
})

test('rejects messages without a conventional subject', () => {
  const result = check('update the readme')
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /not conventional/)
})

test('rejects unknown commit types', () => {
  const result = check('wip: try something')
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /unknown commit type "wip"/)
})

test('rejects descriptions that are too short or subjects that are too long', () => {
  assert.match(check('fix: ab').errors.join('\n'), /too short/)
  const long = check(`fix: ${'x'.repeat(120)}`)
  assert.match(long.errors.join('\n'), /keep it under 100/)
})

test('ignores machine-generated commits', () => {
  for (const message of ['Merge branch main into feature', 'fixup! fix: keep me', 'chore(release): v0.5.0']) {
    assert.equal(check(message).ok, true, message)
  }
})

test('accepts git revert commits', () => {
  assert.equal(check('Revert "feat: drop tool"').ok, true)
})

test('does not let the skip marker bypass the format check', () => {
  const result = check('update stuff [skip release]')
  assert.equal(result.ok, false)
  assert.match(result.errors.join('\n'), /not conventional/)
})

test('validates Release-As footers', () => {
  assert.equal(check('fix: keep evidence\n\nRelease-As: 0.5.0').ok, true)
  assert.match(check('fix: keep evidence\n\nRelease-As: next').errors.join('\n'), /x\.y\.z/)
  assert.match(check('fix: keep evidence\n\nRelease-As: 0.4.1').errors.join('\n'), /greater than the current version/)
})

test('requires the release gate for risky staged files', () => {
  const blocked = check('feat(worker): add tool', { riskyFiles: ['worker/vibe_trading_worker.py'] })
  assert.equal(blocked.ok, false)
  assert.match(blocked.errors.join('\n'), /Release-Gate: verified/)
  assert.match(blocked.errors.join('\n'), /skill `release-gate`/)

  const allowed = check('feat(worker): add tool\n\nRelease-Gate: verified (verify:all; smoke: activation)', {
    riskyFiles: ['worker/vibe_trading_worker.py'],
  })
  assert.equal(allowed.ok, true, allowed.errors.join('; '))
})

test('requires the release gate when engines.dsh changes', () => {
  const blocked = check('chore: raise the host floor', { enginesChanged: true })
  assert.equal(blocked.ok, false)
  assert.match(blocked.errors.join('\n'), /engines\.dsh/)
})

test('does not require the gate for ordinary source changes', () => {
  assert.equal(check('feat: add a command', { riskyFiles: ['src/index.ts', 'docs/development.md'] }).ok, true)
})
