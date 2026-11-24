/** Shared output declaration for tools that return text/JSON strings. */
export const TEXT_OUTPUT = {
  // Our tools all return a string (formatted text or serialized JSON). The DSH
  // schema DSL only accepts JSON-Schema types, not an author-only 'json' kind.
  schema: { type: 'string' as const },
  render: (_args: any, value: any) => [
    { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
  ],
}
