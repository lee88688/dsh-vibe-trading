#!/usr/bin/env python3
"""Probe which market-data sources actually serve K-lines on this machine.

Runs the same two layers the plugin worker uses, in this order:

1. ``--network`` (default on): plain HTTP reachability of every upstream host the
   loaders hit. This separates "the source is blocked/rate-limited" from "the
   loader is broken".
2. Coverage: calls ``src.market_data.fetch_market_data_json`` (the exact function
   behind ``get_market_data``) for one representative symbol per market and
   prints what actually served each one, plus the price caliber.

The output is deliberately factual: every row is a real request made by this
run, with its own latency. Nothing is cached, so re-running after a fix (proxy,
baostock install, key added) shows the delta.

Usage (runtime venv, not the repo dev venv)::

    python scripts/dev/probe-market-data.py
    HTTPS_PROXY=http://127.0.0.1:7890 python scripts/dev/probe-market-data.py
    python scripts/dev/probe-market-data.py --network-only
    python scripts/dev/probe-market-data.py --symbols AAPL.US,600519.SH

Read-only: no files are written, no plugin/worker state is touched.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_VENV_PY = Path.home() / ".vibe-trading" / "dsh" / "venv" / "Scripts" / "python.exe"

# Upstream hosts each loader family depends on. ``expect`` documents what a
# healthy network looks like, so a green run is unambiguous.
ENDPOINTS = [
    ("yahoo", "https://query1.finance.yahoo.com/v8/finance/chart/AAPL?interval=1d&range=5d",
     "primary US/HK/CA/UK/BR/index source"),
    ("yahoo-search", "https://query2.finance.yahoo.com/v1/finance/search?q=AAPL",
     "symbol search (identity lock)"),
    ("stooq", "https://stooq.com/q/d/l/?s=aapl.us&i=d", "US EOD fallback"),
    ("sina-us", "https://stock.finance.sina.com.cn/usstock/api/jsonp_v2.php/var%20x=/US_MinKService.getDailyK?symbol=AAPL",
     "US daily fallback (raw prices)"),
    ("sina-cn", "https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=sh600519&scale=240&ma=no&datalen=5",
     "A-share daily (NOT wired into any loader)"),
    ("tencent", "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,2026-10-01,2026-11-13,5,qfq",
     "A-share/HK primary (can return an anti-bot 501)"),
    ("tencent-quote", "https://qt.gtimg.cn/q=sh600519", "A-share realtime quote host"),
    ("eastmoney", "https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1,f2&fields2=f51,f53&klt=101&fqt=1&beg=20261101&end=20261113",
     "A-share/HK/US fallback (IP rate-limit -> RemoteDisconnected)"),
    ("baostock:10030", "tcp://www.baostock.com:10030", "A-share fallback (needs `pip install baostock`)"),
    ("okx", "https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1D&limit=2", "crypto primary"),
    ("binance", "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2", "crypto fallback"),
    ("binance-vision", "https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1d&limit=2",
     "crypto public data host (works from CN; NOT wired into any loader)"),
    ("tushare", "https://api.tushare.pro", "A-share key-gated (needs token)"),
]

# One representative symbol per market, matching the loader registry's chains.
COVERAGE = [
    ("AAPL.US", "us_equity", "yahoo -> stooq -> sina -> eastmoney -> yfinance"),
    ("600519.SH", "a_share", "tencent -> eastmoney -> baostock -> akshare -> tushare"),
    ("510300.SH", "a_share(etf)", "akshare (sina-backed fund_etf_hist_sina)"),
    ("700.HK", "hk_equity", "tencent -> eastmoney -> yahoo -> futu -> akshare"),
    ("BTC-USDT", "crypto", "okx -> binance -> ccxt -> yfinance"),
    ("^GSPC", "index", "yahoo -> yfinance"),
    ("TD.TO", "ca_equity", "yahoo -> yfinance"),
    ("VOD.L", "uk_equity", "yahoo -> yfinance"),
    ("EUR/USD", "forex", "mt5 -> akshare -> yfinance"),
    ("RB0", "futures", "akshare (sina futures)"),
]


def _http_status(url: str, timeout: float = 12.0) -> str:
    """Return a one-line verdict for *url* (HTTP status, tcp verdict, or error)."""
    if url.startswith("tcp://"):
        import socket

        host, _, port = url[6:].partition(":")
        sock = socket.socket()
        sock.settimeout(timeout)
        try:
            sock.connect((host, int(port or 80)))
            return "tcp open"
        except Exception as exc:  # noqa: BLE001
            return f"tcp fail ({type(exc).__name__})"
        finally:
            sock.close()

    import requests

    try:
        response = requests.get(
            url,
            timeout=timeout,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36"
            },
        )
        body = response.text[:120].replace("\n", " ")
        return f"HTTP {response.status_code} {body[:70]!r}"
    except Exception as exc:  # noqa: BLE001
        return f"FAIL {type(exc).__name__}: {str(exc)[:90]}"


def probe_network(only: set[str] | None = None) -> None:
    """Print reachability for every upstream host."""
    proxy = os.environ.get("HTTPS_PROXY") or os.environ.get("https_proxy")
    print(f"\n== network reachability (proxy={proxy or 'none'}) ==")
    for name, url, why in ENDPOINTS:
        if only and name not in only:
            continue
        started = time.time()
        verdict = _http_status(url)
        print(f"{name:15s} {time.time() - started:5.2f}s  {verdict}")
        print(f"{'':15s}          ({why})")


def probe_coverage(symbols: list[str] | None = None) -> None:
    """Call the loader layer per market and report the serving source."""
    try:
        from src.market_data import fetch_market_data_json
    except ImportError:
        print(
            "\n[skip] cannot import src.market_data — run with the runtime venv python:\n"
            f"       {DEFAULT_VENV_PY}",
            file=sys.stderr,
        )
        return

    cases = [case for case in COVERAGE if not symbols or case[0] in symbols]
    print("\n== get_market_data coverage (source=auto, 1D, 2026-09-01..2026-11-13) ==")
    print(f"{'symbol':11s} {'market':13s} {'ok':3s} {'served':10s} {'caliber':24s} {'rows':>5s} {'last':11s} {'secs':>6s}")
    good = 0
    for symbol, market, chain in cases:
        started = time.time()
        try:
            raw = fetch_market_data_json(
                codes=[symbol],
                start_date="2026-09-01",
                end_date="2026-11-13",
                source="auto",
                interval="1D",
                max_rows=0,
                include_provenance=True,
            )
            payload = json.loads(raw)
            elapsed = time.time() - started
            if payload.get("status") == "error":
                diag = payload.get("_diagnostics", {}).get(symbol, {})
                attempted = ",".join(a.get("source", "?") for a in diag.get("attempts", []))
                print(f"{symbol:11s} {market:13s} {'NO':3s} {'-':10s} {'-':24s} {0:5d} {'-':11s} {elapsed:6.2f}")
                print(f"{'':11s}          attempts: {attempted}")
                continue
            rows = payload.get(symbol) or []
            if isinstance(rows, dict):
                rows = rows.get("data", [])
            prov = (payload.get("_provenance") or {}).get(symbol, {})
            caliber = f"adj={prov.get('adjustment')} vol={prov.get('volume_unit')}"
            last = rows[-1].get("trade_date", "")[:10] if rows else "-"
            good += 1
            print(
                f"{symbol:11s} {market:13s} {'ok':3s} {str(prov.get('source')):10s} "
                f"{caliber:24s} {len(rows):5d} {last:11s} {elapsed:6.2f}"
            )
            if prov.get("fallback_used"):
                print(f"{'':11s}          (fallback: requested={prov.get('requested_source')} "
                      f"detected={prov.get('detected_source')})")
        except Exception as exc:  # noqa: BLE001
            print(f"{symbol:11s} {market:13s} EXC {type(exc).__name__}: {str(exc)[:70]}")
    print(f"\nserved {good}/{len(cases)} representative symbols")
    print("chain reference:")
    for symbol, market, chain in cases:
        print(f"  {symbol:11s} {market:13s} {chain}")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--network-only", action="store_true", help="probe upstream hosts only")
    parser.add_argument("--coverage-only", action="store_true", help="probe loader coverage only")
    parser.add_argument("--symbols", default="", help="comma-separated subset of COVERAGE symbols")
    parser.add_argument("--endpoint", action="append", default=[], help="limit --network to these names (repeatable)")
    args = parser.parse_args(argv)

    symbols = [item.strip() for item in args.symbols.split(",") if item.strip()]
    only = set(args.endpoint) or None
    if not args.coverage_only:
        probe_network(only)
    if not args.network_only:
        probe_coverage(symbols or None)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
