/**
 * Worker process manager and JSON-RPC client.
 *
 * One long-lived Python worker per DSH process serves every session. The
 * protocol is newline-delimited JSON-RPC 2.0 over stdio; stdout carries only
 * JSON lines and stderr is appended to `<vibeHome>/dsh/logs/worker.log`.
 */

import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  dshDataDir,
  logsDir,
  readDotEnvValues,
  runtimeHomeDir,
  workerLogPath,
  workDir,
} from './config.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// dist/lib/worker.js -> repo root/worker/vibe_trading_worker.py
const DEFAULT_WORKER_SCRIPT = path.join(HERE, '..', '..', 'worker', 'vibe_trading_worker.py')

/** Tools allowed to run for minutes rather than seconds. */
export const LONG_RUNNING_TOOLS = new Set([
  'backtest',
  'factor_analysis',
  'alpha_bench',
  'alpha_compare',
  'analyze_trade_journal',
  'extract_shadow_strategy',
  'run_shadow_backtest',
  'render_shadow_report',
  'scan_shadow_signals',
  'start_research_goal',
  'update_research_goal',
  'run_research_autopilot',
  'sdm_decay_scan',
  'screen_market',
  'research_papers',
  'etf_holdings',
  'get_institutional_holdings',
  'prediction_market',
  'generate_backtest_config',
  'read_document',
])

export function timeoutForTool(name: string, cfg: any) {
  return LONG_RUNNING_TOOLS.has(name)
    ? (cfg?.worker?.longTimeoutMs ?? 1_860_000)
    : (cfg?.worker?.defaultTimeoutMs ?? 120_000)
}

/** DSH data root (`~/.dsh`); chat attachments live under `<dshHome>/attachments/v1`. */
export function dshHomeDir(env: any = process.env) {
  const explicit = env?.DSH_HOME
  if (explicit) return String(explicit)
  return path.join(homedir(), '.dsh')
}

export async function resolveWorkerPaths(cfg: any, options: any = {}) {
  const env = options.env ?? process.env
  const scriptPath = options.scriptPath ?? DEFAULT_WORKER_SCRIPT
  const python = options.python ?? cfg?.venv?.python ?? null
  return { scriptPath, python, cwd: options.cwd ?? workDir(env) }
}

/**
 * Build the environment for the Python worker.
 *
 * `VIBE_TRADING_HOME` points at the plugin's own data root (`<vibeHome>/dsh/work`),
 * never at the real `<vibeHome>`: every runtime artifact VT computes from
 * `get_runtime_root()` (runs, sessions.db, shadow_*, strategies, reports,
 * paper-trading, …) then lands inside the plugin's directory instead of mixing
 * with a separately installed original VT. VT's `.env` and `data-bridge` are
 * resolved from `Path.home()`, so those stay shared on purpose.
 *
 * Exported so tests can assert the path contract without spawning Python.
 */
/**
 * Resolve the worker's VT runtime root.
 *
 * Priority: explicit `worker.runtimeHome` → the install fact `workDir` written
 * by init → the derived default (`<vibeHome>/dsh/work`).
 */
export function resolveRuntimeHome(cfg: any, env: any = process.env) {
  const explicit = String(cfg?.worker?.runtimeHome ?? '').trim()
  if (explicit) return path.resolve(explicit)
  const fromWorkDir = String(cfg?.workDir ?? '').trim()
  return fromWorkDir || runtimeHomeDir(env)
}

export function buildWorkerEnv(
  cfg: any,
  env: any = process.env,
  dotenv: Record<string, string> = {},
  extra: { patchFile?: string } = {},
) {
  // `worker.runtimeHome` is the explicit escape hatch; otherwise follow the
  // install fact `workDir` (written by init) and finally the derived default.
  const runtimeHome = resolveRuntimeHome(cfg, env)
  return {
    ...dotenv,
    ...env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    VIBE_TRADING_ALLOWED_RUN_ROOTS: cfg?.worker?.allowedRunRoots ?? path.join(runtimeHome, 'runs'),
    VIBE_TRADING_ALLOWED_WRITE_ROOTS: cfg?.worker?.allowedWriteRoots ?? path.join(runtimeHome, 'runs'),
    VIBE_TRADING_ALLOWED_FILE_ROOTS:
      cfg?.worker?.allowedFileRoots ??
      [
        path.join(runtimeHome, 'runs'),
        path.join(runtimeHome, 'results'),
        // Chat attachments arrive outside the session workspace; read_document
        // enforces VT's own allowed-root list, so the attachment root must be
        // named explicitly. The session workspace is deliberately not global:
        // one shared worker would expose every session's workspace.
        path.join(dshHomeDir(env), 'attachments', 'v1'),
      ].join(','),
    // VT reads these from env when set; pinning them keeps the research stores
    // beside the runs instead of falling back to `<vibeHome>/*.json`.
    VIBE_TRADING_HYPOTHESES_PATH:
      cfg?.worker?.hypothesesPath ?? path.join(runtimeHome, 'research', 'hypotheses.json'),
    VIBE_TRADING_GOAL_DB_PATH:
      cfg?.worker?.goalDbPath ?? path.join(runtimeHome, 'research', 'goals.sqlite3'),
    VIBE_TRADING_RESEARCH_ARTIFACT_DB_PATH:
      cfg?.worker?.researchArtifactDbPath ??
      path.join(runtimeHome, 'research', 'research_artifacts.sqlite3'),
    VIBE_TRADING_STRATEGY_STORE_DB_PATH:
      cfg?.worker?.strategyStoreDbPath ??
      path.join(runtimeHome, 'research', 'strategy_store.sqlite3'),
    VIBE_TRADING_STRATEGY_DISCOVERY_DB_PATH:
      cfg?.worker?.strategyDiscoveryDbPath ??
      path.join(runtimeHome, 'research', 'strategy_discovery.sqlite3'),
    VIBE_TRADING_PLAYBOOK_DIR:
      cfg?.worker?.playbookDir ?? path.join(runtimeHome, 'research', 'playbooks'),
    VIBE_TRADING_DATA_CACHE_ROOT: cfg?.worker?.dataCacheRoot ?? path.join(runtimeHome, 'cache'),
    // Operator-supplied monkey patch, imported by the worker at startup. An
    // empty value disables the hook; the worker reports the outcome through
    // `ping` -> `startup.user_patch`.
    VIBE_TRADING_DSH_PATCH: extra.patchFile ?? '',
    ...(cfg?.env ?? {}),
    // Last, so a stale `env.VIBE_TRADING_HOME` left in an older config.json can
    // never point VT back at the real home and silently undo the isolation.
    VIBE_TRADING_HOME: runtimeHome,
  }
}

/**
 * Truncate a tool result and persist the full text so the model can `read` it.
 * @returns {Promise<string>}
 */
export async function formatToolResult(text: any, options: any = {}) {
  const value = typeof text === 'string' ? text : JSON.stringify(text)
  const limit = options.limitChars ?? 10_000
  // The worker caps its own text and stores the full payload when truncated; in
  // that case the text already carries the "[FULL RESULT SAVED: ...]" notice and
  // must not be truncated a second time.
  if (options.fullPath) return value ?? ''
  if (!value || value.length <= limit) return value ?? ''
  const env = options.env ?? process.env
  const dir = options.resultsDir ?? path.join(workDir(env), 'results')
  await fsp.mkdir(dir, { recursive: true })
  const file = path.join(dir, `${randomUUID()}.json`)
  await fsp.writeFile(file, value, 'utf8')
  return `${value.slice(0, limit)}\n\n[结果已截断：完整内容在 ${file}，可用 read 读取]`
}

export class WorkerClient {
  cfg: any
  options: any
  env: any
  child: any = null
  pending: Map<number, any> = new Map()
  seq = 0
  buffer = ''
  starting: any = null
  stopping = false
  restarts = 0
  maxRestarts: number
  startedAt: string | null = null
  lastError: string | null = null
  idleTimer: any = null
  logStream: any = null
  logFileHandle: any = null
  log: (line: string) => void
  /** Operator monkey-patch path passed to the worker; '' disables the hook. */
  patchFile: string
  /**
   * @param {object} cfg parsed config.json
   * @param {{scriptPath?: string, python?: string, env?: NodeJS.ProcessEnv, log?: (line: string) => void, patchFile?: string}} [options]
   */
  constructor(cfg: any, options: any = {}) {
    this.cfg = cfg ?? {}
    this.options = options
    this.env = options.env ?? process.env
    this.child = null
    this.pending = new Map()
    this.seq = 0
    this.buffer = ''
    this.starting = null
    this.stopping = false
    this.restarts = 0
    this.maxRestarts = options.maxRestarts ?? 1
    this.startedAt = null
    this.lastError = null
    this.idleTimer = null
    this.logStream = null
    this.log = options.log ?? (() => {})
    /** @type {string} operator monkey-patch path; '' disables the hook. */
    this.patchFile = String(options.patchFile ?? '')
  }

  get ready() {
    return Boolean(this.child && this.child.exitCode === null)
  }

  get status() {
    return {
      ready: this.ready,
      pid: this.child?.pid ?? null,
      startedAt: this.startedAt,
      restarts: this.restarts,
      lastError: this.lastError,
      pending: this.pending.size,
    }
  }

  async start() {
    if (this.ready) return
    if (this.starting) return this.starting
    this.starting = this.#spawn()
    try {
      await this.starting
    } finally {
      this.starting = null
    }
  }

  /**
   * Guard the path contract: the worker's `<runtimeHome>/runs` must be one of the
   * allowed run roots, otherwise `read_file` / `write_file` reject the very run
   * directories the worker just created.
   */
  #checkRuntimeRoots(env: any) {
    const expected = path.resolve(path.join(resolveRuntimeHome(this.cfg, this.env), 'runs'))
    const roots = String(env?.VIBE_TRADING_ALLOWED_RUN_ROOTS ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
    if (roots.length && !roots.some((root) => path.resolve(root) === expected)) {
      this.log(
        `warn: runtime home runs dir ${expected} is not in VIBE_TRADING_ALLOWED_RUN_ROOTS (${roots.join(', ')})`,
      )
    }
  }

  async #spawn(): Promise<any> {
    const { scriptPath, python, cwd } = await resolveWorkerPaths(this.cfg, {
      env: this.env,
      scriptPath: this.options.scriptPath,
      python: this.options.python,
      cwd: this.options.cwd,
    })
    if (!python) throw new Error('config.json 缺少 venv.python，请先运行 /vibe-trading init')

    await fsp.mkdir(cwd, { recursive: true })
    await fsp.mkdir(logsDir(this.env), { recursive: true })
    const logFile = this.options.logFile ?? workerLogPath(this.env)
    if (!this.logFileHandle) {
      // Rotate once at 5 MB so a long-running worker cannot grow the log forever.
      try {
        const stat = await fsp.stat(logFile)
        if (stat.size > 5 * 1024 * 1024) {
          await fsp.rename(logFile, `${logFile}.1`).catch(() => {})
        }
      } catch {
        /* no existing log */
      }
      this.logFileHandle = await fsp.open(logFile, 'a')
    }

    // Vibe-Trading keeps data-source credentials in <vibeHome>/.env; the worker
    // runs with that directory as its cwd, so load them the way VT itself would
    // (existing process env wins, config.env wins last). `.env` stays on the real
    // home because VT resolves it from `Path.home()`, not from VIBE_TRADING_HOME.
    const dotenv = await readDotEnvValues(this.env)
    const env = buildWorkerEnv(this.cfg, this.env, dotenv, { patchFile: this.patchFile })
    this.#checkRuntimeRoots(env)

    const child = spawn(python, [scriptPath, '--cwd', cwd], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.startedAt = new Date().toISOString()
    this.log(`worker started: pid=${child.pid} python=${python}`)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      void this.logFileHandle?.write?.(String(chunk))
    })
    child.on('error', (error) => {
      this.lastError = String(error?.message ?? error)
      this.#failPending(new Error(this.lastError))
    })
    child.on('exit', (code, signal) => {
      this.log(`worker exited: code=${code} signal=${signal}`)
      this.child = null
      this.#failPending(new Error(`worker exited (code ${code}) before replying`))
      this.#clearIdleTimer()
    })

    const ping: any = await this.request('ping', {}, { timeoutMs: 120_000 })
    this.restarts = 0
    this.lastError = null
    this.log(`worker ready: ${ping?.tools ?? '?'} tools`)
    return ping
  }

  #failPending(error: any) {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(error)
    }
    this.pending.clear()
  }

  #onStdout(chunk: string) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (line) this.handleLine(line)
      index = this.buffer.indexOf('\n')
    }
  }

  /** Handle one stdout line (public for tests; called by the stdout reader). */
  handleLine(line: string) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.log(`non-JSON line on stdout: ${line.slice(0, 200)}`)
      return
    }
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) {
      const error: any = new Error(message.error?.message ?? 'worker 调用失败')
      error.code = message.error?.code
      error.data = message.error?.data
      entry.reject(error)
    } else {
      entry.resolve(message.result)
    }
  }

  /**
   * Send one request. Restarts the worker once per request when the process
   * died between calls.
   */
  async request(method: string, params: any = {}, options: any = {}) {
    try {
      return await this.#requestOnce(method, params, options)
    } catch (error: any) {
      const retryable =
        !options.signal?.aborted &&
        Boolean(this.cfg?.venv?.python || this.options.python) &&
        this.restarts < this.maxRestarts &&
        /worker exited|EPIPE|not running|未运行/.test(String(error?.message ?? ''))
      if (!retryable) throw error
      this.restarts += 1
      this.log(`restarting worker after: ${error.message}`)
      await this.start()
      return this.#requestOnce(method, params, options)
    }
  }

  #requestOnce(method: string, params: any, options: any = {}) {
    if (!this.ready) return Promise.reject(new Error('worker 未运行，请先执行 /vibe-trading on'))
    this.#touchIdleTimer()
    const id = ++this.seq
    const timeoutMs = options.timeoutMs ?? this.cfg?.worker?.defaultTimeoutMs ?? 120_000
    const child = this.child
    return new Promise((resolve, reject) => {
      // Do not unref this timer: the caller is awaiting the promise, so the
      // timeout is live work. Unref'd timers let the event loop drain first and
      // surface as "Promise resolution is still pending" under load (tests and
      // short timeouts were flaky). The idle timer below stays unref'd.
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`worker 调用超时: ${method} (${timeoutMs}ms)`))
      }, timeoutMs)

      const onAbort = () => {
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(new Error('cancelled'))
      }
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer)
          reject(new Error('cancelled'))
          return
        }
        options.signal.addEventListener('abort', onAbort, { once: true })
      }

      this.pending.set(id, {
        resolve: (value: any) => {
          options.signal?.removeEventListener?.('abort', onAbort)
          resolve(value)
        },
        reject: (error: any) => {
          options.signal?.removeEventListener?.('abort', onAbort)
          reject(error)
        },
        timer,
      })

      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error: any) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(String(error?.message ?? error)))
      }
    })
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.#clearIdleTimer()
    const child = this.child
    if (!child) {
      this.stopping = false
      return
    }
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: ++this.seq, method: 'shutdown', params: {} })}\n`)
    } catch {
      /* ignore */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        resolve()
      }, 3_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.child = null
    this.stopping = false
  }

  /* ---- idle handling -------------------------------------------------- */

  #idleMs() {
    const minutes = this.cfg?.worker?.idleMinutes
    if (minutes === undefined || minutes === null) return 30 * 60_000
    if (minutes <= 0) return 0
    return minutes * 60_000
  }

  #touchIdleTimer() {
    this.#clearIdleTimer()
    const idleMs = this.#idleMs()
    if (!idleMs) return
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) {
        this.log('worker idle timeout; stopping')
        void this.stop()
      }
    }, idleMs)
    if (this.idleTimer.unref) this.idleTimer.unref()
  }

  #clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }

  async dispose(): Promise<void> {
    await this.stop()
    try {
      await this.logFileHandle?.close?.()
    } catch {
      /* ignore */
    }
    this.logFileHandle = null
  }
}

export { dshDataDir }
