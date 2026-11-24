/**
 * Client-visible state for the Web GUI: the composer chip and the per-turn gate
 * footer.
 *
 * Values are derived from the durable session log, not from plugin memory:
 * - activation comes from `/vibe-trading on|off` command events;
 * - the gate footer prefers the answer gate's ignorable plugin record
 *   (`plugin:dsh-vibe-trading/gate`), which carries the figure details without
 *   entering the model-visible surface;
 * - older sessions and hosts without the experimental plugin-record bridge fall
 *   back to parsing the disclosure `user/message` the gate steers.
 *
 * Deriving from the log keeps both views correct across Session switching and
 * page reloads. It also means the footer never rewrites the assistant message:
 * the text stays exactly as recorded, so prefix caching is untouched.
 *
 * The projection service only calls `parse()` on `stateSchema`/`viewSchema`, so
 * the plugin passes a dependency-free identity schema instead of pulling `zod`
 * into a package that ships no runtime dependencies.
 */
import { gateRecordOf } from './gate-record.js'
export const VIBE_PROJECTION_KEY = 'vibeTrading'

/** One failed/undeclared figure as the footer panel shows it. */
export interface VibeGateDetail {
  value: string
  context: string
  reason: string
}

/** Gate outcome for one turn. */
export interface VibeGateState {
  unverified: number
  details?: VibeGateDetail[]
  passed?: number
  passedValues?: string[]
  suppressed?: number
  suppressedRules?: { rule: string; count: number }[]
}

/** Highest command intent seen in the log for this plugin, or null before any. */
export interface VibeTradingState {
  requested: 'on' | 'off' | null
  /** Turn whose events are currently being folded. */
  currentTurn: number | null
  /** Per-turn gate outcome keyed by turn number (string); culled to recent turns. */
  gate: Record<string, VibeGateState>
}

const identitySchema = { parse: (value: any) => value }

const COMMAND_NAME = 'vibe-trading'
const MAX_TRACKED_TURNS = 20

/** First word of the recorded command input (`args` on `command/run`). */
function firstWord(args: any): string {
  return String(args ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
}

/** Concatenated text blocks of a message payload, if any. */
function messageText(data: any): string {
  const content = data?.content ?? data?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block: any) => block.text)
    .join('\n')
    .trim()
}

/**
 * Whether a `user/message` event is the answer gate's own steer.
 *
 * Steered messages are recorded with `source.kind === 'user'`; compaction
 * checkpoints (`compact-checkpoint`) and other injected context also arrive as
 * user messages and may quote the disclosure text wholesale. Treating those as
 * gate outcomes would paint a panel into a turn that never ran the gate, so the
 * source is checked first and the body must start with the disclosure header
 * (a real steer is exactly that message, never a quotation of it).
 */
function isGateSteer(data: any): boolean {
  if (data?.source?.kind !== 'user') return false
  const text = messageText(data)
  return text.startsWith('本次回答有') || /^注意：上一版回答/.test(text)
}

/**
 * The answer gate's disclosure steer. Keeping these markers in one place means
 * the projection follows the text the model is actually shown.
 */
export function disclosureTurnCount(text: string): number | null {
  const parsed = disclosureTurnState(text)
  return parsed ? parsed.unverified : null
}

/**
 * Parse the disclosure message into the footer panel's data.
 *
 * Recognized shape (see verify.ts buildDisclosure):
 *   `本次回答有 2 处数字没有通过核实…`
 *   `- 未核实 0.62 ｜ 上下文：… ｜ 原因：no_evidence`
 *   `- 已核实 7 项：0.666、0.646`
 *   `- 自动豁免 3 项（versions 2、urls 1）`
 */
export function disclosureTurnState(text: string): VibeGateState | null {
  const body = String(text ?? '')
  const header = body.match(/本次回答有\s*(\d+)\s*处/)
  if (!header) {
    if (/上一版回答中的部分数字没有通过核实|部分数字未能核实/.test(body)) {
      return { unverified: 1 }
    }
    return null
  }
  const state: VibeGateState = { unverified: Number(header[1]) }
  const details: VibeGateDetail[] = []
  for (const line of body.split('\n')) {
    const detail = line.match(/^-\s*未核实\s+(.+?)\s*｜\s*上下文：(.+?)\s*｜\s*原因：(.+?)\s*$/)
    if (detail) {
      details.push({ value: detail[1].trim(), context: detail[2].trim(), reason: detail[3].trim() })
      continue
    }
    const passed = line.match(/^-\s*已核实\s+(\d+)\s*项(?:\s*：(.+))?$/)
    if (passed) {
      state.passed = Number(passed[1])
      if (passed[2]) {
        state.passedValues = passed[2]
          .split(/[、,，]/)
          .map((value) => value.trim())
          .filter(Boolean)
      }
      continue
    }
    const exempted = line.match(/^-\s*自动豁免\s+(\d+)\s*项(?:\s*（(.+)）)?$/)
    if (exempted) {
      state.suppressed = Number(exempted[1])
      if (exempted[2]) {
        state.suppressedRules = exempted[2]
          .split(/[、,，]/)
          .map((entry) => entry.trim())
          .filter(Boolean)
          .map((entry) => {
            const parts = entry.split(/\s+/)
            return { rule: parts[0], count: Number(parts[1] ?? 0) || 0 }
          })
      }
    }
  }
  if (details.length) state.details = details
  return state
}

/** Keep only the most recent turns so the projection stays bounded. */
function pruneGate(gate: Record<string, VibeGateState>): Record<string, VibeGateState> {
  const turns = Object.keys(gate)
    .map((key) => Number(key))
    .filter((turn) => Number.isFinite(turn))
    .sort((a, b) => a - b)
  if (turns.length <= MAX_TRACKED_TURNS) return gate
  const keep = new Set(turns.slice(-MAX_TRACKED_TURNS).map((turn) => String(turn)))
  const next: Record<string, VibeGateState> = {}
  for (const key of Object.keys(gate)) if (keep.has(key)) next[key] = gate[key]
  return next
}

/**
 * Merge one gate observation for a turn. Later observations refine the same
 * turn: the plugin record supplies details and summaries, while the disclosure
 * text supplies the count for older sessions. Neither may lower the count, and
 * the returned state keeps the projection contract's reference-equality signal.
 */
function mergeGate(state: VibeTradingState, key: string, patch: Partial<VibeGateState>): VibeTradingState {
  const existing = state.gate[key]
  const next: VibeGateState = { ...existing }
  next.unverified = Math.max(existing?.unverified ?? 0, Number(patch.unverified ?? 0) || 0)
  if (patch.details !== undefined) next.details = patch.details
  if (patch.passed !== undefined) next.passed = patch.passed
  if (patch.passedValues !== undefined) next.passedValues = patch.passedValues
  if (patch.suppressed !== undefined) next.suppressed = patch.suppressed
  if (patch.suppressedRules !== undefined) next.suppressedRules = patch.suppressedRules
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return state
  return { ...state, gate: pruneGate({ ...state.gate, [key]: next }) }
}

/**
 * Projection definition registered on the plugin context.
 *
 * `apply` returns the same state reference for events it ignores, which is the
 * projection contract's no-change signal.
 */
export function vibeProjectionDefinition() {
  return {
    key: VIBE_PROJECTION_KEY,
    // v3: the disclosure-text fallback is source-gated so checkpoint messages
    // cannot paint a gate panel; bumping the version drops stale checkpoints
    // that were folded by the looser v2 parser.
    // v4: a refused post-turn `off` no longer folds into `requested` (v3
    // checkpoints could carry "off" for a session whose tools stayed live).
    stateVersion: 4,
    stateSchema: identitySchema,
    init: (): VibeTradingState => ({ requested: null, currentTurn: null, gate: {} }),
    apply(state: VibeTradingState, event: any): VibeTradingState {
      if (!state || !event) return state
      if (event.type === 'command/run') {
        const data = event.data ?? {}
        if (data.name !== COMMAND_NAME) return state
        const word = firstWord(data.args)
        if (word === 'on') return { ...state, requested: 'on' }
        // Once a turn has started, `/vibe-trading off` is refused by the command
        // handler but its input is still logged; folding it would make the chip
        // (and auto-restore) claim the session is off while its tools are live.
        if (word === 'off' && state.currentTurn === null) return { ...state, requested: 'off' }
        return state
      }
      if (event.type === 'turn/start') {
        const turn = Number(event.data?.turn)
        if (!Number.isFinite(turn)) return state
        return { ...state, currentTurn: turn, gate: pruneGate(state.gate) }
      }
      if (event.type === 'user/message') {
        if (state.currentTurn === null) return state
        if (!isGateSteer(event.data)) return state
        const parsed = disclosureTurnState(messageText(event.data))
        if (!parsed) return state
        return mergeGate(state, String(state.currentTurn), parsed)
      }
      // The answer gate's ignorable plugin record is the primary source: it
      // never enters the model-visible surface, so the disclosure steer can stay
      // one line. Unknown/foreign records are ignored by gateRecordOf.
      const record = gateRecordOf(event)
      if (record && state.currentTurn !== null) {
        return mergeGate(state, String(state.currentTurn), record)
      }
      return state
    },
    wire: {
      viewSchema: identitySchema,
      view: (state: VibeTradingState) => ({
        requested: state?.requested ?? null,
        gate: state?.gate ?? {},
      }),
    },
  }
}

/**
 * Register the projection when the host exposes `sessionProjections`.
 *
 * Returns the settled handle (or null when the service is absent). Failures are
 * swallowed: both views are decorative, so a projection problem must never
 * break `/vibe-trading` or plugin activation.
 */
export async function registerVibeProjection(ctx: any): Promise<any | null> {
  try {
    const projections = ctx?.get?.('sessionProjections')
    if (!projections?.register) return null
    return await projections.register(vibeProjectionDefinition())
  } catch {
    return null
  }
}
