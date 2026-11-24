import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  CONFIG_SCHEMA_VERSION,
  DEFAULT_MINIMUM_VERSION,
  DEFAULT_PACKAGE_MODE,
  DEFAULT_VERIFIED_VERSIONS,
  PINNED_VERSION,
  cmpVersion,
  configPath,
  defaultConfig,
  dshDataDir,
  effectiveConfig,
  installSpec,
  isFloorAbovePin,
  isSameRelease,
  isVerifiedVersion,
  isVersionBelow,
  getConfigValue,
  isSemverLike,
  packageMode,
  parseConfigValue,
  readConfig,
  resolveVibeHome,
  runtimeHomeDir,
  validateConfig,
  venvLayout,
  workDir,
  writeConfig,
} from '../dist/lib/config.js'

async function tempHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-vt-config-'))
  return { dir, env: { ...process.env, VIBE_TRADING_HOME: dir } }
}

test('resolveVibeHome honours VIBE_TRADING_HOME and falls back to home', () => {
  assert.equal(resolveVibeHome({ VIBE_TRADING_HOME: 'C:\\vt' }), path.resolve('C:\\vt'))
  const fallback = resolveVibeHome({ HOME: '/home/u' })
  assert.equal(fallback, path.join('/home/u', '.vibe-trading'))
})

test('derived paths live under the plugin data directory', async () => {
  const { dir, env } = await tempHome()
  assert.equal(dshDataDir(env), path.join(dir, 'dsh'))
  assert.equal(configPath(env), path.join(dir, 'dsh', 'config.json'))
})

test('worker runtime home is the plugin work dir, not the real vibe home', async () => {
  const { dir, env } = await tempHome()
  assert.equal(runtimeHomeDir(env), path.join(dir, 'dsh', 'work'))
  assert.equal(runtimeHomeDir(env), workDir(env))
  // The plugin's own config/logs/venv stay on the real home; only the worker's
  // VT runtime root moves, so `.env` and data-bridge keep resolving from home.
  assert.notEqual(runtimeHomeDir(env), resolveVibeHome(env))
})

test('effectiveConfig fills the install facts and leaves behaviour to the profile', () => {
  const cfg = effectiveConfig({ schemaVersion: CONFIG_SCHEMA_VERSION }, { HOME: '/home/u' })
  assert.equal(cfg.vision === undefined, true)
  // Behavioural settings live in the plugin's profile row config, not here:
  assert.equal(cfg.verification, undefined)
  assert.equal(cfg.skills, undefined)
  assert.equal(cfg.worker, undefined)
  // Dead keys must not come back.
  assert.equal(cfg.toolsets, undefined)
  assert.equal(cfg.mcp, undefined)
  assert.equal(cfg.package.minimumVersion, DEFAULT_MINIMUM_VERSION)
  assert.equal(cfg.package.mode, DEFAULT_PACKAGE_MODE)
  assert.equal(cfg.package.pinnedVersion, PINNED_VERSION)
  assert.deepEqual(cfg.package.verifiedVersions, DEFAULT_VERIFIED_VERSIONS)
  assert.equal(cfg.package.verified, null)
  assert.equal(cfg.package.spec, installSpec())
})

test('defaultConfig recomputes the spec for a package override', () => {
  const cfg = defaultConfig({ package: { mode: 'latest' } }, { HOME: '/home/u' })
  assert.equal(cfg.package.mode, 'latest')
  assert.equal(cfg.package.spec, `vibe-trading-ai>=${PINNED_VERSION}`)

  const pinned = defaultConfig({ package: { minimumVersion: '0.1.20' } }, { HOME: '/home/u' })
  assert.equal(pinned.package.spec, 'vibe-trading-ai==0.1.20')
})

test('the version policy pins the tested release by default', () => {
  assert.equal(PINNED_VERSION, '0.1.19')
  assert.equal(DEFAULT_MINIMUM_VERSION, PINNED_VERSION)
  assert.equal(packageMode(undefined), 'pinned')
  assert.equal(packageMode({ package: { mode: 'latest' } }), 'latest')
  assert.equal(installSpec(), `vibe-trading-ai==${PINNED_VERSION}`)
  assert.equal(installSpec(PINNED_VERSION, 'latest'), `vibe-trading-ai>=${PINNED_VERSION}`)
  // A floor above the pin is refused by runInstall (isFloorAbovePin); the spec
  // helper still reflects the floor so the refusal reason is visible.
  assert.equal(installSpec('0.1.20'), 'vibe-trading-ai==0.1.20')
  assert.equal(installSpec('0.1.20', 'latest'), 'vibe-trading-ai>=0.1.20')
})

test('isVerifiedVersion only accepts tested releases (never prereleases)', () => {
  assert.equal(isVerifiedVersion(PINNED_VERSION), true)
  assert.equal(isVerifiedVersion('0.1.19+build.5'), true, 'build metadata does not change the release')
  assert.equal(isVerifiedVersion('0.1.19-rc1'), false, 'a prerelease is not the tested release')
  assert.equal(isVerifiedVersion('0.1.20'), false)
  assert.equal(isVerifiedVersion(null), false)
  assert.equal(isVerifiedVersion('not-a-version'), false)
  assert.equal(isVersionBelow('0.1.19-rc1', PINNED_VERSION), true, 'prerelease is below the release')
  assert.equal(isVersionBelow(PINNED_VERSION, PINNED_VERSION), false)
  assert.equal(isVersionBelow('0.1.20', PINNED_VERSION), false)
  assert.equal(isSameRelease('0.1.19+build.5', PINNED_VERSION), true)
  assert.equal(isSameRelease('0.1.19-rc1', PINNED_VERSION), false)
})

test('a floor above the tested pin is detectable before installing', () => {
  assert.equal(isFloorAbovePin(PINNED_VERSION), false)
  assert.equal(isFloorAbovePin('0.1.20'), true)
  assert.equal(isFloorAbovePin('0.1.18'), false)
})

test('validateConfig rejects structural problems', () => {
  assert.equal(validateConfig(null).ok, false)
  assert.equal(validateConfig({}).ok, false)
  const bad = validateConfig({ schemaVersion: 99 })
  assert.equal(bad.ok, false)
  assert.ok(bad.problems.some((problem) => problem.includes('schemaVersion')))

  const tooOld = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    vibeHome: path.resolve('/tmp/vt'),
    workDir: path.resolve('/tmp/vt/work'),
    package: { name: 'vibe-trading-ai', minimumVersion: '0.1.18', installedVersion: '0.1.17' },
    venv: { python: '/tmp/vt/venv/bin/python' },
    python: { exe: '/usr/bin/python3' },
  }
  const result = validateConfig(tooOld)
  assert.equal(result.ok, false)
  assert.ok(result.problems.some((problem) => problem.includes('below minimum')))

  const badMode = validateConfig({
    ...tooOld,
    package: { name: 'vibe-trading-ai', minimumVersion: PINNED_VERSION, installedVersion: PINNED_VERSION, mode: 'newest' },
  })
  assert.equal(badMode.ok, false)
  assert.ok(badMode.problems.some((problem) => problem.includes('package.mode')))

  const badVerified = validateConfig({
    ...tooOld,
    package: {
      name: 'vibe-trading-ai',
      minimumVersion: PINNED_VERSION,
      installedVersion: PINNED_VERSION,
      verifiedVersions: ['latest'],
    },
  })
  assert.equal(badVerified.ok, false)
  assert.ok(badVerified.problems.some((problem) => problem.includes('verifiedVersions')))
})

test('writeConfig then readConfig round trips and validates', async () => {
  const { env } = await tempHome()
  const layout = venvLayout('/tmp/vt/venv', 'linux')
  const cfg = effectiveConfig(
    {
      package: {
        name: 'vibe-trading-ai',
        minimumVersion: DEFAULT_MINIMUM_VERSION,
        installedVersion: PINNED_VERSION,
        spec: installSpec(),
      },
      vibeHome: resolveVibeHome(env),
      workDir: path.join(dshDataDir(env), 'work'),
      python: { kind: 'system', exe: '/usr/bin/python3', version: '3.12.0' },
      venv: { dir: layout.dir, python: layout.python },
    },
    env,
  )
  const written = await writeConfig(cfg, env)
  assert.ok(written.updatedAt)
  const read = await readConfig(env)
  assert.equal(read.error, null)
  assert.equal(read.config.package.installedVersion, PINNED_VERSION)
  assert.equal(read.config.package.mode, DEFAULT_PACKAGE_MODE)
  assert.equal(read.config.schemaVersion, CONFIG_SCHEMA_VERSION)
})

test('readConfig reports corrupt JSON and missing files distinctly', async () => {
  const { env } = await tempHome()
  const missing = await readConfig(env)
  assert.equal(missing.config, null)
  assert.equal(missing.exists, false)

  await fsp.mkdir(path.dirname(configPath(env)), { recursive: true })
  await fsp.writeFile(configPath(env), '{not json', 'utf8')
  const corrupt = await readConfig(env)
  assert.equal(corrupt.config, null)
  assert.equal(corrupt.exists, true)
  assert.match(corrupt.error, /invalid JSON/)
})

test('cmpVersion orders semver-ish strings', () => {
  assert.equal(cmpVersion('0.1.18', '0.1.18'), 0)
  assert.equal(cmpVersion('0.1.18', '0.1.17'), 1)
  assert.equal(cmpVersion('0.1.9', '0.1.10'), -1)
  assert.equal(cmpVersion('1.0.0', '0.9.9'), 1)
  assert.equal(cmpVersion('0.2.0-beta.1', '0.2.0'), 0)
  assert.equal(isSemverLike('0.1.18'), true)
  assert.equal(isSemverLike('v0.1'), false)
})

test('venvLayout follows the platform convention', () => {
  const win = venvLayout('C:\\vt\\venv', 'win32')
  assert.ok(win.python.endsWith(path.join('Scripts', 'python.exe')))
  const posix = venvLayout('/vt/venv', 'linux')
  assert.ok(posix.python.endsWith(path.join('bin', 'python')))
})

test('getConfigValue reads dotted paths', () => {
  const cfg = { verification: { enabled: true, ignoreRules: { extra: ['x'] } } }
  assert.equal(getConfigValue(cfg, 'verification.enabled'), true)
  assert.deepEqual(getConfigValue(cfg, 'verification.ignoreRules.extra'), ['x'])
  assert.equal(getConfigValue(cfg, 'verification.missing'), undefined)
  assert.equal(getConfigValue(cfg, ''), cfg)
})

test('parseConfigValue coerces JSON scalars', () => {
  assert.equal(parseConfigValue('true'), true)
  assert.equal(parseConfigValue('false'), false)
  assert.equal(parseConfigValue('2'), 2)
  assert.equal(parseConfigValue('disclose'), 'disclose')
})

test('setConfigValue was removed with the behaviour sections; parseConfigValue stays', () => {
  // config.json is install facts only now, so there is nothing to mutate there.
  assert.equal(parseConfigValue('true'), true)
  assert.equal(parseConfigValue('2'), 2)
  assert.equal(parseConfigValue('disclose'), 'disclose')
})
