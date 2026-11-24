#!/usr/bin/env python3
"""Benchmark: direct registry worker vs the MCP server, same calls both sides.

Spawns scripts/env/direct_worker.py (raw ToolRegistry over newline JSON-RPC) and
the installed vibe-trading-mcp.exe (MCP stdio), then measures startup, tool
listing, and a small identical call set. Writes scripts/env/bridge-bench.json.

Usage:
  uv run python scripts/env/bench_bridge.py
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
OUT = ENV / "bridge-bench.json"
WRITE_ROOT = ENV / "tmp"

sys.path.insert(0, str(ENV))
from env_common import child_env as _common_child_env, mcp_exe, python_exe
PY = python_exe()
MCP_EXE = mcp_exe()
from mcp_handshake import StdioMCPClient  # noqa: E402

CALLS = [
    ("search_symbol", {"query": "Apple", "limit": 3}),
    (
        "get_market_data",
        {
            "codes": ["AAPL.US"],
            "start_date": "2026-10-20",
            "end_date": "2026-11-05",
            "source": "auto",
            "max_rows": 5,
        },
    ),
    ("get_research_goal", {"session_id": "bench-session"}),
    ("start_research_goal", {"objective": "bench probe only"}),
    ("write_file", {"path": "worker-write-probe.txt", "content": "probe"}),
    ("write_file", {"path": "C:/Windows/worker-write-probe.txt", "content": "probe"}),
    ("backtest", {"run_dir": "C:/definitely-not-a-run-dir"}),
    ("definitely_not_a_tool", {}),
]


def child_env() -> dict[str, str]:
    env = _common_child_env({"VIBE_TRADING_ALLOWED_WRITE_ROOTS": str(WRITE_ROOT)})
    for k in (
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "TUSHARE_TOKEN",
        "FRED_API_KEY", "TIINGO_API_KEY", "ALPHAVANTAGE_API_KEY", "FINNHUB_API_KEY", "FMP_API_KEY",
    ):
        env[k] = ""
    return env


def rss_bytes(pid: int) -> int | None:
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             f"(Get-Process -Id {pid} -ErrorAction Stop).WorkingSet64"],
            capture_output=True, text=True, timeout=30,
        )
        return int(out.stdout.strip())
    except Exception:
        return None


class Worker:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [str(PY), str(ENV / "direct_worker.py")],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=child_env(), cwd=str(REPO), bufsize=0,
        )
        self._id = 0
        self.stderr: list[str] = []

    def request(self, method: str, params: dict | None = None, timeout: float = 300.0) -> dict:
        self._id += 1
        rid = self._id
        payload = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            payload["params"] = params
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write((json.dumps(payload, ensure_ascii=False) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("worker closed stdout")
            obj = json.loads(line.decode("utf-8", "replace"))
            if obj.get("id") == rid or "id" not in obj:
                return obj
        raise TimeoutError(method)

    def close(self) -> None:
        try:
            self.request("shutdown", timeout=10)
        except Exception:
            pass
        try:
            self.proc.kill()
        except Exception:
            pass
        assert self.proc.stderr is not None
        self.stderr = self.proc.stderr.read().decode("utf-8", "replace").splitlines()


def summarise(text: str) -> dict:
    out: dict = {"chars": len(text)}
    try:
        val = json.loads(text)
    except Exception:
        out["head"] = text[:160]
        return out
    if isinstance(val, dict):
        out["keys"] = sorted(val.keys())[:8]
        out["status"] = val.get("status")
        out["ok"] = val.get("ok")
        if val.get("error"):
            out["error"] = str(val["error"])[:200]
        out["head"] = json.dumps(val, ensure_ascii=False)[:160]
    else:
        out["head"] = json.dumps(val, ensure_ascii=False)[:160]
    return out


def bench_worker() -> dict:
    WRITE_ROOT.mkdir(parents=True, exist_ok=True)
    t0 = time.perf_counter()
    w = Worker()
    ping = w.request("ping", timeout=300)
    startup = round(time.perf_counter() - t0, 2)
    pid = (ping.get("result") or {}).get("pid")
    rss = rss_bytes(pid) if pid else None

    t = time.perf_counter()
    listing = w.request("tools/list", timeout=120)
    list_sec = round(time.perf_counter() - t, 3)
    tools = (listing.get("result") or {}).get("tools") or []
    list_chars = len(json.dumps(listing, ensure_ascii=False))

    calls = []
    for name, args in CALLS:
        t = time.perf_counter()
        resp = w.request("tools/call", {"name": name, "arguments": args}, timeout=600)
        secs = round(time.perf_counter() - t, 3)
        res = resp.get("result") or {}
        row = {"tool": name, "sec": secs, "chars": res.get("chars")}
        row.update(summarise(res.get("text") or ""))
        calls.append(row)

    rss_after = rss_bytes(pid) if pid else None
    w.close()
    return {
        "startup_sec_incl_spawn": startup,
        "ready": (ping.get("result") or {}),
        "tools_list_sec": list_sec,
        "tools_list_response_chars": list_chars,
        "tool_count": len(tools),
        "tools_list_contains_schemas": bool(tools and "parameters" in tools[0]),
        "rss_after_start_mb": round(rss / 1e6, 1) if rss else None,
        "rss_after_calls_mb": round(rss_after / 1e6, 1) if rss_after else None,
        "calls": calls,
        "stderr_tail": w.stderr[-12:],
    }


def bench_mcp() -> dict:
    env = child_env()
    t0 = time.perf_counter()
    c = StdioMCPClient([str(MCP_EXE)], env=env, cwd=str(REPO))
    init = c.request(
        "initialize",
        {"protocolVersion": "2025-06-18", "capabilities": {},
         "clientInfo": {"name": "bench", "version": "0.1"}},
        timeout=300,
    )
    init_sec = round(time.perf_counter() - t0, 2)
    c.notify("notifications/initialized")
    pid = c.proc.pid
    rss = rss_bytes(pid)

    t = time.perf_counter()
    listing = c.request("tools/list", {}, timeout=120)
    list_sec = round(time.perf_counter() - t, 3)
    tools = ((listing.get("result") or {}).get("tools")) or []
    list_chars = len(json.dumps(listing, ensure_ascii=False))

    calls = []
    for name, args in CALLS:
        t = time.perf_counter()
        try:
            resp = c.request("tools/call", {"name": name, "arguments": args}, timeout=600)
        except Exception as exc:  # protocol-level error (unknown tool etc.)
            calls.append({"tool": name, "sec": round(time.perf_counter() - t, 3),
                          "protocol_error": str(exc)[:200]})
            continue
        secs = round(time.perf_counter() - t, 3)
        if "error" in resp:
            calls.append({"tool": name, "sec": secs,
                          "protocol_error": str(resp["error"])[:200]})
            continue
        result = resp.get("result") or {}
        content = result.get("content") or []
        text = ""
        if content and isinstance(content[0], dict):
            text = content[0].get("text") or ""
        row = {"tool": name, "sec": secs, "chars": len(text),
               "is_error": result.get("isError")}
        row.update(summarise(text))
        calls.append(row)

    rss_after = rss_bytes(pid)
    c.close()
    return {
        "startup_sec_incl_spawn": init_sec,
        "server_info": (init.get("result") or {}).get("serverInfo"),
        "tools_list_sec": list_sec,
        "tools_list_response_chars": list_chars,
        "tool_count": len(tools),
        "tools_list_contains_schemas": bool(tools and "inputSchema" in tools[0]),
        "rss_after_start_mb": round(rss / 1e6, 1) if rss else None,
        "rss_after_calls_mb": round(rss_after / 1e6, 1) if rss_after else None,
        "calls": calls,
        "stderr_tail": c.stderr_lines[-6:],
    }


def main() -> int:
    report: dict = {"python": str(PY), "mcp_exe": str(MCP_EXE)}
    print("== direct registry worker ==")
    report["direct_worker"] = bench_worker()
    dw = report["direct_worker"]
    print(f"spawn+ready: {dw['startup_sec_incl_spawn']}s  import={dw['ready'].get('import_sec')}s "
          f"build={dw['ready'].get('build_sec')}s  tools={dw['tool_count']}  "
          f"RSS={dw['rss_after_start_mb']}MB")
    print(f"tools/list: {dw['tools_list_sec']}s {dw['tools_list_response_chars']:,} chars")
    for c in dw["calls"]:
        print(f"  {c['tool']:<24}{c['sec']:>7}s {c.get('chars') or 0:>8,}c status={c.get('status')} "
              f"ok={c.get('ok')} err={str(c.get('error'))[:60]}")

    print("\n== MCP server (vibe-trading-mcp) ==")
    report["mcp_server"] = bench_mcp()
    ms = report["mcp_server"]
    print(f"spawn+initialize: {ms['startup_sec_incl_spawn']}s  tools={ms['tool_count']}  "
          f"RSS={ms['rss_after_start_mb']}MB")
    print(f"tools/list: {ms['tools_list_sec']}s {ms['tools_list_response_chars']:,} chars")
    for c in ms["calls"]:
        print(f"  {c['tool']:<24}{c['sec']:>7}s {c.get('chars') or 0:>8,}c status={c.get('status')} "
              f"is_error={c.get('is_error')} proto={str(c.get('protocol_error'))[:50]} "
              f"err={str(c.get('error'))[:50]}")

    OUT.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"\nwrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
