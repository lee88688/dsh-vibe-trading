/**
 * Number-verification gate (config switch, default off).
 *
 * Vibe-Trading's grounding package is imported by the Python worker; this module
 * is the DSH-side glue:
 *
 *   beforeCall  → identity gate (block market-data calls before a symbol is locked)
 *   afterResult → evidence ingest (the UNTRUNCATED tool result)
 *   checkAnswer → final-answer validation + correction prompt
 *
 * Every call is best-effort: a gate failure must never break the tool call or
 * the turn, so errors degrade to "allowed" / "valid" and are reported through
 * the returned `degraded` flag.
 */

import type { GatePanel } from './gate-record.js'
import { failureMode as normalizeFailureMode } from './settings.js'

export function createGrounding(options: any) {
  const { worker, agentId, cfg, env = process.env } = options
  /**
   * Read the gate configuration as it is *now*.
   *
   * The values arrive as volatile Loader refs (`settings`), so a saved form
   * value must apply to the next gate check instead of only after the session is
   * re-activated. The static `cfg.verification` fallback keeps unit tests and
   * hosts without a config schema working.
   */
  const readVerification = () => {
    if (typeof options.settings?.verification === 'function') return options.settings.verification()
    return cfg?.verification ?? {}
  }
  const gateEnabled = () => Boolean(readVerification().enabled)
  const identityAllowed = () => readVerification().identityGate !== false
  const figuresAllowed = () => readVerification().figuresGate !== false
  const revisionBudget = () => {
    const value = Number(readVerification().maxRevisions)
    return Number.isFinite(value) ? value : 2
  }
  // DSH cannot rewrite an answer that was already committed, so the only
  // honest fallback is a disclosure: a turn-tail panel record by default, an
  // extra steered sentence when `onFailure=disclose` asks for transcript text.
  const failureMode = () => normalizeFailureMode(readVerification().onFailure)
  const ignoreRules = () => readVerification().ignoreRules ?? {}

  const state = {
    created: false,
    corrections: 0,
    lastIssues: [],
    lastPanel: null as GatePanel | null,
    userMessage: '',
    degraded: null as string | null,
  }

  /** Seed text for the identity gate: the current turn's user request. */
  function createPayload() {
    return { session_id: agentId, user_message: state.userMessage }
  }

  async function ensureSession(): Promise<boolean> {
    if (state.created) return true
    try {
      await worker.request('grounding/create', createPayload())
      state.created = true
      return true
    } catch (error: any) {
      state.degraded = `grounding/create failed: ${error?.message ?? error}`
      return false
    }
  }

  async function ensure() {
    if (!gateEnabled()) return false
    if (state.created) return true
    try {
      await worker.request('grounding/create', createPayload())
      state.created = true
      return true
    } catch (error: any) {
      state.degraded = `grounding/create failed: ${error?.message ?? error}`
      return false
    }
  }

  /** @returns {Promise<{allowed: boolean, message?: string}>} */
  async function beforeCall(name: string, args: any, options: { callId?: string } = {}) {
    if (!gateEnabled() || !identityAllowed()) return { allowed: true }
    if (!(await ensure())) return { allowed: true }
    try {
      const decision = await worker.request('grounding/authorize', {
        session_id: agentId,
        name,
        arguments: args ?? {},
        ...(options.callId ? { call_id: options.callId } : {}),
      })
      if (decision?.allowed !== false) return { allowed: true }
      return {
        allowed: false,
        message: [
          `工具 ${name} 被 identity 门禁拦截（${decision.error_code ?? 'identity_required'}）。`,
          decision.message ?? '',
          decision.required_action ?? '',
        ]
          .filter(Boolean)
          .join('\n'),
      }
    } catch (error: any) {
      state.degraded = `grounding/authorize failed: ${error?.message ?? error}`
      return { allowed: true }
    }
  }

  /** Ingest the untruncated result. `raw` must be the full payload string. */
  async function afterResult(name: string, args: any, raw: any, success = true, options: { callId?: string } = {}) {
    if (!gateEnabled()) return
    if (!(await ensure())) return
    try {
      await worker.request('grounding/ingest', {
        session_id: agentId,
        name,
        arguments: args ?? {},
        result: typeof raw === 'string' ? raw : JSON.stringify(raw ?? ''),
        success,
        ...(options.callId ? { call_id: options.callId } : {}),
      })
    } catch (error: any) {
      state.degraded = `grounding/ingest failed: ${error?.message ?? error}`
    }
  }

  /**
   * @returns {Promise<{valid: boolean, released: string|null, correction: string|null, fallback: string|null, fallbackFull: string|null, issues: Array, panel: GatePanel|null, exhausted: boolean}>}
   */
  async function checkAnswer(content: string) {
    const empty = {
      valid: true,
      released: null,
      correction: null,
      fallback: null,
      fallbackFull: null,
      issues: [] as any[],
      panel: null as GatePanel | null,
      exhausted: false,
    }
    if (!gateEnabled() || !figuresAllowed()) return empty
    if (!(await ensure())) return empty
    try {
      const result = await worker.request('grounding/validate', {
        session_id: agentId,
        content: String(content ?? ''),
        ignore: ignoreRules(),
      })
      if (result?.valid) {
        state.corrections = 0
        state.lastIssues = []
        state.lastPanel = null
        return { ...empty, released: result.released_text ?? null }
      }
      state.lastIssues = result?.issues ?? []
      state.lastPanel = panelFrom(result, state.lastIssues.length)
      state.corrections += 1
      // Vibe-Trading rejects at most `maxRevisions` drafts, then releases a
      // redacted answer; DSH cannot redact an already-committed message, so the
      // budget maps to: after the last allowed rejection, disclose instead of
      // asking for another draft.
      const exhausted = state.corrections >= revisionBudget()
      if (!exhausted) {
        return {
          valid: false,
          released: null,
          correction: result?.correction_prompt ?? '回答未通过数字核实，请修正后重新提交。',
          fallback: null,
          fallbackFull: null,
          issues: state.lastIssues,
          panel: state.lastPanel,
          exhausted: false,
        }
      }
      if (failureMode() === 'silent') {
        return {
          valid: false,
          released: null,
          correction: null,
          fallback: null,
          fallbackFull: null,
          issues: state.lastIssues,
          panel: state.lastPanel,
          exhausted: true,
        }
      }
      return {
        valid: false,
        released: null,
        correction: null,
        // The short form is used when the panel data reached the session log as
        // an ignorable plugin record; the full form is the fallback data source
        // (and the only source for sessions recorded before this upgrade).
        fallback: buildDisclosure(result),
        fallbackFull: buildDetailedDisclosure(result),
        issues: state.lastIssues,
        panel: state.lastPanel,
        exhausted: true,
      }
    } catch (error: any) {
      state.degraded = `grounding/validate failed: ${error?.message ?? error}`
      return empty
    }
  }

  function cleanText(value: any, limit: number) {
    return String(value ?? '').replace(/[｜\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
  }

  /** The footer payload, also persisted as the ignorable gate record. */
  function panelFrom(result: any, count: number): GatePanel {
    const panel: GatePanel = { v: 1, unverified: count }
    if (Array.isArray(result?.details)) {
      const details = result.details
        .filter((entry: any) => entry && typeof entry === 'object')
        .slice(0, 5)
        .map((entry: any) => ({
          value: cleanText(entry.value, 40) || '?',
          context: cleanText(entry.context, 60),
          reason: cleanText(entry.reason, 40) || 'unverified',
        }))
      if (details.length > 0) panel.details = details
    }
    const passed = Number(result?.passed_count)
    if (Number.isFinite(passed) && passed >= 0) {
      panel.passed = Math.floor(passed)
      const values = (Array.isArray(result?.passed_values) ? result.passed_values : [])
        .map((value: any) => cleanText(value, 24))
        .filter(Boolean)
        .slice(0, 8)
      if (values.length > 0) panel.passedValues = values
    }
    const suppressed = Number(result?.suppressed_count)
    if (Number.isFinite(suppressed) && suppressed >= 0) {
      panel.suppressed = Math.floor(suppressed)
      const rules = (Array.isArray(result?.suppressed_rules) ? result.suppressed_rules : [])
        .filter((entry: any) => entry && typeof entry === 'object')
        .slice(0, 4)
        .map((entry: any) => ({
          rule: cleanText(entry.rule, 20) || 'extra',
          count: Math.max(0, Math.floor(Number(entry.count) || 0)),
        }))
      if (rules.length > 0) panel.suppressedRules = rules
    }
    return panel
  }

  /**
   * Short steer used when the panel data is persisted separately. The blocker
   * never depends on the record: if the bridge fails, index.ts falls back to
   * {@link buildDetailedDisclosure}.
   */
  function buildDisclosure(result: any) {
    const count = (result?.issues ?? []).length
    return (
      `本次回答有 ${count} 处数字没有通过核实。请用一句话向用户说明"部分数字未能核实、需要复核"，` +
      '不要重复未核实的数字，也不要声称它们已验证。'
    )
  }

  /**
   * Full steer carrying the footer data itself. This is the pre-record format
   * and the fallback when the experimental plugin-record bridge is unavailable;
   * `vibe-state.ts` keeps parsing it for older sessions.
   *
   * The format is load-bearing: the first line carries the count, each
   * `- 未核实 …` line one failed figure with its local context, and the two
   * summary lines the passed and auto-exempted counts. Keep the markers stable
   * and the payload bounded (5 details, 60-char contexts).
   */
  function buildDetailedDisclosure(result: any) {
    const issues = result?.issues ?? []
    const details = Array.isArray(result?.details) ? result.details : []
    const passedCount = Number(result?.passed_count ?? 0)
    const suppressedCount = Number(result?.suppressed_count ?? 0)
    const passedValues = Array.isArray(result?.passed_values) ? result.passed_values : []
    const rules = Array.isArray(result?.suppressed_rules) ? result.suppressed_rules : []
    const clean = (value: any, limit: number) =>
      String(value ?? '').replace(/[｜\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
    const lines = [
      `本次回答有 ${issues.length} 处数字没有通过核实。请用一句话向用户说明"部分数字未能核实、需要复核"，` +
        '不要重复未核实的数字，也不要声称它们已验证。',
    ]
    for (const detail of details.slice(0, 5)) {
      const value = clean(detail?.value, 40) || '?'
      const context = clean(detail?.context, 60)
      const reason = clean(detail?.reason, 40) || 'unverified'
      lines.push(`- 未核实 ${value} ｜ 上下文：${context || '（无）'} ｜ 原因：${reason}`)
    }
    const truncated = Number(result?.details_truncated ?? 0) || Math.max(0, issues.length - details.length)
    if (truncated > 0) lines.push(`- 另有 ${truncated} 处未展开`)
    const passed = clean(passedValues.map((value: any) => clean(value, 24)).filter(Boolean).slice(0, 8).join('、'), 200)
    lines.push(`- 已核实 ${passedCount} 项${passed ? `：${passed}` : ''}`)
    const ruleText = rules
      .slice(0, 4)
      .map((entry: any) => `${clean(entry?.rule, 20)} ${Number(entry?.count ?? 0)}`)
      .join('、')
    lines.push(`- 自动豁免 ${suppressedCount} 项${ruleText ? `（${ruleText}）` : ''}`)
    return lines.join('\n')
  }

  /**
   * Submit figure declarations (and optionally the draft answer) for validation.
   * Runs even when the gate is disabled: then it only records the declarations.
   */
  async function declare(request: { figures: string[]; draft?: string }) {
    if (!(await ensureSession())) {
      return { ok: true, text: '数字核实服务不可用，已跳过声明校验。' }
    }
    try {
      const result = await worker.request('grounding/declare', {
        session_id: agentId,
        figures: request.figures,
        draft: request.draft,
        validate: gateEnabled() && figuresAllowed(),
        ignore: ignoreRules(),
      })
      return {
        ok: result?.ok !== false,
        text: String(result?.text ?? ''),
        issues: result?.issues ?? [],
        suppressed: result?.suppressed ?? [],
        validated: Boolean(result?.validated),
      }
    } catch (error: any) {
      state.degraded = `grounding/declare failed: ${error?.message ?? error}`
      return { ok: true, text: `声明记录失败（不影响回答）：${error?.message ?? error}` }
    }
  }

  /** Start a fresh grounding turn: the ledger is per-turn in Vibe-Trading. */
  async function resetTurn(): Promise<void> {
    state.corrections = 0
    state.lastIssues = []
    state.lastPanel = null
    state.created = false
    try {
      await worker.request('grounding/reset', { session_id: agentId })
    } catch (error: any) {
      state.degraded = `grounding/reset failed: ${error?.message ?? error}`
    }
  }

  /** Remember the current turn's user request so the identity gate can seed it. */
  function setUserMessage(text: string) {
    state.userMessage = String(text ?? '')
  }

  return {
    state,
    /** Live: a saved form value changes the gate without re-activation. */
    get enabled() {
      return gateEnabled()
    },
    get failureMode() {
      return failureMode()
    },
    /** `silent` writes neither the panel record nor a steer. */
    get silent() {
      return failureMode() === 'silent'
    },
    get maxRevisions() {
      return revisionBudget()
    },
    ensure,
    beforeCall,
    afterResult,
    checkAnswer,
    declare,
    resetTurn,
    setUserMessage,
    resetCorrections() {
      state.corrections = 0
      state.lastIssues = []
      state.lastPanel = null
    },
  }
}
