#!/usr/bin/env python3
"""Extract full text of assistant messages (optionally only the last turn) from a DSH session log."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import zstandard


def decompress_all(path: Path) -> bytes:
    data = path.read_bytes()
    out = bytearray()
    while data:
        d = zstandard.ZstdDecompressor().decompressobj()
        out += d.decompress(data)
        rest = d.unused_data
        if not rest or rest == data:
            break
        data = rest
    return bytes(out)


def blocks_text(content) -> str:
    parts = []
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                parts.append(str(block.get("text", "")))
    elif isinstance(content, str):
        parts.append(content)
    return "\n".join(parts)


def main(argv: list[str]) -> int:
    src = Path(argv[1])
    out = Path(argv[2])
    text = decompress_all(src).decode("utf-8", "replace")
    records = []
    for line in text.splitlines():
        line = line.strip()
        if line:
            try:
                records.append(json.loads(line))
            except json.JSONDecodeError:
                pass

    turn = None
    chunks: list[str] = []
    for record in records:
        kind = record.get("type")
        data = record.get("data") or {}
        if kind == "turn/start":
            turn = data.get("turn")
        if kind == "assistant/message":
            message = data.get("message") or {}
            body = blocks_text(message.get("content"))
            if body.strip():
                chunks.append(f"\n===== assistant (turn={data.get('turn')} step={data.get('step')}) =====\n{body}")
        if kind == "user/message":
            content = data.get("message", {}).get("content") or data.get("content")
            body = blocks_text(content)
            if body and not body.startswith(("Current runtime context", "<system-reminder>", "Time sampled", "Vibe Trading 初始化检查结果")):
                chunks.append(f"\n===== user =====\n{body}")

    out.write_text("\n".join(chunks) + "\n", encoding="utf-8")
    print(f"wrote {out} ({len(chunks)} messages)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
