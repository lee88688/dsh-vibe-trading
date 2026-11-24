#!/usr/bin/env node
/**
 * End-to-end smoke test of the activation path, without DSH.
 *
 * Runs what `/vibe-trading on` runs: read config → start the Python worker →
 * list tools and skills → assemble the prompt → call two real tools → shut down.
 *
 *   node scripts/dev/activate-smoke.mjs
 */

import { promises as fsp } from 'node:fs'

import { configPath, readConfig, resolveVibeHome, workDir } from '../../dist/lib/config.js'
import { WorkerClient } from '../../dist/lib/worker.js'
import { buildPromptText } from '../../dist/lib/prompt.js'
import { createGrounding } from '../../dist/lib/verify.js'

const env = process.env
const log = (line) => console.log(`[smoke] ${line}`)
const fail = (message) => {
  console.error(`[smoke] FAIL: ${message}`)
  process.exit(1)
}

const { config, error } = await readConfig(env)
if (!config) fail(`config missing or invalid: ${error} (${configPath(env)})`)
log(`config ok: ${configPath(env)} (vibe-trading-ai ${config.package?.installedVersion})`)
log(`vibe home: ${resolveVibeHome(env)}`)

const toolsets = JSON.parse(await fsp.readFile(new URL('../../toolsets.json', import.meta.url), 'utf8'))
const promptDir = new URL('../../prompt/', import.meta.url)
const base = await fsp.readFile(new URL('vibe-trading.md', promptDir), 'utf8')
const bridge = await fsp.readFile(new URL('bridge.md', promptDir), 'utf8')

const worker = new WorkerClient(config, { env, log: (line) => log(line) })
const started = Date.now()
await worker.start()
log(`worker ready in ${((Date.now() - started) / 1000).toFixed(2)}s pid=${worker.status.pid}`)

const tools = (await worker.request('tools/list'))?.tools ?? []
const skills = (await worker.request('skills/list'))?.skills ?? []
log(`tools: ${tools.length} (advertised in toolsets: ${new Set([...toolsets.staticCore, ...Object.values(toolsets.groups).flat()]).size})`)
log(`skills: ${skills.length}`)

const core = toolsets.staticCore.filter((name) => tools.some((tool) => tool.name === name))
const missing = toolsets.staticCore.filter((name) => !tools.some((tool) => tool.name === name))
log(`core tools present: ${core.join(', ')}${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`)
if (missing.length) fail(`worker is missing static core tools: ${missing.join(', ')}`)

const prompt = buildPromptText({ base, bridge, tools, skills, toolsets, skillsMode: config.skills?.mode ?? 'short' })
log(`prompt: ${prompt.length} chars ≈ ${Math.round(prompt.length / 4)} tokens`)
if (!prompt.includes('## Available Vibe-Trading tools')) fail('prompt is missing the tool catalog section')
if (!prompt.includes('## Available Vibe-Trading skills')) fail('prompt is missing the skill catalog section')

async function call(name, args) {
  const at = Date.now()
  const result = await worker.request('tools/call', { name, arguments: args, session_id: 'activate-smoke' }, { timeoutMs: 120_000 })
  const elapsed = ((Date.now() - at) / 1000).toFixed(2)
  const text = String(result?.text ?? '')
  log(`${name}: ${text.length} chars in ${elapsed}s → ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
  return result
}

const resolved = await call('search_symbol', { query: 'Apple', limit: 3 })
if (!resolved || resolved.isError) fail('search_symbol failed')
await call('get_market_data', { codes: ['AAPL.US'], start_date: '2026-10-28', end_date: '2026-11-03' })

// Gateway-only tool through the same worker path.
const rigor = await call('financial_rigor', { command: 'calc', expr: '100 * 1.05' })
if (!rigor) fail('financial_rigor failed')

// Grounding gate against the real worker.
const grounding = createGrounding({ worker, agentId: 'activate-smoke', cfg: { verification: { enabled: true } }, env })
await grounding.ensure()
const gate = await grounding.beforeCall('get_market_data', { codes: ['TSLA.US'] })
log(`identity gate: allowed=${gate.allowed}${gate.allowed ? '' : ` (${gate.message.split('\n')[0]})`}`)
const verdict = await grounding.checkAnswer('AAPL.US closed at 999.99 USD on 2026-11-03.')
log(`figures gate: valid=${verdict.valid} issues=${verdict.issues?.length ?? 0}`)
if (verdict.valid) fail('a fabricated price was accepted by the figures gate')

await worker.dispose()
log('worker stopped')
log(`work dir: ${workDir(env)}`)
log('OK')
process.exit(0)
