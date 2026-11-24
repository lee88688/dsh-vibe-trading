import test from 'node:test'
import assert from 'node:assert/strict'

import { buildConfigFromInstall, resolveInstallPlan } from '../dist/lib/install.js'
import { DEFAULT_PACKAGE_MODE, PINNED_VERSION, installSpec } from '../dist/lib/config.js'

test('install spec pins the tested release by default', () => {
  assert.equal(installSpec(), `vibe-trading-ai==${PINNED_VERSION}`)
  assert.equal(installSpec(PINNED_VERSION), `vibe-trading-ai==${PINNED_VERSION}`)
  assert.equal(installSpec(PINNED_VERSION, 'latest'), `vibe-trading-ai>=${PINNED_VERSION}`)
  assert.equal(installSpec('0.1.20'), 'vibe-trading-ai==0.1.20')
})

test('resolveInstallPlan keeps only usable candidates in priority order', () => {
  const plan = resolveInstallPlan([
    { via: 'dsh-bundled', exe: 'dsh-python', ok: true, version: '3.12.14' },
    { via: 'uv', exe: 'uv-python', ok: true, version: '3.12.0' },
    { via: 'system', exe: 'sys-python', ok: true, version: '3.11.9' },
    { via: 'conda', exe: 'bad', ok: false, version: null },
  ])
  assert.deepEqual(
    plan.map((entry) => entry.kind),
    ['system', 'uv', 'dsh-bundled'],
  )
  assert.equal(plan[0].exe, 'sys-python')
})

test('resolveInstallPlan returns an empty plan when nothing is usable', () => {
  assert.deepEqual(resolveInstallPlan([{ via: 'system', exe: 'x', ok: false }]), [])
  assert.deepEqual(resolveInstallPlan(), [])
})

test('buildConfigFromInstall produces a validated shape', () => {
  const config = buildConfigFromInstall({
    vibeHome: '/home/u/.vibe-trading',
    workDir: '/home/u/.vibe-trading/dsh/work',
    venv: { dir: '/home/u/.vibe-trading/dsh/venv', python: '/home/u/.vibe-trading/dsh/venv/bin/python' },
    python: { kind: 'system', exe: '/usr/bin/python3', version: '3.12.1' },
    uv: { exe: 'uv', version: '0.12.20' },
    installedVersion: PINNED_VERSION,
    detectedKeys: ['DEEPSEEK_API_KEY'],
    minimumVersion: PINNED_VERSION,
    verified: true,
  })
  assert.equal(config.package.installedVersion, PINNED_VERSION)
  assert.equal(config.package.spec, `vibe-trading-ai==${PINNED_VERSION}`)
  assert.equal(config.package.mode, DEFAULT_PACKAGE_MODE)
  assert.equal(config.package.pinnedVersion, PINNED_VERSION)
  assert.equal(config.package.verified, true)
  assert.equal(config.python.kind, 'system')
  assert.equal(config.venv.python, '/home/u/.vibe-trading/dsh/venv/bin/python')
  // The worker's VT runtime root is derived at spawn time, never stored here:
  // a stale value would point VT back at the real home.
  assert.equal(config.env.VIBE_TRADING_HOME, undefined)
  assert.deepEqual(config.detectedKeys, ['DEEPSEEK_API_KEY'])
  assert.equal(config.checks.packageImportOk, true)
  // Behavioural settings belong to the profile row config, not to config.json.
  assert.equal(config.worker, undefined)
  assert.equal(config.skills, undefined)
  assert.equal(config.verification, undefined)
})

test('buildConfigFromInstall records a latest-policy install as unverified', () => {
  const config = buildConfigFromInstall({
    vibeHome: '/home/u/.vibe-trading',
    workDir: '/home/u/.vibe-trading/dsh/work',
    venv: { dir: '/home/u/.vibe-trading/dsh/venv', python: '/home/u/.vibe-trading/dsh/venv/bin/python' },
    python: { kind: 'uv', exe: 'python3', version: '3.12.1' },
    uv: null,
    installedVersion: '0.1.20',
    detectedKeys: [],
    minimumVersion: PINNED_VERSION,
    mode: 'latest',
    verified: false,
  })
  assert.equal(config.package.mode, 'latest')
  assert.equal(config.package.spec, `vibe-trading-ai>=${PINNED_VERSION}`)
  assert.equal(config.package.verified, false)
})
