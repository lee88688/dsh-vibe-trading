#!/usr/bin/env python3
"""Summarize which tools a DSH session log actually invoked.

DSH appends one zstd frame per flush, so decompress frame-by-frame.
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
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
    text = decompress_all(path).decode("utf-8", "replace")
    records: list[dict] = []
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    print(f"file: {path.name} records={len(records)}")
    kinds = Counter(record.get("type") or record.get("kind") or "?" for record in records)
    print("kinds:", kinds.most_common(14))

    candidates = [
        "search_symbol", "get_market_data", "read_document", "backtest", "financial_rigor",
        "vt_load_tools", "vt_call", "vt_list_skills", "vt_load_skill", "vibe_trading_setup",
        "pwsh", "bash", "read", "write", "edit", "web_search", "web_fetch",
    ]
    counts: Counter[str] = Counter()
    for record in records:
        blob = json.dumps(record, ensure_ascii=False)
        for name in candidates:
            if re.search(rf'"name"\s*:\s*"{re.escape(name)}"', blob):
                counts[name] += 1
    print("tool-name occurrences:", counts.most_common())

    commands = [record for record in records if "command/" in json.dumps(record, ensure_ascii=False)]
    print(f"command events: {len(commands)}")
    for record in commands[-8:]:
        printable = json.dumps(record, ensure_ascii=False)
        print("  CMD", printable[:300])

    # tool calls / results by name
    for record in records:
        if record.get("type") in {"tool/call", "tool/result"}:
            data = record.get("data") or {}
            name = data.get("name") or (data.get("call") or {}).get("name")
            if name:
                print(f"  {record['type']}: {name}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
