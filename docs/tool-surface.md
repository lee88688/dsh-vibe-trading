# 工具面对照表（vibe-trading-ai 0.1.19）

> 本文件由 `scripts/validate/gen_tool_surface_doc.mjs` 生成，**不要手改**。
> 改完 `toolsets.json` 后运行 `pnpm docs:tools`；`pnpm check:tools` 在 CI/校验里检查本文件是否过期。
> 升级 Vibe-Trading 版本的流程见 §8。

一句话：worker 发布 **127** 个工具，本插件最多暴露 **88** 个 worker 工具 + **1** 个本地工具；
其余 39 个要么由 DSH 接管、要么需要凭据、要么被明确禁用（每条都有理由，见下）。

## 1. 数字账

| 项 | 数量 | 说明 |
|---|---|---|
| worker 发布工具 | 127 | 118 registry + 9 virtual（`tools/list` 实测） |
| 上游 MCP 对外工具 | 81 | `mcp_server.py` 的公开面；比 worker 少（含 6 个 swarm 名，不含 registry-only 工具） |
| 本插件暴露（上限） | 89 | 88 worker + 1 本地 `report_figures` |
| ├ 常驻 staticCore | 5 | 激活时直接注册，无需 load |
| └ 工具组（9 组） | 83 | 经 `vt_load_tools` 加载、`vt_call` 调用 |
| 未暴露 worker 工具 | 39 | hidden 25 + DSH 替代 9 + 网关替代 1 + dropped 4（另 6 个 dropped 名 worker 从未注册） |
| 需要凭据（缺则不出现在目录） | 6 | 见 §4；本机缺凭据时运行时目录 = 83 |

## 2. 常驻工具（激活时直接注册）

| 工具 | 来源 | 说明 |
|---|---|---|
| `search_symbol` | VT registry | 标的解析：代码/名称 → 标准化 symbol + 交易所 |
| `get_market_data` | VT registry | OHLCV 行情（多源回退） |
| `read_document` | VT registry | PDF / Office / 图片的文本提取（DSH 的 read 只管文本文件） |
| `backtest` | VT registry | 回测引擎，产物落 run 目录 |
| `financial_rigor` | VT registry | 确定性计算（涨跌幅/PE/汇率等），禁止用 shell 当计算器 |
| `report_figures` | 插件本地 | 声明回答引用的 figures（value / role / note / ref）与草稿正文，发布前对照本会话证据校验（工具描述面向模型，保持英文） |

## 3. 工具组（`vt_load_tools(toolset=...)`）

带 † 的工具需要凭据，缺凭据时会在运行时从目录和本组里移除（见 §4）。

| 组 | 成员数 | 成员 |
|---|---|---|
| `research` | 26 | `get_financial_statements`、`get_sec_filings`、`get_stock_news`、`get_research_reports`、`get_stock_profile`、`get_sector_info`、`get_margin_trading`、`get_block_trades`、`get_dragon_tiger`、`get_fund_flow`、`get_northbound_flow`、`get_southbound_flow`、`get_shareholder_count`、`get_lockup_expiry`、`get_institutional_holdings`、`etf_holdings`、`get_macro_series` †、`get_cn_macro_series` †、`get_cn_announcements` †、`search_broker_reports` †、`screen_market`、`iwencai_search` †、`prediction_market`、`research_papers`、`get_fundamentals`、`get_fund_nav` † |
| `backtest` | 9 | `factor_analysis`、`alpha_zoo`、`alpha_bench`、`list_strategies`、`query_strategies`、`get_strategy_evidence`、`refresh_strategy_evidence`、`adapt_strategy`、`read_run_artifact` |
| `quant` | 11 | `get_options_chain`、`options_pricing`、`options_payoff`、`quantlib_call`、`cashflow_performance`、`technical_indicators`、`sentiment`、`orderbook_depth`、`pattern`、`paper_trade_step`、`portfolio_risk_xray` |
| `verify` | 1 | `report_audit` |
| `team` | 5 | `analyze_trade_journal`、`extract_shadow_strategy`、`run_shadow_backtest`、`render_shadow_report`、`scan_shadow_signals` |
| `trading-reads` | 8 | `trading_connections`、`trading_select_connection`、`trading_check`、`trading_account`、`trading_positions`、`trading_orders`、`trading_quote`、`trading_history` |
| `goals` | 5 | `start_research_goal`、`get_research_goal`、`add_goal_evidence`、`update_research_goal`、`update_research_goal_status` |
| `runio` | 3 | `read_file`、`write_file`、`edit_file` |
| `research-workflow` | 15 | `create_hypothesis`、`update_hypothesis`、`search_hypotheses`、`save_research_artifact`、`search_research_artifacts`、`get_research_artifact`、`list_backtest_runs`、`generate_backtest_config`、`scaffold_signal_engine`、`link_backtest`、`link_autopilot_backtest`、`run_research_autopilot`、`sdm_register`、`sdm_status`、`sdm_decay_scan` |

## 4. 需要凭据才暴露

| 工具 | 需要的凭据 | 缺凭据时 |
|---|---|---|
| `get_macro_series` | FRED_API_KEY | 不出现在目录里（worker `capabilities` 上报 `available=false`） |
| `iwencai_search` | VIBE_TRADING_IWENCAI_KEY | 不出现在目录里（worker `capabilities` 上报 `available=false`） |
| `get_fund_nav` | GILDATA_TOKEN + fund_nav opt-in | 不出现在目录里（worker `capabilities` 上报 `available=false`） |
| `get_cn_macro_series` | GILDATA_TOKEN + macro_series opt-in | 不出现在目录里（worker `capabilities` 上报 `available=false`） |
| `get_cn_announcements` | GILDATA_TOKEN + announcements opt-in | 不出现在目录里（worker `capabilities` 上报 `available=false`） |
| `search_broker_reports` | GILDATA_TOKEN + broker_reports opt-in | 不出现在目录里（worker `capabilities` 上报 `available=false`） |

说明：

- 判定复用 VT 自己的 `check_available()`（只读环境变量，不联网），与上游“agent never sees a tool it cannot call”一致。
- 凭据是 **worker 启动时** 读取的；配好 `.env` 后需要重启 worker（空闲 30 分钟自动退出，或重载插件）才会出现在目录里。
- 这些名字在上游 registry 里会被 `check_available()` 直接剔除，所以 worker 用 MCP wrapper 的实现（virtual tool）承载；插件只在可用时把它放进目录。
- 券商连接（`trading-reads` 组）不是环境变量凭据：没配置时工具仍暴露，调用会返回“没有连接”，属于运行期配置而非门禁。

## 5. 由 DSH 接管（不暴露，但能力仍在）

| Vibe-Trading 名字 | 这里的替代 | 说明 |
|---|---|---|
| `web_search` | `web_search` | DSH 原生联网搜索，同名直接用 |
| `read_url` | `web_fetch` | 抓取网页为 Markdown/文本 |
| `analyze_image` | `read_image` | VT 版本要 VT 自己的 provider 栈，本部署不启用 |
| `save_skill` | `write` | 把 SKILL.md 写进 DSH 技能根 .dsh/skills/<name>/，新会话出现在技能目录 |
| `patch_skill` | `edit` | 修改技能正文或 references/ 下的附带文件 |
| `delete_skill` | `pwsh` | DSH 没有专用删除工具，删技能目录用 shell |
| `skill_file` | `read` | 读技能附带文件；写入用 write / edit |
| `check_background` | `job_list` | 后台任务列表与输出走 job_list / job_output |
| `scheduled_research` | `schedule_create` | 定时研究用 DSH 的 scheduled task（schedule_create / schedule_edit） |
| `list_skills` | 插件网关 | 由 `vt_list_skills` / `vt_load_skill` 承担 |
| `load_skill` | 插件网关 | 由 `vt_list_skills` / `vt_load_skill` 承担 |

上游默认不发布 shell 能力（要 `VIBE_TRADING_ENABLE_SHELL_TOOLS=1` 才开），这部分由宿主提供：

| Vibe-Trading 工具 | 这里的替代 | 说明 |
|---|---|---|
| `bash` | `pwsh` | DSH 自带 shell；VT 技能会提到 bash，改成 pwsh，且不能当计算器、不能读 VT 安装包 |
| `background_run` | `pwsh` | 长任务放后台作业跑，用 job_list / job_output 取结果 |
| `cancel_background` | `job_kill` | 取消 DSH 的后台作业 |

## 6. 直接禁用（hidden，25 个 registry 工具）

一行一组；每个工具都必须在这里有理由——`check_manifest.mjs` 会拒绝“悄悄消失”的工具。

| 类别 | 原因 | 工具（数量） |
|---|---|---|
| `execution`（10） | 交易执行一律不暴露（D1）：本部署是研究/只读形态，券商访问只做 trading-reads 的只读视图，不下单、不撤单、不改仓。 | `trading_place_order`、`trading_cancel_order`、`etoro_cancel_close_order`、`etoro_close_position`、`etoro_copy_close`、`etoro_copy_poll`、`etoro_copy_precheck`、`etoro_copy_start`、`etoro_edit_position_stops`、`etoro_search_instruments` |
| `broker-reads-extended`（7） | 券商扩展只读工具：用户配置券商连接前保持隐藏；常用的账户/持仓/委托/成交/报价视图已由 trading-reads 覆盖。 | `trading_acc_cash_flow`、`trading_capital_distribution`、`trading_capital_flow`、`trading_earnings_calendar`、`trading_financials`、`trading_history_deals`、`trading_rehab` |
| `memory`（3） | 本部署没有跨会话记忆与会话搜索（DSH 无等价能力，提示词要求明确告知用户）；compact 也不需要——宿主自动管理上下文，没有手动压缩工具。 | `compact`、`remember`、`session_search` |
| `research-needs-vt-ui`（1） | portfolio_summary 读的是 VT Web UI 刷新后落盘的组合快照；本插件不跑 VT 前端，永远没有快照可读。 | `portfolio_summary` |
| `research-needs-local-store`（1） | get_br_market_data 读本地同步的巴西数据仓（B3/CVM/BCB/Tesouro Direto）；没有这个库时除 status 外都是空结果。 | `get_br_market_data` |
| `research-dropped-feature`（2） | 绑定本部署不运行的功能：pixel-office 任务板（UI/swarm 协调面，还会写本地任务库）与实盘 mandate 提议流程（这里没有下单路径，没有消费者）。 | `pixel_office`、`propose_mandate_profiles` |
| `research-overlap`（1） | alpha_compare 只做多个 alpha 的横向排名；已暴露的 alpha_bench 支持单 alpha 或整 zoo 并给 IC/IR，只差多 alpha 排名的便利。 | `alpha_compare` |

## 7. 未发布（dropped / excluded / 上游没有）

| 类别 | 原因 | 工具（数量） |
|---|---|---|
| `swarm`（7） | VT 的嵌套多 agent 运行由 DSH subagent 取代；它们还需要自己的 LLM key 和 per-session 绑定。 | `run_swarm`、`list_swarm_presets`（worker 未注册）、`get_swarm_status`（worker 未注册）、`get_run_result`（worker 未注册）、`list_runs`（worker 未注册）、`retry_run`（worker 未注册）、`reap_stale_runs`（worker 未注册） |
| `mcp-facade`（3） | MCP 包装名，对应的 registry 名已直接暴露（pattern / options_pricing / options_payoff）；保留包装名只为与上游 MCP 面对齐，worker 仍会列出它们。 | `pattern_recognition`、`analyze_options`、`analyze_options_payoff` |
| `excluded`（3） | 上游 MCP surface 之外的可选工具，本插件不接（D9）；worker 也不会注册 | `qveris_search`、`qveris_inspect`、`qveris_execute` |

上游 MCP 有、worker 没有（7 个）：

| 工具 | 原因 |
|---|---|
| `get_run_result` | swarm |
| `get_swarm_status` | swarm |
| `list_runs` | swarm |
| `list_skills` | 网关替代（`vt_list_skills` / `vt_load_skill`） |
| `list_swarm_presets` | swarm |
| `reap_stale_runs` | swarm |
| `retry_run` | swarm |

## 8. 升级 Vibe-Trading 时怎么维护

| 步骤 | 做什么 | 检查点 |
|---|---|---|
| 1 | 按 skill `vt-version-pin` 升级 `PINNED_VERSION` / `_vendor` tag / `pyproject.toml` / `uv.lock` / venv | 版本固定点一致 |
| 2 | `node scripts/validate/check_pin.mjs` | 0 FAIL |
| 3 | `pnpm capture:surface` 重新抓 worker 面 | `scripts/validate/worker-surface.json` 更新 |
| 4 | `pnpm docs:tools` 重新生成本文件，**看 diff** | 新工具：决定进组 / 进 hidden 配理由 / 进 dropped；消失的工具：`check_manifest` 报 hidden 文档失效；改名：报 duplicate/unknown |
| 5 | `pnpm check:tools` + `check_manifest.mjs` + `pnpm verify` | 全绿 |
| 6 | 名字对齐原则 | 优先跟 VT agent 内部 registry 名（技能文档按这些名字写）；MCP wrapper 名只做 `prompt/bridge.md` 映射，不进目录 |
