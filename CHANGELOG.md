# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

> `0.4.0` is the first public release. Earlier `0.2.x`–`0.3.x` iterations were pre-public; the public
> git history starts here. Version references in `AGENTS.md` and `docs/decisions.md` (for example
> “0.2.7 起”) record when a behavior was introduced, not public tags.

## [0.4.0] - 2026-11-20

First public release, published as `@monsterlee/dsh-vibe-trading` on npm and available from source on
GitHub.

### Added

- Per-tool exposure table in [docs/tool-surface.md](docs/tool-surface.md): advertised, DSH-replaced,
  credential-gated, hidden, and dropped tools, each with a reason.
- Credential-gated catalog entries: a tool is advertised only when the worker reports its required
  credential as available.
- Tool names aligned with the Vibe-Trading agent registry; MCP wrapper names are mapped only in
  `prompt/bridge.md`.
- Tracked MCP surface snapshot (`scripts/validate/mcp-surface.json`) so checks work on a fresh clone.

### Changed

- Scoped npm package `@monsterlee/dsh-vibe-trading`, public access, with GitHub source and CI.
- Configuration and metadata for an open-source release: English README plus Chinese translation,
  contribution and security files, third-party notices.
- `pnpm install` now builds `dist/` through the `prepare` lifecycle.

### Fixed

- Checks no longer depend on git-ignored benchmark artifacts for the worker and MCP surfaces.

[0.4.0]: https://github.com/lee88688/dsh-vibe-trading/releases/tag/v0.4.0
