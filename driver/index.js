/**
 * dsh-vt-test-driver — test-only session driver for dsh-vibe-trading.
 *
 * Creates a real root Agent/Session in the running profile (visible in the
 * desktop GUI), optionally executes `/vibe-trading on` against it, and sends a
 * prompt so the same session can be observed by the user and audited from its
 * session log / grounding artifacts.
 *
 * The plugin is installed disabled; enable it only while testing. Handles stay
 * alive after the turn so the session remains visible; `dispose` removes the
 * session (the Agent handle contract does that).
 */

export const name = 'dsh-vt-test-driver'

export const inject = ['tools', 'agents', 'commands', 'agentPresets', 'workspaceRegistry']

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

function preview(text, limit = 2000) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}\n… (${value.length - limit} more chars)` : value
}

function newSessionId() {
  return `session-${crypto.randomUUID()}`
}

/**
 * Build one complete user message.
 *
 * `agent.followup` persists the payload verbatim as a `user/message` event, and
 * Session validation on reload requires `id` and `role`, so a bare
 * `{ content, source }` object would corrupt the Session on the next load.
 */
function userMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    source: { kind: 'user' },
  }
}

export function apply(ctx, config = {}) {
  const logger = ctx.logger?.('dsh-vt-test-driver')
  const handles = new Map()

  function log(line) {
    try {
      logger?.info?.(line)
    } catch {
      /* best effort */
    }
  }

  async function waitIdle(record, timeoutMinutes = 30) {
    record.idle = false
    const timeoutMs = Math.max(1, Number(timeoutMinutes) || 30) * 60_000
    let timer
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs)
    })
    try {
      const outcome = await Promise.race([record.handle.agent.whenIdle().then(() => 'idle'), timeout])
      record.idle = outcome === 'idle'
      return outcome
    } finally {
      clearTimeout(timer)
    }
  }

  async function runPrompt(record, prompt, timeoutMinutes) {
    record.handle.agent.followup(userMessage(prompt))
    const outcome = await waitIdle(record, timeoutMinutes)
    return outcome
  }

  function describe(record) {
    return {
      sessionId: record.sessionId,
      status: record.handle.agent.status,
      idle: record.idle,
      cwd: record.cwd ?? null,
    }
  }

  /**
   * A fresh root agent has no model route of its own; the GUI's current model
   * selection is the profile default, so adopt it unless the caller configured
   * an explicit route.
   */
  function resolveAgentOptions() {
    const configured = config.agentOptions
    if (configured && configured.provider && configured.model) return configured
    // The initiator agent (the session whose tool call drives this driver) has a
    // live model selection; adopt it for the new root agent.
    try {
      const current = ctx.agents?.currentInitiator?.()?.model?.current?.()
      if (current && current.provider && current.model) {
        return {
          provider: current.provider,
          model: current.model,
          ...(current.reasoningEffort ? { reasoningEffort: current.reasoningEffort } : {}),
        }
      }
    } catch {
      /* fall through */
    }
    try {
      const selection = ctx.agentDefaultModel?.currentSelection?.()
      if (selection && selection.provider && selection.model) {
        return {
          provider: selection.provider,
          model: selection.model,
          ...(selection.reasoningEffort ? { reasoningEffort: selection.reasoningEffort } : {}),
        }
      }
    } catch {
      /* fall through */
    }
    return undefined
  }

  const tool = {
    name: 'vt_test_session',
    description:
      'Testing only: create or drive a real DSH session in this desktop profile. ' +
      'start = create a new session (optionally run /vibe-trading on and send a prompt, then wait for idle); ' +
      'send = send another prompt to an existing test session; command = execute a slash command against an existing ' +
      'test session (e.g. "/vibe-trading off"); resume = load a stored session to prove it still opens; ' +
      'fork = create a seeded fork of a live test session (source=startup + isSeeded) to exercise fork auto-restore; ' +
      'status = list live test sessions; dispose = tear one down.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['start', 'send', 'command', 'resume', 'fork', 'status', 'presets', 'dispose', 'remove', 'attach'], description: 'Operation to run.' },
        prompt: { type: 'string', description: 'User prompt to send (start/send).' },
        command: { type: 'string', description: 'Slash command to execute against an existing session (command).' },
        sessionId: { type: 'string', description: 'Target session for send/dispose.' },
        cwd: { type: 'string', description: 'Workspace cwd for the new session (start only).' },
        preset: { type: 'string', description: 'Agent preset id for the new session (defaults to config.preset).' },
        activate: { type: 'boolean', description: 'Run /vibe-trading on after creating the session (default true).' },
        wait: { type: 'boolean', description: 'Wait for the turn to finish before returning (default true).' },
        timeoutMinutes: { type: 'number', description: 'Idle wait timeout in minutes (default 30).' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => false,
    async execute(args = {}) {
      const action = String(args.action ?? 'start')
      try {
        if (action === 'presets') {
          try {
            const presets = await ctx.agentPresets?.list?.()
            return JSON.stringify({ presets }, null, 2)
          } catch (error) {
            return `presets failed: ${error?.message ?? error}`
          }
        }

        if (action === 'attach') {
          const sessionId = String(args.sessionId ?? '')
          const cwd = typeof args.cwd === 'string' && args.cwd
            ? args.cwd
            : (typeof config.cwd === 'string' ? config.cwd : undefined)
          if (!sessionId) return 'sessionId is required for attach'
          try {
            let workspace = cwd ? await ctx.workspaceRegistry?.resolveByPath?.(cwd) : undefined
            if (workspace === undefined && cwd) workspace = await ctx.workspaceRegistry?.create?.(cwd)
            if (!workspace?.attachSession) return 'no workspace registry available'
            await workspace.attachSession(sessionId)
            return JSON.stringify({ attached: sessionId, workspace: { workspaceId: String(workspace.id ?? ''), path: workspace.path ?? cwd } })
          } catch (error) {
            return `attach failed: ${error?.message ?? error}`
          }
        }

        if (action === 'remove') {
          const sessionId = String(args.sessionId ?? '')
          if (!sessionId) return 'sessionId is required for remove'
          try {
            const route = resolveAgentOptions()
            const handle = await ctx.agents.resume({
              resumeSessionId: sessionId,
              ...(route ? { agentOptions: route } : {}),
            })
            await handle.dispose()
            handles.delete(sessionId)
            log(`removed ${sessionId}`)
            return JSON.stringify({ removed: sessionId })
          } catch (error) {
            return `remove failed: ${error?.message ?? error}`
          }
        }

        if (action === 'status') {
          return JSON.stringify({ sessions: [...handles.values()].map(describe) }, null, 2)
        }

        if (action === 'dispose') {
          const record = handles.get(String(args.sessionId ?? ''))
          if (!record) return `unknown test session: ${args.sessionId ?? ''}`
          handles.delete(record.sessionId)
          await record.handle.dispose()
          log(`disposed ${record.sessionId}`)
          return JSON.stringify({ disposed: record.sessionId, note: 'the session is removed from the store' })
        }

        if (action === 'resume') {
          const sessionId = String(args.sessionId ?? '')
          if (!sessionId) return 'sessionId is required for resume'
          try {
            const route = resolveAgentOptions()
            const handle = await ctx.agents.resume({
              resumeSessionId: sessionId,
              ...(route ? { agentOptions: route } : {}),
            })
            const record = { sessionId, handle, idle: true, cwd: null, preset: null, workspace: null }
            handles.set(sessionId, record)
            log(`resumed ${sessionId}`)
            return JSON.stringify({ resumed: sessionId, status: handle.agent.status, note: 'handle kept; loadability check only' }, null, 2)
          } catch (error) {
            return `resume failed: ${error?.message ?? error}`
          }
        }

        if (action === 'fork') {
          const sourceId = String(args.sessionId ?? '')
          if (!sourceId) return 'sessionId is required for fork'
          const source = handles.get(sourceId)
          if (!source) return `unknown test session: ${sourceId} (start it first so a live agent can seed the fork)`
          try {
            const events = source.handle.agent.session.snapshotEvents()
            const childId = newSessionId()
            const cwd = typeof source.cwd === 'string' && source.cwd ? source.cwd : undefined
            // Reproduce what the GUI fork produces: a seeded child created through
            // agents.create, which DSH announces as source=startup + header.isSeeded.
            const child = await ctx.agents.create({
              sessionId: childId,
              meta: {
                isSeeded: true,
                parentSession: sourceId,
                ...(cwd ? { cwd } : {}),
                ...(source.preset ? { agentPreset: source.preset } : {}),
              },
              inheritedEventCount: events.length,
              seed: events,
              ...(resolveAgentOptions() ? { agentOptions: resolveAgentOptions() } : {}),
            })
            handles.set(childId, {
              sessionId: childId,
              handle: child,
              idle: true,
              cwd: cwd ?? null,
              preset: source.preset ?? null,
              workspace: null,
            })
            log(`forked ${sourceId} -> ${childId}`)
            return JSON.stringify(
              {
                fork: childId,
                from: sourceId,
                seededEvents: events.length,
                isSeeded: child.agent?.session?.header?.isSeeded ?? null,
                status: child.agent.status,
                note: 'seeded fork via agents.create (source=startup); check plugin.log for auto-restore',
              },
              null,
              2,
            )
          } catch (error) {
            return `fork failed: ${error?.message ?? error}\n${preview(error?.stack ?? '')}`
          }
        }

        if (action === 'command') {
          const record = handles.get(String(args.sessionId ?? ''))
          if (!record) return `unknown test session: ${args.sessionId ?? ''}`
          const raw = typeof args.command === 'string' ? args.command.trim() : ''
          if (!raw) return 'command is required for command'
          const controller = new AbortController()
          const execution = await ctx.commands.execute(record.handle.agent, raw, [], controller.signal)
          const text = execution
            ? JSON.stringify(execution.result ?? execution).slice(0, 4000)
            : 'no command execution (unknown or invalid command)'
          const outcome = args.wait === false ? 'queued' : await waitIdle(record, args.timeoutMinutes)
          return JSON.stringify({ sessionId: record.sessionId, command: raw, text, outcome, status: record.handle.agent.status }, null, 2)
        }

        if (action === 'send') {
          const record = handles.get(String(args.sessionId ?? ''))
          if (!record) return `unknown test session: ${args.sessionId ?? ''}`
          if (!args.prompt) return 'prompt is required for send'
          const outcome = args.wait === false
            ? (record.handle.agent.followup(userMessage(args.prompt)), 'queued')
            : await runPrompt(record, args.prompt, args.timeoutMinutes)
          return JSON.stringify({ sessionId: record.sessionId, outcome, status: record.handle.agent.status }, null, 2)
        }

        // start
        const sessionId = newSessionId()
        const cwd = typeof args.cwd === 'string' && args.cwd ? args.cwd : (typeof config.cwd === 'string' ? config.cwd : undefined)
        const preset = typeof args.preset === 'string' && args.preset
          ? args.preset
          : (typeof config.preset === 'string' && config.preset ? config.preset : 'standard')
        let mountedPreset
        try {
          const resolved = await ctx.agentPresets?.resolve?.(preset)
          mountedPreset = resolved?.id ?? preset
        } catch (error) {
          log(`preset resolve failed: ${error?.message ?? error}`)
          mountedPreset = undefined
        }
        const handle = await ctx.agents.create({
          sessionId,
          ...(cwd || mountedPreset ? { meta: { ...(cwd ? { cwd } : {}), ...(mountedPreset ? { agentPreset: mountedPreset } : {}) } } : {}),
          ...(resolveAgentOptions() ? { agentOptions: resolveAgentOptions() } : {}),
          ...(mountedPreset
            ? { setup: async (agentCtx) => { await ctx.agentPresets.mount(agentCtx, mountedPreset) } }
            : {}),
        })
        const record = { sessionId, handle, idle: false, cwd: cwd ?? null, preset: mountedPreset ?? null, workspace: null }
        // Join the workspace that owns this directory so the GUI groups the
        // session under a project instead of "ungrouped".
        try {
          if (typeof cwd === 'string' && cwd && ctx.workspaceRegistry) {
            let workspace = await ctx.workspaceRegistry.resolveByPath?.(cwd)
            if (workspace === undefined) workspace = await ctx.workspaceRegistry.create?.(cwd)
            if (workspace?.attachSession) {
              await workspace.attachSession(sessionId)
              record.workspace = { workspaceId: String(workspace.id ?? ''), path: workspace.path ?? cwd }
            }
          }
        } catch (error) {
          log(`workspace attach failed: ${error?.message ?? error}`)
        }
        handles.set(sessionId, record)
        log(`created ${sessionId}`)

        let activation = 'skipped'
        if (args.activate !== false) {
          const controller = new AbortController()
          try {
            const execution = await ctx.commands.execute(handle.agent, '/vibe-trading on', [], controller.signal)
            activation = execution
              ? JSON.stringify(execution.result ?? execution).slice(0, 800)
              : 'no command execution (unknown or invalid command)'
          } catch (error) {
            activation = `activation failed: ${error?.message ?? error}`
          }
        }

        let outcome = 'no prompt'
        if (args.prompt) {
          outcome = args.wait === false
            ? (handle.agent.followup(userMessage(args.prompt)), 'queued')
            : await runPrompt(record, args.prompt, args.timeoutMinutes)
        }

        return JSON.stringify(
          {
            sessionId,
            activation,
            modelRoute: resolveAgentOptions() ?? null,
            preset: record.preset,
            workspace: record.workspace,
            outcome,
            status: handle.agent.status,
            idle: record.idle,
            note: 'Open the GUI session list to watch it; dispose removes the session.',
          },
          null,
          2,
        )
      } catch (error) {
        log(`vt_test_session failed: ${error?.message ?? error}`)
        return `vt_test_session failed: ${error?.message ?? error}\n${preview(error?.stack ?? '')}`
      }
    },
  }

  const disposeTool = ctx.tools.register(tool)
  ctx.on('dispose', () => {
    disposeTool?.()
    for (const record of handles.values()) {
      try {
        record.handle.dispose?.()
      } catch {
        /* best effort */
      }
    }
    handles.clear()
  })
}
