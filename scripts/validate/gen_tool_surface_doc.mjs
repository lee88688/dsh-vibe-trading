#!/usr/bin/env node
/**
 * Generate docs/tool-surface.md: the pinned Vibe-Trading tool surface versus the
 * surface this plugin actually advertises.
 *
 *   node scripts/validate/gen_tool_surface_doc.mjs          # write the doc
 *   node scripts/validate/gen_tool_surface_doc.mjs --check  # fail if stale
 *
 * Everything is derived from toolsets.json plus the captured worker/MCP surface
 * artifacts, so an upgrade shows up as a diff: add a tool to a group, hide it
 * with a reason, or the generator fails before the doc can lie.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const toolsets = JSON.parse(read('toolsets.json'))
const surface = JSON.parse(read('scripts/validate/worker-surface.json'))
// The slim snapshot is tracked so the doc can be regenerated on a fresh clone;
// the full handshake capture under scripts/env/ is git-ignored.
const mcpFile = existsSync(path.join(root, 'scripts/validate/mcp-surface.json'))
  ? 'scripts/validate/mcp-surface.json'
  : 'scripts/env/mcp-tools.json'
const mcp = JSON.parse(read(mcpFile))
const configTs = read('src/lib/config.ts')

const DOC = path.join(root, 'docs/tool-surface.md')
const pinned = (configTs.match(/PINNED_VERSION\s*=\s*'([^']+)'/) ?? [])[1] ?? 'unknown'

const registry = new Set(surface.registry_names ?? [])
const virtual = new Set(surface.virtual_names ?? [])
const workerNames = new Set([...registry, ...virtual])
const mcpSurface = new Set(mcp.tool_names ?? [])

const groups = toolsets.groups ?? {}
const hidden = toolsets.hidden ?? {}
const dropped = toolsets.dropped ?? {}
const gated = toolsets.credentialGated ?? {}
const replacedByDsh = toolsets.replacedByDsh ?? {}
const replacedByGateway = toolsets.replacedByGateway ?? []
const excluded = toolsets.excluded ?? []

const staticCore = toolsets.staticCore ?? []
const localTools = toolsets.localTools ?? []

/** Hidden/dropped names by tool, for annotations. */
const reasonFor = new Map()
for (const [reason, entry] of Object.entries(hidden)) for (const name of entry.tools ?? []) reasonFor.set(name, reason)
for (const [reason, entry] of Object.entries(dropped)) for (const name of entry.tools ?? []) reasonFor.set(name, reason)

const droppedWorkerNames = Object.values(dropped)
  .flatMap((entry) => entry.tools ?? [])
  .filter((name) => workerNames.has(name))
const hiddenWorkerNames = Object.values(hidden)
  .flatMap((entry) => entry.tools ?? [])
  .filter((name) => workerNames.has(name))
const dshWorkerNames = Object.keys(replacedByDsh).filter((name) => workerNames.has(name))
const gatewayWorkerNames = replacedByGateway.filter((name) => workerNames.has(name))

// --- consistency gates -----------------------------------------------------
const fail = (message) => {
  console.error(`FAIL  ${message}`)
  process.exitCode = 1
}
const advertised = new Set([...staticCore, ...Object.values(groups).flat()])
for (const name of advertised) {
  if (!workerNames.has(name)) fail(`advertised tool ${name} is not in the captured worker surface`)
  if (reasonFor.has(name)) fail(`${name} is both advertised and hidden/dropped (${reasonFor.get(name)})`)
}
for (const [name] of Object.entries(gated)) {
  if (!advertised.has(name)) fail(`credentialGated ${name} is not advertised`)
  if (!(gated[name] ?? '').trim()) fail(`credentialGated ${name} has an empty requirement`)
}
const nonAdvertised = [...workerNames].filter((name) => !advertised.has(name))
if (hiddenWorkerNames.length + dshWorkerNames.length + gatewayWorkerNames.length + droppedWorkerNames.length !== nonAdvertised.length) {
  fail('non-advertised tools are not fully accounted for by hidden/replaced/dropped')
}
if (process.exitCode) {
  console.error('refusing to write a doc from an inconsistent toolsets.json')
  process.exit(1)
}

// --- rendering -------------------------------------------------------------
const code = (name) => `\`${name}\``
const escapeCell = (text) => String(text ?? '').replace(/\|/g, '\\|').trim()
const localToolGloss = {
  report_figures:
    '声明回答引用的 figures（value / role / note / ref）与草稿正文，发布前对照本会话证据校验（工具描述面向模型，保持英文）',
}
const staticCoreGloss = {
  search_symbol: '标的解析：代码/名称 → 标准化 symbol + 交易所',
  get_market_data: 'OHLCV 行情（多源回退）',
  read_document: 'PDF / Office / 图片的文本提取（DSH 的 read 只管文本文件）',
  backtest: '回测引擎，产物落 run 目录',
  financial_rigor: '确定性计算（涨跌幅/PE/汇率等），禁止用 shell 当计算器',
}
const staticCoreNote = (name) => staticCoreGloss[name] ?? (registry.has(name) ? 'registry 工具' : 'MCP wrapper')
const localToolNote = (tool) => localToolGloss[tool?.name] ?? escapeCell(tool?.description)
const toolCell = (name) => (gated[name] ? `${code(name)} †` : code(name))
const listCell = (names) => names.map(toolCell).join('、')

const groupRows = Object.entries(groups)
  .map(([group, names]) => `| ${code(group)} | ${names.length} | ${listCell(names)} |`)
  .join('\n')

const hiddenRows = Object.entries(hidden)
  .map(([reason, entry]) => {
    const names = entry.tools ?? []
    return `| ${code(reason)}（${names.length}） | ${escapeCell(entry.why)} | ${listCell(names)} |`
  })
  .join('\n')

const droppedRows = Object.entries(dropped)
  .map(([reason, entry]) => {
    const names = entry.tools ?? []
    const cell = names
      .map((name) => `${code(name)}${workerNames.has(name) ? '' : '（worker 未注册）'}`)
      .join('、')
    return `| ${code(reason)}（${names.length}） | ${escapeCell(entry.why)} | ${cell} |`
  })
  .join('\n')

const mcpOnly = [...mcpSurface].filter((name) => !workerNames.has(name)).sort()
const mcpOnlyRows = mcpOnly
  .map((name) => {
    const note = reasonFor.has(name)
      ? reasonFor.get(name)
      : replacedByGateway.includes(name)
        ? '网关替代（`vt_list_skills` / `vt_load_skill`）'
        : '上游可选，本部署未注册'
    return `| ${code(name)} | ${note} |`
  })
  .join('\n')

const dshTarget = (entry) => (typeof entry === 'string' ? { tool: entry, note: '' } : (entry ?? {}))
const dshReplacementRows = Object.entries(replacedByDsh)
  .map(([name, entry]) => {
    const { tool, note } = dshTarget(entry)
    return `| ${code(name)} | ${code(tool)} | ${escapeCell(note) || 'DSH 原生工具，直接用'} |`
  })
  .concat(replacedByGateway.map((name) => `| ${code(name)} | 插件网关 | 由 \`vt_list_skills\` / \`vt_load_skill\` 承担 |`))
  .join('\n')

const shellRows = [
  ['bash', 'pwsh', 'DSH 自带 shell；VT 技能会提到 bash，改成 pwsh，且不能当计算器、不能读 VT 安装包'],
  ['background_run', 'pwsh', '长任务放后台作业跑，用 job_list / job_output 取结果'],
  ['cancel_background', 'job_kill', '取消 DSH 的后台作业'],
]
  .map(([name, tool, note]) => `| ${code(name)} | ${code(tool)} | ${note} |`)
  .join('\n')

const doc = `# 工具面对照表（vibe-trading-ai ${pinned}）

> 本文件由 \`scripts/validate/gen_tool_surface_doc.mjs\` 生成，**不要手改**。
> 改完 \`toolsets.json\` 后运行 \`pnpm docs:tools\`；\`pnpm check:tools\` 在 CI/校验里检查本文件是否过期。
> 升级 Vibe-Trading 版本的流程见 §8。

一句话：worker 发布 **${workerNames.size}** 个工具，本插件最多暴露 **${advertised.size}** 个 worker 工具 + **${localTools.length}** 个本地工具；
其余 ${nonAdvertised.length} 个要么由 DSH 接管、要么需要凭据、要么被明确禁用（每条都有理由，见下）。

## 1. 数字账

| 项 | 数量 | 说明 |
|---|---|---|
| worker 发布工具 | ${workerNames.size} | ${registry.size} registry + ${virtual.size} virtual（\`tools/list\` 实测） |
| 上游 MCP 对外工具 | ${mcpSurface.size} | \`mcp_server.py\` 的公开面；比 worker 少（含 6 个 swarm 名，不含 registry-only 工具） |
| 本插件暴露（上限） | ${advertised.size + localTools.length} | ${advertised.size} worker + ${localTools.length} 本地 \`report_figures\` |
| ├ 常驻 staticCore | ${staticCore.length} | 激活时直接注册，无需 load |
| └ 工具组（${Object.keys(groups).length} 组） | ${Object.values(groups).flat().length} | 经 \`vt_load_tools\` 加载、\`vt_call\` 调用 |
| 未暴露 worker 工具 | ${nonAdvertised.length} | hidden ${hiddenWorkerNames.length} + DSH 替代 ${dshWorkerNames.length} + 网关替代 ${gatewayWorkerNames.length} + dropped ${droppedWorkerNames.length}（另 ${
  Object.values(dropped).flatMap((entry) => entry.tools ?? []).filter((name) => !workerNames.has(name)).length
} 个 dropped 名 worker 从未注册） |
| 需要凭据（缺则不出现在目录） | ${Object.keys(gated).length} | 见 §4；本机缺凭据时运行时目录 = ${advertised.size + localTools.length - Object.keys(gated).length} |

## 2. 常驻工具（激活时直接注册）

| 工具 | 来源 | 说明 |
|---|---|---|
${staticCore.map((name) => `| ${code(name)} | ${registry.has(name) ? 'VT registry' : 'virtual'} | ${staticCoreNote(name)} |`).join('\n')}
${localTools.map((tool) => `| ${code(tool.name)} | 插件本地 | ${localToolNote(tool)} |`).join('\n')}

## 3. 工具组（\`vt_load_tools(toolset=...)\`）

带 † 的工具需要凭据，缺凭据时会在运行时从目录和本组里移除（见 §4）。

| 组 | 成员数 | 成员 |
|---|---|---|
${groupRows}

## 4. 需要凭据才暴露

| 工具 | 需要的凭据 | 缺凭据时 |
|---|---|---|
${Object.entries(gated)
  .map(([name, requirement]) => `| ${code(name)} | ${requirement} | 不出现在目录里（worker \`capabilities\` 上报 \`available=false\`） |`)
  .join('\n')}

说明：

- 判定复用 VT 自己的 \`check_available()\`（只读环境变量，不联网），与上游“agent never sees a tool it cannot call”一致。
- 凭据是 **worker 启动时** 读取的；配好 \`.env\` 后需要重启 worker（空闲 30 分钟自动退出，或重载插件）才会出现在目录里。
- 这些名字在上游 registry 里会被 \`check_available()\` 直接剔除，所以 worker 用 MCP wrapper 的实现（virtual tool）承载；插件只在可用时把它放进目录。
- 券商连接（\`trading-reads\` 组）不是环境变量凭据：没配置时工具仍暴露，调用会返回“没有连接”，属于运行期配置而非门禁。

## 5. 由 DSH 接管（不暴露，但能力仍在）

| Vibe-Trading 名字 | 这里的替代 | 说明 |
|---|---|---|
${dshReplacementRows}

上游默认不发布 shell 能力（要 \`VIBE_TRADING_ENABLE_SHELL_TOOLS=1\` 才开），这部分由宿主提供：

| Vibe-Trading 工具 | 这里的替代 | 说明 |
|---|---|---|
${shellRows}

## 6. 直接禁用（hidden，${hiddenWorkerNames.length} 个 registry 工具）

一行一组；每个工具都必须在这里有理由——\`check_manifest.mjs\` 会拒绝“悄悄消失”的工具。

| 类别 | 原因 | 工具（数量） |
|---|---|---|
${hiddenRows}

## 7. 未发布（dropped / excluded / 上游没有）

| 类别 | 原因 | 工具（数量） |
|---|---|---|
${droppedRows}
| \`excluded\`（${excluded.length}） | 上游 MCP surface 之外的可选工具，本插件不接（D9）；worker 也不会注册 | ${listCell(excluded)} |

上游 MCP 有、worker 没有（${mcpOnly.length} 个）：

| 工具 | 原因 |
|---|---|
${mcpOnlyRows}

## 8. 升级 Vibe-Trading 时怎么维护

| 步骤 | 做什么 | 检查点 |
|---|---|---|
| 1 | 按 skill \`vt-version-pin\` 升级 \`PINNED_VERSION\` / \`_vendor\` tag / \`pyproject.toml\` / \`uv.lock\` / venv | 版本固定点一致 |
| 2 | \`node scripts/validate/check_pin.mjs\` | 0 FAIL |
| 3 | \`pnpm capture:surface\` 重新抓 worker 面 | \`scripts/validate/worker-surface.json\` 更新 |
| 4 | \`pnpm docs:tools\` 重新生成本文件，**看 diff** | 新工具：决定进组 / 进 hidden 配理由 / 进 dropped；消失的工具：\`check_manifest\` 报 hidden 文档失效；改名：报 duplicate/unknown |
| 5 | \`pnpm check:tools\` + \`check_manifest.mjs\` + \`pnpm verify\` | 全绿 |
| 6 | 名字对齐原则 | 优先跟 VT agent 内部 registry 名（技能文档按这些名字写）；MCP wrapper 名只做 \`prompt/bridge.md\` 映射，不进目录 |
`

const current = existsSync(DOC) ? readFileSync(DOC, 'utf8') : ''
const check = process.argv.includes('--check')
if (check) {
  if (current !== doc) {
    console.error(`FAIL  ${path.relative(root, DOC)} is stale; run: pnpm docs:tools`)
    process.exit(1)
  }
  console.log(`PASS  ${path.relative(root, DOC)} matches toolsets.json (${advertised.size} advertised worker tools)`)
} else {
  writeFileSync(DOC, doc)
  console.log(`wrote ${path.relative(root, DOC)} (pinned ${pinned}; ${workerNames.size} worker tools, ${advertised.size} advertised)`)
}
