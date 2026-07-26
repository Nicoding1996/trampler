// Summarise a harness run: failures with the section they came from, the totals,
// and optionally the full text of chosen sections.
//
//   node tools/summarise.mjs out.txt            # failures + totals
//   node tools/summarise.mjs out.txt 87 88 89    # ...plus those sections in full
//
// Exists because the harness prints ~700 lines, the shell in this environment
// mangles anything but the simplest inline command, and reading the file directly
// tends to return the head rather than the part that matters.

import { readFileSync } from "node:fs";

const [file, ...want] = process.argv.slice(2);
if (!file) {
  console.error("usage: node tools/summarise.mjs <run.txt> [section numbers...]");
  process.exit(2);
}

const lines = readFileSync(file, "utf8").split(/\r?\n/);
const HEADER = /^(\d+[a-z]?)\. /;

let section = "";
const failures = [];
const totals = [];
const wanted = new Set(want);
let capturing = false;
const captured = [];

for (const line of lines) {
  const h = line.match(HEADER);
  if (h) {
    section = line;
    capturing = wanted.has(h[1]);
    if (capturing) captured.push("");
  }
  if (capturing) captured.push(line);
  if (line.includes("FAIL")) failures.push(`  ${section}\n    ${line.trim()}`);
  if (/checks passed|FAILING/.test(line)) totals.push(line.trim());
  if (/^(Error|TypeError|ReferenceError|SyntaxError)/.test(line.trim())) {
    failures.push(`  ${section}\n    ${line.trim()}`);
  }
}

if (captured.length) console.log(captured.join("\n"));

console.log(`\n${failures.length ? "FAILURES" : "No failures."}`);
for (const f of failures) console.log(f);
console.log(`\n${totals.join("\n") || "no totals line found"}\n`);
