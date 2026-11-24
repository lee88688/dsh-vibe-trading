# 基线：dsh-vibe-trading 0.2.7 ↔ Vibe-Trading 0.1.19（2026-11-13）

> 这是 `vt-parity-check` 的**对照基线**，不是报告。每次扫描后如果版本/数量/缺口状态变化，**只更新本文件与 `baseline.json` 的对应行**；
> 不要在这里追加扫描详情，也不要写进 `docs/`。历史结论只保留"当前仍成立"的部分。

## 版本三元组

| 项 | 基线值 | 来源 |
|---|---|---|
| 插件版本 | `0.2.7` | `package.json` |
| 运行时 `vibe-trading-ai` | `0.1.19` | `~/.vibe-trading/dsh/config.json` + `importlib.metadata` |
| `_vendor` 参考 clone | `v0.1.19` | `git -C _vendor/Vibe-Trading describe --tags` |
| 宿主 | DSH Desktop `0.2.2-rc.1`，web profile，`standard` preset | profile/预设文件 |

## 关键数字（baseline.json 同源）

| 面 | 数量 | 说明 |
|---|---|---|
| VT registry | 118 | `build_registry()` 默认（`include_shell_tools=False`）；开 shell 为 121 |
| VT MCP 面 | 81 | `mcp_server.mcp.list_tools()` |
| 插件 worker | 127 | 118 registry + 9 virtual |
| 插件 advertised | 88 | 87 worker（staticCore 5 + groups 82）+ 本地 `report_figures` |
| hidden | 40 | worker − advertised；0/40 可达，34 个无替代 |
| 技能 | 89 / 9 类 | 与安装包 `src/skills` 逐项一致（sha1 相同） |

## 关键运行时事实（扫描时用于判断"是否仍成立"）

- 门禁：`verification.enabled=true`、`identityGate/figuresGate=true`、`maxRevisions=2`、`onFailure=disclose`、`ignoreRules` 全开（`~/.vibe-trading/dsh/config.json`）。
- 工具超时：默认 120,000ms；10 个白名单工具 1,860,000ms（`src/lib/worker.ts`）。
- 结果交付：单结果 10,000 字符截断；超限落单文件 `<cwd>/results/<uuid>.json`，`read_file` 只有 `limit`、无 `offset`（VT 侧）。
- 提示词：`prompt/vibe-trading.md` 27,094 字符 + `bridge.md` 4,124 字符；组装后 prompt section ≈49,332 字符 ≈12.3k tok（历史测量，升级后需复测）。
- 六原则：2,628 字符，`prompt/vibe-trading.md:18-56` 与 VT `context.py:34-72` 逐字节一致（LF 归一化）。
- DSH 会话事实：`standard` preset 在 Windows 挂 `tool-pwsh`、`tool-jobs`、`compaction-basic`、`command-compact`、`tool-result-pruner`、`time-context`。
- 技能目录：`skills.mode=short`，`loadLimitChars=10000`；实测 89 次加载 0 error、0 二次截断，最大投递 9,964 chars。

## 已知缺口（2026-11-10 基线；修复后删行）

> 级别口径见 SKILL.md。带 `→ 扫描码` 的会被 `scan.py` 自动复查；其余需按 `checks.md` 人工确认。

| # | 级别 | 缺口 | 扫描码/位置 | 状态 |
|---|---|---|---|---|
| 1 | P0 | 门禁开启时无发布前拦截：被拒草案已展示、不可撤回；无 VT 的 `redacted_release`/`safe_fallback`。已落地展示层缓解：`turnTail` footer + 三组折叠面板（未汇报/未通过含上下文、已汇报且通过、自动豁免）；明细走 `plugin:dsh-vibe-trading/gate` ignorable 插件记录（实验 API，失败回退披露文本），披露消息保持一行、正文不改、缓存不动 | → `BEHAV02` | open（平台限制；展示层缓解已真机验证） |
| 2 | P2 | loop 治理层缺失：无 turn 预算/收尾提示/无进展熔断/停滞看门狗（DSH 明示无内建 turn budget） | → `BEHAV05` | open（DSH 平台） |
| 3 | P2 | 上下文压缩阈值/策略与 VT 不同（≈550k vs 200k），摘要无 verification ledger 保护，模型无 `compact` 工具 | 人工（checks.md 行为面） | open（DSH 平台） |
| 5 | P2 | `ignoreRules` 抑制即通过、无 `repair_provenance`（D19 的有意取舍，但与 VT 行为不一致） | 人工（checks.md 行为面） | open |
| 6 | P2 | PDF 话术：`write_file` 可渲染 `.pdf`，但插件提示词按"PDF 不可用"处理，且 `download_url` 指向不存在的 VT web 服务 | 人工（checks.md 提示词面） | **不修**（2026-11-13 用户确认：PDF 非主流程、低价值；保留提示词"不要用 .pdf 存文本"的防错约束） |
| 7 | P3 | `read_document` 允许根已加 DSH 附件根（`~/.dsh/attachments/v1`），但 session workspace 仍不在全局根内；工作区文件需先复制到 `work/uploads` 或让用户用附件 | → `TOOL10`（已不报） | 记录在案（设计取舍） |

> 2026-11-11 已修（不再列入）：纠正提示通道（PROMPT04）、shell/后台事实错误（PROMPT03）、路由直调语法（PROMPT06）、交易拒绝句、
> 大结果分片读回（TOOL09）、工具脱敏（TOOL08）、超时白名单（TOOL07/07b）、证据账本外部工具入账（BEHAV01，read/web；pwsh 故意除外）、
> hidden 显式清单（TOOL04）、virtual 描述 0.1.19（TOOL06）、技能目录截断/分类顺序（SKILL04/05）、技能资源指引（SKILL06）、
> `vt_load_tools` 组名（PROMPT05）、identity seed（BEHAV03）、修订预算（BEHAV04）、文档/日期漂移（DOC01-03/PROMPT08）。

> 2026-11-13：P0 展示层缓解（三组面板 + `plugin:dsh-vibe-trading/gate` ignorable 记录）真机验证；披露消息 66 字符，明细不占模型上下文；`vt_load_tools` 默认改为 description + 完整 JSON Schema（compact 可选），PDF 话术确认不修。

## 更新规则

1. 版本三元组变化（升级）→ 更新本表 + `baseline.json` 的版本/数量字段，并重跑一次扫描确认差异。
2. 某缺口修复 → 从本表删行；`scan.py` 对应码若仍报，说明未真修或检测口径过期（修脚本）。
3. 新缺口 → 只在上表加一行（编号顺延），不写详情；详情在当次对话里说明。
4. 不要在本文件记录历史快照；上一版基线只保留在 git 历史里。
