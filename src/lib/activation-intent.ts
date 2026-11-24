/**
 * Activation intent derived from the durable session log.
 *
 * `/vibe-trading on|off` is registered with `recordInput: true`, so every
 * invocation is a `command/run` event in the session itself. That log is the
 * single source of truth for auto-restore: no side-car state file is needed,
 * and a session restored after a plugin reload / host restart already carries
 * the intent.
 *
 * Last-wins: an early `on` followed by `off` before the first turn must not
 * auto-activate. Once a turn has started, `off` is refused by the command
 * handler (`sessionHasStarted`), but the refused invocation still commits its
 * `command/run` input — so an `off` that appears after the first `turn/start`
 * must be ignored, or a reload would silently drop a session the user never
 * turned off.
 */
export function activationIntentFromEvents(events: readonly any[]): boolean {
  let intent = false
  let started = false
  for (const event of events ?? []) {
    if (!event) continue
    if (event.type === 'turn/start') {
      started = true
      continue
    }
    if (event.type !== 'command/run') continue
    const data = event.data ?? {}
    if (data.name !== 'vibe-trading') continue
    const word = String(data.args ?? '').trim().toLowerCase().split(/\s+/)[0] ?? ''
    if (word === 'on') intent = true
    else if (word === 'off' && !started) intent = false
  }
  return intent
}

/** Fold the live Session's log; a session without a readable log has no intent. */
export function activationIntent(session: any): boolean {
  try {
    if (typeof session?.snapshotEvents !== 'function') return false
    return activationIntentFromEvents(session.snapshotEvents())
  } catch {
    return false
  }
}

/**
 * Whether an `agent/created` edge may reach auto-restore at all.
 *
 * DSH has no `'fork'` start source: `SessionStartSource` is
 * `'startup' | 'resume' | 'clear' | 'compact'`, and a fork is announced as
 * `startup` carrying `header.isSeeded`. `source` therefore cannot tell a fork
 * from a brand-new session on its own — `isSeeded` is the distinction.
 *
 * Suppressing `startup` never protected a new session: one carries no
 * `command/run` at all, so {@link activationIntentFromEvents} returns false and
 * `maybeAutoActivate` no-ops. The only sessions that guard could ever suppress
 * are seeded children that inherited their parent's `on`, which is exactly the
 * fork case this predicate now restores.
 */
export function shouldRestoreOnCreation(source: string, isSeeded: boolean): boolean {
  if (source !== 'startup') return true
  return isSeeded === true
}
