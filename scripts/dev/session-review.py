#!/usr/bin/env python3
"""Dump a detailed, readable transcript of one DSH session log for review.

Usage: session-review.py <session.v4.jsonl.zstd> <out.txt>
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import zstandard


def decompress_all(path: Path) -> bytes:
    data = path.read_bytes()
    out = bytearray()
    while data:
        decompressor = zstandard.ZstdDecompressor().decompressobj()
        out += decompressor.decompress(data)
        rest = decompressor.unused_data
        if not rest or rest == data:
            break
        data = rest
    return bytes(out)


def text_of(content) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
                elif block.get("type") == "reasoning":
                    parts.append(f"[reasoning] {str(block.get('text', ''))[:200]}")
                elif block.get("type") in {"tool-call", "tool_call"}:
                    parts.append(f"[tool-call {block.get('name')}]")
        return "\n".join(parts)
    return json.dumps(content, ensure_ascii=False)


def main(argv: list[str]) -> int:
    src = Path(argv[1])
    out = Path(argv[2])
    limit = int(argv[3]) if len(argv) > 3 else 600

    text = decompress_all(src).decode("utf-8", "replace")
    records = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    lines: list[str] = []
    tool_calls: dict[str, dict] = {}
    stats: dict[str, int] = {}
    errors = 0
    turns = 0

    for record in records:
        kind = record.get("type") or ""
        data = record.get("data") or {}
        seq = record.get("seq")
        when = record.get("time")
        stamp = datetime.fromtimestamp(when / 1000, tz=timezone.utc).astimezone().strftime("%H:%M:%S") if when else ""
        seq_text = f"{seq:>4}" if isinstance(seq, int) else "   -"
        prefix = f"{seq_text} {stamp} "

        if kind == "user/message":
            content = data.get("message", {}).get("content") or data.get("content")
            body = text_of(content)
            if body.startswith("Vibe Trading") or "system-reminder" in body or body.startswith("Time sampled"):
                lines.append(prefix + "USER (system-ish): " + body[:limit].replace("\n", " ⏎ "))
            else:
                lines.append(prefix + "USER: " + body[:limit].replace("\n", " ⏎ "))
        elif kind == "assistant/message":
            message = data.get("message") or {}
            content = message.get("content") or []
            body = text_of(content)
            calls = []
            for block in content if isinstance(content, list) else []:
                if isinstance(block, dict) and block.get("type") in {"tool-call", "tool_call"}:
                    calls.append(block.get("name"))
            lines.append(prefix + f"ASSISTANT calls={calls}: " + body[:limit].replace("\n", " ⏎ "))
        elif kind == "tool/call":
            name = data.get("name")
            args = data.get("arguments")
            stats[name] = stats.get(name, 0) + 1
            tool_calls[data.get("callId", "")] = {"name": name, "args": args}
            lines.append(prefix + f"CALL {name} " + str(args)[:limit].replace("\n", " "))
        elif kind == "tool/result":
            message = data.get("message") or {}
            content = message.get("content")
            body = text_of(content)
            is_error = bool(message.get("isError"))
            if is_error:
                errors += 1
            lines.append(prefix + f"RESULT err={is_error}: " + body[:limit].replace("\n", " ⏎ "))
        elif kind == "command/run":
            lines.append(prefix + f"COMMAND/RUN {data.get('name')}")
        elif kind == "command/done":
            lines.append(prefix + f"COMMAND/DONE {data.get('kind')}: " + str(data.get("text", ""))[:limit].replace("\n", " ⏎ "))
        elif kind == "turn/start":
            turns += 1
            lines.append(prefix + f"TURN START turn={data.get('turn')}")
        elif kind in {"session", "request/header"}:
            if kind == "session":
                lines.append(prefix + f"SESSION cwd={data.get('cwd')} preset={data.get('agentPreset')}")
        elif kind == "step/end":
            status = data.get("status") or data.get("reason")
            if status and status not in {"ok", "completed"}:
                lines.append(prefix + f"STEP END {status}")
        elif kind == "error" or data.get("error"):
            lines.append(prefix + f"ERROR {json.dumps(record, ensure_ascii=False)[:limit]}")

    header = [
        f"records={len(records)} turns={turns} toolCalls={sum(stats.values())} toolErrors={errors}",
        f"tools={json.dumps(stats, ensure_ascii=False)}",
        "",
    ]
    out.write_text("\n".join(header + lines) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(lines)} lines)")
    print("tools:", stats, "errors:", errors, "turns:", turns)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
