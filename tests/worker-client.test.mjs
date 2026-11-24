import test from 'node:test'
import assert from 'node:assert/strict'
import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  LONG_RUNNING_TOOLS,
  WorkerClient,
  buildWorkerEnv,
  formatToolResult,
  resolveWorkerPaths,
  timeoutForTool,
} from '../dist/lib/worker.js'

function fakeChild() {
  const writes = []
  return {
    writes,
    child: {
      pid: 4242,
      exitCode: null,
      stdin: {
        write(chunk) {
          writes.push(chunk)
        },
      },
    },
  }
}

function respond(client, payload) {
  client.handleLine(JSON.stringify(payload))
}

test('timeoutForTool separates long-running tools from ordinary ones', () => {
  const cfg = { worker: { defaultTimeoutMs: 120_000, longTimeoutMs: 1_860_000 } }
  assert.equal(timeoutForTool('backtest', cfg), 1_860_000)
  assert.equal(timeoutForTool('get_market_data', cfg), 120_000)
  assert.ok(LONG_RUNNING_TOOLS.has('backtest'))
})

test('resolveWorkerPaths defaults to the packaged worker and work dir', async () => {
  const { python, scriptPath, cwd } = await resolveWorkerPaths(
    { venv: { python: '/vt/venv/bin/python' } },
    { env: { VIBE_TRADING_HOME: path.join(os.tmpdir(), 'vt-home') } },
  )
  assert.equal(python, '/vt/venv/bin/python')
  assert.ok(scriptPath.endsWith(path.join('worker', 'vibe_trading_worker.py')))
  assert.ok(cwd.endsWith(path.join('dsh', 'work')))
})

test('buildWorkerEnv points VT runtime artifacts at the plugin work dir', () => {
  const env = { VIBE_TRADING_HOME: path.join(os.tmpdir(), 'vt-home') }
  const out = buildWorkerEnv({}, env, { TUSHARE_TOKEN: 'from-dotenv' })
  const runtimeHome = path.join(env.VIBE_TRADING_HOME, 'dsh', 'work')

  assert.equal(out.VIBE_TRADING_HOME, runtimeHome)
  assert.equal(out.VIBE_TRADING_ALLOWED_RUN_ROOTS, path.join(runtimeHome, 'runs'))
  assert.equal(out.VIBE_TRADING_ALLOWED_WRITE_ROOTS, path.join(runtimeHome, 'runs'))
  assert.equal(out.VIBE_TRADING_HYPOTHESES_PATH, path.join(runtimeHome, 'research', 'hypotheses.json'))
  assert.equal(out.VIBE_TRADING_GOAL_DB_PATH, path.join(runtimeHome, 'research', 'goals.sqlite3'))
  assert.equal(out.VIBE_TRADING_DATA_CACHE_ROOT, path.join(runtimeHome, 'cache'))
  // `.env` values are still seeded, but `.env` cannot move the runtime root.
  assert.equal(out.TUSHARE_TOKEN, 'from-dotenv')
  assert.equal(buildWorkerEnv({}, env, { VIBE_TRADING_HOME: '/evil' }).VIBE_TRADING_HOME, runtimeHome)
  // A stale `env.VIBE_TRADING_HOME` in config.json must not undo the isolation;
  // the explicit escape hatch is `worker.runtimeHome`.
  assert.equal(
    buildWorkerEnv({ env: { VIBE_TRADING_HOME: '/home/u/.vibe-trading' } }, env, {}).VIBE_TRADING_HOME,
    runtimeHome,
  )
  assert.equal(
    buildWorkerEnv({ worker: { runtimeHome: '/custom/vt' } }, env, {}).VIBE_TRADING_HOME,
    path.resolve('/custom/vt'),
  )
  // init writes `workDir`; the runtime root follows it.
  assert.equal(
    buildWorkerEnv({ workDir: '/home/u/.vibe-trading/dsh/work' }, env, {}).VIBE_TRADING_HOME,
    '/home/u/.vibe-trading/dsh/work',
  )
})

test('buildWorkerEnv forwards the operator monkey-patch path', () => {
  const env = { VIBE_TRADING_HOME: path.join(os.tmpdir(), 'vt-home') }

  // Disabled by default: an empty value must still be present so a stale
  // inherited VIBE_TRADING_DSH_PATCH in the parent process cannot leak in.
  assert.equal(buildWorkerEnv({}, env, {}).VIBE_TRADING_DSH_PATCH, '')
  assert.equal(buildWorkerEnv({}, env, {}, {}).VIBE_TRADING_DSH_PATCH, '')

  const patch = path.join(env.VIBE_TRADING_HOME, 'dsh', 'patches', 'my_patch.py')
  assert.equal(buildWorkerEnv({}, env, {}, { patchFile: patch }).VIBE_TRADING_DSH_PATCH, patch)
})

test('resolveWorkerPaths throws nothing when python is missing (caller decides)', async () => {
  const { python } = await resolveWorkerPaths({}, { env: { VIBE_TRADING_HOME: os.tmpdir() } })
  assert.equal(python, null)
})

test('formatToolResult passes small results through untouched', async () => {
  const env = { VIBE_TRADING_HOME: await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-format-')) }
  const text = '{"ok":true}'
  assert.equal(await formatToolResult(text, { env }), text)
  assert.equal(await formatToolResult(undefined, { env }), '')
})

test('formatToolResult truncates and stores the full payload', async () => {
  const env = { VIBE_TRADING_HOME: await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-format-')) }
  const big = 'x'.repeat(12_345)
  const value = await formatToolResult(big, { env, limitChars: 100 })
  assert.ok(value.startsWith('x'.repeat(100)))
  assert.match(value, /结果已截断/)
  const match = value.match(/完整内容在 (.+?)，/)
  assert.ok(match)
  const stored = await fsp.readFile(match[1], 'utf8')
  assert.equal(stored.length, 12_345)
})

test('formatToolResult leaves a worker-saved full result untouched', async () => {
  const env = { VIBE_TRADING_HOME: await fsp.mkdtemp(path.join(os.tmpdir(), 'vt-full-')) }
  const text = `${'x'.repeat(10_000)}\n\n[FULL RESULT SAVED: C:/tmp/full.json]`
  const value = await formatToolResult(text, { env, limitChars: 100, fullPath: 'C:/tmp/full.json' })
  assert.equal(value, text)
  // No second copy was written for a result the worker already persisted.
  const results = path.join(env.VIBE_TRADING_HOME, 'dsh', 'work', 'results')
  assert.equal(await fsp.readdir(results).then((items) => items.length).catch(() => 0), 0)
})

test('request rejects with a timeout error and clears the pending entry', async () => {
  const client = new WorkerClient({ worker: { defaultTimeoutMs: 20 } }, { env: {} })
  const { child, writes } = fakeChild()
  client.child = child
  await assert.rejects(client.request('ping'), /超时/)
  assert.equal(client.pending.size, 0)
  assert.equal(writes.length, 1)
})

test('request resolves when the matching response line arrives', async () => {
  const client = new WorkerClient({ worker: { defaultTimeoutMs: 1_000 } }, { env: {} })
  const { child, writes } = fakeChild()
  client.child = child
  const promise = client.request('tools/call', { name: 'x' })
  const sent = JSON.parse(writes[0])
  assert.equal(sent.jsonrpc, '2.0')
  assert.equal(sent.method, 'tools/call')
  respond(client, { jsonrpc: '2.0', id: sent.id, result: { text: 'ok' } })
  assert.deepEqual(await promise, { text: 'ok' })
})

test('request rejects with the worker error envelope details', async () => {
  const client = new WorkerClient({ worker: { defaultTimeoutMs: 1_000 } }, { env: {} })
  const { child, writes } = fakeChild()
  client.child = child
  const promise = client.request('tools/call', { name: 'nope' })
  const sent = JSON.parse(writes[0])
  respond(client, {
    jsonrpc: '2.0',
    id: sent.id,
    error: { code: -32602, message: "unknown tool 'nope'", data: { kind: 'unknown_tool' } },
  })
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, -32602)
    assert.deepEqual(error.data, { kind: 'unknown_tool' })
    return true
  })
})

test('request honours an aborted signal', async () => {
  const client = new WorkerClient({ worker: { defaultTimeoutMs: 10_000 } }, { env: {} })
  const { child } = fakeChild()
  client.child = child
  const controller = new AbortController()
  const promise = client.request('slow', {}, { signal: controller.signal })
  controller.abort()
  await assert.rejects(promise, /cancelled/)
  assert.equal(client.pending.size, 0)
})

test('request rejects when the worker is not running', async () => {
  const client = new WorkerClient({}, { env: {} })
  await assert.rejects(client.request('ping'), /未运行/)
})

test('handleLine ignores unknown ids and malformed lines', () => {
  const client = new WorkerClient({}, { env: {} })
  client.handleLine('not json')
  client.handleLine(JSON.stringify({ id: 999, result: { ok: true } }))
  assert.equal(client.pending.size, 0)
})

test('status reports readiness and counters', () => {
  const client = new WorkerClient({}, { env: {} })
  assert.equal(client.status.ready, false)
  const { child } = fakeChild()
  client.child = child
  assert.equal(client.status.ready, true)
  assert.equal(client.status.pid, 4242)
  client.child = null
  assert.equal(client.status.ready, false)
})
