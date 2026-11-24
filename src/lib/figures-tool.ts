/**
 * `report_figures` — the declaration channel for the number gate.
 *
 * DSH cannot rewrite an assistant message once committed, so the VT `figures`
 * block cannot live in the answer text (the user would see it). Instead the
 * model submits its declarations here, together with the draft answer, and the
 * worker runs the same `validate_final_answer` before the answer is emitted.
 */

import { TEXT_OUTPUT } from './tool-output.js'

export const FIGURES_TOOL_NAME = 'report_figures'

export const FIGURES_PARAMETERS = {
  type: 'object',
  properties: {
    figures: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One "value | role | note | ref" line per declared figure. Roles: observed, derived, proposed, cited, count.',
    },
    draft: {
      type: 'string',
      description:
        'The exact final answer text you intend to output (without any figures code block). The validator checks it before release.',
    },
  },
  required: ['figures'],
  additionalProperties: false,
}

export function createFiguresTool(grounding: any) {
  return {
    name: FIGURES_TOOL_NAME,
    description:
      'Declare the figures your answer will cite and validate them before release. Submit "value | role | note | ref" ' +
      'lines (roles: observed/derived/proposed/cited/count) plus the exact draft answer; returns issues to fix. ' +
      'Calling again with an empty figures list re-checks a draft against the declarations already recorded. ' +
      'Never print a figures code block in the answer itself.',
    parameters: FIGURES_PARAMETERS,
    output: TEXT_OUTPUT,
    // Predicate form: DSH invokes the field with the call arguments.
    isConcurrencySafe: () => false,
    async execute(args: any = {}) {
      const figures = Array.isArray(args?.figures) ? args.figures.map((line: any) => String(line)) : []
      const draft = typeof args?.draft === 'string' ? args.draft : undefined
      try {
        const result = await grounding.declare({ figures, draft })
        return result.text
      } catch (error: any) {
        return `report_figures 调用失败：${error?.message ?? error}`
      }
    },
  }
}
