#!/usr/bin/env node
/**
 * Locate a DSH session log without hardcoding the workspace path encoding.
 *
 * DSH stores sessions under $DSH_HOME/sessions/<encoded-cwd>/<sessionId>/,
 * where the cwd is flattened (path separators, drive colons and spaces become
 * separators of the directory name). This helper searches all session roots.
 *
 * Usage: node scripts/dev/session-log.mjs <sessionId> [...]
 * Prints one absolute path per line; exits 1 if any id is missing.
 */
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const sessionsRoot = path.join(home, 'sessions')

function findAll(sessionId) {
  const found = []
  if (!existsSync(sessionsRoot)) return found
  for (const dir of readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue
    const candidate = path.join(sessionsRoot, dir.name, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(candidate)) found.push(candidate)
  }
  return found
}

const ids = process.argv.slice(2)
if (!ids.length) {
  console.error('usage: node scripts/dev/session-log.mjs <sessionId> [...]')
  process.exit(2)
}
let missing = false
for (const sessionId of ids) {
  const paths = findAll(sessionId)
  if (!paths.length) {
    console.error(`missing: ${sessionId}`)
    missing = true
    continue
  }
  for (const found of paths) console.log(found)
}
process.exit(missing ? 1 : 0)
