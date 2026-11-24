# dsh-vibe-trading 架构（v1.1）

> 设计事实来源。设计决策见 [`decisions.md`](decisions.md)；开发/测试/发版见 [`development.md`](development.md)；
> 数字核实机制见 [`number-verification.md`](number-verification.md)；数据源见 [`data-sources.md`](data-sources.md)。
>
> 一句话：**DSH 当 agent；Vibe-Trading 的工具/技能/领域规则通过一个常驻 Python worker 提供给 DSH；
> 命令按会话激活；工具与技能目录静态、正文/签名按需；全程不破坏前缀缓存。**

## 1. 目标与边界

- 用 DSH 替换 Vibe-Trading 的 agent（LangGraph loop + providers + CLI/API/frontend 全部不启用）。
- 复用 Vibe-Trading 的**工具、技能与系统提示词的领域纪律**：0.1.18 基线为 82 个 MCP 对外 / 113 个注册表 / 90 份 SKILL.md；本机实装 0.1.19 实测为 **127 个发布工具（118 注册表 + 9 virtual）/ 89 份技能**。
- 插件是普通宿主插件，装进 profile，**不创建 agent preset**；用命令在**当前会话**激活/取消激活。
- 不启动 Vibe-Trading 的 MCP server，也不启动它的 API server；直接调用它的 Python 工具注册表。
- 版本基线：`PINNED_VERSION = 0.1.19`（`src/lib/config.ts` 单一事实源）。默认安装精确固定到该版本，
  只有显式 `--latest` / `mode=latest` 才跟随最新（结果标记“未验证”）；`_vendor`/pyproject/uv.lock/运行时 venv
  必须与之对齐（`scripts/validate/check_pin.mjs`），升级流程见 skill `vt-version-pin`。

## 2. 总体架构

```
DSH（profile 由使用者决定，本机为 web/desktop）
│
├─ 宿主插件 dsh-vibe-trading（Host 进程，无沙箱；TypeScript 源码 src/ → 构建 dist/）
│   ├─ /vibe-trading 命令（init | on | off | status）
│   ├─ 初始化：预检 → 建 venv/装包 → 写 config.json（失败交给 agent）
│   ├─ Host 工具 vibe_trading_setup（agent 可调用：check/create-venv/install/verify/write-config/repair）
│   ├─ worker 管理：懒启动、保活、崩溃重启、日志
│   └─ 激活时向当前 agent 作用域注册：工具 + 提示词段落（off 时撤销）
│
└─ Python worker（每个 DSH 进程一个，常驻；运行在我们的 venv）
    ├─ build_registry() / SkillsLoader（vibe-trading-ai 内部实现）
    ├─ newline JSON-RPC：ping / capabilities / tools/list / tools/call / skills/list / skills/load / shutdown
    └─ cwd = ~/.vibe-trading/dsh/work；会话 id 随调用透传
```

数据流（一次工具调用）：
`模型 → DSH 工具（例如 vt_call / core 工具）→ 插件 Host → worker tools/call → registry.execute(...) → JSON 字符串 → 原样回给模型`

## 3. 目录结构

**插件仓库（当前目录）**

```
dsh-vibe-trading/
├─ package.json               # 插件包 manifest（dsh.bundle.patch、exports、files）
├─ cordis.patch.yml           # 只插入插件行（不改任何宿主行）
├─ src/index.ts               # 插件入口（TypeScript）：commands / init / worker 管理 / 工具与提示词注册
├─ src/lib/*.ts               # config/preflight/install/setup-tool/worker/gateway/activate/prompt/verify
├─ src/types.ts               # DSH 边界类型
├─ dist/                      # tsc 产物（package.json main/exports 指向这里）
├─ worker/
│   └─ vibe_trading_worker.py # Python worker（JSON-RPC，直调 registry）
├─ toolsets.json              # 工具分组（core + research/backtest/quant/verify/team/trading-reads/goals/runio）
├─ prompt/
│   ├─ vibe-trading.md        # 移植后的领域提示词（静态段落来源）
│   └─ bridge.md              # DSH 原生工具映射说明
├─ locale/{en,zh}.json        # 插件名/描述（Plugin Manager 展示）
├─ icon.svg
├─ docs/                      # 设计文档（本文件等）
└─ scripts/                   # 本地验证脚本（不进运行路径）
```

**运行期数据（`~/.vibe-trading/`）**

```
~/.vibe-trading/
├─ .env、data-bridge/、券商 *.json        # 原版 VT 共享的密钥/数据桥/连接配置（两边共用）
├─ runs/、sessions.db、memory/、pyenv/    # 原版 VT 自己的运行产物（插件不写）
└─ dsh/                                   # 插件专属数据根
   ├─ config.json            # 初始化产物（安装事实；行为偏好在 profile patch）
   ├─ init-report.json       # 预检/安装诊断（agent 交接用）
   ├─ logs/                  # init / worker 日志
   ├─ venv/                  # Python 虚拟环境
   └─ work/                  # worker cwd + **VT 运行时根**（VIBE_TRADING_HOME）
      ├─ runs/<id>/          # config.json + code/signal_engine.py + artifacts
      ├─ research/           # hypotheses / goals / research_artifacts / strategy store / playbooks
      ├─ cache/              # 行情缓存（VIBE_TRADING_DATA_CACHE_ROOT）
      ├─ results/            # 工具结果 spill
      ├─ panel/              # 因子面板输入输出
      └─ reports/、strategies/、paper-trading/、shadow_*/   # VT 按 runtime root 自动创建
```

`VIBE_TRADING_HOME` 只对 **worker 子进程**生效（`buildWorkerEnv`），不是宿主环境变量：
VT 所有 `get_runtime_root()/xxx` 路径因此落在 `dsh/work` 下，和原版 VT 的 `~/.vibe-trading/xxx`
完全分开。VT 的 `.env`、`data-bridge/`、各券商 json 由 `Path.home()` 解析，**故意继续共用**
（密钥和数据桥没有第二份）。


## 4. 命令与生命周期

```
/vibe-trading init      # 初始化（幂等）：预检 → 建 venv/装包 → 校验 → 写 config.json；失败交给 agent
/vibe-trading on        # 激活当前会话：启动/复用 worker，注册 core 工具 + 网关 + 静态提示词
/vibe-trading off       # 取消激活：撤销本会话注册（worker 按保活策略保留）
/vibe-trading status    # 环境/worker/已加载状态/版本
```

- 命令结果只显示在 UI，不进模型历史；长任务不在 handler 里做（安装放后台 + `init-report.json`）。
- 激活是**每会话**的（`agent.ctx` 作用域），互不影响；未激活的会话看不到任何 VT 内容。
- 激活时若会话已在对话中：工具定义块变化一次（一次缓存 miss），之后恒定。建议会话开始就激活。

## 5. 初始化

### 5.1 预检（只读、秒级）

| 项 | 判定 |
|---|---|
| 平台/架构 | 支持 win32/darwin/linux |
| 磁盘 | `~/.vibe-trading` 所在盘 ≥1GB |
| Python | `python`/`python3`/`py -0p`/常见目录/conda；≥3.11（推荐 3.12），`import venv` 可用 |
| uv | `uv --version` 可执行（能力安装阶段验证） |
| DSH 自带 Python | 扫 `~/.dsh/dsh-runtimes/*/dependencies/python/python.exe`（**最后备选**） |
| 目录可写 | 可创建 `~/.vibe-trading/dsh/` |
| 已有 config | 有效则直接就绪（并校验版本） |
| `.env` | 只记录 key 名，不读值 |

### 5.2 安装（按优先级，失败自动降级）

1. 系统 Python：`<python> -m venv ~/.vibe-trading/dsh/venv` → `pip install`
2. uv：`uv python find` / 复用 dsh-bundled Python → `<python> -m venv`；安装用 `uv pip install`（失败降级 pip）
3. DSH 自带 Python：`<dsh python> -m venv` → `pip install`
4. 都失败 → 写 `init-report.json`，命令返回诊断，并 `agent.followup` 交给当前会话的 agent；
   agent 用 Host 工具 `vibe_trading_setup` 逐项修复后重跑 init。

包版本：插件内置 **`PINNED_VERSION = 0.1.19`**（`src/lib/config.ts`，单一事实源）与 `DEFAULT_VERIFIED_VERSIONS`。
- 安装 spec：默认 `vibe-trading-ai==0.1.19`；显式 `mode=latest`（`/vibe-trading init --latest` 或
  `vibe_trading_setup(action=install, mode=latest)`）才用 `>=minimumVersion`。
- `DEFAULT_MINIMUM_VERSION` 与 pin 对齐：`on` 每次校验 floor；低于 floor → 拒绝激活并提示 init。
- 安装/激活返回 `{verified, pinnedVersion, verifiedVersions}`；`config.package` 记录 `mode/pinnedVersion/verified`，
  `status` 显示「策略 + 已验证/未验证」，未验证只告警不阻断。
- 工具面自检：激活时把 worker 实时 `tools/list` 与 `toolsets.json` 快照比对（`src/lib/surface.ts`），
  缺失目录工具 → `on`/`status` 报"工具面漂移"。
- 本地一致性：`scripts/validate/check_pin.mjs`（无子进程）校验 `PINNED_VERSION` ↔ `pyproject.toml`/`uv.lock` ↔
  `_vendor/Vibe-Trading` tag ↔ 运行时 venv；升级流程见 skill `vt-version-pin`。

### 5.3 config.json（安装事实）与 profile 行配置（行为偏好）

`~/.vibe-trading/dsh/config.json` 只存**安装事实**（解释器、venv、工作目录、包版本策略）；
行为偏好（`verification` / `worker` / `skills`）属于 **DSH profile**，存在该 profile 的
`cordis.patch.yml` 里本插件行（`dsh-vibe-trading`）的 `config:` 下，默认值编译在
`src/lib/settings.ts` 的 `SETTING_DEFAULTS`（同时是 Loader `Config` schema 的 default）。

```jsonc
// ~/.vibe-trading/dsh/config.json —— 安装事实
{
  "schemaVersion": 1, "pluginVersion": "0.1.0",
  "createdAt": "...", "updatedAt": "...",
  "package": {
    "name": "vibe-trading-ai",
    "mode": "pinned",                 // pinned = 精确 pin；latest = 跟随最新（标未验证）
    "pinnedVersion": "0.1.19",        // 插件验证过的版本（PINNED_VERSION）
    "verifiedVersions": ["0.1.19"],
    "minimumVersion": "0.1.19",
    "installedVersion": "0.1.19",
    "verified": true,
    "spec": "vibe-trading-ai==0.1.19"
  },
  "python": { "kind": "system|uv|dsh-bundled", "exe": "...", "version": "3.12.14" },
  "uv": { "exe": "...", "version": "0.12.20" },
  "venv": { "dir": "...", "python": "...", "worker": ".../worker/vibe_trading_worker.py" },
  "vibeHome": "<解析后的 ~/.vibe-trading>",
  "workDir": "<dsh/work>",
  "env": { "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "VIBE_TRADING_HOME": "<vibeHome>" },
  "detectedKeys": ["DEEPSEEK_API_KEY", "..."],
  "checks": { "workerHandshake": { "ok": true, "toolCount": 82, "at": "..." } }
}
```

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml —— 该 profile 的行为偏好（插件页「配置」或
# /vibe-trading config set 写入；全部字段 volatile，保存后由 Loader 原地提交，不重挂插件）
- id: dsh-vibe-trading
  name: '@monsterlee/dsh-vibe-trading'
  config:
    verification:
      enabled: true
      identityGate: true
      figuresGate: true
      maxRevisions: 2
      onFailure: disclose
      ignoreRules: { urls: true, paths: true, code: true, versions: true, dates: true, sections: true, ids: true, extra: [] }
    skills: { mode: short, loadLimitChars: 10000 }
    worker: { idleMinutes: 30, defaultTimeoutMs: 120000, longTimeoutMs: 1860000 }
```

旧 `config.json` 里的 `worker/toolsets/skills/verification/mcp` 段已不再被读取（`toolsets`/`mcp`/
`concurrency`/`reportSuppressed` 从未有消费方，已删除）；`effectiveConfig` 不再补这些默认段。

`config.package.verified` 只是上一次安装的记录，验证结论始终以插件内置 `DEFAULT_VERIFIED_VERSIONS`
与实时版本探测为准；`init` 快路径不改写安装事实，`status`/`on` 用实时探测计算展示。

## 6. Worker

- **进程模型**：每个 DSH 进程一个，首次 `on` 懒启动；空闲 30 分钟退出（可配）。
- **启动**：`<venv python> <worker.py> --cwd <work>`，env 见上；目标启动 4s 左右（避开 langchain import）。
- **协议**：newline JSON-RPC，stdout 只有 JSON 行，日志走 stderr（重定向到 `logs/worker.log`）。

| method | 参数 | 返回 |
|---|---|---|
| `ping` | — | `{ok, version, toolCount}` |
| `capabilities` | — | `{ok, key_gated: {<tool>: {available, error?}}}`：凭据门禁的可用性，激活时据此决定哪些工具进目录 |
| `tools/list` | — | `[{name, description, inputSchema, readonly, repeatable}]` |
| `tools/call` | `{name, arguments, session_id?}` | `{ok, result}`（result 为 VT 的 JSON 字符串） |
| `skills/list` | — | `[{name, description, category}]` |
| `skills/load` | `{name, section?, offset?}` | `{ok, result}`（骨架/分节/翻页同 VT） |
| `shutdown` | — | 退出 |

- **并发**：线程池（默认 4）；`backtest` 等长任务不阻塞其它会话。
- **超时**：插件侧按工具配置；`backtest` 用 `longTimeoutMs`（1860s）。
- **取消**：DSH `exec.signal` 中止 → 插件停止等待并回错误；**不向 worker 发 cancel**（VT 工具本身不可硬取消，worker 里的调用继续跑完）。
- **崩溃**：当前请求回明确错误；插件自动重启一次并重试；连续失败 → `status` 显示、提示 `/vibe-trading init`。
- **截断**：worker 先截断正文并写入 `work/results/<uuid>.json`，返回 `[TRUNCATED … FULL RESULT SAVED: <path>]` 与 `full_path`；插件原样透传、不再二次截断。模型用 `vt_call("read_file", {path})` 读全文。

## 7. 工具

### 7.1 静态注册（激活时，之后不变）

| 工具 | 说明 |
|---|---|
| `search_symbol` | 标的解析（完整 schema） |
| `get_market_data` | 行情（完整 schema） |
| `read_document` | PDF/Office/OCR（DSH 无替代） |
| `backtest` | 回测入口（schema 仅 run_dir） |
| `financial_rigor` | 数字核实/精确计算（AST `calc`、多源交叉校验、市值/估值复核）；**registry-only，MCP 面没有** |
| `vt_load_tools` | `{toolset?, names?, detail?}` → 返回签名/schema 文本 |
| `vt_call` | `{name, arguments}` → 网关调用 |
| `vt_list_skills` | `{category?, query?}` → 完整技能描述 |
| `vt_load_skill` | `{name, section?, offset?}` → 技能正文 |

工具名保留 VT 原名（无前缀）；注册时做重名检查。

### 7.2 提示词里的工具目录

- VT 式全量目录：每个**广告工具**一行 `- name: 80 字提示`（≈2k tok，静态、缓存友好）。
  广告集合 = `staticCore` + 所有 group 成员（当前 5 + 65 = **70 行**，含 9 个 virtual 工具 + runio 2 个）。
- 分组（`toolsets.json` v4）：research 26 / backtest 9 / quant 11 / verify 1（`report_audit`）/
  team 5 / trading-reads 8 / goals 5 / runio 3 / research-workflow 15（core 不进组）。
- **virtualTools（9 个）**：`analyze_options`、`analyze_options_payoff`、`pattern_recognition`、
  `get_macro_series`、`get_cn_macro_series`、`get_fund_nav`、`get_cn_announcements`、
  `search_broker_reports`、`iwencai_search` —— 它们不在 Python 注册表里，实现位于
  `mcp_server.py` 的包装函数；由 worker 复刻（调用同样的底层模块），对插件表现为普通工具。
- **dropped（7 个 swarm 工具）**：`run_swarm`、`list_swarm_presets`、`get_swarm_status`、
  `get_run_result`、`list_runs`、`retry_run`、`reap_stale_runs` —— 由 DSH subagent 取代 swarm。
- 注册表里其余工具（0.1.19 为 118 registry / worker 面 88 advertised + 本地 `report_figures` = 89 上限 /
  未暴露 39 = hidden 25 + DSH 替代 9 + 网关替代 1 + dropped 4；其中 9 个为 virtual）
  （`edit_file`、`remember`、`session_search`、`save_skill`、`portfolio_risk_xray`、`etoro_*`、`trading_place_order` 等）不广告、不可经 `vt_call` 调用；
  需要时在 `toolsets.json` 里加进某个 group 即可。逐工具的现状与理由见 [`tool-surface.md`](tool-surface.md)（由 `pnpm docs:tools` 生成）。
- **凭据门禁**：`get_macro_series`（FRED）、`iwencai_search`（问财）、`get_fund_nav` / `get_cn_macro_series` /
  `get_cn_announcements` / `search_broker_reports`（Gildata）只在 worker 的 `capabilities` 报告 `available=true` 时进入目录；
  缺凭据时整条工具（目录行、组计数、`vt_load_tools`）一起消失，而不是留一个只会回 “not configured” 的入口。
- 使用规则：不确定参数时先 `vt_load_tools`；`vt_call` 参数错误会把 worker 的 `error.data`（含可用工具/签名提示）回给模型，不自动附完整 schema。

### 7.3 `vt_load_tools`

- `detail: "compact"`（默认）：每工具一段 TS 风格签名（含 required/enum/default）+ 一句话描述；
- 参数 >8 个或 schema >1.5k 字符 → 自动返回完整 JSON Schema；
- 返回文本只追加历史，不改工具定义。

### 7.4 `vt_call`

- 校验工具存在且已加载（core 或 load 过）；未加载 → 提示先加载；
- 宽松参数转换（JSON 字符串 → list/dict）；
- 结果原样返回（VT JSON 信封）；截断规则见 §6。

### 7.5 数字核实门禁（配置开关，默认开启）

VT 最鲜明的 agent 特色：每个数字必须可追溯到本 session 的工具证据，
`derived` 数字要给出可求值公式且公式结果必须与写的数字一致（详见 `number-verification.md`）。
我们**移植而不是重写**，因为它全是纯 Python 且与 Vibe-Trading 同 venv：

| 环节 | 接入点 | worker 方法 | 行为 |
|---|---|---|---|
| 证据入库 | 工具 execute 内（**在 10k 截断之前**） | `grounding/ingest` | 未截断结果进本轮证据账本 |
| identity 门禁 | 工具包装层 `beforeCall` | `grounding/authorize` | 未锁定标的的 symbol 调用返回结构化拒绝 |
| 回答校验 | `agent/turn-stopping` | `grounding/validate` | 附加 `report_figures` 存储的声明、逐 role 校验、derived 公式求值、比对最终回答与已校验草稿 |
| 纠正 | `agent.steer` | — | 下一轮 steer 逐条失败清单，最多 `maxRevisions`（默认 2）次；"纠正期间工具只用已有证据"尚未实现 |
| 兜底 | `grounding/validate` + 轮末面板 | — | DSH 无法改写已提交的回答，兜底 = 把明细写成 ignorable 记录、由 `turnTail` 面板挂在回答下方并关轮（`onFailure: panel` 默认，不再多跑一轮）；`disclose` 额外 steer 一句"部分数字未核实"，`silent` 两者都不做 |
| 展示 | `conversation.chat.turnTail` + 会话投影 | — | 每轮末尾三组折叠面板（未核实/已通过/自动豁免）；明细写入 ignorable 的 `plugin:dsh-vibe-trading/gate` 记录（模型不可见），桥不可用或旧日志回退解析披露文本；正文不改、前缀缓存不动 |

配置（`config.json`）：

```jsonc
"verification": {
  "enabled": true,         // 总开关（D18 默认开）；关闭时只记录不校验
  "identityGate": true,    // enabled 时生效
  "figuresGate": true,
    "ignoreRules": { "urls": true, "paths": true, "code": true, "versions": true, "dates": true, "sections": true, "ids": true, "extra": [] },
  "maxRevisions": 2,
  "onFailure": "panel"       // panel（默认，只出面板）| disclose（再 steer 一句）| silent（都不做）
}
```

关闭时：`report_figures` 只登记声明，不做机械校验；打开时工具会先校验草稿，`turn-stopping` 再复核最终回答。

## 8. 技能
- **目录**：激活时由 `skills/list` 生成静态提示词段落（按类别分组；`skills.mode: "short"` 默认每条首句 ≤100 字符，≈1.8k tok；`full` 5k；`none` 不注入）。
- **查询**：`vt_list_skills({category?, query?})` 返回完整 name+description（≈300–800 tok，按需）。
- **正文**：`vt_load_skill({name, section?, offset?})`，复用 VT 骨架/分节/翻页；单次上限 10k 字符。
- **用户技能**：`~/.vibe-trading/skills/user` 自动包含。
- **不挂 DSH 原生 skill provider**（避免全局目录污染与正文无分页问题）。

## 9. 提示词

- 来源：`src/agent/context.py:23-278` 的 `_SYSTEM_PROMPT` + `agent/SKILL.md`。
- 静态段落（激活时注册）：
  1. identity + 6 条 Output Principles（逐字节保留）；
  2. Task Routing（回测/研究/期权/文档/交易日志/影子账户/swarm 门槛）；
  3. Guidelines（先 identity 后行情、figures 协议、符号 grounding、run_dir 约定）；
  4. 工具目录（≤89 行，缺凭据时更少）+ 使用规则；
  5. 技能目录（按 `skills.mode`）；
  6. **桥接说明**：`read_file/write_file/read_url/web_search/analyze_image` → DSH `read/write/web_fetch/web_search/read_image`；MCP 门面名（`pattern_recognition` → `pattern`、`analyze_options` → `options_pricing`、`analyze_options_payoff` → `options_payoff`）如何对应到 registry 名。
- 易变内容（时间、run 目录、计数）不写入静态段落（避免破坏缓存）。

## 10. 文件与沙箱

- 回测 run 目录固定 `~/.vibe-trading/dsh/work/runs/<id>`。
- **插件不修改宿主 `sandbox-policy`**。原因见 [`postmortems/install-hang.md`](postmortems/install-hang.md)：
  覆盖宿主核心行会整体替换其 config 并在激活期重载基础服务，曾导致安装永久挂起。
- 因此运行目录 I/O 分两路：
  - 工作区内的普通文件：DSH 原生 `read` / `write`；
  - run 目录内的文件（`config.json`、`code/signal_engine.py`、自定义数据）：
    通过 `vt_call` 调 Vibe-Trading 的 `read_file` / `write_file`（`runio` 工具组，按需加载）。
    它们跑在 Python worker 进程里，不受 DSH 文件沙箱限制。
- VT 侧 `VIBE_TRADING_ALLOWED_RUN_ROOTS` 指向 `work`（默认已含 `$CWD/runs`）。
- `VIBE_TRADING_HOME` 由 `buildWorkerEnv` 固定为 `<vibeHome>/dsh/work`（`runtimeHomeDir`），
  **不是** `resolveVibeHome()`：后者决定插件自己的 config.json / logs / venv，以及 `.env` 的读取位置。
  两者混用会让插件目录套娃、密钥读不到。`#checkRuntimeRoots` 在 spawn 时校验
  `<runtimeHome>/runs` 仍在允许根内，防止以后改布局时漏改。
- 该设计让插件补丁退化成**纯插入**，`check_manifest.mjs` 会拒绝任何宿主行覆盖。

## 11. 缓存与 token 预算

| 内容 | 大小 | 变化时机 |
|---|---|---|
| 工具定义块（5 core + 4 网关工具） | ~1.8k tok | 仅激活/取消时 |
| 提示词（原则+路由+guidelines+目录+技能目录+bridge） | ~10.9k tok（short 模式，43,701 字符） | 激活后恒定 |
| `vt_load_tools` / `vt_load_skill` / `vt_call` 结果 | 按需 | 追加，不破坏前缀缓存 |

对比 VT 自己：14.6k/请求（deferred）/48.4k（eager）；我们稳态 ≈12.5k 且缓存全程命中。
超出 12k 红线约 0.5k，可通过 `skills.mode`（`none` 省 2.2k）或后续精简 Task Routing 压缩。

### 11.1 性能基线（2026-11 实测，Windows 11 / Python 3.12.14 / vibe-trading-ai 0.1.19）

| 项 | 值 |
|---|---|
| worker 启动（spawn→ready） | 3.7–4.0s（init 后首次冷启动约 17s；lean registry 4.5s，plain 6.6s） |
| worker 内存 | lean ≈198 MB / plain ≈241 MB |
| `tools/list` | ≈0.11s |
| 工具 schema 总量 | 127 工具 ≈111k 字符（≈28k tok）；注册表 118 个 ≈157k 字符（≈39k tok） |
| 技能 | 89 份；目录 107 行 ≈20k 字符（≈5k tok）；正文总量 ≈928k 字符 |
| 提示词 | `prompt/vibe-trading.md` ≈27k 字符（≈6.8k tok）；激活后 prompt section ≈49.3k 字符（≈12.3k tok） |
| 激活后稳态 | ≈12.5k tok/请求（工具定义 ≈1.8k + 提示词 ≈10.9k） |

## 源码结构（TypeScript）

```
src/
├─ index.ts              # 插件入口：apply(ctx)、/vibe-trading 命令、答案门禁接线
├─ types.ts              # DSH 边界类型（ToolDefinition / PluginContext / CommandInvocation …）
├─ lib/
│  ├─ config.ts          # 路径解析、config.json 读写与校验（安装事实）
│  ├─ settings.ts        # profile 行配置：volatile Config schema + 读写 + settingPatch
│  ├─ exec.ts            # 不会抛异常的子进程封装
│  ├─ preflight.ts       # 只读预检（平台/磁盘/可写性/python/uv/venv/dotenv）
│  ├─ install.ts         # venv 创建、包安装、verify、报告
│  ├─ setup-tool.ts      # Host 工具 vibe_trading_setup
│  ├─ worker.ts          # Python worker 进程 + JSON-RPC 客户端 + full_path 透传
│  ├─ gateway.ts         # vt_load_tools / vt_call / vt_list_skills / vt_load_skill
│  ├─ activate.ts        # 每会话注册/撤销（agent.ctx 作用域）
│  ├─ prompt.ts          # 提示词组装（纯函数）
│  ├─ figures-tool.ts    # report_figures：声明 + draft 提前校验（DSH 适配）
│  └─ verify.ts          # 数字核实门禁（identity / figures / 修正 / 兜底）
└─ types 内联在各模块

dist/                    # tsc 输出（package.json main/exports 指向这里）
tests/*.test.mjs         # node:test，import dist/
```

类型检查用最新稳定版 **TypeScript 7.0.2**，`tsconfig.json` 开 `strict` + `noImplicitAny`（0 error）。构建与校验：`pnpm typecheck` → `pnpm build` → `node tests/run-all.mjs` → `node scripts/validate/check_manifest.mjs`
→ `python scripts/validate/check_worker.py` / `check_grounding.py`。

## 12. 失败模式与降级

| 场景 | 行为 |
|---|---|
| 未初始化就 `on` | 明确报错 + 提示 `/vibe-trading init` |
| 预检失败 | 写报告 → `agent.followup` 交当前会话 agent（经 Host 工具修复） |
| worker 启动失败 | `on` 返回错误 + 日志路径；不注册任何工具 |
| worker 崩溃 | 当前调用错误 + 自动重启一次；失败则提示 init/status |
| 工具参数错误 | VT 错误信封 + `error.data` 提示 |
| 结果过大 | 头部 + `full_path` + 提示用 `vt_call("read_file")` 读全文 |
| 工具不存在（版本差异） | 明确报错并提示版本/升级 |

## 13. 边界与已知限制

- **`off` 只在会话开始对话前可用**：已产生工具调用的会话不允许撤销（历史里的调用会变成 `unknown tool`，且作废前缀缓存）。
- **热重载/升级会 dispose 活跃会话的会话级工具**：尽量在 turn 之间更新；进行中的 turn 可能被打断。
- **DSH 不能改写已提交的 assistant 消息**：门禁不通过时只能纠正/披露，不能遮蔽正文（展示层见 [`number-verification.md`](number-verification.md)）。
- **第三方命令显示面受限**（DSH ≤ 0.2.2-rc.5）：`/vibe-trading` 在 `/` 菜单没有图标、标题/描述不随语言切换，且只在裸 token 时执行。
- **宿主版本适配**（2026-11-19 核对 0.2.2-rc.5）：`isConcurrencySafe` 必须是谓词；`user/message` 里宿主注入的
  `runtime-context`/`time-context` 不能当作用户输入；被拒绝的 `off` 不算关闭意图（详见 [`decisions.md`](decisions.md) D23）。
- **宿主版本下限**：`package.json` 的 `engines.dsh = ">=0.2.2-rc.5"` 由 DSH 在 profile 加载时判定（`includePrerelease`，
  单一下限，不需要随宿主升级调整）；不满足时本 bundle 被跳过而不是半载入（D24）。
- 未验证版本（`--latest`）可运行但 `status`/`on` 告警；激活时对比 `tools/list` 与 `toolsets.json` 快照报“工具面漂移”。

## 14. 文档地图

| 文档 | 作用 |
|---|---|
| [`decisions.md`](decisions.md) | 设计决策：已定取舍与被取代的旧决策 |
| 本文件 | 设计事实：边界、架构、命令、初始化、worker、工具、技能、提示词、沙箱、预算、失败模式 |
| [`number-verification.md`](number-verification.md) | 数字核实三层机制与展示层 |
| [`data-sources.md`](data-sources.md) | 行情数据来源、失败原因与用户侧配置 |
| [`development.md`](development.md) | 本地环境、校验、真机验收、真实会话测试、场景矩阵、发版 |
| [`postmortems/install-hang.md`](postmortems/install-hang.md) | 安装挂起事故复盘与回归防线 |
