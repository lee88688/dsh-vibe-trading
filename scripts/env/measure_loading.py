#!/usr/bin/env python3
"""Quantify Vibe-Trading's deferred tool loading and progressive skill disclosure.

Read-only measurement harness: imports the *installed* vibe-trading-ai package,
builds the real tool registry, and writes every schema/catalog/skill size to
scripts/env/loading-metrics.json.  Nothing outside scripts/env/ is written.

Usage:
  uv run python scripts\\env\\measure_loading.py
"""

from __future__ import annotations

import json
import os
import re
import statistics
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "scripts" / "env" / "loading-metrics.json"
CHARS_PER_TOKEN = 4  # src/agent/loop.py:122-131 estimate_tokens()
CATALOG_HINT_CHARS = 80  # src/agent/tool_loading.json catalog_description_chars

# --- domain taxonomy -------------------------------------------------------
# Names are the agent-registry tool names the auto-discovery produces. Anything
# not listed falls back to prefix rules, then to "other" (reported explicitly).
DOMAIN_BY_NAME: dict[str, str] = {}


def _add(domain: str, names: str) -> None:
    for n in names.split():
        DOMAIN_BY_NAME[n] = domain


_add("skills", "load_skill list_skills save_skill patch_skill delete_skill skill_file")
_add("goals", "start_research_goal get_research_goal add_goal_evidence update_research_goal "
              "update_research_goal_status")
_add("hypothesis", "create_hypothesis update_hypothesis link_backtest link_autopilot_backtest "
                   "search_hypotheses")
_add("market-data", """
get_market_data get_fund_flow get_dragon_tiger get_northbound_flow get_southbound_flow
get_margin_trading get_block_trades get_shareholder_count get_lockup_expiry get_sector_info
get_research_reports get_stock_news get_sec_filings get_financial_statements get_options_chain
get_stock_profile screen_market search_symbol get_macro_series get_fund_nav get_cn_macro_series
get_cn_announcements search_broker_reports iwencai_search get_institutional_holdings etf_holdings
prediction_market research_papers get_fundamentals get_br_market_data get_taiwan_stock_data
gildata_fin_query gildata_stock_selection
""")
_add("analytics", """
quantlib_call cashflow_performance orderbook_depth sentiment technical_indicators financial_rigor
factor_analysis alpha_zoo alpha_bench alpha_compare pattern pattern_recognition options_pricing
options_payoff analyze_options analyze_options_payoff portfolio_summary portfolio_risk_xray
report_audit
""")
_add("backtest-strategy", """
backtest list_backtest_runs read_run_artifact generate_backtest_config scaffold_signal_engine
run_research_autopilot sdm_register sdm_status sdm_decay_scan list_strategies query_strategies
get_strategy_evidence refresh_strategy_evidence adapt_strategy scheduled_research
""")
_add("swarm", "list_swarm_presets run_swarm")
_add("runs", "list_runs get_run_result get_swarm_status reap_stale_runs retry_run")
_add("shadow-journal", """
analyze_trade_journal extract_shadow_strategy run_shadow_backtest render_shadow_report
scan_shadow_signals paper_trade_step
""")
_add("io-web", """
read_file write_file edit_file read_url read_document web_search read_research_artifact
save_research_artifact search_research_artifacts get_research_artifact analyze_image pixel_office
""")
_add("memory-session", "remember session_search compact")
_add("shell", "bash background_run check_background cancel_background")
_add("trading", "propose_mandate_profiles")


def domain_of(name: str) -> str:
    if name in DOMAIN_BY_NAME:
        return DOMAIN_BY_NAME[name]
    if name.startswith(("trading_", "etoro_")):
        return "trading"
    if name.startswith("gildata_"):
        return "market-data"
    return "other"


def jchars(obj: object) -> int:
    return len(json.dumps(obj, ensure_ascii=False))


def main() -> int:
    # Keep runtime state inside the repo; never read/write ~/.vibe-trading.
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from env_common import vibe_home

    vibe_home()
    os.environ.setdefault("PYTHONUTF8", "1")

    t_import = time.perf_counter()
    from src.agent.skills import SkillsLoader
    from src.agent.tool_loading import (
        DeferredToolRegistry,
        LoadToolsTool,
        loading_policy,
        prepare_registry,
    )
    from src.config.limits import TOOL_RESULT_LIMIT
    from src.tools import build_registry

    import importlib.metadata as md

    t_import_done = time.perf_counter()

    t_build = time.perf_counter()
    registry = build_registry()  # agent registry, shell tools OFF (matches MCP server default)
    t_build_done = time.perf_counter()

    tools: list[dict] = []
    for name, tool in registry._tools.items():
        schema = tool.to_openai_schema()
        desc = tool.description or ""
        tools.append(
            {
                "name": name,
                "domain": domain_of(name),
                "readonly": bool(getattr(tool, "is_readonly", True)),
                "schema_chars": jchars(schema),
                "function_chars": jchars(schema.get("function", {})),
                "description_chars": len(desc),
                "param_count": len(((tool.parameters or {}).get("properties") or {})),
                "schema": schema,
            }
        )
    tools.sort(key=lambda t: t["schema_chars"], reverse=True)

    # --- deferred exposure -------------------------------------------------
    policy = loading_policy()
    deferred = prepare_registry(registry)
    is_deferred = isinstance(deferred, DeferredToolRegistry)
    initial_defs = deferred.request_definitions() if is_deferred else registry.get_definitions()
    initial_names = list(getattr(deferred, "_loaded", {}).keys())
    catalog = deferred.catalog() if is_deferred else ""
    catalog_lines = catalog.splitlines() if catalog else []
    load_tools_schema = LoadToolsTool(registry).to_openai_schema() if is_deferred else None

    eager_chars = jchars([t["schema"] for t in tools])
    initial_chars = jchars(initial_defs)

    by_domain: dict[str, dict] = {}
    for t in tools:
        d = by_domain.setdefault(
            t["domain"],
            {"tools": 0, "schema_chars": 0, "max_tool": "", "max_chars": 0},
        )
        d["tools"] += 1
        d["schema_chars"] += t["schema_chars"]
        if t["schema_chars"] > d["max_chars"]:
            d["max_chars"] = t["schema_chars"]
            d["max_tool"] = t["name"]

    # --- skills ------------------------------------------------------------
    loader = SkillsLoader()
    skills = []
    for s in loader.skills:
        wrapped = f'<skill name="{s.name}">\n{s.body}\n</skill>'
        skills.append(
            {
                "name": s.name,
                "category": s.category,
                "body_chars": len(s.body),
                "wrapped_chars": len(wrapped),
                "description_chars": len(s.description or ""),
                "sections": _count_sections(s.body),
            }
        )
    skills.sort(key=lambda s: s["body_chars"], reverse=True)
    skill_descriptions = loader.get_descriptions()

    # --- tool <-> skill co-occurrence (bundle topology evidence) -----------
    bodies = {s.name: s.body for s in loader.skills}
    mentions: dict[str, list[str]] = {}
    name_re_cache: dict[str, re.Pattern] = {}
    for t in tools:
        name = t["name"]
        if name in {"bash", "compact"}:
            continue
        pat = name_re_cache.setdefault(name, re.compile(rf"(?<![\w-]){re.escape(name)}(?![\w-])"))
        hits = [sk for sk, body in bodies.items() if pat.search(body)]
        if hits:
            mentions[name] = sorted(hits)

    report = {
        "meta": {
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "package_version": md.version("vibe-trading-ai"),
            "python": sys.version.split()[0],
            "vibe_trading_home": os.environ["VIBE_TRADING_HOME"],
            "chars_per_token": CHARS_PER_TOKEN,
            "tool_result_limit": TOOL_RESULT_LIMIT,
            "import_sec": round(t_import_done - t_import, 2),
            "registry_build_sec": round(t_build_done - t_build, 2),
            "registry_tool_count": len(registry),
            "import_failures": dict(getattr(registry, "import_failures", {}) or {}),
            "registration_failures": dict(getattr(registry, "registration_failures", {}) or {}),
        },
        "deferred_loading": {
            "policy": policy,
            "is_deferred": is_deferred,
            "initial_tool_names": initial_names,
            "initial_tools_missing_from_registry": [
                n for n in policy["initial_tools"] if n not in registry._tools
            ],
            "initial_schema_chars": initial_chars,
            "initial_schema_tokens": initial_chars // CHARS_PER_TOKEN,
            "load_tools_schema_chars": jchars(load_tools_schema) if load_tools_schema else 0,
            "eager_all_schema_chars": eager_chars,
            "eager_all_schema_tokens": eager_chars // CHARS_PER_TOKEN,
            "catalog_chars": len(catalog),
            "catalog_tokens": len(catalog) // CHARS_PER_TOKEN,
            "catalog_lines": len(catalog_lines),
            "catalog_line_stats": {
                "min": min((len(x) for x in catalog_lines), default=0),
                "mean": round(statistics.mean([len(x) for x in catalog_lines]), 1) if catalog_lines else 0,
                "max": max((len(x) for x in catalog_lines), default=0),
            },
            "per_request_overhead_chars": initial_chars + len(catalog),
            "per_request_overhead_tokens": (initial_chars + len(catalog)) // CHARS_PER_TOKEN,
        },
        "domains": by_domain,
        "tools": tools,
        "skills": {
            "count": len(skills),
            "descriptions_chars": len(skill_descriptions),
            "descriptions_tokens": len(skill_descriptions) // CHARS_PER_TOKEN,
            "descriptions_lines": len(skill_descriptions.splitlines()),
            "body_total_chars": sum(s["body_chars"] for s in skills),
            "body_min_chars": min((s["body_chars"] for s in skills), default=0),
            "body_mean_chars": round(statistics.mean([s["body_chars"] for s in skills]), 1) if skills else 0,
            "body_median_chars": round(statistics.median([s["body_chars"] for s in skills]), 1) if skills else 0,
            "body_max_chars": max((s["body_chars"] for s in skills), default=0),
            "over_tool_result_limit": sum(1 for s in skills if s["wrapped_chars"] > TOOL_RESULT_LIMIT),
            "per_skill": skills,
            "category_totals": _category_totals(skills),
        },
        "tool_skill_mentions": mentions,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    # --- stdout summary ----------------------------------------------------
    dl = report["deferred_loading"]
    sk = report["skills"]
    print(f"package={report['meta']['package_version']} python={report['meta']['python']}")
    print(f"tools={len(tools)} import={report['meta']['import_sec']}s build={report['meta']['registry_build_sec']}s")
    print(f"eager all schemas: {dl['eager_all_schema_chars']:,} chars = {dl['eager_all_schema_tokens']:,} tok")
    print(f"initial({len(initial_names)}): {dl['initial_schema_chars']:,} chars = {dl['initial_schema_tokens']:,} tok")
    print(f"catalog: {dl['catalog_chars']:,} chars = {dl['catalog_tokens']:,} tok over {dl['catalog_lines']} lines")
    print(f"load_tools schema: {dl['load_tools_schema_chars']:,} chars")
    print(f"per-request deferred overhead: {dl['per_request_overhead_chars']:,} chars = "
          f"{dl['per_request_overhead_tokens']:,} tok")
    print(f"skills={sk['count']} bodies={sk['body_total_chars']:,} chars "
          f"min/mean/med/max={sk['body_min_chars']}/{sk['body_mean_chars']}/{sk['body_median_chars']}/{sk['body_max_chars']}")
    print(f"skill catalog: {sk['descriptions_chars']:,} chars = {sk['descriptions_tokens']:,} tok")
    print(f"skills over one tool result ({TOOL_RESULT_LIMIT}): {sk['over_tool_result_limit']}")
    print("\nTop 10 schemas:")
    for t in tools[:10]:
        print(f"  {t['schema_chars']:>6,}  {t['name']} ({t['domain']})")
    print("\nBottom 10 schemas:")
    for t in tools[-10:]:
        print(f"  {t['schema_chars']:>6,}  {t['name']} ({t['domain']})")
    print("\nBy domain:")
    for d, v in sorted(by_domain.items(), key=lambda kv: kv[1]["schema_chars"], reverse=True):
        print(f"  {d:<18} tools={v['tools']:>3}  {v['schema_chars']:>7,} chars  "
              f"({v['schema_chars'] // CHARS_PER_TOKEN:>6,} tok)  biggest={v['max_tool']}")
    unknown = [t["name"] for t in tools if t["domain"] == "other"]
    if unknown:
        print(f"\nunclassified: {unknown}")
    print(f"\nwrote {OUT}")
    return 0


def _count_sections(body: str) -> int:
    return sum(1 for line in body.splitlines() if re.match(r"^#{1,6}\s", line))


def _category_totals(skills: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for s in skills:
        c = out.setdefault(s["category"], {"count": 0, "body_chars": 0})
        c["count"] += 1
        c["body_chars"] += s["body_chars"]
    return dict(sorted(out.items(), key=lambda kv: kv[1]["body_chars"], reverse=True))


if __name__ == "__main__":
    raise SystemExit(main())
