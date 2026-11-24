# AGENTS.md — dsh-vibe-trading 跨会话交接

> 给后续 session / 其他 agent 的最小必要上下文。先读本文件，再看 [docs/README.md](docs/README.md)（文档索引）；细节都在 `docs/`。
> 最后更新：2026-11-24（开源发布骨架：英文 README + README.zh-CN、CI、CONTRIBUTING/SECURITY/THIRD-PARTY-NOTICES、GitHub 模板；包名改为 npm scope `@monsterlee/dsh-vibe-trading`，发布 npm + GitHub 源码；新 clone 的 Node 校验不再依赖 git-ignored 采集物；版本号只在 `package.json` 维护，发布说明由 GitHub Release 自动生成）。
> **公开 git 历史从 0.4.0 开始**（0.2.x–0.3.x 是公开前内部迭代；文中“0.2.7 起/0.3.x 起”是行为溯源，不是公开 tag）。

## 1. 项目是什么

`dsh-vibe-trading` 是一个 **DSH host 插件**：让 DeepSeek Harness 跑 agent loop，Vibe-Trading
继续提供工具、技能和金融领域纪律，替代 Vibe-Trading 自带的 agent。

- 仓库：<https://github.com/lee88688/dsh-vibe-trading>（本文件所在目录；下文相对路径都相对于仓库根，换机器 clone 后无需改动）
- 包名 **`@monsterlee/dsh-vibe-trading`**（npm scope `monsterlee`），version 以 `package.json` 为准（当前 `0.4.x`）；
  profile 行 id 仍为 `dsh-vibe-trading`（`cordis.patch.yml` 的 `id`），`name` 指向 scoped 包；npm 上不带 scope 的
  `dsh-vibe-trading` 是另一个项目，不要混用。profile 里 link 安装，reload 后加载当前 dist；`main`/`exports` →
  `dist/index.js`；`pnpm install` 的 `prepare` 会构建 `dist/`；bundle patch 只有一条 `- insert:`（不 override 宿主行）
- 当前状态：已构建、已安装进 **web profile**（本机实测）、**已启用**（`plugin_manager` 行 `dsh-vibe-trading`）
- 运行时 venv：由 `/vibe-trading init` 创建在 `~/.vibe-trading/dsh/venv`（本机实测装的是 vibe-trading-ai 0.1.19；
  Windows 入口 `Scripts/python.exe`，POSIX 为 `bin/python`）
- **版本固定（单一事实源）**：`PINNED_VERSION = 0.1.19`（`src/lib/config.ts`）。`/vibe-trading init` 默认
  `pip install vibe-trading-ai==0.1.19`；`/vibe-trading init --latest` 才跟随最新（结果会标"未验证"，`status`/`on` 告警但不阻断）。
  `_vendor/Vibe-Trading` 必须 checkout 到同一 tag，`pyproject.toml`/`uv.lock`/运行时 venv 都必须一致：
  `node scripts/validate/check_pin.mjs` **0 FAIL** 才算对齐（WARN 是提示；`--strict` 时 WARN 也算失败）；升级流程见 **skill `vt-version-pin`**。
- 宿主：DeepSeek Harness（本机 web profile 实测 **0.2.2-rc.5**；Desktop 侧另有 0.2.2-rc.3；不同机器/CLI 的 profile 名可能不同）
- **宿主版本下限**：`package.json` 声明 `engines.dsh: ">=0.2.2-rc.5"`（0.3.4 起）。DSH app-boot 用
  `semver.satisfies(version, range, { includePrerelease: true })` 单独判定 `engines.dsh`（忽略 peers），
  不满足时**在 profile 加载阶段跳过本 bundle**（`skippedBundles`，不是运行期报错）；`workspace:` 范围一律不满足。
  下限对齐"插件按哪个宿主优化/验证"：0.3.2 的修复按 rc.5 的契约写成（谓词/消息来源/主题变量），因此 rc.1–rc.4
  的宿主会被跳过，需要先升级宿主（Desktop 侧由使用者自行升级到 rc.5）。更高版本（含未来 pre-release）自动放行，
  不需要跟着 DSH 改范围。
  实测拒绝形态：`dsh: skipping profile bundle "dsh-vibe-trading": … incompatible with dsh <版本>: requirements
  {"engines.dsh":">=…"}`（stderr，bundle 被跳过而非半载入）；被跳过时 profile `cordis.patch.yml` 里的该行覆盖会
  报 `patch: entry "dsh-vibe-trading" not found`——属预期，升级宿主、换兼容插件版本，或对"精确插件版本 + 精确宿主版本"
  用 `plugin_manager set_version_exemption` 临时放行。
- 测试和修改插件需要启动创造模式，否则无法调试

## 2. 当前状态

| 项 | 值 |
|---|---|
| 插件版本 | `package.json` 的 `version`（当前 `0.4.x`；profile 里 link 安装，reload 后加载当前 dist）；`main`/`exports` → `dist/index.js`；bundle patch 只有一条 `- insert:`（不 override 宿主行） |
| 发布形态 | npm **`@monsterlee/dsh-vibe-trading`**（public，`publishConfig.access=public`）+ GitHub 源码；安装 target 用 scoped 包名或本地绝对路径；CI 见 `.github/workflows/ci.yml` |
| 适配运行时 | vibe-trading-ai **0.1.19**（`PINNED_VERSION`，单一事实源 `src/lib/config.ts`） |
| 适配宿主 | DSH **0.2.2-rc.5**（实测/优化基线）；`engines.dsh = ">=0.2.2-rc.5"`（0.3.4 起，`check_manifest.mjs` 校验形态） |
| 工具面 | worker **127 个工具**（118 registry + 9 virtual）、**9 个工具组**、advertised **≤89**（worker 面 88 + 本地 `report_figures`；本机缺凭据时目录 83）、未暴露 **39**（hidden 25 + DSH 替代 9 + 网关替代 1 + dropped 4）；89 份技能。名称跟 VT agent 内部 registry 名（`pattern`/`options_pricing`/`options_payoff`），MCP 门面名只做映射；技能写入、shell、后台任务走 DSH 等价物。**逐工具清单见 [docs/tool-surface.md](docs/tool-surface.md)** |
| 数字门禁 | **默认开启**（D18）；`report_figures` 工具化，正文不出现 figures 块；预算耗尽后默认只出轮末面板（`onFailure: panel`，D25） |
| 本地基线 | `pnpm verify`（178 测试 + manifest）、`check_pin.mjs` 0 FAIL、`check_worker.py` 24/24（外网离线时可能少 1 项）、`check_grounding.py` 23/23 |

改动历史看 `git log --oneline`；**任务/待办用 GitHub Issues**，本文件不维护任务清单。

## 3. 必须遵守的操作规则（踩过坑）

1. **不要在活跃 turn 进行中热重载插件**：`plugin_manager` bundle off/on、升级、重装都会 dispose 活跃会话的
   10 个工具，正在进行的 turn 可能收到 `unknown tool`。**0.2.7 起**，reload/升级/host 重启后，日志里带
   `/vibe-trading on` 的会话会自动恢复（`src/lib/activation-intent.ts` 折叠 `command/run`，无状态文件；
   新会话/无 on 不自动开，seeded fork 会自动恢复）；但中途 reload 仍可能打断当前 turn，所以尽量在 turn 之间更新。
2. **门禁默认开，开关在 profile 配置里**（2026-11-14 起）：插件页 → Vibe Trading → **配置** 或
   `/vibe-trading config set verification.enabled false`（也支持 `figuresGate` / `identityGate` / `maxRevisions` /
   `onFailure` / `ignoreRules.*`）。值写进**当前 profile** 的 `cordis.patch.yml`（`- id: dsh-vibe-trading` 行），
   不再读 `~/.vibe-trading/dsh/config.json`；字段全是 volatile → 保存后立即生效，不重挂插件、不打断会话。
3. **非价格金额不能带货币词**：营收/利润/现金流写 `938.13 亿` 或 `93813317667.45`，**不要写**
   `938.13 亿元/¥/人民币`——带 currency 的 figure 只匹配 price-kind 证据，财报金额会判 no_evidence。
   价格/报价则必须写数据源+币种。
4. **计算值必须 declared derived**（涨跌幅/PE/比率），不能声明 observed。
5. **工具结果末尾有 `[tool_call_id: call-xxxxxxxx]`**（门禁开时）；同一工具多次调用时 ref 用
   `call_id::字段`。
6. **不要用 shell（pwsh/bash）当计算器**：多步计算用 `financial_rigor` / `quantlib_call`。
   也不要读 Vibe-Trading 安装包源码/ledger 去绕过门禁（黑盒规则）。
7. **交易类工具不暴露**（下单/etoro/mandate）；模型必须明确拒绝执行，不编造成交。
8. 提示词/工具目录里的工具计数是**动态生成**的，不要硬编码绝对路径或把工具数写死进代码（测试除外）。
9. **`/vibe-trading off` 只在会话开始对话前有效**（判据 `ctx.agents.turnBoundaryOf(session).lastTurn === 0`，
   经 `optionalAgents(ctx)` 可选读取，未注入时不拒绝）。已开始对话的会话返回错误：历史里的工具调用会变成
   `unknown tool`（实测 5 次），且作废前缀缓存。要验证 `off` 请新建会话（不要先发 prompt）；要"不带 VT 的会话"就新建。
   **被拒绝的 `off` 不算关闭意图**：`command/run` 输入仍会落盘，所以 `activation-intent.ts` / `vibeTrading` 投影
   只认第一个 `turn/start` 之前的 `off`；否则一次 reload 会让"从未关过"的会话静默丢工具（0.3.2 修复）。
10. **注入消息必须自带 `id`/`role`**：`agent.followup` / `agent.steer` 把 payload 原样持久化成 `user/message`，
    DSH **只在下次加载时**校验 `id` 与 `role`（append 不校验）；只传 `{content, source}` 会让会话变成
    corrupt（`session event at seq N lacks an identified message`）。统一用插件里的 `userMessage()` /
    driver 里的 `userMessage()`。已损坏会话：`python scripts/dev/repair-session-messages.py --scan` 检查，
    `--emit-dir .tmp/session-repairs/r1` 生成修复件，再在 pwsh 里回写（子进程受沙箱限制不能写 `$DSH_HOME`）。
    修复/重写日志必须保持 DSH 的 Zstandard **帧布局**：第 0 帧只能是一行 `session` header（`--reframe` 已实现），
    否则 `readFirstZstdLine` 判 `first frame is not exactly one header line`，会话会被 workspace 过滤、在侧边栏消失。
11. **版本对齐是硬前提**：改提示词/工具面/门禁前先 `node scripts/validate/check_pin.mjs`，**0 FAIL**；
    `_vendor/Vibe-Trading` 的 HEAD commit 必须等于 `PINNED_VERSION` 对应 tag（`v0.1.19`）的 commit——
    当前 clone 的 `main` 正好停在该 commit 上也算对齐（比较的是 SHA）；不要拿未打 tag 的 main 最新提交当参照。
    升级 = 改 `PINNED_VERSION` + `pyproject.toml` + `uv.lock` + vendor tag + 重跑 parity/capture/全套校验，
    流程见 skill `vt-version-pin`；任一处不一致，等于测试跑的不是用户装的版本。
    升级 **DSH 宿主**（不是 vibe-trading-ai）时：先跑一遍真实会话 smoke（`/vibe-trading on` + 工具 + 门禁），
    把宿主差异写进 §8，然后把 `engines.dsh` 下限抬到新的优化基线——本插件的策略是"跟着验证过的宿主版本走"
    （当前 `>=0.2.2-rc.5`）；抬高意味着旧 profile 里本 bundle 会被跳过，旧宿主（Desktop 等）需同步升级，
    过渡期可用 `plugin_manager set_version_exemption` 对精确版本对临时放行。
12. **行为配置不要写回 `config.json`**：`verification` / `skills` / `worker` 的默认值在
    `src/lib/settings.ts`（`SETTING_DEFAULTS` + Loader `Config` schema），是 **profile 级**设置。
    新增可配置项时同时改：schema（**必须 `.volatile()`**，否则保存会 remount 插件、dispose 会话工具）、
    `createSettings` 读取、`SETTING_KEYS`、`client.js` 表单；`config.json` 只允许写安装事实。
13. **`worker.patchFile` 是唯一的"用户代码"入口**：profile 设置里填一个 `.py` 绝对路径，`buildWorkerEnv`
    把它塞进 `VIBE_TRADING_DSH_PATCH`，Python worker 在注册表构建完之后 `exec_module` 一次
    （`worker/vibe_trading_worker.py` 的 `_apply_user_patch`）。约定：**补丁失败绝不拖垮 worker**
    ——异常被捕获并写进 `ping.startup.user_patch`（`ok`/`error`）。改完需重启 worker 才生效。
    **回测跑在子进程里**（`backtest.runner`），而源的注册/校验也在那里；runner 只用一份**环境变量白名单**
    （`_copy_runtime_env`）传给子进程，自定义变量会被丢掉，`PYTHONPATH` 则保留。所以补丁要同时进子进程：
    worker 把 `worker/patch_bootstrap/sitecustomize.py` 拷到 `<VIBE_TRADING_HOME>/patch_bootstrap/`、写同目录
    `bootstrap.json`（`{"patch": …, "db": …}`）、再把该目录塞进 `os.environ["PYTHONPATH"]`——子解释器启动时
    `site` 自动 import `sitecustomize`，补丁就在引擎进程里生效了。DuckDB 路径也走这个 json（子进程的
    `VIBE_TRADING_HOME` 也被过滤，`HOME` 还被换成沙箱目录，别用 `Path.home()` 定位）。
    改这条链路时要一起看：`settings.ts`（默认值与 schema）、`worker.ts`（env 与 `patchFile` 字段）、
    `index.ts`（`getWorker` 每次读快照）、`worker/patch_bootstrap/sitecustomize.py`、
    `tests/worker-client.test.mjs` 与 `tests/settings.test.mjs`。
14. **个人内容只放 `_personal/`**（git-ignored）：个人投资研究/回测/与项目无关的笔记不得写进 `docs/`、
    `README.md`、本文件或代码注释；单篇保持简短，不复述具体持仓/金额。个人 skill 放 `.dsh/skills/`
    （DSH 默认项目级 skill 根，rank 100，已 gitignore）。`_personal/` 与 `.dsh/` 不参与构建、测试与发布，
    删除它们不影响项目运行。

## 3.5 本地目录（git-ignored，不属于发布物）

`_vendor/Vibe-Trading`（上游只读参考 clone，HEAD 必须对齐 pin tag）、uv 项目 `.venv/`、运行时 venv 的说明见
[docs/development.md](docs/development.md) §1。

- `_personal/`：个人研究笔记（个人投资/回测、与项目无关的资料），不发布。
- `.dsh/skills/`：个人 skill（DSH 默认项目级 skill 根，rank 100，高于 `.agents/skills` 的 200），不发布；
  项目自带开发 skill 仍在 `.agents/skills/`（会被发布）。
- 规则见 §3 第 14 条：不要把个人内容写进 `docs/`、`README.md`、本文件或代码注释。

## 4. 代码地图

完整源码结构见 [docs/architecture.md](docs/architecture.md)「源码结构」。入口与关键文件：

```
src/index.ts          插件入口：apply、命令、warmWorker、wireAnswerGate、handoffToAgent
src/lib/activate.ts   会话激活：注册 6 常驻 + 4 网关 + 提示词；defineToolFromWorker（call-id footer 在此）
src/lib/worker.ts     Python worker 生命周期、env（run roots/file roots/research store 重定向）、格式化结果
src/lib/settings.ts   profile 行配置：SETTING_DEFAULTS + volatile Config schema
src/lib/verify.ts     数字核实门禁客户端：beforeCall/afterResult/declare/checkAnswer
worker/vibe_trading_worker.py   长驻 Python worker（newline JSON-RPC）
prompt/vibe-trading.md         移植的领域提示词（正文 ≈6.8k tok；激活后 prompt section ≈12.3k tok）
toolsets.json                 staticCore 5 + 9 组 + virtualTools 6 + credentialGated + hidden/dropped + localTools
client.js                    客户端半：状态芯片 + turnTail 门禁面板 + 插件页「配置」表单
tests/                        178 个 node:test（import dist/）
scripts/dev/release.mjs      发版辅助：status / bump / verify / tag / push --yes（不执行 npm publish）
scripts/validate/             check_manifest / check_worker / check_grounding / capture_worker_surface / capture_mcp_surface / check_pin / check_docs_links / check_private / gen_tool_surface_doc
.agents/skills/release-npm/   发版 skill：只改 package.json、单独推 tag、OIDC 发布与自动 Release
docs/                         见 [docs/README.md](docs/README.md)；工具面逐条见 [docs/tool-surface.md](docs/tool-surface.md)
```

## 5. 本地校验命令（改完必须跑）

```bash
pnpm typecheck
pnpm build
node tests/run-all.mjs                    # 178/178
node scripts/validate/check_manifest.mjs  # all pass
node scripts/validate/check_pin.mjs       # PINNED_VERSION 与 _vendor tag/pyproject/uv.lock/venv 一致
pnpm check:docs                           # 文档相对链接可达
pnpm check:private                        # 个人内容/本机绝对路径扫描（denylist）
pnpm check:grounding                      # 23/23
pnpm check:worker                         # 24/24（需外网；本机 Yahoo 不可达 → 23/24，唯一 FAIL 是 stderr 告警检查）
pnpm capture:surface                      # 更新 scripts/validate/worker-surface.json
pnpm capture:mcp                          # 从 scripts/env/mcp-tools.json 生成 tracked 的 MCP 快照
pnpm docs:tools                           # 重新生成 docs/tool-surface.md（工具面对照表）
pnpm check:tools                          # 对照表未过期（改了 toolsets.json 没重生成会 FAIL）
pnpm verify:ci                            # CI 跑的子集（Node 部分，不需要 uv/外网）
node scripts/dev/command-smoke.mjs        # 命令冒烟（不写 profile）
```

> 新 clone 可直接跑 `pnpm verify` / `pnpm check:tools`：`check_manifest.mjs` 与 `gen_tool_surface_doc.mjs`
> 只依赖 tracked 的 `scripts/validate/worker-surface.json` 与 `mcp-surface.json`，不读 git-ignored 的
> `scripts/env/*.json`。`check_pin.mjs` 对缺失的 `_vendor`/运行时 venv/采集物只报 WARN。
>
> 个人/机器特定的扫描规则放 git-ignored 的 `scripts/validate/private-denylist.local.json`
> （`[label, regex]` 数组，由 `check_private.mjs` 加载并跳过自身）；不要把个人股票/项目名/内网 IP 写进公开的校验脚本。
>
> `pnpm check:*` 通过 `scripts/validate/py.mjs` 选 Python：`VIBE_TRADING_PYTHON` → `.venv` →
> 已安装运行时 venv → PATH。需要指定解释器时：`VIBE_TRADING_PYTHON=/path/to/python pnpm check:grounding`。

## 6. 真实会话测试

完整流程见 [docs/development.md](docs/development.md) §4：测试驱动插件（`driver/`）、`vt_test_session` 的
`start`/`send`/`command`/`resume`/`fork`/`dispose`、会话审计脚本、通过标准。要点：

- 测试驱动插件测完**必须禁用**；斜杠命令用 `action=command`（`send` 只发普通文本、不执行命令）；
- 判断会话结束用 `scripts/dev/session-state.py`，**不要**用子串搜 `turn/end`；
- 通过标准：0 工具错误、正文无 figures 块、交易类拒绝、不可知问题不编造、无 pwsh 兜底（文件阅读类除外）。

## 7. 调试技巧

- 插件日志：`<VIBE_TRADING_HOME>/dsh/logs/plugin.log`（默认 `~/.vibe-trading`；apply / 命令调用 / 错误栈）
- worker 探针：`scripts/dev/probe-*.py`（hidden tools / research state 等）
- 证据账本：`<VIBE_TRADING_HOME>/dsh/work/runs/<session>-*/artifacts/grounding_evidence.json`
  （看 tool/call_id/symbol/field/value/status）
- run 目录：`<VIBE_TRADING_HOME>/dsh/work/runs/`（回测产物 run_card.md / artifacts/metrics.csv / trades.csv）
- research 存储：`<VIBE_TRADING_HOME>/dsh/work/research/`（hypotheses.json、research_artifacts.sqlite3 等）
- 会话日志 zstd：用 `scripts/dev/*.py` 里的逐帧解压方式（`ZstdDecompressor().decompressobj()` + `unused_data` 循环）
- 命令行为诊断：`node scripts/dev/command-smoke.mjs`
- 会话损坏（缺 id/role）：`python scripts/dev/repair-session-messages.py --scan`；修复走 `--emit-dir` + pwsh 回写，备份在 `.tmp/session-repair-backups/`

## 8. 已知限制（非任务）

- 数值密集回答要 2–4 轮 `report_figures` 修正（修复前 12–20 轮）；正文不会出现 figures 块；
- 门禁面板明细走 `plugin:dsh-vibe-trading/gate` ignorable 插件记录（DSH 实验 API；桥不可用时回退到完整披露文本）；
  记录只在本机会话日志里，模型不可见，正文与前缀缓存不受影响；
- 自动恢复只认 session 日志里的 `command/run on`（last-wins）；0.1.x 时代没有 `recordInput` 的旧会话无法推断；
  `startup` 的纯新会话不自动开（日志里没有 `on` 意图，`maybeAutoActivate` 自然 no-op）；**seeded fork 会自动恢复**——DSH 的 `SessionStartSource` 没有 `'fork'`，fork 报 `startup` + `header.isSeeded`，判据是 `shouldRestoreOnCreation()`；`resume`（host 重启/持久化加载）同样恢复；
- 未验证版本（`/vibe-trading init --latest` 或手动升级）仍可运行，但 `status`/`on` 会提示未验证，激活时还会用 worker 实时 `tools/list` 对比 `toolsets.json` 快照，缺失工具会显示“工具面漂移”；回退：`/vibe-trading init --pinned`；
- **发布形态 / npm 同名包**：本仓库发布为 `@monsterlee/dsh-vibe-trading`（scope `monsterlee`，public），profile 行 id
  仍是 `dsh-vibe-trading`。npm 上不带 scope 的 `dsh-vibe-trading` 是另一个实现，不要装错，也不要在 fork 里
  `npm publish`。`pnpm install` 的 `prepare` 构建 `dist/`；`dist/` 仍不进 git。
- **profile 设置**：值是 volatile Loader 引用，保存后原地提交（不重挂、不打断会话）；但 `skills.mode`
   只影响**下一次激活**（提示词在激活时组装），门禁/worker 参数对已激活会话立即生效；
  - 插件页的「配置」表单由 client 半注册（`plugins.bundle.config`，key `dsh-vibe-trading`），
    宿主若没有 `configForms`/settings 服务则不注册；此时 `/vibe-trading config set` 会提示改用 profile 文件；
  - 冷启动 ~17s（init 后台预热后热启动 ~4s）；
- 热重载/升级会 dispose 活跃会话的工具，但 0.2.7 起带 `/vibe-trading on` 历史的会话自动恢复；进行中的 turn 仍可能被打断；
- `driver/` 仅测试用，在修改插件之后需要开始测试就需要加载，中途可以不考虑禁止
- **DSH 0.2.2-rc.5 适配要点**（2026-11-19 升级核对，0.3.2 修复）：
  - `ToolDefinition.isConcurrencySafe` 在 rc.5 是**谓词** `(args) => boolean`，宿主会调用它；传布尔值会在
    `dsh-tools/pipeline.js` 里抛错并被吞掉 → 所有工具静默退化为串行。已改为 `() => Boolean(tool.readonly)`。
  - rc.5 的 `user/message` 里混入宿主注入的 `runtime-context` / `time-context` 等（`<system-reminder>` 包裹）；
    identity 门禁只接收 `source.kind === 'user'`（无 source 的旧记录仍按旧逻辑接收）。
  - `Session.snapshotEvents()` 在 rc.5 标为 deprecated（仍可用）；自动恢复的 intent 折叠仍在用它，
    迁移到投影句柄是后续任务。
  - `agent/turn-stopping` 在 rc.5 是 **serial** 事件（`(payload, signal)`，无 `next`）；现有 `finish(next)` 兼容两种形态，不必删。
  - profile patch 写入（插件页保存 / `config set`）**不保证永远走 volatile 原地提交**：实测一次在激活进行中写入触发了
    插件 remount（活跃会话工具被 dispose，约 16s 后按 intent 自动恢复）。写配置尽量在没有活跃 turn 时做；
    恢复失败时看 `plugin.log` 的 `auto-restore` 行。
- **第三方命令在 `/` 菜单里没有图标、标题/描述不随语言切换**（DSH ≤ 0.2.2-rc.5 限制，不是插件 bug）：
  客户端 `builtinRowFace()` 只对六个首方 `definitionId`（goal/plan/feedback/compact/permission/export）返回
  本地化 title/description/icon，其余 host 行只保留 `description` 原文；`CommandContribution` 虽可带
  `icon`/`label()`/`description()`，但与 host 命令**同名会直接抛错**（`collides with a host command`），
  且只在裸 token 时执行、不支持参数（rc.5 另给宿主命令加了 `CommandDecoration`，仍不画图标/标题）。
  所以 `/vibe-trading` 只能是 name + 单语言 description + input hint。
  见 `@deepseek-ai/dsh-client-ui-commands/lib/client.js` 的 `builtinRowFace`/`candidates`、
  `dsh-commands/lib/types/builtin.d.ts`；

**任务/待办用 GitHub Issues 跟踪；本文件只保留规则、环境与已知限制，不维护任务清单。**

## 9. 其他会话继续工作的推荐顺序

1. 读本文件（规则/环境/调试）+ [docs/README.md](docs/README.md)（文档索引）+ [docs/development.md](docs/development.md)（开发/测试/发版）；
2. `git status` / `git log --oneline -5` 确认工作区干净、看最近改动；
3. 跑一遍第 5 节本地校验 + `node scripts/validate/check_pin.mjs`，确认基线与版本 pin 都 OK；
4. 若要做真实会话验证：按 [docs/development.md](docs/development.md) §4；
5. 改提示词/工具面后：`pnpm build` → reload 插件（无活跃会话时）→ 新会话 `/vibe-trading on` 验证；
6. 收尾：更新 [docs/development.md](docs/development.md)（测试/验收）、用户可见行为同步 `README.md` / `README.zh-CN.md`，必要时 [docs/decisions.md](docs/decisions.md) / [docs/architecture.md](docs/architecture.md)，提交。版本号只改 `package.json`；发布说明由 GitHub Release 自动生成，不维护 CHANGELOG。
