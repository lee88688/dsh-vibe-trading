#!/usr/bin/env node
/**
 * Run the plugin's init pipeline outside DSH.
 *
 * Useful for local development and for pre-seeding the environment before the
 * first `/vibe-trading on` in a session:
 *
 *   node scripts/dev/init.mjs            # preflight → install → verify → write config
 *   node scripts/dev/init.mjs --dry-run  # preflight only
 *   node scripts/dev/init.mjs --verify   # verify the recorded config only
 *
 * The DSH host runs this same code from `lib/install.ts`; running it here writes
 * the same `~/.vibe-trading/dsh/{config.json,init-report.json}`.
 */

import path from 'node:path'

import { PINNED_VERSION, configPath, readConfig, resolveVibeHome } from '../../dist/lib/config.js'
import { runPreflight, summarizePreflight } from '../../dist/lib/preflight.js'
import { runInstall, verifyEnvironment } from '../../dist/lib/install.js'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const onlyVerify = args.includes('--verify')
const env = process.env
const minimumVersion = process.env.VIBE_TRADING_MIN_VERSION ?? PINNED_VERSION
const mode = process.env.VIBE_TRADING_PACKAGE_MODE === 'latest' ? 'latest' : 'pinned'
const log = (line) => console.log(`[init] ${line}`)

console.log(`vibe home: ${resolveVibeHome(env)}`)
console.log(`config:    ${configPath(env)}`)
console.log(`policy:    ${mode}${mode === 'pinned' ? ` (vibe-trading-ai==${PINNED_VERSION})` : ''}`)

if (onlyVerify) {
  const verification = await verifyEnvironment(env, minimumVersion, { pinnedVersion: PINNED_VERSION })
  console.log(JSON.stringify(verification, null, 2))
  process.exit(verification.ok ? 0 : 1)
}

if (dryRun) {
  const report = await runPreflight({ env, minimumVersion, pinnedVersion: PINNED_VERSION })
  console.log(summarizePreflight(report))
  console.log(
    JSON.stringify(
      { status: report.status, pythons: report.pythons, uv: report.uv, checks: report.checks },
      null,
      2,
    ),
  )
  process.exit(report.status === 'needs-help' ? 1 : 0)
}

const started = Date.now()
const result = await runInstall({ env, minimumVersion, mode, pinnedVersion: PINNED_VERSION, log })
console.log(`\nresult: ${result.ok ? 'OK' : 'FAILED'} (${result.status}) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
for (const step of result.steps ?? []) {
  console.log(`  ${step.ok ? 'PASS' : 'FAIL'}  ${step.id}${step.detail ? `  ${String(step.detail).slice(0, 200)}` : ''}`)
}
const config = await readConfig(env)
if (config.config) {
  console.log(`\nconfig written: ${configPath(env)}`)
  console.log(`python: ${config.config.venv?.python}`)
  console.log(`installed: ${config.config.package?.installedVersion}`)
  console.log(
    `policy:    ${config.config.package?.mode ?? 'pinned'} · verified=${config.config.package?.verified ?? '?'}` +
      ` · pinned=${config.config.package?.pinnedVersion ?? PINNED_VERSION}`,
  )
} else if (config.error) {
  console.log(`config: ${config.error}`)
}
const report = result.report ?? {}
if (report.failures?.length) console.log(`failures: ${JSON.stringify(report.failures, null, 2)}`)
process.exit(result.ok ? 0 : 1)
