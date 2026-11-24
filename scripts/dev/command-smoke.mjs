#!/usr/bin/env node
/**
 * Exercise `/vibe-trading status | on | status | off` without a GUI.
 *
 * Builds a fake plugin context and a fake agent registry, then runs the same
 * command handler DSH calls. This covers config reading, worker start, tool
 * registration, prompt assembly, gateway registration and disposal against the
 * real Python environment.
 *
 *   node scripts/dev/command-smoke.mjs
 */

process.env.VIBE_TRADING_HOME ??= `${process.env.USERPROFILE}\\.vibe-trading`

const { apply } = await import('../../dist/index.js')

const registered = []
const sections = []
const commands = []
const logs = []
const profileWrites = []
let followups = 0

/** Host settings service stand-in: `/vibe-trading config set` writes here. */
const settingsService = {
  async update(namespace, patch) {
    profileWrites.push({ namespace, patch })
    return { namespace, patch }
  },
}

const ctx = {
  logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
  // Optional Cordis service lookup (agents / settings / configEditor).
  get: (id) => (id === 'settings' ? settingsService : undefined),
  effect: (fn) => {
    const disposer = fn()
    return () => {
      if (typeof disposer === 'function') disposer()
    }
  },
  tools: {
    register: (definition) => {
      registered.push(definition)
      return () => {}
    },
  },
  commands: {
    register: (command) => {
      commands.push(command)
      return () => {}
    },
  },
}

apply(ctx, {})

const command = commands.find((entry) => entry.name === 'vibe-trading')
if (!command) {
  console.error('FAIL: /vibe-trading command was not registered')
  process.exit(1)
}
console.log(`command registered: ${command.name} — ${command.description}`)
console.log(`host tools registered: ${registered.map((tool) => tool.name).join(', ') || '(none)'}`)
if (!registered.some((tool) => tool.name === 'vibe_trading_setup')) {
  console.error('FAIL: vibe_trading_setup host tool was not registered')
  process.exit(1)
}

const agentTools = []
const agent = {
  id: 'command-smoke',
  ctx: {
    tools: {
      register: (definition) => {
        agentTools.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section: (spec) => {
        sections.push(spec)
        return () => {}
      },
    },
    on: () => () => {},
  },
  followup: () => {
    followups += 1
  },
  steer: () => {},
  inject: () => {},
}

const invoke = async (rawInput, options = {}) => {
  const result = await command.handler({ rawInput, agent })
  console.log(`\n> /vibe-trading ${rawInput}\n${result.text}`)
  if (result.kind === 'error' && rawInput !== 'off' && options.allowError !== true) process.exitCode = 1
  return result
}

await invoke('status')

// Config surface: show, get, guarded set, denied mutation.
const configShow = await invoke('config')
if (!configShow.text.includes('verification.enabled')) {
  console.error('FAIL: config show does not list verification.enabled')
  process.exit(1)
}
const configGet = await invoke('config get verification.enabled')
if (!/verification\.enabled = (true|false)/.test(configGet.text)) {
  console.error('FAIL: config get verification.enabled did not return a boolean')
  process.exit(1)
}
const configSet = await invoke('config set verification.onFailure disclose', { allowError: true })
const written = profileWrites.at(-1)
if (
  configSet.kind !== 'success' ||
  !configSet.text.includes('verification.onFailure') ||
  written?.namespace !== 'dsh-vibe-trading' ||
  written?.patch?.verification?.onFailure !== 'disclose'
) {
  console.error('FAIL: config set did not write the profile row config through the settings service')
  process.exit(1)
}
const configDenied = await invoke('config set package.minimumVersion 9.9.9', { allowError: true })
if (configDenied.kind !== 'error' || !configDenied.text.includes('不支持这个设置项')) {
  console.error('FAIL: config set accepted an install-fact key instead of refusing it')
  process.exit(1)
}

// init must always hand its outcome to the current session's agent (fast path included).
const before = followups
const initResult = await invoke('init')
if (!initResult.text.includes('已交给当前会话的 agent')) {
  console.error('FAIL: init did not report that the outcome was handed to the agent')
  process.exit(1)
}
if (followups <= before) {
  console.error('FAIL: init did not call agent.followup')
  process.exit(1)
}
console.log(`init: followups=${followups} (expected > ${before})`)

await invoke('on')
console.log(`\nregistered on agent: ${agentTools.map((tool) => tool.name).join(', ')}`)
const section = sections[0]
if (!section) {
  console.error('FAIL: no prompt section registered')
  process.exit(1)
}
const promptText = section.text()
console.log(`prompt section: ${promptText.length} chars ≈ ${Math.round(promptText.length / 4)} tokens`)
if (!promptText.includes('## Available Vibe-Trading tools')) {
  console.error('FAIL: prompt section has no tool catalog')
  process.exit(1)
}
await invoke('on') // idempotent
await invoke('status')
await invoke('off')
console.log(`\nafter off: agent tools still registered = ${agentTools.length} (registrations happen once)`)
console.log(`followups: ${followups}`)
const status = await invoke('status')
if (!status.text.includes('未激活')) {
  console.error('FAIL: status does not report the session as inactive after off')
  process.exit(1)
}
console.log('\nOK')
process.exit(process.exitCode ?? 0)
