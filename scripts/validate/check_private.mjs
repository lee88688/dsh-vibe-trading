#!/usr/bin/env node
// Scan project text files for personal content and local absolute paths.
// Personal research notes belong in the git-ignored _personal/ directory (see AGENTS.md).
//
// The public check is generic. Machine- or person-specific patterns belong in the
// git-ignored scripts/validate/private-denylist.local.json (same [label, regex]
// shape); that file is never published and is skipped by this scan.
//
// Usage: node scripts/validate/check_private.mjs
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SELF = "scripts/validate/check_private.mjs";
const LOCAL_PATTERNS = "scripts/validate/private-denylist.local.json";

const PATTERNS = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  [
    "provider-token",
    /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b/,
  ],
  ["local-user-path", /C:\\Users\\|Administrator/i],
];

const localFile = join(ROOT, LOCAL_PATTERNS);
if (existsSync(localFile)) {
  const extra = JSON.parse(readFileSync(localFile, "utf8"));
  if (!Array.isArray(extra)) throw new Error(`${LOCAL_PATTERNS} must be an array of [label, regex] pairs`);
  for (const entry of extra) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
      throw new Error(`${LOCAL_PATTERNS}: each entry must be [label, regex]`);
    }
    PATTERNS.push([entry[0], new RegExp(entry[1], "i")]);
  }
}

const SKIP_DIRS = new Set([
  ".git",
  ".venv",
  "node_modules",
  "dist",
  "_vendor",
  "_personal",
  ".tmp",
  "tmp",
  "results",
  ".scratch",
  ".cache",
  "coverage",
  "out",
  "build",
  "__pycache__",
]);
const SKIP_FILES = [
  /^scripts\/env\/(?!bundles\.json$).+\.json$/i, // generated benchmark artifacts
  /^scripts\/validate\/worker-check\.json$/i, // generated check result
  /^scripts\/validate\/private-denylist\.local\.json$/i, // local-only patterns
];
const BINARY = /\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|zip|gz|zst|pdf|exe|dll|node|wasm)$/i;

function walk(dir, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = relative(ROOT, full).split(sep).join("/");
    if (rel === SELF) continue;
    if (SKIP_FILES.some((re) => re.test(rel))) continue;
    out.push(rel);
  }
}

const files = [];
walk(ROOT, files);

let hits = 0;
for (const file of files) {
  if (BINARY.test(file)) continue;
  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    continue;
  }
  if (buffer.subarray(0, 8192).includes(0)) continue; // binary
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const [label, re] of PATTERNS) {
      if (re.test(lines[index])) {
        console.log(`${file}:${index + 1}: [${label}] ${lines[index].trim().slice(0, 160)}`);
        hits += 1;
      }
    }
  }
}

if (hits) {
  console.error(`\n${hits} personal/local-content hit(s); move them to _personal/ or generalize the text`);
  process.exit(1);
}
console.log(`private-content scan OK (${files.length} files)`);
