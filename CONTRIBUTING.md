# Contributing

Thanks for taking a look. This is a small project with a deliberately narrow surface: a DSH plugin, a
Python worker, and the tests/checks around them. Contributions that make the tool surface, the number
gate, or the install path more reliable are especially welcome.

By contributing, you agree that your contributions are licensed under the repository's
[MIT license](LICENSE).

## Before you start

1. Read [AGENTS.md](AGENTS.md) (repository rules and code map) and
   [docs/development.md](docs/development.md) (setup and test commands).
2. Check [docs/tool-surface.md](docs/tool-surface.md) before proposing a new tool. Some upstream tools
   are intentionally hidden, replaced by DSH tools, or gated behind credentials, and the table records
   why.
3. For security issues, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Setup

Prerequisites: **Node.js ≥ 24.9**, **pnpm 12.x**, **Python 3.12** (for the Python checks), and a DSH
`>=0.2.2-rc.5` installation if you want to test activation in a real session.

```bash
git clone https://github.com/lee88688/dsh-vibe-trading.git
cd dsh-vibe-trading
pnpm install      # "prepare" builds dist/
pnpm verify       # typecheck + build + 178 tests + manifest
```

`dist/` is git-ignored. Maintainers publish the package as `@monsterlee/dsh-vibe-trading`; do not run
`npm publish` from a fork. The unscoped `dsh-vibe-trading` package is a different project and is not
this code. For local installation, see the README's “Install → From source”.

The Python checks use an optional uv environment:

```bash
uv sync --frozen
pnpm check:grounding
pnpm check:worker   # needs network access; a data-source failure can reduce the count
```

`_vendor/Vibe-Trading` is an optional read-only reference checkout at the pinned tag. Without it,
`check_pin.mjs` reports a warning instead of a failure; the source vendor directory is not required to
build or test the plugin.

## Checks

Run the relevant subset before opening a pull request:

| Command | What it covers |
|---|---|
| `pnpm typecheck` | TypeScript strict typecheck |
| `pnpm build` | Emit `dist/` |
| `node tests/run-all.mjs` | 178 Node unit tests |
| `node scripts/validate/check_manifest.mjs` | package/patch/locale/toolset consistency |
| `pnpm check:docs` | relative Markdown links |
| `pnpm check:private` | personal content and machine-specific paths |
| `pnpm check:tools` | `docs/tool-surface.md` freshness |
| `node scripts/validate/check_pin.mjs` | `PINNED_VERSION` vs `uv.lock` / vendor / captures |
| `pnpm check:grounding` | grounding adapter (needs `uv sync`) |
| `pnpm check:worker` | live worker surface (needs network) |

`pnpm verify:ci` is the subset CI runs. CI covers Linux and Windows; the Python checks are maintainer
checks because they need a populated environment and external data sources.

## Changing what

- **Prompt or tool catalog:** update `prompt/` and/or `toolsets.json`, then run
  `pnpm docs:tools` and `pnpm check:tools`. Keep the number-gate rules in sync with
  [docs/number-verification.md](docs/number-verification.md) and `src/lib/verify.ts`.
- **Tool surface:** a worker tool must be accounted for in `toolsets.json` (advertised, hidden,
  replaced, gated, or dropped). `check_manifest.mjs` fails on undocumented registry tools.
- **Pin/upstream version:** follow the `vt-version-pin` skill and update `PINNED_VERSION`,
  `pyproject.toml`, `uv.lock`, `_vendor` tag, and the captured surfaces together.
- **Profile settings:** add the default in `src/lib/settings.ts`, mark the schema field `.volatile()`,
  and update `SETTING_KEYS` plus the client-side form. Do not write behavior settings to
  `~/.vibe-trading/dsh/config.json`.
- **User-facing behavior:** update `README.md`, `README.zh-CN.md`, and the relevant `docs/` page. Keep
  the two READMEs aligned on numbers and commands.

## Pull requests

- Keep a PR focused; split unrelated refactors.
- Add a test when behavior changes. Tests import the built `dist/`, so run `pnpm build` first.
- Do not commit `dist/`, `node_modules/`, `.venv/`, logs, generated JSON under `scripts/env/`, or
  personal notes.
- Do not add secrets, API keys, account IDs, machine-specific absolute paths, or personal research
  data. `pnpm check:private` is a guard, not a substitute for care.
- Use clear conventional-style commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).

## Code of conduct

Participation is covered by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Be direct about technical
problems and respectful to the people discussing them.
