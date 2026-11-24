---
name: vt-version-pin
description: 核对并同步 dsh-vibe-trading 的适配版本固定点（src/lib/config.ts 的 PINNED_VERSION）与 _vendor/Vibe-Trading checkout、pyproject/uv.lock、运行时 venv、快照资产是否一致。用于开始本地开发前、升级 vibe-trading-ai 前后、重新 clone _vendor、或 /vibe-trading status 显示“未验证版本”时；默认只读检查，升级/回退需用户明确授权。
whenToUse: 当用户说“版本对不上 / vendor 是哪个版本 / 先固定到某个版本 / 要不要升级 VT / 升级前先对齐 / pin 改成几”，或改动了 PINNED_VERSION、pyproject.toml、_vendor checkout 之后。
---

# vt-version-pin

## 这是什么

插件只对**一个** `vibe-trading-ai` 版本负责：`PINNED_VERSION`（`src/lib/config.ts`）。
它与 worker 的私有 import（`src.tools.build_registry`、`src.agent.skills`、`src.agent.grounding.*`）、
`toolsets.json` 的工具面快照、`prompt/vibe-trading.md` 的 6 条原则、`_vendor` 源码参照都是**同一版本**的资产。
任何一处漂移，都会让“已验证”失去意义。

**单一事实源**：`src/lib/config.ts` 的 `PINNED_VERSION`（当前 `0.1.19`）与 `DEFAULT_VERIFIED_VERSIONS`。
**其它所有记录都必须等于它**：`pyproject.toml` 的 dev pin、`uv.lock`、`_vendor/Vibe-Trading` 的 tag、
运行时 venv 的安装版本；`scripts/env/*.json` 等快照资产允许滞后，但会告警。

## 快速检查（只读，先跑这个）

```powershell
node scripts/validate/check_pin.mjs
```

无子进程（不调 `git`/`python`），DSH 沙箱内可用。输出 `PASS/WARN/FAIL`：

| 位置 | 期望 | 不一致时 |
|---|---|---|
| `src/lib/config.ts` | `PINNED_VERSION=x.y.z`，`DEFAULT_MINIMUM_VERSION = PINNED_VERSION` | 只有升级版本时才改，见下文 |
| `pyproject.toml` | `"vibe-trading-ai==x.y.z"` | 改 dev 依赖 → `uv lock` |
| `uv.lock` | `name = "vibe-trading-ai"` 下 `version = "x.y.z"` | `uv lock`（不要手改） |
| `_vendor/Vibe-Trading` | `HEAD` 等于 tag `vx.y.z` | `git -C _vendor/Vibe-Trading fetch --tags` + `git -C _vendor/Vibe-Trading checkout vx.y.z` |
| `scripts/env/loading-metrics.json`、`scripts/validate/worker-check.json`、`scripts/env/mcp-tools.json` | 记录 `x.y.z` | 升级后 `pnpm capture:surface` 并重跑校验 |
| `~/.vibe-trading/dsh/venv` | 安装 `x.y.z` | `/vibe-trading init --pinned`（或 `node scripts/dev/init.mjs`） |

`_vendor` 不存在 = WARN（可以没有）；存在但其 HEAD 不是 tag = **FAIL**（本地开发必须对齐到固定版本）。

## 升级或回退版本（需用户明确授权）

按顺序做，**不要只改一处**：

1. **确认目标版本**：`pip index versions vibe-trading-ai` 或 PyPI 页面；确认 changelog 里工具面/门禁相关变化。
2. **对齐参照源码**：
   ```powershell
   git -C _vendor/Vibe-Trading fetch --tags
   git -C _vendor/Vibe-Trading checkout vX.Y.Z
   git -C _vendor/Vibe-Trading describe --tags --always   # 必须是 vX.Y.Z
   ```
3. **改单一事实源**：`src/lib/config.ts` 的 `PINNED_VERSION`，以及 `DEFAULT_VERIFIED_VERSIONS`
   （默认只放新版本；确有必要保留旧版本兼容时才加进去，并在 config 校验里明确）。
4. **改 dev 依赖**：`pyproject.toml` 写 `vibe-trading-ai==X.Y.Z` → `uv lock` → `uv sync`。
5. **重扫上游差异**：运行 `vt-parity-check` 技能（工具/技能/提示词/门禁四张表），据此判断是否需要
   更新 `toolsets.json`（组、hidden 理由）和 `prompt/vibe-trading.md`。
6. **重跑本地校验**：`pnpm typecheck && pnpm build && node tests/run-all.mjs`、
   `node scripts/validate/check_pin.mjs`、`node scripts/validate/check_manifest.mjs`、`pnpm check:worker`、`pnpm check:grounding`、
   `pnpm capture:surface`。
7. **对齐运行时**：`node scripts/dev/init.mjs --verify` 看版本；需要重装时
   `/vibe-trading init --pinned`（回退）或 `/vibe-trading init --latest`（跟随最新，会标记未验证）。
8. **同步文档**：`AGENTS.md`（版本数字/_vendor 段）、`docs/decisions.md`（D20/D11）、`docs/development.md`、
   必要时 `docs/architecture.md` 的版本策略段；`package.json` 升一个 patch 版本。
9. 最后再跑一次 `node scripts/validate/check_pin.mjs`：**0 FAIL** 才算收口；WARN 要逐条解释
   （缺 `_vendor`/缺运行时 venv/快照滞后都可接受），要求零 WARN 时加 `--strict`。

## 铁律

- **默认只读**：本技能默认跑检查、列差异、给命令；改版本必须用户明确说“升级/回退”。
- **`_vendor` 只读**：不要修改 `_vendor/Vibe-Trading` 里的文件；要读源码先 checkout 到 tag。
- **不要手改 `uv.lock`**，走 `uv lock`。
- **不要在未跑 `vt-parity-check` + 全套校验前宣布升级完成**。
- **不要在会话进行中热重载插件**（会 dispose 已注册的 10 个工具），见 AGENTS.md 规则 1。
- 找不到证据就不写结论；每条不一致都指到 `file:line` 或命令输出。

## 相关

- `AGENTS.md` §1/§3.5/§5：版本固定说明、`_vendor` 不变量、校验命令。
- `scripts/validate/check_pin.mjs`：本技能的机器检查实现。
- `vt-parity-check` 技能：升级后的功能/行为一致性扫描。
