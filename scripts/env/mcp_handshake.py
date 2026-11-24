#!/usr/bin/env python3
"""Raw MCP stdio handshake + tools/list (+ optional tools/call) probe.

Spawns a stdio MCP server (newline-delimited JSON-RPC 2.0, no Content-Length
framing), performs initialize -> notifications/initialized -> tools/list
(paginated) -> optional tools/call, and writes a JSON report.

Usage:
  python mcp_handshake.py --exe .venv/Scripts/vibe-trading-mcp.exe \
      --out scripts/env/mcp-tools.json [--call search_symbol --args '{"query":"Apple","limit":3}']
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

PROTOCOL_VERSION = "2025-06-18"


class StdioMCPClient:
    def __init__(self, cmd: list[str], env: dict[str, str], cwd: str | None = None):
        self.proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env=env,
            cwd=cwd,
            bufsize=0,
        )
        self._next_id = 0
        self.stdout_noise: list[str] = []
        self.stderr_lines: list[str] = []
        self._stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        self._stderr_thread.start()

    def _drain_stderr(self) -> None:
        assert self.proc.stderr is not None
        for raw in iter(self.proc.stderr.readline, b""):
            try:
                line = raw.decode("utf-8", "replace").rstrip("\r\n")
            except Exception:  # pragma: no cover
                line = repr(raw)
            if line:
                self.stderr_lines.append(line)

    def send(self, obj: dict) -> None:
        assert self.proc.stdin is not None
        payload = json.dumps(obj, ensure_ascii=False).encode("utf-8") + b"\n"
        self.proc.stdin.write(payload)
        self.proc.stdin.flush()

    def request(self, method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
        self._next_id += 1
        req_id = self._next_id
        msg: dict = {"jsonrpc": "2.0", "id": req_id, "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)
        return self._await(rid=req_id, timeout=timeout)

    def _await(self, rid: int, timeout: float) -> dict:
        assert self.proc.stdout is not None
        deadline = time.monotonic() + timeout
        result: dict | None = None

        def _reader() -> None:
            nonlocal result
            while True:
                raw = self.proc.stdout.readline()
                if not raw:
                    return
                text = raw.decode("utf-8", "replace").strip()
                if not text:
                    continue
                try:
                    obj = json.loads(text)
                except json.JSONDecodeError:
                    self.stdout_noise.append(text)
                    continue
                if obj.get("id") == rid and ("result" in obj or "error" in obj):
                    result = obj
                    return
                # Server-initiated notification/log on the same stream: ignore.

        t = threading.Thread(target=_reader, daemon=True)
        t.start()
        t.join(max(0.0, deadline - time.monotonic()))
        if result is None:
            raise TimeoutError(
                f"timeout after {timeout}s waiting for id={rid}; "
                f"stderr_tail={self.stderr_lines[-5:]!r}"
            )
        return result

    def notify(self, method: str, params: dict | None = None) -> None:
        msg: dict = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            msg["params"] = params
        self.send(msg)

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=10)
        self._stderr_thread.join(timeout=2)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--exe", required=True, help="MCP server executable (stdio)")
    ap.add_argument("--out", required=True, help="Path for the JSON report")
    ap.add_argument("--call", default=None, help="Tool name for a tools/call sanity test")
    ap.add_argument("--args", default="{}", help="JSON object of tool arguments")
    ap.add_argument("--protocol", default=PROTOCOL_VERSION)
    ap.add_argument("--timeout", type=float, default=180.0)
    args = ap.parse_args()

    exe = Path(args.exe).resolve()
    if not exe.exists():
        print(f"ERROR: not found: {exe}", file=sys.stderr)
        return 2

    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env.setdefault("PYTHONUNBUFFERED", "1")

    t0 = time.perf_counter()
    client = StdioMCPClient([str(exe), "--transport", "stdio"], env=env)
    report: dict = {"exe": str(exe), "protocol_requested": args.protocol}

    try:
        # 1) initialize -- this is the startup / import cost of the server.
        init = client.request(
            "initialize",
            {
                "protocolVersion": args.protocol,
                "capabilities": {"roots": {"listChanged": False}},
                "clientInfo": {"name": "dsh-env-probe", "version": "1.0.0"},
            },
            timeout=args.timeout,
        )
        report["startup_sec"] = round(time.perf_counter() - t0, 3)
        srv = (init.get("result") or {}).get("serverInfo") or {}
        report["server_info"] = srv
        report["protocol_negotiated"] = (init.get("result") or {}).get("protocolVersion")
        report["capabilities"] = (init.get("result") or {}).get("capabilities")
        if "error" in init:
            report["initialize_error"] = init["error"]

        # 2) initialized notification (required by spec before any other request)
        client.notify("notifications/initialized", {})
        time.sleep(0.05)

        # 3) tools/list, following nextCursor pagination.
        tools: list[dict] = []
        cursor = None
        pages = 0
        t_list0 = time.perf_counter()
        while True:
            params = {"cursor": cursor} if cursor else {}
            res = client.request("tools/list", params, timeout=args.timeout)
            pages += 1
            if "error" in res:
                report["tools_list_error"] = res["error"]
                break
            page = res.get("result") or {}
            tools.extend(page.get("tools") or [])
            cursor = page.get("nextCursor")
            if not cursor:
                break
            if pages > 50:
                report["tools_list_error"] = "pagination runaway (>50 pages)"
                break
        report["tools_list_sec"] = round(time.perf_counter() - t_list0, 3)
        report["tool_count"] = len(tools)
        report["tool_pages"] = pages

        # store full schemas but keep the file reasonably small
        report["tools"] = [
            {
                "name": t.get("name"),
                "title": t.get("title"),
                "description": (t.get("description") or "")[:800],
                "input_schema_keys": sorted(((t.get("inputSchema") or {}).get("properties") or {}).keys()),
                "required": ((t.get("inputSchema") or {}).get("required") or []),
            }
            for t in tools
        ]
        report["tool_names"] = [t.get("name") for t in tools]

        # 4) optional cheap read-only tools/call
        if args.call:
            call_args = json.loads(args.args)
            t_call0 = time.perf_counter()
            try:
                res = client.request(
                    "tools/call",
                    {"name": args.call, "arguments": call_args},
                    timeout=args.timeout,
                )
                report["tool_call"] = {
                    "name": args.call,
                    "arguments": call_args,
                    "elapsed_sec": round(time.perf_counter() - t_call0, 3),
                    "isError": (res.get("result") or {}).get("isError"),
                    "content": (res.get("result") or {}).get("content"),
                    "raw_error": res.get("error"),
                }
            except Exception as exc:  # noqa: BLE001
                report["tool_call"] = {
                    "name": args.call,
                    "arguments": call_args,
                    "elapsed_sec": round(time.perf_counter() - t_call0, 3),
                    "exception": f"{type(exc).__name__}: {exc}",
                }
    finally:
        report["stdout_noise"] = client.stdout_noise[:50]
        client.close()
        time.sleep(0.2)
        report["stderr_lines"] = client.stderr_lines[:400]
        report["stderr_line_count"] = len(client.stderr_lines)
        report["total_sec"] = round(time.perf_counter() - t0, 3)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"tool_count={report.get('tool_count')} pages={report.get('tool_pages')}")
    print(f"startup_sec={report.get('startup_sec')} tools_list_sec={report.get('tools_list_sec')}")
    print(f"serverInfo={report.get('server_info')} protocol={report.get('protocol_negotiated')}")
    print(f"stderr_lines={report.get('stderr_line_count')} stdout_noise={len(report.get('stdout_noise') or [])}")
    print(f"report={out.resolve()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
