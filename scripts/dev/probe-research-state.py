#!/usr/bin/env python3
"""Probe hypothesis/artifact/sdm tools with research state redirected under dsh/work."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PY = os.environ.get("VIBE_TRADING_PYTHON") or str(Path.home() / ".vibe-trading" / "dsh" / "venv" / "Scripts" / "python.exe")
WORKER = REPO / "worker" / "vibe_trading_worker.py"
STATE = Path.home() / ".vibe-trading" / "dsh" / "work" / "research"
ALLOWED_RUNS = str(Path.home() / ".vibe-trading" / "dsh" / "work" / "runs")

CANDIDATES = [
    ("create_hypothesis", {"title": "probe", "thesis": "probe only"}),
    ("search_hypotheses", {}),
    ("save_research_artifact", {"content": "probe", "data_as_of": "2026-11-07"}),
    ("search_research_artifacts", {}),
    ("sdm_status", {"action": "list"}),
    ("remember", {"action": "save", "title": "probe", "content": "probe", "memory_type": "insight"}),
]


class Worker:
    def __init__(self) -> None:
        STATE.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
                "VIBE_TRADING_HOME": str(Path.home() / ".vibe-trading"),
                "VIBE_TRADING_ALLOWED_RUN_ROOTS": ALLOWED_RUNS,
                "VIBE_TRADING_ALLOWED_WRITE_ROOTS": ALLOWED_RUNS,
                "VIBE_TRADING_HYPOTHESES_PATH": str(STATE / "hypotheses.json"),
                "VIBE_TRADING_GOAL_DB_PATH": str(STATE / "goals.sqlite3"),
                "VIBE_TRADING_RESEARCH_ARTIFACT_DB_PATH": str(STATE / "research_artifacts.sqlite3"),
                "VIBE_TRADING_STRATEGY_STORE_DB_PATH": str(STATE / "strategy_store.sqlite3"),
                "VIBE_TRADING_STRATEGY_DISCOVERY_DB_PATH": str(STATE / "strategy_discovery.sqlite3"),
                "VIBE_TRADING_PLAYBOOK_DIR": str(STATE / "playbooks"),
                "VIBE_TRADING_DATA_CACHE_ROOT": str(Path.home() / ".vibe-trading" / "dsh" / "work" / "cache"),
            }
        )
        cwd = REPO / ".tmp" / "probe-hidden"
        cwd.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(
            [PY, str(WORKER), "--cwd", str(cwd), "--shutdown-grace", "5"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            cwd=str(cwd), env=env, text=True, encoding="utf-8", bufsize=1,
        )
        self.seq = 0
        self.call("ping")

    def call(self, method: str, params: dict | None = None, timeout: float = 180.0) -> dict:
        self.seq += 1
        request = {"jsonrpc": "2.0", "id": self.seq, "method": method, "params": params or {}}
        assert self.proc.stdin and self.proc.stdout
        self.proc.stdin.write(json.dumps(request) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("worker closed stdout")
            payload = json.loads(line)
            if payload.get("id") == request["id"]:
                return payload
        raise TimeoutError(method)

    def close(self) -> None:
        try:
            self.call("shutdown", timeout=10)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def main() -> int:
    worker = Worker()
    try:
        for name, args in CANDIDATES:
            try:
                response = worker.call("tools/call", {"name": name, "arguments": args})
            except Exception as error:
                print(f"{name:28} EXC {error}")
                continue
            if "error" in response:
                print(f"{name:28} RPC-ERR {str(response['error'])[:120]}")
                continue
            result = response.get("result") or {}
            text = result.get("text") or result.get("json") or ""
            if isinstance(text, (dict, list)):
                text = json.dumps(text, ensure_ascii=False)
            print(f"{name:28} {str(result.get('status') or '?'):6} {str(text).replace(chr(10),' ')[:170]}")
    finally:
        worker.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
