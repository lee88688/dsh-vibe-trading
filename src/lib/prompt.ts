/**
 * Pure prompt-assembly helpers for Vibe-Trading activation.
 *
 * This module does no I/O: callers pass the worker's `tools/list` and
 * `skills/list` payloads plus the parsed `toolsets.json`. Output is deterministic
 * so the static prompt section stays byte-stable across requests (prefix cache).
 */

import { advertisedToolNames } from './surface.js'

/** Characters of each tool description kept in the one-line catalog. */
const CATALOG_HINT_CHARS = 80

/** Characters of each skill description kept in `short` skills mode. */
const SKILL_SHORT_CHARS = 100

/** Display order for skill categories: the upstream SkillsLoader order. */
const SKILL_CATEGORY_ORDER = [
  'data-source',
  'strategy',
  'analysis',
  'asset-class',
  'crypto',
  'flow',
  'tool',
  'other',
]

/** Common abbreviation endings that are not sentence boundaries. */
const ABBREVIATION_END = /(?:^|[\s(])(?:[A-Za-z]\.){1,3}$|(?:^|\s)(?:U\.S|e\.g|i\.e|No|vs|Inc|Ltd|Corp|Co|etc|Mr|Ms|Dr)\.$/i

/** @param {string} value */
function oneLine(value: any) {
  return String(value ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * Render one catalog line per advertised tool, in the order the worker lists
 * them: `- name: first 80 chars of description…`. Advertised names that the
 * worker did not return are skipped.
 * @param {Array<{name?: string, description?: string}>} tools
 * @param {{staticCore?: string[], groups?: Record<string, string[]>}} toolsets
 * @returns {string}
 */
export function toolCatalogText(tools: any[], toolsets: any) {
  const advertised = advertisedToolNames(toolsets)
  const lines: any[] = []
  for (const tool of tools ?? []) {
    const name = oneLine(tool?.name)
    if (!name || !advertised.has(name)) continue
    const description = oneLine(tool?.description)
    const hint = description.length > CATALOG_HINT_CHARS
      ? `${description.slice(0, CATALOG_HINT_CHARS)}…`
      : description
    lines.push(`- ${name}: ${hint}`)
  }
  for (const entry of toolsets?.localTools ?? []) {
    if (entry?.name && entry?.description) lines.push(`- ${entry.name}: ${entry.description}`)
  }
  return lines.join('\n')
}

/** Cut point when no sentence end fits: prefer a nearby word boundary. */
function fallbackCut(text: string) {
  const budget = SKILL_SHORT_CHARS - 1
  if (text.length <= budget) return text.length
  const head = text.slice(0, budget)
  const space = head.lastIndexOf(' ')
  // A space far from the end would cut the summary too short (common in CJK
  // text where " " appears early); prefer the hard budget in that case.
  return space > budget * 0.6 ? space : budget
}

/**
 * First sentence of a description, capped at 100 chars.
 *
 * Sentence ends are `.!?;` (plus CJK `。；`), but a period after a single
 * letter, a known abbreviation, or a digit is not a boundary (`U.S. SEC`,
 * `e.g.`, `version 0.1`). When no sentence end fits the budget the text is cut
 * at the last word boundary and an ellipsis marks the omission, so a catalog
 * line never ends mid-word without signalling it.
 * @param {string} description
 * @returns {string}
 */
function shortSkillDescription(description: string) {
  const text = String(description ?? '')
  let cut = 0
  let endedAtSentence = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '.' || ch === '。' || ch === '；' || ch === ';' || ch === '!' || ch === '?') {
      const sentence = text.slice(0, i + 1)
      const nextChar = text[i + 1]
      // A period inside a token (`signal_engine.py`, `v0.1.19`) is not a
      // sentence end; nor is an abbreviation or a decimal point. CJK stops
      // (`。`, `；`) always end a sentence, with or without a following space.
      if (ch === '.') {
        // A trailing period always ends the description; mid-text periods may
        // be part of a filename, version, decimal or abbreviation.
        if (nextChar) {
          if (!/\s/.test(nextChar)) continue
          if (/[0-9]\.$/.test(sentence) || ABBREVIATION_END.test(sentence.trimEnd())) continue
        }
      }
      cut = i + 1
      endedAtSentence = true
      break
    }
    if (i >= SKILL_SHORT_CHARS - 1) {
      cut = fallbackCut(text)
      break
    }
  }
  if (!cut) {
    cut = fallbackCut(text)
    endedAtSentence = false
  }
  const head = text.slice(0, cut).trimEnd()
  if (head.length >= text.length) return head || text
  return endedAtSentence ? head : `${head}…`
}

/**
 * Render the skill catalog grouped by category with `### <category>` headings.
 * Categories follow the upstream `SkillsLoader` display order; unlisted
 * categories come after it, alphabetically. Within a category the worker's
 * order (name order) is kept.
 * - `short` (default): first sentence / at most 100 chars per skill
 * - `full`: the whole one-line description
 * - `none`: empty string
 * @param {Array<{name?: string, description?: string, category?: string}>} skills
 * @param {'short'|'full'|'none'} [mode]
 * @returns {string}
 */
export function skillCatalogText(skills: any[], mode: string = 'short') {
  const effective = mode === 'full' || mode === 'none' ? mode : 'short'
  if (effective === 'none') return ''

  /** @type {Map<string, string[]>} */
  const byCategory = new Map()
  for (const skill of skills ?? []) {
    const name = oneLine(skill?.name)
    if (!name) continue
    const category = oneLine(skill?.category) || 'other'
    const description = oneLine(skill?.description)
    const text = effective === 'full' ? description : shortSkillDescription(description)
    if (!byCategory.has(category)) byCategory.set(category, [])
    byCategory.get(category).push(`- ${name}: ${text}`)
  }

  const known = SKILL_CATEGORY_ORDER.filter((category) => byCategory.has(category))
  const unknown = [...byCategory.keys()].filter((category) => !SKILL_CATEGORY_ORDER.includes(category)).sort()
  const blocks: any[] = []
  for (const category of [...known, ...unknown]) {
    blocks.push([`### ${category}`, ...byCategory.get(category)!].join('\n'))
  }
  return blocks.join('\n\n')
}

/**
 * Compact group summary for the prompt: `research(26) · backtest(9) · ...`.
 * @param {{groups?: Record<string, string[]>}} toolsets
 * @returns {string}
 */
export function toolsetSummary(toolsets: any) {
  return Object.entries(toolsets?.groups ?? {})
    .map(([group, names]) => `${group}(${Array.isArray(names) ? names.length : 0})`)
    .join(' · ')
}

/**
 * Assemble the complete static prompt section:
 *
 *   <base prompt>
 *
 *   ## Available Vibe-Trading tools
 *   <catalog>
 *
 *   Tool groups (load with vt_load_tools): <summary>
 *
 *   ## Available Vibe-Trading skills
 *   <skill catalog>
 *
 *   ## Tool mapping for DSH native tools
 *   <bridge>
 *
 * @param {{
 *   base?: string,
 *   bridge?: string,
 *   tools?: Array<{name?: string, description?: string}>,
 *   skills?: Array<{name?: string, description?: string, category?: string}>,
 *   toolsets?: {staticCore?: string[], groups?: Record<string, string[]>},
 *   skillsMode?: 'short'|'full'|'none',
 * }} input
 * @returns {string}
 */
export interface PromptInput {
  base?: string
  bridge?: string
  tools?: any[]
  skills?: any[]
  toolsets?: any
  skillsMode?: string
}

export function buildPromptText({
  base = '',
  bridge = '',
  tools = [],
  skills = [],
  toolsets = {},
  skillsMode = 'short',
}: PromptInput = {}) {
  const blocks = [
    String(base ?? '').trimEnd(),
    `\n## Available Vibe-Trading tools\n${toolCatalogText(tools, toolsets)}`,
    `\nTool groups (load with vt_load_tools): ${toolsetSummary(toolsets)}`,
    `\n## Available Vibe-Trading skills\n${skillCatalogText(skills, skillsMode)}`,
    `\n## Tool mapping for DSH native tools\n${String(bridge ?? '').trim()}`,
  ]
  return blocks.join('\n').trim()
}
