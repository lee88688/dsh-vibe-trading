# 开发与测试（development）

> 面向贡献者/维护者：本地环境、校验命令、真机验收、真实会话测试、场景矩阵、发版步骤。
> 设计事实见 [`architecture.md`](architecture.md)，设计取舍见 [`decisions.md`](decisions.md)，
> 数字门禁机制见 [`number-verification.md`](number-verification.md)。

## 1. 本地环境

- **Node / TypeScript**：Node 24.9+ + pnpm 12；`pnpm install` 会通过 `prepare` 构建 `dist/`
  （`dist/` 仍 git-ignored），之后 `pnpm typecheck` / `pnpm build` 可重复执行
  （TypeScript 7.0.2，`strict` + `noImplicitAny`）。
- **Python（uv 项目）**：仓库根有 `pyproject.toml`、`uv.lock`、`.python-version`；`uv sync` 生成 `.venv/`
  （git-ignored）。dev 依赖 `vibe-trading-ai==0.1.19`（与运行时一致）+ `zstandard`；仓库不是 Python 包
  （`package = false`）。
- **运行时 venv**：由 `/vibe-trading init` 创建在 `~/.vibe-trading/dsh/venv`，插件 worker 用它；`.venv/`
  只给 `scripts/`、`worker/` 的校验与 benchmark 用。校验脚本经 `scripts/validate/py.mjs` 选解释器：
  `VIBE_TRADING_PYTHON` → `.venv` → 已安装运行时 venv → PATH。
- **`_vendor/Vibe-Trading`**：上游的只读参考 clone（不是依赖、不被插件 import）。HEAD 必须等于
  `PINNED_VERSION` 对应 tag 的 commit，`node scripts/validate/check_pin.mjs` 校验。可删，但删后失去源码对照
  （check_pin 把“缺席”标 WARN）。重新 clone：
  `git clone --depth 1 --branch v0.1.19 https://github.com/HKUDS/Vibe-Trading _vendor/Vibe-Trading`。
- **本地目录**：`_personal/`（个人笔记）与 `.dsh/skills/`（个人 skill）已 gitignore；个人内容规则见
  [`../AGENTS.md`](../AGENTS.md) 第 14 条。
- Windows 注意：控制台 cp936 下跑 Python 建议 `PYTHONUTF8=1`；`weasyprint` 缺 GTK 时自动降级 reportlab。

## 2. 本地校验

```bash
pnpm typecheck
pnpm build
node tests/run-all.mjs                    # 178/178
node scripts/validate/check_manifest.mjs  # all pass
node scripts/validate/check_pin.mjs       # PINNED_VERSION 与 _vendor tag/pyproject/uv.lock/venv 一致
pnpm check:docs                           # 文档相对链接可达
pnpm check:private                        # 个人内容/本机绝对路径扫描（denylist）
pnpm check:grounding                      # 23/23
pnpm check:worker                         # 24/24（需外网；离线时可能少 1 项）
pnpm capture:surface                      # 更新 scripts/validate/worker-surface.json
pnpm capture:mcp                          # 从 scripts/env/mcp-tools.json 生成 tracked 的 MCP 快照
pnpm docs:tools                           # 重新生成 docs/tool-surface.md（工具面对照表）
pnpm check:tools                          # 校验对照表未过期（toolsets.json 改了没重生成会 FAIL）
node scripts/dev/command-smoke.mjs        # 命令冒烟（不写 profile）
```

`pnpm verify` = typecheck + build + tests + manifest；`pnpm verify:all` 再加 docs/private/tools/pin/worker/grounding/surface。
`pnpm check:*` 通过 `scripts/validate/py.mjs` 选 Python；指定解释器：
`VIBE_TRADING_PYTHON=/path/to/python pnpm check:grounding`。

**新 clone / CI 的边界**：`scripts/env/*.json`（除 `bundles.json`）和 `scripts/validate/worker-check.json`
是 git-ignored 的采集物；`check_manifest.mjs`、`gen_tool_surface_doc.mjs` 只依赖 tracked 的
`scripts/validate/worker-surface.json` 与 `scripts/validate/mcp-surface.json`，所以新 clone 可以直接跑
`pnpm verify` / `pnpm check:tools`。`check_pin.mjs` 对缺失的采集物与 `_vendor`/运行时 venv 只报 WARN，
不会 FAIL；CI 不需要 `uv sync` 或外网即可完成 Node 部分（见 `.github/workflows/ci.yml`）。

## 3. 真机安装与激活验收

前置：插件已通过 `plugin_manager install_bundle` 安装进 profile（需要批准）；`link:` 安装不执行构建，
**装前先 `pnpm build`**。

| # | 步骤 | 期望 |
|---|---|---|
| 0.1 | Plugin Manager 列表里找到 Vibe Trading | 标题/描述/图标正确，无诊断 |
| 0.2 | 安装 bundle（target = 仓库绝对路径） | `application: applied`，无 warnings |
| 0.3 | 卸载 bundle | profile 恢复；`~/.vibe-trading/dsh/` 数据保留 |
| 1.1 | 新会话 `/vibe-trading status` | config 缺失、worker 未启动、本会话未激活 |
| 1.2 | `/vibe-trading init` | 建 venv、装 `vibe-trading-ai==PINNED_VERSION`、写 config.json |
| 1.3 | 再次 `init` | 1 秒内返回“已就绪”（幂等） |
| 1.4 | 改坏 config.json 后 `init` | 明确诊断；必要时交给 agent 修复 |
| 2.1 | `/vibe-trading on` | 返回真实工具数/组数/技能数 |
| 2.2 | `search_symbol` / `get_market_data` | 候选 / OHLCV + provenance |
| 2.3 | 再 `on` / `off` / 另一会话不激活 | 幂等；`off` 撤销注册；其它会话无 VT 工具 |
| 3.1 | `vt_load_tools({toolset:"research"})` | 紧凑签名列表 |
| 3.2 | `vt_call` 正常调用 / 传错参数 / 未加载直接调 | 正常结果 / VT 错误信封 + schema / 提示先加载 |
| 3.3 | `vt_list_skills` → `vt_load_skill` | outline → offset → section 可用 |
| 3.4 | 大结果（>10k） | 截断 + `FULL RESULT SAVED` + `full_path` |
| 3.5 | 连续两次请求 | 工具定义块一致（前缀缓存命中） |
| 4.1 | 问“你的数字规则” | 复述 6 条原则关键点 |
| 4.2 | 要求带数字的结论 | 调 `report_figures`；正文无 figures 代码块 |
| 5.1 | `verification.enabled=false` 时编造数字 | 无拦截（对照组） |
| 5.2 | 打开门禁，同一问题 | 被拒并纠正；再次失败则轮末面板直接挂在回答下方（不再多跑一轮披露） |
| 5.3 | derived 公式与数字不符 / 不 `search_symbol` 直接查行情 | 被拒并给出原因 / identity 门禁拒绝 |

**回归红线**（每次发版都检查）：

- worker 启动 ≤ 5s（热启动 3.7–4.0s；init 后首次冷启动约 17s）；
- `tools/list` ≤ 0.2s（实测约 0.11s）；
- 激活后稳态 token ≤ 12k（实测约 12.5k；`skills.mode:"none"` 可省约 2.2k）；
- 工具定义块在会话内只变一次（激活时）；
- `off` 后无残留注册与进程泄漏，其它会话完全不受影响。

GUI 目视项（无法自动断言）：`/vibe-trading` 命令出现在 `/` 菜单、Plugin Manager 卡片、工具调用展示、
composer 状态芯片（窄屏 ≤560px 只留图标）、门禁 `turnTail` 面板布局。

## 4. 真实会话测试

1. 启用测试驱动插件：`plugin_manager set_bundle dsh-vt-test-driver enabled=true`（测完**必须禁用**）。
2. 用 `vt_test_session`：
   - `action=start`（cwd=仓库、preset=standard、activate=true、wait=false）→ sessionId；
   - 多轮用 `action=send`；斜杠命令用 `action=command`（`send` 只发普通文本、不执行命令）；
   - `action=resume` 验证已存会话可打开；`action=fork` 复刻 GUI fork（回归 fork 自动恢复）；
   - 结束 `action=dispose`。
3. 等会话跑完：`python scripts/dev/session-state.py <session log>...`（不要用子串搜 `turn/end`，日志引用该词会误判）。
4. 审计：`session-review.py`（逐条事件）、`audit-parity.py`（工具/错误/声明/suppressed/pwsh 统计）、
   `session-assistant-text.py`（各轮 assistant 文本）。
5. 会话日志：`$DSH_HOME/sessions/<编码后的 cwd>/<sessionId>/session.v4.jsonl.zstd`（用
   `node scripts/dev/session-log.mjs <sessionId>` 定位）。
6. 通过标准：0 工具错误、最终正文无 ```figures 块、交易类请求明确拒绝、不可知问题不编造、
   无 pwsh 兜底（文件阅读类除外）。

## 5. 场景矩阵

发版前至少复跑门禁与工具链相关场景（每类一个会话）：

| 场景 | 关注点 |
|---|---|
| 行情查询 | 表格数据正确；涨跌幅按 derived 声明 |
| 研报整理 | 评级/EPS/目标价齐全、带来源 |
| 财报解读 | 三表/同比；非价格金额单位规则 |
| 估值判断 | 技能路由（`research-discipline`/`valuation-model`）；derived PE 操作数 |
| 研究流程工具 | hypothesis/artifact/runs 落盘 `dsh/work/research` |
| 交易指令 | 明确拒绝执行，不编造成交 |
| 文件阅读 + 非财务数字 | `suppressed` 忽略规则生效，文档事实正确 |
| 多轮追问 | 两轮各自通过门禁，正文无块 |
| 回测策略 | 产出 run_dir（run_card/metrics/trades），说明成本/局限 |
| 期权/保护性看跌 | A 股个股期权不可得时不编造权利金 |
| 未来说明（诱导编造） | 明确不可知；给情景并标假设 |

**已知限制**（不是 bug）：热重载会注销活跃会话的工具（更新后需重新 `on` 或新建会话）；数字门禁对数值密集
回答通常 2–4 轮修正；价格声明必须带数据源+币种；交易类工具不暴露；`driver/` 仅测试用、默认禁用。

## 6. 发版 / 升级 / 卸载

- 升级运行时 pin：按 skill `vt-version-pin`（改 `PINNED_VERSION` + `pyproject.toml` + `uv.lock` + `_vendor` tag，
  跑 parity/capture/全套校验）。
- 插件版本：**只改 `package.json` 的 `version`**。README/AGENTS/docs 不再写死插件版本（安装命令用
  `@latest` 或 `@<version>` 示例）；`pnpm build` 后再 reload（无活跃 turn 时）。
- **DSH 宿主兼容**：`package.json` 的 `engines.dsh`（当前 `>=0.2.2-rc.5`）由 DSH app-boot 在 profile 加载时判定
  （`semver.satisfies(..., { includePrerelease: true })`，单一下限即可，见 decisions D24）；不满足时该 bundle 被
  跳过（`skippedBundles`）。升级 DSH 后先按 §4 做真实会话 smoke，然后把下限抬到新的优化基线（抬高 = 旧 profile 里
  该 bundle 被跳过，Desktop 等旧宿主需先升级）；`check_manifest.mjs` 会校验字段形态。
- reload/升级会 dispose 活跃会话工具；0.2.7 起带 `/vibe-trading on` 历史的会话自动恢复，进行中的 turn 仍可能被打断。
- 卸载：`plugin_manager remove_bundle`；profile 恢复，`~/.vibe-trading/dsh/`（venv/work/logs/config）保留，重装后正常。

**发布步骤（GitHub + npm）**：

1. `pnpm verify:all` 全绿；至少复跑第 3 节真机验收与第 5 节场景矩阵（Python 检查需要 `uv sync` + 外网）。
2. 确认工作区干净：`git status`；`dist/`、`scripts/env/*.json`、`worker-check.json`、`.venv/` 都不进提交。
3. 只改 `package.json` 的 `version`，提交，打 annotated tag：
   `git tag -a vX.Y.Z -m "dsh-vibe-trading X.Y.Z"`。
4. **单独推送 tag**：`git push origin main`，再 `git push origin vX.Y.Z`。不要和 `main` 放在同一次 push；
   `publish.yml` 会校验 tag 与 `package.json` 一致，跑 `pnpm verify:ci`，用 OIDC 发布 npm，并用
   `gh release create --generate-notes` 自动创建 GitHub Release。发布说明看 GitHub Releases，不维护 `CHANGELOG.md`。
5. **首次发布一个全新的 scoped 包**仍需要一次 token/bootstrap（npm 不能给尚不存在的包预配置 Trusted Publisher）；
   本仓库 0.4.0 已完成这一步，之后不需要 `NPM_TOKEN`。
6. 安装方式：`plugin_manager install_bundle target = "@monsterlee/dsh-vibe-trading@latest"`；需要可复现时把
   `@latest` 换成 `@<version>`。源码安装仍可用 `clone + pnpm install + target=<绝对路径>`。发布后按 README
   的安装步骤跑一遍冷启动验证。

**npm token（仅首次发布/无 Trusted Publishing 时）**：npm 从 2025-11 起只支持 granular access token；
classic token 已移除。需要 token 时：

1. npmjs.com → 头像 → **Access Tokens** → **Generate New Token**。
2. Token name：`dsh-vibe-trading-bootstrap`；Expiration：7–30 天（只用于引导，不要长期保留）。
3. **Packages and scopes** → **Only select packages and scopes** → 选 `@monsterlee/dsh-vibe-trading`
   （包还不存在时选 `@monsterlee` scope）；Permissions：**Read and write (publish and stage)**。
4. **Bypass two-factor authentication**：勾选（CI 无法交互输入 OTP）。Allowed IP ranges 留空
   （GitHub-hosted runner 的出口 IP 不固定）；Organizations 选 **No access**。
5. Generate 后立即复制；GitHub 仓库 **Settings → Secrets and variables → Actions** 新建
   `NPM_TOKEN`，只在 tag 发布 job 里用 `NODE_AUTH_TOKEN` 注入；不要在 `pull_request` 工作流里引用。
6. 完全不本地登录的首发：**Actions → Publish npm → Run workflow → bootstrap=true**。该路径用
   `NODE_AUTH_TOKEN` 发布；`workflow_dispatch` 只允许在 `main` 上运行。成功后配置 Trusted Publishing。
7. 配置好 Trusted Publishing 后**撤销该 token、删除 `NPM_TOKEN` secret**。npm 计划从 **2027-01** 起移除
   bypass-2FA token 的直接发布能力，长期方案应是 Trusted Publishing。

**CI**：`.github/workflows/ci.yml` 在 Linux/Windows 上跑 typecheck、build、178 个测试、manifest、docs/private/
tools/pin；不跑需要 `uv sync` 或外网的 Python 检查。CI 的 `check_pin` 对缺失的 `_vendor`/运行时 venv 只报 WARN。
[`.github/workflows/publish.yml`](../.github/workflows/publish.yml) 在 `v*` tag 上用 OIDC 发布；也支持
`workflow_dispatch` + `bootstrap=true`，用 `NPM_TOKEN` 完成首次发布。
