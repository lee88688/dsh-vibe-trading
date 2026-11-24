/**
 * Gateway tools: the cache-stable way to reach the long tail of Vibe-Trading
 * tools without changing the session's tool definitions.
 *
 * `vt_load_tools` returns signatures (append-only text), `vt_call` executes a
 * loaded tool, and the two skill helpers page long skill documents.
 */

import { randomUUID } from 'node:crypto'
import { formatToolResult, timeoutForTool } from './worker.js'
import { TEXT_OUTPUT } from './tool-output.js'
import { advertisedToolNames } from './surface.js'

const RESULT_LIMIT = 10_000

export function isComplexTool(tool: any) {
  const schema = tool?.inputSchema ?? {}
  const count = Object.keys(schema.properties ?? {}).length
  const size = JSON.stringify(schema).length
  return count > 8 || size > 1500
}

function typeOf(value: any) {
  if (value?.type) return value.type
  if (Array.isArray(value?.anyOf)) {
    return value.anyOf.map((entry: any) => entry?.type).filter(Boolean).join('|') || 'any'
  }
  return 'any'
}

/** "name(req: string, opt?: int = 10) -> JSON" */
export function compactSignature(tool: any) {
  const schema = tool?.inputSchema ?? {}
  const properties = schema.properties ?? {}
  const required = new Set<any>(schema.required ?? [])
  const parts = Object.entries(properties as Record<string, any>).map(([key, value]: [string, any]) => {
    const optional = required.has(key) ? '' : '?'
    const enumHint = Array.isArray(value?.enum)
      ? ` = ${value.enum.map((item: any) => JSON.stringify(item)).join('|')}`
      : ''
    const defaultHint = value?.default !== undefined ? ` = ${JSON.stringify(value.default)}` : ''
    return `${key}${optional}: ${typeOf(value)}${enumHint || defaultHint}`
  })
  return `${tool.name}(${parts.join(', ')}) -> JSON`
}

/** One-line description for compact loads; full loads keep the whole text. */
function shortDescription(tool: any, limit = 160) {
  const text = String(tool?.description ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Tool name + one-line description (or full description) before its schema. */
function describeTool(tool: any, detail: string) {
  const description = detail === 'full' ? String(tool?.description ?? '').trim() : shortDescription(tool)
  return description ? `${tool.name} — ${description}` : String(tool.name)
}

/**
 * Render one loaded tool. `full` (the default) returns the complete JSON
 * Schema, including every enum value and nested object/array constraint, plus
 * the full description. `compact` keeps the legacy signature line and a short
 * description for token-sensitive calls.
 */
export function renderLoadedTool(tool: any, detail: string) {
  if (detail === 'compact') {
    const signature = compactSignature(tool)
    const note = shortDescription(tool)
    return note ? `${signature} — ${note}` : signature
  }
  return `${describeTool(tool, detail)}\ninputSchema: ${JSON.stringify(tool?.inputSchema ?? {})}`
}

/**
 * @param {object} context
 * @param {object} context.worker WorkerClient (or fake with request())
 * @param {object} context.toolsets parsed toolsets.json
 * @param {string} context.agentId
 * @param {{loaded: Set<string>}} context.session per-session state
 * @param {object} context.cfg config.json
 */
export function createGatewayTools(context: any) {
  const { worker, toolsets, agentId, session, cfg, grounding } = context
  const env = context.env ?? process.env

  async function listTools() {
    const listed = await worker.request('tools/list')
    return { all: listed?.tools ?? [], raw: listed }
  }

  const toolsetNames = Object.keys(toolsets?.groups ?? {})
  const toolsetHint = toolsetNames.length ? toolsetNames.join('/') : 'none'

  return [
    {
      name: 'vt_load_tools',
      output: TEXT_OUTPUT,
      description:
        `Load Vibe-Trading tool definitions. Pass a toolset (${toolsetHint}) ` +
        'or exact tool names. By default this returns each tool\'s full description and complete JSON Schema ' +
        '(all enum values and nested constraints); pass detail="compact" for compact signatures only. ' +
        'Loading only makes the tool callable through vt_call — it does not change this session\'s tool list.',
      parameters: {
        type: 'object',
        properties: {
          toolset: { type: 'string', description: 'Group name from the tool catalog.' },
          names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names.' },
          detail: {
            type: 'string',
            enum: ['compact', 'full'],
            default: 'full',
            description: 'full = description + complete input schema (default); compact = signature + short description.',
          },
        },
        additionalProperties: false,
      },
      async execute(args: any = {}) {
        const { all } = await listTools()
        const byName = new Map((all as any[]).map((tool: any) => [tool.name, tool]))
        const allowed = advertisedToolNames(toolsets)
        let names: any[] = []
        if (Array.isArray(args.names) && args.names.length) {
          names = args.names
        } else if (args.toolset) {
          names = toolsets?.groups?.[args.toolset] ?? []
          if (!names.length) {
            return `未知工具组 ${args.toolset}；可用：${Object.keys(toolsets?.groups ?? {}).join(', ')}`
          }
        } else {
          return `请提供 toolset 或 names；可用工具组：${Object.keys(toolsets?.groups ?? {}).join(', ')}`
        }

        const blocked = names.filter((name) => !allowed.has(name))
        if (blocked.length) return `工具未在本部署开放：${blocked.join(', ')}`
        const unknown = names.filter((name) => !byName.has(name))
        if (unknown.length) {
          const known = names.filter((name) => byName.has(name))
          return `worker 未提供这些工具：${unknown.join(', ')}${known.length ? `（可用：${known.join(', ')}）` : ''}`
        }

        for (const name of names) session?.loaded?.add(name)
        const detail = args.detail === 'compact' ? 'compact' : 'full'
        const lines = names.map((name) => renderLoadedTool(byName.get(name), detail))
        return `${lines.join('\n')}\n\n以上工具现在可通过 vt_call 调用（参数格式见签名）。`
      },
    },
    {
      name: 'vt_call',
      output: TEXT_OUTPUT,
      description:
        'Call a Vibe-Trading tool by name with arguments. The tool must be one of the always-on tools or loaded via vt_load_tools first.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Tool name, e.g. get_financial_statements.' },
          arguments: { type: 'object', additionalProperties: true, description: 'Tool arguments.' },
        },
        required: ['name', 'arguments'],
        additionalProperties: false,
      },
      async execute(args: any = {}, exec?: any) {
        const name = String(args.name ?? '')
        const alwaysOn = new Set(toolsets?.staticCore ?? [])
        if (!alwaysOn.has(name) && !session?.loaded?.has(name)) {
          return `工具 ${name || '(空)'} 尚未加载；先调用 vt_load_tools（toolset 或 names）`
        }
        const callArgs = args.arguments ?? {}
        const callId = `call-${randomUUID().slice(0, 8)}`
        const gate = grounding ? await grounding.beforeCall(name, callArgs, { callId }) : { allowed: true }
        if (!gate.allowed) return gate.message
        try {
          const result = await worker.request(
            'tools/call',
            { name, arguments: callArgs, session_id: agentId },
            { timeoutMs: timeoutForTool(name, cfg), signal: exec?.signal },
          )
          const full =
            result?.full_text ??
            (result?.json !== undefined && result?.json !== null ? JSON.stringify(result.json) : result?.text)
          if (grounding) await grounding.afterResult(name, callArgs, full, result?.isError !== true, { callId })
          const text = await formatToolResult(result?.text ?? result?.json ?? result, {
            env,
            limitChars: cfg?.skills?.loadLimitChars ?? RESULT_LIMIT,
            fullPath: result?.full_path,
          })
          return grounding?.enabled ? `${text}\n\n[tool_call_id: ${callId}]` : text
        } catch (error: any) {
          const data = error?.data ? `\n${JSON.stringify(error.data, null, 2)}` : ''
          return `调用 ${name} 失败：${error?.message ?? error}${data}`
        }
      },
    },
    {
      name: 'vt_list_skills',
      output: TEXT_OUTPUT,
      description:
        'List Vibe-Trading skills with their full descriptions; optional category or keyword filter. Use vt_load_skill to read one.',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          query: { type: 'string' },
        },
        additionalProperties: false,
      },
      async execute(args: any = {}) {
        const listed = await worker.request('skills/list')
        const skills = listed?.skills ?? []
        const query = String(args.query ?? '').toLowerCase()
        const filtered = skills.filter((skill: any) => {
          if (args.category && (skill.category || 'other') !== args.category) return false
          if (query && !`${skill.name} ${skill.description}`.toLowerCase().includes(query)) return false
          return true
        })
        if (!filtered.length) return `没有匹配的技能（共 ${skills.length} 个）`
        return filtered
          .map((skill: any) => `- ${skill.name} [${skill.category || 'other'}]: ${skill.description}`)
          .join('\n')
      },
    },
    {
      name: 'vt_load_skill',
      output: TEXT_OUTPUT,
      description:
        'Load a Vibe-Trading skill body. Long documents return an outline; use section or offset to page through it.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          section: { type: 'string', description: 'Section title from the outline.' },
          offset: { type: 'number', description: 'Character offset from next_offset.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
      async execute(args: any = {}) {
        const params: any = { name: String(args.name ?? '') }
        if (args.section !== undefined) params.section = args.section
        if (args.offset !== undefined) params.offset = args.offset
        try {
          const result = await worker.request('skills/load', params)
          return formatToolResult(result?.text ?? result, {
            env,
            limitChars: cfg?.skills?.loadLimitChars ?? RESULT_LIMIT,
          })
        } catch (error: any) {
          return `读取技能失败：${error?.message ?? error}`
        }
      },
    },
  ]
}
