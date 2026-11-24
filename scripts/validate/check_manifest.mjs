#!/usr/bin/env node
/**
 * Local manifest/structure validation for the dsh-vibe-trading bundle.
 * Run from the repository root: node scripts/validate/check_manifest.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []

function check(name, fn) {
  try {
    fn()
    checks.push(['PASS', name])
  } catch (error) {
    checks.push(['FAIL', `${name}: ${error.message}`])
    failures.push(name)
  }
}

function must(condition, message) {
  if (!condition) throw new Error(message)
}

function fileExists(relative) {
  const target = path.join(root, relative)
  must(statSync(target).isFile(), `${relative} is not a file`)
  return target
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))

check('package.json manifest', () => {
  must(pkg.name === '@monsterlee/dsh-vibe-trading', `unexpected name ${pkg.name}`)
  must(/^\d+\.\d+\.\d+/.test(pkg.version), 'version must be semver')
  must(pkg.type === 'module', 'type must be module')
  must(pkg.dsh?.bundle?.patch === './cordis.patch.yml', 'dsh.bundle.patch missing')
  // Host compatibility: DSH app-boot evaluates `engines.dsh` alone (peers are
  // ignored) with `semver.satisfies(version, range, { includePrerelease: true })`,
  // so a lower-bound range keeps accepting every later prerelease/stable host.
  // A mismatch skips this bundle at profile load instead of failing loudly at
  // runtime, and `workspace:` ranges are always unmet.
  must(pkg.engines && typeof pkg.engines === 'object' && !Array.isArray(pkg.engines), 'engines must be an object')
  const dshRange = pkg.engines.dsh
  must(typeof dshRange === 'string' && dshRange.trim() !== '', 'engines.dsh missing')
  must(!dshRange.includes('workspace:'), 'engines.dsh cannot use workspace: ranges')
  must(
    /^>=\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(dshRange.trim()),
    `engines.dsh must be a single lower bound (>=x.y.z[-pre]); got ${JSON.stringify(dshRange)}`,
  )
  const main = pkg.main ?? pkg.exports?.['.']
  must(main, 'main/exports "." missing')
  must(main.endsWith('.js'), 'main must point at built JavaScript')
  fileExists(main.replace(/^\.\//, ''))
  must(pkg.exports?.['./locale/*.json'], 'exports "./locale/*.json" missing')
  must(pkg.exports?.['./icon'], 'exports "./icon" missing')
  for (const entry of ['cordis.patch.yml', 'toolsets.json', 'icon.svg']) {
    fileExists(entry)
  }
  for (const entry of pkg.files ?? []) {
    if (entry.includes('*')) continue
    const cleaned = entry.replace(/\/$/, '')
    must(statSync(path.join(root, cleaned)), `files entry missing: ${entry}`)
  }
  const iconSize = statSync(path.join(root, 'icon.svg')).size
  must(iconSize > 0 && iconSize < 256 * 1024, `icon size ${iconSize} out of range`)
})

check('cordis.patch.yml shape', () => {
  const patch = readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8')
  must(patch.includes('- insert:'), 'missing insert block')
  must(patch.includes('id: dsh-vibe-trading'), 'missing plugin row id')
  must(patch.includes("name: '@monsterlee/dsh-vibe-trading'"), 'missing plugin row name')
  // Regression guard: overriding a host capability row (sandbox-policy and
  // friends) replaces its config wholesale and deadlocked profile activation.
  const overrides = patch
    .split(/\r?\n/)
    .filter((line) => /^\s+-\s+id:|^- id:/.test(line))
    .map((line) => line.replace(/^.*id:\s*/, '').trim())
    .filter((id) => id && id !== 'dsh-vibe-trading')
  must(overrides.length === 0, `patch must not override host rows: ${overrides.join(', ')}`)
  must(!/^\s*-\s*id:\s*sandbox-policy/m.test(patch), 'patch must not override sandbox-policy')
})

check('locale files', () => {
  for (const file of ['locale/en.json', 'locale/zh.json']) {
    const locale = JSON.parse(readFileSync(path.join(root, file), 'utf8'))
    must(locale.meta?.title, `${file} meta.title missing`)
    must(locale.meta?.description, `${file} meta.description missing`)
    // The plugin page renders meta.detail as the bundle detail document; an
    // invalid path or a missing file fails the whole page, so validate both.
    if (locale.meta?.detail !== undefined) {
      const detail = locale.meta.detail
      must(typeof detail === 'string' && detail.endsWith('.md'), `${file} meta.detail must be a .md path`)
      must(
        !detail.includes('\\') && !detail.split('/').some((part) => part === '' || part === '.' || part === '..'),
        `${file} meta.detail must be a clean relative path`,
      )
      fileExists(detail)
    }
  }
})

check('toolsets match the worker tool surface', () => {
  const toolsets = JSON.parse(readFileSync(path.join(root, 'toolsets.json'), 'utf8'))

  // The tracked worker-surface snapshot is the source of truth for a fresh
  // clone. The full measurement artifact under scripts/env/ is generated and
  // git-ignored, so CI and contributors cannot depend on it.
  const surfaceFile = path.join(root, 'scripts/validate/worker-surface.json')
  must(existsSync(surfaceFile), 'missing scripts/validate/worker-surface.json (run pnpm capture:surface)')
  const captured = JSON.parse(readFileSync(surfaceFile, 'utf8'))
  const registry = new Set(captured.registry_names ?? [])
  must(registry.size > 80, 'worker surface artifact looks incomplete')

  const virtual = new Set(toolsets.virtualTools ?? [])
  for (const name of virtual) {
    must(!registry.has(name), `${name} is already in the registry; it must not be a virtual tool`)
  }

  const known = (name) => registry.has(name) || virtual.has(name)
  // The MCP surface snapshot is tracked for the same reason; the full handshake
  // capture (scripts/env/mcp-tools.json) stays git-ignored.
  const mcpFile = path.join(root, 'scripts/validate/mcp-surface.json')
  const legacyMcpFile = path.join(root, 'scripts/env/mcp-tools.json')
  const mcpPath = existsSync(mcpFile) ? mcpFile : legacyMcpFile
  must(existsSync(mcpPath), 'missing scripts/validate/mcp-surface.json (run pnpm capture:mcp)')
  const mcpNames = new Set(JSON.parse(readFileSync(mcpPath, 'utf8')).tool_names ?? [])
  must(mcpNames.size > 0, 'MCP surface artifact looks incomplete')
  const surface = () => mcpNames
  const seen = new Set()
  const add = (name, source) => {
    must(known(name), `${source}: unknown tool ${name}`)
    must(!seen.has(name), `${source}: duplicate tool ${name}`)
    seen.add(name)
  }
  const local = toolsets.localTools ?? []
  for (const entry of local) {
    must(entry && typeof entry.name === 'string' && entry.name, 'localTools entry needs a name')
    must(!seen.has(entry.name), `localTools: duplicate tool ${entry.name}`)
    must(!registry.has(entry.name) && !virtual.has(entry.name), `localTools: ${entry.name} is a worker tool`)
    seen.add(entry.name)
  }
  for (const item of toolsets.staticCore) add(item, 'staticCore')
  for (const [group, names] of Object.entries(toolsets.groups)) {
    must(Array.isArray(names) && names.length > 0, `group ${group} is empty`)
    for (const item of names) add(item, `group ${group}`)
  }
  // Gateway-replaced and excluded tools may be MCP-surface-only names.
  for (const item of toolsets.replacedByGateway) {
    must(surface().has(item) || registry.has(item), `replacedByGateway: unknown tool ${item}`)
    seen.add(item)
  }
  for (const item of toolsets.excluded) {
    // An excluded tool documents a deliberate omission; the upstream surface may
    // legitimately drop it in a later release, so only its name is required here.
    must(typeof item === 'string' && item.length > 0, 'excluded entry needs a name')
    if (surface().has(item) || registry.has(item)) seen.add(item)
  }
  // A DSH replacement is either a bare tool name or `{tool, note}`; the note is
  // what the generated tool-surface doc shows for non-obvious replacements
  // (skill writing, background jobs), so it must be a real string when present.
  for (const [item, target] of Object.entries(toolsets.replacedByDsh ?? {})) {
    must(surface().has(item) || registry.has(item), `replacedByDsh: unknown tool ${item}`)
    const replacement = typeof target === 'string' ? target : target?.tool
    must(
      typeof replacement === 'string' && replacement.trim() !== '',
      `replacedByDsh: ${item} needs a replacement tool name`,
    )
    if (target && typeof target === 'object') {
      must(
        target.note === undefined || (typeof target.note === 'string' && target.note.trim() !== ''),
        `replacedByDsh: ${item} note must be a non-empty string`,
      )
    }
    seen.add(item)
  }
  // Credential-gated tools are advertised conditionally: the plugin drops them
  // from the catalog when the worker reports the credential missing. Each entry
  // must therefore name an advertised tool and document what it needs.
  for (const [name, requirement] of Object.entries(toolsets.credentialGated ?? {})) {
    must(known(name), `credentialGated: unknown tool ${name}`)
    must(
      typeof requirement === 'string' && requirement.trim() !== '',
      `credentialGated: ${name} needs a non-empty requirement string`,
    )
    must(seen.has(name), `credentialGated: ${name} is not advertised, so the gate can never apply`)
  }
  for (const [reason, entry] of Object.entries(toolsets.dropped ?? {})) {
    for (const item of entry.tools ?? []) {
      must(surface().has(item) || registry.has(item), `dropped/${reason}: unknown tool ${item}`)
      must(!seen.has(item), `dropped tool ${item} is also exposed (${reason})`)
      seen.add(item)
    }
  }
  for (const name of toolsets.registryOnly ?? []) {
    must(!surface().has(name), `${name} is on the MCP surface; it does not need registryOnly`)
  }

  // Every virtual tool must be reachable somewhere (static core or a group).
  for (const name of virtual) {
    must(seen.has(name), `virtual tool ${name} is not assigned to staticCore or a group`)
  }

  // Report registry tools that are intentionally hidden, and require a recorded
  // reason for each one (toolsets.hidden). A registry tool must never disappear
  // from the advertised surface without an explicit entry.
  const hidden = [...registry].filter((name) => !seen.has(name))
  const hiddenDoc = new Set()
  for (const [reason, entry] of Object.entries(toolsets.hidden ?? {})) {
    must(entry && typeof entry.why === 'string' && entry.why, `hidden/${reason} needs a why`)
    for (const item of entry.tools ?? []) {
      must(typeof item === 'string' && item.length > 0, `hidden/${reason}: entry needs a name`)
      must(!hiddenDoc.has(item), `hidden/${reason}: ${item} is documented twice`)
      must(registry.has(item), `hidden/${reason}: ${item} is not a registry tool`)
      hiddenDoc.add(item)
    }
  }
  const undocumented = hidden.filter((name) => !hiddenDoc.has(name))
  must(undocumented.length === 0, `hidden tools without a documented reason: ${undocumented.join(', ')}`)
  const stale = [...hiddenDoc].filter((name) => !hidden.includes(name))
  must(stale.length === 0, `hidden doc lists tools that are not hidden: ${stale.join(', ')}`)
  console.log(`INFO  hidden registry tools (documented): ${hidden.length}`)
})

check('worker script present', () => {
  const worker = fileExists('worker/vibe_trading_worker.py')
  must(statSync(worker).size > 500, 'worker script looks empty')
})

check('prompt assets present', () => {
  for (const file of ['prompt/vibe-trading.md', 'prompt/bridge.md']) fileExists(file)
})

check('client half (composer chip) declared', () => {
  const client = pkg.dsh?.client
  must(client, 'dsh.client missing')
  must(client.platform === 'web', 'dsh.client.platform must be web')
  must(client.immediately === true, 'dsh.client.immediately must be true')
  must(
    Array.isArray(client.inject) && client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
    'dsh.client.inject must order after dsh-client-ui-conversation',
  )
  must(pkg.exports?.['./client'] === './client.js', 'exports "./client" must point at ./client.js')
  const file = fileExists('client.js')
  const source = readFileSync(file, 'utf8')
  must(source.includes('__ModuleLoader__.load'), 'client.js must register through __ModuleLoader__.load')
  must(source.includes(`id: '${pkg.name}'`), 'client module id must equal the package name')
  must(source.includes('ctx.slots.register'), 'client.js must register a slot occupant')
  // The chip reads the host projection; keep the two key strings in sync.
  const projection = readFileSync(path.join(root, 'src/lib/vibe-state.ts'), 'utf8')
  const hostKey = /VIBE_PROJECTION_KEY = '([^']+)'/.exec(projection)?.[1]
  must(hostKey, 'missing VIBE_PROJECTION_KEY in src/lib/vibe-state.ts')
  must(source.includes(`'${hostKey}'`), `client.js must read projection '${hostKey}'`)
})

for (const [status, detail] of checks) console.log(`${status}  ${detail}`)
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall manifest checks passed')
