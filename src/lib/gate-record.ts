/**
 * Experimental bridge: persist the answer gate's footer data as an ignorable
 * plugin record instead of the disclosure message.
 *
 * DSH documents `appendPluginRecord` as experimental and reserves it for
 * `packages/experimental/`, but the record is exactly the channel this plugin
 * needs: it is retained in the session log, skipped by every reader that does
 * not know the type, carried through fork/resume, and never enters the
 * model-visible surface. The alternative — encoding the details in the
 * user-visible disclosure message — duplicates the footer data and spends model
 * context on it.
 *
 * The function is only exported from the host's own `@deepseek-ai/dsh-session`
 * module instance: its `appendPluginRecord` reaches a module-private
 * `#appendRecord` method, so a separately resolved copy of the package would
 * fail the private-field brand check. We therefore resolve the entry module
 * through the running process (`process.argv[1]`) and import the resolved file,
 * which shares Node's ESM module cache with the host. Every failure degrades to
 * the disclosure-message channel; the gate never depends on this bridge.
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** Namespaced record type; the grammar is `plugin:` + lowercase segments. */
export const GATE_RECORD_TYPE = 'plugin:dsh-vibe-trading/gate'

export interface GateDetail {
  value: string
  context: string
  reason: string
}

export interface GatePanel {
  v: 1
  unverified: number
  details?: GateDetail[]
  passed?: number
  passedValues?: string[]
  suppressed?: number
  suppressedRules?: { rule: string; count: number }[]
}

function clean(value: unknown, limit: number): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit)
}

/**
 * Read one committed event as a gate record. Pure and total: unknown shapes
 * answer null so a foreign event can never corrupt projection state.
 */
export function gateRecordOf(event: any): GatePanel | null {
  if (!event || event.ignorable !== true || event.type !== GATE_RECORD_TYPE) return null
  const data = event.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const unverified = Number(data.unverified)
  if (!Number.isFinite(unverified) || unverified < 0) return null
  const panel: GatePanel = { v: 1, unverified: Math.floor(unverified) }
  if (Array.isArray(data.details)) {
    const details = data.details
      .filter((entry: any) => entry && typeof entry === 'object')
      .slice(0, 5)
      .map((entry: any) => ({
        value: clean(entry.value, 40) || '?',
        context: clean(entry.context, 80),
        reason: clean(entry.reason, 40) || 'unverified',
      }))
    if (details.length > 0) panel.details = details
  }
  const passed = Number(data.passed)
  if (Number.isFinite(passed) && passed >= 0) {
    panel.passed = Math.floor(passed)
    if (Array.isArray(data.passedValues)) {
      const values = data.passedValues
        .map((value: unknown) => clean(value, 24))
        .filter(Boolean)
        .slice(0, 8)
      if (values.length > 0) panel.passedValues = values
    }
  }
  const suppressed = Number(data.suppressed)
  if (Number.isFinite(suppressed) && suppressed >= 0) {
    panel.suppressed = Math.floor(suppressed)
    if (Array.isArray(data.suppressedRules)) {
      const rules = data.suppressedRules
        .filter((entry: any) => entry && typeof entry === 'object')
        .slice(0, 4)
        .map((entry: any) => ({
          rule: clean(entry.rule, 20) || 'extra',
          count: Math.max(0, Math.floor(Number(entry.count) || 0)),
        }))
        .filter((entry: { rule: string; count: number }) => entry.rule.length > 0)
      if (rules.length > 0) panel.suppressedRules = rules
    }
  }
  return panel
}

type AppendPluginRecord = (session: any, type: string, data: unknown) => number

let loader: Promise<AppendPluginRecord | null> | null = null

function loadAppendPluginRecord(log?: (line: string) => void): Promise<AppendPluginRecord | null> {
  if (loader === null) {
    loader = (async () => {
      try {
        const anchor = process.argv[1]
        if (!anchor) return null
        const hostRequire = createRequire(anchor)
        const resolved = hostRequire.resolve('@deepseek-ai/dsh-session')
        const hostModule: any = await import(pathToFileURL(resolved).href)
        const append = hostModule?.appendPluginRecord
        return typeof append === 'function' ? append : null
      } catch (error: any) {
        log?.(`gate record bridge unavailable: ${error?.message ?? error}`)
        return null
      }
    })()
  }
  return loader
}

/**
 * Append the panel record to the live session. Returns false when the host
 * bridge is unavailable, in which case the caller must keep the detailed
 * disclosure text as the data source.
 */
export async function appendGateRecord(
  session: any,
  panel: GatePanel,
  log?: (line: string) => void,
): Promise<boolean> {
  if (!session) return false
  const append = await loadAppendPluginRecord(log)
  if (!append) return false
  try {
    append(session, GATE_RECORD_TYPE, panel)
    return true
  } catch (error: any) {
    log?.(`gate record append failed: ${error?.message ?? error}`)
    return false
  }
}
