#!/usr/bin/env node
/**
 * Commit-message gate for @monsterlee/dsh-vibe-trading.
 *
 *   node scripts/dev/check-commit.mjs message <file>          # commit-msg hook
 *   node scripts/dev/check-commit.mjs range <base>..<head> [--strict]
 *
 * Enforces the conventional-commit format that drives automatic releases, and
 * requires a `Release-Gate: verified` footer when the staged changes touch the
 * release risk surface (prompt/, worker/, toolsets.json, client.js, engines.dsh).
 *
 * The hook can be bypassed with `SKIP_COMMIT_HOOK=1 git commit ...`; the release
 * workflow still refuses to publish an unverified risky change.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  POLICY,
  ROOT,
  collectCommits,
  detectPackageFieldChanges,
  isKnownType,
  matchRiskyPaths,
  parseCommit,
  parseVersion,
  compareVersions,
} from './release-plan.mjs'

const CONVENTIONAL_HINT =
  'expected "<type>(<scope>)!: <description>" with type in: ' + Object.keys(POLICY.types).join(', ')

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim()
}

function stagedChanges() {
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
    .split('\n')
    .filter(Boolean)
  const enginesChanged =
    files.includes('package.json') &&
    detectPackageFieldChanges(git(['diff', '--cached', '-U0', '--', 'package.json'])).includes('engines.dsh')
  return { files, enginesChanged }
}

function currentVersion() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version ?? null
  } catch {
    return null
  }
}

export function validateMessage(
  message,
  { riskyFiles = [], enginesChanged = false, version = currentVersion(), policy = POLICY } = {},
) {
  const parsed = parseCommit({ message })
  const errors = []
  const warnings = []

  if (parsed.skip && parsed.skipReason === 'merge/fixup/release commit') {
    // Merge/fixup/squash commits and the bot's own `chore(release):` commits are
    // machine-generated; the release planner ignores them too.
    return { ok: true, errors, warnings, parsed }
  }

  if (!parsed.subject) {
    errors.push('commit message is empty')
    return { ok: false, errors, warnings, parsed }
  }

  if (!parsed.conventional) {
    errors.push(`commit subject is not conventional; ${CONVENTIONAL_HINT}`)
  } else if (!isKnownType(parsed.type, policy)) {
    errors.push(`unknown commit type "${parsed.type}"; ${CONVENTIONAL_HINT}`)
  }

  if (parsed.description.trim().length < 3) {
    errors.push('commit description is too short (need at least 3 characters)')
  }
  if (parsed.subject.length > 100) {
    errors.push(`commit subject is ${parsed.subject.length} characters; keep it under 100`)
  } else if (parsed.subject.length > 72) {
    warnings.push(`commit subject is ${parsed.subject.length} characters; 72 is the conventional limit`)
  }

  if (parsed.releaseAs) {
    if (!parseVersion(parsed.releaseAs)) {
      errors.push(`Release-As must be x.y.z, got "${parsed.releaseAs}"`)
    } else if (version && compareVersions(parsed.releaseAs, version) <= 0) {
      errors.push(`Release-As ${parsed.releaseAs} must be greater than the current version ${version}`)
    }
  }

  const risky = [...matchRiskyPaths(riskyFiles, policy.riskyPaths)]
  if (enginesChanged) risky.push('package.json#engines.dsh')
  if (risky.length > 0 && !parsed.gate) {
    errors.push(
      [
        `release risk surface changed (${risky.join(', ')}) but the commit has no "Release-Gate: verified" footer.`,
        'Load skill `release-gate`, run pnpm verify:all + parity + real-session/UI smoke, then add a footer:',
        '  Release-Gate: verified (verify:all; parity; smoke: <scenario>; ui: <page>)',
        'Emergency bypass (the release workflow will still refuse): SKIP_COMMIT_HOOK=1 git commit ...',
      ].join('\n'),
    )
  }

  return { ok: errors.length === 0, errors, warnings, parsed }
}

function report({ errors, warnings }) {
  for (const warning of warnings) console.error(`commit-check: warning: ${warning}`)
  for (const error of errors) console.error(`commit-check: ${error}`)
}

function runMessage(file) {
  if (process.env.SKIP_COMMIT_HOOK) {
    console.error('commit-check: skipped because SKIP_COMMIT_HOOK is set')
    return 0
  }
  if (!existsSync(file)) return 0

  const staged = stagedChanges()
  const result = validateMessage(readFileSync(file, 'utf8'), {
    riskyFiles: staged.files,
    enginesChanged: staged.enginesChanged,
  })
  report(result)
  return result.ok ? 0 : 1
}

function runRange(range, { strict = false } = {}) {
  const [base, head = 'HEAD'] = String(range).split('..')
  if (!base || !head) throw new Error('expected <base>..<head>')
  // `github.event.before` is all zeros for a new branch; that is the empty tree.
  const from = /^0+$/.test(base) ? '4b825dc642cb6eb9a060e54bf8d69288fbee4904' : base
  const commits = collectCommits(from, head)
  const failures = []
  for (const commit of commits) {
    const result = validateMessage(commit.message, { riskyFiles: [], enginesChanged: false })
    for (const warning of result.warnings) console.error(`commit-check: warning: ${commit.sha.slice(0, 7)}: ${warning}`)
    for (const error of result.errors) {
      console.error(`commit-check: ${commit.sha.slice(0, 7)}: ${error.split('\n')[0]}`)
      failures.push(error)
    }
  }
  if (failures.length === 0) {
    console.log(`commit-check: ${commits.length} commit(s) look conventional`)
    return 0
  }
  console.error(`commit-check: ${failures.length} problem(s); ${strict ? 'failing' : 'warnings only'}`)
  return strict ? 1 : 0
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const [command = 'message', first, ...rest] = process.argv.slice(2)
  try {
    if (command === 'message' && first) process.exitCode = runMessage(first)
    else if (command === 'range' && first) process.exitCode = runRange(first, { strict: rest.includes('--strict') })
    else {
      console.error('usage: check-commit.mjs message <file> | range <base>..<head> [--strict]')
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`commit-check: ${error.message}`)
    process.exitCode = 1
  }
}
