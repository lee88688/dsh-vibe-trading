#!/usr/bin/env python3
"""Vibe-Trading worker: newline-delimited JSON-RPC 2.0 over stdio.

Why this exists
---------------
``vibe-trading-mcp`` is a FastMCP server: it speaks the MCP protocol, publishes
82 curated tools, and pays for the whole fastmcp/starlette stack at startup.
This worker exposes Vibe-Trading's *own* production registry instead —
``src.tools.build_registry()`` + ``ToolRegistry.execute()`` — so callers get the
full 113-tool registry surface, the identical tool error envelopes, the same
10k-char result cap, plus a skills API, over a dependency-free protocol.

Virtual tools
-------------
Fifteen of the 82 MCP tool names are not registry tools: their bodies live in
``mcp_server.py`` wrappers. Six are swarm tools, dropped by design (DSH
subagents replace swarm). The other nine are published here as *virtual tools*
— same names, schemas, readonly/repeatable flags and envelopes as the MCP
server, with the wrapper bodies inlined (see the Virtual tools section), so the
worker publishes 122 tools without ever importing ``mcp_server``/fastmcp.

Lean startup
------------
Importing ``src.tools`` normally runs ``src/agent/__init__.py``, which imports
``AgentLoop`` -> ``src.providers.chat`` -> langchain/openai (~2.3 s and a large
RSS). Nothing in the tool layer needs that. Unless ``--no-lean`` is passed, this
worker pre-seeds a stub ``src.agent`` package into ``sys.modules`` so the
submodule ``src.agent.tools`` still imports normally while the package
``__init__`` never runs. If the lean path breaks registry construction the
worker logs it, purges the ``src*`` modules and retries the plain import path,
so a future upstream refactor degrades instead of failing.

Protocol (one JSON object per line, UTF-8, stdin -> stdout)
-----------------------------------------------------------
Request:   {"jsonrpc":"2.0","id":<int|str>,"method":"<name>","params":{...}}
Response:  {"jsonrpc":"2.0","id":<same>,"result":{...}}
           {"jsonrpc":"2.0","id":<same>,"error":{"code":<int>,"message":"...","data":{...}}}
A message with no ``id`` (a notification) is accepted and ignored.

Methods
-------
ping         no params
             -> {ok, worker_version, vibe_trading_version, pid, python, session_id,
                 cwd, tools, registry_tools, virtual_tools, lean, lean_used,
                 loop_imported, langchain_imported, max_chars, truncate,
                 startup{import_sec, build_sec, catalogue_sec, total_sec},
                 import_failures, registration_failures, vibe_trading_home}
tools/list   no params
             -> {count, registry_count, virtual_count, tools:[{name, description,
                 inputSchema, readonly, repeatable, virtual}], schema_chars,
                 readonly_count, repeatable_count, registry_incomplete}
tools/call   params {name, arguments?, session_id?}
             -> {name, text, json, chars, delivered_chars, truncated, isError,
                 elapsed_sec, session_id}
skills/list  no params
             -> {count, skills:[{name, description, category, chars}]}
skills/load  params {name, section?, offset?}
             -> same envelope shape as tools/call
shutdown     no params
             -> {ok, uptime_sec, requests}; the process then exits 0.

stdout carries ONLY those JSON lines. The protocol handle is captured first and
``sys.stdout`` is then replaced with ``sys.stderr``, so a stray ``print()``
anywhere inside a tool (or a library's banner) cannot corrupt the stream.

Usage:
  uv run python worker/vibe_trading_worker.py [--session-id X]
  echo '{"jsonrpc":"2.0","id":1,"method":"ping"}' | uv run python worker/vibe_trading_worker.py
"""

from __future__ import annotations

import argparse
import importlib
import inspect
import json
import logging
import os
import shutil
import sys
import threading
import time
import traceback
import types
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

WORKER_VERSION = "1.0.0"
REPO_ROOT = Path(__file__).resolve().parents[1]
T_START = time.perf_counter()

# ---------------------------------------------------------------------------
# Transport state
# ---------------------------------------------------------------------------

_PROTO_OUT = None  # binary (or text) handle kept for protocol writes only
_PROTO_IS_BINARY = True
_EMIT_LOCK = threading.Lock()
_STDERR_LOCK = threading.Lock()
_INFLIGHT = 0
_INFLIGHT_COND = threading.Condition()
_REQUESTS = 0

# ---------------------------------------------------------------------------
# Worker state
# ---------------------------------------------------------------------------

_REGISTRY = None
_SKILLS_LOADER = None
_TOOLS_CACHE: list[dict] | None = None
_SCHEMA_BY_NAME: dict[str, dict] = {}
_KEY_GATED_AVAILABILITY: dict[str, dict] | None = None
_TRUNCATE_LIMIT = 10_000
_TRUNCATE_IDENTITY = False
_STARTUP: dict = {}
_LEAN_REQUESTED = True
_LEAN_USED = False
_SESSION_ID = ""
_TOOL_RESULT_TRUNCATOR = None


class RpcError(Exception):
    """A JSON-RPC error that should be returned to the caller verbatim."""

    def __init__(self, code: int, message: str, data: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}

    def envelope(self) -> dict:
        err: dict = {"code": self.code, "message": self.message}
        if self.data:
            err["data"] = self.data
        return err


# ---------------------------------------------------------------------------
# I/O helpers
# ---------------------------------------------------------------------------


def _capture_protocol_stream() -> None:
    """Keep the real stdout for protocol frames, then send all prints to stderr.

    Must run before anything else can import a library that prints.
    """
    global _PROTO_OUT, _PROTO_IS_BINARY
    stream = sys.stdout
    buffer = getattr(stream, "buffer", None)
    _PROTO_IS_BINARY = buffer is not None
    _PROTO_OUT = buffer if buffer is not None else stream
    # Everything else (tool prints, library banners) must not reach stdout.
    sys.stdout = sys.stderr


def _emit(obj: dict) -> None:
    """Write one JSON line to the protocol stream."""
    text = json.dumps(obj, ensure_ascii=False, default=str) + "\n"
    with _EMIT_LOCK:
        try:
            payload = text.encode("utf-8", "replace") if _PROTO_IS_BINARY else text
            _PROTO_OUT.write(payload)
            _PROTO_OUT.flush()
        except (BrokenPipeError, ValueError):
            # Parent went away; nothing useful left to do.
            os._exit(0)


def _log(msg: str) -> None:
    """Write one diagnostic line to stderr."""
    with _STDERR_LOCK:
        try:
            sys.stderr.write(f"[worker] {msg}\n")
            sys.stderr.flush()
        except Exception:  # pragma: no cover - stderr closed
            pass


# ---------------------------------------------------------------------------
# Import-path preparation
# ---------------------------------------------------------------------------


def _find_src_root() -> Path | None:
    """Return the sys.path entry that holds the ``src`` package, if any."""
    for entry in sys.path:
        if not entry:
            continue
        try:
            if os.path.isfile(os.path.join(entry, "src", "agent", "tools.py")):
                return Path(entry)
        except OSError:  # pragma: no cover - unreadable path entry
            continue
    # Fallback: this interpreter's own site-packages (covers running the worker
    # with a python whose sys.path was trimmed by an embedder).
    candidate = Path(sys.prefix) / "Lib" / "site-packages"
    if (candidate / "src" / "agent" / "tools.py").is_file():
        sys.path.insert(0, str(candidate))
        return candidate
    return None


def _seed_lean_agent_package(root: Path) -> None:
    """Pre-seed ``src.agent`` with an empty package so its __init__ never runs.

    ``src/agent/__init__.py`` imports AgentLoop (langchain/openai). Tool modules
    only need the sibling ``src.agent.tools``, which still imports normally
    because the stub carries the real ``__path__``.
    """
    agent_dir = root / "src" / "agent"
    existing = sys.modules.get("src.agent")
    if existing is not None and getattr(existing, "_vt_lean_stub", False):
        return
    pkg = types.ModuleType("src.agent")
    pkg.__path__ = [str(agent_dir)]
    pkg.__doc__ = (
        "Lean stub installed by vibe_trading_worker: bypasses "
        "src/agent/__init__ (AgentLoop -> langchain)."
    )
    pkg._vt_lean_stub = True  # type: ignore[attr-defined]
    sys.modules["src.agent"] = pkg


def _purge_src_modules() -> None:
    """Drop every imported ``src*`` module so a clean import can be retried."""
    for name in [m for m in list(sys.modules) if m == "src" or m.startswith("src.")]:
        sys.modules.pop(name, None)


# ---------------------------------------------------------------------------
# Registry / skills construction
# ---------------------------------------------------------------------------


def _import_registry_builder():
    """Import ``build_registry`` (returns the callable)."""
    from src.tools import build_registry

    return build_registry


def _build_registry(lean: bool, session_id: str) -> tuple[object, dict]:
    """Build the tool registry, preferring the lean import path.

    Args:
        lean: Try the stdlib-only stub of ``src.agent`` first.
        session_id: Session id injected into tools that persist per-session state.

    Returns:
        ``(registry, metrics)`` where metrics records timings and which import
        path actually worked.

    Raises:
        RpcError: If both the lean and the plain path fail.
    """
    global _LEAN_USED

    metrics: dict = {
        "lean_requested": bool(lean),
        "lean_used": False,
        "fallback_reason": "",
        "import_sec": 0.0,
        "build_sec": 0.0,
    }

    root = _find_src_root()
    if root is None:
        raise RpcError(
            -32000,
            "vibe-trading-ai is not importable from this interpreter",
            {"python": sys.executable, "sys_prefix": sys.prefix},
        )

    attempts: list[tuple[bool, str]] = []
    if lean:
        attempts.append((True, "lean"))
    attempts.append((False, "plain"))

    last_detail = ""
    for use_lean, label in attempts:
        try:
            if use_lean:
                _seed_lean_agent_package(root)
            elif "src.agent" in sys.modules:
                _purge_src_modules()

            t_import = time.perf_counter()
            builder = _import_registry_builder()
            t_imported = time.perf_counter()
            registry = builder(session_id=session_id or None)
            t_built = time.perf_counter()

            metrics["import_sec"] = round(t_imported - t_import, 3)
            metrics["build_sec"] = round(t_built - t_imported, 3)
            metrics["lean_used"] = use_lean
            metrics["import_path"] = label
            _LEAN_USED = use_lean
            return registry, metrics
        except Exception:  # noqa: BLE001 - retry on the plain path
            last_detail = traceback.format_exc()
            metrics["fallback_reason"] = f"{label} path failed: {last_detail.splitlines()[-1][:300]}"
            _log(f"{label} import path failed, retrying: {last_detail}")
            _purge_src_modules()

    raise RpcError(-32001, "tool registry build failed", {"detail": last_detail[-2000:]})


def _registry():
    if _REGISTRY is None:  # pragma: no cover - build happens before serving
        raise RpcError(-32002, "worker not initialised")
    return _REGISTRY


def _skills_loader():
    """Return the shared SkillsLoader, importing it on first use."""
    global _SKILLS_LOADER
    if _SKILLS_LOADER is None:
        t0 = time.perf_counter()
        from src.agent.skills import SkillsLoader

        _SKILLS_LOADER = SkillsLoader()
        _log(f"skills loaded: {len(_SKILLS_LOADER.skills)} in {time.perf_counter() - t0:.2f}s")
    return _SKILLS_LOADER


def _truncator():
    """Return ``truncate_tool_result`` from the package, or a local fallback."""
    global _TOOL_RESULT_TRUNCATOR
    if _TOOL_RESULT_TRUNCATOR is None:
        try:
            from src.config.limits import truncate_tool_result

            _TOOL_RESULT_TRUNCATOR = truncate_tool_result
        except Exception:  # pragma: no cover - limits module unavailable
            def _fallback(result: str, limit: int = 10_000) -> str:
                total = len(result)
                notice = (
                    f"\n\n[TRUNCATED: {limit} of {total} characters delivered. "
                    "The remainder was not sent — narrow the request.]"
                )
                return result[: max(0, limit - len(notice))] + notice[:limit]

            _TOOL_RESULT_TRUNCATOR = _fallback
    return _TOOL_RESULT_TRUNCATOR


# ---------------------------------------------------------------------------
# Argument handling (mirrors the MCP layer's leniency)
# ---------------------------------------------------------------------------


def _coerce_json_string(value):
    """Decode a JSON array/object string some clients send for list/dict args.

    Copied from ``mcp_server._coerce_json_string`` so the worker is as tolerant
    as the MCP server is: a string argument that starts with ``[`` or ``{`` and
    parses as JSON is replaced by the list/dict it encodes. Anything else is
    returned unchanged.
    """
    if isinstance(value, str):
        stripped = value.strip()
        if stripped[:1] in ("[", "{"):
            try:
                return json.loads(stripped)
            except (json.JSONDecodeError, ValueError):
                return value
    return value


def _expects_container(spec: dict) -> bool:
    """Whether a JSON-Schema property declares an array/object-ish type."""
    if not isinstance(spec, dict):
        return False
    kind = spec.get("type")
    if kind in ("array", "object"):
        return True
    if isinstance(kind, list) and ("array" in kind or "object" in kind):
        return True
    if "items" in spec or "properties" in spec:
        return True
    for combiner in ("anyOf", "oneOf", "allOf"):
        options = spec.get(combiner)
        if isinstance(options, list) and any(_expects_container(o) for o in options):
            return True
    return False


def _normalise_arguments(tool_name: str, arguments) -> dict:
    """Coerce ``arguments`` into a dict and decode JSON-string containers.

    Applies the MCP layer's leniency only to parameters whose schema declares an
    array/object (or a union that includes one), so a genuine string parameter
    that happens to start with ``{`` is left alone.
    """
    global _SCHEMA_BY_NAME

    if arguments is None:
        return {}
    if isinstance(arguments, str):
        arguments = _coerce_json_string(arguments)
        if not isinstance(arguments, dict):
            raise RpcError(
                -32602,
                f"arguments for tool {tool_name!r} must be an object",
                {"got": type(arguments).__name__},
            )
    if not isinstance(arguments, dict):
        raise RpcError(
            -32602,
            f"arguments for tool {tool_name!r} must be an object",
            {"got": type(arguments).__name__},
        )

    schema = _SCHEMA_BY_NAME.get(tool_name) or {}
    props = schema.get("properties") if isinstance(schema, dict) else None
    props = props if isinstance(props, dict) else {}

    out: dict = {}
    for key, value in arguments.items():
        if isinstance(value, str) and _expects_container(props.get(key) or {}):
            out[key] = _coerce_json_string(value)
        else:
            out[key] = value
    return out


def _inject_session_id(tool_name: str, arguments: dict, session_id: str) -> None:
    """Add ``session_id`` to the arguments when the tool's schema declares it.

    Seven tools (goal / autopilot / backtest-config / mandate) read a session id
    from their params and fall back to the id injected at construction time.
    Injecting only for those keeps every other tool's signature untouched.
    """
    if not session_id:
        return
    schema = _SCHEMA_BY_NAME.get(tool_name) or {}
    props = schema.get("properties") if isinstance(schema, dict) else None
    if isinstance(props, dict) and "session_id" in props and "session_id" not in arguments:
        arguments["session_id"] = session_id


# ---------------------------------------------------------------------------
# Virtual tools: MCP-surface tools whose body lives in mcp_server.py
# ---------------------------------------------------------------------------
# 15 of the 82 MCP tool names are absent from the 113-tool registry. Six are
# swarm tools, dropped by design (DSH subagents replace swarm). The remaining
# nine are served here as "virtual tools": the same names, published schemas,
# readonly/repeatable flags and return envelopes as the MCP server, with the
# wrapper bodies inlined so this worker never imports mcp_server (fastmcp plus
# MCP app construction cost ~4.7 s at startup).
#
# Schemas below are the exact ``inputSchema`` objects the MCP server published
# for vibe-trading-ai 0.1.18 (captured from a live ``tools/list``), so a DSH
# client sees these tools exactly like registry tools.

_VIRTUAL_TOOL_SPECS_JSON = r"""
[
  {"name": "pattern_recognition", "description": "Detect technical chart patterns (head-and-shoulders, double top/bottom,\ntriangles, wedges, channels) in OHLCV data.\n\nReads price data from run_dir/artifacts/ohlcv_*.csv files.\nCan be called before coding (to inform strategy) or after backtest (to analyse).", "inputSchema": {"additionalProperties": false, "properties": {"run_dir": {"type": "string", "description": "Path to run directory containing artifacts/ohlcv_*.csv."}}, "required": ["run_dir"], "type": "object"}},
  {"name": "analyze_options", "description": "Calculate Black-Scholes option price and Greeks (Delta, Gamma, Theta, Vega).", "inputSchema": {"additionalProperties": false, "properties": {"spot": {"type": "number", "description": "Current underlying price."}, "strike": {"type": "number", "description": "Strike price."}, "expiry_days": {"type": "integer", "description": "Days until expiration."}, "risk_free_rate": {"default": 0.03, "type": "number", "description": "Annual risk-free rate (default 0.03 = 3%)."}, "volatility": {"default": 0.25, "type": "number", "description": "Annual volatility (default 0.25 = 25%)."}, "option_type": {"default": "call", "type": "string", "description": "\"call\" or \"put\"."}}, "required": ["spot", "strike", "expiry_days"], "type": "object"}},
  {"name": "analyze_options_payoff", "description": "Analyze a multi-leg option strategy's payoff and spot/IV scenarios.\n\nThe expiry summary is analytic rather than chart-grid dependent. Returns\nentry debit/credit and commission, breakevens, bounded or unbounded maximum\nprofit/loss, an expiry curve, and a Black-Scholes spot/IV P&L matrix.\nResearch only; this tool cannot place orders.", "inputSchema": {"additionalProperties": false, "properties": {"legs": {"items": {"additionalProperties": true, "type": "object"}, "type": "array", "description": "Option leg objects with ``option_type`` (call/put), positive\n``strike``, signed integer ``qty``, and optional per-share\n``premium``. Positive quantity is long; negative is short."}, "entry_spot": {"type": "number", "description": "Positive underlying spot at entry."}, "expiry_days": {"type": "number", "description": "Non-negative calendar days to expiry."}, "risk_free_rate": {"default": 0.05, "type": "number", "description": "Annual continuously compounded risk-free rate."}, "volatility": {"default": 0.3, "type": "number", "description": "Annualized entry volatility, e.g. 0.3 for 30%."}, "multiplier": {"default": 1.0, "type": "number", "description": "Currency multiplier per option price unit."}, "commission_rate": {"default": 0.001, "type": "number", "description": "Entry commission fraction, aligned with the options\nbacktest engine."}, "spot_min": {"anyOf": [{"type": "number"}, {"type": "null"}], "default": null, "description": "Optional non-negative chart/scenario lower bound."}, "spot_max": {"anyOf": [{"type": "number"}, {"type": "null"}], "default": null, "description": "Optional chart/scenario upper bound above ``spot_min``."}, "spot_points": {"default": 121, "type": "integer", "description": "Display-grid size from 21 through 501."}, "scenario_iv_values": {"anyOf": [{"items": {"type": "number"}, "type": "array"}, {"type": "null"}], "default": null, "description": "Optional positive annualized IV scenarios. Omit for\n50%, 75%, 100%, 125%, and 150% of entry volatility."}}, "required": ["legs", "entry_spot", "expiry_days"], "type": "object"}},
  {"name": "get_macro_series", "description": "Fetch a FRED macroeconomic time series from the St. Louis Fed.\n\nReturns dated observations of indicators such as CPI (CPIAUCSL),\nunemployment (UNRATE), real GDP (GDPC1), the federal funds rate (FEDFUNDS),\nor the 10-year Treasury yield (DGS10). Markets: US / global macro data.\nRequires a free FRED API key (FRED_API_KEY); without it the tool returns a\nnot-available error.", "inputSchema": {"additionalProperties": false, "properties": {"series_id": {"type": "string", "description": "FRED series identifier (e.g. \"CPIAUCSL\", \"UNRATE\")."}, "start_date": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Inclusive window start, YYYY-MM-DD. Omit for full history."}, "end_date": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Inclusive window end, YYYY-MM-DD. Omit for the latest date."}, "limit": {"default": 2000, "type": "integer", "description": "Maximum number of most-recent observations to return (max\n5000). A series longer than that is capped and says so in the\nresult: truncated, observations_available, and a hint. The shared\ncharacter budget may return fewer rows; count reports delivered rows."}}, "required": ["series_id"], "type": "object"}},
  {"name": "get_cn_macro_series", "description": "Fetch China macro / regional / industry economic indicator series (宏观 EDB).\n\nGDP, CPI, PPI, PMI, money supply, rates, trade, 31 industry series and\nregional data — dated observations with unit and frequency, asked for in\nnatural language. Complements get_macro_series (FRED, US/global).\nRequires GILDATA_TOKEN and the macro_series opt-in.", "inputSchema": {"additionalProperties": false, "properties": {"query": {"type": "string", "description": "Natural-language indicator request, e.g. \"2024年中国月度CPI同比\"."}, "limit": {"default": 50, "type": "integer", "description": "Maximum rows returned."}}, "required": ["query"], "type": "object"}},
  {"name": "get_fund_nav", "description": "Fetch daily NAV history for Chinese off-exchange funds (场外基金).\n\nReturns unit NAV (单位净值), accumulated NAV (累计净值), dividend-adjusted\nNAV (复权净值) and the daily growth rate per fund, over an optional date\nwindow. Codes are bare 6-digit ('110022') or '.OF'-suffixed\n('110022.OF'). Exchange-listed ETF/LOF are OHLCV instruments — use\nget_market_data for those. Requires GILDATA_TOKEN and the fund_nav opt-in.", "inputSchema": {"additionalProperties": false, "properties": {"funds": {"items": {"type": "string"}, "type": "array", "description": "Fund codes, e.g. [\"110022\", \"000198.OF\"]."}, "start_date": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Inclusive window start, YYYY-MM-DD. Omit for the vendor's\ndefault history window."}, "end_date": {"anyOf": [{"type": "string"}, {"type": "null"}], "default": null, "description": "Inclusive window end, YYYY-MM-DD. Omit through the latest\npublished NAV."}, "limit": {"default": 2000, "type": "integer", "description": "Maximum number of most-recent rows per fund."}}, "required": ["funds"], "type": "object"}},
  {"name": "get_cn_announcements", "description": "Search Chinese-market announcements (公告): A-share, HK and fund filings.\n\nAnnual reports, earnings, dividends, buybacks, restructuring, inquiry\nletters — with title, publish date and a highlighted excerpt. For US\nfilings use get_sec_filings. Requires GILDATA_TOKEN and the announcements opt-in.", "inputSchema": {"additionalProperties": false, "properties": {"query": {"type": "string", "description": "Natural-language announcement request, e.g. \"贵州茅台2024年年度分红公告\"."}, "limit": {"default": 50, "type": "integer", "description": "Maximum rows returned."}}, "required": ["query"], "type": "object"}},
  {"name": "search_broker_reports", "description": "Search sell-side broker research (券商研报) over the Juyuan library.\n\nTitle, broker, industry, rating and a highlighted excerpt of the argument\n— for company deep-dives, industry views and macro commentary. Coexists\nwith get_research_reports (eastmoney-backed). Requires GILDATA_TOKEN and the broker_reports opt-in.", "inputSchema": {"additionalProperties": false, "properties": {"query": {"type": "string", "description": "Natural-language research request, e.g. \"最近三个月白酒行业的券商研报观点\"."}, "limit": {"default": 50, "type": "integer", "description": "Maximum rows returned."}}, "required": ["query"], "type": "object"}},
  {"name": "iwencai_search", "description": "Run a natural-language A-share research query against iWenCai (问财).\n\niWenCai is a Chinese-market semantic stock screener. Phrase the question in\nplain language (Chinese works best) and get back the matching China A-share\n(SH/SZ) securities with the metric columns iWenCai parsed from the question.\nRead-only; requires the VIBE_TRADING_IWENCAI_KEY access key (without it the\ntool returns a not-available error).", "inputSchema": {"additionalProperties": false, "properties": {"query": {"type": "string", "description": "Natural-language research question (Chinese phrasing yields the\nbest parse, e.g. \"市盈率低于15的银行股\")."}, "limit": {"default": 20, "type": "integer", "description": "Maximum securities to return."}}, "required": ["query"], "type": "object"}}
]"""

_VIRTUAL_TOOL_SPECS: list[dict] = json.loads(_VIRTUAL_TOOL_SPECS_JSON)

# name -> (module, class) for the key-gated tools; mirrors
# ``mcp_server._key_gated_tool_classes()`` in vibe-trading-ai 0.1.18.
_KEY_GATED_TOOL_CLASSES: dict[str, tuple[str, str]] = {
    "get_macro_series": ("src.tools.fred_macro_tool", "FredMacroTool"),
    "get_fund_nav": ("src.tools.fund_nav_tool", "GildataFundNavTool"),
    "get_cn_macro_series": ("src.tools.gildata_research_tools", "GetCnMacroSeriesTool"),
    "get_cn_announcements": ("src.tools.gildata_research_tools", "GetCnAnnouncementsTool"),
    "search_broker_reports": ("src.tools.gildata_research_tools", "SearchBrokerReportsTool"),
    "iwencai_search": ("src.tools.iwencai_tool", "IWenCaiSearchTool"),
}


def _execute_key_gated(name: str, params: dict) -> str:
    """Run a key-gated tool exactly like ``mcp_server._execute_key_gated``.

    The registry only holds tools whose ``check_available()`` passed, so a tool
    that needs a missing token is absent from it and must be instantiated
    directly — that is what produces the wrapper's actionable
    ``{"ok": false, "error": "<ENV VAR> is not configured"}`` envelope instead of
    a "tool not found" error.

    Args:
        name: Published tool name (one of ``_KEY_GATED_TOOL_CLASSES``).
        params: Tool keyword arguments.

    Returns:
        The tool's JSON envelope as a string.
    """
    reg = _registry()
    if reg.get(name) is not None:
        return reg.execute(name, params)

    module_name, class_name = _KEY_GATED_TOOL_CLASSES[name]
    try:
        module = importlib.import_module(module_name)
        tool_cls = getattr(module, class_name)
        return tool_cls().execute(**params)
    except Exception as exc:  # missing optional dependency / import drift
        _log(f"key-gated tool {name} failed: {type(exc).__name__}: {exc}")
        return json.dumps(
            {"status": "error", "tool": name, "error": f"{type(exc).__name__}: {exc}"},
            ensure_ascii=False,
        )


# --- wrapper bodies, copied from mcp_server.py (0.1.18) ---------------------
# Each function has the same signature and defaults as the MCP wrapper, so
# ``inspect.signature(...).bind`` rejects unknown/missing arguments the way
# FastMCP's pydantic validation does.


def _vt_pattern_recognition(run_dir: str) -> str:
    """Detect chart patterns in run_dir/artifacts/ohlcv_*.csv (alias -> pattern)."""
    return _registry().execute("pattern", {"run_dir": run_dir})


def _vt_analyze_options(
    spot: float,
    strike: float,
    expiry_days: int,
    risk_free_rate: float = 0.03,
    volatility: float = 0.25,
    option_type: str = "call",
) -> str:
    """Black-Scholes price + Greeks (alias -> options_pricing)."""
    return _registry().execute(
        "options_pricing",
        {
            "spot": spot,
            "strike": strike,
            "expiry_days": expiry_days,
            "risk_free_rate": risk_free_rate,
            "volatility": volatility,
            "option_type": option_type,
        },
    )


def _vt_analyze_options_payoff(
    legs: list,
    entry_spot: float,
    expiry_days: float,
    risk_free_rate: float = 0.05,
    volatility: float = 0.3,
    multiplier: float = 1.0,
    commission_rate: float = 0.001,
    spot_min: float | None = None,
    spot_max: float | None = None,
    spot_points: int = 121,
    scenario_iv_values: list | None = None,
) -> str:
    """Multi-leg payoff/scenario analysis (alias -> options_payoff)."""
    params: dict = {
        "legs": legs,
        "entry_spot": entry_spot,
        "expiry_days": expiry_days,
        "risk_free_rate": risk_free_rate,
        "volatility": volatility,
        "multiplier": multiplier,
        "commission_rate": commission_rate,
        "spot_points": spot_points,
    }
    if spot_min is not None:
        params["spot_min"] = spot_min
    if spot_max is not None:
        params["spot_max"] = spot_max
    if scenario_iv_values is not None:
        params["scenario_iv_values"] = scenario_iv_values
    return _registry().execute("options_payoff", params)


def _vt_get_macro_series(
    series_id: str,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 2000,
) -> str:
    """FRED macro series (key-gated on FRED_API_KEY)."""
    params: dict = {"series_id": series_id, "limit": limit}
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date
    return _execute_key_gated("get_macro_series", params)


def _vt_get_fund_nav(
    funds: list,
    start_date: str | None = None,
    end_date: str | None = None,
    limit: int = 2000,
) -> str:
    """Chinese off-exchange fund NAV history (key-gated on GILDATA_TOKEN)."""
    params: dict = {"funds": funds, "limit": limit}
    if start_date:
        params["start_date"] = start_date
    if end_date:
        params["end_date"] = end_date
    return _execute_key_gated("get_fund_nav", params)


def _vt_get_cn_macro_series(query: str, limit: int = 50) -> str:
    """GILDATA EDB China macro series (key-gated on GILDATA_TOKEN)."""
    return _execute_key_gated("get_cn_macro_series", {"query": query, "limit": limit})


def _vt_get_cn_announcements(query: str, limit: int = 50) -> str:
    """GILDATA China announcements (key-gated on GILDATA_TOKEN)."""
    return _execute_key_gated("get_cn_announcements", {"query": query, "limit": limit})


def _vt_search_broker_reports(query: str, limit: int = 50) -> str:
    """GILDATA/Juyuan broker reports (key-gated on GILDATA_TOKEN)."""
    return _execute_key_gated("search_broker_reports", {"query": query, "limit": limit})


def _vt_iwencai_search(query: str, limit: int = 20) -> str:
    """iWenCai semantic A-share screener (key-gated on VIBE_TRADING_IWENCAI_KEY)."""
    return _execute_key_gated("iwencai_search", {"query": query, "limit": limit})


_VIRTUAL_CALLABLES = {
    "pattern_recognition": _vt_pattern_recognition,
    "analyze_options": _vt_analyze_options,
    "analyze_options_payoff": _vt_analyze_options_payoff,
    "get_macro_series": _vt_get_macro_series,
    "get_fund_nav": _vt_get_fund_nav,
    "get_cn_macro_series": _vt_get_cn_macro_series,
    "get_cn_announcements": _vt_get_cn_announcements,
    "search_broker_reports": _vt_search_broker_reports,
    "iwencai_search": _vt_iwencai_search,
}

_VIRTUAL_SIGNATURES = {
    name: inspect.signature(fn) for name, fn in _VIRTUAL_CALLABLES.items()
}

# Registry tool each alias forwards to, so its readonly/repeatable flags stay
# identical to the real tool's. The key-gated ones are absent from the registry
# by definition (no token), so their flags are the class defaults verified in
# 0.1.18: readonly True for all, repeatable True only for iwencai_search.
_VIRTUAL_REGISTRY_TARGETS = {
    "pattern_recognition": "pattern",
    "analyze_options": "options_pricing",
    "analyze_options_payoff": "options_payoff",
}
_VIRTUAL_STATIC_FLAGS = {
    "get_macro_series": (True, False),
    "get_fund_nav": (True, False),
    "get_cn_macro_series": (True, False),
    "get_cn_announcements": (True, False),
    "search_broker_reports": (True, False),
    "iwencai_search": (True, True),
}


def _virtual_tool_entries() -> list[dict]:
    """Return the published catalogue entries for the virtual tools."""
    reg = _registry()
    entries: list[dict] = []
    for spec in _VIRTUAL_TOOL_SPECS:
        name = spec["name"]
        target = _VIRTUAL_REGISTRY_TARGETS.get(name)
        real = reg.get(target) if target else None
        if real is not None:
            readonly = bool(getattr(real, "is_readonly", True))
            repeatable = bool(getattr(real, "repeatable", False))
        else:
            readonly, repeatable = _VIRTUAL_STATIC_FLAGS[name]
        entries.append(
            {
                "name": name,
                "description": spec["description"],
                "inputSchema": spec["inputSchema"],
                "readonly": readonly,
                "repeatable": repeatable,
                "virtual": True,
            }
        )
    return entries


def _virtual_type_guard(name: str, arguments: dict) -> None:
    """Reject a JSON-string/list mismatch the way FastMCP's pydantic layer does.

    ``_normalise_arguments`` already decodes a JSON-encoded array/object; if a
    parameter declared as a container is *still* a bare string, the MCP server
    would have answered a 422-style validation error, so fail loudly here
    instead of letting a str reach the tool body.
    """
    schema = _SCHEMA_BY_NAME.get(name) or {}
    props = schema.get("properties") if isinstance(schema, dict) else None
    if not isinstance(props, dict):
        return
    for key, value in arguments.items():
        spec = props.get(key) or {}
        if not isinstance(spec, dict):
            continue
        declared = spec.get("type")
        if declared == "array" and isinstance(value, str):
            raise RpcError(-32602, f"argument {key!r} of {name!r} must be an array", {"got": "string"})
        if declared == "object" and isinstance(value, str):
            raise RpcError(-32602, f"argument {key!r} of {name!r} must be an object", {"got": "string"})


def _call_virtual(name: str, arguments: dict) -> str:
    """Dispatch one virtual tool with MCP-equivalent argument binding."""
    fn = _VIRTUAL_CALLABLES[name]
    signature = _VIRTUAL_SIGNATURES[name]
    try:
        bound = signature.bind(**arguments)
    except TypeError as exc:
        raise RpcError(
            -32602,
            f"invalid arguments for {name!r}: {exc}",
            {"tool": name, "parameters": list(signature.parameters)},
        ) from exc
    bound.apply_defaults()
    return fn(*bound.args, **bound.kwargs)


# ---------------------------------------------------------------------------
# Result envelopes
# ---------------------------------------------------------------------------


_LARGE_RESULT_PART_CHARS = 9_400
_REDACT_TOOL_RESULT = None


def _redactor():
    """Lazy VT redaction hook.

    Vibe-Trading applies ``redact_tool_result`` in its agent loop, after the tool
    body and before delivery/persist/ledger. The worker reuses the tool registry
    but not the loop, so it has to install the same single choke point here:
    redacting once at ``_render_result`` keeps the delivered text, the saved full
    result and the grounding ledger consistent with upstream.
    """
    global _REDACT_TOOL_RESULT
    if _REDACT_TOOL_RESULT is None:
        try:
            from src.tools.redaction import redact_tool_result

            _REDACT_TOOL_RESULT = redact_tool_result
        except Exception:  # pragma: no cover - import drift
            _REDACT_TOOL_RESULT = False
    return _REDACT_TOOL_RESULT


def _redact_result(raw: str) -> str:
    if not isinstance(raw, str):
        raw = str(raw)
    redact = _redactor()
    if not redact:
        return raw
    try:
        return redact(raw)
    except Exception:  # pragma: no cover - defensive
        return raw


def _persist_full_result(raw: str) -> str | None:
    """Save an untruncated tool result under <cwd>/results and return its path.

    The delivered text is capped at 10k, so the model needs a way to read the
    rest. A single saved file is not enough: ``read_file`` has its own 10k
    delivery cap and no offset, so a large one-file result cannot be read past
    the first page. Large results are therefore also split into
    ``parts/NNN.txt`` (each <= ``_LARGE_RESULT_PART_CHARS``, below the read cap)
    plus a ``parts.json`` manifest. Writes are best-effort: a failure just drops
    the path.
    """
    try:
        target_dir = Path.cwd() / "results" / uuid.uuid4().hex
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / "result.json"
        target.write_text(raw, encoding="utf-8")
        if len(raw) > _LARGE_RESULT_PART_CHARS:
            parts_dir = target_dir / "parts"
            parts_dir.mkdir(exist_ok=True)
            parts = []
            for index, start in enumerate(range(0, len(raw), _LARGE_RESULT_PART_CHARS)):
                part_name = f"{index:03d}.txt"
                (parts_dir / part_name).write_text(
                    raw[start : start + _LARGE_RESULT_PART_CHARS], encoding="utf-8"
                )
                parts.append(part_name)
            (target_dir / "parts.json").write_text(
                json.dumps(
                    {
                        "result_chars": len(raw),
                        "part_chars": _LARGE_RESULT_PART_CHARS,
                        "parts": parts,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        return str(target)
    except OSError:  # pragma: no cover - disk/permission problems
        return None


def _truncation_notice(full_chars: int, full_path: str | None) -> str:
    """One bounded line telling the model where the rest of a result lives."""
    saved = ""
    if full_path:
        saved = " FULL RESULT SAVED: " + full_path
        if full_chars > _LARGE_RESULT_PART_CHARS:
            parts = (full_chars + _LARGE_RESULT_PART_CHARS - 1) // _LARGE_RESULT_PART_CHARS
            parts_dir = str(Path(full_path).parent / "parts")
            saved += (
                f" (full text split into {parts} part files of <= {_LARGE_RESULT_PART_CHARS} chars"
                f" under {parts_dir}; read NNN.txt with read_file for the remaining pages)"
            )
    return (
        f"\n\n[TRUNCATED: {full_chars} characters total, {_TRUNCATE_LIMIT} delivered."
        + saved
        + " Narrow the request, or read the saved part files for the rest.]"
    )


def _render_result(name: str, raw: str, elapsed: float, session_id: str | None) -> dict:
    """Build the tools/call / skills/load result envelope from raw tool text."""
    raw = _redact_result(raw)
    full_chars = len(raw)
    delivered = raw
    truncated = False
    if not _TRUNCATE_IDENTITY and _TRUNCATE_LIMIT > 0 and full_chars > _TRUNCATE_LIMIT:
        try:
            delivered = _truncator()(raw, _TRUNCATE_LIMIT)
        except TypeError:  # pragma: no cover - signature drift
            delivered = _truncator()(raw)
        truncated = True

    full_path = _persist_full_result(raw) if truncated else None
    if truncated:
        notice = _truncation_notice(full_chars, full_path)
        budget = max(1_000, _TRUNCATE_LIMIT - len(notice))
        try:
            delivered = _truncator()(raw, budget)
        except TypeError:  # pragma: no cover - signature drift
            delivered = raw[:budget]
        delivered = delivered + notice

    parsed = None
    try:
        parsed = json.loads(raw)
    except (json.JSONDecodeError, ValueError, TypeError):
        parsed = None

    is_error = False
    if isinstance(parsed, dict):
        if parsed.get("status") == "error":
            is_error = True
        elif parsed.get("ok") is False:
            is_error = True
    delivered_json = parsed
    if truncated and parsed is None:
        delivered_json = None

    # Non-JSON results have no `json` field carrying the full payload; the plugin
    # needs the untruncated text for the grounding ledger. JSON results already
    # carry it in `json`, so `full_text` stays null there to keep envelopes small.
    full_text = raw if truncated and parsed is None else None
    return {
        "name": name,
        "text": delivered,
        "json": delivered_json,
        "full_text": full_text,
        "chars": full_chars,
        "delivered_chars": len(delivered),
        "truncated": truncated,
        "full_path": full_path,
        "isError": is_error,
        "elapsed_sec": round(elapsed, 3),
        "session_id": session_id or None,
    }


# ---------------------------------------------------------------------------
# Method handlers
# ---------------------------------------------------------------------------


def _vibe_version() -> str:
    try:
        import importlib.metadata as md

        return md.version("vibe-trading-ai")
    except Exception:  # pragma: no cover - metadata unavailable
        return "unknown"


def _handle_ping() -> dict:
    reg = _registry()
    published = _tool_catalogue()
    return {
        "ok": True,
        "worker_version": WORKER_VERSION,
        "vibe_trading_version": _vibe_version(),
        "pid": os.getpid(),
        "python": sys.version.split()[0],
        "executable": sys.executable,
        "session_id": _SESSION_ID,
        "cwd": os.getcwd(),
        "tools": len(published),
        "registry_tools": len(reg),
        "virtual_tools": len(_VIRTUAL_CALLABLES),
        "skills": len(_SKILLS_LOADER.skills) if _SKILLS_LOADER is not None else None,
        "lean": _LEAN_REQUESTED,
        "lean_used": _LEAN_USED,
        "loop_imported": "src.agent.loop" in sys.modules,
        "langchain_imported": any(
            m == "openai" or m.startswith("langchain") for m in sys.modules
        ),
        # The virtual tools inline mcp_server's wrapper bodies precisely so this
        # stays false; it is the proof that no MCP stack was paid for.
        "mcp_server_imported": "mcp_server" in sys.modules,
        "fastmcp_imported": any(
            m == "fastmcp" or m.startswith("fastmcp.") for m in sys.modules
        ),
        "max_chars": 0 if _TRUNCATE_IDENTITY else _TRUNCATE_LIMIT,
        "truncate": not _TRUNCATE_IDENTITY,
        "startup": dict(_STARTUP),
        "import_failures": dict(reg.import_failures),
        "registration_failures": dict(reg.registration_failures),
        "vibe_trading_home": os.environ.get("VIBE_TRADING_HOME", ""),
        "uptime_sec": round(time.perf_counter() - T_START, 3),
    }


def _key_gated_availability() -> dict[str, dict]:
    """Report which key-gated virtual tools this interpreter can actually run.

    Vibe-Trading's registry drops a tool whose ``check_available()`` is False so
    the agent never sees a tool it cannot call. Its six key-gated tools live in
    the MCP wrapper layer instead, so the plugin asks here before advertising
    them — a catalog entry whose only possible answer is "not configured" is
    worse than no entry. Config-only checks (no network); cached for the worker
    lifetime because the environment does not change while it runs.
    """
    global _KEY_GATED_AVAILABILITY
    if _KEY_GATED_AVAILABILITY is not None:
        return _KEY_GATED_AVAILABILITY
    report: dict[str, dict] = {}
    for name, (module_name, class_name) in _KEY_GATED_TOOL_CLASSES.items():
        try:
            module = importlib.import_module(module_name)
            tool_class = getattr(module, class_name)
            report[name] = {"available": bool(tool_class.check_available())}
        except Exception as exc:  # noqa: BLE001 - a gate must never break the worker
            report[name] = {
                "available": False,
                "error": f"{type(exc).__name__}: {exc}"[:300],
            }
    _KEY_GATED_AVAILABILITY = report
    return report


def _handle_capabilities() -> dict:
    """Describe what this worker can do beyond listing tools.

    ``key_gated`` is the plugin's input for conditional advertisement: names it
    may only put in the catalog when the credential (and opt-in) is present.
    """
    return {
        "ok": True,
        "worker_version": WORKER_VERSION,
        "vibe_trading_version": _vibe_version(),
        "key_gated": _key_gated_availability(),
    }


def _tool_catalogue() -> list[dict]:
    """Build (once) and return the published tool catalogue.

    Registry tools come first, then the virtual tools (MCP-only names served by
    this worker), so callers see one flat, registry-shaped list.
    """
    global _TOOLS_CACHE, _SCHEMA_BY_NAME
    if _TOOLS_CACHE is not None:
        return _TOOLS_CACHE

    reg = _registry()
    tools: list[dict] = []
    schemas: dict[str, dict] = {}
    for tool in reg._tools.values():  # noqa: SLF001 - public registry surface is name-based
        schema = getattr(tool, "parameters", None) or {"type": "object", "properties": {}}
        if not isinstance(schema, dict):
            schema = {"type": "object", "properties": {}}
        schemas[tool.name] = schema
        tools.append(
            {
                "name": tool.name,
                "description": getattr(tool, "description", "") or "",
                "inputSchema": schema,
                "readonly": bool(getattr(tool, "is_readonly", True)),
                "repeatable": bool(getattr(tool, "repeatable", False)),
                "virtual": False,
            }
        )
    for entry in _virtual_tool_entries():
        # A registry tool of the same name would shadow the virtual one in
        # _handle_tools_call, so publishing both would be a lie.
        if entry["name"] in schemas:
            continue
        schemas[entry["name"]] = entry["inputSchema"]
        tools.append(entry)
    _TOOLS_CACHE = tools
    _SCHEMA_BY_NAME = schemas
    return tools


def _handle_tools_list() -> dict:
    reg = _registry()
    tools = _tool_catalogue()
    schema_chars = sum(
        len(json.dumps(t["inputSchema"], ensure_ascii=False)) for t in tools
    )
    return {
        "count": len(tools),
        "registry_count": len(reg),
        "virtual_count": sum(1 for t in tools if t.get("virtual")),
        "tools": tools,
        "schema_chars": schema_chars,
        "readonly_count": sum(1 for t in tools if t["readonly"]),
        "repeatable_count": sum(1 for t in tools if t["repeatable"]),
        "registry_incomplete": bool(reg.import_failures or reg.registration_failures),
    }


def _call_virtual_tool(name: str, params: dict) -> dict:
    """Serve one virtual (MCP-only) tool with the registry-tool envelope.

    Arguments go through the same lenient JSON-string coercion as registry
    tools, then through signature binding (which rejects unknown or missing
    parameters the way FastMCP's validation does).
    """
    arguments = _normalise_arguments(name, params.get("arguments"))
    _virtual_type_guard(name, arguments)
    t0 = time.perf_counter()
    try:
        raw = _call_virtual(name, arguments)
    except RpcError:
        raise
    except Exception:  # noqa: BLE001 - a tool must never kill the worker
        elapsed = time.perf_counter() - t0
        detail = traceback.format_exc()
        _log(f"virtual tool {name} raised: {detail.splitlines()[-1]}")
        return _render_result(
            name,
            json.dumps({"status": "error", "tool": name, "error": detail[-2000:]}, ensure_ascii=False),
            elapsed,
            None,
        )
    return _render_result(name, raw, time.perf_counter() - t0, None)


def _handle_tools_call(params: dict) -> dict:
    reg = _registry()
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        raise RpcError(-32602, "tools/call requires a 'name' string", {"params": list(params)})
    name = name.strip()

    if reg.get(name) is None:
        if name in _VIRTUAL_CALLABLES:
            return _call_virtual_tool(name, params)
        # The registry would answer with its own JSON error envelope; surface it
        # as a protocol error too so a caller cannot mistake it for success.
        envelope = reg.execute(name, {})
        try:
            detail = json.loads(envelope)
        except (json.JSONDecodeError, ValueError):
            detail = {"raw": envelope}
        raise RpcError(
            -32602,
            f"unknown tool {name!r}",
            {
                "kind": "unknown_tool",
                "tool": name,
                "tool_count": len(_tool_catalogue()),
                "virtual_tools": sorted(_VIRTUAL_CALLABLES),
                "registry_envelope": detail,
            },
        )

    arguments = _normalise_arguments(name, params.get("arguments"))
    session_id = params.get("session_id") or _SESSION_ID or ""
    if isinstance(session_id, str):
        session_id = session_id.strip()
    _inject_session_id(name, arguments, session_id)

    t0 = time.perf_counter()
    try:
        raw = reg.execute(name, arguments)
    except Exception:  # noqa: BLE001 - registry.execute should already catch; belt and braces
        elapsed = time.perf_counter() - t0
        detail = traceback.format_exc()
        _log(f"tool {name} raised: {detail.splitlines()[-1]}")
        return _render_result(
            name,
            json.dumps({"status": "error", "tool": name, "error": detail[-2000:]}, ensure_ascii=False),
            elapsed,
            session_id,
        )
    return _render_result(name, raw, time.perf_counter() - t0, session_id)


def _handle_skills_list() -> dict:
    loader = _skills_loader()
    skills = []
    for skill in loader.skills:
        content = loader.get_content(skill.name)
        skills.append(
            {
                "name": skill.name,
                "description": skill.description,
                "category": getattr(skill, "category", "other"),
                "chars": len(content) if isinstance(content, str) else 0,
            }
        )
    skills.sort(key=lambda s: s["name"])
    return {"count": len(skills), "skills": skills}


def _handle_skills_load(params: dict) -> dict:
    name = params.get("name")
    if not isinstance(name, str) or not name.strip():
        raise RpcError(-32602, "skills/load requires a 'name' string", {"params": list(params)})
    name = name.strip()

    call_params: dict = {"name": name}
    section = params.get("section")
    if isinstance(section, str) and section.strip():
        call_params["section"] = section
    offset = params.get("offset")
    if offset is not None:
        try:
            call_params["offset"] = max(int(offset), 0)
        except (TypeError, ValueError):
            raise RpcError(-32602, "offset must be an integer", {"offset": repr(offset)})

    reg = _registry()
    t0 = time.perf_counter()
    if reg.get("load_skill") is not None:
        raw = reg.execute("load_skill", call_params)
    else:  # pragma: no cover - registry without the load_skill tool
        content = _skills_loader().get_content(name)
        raw = json.dumps(
            {"status": "ok", "mode": "document", "content": content,
             "offset": 0, "next_offset": None, "complete": True,
             "total_chars": len(content)},
            ensure_ascii=False,
        )
    result = _render_result(name, raw, time.perf_counter() - t0, None)
    result["request"] = call_params
    return result


def _handle_shutdown() -> dict:
    return {"ok": True, "uptime_sec": round(time.perf_counter() - T_START, 3), "requests": _REQUESTS}


# ---------------------------------------------------------------------------
# Grounding gate (number verification) — lazy, optional
# ---------------------------------------------------------------------------

_GROUNDING = None


def _grounding_adapter():
    """Import the grounding adapter on first use (keeps startup fast)."""
    global _GROUNDING
    if _GROUNDING is None:
        try:
            from grounding_adapter import GroundingAdapter
        except ImportError:  # pragma: no cover - script dir not on sys.path
            import importlib.util

            here = Path(__file__).resolve().parent / "grounding_adapter.py"
            spec = importlib.util.spec_from_file_location("grounding_adapter", here)
            module = importlib.util.module_from_spec(spec)
            assert spec and spec.loader
            spec.loader.exec_module(module)
            GroundingAdapter = module.GroundingAdapter
        _GROUNDING = GroundingAdapter()
    return _GROUNDING


def _grounding_call(method: str, params: dict) -> dict:
    return getattr(_grounding_adapter(), method)(params)


_HANDLERS = {
    "ping": lambda _p: _handle_ping(),
    "capabilities": lambda _p: _handle_capabilities(),
    "tools/list": lambda _p: _handle_tools_list(),
    "tools/call": _handle_tools_call,
    "skills/list": lambda _p: _handle_skills_list(),
    "skills/load": _handle_skills_load,
    "grounding/create": lambda p: _grounding_call("create", p),
    "grounding/reset": lambda p: _grounding_call("reset", p),
    "grounding/status": lambda p: _grounding_call("status", p),
    "grounding/authorize": lambda p: _grounding_call("authorize", p),
    "grounding/ingest": lambda p: _grounding_call("ingest", p),
    "grounding/declare": lambda p: _grounding_call("declare", p),
    "grounding/validate": lambda p: _grounding_call("validate", p),
}


# ---------------------------------------------------------------------------
# Request dispatch / server loop
# ---------------------------------------------------------------------------


def _dispatch(req: dict) -> dict | None:
    """Turn one request object into a response envelope (None for notifications)."""
    if not isinstance(req, dict):
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32600, "message": "invalid request: expected a JSON object"},
        }

    rid = req.get("id")
    method = req.get("method")
    params = req.get("params")
    if params is None:
        params = {}
    is_notification = "id" not in req or rid is None

    if not isinstance(method, str) or not method:
        if is_notification:
            return None
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32600, "message": "invalid request: missing 'method'"},
        }

    if method.startswith("notifications/"):
        return None  # nothing in this worker needs the MCP notification stream

    handler = _HANDLERS.get(method)
    if handler is None:
        if is_notification:
            return None
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32601, "message": f"unknown method {method!r}",
                      "data": {"methods": sorted(_HANDLERS) + ["shutdown"]}},
        }

    if is_notification:
        return None

    try:
        if not isinstance(params, dict):
            raise RpcError(-32602, "params must be an object", {"got": type(params).__name__})
        result = handler(params)
    except RpcError as exc:
        return {"jsonrpc": "2.0", "id": rid, "error": exc.envelope()}
    except Exception as exc:  # noqa: BLE001 - never kill the loop
        detail = traceback.format_exc()
        _log(f"internal error on {method!r}: {detail.splitlines()[-1]}")
        return {
            "jsonrpc": "2.0",
            "id": rid,
            "error": {"code": -32603, "message": f"internal error: {exc}",
                      "data": {"detail": detail[-1500:]}},
        }
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def _serve_request(req: dict) -> None:
    """Handle a request on a pool thread and emit its response (best effort)."""
    global _INFLIGHT
    try:
        response = _dispatch(req)
        if response is not None:
            _emit(response)
    finally:
        with _INFLIGHT_COND:
            _INFLIGHT -= 1
            _INFLIGHT_COND.notify_all()


def _begin_request() -> None:
    """Mark one request as in flight (pool thread clears it when done)."""
    global _INFLIGHT
    with _INFLIGHT_COND:
        _INFLIGHT += 1


def _wait_quiescent(timeout: float) -> None:
    """Wait until no request is in flight, up to ``timeout`` seconds."""
    deadline = time.monotonic() + max(timeout, 0.0)
    with _INFLIGHT_COND:
        while _INFLIGHT > 0:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return
            _INFLIGHT_COND.wait(remaining)


# ---------------------------------------------------------------------------
# Startup
# ---------------------------------------------------------------------------


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(
        description="Vibe-Trading worker: newline-delimited JSON-RPC 2.0 over stdio.",
    )
    ap.add_argument("--session-id", default=os.environ.get("VIBE_TRADING_SESSION_ID", ""),
                    help="default session id injected into session-scoped tools")
    ap.add_argument("--cwd", default="", help="working directory (default: repository root)")
    ap.add_argument("--workers", type=int, default=4,
                    help="thread-pool size; long tools do not block other requests (default 4)")
    ap.add_argument("--max-chars", type=int, default=None,
                    help="result cap in characters (0 disables; default 10000, env "
                         "VIBE_TRADING_WORKER_MAX_CHARS)")
    ap.add_argument("--no-truncate", action="store_true", help="disable the result cap")
    ap.add_argument("--no-lean", action="store_true",
                    help="import src.agent normally (loads langchain; slower startup)")
    ap.add_argument("--shutdown-grace", type=float, default=3.0,
                    help="seconds to let in-flight calls finish on shutdown (default 3)")
    ap.add_argument("--verbose", action="store_true", help="INFO-level logs on stderr")
    ap.add_argument("--version", action="version", version=f"version={WORKER_VERSION}")
    return ap.parse_args(argv)


def _configure_logging(verbose: bool) -> None:
    level = logging.INFO if verbose else logging.WARNING
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler(sys.stderr)
        handler.setFormatter(logging.Formatter("[%(levelname)s] %(name)s: %(message)s"))
        root.addHandler(handler)
    root.setLevel(level)
    logging.captureWarnings(True)


def _apply_env_defaults() -> None:
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    # Chart tools must never open a GUI window in a headless worker.
    os.environ.setdefault("MPLBACKEND", "Agg")
    if not os.environ.get("VIBE_TRADING_HOME"):
        # Standalone local runs keep their state in the git-ignored scratch dir.
        home = REPO_ROOT / ".tmp" / "vibe-home"
        home.mkdir(parents=True, exist_ok=True)
        os.environ["VIBE_TRADING_HOME"] = str(home)


def _apply_user_patch() -> dict:
    """Import a user-supplied monkey-patch module once at startup.

    ``VIBE_TRADING_DSH_PATCH`` names a ``.py`` file (by convention under
    ``~/.vibe-trading/dsh/patches/``). It runs after the tool registry is built,
    so a patch may adjust both data loaders and registered tools.

    The patch is also applied to **child** Python processes: the backtest runs in
    a subprocess and does its own loader/chain resolution there, so a
    worker-only patch would be invisible to the engine. ``worker/patch_bootstrap``
    holds a ``sitecustomize`` that applies the same file at interpreter startup;
    prepending it to ``PYTHONPATH`` is enough to reach every child.

    Contract: a broken patch must never take the worker down. Every failure is
    logged and reported through ``ping`` so the operator can see it instead of
    guessing why a source behaves differently.
    """
    raw = (os.environ.get("VIBE_TRADING_DSH_PATCH") or "").strip()
    if not raw:
        return {"enabled": False}

    from importlib import util as _importlib_util

    resolved = Path(raw).expanduser()
    info = {"enabled": True, "path": str(resolved), "ok": False, "error": "", "children": False}
    if not resolved.is_file():
        info["error"] = "patch file not found"
        _log(f"user patch: {resolved} not found; skipping")
        return info
    try:
        spec = _importlib_util.spec_from_file_location("vt_user_patch", resolved)
        if spec is None or spec.loader is None:
            raise ImportError("cannot build an import spec")
        module = _importlib_util.module_from_spec(spec)
        sys.modules["vt_user_patch"] = module
        spec.loader.exec_module(module)
        info["ok"] = True
        _log(f"user patch applied: {resolved}")
    except BaseException as exc:  # noqa: BLE001 - a patch must never crash the worker
        info["error"] = f"{type(exc).__name__}: {exc}"
        _log(f"user patch failed: {info['error']}")
        _log(traceback.format_exc())
        return info

    # Reach the backtest subprocess (and any other Python child) as well. The
    # runner copies only an env allowlist, so the patch path travels in a JSON
    # file next to the bootstrap `sitecustomize.py`, and the directory itself
    # rides on PYTHONPATH (which the allowlist does keep).
    info["children"] = _install_child_bootstrap(resolved)
    return info


def _install_child_bootstrap(patch_path: Path) -> bool:
    """Materialise the startup bootstrap so child Python processes patch too.

    Returns False (and logs) when the bootstrap could not be installed; the
    worker-side patch still applies in that case.
    """
    source = Path(__file__).resolve().parent / "patch_bootstrap" / "sitecustomize.py"
    if not source.is_file():
        _log("user patch: bootstrap sitecustomize.py missing; children unpatchable")
        return False
    try:
        runtime_home = Path(os.environ.get("VIBE_TRADING_HOME") or (REPO_ROOT / ".tmp" / "vibe-home"))
        target = runtime_home / "patch_bootstrap"
        target.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, target / "sitecustomize.py")

        db = os.environ.get("DATABRIDGE_DB") or ""
        if not db:
            candidate = runtime_home.parent / "databridge" / "market.duckdb"
            if candidate.is_file():
                db = str(candidate)
        (target / "bootstrap.json").write_text(
            json.dumps({"patch": str(patch_path), "db": db}, ensure_ascii=False),
            encoding="utf-8",
        )

        existing = os.environ.get("PYTHONPATH", "")
        parts = [str(target)] + [p for p in existing.split(os.pathsep) if p and p != str(target)]
        os.environ["PYTHONPATH"] = os.pathsep.join(parts)
        _log(f"user patch: child bootstrap ready at {target} (db={db or 'unset'})")
        return True
    except Exception as exc:  # noqa: BLE001 - bootstrap is best effort
        _log(f"user patch: child bootstrap failed: {type(exc).__name__}: {exc}")
        return False


def _resolve_cap(args: argparse.Namespace) -> tuple[int, bool]:
    """Return (limit, identity) for the result cap."""
    if args.no_truncate:
        return 0, True
    if args.max_chars is not None:
        limit = max(int(args.max_chars), 0)
        return limit, limit == 0
    env = os.environ.get("VIBE_TRADING_WORKER_MAX_CHARS", "").strip()
    if env:
        try:
            limit = max(int(env), 0)
            return limit, limit == 0
        except ValueError:
            _log(f"ignoring non-integer VIBE_TRADING_WORKER_MAX_CHARS={env!r}")
    return 10_000, False


def _readline_binary() -> bytes:
    """Read one line from stdin as bytes (encoding-independent)."""
    stream = sys.stdin
    buffer = getattr(stream, "buffer", None)
    if buffer is not None:
        return buffer.readline()
    line = stream.readline()
    return line.encode("utf-8", "replace") if line else b""


def main(argv: list[str] | None = None) -> int:
    global _REGISTRY, _SESSION_ID, _STARTUP, _LEAN_REQUESTED, _TRUNCATE_LIMIT, _TRUNCATE_IDENTITY
    global _REQUESTS

    _capture_protocol_stream()
    args = _parse_args(argv)
    _configure_logging(args.verbose)
    _apply_env_defaults()

    workdir = Path(args.cwd).expanduser() if args.cwd else REPO_ROOT
    if not workdir.is_absolute():
        workdir = (REPO_ROOT / workdir).resolve()
    if not workdir.is_dir():
        _log(f"--cwd {workdir} is not a directory; staying in {os.getcwd()}")
    else:
        os.chdir(workdir)

    _SESSION_ID = (args.session_id or "").strip()
    _LEAN_REQUESTED = not args.no_lean
    _TRUNCATE_LIMIT, _TRUNCATE_IDENTITY = _resolve_cap(args)

    t_build0 = time.perf_counter()
    try:
        _REGISTRY, metrics = _build_registry(_LEAN_REQUESTED, _SESSION_ID)
    except RpcError as exc:
        _log(f"fatal: {exc.message}")
        _emit({"jsonrpc": "2.0", "id": None, "error": exc.envelope()})
        return 2
    t_ready = time.perf_counter()

    # Build the published catalogue now (registry + virtual tools) so argument
    # coercion and session-id injection work even if the first call is a
    # tools/call that never saw a tools/list.
    published = _tool_catalogue()
    t_catalogue = time.perf_counter()

    _STARTUP = {
        "import_sec": metrics["import_sec"],
        "build_sec": metrics["build_sec"],
        "build_total_sec": round(t_ready - t_build0, 3),
        "catalogue_sec": round(t_catalogue - t_ready, 3),
        "total_sec": round(t_catalogue - T_START, 3),
        "path": metrics.get("import_path", "plain"),
        "fallback_reason": metrics.get("fallback_reason", ""),
        "registry_tools": len(_REGISTRY),
        "virtual_tools": len(published) - len(_REGISTRY),
        "published_tools": len(published),
        # Run the operator's monkey patch last: the registry exists, so a patch
        # can touch loaders, tools and chains in one place.
        "user_patch": _apply_user_patch(),
    }
    _log(
        f"ready in {_STARTUP['total_sec']}s: {len(published)} tools "
        f"({len(_REGISTRY)} registry + {len(published) - len(_REGISTRY)} virtual), "
        f"lean={metrics['lean_used']}, session_id={_SESSION_ID or '(none)'}, "
        f"cap={0 if _TRUNCATE_IDENTITY else _TRUNCATE_LIMIT}"
    )

    workers = max(1, int(args.workers or 1))
    pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="vtool")
    try:
        while True:
            raw = _readline_binary()
            if not raw:
                _log("stdin closed; shutting down")
                break
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue

            try:
                req = json.loads(line)
            except json.JSONDecodeError as exc:
                _emit({"jsonrpc": "2.0", "id": None,
                       "error": {"code": -32700, "message": f"parse error: {exc}"}})
                continue

            is_request = isinstance(req, dict) and req.get("id") is not None
            if is_request:
                _REQUESTS += 1

            if is_request and req.get("method") == "shutdown":
                _emit({"jsonrpc": "2.0", "id": req.get("id"), "result": _handle_shutdown()})
                _wait_quiescent(args.shutdown_grace)
                break

            _begin_request()
            pool.submit(_serve_request, req)
    except KeyboardInterrupt:  # pragma: no cover - interactive Ctrl+C
        _log("interrupted")
    finally:
        pool.shutdown(wait=False)
        _wait_quiescent(args.shutdown_grace)
        with _INFLIGHT_COND:
            remaining = _INFLIGHT > 0
        if remaining:  # pragma: no cover - hung tool at shutdown
            _log(f"exiting with {_INFLIGHT} call(s) still running")
            os._exit(0)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
