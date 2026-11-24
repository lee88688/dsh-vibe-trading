#!/usr/bin/env python3
"""vt-parity-check / scan.py — read-only parity scan between dsh-vibe-trading and Vibe-Trading.

What it does
------------
Collects the *source of truth* from both sides and runs mechanical comparisons:

  VT side      : installed `vibe-trading-ai` registry (build_registry), MCP surface
                 (mcp_server.mcp.list_tools), skills (installed src/skills + vendor clone),
                 system prompt text (installed src/agent/context.py).
  plugin side  : worker tool/skill surface (spawns worker/vibe_trading_worker.py over
                 JSON-RPC), toolsets.json, prompt/*.md, src/lib/*.ts, worker/*.py,
                 docs/*.md.

It never modifies product files and never calls a network API.  It writes raw JSON
only under <repo>/.tmp/parity/<run-id>/ (git-ignored).  The SKILL is responsible for
the problem table + suggestions; this script prints compact findings with codes.

Usage
-----
  & "$env:USERPROFILE\\.vibe-trading\\dsh\\venv\\Scripts\\python.exe" scan.py
  python scan.py --skip-worker        # quick: skip the JSON-RPC worker spawn
  python scan.py --json-only          # print path of the raw JSON only

Exit code: 0 always (a scan is not a gate); read the findings.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import re
import subprocess
import sys
from pathlib import Path

# --------------------------------------------------------------------------- #
# paths / helpers
# --------------------------------------------------------------------------- #

SCRIPT = Path(__file__).resolve()
SKILL_DIR = SCRIPT.parents[1]
REPO = SCRIPT.parents[4]
TMP_ROOT = REPO / ".tmp" / "parity"

VENDOR = REPO / "_vendor" / "Vibe-Trading"


def read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n")
    except OSError:
        return ""


def sha1(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()


def jdump(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def rel(path: Path) -> str:
    try:
        return str(path.resolve().relative_to(REPO)).replace("\\", "/")
    except ValueError:
        return str(path)


def line_of(text: str, needle: str) -> int | None:
    pos = text.find(needle)
    return None if pos < 0 else text.count("\n", 0, pos) + 1


findings: list[dict] = []


def add(code: str, level: str, area: str, message: str, evidence: str = "", suggestion: str = "") -> None:
    findings.append(
        {"code": code, "level": level, "area": area, "message": message, "evidence": evidence, "suggestion": suggestion}
    )


def find_line(text: str, needle: str) -> str:
    n = line_of(text, needle)
    return f"line {n}" if n else "not found"


def read_tree(*folders: Path) -> str:
    """Concatenate text of source folders (for whole-tree greps)."""
    parts = []
    for folder in folders:
        if not folder.exists():
            continue
        for path in sorted(folder.rglob("*")):
            if path.is_file() and path.suffix in {".ts", ".py", ".js", ".mjs"}:
                parts.append(read(path))
    return "\n".join(parts)


# --------------------------------------------------------------------------- #
# 0. environment / versions
# --------------------------------------------------------------------------- #


def load_config(home: Path | None = None) -> dict:
    home = home or Path(os.environ.get("VIBE_TRADING_HOME") or (Path.home() / ".vibe-trading"))
    cfg = home / "dsh" / "config.json"
    if not cfg.exists():
        return {}
    try:
        return json.loads(read(cfg))
    except json.JSONDecodeError:
        return {}


def git(*args: str) -> str:
    try:
        out = subprocess.run(
            ["git", "-C", str(VENDOR), *args], capture_output=True, text=True, timeout=20
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except OSError:
        return ""


def runtime_version() -> str:
    try:
        from importlib.metadata import version

        return version("vibe-trading-ai")
    except Exception:
        return ""


def plugin_version() -> str:
    try:
        return json.loads(read(REPO / "package.json")).get("version", "")
    except Exception:
        return ""


def prepare_vt_env(scratch: Path) -> None:
    """Isolate VT state inside .tmp/parity/<run>/home before importing VT."""
    home = scratch / "home"
    home.mkdir(parents=True, exist_ok=True)
    os.environ["VIBE_TRADING_HOME"] = str(home)
    os.environ.setdefault("PYTHONUTF8", "1")
    os.environ.setdefault("PYTHONIOENCODING", "utf-8")
    os.environ.setdefault("MPLBACKEND", "Agg")
    for key, sub in {
        "VIBE_TRADING_HYPOTHESES_PATH": "research/hypotheses.json",
        "VIBE_TRADING_GOAL_DB_PATH": "research/goals.sqlite3",
        "VIBE_TRADING_RESEARCH_ARTIFACT_DB_PATH": "research/research_artifacts.sqlite3",
        "VIBE_TRADING_STRATEGY_STORE_DB_PATH": "research/strategy_store.sqlite3",
        "VIBE_TRADING_STRATEGY_DISCOVERY_DB_PATH": "research/strategy_discovery.sqlite3",
        "VIBE_TRADING_PLAYBOOK_DIR": "research/playbooks",
        "VIBE_TRADING_DATA_CACHE_ROOT": "cache",
    }.items():
        os.environ.setdefault(key, str(home / "dsh" / "work" / sub))
    os.chdir(scratch)


# --------------------------------------------------------------------------- #
# 1. VT surface
# --------------------------------------------------------------------------- #


def dump_vt(scratch: Path) -> dict:
    """Return {"version", "registry": {...}, "mcp": [...], "src_pkg", "skills_dir"}.

    Must run after prepare_vt_env(). Import errors are recorded, not raised.
    """
    out: dict = {"version": "", "registry": {}, "mcp": [], "errors": []}
    try:
        from importlib.metadata import version

        out["version"] = version("vibe-trading-ai")
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"importlib.metadata: {exc}")
        return out

    try:
        from src.tools import build_registry

        reg = build_registry()
        entries = []
        for tool in reg._tools.values():  # noqa: SLF001 - read-only introspection
            entries.append(
                {
                    "name": tool.name,
                    "description": getattr(tool, "description", "") or "",
                    "parameters": getattr(tool, "parameters", None) or {"type": "object", "properties": {}},
                    "readonly": bool(getattr(tool, "is_readonly", True)),
                    "repeatable": bool(getattr(tool, "repeatable", False)),
                }
            )
        out["registry"] = {t["name"]: t for t in entries}
        out["registry_order"] = [t["name"] for t in entries]
        out["registry_failures"] = {
            "import": dict(getattr(reg, "import_failures", {}) or {}),
            "registration": dict(getattr(reg, "registration_failures", {}) or {}),
        }
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"src.tools.build_registry: {exc}")

    try:
        import mcp_server

        tools = asyncio.run(mcp_server.mcp.list_tools())
        out["mcp"] = [
            {
                "name": t.name,
                "description": getattr(t, "description", "") or "",
                "parameters": getattr(t, "parameters", None) or getattr(t, "inputSchema", None) or {},
            }
            for t in tools
        ]
    except Exception as exc:  # noqa: BLE001
        out["errors"].append(f"mcp_server list_tools: {exc}")

    try:
        import src

        out["src_pkg"] = str(Path(src.__file__).resolve().parent)
        out["skills_dir"] = str(Path(src.__file__).resolve().parent / "skills")
    except Exception:  # noqa: BLE001
        out["src_pkg"] = out["skills_dir"] = ""
    return out


# --------------------------------------------------------------------------- #
# 2. worker surface (JSON-RPC, same protocol as scripts/validate/capture_worker_surface.py)
# --------------------------------------------------------------------------- #


def dump_worker(scratch: Path) -> dict:
    out: dict = {"tools": [], "skills": [], "error": ""}
    python = os.environ.get("VIBE_TRADING_PYTHON") or sys.executable
    worker = REPO / "worker" / "vibe_trading_worker.py"
    if not Path(python).exists():
        out["error"] = f"no interpreter at {python}"
        return out
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
    try:
        proc = subprocess.Popen(
            [python, str(worker), "--cwd", str(scratch), "--shutdown-grace", "5"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(scratch),
            env=env,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
    except OSError as exc:
        out["error"] = f"spawn: {exc}"
        return out

    seq = 0

    def call(method: str, params: dict | None = None, timeout: float = 120.0) -> dict:
        nonlocal seq
        seq += 1
        request = {"jsonrpc": "2.0", "id": seq, "method": method, "params": params or {}}
        assert proc.stdin and proc.stdout
        proc.stdin.write(json.dumps(request) + "\n")
        proc.stdin.flush()
        import time

        deadline = time.time() + timeout
        while time.time() < deadline:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("worker closed stdout")
            payload = json.loads(line)
            if payload.get("id") == request["id"]:
                return payload
        raise TimeoutError(method)

    try:
        call("ping")
        out["tools"] = (call("tools/list").get("result") or {}).get("tools") or []
        out["skills"] = (call("skills/list").get("result") or {}).get("skills") or []
    except Exception as exc:  # noqa: BLE001
        out["error"] = f"rpc: {exc}"
    finally:
        try:
            call("shutdown", timeout=10)
        except Exception:  # noqa: BLE001
            pass
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001
            proc.kill()
    return out


# --------------------------------------------------------------------------- #
# 3. skills
# --------------------------------------------------------------------------- #


def parse_skill(path: Path) -> dict | None:
    text = read(path)
    if not text.startswith("---"):
        return None
    end = text.find("\n---", 3)
    if end < 0:
        return None
    front, body = text[3:end], text[end + 4 :].lstrip("\n")
    meta: dict = {}
    for line in front.splitlines():
        if ":" not in line or line.startswith((" ", "\t")):
            continue
        key, value = line.split(":", 1)
        meta[key.strip()] = value.strip().strip("\"'")
    return {
        "name": meta.get("name") or path.parent.name,
        "description": meta.get("description", ""),
        "category": meta.get("category", ""),
        "body_sha": sha1(body),
        "body_chars": len(body),
        "has_resources": ("references/" in body) or ("scripts/" in body),
    }


def scan_skill_dir(path: Path) -> list[dict]:
    result = []
    if not path.is_dir():
        return result
    for child in sorted(path.iterdir()):
        skill = child / "SKILL.md"
        if skill.is_file():
            parsed = parse_skill(skill)
            if parsed:
                result.append(parsed)
    return result


# --------------------------------------------------------------------------- #
# 4. checks
# --------------------------------------------------------------------------- #


def check_env(cfg: dict, vt: dict, worker: dict) -> None:
    installed = ((cfg.get("package") or {}).get("installedVersion")) or ""
    minimum = ((cfg.get("package") or {}).get("minimumVersion")) or ""
    if not installed:
        add(
            "ENV01",
            "P1",
            "environment",
            "找不到 ~/.vibe-trading/dsh/config.json 或缺少 package.installedVersion（插件可能未初始化）",
            "config.json 缺失/不完整；先跑 /vibe-trading init",
            "[环境] 先执行 /vibe-trading init（或 vibe_trading_setup），再重扫",
        )
        return

    if vt.get("version") and installed and vt["version"] != installed:
        add(
            "ENV02",
            "P1",
            "environment",
            f"运行时 venv 的 vibe-trading-ai={vt['version']} 与 config.installedVersion={installed} 不一致",
            "config.json package.installedVersion vs importlib.metadata.version",
            "[环境] 说明 config 过期或 venv 被换过；以运行时为准，重新 init/verify",
        )
    if vt.get("version") and minimum and _ver_lt(vt["version"], minimum):
        add(
            "ENV03",
            "P1",
            "environment",
            f"运行时版本 {vt['version']} 低于插件最低要求 {minimum}",
            "config.json package.minimumVersion",
            "[环境] 升级 vibe-trading-ai 或调整最低版本",
        )

    vendor_tag = git("describe", "--tags", "--always")
    if vendor_tag:
        tag_ver = vendor_tag.lstrip("v")
        if vt.get("version") and not vt["version"].startswith(tag_ver.split("-")[0]):
            add(
                "ENV04",
                "P2",
                "environment",
                f"_vendor 参考 clone tag={vendor_tag} 与运行时 {vt['version']} 不一致",
                f"_vendor/Vibe-Trading git describe = {vendor_tag}",
                "[环境] 以运行时为准；需要源码对照时同步 _vendor clone（谨慎 pull）",
            )
    elif VENDOR.exists():
        add("ENV05", "P3", "environment", "_vendor/Vibe-Trading 是 git 之外的副本或缺少 tag", str(VENDOR), "可选：修复参考 clone")
    else:
        add("ENV06", "P3", "environment", "缺少 _vendor/Vibe-Trading 参考 clone（技能部分源码对照会跳过）", str(VENDOR), "可选：clone v0.1.19 参考")


def _ver_lt(a: str, b: str) -> bool:
    def parts(v: str) -> tuple:
        return tuple(int(x) for x in re.findall(r"\d+", v)[:3])

    try:
        return parts(a) < parts(b)
    except Exception:  # noqa: BLE001
        return False


def advertised_sets(toolsets: dict) -> tuple[set, set, dict]:
    core = list(toolsets.get("staticCore") or [])
    groups = {k: list(v or []) for k, v in (toolsets.get("groups") or {}).items()}
    members = [name for names in groups.values() for name in names]
    advertised = set(core) | set(members)
    local = {t.get("name") for t in toolsets.get("localTools") or [] if t.get("name")}
    return advertised, set(core), {"groups": groups, "members": members, "local": local}


def check_tools(vt: dict, worker: dict, toolsets: dict) -> None:
    reg = set(vt.get("registry") or {})
    mcp = {t["name"] for t in vt.get("mcp") or []}
    wtools = [t for t in worker.get("tools") or [] if t.get("name")]
    wnames = {t["name"] for t in wtools}
    wvir = {t["name"] for t in wtools if t.get("virtual")}
    advertised, core, extra = advertised_sets(toolsets)
    local = extra["local"]

    if worker.get("error") and not str(worker["error"]).startswith("skipped"):
        add("TOOL00", "P1", "tools", f"worker 面不可用：{worker['error']}", "--skip-worker 或查看 venv", "[环境] 检查运行时 venv 与 worker 启动")
    if not wnames:
        add(
            "TOOL00",
            "P3",
            "tools",
            "worker 面未扫描（--skip-worker）：工具/技能集合类检查已跳过",
            "去掉 --skip-worker 可获得完整结果",
            "[环境] 完整扫描请不带 --skip-worker",
        )
        return

    if reg:
        missing = sorted(reg - wnames)
        extra_names = sorted(wnames - reg - wvir)
        if missing or extra_names:
            add(
                "TOOL01",
                "P1" if missing else "P2",
                "tools",
                f"worker registry 面与 VT registry 不一致：缺 {len(missing)} / 多 {len(extra_names)}",
                f"缺: {missing[:8]}｜多: {extra_names[:8]}",
                "[环境] worker 未用当前安装包的 build_registry；检查 venv 与 worker 缓存",
            )
        if wtools:
            wan = {t["name"] for t in wtools if not t.get("virtual")}
            if wan and wan != reg:
                add("TOOL01b", "P2", "tools", "worker 发布的非 virtual 工具集合 != registry（virtual 之外有漂移）", f"{sorted(wan ^ reg)[:8]}", "[代码] 检查 worker _handle_tools_list")

    advertised_worker = advertised - local
    missing_adv = sorted(advertised_worker - wnames)
    if missing_adv:
        add(
            "TOOL02",
            "P1",
            "tools",
            f"提示词/toolsets 广告了 worker 没有的工具：{len(missing_adv)} 个（模型会看到不存在的工具）",
            ", ".join(missing_adv[:12]),
            "[代码] 从 toolsets.json 移除或按版本条件加载",
        )
    missing_core = sorted(core - wnames)
    if missing_core:
        add("TOOL03", "P1", "tools", f"staticCore 工具在 worker 里不存在：{missing_core}", "toolsets.json staticCore", "[代码] 修 staticCore")

    # hidden tools: worker - advertised - local
    hidden = sorted(wnames - advertised_worker - local)
    toolsets_doc = toolsets.get("dropped") or {}
    dropped = set()
    for value in toolsets_doc.values():
        dropped.update(value.get("tools") or [])
    excluded = set(toolsets.get("excluded") or [])
    replaced = set((toolsets.get("replacedByDsh") or {}).keys()) | set(toolsets.get("replacedByGateway") or [])
    documented = dropped | excluded | replaced
    for entry in (toolsets.get("hidden") or {}).values():
        documented.update(entry.get("tools") or [])
    undocumented = [n for n in hidden if n not in documented]
    if undocumented:
        add(
            "TOOL04",
            "P2",
            "tools",
            f"hidden {len(hidden)} 个，其中 {len(undocumented)} 个没有显式记录（dropped/excluded/replaced/hidden）",
            "未记录样例: " + ", ".join(undocumented[:12]),
            "[代码] toolsets.json 的 hidden 清单补齐名字+理由；check_manifest 会断言",
        )

    # contract diff for advertised tools with a VT reference
    diffs = []
    for name in sorted(advertised_worker & wnames):
        entry = next(t for t in wtools if t["name"] == name)
        if name in wvir:
            continue  # virtual tools are compared against the MCP surface below (TOOL06)
        ref = (vt.get("registry") or {}).get(name)
        if not ref:
            continue
        if jdump(entry.get("inputSchema")) != jdump(ref.get("parameters")):
            diffs.append(f"{name}:params")
        elif (entry.get("description") or "") != (ref.get("description") or ""):
            diffs.append(f"{name}:desc")
        elif bool(entry.get("readonly", True)) != bool(ref.get("readonly", True)):
            diffs.append(f"{name}:readonly")
    if diffs:
        add(
            "TOOL05",
            "P1" if any(d.endswith(":params") for d in diffs) else "P2",
            "tools",
            f"广告工具与 VT 契约（描述/参数/readonly）不一致：{len(diffs)} 项",
            ", ".join(diffs[:12]),
            "[代码] 若 VT 升级导致，重生成 virtual schema；registry 工具应对齐 build_registry",
        )

    # virtual tools vs MCP surface
    v_missing = sorted(wvir - mcp)
    v_diffs = []
    for name in sorted(wvir & mcp):
        entry = next(t for t in wtools if t["name"] == name)
        ref = next(t for t in vt.get("mcp") or [] if t["name"] == name)
        if jdump(entry.get("inputSchema")) != jdump(ref.get("parameters")):
            v_diffs.append(f"{name}:params")
        elif (entry.get("description") or "") != (ref.get("description") or ""):
            v_diffs.append(f"{name}:desc")
    if v_missing or v_diffs:
        add(
            "TOOL06",
            "P1" if any(d.endswith(":params") for d in v_diffs) else "P2",
            "tools",
            f"virtual 工具与 0.1.19 MCP 面漂移：缺 {len(v_missing)}、不一致 {len(v_diffs)}",
            f"缺: {v_missing[:6]}｜diff: {v_diffs[:8]}",
            "[代码] virtual spec 是冻结 JSON；从 mcp_server.tools/list 生成或加 check_worker 断言",
        )


def check_runtime(vt: dict, worker: dict, toolsets: dict) -> None:
    worker_ts = read(REPO / "src" / "lib" / "worker.ts")
    gateway_ts = read(REPO / "src" / "lib" / "gateway.ts")
    worker_py = read(REPO / "worker" / "vibe_trading_worker.py")
    advertised, core, _ = advertised_sets(toolsets)

    # timeout whitelist
    m = re.search(r"LONG_RUNNING_TOOLS = new Set\(\[(.*?)\]\)", worker_ts, re.S)
    whitelist = set(re.findall(r"'([^']+)'", m.group(1))) if m else set()
    long_hints = [
        "backtest", "factor_analysis", "alpha_bench", "alpha_compare", "analyze_trade_journal",
        "extract_shadow_strategy", "run_shadow_backtest", "render_shadow_report", "scan_shadow_signals",
        "run_research_autopilot", "start_research_goal", "update_research_goal", "sdm_decay_scan",
        "screen_market", "research_papers", "etf_holdings",
        "get_institutional_holdings", "prediction_market", "generate_backtest_config",
    ]
    risky = [n for n in long_hints if n in advertised and n not in whitelist]
    if risky:
        add(
            "TOOL07",
            "P1",
            "tools",
            f"可能长耗时但未进超时白名单（默认 120s）的工具：{len(risky)} 个",
            ", ".join(risky[:12]),
            "[代码] 按工具元数据/白名单给长超时；写工具不硬 kill",
        )
    if "read_document" not in whitelist:
        add(
            "TOOL07b",
            "P2",
            "tools",
            "常驻 read_document 未进长超时白名单（OCR/大 PDF 会被 120s 误杀）",
            f"LONG_RUNNING_TOOLS 位于 {rel(REPO / 'src/lib/worker.ts')}",
            "[代码] 加入白名单或按内容大小动态超时",
        )

    # redaction choke point
    if "redact" not in worker_py.lower() and "redact" not in worker_ts.lower():
        add(
            "TOOL08",
            "P1",
            "security",
            "插件没有 VT 的 redact_tool_result 单一脱敏点：结果原样交付、落盘、入证据账本",
            f"grep redact: worker/*.py + src/**/*.ts 无命中（VT: agent/tool_lifecycle.py）",
            "[代码] worker._render_result 前调用 VT redaction.redact_tool_result；落盘/ingest 同源",
        )

    # read-back path
    if "parts" not in worker_py and "FULL RESULT SAVED" in worker_py:
        add(
            "TOOL09",
            "P1",
            "tools",
            "超限结果落盘为单文件且无分片；read_file 无 offset → >10k 结果尾部读不回来",
            f"{rel(REPO / 'worker/vibe_trading_worker.py')} _persist_full_result；VT read_file_tool.py 只有 limit",
            "[代码] 移植 parts/N.txt 或给 read_file 增加 offset；同步改截断提示",
        )

    # file roots
    roots_line = next((ln for ln in worker_ts.splitlines() if "VIBE_TRADING_ALLOWED_FILE_ROOTS" in ln), "")
    if roots_line:
        begin = worker_ts.find("VIBE_TRADING_ALLOWED_FILE_ROOTS")
        block = worker_ts[begin : begin + 500]
        if not re.search(r"process\.cwd|workspace|attachment", block, re.I):
            add(
                "TOOL10",
                "P1",
                "tools",
                "read_document 允许根不含 DSH workspace/附件目录（工作区里的 PDF/Office 会被拒）",
                f"{rel(REPO / 'src/lib/worker.ts')} VIBE_TRADING_ALLOWED_FILE_ROOTS 默认只有 work/runs,work/results",
                "[代码] 增加 workspace/附件根，或在提示词要求先复制到 work/uploads",
            )

    # evidence ingest coverage
    ingest_sites = []
    for path in (REPO / "src").rglob("*.ts"):
        text = read(path)
        if re.search(r"\.afterResult\(", text):
            ingest_sites.append(rel(path))
    universal_hook = any(
        marker in read_tree(REPO / "src") for marker in ("tools/post-execute", "tool/executed", "postExecute")
    )
    if not universal_hook and len(ingest_sites) <= 3:        add(
            "BEHAV01",
            "P1",
            "behavior",
            "证据账本只覆盖常驻工具 + vt_call；DSH 原生 read/web_*/pwsh 的结果不进 ledger（真实数字会被误拒）",
            f"afterResult 仅出现在: {', '.join(ingest_sites)}；无统一工具执行钩子",
            "[代码] 用宿主工具中间件覆盖所有工具，或提供 ingest_external 并更新提示词",
        )


def check_gate(cfg: dict) -> None:
    verify = read(REPO / "src" / "lib" / "verify.ts")
    index = read(REPO / "src" / "index.ts")
    enabled = bool(((cfg.get("verification") or {}).get("enabled")))
    src_all = read_tree(REPO / "src", REPO / "worker")

    if "redacted_release" not in src_all and "safe_fallback" not in src_all and "released" not in index:
        add(
            "BEHAV02",
            "P0" if enabled else "P1",
            "behavior",
            "门禁开启但没有发布前拦截/遮蔽兜底：被拒草案已经作为 assistant/message 展示，不可撤回",
            "src/ 无 redacted_release/safe_fallback；index.ts 未使用 released_text；turn-stopping 只能 steer",
            "[宿主/需要 DSH 能力] 流式扣留或撤回 API；短期用 steer 文案明确“上一版含未核实数字”",
        )

    if not ("setUserMessage" in verify and "setUserMessage" in index and "state.userMessage" in verify):
        add(
            "BEHAV03",
            "P2",
            "behavior",
            "identity 门禁没有 seed 用户题面（grounding/create 的 user_message 为空或未接线）",
            f"{rel(REPO / 'src/lib/verify.ts')} / {rel(REPO / 'src/index.ts')}",
            "[代码] 从 user/message 事件捕获当前用户请求并传给 grounding/create",
        )

    if re.search(r"corrections\s*>\s*maxRevisions", verify):
        add(
            "BEHAV04",
            "P2",
            "behavior",
            "修订预算与 VT 语义有 off-by-one：插件第 maxRevisions+1 次被拒才披露，VT 第 2 次被拒就遮蔽发布",
            f"{rel(REPO / 'src/lib/verify.ts')} exhausted = corrections > maxRevisions",
            "[代码] 对齐“被拒草案数达到预算就披露/遮蔽”的语义",
        )

    if "turnBudget" not in index and "maxIterations" not in read_tree(REPO / "src"):
        add(
            "BEHAV05",
            "P2",
            "behavior",
            "没有 turn 预算/收尾/熔断：DSH 本身无 turn budget，长任务可能不收敛",
            "src/ 无 turnBudget/maxIterations；VT 有 50 轮上限+80% 收尾提示+8 轮无进展熔断",
            "[宿主/需要 DSH 能力] 用 turn-stopping 统计步数近似收尾；或在文档声明限制",
        )


def check_skills(vt: dict, worker: dict) -> None:
    installed_dir = Path(vt.get("skills_dir") or "")
    installed = {s["name"]: s for s in scan_skill_dir(installed_dir)}
    vendor = {s["name"]: s for s in scan_skill_dir(VENDOR / "agent" / "src" / "skills")}
    wk = {s.get("name"): s for s in worker.get("skills") or [] if s.get("name")}
    advertised, core, _ = advertised_sets(json.loads(read(REPO / "toolsets.json") or "{}"))
    prompt = read(REPO / "prompt" / "vibe-trading.md")
    bridge = read(REPO / "prompt" / "bridge.md")

    if installed and wk:
        missing = sorted(set(installed) - set(wk))
        extra = sorted(set(wk) - set(installed))
        if missing or extra:
            add("SKILL01", "P1", "skills", f"worker skills/list 与安装包技能目录不一致：缺 {len(missing)}/多 {len(extra)}", f"缺 {missing[:6]}｜多 {extra[:6]}", "[代码] 检查 worker skills/list 与 SkillsLoader")
        desc_diff = [n for n in sorted(set(installed) & set(wk)) if installed[n]["description"] != (wk[n].get("description") or "")]
        if desc_diff:
            add("SKILL02", "P2", "skills", f"技能 description 与安装包不一致：{len(desc_diff)} 个", ", ".join(desc_diff[:8]), "[环境] 恢复技能文件或重装包")
    if vendor:
        only_vend = sorted(set(vendor) - set(installed))
        only_inst = sorted(set(installed) - set(vendor))
        sha_diff = [n for n in sorted(set(vendor) & set(installed)) if vendor[n]["body_sha"] != installed[n]["body_sha"]]
        if only_vend or only_inst or sha_diff:
            add(
                "SKILL03",
                "P2",
                "skills",
                f"安装包技能与 _vendor 漂移：仅 vendor {len(only_vend)}/仅安装 {len(only_inst)}/正文不同 {len(sha_diff)}",
                f"only_vendor={only_vend[:4]} only_installed={only_inst[:4]} sha_diff={sha_diff[:4]}",
                "[环境] 以安装包为准；同步 _vendor 参考 clone",
            )

    if not wk:
        return

    # catalog short truncation (mirror of src/lib/prompt.ts shortSkillDescription)
    import re as _re

    _ABBREV = _re.compile(
        r"(?:^|[\s(])(?:[A-Za-z]\.){1,3}$|(?:^|\s)(?:U\.S|e\.g|i\.e|No|vs|Inc|Ltd|Corp|Co|etc|Mr|Ms|Dr)\.$",
        _re.I,
    )

    def fallback_cut(text: str) -> int:
        budget = 99
        if len(text) <= budget:
            return len(text)
        head = text[:budget]
        space = head.rfind(" ")
        return space if space > budget * 0.6 else budget

    def short_desc(desc: str) -> tuple[str, bool]:
        """Mirror of prompt.ts shortSkillDescription; returns (text, endedAtSentence)."""
        text = (desc or "").replace("\n", " ")
        cut, ended = 0, False
        for i, ch in enumerate(text):
            if ch in ".。；;!?":
                sentence = text[: i + 1]
                nxt = text[i + 1] if i + 1 < len(text) else ""
                if ch == ".":
                    if nxt:
                        if not nxt.isspace():
                            continue
                        if _re.search(r"[0-9]\.$", sentence) or _ABBREV.search(sentence.rstrip()):
                            continue
                cut, ended = i + 1, True
                break
            if i >= 99:
                cut = fallback_cut(text)
                break
        if not cut:
            cut = fallback_cut(text)
            ended = False
        head = text[:cut].rstrip()
        return (head, ended) if len(head) >= len(text) else ((head, True) if ended else (head + "…", False))

    rows = []
    for name, skill in wk.items():
        full = (skill.get("description") or "").replace("\n", " ")
        short, ended = short_desc(full)
        rows.append(
            {
                "name": name,
                "category": skill.get("category") or "other",
                "full": full,
                "short": short,
                "ended": ended,
                "lost": len(full) - len(short),
            }
        )
    # Only fallback cuts (no sentence end) can be artifacts. Legitimately short
    # first sentences are by design and must not be reported.
    fallback_short = sorted(
        (r for r in rows if r["lost"] > 0 and not r["ended"] and len(r["short"]) < 40),
        key=lambda r: len(r["short"]),
    )[:8]
    mid_word = [
        r
        for r in rows
        if r["lost"] > 0
        and not r["short"].endswith("…")
        and r["full"][len(r["short"]) : len(r["short"]) + 1].isascii()
        and r["full"][len(r["short"]) : len(r["short"]) + 1].isalnum()
    ]
    if fallback_short or mid_word:
        add(
            "SKILL04",
            "P2",
            "skills",
            f"技能目录 short 模式截断仍有可疑行：{len(fallback_short)} 条过短回退，{len(mid_word)} 条可能切在词中",
            "例子: " + "; ".join(f"{r['name']}={r['short']!r}" for r in (fallback_short or mid_word)[:4]),
            "[提示词] 检查 shortSkillDescription；目录行应可辨识且带省略号",
        )
    # category order: plugin should follow VT _CATEGORY_ORDER; unknown categories alphabetical
    try:
        import src as _src

        skills_py = read(Path(_src.__file__).resolve().parent / "agent" / "skills.py")
        m = re.search(r"_CATEGORY_ORDER\s*=\s*\[(.*?)\]", skills_py, re.S)
        vt_order = re.findall(r'"([^"]+)"', m.group(1)) if m else []
    except Exception:  # noqa: BLE001
        vt_order = []
    if vt_order:
        categories = {r["category"] for r in rows}
        expected = [c for c in vt_order if c in categories] + sorted(c for c in categories if c not in vt_order)
        plugin_prompt = read(REPO / "src" / "lib" / "prompt.ts")
        if "SKILL_CATEGORY_ORDER" not in plugin_prompt:
            add(
                "SKILL05",
                "P2",
                "skills",
                "prompt.ts 未按 VT 的类别顺序排序（应为 data-source→strategy→analysis→asset-class→crypto→flow→tool→other）",
                f"期望顺序: {' > '.join(expected)}",
                "[代码] prompt.ts 使用 SKILL_CATEGORY_ORDER 排序",
            )
    # resources guidance
    resources = [r for r in rows if (installed.get(r["name"]) or {}).get("has_resources")]
    if resources and not re.search(r"references/|scripts/", prompt + bridge):
        add(
            "SKILL06",
            "P2",
            "skills",
            f"{len(resources)} 个技能链接 references/scripts，但提示词未说明如何读取（runio read_file 实际可用）",
            "prompt/vibe-trading.md 与 bridge.md 无 references/scripts 指引",
            "[提示词] Skills 段加一句：技能资源可用 vt_call('read_file', {path:'skills/<name>/references/…'})",
        )


def check_prompts(vt: dict, toolsets: dict) -> None:
    prompt = read(REPO / "prompt" / "vibe-trading.md")
    bridge = read(REPO / "prompt" / "bridge.md")
    context = ""
    if vt.get("src_pkg"):
        context = read(Path(vt["src_pkg"]) / "agent" / "context.py")
    if context:
        m = re.search(r'_SYSTEM_PROMPT = """(.*?)"""', context, re.S)
        vt_prompt = m.group(1) if m else ""
        if vt_prompt:
            vt_block = _between(vt_prompt, "## Output Principles", "## Tools")
            pl_block = _between(prompt, "## Output Principles", "## Tools")
            if vt_block and pl_block and sha1(vt_block.strip()) != sha1(pl_block.strip()):
                add(
                    "PROMPT01",
                    "P1",
                    "prompt",
                    "六原则段与 VT 不再逐字节一致（这是数字门禁的文本契约）",
                    f"VT {len(vt_block)} chars vs plugin {len(pl_block)} chars; {rel(REPO / 'prompt/vibe-trading.md')}",
                    "[提示词] 恢复逐字节一致，或确认改动后同步门禁检查",
                )
            for marker, level in [
                ("Identity before market data", "P1"),
                ("Evidence-grounded numbers", "P1"),
                ("Figures need a symbol", "P1"),
                ("Ask the user if critical info is missing", "P2"),
            ]:
                vt_part = _bullet_block(vt_prompt, marker)
                pl_part = _bullet_block(prompt, marker)
                if vt_part and pl_part and sha1(vt_part) != sha1(pl_part):
                    add(
                        "PROMPT02",
                        level,
                        "prompt",
                        f"Guideline 与 VT 不再逐字节一致：{marker}",
                        f"VT {len(vt_part)} chars vs plugin {len(pl_part)} chars",
                        "[提示词] 对比差异；若有意改写，确认不弱化纪律",
                    )
    # shell contradiction
    claims_no_shell = re.search(r"there is no shell|no shell or background job|There is no shell", prompt + bridge, re.I)
    mentions_shell = re.search(r"pwsh|bash", prompt + bridge, re.I)
    if claims_no_shell and mentions_shell:
        add(
            "PROMPT03",
            "P1",
            "prompt",
            "提示词内部矛盾：一处说“没有 shell/后台任务”，另一处又提到 pwsh/bash（DSH standard preset 实际有 tool-pwsh/tool-jobs）",
            f"{rel(REPO / 'prompt/bridge.md')} 与 {rel(REPO / 'prompt/vibe-trading.md')}",
            "[提示词] 改为“VT 的 bash 不存在；DSH 有 pwsh/jobs，但不得当计算器/读门禁内部”",
        )
    adapter = read(REPO / "worker" / "grounding_adapter.py")
    call_at = adapter.find("correction_prompt(validation)")
    rewritten = "_adapt_correction_prompt" in adapter and "_adapt_correction_prompt(ledger.correction_prompt" in adapter
    if call_at >= 0 and not rewritten:
        add(
            "PROMPT04",
            "P1",
            "prompt",
            "门禁纠正文案仍透传 VT 原文（要求正文末尾 figures 块/称上一版未发布）",
            f"{rel(REPO / 'worker/grounding_adapter.py')} correction = ledger.correction_prompt(...)",
            "[代码] adapter 里做文案替换：改用 report_figures 口径并说明上一版已展示",
        )
    m = re.search(r"Pass a toolset \(([^)]*)\)", read(REPO / "src" / "lib" / "gateway.ts"))
    gateway_src = read(REPO / "src" / "lib" / "gateway.ts")
    if m and "toolsetHint" not in gateway_src:
        listed = {x.strip() for x in m.group(1).split("/") if x.strip()}
        groups = set((toolsets.get("groups") or {}).keys())
        missing = sorted(groups - listed)
        if missing:
            add(
                "PROMPT05",
                "P2",
                "prompt",
                f"vt_load_tools 描述只列 {len(listed)} 个工具组，toolsets 有 {len(groups)} 组：漏 {missing}",
                f"{rel(REPO / 'src/lib/gateway.ts')} 描述字符串",
                "[代码] 创建工具时由 toolsets.groups 动态拼接组名",
            )
    # direct-call routing syntax for non-core tools
    advertised, core, _ = advertised_sets(toolsets)
    noncore = sorted(advertised - core)
    direct = []
    for name in noncore:
        for m2 in re.finditer(rf"(?<![\w.]){re.escape(name)}\(", prompt):
            start = max(0, m2.start() - 160)
            window = prompt[start : m2.start()]
            if "vt_call" in window or "vt_load_tools" in window:
                continue
            direct.append(name)
            break
    if direct:
        add(
            "PROMPT06",
            "P1",
            "prompt",
            f"Task Routing 用 VT 直调语法写了 {len(direct)} 个非 core 工具（实际必须先 vt_load_tools 再 vt_call）",
            ", ".join(direct[:12]),
            "[提示词] 改为“vt_load_tools('组') → vt_call(...)”，或在段首统一声明",
        )
    # hidden tools coverage in bridge (worker-based hidden is covered by TOOL04)
    names_to_map = set((toolsets.get("replacedByDsh") or {}).keys()) | set(toolsets.get("replacedByGateway") or [])
    for value in (toolsets.get("dropped") or {}).values():
        names_to_map |= set(value.get("tools") or [])
    missing_bridge = [n for n in sorted(names_to_map) if f"`{n}`" not in bridge and n not in bridge]
    if missing_bridge:
        add("PROMPT07", "P2", "prompt", f"bridge 未覆盖 {len(missing_bridge)} 个被替换/丢弃工具", ", ".join(missing_bridge[:10]), "[提示词] bridge 表/清单补齐")
    if "no tool result supplies" in prompt and "date is not available" in prompt:
        add(
            "PROMPT08",
            "P3",
            "prompt",
            "日期行为写成“没有工具结果就说不可用”，但 DSH time-context 每步注入日期（standard preset）",
            f"{rel(REPO / 'prompt/vibe-trading.md')} 末尾 guideline",
            "[提示词] 改为“以会话注入的 time-context 为准；确实没有时说不确定”",
        )


def _between(text: str, start: str, end: str) -> str:
    i = text.find(start)
    if i < 0:
        return ""
    j = text.find(end, i)
    return text[i:j] if j > 0 else ""


def _bullet_block(text: str, marker: str) -> str:
    """Extract one markdown bullet paragraph that starts with the marker text."""
    pattern = re.compile(rf"^- \*\*{re.escape(marker)}[^\n]*\n(?:  [^\n]*\n|    [^\n]*\n)*", re.M)
    m = pattern.search(text)
    return m.group(0).strip() if m else ""


def check_docs() -> None:
    num = read(REPO / "docs" / "number-verification.md")
    verify = read(REPO / "src" / "lib" / "verify.ts")
    if re.search(r"redact`?\s*\|\s*`?fallback", num) and "silent" in verify:
        add(
            "DOC02",
            "P3",
            "docs",
            "文档写 onFailure=redact|fallback，实现只支持 silent|disclose",
            "docs/number-verification.md vs src/lib/verify.ts",
            "[文档] 更正档位名称",
        )


def check_baseline(surface: dict) -> None:
    baseline = SKILL_DIR / "references" / "baseline.json"
    if not baseline.exists():
        return
    try:
        old = json.loads(read(baseline))
    except json.JSONDecodeError:
        return
    changed = []
    for key, label in [
        ("pluginVersion", "插件版本"),
        ("vtVersion", "运行时 VT 版本"),
        ("registryCount", "VT registry 工具数"),
        ("mcpCount", "MCP 面工具数"),
        ("workerCount", "worker 工具数"),
        ("skillCount", "技能数"),
        ("advertisedCount", "advertised 工具数"),
        ("hiddenCount", "hidden 工具数"),
    ]:
        if key in old and key in surface and old[key] != surface[key]:
            changed.append(f"{label}: {old[key]} → {surface[key]}")
    if changed:
        add(
            "BASE01",
            "P2",
            "baseline",
            "与上次核对基线相比，版本/数量发生变化（升级后属预期，需确认影响面）",
            "; ".join(changed),
            "[基线] 确认新工具/新技能/新 face 是否有意；更新 references/baseline-*.md 与 baseline.json",
        )


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="dsh-vibe-trading ↔ Vibe-Trading parity scan (read-only)")
    parser.add_argument("--skip-worker", action="store_true", help="skip the JSON-RPC worker spawn")
    parser.add_argument("--json-only", action="store_true", help="only print the raw JSON path")
    args = parser.parse_args()

    run_id = f"{_now()}"
    scratch = TMP_ROOT / run_id
    scratch.mkdir(parents=True, exist_ok=True)

    prepare_vt_env(scratch)
    cfg = load_config(Path(os.environ.get("VT_PARITY_CONFIG_HOME") or (Path.home() / ".vibe-trading")))
    vt = dump_vt(scratch)
    worker = {"tools": [], "skills": [], "error": "skipped (--skip-worker)"} if args.skip_worker else dump_worker(scratch)
    toolsets_raw = read(REPO / "toolsets.json")
    try:
        toolsets = json.loads(toolsets_raw) if toolsets_raw else {}
    except json.JSONDecodeError:
        toolsets = {}
        add("TOOL00b", "P1", "tools", "toolsets.json 无法解析", rel(REPO / "toolsets.json"), "[代码] 修 JSON")

    check_env(cfg, vt, worker)
    check_tools(vt, worker, toolsets)
    check_runtime(vt, worker, toolsets)
    check_gate(cfg)
    check_skills(vt, worker)
    check_prompts(vt, toolsets)
    check_docs()

    advertised, _core, _extra = advertised_sets(toolsets)
    local_tools = _extra["local"]
    surface = {
        "pluginVersion": plugin_version(),
        "vtVersion": vt.get("version", ""),
        "vendorTag": git("describe", "--tags", "--always"),
        "registryCount": len(vt.get("registry") or {}),
        "mcpCount": len(vt.get("mcp") or []),
        "workerCount": len(worker.get("tools") or []),
        "skillCount": len(worker.get("skills") or []),
        "advertisedCount": len(advertised | local_tools),
        "hiddenCount": len({t["name"] for t in worker.get("tools") or []} - advertised - local_tools),
        "verificationEnabled": bool(((cfg.get("verification") or {}).get("enabled"))),
        "workerError": worker.get("error", ""),
        "vtErrors": vt.get("errors", []),
    }
    check_baseline(surface)

    levels = {"P0": 0, "P1": 0, "P2": 0, "P3": 0}
    for f in findings:
        levels[f["level"]] = levels.get(f["level"], 0) + 1

    raw = {
        "runId": run_id,
        "surface": surface,
        "findings": findings,
        "vtRegistryFailures": vt.get("registry_failures", {}),
    }
    (scratch / "scan.json").write_text(json.dumps(raw, ensure_ascii=False, indent=1), encoding="utf-8")

    if args.json_only:
        print(str(scratch / "scan.json"))
        return 0

    print("== vt-parity-check ==")
    print(
        f"baseline  plugin {surface['pluginVersion']} | VT {surface['vtVersion']}"
        f"{' (vendor ' + surface['vendorTag'] + ')' if surface['vendorTag'] else ''}"
        f" | verification.enabled={surface['verificationEnabled']}"
    )
    print(
        f"surfaces  VT registry {surface['registryCount']} | MCP {surface['mcpCount']}"
        f" | worker {surface['workerCount']} | skills {surface['skillCount']}"
        f" | advertised {surface['advertisedCount']} | hidden {surface['hiddenCount']}"
    )
    if surface["workerError"]:
        print(f"worker    ERROR {surface['workerError']}")
    if surface["vtErrors"]:
        print(f"vt        ERRORS {surface['vtErrors']}")
    print(f"findings  P0 {levels.get('P0', 0)} | P1 {levels.get('P1', 0)} | P2 {levels.get('P2', 0)} | P3 {levels.get('P3', 0)}")
    print("")
    order = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}
    for f in sorted(findings, key=lambda x: (order.get(x["level"], 9), x["code"])):
        print(f"[{f['level']}] {f['code']} ({f['area']}) {f['message']}")
        if f["evidence"]:
            print(f"      evidence: {f['evidence']}")
    print("")
    print(f"raw: {scratch / 'scan.json'}")
    print("提示：按 SKILL.md 的输出格式整理“问题+建议”；未覆盖项见 references/checks.md。")
    return 0


def _now() -> str:
    from datetime import datetime

    return datetime.now().strftime("%Y%m%d-%H%M%S")


if __name__ == "__main__":
    sys.exit(main())
