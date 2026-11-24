"""Adapter exposing Vibe-Trading's grounding gate over the worker's JSON-RPC.

Vibe-Trading's number discipline lives in ``src.agent.grounding``: a run-scoped
evidence ledger, an identity state machine, a ``figures`` declaration protocol
and a final-answer validator. That package is pure stdlib and deliberately free
of provider/tool-registry dependencies, so the worker can import it directly.

DSH cannot rewrite an assistant message once it is committed, so the plugin
moves the ``figures`` declaration out of the answer text and into a tool call
(``report_figures``). This adapter owns both halves of that contract:

* ``grounding/declare``  — validate + store declarations, and (when a draft is
  supplied) run the full VT validator against ``draft + synthesized block`` so
  the model learns about problems before it emits the answer.
* ``grounding/validate`` — re-run the validator on the final answer with the
  stored declarations appended, and reject a final answer that drifted from the
  validated draft.

Issues that clearly concern non-financial numbers (URLs, paths, code, version
strings, dates, section numbers, ids) are suppressed according to configurable
rules and reported back as ``suppressed`` entries for the audit trail.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import uuid
from pathlib import Path
from typing import Any, Mapping

ROLES = ("observed", "derived", "proposed", "cited", "count")

DEFAULT_BLOCK_LANGUAGE = "figures"

DEFAULT_IGNORE_RULES: dict[str, Any] = {
    "urls": True,
    "paths": True,
    "code": True,
    "versions": True,
    "dates": True,
    "sections": True,
    "ids": True,
    "extra": [],
}

_URL_RE = re.compile(r"(?:https?|ftp|file)://[^\s\"'）)】]+")
_WIN_PATH_RE = re.compile(r"[A-Za-z]:\\[^\s\"'）)】]+")
_POSIX_PATH_RE = re.compile(r"(?:(?<=^)|(?<=[\s(\"'`]))(?:/[A-Za-z0-9._-]+){2,}")
_FENCE_RE = re.compile(r"(```|~~~).*?\1", re.DOTALL)
_INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
_VERSION_RE = re.compile(r"^v?\d+(?:\.\d+){2,}(?:[-+][0-9A-Za-z.-]+)?$")
_DATE_RE = re.compile(r"^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$")
_TIME_RE = re.compile(r"^\d{1,2}:\d{2}(?::\d{2})?$")
_UUID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
_HEX_RE = re.compile(r"^[0-9a-fA-F]{8,}$")
_VERSION_TOKEN_RE = re.compile(r"v?\d+(?:\.\d+){2,}(?:[-+][0-9A-Za-z.-]+)?")
_DATE_TOKEN_RE = re.compile(r"\d{4}[-/.]\d{1,2}(?:[-/.]\d{1,2})?")
_SECTION_TOKEN_RE = re.compile(r"(?:第|§)\s*\d+(?:\.\d+)*(?:\s*[条章节])?")


def _default_runs_root() -> Path:
    """Directory holding VT run artifacts (grounding evidence lives under it).

    The DSH plugin sets ``VIBE_TRADING_HOME`` to its own data root and pins
    ``VIBE_TRADING_ALLOWED_RUN_ROOTS`` to ``<that root>/runs``, so the explicit
    allowed root wins. The fallbacks keep vanilla VT (``~/.vibe-trading/runs``)
    and older plugin layouts (``<vibeHome>/dsh/work/runs``) working.
    """
    for item in os.environ.get("VIBE_TRADING_ALLOWED_RUN_ROOTS", "").split(","):
        item = item.strip()
        if item:
            return Path(item).expanduser()
    home = os.environ.get("VIBE_TRADING_HOME")
    base = Path(home) if home else Path.home() / ".vibe-trading"
    if (base / "dsh").is_dir():
        return base / "dsh" / "work" / "runs"
    return base / "runs"


_QUOTE_MAP = {
    "\u201c": '"',
    "\u201d": '"',
    "\u201e": '"',
    "\u201f": '"',
    "\u300c": '"',
    "\u300d": '"',
    "\u300e": '"',
    "\u300f": '"',
    "\u2018": "'",
    "\u2019": "'",
    "\u2013": "-",
    "\u2014": "-",
    "\u2026": "...",
    "\u00a0": " ",
}
_QUOTE_RE = re.compile("|".join(re.escape(key) for key in _QUOTE_MAP))


def _normalize_text(text: str) -> str:
    """Normalize whitespace and typographic punctuation for draft comparison."""
    value = (text or "").strip()
    value = _QUOTE_RE.sub(lambda match: _QUOTE_MAP[match.group(0)], value)
    return re.sub(r"\s+", " ", value)


def _sha256(text: str) -> str:
    return hashlib.sha256(_normalize_text(text).encode("utf-8")).hexdigest()


def _normalize_declaration(line: str) -> tuple[str | None, list[str]]:
    """Return ``(normalized_line, problems)`` for one ``value | role | note | ref`` row."""
    problems: list[str] = []
    raw = (line or "").strip()
    if not raw:
        return None, ["empty declaration line"]
    parts = [part.strip() for part in re.split(r"[|｜]", raw)]
    # VT's parser is lenient about the trailing ref for a chosen parameter
    # (97% | count | discount factor); the declaration channel mirrors that.
    if len(parts) == 3:
        value, role, note = parts
        ref = ""
    elif len(parts) == 4:
        value, role, note, ref = parts
    else:
        return None, [f"expected 3 columns (count) or 4 columns (value | role | note | ref), got {len(parts)}: {raw[:120]}"]
    if not value:
        problems.append("empty value")
    if role.lower() not in ROLES:
        problems.append(f"unknown role {role!r}; use one of {', '.join(ROLES)}")
    if not ref and role.lower() != "count":
        problems.append("empty ref")
    columns = [value, role.lower(), note] + ([ref] if ref else [])
    return " | ".join(columns), problems


def _build_block(lines: list[str]) -> str:
    return f"\n\n```{DEFAULT_BLOCK_LANGUAGE}\n" + "\n".join(lines) + f"\n```"


# The upstream correction prompt is written for Vibe-Trading's own loop: it says
# the rejected draft "was not released to the user" and asks for a fenced
# ``figures`` block in the answer. In DSH the rejected draft is already visible
# and declarations go through the ``report_figures`` tool, so the text must be
# re-pointed at this deployment's channel before it is steered to the model.
_DSH_CORRECTION_HEADER = (
    "[GROUNDING GATE] The previous draft was rejected. It is already visible to the user "
    "in this conversation; do not repeat the rejected figures and do not claim they were "
    "never shown."
)
_DSH_FIGURES_INSTRUCTION = (
    "Before the final answer, call `report_figures({figures, draft})` declaring every number "
    "that carries a decimal point, a percent sign, a currency mark or a table cell, one line per "
    "figure as `value | role | note | ref`, where role is one of observed / derived / proposed / "
    "cited / count and `draft` is the exact answer text you will output. Keep the answer body free "
    "of any ```figures``` block: the gate reads the declaration from the tool call, not from the "
    "prose. Reuse the exact locked symbol and venue; do not attach a figure to a symbol no tool "
    "call in this session handled - report it as not retrieved instead."
)


def _adapt_correction_prompt(text: str) -> str:
    """Re-point the upstream correction prompt at the DSH declaration channel."""
    if not text:
        return text
    adapted = text.replace(
        "[GROUNDING GATE] The previous draft was rejected and was not released to the user.",
        _DSH_CORRECTION_HEADER,
    ).replace("in the figures block", "in the report_figures declaration")
    start = adapted.find("End the answer with a ```figures``` block")
    if start >= 0:
        end_marker = "report it as not retrieved instead."
        end = adapted.find(end_marker, start)
        end = end + len(end_marker) if end >= 0 else len(adapted)
        adapted = adapted[:start] + _DSH_FIGURES_INSTRUCTION + adapted[end:]
    return adapted


class GroundingAdapter:
    """One ``GroundingLedger`` per DSH session, created on demand."""

    def __init__(self, runs_root: Path | None = None) -> None:
        self._runs_root = runs_root or _default_runs_root()
        self._ledgers: dict[str, Any] = {}
        self._meta: dict[str, dict[str, Any]] = {}
        self._declarations: dict[str, list[str]] = {}
        self._last_validated: dict[str, str] = {}
        self._suppressions: dict[str, list[dict[str, Any]]] = {}

    # -- lifecycle ---------------------------------------------------------

    def create(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        if not session_id:
            raise ValueError("session_id is required")
        user_message = str(params.get("user_message") or "")
        history = params.get("history") or None
        run_dir = params.get("run_dir")

        if run_dir:
            target = Path(str(run_dir))
        else:
            stamp = time.strftime("%Y%m%d-%H%M%S")
            safe = "".join(ch if ch.isalnum() or ch in "-_" else "-" for ch in session_id)[:40]
            target = self._runs_root / f"{safe}-{stamp}-{uuid.uuid4().hex[:6]}"
        target.mkdir(parents=True, exist_ok=True)

        from src.agent.grounding import GroundingLedger

        ledger = GroundingLedger(run_dir=target, user_message=user_message, history=history)
        self._ledgers[session_id] = ledger
        self._declarations[session_id] = []
        self._last_validated.pop(session_id, None)
        self._suppressions[session_id] = []
        self._meta[session_id] = {
            "run_dir": str(target),
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "tool_results": 0,
        }
        return {"ok": True, "session_id": session_id, "run_dir": str(target), "identity_status": ledger.identity_status}

    def reset(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        existed = self._ledgers.pop(session_id, None) is not None
        self._meta.pop(session_id, None)
        self._declarations.pop(session_id, None)
        self._last_validated.pop(session_id, None)
        self._suppressions.pop(session_id, None)
        return {"ok": True, "session_id": session_id, "existed": existed}

    def status(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        ledger = self._ledgers.get(session_id)
        if ledger is None:
            return {"ok": False, "session_id": session_id, "error": "no grounding session"}
        meta = self._meta.get(session_id, {})
        return {
            "ok": True,
            "session_id": session_id,
            "run_dir": meta.get("run_dir"),
            "created_at": meta.get("created_at"),
            "tool_results": meta.get("tool_results", 0),
            "identity_status": ledger.identity_status,
            "identity_summary": ledger.identity_summary(),
            "authorized_symbols": sorted(ledger.authorized_symbols),
            "declarations": len(self._declarations.get(session_id, [])),
            "draft_validated": session_id in self._last_validated,
            "suppressed": len(self._suppressions.get(session_id, [])),
        }

    # -- gate --------------------------------------------------------------

    def _ledger(self, session_id: str) -> Any:
        ledger = self._ledgers.get(session_id)
        if ledger is None:
            raise ValueError(f"no grounding session for {session_id!r}; call grounding/create first")
        return ledger

    def authorize(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        ledger = self._ledger(session_id)
        tool_name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        if not isinstance(arguments, Mapping):
            raise ValueError("arguments must be an object")
        call_id = str(params.get("call_id") or f"call-{uuid.uuid4().hex[:8]}")
        decision = ledger.authorize_tool_call(
            tool_name,
            arguments,
            batch_authorized_symbols=ledger.authorized_symbols,
            call_id=call_id,
            batch_identity_status=ledger.identity_status,
        )
        payload: dict[str, Any] = {
            "ok": True,
            "allowed": bool(decision.allowed),
            "identity_status": ledger.identity_status,
            "authorized_symbols": sorted(ledger.authorized_symbols),
        }
        if not decision.allowed:
            payload["error_code"] = decision.error_code
            payload["message"] = decision.message
            payload["symbols"] = list(decision.symbols or ())
            payload["required_action"] = (
                "Call search_symbol with the instrument name or ticker first, then retry "
                "this call with the returned canonical symbol. If search_symbol returned "
                "several candidates, pick one canonical symbol (or ask the user) before "
                "calling market-data tools."
            )
        return payload

    def ingest(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        ledger = self._ledger(session_id)
        tool_name = str(params.get("name") or "")
        arguments = params.get("arguments") or {}
        result = params.get("result")
        if not isinstance(result, str):
            result = json.dumps(result, ensure_ascii=False)
        call_id = str(params.get("call_id") or f"call-{uuid.uuid4().hex[:8]}")
        success = bool(params.get("success", True))
        try:
            ledger.ingest_tool_result(
                tool_name=tool_name,
                arguments=arguments if isinstance(arguments, Mapping) else {},
                result=result,
                call_id=call_id,
                success=success,
            )
        except Exception as error:  # evidence is best-effort: never break a tool call
            return {"ok": False, "error": f"{type(error).__name__}: {error}"}
        meta = self._meta.setdefault(session_id, {})
        meta["tool_results"] = int(meta.get("tool_results", 0)) + 1
        return {
            "ok": True,
            "session_id": session_id,
            "identity_status": ledger.identity_status,
            "evidence_chars": len(result),
            "tool_results": meta["tool_results"],
        }
# -- declarations ------------------------------------------------------

    def declare(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        ledger = self._ledger(session_id)
        raw_figures = params.get("figures")
        if isinstance(raw_figures, str):
            raw_figures = [line for line in raw_figures.splitlines() if line.strip()]
        if not isinstance(raw_figures, list):
            raw_figures = []

        problems: list[dict[str, Any]] = []
        normalized: list[str] = []
        for index, line in enumerate(raw_figures, start=1):
            fixed, line_problems = _normalize_declaration(str(line))
            for problem in line_problems:
                problems.append({"index": index, "code": "declaration_format", "reason": problem})
            if fixed is not None:
                normalized.append(fixed)
        # A derived figure must carry a formula the validator can evaluate.
        if not problems:
            try:
                from src.agent.grounding.policies import _formula_in_note
            except Exception:  # pragma: no cover - import drift
                _formula_in_note = None
            if _formula_in_note is not None:
                for index, line in enumerate(normalized, start=1):
                    parts = [part.strip() for part in re.split(r"[|｜]", line)]
                    value, role, note = parts[0], parts[1], parts[2] if len(parts) > 2 else ""
                    if role == "derived" and _formula_in_note(note) is None:
                        problems.append(
                            {
                                "index": index,
                                "code": "derived_formula",
                                "reason": f"derived figure {value!r} needs an arithmetic formula in 'note'",
                            }
                        )
        if problems:
            text = "数字声明格式有误，请修正后重试：\n" + "\n".join(
                f"- 第{row['index']}行：{row['reason']}" for row in problems
            )
            return {"ok": False, "count": 0, "issues": problems, "text": text}

        submitted = bool(normalized)
        stored = list(self._declarations.get(session_id) or [])
        if submitted:
            self._declarations[session_id] = normalized
        elif stored:
            # A draft-only check (`figures: []` + `draft`) must not drop the
            # declarations the answer was built on: the final-answer validation
            # reuses the ledger, and emptying it turns every previously
            # verified figure into "no evidence" on the next round.
            normalized = stored
        validate = bool(params.get("validate", True)) and bool(normalized)
        draft = params.get("draft")
        if not validate or not isinstance(draft, str) or not draft.strip():
            if not normalized:
                text = "本次未提交数字声明，且本会话还没有已记录的声明。"
            elif not submitted:
                text = f"沿用已记录的 {len(normalized)} 条数字声明（本次未提交新的声明；没有 draft，不校验）。"
            elif not params.get("validate", True):
                text = f"已记录 {len(normalized)} 条数字声明。（数字核实门禁未启用，仅记录，不校验。）"
            else:
                text = f"已记录 {len(normalized)} 条数字声明。（没有提供 draft，仅记录，不校验。）"
            return {
                "ok": True,
                "recorded": submitted,
                "reused": bool(normalized) and not submitted,
                "validated": False,
                "count": len(normalized),
                "text": text,
            }

        content = draft.rstrip() + _build_block(normalized)
        validation = ledger.validate_final_answer(content)
        issues, suppressed = _filter_issues(validation.issues, content, params.get("ignore"))
        self._last_validated[session_id] = _sha256(draft)
        self._suppressions.setdefault(session_id, []).extend(suppressed)
        ok = len(issues) == 0
        payload: dict[str, Any] = {
            "ok": ok,
            "recorded": submitted,
            "reused": bool(normalized) and not submitted,
            "validated": True,
            "count": len(normalized),
            "draft_sha256": self._last_validated[session_id],
            "issues": issues,
            "suppressed": suppressed,
            **_gate_details(validation, issues, suppressed, content),
        }
        if ok:
            payload["text"] = (
                f"数字声明校验通过（{len(normalized)} 条）"
                + (f"，已忽略 {len(suppressed)} 处非财务数字。" if suppressed else "。")
                + " 现在把 draft 原文作为最终回答输出，不要输出 figures 代码块。"
            )
        else:
            payload["text"] = (
                f"数字声明校验未通过（{len(issues)} 处问题）：\n"
                + "\n".join(_issue_line(issue) for issue in issues[:12])
                + (
                    "\n修正提示：\n"
                    + "\n".join(
                        "- " + hint
                        for hint in list(dict.fromkeys(_fix_hint(issue) for issue in issues))[:5]
                        if hint
                    )
                    if any(_fix_hint(issue) for issue in issues)
                    else ""
                )
                + "\n修正数字或补充 observed/derived 依据后重新调用 report_figures；不要向用户输出这些数字的版本。"
            )
        return payload

    def validate(self, params: Mapping[str, Any]) -> dict[str, Any]:
        session_id = str(params.get("session_id") or "").strip()
        ledger = self._ledger(session_id)
        content = str(params.get("content") or "")
        declarations = self._declarations.get(session_id) or []
        block = _build_block(declarations) if declarations else ""
        combined = content.rstrip() + block if block else content
        validation = ledger.validate_final_answer(combined)
        issues, suppressed = _filter_issues(validation.issues, combined, params.get("ignore"))
        self._suppressions.setdefault(session_id, []).extend(suppressed)

        # A narrative rewrite is not itself a number problem: VT validates the
        # final text against the stored declarations below. Drift only matters
        # when that validation still finds issues, where reusing the validated
        # draft is the quickest fix.
        expected = self._last_validated.get(session_id)
        drift = expected is not None and _sha256(content) != expected
        correction = None
        if issues:
            try:
                correction = _adapt_correction_prompt(ledger.correction_prompt(validation))
            except Exception:  # pragma: no cover - defensive
                correction = "回答未通过数字核实，请修正后重新提交。"
            if drift:
                correction = (
                    correction.rstrip()
                    + "\n你交给 report_figures 的草稿已经通过校验，但与当前正文不一致；"
                    "最简单的是改回草稿原文（只改文字措辞时也请先重新调用 report_figures）。"
                )

        ok = len(issues) == 0
        return {
            "ok": True,
            "valid": ok,
            "issues": issues,
            "suppressed": suppressed,
            **_gate_details(validation, issues, suppressed, combined),
            "released_text": validation.released_text,
            "passed_figures": list(validation.passed_figures),
            "identity_status": ledger.identity_status,
            "declarations": len(declarations),
            "draft_validated": expected is not None,
            "draft_drift": drift,
            **({"correction_prompt": correction} if correction else {}),
        }


# -- issue filtering -------------------------------------------------------


def _context(content: str, start: int, end: int, radius: int = 12) -> tuple[str, str]:
    return content[max(0, start - radius) : start], content[end : end + radius]


def _suppression_rule(content: str, span_text: str, start: int, end: int, rules: Mapping[str, Any]) -> str | None:
    before, after = _context(content, start, end)
    if rules.get("urls", True):
        for match in _URL_RE.finditer(content):
            if match.start() <= start and end <= match.end():
                return "urls"
    if rules.get("paths", True):
        for pattern in (_WIN_PATH_RE, _POSIX_PATH_RE):
            for match in pattern.finditer(content):
                if match.start() <= start and end <= match.end():
                    return "paths"
    if rules.get("code", True):
        for pattern in (_FENCE_RE, _INLINE_CODE_RE):
            for match in pattern.finditer(content):
                if match.start() <= start and end <= match.end():
                    return "code"
    # A scanned token is often only a fragment of a longer token: VT's number
    # regex reads "Python 3.12.14" as "3.12" and "14". Suppression therefore
    # checks the enclosing token as well.
    if rules.get("versions", True):
        for match in _VERSION_TOKEN_RE.finditer(content):
            if match.start() <= start and end <= match.end():
                return "versions"
        if _VERSION_RE.match(span_text):
            return "versions"
        if re.search(r"(?:^|[\s(（\[【])v$", before, re.IGNORECASE) and re.match(r"^\d", span_text):
            return "versions"
        if before.endswith(("版本", "version ", "Version ")) and re.match(r"^\d", span_text):
            return "versions"
    if rules.get("dates", True):
        for match in _DATE_TOKEN_RE.finditer(content):
            if match.start() <= start and end <= match.end():
                return "dates"
        if _TIME_RE.match(span_text):
            return "dates"
        if before.endswith(("年", "月", "日")) and span_text.isdigit():
            return "dates"
    if rules.get("sections", True):
        for match in _SECTION_TOKEN_RE.finditer(content):
            if match.start() <= start and end <= match.end():
                return "sections"
        if before.endswith(("（", "(")) and after.startswith(("）", ")")):
            return "sections"
        if re.match(r"^[一二三四五六七八九十]+$", span_text) and after.startswith(("、", "，", "。")):
            return "sections"
    if rules.get("ids", True):
        if _UUID_RE.match(span_text) or (_HEX_RE.match(span_text) and len(span_text) >= 12):
            return "ids"
    for extra in rules.get("extra") or []:
        try:
            if re.search(str(extra), span_text) or re.search(str(extra), before + span_text + after):
                return f"extra:{extra}"
        except re.error:
            continue
    return None


def _clean(text: Any, limit: int) -> str:
    """Single-line, length-bounded text for the client-facing gate panel."""
    return " ".join(str(text or "").split())[:limit]


def _issue_detail(issue: Mapping[str, Any], content: str) -> dict[str, Any]:
    """One issue as the footer panel shows it: value, nearby context, reason."""
    value = _clean(issue.get("value") or issue.get("figure") or "", 40)
    context = ""
    span = issue.get("span")
    if isinstance(span, (list, tuple)) and len(span) == 2:
        try:
            start, end = int(span[0]), int(span[1])
            if 0 <= start <= end <= len(content):
                if not value:
                    value = _clean(content[start:end], 40)
                context = _clean(content[max(0, start - 30) : min(len(content), end + 30)], 60)
        except (TypeError, ValueError):
            pass
    if not context:
        context = _clean(issue.get("message") or issue.get("snippet") or "", 60)
    reason = _clean(issue.get("code") or issue.get("reason") or "unverified", 40)
    return {"value": value or "?", "context": context, "reason": reason}


def _gate_details(validation: Any, issues: list[dict[str, Any]], suppressed: list[dict[str, Any]], content: str) -> dict[str, Any]:
    """Bounded machine-readable summary attached to a disclosure message.

    The footer panel groups three things: figures that failed/never got declared,
    declarations that passed, and numbers the ignore rules exempted (no report
    needed). Counts stay exact; lists are capped so the steered message stays
    small.
    """
    details = [_issue_detail(issue, content) for issue in issues[:5]]
    passed = [str(line) for line in (getattr(validation, "passed_figures", None) or [])]
    passed_values = []
    for line in passed[:8]:
        value = line.split("|", 1)[0].strip()
        if value:
            passed_values.append(_clean(value, 24))
    rules: dict[str, int] = {}
    for entry in suppressed:
        rule = str(entry.get("rule") or "extra")
        rules[rule] = rules.get(rule, 0) + 1
    rule_summary = [
        {"rule": rule, "count": count}
        for rule, count in sorted(rules.items(), key=lambda item: (-item[1], item[0]))[:4]
    ]
    return {
        "details": details,
        "details_truncated": max(0, len(issues) - len(details)),
        "passed_count": len(passed),
        "passed_values": passed_values,
        "suppressed_count": len(suppressed),
        "suppressed_rules": rule_summary,
    }


def _filter_issues(
    issues: list[dict[str, Any]],
    content: str,
    rules: Mapping[str, Any] | None,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    merged = dict(DEFAULT_IGNORE_RULES)
    if isinstance(rules, Mapping):
        merged.update(rules)
    kept: list[dict[str, Any]] = []
    suppressed: list[dict[str, Any]] = []
    for issue in issues:
        span = issue.get("span")
        text = ""
        start = end = 0
        if isinstance(span, (list, tuple)) and len(span) == 2:
            try:
                start, end = int(span[0]), int(span[1])
                if 0 <= start <= end <= len(content):
                    text = content[start:end]
            except (TypeError, ValueError):
                pass
        rule = _suppression_rule(content, text or str(issue.get("value") or ""), start, end, merged) if text else None
        if rule:
            suppressed.append(
                {
                    "rule": rule,
                    "code": issue.get("code"),
                    "value": text or issue.get("value"),
                    "span": [start, end] if text else None,
                    "snippet": content[max(0, start - 24) : end + 24],
                }
            )
            continue
        kept.append(issue)
    return kept, suppressed


_FIX_HINTS = {
    "citation_not_visible": "cited/derived figures: write the source name in the SAME sentence as the number",
    "not_in_referenced_call": "the ref must name the exact tool call (call_id) or tool whose result contains the value",
    "operand_not_observed": "every operand of a derived formula must be an observed value declared in the list",
    "additive_operand_not_observed": "added/subtracted terms must each be observed; do not mix a cited number into arithmetic",
    "data_source_not_surfaced": "price claims must surface the data source name and quote currency in the prose",
    "figure_undeclared": "declare every non-price figure (signed %, ratio, amount, count) that appears in the draft",
    "value_mismatch": "the declared value differs from the tool value; quote the tool value or fix the formula",
    "formula_not_anchored": "derived notes must contain an arithmetic formula, not a description",
    "unparseable_declaration": "use value | role | note | ref on one line; no markdown table cells inside a line",
    "no_evidence": "this figure has no matching tool result in this session; fetch it or remove the claim",
}


def _fix_hint(issue: Mapping[str, Any]) -> str:
    for key in (issue.get("reason"), issue.get("code")):
        if isinstance(key, str) and key in _FIX_HINTS:
            return _FIX_HINTS[key]
    return ""


def _issue_line(issue: Mapping[str, Any]) -> str:
    code = issue.get("code") or "issue"
    value = issue.get("value")
    reason = issue.get("reason") or issue.get("message") or ""
    head = f"- {code}"
    if value:
        head += f" [{value}]"
    return f"{head}: {reason}"
