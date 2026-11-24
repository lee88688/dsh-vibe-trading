#!/usr/bin/env python3
"""Probe whether hidden Vibe-Trading tools are callable in the lean DSH worker.

Runs the real worker over JSON-RPC and calls each candidate with minimal args,
printing whether the tool exists, whether argument validation passed, and the
first line of any error. Read-only research tooling.
"""
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

CANDIDATES = [
    ("search_hypotheses", {}),
    ("list_backtest_runs", {"limit": 3}),
    ("sdm_status", {"action": "list"}),
    ("remember", {"action": "search", "query": "test"}),
    ("session_search", {"query": "test", "max_results": 2}),
    ("options_pricing", {"spot": 100, "strike": 105, "expiry_days": 30, "volatility": 0.2, "option_type": "call"}),
    ("options_payoff", {"legs": [{"option_type": "call", "strike": 100, "qty": 1}], "entry_spot": 100, "expiry_days": 30}),
    ("portfolio_risk_xray", {"symbols": ["AAPL.US"]}),
    ("portfolio_summary", {}),
    ("create_hypothesis", {"title": "probe", "thesis": "probe only"}),
    ("save_research_artifact", {"content": "probe", "data_as_of": "2026-11-07"}),
    ("search_research_artifacts", {}),
    ("alpha_compare", {"alpha_ids": ["momentum_20d", "reversal_5d"], "universe": "csi300", "period": "1y"}),
    ("run_research_autopilot", {"hypothesis_id": "probe-missing"}),
    ("generate_backtest_config", {"hypothesis_id": "probe-missing", "start_date": "2024-01-01", "end_date": "2025-01-01"}),
    ("link_backtest", {"hypothesis_id": "probe-missing"}),
    ("link_autopilot_backtest", {"hypothesis_id": "probe-missing", "run_dir": "missing"}),
    ("update_research_goal", {}),
    ("edit_file", {"path": "probe.txt", "old_text": "a", "new_text": "b"}),
    ("check_background", {}),
    ("get_br_market_data", {"symbol": "PETR4"}),
    ("pattern", {"run_dir": "missing"}),
]

ALLOWED_RUNS = str(Path.home() / ".vibe-trading" / "dsh" / "work" / "runs")


class Worker:
    def __init__(self) -> None:
        env = dict(os.environ)
        env.update(
            {
                "PYTHONUTF8": "1",
                "PYTHONIOENCODING": "utf-8",
                "VIBE_TRADING_HOME": str(Path.home() / ".vibe-trading"),
                "VIBE_TRADING_ALLOWED_RUN_ROOTS": ALLOWED_RUNS,
                "VIBE_TRADING_ALLOWED_WRITE_ROOTS": ALLOWED_RUNS,
            }
        )
        cwd = REPO / ".tmp" / "probe-hidden"
        cwd.mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(
            [PY, str(WORKER), "--cwd", str(cwd), "--shutdown-grace", "5"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(cwd),
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.seq = 0
        self.call("ping")

    def call(self, method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
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
                response = worker.call("tools/call", {"name": name, "arguments": args}, timeout=180)
            except Exception as error:
                print(f"{name:28} EXC  {error}")
                continue
            if "error" in response:
                message = str(response["error"].get("message") or response["error"])
                print(f"{name:28} RPC-ERR {message[:120]}")
                continue
            result = response.get("result") or {}
            status = result.get("status") or ("ok" if result.get("ok") else "?")
            text = result.get("text") or result.get("json") or ""
            if isinstance(text, (dict, list)):
                text = json.dumps(text, ensure_ascii=False)
            first = str(text).replace("\n", " ")[:150]
            print(f"{name:28} {status:6} {first}")
    finally:
        worker.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
