# 数字核实系统：VT 为什么"不估算、只计算、且数字会被核实"

> 这是 Vibe-Trading agent 最鲜明的特色，也是我们在 DSH 侧最需要移植的部分。
> 依据 `_vendor/Vibe-Trading` v0.1.19 源码。

## 0. 一句话

它不是靠"提示模型要小心"，而是**把每个数字变成必须可追溯的对象，再用机械校验强制执行**：
模型要么指向工具结果，要么在 `figures` 块里声明并给出**可求值的公式**，
否则回答被拒绝、打回重写；重写两次仍不合格就**遮蔽该数字**再发布。

## 1. 第一层：提示词里的"数字契约"

`src/agent/context.py:193-265`（Guidelines 中的 "Declare every figure..."）：

- 判定标准：**带小数点、百分号、货币符号或位于表格单元格的数字**都算"figure"；
- 纯工具返回的价格/成交量可以直接写，其它必须通过 **`report_figures` 工具**提交（DSH 版：正文不再输出 ```figures 代码块，见 §5）：
  每行格式 `value | role | note | ref`；
- 五种 role（`src/agent/grounding/figures.py:38`）：
  | role | 含义 | 必须提供 |
  |---|---|---|
  | `observed` | 工具返回值（如 PE），或回测输出 | `ref` = 工具名/调用 id/run 目录 |
  | `derived` | **对观测值做算术** | `note` = 公式；**所有操作数都必须是本 session 观测到的**；`ref` = 来源 |
  | `proposed` | 建议的价位（入场/止损/目标） | 必须落在观测价格区间内，或给公式 |
  | `cited` | 来自本 session 之外 | 同一句话+note 里注明来源 |
  | `count` | 自选的计数/窗口/权重/概率/阈值 | 值 + note 标签必须在正文可见行 |
- 明确禁止："**Never relabel missing data as a chosen parameter: fetch it or remove the calculation**"
  （`context.py:229-230`）——不能把缺失数据"改名"成拍脑袋的参数；
- 明确的兜底："A figure you cannot declare truthfully under one of these roles must be **removed, not relabelled**"
  （`context.py:256-257`）；
- Output Principles 1/3（`context.py:41-55`）：每个数字必须能指出本 session 返回它的一次工具调用；
  工具没返回的，不许补。

## 2. 第二层：机械门禁（真正执行的地方）

`src/agent/grounding/`（约 4.8k 行纯 Python，零第三方依赖）：

| 文件 | 职责 |
|---|---|
| `figures.py` (56KB) | 解析 `figures` 块（`parse_figures_block` :791、`strip_figures_block` :873）；把正文里每个数字按**形状**分类（日期/时间、代码、列表序号、表格标号、测量值、裸整数），并做规范化（不可见字符、Markdown 转义、千分位、全角）；再把正文数字匹配到声明 |
| `ledger.py` | `GroundingLedger`：`ingest_tool_result` (:280) 把**未截断**的工具结果存成本轮证据；`validate_final_answer` (:360) 跑完整校验；`streamable_length` (:217) 给流式扣留用 |
| `policies.py` (119KB) | 逐项检查：`figure-derived` (:2191)、`figure-count` (:1530)、`figure-observed` (:1672)、`figure-proposed` (:2256)、`figure-cited` (:2342)、`undeclared-figure` (:685)、`figure-symbol` (:664)、`figure-price-column` (:717)、provenance 检查 |
| `figures_checks.py` | `figures-block-malformed`、`unsourced-symbol-figures` (:48)：数字挂到本 session 没处理过的 ticker → 拒绝 |
| `release.py` | 拒绝后的纠正提示（`correction_prompt` :176，逐条列出每个失败数字和它的问题）、`MAX_GROUNDING_REVISIONS = 2` (:32)、`redacted_release`（把被拒数字替换成 `（略※）`）、`safe_fallback` (:365) |

**核心机制：`derived` 的公式真的会被求值。**
`_check_derived`（`policies.py:2191-2254`）把 `note` 当算术表达式解析成 AST（`_evaluate_formula`），
用本 session 观测到的值代入，要求：

1. 至少两个操作数、其中至少一个来自本 session 的证据；
2. 不能用未观测的值当"参数"顶替（否则报 `operand_not_observed`）；
3. 求值结果必须与模型写的数字一致（否则报 `derivation_result_mismatch`，并明确告诉模型
   `"its own formula evaluates to X"`，甚至能识别符号写反）。

所以"心算一个数字"必然过不了：要么没声明（`undeclared-figure`），要么公式对不上。

## 3. 第三层：让"计算"有工具可用

模型之所以"写代码算"，是因为提示词要求可求值公式 + 有现成计算工具：

| 工具 | 位置 | 作用 |
|---|---|---|
| `financial_rigor` | `src/tools/financial_rigor_tool.py` | 6 个纯 stdlib + `Decimal`(28 位) 子命令：`verify_market_cap`（市值复核，1%/5% 判定）、`verify_valuation`（PE/PB/ROE/P/FCF 从原始每股数据推导）、`cross_validate`（同一字段多源交叉，默认 2% 容差、给出中位数共识）、`benford`（≥50 样本首位数字检验）、**`calc`（AST 白名单的精确算术求值）**、`three_scenario`（牛/平/熊目标价） |
| `report_audit` | `src/tools/report_audit_tool.py` | 两阶段报告审计：`extract` 从 markdown 报告抽数字（支持 `亿/万亿/x/倍/%` 单位）并抽样（默认 15%，3–30 个）→ `verdict` 对 1% 容差逐点核对，单点失败即整份报告不通过 |
| `quantlib_call` | `src/quantlib/*` | 确定性金融数学（VaR/ES、归因、期权、统计检验）；技能 `quant-statistics` 明确要求"**import 调用，不要把这些公式重抄进一次性代码**" |
| `read_run_artifact` / `artifacts/*.csv` | `src/tools/read_run_artifact_tool.py` | 让模型读回测产物再计算，而不是凭记忆 |

配套技能里还有一条三层的说法（`src/skills/research-discipline/SKILL.md`）：
`financial_rigor` 校验**数据层**、`report_audit` 校验**输出层**、该技能自己校验**推理层**。

## 4. 完整的一次"数字"生命周期

```
工具返回数据
  → ledger.ingest_tool_result（未截断，进证据账本）
  → 模型用 calc / quantlib_call / 写脚本计算（得到 derived 值）
  → 判定"要写进答案的数字"→ 调用 report_figures({figures, draft})（每个数字一行：value | role | note | ref）
  → validate_final_answer：
      解析块 → 正文数字形状分类 → 匹配声明 → identity → 声明完整性
      → 逐 role 校验（derived 公式求值比对）→ provenance
  → 通过：确认最终回答 == 已校验草稿，正常发布（正文本来就没有块）
  → 不通过：correction_prompt（逐条列出问题）→ 模型重写（最多 maxRevisions 次拒绝）
            → 仍不通过：明细写进轮末面板并关轮（onFailure=panel，默认）；
              disclose 才再 steer 一句"部分数字未核实"，silent 两者都不做
```

## 5. 展示层：门禁参考面板（2026-11-13）

DSH 不能改写已提交的 assistant 消息，所以门禁的参考信息放在每轮末尾的 `turnTail` 面板里，而不是正文：

- **三组**：未核实/未汇报（默认展开；数字 + 上下文 + 原因）、已汇报且通过、自动豁免（无需 report）。
- **数据通道**：`turn-stopping` 耗尽纠正预算时，插件把面板数据写成 `plugin:dsh-vibe-trading/gate` 的
  **ignorable** 会话记录（`ignorable: true`；未知读者跳过、fork/resume 携带、模型不可见），然后**直接关轮**——
  面板紧贴失败的那版回答，不再为一句"部分数字未核实"多跑一轮模型。
- **三种耗尽行为**（`verification.onFailure`）：`panel`（默认，只出面板）/ `disclose`（额外 steer 一句，
  正文里也留披露，适合导出或没有 client 半的客户端）/ `silent`（面板与消息都不做）。
  面板记录写不进去时（桥不可用）退回 `disclose` 行为，否则用户拿不到任何披露。
- **回退**：`appendPluginRecord` 桥不可用（宿主布局变化/实验 API 移除）时，披露消息退回完整文本格式；
  投影两种都解析，旧会话不丢面板。
- **约束**：正文与前缀缓存不变；面板数据仍在本地会话日志中；投影 `stateVersion` 在解析规则变更时递增，
  以丢弃旧 checkpoint（v2→v3 已用于修复“压缩摘要误判为披露”）。
