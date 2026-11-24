/**
 * Tool-surface drift detection.
 *
 * `toolsets.json` is a snapshot of the advertised surface of the *pinned*
 * vibe-trading-ai release. Because the worker talks to Vibe-Trading's Python
 * internals (registry, skills loader, grounding policies) rather than a stable
 * public API, a runtime version outside the verified list can boot fine and
 * still drop or rename tools. Comparing the live `tools/list` with the recorded
 * surface turns that silent drift into a visible warning.
 *
 * Pure helpers: no I/O, so both activation and unit tests can use them.
 */

/** Advertised worker tools = static core plus every group member. */
export function advertisedToolNames(toolsets: any) {
  const names = new Set<string>()
  if (Array.isArray(toolsets?.staticCore)) {
    for (const name of toolsets.staticCore) names.add(String(name))
  }
  for (const members of Object.values(toolsets?.groups ?? {}) as any[]) {
    if (!Array.isArray(members)) continue
    for (const name of members) names.add(String(name))
  }
  return names
}

/**
 * Names whose credential gate the worker reports as closed.
 *
 * Only names documented in `toolsets.credentialGated` are considered, and only
 * when the worker's `capabilities` reply says they are unavailable. An older
 * or unreachable worker (no `key_gated` entry) keeps the current behaviour:
 * advertise the tool and let it answer "not configured".
 *
 * @param {object} toolsets parsed toolsets.json
 * @param {any} capabilities worker `capabilities` reply, or null when unavailable
 * @returns {string[]}
 */
export function credentialGatedOff(toolsets: any, capabilities: any) {
  const gated = toolsets?.credentialGated ?? {}
  const reported = capabilities?.key_gated ?? {}
  const off: string[] = []
  for (const name of Object.keys(gated)) {
    const entry = reported[name]
    if (entry && entry.available === false) off.push(name)
  }
  return off
}

/**
 * Advertised toolsets with the given names removed from their groups.
 *
 * The catalog, the group summary and `vt_load_tools` all read the returned
 * object, so a credential-gated tool that the worker cannot run disappears
 * everywhere at once instead of being promised and then failing.
 *
 * @param {object} toolsets parsed toolsets.json
 * @param {Iterable<string>} unavailable names to drop
 * @returns {object} a copy; the input is not mutated
 */
export function filterToolsets(toolsets: any, unavailable: Iterable<string> = []) {
  const drop = new Set(Array.from(unavailable ?? [], String))
  if (!drop.size) return toolsets
  const groups: Record<string, string[]> = {}
  for (const [group, names] of Object.entries(toolsets?.groups ?? {}) as [string, any][]) {
    groups[group] = Array.isArray(names) ? names.filter((name: string) => !drop.has(name)) : []
  }
  return { ...toolsets, groups }
}

/**
 * @param {Array<{name?: string}>} tools live worker `tools/list`
 * @param {object} toolsets parsed toolsets.json
 * @returns {{ok: boolean, expectedCount: number, liveCount: number, missing: string[]}}
 */
export function surfaceReport(tools: any[] = [], toolsets: any = {}) {
  const advertised = advertisedToolNames(toolsets)
  const listed = Array.isArray(tools) ? tools : []
  const live = new Set(
    listed
      .map((tool: any) => String(tool?.name ?? ''))
      .filter(Boolean),
  )
  const missing = [...advertised].filter((name) => !live.has(name))
  return {
    ok: missing.length === 0,
    expectedCount: advertised.size,
    liveCount: live.size,
    missing,
  }
}
