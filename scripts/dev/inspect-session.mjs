#!/usr/bin/env node
/** Inspect a compressed DSH session log: print record kinds and command events. */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const pattern = process.argv[3]
if (!file) {
  console.error('usage: node inspect-session.mjs <session.v4.jsonl.zstd> [pattern]')
  process.exit(1)
}
const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log(`records: ${lines.length}`)
const kinds = new Map()
const parsed = []
for (const line of lines) {
  try {
    const record = JSON.parse(line)
    parsed.push(record)
    const kind = record.type ?? record.kind ?? record.event ?? record.name ?? Object.keys(record).slice(0, 3).join('+')
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  } catch {
    parsed.push({ raw: line.slice(0, 200) })
  }
}
console.log('kinds:', JSON.stringify([...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)))
const hits = pattern
  ? parsed.filter((record) => JSON.stringify(record).includes(pattern))
  : parsed.filter((record) => /command|vibe/i.test(JSON.stringify(record).slice(0, 400)))
console.log(`matches (${pattern ?? 'command|vibe'}): ${hits.length}`)
for (const hit of hits.slice(0, 20)) {
  const text = JSON.stringify(hit)
  console.log('---')
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}…` : text)
}
