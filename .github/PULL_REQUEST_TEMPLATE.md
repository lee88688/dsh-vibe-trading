## Summary

<!-- What changed, and why? Link the issue if one exists. -->

## Verification

<!-- Paste the relevant commands and results. -->

- [ ] `pnpm typecheck`
- [ ] `pnpm build`
- [ ] `node tests/run-all.mjs`
- [ ] `node scripts/validate/check_manifest.mjs`
- [ ] `pnpm check:docs`
- [ ] `pnpm check:private`
- [ ] `pnpm check:tools`
- [ ] `node scripts/validate/check_pin.mjs`

Python checks (`pnpm check:worker`, `pnpm check:grounding`) need `uv sync` and network access; run them when the change touches `worker/`, `prompt/`, or data sources.

## Checklist

- [ ] The change is focused; unrelated refactors are split out.
- [ ] Tests cover the behavior, or the PR explains why a test is not practical.
- [ ] User-facing behavior and limitations are reflected in `README.md` / `README.zh-CN.md` or `docs/`.
- [ ] If `toolsets.json` changed, `pnpm docs:tools` was run and `docs/tool-surface.md` is current.
- [ ] If the pinned Vibe-Trading version changed, the `vt-version-pin` steps were followed.
- [ ] No secrets, API keys, personal notes, or machine-specific absolute paths were added.
- [ ] `dist/` and generated artifacts are not committed.

## Notes

<!-- Screenshots, logs, trade-offs, or follow-up work. -->
