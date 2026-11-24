#!/usr/bin/env python3
"""Repair persisted Session logs whose message events lack identity.

Background: `agent.followup` / `agent.steer` persist the payload verbatim as a
`user/message` event. A payload built as `{ content, source }` (no `id`, no
`role`) passes at runtime but fails Session validation on the next load:

    stored session "<id>" failed validation:
    session event at seq N lacks an identified message

This tool rewrites such logs: every message event gets the missing `id`
(fresh UUID) and `role` (derived from the event type), then the file is
recompressed. A backup of the original bytes is written next to it as
`session.v4.jsonl.zstd.corrupt-backup-<utcstamp>`.

Usage:
  python scripts/dev/repair-session-messages.py --scan            # report only
  python scripts/dev/repair-session-messages.py --all             # repair every corrupt log
  python scripts/dev/repair-session-messages.py <sessionId> [...]
  python scripts/dev/repair-session-messages.py <path/to/session.v4.jsonl.zstd> [...]

Exit code: 0 when nothing remains corrupt after the run, 1 otherwise.
"""
from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import zstandard

ROLE_BY_TYPE = {
    "user/message": "user",
    "developer/message": "developer",
    "assistant/message": "assistant",
    "tool/result": "tool",
    "system/message": "system",
}

LOG_NAME = "session.v4.jsonl.zstd"


def sessions_root() -> Path:
    home = os.environ.get("DSH_HOME") or str(Path.home() / ".dsh")
    return Path(home) / "sessions"


def backup_root() -> Path:
    explicit = os.environ.get("SESSION_REPAIR_BACKUP_DIR")
    if explicit:
        return Path(explicit)
    repo = Path(__file__).resolve().parents[2]
    return repo / ".tmp" / "session-repair-backups"


def decompress(path: Path) -> str:
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


def compress(text: str) -> bytes:
    """Encode one repaired log in the layout DSH writes.

    DSH's reader takes frame 0 of the Zstandard artifact as the Session header
    and rejects a first frame that is not exactly one line
    (`first frame is not exactly one header line`). A single-frame file
    therefore makes the Session unreadable for listing/resume even though the
    content is valid, so the header goes in its own frame and the remaining
    events are batched into further frames.
    """
    lines = text.splitlines(keepends=True)
    if not lines:
        return zstandard.ZstdCompressor(level=3).compress(b"")
    compressor = zstandard.ZstdCompressor(level=3)
    frames = [compressor.compress(lines[0].encode("utf-8"))]
    batch: list[str] = []
    size = 0
    for line in lines[1:]:
        batch.append(line)
        size += len(line)
        if len(batch) >= 40 or size >= 32 * 1024:
            frames.append(compressor.compress("".join(batch).encode("utf-8")))
            batch = []
            size = 0
    if batch:
        frames.append(compressor.compress("".join(batch).encode("utf-8")))
    return b"".join(frames)


def message_of(event_type: str, data):
    if event_type == "user/message":
        return data if isinstance(data, dict) else None
    if isinstance(data, dict):
        message = data.get("message")
        return message if isinstance(message, dict) else None
    return None


def repair_text(text: str) -> tuple[str, int]:
    lines = text.splitlines()
    patched = 0
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_type = record.get("type")
        role = ROLE_BY_TYPE.get(event_type)
        if role is None:
            continue
        data = record.get("data")
        message = message_of(event_type, data)
        if message is None:
            # A structurally broken message event: materialize one so the log validates.
            message = {"content": []}
            if event_type == "user/message":
                record["data"] = message
            else:
                record.setdefault("data", {})["message"] = message
        changed = False
        if not isinstance(message.get("id"), str) or not message.get("id"):
            message["id"] = str(uuid.uuid4())
            changed = True
        if message.get("role") != role:
            message["role"] = role
            changed = True
        if not isinstance(message.get("content"), list):
            message["content"] = []
            changed = True
        if not isinstance(message.get("source"), dict) or not message["source"].get("kind"):
            message["source"] = {"kind": "user"} if role == "user" else message.get("source") or {}
            changed = True
        if changed:
            lines[index] = json.dumps(record, ensure_ascii=False, separators=(",", ":"))
            patched += 1
    return "\n".join(lines) + ("\n" if lines and not lines[-1] == "" else ""), patched


def find_logs(targets: list[str]) -> list[Path]:
    root = sessions_root()
    if not targets:
        return sorted(root.rglob(LOG_NAME))
    found: list[Path] = []
    for target in targets:
        candidate = Path(target)
        if candidate.is_file():
            found.append(candidate)
            continue
        matches = [p for p in root.rglob(LOG_NAME) if p.parent.name == target or p.parent.name.endswith(target)]
        found.extend(matches)
    return found


def is_corrupt(path: Path) -> int:
    """Return the number of malformed message events (0 = healthy)."""
    try:
        text = decompress(path)
    except Exception:
        return -1
    bad = 0
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        event_type = record.get("type")
        role = ROLE_BY_TYPE.get(event_type)
        if role is None:
            continue
        message = message_of(event_type, record.get("data"))
        if (
            message is None
            or not isinstance(message.get("id"), str)
            or not message.get("id")
            or message.get("role") != role
        ):
            bad += 1
    return bad


def main(argv: list[str]) -> int:
    scan_only = "--scan" in argv
    all_logs = "--all" in argv
    reframe = "--reframe" in argv
    if reframe:
        all_logs = True
    emit_dir = None
    if "--emit-dir" in argv:
        index = argv.index("--emit-dir")
        if index + 1 >= len(argv):
            print("--emit-dir needs a directory")
            return 2
        emit_dir = Path(argv[index + 1])
        argv = argv[:index] + argv[index + 2 :]
    targets = [a for a in argv[1:] if not a.startswith("--")]
    if not scan_only and not all_logs and emit_dir is None and not targets:
        print(__doc__)
        return 2

    logs = find_logs(targets) if targets else find_logs([])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    repaired = 0
    remaining = 0
    for path in logs:
        if reframe:
            text = decompress(path)
            if emit_dir is None:
                print(f"REFRAIME-NEEDS-EMIT {path}")
                remaining += 1
                continue
            emit_dir.mkdir(parents=True, exist_ok=True)
            out = emit_dir / f"{path.parent.name}.zstd"
            out.write_bytes(compress(text))
            print(f"EMIT {out} {path}")
            repaired += 1
            continue
        bad = is_corrupt(path)
        if bad <= 0:
            if bad < 0:
                print(f"DECODE-FAIL {path}")
                remaining += 1
            continue
        if scan_only:
            print(f"CORRUPT {path} ({bad} event(s))")
            remaining += 1
            continue
        text = decompress(path)
        patched_text, patched = repair_text(text)
        if patched == 0:
            print(f"NO-CHANGE {path} ({bad} event(s) flagged but nothing patched)")
            remaining += 1
            continue
        if emit_dir is not None:
            emit_dir.mkdir(parents=True, exist_ok=True)
            out = emit_dir / f"{path.parent.name}.zstd"
            out.write_bytes(compress(patched_text))
            print(f"EMIT {out} {path}")
            repaired += 1
            continue
        # In-place: long session paths can exceed MAX_PATH once a suffix is
        # appended, so backups live in the repository scratch (or
        # SESSION_REPAIR_BACKUP_DIR) under a short path.
        backup_dir = backup_root() / stamp
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup = backup_dir / f"{path.parent.name}.zstd"
        backup.write_bytes(path.read_bytes())
        path.write_bytes(compress(patched_text))
        dirty = is_corrupt(path)
        status = "OK" if dirty == 0 else f"STILL-CORRUPT({dirty})"
        print(f"REPAIRED {path.name} ({patched} event(s)) {status} backup={backup}")
        repaired += 1
        if dirty:
            remaining += 1
    print(f"\nrepaired={repaired} remaining_corrupt={remaining}")
    return 0 if remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
