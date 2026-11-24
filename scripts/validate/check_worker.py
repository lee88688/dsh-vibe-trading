#!/usr/bin/env python3
"""Validate worker/vibe_trading_worker.py end-to-end against the installed package.

Spawns the worker with the project venv's python and walks the whole protocol:
ping (startup timing), tools/list (count + schema size), two real read-only data
calls, the lenient-JSON-argument path, an unknown-tool negative test, the skills
API (list, small skill, >8k-char skill with outline/offset/section), a
concurrency check that proves a long tool does not block a ping, and shutdown.

Every step prints PASS/FAIL; the process exits non-zero if any step fails and
writes a machine-readable summary next to this file (worker-check.json).

Usage:
  uv run python scripts/validate/check_worker.py
  uv run python scripts/validate/check_worker.py --no-network   # skip data calls
"""

from __future__ import annotations

import pathlib

import argparse
import csv
import datetime as dt
import json
import math
import os
import queue
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
INSTALLED_PYTHON = Path.home() / ".vibe-trading" / "dsh" / "venv" / "Scripts" / "python.exe"
DEV_VENV = REPO / ".venv"


def _dev_python() -> Path:
    for candidate in (DEV_VENV / "Scripts" / "python.exe", DEV_VENV / "bin" / "python3", DEV_VENV / "bin" / "python"):
        if candidate.is_file():
            return candidate
    return DEV_VENV / "bin" / "python"


# Prefer the environment the plugin actually spawns; fall back to the uv dev venv.
DEFAULT_PYTHON = INSTALLED_PYTHON if INSTALLED_PYTHON.is_file() else _dev_python()
DEFAULT_WORKER = REPO / "worker" / "vibe_trading_worker.py"
# Scratch cwd for worker runs: truncated results are persisted under <cwd>/results.
DEFAULT_WORKDIR = REPO / ".tmp" / "worker-validate"
FIXTURES = REPO / "scripts" / "validate" / "fixtures"
PATTERN_RUN = FIXTURES / "pattern-run"
OUT_JSON = Path(__file__).resolve().parent / "worker-check.json"

# MCP-only tool names the worker serves as virtual tools (the 6 swarm tools are
# dropped by design: DSH subagents replace swarm).
EXPECTED_VIRTUAL = {
    "pattern_recognition",
    "analyze_options",
    "analyze_options_payoff",
    "get_macro_series",
    "get_fund_nav",
    "get_cn_macro_series",
    "get_cn_announcements",
    "search_broker_reports",
    "iwencai_search",
}

# tool -> (arguments, env var whose absence must produce the not-available error)
KEY_GATED_CASES = [
    ("get_macro_series", {"series_id": "CPIAUCSL", "limit": 5}, "FRED_API_KEY"),
    ("get_fund_nav", {"funds": ["110022"], "limit": 5}, "GILDATA_TOKEN"),
    ("get_cn_macro_series", {"query": "CPI", "limit": 5}, "GILDATA_TOKEN"),
    ("get_cn_announcements", {"query": "分红公告", "limit": 5}, "GILDATA_TOKEN"),
    ("search_broker_reports", {"query": "白酒", "limit": 5}, "GILDATA_TOKEN"),
    ("iwencai_search", {"query": "市盈率低于15的银行股", "limit": 5}, "VIBE_TRADING_IWENCAI_KEY"),
]

_OUTLINE_LINE_RE = re.compile(r"^\s*-\s+(?P<label>.+?)\s+\((?P<chars>[\d,]+)\s+chars\)")
_WARN_RE = re.compile(r"\b(WARNING|ERROR|CRITICAL|Traceback|failed)\b", re.IGNORECASE)


class WorkerError(RuntimeError):
    """A protocol-level failure (timeout, closed pipe, malformed frame)."""


class WorkerClient:
    """Minimal JSON-RPC-over-stdio client for the worker."""

    def __init__(self, cmd: list[str], cwd: Path, env: dict[str, str]) -> None:
        Path(cwd).mkdir(parents=True, exist_ok=True)
        self.proc = subprocess.Popen(
            cmd,
            cwd=str(cwd),
            env=env,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
        )
        self._next_id = 0
        self._pending: dict[object, queue.Queue] = {}
        self._lock = threading.Lock()
        self.stderr_lines: list[str] = []
        self.stdout_noise: list[str] = []
        self._closed = False
        self._reader = threading.Thread(target=self._read_stdout, daemon=True)
        self._reader.start()
        self._stderr_reader = threading.Thread(target=self._read_stderr, daemon=True)
        self._stderr_reader.start()

    # -- plumbing ---------------------------------------------------------
    def _read_stdout(self) -> None:
        assert self.proc.stdout is not None
        for raw in iter(self.proc.stdout.readline, b""):
            text = raw.decode("utf-8", "replace").strip()
            if not text:
                continue
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                self.stdout_noise.append(text[:300])
                continue
            rid = msg.get("id") if isinstance(msg, dict) else None
            with self._lock:
                box = self._pending.get(rid)
            if box is not None:
                box.put(msg)
            else:
                self.stdout_noise.append(text[:300])

    def _read_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            line = raw.decode("utf-8", "replace").rstrip("\r\n")
            if line:
                self.stderr_lines.append(line)

    def send(self, method: str, params: dict | None = None) -> int:
        if self.proc.stdin is None:
            raise WorkerError("stdin closed")
        self._next_id += 1
        rid = self._next_id
        msg = {"jsonrpc": "2.0", "id": rid, "method": method}
        if params is not None:
            msg["params"] = params
        box: queue.Queue = queue.Queue(maxsize=1)
        with self._lock:
            self._pending[rid] = box
        payload = json.dumps(msg, ensure_ascii=False).encode("utf-8") + b"\n"
        try:
            self.proc.stdin.write(payload)
            self.proc.stdin.flush()
        except (BrokenPipeError, OSError) as exc:
            raise WorkerError(f"worker stdin closed while sending {method}: {exc}") from exc
        return rid

    def wait(self, rid: int, timeout: float) -> dict:
        with self._lock:
            box = self._pending.get(rid)
        if box is None:
            raise WorkerError(f"unknown request id {rid}")
        try:
            msg = box.get(timeout=timeout)
        except queue.Empty as exc:
            raise WorkerError(
                f"timeout after {timeout}s waiting for id={rid}; "
                f"stderr_tail={self.stderr_lines[-4:]!r}"
            ) from exc
        finally:
            with self._lock:
                self._pending.pop(rid, None)
        return msg

    def request(self, method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
        rid = self.send(method, params)
        return self.wait(rid, timeout)

    # -- teardown ---------------------------------------------------------
    def close(self, timeout: float = 15.0) -> int | None:
        if self._closed:
            return self.proc.returncode
        self._closed = True
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            return self.proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            return self.proc.wait(timeout=10)


class Report:
    """Collects PASS/FAIL steps and prints the compact summary."""

    def __init__(self) -> None:
        self.steps: list[dict] = []
        self.started = time.perf_counter()

    def check(self, name: str, ok: bool, detail: str = "", elapsed: float | None = None) -> bool:
        row = {
            "step": name,
            "ok": bool(ok),
            "detail": detail,
            "elapsed_sec": round(elapsed, 3) if elapsed is not None else None,
        }
        self.steps.append(row)
        mark = "PASS" if ok else "FAIL"
        timing = f"{elapsed:7.2f}s" if elapsed is not None else " " * 8
        print(f"  {mark}  {name:<26} {timing}  {detail}")
        return bool(ok)

    @property
    def ok(self) -> bool:
        return all(s["ok"] for s in self.steps)

    @property
    def passed(self) -> int:
        return sum(1 for s in self.steps if s["ok"])


def _child_env() -> dict[str, str]:
    env = dict(os.environ)
    home = REPO / ".tmp" / "check-worker-home"
    home.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "MPLBACKEND": "Agg",
            # Keep every runtime artefact inside the workspace.
            "VIBE_TRADING_HOME": str(home),
        }
    )
    # pattern_recognition only accepts run dirs under an allowed root; the
    # fixture lives next to this script, so whitelist it explicitly.
    roots = [r for r in (env.get("VIBE_TRADING_ALLOWED_RUN_ROOTS", "").strip(), str(FIXTURES)) if r]
    env["VIBE_TRADING_ALLOWED_RUN_ROOTS"] = ",".join(roots)
    # Prove the data tools do not need credentials.
    for key in (
        "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "DEEPSEEK_API_KEY", "TUSHARE_TOKEN",
        "FRED_API_KEY", "TIINGO_API_KEY", "ALPHAVANTAGE_API_KEY", "FINNHUB_API_KEY",
        "FMP_API_KEY", "GILDATA_TOKEN", "VIBE_TRADING_IWENCAI_KEY",
    ):
        if key in env:
            env[key] = ""
    return env


def _fmt_sec(value) -> str:
    """Format an optional duration for the summary line."""
    return f"{value:.2f}s" if isinstance(value, (int, float)) else "n/a"


def _first_outline_label(outline: str) -> str | None:
    for line in (outline or "").splitlines():
        match = _OUTLINE_LINE_RE.match(line)
        if match:
            return match.group("label").strip()
    return None


def _no_truncate_check(py: Path, worker: Path, args, report: Report, summary: dict) -> None:
    """Prove ``--no-truncate`` delivers the full result (second short-lived worker)."""
    client = WorkerClient(
        [str(py), str(worker), "--no-truncate", "--session-id", args.session_id, "--cwd", str(DEFAULT_WORKDIR)],
        cwd=DEFAULT_WORKDIR,
        env=_child_env(),
    )
    try:
        client.request("ping", timeout=args.startup_timeout)
        today = dt.date.today()
        big_args = {
            "codes": ["AAPL.US"],
            "start_date": (today - dt.timedelta(days=1000)).isoformat(),
            "end_date": today.isoformat(),
            "source": "auto",
            "interval": "1D",
            "max_rows": 0,
        }
        t0 = time.perf_counter()
        big = client.request(
            "tools/call", {"name": "get_market_data", "arguments": big_args},
            timeout=args.timeout,
        )
        elapsed = time.perf_counter() - t0
        res = big.get("result") or {}
        report.check(
            "--no-truncate flag",
            res.get("truncated") is False
            and res.get("delivered_chars") == res.get("chars")
            and (res.get("chars") or 0) > 10_000,
            f"chars={(res.get('chars') or 0):,} delivered={(res.get('delivered_chars') or 0):,} "
            f"truncated={res.get('truncated')}",
            elapsed,
        )
        summary["no_truncate"] = {
            "chars": res.get("chars"),
            "delivered_chars": res.get("delivered_chars"),
            "truncated": res.get("truncated"),
        }
    finally:
        try:
            client.request("shutdown", timeout=20)
        except WorkerError:
            pass
        client.close(timeout=20)


def _ensure_pattern_fixture() -> Path:
    """Write the deterministic OHLCV fixture the pattern check needs.

    ``pattern_recognition`` reads ``<run_dir>/artifacts/ohlcv_*.csv`` and only
    accepts run directories under an allowed run root, so the validator
    generates this run itself and whitelists ``scripts/validate/fixtures``.
    """
    arts = PATTERN_RUN / "artifacts"
    arts.mkdir(parents=True, exist_ok=True)
    target = arts / "ohlcv_VTSIM.csv"
    price = 100.0
    with target.open("w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["date", "open", "high", "low", "close", "volume"])
        for i in range(160):
            wave = 6.0 * math.sin(i / 7.0) + 2.5 * math.sin(i / 2.3)
            close = round(price + wave + 0.05 * i, 4)
            open_ = round(close - 0.4 * math.cos(i / 3.0), 4)
            high = round(max(open_, close) + 0.6, 4)
            low = round(min(open_, close) - 0.6, 4)
            writer.writerow(
                [
                    f"2026-{(i // 28) + 1:02d}-{(i % 28) + 1:02d}",
                    open_,
                    high,
                    low,
                    close,
                    1_000_000 + i * 1000,
                ]
            )
    return PATTERN_RUN


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Validate worker/vibe_trading_worker.py")
    ap.add_argument("--python", default=str(DEFAULT_PYTHON))
    ap.add_argument("--worker", default=str(DEFAULT_WORKER))
    ap.add_argument("--json-out", default=str(OUT_JSON))
    ap.add_argument("--session-id", default="validate-session")
    ap.add_argument("--startup-timeout", type=float, default=180.0)
    ap.add_argument("--timeout", type=float, default=120.0)
    ap.add_argument("--no-network", action="store_true", help="skip the live market-data calls")
    args = ap.parse_args(argv)

    py, worker = Path(args.python), Path(args.worker)
    for path, label in ((py, "venv python"), (worker, "worker script")):
        if not path.exists():
            print(f"ERROR: {label} not found: {path}")
            return 2

    report = Report()
    print("== Vibe-Trading worker validation ==")
    print(f"  python: {py}")
    print(f"  worker: {worker}")
    print(f"  cwd   : {REPO}")
    print("")

    t_spawn = time.perf_counter()
    client = WorkerClient(
        [str(py), str(worker), "--session-id", args.session_id, "--cwd", str(DEFAULT_WORKDIR)],
        cwd=DEFAULT_WORKDIR,
        env=_child_env(),
    )
    summary: dict = {}

    try:
        # 1) ping -- this wall time is the cold startup of the worker.
        ping = client.request("ping", timeout=args.startup_timeout)
        startup = time.perf_counter() - t_spawn
        body = ping.get("result") or {}
        report.check(
            "ping / startup",
            bool(body.get("ok")) and ping.get("error") is None,
            f"tools={body.get('tools')} lean_used={body.get('lean_used')} "
            f"loop_imported={body.get('loop_imported')} "
            f"langchain={body.get('langchain_imported')}",
            startup,
        )
        report.check(
            "lean import path",
            # mcp_server must never be imported: that is the 3.9 s MCP stack the
            # virtual tools exist to avoid. fastmcp itself IS imported by
            # src.tools.mcp during registry build (pre-existing, ~0.9 s), so it
            # is reported, not asserted.
            bool(body.get("lean_used"))
            and not body.get("loop_imported")
            and not body.get("mcp_server_imported"),
            f"path={body.get('startup', {}).get('path')} "
            f"import={body.get('startup', {}).get('import_sec')}s "
            f"build={body.get('startup', {}).get('build_sec')}s "
            f"mcp_server={body.get('mcp_server_imported')} "
            f"fastmcp={body.get('fastmcp_imported')} "
            f"fallback={body.get('startup', {}).get('fallback_reason') or 'none'}",
        )
        summary["signature"] = {
            "worker_version": body.get("worker_version"),
            "vibe_trading_version": body.get("vibe_trading_version"),
            "python": body.get("python"),
            "lean_used": body.get("lean_used"),
            "loop_imported": body.get("loop_imported"),
            "langchain_imported": body.get("langchain_imported"),
            "max_chars": body.get("max_chars"),
        }
        summary["startup_sec"] = round(startup, 3)
        summary["startup_breakdown"] = body.get("startup")
        summary["worker_ping"] = body

        # 2) tools/list
        t0 = time.perf_counter()
        listing = client.request("tools/list", timeout=args.timeout)
        elapsed = time.perf_counter() - t0
        tools = (listing.get("result") or {}).get("tools") or []
        names = [t.get("name") for t in tools]
        schema_chars = (listing.get("result") or {}).get("schema_chars") or 0
        missing_fields = [
            t.get("name")
            for t in tools
            if not all(k in t for k in ("name", "description", "inputSchema", "readonly", "repeatable"))
        ]
        expected = {"search_symbol", "get_market_data", "load_skill", "get_fundamentals", "backtest"}
        absent = sorted(expected - set(names))
        report.check(
            "tools/list",
            len(tools) > 0 and not missing_fields and not absent and len(names) == len(set(names)),
            f"count={len(tools)} schema_chars={schema_chars:,} "
            f"readonly={sum(1 for t in tools if t.get('readonly'))} "
            f"missing_fields={len(missing_fields)} absent={absent or 'none'}",
            elapsed,
        )
        summary["tool_count"] = len(tools)
        summary["schema_chars"] = schema_chars
        summary["tools_list_sec"] = round(elapsed, 3)
        summary["readonly_count"] = sum(1 for t in tools if t.get("readonly"))
        summary["duplicate_tool_names"] = len(names) - len(set(names))
        listing_result = listing.get("result") or {}
        summary["registry_count"] = listing_result.get("registry_count")
        summary["virtual_count"] = listing_result.get("virtual_count")

        # 3) tools/call search_symbol
        t0 = time.perf_counter()
        call = client.request(
            "tools/call", {"name": "search_symbol", "arguments": {"query": "Apple", "limit": 3}},
            timeout=args.timeout,
        )
        elapsed = time.perf_counter() - t0
        res = call.get("result") or {}
        payload = res.get("json") or {}
        candidates = ((payload.get("data") or {}).get("candidates") or []) if isinstance(payload, dict) else []
        report.check(
            "tools/call search_symbol",
            not call.get("error") and not res.get("isError") and bool(candidates),
            f"chars={res.get('chars')} elapsed={res.get('elapsed_sec')}s "
            f"first={candidates[0].get('symbol') if candidates else 'none'}",
            elapsed,
        )
        summary["call_search_symbol_sec"] = round(elapsed, 3)
        summary["search_symbol_first"] = candidates[0].get("symbol") if candidates else None

        today = dt.date.today()
        start = today - dt.timedelta(days=21)
        md_args = {
            "codes": ["AAPL.US"],
            "start_date": start.isoformat(),
            "end_date": today.isoformat(),
            "source": "auto",
            "interval": "1D",
            "max_rows": 4,
        }

        if not args.no_network:
            # 4) tools/call get_market_data (real, read-only, no credentials)
            t0 = time.perf_counter()
            call = client.request(
                "tools/call", {"name": "get_market_data", "arguments": md_args}, timeout=args.timeout
            )
            elapsed = time.perf_counter() - t0
            res = call.get("result") or {}
            payload = res.get("json") or {}
            series = payload.get("AAPL.US") if isinstance(payload, dict) else None
            rows = (series or {}).get("data") or []
            provenance = ((payload.get("_provenance") or {}).get("AAPL.US") or {}) if isinstance(payload, dict) else {}
            report.check(
                "tools/call get_market_data",
                not call.get("error") and not res.get("isError") and bool(rows),
                f"rows={len(rows)} source={provenance.get('source')} "
                f"adj={provenance.get('adjustment')} chars={res.get('chars')}",
                elapsed,
            )
            summary["call_get_market_data_sec"] = round(elapsed, 3)
            summary["market_data_source"] = provenance.get("source")

            # 5) lenient arguments: a list parameter sent as a JSON string
            lenient_args = dict(md_args)
            lenient_args["codes"] = json.dumps(md_args["codes"])  # '["AAPL.US"]'
            t0 = time.perf_counter()
            call = client.request(
                "tools/call", {"name": "get_market_data", "arguments": lenient_args},
                timeout=args.timeout,
            )
            elapsed = time.perf_counter() - t0
            res = call.get("result") or {}
            payload = res.get("json") or {}
            rows = ((payload.get("AAPL.US") or {}).get("data") or []) if isinstance(payload, dict) else []
            report.check(
                "lenient JSON-string arg",
                not call.get("error") and not res.get("isError") and bool(rows),
                f"codes-as-string accepted, rows={len(rows)}",
                elapsed,
            )
            summary["call_lenient_sec"] = round(elapsed, 3)

            # 5b) truncation: a >100k-char result is capped at 10k with a notice
            big_args = {
                "codes": ["AAPL.US"],
                "start_date": (today - dt.timedelta(days=1000)).isoformat(),
                "end_date": today.isoformat(),
                "source": "auto",
                "interval": "1D",
                "max_rows": 0,
            }
            t0 = time.perf_counter()
            big = client.request(
                "tools/call", {"name": "get_market_data", "arguments": big_args},
                timeout=args.timeout,
            )
            elapsed = time.perf_counter() - t0
            res = big.get("result") or {}
            text = res.get("text") or ""
            report.check(
                "truncation (10k cap)",
                bool(res.get("truncated"))
                and (res.get("delivered_chars") or 0) <= 10_000
                and "[TRUNCATED:" in text
                and bool(res.get("full_path"))
                and pathlib.Path(str(res.get("full_path"))).is_file(),
                f"chars={(res.get('chars') or 0):,} delivered={(res.get('delivered_chars') or 0):,} "
                f"truncated={res.get('truncated')} notice={'[TRUNCATED:' in text}",
                elapsed,
            )
            summary["truncation"] = {
                "chars": res.get("chars"),
                "delivered_chars": res.get("delivered_chars"),
                "truncated": res.get("truncated"),
                "full_path": res.get("full_path"),
            }

        # 6) unknown tool -> JSON error envelope
        t0 = time.perf_counter()
        bad = client.request(
            "tools/call", {"name": "definitely_not_a_tool", "arguments": {}}, timeout=args.timeout
        )
        elapsed = time.perf_counter() - t0
        err = bad.get("error") or {}
        envelope = (err.get("data") or {}).get("registry_envelope") or {}
        report.check(
            "unknown tool error",
            err.get("code") == -32602 and envelope.get("status") == "error",
            f"code={err.get('code')} envelope_status={envelope.get('status')} "
            f"msg={str(err.get('message'))[:48]}",
            elapsed,
        )
        summary["unknown_tool_error_code"] = err.get("code")

        # 6b) virtual tools: MCP-only names the worker serves itself
        vt = [t for t in tools if t.get("virtual")]
        vt_by_name = {t["name"]: t for t in vt}
        vt_missing = sorted(EXPECTED_VIRTUAL - set(vt_by_name))
        vt_bad_schema = [
            t["name"]
            for t in vt
            if not isinstance(t.get("inputSchema"), dict) or t["inputSchema"].get("type") != "object"
        ]
        flags_ok = (
            all(bool(vt_by_name[n].get("readonly")) for n in EXPECTED_VIRTUAL if n in vt_by_name)
            and vt_by_name.get("pattern_recognition", {}).get("repeatable") is True
            and vt_by_name.get("analyze_options", {}).get("repeatable") is False
            and vt_by_name.get("analyze_options_payoff", {}).get("repeatable") is True
            and vt_by_name.get("iwencai_search", {}).get("repeatable") is True
        )
        counts_ok = (
            listing_result.get("virtual_count") == len(EXPECTED_VIRTUAL)
            and listing_result.get("count") == (listing_result.get("registry_count") or 0) + len(EXPECTED_VIRTUAL)
        )
        report.check(
            "virtual tools registered",
            not vt_missing and not vt_bad_schema and flags_ok and counts_ok,
            f"{len(vt)} virtual (expect {len(EXPECTED_VIRTUAL)}) "
            f"total={listing_result.get('count')} registry={listing_result.get('registry_count')} "
            f"missing={vt_missing or 'none'} bad_schema={vt_bad_schema or 'none'} flags_ok={flags_ok}",
        )

        # 6c) pure-computation virtual tools actually execute
        pattern_run = _ensure_pattern_fixture()
        t0 = time.perf_counter()
        call = client.request(
            "tools/call",
            {"name": "pattern_recognition", "arguments": {"run_dir": str(pattern_run)}},
            timeout=args.timeout,
        )
        elapsed = time.perf_counter() - t0
        res = call.get("result") or {}
        payload = res.get("json") or {}
        results = payload.get("results") if isinstance(payload, dict) else None
        report.check(
            "vt pattern_recognition",
            not call.get("error") and not res.get("isError")
            and isinstance(payload, dict) and payload.get("status") == "ok" and bool(results),
            f"chars={res.get('chars')} series={list(results or {})} "
            f"patterns={len(payload.get('patterns') or []) if isinstance(payload, dict) else 0}",
            elapsed,
        )
        summary["vt_pattern_recognition_sec"] = round(elapsed, 3)

        t0 = time.perf_counter()
        call = client.request(
            "tools/call",
            {"name": "analyze_options", "arguments": {"spot": 100, "strike": 105, "expiry_days": 30}},
            timeout=args.timeout,
        )
        elapsed = time.perf_counter() - t0
        res = call.get("result") or {}
        payload = res.get("json") or {}
        greeks = ("price", "delta", "gamma", "theta", "vega")
        report.check(
            "vt analyze_options",
            not call.get("error") and not res.get("isError")
            and isinstance(payload, dict) and all(k in payload for k in greeks),
            f"price={payload.get('price')} delta={payload.get('delta')} "
            f"gamma={payload.get('gamma')} theta={payload.get('theta')} vega={payload.get('vega')}"
            if isinstance(payload, dict) else "no payload",
            elapsed,
        )
        summary["vt_analyze_options_sec"] = round(elapsed, 3)

        t0 = time.perf_counter()
        call = client.request(
            "tools/call",
            {
                "name": "analyze_options_payoff",
                "arguments": {
                    "legs": [
                        {"option_type": "call", "strike": 105, "qty": 1, "premium": 2.5},
                        {"option_type": "call", "strike": 110, "qty": -1, "premium": 1.2},
                    ],
                    "entry_spot": 100,
                    "expiry_days": 30,
                },
            },
            timeout=args.timeout,
        )
        elapsed = time.perf_counter() - t0
        res = call.get("result") or {}
        payload = res.get("json") or {}
        report.check(
            "vt analyze_options_payoff",
            not call.get("error") and not res.get("isError")
            and isinstance(payload, dict) and payload.get("status") == "ok",
            f"chars={res.get('chars')} truncated={res.get('truncated')} "
            f"keys={sorted(payload)[:6] if isinstance(payload, dict) else 'none'}",
            elapsed,
        )
        summary["vt_analyze_options_payoff_sec"] = round(elapsed, 3)

        # 6d) key-gated virtual tools must answer the MCP wrapper's error, not crash
        gated: list[dict] = []
        for tool_name, tool_args, env_var in KEY_GATED_CASES:
            t0 = time.perf_counter()
            call = client.request(
                "tools/call", {"name": tool_name, "arguments": tool_args},
                timeout=args.timeout,
            )
            elapsed = time.perf_counter() - t0
            res = call.get("result") or {}
            payload = res.get("json") or {}
            message = str((payload or {}).get("error", "")) if isinstance(payload, dict) else ""
            matched = (
                not call.get("error")
                and res.get("isError") is True
                and isinstance(payload, dict)
                and payload.get("ok") is False
                and env_var in message
            )
            gated.append(
                {
                    "tool": tool_name,
                    "env_var": env_var,
                    "matched": matched,
                    "isError": res.get("isError"),
                    "error": message[:160],
                    "elapsed_sec": round(elapsed, 3),
                }
            )
        report.check(
            "vt key-gated errors",
            all(g["matched"] for g in gated),
            f"{sum(1 for g in gated if g['matched'])}/{len(gated)} matched: "
            + "; ".join(f"{g['tool']}->{g['error'][:44]}" for g in gated),
        )
        summary["vt_key_gated"] = gated

        # 6e) signature binding rejects bad/unknown virtual arguments
        call = client.request(
            "tools/call",
            {"name": "analyze_options", "arguments": {"spot": 100}},
            timeout=args.timeout,
        )
        err = call.get("error") or {}
        report.check(
            "vt bad arguments rejected",
            err.get("code") == -32602,
            f"code={err.get('code')} msg={str(err.get('message'))[:80]}",
        )

        # 7) skills/list
        t0 = time.perf_counter()
        skills = client.request("skills/list", timeout=args.timeout)
        elapsed = time.perf_counter() - t0
        body = skills.get("result") or {}
        items = body.get("skills") or []
        biggest = max(items, key=lambda s: s.get("chars") or 0) if items else None
        smallest = min(items, key=lambda s: s.get("chars") or 0) if items else None
        report.check(
            "skills/list",
            len(items) > 0 and all({"name", "description", "category", "chars"} <= set(s) for s in items),
            f"count={body.get('count')} largest={biggest.get('name') if biggest else None}"
            f"({biggest.get('chars') if biggest else 0:,}c) "
            f"smallest={smallest.get('name') if smallest else None}"
            f"({smallest.get('chars') if smallest else 0:,}c)",
            elapsed,
        )
        summary["skill_count"] = body.get("count")
        summary["largest_skill"] = (
            {"name": biggest.get("name"), "chars": biggest.get("chars")} if biggest else None
        )

        # 8) skills/load: a small skill is returned whole
        if smallest:
            t0 = time.perf_counter()
            loaded = client.request(
                "skills/load", {"name": smallest["name"]}, timeout=args.timeout
            )
            elapsed = time.perf_counter() - t0
            res = loaded.get("result") or {}
            payload = res.get("json") or {}
            report.check(
                "skills/load small",
                not loaded.get("error") and payload.get("status") == "ok"
                and payload.get("complete") is True,
                f"{smallest['name']} mode={payload.get('mode')} "
                f"complete={payload.get('complete')} chars={res.get('chars')}",
                elapsed,
            )

        # 9) skills/load: >8k-char skill returns an outline, then pages by offset
        if biggest and (biggest.get("chars") or 0) > 8000:
            t0 = time.perf_counter()
            loaded = client.request(
                "skills/load", {"name": biggest["name"]}, timeout=args.timeout
            )
            elapsed = time.perf_counter() - t0
            res = loaded.get("result") or {}
            payload = res.get("json") or {}
            outline = payload.get("outline") or ""
            label = _first_outline_label(outline)
            report.check(
                "skills/load outline (>8k)",
                not loaded.get("error")
                and payload.get("status") == "ok"
                and payload.get("mode") == "outline"
                and bool(outline)
                and payload.get("next_offset"),
                f"{biggest['name']} mode={payload.get('mode')} "
                f"sections={payload.get('section_count')} "
                f"next_offset={payload.get('next_offset')} label={label!r}",
                elapsed,
            )
            summary["outline_mode"] = payload.get("mode")

            next_offset = payload.get("next_offset")
            if next_offset:
                t0 = time.perf_counter()
                paged = client.request(
                    "skills/load", {"name": biggest["name"], "offset": next_offset},
                    timeout=args.timeout,
                )
                elapsed = time.perf_counter() - t0
                res2 = paged.get("result") or {}
                payload2 = res2.get("json") or {}
                report.check(
                    "skills/load offset",
                    not paged.get("error")
                    and payload2.get("status") == "ok"
                    and payload2.get("offset") == next_offset
                    and bool(payload2.get("content")),
                    f"offset={payload2.get('offset')} mode={payload2.get('mode')} "
                    f"complete={payload2.get('complete')} chars={res2.get('chars')}",
                    elapsed,
                )

            if label:
                t0 = time.perf_counter()
                sectioned = client.request(
                    "skills/load", {"name": biggest["name"], "section": label},
                    timeout=args.timeout,
                )
                elapsed = time.perf_counter() - t0
                res3 = sectioned.get("result") or {}
                payload3 = res3.get("json") or {}
                report.check(
                    "skills/load section",
                    not sectioned.get("error")
                    and payload3.get("status") == "ok"
                    and payload3.get("mode") == "section"
                    and payload3.get("section") == label
                    and bool(payload3.get("content")),
                    f"section={payload3.get('section')!r} "
                    f"total_chars={payload3.get('total_chars')} "
                    f"complete={payload3.get('complete')}",
                    elapsed,
                )

        # 10) concurrency: a long call must not block a ping
        if not args.no_network:
            slow_id = client.send(
                "tools/call", {"name": "get_market_data", "arguments": md_args}
            )
            time.sleep(0.15)
            t0 = time.perf_counter()
            ping_fast = client.request("ping", timeout=args.timeout)
            ping_latency = time.perf_counter() - t0
            slow = client.wait(slow_id, args.timeout)
            slow_ok = not slow.get("error") and not (slow.get("result") or {}).get("isError")
            report.check(
                "concurrency (pool)",
                ping_fast.get("error") is None and ping_latency < 1.5 and slow_ok,
                f"ping_during_long_call={ping_latency:.3f}s (limit 1.5s), long_call_ok={slow_ok}",
                ping_latency,
            )
            summary["ping_during_long_call_sec"] = round(ping_latency, 3)

        # 11) shutdown
        t0 = time.perf_counter()
        bye = client.request("shutdown", timeout=args.timeout)
        elapsed = time.perf_counter() - t0
        code = client.close(timeout=20)
        report.check(
            "shutdown",
            (bye.get("result") or {}).get("ok") is True and code == 0,
            f"exit_code={code} uptime={(bye.get('result') or {}).get('uptime_sec')}s",
            elapsed,
        )
    except WorkerError as exc:
        report.check("protocol", False, str(exc)[:300])
    finally:
        code = client.close(timeout=10)

        # 12) protocol purity + warnings
        noise = client.stdout_noise
        report.check(
            "stdout purity",
            not noise,
            f"non-JSON lines={len(noise)}" + (f" first={noise[0][:120]!r}" if noise else ""),
        )
        warnings = [line for line in client.stderr_lines if _WARN_RE.search(line)]
        report.check(
            "stderr warnings",
            len(warnings) == 0,
            f"{len(warnings)} warning line(s) of {len(client.stderr_lines)}" +
            (f" first={warnings[0][:160]}" if warnings else ""),
        )

        # 13) --no-truncate really delivers the whole result
        if not args.no_network:
            try:
                _no_truncate_check(py, worker, args, report, summary)
            except Exception as exc:  # noqa: BLE001 - a sub-check must not hide the rest
                report.check(
                    "--no-truncate flag", False, f"{type(exc).__name__}: {exc}"[:200]
                )

        total = time.perf_counter() - report.started
        summary.update(
            {
                "ok": report.ok,
                "steps": report.steps,
                "passed": report.passed,
                "total_steps": len(report.steps),
                "total_sec": round(total, 3),
                "exit_code": code,
                "stderr_line_count": len(client.stderr_lines),
                "stderr_warnings": warnings[:20],
                "stderr_lines": client.stderr_lines[:60],
                "stdout_noise": noise[:10],
            }
        )

        print("")
        print("-" * 78)
        print(
            f"startup={summary.get('startup_sec')}s  tools={summary.get('tool_count')} "
            f"({summary.get('registry_count')} registry + {summary.get('virtual_count')} virtual)  "
            f"schema_chars={(summary.get('schema_chars') or 0):,}  skills={summary.get('skill_count')}"
        )
        print(
            f"calls: search_symbol={_fmt_sec(summary.get('call_search_symbol_sec'))} "
            f"market_data={_fmt_sec(summary.get('call_get_market_data_sec'))} "
            f"lenient={_fmt_sec(summary.get('call_lenient_sec'))} "
            f"tools/list={_fmt_sec(summary.get('tools_list_sec'))}"
        )
        gated = summary.get("vt_key_gated") or []
        print(
            f"virtual calls: pattern={_fmt_sec(summary.get('vt_pattern_recognition_sec'))} "
            f"options={_fmt_sec(summary.get('vt_analyze_options_sec'))} "
            f"payoff={_fmt_sec(summary.get('vt_analyze_options_payoff_sec'))} "
            f"key_gated={sum(1 for g in gated if g.get('matched'))}/{len(gated)} not-available"
        )
        lean = summary.get("signature") or {}
        print(
            f"lean_used={lean.get('lean_used')} loop_imported={lean.get('loop_imported')} "
            f"langchain_imported={lean.get('langchain_imported')} "
            f"(worker {lean.get('worker_version')}, vibe-trading-ai {lean.get('vibe_trading_version')})"
        )
        print(f"stderr: {len(client.stderr_lines)} line(s), {len(warnings)} warning-like")
        for line in client.stderr_lines[:8]:
            print(f"  | {line[:150]}")
        print("-" * 78)
        verdict = "PASS" if report.ok else "FAIL"
        print(f"RESULT: {verdict} ({report.passed}/{len(report.steps)} checks, {total:.2f}s)")

        out = Path(args.json_out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(summary, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        print(f"report: {out}")

    return 0 if report.ok else 1


if __name__ == "__main__":
    sys.exit(main())
