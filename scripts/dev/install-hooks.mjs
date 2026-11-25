#!/usr/bin/env node
/**
 * Install the tracked git hooks (`.githooks/commit-msg`).
 *
 * Deliberately explicit instead of hooking into `pnpm install`'s `prepare`:
 * silently rewriting a clone's git config is surprising, and CI does not need
 * the hook because it runs the same checks itself.
 *
 *   pnpm hooks:install
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const hook = path.join(ROOT, '.githooks', 'commit-msg')

if (!existsSync(hook)) {
  console.error('install-hooks: .githooks/commit-msg is missing')
  process.exitCode = 1
} else {
  execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], { cwd: ROOT, stdio: 'inherit' })
  console.log('installed: core.hooksPath = .githooks (commit-msg checks conventional commits + release gate)')
  console.log('bypass once with: SKIP_COMMIT_HOOK=1 git commit ...')
}
