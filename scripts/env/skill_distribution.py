#!/usr/bin/env python3
"""Skill size distribution + progressive-disclosure evidence (stdout only)."""

from __future__ import annotations

import json
from pathlib import Path

ENV = Path(__file__).resolve().parent
m = json.loads((ENV / "loading-metrics.json").read_text(encoding="utf-8"))
ps = m["skills"]["per_skill"]
big_threshold = 8192

print("body-char buckets (wrapped body = <skill name=...> envelope):")
buckets = [(0, 2000), (2000, 5000), (5000, 8192), (8192, 10000), (10000, 20000),
           (20000, 50000), (50000, 10 ** 12)]
for lo, hi in buckets:
    n = [s for s in ps if lo <= s["body_chars"] < hi]
    label = f"{lo:,}-{hi:,}" if hi < 10 ** 12 else f"{lo:,}+"
    print(f"  {label:>15}: {len(n):>2} skills  {sum(x['body_chars'] for x in n):>9,} chars")

print("\ntop 12 by body chars (chars, sections, name):")
for s in ps[:12]:
    print(f"  {s['body_chars']:>7,}  sections={s['sections']:>2}  {s['name']}")

over = [s for s in ps if s["wrapped_chars"] > big_threshold]
print(f"\nskills whose one-shot body exceeds the DSH pruner threshold ({big_threshold}): {len(over)}")
print(f"their body total: {sum(s['body_chars'] for s in over):,} chars "
      f"({sum(s['body_chars'] for s in over) // 4:,} tok if all loaded in one session)")

big = [s for s in ps if s["body_chars"] > 10000]
print(f"\nskills >10k: {len(big)}; their H2/H3 section count totals {sum(s['sections'] for s in big)} "
      f"(max {max(s['sections'] for s in big)} on "
      f"{max(big, key=lambda s: s['sections'])['name']})")

print("\nlargest per category:")
cats: dict[str, list[dict]] = {}
for s in ps:
    cats.setdefault(s["category"], []).append(s)
for c, rows in sorted(cats.items(), key=lambda kv: -sum(r["body_chars"] for r in kv[1])):
    print(f"  {c:<14} n={len(rows):>2} total={sum(r['body_chars'] for r in rows):>8,} "
          f"max={max(r['body_chars'] for r in rows):>7,} ({max(rows, key=lambda r: r['body_chars'])['name']})")
