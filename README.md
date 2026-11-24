# dsh-vibe-trading

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/lee88688/dsh-vibe-trading/actions/workflows/ci.yml/badge.svg)](https://github.com/lee88688/dsh-vibe-trading/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@monsterlee/dsh-vibe-trading)](https://www.npmjs.com/package/@monsterlee/dsh-vibe-trading)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.5-4E6DD4)](https://github.com/deepseek-ai/deepseek-harness)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) plugin that puts
[Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)'s finance research tools, skills, and number
discipline inside DSH sessions. **DSH runs the agent loop**; Vibe-Trading keeps supplying its tool
registry, 89 specialist skills, and finance-specific output rules.

Published as [`@monsterlee/dsh-vibe-trading`](https://www.npmjs.com/package/@monsterlee/dsh-vibe-trading)
on npm; the source lives in this repository.

> **Status:** pre-1.0, verified against DSH `0.2.2-rc.5` and `vibe-trading-ai` `0.1.19` on a Windows
> 11 web profile. The GitHub Actions workflow builds and tests on Linux and Windows.
> This is an independent community integration, **not** an official HKUDS project.
>
> **Research tooling only.** It does not execute trades and is not investment advice.

## What it does

- **One worker, no MCP server.** A long-lived Python worker calls Vibe-Trading's
  `build_registry()` directly over newline-delimited JSON-RPC. Startup is roughly 3.7–4.0 s;
  `tools/list` is roughly 0.11 s; `mcp_server` is never imported.
- **127 tools and 89 skills.** 6 resident tools plus 4 gateway tools are registered when a session
  activates; the other 83 worker tools load on demand through 9 groups (`research`, `research-workflow`,
  `backtest`, `quant`, `verify`, `team`, `trading-reads`, `goals`, `runio`).
- **Stable prompt cache.** After activation the tool-definition block does not change during the
  session. Steady state is about 12.5k tokens (tool definitions ≈1.8k, prompt ≈10.9k).
- **Number verification on by default.** `report_figures` is a real tool; the model does not write a
  `figures` block into the answer. Identity, evidence, and derived-figure checks run before a numeric
  answer is accepted, and a `turnTail` panel shows what was verified. See
  [docs/number-verification.md](docs/number-verification.md).
- **Per-session activation.** `/vibe-trading on` only affects the current session. Reloading or
  upgrading the plugin restores sessions whose logs contain `/vibe-trading on`.
- **No host-row overrides.** `cordis.patch.yml` inserts one plugin row and changes nothing else.
  Backtest run-directory I/O uses Vibe-Trading's own `read_file` / `write_file` tools.

## Requirements

| Component | Version | Notes |
|---|---|---|
| DSH | `>=0.2.2-rc.5` | Declared as `engines.dsh`; older hosts skip the bundle |
| Node.js | `>=24.9.0` | DSH's own requirement; tested with Node 24.9 |
| pnpm | 12.x | Used to install and build the checkout |
| Python | 3.12 | Used by `/vibe-trading init` to create the worker venv |
| Network | PyPI + data sources | `init` installs `vibe-trading-ai`; market tools need data access |

Windows 11 is the primary tested platform. Linux and macOS should work but have less field testing.
`uv` is optional; `init` can use the system Python or an existing `uv` installation.

## Install

The plugin is published as **`@monsterlee/dsh-vibe-trading`**. Install a pinned version through DSH's
plugin manager:

```text
plugin_manager install_bundle target = "@monsterlee/dsh-vibe-trading@latest"
```

For a reproducible install, replace `@latest` with the version you want (for example `@0.4.x`); npm's
`latest` tag tracks the current release. Then open a **new session**:

```text
/vibe-trading init     # create ~/.vibe-trading/dsh/venv and install vibe-trading-ai==0.1.19
/vibe-trading on       # activate this session (other sessions are unaffected)
/vibe-trading status
```

`init` takes one to two minutes on a cold cache and is idempotent. It writes installation facts to
`~/.vibe-trading/dsh/config.json`; profile behavior settings are stored separately in the profile's
`cordis.patch.yml`.

> The unscoped npm package `dsh-vibe-trading` is a **different project**. Do not install it expecting
> this code; use the `@monsterlee/` scope shown above.

### From source

Useful when developing the plugin or testing an unreleased change:

```bash
git clone https://github.com/lee88688/dsh-vibe-trading.git
cd dsh-vibe-trading
pnpm install     # installs dev dependencies; "prepare" builds dist/
pnpm verify      # optional: typecheck + build + 178 tests + manifest checks
```

Install the checkout directory with `plugin_manager install_bundle target = "<absolute path>"`, or use
**Plugins → Add plugin** and pick the directory. Then run `init` / `on` in a new session as above.

## Commands

| Command | Effect |
|---|---|
| `/vibe-trading init [--pinned\|--latest]` | Create/repair the Python venv and install the pinned `vibe-trading-ai` (default `0.1.19`) |
| `/vibe-trading on` | Start/reuse the worker and activate the current session |
| `/vibe-trading off` | Remove this session's tools; only valid before its first turn |
| `/vibe-trading status` | Show environment, worker, gate, and session state |
| `/vibe-trading config set <key> <value>` | Change profile settings (for example `verification.enabled false`) |

Activation registers 6 resident tools (including `report_figures`) and 4 gateway tools
(`vt_load_tools`, `vt_call`, `vt_list_skills`, `vt_load_skill`). The complete catalog is in
[docs/tool-surface.md](docs/tool-surface.md).

## Design

- **Activation is a command, not a global mount.** A session gets the worker, tools, and prompt only
  after `/vibe-trading on`. This keeps unrelated sessions small and makes the tool surface explicit.
- **The worker is the boundary.** The TypeScript plugin supervises the Python process, maps JSON-RPC
  results to DSH tools, and enforces output rules; the Python worker owns the Vibe-Trading registry.
- **Numbers come from tools.** Market data, filings, computed figures, and derived metrics must trace
  back to a tool call in the same session. Prices need a source and currency; non-price amounts must
  not carry a currency word. The gate can be disabled per profile, but it is on by default.
- **Trade execution stays out.** Order placement, eToro, and mandate tools are not exposed. The model
  must refuse trade instructions rather than fabricate fills.
- **Installation is pinned.** `/vibe-trading init` installs exactly `vibe-trading-ai==0.1.19` unless
  `--latest` is passed; `--latest` is reported as unverified.

## Validation

```bash
pnpm verify       # typecheck + build + unit tests + manifest
pnpm verify:all   # + docs/private/tools/pin/surface/worker/grounding
```

Current baseline: **178/178** Node tests, manifest checks pass, and `check_pin.mjs` reports 0 failures.
The Python checks (`check:worker`, `check:grounding`) need `uv sync` and network access; see
[docs/development.md](docs/development.md) §2. CI runs the Node checks on Linux and Windows.

## Documentation

| Document | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Cross-session handoff: rules, environment, code map, debugging |
| [docs/README.md](docs/README.md) | Documentation index and maintenance rules |
| [docs/architecture.md](docs/architecture.md) | Design facts and component boundaries |
| [docs/decisions.md](docs/decisions.md) | Recorded design decisions (D1–D27) |
| [docs/number-verification.md](docs/number-verification.md) | Identity/evidence/figures gate and calculation tools |
| [docs/data-sources.md](docs/data-sources.md) | Market-data sources, failure modes, user configuration |
| [docs/development.md](docs/development.md) | Setup, checks, real-session testing, release steps |
| [docs/tool-surface.md](docs/tool-surface.md) | Per-tool exposure table with reasons |
| [docs/postmortems/install-hang.md](docs/postmortems/install-hang.md) | First-install hang postmortem |

## Known limitations

- **Hot reload interrupts active turns.** Enabling/disabling or upgrading the plugin disposes the
  session's tools; do it between turns. Sessions with an activation intent recover automatically, but
  an in-flight turn may still see `unknown tool`.
- **`off` is pre-turn only.** After a session's first turn, removing tools would invalidate tool calls
  already in history and the prompt cache. Create a new session instead.
- **The gate can need 2–4 revisions.** Numeric answers usually converge in a few `report_figures` rounds;
  after the revision budget is spent, the gate falls back to a disclosure panel instead of silently
  accepting unverified numbers.
- **Data sources are best-effort.** Some sources require credentials, rate-limit, or are unreachable
  from a given network. The agent should say “not retrieved” rather than fill gaps from memory.
- **Third-party slash commands have limited UI.** DSH 0.2.2-rc.5 does not draw icons or localized
  titles for non-host commands; `/vibe-trading` appears with its description and input hint only.
- **Profile settings apply at different times.** `verification.*` and worker timeouts apply to the next
  tool call; `skills.mode` only affects the next activation.

## Contributing and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.
- Report vulnerabilities through
  [GitHub private advisories](https://github.com/lee88688/dsh-vibe-trading/security/advisories/new),
  not a public issue. See [SECURITY.md](SECURITY.md) for the trust model.
- Release notes are generated on
  [GitHub Releases](https://github.com/lee88688/dsh-vibe-trading/releases).

## License and attribution

This project is [MIT licensed](LICENSE). It adapts prompt text, tool names, descriptions, and schemas
from [HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading), which is also MIT licensed. The
required copyright and permission notice is reproduced in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). The runtime package `vibe-trading-ai` is installed
separately and retains its own license and notices.

This project is not affiliated with or endorsed by HKUDS. “Vibe-Trading” refers to the upstream project.
