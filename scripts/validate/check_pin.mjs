#!/usr/bin/env node
/**
 * Version-pin consistency check (read-only, no subprocesses).
 *
 * The plugin is built and tested against exactly one `vibe-trading-ai` release
 * (PINNED_VERSION in src/lib/config.ts). Everything that records or consumes
 * that version must agree, otherwise "tested" stops meaning anything:
 *
 *   - src/lib/config.ts          PINNED_VERSION            (source of truth)
 *   - pyproject.toml             dev dependency            (== pin)
 *   - uv.lock                    dev lock                  (== pin)
 *   - _vendor/Vibe-Trading       reference checkout        (tag v<pin>)
 *   - scripts/env/*.json, scripts/validate/worker-check.json,
 *     scripts/validate/mcp-surface.json
 *                                captured surfaces         (warn when stale)
 *   - ~/.vibe-trading/dsh/venv   runtime install           (warn when it differs)
 *
 * Hard failures are the three things a developer controls locally; runtime and
 * captured artifacts are warnings because CI machines may not have them.
 *
 * Everything is read straight from files (no `git`/`python` child processes):
 * DSH's Windows sandbox forbids piped stdio, and file reads work everywhere.
 *
 * Usage: node scripts/validate/check_pin.mjs [--strict]
 *   --strict turns warnings into a non-zero exit (CI gate).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

// Resolve the repository root from this file, not from the caller's cwd.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const strict = process.argv.includes('--strict')
const results = []
const failures = []

function pass(name, detail) {
  results.push(['PASS', `${name}: ${detail}`])
}

function warn(name, detail) {
  results.push(['WARN', `${name}: ${detail}`])
}

function fail(name, detail) {
  results.push(['FAIL', `${name}: ${detail}`])
  failures.push(name)
}

function readOptional(relative) {
  try {
    return readFileSync(path.join(root, relative), 'utf8')
  } catch {
    return null
  }
}

function listDir(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/* ------------------------------------------------------------------------- */
/* Source of truth                                                            */
/* ------------------------------------------------------------------------- */

const configSource = readOptional('src/lib/config.ts')
const pinned = configSource ? /export const PINNED_VERSION = '([^']+)'/.exec(configSource)?.[1] : undefined
if (!configSource) {
  fail('config', 'src/lib/config.ts not found (run from the repository root)')
} else if (!pinned) {
  fail('config', 'PINNED_VERSION not found in src/lib/config.ts')
} else {
  pass('config', `PINNED_VERSION = ${pinned}`)
}
if (configSource) {
  // The floor must not drift below the pin, or an old release would pass `on`.
  const floor = /export const DEFAULT_MINIMUM_VERSION = ([^\s]+)/.exec(configSource)?.[1]
  if (floor === 'PINNED_VERSION') pass('config', 'DEFAULT_MINIMUM_VERSION follows PINNED_VERSION')
  else fail('config', `DEFAULT_MINIMUM_VERSION is ${floor ?? 'missing'}; it must follow PINNED_VERSION`)
}
if (!pinned) {
  finish()
  process.exit(1)
}

/* ------------------------------------------------------------------------- */
/* Dev dependency + lock                                                      */
/* ------------------------------------------------------------------------- */

const pyproject = readOptional('pyproject.toml')
const devPin = pyproject ? /"vibe-trading-ai==([^"]+)"/.exec(pyproject)?.[1] : undefined
if (!pyproject) fail('pyproject.toml', 'missing (run from the repository root)')
else if (!devPin) fail('pyproject.toml', 'vibe-trading-ai==<version> not found in dev dependencies')
else if (devPin !== pinned) fail('pyproject.toml', `dev pin ${devPin} != PINNED_VERSION ${pinned}`)
else pass('pyproject.toml', `dev pin == ${pinned}`)

const lock = readOptional('uv.lock')
if (!lock) {
  warn('uv.lock', 'missing (uv project not synced?)')
} else {
  // Tolerate a CRLF checkout (core.autocrlf on Windows without .gitattributes).
  const locked = /name = "vibe-trading-ai"\r?\nversion = "([^"]+)"/.exec(lock)?.[1]
  if (!locked) warn('uv.lock', 'vibe-trading-ai entry not found (run uv lock)')
  else if (locked !== pinned) fail('uv.lock', `locked ${locked} != PINNED_VERSION ${pinned} (run uv lock / uv sync)`)
  else pass('uv.lock', `locked == ${pinned}`)
}

/* ------------------------------------------------------------------------- */
/* _vendor reference clone (pure .git ref parsing)                            */
/* ------------------------------------------------------------------------- */

/** Resolve `refs/...` values from loose refs plus packed-refs, honouring worktrees. */
function readGitRefs(gitDir) {
  const refs = new Map()
  const peeled = new Map()
  const dirs = [gitDir]
  try {
    const commonDir = readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    if (commonDir) dirs.push(path.resolve(gitDir, commonDir))
  } catch {
    /* not a worktree */
  }

  const addLoose = (dir, prefix) => {
    for (const entry of listDir(dir)) {
      const full = path.join(dir, entry)
      const refName = prefix ? `${prefix}/${entry}` : entry
      let stats
      try {
        stats = statSync(full)
      } catch {
        continue
      }
      if (stats.isDirectory()) addLoose(full, refName)
      else if (stats.isFile()) {
        try {
          refs.set(refName, readFileSync(full, 'utf8').trim())
        } catch {
          /* unreadable ref: ignore */
        }
      }
    }
  }

  for (const dir of dirs) {
    addLoose(path.join(dir, 'refs'), 'refs')
    let packed = ''
    try {
      packed = readFileSync(path.join(dir, 'packed-refs'), 'utf8')
    } catch {
      /* no packed refs */
    }
    let previous = ''
    for (const raw of packed.split(/\r?\n/)) {
      const line = raw.trim()
      if (!line || line.startsWith('#')) continue
      if (line.startsWith('^')) {
        // Peeled value of an annotated tag: this is the commit to compare with HEAD.
        if (previous) peeled.set(previous, line.slice(1).trim())
        continue
      }
      const match = /^([0-9a-f]{40})\s+(refs\/\S+)$/.exec(line)
      if (match) {
        if (!refs.has(match[2])) refs.set(match[2], match[1])
        previous = match[2]
      }
    }
  }
  return { refs, peeled, dirs }
}

/** First bytes of a loose object tell us whether it is a commit or an annotated tag. */
function looseObjectType(gitDirs, sha) {
  for (const dir of gitDirs) {
    const file = path.join(dir, 'objects', sha.slice(0, 2), sha.slice(2))
    try {
      const body = inflateSync(readFileSync(file))
      const nul = body.indexOf(0)
      if (nul < 0) continue
      return body.subarray(0, nul).toString('utf8').split(' ')[0]
    } catch {
      /* packed object or unreadable: unknown */
    }
  }
  return null
}

function inspectVendor() {
  const vendor = path.join(root, '_vendor', 'Vibe-Trading')
  if (!existsSync(vendor)) {
    return {
      status: 'warn',
      detail: `absent (not required to build; clone it at tag v${pinned} before porting prompt/grounding source)`,
    }
  }
  let gitDir = path.join(vendor, '.git')
  try {
    if (statSync(gitDir).isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))?.[1]
      if (pointer) gitDir = path.resolve(vendor, pointer.trim())
    }
  } catch {
    return { status: 'warn', detail: 'not a git checkout (.git missing)' }
  }

  let headRaw = ''
  try {
    headRaw = readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim()
  } catch {
    return { status: 'warn', detail: 'HEAD unreadable' }
  }
  const { refs, peeled, dirs } = readGitRefs(gitDir)
  const headRef = /^ref:\s*(.+)$/.exec(headRaw)?.[1]
  const headSha = headRef ? refs.get(headRef) : headRaw
  const headLabel = headRef ?? `${headRaw.slice(0, 8)} (detached)`
  const tagRef = `refs/tags/v${pinned}`
  const tagSha = refs.get(tagRef)

  if (!tagSha) {
    return {
      status: 'warn',
      detail: `tag v${pinned} not found locally; run: git -C _vendor/Vibe-Trading fetch --tags`,
    }
  }
  const tagCommit = peeled.get(tagRef) ?? tagSha
  if (!headSha) {
    return { status: 'warn', detail: `tag v${pinned} exists but HEAD ${headLabel} could not be resolved` }
  }
  if (headSha === tagCommit) return { status: 'pass', detail: `HEAD at tag v${pinned}` }

  // An unpeeled annotated tag would store a tag-object id, not the commit id; we
  // cannot fail on that without git. Loose tag objects are detectable.
  if (tagCommit === tagSha && looseObjectType(dirs, tagSha) === 'tag') {
    return {
      status: 'warn',
      detail: `tag v${pinned} is annotated and could not be peeled from .git; confirm with: git -C _vendor/Vibe-Trading describe --tags --always`,
    }
  }
  return {
    status: 'fail',
    detail:
      `HEAD is ${headLabel} (${headSha.slice(0, 8)}), tag v${pinned} is ${tagCommit.slice(0, 8)} — ` +
      `checkout the pinned tag: git -C _vendor/Vibe-Trading fetch --tags && ` +
      `git -C _vendor/Vibe-Trading checkout v${pinned}`,
  }
}

const vendor = inspectVendor()
if (vendor.status === 'pass') pass('_vendor/Vibe-Trading', vendor.detail)
else if (vendor.status === 'warn') warn('_vendor/Vibe-Trading', vendor.detail)
else fail('_vendor/Vibe-Trading', vendor.detail)

/* ------------------------------------------------------------------------- */
/* Captured surfaces (warn-only)                                              */
/* ------------------------------------------------------------------------- */

const captures = [
  [
    'scripts/env/loading-metrics.json',
    /"package_version"\s*:\s*"([^"]+)"/,
    'uv run python scripts/env/measure_loading.py',
  ],
  [
    'scripts/validate/worker-check.json',
    /"vibe_trading_version"\s*:\s*"([^"]+)"/,
    'pnpm check:worker',
  ],
  [
    'scripts/validate/mcp-surface.json',
    /"vibe_trading_version"\s*:\s*"([^"]+)"/,
    'pnpm capture:mcp',
  ],
]
for (const [file, pattern, recapture] of captures) {
  const source = readOptional(file)
  if (source === null) {
    warn(file, 'missing')
    continue
  }
  const captured = pattern.exec(source)?.[1]
  if (!captured) warn(file, 'captured version not found')
  else if (captured !== pinned) {
    warn(file, `captured at ${captured}, pin is ${pinned} — recapture with: ${recapture}`)
  } else {
    pass(file, `captured at ${pinned}`)
  }
}

/* ------------------------------------------------------------------------- */
/* Runtime venv (warn-only, read the installed dist-info)                     */
/* ------------------------------------------------------------------------- */

function sitePackages(venv) {
  const dirs = []
  if (process.platform === 'win32') dirs.push(path.join(venv, 'Lib', 'site-packages'))
  for (const entry of listDir(path.join(venv, 'lib'))) {
    if (/^python\d+\.\d+$/.test(entry)) dirs.push(path.join(venv, 'lib', entry, 'site-packages'))
  }
  dirs.push(path.join(venv, 'Lib', 'site-packages'))
  return [...new Set(dirs)].filter((dir) => existsSync(dir))
}

function installedFromDistInfo(venv) {
  for (const dir of sitePackages(venv)) {
    const match = listDir(dir).find((entry) => /^vibe_trading_ai-[^-]+.*\.dist-info$/.test(entry))
    if (!match) continue
    try {
      const version = /^Version:\s*(.+)$/m.exec(readFileSync(path.join(dir, match, 'METADATA'), 'utf8'))?.[1]
      if (version) return version.trim()
    } catch {
      /* fall through to the next site-packages */
    }
  }
  return null
}

function vibeHome() {
  const override = process.env.VIBE_TRADING_HOME
  if (override && override.trim()) return path.resolve(override)
  const home = process.env.HOME || process.env.USERPROFILE
  return home ? path.join(home, '.vibe-trading') : null
}

const venv = vibeHome() ? path.join(vibeHome(), 'dsh', 'venv') : null
if (!venv || !existsSync(venv)) {
  warn('runtime venv', `not installed (${venv ?? 'no home'}) — /vibe-trading init creates it`)
} else {
  const installed = installedFromDistInfo(venv)
  if (!installed) warn('runtime venv', 'vibe-trading-ai dist-info not found')
  else if (installed === pinned) pass('runtime venv', `vibe-trading-ai ${installed}`)
  else warn('runtime venv', `vibe-trading-ai ${installed} != pin ${pinned} — /vibe-trading init --pinned reinstalls the pin`)
}

/* ------------------------------------------------------------------------- */

function finish() {
  for (const [status, detail] of results) console.log(`${status}  ${detail}`)
  console.log('')
  const warnings = results.filter(([status]) => status === 'WARN').length
  if (failures.length) {
    console.error(`${failures.length} pin check(s) failed: ${failures.join(', ')}`)
    return
  }
  if (strict && warnings > 0) {
    console.error(`${warnings} warning(s) treated as failures because --strict was passed`)
    process.exitCode = 1
    return
  }
  console.log(
    `pin check passed (PINNED_VERSION ${pinned}); ${warnings} warning(s)${warnings ? ' are informational' : ''}`,
  )
}

finish()
if (failures.length) process.exit(1)
