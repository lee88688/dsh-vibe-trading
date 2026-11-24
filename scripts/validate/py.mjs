#!/usr/bin/env node
/**
 * Cross-platform Python runner for the local validation scripts.
 *
 * Resolution order:
 *   1. $VIBE_TRADING_PYTHON (explicit override)
 *   2. the repo venv (.venv/ created by `uv sync`)
 *   3. the installed Vibe-Trading venv created by /vibe-trading init
 *   4. python3 / python on PATH
 *
 * Usage: node scripts/validate/py.mjs <script.py> [args...]
 */
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, platform } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const isWindows = platform() === 'win32'

function venvPython(base) {
  const candidates = isWindows
    ? [path.join(base, 'Scripts', 'python.exe'), path.join(base, 'Scripts', 'python')]
    : [path.join(base, 'bin', 'python3'), path.join(base, 'bin', 'python')]
  return candidates.find((candidate) => existsSync(candidate))
}

function resolvePython() {
  const override = process.env.VIBE_TRADING_PYTHON
  if (override) return override
  // Repo venv first (uv project, pinned by uv.lock), then the installed runtime
  // venv created by /vibe-trading init.
  const project = venvPython(path.join(root, '.venv'))
  if (project) return project
  const installed = venvPython(path.join(homedir(), '.vibe-trading', 'dsh', 'venv'))
  if (installed) return installed
  for (const name of isWindows ? ['python', 'py'] : ['python3', 'python']) {
    const probe = spawnSync(name, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
    if (probe.status === 0) return name
  }
  return null
}

const [script, ...args] = process.argv.slice(2)
if (!script) {
  console.error('usage: node scripts/validate/py.mjs <script.py> [args...]')
  process.exit(2)
}
const python = resolvePython()
if (!python) {
  console.error(
    'no Python interpreter found. Run `uv sync` (or set VIBE_TRADING_PYTHON), or /vibe-trading init for the runtime venv.',
  )
  process.exit(2)
}
const result = spawnSync(python, [script, ...args], { stdio: 'inherit', cwd: root })
process.exit(result.status ?? 1)
