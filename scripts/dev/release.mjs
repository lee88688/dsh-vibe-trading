#!/usr/bin/env node
/**
 * Release helper for @monsterlee/dsh-vibe-trading.
 *
 * Deliberately semi-automatic: it edits package.json, creates a local tag and
 * (with --yes) pushes main + the tag. It never publishes to npm itself; the
 * GitHub Actions tag workflow does that through OIDC trusted publishing.
 *
 *   node scripts/dev/release.mjs status
 *   node scripts/dev/release.mjs bump patch|minor|major|<x.y.z>
 *   node scripts/dev/release.mjs verify
 *   node scripts/dev/release.mjs tag
 *   node scripts/dev/release.mjs push --yes
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WIN = process.platform === 'win32'
const NPM = 'npm'
const PNPM = 'pnpm'

function out(cmd, args, options = {}) {
  return execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...options }).trim()
}

function tryOut(cmd, args, options = {}) {
  try {
    return out(cmd, args, options)
  } catch {
    return null
  }
}

/** Run npm/pnpm through cmd.exe on Windows (Node cannot exec .cmd directly). */
function tool(cmd, args, options = {}) {
  const opts = { cwd: ROOT, encoding: 'utf8', ...options }
  if (WIN) return execFileSync('cmd.exe', ['/d', '/s', '/c', cmd, ...args], opts)
  return execFileSync(cmd, args, opts)
}

function tryTool(cmd, args, options = {}) {
  try {
    return tool(cmd, args, options).trim()
  } catch {
    return null
  }
}

function pkg() {
  return JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
}

function tagName(version) {
  return `v${version}`
}

function isDirty() {
  return out('git', ['status', '--porcelain']) !== ''
}

function branch() {
  return out('git', ['rev-parse', '--abbrev-ref', 'HEAD'])
}

function tagExists(tag) {
  return out('git', ['tag', '-l', tag]) === tag
}

function remoteTagExists(tag) {
  if (!tryOut('git', ['remote', 'get-url', 'origin'])) return null
  const result = tryOut('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])
  return result === null ? null : result !== ''
}

function npmLatest(name) {
  return tryTool(NPM, ['view', name, 'version', '--registry', 'https://registry.npmjs.org/', '--prefer-online'], {
    timeout: 20_000,
  })
}

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current)
  if (!match) throw new Error(`current version is not x.y.z: ${current}`)
  const [major, minor, patch] = match.slice(1).map(Number)
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  throw new Error(`expected patch, minor, major or x.y.z; got ${kind}`)
}

function printStatus() {
  const p = pkg()
  const current = p.version
  const tag = tagName(current)
  let latest = 'unknown (offline?)'
  try {
    latest = npmLatest(p.name) ?? latest
  } catch {
    // npm view is optional for status; the release workflow still checks it.
  }
  console.log(`package:       ${p.name}`)
  console.log(`version:       ${current}`)
  console.log(`branch:        ${branch()}${isDirty() ? ' (dirty)' : ' (clean)'}`)
  console.log(`local tag:     ${tagExists(tag) ? `${tag} exists` : `${tag} missing`}`)
  const remote = remoteTagExists(tag)
  console.log(`remote tag:    ${remote === null ? 'no origin' : remote ? `${tag} exists` : `${tag} missing`}`)
  console.log(`npm latest:    ${latest}`)
  console.log(`next patch:    ${nextVersion(current, 'patch')}`)
}

function ensureClean() {
  if (isDirty()) {
    throw new Error('working tree is not clean; commit code/doc changes before releasing')
  }
}

function ensureMain() {
  const current = branch()
  if (current !== 'main') throw new Error(`release from main, not ${current}`)
}

function bump(kind = 'patch') {
  ensureClean()
  const p = pkg()
  const previous = p.version
  const next = nextVersion(previous, kind)
  p.version = next
  writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify(p, null, 2)}\n`, 'utf8')
  console.log(`bumped ${p.name}: ${previous} -> ${next}`)
  console.log('next: pnpm release:verify && git add package.json && git commit -m "release: vX.Y.Z"')
  console.log('then: pnpm release:tag && node scripts/dev/release.mjs push --yes')
}

/** Write an explicit version (used by the automated release workflow). */
function setVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`expected x.y.z, got ${version ?? '(missing)'}`)
  }
  const p = pkg()
  if (p.version === version) {
    console.log(`${p.name} is already at ${version}`)
    return
  }
  const previous = p.version
  p.version = version
  writeFileSync(path.join(ROOT, 'package.json'), `${JSON.stringify(p, null, 2)}\n`, 'utf8')
  console.log(`set ${p.name}: ${previous} -> ${version}`)
}

function tag() {
  ensureClean()
  ensureMain()
  const p = pkg()
  const name = tagName(p.version)
  if (tagExists(name)) throw new Error(`${name} already exists locally`)
  if (remoteTagExists(name)) throw new Error(`${name} already exists on origin`)
  out('git', ['tag', '-a', name, '-m', `dsh-vibe-trading ${p.version}`])
  console.log(`created ${name}`)
  console.log('next: node scripts/dev/release.mjs push --yes')
}

function push() {
  if (!process.argv.includes('--yes')) {
    throw new Error('refusing to push without --yes (this pushes main and the release tag)')
  }
  ensureClean()
  ensureMain()
  const p = pkg()
  const name = tagName(p.version)
  if (!tagExists(name)) throw new Error(`${name} does not exist; run: pnpm release:tag`)
  out('git', ['push', 'origin', 'main'])
  out('git', ['push', 'origin', name])
  console.log(`pushed main and ${name}`)
  console.log('watch: gh run list --repo lee88688/dsh-vibe-trading --workflow publish.yml --limit 3')
}

function verify() {
  tool(PNPM, ['verify:ci'], { stdio: 'inherit' })
}

function help() {
  console.log(`Usage: node scripts/dev/release.mjs <command>

  status                 show version, clean state, tags, npm latest, next patch
  bump <kind>            edit package.json only (patch|minor|major|x.y.z)
  set <x.y.z>            write an explicit version (automated release workflow)
  verify                 run pnpm verify:ci
  tag                    create annotated vX.Y.Z tag locally
  push --yes             push main and the tag separately; CI publishes via OIDC

The script never runs npm publish and never uses NPM_TOKEN.`)
}

const [command = 'status', ...args] = process.argv.slice(2)
try {
  if (command === 'status') printStatus()
  else if (command === 'bump') bump(args[0] ?? 'patch')
  else if (command === 'set') setVersion(args[0])
  else if (command === 'verify') verify()
  else if (command === 'tag') tag()
  else if (command === 'push') push()
  else if (command === 'help' || command === '--help' || command === '-h') help()
  else {
    help()
    process.exitCode = 1
  }
} catch (error) {
  console.error(`release: ${error.message}`)
  process.exitCode = 1
}
