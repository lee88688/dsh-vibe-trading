/**
 * dsh-vibe-trading — DeepSeek Harness host plugin.
 *
 * DSH runs the agent. This plugin adds Vibe-Trading's tools, skills and prompt
 * guidance to the *current* session on demand:
 *
 *   /vibe-trading init     create the Python env + config under ~/.vibe-trading/dsh
 *   /vibe-trading on       start/reuse the Python worker, register tools + prompt
 *   /vibe-trading off      dispose this session's registrations
 *   /vibe-trading status   environment / worker / session state
 *
 * The tool block is fixed at activation, so the provider prefix cache stays warm;
 * tool signatures and skill bodies are fetched on demand and appended.
 */

import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_MINIMUM_VERSION,
  DEFAULT_VERIFIED_VERSIONS,
  PINNED_VERSION,
  PACKAGE_NAME,
  configPath,
  effectiveConfig,
  isFloorAbovePin,
  isVerifiedVersion,
  packageMode,
  readConfig,
  readReport,
  resolveVibeHome,
  runtimeHomeDir,
  validateConfig,
  workDir,
  writeConfig,
} from './lib/config.js'
import { runPreflight, summarizePreflight } from './lib/preflight.js'
import { runInstall, verifyEnvironment } from './lib/install.js'
import { createSetupTool } from './lib/setup-tool.js'
import { WorkerClient } from './lib/worker.js'
import { activate, createSessionRegistry, deactivate, sessionStatus } from './lib/activate.js'
import { createGrounding } from './lib/verify.js'
import type { CommandInvocation, PluginConfig, PluginContext } from './types.js'
import { buildPromptText } from './lib/prompt.js'
import { getConfigValue } from './lib/config.js'
import { createFiguresTool } from './lib/figures-tool.js'
import { pluginLog, pluginLogNow } from './lib/log.js'
import { registerVibeProjection } from './lib/vibe-state.js'
import { appendGateRecord } from './lib/gate-record.js'
import { activationIntent, shouldRestoreOnCreation } from './lib/activation-intent.js'
import { advertisedToolNames, credentialGatedOff, filterToolsets, surfaceReport } from './lib/surface.js'
import { parseInitFlags } from './lib/init-flags.js'
import {
  CONFIG_ENTRY_ID,
  SETTING_KEYS,
  createSettings,
  liveConfig,
  loadHostSchema,
  buildConfigSchema,
  settingPatch,
} from './lib/settings.js'

export const name = 'dsh-vibe-trading'
export const inject = ['commands', 'tools']

/**
 * Loader config schema for this plugin row.
 *
 * Declared here (not read from `config.json`) so the web UI can edit the
 * behavioural settings on the plugin page and each DSH profile keeps its own
 * values in that profile's `cordis.patch.yml`. Every editable field is volatile:
 * the Loader commits a volatile-only change into the running references instead
 * of remounting the plugin, and a remount would dispose every session's tools.
 *
 * When the host's own schemastery cannot be resolved the export stays undefined;
 * the Loader then passes the raw config through and `createSettings` falls back
 * to the compiled-in defaults.
 */
export const Config = await (async () => {
  try {
    return buildConfigSchema(await loadHostSchema())
  } catch (error: any) {
    pluginLogNow(`apply: config schema unavailable (${error?.message ?? error})`, process.env)
    return undefined
  }
})()

// dist/index.js -> package root (assets live beside dist/, not inside it)
const PLUGIN_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const PROMPT_DIR = path.join(PLUGIN_DIR, 'prompt')
const TOOLSETS_FILE = path.join(PLUGIN_DIR, 'toolsets.json')

/* ------------------------------------------------------------------------- */
/* Plugin assets                                                              */
/* ------------------------------------------------------------------------- */

async function readToolsets() {
  try {
    return JSON.parse(await fsp.readFile(TOOLSETS_FILE, 'utf8'))
  } catch {
    return { staticCore: [], groups: {}, virtualTools: [] }
  }
}

async function readPromptAssets() {
  const read = async (file: string): Promise<string> => {
    try {
      return await fsp.readFile(path.join(PROMPT_DIR, file), 'utf8')
    } catch {
      return ''
    }
  }
  return { base: await read('vibe-trading.md'), bridge: await read('bridge.md') }
}

function argOf(invocation: CommandInvocation) {
  return String(invocation?.rawInput ?? '').trim().toLowerCase()
}

function splitArgs(raw: any) {
  return String(raw ?? '').trim().split(/\s+/).filter(Boolean)
}

async function readRawConfig(env: NodeJS.ProcessEnv) {
  try {
    return JSON.parse(await fsp.readFile(configPath(env), 'utf8'))
  } catch {
    return null
  }
}

function formatMinutes(minutes?: number | null) {
  if (!minutes || minutes <= 0) return '不自动退出'
  return `${minutes} 分钟`
}

/* ------------------------------------------------------------------------- */
/* Number-verification gate wiring                                            */
/* ------------------------------------------------------------------------- */

/**
 * Read the assistant text out of an 'assistant/message' payload.
 *
 * The committed event carries the message object; older shapes put the text on
 * the payload itself, so both are accepted.
 */
export function extractAssistantText(payload: any): string | null {
  if (!payload) return null
  if (typeof payload === 'string') return payload.trim() || null
  const message = payload.message ?? payload.assistantMessage ?? payload.attempt?.message ?? payload
  const content = message?.content ?? message?.text ?? payload.text
  if (typeof content === 'string') return content.trim() || null
  if (Array.isArray(content)) {
    const text = content
      .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
    return text.trim() || null
  }
  return null
}

/**
 * Wire the answer gate.
 *
 * DSH has no API to rewrite or redact an assistant message that was already
 * committed, so the gate works on the draft captured from 'assistant/message':
 *
 * - invalid + revisions left: steer the per-figure correction and keep the turn
 *   open (the model rewrites);
 * - revisions exhausted: steer one disclosure instruction ("say which numbers
 *   need re-checking") and let the turn close, so the user still learns the
 *   answer was not fully verified instead of getting a silent fabrication.
 *
 * Any unexpected event shape or API absence degrades to letting the turn close.
 */
/**
 * Whether one agent's session has already started a conversation.
 *
 * `/vibe-trading off` is only meaningful before the first turn: once the model
 * has seen the Vibe-Trading tools, the history keeps calling them, so removing
 * the registrations afterwards leaves dead tool calls (`UNKNOWN_TOOL`) and
 * invalidates the provider prefix cache for no user benefit.
 *
 * Reads committed events through `ctx.agents.turnBoundaryOf(session)`. Any
 * absent API or unreadable session answers `false`, which keeps `off` available
 * instead of turning a probe failure into a refusal.
 */
/**
 * Read the `agents` service without declaring a hard dependency on it.
 *
 * The plugin's `inject` list is `['commands', 'tools']`; Cordis throws on direct
 * property access to a non-injected service, so this optional lookup keeps the
 * session-start probe (and therefore `off`) working on hosts without `agents`.
 */
function optionalAgents(ctx: any): any {
  return optionalService(ctx, 'agents')
}

/**
 * Read an optional Cordis service without declaring it in `inject`.
 *
 * Direct property access on a non-injected service throws, so optional lookups
 * (agents, settings, configEditor) always go through `ctx.get`.
 */
function optionalService(ctx: any, id: string): any {
  try {
    return ctx?.get ? ctx.get(id) : undefined
  } catch {
    return undefined
  }
}

export function sessionHasStarted(agent: any, agents: any): boolean {
  try {
    const session = agent?.session
    if (!session) return false
    const boundary = agents?.turnBoundaryOf?.(session)
    if (!boundary) return false
    return Number(boundary.lastTurn ?? 0) > 0
  } catch {
    return false
  }
}

/**
 * Build one complete user message for `agent.followup` / `agent.steer`.
 *
 * The agent inbox persists the payload verbatim as a `user/message` event, and
 * Session validation on reload requires every message event to identify its
 * message (`id`) and role. A bare `{ content, source }` object is accepted at
 * runtime but fails on the next load with "session event ... lacks an identified
 * message", so injected messages must be shaped like the ones the UI submits.
 */
export function userMessage(text: string) {
  return {
    id: randomUUID(),
    role: 'user' as const,
    content: [{ type: 'text' as const, text }],
    source: { kind: 'user' as const },
  }
}

export function wireAnswerGate(agent: any, grounding: any, sessionState: any, log: (line: string) => void) {
  // Wired even while the gate is disabled: the values are live, so enabling it
  // from the plugin page must take effect without re-activating the session.
  if (!grounding) return
  const state: { draft: string | null; disclosed: boolean } = { draft: null, disclosed: false }
  const finish = (next?: () => any) => (typeof next === 'function' ? next() : undefined)
  // Injectable only for tests: the real bridge resolves the host's own
  // `@deepseek-ai/dsh-session` instance, which a unit test cannot provide.
  const appendRecord: typeof appendGateRecord =
    typeof sessionState?.appendRecord === 'function' ? sessionState.appendRecord : appendGateRecord
  const listen = (event: string, listener: (...args: any[]) => any) => {
    const disposer = agent.ctx.on(event, listener)
    if (typeof disposer === 'function') sessionState.disposers.push(disposer)
  }
  const steer = (text: string) => {
    try {
      agent.steer?.(userMessage(text))
      return true
    } catch (error: any) {
      log(`answer gate steer failed: ${error?.message ?? error}`)
      return false
    }
  }

  // 'assistant/message' is a *Session* event, not a Context event: plugins observe
  // it through 'session/event' and read the committed record from event.data.
  const onSessionEvent = (session: any, event: any) => {
    try {
      if (!event || typeof event !== 'object') return
      // Agent.id is the SessionId; agent.session is the Session object.
      const expectedSession = agent?.id ?? agent?.session?.id
      const sessionId = session?.id ?? event?.sessionId ?? event?.data?.sessionId
      if (sessionId && expectedSession && String(sessionId) !== String(expectedSession)) return
      if (event.type === 'turn/start') {
        state.draft = null
        state.disclosed = false
        void grounding.resetTurn?.()
        return
      }
      if (event.type === 'user/message') {
        // Host-injected records arrive as user-role messages too (runtime
        // context, time context, skill catalog...). Only the user's own input may
        // seed the identity gate; a record without a source keeps the old path.
        const sourceKind = event.data?.source?.kind ?? event.data?.message?.source?.kind
        if (sourceKind !== undefined && sourceKind !== 'user') return
        const text = extractAssistantText(event.data ?? event)
        // Skip slash commands and the gate's own injected correction messages:
        // only the user's actual request may seed the identity gate.
        if (text && !text.startsWith('/') && !/^\[GROUNDING GATE\]|^本次回答有|^注意：上一版/.test(text)) {
          grounding.setUserMessage?.(text)
        }
        return
      }
      if (event.type !== 'assistant/message') return
      const text = extractAssistantText(event.data ?? event)
      if (text) state.draft = text
    } catch (error: any) {
      log(`answer gate session listener failed: ${error?.message ?? error}`)
    }
  }
  try {
    listen('session/event', onSessionEvent)
  } catch (error: any) {
    log(`answer gate cannot watch session/event: ${error?.message ?? error}`)
  }

  try {
    // `agent/turn-stopping` is a *serial* event in DSH 0.2.2-rc.5: the host awaits
    // this listener, passes no `next`, and "keep the turn open" is expressed by
    // steering. `finish` still calls a `next` when an older host provides one, so
    // the gate keeps working on both shapes.
    listen('agent/turn-stopping', async (payload: any, next?: () => any) => {
      try {
        // Live value: the gate may have been switched on after activation.
        if (!grounding.enabled) {
          state.draft = null
          return finish(next)
        }
        const text = state.draft ?? extractAssistantText(payload)
        if (!text) return finish(next)
        state.draft = null
        const verdict = await grounding.checkAnswer(text)
        if (verdict.valid) {
          state.disclosed = false
          return finish(next)
        }
        if (!verdict.exhausted && verdict.correction) {
          if (!steer(verdict.correction)) return finish(next)
          return undefined // keep the turn open for the corrected answer
        }
        if (state.disclosed) return finish(next)
        state.disclosed = true
        const mode = typeof grounding.failureMode === 'string' ? grounding.failureMode : grounding.silent ? 'silent' : 'panel'
        // 'silent' means: no panel and no steer — disclosure is opted out.
        if (mode === 'silent') return finish(next)
        // Panel details travel as an ignorable plugin record the client renders
        // at the turn tail, i.e. directly under the answer that failed.
        const recorded = verdict.panel
          ? await appendRecord(agent?.session, verdict.panel, log)
          : false
        if (verdict.panel) log(`answer gate panel record: ${recorded ? 'appended' : 'unavailable (using disclosure text)'}`)
        // 'panel' (default): close the turn on the panel. A steered sentence
        // would cost a whole model round to restate the panel, so it is only
        // used when the record could not be written (otherwise the user would
        // get no disclosure at all).
        if (mode === 'panel') {
          if (recorded) return finish(next)
          const fallback = verdict.fallbackFull ?? verdict.fallback
          if (fallback && steer(fallback)) return undefined
          return finish(next)
        }
        // 'disclose': keep the caveat in the transcript text itself.
        const message =
          (recorded ? verdict.fallback : verdict.fallbackFull ?? verdict.fallback) ??
          '注意：上一版回答中的部分数字没有通过核实。请用一句话向用户说明"部分数字未能核实、需要复核"，' +
            '不要重复未核实的数字，也不要声称它们已验证。'
        if (!steer(message)) return finish(next)
        return undefined
      } catch (error: any) {
        log(`answer gate skipped: ${error?.message ?? error}`)
        return finish(next)
      }
    })
  } catch (error: any) {
    log(`answer gate not wired: ${error?.message ?? error}`)
  }
}

/* ------------------------------------------------------------------------- */
/* Plugin                                                                     */
/* ------------------------------------------------------------------------- */

export async function apply(ctx: PluginContext, pluginConfig: PluginConfig = {}) {
  const env = process.env
  // Profile-scoped preferences come from the Loader row config (live refs);
  // `config.json` only carries install facts from here on.
  const settings = createSettings(pluginConfig)
  const startSnapshot = settings.snapshot()
  pluginLogNow(
    `apply: start (version=${startSnapshot.minimumVersion}, mode=${startSnapshot.packageMode}, ` +
      `gate=${startSnapshot.verification.enabled ? 'on' : 'off'})`,
    env,
  )
  const sessions = createSessionRegistry()
  const minimumVersion = () => settings.minimumVersion()
  // Pinned by default: the tested release is the one users get, unless the
  // profile config explicitly opts into tracking the newest release.
  const defaultMode = () => settings.packageMode()

  let worker: WorkerClient | null = null
  let initPromise: Promise<any> | null = null
  let lastInit: any = null
  // Last worker-surface comparison, shown by `/vibe-trading status` and warned
  // about by `on` when the installed release drifts from the recorded catalog.
  let lastSurface: any = null
  // Last live version probe (init fast path / activation), so `status` reports
  // the actually-installed release instead of only the config record.
  let lastProbe: any = null

  // Lazy auto-restore: the intent comes from the durable session log
  // (`command/run` events), so there is no side-car state to keep in sync.
  const autoIntent = new Map<string, boolean>()
  const autoTried = new Set<string>()
  const pendingAuto = new Map<string, Promise<any>>()

  function log(line: string) {
    try {
      ctx.logger?.info?.(`[vibe-trading] ${line}`)
    } catch {
      /* ignore */
    }
  }

  function getWorker(cfg: any): WorkerClient {
    // The monkey-patch path is a profile setting, so read it live: a change
    // takes effect the next time the worker process is (re)started.
    const patchFile = settings.snapshot().worker.patchFile
    if (!worker) {
      worker = new WorkerClient(cfg, { env, log, patchFile })
    } else {
      if (cfg?.venv?.python) worker.cfg = cfg
      worker.patchFile = patchFile
    }
    return worker
  }

  async function ensureWorker(cfg: any): Promise<WorkerClient> {
    const client: WorkerClient = getWorker(cfg)
    if (!client.ready) await client.start()
    return client
  }

  async function handoffToAgent(inv: CommandInvocation, text: string) {
    try {
      inv.agent.followup?.(userMessage(text))
      return true
    } catch (error: any) {
      log(`agent handoff failed: ${error?.message ?? error}`)
      return false
    }
  }

  function initReportText(result: any): string {
    const reportPath = path.join(resolveVibeHome(env), 'dsh', 'init-report.json')
    const logPath = path.join(resolveVibeHome(env), 'dsh', 'logs')
    if (result?.ok) {
      const installed = result.config?.package?.installedVersion ?? '?'
      const mode = result.report?.mode ?? defaultMode()
      const pinned = result.report?.pinnedVersion ?? PINNED_VERSION
      const verified = result.report?.verified !== undefined
        ? Boolean(result.report.verified)
        : isVerifiedVersion(installed)
      const floorAbovePin = isFloorAbovePin(minimumVersion(), pinned)
      return [
        'Vibe Trading 初始化结果：已完成，环境可用。',
        `- vibe-trading-ai ${installed}（策略 ${mode === 'latest' ? '跟随最新' : '固定版本'}；` +
          `${verified ? `已验证 ${installed}` : `⚠️ 未验证，插件已验证 ${pinned}`}）`,
        `- config: ${configPath(env)}`,
        `- 报告: ${reportPath}`,
        verified
          ? ''
          : floorAbovePin
            ? `注意：minimumVersion ${minimumVersion()} 高于已验证 pin ${pinned}，固定模式已拒绝；如需固定版本请把 minimumVersion 调回 ≤ ${pinned}。`
            : '注意：这次装的是插件未验证过的版本，工具目录可能与快照不同。如需回退到固定版本，运行 /vibe-trading init --pinned。',
        '请用一句话告诉用户"可以了"，并提醒他执行 /vibe-trading on 激活当前会话；如果用户还想做金融任务，直接继续。',
      ]
        .filter(Boolean)
        .join('\n')
    }
    const preflight = result?.report?.preflight ?? result?.preflight
    const diagnosis = preflight
      ? summarizePreflight({
          status: result?.status ?? 'needs-help',
          vibeHome: resolveVibeHome(env),
          config: null,
          configError: null,
          checks: preflight.checks ?? [],
          pythons: preflight.pythons ?? [],
          dotenv: { keys: preflight.dotenvKeys ?? preflight.dotenv?.keys ?? [] },
        })
      : String(result?.report?.reason ?? result?.error ?? result?.reason ?? '未知错误')
    return [
      'Vibe Trading 初始化没有成功。请你根据下面的诊断决定：直接用一句话向用户说明，或者调用 Host 工具 vibe_trading_setup 自己修复（修好后告诉用户结果）。',
      `- 状态: ${result?.status ?? 'unknown'}`,
      `- 诊断: ${diagnosis}`,
      `- 报告: ${reportPath}`,
      `- 日志: ${logPath}`,
      '可用动作: vibe_trading_setup(action=check | install | repair | verify)，或让用户重试 /vibe-trading init。',
    ].join('\n')
  }

  async function startInstall(inv: CommandInvocation, mode = defaultMode()) {
    if (initPromise) return { started: false, promise: initPromise }
    initPromise = runInstall({ env, minimumVersion: minimumVersion(), mode, pinnedVersion: PINNED_VERSION, log })
      .then(async (result) => {
        lastInit = result
        const handed = await handoffToAgent(inv, initReportText(result))
        return { ...result, handed }
      })
      .catch(async (error: any) => {
        const failure = { ok: false, status: 'needs-help', error: String(error?.message ?? error) }
        lastInit = failure
        await handoffToAgent(inv, initReportText(failure))
        return failure
      })
      .finally(() => {
        initPromise = null
      })
    return { started: true, promise: initPromise }
  }

  ctx.effect?.(() => () => {
    sessions.ids?.()
    for (const agentId of sessions.ids()) void deactivate({ agentId, sessions })
    if (worker) void worker.dispose?.()
    worker = null
  })

  // Global host tool used by the agent during `init --guided` style repair.
  try {
    const disposer = ctx.tools.register(createSetupTool({ env }))
    pluginLogNow('apply: vibe_trading_setup registered', env)
    ctx.effect?.(() => (typeof disposer === 'function' ? disposer : () => {}))
  } catch (error: any) {
    pluginLogNow(`apply: vibe_trading_setup registration FAILED: ${error?.message ?? error}`, env)
    log(`vibe_trading_setup registration failed: ${error?.message ?? error}`)
  }

  try {
    ctx.commands.register({
    name: 'vibe-trading',
    description: 'Vibe Trading：init 初始化环境 | on 激活当前会话 | off 取消激活 | status 状态 | config 查看/修改配置',
    input: { hint: 'init [--latest|--pinned|--force] | on | off | status | config [get <key> | set <key> <value>]' },
    // Record the raw input so the client chip projection can tell on from off.
    recordInput: true,
    async handler(inv: CommandInvocation) {
      const tokens = splitArgs(inv.rawInput)
      const verb = (tokens[0] ?? '').toLowerCase() || 'status'
      const arg = argOf(inv) || 'status'
      pluginLogNow(`command invoked: rawInput=${JSON.stringify(inv.rawInput ?? '')} arg=${arg}`, env)
      try {
        if (verb === 'status') return { kind: 'success', text: await statusText(inv) }
        if (verb === 'init') return await initCommand(inv, tokens.slice(1))
        if (verb === 'on') return await onCommand(inv)
        if (verb === 'off') return await offCommand(inv)
        if (verb === 'config') return await configCommand(inv, inv.rawInput)
        return { kind: 'error', text: '用法：/vibe-trading init [--latest|--pinned|--force] | on | off | status | config [get <key> | set <key> <value>]' }
      } catch (error: any) {
        pluginLogNow(`command failed: ${arg} -> ${error?.message ?? error}`, env)
        return { kind: 'error', text: `vibe-trading ${arg} 失败：${error?.message ?? error}` }
      }
    },
    })
    pluginLogNow('apply: /vibe-trading command registered', env)
  } catch (error: any) {
    pluginLogNow(`apply: command registration failed: ${error?.message ?? error}`, env)
    log(`vibe-trading command registration failed: ${error?.message ?? error}`)
  }

  // Client-visible activation state behind the composer chip (Web GUI). Optional:
  // headless/CLI profiles carry no sessionProjections, and a failure here must
  // never affect activation.
  void registerVibeProjection(ctx).then((handle) => {
    pluginLogNow(handle ? 'apply: vibeTrading projection registered' : 'apply: vibeTrading projection unavailable', env)
  })

  // Auto-restore has two entry points and no lazy one: `apply()` scans agents
  // that are already live (reload/upgrade), and `agent/created` covers every
  // session instantiated afterwards (host restart, resume, seeded fork, `clear`,
  // `compact`). There is no `inbox/inserted` path — opening a session is what
  // instantiates its agent, which is the edge observed here.
  //
  // `startup` is allowed through only for a seeded fork: DSH announces a fork
  // with that source, so `header.isSeeded` is the only fork marker available.
  function wireAutoRestore() {
    try {
      const onEvent = (ctx as any).on
      const offCreated =
        typeof onEvent === 'function'
          ? onEvent.call(ctx, 'agent/created', async (payload: any) => {
              const agent = payload?.agent
              const agentId = String(agent?.id ?? '')
              const source = String(payload?.source ?? '?')
              const seeded = agent?.session?.header?.isSeeded === true
              if (!shouldRestoreOnCreation(source, seeded)) {
                pluginLogNow(`auto-restore: skip ${agentId} source=${source} seeded=${seeded}`, env)
                return
              }
              if (seeded) {
                // The fork is the one case where an inherited intent decides, so
                // record the verdict instead of leaving a silent no-tools session.
                pluginLogNow(`auto-restore: seeded fork ${agentId} intent=${sessionAutoIntent(agent)}`, env)
              }
              try {
                await maybeAutoActivate(agent)
              } catch {
                /* activation failures are logged; never break creation */
              }
            })
          : undefined
      if (typeof offCreated === 'function') ctx.effect?.(() => offCreated)
      pluginLogNow('apply: auto-restore listeners registered', env)
    } catch (error: any) {
      pluginLogNow(`auto-restore listener registration failed: ${error?.message ?? error}`, env)
      log(`auto-restore listener registration failed: ${error?.message ?? error}`)
    }
  }
  wireAutoRestore()

  /* ---- command implementations ---------------------------------------- */

  /** Show a compact effective-config view or one value. */
  async function configCommand(inv: CommandInvocation, raw: any) {
    const parts = splitArgs(raw).slice(1) // drop "config"
    const action = parts[0] ?? 'show'
    const snapshot = settings.snapshot()
    const flat = (value: any, prefix = ''): Array<[string, any]> =>
      Object.entries(value ?? {}).flatMap(([key, child]) =>
        child && typeof child === 'object' && !Array.isArray(child)
          ? flat(child, `${prefix}${key}.`)
          : ([[`${prefix}${key}`, child]] as Array<[string, any]>),
      )
    const current = {
      minimumVersion: snapshot.minimumVersion,
      packageMode: snapshot.packageMode,
      verification: snapshot.verification,
      skills: snapshot.skills,
      worker: snapshot.worker,
    }
    if (action === 'show') {
      return {
        kind: 'success',
        text: [
          `profile 配置（本插件行 ${CONFIG_ENTRY_ID}，随 profile 存于 cordis.patch.yml）:`,
          ...flat({
            verification: snapshot.verification,
            skills: snapshot.skills,
            worker: snapshot.worker,
            minimumVersion: snapshot.minimumVersion,
            packageMode: snapshot.packageMode,
          }).map(([key, value]) => `  ${key} = ${JSON.stringify(value)}`),
          `安装事实（解释器/venv/工作目录）: ${configPath(env)}`,
          '修改：/vibe-trading config set <key> <value>；或插件页 → Vibe Trading → 配置（保存后立即生效）。',
        ].join('\n'),
      }
    }
    if (action === 'get') {
      const key = parts[1]
      if (!key) return { kind: 'error', text: '用法：/vibe-trading config get <key>' }
      const value = getConfigValue(current, key)
      return { kind: 'success', text: `${key} = ${value === undefined ? '(未设置)' : JSON.stringify(value)}` }
    }
    if (action === 'set') {
      const key = parts[1]
      const value = parts.slice(2).join(' ')
      if (!key || value === '') {
        return { kind: 'error', text: `用法：/vibe-trading config set <key> <value>（可用：${SETTING_KEYS.join(', ')}）` }
      }
      const written = await writeSetting(key, value)
      if (!written.ok) return { kind: 'error', text: written.error }
      return {
        kind: 'success',
        text: [
          `已写入 ${key} = ${JSON.stringify(written.value)}（profile 配置，立即生效，无需重新 on）。`,
          '图形界面同一项：插件页 → Vibe Trading → 配置。',
        ].join('\n'),
      }
    }
    return { kind: 'error', text: '用法：/vibe-trading config [get <key> | set <key> <value>]' }
  }

  /** Persist one profile-scoped setting through the host settings service. */
  async function writeSetting(key: string, rawValue: string) {
    const patch = settingPatch(key, rawValue)
    if (!patch.ok) return { ok: false as const, error: patch.error ?? '配置项不支持' }
    const hostSettings: any = optionalService(ctx, 'settings')
    if (!hostSettings || typeof hostSettings.update !== 'function') {
      return {
        ok: false as const,
        error:
          '宿主没有提供 settings 服务，无法写入 profile 配置。' +
          '可改用插件页的「配置」，或手动编辑当前 profile 的 cordis.patch.yml。',
      }
    }
    try {
      await hostSettings.update(CONFIG_ENTRY_ID, patch.patch)
    } catch (error: any) {
      return { ok: false as const, error: `写入 profile 配置失败：${error?.message ?? error}` }
    }
    pluginLogNow(`config set: ${key}=${JSON.stringify(patch.value)}（profile ${CONFIG_ENTRY_ID}）`, env)
    return { ok: true as const, value: patch.value }
  }

  /** One-line package status: installed version, install policy, verification. */
  function packageStatusText(config: any) {
    const installed = lastProbe?.version ?? config?.package?.installedVersion ?? '?'
    const mode = packageMode(config)
    // Verification is a property of the plugin's tested set, not of whatever a
    // previous install wrote into config.json.
    const verified = lastProbe ? Boolean(lastProbe.verified) : isVerifiedVersion(installed)
    const tested = (lastProbe?.verifiedVersions ?? DEFAULT_VERIFIED_VERSIONS).join(', ')
    return (
      `vibe-trading-ai: ${installed}（策略 ${mode === 'latest' ? '跟随最新' : '固定版本'}；` +
      `${verified ? `已验证 ${installed}` : `⚠️ 未验证，插件已验证 ${tested}`}）`
    )
  }

  async function statusText(inv: CommandInvocation) {
    const agentId = String(inv.agent?.id ?? 'session')
    const { config, error, exists } = await readConfig(env)
    const session = sessionStatus({ agentId, sessions })
    const report = await readReport(env)
    const snapshot = settings.snapshot()
    const gate = snapshot.verification
    const lines = [
      `config: ${config ? configPath(env) : exists ? `存在但无效（${error}）` : `缺失（${configPath(env)}）`}`,
      config ? packageStatusText(config) : '',
      `vt 运行时根: ${runtimeHomeDir(env)}（runs/research/shadow_* 等落这里；.env 与 data-bridge 仍读 ${resolveVibeHome(env)}）`,
      `worker: ${worker?.ready ? `运行中 pid=${worker.status.pid}` : '未启动'} · 空闲退出 ${formatMinutes(snapshot.worker.idleMinutes)}`,
      `数字核实门禁: ${gate.enabled ? '开启' : '关闭'}（identity=${gate.identityGate ? 'on' : 'off'}, figures=${gate.figuresGate ? 'on' : 'off'}, maxRevisions=${gate.maxRevisions}, onFailure=${gate.onFailure}）`,
      `profile 设置: ${CONFIG_ENTRY_ID} 行（插件页 → 配置）· skills.mode=${snapshot.skills.mode}`,
      `本会话: ${session.active ? `已激活（${session.toolCount} 个工具，已加载 ${session.loadedTools.length} 个）` : '未激活'}`,
      session.active && sessionHasStarted(inv.agent, optionalAgents(ctx))
        ? '关闭方式: 已开始对话，禁止 /vibe-trading off（如需不带 Vibe Trading，请新建会话）'
        : '',
      lastSurface && !lastSurface.ok
        ? `工具面漂移: worker 缺少 ${lastSurface.missing.length} 个目录工具（${lastSurface.missing.slice(0, 5).join(', ')}${lastSurface.missing.length > 5 ? '…' : ''}）；可能是未验证的 vibe-trading-ai 版本`
        : '',
      report ? `最近初始化: ${report.status ?? '?'}${report.seconds ? `，${report.seconds}s` : ''}` : '',
      initPromise ? '初始化进行中…' : '',
    ].filter(Boolean)
    return lines.join('\n')
  }

  /** Warm the worker in the background so the next /vibe-trading on is fast. */
  async function warmWorker(cfg: any) {
    try {
      const client = await ensureWorker(cfg)
      await client.request('ping')
      pluginLogNow('init: worker warmed (cold start paid during init)', env)
      log('worker warmed after init')
      try {
        const listed: any = await client.request('tools/list')
        const toolsets = await readToolsets()
        lastSurface = surfaceReport(listed?.tools ?? [], toolsets)
        if (!lastSurface.ok) {
          log(
            `surface drift: worker lacks ${lastSurface.missing.length} advertised tool(s): ` +
              lastSurface.missing.slice(0, 5).join(', '),
          )
        }
      } catch (error: any) {
        log(`surface check skipped: ${error?.message ?? error}`)
      }
    } catch (error: any) {
      pluginLogNow(`init: worker warm-up failed: ${error?.message ?? error}`, env)
    }
  }

  async function initCommand(inv: CommandInvocation, flags: string[] = []) {
    const parsed = parseInitFlags(flags)
    if (parsed.error) return { kind: 'error', text: parsed.error }
    const mode = parsed.mode ?? defaultMode()
    // `--force` must reinstall too: otherwise it would silently take the fast
    // path and report "already ready" without doing anything.
    const reinstall = Boolean(parsed.mode) || parsed.force
    const { config } = await readConfig(env)
    if (config) {
      const verification = await verifyEnvironment(env, minimumVersion())
      lastProbe = verification
      // An unverified release is usable; only reinstall when the floor is missed
      // or the user explicitly asked for a policy / forced a reinstall.
      if (verification.ok && !reinstall) {
        void warmWorker(liveConfig(config, settings))
        const cfgMode = packageMode(config)
        const state = verification.verified
          ? `已验证 ${verification.version}`
          : `⚠️ 未验证，插件已验证 ${(verification.verifiedVersions ?? DEFAULT_VERIFIED_VERSIONS).join(', ')}`
        const handed = await handoffToAgent(
          inv,
          [
            'Vibe Trading 初始化检查结果：环境已就绪，无需再安装。',
            `- vibe-trading-ai ${verification.version}（策略 ${cfgMode === 'latest' ? '跟随最新' : '固定版本'}；${state}）`,
            `- config: ${configPath(env)}`,
            `- 报告: ${path.join(resolveVibeHome(env), 'dsh', 'init-report.json')}`,
            '请用一句话告诉用户"可以了"，并提醒他执行 /vibe-trading on 激活当前会话。',
          ].join('\n'),
        )
        return {
          kind: 'success',
          text:
            `环境已就绪：vibe-trading-ai ${verification.version}（${verification.verified ? '已验证' : '未验证'}；` +
            `${configPath(env)}）。${handed ? '结果已交给当前会话的 agent。' : '用 /vibe-trading on 激活当前会话。'}`,
        }
      }
      const result = await runInstall({
        env,
        minimumVersion: minimumVersion(),
        mode,
        pinnedVersion: PINNED_VERSION,
        force: true,
        log,
      })
      lastInit = result
      if (result.ok) {
        const fresh = await readConfig(env)
        if (fresh.config) void warmWorker(liveConfig(fresh.config, settings))
      }
      const handed = await handoffToAgent(inv, initReportText(result))
      const installed = result.config?.package?.installedVersion ?? '?'
      const verified = (result.report as any)?.verified !== undefined
        ? Boolean((result.report as any).verified)
        : isVerifiedVersion(installed)
      return result.ok
        ? {
            kind: 'success',
            text:
              `已按${mode === 'latest' ? '跟随最新' : '固定版本'}策略安装 vibe-trading-ai ${installed}` +
              `${verified ? '（已验证）。' : `（未验证，插件已验证 ${DEFAULT_VERIFIED_VERSIONS.join(', ')}）。`}` +
              `${handed ? '结果已交给当前会话的 agent。' : ''}`,
          }
        : {
            kind: 'error',
            text: `初始化失败（${result.status}）。${handed ? '诊断已交给当前会话的 agent。' : '请查看 init-report.json。'}`,
          }
    }

    const preflight = await runPreflight({ env, minimumVersion: minimumVersion(), pinnedVersion: PINNED_VERSION })
    log(`preflight: ${preflight.status}`)
    if (preflight.status === 'needs-help') {
      const handed = await handoffToAgent(inv, initReportText({ ok: false, status: 'needs-help', report: { preflight } }))
      return {
        kind: 'error',
        text: `预检未通过：${summarizePreflight(preflight)}\n${handed ? '诊断已交给当前会话的 agent。' : '请检查上面的诊断后重试。'}`,
      }
    }

    const { started } = await startInstall(inv, mode)
    if (!started) return { kind: 'success', text: '初始化已在进行中，结果出来后我会交给当前会话的 agent。' }
    return {
      kind: 'success',
      text:
        `初始化已开始（后台）：创建 venv 并按${mode === 'latest' ? '跟随最新' : '固定版本'}策略安装 vibe-trading-ai` +
        `${mode === 'pinned' ? ` ${PINNED_VERSION}` : ''}。完成后结果会交给当前会话的 agent；首次安装通常需要 1–2 分钟。`,
    }
  }

  async function activateAgent(agent: any, options: { auto?: boolean } = {}) {
    const agentId = String(agent?.id ?? 'session')
    if (sessions.has(agentId)) {
      return { alreadyActive: true, result: null, tools: [], skills: [], toolsets: null, gatedOff: [] }
    }
    if (initPromise) throw new Error('初始化仍在进行，请稍后用 /vibe-trading status 确认。')

    const { config: rawConfig, error } = await readConfig(env)
    if (!rawConfig) throw new Error(`尚未初始化（${error ?? '缺少 config.json'}）。请先运行 /vibe-trading init。`)
    const verification = await verifyEnvironment(env, minimumVersion())
    if (!verification.ok) throw new Error(`环境不可用：${verification.reason}。请运行 /vibe-trading init。`)
    lastProbe = verification
    if (!verification.verified) {
      pluginLogNow(
        `activate: unverified ${PACKAGE_NAME} ${verification.version}（已验证 ${(verification.verifiedVersions ?? []).join(', ')}）`,
        env,
      )
    }
    const config = liveConfig(effectiveConfig(rawConfig, env), settings)

    await ensureWorker(config)
    const client: WorkerClient = getWorker(config) as WorkerClient
    const [toolsets, assets, toolsResult, skillsResult] = await Promise.all([
      readToolsets(),
      readPromptAssets(),
      client.request('tools/list'),
      client.request('skills/list'),
    ])
    const tools: any[] = (toolsResult as any)?.tools ?? []
    const skills: any[] = (skillsResult as any)?.skills ?? []
    // Credential-gated tools are advertised only while the worker can run them:
    // VT's own registry drops such tools outright, so a catalog entry whose only
    // answer is "not configured" would promise a capability this machine lacks.
    // An older worker without `capabilities` keeps the previous behaviour.
    const capabilities = await (client.request('capabilities') as any).catch(() => null)
    const gatedOff = credentialGatedOff(toolsets, capabilities)
    const effectiveToolsets = filterToolsets(toolsets, gatedOff)
    if (gatedOff.length) {
      const requires = toolsets?.credentialGated ?? {}
      pluginLogNow(
        `activate: credential-gated tools hidden (${gatedOff
          .map((name) => `${name} requires ${requires[name]}`)
          .join('; ')})`,
        env,
      )
    }
    const surface = surfaceReport(tools, effectiveToolsets)
    lastSurface = surface
    if (!surface.ok) {
      pluginLogNow(
        `activate: surface drift, worker lacks ${surface.missing.length} advertised tool(s): ${surface.missing.slice(0, 5).join(', ')}`,
        env,
      )
    }
    const promptText = buildPromptText({
      base: assets.base,
      bridge: assets.bridge,
      tools,
      skills,
      toolsets: effectiveToolsets,
      skillsMode: config.skills?.mode ?? 'short',
    })

    const grounding = createGrounding({ worker: client, agentId, cfg: config, settings, env })
    await grounding.ensure()
    const figuresTool = createFiguresTool(grounding)

    const result = await activate({
      agent,
      cfg: config,
      worker: client,
      toolsets: effectiveToolsets,
      promptText,
      extraTools: [figuresTool],
      sessions,
      env,
      grounding,
    })

    const state = sessions.get(agentId)
    if (state) wireAnswerGate(agent, grounding, state, log)
    if (options.auto) pluginLogNow(`auto-activate: restored ${agentId}`, env)
    return {
      alreadyActive: false,
      result,
      tools,
      skills,
      toolsets: effectiveToolsets,
      gatedOff,
      surface,
      package: {
        mode: settings.packageMode(),
        pinnedVersion: config.package?.pinnedVersion ?? PINNED_VERSION,
        installedVersion: verification.version,
        verified: verification.verified,
        floorAbovePin: isFloorAbovePin(minimumVersion(), verification.pinnedVersion),
      },
    }
  }

  /** Whether this session's log ends with an explicit `on` intent. */
  function sessionAutoIntent(agent: any) {
    try {
      const depth = Number(agent?.session?.header?.delegationDepth ?? 0)
      if (Number.isFinite(depth) && depth > 0) return false
      return activationIntent(agent?.session)
    } catch {
      return false
    }
  }

  function maybeAutoActivate(agent: any) {
    const agentId = String(agent?.id ?? '')
    if (!agentId || sessions.has(agentId)) return undefined
    const pending = pendingAuto.get(agentId)
    if (pending) return pending
    if (autoTried.has(agentId)) return undefined
    let intent = autoIntent.get(agentId)
    if (intent === undefined) {
      intent = sessionAutoIntent(agent)
      autoIntent.set(agentId, intent)
    }
    if (!intent) return undefined
    autoTried.add(agentId)
    pluginLogNow(`auto-restore: start ${agentId}`, env)
    const promise = activateAgent(agent, { auto: true })
      .then(() => pluginLogNow(`auto-restore: done ${agentId}`, env))
      .catch((error: any) => {
        pluginLogNow(`auto-activate failed for ${agentId}: ${error?.message ?? error}`, env)
        log(`auto-activate failed for ${agentId}: ${error?.message ?? error}`)
      })
      .finally(() => pendingAuto.delete(agentId))
    pendingAuto.set(agentId, promise)
    return promise
  }

  async function onCommand(inv: CommandInvocation) {
    const agentId = String(inv.agent?.id ?? 'session')
    if (sessions.has(agentId)) {
      const state = sessionStatus({ agentId, sessions })
      return { kind: 'success', text: `当前会话已激活（${state.toolCount} 个工具）。` }
    }
    try {
      const activated = await activateAgent(inv.agent)
      if (!activated.result) return { kind: 'success', text: '当前会话已激活 Vibe Trading。' }
      const { result, tools, skills, toolsets, gatedOff } = activated
      const lines = [
        result.failedCount > 0
          ? `Vibe Trading 部分激活：${result.toolCount} 个工具注册成功，${result.failedCount} 个失败`
          : `Vibe Trading 已激活：${result.toolCount} 个工具（${result.coreTools.length + (result.localToolCount ?? 0)} 常驻 + 4 网关）`,
        `工具目录 ${advertisedToolNames(toolsets).size + (result.localToolCount ?? 0)} 个` +
          `（${Object.keys(toolsets.groups ?? {}).length} 个工具组；worker 共 ${tools.length} 个）、技能 ${skills.length} 个`,
        gatedOff?.length
          ? `凭据未配、未暴露：${gatedOff
              .map((name) => `${name}（${toolsets.credentialGated?.[name] ?? '需要凭据'}）`)
              .join('、')}`
          : '',
        activated.package && !activated.package.verified
          ? `注意：vibe-trading-ai ${activated.package.installedVersion} 不在已验证范围（插件已验证 ${activated.package.pinnedVersion}）；` +
            (activated.package.floorAbovePin
              ? `minimumVersion 高于 pin，请用 /vibe-trading init --latest 或把 minimumVersion 调到 ≤ ${activated.package.pinnedVersion}。`
              : '工具面可能不同，可运行 /vibe-trading init --pinned 回退到固定版本。')
          : '',
        activated.surface && !activated.surface.ok
          ? `工具面漂移：worker 缺少 ${activated.surface.missing.length} 个目录工具` +
            `（${activated.surface.missing.slice(0, 5).join(', ')}${activated.surface.missing.length > 5 ? '…' : ''}）`
          : '',
        result.missingCore?.length ? `注意：worker 缺少常驻工具 ${result.missingCore.join(', ')}` : '',
        result.failedCount > 0 ? `注册失败：${result.failures.slice(0, 3).join('; ')}` : '',
        '用 vt_load_tools 加载工具组，用 vt_call 调用；/vibe-trading off 关闭。',
      ].filter(Boolean)
      return { kind: 'success', text: lines.join('\n') }
    } catch (error: any) {
      return { kind: 'error', text: `vibe-trading on 失败：${error?.message ?? error}` }
    }
  }

  async function offCommand(inv: CommandInvocation) {
    const agentId = String(inv.agent?.id ?? 'session')
    if (sessionHasStarted(inv.agent, optionalAgents(ctx))) {
      pluginLogNow(`command off refused: session already started (${agentId})`, env)
      return {
        kind: 'error',
        text:
          '本会话已经开始对话，不能关闭 Vibe Trading：历史里的工具调用会变成 unknown tool，' +
          '而且会作废当前的提示词缓存。需要不带 Vibe Trading 继续，请新建一个会话；' +
          '已有会话里的工具可以一直用到会话结束。',
      }
    }
    const result = await deactivate({ agentId, sessions })
    if (!result.wasActive) return { kind: 'success', text: '当前会话未激活 Vibe Trading。' }
    return { kind: 'success', text: `已取消激活（撤销 ${result.disposed} 项注册）。` }
  }

  /** Restore every already-live agent whose log says `on` (plugin reload). */
  async function restoreLiveAgents() {
    try {
      const agents = (ctx as any).get?.('agents')?.list?.() ?? []
      for (const agent of agents) {
        try {
          await maybeAutoActivate(agent)
        } catch (error: any) {
          pluginLogNow(`auto-activate scan failed for ${String(agent?.id ?? '?')}: ${error?.message ?? error}`, env)
        }
      }
      if (agents.length > 0) pluginLogNow(`auto-restore: scanned ${agents.length} live agent(s)`, env)
    } catch (error: any) {
      pluginLogNow(`auto-restore scan unavailable: ${error?.message ?? error}`, env)
    }
  }

  void workDir
  await restoreLiveAgents()
}
