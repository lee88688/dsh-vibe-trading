# Third-party notices

This project integrates with and adapts material from **Vibe-Trading**, an MIT-licensed project:

- Upstream: <https://github.com/HKUDS/Vibe-Trading>
- Copyright (c) 2026 Vibe-Trading Contributors
- License: MIT (reproduced below)

Adapted material in this repository includes:

- `prompt/vibe-trading.md` — a DSH-specific adaptation of the upstream agent system prompt
  (`agent/src/agent/context.py`, `_SYSTEM_PROMPT`), including the “Output Principles” and file/write
  reporting rules.
- `prompt/bridge.md` — mappings between Vibe-Trading registry names and MCP-facing names.
- `toolsets.json`, `worker/vibe_trading_worker.py` (fallback tool catalog), and
  `docs/tool-surface.md` — tool names, descriptions, schemas, and surface classifications derived from
  the Vibe-Trading public tool registry and MCP surface.
- `worker/grounding_adapter.py` and the number-gate integration — an adapter around Vibe-Trading's
  grounding behavior, not a copy of the upstream package.

The runtime package `vibe-trading-ai` is installed separately by `/vibe-trading init` and keeps its own
license, notices, and third-party attributions. This repository does not vendor the upstream runtime,
its Qlib factor definitions, or its font assets; those remain with the installed package.

Vibe-Trading's own `NOTICE` records additional attributions for material bundled in the upstream
package. Consult the installed `vibe-trading-ai` distribution and its `NOTICE` for those terms.

## Vibe-Trading MIT license

```text
MIT License

Copyright (c) 2026 Vibe-Trading Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## This project

`dsh-vibe-trading` is licensed under MIT; see [LICENSE](LICENSE). It is an independent community
integration and is not affiliated with or endorsed by HKUDS.
