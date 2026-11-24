# Vibe Trading

Run Vibe-Trading's finance research tools, skills and number discipline inside DSH sessions
(DSH runs the agent loop).

> Research and education only. It does not execute trades and is not investment advice.
> This is an independent project, not affiliated with or endorsed by HKUDS.

## Activate and inspect

- `/vibe-trading on` in a new session: registers 10 session tools (6 core + 4 gateway tools) and
  injects the domain prompt into that session.
- `/vibe-trading status` shows the environment, worker, number gate and this session's state.
  `/vibe-trading off` only works before a session's first turn.
- First use: run `/vibe-trading init` once to build the Python environment (1–2 minutes; idempotent).

## The Configuration section below

These settings belong to the **current DSH profile** and live in that profile's `cordis.patch.yml`
(one copy per profile). They are unrelated to the installed environment under `~/.vibe-trading/dsh/`.

- **Number gate**: every figure in an answer must trace back to a tool result from this session.
  A rejected draft is steered one correction (`[GROUNDING GATE]`); once the revision budget is spent
  the model is asked to state that some numbers could not be verified. The `identity` gate requires
  `search_symbol` before market-data calls.
- **Skills and worker**: `skills.mode` shapes the skill catalog in the prompt (takes effect on the
  **next activation**); worker idle exit and timeouts apply to the **next tool call** of an active session.
- **Monkey patch**: `worker.patchFile` takes an absolute path to a `.py` file (empty = disabled). The
  worker imports it once at startup, so it can adjust data sources, the loader registry or tool
  behaviour. **Restart the worker** (restart DSH or wait for the idle timer) for a change to apply;
  the outcome is reported in `ping` -> `startup.user_patch` (`ok=false` carries `error`). A patch that
  raises is caught and never takes the worker down — it just does not apply. See the examples under
  `~/.vibe-trading/dsh/patches/`.
- **Install policy is read-only**: switch vibe-trading-ai versions with `/vibe-trading init --pinned|--latest`.

Saving applies immediately: no plugin remount, no tool disposal, no interruption of a running turn.
The one exception is enabling the gate mid-turn — tool results from earlier in that turn are not in
the evidence ledger, so switch settings between turns.
