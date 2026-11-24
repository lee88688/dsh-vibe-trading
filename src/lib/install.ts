/**
 * Environment bootstrap for `/vibe-trading init`.
 *
 * Creates a virtual environment under `<vibeHome>/dsh/venv` and installs the
 * pinned `vibe-trading-ai` package there, trying interpreters in priority
 * order (system Python → uv-managed → DSH bundled). Writes `config.json` and
 * `init-report.json`; never touches Vibe-Trading's own files.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_MINIMUM_VERSION,
  DEFAULT_PACKAGE_MODE,
  DEFAULT_VERIFIED_VERSIONS,
  PINNED_VERSION,
  PACKAGE_NAME,
  configPath,
  dshDataDir,
  installSpec,
  installTargetVersion,
  isFloorAbovePin,
  isSameRelease,
  isVerifiedVersion,
  isVersionBelow,
  logsDir,
  reportPath,
  resolveVibeHome,
  runtimeHomeDir,
  venvDir,
  venvLayout,
  writeConfig,
  writeReport,
} from './config.js'
import type { PackageMode } from './config.js'
import { pythonProbe, tryExec } from './exec.js'
import { runPreflight } from './preflight.js'

const VENV_TIMEOUT_MS = 300_000
const INSTALL_TIMEOUT_MS = 1_800_000
const VERIFY_IMPORT_CODE = 'import src.market_data\nprint("ok")'
const VERSION_CODE = [
  'import importlib.metadata as m',
  `print(m.version(${JSON.stringify(PACKAGE_NAME)}))`,
].join('\n')

function nowIso() {
  return new Date().toISOString()
}

function seconds(startedAt: number) {
  return Math.round((Date.now() - startedAt) / 100) / 10
}

function childEnv(env: NodeJS.ProcessEnv, overrides: any = {}) {
  return {
    ...env,
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
    ...overrides,
  }
}

/**
 * Pure planning helper (unit-testable): ordered install attempts.
 * @returns {Array<{kind: string, exe: string, version: string|null}>}
 */
export function resolveInstallPlan(pythons: any[] = []) {
  const order = ['system', 'conda', 'uv', 'dsh-bundled']
  return [...pythons]
    .filter((candidate) => candidate.ok)
    .sort((left, right) => order.indexOf(left.via) - order.indexOf(right.via))
    .map((candidate) => ({ kind: candidate.via, exe: candidate.exe, version: candidate.version ?? null }))
}

/**
 * Pure config builder (unit-testable).
 */
export function buildConfigFromInstall(input: any) {
  // config.json keeps only install facts (paths, interpreter, package policy).
  // Behavioural preferences (verification/worker/skills) live in this plugin's
  // profile row config so each DSH profile can set them on its own.
  const {
    vibeHome,
    workDir: work,
    venv,
    python,
    uv,
    installedVersion,
    detectedKeys,
    minimumVersion,
    mode,
    pinnedVersion,
    verifiedVersions,
    verified,
  } = input
  const policy: PackageMode = mode === 'latest' ? 'latest' : DEFAULT_PACKAGE_MODE
  const pin = pinnedVersion ?? PINNED_VERSION
  return {
    package: {
      name: PACKAGE_NAME,
      mode: policy,
      pinnedVersion: pin,
      verifiedVersions: verifiedVersions ?? [...DEFAULT_VERIFIED_VERSIONS],
      minimumVersion,
      installedVersion,
      verified: verified ?? null,
      spec: installSpec(minimumVersion, policy, pin),
    },
    python: { kind: python.kind, exe: python.exe, version: python.version ?? null },
    uv: uv ?? null,
    venv: { dir: venv.dir, python: venv.python },
    vibeHome,
    workDir: work,
    env: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // VIBE_TRADING_HOME is not an install fact: the worker derives its VT
      // runtime root at spawn time (`runtimeHomeDir` / `worker.runtimeHome`).
    },
    detectedKeys: detectedKeys ?? [],
    checks: {
      packageImportOk: true,
      installedAt: nowIso(),
    },
  }
}

async function ensureDirs(env: NodeJS.ProcessEnv) {
  for (const dir of [dshDataDir(env), logsDir(env), runtimeHomeDir(env)]) {
    await fsp.mkdir(dir, { recursive: true })
  }
}

async function createVenv(pythonExe: string, layout: any, env: NodeJS.ProcessEnv, log: (line: string) => void) {
  const startedAt = Date.now()
  log(`creating venv: ${pythonExe} -m venv ${layout.dir}`)
  const result = await tryExec(pythonExe, ['-m', 'venv', layout.dir], {
    env: childEnv(env),
    timeoutMs: VENV_TIMEOUT_MS,
  })
  const ok = result.ok
  log(ok ? `venv created in ${seconds(startedAt)}s` : `venv failed: ${(result.stderr || result.error || '').slice(0, 500)}`)
  return { ok, seconds: seconds(startedAt), detail: ok ? null : (result.stderr || result.error || 'venv failed').slice(0, 800) }
}

async function installPackage({ layout, env, minimumVersion, mode, pinnedVersion, indexUrl, preferUv, log }: any) {
  const startedAt = Date.now()
  const spec = installSpec(minimumVersion, mode === 'latest' ? 'latest' : 'pinned', pinnedVersion)
  const attempts: any[] = []
  const uvArgs = ['pip', 'install', '--python', layout.python, spec]
  if (indexUrl) uvArgs.push('--index-url', indexUrl)
  attempts.push({ tool: 'uv', argv: ['uv', uvArgs] })
  const pipArgs = ['-m', 'pip', 'install', '--upgrade', '--disable-pip-version-check', spec]
  if (indexUrl) pipArgs.push('--index-url', indexUrl)
  attempts.push({ tool: 'pip', argv: [layout.python, pipArgs] })

  const ordered = preferUv ? attempts : [...attempts].reverse()
  const problems: any[] = []
  for (const attempt of ordered) {
    log(`installing ${spec} via ${attempt.tool}: ${attempt.argv[0]} ...`)
    const result = await tryExec(attempt.argv[0], attempt.argv[1] ?? [], {
      env: childEnv(env),
      timeoutMs: INSTALL_TIMEOUT_MS,
    })
    const output = `${result.stdout}\n${result.stderr}`.trim()
    if (result.ok) {
      log(`${attempt.tool} install finished in ${seconds(startedAt)}s`)
      return { ok: true, tool: attempt.tool, seconds: seconds(startedAt), detail: output.slice(-2000) }
    }
    const detail = (result.stderr || result.error || output || 'install failed').slice(-1500)
    problems.push(`${attempt.tool}: ${detail}`)
    log(`${attempt.tool} install failed; trying next`)
  }
  return { ok: false, tool: null, seconds: seconds(startedAt), detail: problems.join('\n---\n') }
}

async function verifyInstall({ layout, env, minimumVersion, pinnedVersion, verifiedVersions, log }: any) {
  const steps: any[] = []
  const versionProbe = await pythonProbe(layout.python, VERSION_CODE, { env })
  steps.push({ id: 'version', ok: versionProbe.ok, detail: versionProbe.ok ? versionProbe.value : versionProbe.detail })
  if (!versionProbe.ok) return { ok: false, steps, verified: false }

  const importProbe = await pythonProbe(layout.python, VERIFY_IMPORT_CODE, { env, timeoutMs: 120_000 })
  steps.push({ id: 'import', ok: importProbe.ok, detail: importProbe.ok ? 'src.market_data' : importProbe.detail })

  const { cmpVersion } = await import('./config.js')
  const versionOk = cmpVersion(String(versionProbe.value ?? ''), minimumVersion) >= 0
  steps.push({
    id: 'minimum-version',
    ok: versionOk,
    detail: `${versionProbe.value} >= ${minimumVersion}`,
  })
  // Verification is informational: an unverified newer version still passes the
  // technical checks, it is just reported (and warned about) rather than used
  // silently as if it were tested.
  const verified = isVerifiedVersion(versionProbe.value, verifiedVersions)
  steps.push({
    id: 'verified',
    ok: true,
    detail: verified
      ? `${versionProbe.value} ∈ verified [${(verifiedVersions ?? []).join(', ')}]`
      : `${versionProbe.value} ∉ verified [${(verifiedVersions ?? []).join(', ')}] (pin ${pinnedVersion})`,
  })
  log(`verify: ${steps.map((step) => `${step.id}=${step.ok ? 'ok' : 'FAIL'}`).join(' ')}`)
  return { ok: steps.every((step) => step.ok), steps, version: versionProbe.value, verified }
}

/**
 * Run the installer.
 * @param {object} options
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.minimumVersion]
 * @param {'pinned'|'latest'} [options.mode] install policy (default pinned)
 * @param {string} [options.pinnedVersion] tested version to pin to
 * @param {string[]} [options.verifiedVersions] versions treated as tested
 * @param {string} [options.indexUrl]
 * @param {boolean} [options.force] rebuild even when the environment already works
 * @param {boolean} [options.dryRun] plan and verify only, write nothing
 * @returns {Promise<{ok: boolean, status: string, config: object|null, report: object, steps: Array}>}
 */
export async function runInstall(options: any = {}) {
  const env = options.env ?? process.env
  const minimumVersion = options.minimumVersion ?? DEFAULT_MINIMUM_VERSION
  const mode: PackageMode = options.mode === 'latest' ? 'latest' : DEFAULT_PACKAGE_MODE
  const pinnedVersion = options.pinnedVersion ?? PINNED_VERSION
  const verifiedVersions = Array.isArray(options.verifiedVersions) && options.verifiedVersions.length
    ? options.verifiedVersions
    : [...DEFAULT_VERIFIED_VERSIONS]
  // Progress goes to <vibeHome>/dsh/logs/init-<stamp>.log as well as the caller's
  // logger, so a failed init can be diagnosed after the fact.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const initLogPath = path.join(logsDir(env), `init-${stamp}.log`)
  await fsp.mkdir(logsDir(env), { recursive: true }).catch(() => {})
  // VT's runtime root for the worker lives here; create it up front so the first
  // tool call never races the OS on directory creation.
  await fsp.mkdir(runtimeHomeDir(env), { recursive: true }).catch(() => {})
  const callerLog = options.log ?? (() => {})
  const log = (line: string) => {
    void fsp.appendFile(initLogPath, `${new Date().toISOString()} ${line}\n`).catch(() => {})
    try {
      callerLog(line)
    } catch {
      /* logging must never break init */
    }
  }
  const steps: any[] = []
  const startedAt = Date.now()
  const push = (entry: any) => {
    steps.push(entry)
    return entry
  }

  // Pinned mode installs exactly the tested release. A floor above the pin would
  // force an untested `==<floor>` install (and a later `--pinned` retry would
  // repeat it), so refuse up front with an actionable message.
  if (mode === 'pinned' && isFloorAbovePin(minimumVersion, pinnedVersion)) {
    const reason =
      `minimumVersion ${minimumVersion} is above the tested pin ${pinnedVersion}; ` +
      'use mode="latest" (or lower minimumVersion) instead of a pinned install'
    push({ id: 'policy', ok: false, detail: reason })
    log(`pin policy: ${reason}`)
    const report = {
      status: 'needs-help',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      seconds: seconds(startedAt),
      minimumVersion,
      mode,
      pinnedVersion,
      initLogPath,
      reason,
      steps,
    }
    await writeReport(report, env)
    return { ok: false, status: 'needs-help', config: null, report, steps }
  }

  const preflight = await runPreflight({ env, minimumVersion, pinnedVersion, verifiedVersions })
  // needs-install is a healthy preflight (it produces the install plan); only needs-help is a failure.
  push({ id: 'preflight', ok: preflight.status !== 'needs-help', status: preflight.status, checks: preflight.checks })
  log(`preflight: ${preflight.status} (${preflight.pythons.filter((p: any) => p.ok).length} usable python)`)

  if (options.dryRun) {
    return {
      ok: preflight.status === 'ready',
      status: preflight.status,
      config: preflight.config,
      report: { dryRun: true, mode, pinnedVersion, verifiedVersions, preflight, steps },
      steps,
    }
  }

  await ensureDirs(env)
  const layout = venvLayout(venvDir(env))

  // Already usable *and on the requested target*: nothing to do. If the
  // installed release does not satisfy the requested policy (e.g. mode=latest
  // requested while `pinned` was installed, or an unverified newer version under
  // `pinned`), fall through and actually install the target instead of echoing
  // the requested mode without doing anything.
  const installedVersion = preflight.venv.installedVersion
  const targetVersion = installTargetVersion(minimumVersion, mode, pinnedVersion)
  const targetSatisfied =
    preflight.status === 'ready' && Boolean(installedVersion)
      ? mode === 'latest'
        ? // "latest" means *newest available*, which we cannot know without
          // hitting the index; never claim it was applied by reusing a venv.
          false
        : isSameRelease(installedVersion, targetVersion)
      : false
  if (targetSatisfied && !options.force) {
    const verified = isVerifiedVersion(installedVersion, verifiedVersions)
    push({ id: 'reuse', ok: true, detail: `${PACKAGE_NAME} ${installedVersion} already installed` })
    push({ id: 'verified', ok: true, detail: `${installedVersion} ${verified ? '∈' : '∉'} verified [${verifiedVersions.join(', ')}]` })
    log(`environment already ready: ${PACKAGE_NAME} ${installedVersion}; nothing to do`)
    const report = {
      status: 'ready',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      seconds: seconds(startedAt),
      minimumVersion,
      mode,
      pinnedVersion,
      verifiedVersions,
      verified,
      initLogPath,
      reused: true,
      config: preflight.config,
      steps,
    }
    return { ok: true, status: 'ready', config: preflight.config, report, steps }
  }
  if (preflight.status === 'ready' && !targetSatisfied && !options.force) {
    log(
      `installed ${PACKAGE_NAME} ${installedVersion} does not satisfy mode=${mode} target ${targetVersion}; installing`,
    )
  }

  const plan = resolveInstallPlan(preflight.pythons)
  if (plan.length === 0) {
    const report = {
      status: 'needs-help',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      seconds: seconds(startedAt),
      minimumVersion,
      mode,
      pinnedVersion,
      initLogPath,
      reason: 'no usable Python (>= 3.11) found',
      preflight,
      steps,
    }
    await writeReport(report, env)
    return { ok: false, status: 'needs-help', config: null, report, steps }
  }

  log(`install plan: ${plan.length} python candidate(s), first=${(plan[0] as any)?.kind ?? 'none'}`)
  const failures: any[] = []
  for (const candidate of plan) {
    log(`trying ${candidate.kind} python ${candidate.version ?? ''} at ${candidate.exe}`)
    const venvResult = await createVenv(candidate.exe, layout, env, log)
    push({ id: `venv:${candidate.kind}`, ok: venvResult.ok, detail: venvResult.detail, seconds: venvResult.seconds })
    if (!venvResult.ok) {
      failures.push({ kind: candidate.kind, stage: 'venv', detail: venvResult.detail })
      continue
    }

    const install = await installPackage({
      layout,
      env,
      minimumVersion,
      mode,
      pinnedVersion,
      indexUrl: options.indexUrl,
      preferUv: candidate.kind === 'uv' && Boolean(preflight.uv),
      log,
    })
    push({ id: `install:${candidate.kind}`, ok: install.ok, tool: install.tool, detail: install.detail, seconds: install.seconds })
    if (!install.ok) {
      failures.push({ kind: candidate.kind, stage: 'install', detail: install.detail })
      continue
    }

    const verify = await verifyInstall({
      layout,
      env,
      minimumVersion,
      pinnedVersion,
      verifiedVersions,
      log,
    })
    push({ id: `verify:${candidate.kind}`, ok: verify.ok, steps: verify.steps })
    if (!verify.ok) {
      failures.push({ kind: candidate.kind, stage: 'verify', detail: verify.steps.map((step) => `${step.id}: ${step.detail}`).join('; ') })
      continue
    }

    const config = {
      ...buildConfigFromInstall({
        vibeHome: resolveVibeHome(env),
        workDir: path.join(dshDataDir(env), 'work'),
        venv: layout,
        python: { kind: candidate.kind, exe: candidate.exe, version: candidate.version },
        uv: preflight.uv ? { exe: preflight.uv.exe, version: preflight.uv.version } : null,
        installedVersion: verify.version,
        detectedKeys: preflight.dotenv.keys,
        minimumVersion,
        mode,
        pinnedVersion,
        verifiedVersions,
        verified: verify.verified,
      }),
    }
    const written = await writeConfig(config, env)
    push({ id: 'config', ok: true, detail: configPath(env) })

    const report = {
      status: 'ready',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: nowIso(),
      seconds: seconds(startedAt),
      minimumVersion,
      mode,
      pinnedVersion,
      verifiedVersions,
      // Plugin data root (config/logs/venv) vs the worker's VT runtime root: the
      // latter is where runs, research stores and shadow_* land.
      vibeHome: resolveVibeHome(env),
      runtimeHome: runtimeHomeDir(env),
      verified: verify.verified,
      chosen: candidate.kind,
      failures,
      preflight: {
        checks: preflight.checks,
        uv: preflight.uv,
        pythons: preflight.pythons,
        dotenvKeys: preflight.dotenv.keys,
      },
      steps,
    }
    await writeReport(report, env)
    log(`ready: ${PACKAGE_NAME} ${verify.version} via ${candidate.kind} (verified=${verify.verified})`)
    return { ok: true, status: 'ready', config: written, report, steps }
  }

  const report = {
    status: 'needs-help',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: nowIso(),
    seconds: seconds(startedAt),
    minimumVersion,
    mode,
    pinnedVersion,
    reason: 'every interpreter candidate failed',
    failures,
    preflight: { checks: preflight.checks, pythons: preflight.pythons, uv: preflight.uv },
    steps,
    reportPath: reportPath(env),
  }
  await writeReport(report, env)
  return { ok: false, status: 'needs-help', config: null, report, steps }
}

/**
 * Quick post-init health check used by `/vibe-trading on`.
 *
 * `ok` keeps the old meaning (environment usable). `verified` reports whether
 * the installed release is in the plugin's tested set; an unverified version is
 * usable but warned about, never silently treated as tested.
 */
export async function verifyEnvironment(
  env = process.env,
  minimumVersion = DEFAULT_MINIMUM_VERSION,
  options: any = {},
) {
  const layout = venvLayout(venvDir(env))
  const pinnedVersion = options.pinnedVersion ?? PINNED_VERSION
  const verifiedVersions = Array.isArray(options.verifiedVersions) && options.verifiedVersions.length
    ? options.verifiedVersions
    : [...DEFAULT_VERIFIED_VERSIONS]
  const version = await pythonProbe(layout.python, VERSION_CODE, { env })
  if (!version.ok) {
    return {
      ok: false,
      verified: false,
      pinnedVersion,
      verifiedVersions,
      reason: `venv python missing or package not installed (${version.detail})`,
    }
  }
  const installedVersion = String(version.value ?? '')
  if (isVersionBelow(installedVersion, minimumVersion)) {
    return {
      ok: false,
      verified: false,
      version: installedVersion,
      pinnedVersion,
      verifiedVersions,
      reason: `${PACKAGE_NAME} ${installedVersion} is below minimum ${minimumVersion}`,
    }
  }
  const verified = isVerifiedVersion(installedVersion, verifiedVersions)
  // `--pinned` only helps when the pin can satisfy the floor; otherwise it would
  // reinstall the same untested floor version the warning is about.
  const pinnedRemedy = isFloorAbovePin(minimumVersion, pinnedVersion)
    ? `已验证 pin ${pinnedVersion} 低于 minimumVersion ${minimumVersion}，请改用 /vibe-trading init --latest（或把 minimumVersion 调到 ≤ ${pinnedVersion}）`
    : '如需回退到固定版本，运行 /vibe-trading init --pinned'
  return {
    ok: true,
    verified,
    version: installedVersion,
    pinnedVersion,
    verifiedVersions,
    warning: verified
      ? null
      : `${PACKAGE_NAME} ${installedVersion} 不在已验证范围（${verifiedVersions.join(', ')}）；` +
        `工具面可能与目录快照不同。${pinnedRemedy}。`,
  }
}
