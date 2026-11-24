/**
 * Read-only preflight for `/vibe-trading init`.
 *
 * Detects the platform, disk space, writability, an existing config, every
 * usable Python interpreter (system → uv-managed → DSH bundled), and the keys
 * present in Vibe-Trading's own `.env` (names only, never values).
 *
 * Never writes anything except a temporary probe file inside the plugin data
 * directory (created on demand and removed again).
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  DEFAULT_MINIMUM_VERSION,
  DEFAULT_PACKAGE_MODE,
  DEFAULT_VERIFIED_VERSIONS,
  PINNED_VERSION,
  PACKAGE_NAME,
  configPath,
  dshDataDir,
  homeDir,
  installTargetVersion,
  isFloorAbovePin,
  isVerifiedVersion,
  isVersionBelow,
  readConfig,
  resolveVibeHome,
  venvDir,
  venvLayout,
} from './config.js'
import { pythonProbe, tryExec } from './exec.js'

const MIN_DISK_BYTES = 1024 ** 3 // 1 GiB

const PROBE_CODE = [
  'import sys',
  'print(sys.version.split()[0])',
  'import venv',
].join('\n')

const VERSION_CODE = [
  'import importlib.metadata as m',
  `print(m.version(${JSON.stringify(PACKAGE_NAME)}))`,
].join('\n')

/* ------------------------------------------------------------------------- */
/* Candidate discovery                                                        */
/* ------------------------------------------------------------------------- */

function commonWindowsPythonDirs(env: any) {
  const roots: Array<string | null> = [
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Programs', 'Python') : null,
    env.ProgramFiles ? path.join(env.ProgramFiles, 'Python') : null,
    'C:\\Python312',
    'C:\\Python311',
    'C:\\Python310',
  ].filter(Boolean)
  const dirs: any[] = []
  for (const root of roots as string[]) {
    dirs.push({ exe: path.join(root, 'python.exe'), via: 'dir' })
  }
  return dirs
}

function condaCandidates(env: any) {
  const roots: Array<string | null> = [
    env.CONDA_PREFIX,
    env.USERPROFILE ? path.join(env.USERPROFILE, 'miniconda3') : null,
    env.USERPROFILE ? path.join(env.USERPROFILE, 'anaconda3') : null,
    env.HOME ? path.join(env.HOME, 'miniconda3') : null,
    env.HOME ? path.join(env.HOME, 'anaconda3') : null,
  ].filter(Boolean)
  const candidates: any[] = []
  for (const root of roots as string[]) {
    candidates.push({ exe: path.join(root, 'python.exe'), via: 'conda' })
    candidates.push({ exe: path.join(root, 'bin', 'python'), via: 'conda' })
  }
  return candidates
}

export function dshBundledPythonCandidates(env = process.env) {
  const home = homeDir(env)
  const base = path.join(home, '.dsh', 'dsh-runtimes')
  return { base, exeRel: path.join('dependencies', 'python', 'python.exe'), exeRelPosix: path.join('dependencies', 'python', 'bin', 'python') }
}

async function exists(file: string) {
  try {
    await fsp.access(file)
    return true
  } catch {
    return false
  }
}

async function probeInterpreter(exe: string, via: string, env: any) {
  const probe = await pythonProbe(exe, PROBE_CODE, { env })
  if (!probe.ok) return { exe, via, ok: false, version: null, reason: probe.detail || 'probe failed' }
  const version = String(probe.value ?? '')
  const parts = version.split('.').map((value) => Number.parseInt(value, 10) || 0)
  const suitable = parts[0] === 3 && parts[1] >= 11
  return {
    exe,
    via,
    ok: suitable,
    version,
    reason: suitable ? null : `Python ${version} is unsupported (need >= 3.11)`,
  }
}

async function findUv(env: any) {
  const result = await tryExec('uv', ['--version'], { env, timeoutMs: 10_000 })
  if (!result.ok) return null
  const version = (result.stdout || '').trim().split(/\s+/)[1] ?? null
  return { exe: 'uv', version }
}

async function findBundledPythons(env: any) {
  const { base, exeRel, exeRelPosix } = dshBundledPythonCandidates(env)
  let entries: any[] = []
  try {
    entries = await fsp.readdir(base, { withFileTypes: true })
  } catch {
    return []
  }
  const candidates: any[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const runtimeDir = path.join(base, entry.name)
    for (const rel of [exeRel, exeRelPosix]) {
      const exe = path.join(runtimeDir, rel)
      if (await exists(exe)) {
        candidates.push({ exe, via: 'dsh-bundled' })
        break
      }
    }
  }
  return candidates
}

/**
 * Every interpreter candidate in priority order: system → uv-managed → DSH bundled.
 * Each entry: { exe, via, ok, version, reason }
 */
export async function findPythons(env = process.env, extraCandidates: any[] = []) {
  const raw: any[] = []
  const seen = new Set()
  const push = (exe: string, via: string) => {
    if (!exe) return
    const key = path.normalize(exe).toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    raw.push({ exe, via })
  }

  // 0) explicit candidates (e.g. a user-supplied interpreter path).
  for (const entry of extraCandidates) push(entry.exe, entry.via ?? 'explicit')

  // 1) system: PATH names first, then the Windows/conda well-known locations.
  for (const name of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    push(name, 'system')
  }
  if (process.platform === 'win32') {
    for (const entry of commonWindowsPythonDirs(env)) push(entry.exe, 'system')
  }
  for (const entry of condaCandidates(env)) push(entry.exe, entry.via)

  // 2) uv-managed interpreters (best effort; uv may need a writable cache).
  const uv = await findUv(env)
  if (uv) {
    const found: any = await tryExec('uv', ['python', 'find', '3.12'], { env, timeoutMs: 20_000 })
    if (found.ok) {
      const exe = ((found as any).stdout || '').trim().split(/\r?\n/).pop()
      if (exe) push(exe, 'uv')
    }
  }

  // 3) DSH's bundled Python (present only in some DSH distributions).
  for (const entry of await findBundledPythons(env)) push(entry.exe, 'dsh-bundled')

  const probed: any[] = []
  for (const candidate of raw) {
    const result = await probeInterpreter(candidate.exe, candidate.via, env)
    probed.push(result)
  }
  return { uv, candidates: probed }
}

/* ------------------------------------------------------------------------- */
/* Misc checks                                                                */
/* ------------------------------------------------------------------------- */

async function checkDisk(target: string) {
  try {
    const stats = await fsp.statfs(target)
    const freeBytes = Number(stats.bavail) * Number(stats.bsize)
    return { ok: freeBytes >= MIN_DISK_BYTES, freeBytes, freeGb: Math.round((freeBytes / 1024 ** 3) * 10) / 10 }
  } catch (error: any) {
    return { ok: true, freeBytes: null, freeGb: null, note: String(error?.message ?? error) }
  }
}

async function checkWritable(dir: string) {
  try {
    await fsp.mkdir(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`)
    await fsp.writeFile(probe, 'ok', 'utf8')
    await fsp.rm(probe, { force: true })
    return { ok: true }
  } catch (error: any) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

async function readDotEnvKeys(vibeHome: string) {
  const file = path.join(vibeHome, '.env')
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const keys: any[] = []
    for (const line of raw.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/)
      if (match) keys.push(match[1])
    }
    return { file, keys: [...new Set(keys)].sort() }
  } catch {
    return { file, keys: [] }
  }
}

async function installedVersion(env: any, layout: any) {
  if (!(await exists(layout.python))) return { ok: false, version: null, reason: 'venv python missing' }
  const probe = await pythonProbe(layout.python, VERSION_CODE, { env })
  if (!probe.ok) return { ok: false, version: null, reason: probe.detail || 'package not installed' }
  return { ok: true, version: probe.value, reason: null }
}

/* ------------------------------------------------------------------------- */
/* Preflight                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * @returns {Promise<{
 *   ok: boolean,
 *   status: 'ready'|'needs-install'|'needs-help',
 *   checks: Array<{id: string, ok: boolean, detail: string, hint?: string}>,
 *   env: object, vibeHome: string, dataDir: string,
 *   config: object|null, configError: string|null,
 *   uv: object|null, pythons: Array<object>,
 *   venv: { python: string, exists: boolean, installedVersion: string|null, layout: object },
 *   disk: object, dotenv: object,
 * }>}
 */
export async function runPreflight(options: any = {}) {
  const env = options.env ?? process.env
  const minimumVersion = options.minimumVersion ?? DEFAULT_MINIMUM_VERSION
  const pinnedVersion = options.pinnedVersion ?? PINNED_VERSION
  const verifiedVersions = Array.isArray(options.verifiedVersions) && options.verifiedVersions.length
    ? options.verifiedVersions
    : [...DEFAULT_VERIFIED_VERSIONS]
  const vibeHome = resolveVibeHome(env)
  const dataDir = dshDataDir(env)
  const layout = venvLayout(venvDir(env))

  const checks: any[] = []
  const add = (id: string, ok: boolean, detail: string, hint?: string) => checks.push({ id, ok, detail, ...(hint ? { hint } : {}) })

  // platform
  const platformOk = ['win32', 'darwin', 'linux'].includes(process.platform)
  add('platform', platformOk, `${process.platform}/${process.arch}`, platformOk ? undefined : 'unsupported platform')

  // disk + writability
  const disk = await checkDisk(vibeHome)
  add('disk', disk.ok, disk.freeGb === null ? 'unknown' : `${disk.freeGb} GB free`, disk.ok ? undefined : 'need >= 1 GB')
  const writable = await checkWritable(dataDir)
  add('writable', writable.ok, writable.ok ? dataDir : String(writable.reason ?? ''), writable.ok ? undefined : 'cannot create the plugin data directory')

  // existing config
  const existing = await readConfig(env)
  add(
    'config',
    Boolean(existing.config),
    existing.config ? configPath(env) : (existing.error ?? 'not initialized'),
    existing.config ? undefined : 'run /vibe-trading init',
  )

  // interpreters
  const { uv, candidates } = await findPythons(env, options.extraCandidates ?? [])
  const usable = candidates.filter((candidate) => candidate.ok)
  add(
    'python',
    usable.length > 0,
    usable.length ? usable.map((item) => `${item.via}:${item.version}`).join(', ') : 'no usable Python >= 3.11',
    usable.length ? undefined : 'install Python 3.12 or uv, then re-run init',
  )
  add('uv', Boolean(uv), uv ? `${uv.exe} ${uv.version ?? ''}`.trim() : 'not found', undefined)

  // venv / installed package
  const venvExists = await exists(layout.python)
  const installed = await installedVersion(env, layout)
  const versionOk =
    installed.ok && installed.version && !isVersionBelow(installed.version, minimumVersion)
  const verified = Boolean(installed.ok && installed.version && isVerifiedVersion(installed.version, verifiedVersions))
  const pinnedTarget = installTargetVersion(minimumVersion, DEFAULT_PACKAGE_MODE, pinnedVersion)
  const packageHint = isFloorAbovePin(minimumVersion, pinnedVersion)
    ? `minimumVersion ${minimumVersion} > pin ${pinnedVersion}; use /vibe-trading init --latest`
    : `install ${PACKAGE_NAME}==${pinnedTarget}`
  add(
    'package',
    Boolean(versionOk),
    installed.ok
      ? `${PACKAGE_NAME} ${installed.version}${verified ? '' : '（未验证）'}`
      : (installed.reason ?? 'not installed'),
    versionOk ? undefined : packageHint,
  )

  const dotenv = await readDotEnvKeys(vibeHome)
  add('dotenv', dotenv.keys.length > 0, dotenv.keys.length ? `${dotenv.keys.length} key(s) in ${dotenv.file}` : `no .env at ${dotenv.file}`)

  const ready = Boolean(existing.config) && versionOk && usable.length > 0
  const canInstall = usable.length > 0 && writable.ok && disk.ok
  const status = ready ? 'ready' : canInstall ? 'needs-install' : 'needs-help'

  return {
    ok: ready,
    status,
    checks,
    env: {
      platform: process.platform,
      arch: process.arch,
      home: homeDir(env),
      node: process.version,
    },
    vibeHome,
    dataDir,
    config: existing.config,
    configError: existing.error,
    uv,
    pythons: candidates,
    venv: {
      layout,
      exists: venvExists,
      installedVersion: installed.version,
      installedOk: installed.ok,
      verified,
    },
    disk,
    dotenv,
    minimumVersion,
    pinnedVersion,
    verifiedVersions,
  }
}

/** Human-readable one-paragraph summary used in command results and agent handoff. */
export function summarizePreflight(report: any) {
  const lines: any[] = []
  lines.push(`status: ${report.status}`)
  lines.push(`vibeHome: ${report.vibeHome}`)
  if (report.pinnedVersion) {
    lines.push(`pinned: ${PACKAGE_NAME} ${report.pinnedVersion}（已验证 ${(report.verifiedVersions ?? []).join(', ')}）`)
  }
  lines.push(`config: ${report.config ? configPath() : (report.configError ?? 'missing')}`)
  for (const check of report.checks) {
    lines.push(`${check.ok ? 'ok' : 'FAIL'}  ${check.id}: ${check.detail}`)
  }
  if (report.pythons?.length) {
    lines.push('python candidates:')
    for (const candidate of report.pythons) {
      lines.push(`  - ${candidate.via}: ${candidate.exe}${candidate.version ? ` (${candidate.version})` : ''}${candidate.ok ? '' : ` — ${candidate.reason}`}`)
    }
  }
  if (report.dotenv?.keys?.length) lines.push(`dotenv keys: ${report.dotenv.keys.join(', ')}`)
  return lines.join('\n')
}

export { os }
