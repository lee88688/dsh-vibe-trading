"""Interpreter-startup bootstrap for the worker's monkey patch.

Why this file exists
--------------------
The worker applies `VIBE_TRADING_DSH_PATCH` in its own process, but a backtest
runs in a **subprocess** (`backtest.runner`), and source/loader registration
happens there too. A patch that only touched the worker would be invisible to
the engine, so `source: "<my_source>"` would be rejected.

The runner does not forward arbitrary env vars to that subprocess — it copies a
fixed allowlist (`_copy_runtime_env`). `PYTHONPATH` **is** on the allowlist, so
the worker passes its bootstrap directory that way, and `site` imports this
module at interpreter startup. Everything else travels in a JSON file beside it:

    bootstrap.json  {"patch": "<absolute path to the .py>", "db": "<duckdb path>"}

Contract: this module must never raise. It runs inside every subprocess the
worker spawns, including ones that know nothing about the patch.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

_MODULE_NAME = "vt_user_patch"
_CONFIG_NAME = "bootstrap.json"
_ENV_VAR = "VIBE_TRADING_DSH_PATCH"
logger = logging.getLogger("vt_patch_bootstrap")


def _read_config() -> dict:
    here = Path(__file__).resolve().parent
    path = here / _CONFIG_NAME
    try:
        if not path.is_file():
            return {}
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - startup must survive a corrupt config
        return {}


def _apply() -> None:
    config = _read_config()

    # The cache location has to survive the allowlist too: hand it to the patch
    # through an env var the patch already understands.
    db = (config.get("db") or "").strip()
    if db and not os.environ.get("DATABRIDGE_DB"):
        os.environ["DATABRIDGE_DB"] = db

    raw = (config.get("patch") or os.environ.get(_ENV_VAR) or "").strip()
    if not raw:
        return
    if sys.modules.get(_MODULE_NAME) is not None:
        return  # already applied in this process

    try:
        path = Path(raw).expanduser()
        if not path.is_file():
            return
        from importlib import util

        spec = util.spec_from_file_location(_MODULE_NAME, path)
        if spec is None or spec.loader is None:
            return
        module = util.module_from_spec(spec)
        sys.modules[_MODULE_NAME] = module
        spec.loader.exec_module(module)
    except BaseException:  # noqa: BLE001 - a broken patch must not break startup
        sys.modules.pop(_MODULE_NAME, None)
        try:
            logger.warning("user patch failed at interpreter startup: %s", raw, exc_info=True)
        except Exception:
            pass


_apply()
