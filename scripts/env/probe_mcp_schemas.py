#!/usr/bin/env python3
"""Capture the exact tools/list payload of the installed Vibe-Trading MCP server.

Writes scripts/env/mcp-schemas.json with the full name/description/inputSchema
for every MCP tool, plus per-tool and per-domain byte sizes. This is the payload
a DSH `@deepseek-ai/dsh-mcp-client` registration would receive.

Usage:
  uv run python scripts\\env\\probe_mcp_schemas.py
"""

from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

SCRIPTS_ENV = Path(__file__).resolve().parent
REPO = SCRIPTS_ENV.parents[1]
OUT = SCRIPTS_ENV / "mcp-schemas.json"

sys.path.insert(0, str(SCRIPTS_ENV))
from env_common import mcp_exe, vibe_home  # noqa: E402
from mcp_handshake import StdioMCPClient  # noqa: E402

CHARS_PER_TOKEN = 4

# MCP-domain taxonomy (mirrors guides/mcp.md overlapping the agent registry).
DOMAINS: dict[str, list[str]] = {
    "skills": ["list_skills", "load_skill"],
    "goals": [
        "start_research_goal",
        "get_research_goal",
        "add_goal_evidence",
        "update_research_goal",
        "update_research_goal_status",
    ],
    "backtest-quant": [
        "backtest",
        "factor_analysis",
        "alpha_zoo",
        "alpha_bench",
        "analyze_options",
        "analyze_options_payoff",
        "pattern_recognition",
        "paper_trade_step",
        "quantlib_call",
        "cashflow_performance",
    ],
    "strategy": [
        "list_strategies",
        "query_strategies",
        "get_strategy_evidence",
        "refresh_strategy_evidence",
        "adapt_strategy",
        "list_backtest_runs",
    ],
    "market-data": [
        "get_market_data",
        "get_fund_flow",
        "get_dragon_tiger",
        "get_northbound_flow",
        "get_southbound_flow",
        "get_margin_trading",
        "get_block_trades",
        "get_shareholder_count",
        "get_lockup_expiry",
        "get_sector_info",
        "get_research_reports",
        "get_stock_news",
        "get_sec_filings",
        "get_financial_statements",
        "get_options_chain",
        "get_stock_profile",
        "screen_market",
        "search_symbol",
        "get_macro_series",
        "get_fund_nav",
        "get_cn_macro_series",
        "get_cn_announcements",
        "search_broker_reports",
        "iwencai_search",
        "get_institutional_holdings",
        "etf_holdings",
        "prediction_market",
        "research_papers",
        "sentiment",
        "technical_indicators",
        "orderbook_depth",
        "get_fundamentals",
    ],
    "files-web": ["read_url", "read_document", "web_search", "write_file", "read_file", "read_run_artifact"],
    "swarm": [
        "list_swarm_presets",
        "run_swarm",
        "get_swarm_status",
        "get_run_result",
        "list_runs",
        "reap_stale_runs",
        "retry_run",
    ],
    "shadow-journal": [
        "analyze_trade_journal",
        "extract_shadow_strategy",
        "run_shadow_backtest",
        "render_shadow_report",
        "scan_shadow_signals",
    ],
    "trading-reads": [
        "trading_connections",
        "trading_select_connection",
        "trading_check",
        "trading_account",
        "trading_positions",
        "trading_orders",
        "trading_quote",
        "trading_history",
    ],
}
NAME_TO_DOMAIN = {n: d for d, names in DOMAINS.items() for n in names}


def jchars(obj: object) -> int:
    return len(json.dumps(obj, ensure_ascii=False))


def main() -> int:
    exe = mcp_exe()
    if not exe.exists():
        print(f"missing {exe}", file=sys.stderr)
        return 2

    env = dict(os.environ)
    env.update(
        {
            "VIBE_TRADING_HOME": str(vibe_home()),
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
        }
    )
    for k in (
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "DEEPSEEK_API_KEY",
        "TUSHARE_TOKEN",
        "FRED_API_KEY",
        "TIINGO_API_KEY",
        "ALPHAVANTAGE_API_KEY",
        "FINNHUB_API_KEY",
        "FMP_API_KEY",
    ):
        env[k] = ""

    t0 = time.perf_counter()
    client = StdioMCPClient([str(exe)], env=env, cwd=str(REPO))
    tools: list[dict] = []
    try:
        init = client.request(
            "initialize",
            {
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": {"name": "dsh-vibe-trading-probe", "version": "0.1"},
            },
            timeout=180.0,
        )
        client.notify("notifications/initialized")
        cursor = None
        while True:
            params = {"cursor": cursor} if cursor else {}
            page = client.request("tools/list", params, timeout=120.0)
            result = page.get("result") or {}
            tools.extend(result.get("tools") or [])
            cursor = result.get("nextCursor")
            if not cursor:
                break
    finally:
        client.close()

    rows = []
    for t in tools:
        row = {
            "name": t.get("name"),
            "domain": NAME_TO_DOMAIN.get(t.get("name", ""), "other"),
            "description": t.get("description") or "",
            "input_schema": t.get("inputSchema") or {},
            "description_chars": len(t.get("description") or ""),
            "schema_chars": jchars(t.get("inputSchema") or {}),
            "full_chars": jchars(t),
            "param_count": len((t.get("inputSchema") or {}).get("properties") or {}),
        }
        rows.append(row)
    rows.sort(key=lambda r: r["full_chars"], reverse=True)

    by_domain: dict[str, dict] = {}
    for r in rows:
        d = by_domain.setdefault(r["domain"], {"tools": 0, "full_chars": 0, "max_tool": "", "max_chars": 0})
        d["tools"] += 1
        d["full_chars"] += r["full_chars"]
        if r["full_chars"] > d["max_chars"]:
            d["max_chars"] = r["full_chars"]
            d["max_tool"] = r["name"]

    payload = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "exe": str(exe),
        "startup_and_list_sec": round(time.perf_counter() - t0, 2),
        "server_info": (init.get("result") or {}).get("serverInfo"),
        "protocol": (init.get("result") or {}).get("protocolVersion"),
        "tool_count": len(rows),
        "total_full_chars": sum(r["full_chars"] for r in rows),
        "total_full_tokens": sum(r["full_chars"] for r in rows) // CHARS_PER_TOKEN,
        "total_description_chars": sum(r["description_chars"] for r in rows),
        "total_schema_chars": sum(r["schema_chars"] for r in rows),
        "by_domain": by_domain,
        "tools": rows,
        "stderr_lines": client.stderr_lines,
    }
    OUT.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"server={payload['server_info']} protocol={payload['protocol']}")
    print(f"tools={len(rows)} total={payload['total_full_chars']:,} chars = "
          f"{payload['total_full_tokens']:,} tok (in {payload['startup_and_list_sec']}s)")
    print(f"descriptions={payload['total_description_chars']:,} chars, "
          f"inputSchemas={payload['total_schema_chars']:,} chars")
    print("\nTop 10:")
    for r in rows[:10]:
        print(f"  {r['full_chars']:>6,}  {r['name']} ({r['domain']})")
    print("\nBottom 10:")
    for r in rows[-10:]:
        print(f"  {r['full_chars']:>6,}  {r['name']} ({r['domain']})")
    print("\nBy domain:")
    for d, v in sorted(by_domain.items(), key=lambda kv: kv[1]["full_chars"], reverse=True):
        print(f"  {d:<15} n={v['tools']:>2} {v['full_chars']:>7,} chars "
              f"({v['full_chars'] // CHARS_PER_TOKEN:>5,} tok) biggest={v['max_tool']}")
    other = [r["name"] for r in rows if r["domain"] == "other"]
    if other:
        print(f"\nunclassified: {other}")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
