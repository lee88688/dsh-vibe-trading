import test from 'node:test'
import assert from 'node:assert/strict'

import { createFiguresTool, FIGURES_TOOL_NAME, FIGURES_PARAMETERS } from '../dist/lib/figures-tool.js'

test('report_figures declares the DSH tool contract (parameters + output)', () => {
  const tool = createFiguresTool({ async declare() { return { ok: true, text: 'ok' } } })
  assert.equal(tool.name, FIGURES_TOOL_NAME)
  assert.equal(tool.parameters, FIGURES_PARAMETERS)
  assert.equal(tool.parameters.required[0], 'figures')
  assert.equal(tool.parameters.properties.figures.type, 'array')
  assert.equal(tool.output.schema.type, 'string')
  assert.equal(typeof tool.output.render, 'function')
  assert.deepEqual(tool.output.render({}, 'hello'), [{ type: 'text', text: 'hello' }])
  assert.equal(typeof tool.execute, 'function')
  // DSH calls isConcurrencySafe as a predicate over the call arguments.
  assert.equal(typeof tool.isConcurrencySafe, 'function')
  assert.equal(tool.isConcurrencySafe({ figures: [] }), false)
})

test('report_figures forwards declarations and draft to the grounding gate', async () => {
  const calls = []
  const tool = createFiguresTool({
    async declare(request) {
      calls.push(request)
      return { ok: false, text: '校验未通过：1 处问题' }
    },
  })
  const text = await tool.execute({
    figures: ['1.5 | observed | PE ratio | get_fundamentals'],
    draft: '答案是 1.5。',
  })
  assert.equal(text, '校验未通过：1 处问题')
  assert.deepEqual(calls[0].figures, ['1.5 | observed | PE ratio | get_fundamentals'])
  assert.equal(calls[0].draft, '答案是 1.5。')
})

test('report_figures tolerates missing draft and gate failures', async () => {
  const tool = createFiguresTool({ async declare() { return { ok: true, text: '已记录 1 条数字声明。' } } })
  assert.match(await tool.execute({ figures: ['7 | count | window'] }), /已记录/)
  const broken = createFiguresTool({ async declare() { throw new Error('worker down') } })
  assert.match(await broken.execute({ figures: [] }), /report_figures 调用失败/)
})
