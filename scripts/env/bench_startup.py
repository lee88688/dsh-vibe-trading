#!/usr/bin/env python3
"""Startup/RSS variants: plain registry worker, lean (no LLM stack) worker, MCP.

Adds three measurements the bridge benchmark does not cover:
  * lean startup: skip src/agent/__init__ -> src.agent.loop -> langchain/openai,
  * real RSS of the Python process behind vibe-trading-mcp.exe (the .exe is a
    launcher stub, so the parent pid is not the one holding pandas),
  * cost of N concurrent MCP servers (per-session spawn scenario).

Writes scripts/env/startup-variants.json.

Usage:
  uv run python scripts/env/bench_startup.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ENV = Path(__file__).resolve().parent
REPO = ENV.parents[1]
OUT = ENV / "startup-variants.json"

sys.path.insert(0, str(ENV))
from env_common import child_env as _common_child_env, mcp_exe, python_exe
PY = python_exe()
MCP_EXE = mcp_exe()
from mcp_handshake import StdioMCPClient  # noqa: E402

COMMON = """
import json, os, sys, time
t0 = time.perf_counter()
"""

PLAIN = COMMON + """
from src.tools import build_registry
t1 = time.perf_counter()
r = build_registry()
t2 = time.perf_counter()
print(json.dumps({"import_sec": round(t1-t0,2), "build_sec": round(t2-t1,2),
                  "tools": len(r), "pid": os.getpid(), "loop_imported": "src.agent.loop" in sys.modules}))
"""

# The lean variant pre-seeds a stub for the package so `src.agent.__init__`
# (which imports AgentLoop -> src.providers.chat -> langchain_openai/openai)
# never runs; every tool module only needs src.agent.tools.
LEAN = COMMON + """
import importlib.util, types
root = next(p for p in sys.path if (os.path.join(p, "src", "agent", "tools.py") and os.path.isdir(os.path.join(p, "src"))))
if root not in sys.path: sys.path.insert(0, root)
pkg = types.ModuleType("src.agent"); pkg.__path__ = [os.path.join(root, "src", "agent")]
sys.modules["src.agent"] = pkg
from src.tools import build_registry
t1 = time.perf_counter()
r = build_registry()
t2 = time.perf_counter()
print(json.dumps({"import_sec": round(t1-t0,2), "build_sec": round(t2-t1,2),
                  "tools": len(r), "pid": os.getpid(), "loop_imported": "src.agent.loop" in sys.modules}))
"""


def child_env() -> dict[str, str]:
    return _common_child_env()


def rss_of(pid: int) -> int | None:
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"try {{ (Get-Process -Id {pid} -ErrorAction Stop).WorkingSet64 }} catch {{ -1 }}"],
            capture_output=True, text=True, timeout=30,
        )
        v = int(out.stdout.strip())
        return v if v > 0 else None
    except Exception:
        return None


def rss_tree(pid: int) -> dict:
    """Sum working set of pid and its descendants via CIM."""
    ps = (
        "$root=" + str(pid) + ";"
        "$all=Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId;"
        "$ids=New-Object System.Collections.ArrayList; [void]$ids.Add($root);"
        "$go=$true; while($go){ $go=$false; foreach($p in $all){"
        " if($ids -contains $p.ParentProcessId -and -not ($ids -contains $p.ProcessId)){"
        " [void]$ids.Add($p.ProcessId); $go=$true } } };"
        "$sum=0; $rows=@(); foreach($i in $ids){ try{ $g=Get-Process -Id $i -ErrorAction Stop;"
        " $sum+=$g.WorkingSet64; $rows+=@{pid=$i; rss_mb=[math]::Round($g.WorkingSet64/1MB,1); name=$g.ProcessName} }catch{} };"
        "@{total_mb=[math]::Round($sum/1MB,1); procs=$rows} | ConvertTo-Json -Depth 4 -Compress"
    )
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", ps],
                             capture_output=True, text=True, timeout=60)
        return json.loads(out.stdout.strip())
    except Exception as exc:
        return {"error": str(exc)}


def run_python_code(code: str, label: str) -> dict:
    t0 = time.perf_counter()
    proc = subprocess.Popen([str(PY), "-c", code], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=child_env(), cwd=str(REPO))
    line = proc.stdout.readline().decode("utf-8", "replace").strip()
    wall = round(time.perf_counter() - t0, 2)
    info = json.loads(line) if line.startswith("{") else {"raw": line[:300]}
    rss = rss_of(info.get("pid")) if info.get("pid") else None
    proc.wait(timeout=60)
    return {"label": label, "spawn_to_ready_sec": wall, **info,
            "rss_mb": round(rss / 1e6, 1) if rss else None}


def bench_mcp(n: int = 1) -> list[dict]:
    env = child_env()
    clients: list[tuple[int, StdioMCPClient]] = []
    out = []
    for i in range(n):
        t0 = time.perf_counter()
        c = StdioMCPClient([str(MCP_EXE)], env=env, cwd=str(REPO))
        init = c.request("initialize",
                         {"protocolVersion": "2025-06-18", "capabilities": {},
                          "clientInfo": {"name": "bench", "version": "0.1"}}, timeout=300)
        c.notify("notifications/initialized")
        listing = c.request("tools/list", {}, timeout=180)
        wall = round(time.perf_counter() - t0, 2)
        clients.append((c.proc.pid, c))
        out.append({
            "idx": i,
            "spawn_initialize_list_sec": wall,
            "launcher_pid": c.proc.pid,
            "tools": len(((listing.get("result") or {}).get("tools")) or []),
            "tree": rss_tree(c.proc.pid),
        })
    for _, c in clients:
        c.close()
    return out


def main() -> int:
    report: dict = {"python": str(PY)}
    print("== startup variants ==")
    plain = run_python_code(PLAIN, "plain build_registry")
    print(f"plain : ready={plain['spawn_to_ready_sec']}s import={plain.get('import_sec')}s "
          f"build={plain.get('build_sec')}s tools={plain.get('tools')} rss={plain.get('rss_mb')}MB "
          f"loop={plain.get('loop_imported')}")
    lean = run_python_code(LEAN, "lean build_registry (no agent loop)")
    print(f"lean  : ready={lean['spawn_to_ready_sec']}s import={lean.get('import_sec')}s "
          f"build={lean.get('build_sec')}s tools={lean.get('tools')} rss={lean.get('rss_mb')}MB "
          f"loop={lean.get('loop_imported')}")
    report["plain"] = plain
    report["lean"] = lean

    print("\n== MCP server process tree ==")
    one = bench_mcp(1)
    print(f"x1: ready={one[0]['spawn_initialize_list_sec']}s tools={one[0]['tools']} "
          f"tree_total={one[0]['tree'].get('total_mb')}MB procs={one[0]['tree'].get('procs')}")
    report["mcp_one"] = one

    print("\n== two concurrent MCP servers (per-session scenario) ==")
    two = bench_mcp(2)
    total = sum(t["tree"].get("total_mb") or 0 for t in two)
    print(f"x2: " + " | ".join(f"{t['spawn_initialize_list_sec']}s {t['tree'].get('total_mb')}MB" for t in two)
          + f"  combined={round(total,1)}MB")
    report["mcp_two"] = two

    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
