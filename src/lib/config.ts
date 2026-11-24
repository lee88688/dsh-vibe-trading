/**
 * Plugin configuration: portable paths, config.json read/write/validate.
 *
 * Nothing here hardcodes a machine path. Every path is derived from the
 * environment (HOME/USERPROFILE, VIBE_TRADING_HOME) and the values written by
 * `/vibe-trading init` live in `<vibeHome>/dsh/config.json`.
 */

import { promises as fsp } from 'node:fs'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

export const CONFIG_SCHEMA_VERSION = 1
export const PACKAGE_NAME = 'vibe-trading-ai'

/**
 * The `vibe-trading-ai` release this plugin was built and tested against
 * (prompt port, `toolsets.json` surface, worker/grounding adapter calls).
 * New installs pin exactly this version unless the caller opts into `latest`.
 */
export const PINNED_VERSION = '0.1.19'

/** Versions this plugin has been validated against; keep in sync with PINNED_VERSION. */
export const DEFAULT_VERIFIED_VERSIONS = [PINNED_VERSION]

/**
 * Floor enforced by `/vibe-trading on` and preflight. It equals the pin so an
 * environment older than the validated surface is refused, not silently used.
 */
export const DEFAULT_MINIMUM_VERSION = PINNED_VERSION

/** Default install policy: `pinned` (exact `==`) or `latest` (`>=` floor). */
export const DEFAULT_PACKAGE_MODE = 'pinned' as const

export type PackageMode = 'pinned' | 'latest'

const PACKAGE_MODES = new Set<PackageMode>(['pinned', 'latest'])

export const DEFAULT_WORKER = {
  idleMinutes: 30,
  defaultTimeoutMs: 120_000,
  longTimeoutMs: 1_860_000,
  /**
   * Optional monkey-patch file imported by the Python worker at startup.
   * Empty means "no patch". Absolute path, or `~`-relative; the worker resolves
   * it and reports the outcome through `ping` -> `startup.user_patch`.
   */
  patchFile: '',
}

export const DEFAULT_SKILLS = {
  mode: 'short',
  loadLimitChars: 10_000,
}

export const DEFAULT_IGNORE_RULES = {
  urls: true,
  paths: true,
  code: true,
  versions: true,
  dates: true,
  sections: true,
  ids: true,
  extra: [] as string[],
}

export const DEFAULT_VERIFICATION = {
  enabled: true,
  ignoreRules: DEFAULT_IGNORE_RULES,
  identityGate: true,
  figuresGate: true,
  maxRevisions: 2,
  onFailure: 'panel',
}

/* ------------------------------------------------------------------------- */
/* Paths                                                                      */
/* ------------------------------------------------------------------------- */

export function homeDir(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir()
}

/** Vibe-Trading home; defaults to ~/.vibe-trading (env override wins). */
export function resolveVibeHome(env = process.env) {
  const override = env.VIBE_TRADING_HOME
  if (override && override.trim()) return path.resolve(override)
  return path.join(homeDir(env), '.vibe-trading')
}

export function dshDataDir(env = process.env) {
  return path.join(resolveVibeHome(env), 'dsh')
}

export function configPath(env = process.env) {
  return path.join(dshDataDir(env), 'config.json')
}

export function reportPath(env = process.env) {
  return path.join(dshDataDir(env), 'init-report.json')
}

export function workDir(env = process.env) {
  return path.join(dshDataDir(env), 'work')
}

/**
 * Vibe-Trading's runtime root, as seen by the worker process only.
 *
 * Vanilla VT keeps every runtime artifact directly under `~/.vibe-trading`
 * (`runs/`, `sessions.db`, `shadow_accounts/`, `strategies/`, `reports/`, …).
 * The plugin points the worker's `VIBE_TRADING_HOME` at its own data root so
 * those artifacts can never mix with a separately installed original VT.
 *
 * Deliberately **not** the same value as `resolveVibeHome()`: the plugin's own
 * files (config.json, logs, venv) and VT's own `.env` / data-bridge lookups stay
 * on the real home, because VT resolves those from `Path.home()` rather than
 * from `VIBE_TRADING_HOME`. `workDir()` is also the worker's cwd and the parent
 * of the default allowed run roots, so `<runtimeHome>/runs` and
 * `VIBE_TRADING_ALLOWED_RUN_ROOTS` coincide by construction.
 */
export function runtimeHomeDir(env = process.env) {
  return workDir(env)
}

export function logsDir(env = process.env) {
  return path.join(dshDataDir(env), 'logs')
}

export function venvDir(env = process.env) {
  return path.join(dshDataDir(env), 'venv')
}

export function resultsDir(env = process.env) {
  return path.join(workDir(env), 'results')
}

export function workerLogPath(env = process.env) {
  return path.join(logsDir(env), 'worker.log')
}

/* ------------------------------------------------------------------------- */
/* Config object                                                              */
/* ------------------------------------------------------------------------- */

/** @returns {object} a complete config object with all default sections filled. */
export function defaultConfig(overrides: any = {}, env = process.env) {
  const now = new Date().toISOString()
  const base = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    pluginVersion: overrides.pluginVersion ?? '0.1.0',
    createdAt: now,
    updatedAt: now,
    package: {
      name: PACKAGE_NAME,
      mode: DEFAULT_PACKAGE_MODE,
      pinnedVersion: PINNED_VERSION,
      verifiedVersions: [...DEFAULT_VERIFIED_VERSIONS],
      minimumVersion: DEFAULT_MINIMUM_VERSION,
      installedVersion: null,
      verified: null,
      spec: installSpec(),
    },
    python: null,
    uv: null,
    venv: null,
    vibeHome: resolveVibeHome(env),
    workDir: workDir(env),
    env: {
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      // VIBE_TRADING_HOME is deliberately absent: the worker's VT runtime root is
      // derived at spawn time (see runtimeHomeDir), so a stale config.json can
      // never point VT back at the real ~/.vibe-trading and undo the isolation.
    },
    // Behavioural settings (verification/skills/worker) are NOT stored here:
    // they belong to the DSH profile and live in this plugin's Loader row config
    // (see `lib/settings.ts`). config.json carries install facts only.
    detectedKeys: [],
    checks: {},
  }
  const merged = mergeDeep(base, overrides)
  // A direct `defaultConfig({ package: ... })` override must not keep the spec
  // computed from the defaults (e.g. mode:"latest" with a `==` spec).
  if (isPlainObject(overrides.package)) {
    const mode = merged.package.mode === 'latest' ? 'latest' : DEFAULT_PACKAGE_MODE
    merged.package.spec = installSpec(merged.package.minimumVersion, mode, merged.package.pinnedVersion)
  }
  return merged
}

function isPlainObject(value: any) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function mergeDeep(base: any, patch: any) {
  if (!isPlainObject(patch)) return patch === undefined ? base : patch
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? mergeDeep(base[key], value) : value
  }
  return out
}

/* ------------------------------------------------------------------------- */
/* Read / write                                                               */
/* ------------------------------------------------------------------------- */

/**
 * Read and structurally validate config.json.
 * @returns {Promise<{config: object|null, error: string|null, exists: boolean}>}
 */
/**
 * Parse `<vibeHome>/.env` into a plain object (values included; used to seed the
 * worker process). Comments, blank lines, `export ` prefixes and surrounding
 * quotes are handled the way python-dotenv handles them.
 */
export async function readDotEnvValues(env = process.env): Promise<Record<string, string>> {
  const file = path.join(resolveVibeHome(env), '.env')
  let raw = ''
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch {
    return {}
  }
  const values: Record<string, string> = {}
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed
    const eq = body.indexOf('=')
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = body.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1)
    } else {
      const hash = value.indexOf(' #')
      if (hash >= 0) value = value.slice(0, hash).trim()
    }
    values[key] = value
  }
  return values
}
export async function readConfig(env = process.env) {
  const file = configPath(env)
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error: any) {
    const exists = error?.code !== 'ENOENT'
    return { config: null, error: exists ? String(error.message ?? error) : null, exists }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error: any) {
    return { config: null, error: `invalid JSON: ${error.message}`, exists: true }
  }
  const { ok, problems } = validateConfig(parsed)
  if (!ok) return { config: null, error: problems.join('; '), exists: true }
  return { config: effectiveConfig(parsed, env), error: null, exists: true }
}

/** Fill missing optional sections with defaults (structural only). */
export function effectiveConfig(cfg: any, env: NodeJS.ProcessEnv = process.env) {
  const merged = mergeDeep(defaultConfig({ pluginVersion: cfg?.pluginVersion }, env), cfg ?? {})
  merged.schemaVersion = cfg?.schemaVersion ?? CONFIG_SCHEMA_VERSION
  return merged
}

/**
 * Structural validation — no filesystem probing.
 * @returns {{ok: boolean, problems: string[], warnings: string[]}}
 */
export function validateConfig(cfg: any) {
  const problems: any[] = []
  const warnings: any[] = []
  if (!isPlainObject(cfg)) return { ok: false, problems: ['config is not an object'], warnings }

  if (cfg.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    problems.push(`unsupported schemaVersion ${cfg.schemaVersion} (expected ${CONFIG_SCHEMA_VERSION})`)
  }
  if (typeof cfg.vibeHome !== 'string' || !path.isAbsolute(cfg.vibeHome)) {
    problems.push('vibeHome must be an absolute path')
  }
  if (typeof cfg.workDir !== 'string' || !path.isAbsolute(cfg.workDir)) {
    problems.push('workDir must be an absolute path')
  }
  if (!isPlainObject(cfg.package) || cfg.package.name !== PACKAGE_NAME) {
    problems.push(`package.name must be ${PACKAGE_NAME}`)
  } else {
    if (!isSemverLike(cfg.package.minimumVersion)) problems.push('package.minimumVersion must be semver')
    if (cfg.package.installedVersion && !isSemverLike(cfg.package.installedVersion)) {
      problems.push('package.installedVersion must be semver')
    }
    if (cfg.package.mode !== undefined && !PACKAGE_MODES.has(cfg.package.mode)) {
      problems.push(`package.mode must be ${[...PACKAGE_MODES].join(' or ')}`)
    }
    if (cfg.package.pinnedVersion !== undefined && !isSemverLike(cfg.package.pinnedVersion)) {
      problems.push('package.pinnedVersion must be semver')
    }
    if (cfg.package.verified !== undefined && cfg.package.verified !== null && typeof cfg.package.verified !== 'boolean') {
      problems.push('package.verified must be a boolean or null')
    }
    if (cfg.package.verifiedVersions !== undefined) {
      if (!Array.isArray(cfg.package.verifiedVersions) || cfg.package.verifiedVersions.length === 0) {
        problems.push('package.verifiedVersions must be a non-empty array')
      } else if (!cfg.package.verifiedVersions.every((value: any) => isSemverLike(value))) {
        problems.push('package.verifiedVersions entries must be semver')
      }
    }
    if (
      cfg.package.installedVersion &&
      isVersionBelow(cfg.package.installedVersion, cfg.package.minimumVersion)
    ) {
      problems.push(
        `installed ${PACKAGE_NAME}@${cfg.package.installedVersion} is below minimum ${cfg.package.minimumVersion}`,
      )
    }
  }
  const venv = cfg.venv
  if (!isPlainObject(venv) || typeof venv.python !== 'string' || !venv.python) {
    problems.push('venv.python is required')
  }
  if (!isPlainObject(cfg.python) || typeof cfg.python.exe !== 'string' || !cfg.python.exe) {
    warnings.push('python.exe is missing (init should record it)')
  }
  return { ok: problems.length === 0, problems, warnings }
}

/** Read a dotted path out of a config object (undefined when absent). */
export function getConfigValue(cfg: any, keyPath: string) {
  let current = cfg
  for (const part of String(keyPath ?? '').split('.').filter(Boolean)) {
    if (current === null || typeof current !== 'object' || !(part in current)) return undefined
    current = current[part]
  }
  return current
}


/** Coerce a command-line value into a JSON scalar. */
export function parseConfigValue(raw: string) {
  const value = String(raw ?? '').trim()
  if (value === 'true') return true
  if (value === 'false') return false
  if (value === 'null') return null
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value)
  return value
}

/** Atomic write: temp file in the same directory, then rename. */
export async function writeConfig(cfg: any, env: NodeJS.ProcessEnv = process.env) {
  const file = configPath(env)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const next = { ...cfg, schemaVersion: CONFIG_SCHEMA_VERSION, updatedAt: new Date().toISOString() }
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
  return next
}

export async function readReport(env = process.env) {
  try {
    return JSON.parse(await fsp.readFile(reportPath(env), 'utf8'))
  } catch {
    return null
  }
}

export async function writeReport(report: any, env: NodeJS.ProcessEnv = process.env) {
  const file = reportPath(env)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await fsp.writeFile(tmp, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  await fsp.rename(tmp, file)
  return report
}

/* ------------------------------------------------------------------------- */
/* Versions                                                                   */
/* ------------------------------------------------------------------------- */

export function isSemverLike(value: any) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value)
}

/** A `0.1.19-rc1` style build is *before* the 0.1.19 release, never equal to it. */
export function isPrerelease(value: any) {
  return typeof value === 'string' && /^\d+\.\d+\.\d+-/.test(value)
}

/** `0.1.19+build5` and `0.1.19` are the same release; `0.1.19-rc1` is not. */
function releaseVersion(value: any) {
  if (!isSemverLike(value) || isPrerelease(value)) return null
  return String(value).split('+')[0]
}

/** True when both strings name the same published release (build metadata ignored). */
export function isSameRelease(left: any, right: any) {
  const a = releaseVersion(left)
  const b = releaseVersion(right)
  return a !== null && a === b
}

/**
 * Semver-correct floor comparison: a prerelease of the floor is below it.
 * `cmpVersion` intentionally ignores prerelease tags (used for display/order
 * only), so floor checks must not rely on it alone.
 */
export function isVersionBelow(installed: any, minimum: any) {
  if (!isSemverLike(installed) || !isSemverLike(minimum)) return true
  const base = cmpVersion(installed, minimum)
  if (base !== 0) return base < 0
  return isPrerelease(installed) && !isPrerelease(minimum)
}

/** Compare two semver strings (prerelease ignored). Returns -1 | 0 | 1. */
export function cmpVersion(a: string, b: string) {
  const parse = (value: string) =>
    String(value)
      .split(/[-+]/)[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const left = parse(a)
  const right = parse(b)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

/** Platform-specific venv layout. */
export function venvLayout(dir: string, platform: string = process.platform) {
  const windows = platform === 'win32'
  return {
    dir,
    python: windows ? path.join(dir, 'Scripts', 'python.exe') : path.join(dir, 'bin', 'python'),
    binDir: windows ? path.join(dir, 'Scripts') : path.join(dir, 'bin'),
  }
}

export function installSpec(
  minimumVersion = DEFAULT_MINIMUM_VERSION,
  mode: PackageMode = DEFAULT_PACKAGE_MODE,
  pinnedVersion = PINNED_VERSION,
) {
  const target = installTargetVersion(minimumVersion, mode, pinnedVersion)
  return mode === 'latest' ? `${PACKAGE_NAME}>=${target}` : `${PACKAGE_NAME}==${target}`
}

/**
 * The version an install should land on. Pinned installs stay on the validated
 * version; an explicit floor above the pin is rejected by `runInstall` (see
 * `isFloorAbovePin`) rather than silently installing an untested release.
 */
export function installTargetVersion(
  minimumVersion = DEFAULT_MINIMUM_VERSION,
  mode: PackageMode = DEFAULT_PACKAGE_MODE,
  pinnedVersion = PINNED_VERSION,
) {
  if (mode === 'latest') return minimumVersion
  return cmpVersion(pinnedVersion, minimumVersion) >= 0 ? pinnedVersion : minimumVersion
}

/** Whether `version` is one this plugin was validated against (exact release). */
export function isVerifiedVersion(version: any, verifiedVersions: any = DEFAULT_VERIFIED_VERSIONS) {
  const list = Array.isArray(verifiedVersions) && verifiedVersions.length ? verifiedVersions : DEFAULT_VERIFIED_VERSIONS
  const release = releaseVersion(version)
  if (!release) return false
  return list.some((candidate: any) => releaseVersion(candidate) === release)
}

/** Install policy recorded in a config object (`pinned` unless explicitly `latest`). */
export function packageMode(cfg?: any): PackageMode {
  return cfg?.package?.mode === 'latest' ? 'latest' : 'pinned'
}

/**
 * A pinned install cannot satisfy a floor above the tested pin: it would have to
 * install a version the plugin never tested. Callers (installer, status hints)
 * must refuse instead of silently pinning to the floor.
 */
export function isFloorAbovePin(minimumVersion: any = DEFAULT_MINIMUM_VERSION, pinnedVersion = PINNED_VERSION) {
  return isSemverLike(minimumVersion) && cmpVersion(minimumVersion, pinnedVersion) > 0
}
