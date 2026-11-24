"""Shared helpers for the local benchmark scripts under ``scripts/env/``.

The repo is a uv project: the environment is ``.venv/`` created by ``uv sync``,
and benchmark state lives under ``.tmp/`` (git-ignored scratch) so nothing leaks
into the repository root.

Import from a script after adding this directory to ``sys.path``::

    from env_common import child_env, mcp_exe, python_exe, vibe_home
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]


def _venv_python(base: Path) -> Path | None:
    windows = base / "Scripts" / "python.exe"
    posix = base / "bin" / "python3"
    if windows.is_file():
        return windows
    if posix.is_file():
        return posix
    fallback = base / "bin" / "python"
    return fallback if fallback.is_file() else None


def python_exe() -> Path:
    """Interpreter for child processes, in preference order.

    1. ``$VIBE_TRADING_PYTHON`` (explicit override)
    2. the interpreter running this script (``uv run`` / activated venv)
    3. the repo ``.venv`` created by ``uv sync``
    4. the installed runtime venv under ``~/.vibe-trading/dsh/venv``
    """
    override = os.environ.get("VIBE_TRADING_PYTHON")
    if override:
        return Path(override)
    if sys.executable:
        current = Path(sys.executable)
        if current.is_file():
            return current
    for base in (REPO / ".venv", Path.home() / ".vibe-trading" / "dsh" / "venv"):
        found = _venv_python(base)
        if found:
            return found
    raise SystemExit("no Python interpreter found; run `uv sync` or set VIBE_TRADING_PYTHON")


def mcp_exe() -> Path:
    """The ``vibe-trading-mcp`` entry point next to the selected interpreter."""
    python = python_exe()
    for name in ("vibe-trading-mcp.exe", "vibe-trading-mcp"):
        candidate = python.parent / name
        if candidate.is_file():
            return candidate
    found = shutil.which("vibe-trading-mcp")
    if found:
        return Path(found)
    raise SystemExit("vibe-trading-mcp not found; run `uv sync` first")


def vibe_home() -> Path:
    """Isolated VIBE_TRADING_HOME for benchmarks (kept out of the repo and real home).

    Defaults to ``.tmp/vibe-home`` (git-ignored). Set ``DSH_VT_BENCH_HOME``
    to reuse a custom path, or ``VIBE_TRADING_HOME`` to accept the caller's.
    (``tempfile.gettempdir()`` is avoided: in some sandboxes it resolves inside
    the repository itself.)
    """
    existing = os.environ.get("VIBE_TRADING_HOME")
    if existing:
        return Path(existing)
    custom = os.environ.get("DSH_VT_BENCH_HOME")
    base = Path(custom) if custom else REPO / ".tmp" / "vibe-home"
    base.mkdir(parents=True, exist_ok=True)
    os.environ["VIBE_TRADING_HOME"] = str(base)
    return base


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Environment for spawned VT processes: UTF-8 and the isolated home."""
    env = dict(os.environ)
    env.setdefault("PYTHONUTF8", "1")
    env.setdefault("PYTHONIOENCODING", "utf-8")
    env["VIBE_TRADING_HOME"] = str(vibe_home())
    if extra:
        env.update(extra)
    return env
