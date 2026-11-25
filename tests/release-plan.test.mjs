import test from 'node:test'
import assert from 'node:assert/strict'

import {
  analyze,
  buildNotes,
  bumpVersion,
  compareVersions,
  detectPackageFieldChanges,
  matchRiskyPaths,
  parseCommit,
} from '../scripts/dev/release-plan.mjs'

const commit = (message, sha = 'abcdef1234567890') => ({ sha, message })

function plan(commits, options = {}) {
  return analyze({
    commits,
    fromVersion: '0.4.1',
    packageVersion: '0.4.1',
    ...options,
  })
}

test('parseCommit reads conventional subjects, breaking markers, and footers', () => {
  const parsed = parseCommit({
    sha: 'a'.repeat(40),
    message: 'feat(worker)!: drop legacy bridge\n\nBREAKING CHANGE: the bridge is gone\nRelease-Gate: verified (smoke: activation)\nRelease-As: 0.9.0',
  })
  assert.equal(parsed.type, 'feat')
  assert.equal(parsed.scope, 'worker')
  assert.equal(parsed.breaking, true)
  assert.equal(parsed.gate, true)
  assert.equal(parsed.releaseAs, '0.9.0')
  assert.equal(parsed.skip, false)
})

test('parseCommit strips git comment lines and flags merge/release commits', () => {
  assert.equal(parseCommit({ message: 'Merge branch main into feature' }).skip, true)
  assert.equal(parseCommit({ message: 'chore(release): v0.5.0' }).skip, true)
  assert.equal(parseCommit({ message: 'fix: keep me\n\n# Please enter the commit message' }).description, 'keep me')
})

test('feat bumps minor and fix bumps patch', () => {
  const feature = plan([commit('feat(worker): expose tool group')])
  assert.equal(feature.releasable, true)
  assert.equal(feature.version, '0.5.0')
  assert.equal(feature.bump, 'minor')

  const fix = plan([commit('fix(gate): keep declared values')])
  assert.equal(fix.version, '0.4.2')
  assert.equal(fix.bump, 'patch')
})

test('breaking changes bump minor before 1.0 and major after 1.0', () => {
  assert.equal(plan([commit('feat!: rewrite activation')]).version, '0.5.0')
  assert.equal(
    plan([commit('feat!: rewrite activation')], { fromVersion: '1.2.3', packageVersion: '1.2.3' }).version,
    '2.0.0',
  )
  assert.equal(
    plan([commit('fix!: stop accepting the old shape')], { fromVersion: '0.4.1' }).version,
    '0.5.0',
  )
})

test('docs/chore/ci/test/style/build/refactor do not release', () => {
  const result = plan([
    commit('docs: explain the release flow'),
    commit('chore: bump dev deps'),
    commit('ci: cache pnpm'),
    commit('test: cover release plan'),
    commit('style: format'),
    commit('build: emit dist'),
    commit('refactor: split analyze'),
  ])
  assert.equal(result.releasable, false)
  assert.equal(result.version, null)
})

test('mixed commits take the highest bump', () => {
  const result = plan([commit('fix: small bug'), commit('feat: new flag'), commit('docs: notes')])
  assert.equal(result.version, '0.5.0')
  assert.equal(result.bump, 'minor')
})

test('non-conventional commits fall back to patch and warn', () => {
  const result = plan([commit('update the readme')])
  assert.equal(result.releasable, true)
  assert.equal(result.version, '0.4.2')
  assert.equal(result.warnings.length, 1)
  assert.match(result.warnings[0], /non-conventional commit/)
})

test('[skip release] excludes a commit, and an all-skipped range releases nothing', () => {
  assert.equal(plan([commit('feat: thing [skip release]')]).releasable, false)
  assert.equal(plan([commit('feat: thing'), commit('fix: other [skip release]')]).version, '0.5.0')
})

test('Release-As overrides the computed bump', () => {
  const result = plan([commit('fix: small bug\n\nRelease-As: 0.6.0')])
  assert.equal(result.version, '0.6.0')
  assert.equal(result.bump, 'release-as')
})

test('Release-As must be a forward x.y.z version', () => {
  assert.throws(() => plan([commit('fix: bug\n\nRelease-As: 0.4.1')]), /greater than the last tag/)
  assert.throws(() => plan([commit('fix: bug\n\nRelease-As: next')]), /x\.y\.z/)
  assert.throws(
    () =>
      plan([
        commit('fix: one\n\nRelease-As: 0.5.0'),
        commit('fix: two\n\nRelease-As: 0.6.0'),
      ]),
    /conflicting Release-As/,
  )
})

test('a package.json version ahead of the last tag wins (failed release self-heal)', () => {
  const result = plan([commit('fix: retry the publish')], { packageVersion: '0.5.0' })
  assert.equal(result.version, '0.5.0')
  assert.equal(result.bump, 'manual')
})

test('a forced version must move forward', () => {
  assert.equal(plan([], { forcedVersion: '0.7.0' }).version, '0.7.0')
  assert.throws(() => plan([], { forcedVersion: '0.4.1' }), /greater than the last tag/)
})

test('risky paths require a Release-Gate footer', () => {
  const missing = plan([commit('feat(worker): new tool')], { changedFiles: ['worker/vibe_trading_worker.py'] })
  assert.equal(missing.gate.required, true)
  assert.equal(missing.gate.satisfied, false)

  const satisfied = plan([
    commit('feat(worker): new tool\n\nRelease-Gate: verified (verify:all; smoke: options_pricing)'),
  ], { changedFiles: ['worker/vibe_trading_worker.py'] })
  assert.equal(satisfied.gate.required, true)
  assert.equal(satisfied.gate.satisfied, true)
})

test('engines.dsh changes require the gate; unrelated package.json edits do not', () => {
  assert.equal(plan([commit('chore: bump node engine')], { enginesChanged: true }).gate.required, true)
  assert.equal(plan([commit('chore: add a script')], { changedFiles: ['package.json'] }).gate.required, false)
})

test('notes group commits and link the compare range', () => {
  const parsed = [
    parseCommit({ sha: 'a'.repeat(40), message: 'feat(worker): add tool' }),
    parseCommit({ sha: 'b'.repeat(40), message: 'fix(gate): keep evidence' }),
    parseCommit({ sha: 'c'.repeat(40), message: 'docs: readme' }),
  ]
  const notes = buildNotes({
    parsed,
    fromRef: 'v0.4.1',
    toRef: 'v0.5.0',
    repository: 'https://github.com/lee88688/dsh-vibe-trading',
  })
  assert.match(notes, /## Features/)
  assert.match(notes, /## Fixes/)
  assert.match(notes, /compare\/v0\.4\.1\.\.\.v0\.5\.0/)
  assert.doesNotMatch(notes, /readme/)
})

test('matchRiskyPaths understands ** globs and exact files', () => {
  assert.deepEqual(
    matchRiskyPaths(['prompt/vibe-trading.md', 'src/index.ts', 'toolsets.json', 'client.js']),
    ['prompt/vibe-trading.md', 'toolsets.json', 'client.js'],
  )
  assert.deepEqual(matchRiskyPaths(['src/index.ts']), [])
})

test('detectPackageFieldChanges only matches engines.dsh edits', () => {
  const diff = ['-    "dsh": ">=0.2.2-rc.5",', '+    "dsh": ">=0.2.2-rc.6",', '   "node": ">=24.9.0"'].join('\n')
  assert.deepEqual(detectPackageFieldChanges(diff), ['engines.dsh'])
  assert.deepEqual(detectPackageFieldChanges('+    "node": ">=24.9.0",'), [])
})

test('bumpVersion and compareVersions are semver-correct', () => {
  assert.equal(bumpVersion('0.4.1', 'patch'), '0.4.2')
  assert.equal(bumpVersion('0.4.9', 'minor'), '0.5.0')
  assert.equal(bumpVersion('1.9.9', 'major'), '2.0.0')
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0)
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
})
