#!/usr/bin/env python3
"""Report whether DSH session logs are still mid-turn.

A substring search for "turn/end" is unreliable: tool results and quoted text can
contain it. Parse the JSONL records and compare turn/start vs turn/end instead.

Usage: python scripts/dev/session-state.py <session.v4.jsonl.zstd> [...]
Exit code 0 = all idle (last turn ended), 1 = at least one running.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import zstandard


def decompress(path: Path) -> str:
    data = path.read_bytes()
    out = bytearray()
    while data:
        dctx = zstandard.ZstdDecompressor().decompressobj()
        out += dctx.decompress(data)
        rest = dctx.unused_data
        if not rest or rest == data:
            break
        data = rest
    return bytes(out).decode("utf-8", "replace")


def state(path: Path) -> dict:
    records = []
    for line in decompress(path).splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    types = [record.get("type") for record in records]
    starts = types.count("turn/start")
    ends = types.count("turn/end")
    calls = types.count("tool/call")
    return {
        "starts": starts,
        "ends": ends,
        "calls": calls,
        "running": starts > ends,
        "last": types[-1] if types else None,
        "records": len(records),
    }


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    running = False
    for raw in argv:
        path = Path(raw)
        if not path.exists():
            print(f"{path.name}: missing")
            running = True
            continue
        info = state(path)
        running = running or info["running"]
        label = "running" if info["running"] else "idle"
        print(
            f"{path.parent.name}: {label} turns={info['starts']}/{info['ends']} "
            f"calls={info['calls']} records={info['records']} last={info['last']}"
        )
    return 1 if running else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
