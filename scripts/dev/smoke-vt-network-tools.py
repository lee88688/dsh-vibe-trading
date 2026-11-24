#!/usr/bin/env python3
"""Smoke-test the worker's network-backed tools under the current `~/.vibe-trading/.env`.

`get_market_data` is covered by `verify-data-env.py`; this one covers the rest of
the tool surface, so a proxy / NO_PROXY change can be checked for regressions:
CN sources must stay direct (NO_PROXY), overseas sources must keep working
(through the proxy), and credential-gated tools must fail with a config error
rather than a network error.

Run with the runtime venv:

    & "$env:USERPROFILE\\.vibe-trading\\dsh\\venv\\Scripts\\python.exe" `
        scripts/dev/smoke-vt-network-tools.py
"""
from __future__ import annotations

import json
import os
import pathlib
import subprocess
import time

from dotenv import dotenv_values

REPO = pathlib.Path(__file__).resolve().parents[2]
VIBE_HOME = pathlib.Path.home() / ".vibe-trading"
VENV_PY = VIBE_HOME / "dsh" / "venv" / "Scripts" / "python.exe"
WORKER = REPO / "worker" / "vibe_trading_worker.py"

# (label, tool, arguments, expected)  expected: "ok" or "needs-config"
CASES = [
    ("CN 搜索", "search_symbol", {"query": "AAPL", "limit": 3}, "ok"),
    ("CN 个股新闻", "get_stock_news", {"code": "AAPL.US", "limit": 3}, "ok"),
    ("CN 财报", "get_financial_statements", {"code": "600519.SH", "limit": 2}, "ok"),
    ("海外 SEC", "get_sec_filings", {"ticker": "AAPL", "limit": 2}, "ok"),
    ("海外 公司概况", "get_stock_profile", {"ticker": "AAPL.US"}, "ok"),
    ("海外 订单簿", "orderbook_depth", {"symbol": "BTC-USDT", "levels": 3}, "ok"),
    ("海外 论文", "research_papers", {"mode": "search", "query": "momentum", "max_results": 2}, "ok"),
    ("海外 预测市场", "prediction_market", {"mode": "search", "query": "election", "limit": 2}, "ok"),
    ("海外 恐慌贪婪", "sentiment", {"mode": "fear_greed_index"}, "ok"),
    ("本地 文本情绪", "sentiment", {"mode": "sentiment_score", "text": "strong earnings beat"}, "ok"),
    ("海外 FRED", "get_macro_series", {"series_id": "CPIAUCSL"}, "needs-config"),
    ("CN Gildata 公告", "get_cn_announcements", {"query": "贵州茅台 2025 分红公告", "limit": 3}, "needs-config"),
    ("CN Gildata 宏观", "get_cn_macro_series", {"query": "2026年10月中国CPI同比", "limit": 5}, "needs-config"),
    ("CN Gildata 基金", "get_fund_nav", {"funds": ["110022"]}, "needs-config"),
]


def main() -> int:
    dotenv = {key: value for key, value in dotenv_values(VIBE_HOME / ".env").items() if value is not None}
    env = {
        **dotenv,
        **os.environ,
        "PYTHONUTF8": "1",
        "PYTHONIOENCODING": "utf-8",
        "VIBE_TRADING_HOME": str(VIBE_HOME),
        "VIBE_TRADING_DATA_CACHE_ROOT": str(VIBE_HOME / "dsh" / "work" / "cache"),
    }
    child = subprocess.Popen(
        [str(VENV_PY), str(WORKER), "--cwd", str(REPO)],
        cwd=str(REPO), env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1,
    )
    counter = 0

    def rpc(method: str, params: dict | None = None, timeout: float = 180.0) -> dict:
        nonlocal counter
        counter += 1
        request = {"jsonrpc": "2.0", "id": counter, "method": method, "params": params or {}}
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
            if message.get("id") == counter:
                if "error" in message:
                    raise RuntimeError(str(message["error"])[:400])
                return message.get("result") or {}
        raise TimeoutError(method)

    failures = 0
    try:
        started = time.time()
        rpc("ping")
        print(f"worker ready in {time.time()-started:.1f}s")
        print(f"{'label':18s} {'ok':3s} {'secs':>6s} note")
        for label, tool, arguments, expected in CASES:
            started = time.time()
            try:
                result = rpc("tools/call", {"name": tool, "arguments": arguments})
                elapsed = time.time() - started
                payload = result.get("json") if isinstance(result.get("json"), dict) else {}
                error_text = str(payload.get("error") or "") if payload.get("error") else ""
                if error_text:
                    status = "cfg" if expected == "needs-config" else "ERR"
                    note = error_text[:110]
                    if expected == "ok":
                        failures += 1
                else:
                    status = "ok"
                    note = f"keys={list(payload)[:5]}" if payload else (result.get("text") or "")[:80]
                print(f"{label:18s} {status:3s} {elapsed:6.2f}s {note[:120]}")
            except Exception as exc:  # noqa: BLE001
                failures += 1
                print(f"{label:18s} EXC {time.time()-started:6.2f}s {type(exc).__name__}: {str(exc)[:110]}")
    finally:
        try:
            child.stdin.write(json.dumps({"jsonrpc": "2.0", "id": 9999, "method": "shutdown"}) + "\n")
            child.stdin.flush()
            time.sleep(0.3)
        except Exception:  # noqa: BLE001
            pass
        child.kill()

    print("\nRESULT:", "ok" if failures == 0 else f"{failures} unexpected failure(s)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
