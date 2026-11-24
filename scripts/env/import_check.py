#!/usr/bin/env python3
"""Import-probe the heavy/optional dependencies of vibe-trading-ai on Windows.

Records import success, elapsed time, and the exact exception text for anything
that fails (e.g. weasyprint's missing system pango/cairo DLLs).
"""

from __future__ import annotations

import importlib
import json
import os
import sys
from pathlib import Path
import time
import traceback

# Keep matplotlib headless so the probe cannot pop a window.
os.environ.setdefault("MPLBACKEND", "Agg")

MODULES = [
    "vibe_trading_ai",  # may not exist as a module name; kept to prove it
    "fastmcp",
    "mcp",
    "langchain",
    "langchain_core",
    "langgraph",
    "pandas",
    "numpy",
    "scipy",
    "sklearn",
    "matplotlib",
    "matplotlib.pyplot",
    "duckdb",
    "pypdfium2",
    "pypdf",
    "docx",
    "pptx",
    "openpyxl",
    "reportlab",
    "weasyprint",
    "akshare",
    "tushare",
    "ccxt",
    "yfinance",
    "curl_cffi",
    "mini_racer",
    "keyring",
    "winloop",
    "pywin32",
]


def probe(name: str) -> dict:
    t0 = time.perf_counter()
    try:
        mod = importlib.import_module(name)
        ver = getattr(mod, "__version__", None)
        return {
            "module": name,
            "ok": True,
            "version": str(ver) if ver else None,
            "file": getattr(mod, "__file__", None),
            "sec": round(time.perf_counter() - t0, 3),
        }
    except BaseException as exc:  # noqa: BLE001 - ImportError, OSError, SystemExit...
        tb = traceback.format_exc()
        return {
            "module": name,
            "ok": False,
            "error_type": type(exc).__name__,
            "error": str(exc)[:600],
            "traceback_tail": "\n".join(tb.strip().splitlines()[-4:]),
            "sec": round(time.perf_counter() - t0, 3),
        }


def main() -> int:
    results = [probe(m) for m in MODULES]
    out = {
        "python": sys.version,
        "python_executable": sys.executable,
        "platform": sys.platform,
        "fs_encoding": sys.getfilesystemencoding(),
        "stdout_encoding": (sys.stdout.encoding if sys.stdout else None),
        "locale_preferred": os.environ.get("LANG") or None,
        "results": results,
    }
    path = sys.argv[1] if len(sys.argv) > 1 else str(Path(__file__).resolve().parent / "imports.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    for r in results:
        if r["ok"]:
            print(f"OK   {r['module']:<20} {r['version'] or '':<12} {r['sec']:>6.2f}s")
        else:
            print(f"FAIL {r['module']:<20} {r['error_type']}: {r['error'].splitlines()[0][:150]}")
    print(f"\nwritten: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
