#!/usr/bin/env node

import { readFileSync } from "node:fs";

const path = process.argv[2];
if (!path) {
  console.error("Usage: validate-zapstore-notes.mjs <notes-file>");
  process.exit(2);
}

const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n").trim();
const blocks = source.split(/\n[ \t]*\n+/).map(block => block.trim()).filter(Boolean);
const errors = [];

if (!/^# [^#\n].+$/u.test(blocks[0] ?? "")) {
  errors.push("first paragraph must be a single '# Theme' title");
}
if (!/^⚡\s+\S.+$/u.test(blocks[1] ?? "") || blocks[1]?.includes("\n")) {
  errors.push("second paragraph must be a one-line ⚡ benefit tagline");
}

const benefits = blocks.slice(2, -1);
if (benefits.length < 2) {
  errors.push("include at least two blank-separated emoji benefit paragraphs");
}
for (const [index, benefit] of benefits.entries()) {
  if (!/^\p{Extended_Pictographic}/u.test(benefit)) {
    errors.push(`benefit paragraph ${index + 1} must start with an emoji`);
  }
  if (benefit.includes("\n")) {
    errors.push(`benefit paragraph ${index + 1} must be one line with blank lines around it`);
  }
}

const proof = blocks.at(-1) ?? "";
if (proof === blocks[0] || !proof.includes(" · ") || /^\p{Extended_Pictographic}/u.test(proof)) {
  errors.push("last paragraph must be a non-emoji proof closer with ' · ' separators");
}

if (errors.length) {
  console.error(`❌ Zapstore release-note protocol failed for ${path}:`);
  for (const error of errors) console.error(`   - ${error}`);
  process.exit(1);
}

console.log(`✅ Zapstore release-note protocol passed: ${path}`);
