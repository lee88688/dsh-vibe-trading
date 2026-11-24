#!/usr/bin/env node
// Validate relative Markdown links in the public entry points and docs/**/*.md.
// Usage: node scripts/validate/check_docs_links.mjs
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const targets = [
  "README.md",
  "README.zh-CN.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CHANGELOG.md",
  "THIRD-PARTY-NOTICES.md",
  "plugin-page.zh.md",
  "plugin-page.en.md",
];

function walkMarkdown(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walkMarkdown(path));
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

if (existsSync(join(root, "docs"))) targets.push(...walkMarkdown(join(root, "docs")));

const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
let failures = 0;

for (const file of targets) {
  const text = readFileSync(file, "utf8");
  text.split(/\r?\n/).forEach((line, index) => {
    for (const match of line.matchAll(linkRe)) {
      let href = match[1].trim();
      if (!href || /^(https?:|mailto:|#)/i.test(href)) continue;
      href = href.split("#")[0].split("?")[0];
      if (!href) continue;
      const target = resolve(root, dirname(file), decodeURI(href));
      if (!existsSync(target)) {
        console.log(`${file}:${index + 1}: broken link -> ${match[1]}`);
        failures += 1;
      }
    }
  });
}

if (failures) {
  console.error(`\n${failures} broken link(s)`);
  process.exit(1);
}
console.log(`docs links OK (${targets.length} files)`);
