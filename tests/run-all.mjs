/**
 * In-process test runner.
 *
 * `node --test` spawns one child process per test file, which fails in
 * sandboxed shells that forbid piped stdio (EPERM). This runner imports every
 * `*.test.mjs` module directly so the same `node:test` suites execute inside a
 * single process. Use it in constrained environments; `node --test tests` works
 * everywhere else.
 *
 * Usage: node tests/run-all.mjs
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const files = (await fsp.readdir(here))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()

if (files.length === 0) {
  console.error('no test files found')
  process.exit(1)
}

for (const file of files) {
  await import(pathToFileURL(path.join(here, file)).href)
}

// node:test reports failures through process.exitCode once the event loop drains.
process.on('beforeExit', () => {
  if (process.exitCode === undefined) process.exitCode = 0
})
