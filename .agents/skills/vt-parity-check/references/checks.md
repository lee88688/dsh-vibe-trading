# 人工检查清单（scan.py 未覆盖 / 需要判断的部分）

> 用法：先跑 `scripts/scan.py`，把它的 findings 当作"机器确认"；本文件只用于**脚本无法判断**或**需要读上下文**的项。
> 每项都给了命令；没有命令的给"读哪里 + 判据"。不要全做——先看 `baseline-2026-11.md`，只查可能变了的项。

## 0. 先决核对（1 分钟）

- [ ] 运行时版本 = 基线（`config.json` + `importlib.metadata`）；不一致 → 先按"升级专项"做。
- [ ] 插件在 profile 里 `enabled=true`（`plugin_manager list_plugins`，找 `dsh-vibe-trading`）。**只读检查，不要开关**。
- [ ] `dist/` 存在（`Test-Path dist/lib/gateway.js`）；不存在 → 提示"装前必须 pnpm build"，本次扫描只看源码。

## 1. 工具面（人工判断项）

1. **新工具三问**（VT 升级后必做）：从 `scan.py` 的 `TOOL01/TOOL02` 或 registry dump 里找出"VT 有、插件未广告"的工具：
   - 它属于哪类能力（数据源/研究/回测/交易执行/记忆/后台/技能写）？
   - 插件是否已有等价替代（查 `toolsets.json` 的 `dropped`/`excluded`/`replacedBy*` 与提示词 bridge）？
   - 是否应进组（`staticCore` 或某个 `groups`）？进了组是否要改提示词路由？
   记录：工具名、能力、建议（进组/保持隐藏/加进 hidden 清单）。
2. **hidden 是否有意**：`scan.py` 报的是"未显式记录"。逐类看 `baseline` 的 hidden 分类；若某 hidden 工具在新版本变成"用户高频请求"，
   考虑提升进组；若只是执行类/记忆类，保持隐藏并在 `toolsets.json` 增加显式 `hidden` 条目。
3. **新默认值/枚举**（schemas 变化但字段集没变时 `scan.py` 可能不报）：抽查 3–5 个高频工具（`get_market_data`、`backtest`、`financial_rigor`、`search_symbol`、`read_document`）：
   - 默认值、枚举、required 是否变化？变化是否改变模型行为（例：`source` 新增枚举、`max_rows` 默认变小）？
4. **错误信封**：用 `check_worker.py`（`pnpm check:worker`，需网络；离线可跳过）看 key-gated 工具是否仍返回同款 `not configured` 信封。
5. **超时/并发语义**（`scan.py TOOL07` 之外）：新工具若是长任务，确认是否进 `LONG_RUNNING_TOOLS`，以及 DSH 取消是否传导。
6. **文件根**：`read_file`/`write_file`/`read_document` 的允许根是否仍覆盖 run 目录、results、DSH 附件根
   （`~/.dsh/attachments/v1`，2026-11-11 已加）与 `work/uploads`。
   **判据**：GUI 上传的附件应能直接 `read_document`；仅存在于 session workspace 的文件仍不在全局根内（共享 worker 不能按会话切换根），
   应提示模型/用户复制到 `work/uploads` 或改用附件。若附件根失效，升级为 P1。

## 2. 技能面（人工判断项）

1. **新增/改名/删除技能**：`scan.py` 的 `SKILL01/03` 会报差异；对新增技能判断：
   - 是否引用新工具（新工具是否在 advertised 集合）？
   - 是否要求本地执行（`pip install` / `python scripts/` / `bash(...)`）？若是，按 bridge 的口径（不执行、转述/交用户）处理。
2. **加载协议抽查**（升级后必做 2 个）：任选一个长技能，验证 outline → `section` → `offset` 翻页仍工作；重名 section 是否仍报候选。
   命令（真实 worker，只读）：
   ```powershell
   # 用 scan.py 的 dump_worker 思路，或直接：
   & "$env:USERPROFILE\.vibe-trading\dsh\venv\Scripts\python.exe" -c "<spawn worker + skills/load>"
   ```
   更简单：真实会话里 `vt_load_skill(name=..., section=...)` 一次；但**这属于真机验证，需用户同意**。
3. **目录可读性**：读 `scan.py` 输出的最短截断样例；若新版本出现更多 `<40 chars` 的目录行，升级为 P1 并建议修截断算法。
4. **resources 指引**：`scan.py SKILL06`；若新技能大量依赖 references，提示词缺指引就是 P2（或 P1，取决于核心技能是否依赖）。

## 3. 提示词面（人工判断项）

1. **逐节 diff**（升级后必做）：VT `context.py` 的 `_SYSTEM_PROMPT` 与 `prompt/vibe-trading.md` 按节对照。
   `scan.py` 只比对六原则 + 3 条关键 guideline；其余节人工看：
   - 新增/删除的 section（尤其 Task Routing、Guidelines、Tools/Skills 段）；
   - VT 改写的措辞是否影响纪律（"must / never" 是否被弱化）。
2. **内部一致性**（`scan.py` 只覆盖 shell/日期/组名/纠正提示）：
   - figures 契约三处口径是否一致：提示词、`report_figures` 工具描述、`grounding_adapter` 返回文案；
   - 工具名：提示词/技能文档引用到但未广告的工具（用 `grep -oE '`[a-z_]+\(`' prompt/*.md` 对照 advertised）；
   - run 目录：提示词要求"自己建绝对路径"与工具是否自动建目录/注入 run_dir 是否冲突；
   - PDF：`write_file` 是否真能渲染 PDF（跑一次 `vt_call("write_file", {path: ".../x.pdf", content: "# x"})`，只读验证，可放 `.tmp`）。
3. **bridge 覆盖**：`scan.py PROMPT07` 只查 replaced/dropped 名字；人工补：技能文档里引用的隐藏工具名是否都有"不可用/替代"说明。
4. **动态计数**：确认提示词里的组名/工具数/技能数不是硬编码（`scan.py PROMPT05` 查组名；其余用 grep `\b[0-9]+\b` 粗看）。

## 4. 行为面（人工判断项，最关键）

> `scan.py` 只能做静态判断；下面 4 项是"用户感知差异"的高发区，必须读代码 + 必要时真机验证。

1. **门禁端到端**（P0 相关）：读 `src/index.ts` 的 `turn-stopping` 路径 + `worker/grounding_adapter.py` 的 `validate`，
   回答：被拒草案是否已经作为 `assistant/message` 提交？失败后 steer 的文案是否仍要求 figures 块？预算耗尽后的披露是否准确？
   展示层：`vibe-state.ts` 折叠披露消息里的 `未核实/已核实/自动豁免` 三组，客户端 `turnTail` 面板渲染；
   改动披露文本格式时同步 `client.js` 与 `tests/vibe-state.test.mjs`（格式是 load-bearing 的）。
   **真机验证（需用户同意，按 AGENTS §6）**：新会话让模型不调 `report_figures` 直接写一个编造数字，看界面是否保留、
   steer 后是否出现 figures 块；纠正文案应已改写为 `report_figures` 口径（`worker/grounding_adapter.py:_adapt_correction_prompt`）。
2. **交易/执行拒绝**：读 `prompt/bridge.md` 的不可用清单 + 主提示词 Guidelines，确认有"不能下单/不得声称成交"的明文；
   没有就报 P1（即使实测拒绝正确，也缺机制保证）。
3. **证据摄取范围**：读 `src/lib/activate.ts` 与 `gateway.ts` 的 `afterResult` 调用点；若新版本引入新的工具执行通道（如宿主中间件），确认是否入账。
4. **长任务收敛**：读 `src/index.ts` 是否有 turn 预算/收尾/熔断；没有则确认 `docs/` 是否如实声明（DSH 无内建 turn budget）。

## 5. 升级专项（`config.json installedVersion` 或 `_vendor` tag 变化时）

1. 记录旧→新版本；先看 VT `CHANGELOG.md`（`_vendor/Vibe-Trading/CHANGELOG.md`）中与 agent/tools/skills/grounding 相关的条目。
2. 重点 diff 三类：
   - **工具**：新增/删除/改名/默认值/枚举/schema；MCP 面是否同步（virtual tools 是否需重生成）。
   - **技能**：新增/删除/正文大改（尤其依赖新工具或新脚本的）。
   - **提示词/行为**：`context.py` 的 `_SYSTEM_PROMPT` 差异、grounding 规则/默认值、`tool_loading.json`、`env_schema.py` 相关默认值。
3. 重跑 `scan.py`，把 `BASE01` 的变化逐条确认（新工具/新技能/新 face 是否有意）。
4. 判断"插件的最低版本"（`config.ts` 的 `DEFAULT_MINIMUM_VERSION`）是否要跟着提；若新版本删除了插件依赖的工具/字段，可能需要兼容分支。

## 6. 收尾（1 分钟）

- [ ] 本次有新增/删除的缺口？→ 更新 `references/baseline-2026-11.md` 的"已知缺口"表（只加/删行）。
- [ ] 版本/数量变化？→ 更新 `references/baseline.json` 与基线 md 的数字。
- [ ] 输出按 SKILL.md 的格式：总评 + 问题/建议表 + 未验证；**不写报告文件、不改产品代码**。
