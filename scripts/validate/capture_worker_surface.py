#!/usr/bin/env python3
"""Capture the current worker tool surface into scripts/validate/worker-surface.json.

check_manifest.mjs uses this snapshot (when present) in addition to the historical
measurement artifact, so tools added by a newer vibe-trading-ai release validate
without hand-editing the metrics file.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
OUT = Path(__file__).resolve().parent / "worker-surface.json"
VENV_PYTHON = Path.home() / ".vibe-trading" / "dsh" / "venv" / "Scripts" / "python.exe"
WORKER = REPO / "worker" / "vibe_trading_worker.py"


def main() -> int:
    python = os.environ.get("VIBE_TRADING_PYTHON") or str(VENV_PYTHON)
    if not Path(python).exists():
        print(f"skip: no worker interpreter at {python}")
        return 0
    cwd = REPO / ".tmp" / "surface-capture"
    cwd.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    proc = subprocess.Popen(
        [python, str(WORKER), "--cwd", str(cwd), "--shutdown-grace", "5"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        cwd=str(cwd),
        env=env,
        text=True,
        encoding="utf-8",
        bufsize=1,
    )
    try:
        def call(method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
            call.seq = getattr(call, "seq", 0) + 1
            request = {"jsonrpc": "2.0", "id": call.seq, "method": method, "params": params or {}}
            assert proc.stdin and proc.stdout
            proc.stdin.write(json.dumps(request) + "\n")
            proc.stdin.flush()
            deadline = time.time() + timeout
            while time.time() < deadline:
                line = proc.stdout.readline()
                if not line:
                    raise RuntimeError("worker closed stdout")
                payload = json.loads(line)
                if payload.get("id") == request["id"]:
                    return payload
            raise TimeoutError(method)

        call("ping")
        tools = (call("tools/list").get("result") or {}).get("tools") or []
        registry_names = sorted(
            tool["name"] for tool in tools if tool.get("name") and not tool.get("virtual")
        )
        virtual_names = sorted(tool["name"] for tool in tools if tool.get("name") and tool.get("virtual"))
        payload = {
            "tool_count": len(tools),
            "registry_count": len(registry_names),
            "virtual_count": len(virtual_names),
            "registry_names": registry_names,
            "virtual_names": virtual_names,
            "tool_names": sorted(tool["name"] for tool in tools if tool.get("name")),
        }
        OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {OUT} ({payload['tool_count']} tools)")
        return 0
    finally:
        try:
            call("shutdown", timeout=10)
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
