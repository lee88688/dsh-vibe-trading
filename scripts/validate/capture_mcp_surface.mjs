#!/usr/bin/env node
/**
 * Write the tracked MCP surface snapshot from the full handshake capture.
 *
 * The full capture (scripts/env/mcp-tools.json) is a generated artifact and is
 * git-ignored; checks must work on a fresh clone. This script keeps the small,
 * reviewable snapshot under scripts/validate/ in sync.
 *
 *   uv run python scripts/env/mcp_handshake.py --out scripts/env/mcp-tools.json
 *   node scripts/validate/capture_mcp_surface.mjs
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourcePath = path.join(root, 'scripts/env/mcp-tools.json')
const targetPath = path.join(root, 'scripts/validate/mcp-surface.json')

if (!existsSync(sourcePath)) {
  console.error(`missing ${path.relative(root, sourcePath)}; capture the MCP surface first:`)
  console.error('  uv run python scripts/env/mcp_handshake.py --out scripts/env/mcp-tools.json')
  process.exit(1)
}

const source = JSON.parse(readFileSync(sourcePath, 'utf8'))
const version = source.server_info?.version
if (typeof version !== 'string' || version.trim() === '') {
  console.error(`${path.relative(root, sourcePath)} has no server_info.version; refusing to write a stale pin`)
  process.exit(1)
}
if (!Array.isArray(source.tool_names) || source.tool_names.length === 0) {
  console.error(`${path.relative(root, sourcePath)} has no tool_names; refusing to write an empty surface`)
  process.exit(1)
}

const toolNames = [...new Set(source.tool_names.map(String))].sort()
const snapshot = {
  vibe_trading_version: version,
  tool_count: toolNames.length,
  tool_names: toolNames,
}
writeFileSync(targetPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8')
console.log(
  `wrote ${path.relative(root, targetPath)}: ${toolNames.length} tools @ vibe-trading-ai ${version}`,
)
