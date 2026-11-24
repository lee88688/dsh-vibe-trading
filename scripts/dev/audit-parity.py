#!/usr/bin/env python3
"""Audit dsh-vibe-trading parity / T8.2 metrics for one or more DSH sessions.

Usage:
  python scripts/dev/audit-parity.py <session-dir-or-log> [...]
  python scripts/dev/audit-parity.py --sessions-root <root> <sessionId> [...]

Prints a markdown table plus per-session details. Read-only.
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import zstandard


def decompress_all(path: Path) -> str:
    data = path.read_bytes()
    out = bytearray()
    while data:
        d = zstandard.ZstdDecompressor().decompressobj()
        out += d.decompress(data)
        rest = d.unused_data
        if not rest or rest == data:
            break
        data = rest
    return bytes(out).decode("utf-8", "replace")


def blocks_text(content) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(str(b.get("text", "")) for b in content if isinstance(b, dict) and b.get("type") == "text")
    return ""


def normalize(text: str) -> str:
    table = {
        "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u201f": '"',
        "\u300c": '"', "\u300d": '"', "\u2018": "'", "\u2019": "'",
        "\u2013": "-", "\u2014": "-", "\u2026": "...", "\u00a0": " ",
    }
    for key, value in table.items():
        text = text.replace(key, value)
    return re.sub(r"\s+", " ", text.strip())


ISSUE_CODE_RE = re.compile(r"- ([a-z_]+)(?: \[([^\]]+)\])?:")
FIG_ATTEMPT_RE = re.compile(r"数字声明校验(?:未通过（(\d+) 处问题）|通过（(\d+) 条）)")
SUPPRESSED_RE = re.compile(r"已忽略 (\d+) 处非财务数字")


def audit(log_path: Path) -> dict:
    text = decompress_all(log_path)
    records = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    times = [r.get("time") for r in records if isinstance(r.get("time"), (int, float))]
    tools: dict[str, int] = {}
    tool_errors = 0
    report_calls: list[dict] = []
    pending_report = None
    suppressed = 0
    command_texts: list[str] = []
    figures_fence_final = False
    final_text = ""
    turns = 0
    turn_end: list[dict] = []
    header_tools = None

    for record in records:
        kind = record.get("type")
        data = record.get("data") or {}
        if kind == "turn/start":
            turns += 1
        elif kind == "request/header" and header_tools is None:
            header_tools = [t.get("name") for t in (data.get("header") or {}).get("tools") or []]
        elif kind == "command/done":
            command_texts.append(str(data.get("text", "")))
        elif kind == "tool/call":
            name = data.get("name") or ""
            tools[name] = tools.get(name, 0) + 1
            if name == "report_figures":
                try:
                    args = json.loads(data.get("arguments") or "{}")
                except json.JSONDecodeError:
                    args = {}
                pending_report = {
                    "figures": len(args.get("figures") or []),
                    "draft": len(args.get("draft") or ""),
                    "draft_text": args.get("draft") or "",
                    "ok": None,
                    "issues": None,
                    "text": "",
                }
        elif kind == "tool/result":
            message = data.get("message") or {}
            body = blocks_text(message.get("content"))
            if message.get("isError"):
                tool_errors += 1
            if pending_report is not None:
                pending_report["text"] = body
                pending_report["ok"] = not body.startswith("数字声明校验未通过") and "declaration_format" not in body
                codes = ISSUE_CODE_RE.findall(body)
                pending_report["issues"] = len(codes) if codes else (0 if "校验通过" in body else None)
                report_calls.append(pending_report)
                pending_report = None
            suppressed += sum(int(m) for m in SUPPRESSED_RE.findall(body))
        elif kind == "assistant/message":
            body = blocks_text((data.get("message") or {}).get("content"))
            if body.strip():
                final_text = body
        elif kind == "turn/end":
            turn_end.append(data.get("reason") or {})

    figures_fence_final = "```figures" in final_text
    passed = [r for r in report_calls if r["ok"]]
    failed = [r for r in report_calls if not r["ok"]]
    last_ok = passed[-1] if passed else None
    draft_match = None
    if last_ok and last_ok.get("draft_text"):
        draft_match = normalize(last_ok["draft_text"]) == normalize(final_text)
    duration = (times[-1] - times[0]) / 1000 if len(times) >= 2 else None

    return {
        "log": str(log_path),
        "records": len(records),
        "turns": turns,
        "duration_s": duration,
        "tool_calls": sum(tools.values()),
        "tool_errors": tool_errors,
        "tools": dict(sorted(tools.items(), key=lambda item: -item[1])),
        "header_tools": len(header_tools) if header_tools else None,
        "report_attempts": len(report_calls),
        "report_failed": len(failed),
        "report_passed": len(passed),
        "report_final_figures": last_ok["figures"] if last_ok else None,
        "report_issue_history": [r["issues"] for r in report_calls],
        "draft_matches_final": draft_match,
        "figures_fence_in_final": figures_fence_final,
        "final_chars": len(final_text),
        "suppressed": suppressed,
        "pwsh_calls": tools.get("pwsh", 0),
        "turn_end": turn_end,
        "command_texts": command_texts,
    }


def resolve(arg: str) -> Path:
    path = Path(arg)
    if path.is_dir():
        return path / "session.v4.jsonl.zstd"
    return path


def main(argv: list[str]) -> int:
    sessions_root = Path.home() / ".dsh" / "sessions"
    paths: list[Path] = []
    for arg in argv[1:]:
        if arg.startswith("session-"):
            matches = list(sessions_root.glob(f"*/{arg}/session.v4.jsonl.zstd"))
            if matches:
                paths.append(matches[0])
            else:
                print(f"(not found: {arg})")
        else:
            paths.append(resolve(arg))

    results = [audit(path) for path in paths if path.exists()]
    print("| session | 时长 | 工具调用(错误) | report_figures 尝试/失败 | 最终声明数 | 正文有块 | 草稿一致 | suppressed | pwsh |")
    print("|---|---|---|---|---|---|---|---|---|")
    for row in results:
        sid = Path(row["log"]).parent.name
        print(
            f"| {sid} | {row['duration_s']:.0f}s | {row['tool_calls']}({row['tool_errors']}) | "
            f"{row['report_attempts']}/{row['report_failed']} | {row['report_final_figures']} | "
            f"{'YES' if row['figures_fence_in_final'] else 'no'} | "
            f"{row['draft_matches_final']} | {row['suppressed']} | {row['pwsh_calls']} |"
        )
    for row in results:
        print(f"\n### {Path(row['log']).parent.name}")
        print(json.dumps(row, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
