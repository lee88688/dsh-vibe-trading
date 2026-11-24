---
name: vt-parity-check
description: 核对 dsh-vibe-trading 与上游 Vibe-Trading 的功能与行为一致性（提示词/工具/技能/门禁）。用于 vibe-trading-ai 升级、_vendor 参考 clone 变动、改动 prompt/toolsets/worker/grounding 之后，或发版前扫描漂移；只输出问题清单与建议，不生成报告文件。
whenToUse: 当用户说“核对插件和 VT 是否一致 / 有没有漂移 / 升级后扫描 / parity / 对齐检查”，或 vibe-trading-ai 版本、_vendor tag、插件提示词/工具面/门禁代码发生变化时。
---

# vt-parity-check

## 目标

每次执行产出一份**问题清单 + 建议**（在对话里），回答两个问题：

1. **功能还在不在**：VT 的提示词、工具、技能、行为，插件是否仍然提供/覆盖？
2. **行为还一不一致**：同一条请求/同一份工具结果，插件给用户的结果是否与 VT 等价？

**不产出报告文件**：不写 `docs/`、不提交 git。
原始扫描数据只落 `.tmp/parity/<run-id>/`（git-ignored），供本次对话引用；对话结束可丢弃。

## 铁律（每次）

- **只读**：不改产品代码/配置/提示词/`toolsets.json`，不 `pnpm build`，不重载插件、不重启服务。
- **不跑真实会话**（除非用户明确要求单独一轮验证）：静态扫描 + 现有校验脚本即可；真实会话验证是另一个任务。
- **不热修**：发现问题先只列出来；修不修、怎么修由用户决定（一次只改一类）。
- **基线是技能资产**：`references/baseline-*.md` 记录“上次核对时的数字与已知缺口”，版本/数字变化时**只更新基线文件**，不写报告。
- **找不到证据就不写**：每条问题必须能指到 `file:line` 或命令输出；不确定的放“未验证/假设”。

## 快速开始（3 步）

1. 跑机器扫描（只读，约 30–60 秒）：

   ```powershell
   # 用运行时 venv 或仓库 .venv 均可（两者都装 vibe-trading-ai）
   & "$env:USERPROFILE\.vibe-trading\dsh\venv\Scripts\python.exe" `
     .agents\skills\vt-parity-check\scripts\scan.py
   ```

   输出：版本三元组、四张工具面数量、技能/目录统计、按级别的 findings（code / 证据；完整的修复建议在
   `.tmp/parity/<run-id>/scan.json` 的 `suggestion` 字段，整理输出时读它）。

2. 对脚本没覆盖的部分，按 [`references/checks.md`](references/checks.md) 人工补查（每项都给了命令与判据；
   先读 [`references/baseline-*.md`](references/baseline-2026-11.md) 了解上次结论，只查“可能变了”的项）。

3. 按下面的输出格式给用户**问题清单 + 建议**，并给出总评与修复顺序建议。

## 扫描范围（四轴）

| 轴 | 脚本自动检查 | 需要人工判断（checks.md 对应节） |
|---|---|---|
| 工具面 | 四张名单差分（registry/MCP/worker/advertised）、hidden、契约抽查、virtual 漂移、超时白名单、脱敏、落盘读回、文件根 | 新工具是否该进组、hidden 是否有意、新默认值是否会改变行为 |
| 技能面 | 89 技能名单/描述/正文 diff、加载协议、目录截断与分类顺序、references 指引 | 新技能是否需要新工具/脚本、被截断的是否影响选择 |
| 提示词面 | 六原则/关键 guideline 逐字节、内部矛盾（shell/纠正提示/日期）、组名与路由语法、bridge 覆盖 | 新改写段落是否误导、动态计数是否漂移 |
| 行为面 | 门禁释放路径、证据摄取点、identity seed、修订预算、错误信封、turn budget、压缩与安全扫描 | 同一回答在两边是否会给用户不同东西（重点） |

## 输出格式（强制）

先给一行总评，再给问题表，最后给“未验证”。

```markdown
## 总评
<一句话：功能面 X 成、行为面 Y 成；阻塞 P0 n 个；与上次基线相比：...>

## 问题与建议
| # | 级别 | 问题 | 证据 | 建议 |
|---|---|---|---|---|
| 1 | P1 | 纠正提示仍要求正文输出 figures 块 | worker/grounding_adapter.py:392 | 在 adapter 输出后做文案替换（report_figures 口径） |
| ... |

## 未验证 / 假设
- ...
```

规则：

- **只列问题与建议**；没有问题的轴用一行“XX 轴未发现不一致”带过，不贴日志、不贴大段代码。
- 证据写 `file:line` 或脚本输出摘要；一条问题最多两行证据。
- 建议必须标类型：`[提示词]` / `[代码]` / `[文档]` / `[宿主/需要 DSH 能力]`；能一步到位的小改优先。
- 级别口径：
  - **P0**：会产生错误结论或用户可见的错误数据（例：未核实数字可先到用户；门禁开着但无兜底）。
  - **P1**：能力缺口或用户可见行为不一致（提示词事实错误、必需工具不可达、契约/默认值变化、超时误杀、无脱敏）。
  - **P2**：有损但有替代或影响有限（目录截断、描述丢失、文档漂移、identifier 语义差异）。
  - **P3**：纯文案/注释/计数漂移。
- 收尾建议给出“先修哪 3 个”，并问一句是否按顺序修；不要直接动手。

## 判升级是否“需要重扫”的触发条件

- `config.json` 的 `package.installedVersion` 变化，或 `_vendor/Vibe-Trading` tag 与运行时版本不一致；
- 改动 `prompt/*.md`、`toolsets.json`、`worker/*.py`、`src/lib/{gateway,verify,worker,prompt,activate}.ts`、`worker/grounding_adapter.py`；
- 用户报告“模型不知道有某工具/技能”“某数字没被核实/被误拒”“长任务被超时”等行为问题。

## 与真实会话验证的边界

静态扫描只能回答“代码/文本是否还对齐”。下面三类必须靠真实会话（另行安排，按 AGENTS.md §6 用 driver 会话）：

1. 门禁 `turn-stopping → steer → 用户可见文本` 的端到端行为；
2. 交易/执行类请求的拒绝措辞与“不编造成交”；
3. 技能工作流（references/scripts、交割单、影子账户）是否真能走通。

在这些验证完成前，输出里把相关结论标为“静态成立、未真机验证”。

## 基线维护

- 首次使用先读 [`references/baseline-2026-11.md`](references/baseline-2026-11.md)（记录 0.2.4 / VT 0.1.19 的数字与已知缺口）。
- 每次扫描后：若版本、四张名单数量、技能数或已知缺口状态变化，**只更新基线 md/json 里的对应行**（一行改动），不要生成报告。
- 已知缺口修复后，从基线“已知缺口”表删除该行，并在对话里注明“已修复”。

## 目录

```
.agents/skills/vt-parity-check/
├─ SKILL.md                  ← 本文件：流程、输出格式、判级
├─ references/
│  ├─ baseline-2026-11.md    ← 上次核对基线：版本/数字/已知缺口（更新它，而不是写报告）
│  └─ checks.md              ← 脚本未覆盖项的人工检查清单（命令 + 判据）
└─ scripts/
   └─ scan.py                ← 只读机器扫描：四轴事实 + 机械比对 → findings
```
