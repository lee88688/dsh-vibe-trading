#!/usr/bin/env python3
"""Cost the proposed DSH tool/skill bundles from measured artifacts.

Reads scripts/env/mcp-schemas.json (real MCP tools/list payload),
scripts/env/loading-metrics.json (agent registry + skill sizes) and
scripts/env/bundles.json (proposed partition); writes bundle-costs.json.

Usage:
  uv run python scripts\\env\\bundle_costs.py
"""

from __future__ import annotations

import json
from pathlib import Path

ENV = Path(__file__).resolve().parent
CHARS_PER_TOKEN = 4
DSH_SKILL_CATALOG_CAP = 500  # @deepseek-ai/dsh-tool-skill catalogDescriptionMaxLength default
DSH_PRUNE_THRESHOLD = 8192  # @deepseek-ai/dsh-compaction-tool-result-pruner thresholdChars default

mcp = json.loads((ENV / "mcp-schemas.json").read_text(encoding="utf-8"))
metrics = json.loads((ENV / "loading-metrics.json").read_text(encoding="utf-8"))
bundles = json.loads((ENV / "bundles.json").read_text(encoding="utf-8"))

mcp_by_name = {t["name"]: t for t in mcp["tools"]}
skills_by_name = {s["name"]: s for s in metrics["skills"]["per_skill"]}
excluded = set(bundles.get("excluded", {}).get("tools", []))


def tool_row(name: str) -> dict:
    t = mcp_by_name[name]
    return {
        "name": name,
        "domain": t["domain"],
        "full_chars": t["full_chars"],
        "hint_chars": len(name) + 2 + min(len(t["description"]), 80),  # "- name: hint"
    }


def skill_row(name: str) -> dict:
    s = skills_by_name[name]
    return {
        "name": name,
        "category": s["category"],
        "body_chars": s["body_chars"],
        "catalog_chars": min(s["description_chars"], DSH_SKILL_CATALOG_CAP),
        "over_prune_threshold": s["wrapped_chars"] > DSH_PRUNE_THRESHOLD,
    }


report: dict = {
    "meta": {
        "chars_per_token": CHARS_PER_TOKEN,
        "dsh_skill_catalog_cap": DSH_SKILL_CATALOG_CAP,
        "dsh_prune_threshold": DSH_PRUNE_THRESHOLD,
        "mcp_tool_count": len(mcp_by_name),
        "mcp_all_full_chars": mcp["total_full_chars"],
    },
    "bundles": [],
    "warnings": [],
}

seen: set[str] = set()
for b in bundles["bundles"]:
    unknown_tools = [n for n in b["tools"] if n not in mcp_by_name]
    unknown_skills = [n for n in b["skills"] if n not in skills_by_name]
    for n in unknown_tools:
        report["warnings"].append(f"{b['id']}: unknown MCP tool {n!r}")
    for n in unknown_skills:
        report["warnings"].append(f"{b['id']}: unknown skill {n!r}")
    tools = [tool_row(n) for n in b["tools"] if n in mcp_by_name]
    skills = [skill_row(n) for n in b["skills"] if n in skills_by_name]
    dupes = [t["name"] for t in tools if t["name"] in seen]
    seen.update(t["name"] for t in tools)
    full = sum(t["full_chars"] for t in tools)
    hints = sum(t["hint_chars"] for t in tools)
    report["bundles"].append(
        {
            "id": b["id"],
            "title": b["title"],
            "tool_count": len(tools),
            "tool_full_chars": full,
            "tool_full_tokens": full // CHARS_PER_TOKEN,
            "tool_catalog_chars": hints,
            "tool_catalog_tokens": hints // CHARS_PER_TOKEN,
            "skills": len(skills),
            "skill_body_chars": sum(s["body_chars"] for s in skills),
            "skill_catalog_chars": sum(s["catalog_chars"] for s in skills),
            "skill_catalog_tokens": sum(s["catalog_chars"] for s in skills) // CHARS_PER_TOKEN,
            "skills_over_prune_threshold": sum(1 for s in skills if s["over_prune_threshold"]),
            "biggest_tool": max(tools, key=lambda t: t["full_chars"])["name"] if tools else None,
            "duplicate_of_earlier_bundle": dupes,
            "unknown_tools": unknown_tools,
            "unknown_skills": unknown_skills,
        }
    )

covered = seen
report["coverage"] = {
    "tools_in_bundles": len(covered),
    "mcp_tools_total": len(mcp_by_name),
    "unassigned_tools": sorted(set(mcp_by_name) - covered),
    "excluded_by_policy": sorted(excluded),
    "overlap_tools": sorted(t for t in covered if t in excluded),
}

# What a "deferred" registration would cost if DSH could hide schemas and show a
# catalog instead: name + 80-char hint for all assigned tools.
all_catalog = sum(
    len(n) + 2 + min(len(mcp_by_name[n]["description"]), 80) for n in sorted(covered)
)
report["catalog_mode"] = {
    "tools": len(covered),
    "catalog_chars": all_catalog,
    "catalog_tokens": all_catalog // CHARS_PER_TOKEN,
    "vs_all_schemas_tokens": mcp["total_full_tokens"],
    "saving_pct": round(100 * (1 - (all_catalog // CHARS_PER_TOKEN) / mcp["total_full_tokens"]), 1),
}

(ENV / "bundle-costs.json").write_text(
    json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
)

print(f"chars/token={CHARS_PER_TOKEN}  skills catalog cap={DSH_SKILL_CATALOG_CAP}")
print(f"MCP all 82 tools: {mcp['total_full_chars']:,} chars = {mcp['total_full_tokens']:,} tok\n")
hdr = f"{'bundle':<14}{'tools':>6}{'tool chars':>12}{'tok':>8}{'cat chars':>11}{'tok':>7}{'skills':>7}{'skill bodies':>13}{'skill cat':>10}"
print(hdr)
print("-" * len(hdr))
for b in report["bundles"]:
    print(
        f"{b['id']:<14}{b['tool_count']:>6}{b['tool_full_chars']:>12,}{b['tool_full_tokens']:>8,}"
        f"{b['tool_catalog_chars']:>11,}{b['tool_catalog_tokens']:>7,}{b['skills']:>7}"
        f"{b['skill_body_chars']:>13,}{b['skill_catalog_chars']:>10,}"
    )
print("-" * len(hdr))
print(f"\ncoverage: {len(covered)}/{len(mcp_by_name)} MCP tools assigned")
print(f"unassigned: {report['coverage']['unassigned_tools']}")
print(f"duplicates across bundles: "
      f"{[ (b['id'], b['duplicate_of_earlier_bundle']) for b in report['bundles'] if b['duplicate_of_earlier_bundle'] ]}")
print(f"\ncatalog-mode (name+hint only) for {len(covered)} tools: "
      f"{all_catalog:,} chars = {all_catalog // CHARS_PER_TOKEN:,} tok "
      f"(-{report['catalog_mode']['saving_pct']}% vs all schemas)")
if report["warnings"]:
    print("\nwarnings:")
    for w in report["warnings"]:
        print("  " + w)
print(f"\nwrote {ENV / 'bundle-costs.json'}")
