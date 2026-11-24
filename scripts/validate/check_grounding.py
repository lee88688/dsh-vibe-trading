#!/usr/bin/env python3
"""Validate the worker's grounding endpoints end to end.

Spawns the worker, creates a grounding session, feeds it a fabricated evidence
set and checks that:

1. a tool call with a symbol is blocked before ``search_symbol`` ran;
2. after ingesting a resolver result the symbol is locked;
3. a normal ``get_market_data`` call is then allowed;
4. an answer quoting a number with no evidence is rejected with a correction;
5. a truthful answer passes.

Run with the project venv:
  uv run python scripts/validate/check_grounding.py
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if len(sys.argv) > 1 and sys.argv[1] not in ("-h", "--help"):
    PY_OVERRIDE = Path(sys.argv[1])
else:
    PY_OVERRIDE = None
INSTALLED_PY = Path.home() / ".vibe-trading" / "dsh" / "venv" / "Scripts" / "python.exe"
DEV_VENV = ROOT / ".venv"

def _venv_python(base: Path) -> Path:
    for candidate in (base / "Scripts" / "python.exe", base / "bin" / "python3", base / "bin" / "python"):
        if candidate.is_file():
            return candidate
    return base / "bin" / "python"

VENV_PY = PY_OVERRIDE or (INSTALLED_PY if INSTALLED_PY.is_file() else _venv_python(DEV_VENV))
WORKER = ROOT / "worker" / "vibe_trading_worker.py"

checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")


class Worker:
    def __init__(self) -> None:
        env = dict(os.environ)
        env.setdefault("PYTHONUTF8", "1")
        env.setdefault("PYTHONIOENCODING", "utf-8")
        work = ROOT / "scripts" / "validate" / "fixtures" / "grounding-work"
        work.mkdir(parents=True, exist_ok=True)
        scratch = ROOT / ".tmp" / "check-grounding-home"
        scratch.mkdir(parents=True, exist_ok=True)
        env["VIBE_TRADING_HOME"] = str(scratch)
        env["VIBE_TRADING_ALLOWED_RUN_ROOTS"] = str(work)
        self.proc = subprocess.Popen(
            [str(VENV_PY), str(WORKER), "--cwd", str(work)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        self.seq = 0

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
                if "error" in payload:
                    raise RuntimeError(f"{method}: {payload['error']}")
                return payload.get("result") or {}
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
    print("== grounding gate validation ==")
    started = time.time()
    worker = Worker()
    try:
        ping = worker.call("ping")
        check("ping", ping.get("ok") is True, f"tools={ping.get('tools')}")

        session = "validate-grounding"
        created = worker.call(
            "grounding/create",
            {"session_id": session, "user_message": "How did Apple close last week?"},
        )
        check("create", created.get("ok") is True, f"run_dir={created.get('run_dir')}")

        blocked = worker.call(
            "grounding/authorize",
            {"session_id": session, "name": "get_market_data", "arguments": {"codes": ["AAPL.US"]}},
        )
        check(
            "identity gate blocks before resolver",
            blocked.get("allowed") is False,
            f"code={blocked.get('error_code')}",
        )

        # Simulate the resolver result (the real tool returns this shape).
        resolver_result = json.dumps(
            {
                "ok": True,
                "market": "us",
                "source": "symbol_search",
                "data": {
                    "query": "Apple",
                    "count": 1,
                    "candidates": [
                        {"symbol": "AAPL.US", "name": "Apple Inc.", "market": "us", "type": "美股"}
                    ],
                    "sources": {"eastmoney": "ok"},
                },
            },
            ensure_ascii=False,
        )
        authorized = worker.call(
            "grounding/authorize",
            {"session_id": session, "name": "search_symbol", "arguments": {"query": "Apple"}},
        )
        check("resolver allowed", authorized.get("allowed") is True)
        ingested = worker.call(
            "grounding/ingest",
            {
                "session_id": session,
                "name": "search_symbol",
                "arguments": {"query": "Apple"},
                "result": resolver_result,
                "call_id": "call-resolver-1",
                "success": True,
            },
        )
        check("resolver ingested", ingested.get("ok") is True, f"status={ingested.get('identity_status')}")

        allowed = worker.call(
            "grounding/authorize",
            {"session_id": session, "name": "get_market_data", "arguments": {"codes": ["AAPL.US"]}},
        )
        check("identity gate allows locked symbol", allowed.get("allowed") is True, f"symbols={allowed.get('authorized_symbols')}")

        # Fabricated number, no evidence for it.
        bad_answer = "AAPL.US closed at 999.99 USD on 2026-11-03. That is a 12.34% gain."
        bad = worker.call("grounding/validate", {"session_id": session, "content": bad_answer})
        check("fabricated figure rejected", bad.get("valid") is False, f"issues={len(bad.get('issues') or [])}")
        correction = str(bad.get("correction_prompt") or "")
        check("correction prompt provided", bool(correction))
        check(
            "correction uses the report_figures channel",
            "report_figures" in correction
            and "End the answer with a ```figures``` block" not in correction
            and "not released to the user" not in correction,
            f"chars={len(correction)}",
        )
        details = bad.get("details") or []
        check(
            "validate returns footer details",
            bool(details)
            and all(isinstance(row.get("value"), str) and row.get("value") for row in details)
            and all("context" in row and "reason" in row for row in details),
            f"details={len(details)}",
        )
        check(
            "validate returns pass/suppress counts",
            isinstance(bad.get("passed_count"), int) and isinstance(bad.get("suppressed_count"), int),
            f"passed={bad.get('passed_count')} suppressed={bad.get('suppressed_count')}",
        )

        good_answer = "I could not retrieve a verified price for AAPL.US, so I will not quote one."
        good = worker.call("grounding/validate", {"session_id": session, "content": good_answer})
        check("truthful answer passes", good.get("valid") is True)

        # --- declaration channel (report_figures) ---
        bad_decl = worker.call(
            "grounding/declare",
            {"session_id": session, "figures": ["not-a-four-column-line"]},
        )
        check("declare rejects malformed line", bad_decl.get("ok") is False and bad_decl.get("issues"))

        # A chosen parameter (count) needs no evidence; a version string in the
        # same draft must be suppressed as non-financial.
        draft_ok = "折扣系数：97%。（Python 3.12.14）"
        declared = worker.call(
            "grounding/declare",
            {
                "session_id": session,
                "figures": ["97% | count | 折扣系数"],
                "draft": draft_ok,
            },
        )
        check(
            "declare validates draft",
            declared.get("validated") is True and declared.get("ok") is True,
            f"issues={declared.get('issues')} suppressed={len(declared.get('suppressed') or [])}",
        )
        suppressed_rules = {row.get("rule") for row in (declared.get("suppressed") or [])}
        check(
            "non-financial number suppressed",
            "versions" in suppressed_rules,
            f"suppressed={sorted(r for r in suppressed_rules if r)}",
        )
        check(
            "suppression summarized for the footer panel",
            any(row.get("rule") == "versions" for row in (declared.get("suppressed_rules") or [])),
            f"rules={declared.get('suppressed_rules')}",
        )

        # A narrative rewrite must stay valid: VT validates the final text against
        # the stored declarations; drift alone is informational.
        paraphrased = worker.call(
            "grounding/validate",
            {"session_id": session, "content": "折扣系数是 97%（Python 3.12.14）。"},
        )
        check(
            "paraphrased answer stays valid",
            paraphrased.get("valid") is True and paraphrased.get("draft_drift") is True,
            f"valid={paraphrased.get('valid')} drift={paraphrased.get('draft_drift')} issues={paraphrased.get('issues')}",
        )

        # A draft-only re-check (`figures: []` + draft) must reuse the stored
        # declarations: emptying the ledger used to turn every previously
        # verified figure into "no evidence" on the next round.
        reused = worker.call(
            "grounding/declare",
            {"session_id": session, "figures": [], "draft": "折扣系数是 97%（Python 3.12.14）。"},
        )
        check(
            "empty declaration reuses the stored ledger",
            reused.get("validated") is True and reused.get("reused") is True and reused.get("ok") is True,
            f"validated={reused.get('validated')} reused={reused.get('reused')} issues={reused.get('issues')}",
        )
        after_reuse = worker.call("grounding/validate", {"session_id": session, "content": "折扣系数：97%。"})
        check(
            "stored declarations survive the empty re-check",
            after_reuse.get("valid") is True and after_reuse.get("declarations") == 1,
            f"valid={after_reuse.get('valid')} declarations={after_reuse.get('declarations')}",
        )

        draft_bad = "折扣系数：98%，没有依据的 999.99。"
        bad = worker.call(
            "grounding/declare",
            {
                "session_id": session,
                "figures": ["97% | count | 折扣系数"],
                "draft": draft_bad,
            },
        )
        check("fabricated number rejected by declare", bad.get("ok") is False and bad.get("issues"))

        drift = worker.call(
            "grounding/validate",
            {"session_id": session, "content": "AAPL.US 收于 321.00。"},
        )
        codes = {row.get("code") for row in (drift.get("issues") or [])}
        check("drifted answer flagged", drift.get("valid") is False or "unvalidated_change" in codes, f"codes={sorted(c for c in codes if c)}")

        status = worker.call("grounding/status", {"session_id": session})
        check("status", status.get("ok") is True, f"tools={status.get('tool_results')}")

        reset = worker.call("grounding/reset", {"session_id": session})
        check("reset", reset.get("existed") is True)
    finally:
        worker.close()

    passed = sum(1 for _, ok, _ in checks if ok)
    total = len(checks)
    print(f"\nRESULT: {'PASS' if passed == total else 'FAIL'} ({passed}/{total} checks, {time.time() - started:.1f}s)")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
