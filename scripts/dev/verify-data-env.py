#!/usr/bin/env python3
"""Verify the data-source settings in `~/.vibe-trading/.env` through the real worker.

The plugin merges `<vibeHome>/.env` into the worker environment at spawn time
(`src/lib/worker.ts`), so a static check of the file is not enough — this probe
exercises the exact path: dotenv values -> worker process -> loader chain, then
prints which loader actually served each representative symbol and whether the
opt-in parquet cache is being written.

Read-only apart from the worker's own cache writes. Run with the runtime venv:

    & "$env:USERPROFILE\\.vibe-trading\\dsh\\venv\\Scripts\\python.exe" `
        scripts/dev/verify-data-env.py
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import sys
import time

from dotenv import dotenv_values

REPO = pathlib.Path(__file__).resolve().parents[2]
VIBE_HOME = pathlib.Path.home() / ".vibe-trading"
VENV_PY = VIBE_HOME / "dsh" / "venv" / "Scripts" / "python.exe"
WORKER = REPO / "worker" / "vibe_trading_worker.py"
CACHE_ROOT = VIBE_HOME / "dsh" / "work" / "cache"

CASES = [
    ("A-share", "600519.SH"),
    ("A-share", "000001.SZ"),
    ("A-share ETF", "510300.SH"),
    ("US", "AAPL.US"),
    ("HK", "700.HK"),
    ("index", "^GSPC"),
    ("crypto", "BTC-USDT"),
]

WATCHED_ENV = (
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "MARKET_DATA_ORDER_A_SHARE",
    "MARKET_DATA_ORDER_HK_EQUITY",
    "MARKET_DATA_ORDER_US_EQUITY",
    "VIBE_TRADING_DATA_CACHE",
    "VIBE_TRADING_EASTMONEY_MIN_INTERVAL",
    "CCXT_EXCHANGE",
)


def main() -> int:
    dotenv = {key: value for key, value in dotenv_values(VIBE_HOME / ".env").items() if value is not None}
    # Mirror worker.ts: <vibeHome>/.env -> host process env -> mandatory overrides.
    env = {
        **dotenv,
        **os.environ,
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "VIBE_TRADING_HOME": str(VIBE_HOME),
        "VIBE_TRADING_DATA_CACHE_ROOT": str(CACHE_ROOT),
    }
    print("== env seen by the worker ==")
    for key in WATCHED_ENV:
        value = env.get(key)
        print(f"  {key:34s} {value if value is not None else '(unset)'}")

    child = subprocess.Popen(
        [str(VENV_PY), str(WORKER), "--cwd", str(REPO)],
        cwd=str(REPO), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    request_id = 0

    def rpc(method: str, params: dict | None = None, timeout: float = 180.0) -> dict:
        nonlocal request_id
        request_id += 1
        request = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        child.stdin.write(json.dumps(request) + "\n")
        child.stdin.flush()
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = child.stdout.readline()
            if not line:
                if child.poll() is not None:
                    raise RuntimeError(f"worker exited rc={child.returncode}")
                continue
            line = line.strip()
            if not line:
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") == request["id"]:
                if "error" in message:
                    raise RuntimeError(f"rpc error: {message['error']}")
                return message.get("result") or {}
        raise TimeoutError(method)

    failures = 0
    try:
        started = time.time()
        ping = rpc("ping")
        tools = ping.get("tools") if isinstance(ping, dict) else None
        count = tools.get("total") if isinstance(tools, dict) else tools
        print(f"\nworker ready in {time.time()-started:.1f}s (tools={count})")

        print("\n== get_market_data(source=auto) ==")
        for label, symbol in CASES:
            started = time.time()
            result = rpc("tools/call", {
                "name": "get_market_data",
                "arguments": {
                    "codes": [symbol], "start_date": "2026-01-01", "end_date": "2026-11-12",
                    "interval": "1D", "max_rows": 0, "source": "auto",
                },
            })
            elapsed = time.time() - started
            payload = result.get("json") or {}
            if payload.get("status") == "error":
                failures += 1
                diag = payload.get("_diagnostics", {}).get(symbol, {})
                attempts = [item.get("source") for item in diag.get("attempts", [])]
                print(f"  {label:12s} {symbol:10s} FAIL {elapsed:6.2f}s attempts={attempts}")
                continue
            rows = payload.get(symbol)
            if isinstance(rows, dict):
                rows = rows.get("data", [])
            prov = (payload.get("_provenance") or {}).get(symbol, {})
            print(f"  {label:12s} {symbol:10s} ok   {elapsed:6.2f}s rows={len(rows):3d} "
                  f"served={prov.get('source')} adj={prov.get('adjustment')} "
                  f"last={rows[-1]['trade_date'][:10] if rows else '-'}")

        print(f"\n== cache ({CACHE_ROOT}) ==")
        files = sorted(CACHE_ROOT.rglob("*.parquet")) if CACHE_ROOT.exists() else []
        print(f"  parquet entries: {len(files)}")
        for item in files[:8]:
            print("   ", item.relative_to(CACHE_ROOT))
    finally:
        try:
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 9999, "method": "shutdown"}) + "\n")
            child.stdin.flush()
            time.sleep(0.3)
        except Exception:  # noqa: BLE001
            pass
        child.kill()

    print("\nRESULT:", "all representative symbols served" if failures == 0 else f"{failures} symbol(s) failed")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
