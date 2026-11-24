# setup.ps1 -- bootstrap the contributor Python environment with uv.
#
# The repository is a uv project (pyproject.toml + uv.lock). `uv sync` creates
# the repo-local `.venv/` (git-ignored) and installs the pinned dev toolchain
# (vibe-trading-ai 0.1.19 + zstandard). No Python distribution, cache or fake
# home is written into the repository; those belong to uv's global caches and
# the OS temp directory.
#
# The plugin's RUNTIME environment is still the one created by
# `/vibe-trading init` (~/.vibe-trading/dsh/venv); this dev env is only for
# worker/benchmark scripts and local validation.
#
# Usage (from the repository root, or anywhere):
#     pwsh -File scripts\env\setup.ps1
#     pwsh -File scripts\env\setup.ps1 -Frozen     # CI: require uv.lock as-is

[CmdletBinding()]
param(
    # Require uv.lock exactly (fails if pyproject.toml drifted).
    [switch]$Frozen
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $Root

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    throw 'uv is required: https://docs.astral.sh/uv/getting-started/installation/'
}

$syncArgs = @('sync')
if ($Frozen) { $syncArgs += '--frozen' }
Write-Host "uv $($syncArgs -join ' ')" -ForegroundColor Cyan
uv @syncArgs
if ($LASTEXITCODE -ne 0) { throw "uv sync failed ($LASTEXITCODE)" }

uv run python -c "import importlib.metadata as m, sys; print('python', sys.version.split()[0]); print('vibe-trading-ai', m.version('vibe-trading-ai'))"
if ($LASTEXITCODE -ne 0) { throw "dev environment check failed ($LASTEXITCODE)" }

Write-Host ''
Write-Host 'Dev environment ready (.venv). Useful commands:' -ForegroundColor Green
Write-Host '  pnpm check:grounding      # 23/23 via scripts/validate/py.mjs'
Write-Host '  pnpm check:worker         # 24/24 (needs network)'
Write-Host '  uv run python scripts/env/bench_startup.py'
Write-Host '  uv sync --frozen          # reproducible CI sync'
