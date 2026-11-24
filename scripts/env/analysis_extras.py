#!/usr/bin/env python3
"""Workflow-level minimal tool sets, skill->tool reference integrity, and a
signature-only (PTC SDK) size estimate. Reads the measured artifacts.

Usage:
  uv run python scripts\\env\\analysis_extras.py
"""

from __future__ import annotations

import json
from pathlib import Path

ENV = Path(__file__).resolve().parent
CPT = 4

mcp = json.loads((ENV / "mcp-schemas.json").read_text(encoding="utf-8"))
metrics = json.loads((ENV / "loading-metrics.json").read_text(encoding="utf-8"))
mcp_by = {t["name"]: t for t in mcp["tools"]}
skills = {s["name"]: s for s in metrics["skills"]["per_skill"]}
mentions = metrics["tool_skill_mentions"]  # tool -> [skill]

WORKFLOWS: dict[str, dict] = {
    "W1 identity->data->backtest->attribution": {
        "tools": ["search_symbol", "get_market_data", "get_fundamentals", "backtest",
                  "read_run_artifact"],
        "skills": ["strategy-generate", "backtest-diagnose", "performance-attribution",
                   "correlation-analysis", "data-routing"],
        "note": "write_file/write are DSH-native; run_dir must sit in an allowed run root",
    },
    "W2 company deep research": {
        "tools": ["search_symbol", "get_market_data", "get_fundamentals",
                  "get_financial_statements", "get_sec_filings", "get_stock_news",
                  "get_research_reports", "get_stock_profile", "get_sector_info",
                  "get_institutional_holdings", "etf_holdings", "get_fund_flow",
                  "get_dragon_tiger", "get_shareholder_count"],
        "skills": ["deep-company-series", "financial-statement", "valuation-model",
                   "management-deep-dive", "earnings-forecast", "investor-lenses",
                   "research-discipline"],
        "note": "",
    },
    "W3 macro / capital flows / screening": {
        "tools": ["get_macro_series", "get_cn_macro_series", "get_cn_announcements",
                  "get_northbound_flow", "get_southbound_flow", "get_margin_trading",
                  "get_block_trades", "get_lockup_expiry", "search_broker_reports",
                  "iwencai_search", "screen_market"],
        "skills": ["macro-analysis", "global-macro", "sector-rotation", "hk-connect-flow",
                   "us-etf-flow", "sentiment-analysis"],
        "note": "key-gated: FRED_API_KEY, GILDATA_TOKEN, VIBE_TRADING_IWENCAI_KEY",
    },
    "W4 options / risk / technicals": {
        "tools": ["get_options_chain", "analyze_options", "analyze_options_payoff",
                  "quantlib_call", "technical_indicators", "cashflow_performance",
                  "orderbook_depth", "sentiment", "pattern_recognition"],
        "skills": ["options-strategy", "options-payoff", "options-advanced",
                   "risk-analysis", "technical-basic", "market-microstructure"],
        "note": "",
    },
    "W5 factor / alpha / strategy registry": {
        "tools": ["factor_analysis", "alpha_zoo", "alpha_bench", "backtest",
                  "list_strategies", "query_strategies", "get_strategy_evidence",
                  "refresh_strategy_evidence", "adapt_strategy"],
        "skills": ["factor-research", "alpha-zoo", "strategy-discovery",
                   "strategy-dev-manager", "multi-factor"],
        "note": "",
    },
    "W6 swarm teams": {
        "tools": ["list_swarm_presets", "run_swarm", "get_swarm_status",
                  "get_run_result", "list_runs", "retry_run", "reap_stale_runs"],
        "skills": ["private-company-research"],
        "note": "run_swarm spawns its own LLM loop: needs provider keys; 3600 s wait",
    },
    "W7 journal / shadow account": {
        "tools": ["analyze_trade_journal", "extract_shadow_strategy",
                  "run_shadow_backtest", "render_shadow_report", "scan_shadow_signals"],
        "skills": ["shadow-account", "trade-journal", "report-generate"],
        "note": "analyze_trade_journal reads under VIBE_TRADING_ALLOWED_FILE_ROOTS",
    },
    "W8 research goals": {
        "tools": ["start_research_goal", "get_research_goal", "add_goal_evidence",
                  "update_research_goal_status"],
        "skills": ["research-goal"],
        "note": "0.1.18 does not expose update_research_goal as an MCP tool",
    },
    "W9 broker reads (optional)": {
        "tools": ["trading_connections", "trading_account", "trading_positions",
                  "trading_orders", "trading_quote", "trading_history"],
        "skills": [],
        "note": "requires an authorized connector profile",
    },
}

DSH_NATIVE = {
    "read_file": "read",
    "write_file": "write",
    "edit_file": "edit",
    "bash": "pwsh/bash",
    "read_url": "web_fetch",
    "web_search": "web_search",
    "analyze_image": "read_image",
    "read_document": "(no native PDF/OCR equivalent)",
}

print("=== workflow minimal sets (MCP 0.1.18) ===")
hdr = f"{'workflow':<44}{'tools':>6}{'chars':>9}{'tok':>7}{'skills':>7}{'skillchars':>11}"
print(hdr)
print("-" * len(hdr))
missing_names: dict[str, int] = {}
for name, wf in WORKFLOWS.items():
    unknown = [t for t in wf["tools"] if t not in mcp_by]
    for u in unknown:
        missing_names.setdefault(u, 0)
    rows = [mcp_by[t] for t in wf["tools"] if t in mcp_by]
    chars = sum(r["full_chars"] for r in rows)
    sk = [skills[s] for s in wf["skills"] if s in skills]
    print(f"{name:<44}{len(rows):>6}{chars:>9,}{chars // CPT:>7,}{len(sk):>7}"
          f"{sum(s['body_chars'] for s in sk):>11,}")
if missing_names:
    print(f"\nnames not in the 0.1.18 MCP surface: {sorted(missing_names)}")

# --- Skill -> tool reference integrity ------------------------------------
print("\n=== skill -> tool references under the DSH+MCP setup ===")
by_class: dict[str, int] = {"mcp": 0, "dsh-native": 0, "missing": 0}
missing_tools: dict[str, int] = {}
skills_with_missing: dict[str, list[str]] = {}
for tool, sk_names in sorted(mentions.items()):
    if tool in mcp_by:
        by_class["mcp"] += len(sk_names)
    elif tool in DSH_NATIVE:
        by_class["dsh-native"] += len(sk_names)
    else:
        by_class["missing"] += len(sk_names)
        missing_tools[tool] = len(sk_names)
        for s in sk_names:
            skills_with_missing.setdefault(s, []).append(tool)
total = sum(by_class.values())
print(f"distinct tool names referenced by skills: {len(mentions)}")
for k, v in by_class.items():
    print(f"  {k:<12} {v:>4} references ({100 * v / total:.0f}%)")
print(f"\nskills containing at least one dangling reference: {len(skills_with_missing)} / {len(skills)}")
print(f"references with no MCP or DSH-native home: {by_class['missing']}")
print("\ntop dangling tools (references):")
for t, n in sorted(missing_tools.items(), key=lambda kv: -kv[1])[:14]:
    home = DSH_NATIVE.get(t, "-")
    print(f"  {n:>3}  {t:<28} dsh-native={home}")

# --- signature-only estimate (PTC SDK style) -------------------------------
print("\n=== signature-only (PTC SDK) estimate, all 82 MCP tools ===")
sig = 0
for name, t in mcp_by.items():
    props = list((t["input_schema"].get("properties") or {}).keys())
    required = set(t["input_schema"].get("required") or [])
    args = ", ".join(f"{p}{'' if p in required else '?'}" for p in props)
    sig += len(name) + len(args) + 6  # "name(args)\n"
print(f"declaration-only chars: {sig:,} = {sig // CPT:,} tok "
      f"(vs {mcp['total_full_chars']:,} chars / {mcp['total_full_tokens']:,} tok for full schemas)")

# --- VT catalog equivalent -------------------------------------------------
cat = sum(len(n) + 2 + min(len(t["description"]), 80) for n, t in mcp_by.items())
print(f"Vibe-Trading-style catalog (name + 80-char hint) for all 82: {cat:,} chars = {cat // CPT:,} tok")
