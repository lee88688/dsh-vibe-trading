#!/usr/bin/env python3
"""Dump a compact, UTF-8 timeline of a DSH session log for review."""
from __future__ import annotations

import json
import sys
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


def main(argv: list[str]) -> int:
    path = Path(argv[1])
    out_path = Path(argv[2])
    text = decompress_all(path).decode("utf-8", "replace")
    records = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue

    lines = []
    for record in records:
        kind = record.get("type")
        data = record.get("data") or {}
        seq = record.get("seq")
        when = record.get("time")
        if kind in {"tool/call", "tool/result"}:
            name = data.get("name") or (data.get("call") or {}).get("name")
            args = data.get("arguments") or (data.get("call") or {}).get("arguments")
            if kind == "tool/call":
                lines.append(f"{seq}\t{when}\tCALL {name}\t{json.dumps(args, ensure_ascii=False)[:200]}")
            else:
                text_value = ""
                content = data.get("content") or data.get("result")
                if isinstance(content, list):
                    text_value = " ".join(str(block.get("text", "")) for block in content if isinstance(block, dict))
                elif content is not None:
                    text_value = str(content)
                lines.append(f"{seq}\t{when}\tRESULT {name}\t{text_value[:200]}")
        elif kind in {"command/run", "command/done"}:
            lines.append(f"{seq}\t{when}\t{kind.upper()} {data.get('name', '')} {data.get('kind', '')}\t{data.get('text', '')[:300]}")
        elif kind == "user/message":
            content = data.get("message", {}).get("content") or data.get("content")
            lines.append(f"{seq}\t{when}\tUSER\t{json.dumps(content, ensure_ascii=False)[:300]}")
        elif kind == "assistant/message":
            message = data.get("message") or {}
            content = message.get("content") or []
            text_value = " ".join(str(block.get("text", "")) for block in content if isinstance(block, dict) and block.get("type") == "text")
            calls = [block.get("name") for block in content if isinstance(block, dict) and block.get("type") == "tool-call"]
            lines.append(f"{seq}\t{when}\tASSISTANT tools={calls}\t{text_value[:200]}")
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {len(lines)} lines to {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
