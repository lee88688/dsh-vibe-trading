#!/usr/bin/env python3
"""Prototype direct-call bridge: one long-lived process over newline JSON-RPC.

Instead of an MCP server, this exposes Vibe-Trading's own ToolRegistry:

  {"id":1,"method":"ping"}
  {"id":2,"method":"tools/list"}
  {"id":3,"method":"tools/call","params":{"name":"get_market_data","arguments":{...}}}
  {"id":4,"method":"shutdown"}

Responses are one JSON object per line on stdout; diagnostics go to stderr.
Reuses src.tools.build_registry() + ToolRegistry.execute() unchanged, so the
error envelopes, policy screening and the 10k tool-result cap are identical to
Vibe-Trading's own behaviour.

Usage:
  uv run python scripts\\env\\direct_worker.py
  uv run python scripts\\env\\direct_worker.py --session-id bench
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
T_START = time.perf_counter()


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    sys.stderr.write(f"[direct_worker] {msg}\n")
    sys.stderr.flush()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", default="", help="default session id injected into goal tools")
    ap.add_argument("--tool-timeout", type=float, default=0.0, help="0 = no per-call timeout")
    ap.add_argument("--skip-build", action="store_true")
    args = ap.parse_args()

    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from env_common import vibe_home

    vibe_home()

    t_import = time.perf_counter()
    try:
        from src.tools import build_registry
        from src.config.limits import TOOL_RESULT_LIMIT
    except Exception:
        _emit({"jsonrpc": "2.0", "error": {"code": -32000, "message": "import failed"},
               "detail": traceback.format_exc()})
        return 2
    t_imported = time.perf_counter()

    registry = None
    if not args.skip_build:
        try:
            registry = build_registry(session_id=args.session_id or None)
        except Exception:
            _emit({"jsonrpc": "2.0", "error": {"code": -32001, "message": "registry build failed"},
                   "detail": traceback.format_exc()})
            return 2
    t_ready = time.perf_counter()

    startup = {
        "import_sec": round(t_imported - t_import, 2),
        "build_sec": round(t_ready - t_imported, 2),
        "total_sec": round(t_ready - T_START, 2),
        "pid": os.getpid(),
        "tools": len(registry) if registry is not None else 0,
        "python": sys.version.split()[0],
        "tool_result_limit": TOOL_RESULT_LIMIT,
        "vibe_trading_home": os.environ.get("VIBE_TRADING_HOME", ""),
    }
    _log(f"ready in {startup['total_sec']}s with {startup['tools']} tools")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError as exc:
            _emit({"error": {"code": -32700, "message": f"parse error: {exc}"}})
            continue
        rid = req.get("id")
        method = req.get("method")
        params = req.get("params") or {}
        t0 = time.perf_counter()

        if method == "ping":
            body = {"ok": True, **startup}
        elif method == "tools/list":
            if registry is None:
                body = {"error": "registry not built"}
            else:
                body = {
                    "tools": [
                        {
                            "name": t.name,
                            "description": t.description,
                            "parameters": t.parameters,
                            "readonly": bool(getattr(t, "is_readonly", True)),
                            "repeatable": bool(getattr(t, "repeatable", False)),
                        }
                        for t in registry._tools.values()
                    ]
                }
        elif method == "tools/call":
            if registry is None:
                body = {"error": "registry not built"}
            else:
                name = params.get("name") or ""
                arguments = params.get("arguments") or {}
                try:
                    raw = registry.execute(name, arguments)
                except Exception:
                    raw = json.dumps({"status": "error", "error": traceback.format_exc(limit=2)})
                value = None
                try:
                    value = json.loads(raw)
                except (json.JSONDecodeError, TypeError):
                    value = None
                body = {
                    "name": name,
                    "text": raw,
                    "chars": len(raw),
                    "json": value is not None,
                    "over_result_limit": len(raw) > (TOOL_RESULT_LIMIT if registry else 10000),
                }
        elif method == "shutdown":
            _emit({"jsonrpc": "2.0", "id": rid, "result": {"ok": True}})
            return 0
        else:
            _emit({"jsonrpc": "2.0", "id": rid,
                   "error": {"code": -32601, "message": f"unknown method {method!r}"}})
            continue

        body["elapsed_sec"] = round(time.perf_counter() - t0, 3)
        _emit({"jsonrpc": "2.0", "id": rid, "result": body})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
