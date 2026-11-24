# Security policy

## Supported versions

This is a pre-1.0 project. Security fixes target the latest `0.4.x` release and `main`. Older 0.2.x/0.3.x
tags are kept for reference but are not actively maintained.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

<https://github.com/lee88688/dsh-vibe-trading/security/advisories/new>

Do not open a public issue for a suspected vulnerability. Include:

- the affected version (`/vibe-trading status` or `package.json`),
- DSH and Node.js versions, and the operating system,
- a minimal reproduction or the relevant request/tool call,
- impact and any known preconditions,
- logs with API keys, tokens, and personal paths removed.

You can expect an initial acknowledgement within a few days. If the report is about upstream
Vibe-Trading behavior rather than this plugin, it may be forwarded to
[HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading).

## Scope

In scope:

- the TypeScript plugin (`src/`, `client.js`, `dist/` build inputs),
- the Python worker (`worker/`) and its JSON-RPC bridge,
- install/activation code, including how `vibe-trading-ai` is resolved and launched,
- prompt/gate logic that could cause unsafe or misleading output,
- repository content that leaks credentials or executes untrusted code unexpectedly.

Out of scope for this repository:

- vulnerabilities in `vibe-trading-ai` or its dependencies (report upstream, but tell us if the plugin's
  integration makes them worse),
- third-party market-data services and their terms of service,
- vulnerabilities in DSH itself (report to the DSH project).

## Trust model

This plugin runs local code with your user privileges. Treat it accordingly:

- **The Python worker is not sandboxed by DSH.** Vibe-Trading tools (including file read/write and
  backtest runners) execute inside the worker process. The worker can access paths your user can access.
- **`/vibe-trading init` installs from PyPI.** By default it installs exactly
  `vibe-trading-ai==0.1.19` into `~/.vibe-trading/dsh/venv`. `--latest` follows the newest release and is
  reported as unverified. Review [docs/data-sources.md](docs/data-sources.md) before supplying
  credentials.
- **`worker.patchFile` executes arbitrary Python by design.** It is a documented extension point for
  trusted local operators. Only point it at code you have reviewed; a failing patch is reported in
  `ping.startup.user_patch` and does not take the worker down.
- **Credentials are read by upstream tools.** Data-source tokens may come from environment variables or
  a local `.env`. They are not committed by this repository; do not paste them into issues, logs, or
  prompts.
- **No telemetry is added by this plugin.** Network calls come from the upstream tools and the package
  install. The plugin writes local state under `~/.vibe-trading/dsh/` (venv, logs, work, research store).

## Hardening notes

- Keep DSH, Node.js, and `vibe-trading-ai` current within the pinned compatibility range.
- Install from a trusted checkout and review changes before running `/vibe-trading init --latest`.
- Avoid enabling `worker.patchFile` from a shared or downloaded path.
- Do not run the plugin with a Python environment you do not trust; the worker imports the installed
  `vibe_trading` package at startup.
