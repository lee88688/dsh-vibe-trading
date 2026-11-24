#!/usr/bin/env python3
"""Measure the rendered Vibe-Trading system prompt (eager vs deferred registry).

Renders ContextBuilder.build_system_prompt() against the installed package so the
ported prompt size is a measurement, not an estimate.

Usage:
  uv run python scripts\\env\\measure_prompt.py
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "scripts" / "env" / "prompt-metrics.json"
CPT = 4


def main() -> int:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from env_common import vibe_home

    vibe_home()
    from src.agent import context as ctxmod
    from src.agent.context import ContextBuilder
    from src.agent.memory import WorkspaceMemory
    from src.agent.skills import SkillsLoader
    from src.agent.tool_loading import DeferredToolRegistry
    from src.tools import build_registry

    t0 = time.perf_counter()
    registry = build_registry()
    skills = SkillsLoader()
    memory = WorkspaceMemory()

    raw_template = getattr(ctxmod, "_SYSTEM_PROMPT", "")
    memory_section = getattr(ctxmod, "_MEMORY_SECTION", "")

    eager_prompt = ContextBuilder(registry, memory, skills_loader=skills).build_system_prompt()
    deferred = DeferredToolRegistry(registry)
    deferred_prompt = ContextBuilder(deferred, memory, skills_loader=skills).build_system_prompt()

    catalog = deferred.catalog()
    skill_catalog = skills.get_descriptions()

    report = {
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "seconds": round(time.perf_counter() - t0, 2),
        "chars_per_token": CPT,
        "template_chars": len(raw_template),
        "template_tokens": len(raw_template) // CPT,
        "memory_section_template_chars": len(memory_section),
        "eager_prompt_chars": len(eager_prompt),
        "eager_prompt_tokens": len(eager_prompt) // CPT,
        "deferred_prompt_chars": len(deferred_prompt),
        "deferred_prompt_tokens": len(deferred_prompt) // CPT,
        "catalog_chars": len(catalog),
        "catalog_tokens": len(catalog) // CPT,
        "skill_catalog_chars": len(skill_catalog),
        "skill_catalog_tokens": len(skill_catalog) // CPT,
        "prompt_without_catalog_chars": len(deferred_prompt) - len(catalog),
        "prompt_without_catalog_tokens": (len(deferred_prompt) - len(catalog)) // CPT,
        "deferred_prompt_head": deferred_prompt[:400],
        "deferred_prompt_tail": deferred_prompt[-400:],
    }
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    print(f"raw _SYSTEM_PROMPT template: {report['template_chars']:,} chars = {report['template_tokens']:,} tok")
    print(f"eager prompt (no catalog):   {report['eager_prompt_chars']:,} chars = {report['eager_prompt_tokens']:,} tok")
    print(f"deferred prompt (+ catalog): {report['deferred_prompt_chars']:,} chars = {report['deferred_prompt_tokens']:,} tok")
    print(f"  of which tool catalog:     {report['catalog_chars']:,} chars = {report['catalog_tokens']:,} tok")
    print(f"  of which skill catalog:    {report['skill_catalog_chars']:,} chars = {report['skill_catalog_tokens']:,} tok")
    print(f"prompt without tool catalog: {report['prompt_without_catalog_chars']:,} chars = "
          f"{report['prompt_without_catalog_tokens']:,} tok")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
