import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildPromptText,
  skillCatalogText,
  toolCatalogText,
  toolsetSummary,
} from '../dist/lib/prompt.js'

/* ------------------------------------------------------------------------- */
/* toolCatalogText                                                            */
/* ------------------------------------------------------------------------- */

test('toolCatalogText advertises only core + group tools that the worker returned', () => {
  const tools = [
    { name: 'search_symbol', description: 'Resolve a symbol across markets.' },
    { name: 'hidden_tool', description: 'Must not be advertised.' },
    { name: 'get_market_data', description: 'Fetch OHLCV data.' },
    { name: 'factor_analysis', description: 'IC/IR analysis.' },
  ]
  const toolsets = {
    staticCore: ['search_symbol', 'missing_core'],
    groups: {
      research: ['get_market_data', 'missing_group_tool'],
      backtest: ['factor_analysis'],
    },
  }

  assert.equal(
    toolCatalogText(tools, toolsets),
    [
      '- search_symbol: Resolve a symbol across markets.',
      '- get_market_data: Fetch OHLCV data.',
      '- factor_analysis: IC/IR analysis.',
    ].join('\n'),
  )
})

test('toolCatalogText keeps the worker order and collapses whitespace', () => {
  const tools = [
    { name: 'b_tool', description: 'Second\n\nline   with\tspaces.' },
    { name: 'a_tool', description: 'First line.' },
  ]
  const toolsets = { staticCore: ['a_tool'], groups: { research: ['b_tool'] } }

  assert.equal(
    toolCatalogText(tools, toolsets),
    ['- b_tool: Second line with spaces.', '- a_tool: First line.'].join('\n'),
  )
})

test('toolCatalogText truncates at 80 characters with an ellipsis', () => {
  const exactly80 = 'd'.repeat(80)
  const longer = `prefix ${'x'.repeat(120)}`
  const tools = [
    { name: 'short_tool', description: 'A short hint.' },
    { name: 'exact_tool', description: exactly80 },
    { name: 'long_tool', description: longer },
  ]
  const toolsets = { staticCore: ['short_tool', 'exact_tool', 'long_tool'] }
  const [shortLine, exactLine, longLine] = toolCatalogText(tools, toolsets).split('\n')

  assert.equal(shortLine, '- short_tool: A short hint.')
  assert.equal(exactLine, `- exact_tool: ${exactly80}`)
  assert.equal(exactLine.endsWith('…'), false)

  const hint = longLine.slice('- long_tool: '.length)
  assert.equal(hint.length, 81)
  assert.equal(hint, `${longer.slice(0, 80)}…`)
  assert.ok(hint.endsWith('…'))
})

test('toolCatalogText returns empty text when nothing is advertised or returned', () => {
  assert.equal(toolCatalogText([], {}), '')
  assert.equal(toolCatalogText([{ name: 'x', description: 'y' }], { staticCore: [], groups: {} }), '')
  assert.equal(toolCatalogText(undefined, undefined), '')
})

/* ------------------------------------------------------------------------- */
/* skillCatalogText                                                           */
/* ------------------------------------------------------------------------- */

const skillFixtures = [
  { name: 'skill-b', category: 'zeta', description: 'First sentence. Second sentence with more detail.' },
  { name: 'skill-a', category: 'alpha', description: 'Short skill description.' },
  { name: 'skill-c', category: 'zeta', description: 'Another one.' },
]

test('skillCatalogText defaults to short mode and groups by category', () => {
  assert.equal(
    skillCatalogText(skillFixtures),
    [
      '### alpha',
      '- skill-a: Short skill description.',
      '',
      '### zeta',
      '- skill-b: First sentence.',
      '- skill-c: Another one.',
    ].join('\n'),
  )
})

test('skillCatalogText short mode caps each line at 100 characters', () => {
  const noBreak = 'y'.repeat(150)
  const text = skillCatalogText([{ name: 'long-skill', category: 'cat', description: noBreak }], 'short')
  assert.equal(text, `### cat\n- long-skill: ${'y'.repeat(99)}…`)
})

test('skillCatalogText does not treat U.S. or decimals as a sentence end', () => {
  const text = skillCatalogText(
    [{ name: 'sec-edgar', category: 'data-source', description: 'U.S. SEC EDGAR fetch interface. More detail follows here.' }],
    'short',
  )
  assert.equal(text, '### data-source\n- sec-edgar: U.S. SEC EDGAR fetch interface.')
})

test('skillCatalogText full mode keeps the whole description', () => {
  const description = 'First sentence. Second sentence with more detail, kept whole in full mode.'
  const text = skillCatalogText([{ name: 'skill-b', category: 'zeta', description }], 'full')
  assert.equal(text, `### zeta\n- skill-b: ${description}`)
})

test('skillCatalogText none mode returns empty text', () => {
  assert.equal(skillCatalogText(skillFixtures, 'none'), '')
})

test('skillCatalogText falls back to the other category and handles empty input', () => {
  assert.equal(
    skillCatalogText([{ name: 'plain', description: 'No category.' }], 'short'),
    '### other\n- plain: No category.',
  )
  assert.equal(skillCatalogText([], 'short'), '')
  assert.equal(skillCatalogText(undefined, 'full'), '')
})

/* ------------------------------------------------------------------------- */
/* toolsetSummary                                                             */
/* ------------------------------------------------------------------------- */

test('toolsetSummary renders group names with member counts', () => {
  const toolsets = {
    groups: {
      research: Array.from({ length: 26 }, (_, index) => `r${index}`),
      backtest: Array.from({ length: 9 }, (_, index) => `b${index}`),
      verify: ['report_audit'],
    },
  }
  assert.equal(toolsetSummary(toolsets), 'research(26) · backtest(9) · verify(1)')
})

test('toolsetSummary returns empty text without groups', () => {
  assert.equal(toolsetSummary({}), '')
  assert.equal(toolsetSummary(undefined), '')
})

/* ------------------------------------------------------------------------- */
/* buildPromptText                                                            */
/* ------------------------------------------------------------------------- */

const buildInput = {
  base: '# Vibe Trading\n\nYou are a finance research agent.\n',
  bridge: '| read_file | read |',
  tools: [
    { name: 'search_symbol', description: 'Resolve a symbol.' },
    { name: 'hidden_tool', description: 'Not advertised.' },
  ],
  skills: [
    { name: 'skill-a', category: 'cat', description: 'Does A.' },
    { name: 'skill-b', category: 'cat', description: 'Does B.' },
  ],
  toolsets: {
    staticCore: ['search_symbol'],
    groups: { research: ['search_symbol'], backtest: ['backtest_tool'] },
  },
}

test('buildPromptText concatenates base, catalog, groups, skills and bridge in order', () => {
  const text = buildPromptText(buildInput)
  const markers = [
    '# Vibe Trading',
    'You are a finance research agent.',
    '## Available Vibe-Trading tools',
    '- search_symbol: Resolve a symbol.',
    'Tool groups (load with vt_load_tools): research(1) · backtest(1)',
    '## Available Vibe-Trading skills',
    '### cat',
    '- skill-a: Does A.',
    '- skill-b: Does B.',
    '## Tool mapping for DSH native tools',
    '| read_file | read |',
  ]
  const positions = markers.map((marker) => text.indexOf(marker))
  positions.forEach((position, index) => {
    assert.ok(position >= 0, `missing prompt marker: ${markers[index]}`)
    if (index > 0) assert.ok(position > positions[index - 1], `out of order: ${markers[index]}`)
  })
  assert.equal(text.includes('hidden_tool'), false)
  assert.equal(text.includes('\r'), false)
})

test('buildPromptText honours skillsMode', () => {
  const none = buildPromptText({ ...buildInput, skillsMode: 'none' })
  assert.ok(none.includes('## Available Vibe-Trading skills'))
  assert.equal(none.includes('### cat'), false)
  assert.equal(none.includes('- skill-a:'), false)

  const longDescription = 'First sentence. Second sentence with much more detail that short mode trims.'
  const full = buildPromptText({
    ...buildInput,
    skills: [{ name: 'skill-a', category: 'cat', description: longDescription }],
    skillsMode: 'full',
  })
  assert.ok(full.includes(`- skill-a: ${longDescription}`))

  const short = buildPromptText({
    ...buildInput,
    skills: [{ name: 'skill-a', category: 'cat', description: longDescription }],
    skillsMode: 'short',
  })
  assert.ok(short.includes('- skill-a: First sentence.'))
})

test('buildPromptText tolerates empty optional inputs', () => {
  const text = buildPromptText({})
  assert.ok(text.startsWith('## Available Vibe-Trading tools'))
  assert.ok(text.includes('Tool groups (load with vt_load_tools): '))
  assert.ok(text.includes('## Tool mapping for DSH native tools'))
  assert.equal(typeof buildPromptText(), 'string')
})
