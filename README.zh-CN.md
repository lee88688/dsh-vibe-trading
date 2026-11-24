# dsh-vibe-trading

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/lee88688/dsh-vibe-trading/actions/workflows/ci.yml/badge.svg)](https://github.com/lee88688/dsh-vibe-trading/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@monsterlee/dsh-vibe-trading)](https://www.npmjs.com/package/@monsterlee/dsh-vibe-trading)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A50.2.2--rc.5-4E6DD4)](https://github.com/deepseek-ai/deepseek-harness)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件：把
[Vibe-Trading](https://github.com/HKUDS/Vibe-Trading) 的金融研究工具、技能和数字纪律放进 DSH 会话。
**DSH 跑 agent loop**，Vibe-Trading 继续提供工具注册表、89 份专业技能和金融领域输出规则。

npm 包：[`@monsterlee/dsh-vibe-trading`](https://www.npmjs.com/package/@monsterlee/dsh-vibe-trading)；源码在本仓库。

> **状态**：`0.4.1`，在 DSH `0.2.2-rc.5` + `vibe-trading-ai` `0.1.19` 的 Windows 11 web profile
> 实测通过；GitHub Actions 在 Linux 与 Windows 上构建并运行测试。
> 本项目是独立社区集成，**不是** HKUDS 官方项目。
>
> **仅用于研究和教育。** 不执行交易，不构成投资建议。

## 插件做什么

- **常驻 Python worker，不用 MCP server。** worker 通过 newline JSON-RPC 直接调用 Vibe-Trading 的
  `build_registry()`；启动约 3.7–4.0 秒，`tools/list` 约 0.11 秒，全程不 import `mcp_server`。
- **127 个工具、89 份技能。** 会话激活时注册 6 个常驻工具 + 4 个网关工具；其余 83 个 worker 工具
  按 9 个工具组加载（`research` / `research-workflow` / `backtest` / `quant` / `verify` / `team` /
  `trading-reads` / `goals` / `runio`）。
- **提示词缓存稳定。** 激活后工具定义块不再变化；稳态约 12.5k tok（工具定义 ≈1.8k + 提示词 ≈10.9k）。
- **数字核实门禁默认开启。** `report_figures` 是真实工具，正文不出现 `figures` 代码块；identity /
  evidence / derived 三类检查在数字回答被接受前运行，轮末 `turnTail` 面板展示核实明细。机制见
  [docs/number-verification.md](docs/number-verification.md)。
- **按会话激活。** `/vibe-trading on` 只影响当前会话；reload/升级后，日志里带 `on` 的会话会自动恢复。
- **不覆盖宿主行。** `cordis.patch.yml` 只插入本插件一行，不改任何宿主配置。回测 run 目录的读写走
  Vibe-Trading 自己的 `read_file` / `write_file`（Python worker 不受 DSH 文件沙箱限制）。

## 运行要求

| 组件 | 版本 | 说明 |
|---|---|---|
| DSH | `>=0.2.2-rc.5` | 写在 `engines.dsh`；更低版本会在 profile 加载时跳过本 bundle |
| Node.js | `>=24.9.0` | DSH 自身要求；本仓库在 Node 24.9 上测试 |
| pnpm | 12.x | 安装依赖、构建 `dist/` |
| Python | 3.12 | `/vibe-trading init` 用它创建 worker venv |
| 网络 | PyPI + 数据源 | `init` 安装 `vibe-trading-ai`；行情工具需要数据源访问 |

主要验证平台是 Windows 11；Linux/macOS 理论可用，但实测较少。`uv` 是可选的，`init` 也可以使用
系统 Python 或 DSH 自带 Python。

## 安装

插件发布在 npm 的 **`@monsterlee/dsh-vibe-trading`**。在 DSH 会话里让 agent 调用：

```text
plugin_manager install_bundle target = "@monsterlee/dsh-vibe-trading@0.4.1"
```

也可以用 `@latest`，但 1.0 之前建议固定版本，保证宿主/工具面对得上。然后**新建会话**：

```text
/vibe-trading init     # 创建 ~/.vibe-trading/dsh/venv，安装 vibe-trading-ai==0.1.19
/vibe-trading on       # 激活当前会话（不影响其它会话）
/vibe-trading status
```

`init` 冷缓存约 1–2 分钟，可重复执行。它把安装事实写到 `~/.vibe-trading/dsh/config.json`；行为配置
（门禁、技能模式、worker 参数）则写进当前 profile 的 `cordis.patch.yml`，两者不要混。

> npm 上**不带 scope** 的 `dsh-vibe-trading` 是另一个项目；装它不会得到本仓库的代码，请使用上面的
> `@monsterlee/` 包名。

### 从源码安装

开发插件或验证未发布改动时使用：

```bash
git clone https://github.com/lee88688/dsh-vibe-trading.git
cd dsh-vibe-trading
pnpm install     # 安装开发依赖，并通过 prepare 构建 dist/
pnpm verify      # 可选：类型检查 + 构建 + 178 个测试 + manifest 校验
```

在 DSH 里用 `plugin_manager install_bundle target = "<本仓库的绝对路径>"` 安装，或在
**插件 → 添加插件** 里选择目录；之后同样在新会话执行 `init` / `on`。

## 常用命令

| 命令 | 作用 |
|---|---|
| `/vibe-trading init [--pinned\|--latest]` | 创建/修复 Python venv，安装固定版本（默认 `0.1.19`） |
| `/vibe-trading on` | 启动/复用 worker，激活当前会话 |
| `/vibe-trading off` | 撤销当前会话的工具；只在该会话第一轮对话前可用 |
| `/vibe-trading status` | 查看环境、worker、门禁和会话状态 |
| `/vibe-trading config set <key> <value>` | 修改 profile 设置（例如 `verification.enabled false`） |

激活后注册 6 个常驻工具（含 `report_figures`）和 4 个网关工具（`vt_load_tools` / `vt_call` /
`vt_list_skills` / `vt_load_skill`）。逐工具对照见 [docs/tool-surface.md](docs/tool-surface.md)。

## 设计要点

- **激活靠命令，不做全局挂载。** 只有执行 `/vibe-trading on` 的会话才加载 worker、工具和提示词；
  其它会话保持干净，工具面也更容易解释。
- **worker 是边界。** TypeScript 插件负责进程生命周期、JSON-RPC 结果到 DSH 工具的映射和输出规则；
  Python worker 负责 Vibe-Trading 注册表。
- **数字必须能指回工具。** 行情、财报、计算值和派生指标都要能指回本会话的工具调用；价格必须带
  数据源和币种，非价格金额不能带货币词。门禁可以按 profile 关闭，但默认开启。
- **交易类工具不暴露。** 下单、eToro、mandate 工具不会出现在目录里；模型必须拒绝交易指令，而不是
  编造成交。
- **安装版本固定。** `/vibe-trading init` 默认精确安装 `vibe-trading-ai==0.1.19`；只有 `--latest`
  才跟随最新，并标记为“未验证”。

## 校验

```bash
pnpm verify       # 类型检查 + 构建 + 单元测试 + manifest
pnpm verify:all   # 再加 docs/private/tools/pin/surface/worker/grounding
```

当前基线：**178/178** Node 测试、manifest 全部通过、`check_pin.mjs` 0 FAIL。Python 检查
（`check:worker`、`check:grounding`）需要 `uv sync` 和外网，见
[docs/development.md](docs/development.md) §2。CI 在 Linux 和 Windows 上运行 Node 部分。

## 文档

| 文档 | 作用 |
|---|---|
| [AGENTS.md](AGENTS.md) | 跨会话交接：规则、环境、代码地图、调试 |
| [docs/README.md](docs/README.md) | 文档索引与维护约定 |
| [docs/architecture.md](docs/architecture.md) | 设计事实与组件边界 |
| [docs/decisions.md](docs/decisions.md) | 已定设计决策（D1–D27） |
| [docs/number-verification.md](docs/number-verification.md) | 数字核实机制与计算工具 |
| [docs/data-sources.md](docs/data-sources.md) | 行情数据来源、失败原因与用户配置 |
| [docs/development.md](docs/development.md) | 开发环境、校验、真机验收、真实会话测试、发版 |
| [docs/tool-surface.md](docs/tool-surface.md) | 逐工具暴露/接管/禁用对照表 |
| [docs/postmortems/install-hang.md](docs/postmortems/install-hang.md) | 首次安装挂起的复盘 |

## 已知限制

- **热重载会打断活跃 turn。** 启用/禁用/升级插件会 dispose 当前会话的工具，尽量在两轮之间操作。
  带激活意图的会话会自动恢复，但进行中的 turn 仍可能收到 `unknown tool`。
- **`off` 只能在第一轮前用。** 开始对话后撤销工具会让历史里的调用变成 `unknown tool`，并作废提示词
  缓存；需要不带 Vibe Trading 的会话就新建一个。
- **门禁通常需要 2–4 轮修正。** 数值密集回答会反复调用 `report_figures`；预算耗尽后降级为轮末披露
  面板，而不是静默接受未核实数字。
- **数据源不是永远可用。** 部分数据源需要凭据、会限流，或从当前网络不可达。模型应明确说“未取到”，
  不能从记忆补数字。
- **第三方斜杠命令显示面受限。** DSH 0.2.2-rc.5 不给非宿主命令画图标或本地化标题；`/vibe-trading`
  只显示描述和输入提示。
- **profile 设置的生效时机不同。** `verification.*` 和 worker 超时对下一次工具调用生效；
  `skills.mode` 只影响下一次激活。

## 参与贡献与安全

- 提 PR 前先读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请用
  [GitHub 私密安全公告](https://github.com/lee88688/dsh-vibe-trading/security/advisories/new)，
  不要开公开 issue。信任模型见 [SECURITY.md](SECURITY.md)。
- 变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证与来源

本项目使用 [MIT 许可证](LICENSE)。提示词正文、工具名、工具描述和 schema 改编自
[HKUDS/Vibe-Trading](https://github.com/HKUDS/Vibe-Trading)（同为 MIT）。上游版权与许可声明完整
转载在 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。运行时包 `vibe-trading-ai` 由 `init` 单独
安装，保留其自身的许可证和声明。

本项目与 HKUDS 无隶属或背书关系；“Vibe-Trading”指上游项目。
