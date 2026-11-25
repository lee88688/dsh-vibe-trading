#!/usr/bin/env node
/**
 * Release planning for @monsterlee/dsh-vibe-trading.
 *
 * One policy (release-policy.json) drives three consumers:
 *   - the commit-msg hook (scripts/dev/check-commit.mjs)
 *   - CI commit-message checks
 *   - the release workflow (this script)
 *
 * Pure analysis lives in `analyze()` so it can be unit-tested; the CLI adds the
 * git plumbing and is the only part that touches the working tree.
 *
 *   node scripts/dev/release-plan.mjs plan [--from vX.Y.Z] [--version x.y.z] [--json]
 *   node scripts/dev/release-plan.mjs notes --from vX.Y.Z [--to vA.B.C]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
export const POLICY = JSON.parse(readFileSync(path.join(HERE, 'release-policy.json'), 'utf8'))

const CONVENTIONAL = /^([a-z]+)(?:\(([^()\r\n]+)\))?(!)?: (.+)$/u
const REVERT_SUBJECT = /^Revert "(.+)"$/
const SKIP_SUBJECT = /^(Merge |fixup! |squash! |chore\(release\): )/
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export function parseVersion(value) {
  const match = VERSION.exec(String(value ?? '').trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) throw new Error(`not a version: ${!a ? left : right}`)
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch
}

export function bumpVersion(version, kind) {
  const parsed = parseVersion(version)
  if (!parsed) throw new Error(`not a version: ${version}`)
  if (kind === 'major') return `${parsed.major + 1}.0.0`
  if (kind === 'minor') return `${parsed.major}.${parsed.minor + 1}.0`
  if (kind === 'patch') return `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`
  throw new Error(`unknown bump kind: ${kind}`)
}

/** Breaking changes bump minor while the plugin is pre-1.0 (0.x semantics). */
export function breakingKind(version) {
  const parsed = parseVersion(version)
  if (!parsed) throw new Error(`not a version: ${version}`)
  return parsed.major === 0 ? 'minor' : 'major'
}

export function isKnownType(type, policy = POLICY) {
  return typeof type === 'string' && Object.prototype.hasOwnProperty.call(policy.types, type)
}

export function parseCommit({ sha = '', message = '' } = {}) {
  const cleaned = String(message)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n')
    .trim()
  const lines = cleaned.split('\n')
  const subject = (lines.shift() ?? '').trim()
  const body = lines.join('\n').trim()

  const match = CONVENTIONAL.exec(subject)
  const revert = REVERT_SUBJECT.exec(subject)
  const type = match?.[1] ?? (revert ? 'revert' : null)
  const scope = match?.[2] ?? null
  const bang = Boolean(match?.[3])
  const description = match?.[4] ?? revert?.[1] ?? subject

  const skipMarker = new RegExp(escapeRegExp(POLICY.skipMarker), 'i').test(cleaned)
  const skipSubject = SKIP_SUBJECT.test(subject)
  const skip = skipMarker || skipSubject

  const releaseAs = /^Release-As:\s*(\S+)\s*$/im.exec(cleaned)?.[1] ?? null
  const gateLine = /^Release-Gate:\s*(.+)$/im.exec(cleaned)?.[1]?.trim() ?? null
  const gate = gateLine !== null && /^verified\b/i.test(gateLine)
  const breaking = bang || /^BREAKING[ -]CHANGE:/im.test(cleaned)

  return {
    sha,
    subject,
    body,
    type,
    scope,
    description,
    breaking,
    skip,
    skipReason: skipMarker ? 'skip marker' : skipSubject ? 'merge/fixup/release commit' : null,
    releaseAs,
    gate,
    gateNote: gateLine,
    conventional: Boolean(match) || Boolean(revert),
  }
}

export function matchRiskyPaths(files, patterns = POLICY.riskyPaths) {
  const regexes = patterns.map((pattern) => {
    const source = escapeRegExp(pattern).replace(/\\\*\\\*/g, '.*').replace(/\\\*/g, '[^/]*')
    return new RegExp(`^${source}$`)
  })
  return files.filter((file) => regexes.some((regex) => regex.test(file.replace(/\\/g, '/'))))
}

/** `git diff` for package.json: did any engines.<field> line change? */
export function detectPackageFieldChanges(diff, fields = POLICY.riskyPackageFields) {
  const changed = new Set()
  for (const field of fields) {
    const name = field.includes('.') ? field.split('.').pop() : field
    const line = new RegExp(`^[+-]\\s*"${escapeRegExp(name)}"\\s*:`)
    if (diff.split('\n').some((entry) => line.test(entry.trimStart()))) changed.add(field)
  }
  return [...changed]
}

function maxKind(current, next) {
  const rank = { patch: 1, minor: 2, major: 3 }
  return rank[next] > (rank[current] ?? 0) ? next : current
}

export function buildNotes({ parsed, fromRef, toRef, repository }) {
  const contributing = parsed.filter(
    (commit) => !commit.skip && (commit.breaking || !isKnownType(commit.type) || POLICY.types[commit.type]),
  )
  const sections = [
    ['Breaking Changes', contributing.filter((commit) => commit.breaking)],
    ['Features', contributing.filter((commit) => !commit.breaking && commit.type === 'feat')],
    ['Fixes', contributing.filter((commit) => !commit.breaking && (commit.type === 'fix' || commit.type === 'revert'))],
    ['Performance', contributing.filter((commit) => !commit.breaking && commit.type === 'perf')],
    [
      'Other Changes',
      contributing.filter(
        (commit) => !commit.breaking && !['feat', 'fix', 'revert', 'perf'].includes(commit.type),
      ),
    ],
  ]

  const lines = []
  for (const [title, commits] of sections) {
    if (commits.length === 0) continue
    lines.push(`## ${title}`, '')
    for (const commit of commits) {
      const scope = commit.scope ? `**${commit.scope}**: ` : ''
      const short = commit.sha ? commit.sha.slice(0, 7) : ''
      const link = repository && short ? ` ([${short}](${repository}/commit/${commit.sha}))` : short ? ` (${short})` : ''
      lines.push(`- ${scope}${commit.description}${link}`)
    }
    lines.push('')
  }

  if (lines.length === 0) lines.push('No user-facing changes.', '')
  if (repository && fromRef && toRef) {
    lines.push(`**Full Changelog**: ${repository}/compare/${fromRef}...${toRef}`)
  }
  return lines.join('\n').trim() + '\n'
}

export function repositoryUrl(pkg) {
  const raw = String(pkg?.repository?.url ?? '')
  const match = /github\.com[/:]([^/]+)\/([^/.]+)/.exec(raw)
  return match ? `https://github.com/${match[1]}/${match[2]}` : ''
}

/**
 * Decide the next version and whether the release gate is satisfied.
 *
 * @param {object} input
 * @param {Array<{sha: string, message: string}>} input.commits commits since the last release tag
 * @param {string} input.fromVersion version of the last release tag (or 0.0.0)
 * @param {string|null} [input.packageVersion] current package.json version (manual-bump self-heal)
 * @param {string[]} [input.changedFiles] files changed since the last release tag
 * @param {boolean} [input.enginesChanged] whether engines.dsh changed since the last tag
 * @param {string|null} [input.forcedVersion] explicit version from workflow_dispatch
 */
export function analyze({
  commits = [],
  fromVersion = '0.0.0',
  packageVersion = null,
  changedFiles = [],
  enginesChanged = false,
  forcedVersion = null,
  policy = POLICY,
  repository = '',
} = {}) {
  const parsed = commits.map((commit) => parseCommit(commit))
  const warnings = []
  const reasons = []

  const riskyFiles = matchRiskyPaths(changedFiles, policy.riskyPaths)
  const gateRequired = riskyFiles.length > 0 || enginesChanged
  const evidence = parsed.find((commit) => commit.gate)?.gateNote ?? ''
  const gate = {
    required: gateRequired,
    satisfied: !gateRequired || Boolean(evidence),
    riskyFiles,
    enginesChanged,
    evidence,
  }

  let version = null
  let bump = null

  if (forcedVersion) {
    const forced = String(forcedVersion).trim()
    if (!parseVersion(forced)) throw new Error(`--version must be x.y.z, got ${forced}`)
    if (compareVersions(forced, fromVersion) <= 0) {
      throw new Error(`--version ${forced} must be greater than the last tag ${fromVersion}`)
    }
    version = forced
    bump = 'forced'
    reasons.push(`forced by dispatch input (${forced})`)
  } else if (packageVersion && compareVersions(packageVersion, fromVersion) > 0) {
    version = packageVersion
    bump = 'manual'
    reasons.push(`package.json ${packageVersion} is ahead of the last tag ${fromVersion}`)
  } else {
    let kind = null
    const releaseAsValues = new Set()

    for (const commit of parsed) {
      if (commit.skip) continue
      if (commit.releaseAs) releaseAsValues.add(commit.releaseAs)
      if (commit.breaking) kind = maxKind(kind, breakingKind(fromVersion))
      if (!isKnownType(commit.type, policy)) {
        kind = maxKind(kind, policy.unknownType)
        warnings.push(`non-conventional commit ${commit.sha.slice(0, 7)}: ${commit.subject || '(empty subject)'}`)
        continue
      }
      const policyKind = policy.types[commit.type]
      if (policyKind) kind = maxKind(kind, policyKind)
    }

    if (releaseAsValues.size > 0) {
      if (releaseAsValues.size > 1) {
        throw new Error(`conflicting Release-As values: ${[...releaseAsValues].join(', ')}`)
      }
      const requested = [...releaseAsValues][0]
      if (!parseVersion(requested)) throw new Error(`Release-As must be x.y.z, got ${requested}`)
      if (compareVersions(requested, fromVersion) <= 0) {
        throw new Error(`Release-As ${requested} must be greater than the last tag ${fromVersion}`)
      }
      version = requested
      bump = 'release-as'
      reasons.push(`forced by Release-As footer (${requested})`)
    } else if (kind) {
      version = bumpVersion(fromVersion, kind)
      bump = kind
      reasons.push(`${kind} bump from conventional commits`)
    }
  }

  const notes = buildNotes({
    parsed,
    fromRef: fromVersion === '0.0.0' ? null : `v${fromVersion}`,
    toRef: version ? `v${version}` : null,
    repository,
  })

  return {
    releasable: Boolean(version),
    version,
    bump,
    fromVersion,
    packageVersion,
    reasons,
    warnings,
    gate,
    riskFiles: riskyFiles,
    commits: parsed,
    notes,
  }
}

function git(args) {
  return execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }).trim()
}

function lastTag(to = 'HEAD') {
  try {
    return git(['describe', '--tags', '--abbrev=0', to])
  } catch {
    return null
  }
}

export function collectCommits(fromRef, to = 'HEAD') {
  const format = '%H%x1f%B%x1e'
  const range = fromRef ? `${fromRef}..${to}` : to
  const output = git(['log', '--no-merges', `--format=${format}`, range])
  return output
    .split('\x1e')
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const [sha, ...rest] = chunk.split('\x1f')
      return { sha: sha.trim(), message: rest.join('\x1f').trim() }
    })
}

function changedFiles(fromRef, to = 'HEAD') {
  if (!fromRef) return git(['ls-tree', '-r', '--name-only', to]).split('\n').filter(Boolean)
  return git(['diff', '--name-only', `${fromRef}..${to}`]).split('\n').filter(Boolean)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) {
      args._.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (['json', 'strict'].includes(key)) {
      args[key] = true
      continue
    }
    if (['from', 'to', 'version', 'notes-file', 'github-output'].includes(key)) {
      args[key] = argv[index + 1]
      index += 1
      continue
    }
    throw new Error(`unknown option --${key}`)
  }
  return args
}

function writeGitHubOutput(file, result) {
  if (!file) return
  const lines = [
    `releasable=${result.releasable}`,
    `version=${result.version ?? ''}`,
    `bump=${result.bump ?? ''}`,
    `gate_required=${result.gate.required}`,
    `gate_satisfied=${result.gate.satisfied}`,
    `from_version=${result.fromVersion}`,
  ]
  writeFileSync(file, `${lines.join('\n')}\n`, { encoding: 'utf8', flag: 'a' })
}

function printSummary(result) {
  console.log(`last release: ${result.fromVersion}`)
  console.log(`commits:      ${result.commits.length}`)
  console.log(`releasable:   ${result.releasable}`)
  if (result.releasable) {
    console.log(`version:      ${result.version} (${result.bump})`)
  }
  console.log(
    `gate:         ${result.gate.required ? (result.gate.satisfied ? 'satisfied' : 'REQUIRED but missing') : 'not required'}`,
  )
  if (result.gate.riskyFiles.length) console.log(`risky files:  ${result.gate.riskyFiles.join(', ')}`)
  if (result.gate.enginesChanged) console.log('risky field:  engines.dsh')
  for (const reason of result.reasons) console.log(`reason:       ${reason}`)
  for (const warning of result.warnings) console.log(`warning:      ${warning}`)
}

function runPlan(args) {
  const to = args.to ?? 'HEAD'
  const fromRef = args.from ?? lastTag(to)
  const fromVersion = fromRef ? fromRef.replace(/^v/, '') : '0.0.0'
  if (!parseVersion(fromVersion)) throw new Error(`cannot derive a version from ${fromRef}`)

  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const diff = fromRef ? git(['diff', `${fromRef}..${to}`, '--', 'package.json']) : git(['show', `${to}:package.json`])
  const fields = detectPackageFieldChanges(diff)

  const result = analyze({
    commits: collectCommits(fromRef, to),
    fromVersion,
    packageVersion: pkg.version,
    changedFiles: changedFiles(fromRef, to),
    enginesChanged: fields.includes('engines.dsh'),
    forcedVersion: args.version ?? null,
    repository: repositoryUrl(pkg),
  })

  if (args['notes-file']) writeFileSync(args['notes-file'], result.notes, 'utf8')
  writeGitHubOutput(args['github-output'], result)
  if (args.json) console.log(JSON.stringify(result, null, 2))
  else printSummary(result)

  if (result.gate.required && !result.gate.satisfied) {
    console.log(
      `\ngate: changed ${[...result.riskFiles, result.gate.enginesChanged ? 'package.json#engines.dsh' : '']
        .filter(Boolean)
        .join(', ')} without a Release-Gate: verified footer`,
    )
  }
  return result
}

function runNotes(args) {
  const to = args.to ?? 'HEAD'
  const fromRef = args.from ?? lastTag(to)
  const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const parsed = (fromRef ? collectCommits(fromRef, to) : collectCommits(null, to)).map((commit) => parseCommit(commit))
  const notes = buildNotes({
    parsed,
    fromRef: fromRef ?? null,
    toRef: to === 'HEAD' ? null : to,
    repository: repositoryUrl(pkg),
  })
  process.stdout.write(notes)
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const [command = 'plan', ...argv] = process.argv.slice(2)
  try {
    const args = parseArgs(argv)
    if (command === 'plan') runPlan(args)
    else if (command === 'notes') runNotes(args)
    else {
      console.error('usage: release-plan.mjs plan|notes [--from ref] [--to ref] [--version x.y.z] [--json]')
      process.exitCode = 1
    }
  } catch (error) {
    console.error(`release-plan: ${error.message}`)
    process.exitCode = 1
  }
}
