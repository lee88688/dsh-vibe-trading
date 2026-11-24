#!/usr/bin/env python3
"""Self-reported RSS + timing for the three ways to host Vibe-Trading's tools.

Cross-process memory introspection is blocked in this sandbox (WMI/CIM denied,
the console-script .exe hides the real interpreter), so each variant measures
itself with psapi.GetProcessMemoryInfo and reports JSON on stdout.

Variants:
  plain  - build_registry() with the normal src.agent package import chain
  lean   - build_registry() with src.agent.__init__ stubbed (no AgentLoop/langchain)
  mcp    - import mcp_server and pre-warm its registry (what vibe-trading-mcp holds)
  mcponly- import mcp_server without pre-warming the registry

Writes scripts/env/memory-variants.json.

Usage:
  uv run python scripts/env/bench_memory.py
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
OUT = ENV / "memory-variants.json"

sys.path.insert(0, str(ENV))
from env_common import child_env as _common_child_env, mcp_exe, python_exe
PY = python_exe()

RSS_HELPER = """
import ctypes, ctypes.wintypes as wt
class PMC(ctypes.Structure):
    _fields_ = [("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t)]
def rss_mb():
    pmc = PMC(); pmc.cb = ctypes.sizeof(pmc)
    ok = ctypes.windll.psapi.GetProcessMemoryInfo(
        ctypes.windll.kernel32.GetCurrentProcess(), ctypes.byref(pmc), pmc.cb)
    return round(pmc.WorkingSetSize / 1e6, 1) if ok else None
"""

TAIL = """
import json, os, sys, time
print(json.dumps({"pid": os.getpid(), "rss_mb": rss_mb(),
                  "modules": len(sys.modules), "loop_imported": "src.agent.loop" in sys.modules}))
sys.stdout.flush()
time.sleep(2)  # stay alive briefly so a parent can observe it if needed
"""

PLAIN = RSS_HELPER + """
import time
t0 = time.perf_counter()
from src.tools import build_registry
t1 = time.perf_counter()
r = build_registry()
t2 = time.perf_counter()
timing = {"import_sec": round(t1-t0,2), "build_sec": round(t2-t1,2), "tools": len(r)}
""" + TAIL.replace('"modules"', '**timing, "modules"')

LEAN = RSS_HELPER + """
import os, sys, types, time
t0 = time.perf_counter()
root = next(p for p in sys.path if os.path.isdir(os.path.join(p, "src", "agent")))
pkg = types.ModuleType("src.agent"); pkg.__path__ = [os.path.join(root, "src", "agent")]
sys.modules["src.agent"] = pkg
from src.tools import build_registry
t1 = time.perf_counter()
r = build_registry()
t2 = time.perf_counter()
timing = {"import_sec": round(t1-t0,2), "build_sec": round(t2-t1,2), "tools": len(r)}
""" + TAIL.replace('"modules"', '**timing, "modules"')

MCP = RSS_HELPER + """
import time
t0 = time.perf_counter()
from src.providers.llm import _ensure_dotenv
_ensure_dotenv()
import mcp_server
t1 = time.perf_counter()
mcp_server._get_registry()
t2 = time.perf_counter()
timing = {"import_sec": round(t1-t0,2), "prewarm_sec": round(t2-t1,2),
          "tools": len(mcp_server._get_registry())}
""" + TAIL.replace('"modules"', '**timing, "modules"')

MCPONLY = RSS_HELPER + """
import time
t0 = time.perf_counter()
from src.providers.llm import _ensure_dotenv
_ensure_dotenv()
import mcp_server
t1 = time.perf_counter()
timing = {"import_sec": round(t1-t0,2), "prewarm_sec": 0, "tools": 0}
""" + TAIL.replace('"modules"', '**timing, "modules"')


def child_env() -> dict[str, str]:
    return _common_child_env()


def rss_of(pid: int) -> int | None:
    """Read a child's working set from PowerShell (.NET), the only path that
    works in this sandbox: WMI/CIM and psapi inside the child are both denied."""
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"try {{ (Get-Process -Id {pid} -ErrorAction Stop).WorkingSet64 }} catch {{ -1 }}"],
            capture_output=True, text=True, timeout=60,
        )
        v = int(out.stdout.strip())
        return v if v > 0 else None
    except Exception:
        return None


def run(label: str, code: str) -> dict:
    t0 = time.perf_counter()
    proc = subprocess.Popen([str(PY), "-c", code], stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, env=child_env(), cwd=str(REPO))
    line = proc.stdout.readline().decode("utf-8", "replace").strip()
    wall = round(time.perf_counter() - t0, 2)
    try:
        info = json.loads(line)
    except Exception:
        info = {"raw": line[:400]}
    rss = rss_of(info["pid"]) if info.get("pid") else None
    err = proc.stderr.read().decode("utf-8", "replace")
    proc.wait(timeout=120)
    if "rss_mb" not in info or info.get("rss_mb") is None:
        info["rss_mb"] = round(rss / 1e6, 1) if rss else None
    info.pop("raw", None) if info.get("pid") else None
    return {"label": label, "spawn_to_report_sec": wall, **info,
            "stderr_tail": err[-600:] if err else ""}


def main() -> int:
    report = {"python": str(PY), "variants": []}
    print(f"{'variant':<10}{'ready(s)':>9}{'import(s)':>10}{'build/prewarm(s)':>18}{'tools':>7}{'RSS(MB)':>9}{'modules':>9}{'loop':>6}")
    for label, code in (("plain", PLAIN), ("lean", LEAN), ("mcponly", MCPONLY), ("mcp", MCP)):
        r = run(label, code)
        report["variants"].append(r)
        import_sec = r.get("import_sec")
        build_sec = r.get("build_sec", r.get("prewarm_sec"))
        print(f"{label:<10}{r['spawn_to_report_sec']:>9}{str(import_sec):>10}{str(build_sec):>18}"
              f"{str(r.get('tools')):>7}{str(r.get('rss_mb')):>9}{str(r.get('modules')):>9}"
              f"{str(r.get('loop_imported')):>6}")
        if r.get("stderr_tail"):
            print("   stderr:", r["stderr_tail"][-300:].replace("\n", " | "))
    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
