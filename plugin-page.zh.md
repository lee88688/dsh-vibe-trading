# Vibe Trading

在 DSH 会话里使用 Vibe-Trading 的金融研究工具、技能和数字纪律（DSH 负责 agent loop）。

> 仅用于研究和教育；不执行交易，不构成投资建议。本项目与 HKUDS 无隶属或背书关系。

## 激活与会话

- 新会话执行 `/vibe-trading on`：注册 10 个会话级工具（6 常驻 + 4 网关），并把领域提示词注入当前会话。
- `/vibe-trading status` 查看环境、worker、数字门禁和本会话状态；`/vibe-trading off` 只在会话开始对话前可用。
- 首次使用先跑 `/vibe-trading init` 建 Python 环境（1–2 分钟；已就绪时幂等）。

## 本页「配置」

这些设置属于**当前 DSH profile**，保存在该 profile 的 `cordis.patch.yml`（每个 profile 各一份），
与 `~/.vibe-trading/dsh/` 里的安装环境无关。

- **数字核实门禁**：回答里的每个数字都必须能在本次会话的工具结果中找到依据；不通过时注入一次纠正
  （`[GROUNDING GATE]`），预算耗尽后让模型用一句话说明"部分数字未能核实"。
  `identity` 门禁要求行情类工具调用前先用 `search_symbol` 锁定标的。
- **技能与 worker**：`skills.mode` 控制提示词里的技能目录（**下次激活**生效）；worker 的空闲退出与超时
  对已激活会话的**下一次工具调用**生效。
- **猴子补丁**：`worker.patchFile` 填一个 `.py` 的绝对路径（默认留空 = 不加载），worker 每次启动时
  执行一次，可用来改数据源、注册表或工具行为。**改完要重启 worker**（重启 DSH 或等空闲回收）才生效；
  加载结果写在 `ping` 的 `startup.user_patch` 里（`ok=false` 时带 `error`）。补丁抛异常不会拖垮 worker，
  但等于没生效。示例见 `~/.vibe-trading/dsh/patches/`。
- **安装策略只读**：切换 vibe-trading-ai 版本请用 `/vibe-trading init --pinned|--latest`。

保存后立即生效：不重挂插件、不 dispose 工具、不打断进行中的会话。唯一例外是"轮次中途打开门禁"——
本轮已发生的工具结果不在证据账本里，建议在轮次之间切换。
