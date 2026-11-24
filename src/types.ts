/**
 * Shared types for the plugin.
 *
 * DSH's own plugin API types are not shipped to bundles, so the boundary with
 * the Host is described here explicitly. Everything inside the plugin uses
 * these instead of `any` where a shape is stable.
 */

/** A tool as registered through `agent.ctx.tools.register`. */
export interface ToolDefinition {
  name: string
  description: string
  /** Model-facing JSON Schema; DSH rejects a definition without it at projection time. */
  parameters?: any
  /** Worker-side schema (kept for reference; DSH does not read it). */
  inputSchema?: any
  timeoutMs?: number
  /** Predicate over the call's parsed arguments; DSH calls it, it is not a flag. */
  isConcurrencySafe?: (args?: any) => boolean
  execute: (args?: any, exec?: any) => Promise<any>
}

/** A tool entry returned by the worker's `tools/list`. */
export interface ToolSummary {
  name: string
  description?: string
  inputSchema?: any
  readonly?: boolean
  repeatable?: boolean
  virtual?: boolean
}

/** A skill entry returned by the worker's `skills/list`. */
export interface SkillSummary {
  name: string
  description?: string
  category?: string
}

/** `toolsets.json` structure. */
export interface Toolsets {
  staticCore: string[]
  groups: Record<string, string[]>
  virtualTools?: string[]
  replacedByDsh?: Record<string, string>
  replacedByGateway?: string[]
  excluded?: string[]
  dropped?: Record<string, { tools?: string[] }>
  registryOnly?: string[]
}

/** Plugin row config (`plugin_manager` config / `cordis.patch.yml`). */
export interface PluginConfig {
  minimumVersion?: string
  /** Default install policy for `/vibe-trading init` (`pinned` unless set to latest). */
  packageMode?: 'pinned' | 'latest'
  [key: string]: any
}

/** The agent a command runs for, as far as this plugin needs it. */
export interface AgentLike {
  id?: string
  ctx: {
    tools: { register(definition: ToolDefinition): any }
    systemPrompt: { section(spec: any): any }
    on?: (event: string, listener: (...args: any[]) => any) => any
  }
  followup?: (message: any) => unknown
  steer?: (message: any) => unknown
  inject?: (message: any) => unknown
}

/** Invocation handed to a `/vibe-trading` command handler. */
export interface CommandInvocation {
  rawInput?: string
  agent: AgentLike
}

/** The plugin context passed to `apply()`, limited to what we use. */
export interface PluginContext {
  logger?: { info?: (line: string) => void; warn?: (line: string) => void }
  effect?: (factory: () => any) => any
  tools: { register(definition: ToolDefinition): any }
  commands: { register(command: any): any }
}

/** Per-session activation state. */
export interface SessionState {
  agentId: string
  disposers: Array<() => void>
  loaded: Set<string>
  toolCount: number
  groupCount: number
  coreTools: string[]
  missingCore: string[]
  notice: string | null
}
