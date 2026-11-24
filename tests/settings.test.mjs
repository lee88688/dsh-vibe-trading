import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CONFIG_ENTRY_ID,
  SETTING_DEFAULTS,
  SETTING_KEYS,
  createSettings,
  failureMode,
  isVolatileRef,
  liveConfig,
  settingPatch,
} from '../dist/lib/settings.js'

/** Minimal stand-in for a Loader volatile reference. */
function ref(holder, key) {
  return Object.freeze({
    get: () => holder[key],
    [Symbol.for('cosmokit.volatile.write')]: () => {},
  })
}

test('profile settings fall back to the compiled defaults', () => {
  const settings = createSettings({})
  const snapshot = settings.snapshot()
  assert.equal(snapshot.verification.enabled, true)
  assert.equal(snapshot.verification.identityGate, true)
  assert.equal(snapshot.verification.figuresGate, true)
  assert.equal(snapshot.verification.maxRevisions, 2)
  assert.equal(snapshot.verification.onFailure, 'panel')
  assert.deepEqual(snapshot.verification.ignoreRules, SETTING_DEFAULTS.verification.ignoreRules)
  assert.equal(snapshot.worker.idleMinutes, 30)
  assert.equal(snapshot.worker.defaultTimeoutMs, 120_000)
  // No monkey patch until the operator names one.
  assert.equal(snapshot.worker.patchFile, '')
  assert.equal(snapshot.skills.mode, 'short')
  assert.equal(snapshot.minimumVersion, SETTING_DEFAULTS.minimumVersion)
  assert.equal(snapshot.packageMode, 'pinned')
  assert.equal(CONFIG_ENTRY_ID, 'dsh-vibe-trading')
})

test('volatile references are detected across module copies', () => {
  const holder = { enabled: false }
  assert.equal(isVolatileRef(ref(holder, 'enabled')), true)
  assert.equal(isVolatileRef({ get: () => false }), false, 'a plain getter is not a config reference')
  assert.equal(isVolatileRef(undefined), false)
})

test('settings are read through the references on every access', () => {
  const box = { enabled: true, revisions: 2, mode: 'short' }
  const settings = createSettings({
    verification: { enabled: ref(box, 'enabled'), maxRevisions: ref(box, 'revisions') },
    skills: { mode: ref(box, 'mode') },
  })
  assert.equal(settings.verification().enabled, true)
  assert.equal(settings.verification().maxRevisions, 2)

  // The Loader commits a volatile update into the same reference object.
  box.enabled = false
  box.revisions = 0
  box.mode = 'none'
  assert.equal(settings.verification().enabled, false)
  assert.equal(settings.verification().maxRevisions, 0)
  assert.equal(settings.skills().mode, 'none')
  assert.equal(settings.snapshot().verification.onFailure, 'panel', 'unset fields keep their default')
})

test('liveConfig merges install facts with the live settings', () => {
  const box = { idle: 30 }
  const settings = createSettings({ worker: { idleMinutes: ref(box, 'idle') } })
  const cfg = liveConfig(
    { venv: { python: '/py' }, worker: { allowedRunRoots: '/custom/runs', idleMinutes: 99 } },
    settings,
  )
  assert.equal(cfg.venv.python, '/py')
  assert.equal(cfg.worker.idleMinutes, 30, 'profile setting wins over the legacy file value')
  assert.equal(cfg.worker.allowedRunRoots, '/custom/runs', 'hand-set advanced worker keys survive')

  box.idle = 5
  assert.equal(cfg.worker.idleMinutes, 5, 'the view follows the reference')
  assert.equal(cfg.verification.enabled, true)
  assert.equal(cfg.skills.mode, 'short')
})

test('the failure mode normalizes to panel / disclose / silent', () => {
  assert.equal(failureMode('panel'), 'panel')
  assert.equal(failureMode('disclose'), 'disclose')
  assert.equal(failureMode('silent'), 'silent')
  // Unknown or missing values mean the panel-only default, never a silent turn.
  assert.equal(failureMode(undefined), 'panel')
  assert.equal(failureMode('whatever'), 'panel')
  assert.equal(failureMode('SILENT'), 'panel')
})

test('settingPatch turns one dotted key into a nested profile patch', () => {
  const patch = settingPatch('verification.enabled', 'false')
  assert.equal(patch.ok, true)
  assert.deepEqual(patch.patch, { verification: { enabled: false } })
  assert.equal(patch.value, false)

  const revision = settingPatch('verification.maxRevisions', '0')
  assert.deepEqual(revision.patch, { verification: { maxRevisions: 0 } })
  assert.equal(revision.value, 0)

  const rule = settingPatch('verification.ignoreRules.dates', 'false')
  assert.equal(rule.ok, true)
  assert.deepEqual(rule.patch, { verification: { ignoreRules: { dates: false } } })

  assert.equal(settingPatch('verification', 'x').ok, false)
  assert.equal(settingPatch('package.mode', 'latest').ok, false, 'install facts are not profile settings')
  assert.ok(SETTING_KEYS.includes('verification.onFailure'))
})
