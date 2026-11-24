import test from 'node:test'
import assert from 'node:assert/strict'

import { createSetupTool, SETUP_TOOL_NAME } from '../dist/lib/setup-tool.js'

function fakeDeps(overrides = {}) {
  const calls = []
  return {
    calls,
    deps: {
      env: () => ({ VIBE_TRADING_HOME: '/tmp/vt-home' }),
      runPreflight: async () => ({
        status: 'needs-install',
        checks: [],
        pythons: [{ via: 'system', exe: '/usr/bin/python3', ok: true, version: '3.12.1' }],
        uv: null,
        dotenv: { keys: [] },
      }),
      runInstall: async (options) => {
        calls.push(['install', options])
        return {
          ok: true,
          status: 'ready',
          config: { package: { installedVersion: '0.1.18' } },
          steps: [{ id: 'verify:system', ok: true, detail: 'ok' }],
          report: { reason: null, failures: [] },
        }
      },
      verifyEnvironment: async () => ({ ok: true, version: '0.1.18' }),
      ...overrides,
    },
  }
}

test('setup tool exposes a strict action schema', () => {
  const tool = createSetupTool(fakeDeps().deps)
  assert.equal(tool.name, SETUP_TOOL_NAME)
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'check',
    'install',
    'create-venv',
    'verify',
    'write-config',
    'repair',
  ])
  assert.deepEqual(tool.parameters.properties.mode.enum, ['pinned', 'latest'])
  assert.equal(tool.parameters.required[0], 'action')
  assert.ok(tool.output?.schema, 'setup tool output.schema missing')
  assert.equal(typeof tool.output.render, 'function')
})

test('check runs preflight and returns a readable summary', async () => {
  const { deps } = fakeDeps()
  const tool = createSetupTool(deps)
  const payload = JSON.parse(await tool.execute({ action: 'check' }))
  assert.equal(payload.action, 'check')
  assert.equal(payload.status, 'needs-install')
  assert.ok(payload.summary.includes('status:'))
})

test('install passes optional arguments through to the installer', async () => {
  const { deps, calls } = fakeDeps()
  const tool = createSetupTool(deps)
  const payload = JSON.parse(
    await tool.execute({ action: 'install', pythonPath: '/opt/py/bin/python3', indexUrl: 'https://mirror/simple' }),
  )
  assert.equal(payload.ok, true)
  assert.equal(payload.installedVersion, '0.1.18')
  assert.equal(payload.pinnedVersion, '0.1.19')
  const options = calls[0][1]
  assert.equal(options.indexUrl, 'https://mirror/simple')
  assert.equal(options.force, false)
  assert.equal(options.mode, undefined, 'no mode means the installer default (pinned)')
  assert.deepEqual(options.extraCandidates, [{ exe: '/opt/py/bin/python3', via: 'explicit' }])
})

test('install accepts an explicit latest policy', async () => {
  const { deps, calls } = fakeDeps()
  const tool = createSetupTool(deps)
  await tool.execute({ action: 'install', mode: 'latest' })
  assert.equal(calls[0][1].mode, 'latest')
})

test('repair forces a rebuild', async () => {
  const { deps, calls } = fakeDeps()
  const tool = createSetupTool(deps)
  await tool.execute({ action: 'repair' })
  assert.equal(calls[0][1].force, true)
})

test('verify reports both environment and config state', async () => {
  const { deps } = fakeDeps()
  const tool = createSetupTool(deps)
  const payload = JSON.parse(await tool.execute({ action: 'verify' }))
  assert.deepEqual(payload.verification, { ok: true, version: '0.1.18' })
  assert.equal(typeof payload.configPath, 'string')
})

test('unknown action and thrown errors return JSON errors instead of throwing', async () => {
  const { deps } = fakeDeps({
    runInstall: async () => {
      throw new Error('boom')
    },
  })
  const tool = createSetupTool(deps)

  const unknown = JSON.parse(await tool.execute({ action: 'nonsense' }))
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /unsupported action/)

  const failed = JSON.parse(await tool.execute({ action: 'install' }))
  assert.equal(failed.ok, false)
  assert.match(failed.error, /boom/)
})
