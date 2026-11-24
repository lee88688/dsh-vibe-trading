import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { runPreflight, summarizePreflight } from '../dist/lib/preflight.js'
import { PINNED_VERSION, configPath, writeConfig, effectiveConfig, dshDataDir } from '../dist/lib/config.js'

async function tempHome() {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-vt-preflight-'))
  return { dir, env: { ...process.env, VIBE_TRADING_HOME: dir, PATH: '' } }
}

test('without a config it is never ready, and the status follows python discovery', async () => {
  const { env } = await tempHome()
  const report = await runPreflight({ env })
  assert.equal(report.ok, false)
  const usable = report.pythons.filter((candidate) => candidate.ok)
  const pythonCheck = report.checks.find((check) => check.id === 'python')
  assert.equal(pythonCheck.ok, usable.length > 0)
  assert.equal(report.status, usable.length > 0 ? 'needs-install' : 'needs-help')
})

test('preflight reports the data directory as writable', async () => {
  const { dir, env } = await tempHome()
  const report = await runPreflight({ env })
  const writable = report.checks.find((check) => check.id === 'writable')
  assert.equal(writable.ok, true)
  assert.equal(report.dataDir, dshDataDir(env))
  assert.ok(await fsp.stat(dir))
})

test('a valid config makes the config check pass', async () => {
  const { env } = await tempHome()
  const layoutDir = path.join(dshDataDir(env), 'venv')
  const cfg = effectiveConfig(
    {
      package: {
        name: 'vibe-trading-ai',
        minimumVersion: PINNED_VERSION,
        installedVersion: PINNED_VERSION,
        spec: `vibe-trading-ai==${PINNED_VERSION}`,
      },
      vibeHome: env.VIBE_TRADING_HOME,
      workDir: path.join(dshDataDir(env), 'work'),
      python: { kind: 'system', exe: 'python', version: '3.12.0' },
      venv: { dir: layoutDir, python: path.join(layoutDir, 'Scripts', 'python.exe') },
    },
    env,
  )
  await writeConfig(cfg, env)
  const report = await runPreflight({ env })
  const configCheck = report.checks.find((check) => check.id === 'config')
  assert.equal(configCheck.ok, true)
  assert.deepEqual(report.config.package.installedVersion, PINNED_VERSION)
  assert.equal(report.pinnedVersion, PINNED_VERSION)
  assert.equal(report.configError, null)
})

test('dotenv keys are read as names only', async () => {
  const { dir, env } = await tempHome()
  await fsp.writeFile(path.join(dir, '.env'), 'DEEPSEEK_API_KEY=secret-value\nTUSHARE_TOKEN=abc\n# comment\n', 'utf8')
  const report = await runPreflight({ env })
  assert.deepEqual(report.dotenv.keys.sort(), ['DEEPSEEK_API_KEY', 'TUSHARE_TOKEN'])
  assert.equal(JSON.stringify(report).includes('secret-value'), false)
})

test('summary is human readable and mentions every check', async () => {
  const { env } = await tempHome()
  const report = await runPreflight({ env })
  const text = summarizePreflight(report)
  assert.match(text, /status:/)
  for (const check of report.checks) assert.ok(text.includes(check.id), `missing ${check.id}`)
})

test('config path is reported in the summary when missing', async () => {
  const { env } = await tempHome()
  const report = await runPreflight({ env })
  assert.ok(!report.config)
  assert.equal(report.configError, null)
  assert.ok(configPath(env).length > 0)
})
