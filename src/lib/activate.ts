/**
 * Per-session activation: register the static core tools, the gateway tools and
 * the static prompt section on `agent.ctx`, and dispose everything on `off`.
 *
 * Registering through `agent.ctx` scopes every tool and the prompt section to
 * this one session, so other sessions never see Vibe-Trading.
 */

import { randomUUID } from 'node:crypto'
import { createGatewayTools } from './gateway.js'
import { timeoutForTool } from './worker.js'
import type { SessionState, ToolDefinition, ToolSummary } from '../types.js'
import { TEXT_OUTPUT } from './tool-output.js'
import { pluginLogNow } from './log.js'

/** Map-like registry of per-session activation state. */
export function createSessionRegistry() {
  const map = new Map()
  return {
    get: (agentId: string) => map.get(String(agentId)),
    set: (agentId: string, value: any) => map.set(String(agentId), value),
    has: (agentId: string) => map.has(String(agentId)),
    delete: (agentId: string) => map.delete(String(agentId)),
    get size() {
      return map.size
    },
    ids: () => [...map.keys()],
  }
}

function toDisposer(value: any) {
  if (typeof value === 'function') return value
  if (value && typeof value.dispose === 'function') return () => value.dispose()
  return () => {}
}

/**
 * Host tools whose results may carry financial figures the gate should verify.
 *
 * VT tools already ingest inside their own execute wrapper; DSH-native tools run
 * in the host, so they are observed through the `tools/post-execute` waterfall.
 * Deliberately excluded: shells (`pwsh`/`bash`) — a shell-computed number is not
 * evidence (see the prompt's calculation rule).
 */
const EXTERNAL_INGEST_TOOLS = new Set(['read', 'web_fetch', 'web_search'])

/** Ingest host-native tool results into this session's grounding ledger. */
function wireExternalIngest(agent: any, grounding: any, state: any) {
  // Registered even while the gate is disabled; `afterResult` re-checks the live
  // setting, so enabling the gate later does not need a new activation.
  if (!grounding) return
  const handler = async (exec: any, result: any, next: () => any) => {
    try {
      const name = String(exec?.name ?? '')
      if (name && EXTERNAL_INGEST_TOOLS.has(name) && result?.isError !== true) {
        const value = result?.value
        const raw = typeof value === 'string' ? value : JSON.stringify(value ?? '')
        if (raw) await grounding.afterResult(name, exec?.arguments ?? {}, raw, true)
      }
    } catch {
      /* evidence ingest must never break the tool call */
    }
    return next()
  }
  try {
    const disposer = agent.ctx.on('tools/post-execute', handler)
    state.disposers.push(toDisposer(disposer))
  } catch (error: any) {
    state.notice = `${state.notice ? `${state.notice}; ` : ''}结果入账钩子注册失败：${error?.message ?? error}`
  }
}

function defineToolFromWorker(tool: ToolSummary, { worker, agentId, cfg, env, grounding }: any) {  return {
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema,
    // DSH validates registered tools: an output declaration is mandatory.
    output: TEXT_OUTPUT,
    timeoutMs: timeoutForTool(tool.name, cfg),
    // DSH calls this as a predicate over the call's parsed arguments (a bare
    // boolean is invoked and throws, which silently forces every call exclusive).
    isConcurrencySafe: () => Boolean(tool.readonly),
    async execute(args: any, exec?: any) {
      const callArgs = args ?? {}
      const callId = `call-${randomUUID().slice(0, 8)}`
      const gate = grounding ? await grounding.beforeCall(tool.name, callArgs, { callId }) : { allowed: true }
      if (!gate.allowed) return gate.message
      const result = await worker.request(
        'tools/call',
        { name: tool.name, arguments: callArgs, session_id: agentId },
        { timeoutMs: timeoutForTool(tool.name, cfg), signal: exec?.signal },
      )
      const full =
        result?.full_text ??
        (result?.json !== undefined && result?.json !== null ? JSON.stringify(result.json) : result?.text)
      if (grounding) await grounding.afterResult(tool.name, callArgs, full, result?.isError !== true, { callId })
      const { formatToolResult } = await import('./worker.js')
      const text = await formatToolResult(result?.text ?? result?.json ?? result, { env, fullPath: (result as any)?.full_path })
      // Vibe-Trading's figures contract can address one exact tool call; DSH does
      // not surface tool-call ids to the model, so append the id we ingested with.
      return grounding?.enabled ? `${text}\n\n[tool_call_id: ${callId}]` : text
    },
  }
}

/**
 * Activate for one agent/session.
 * @returns {Promise<{alreadyActive: boolean, toolCount: number, groupCount: number, coreTools: string[]}>}
 */
export async function activate(options: any) {
  const { agent, cfg, worker, toolsets, promptText, sessions, env = process.env, grounding } = options
  const agentId = String(agent?.id ?? 'session')

  if (sessions?.has(agentId)) {
    const existing = sessions.get(agentId)
    return {
      alreadyActive: true,
      toolCount: existing.toolCount,
      failedCount: (existing.failures ?? []).length,
      failures: existing.failures ?? [],
      groupCount: existing.groupCount,
      coreTools: existing.coreTools,
      localToolCount: (options.extraTools ?? []).length,
    }
  }

  const tools = options.tools ?? (await worker.request('tools/list'))?.tools ?? []
  const byName = new Map((tools as ToolSummary[]).map((tool: ToolSummary) => [tool.name, tool]))
  const coreNames = (toolsets?.staticCore ?? []).filter((name: string) => byName.has(name))
  const missingCore = (toolsets?.staticCore ?? []).filter((name: string) => !byName.has(name))

  const state: any = {
    agentId,
    failures: [] as string[],
    disposers: [],
    loaded: new Set(),
    toolCount: 0,
    groupCount: Object.keys(toolsets?.groups ?? {}).length,
    coreTools: coreNames,
    missingCore,
    notice: null as string | null,
  }

  const register = (definition: ToolDefinition, label: string) => {
    try {
      const disposer = agent.ctx.tools.register(definition)
      state.disposers.push(toDisposer(disposer))
      state.toolCount += 1
    } catch (error: any) {
      const message = `注册工具 ${label} 失败：${error?.message ?? error}`
      state.failures.push(message)
      state.notice = message
      pluginLogNow?.(message, env)
    }
  }

  for (const definition of options.extraTools ?? []) register(definition, definition.name)

  for (const name of coreNames) {
    register(defineToolFromWorker(byName.get(name)!, { worker, agentId, cfg, env, grounding }), name)
  }

  const gatewayTools = createGatewayTools({ worker, toolsets, agentId, session: state, cfg, env, grounding })
  for (const definition of gatewayTools) register(definition, definition.name)

  wireExternalIngest(agent, grounding, state)

  if (promptText) {
    try {
      const disposer = agent.ctx.systemPrompt.section({
        name: 'vibe-trading',
        order: 1000,
        interpolate: false,
        text: () => promptText,
      })
      state.disposers.push(toDisposer(disposer))
    } catch (error: any) {
      state.notice = `${state.notice ? `${state.notice}; ` : ''}注册提示词段落失败：${error?.message ?? error}`
    }
  }

  sessions?.set(agentId, state)
  return {
    alreadyActive: false,
    toolCount: state.toolCount,
    failedCount: state.failures.length,
    failures: state.failures,
    groupCount: state.groupCount,
    coreTools: coreNames,
    localToolCount: (options.extraTools ?? []).length,
    missingCore,
    notice: state.notice,
  }
}

/** Dispose every registration for one session. */
export async function deactivate(options: any) {
  const { agentId, sessions } = options
  const key = String(agentId)
  const state = sessions?.get(key)
  if (!state) return { wasActive: false, disposed: 0 }
  let disposed = 0
  for (const disposer of [...state.disposers].reverse()) {
    try {
      disposer()
      disposed += 1
    } catch {
      /* keep disposing the rest */
    }
  }
  sessions.delete(key)
  return { wasActive: true, disposed }
}

/** Describe the session's activation state for `/vibe-trading status`. */
export function sessionStatus(options: any) {
  const { agentId, sessions } = options
  const state = sessions?.get(String(agentId))
  if (!state) return { active: false, loadedTools: [], coreTools: [], toolCount: 0 }
  return {
    active: true,
    coreTools: state.coreTools,
    loadedTools: [...(state.loaded ?? [])],
    toolCount: state.toolCount,
    groupCount: state.groupCount,
    notice: state.notice,
  }
}
