// Compare two harness runs line by line.
//
//   node verify.mjs > a.txt && node verify.mjs > b.txt
//   node tools/diff-runs.mjs a.txt b.txt
//
// Invariant 21 says two full runs must differ ONLY in the wall-clock performance
// reading. This is how that gets confirmed after any change to the simulation,
// because a difference anywhere else means unseeded randomness has crept back in
// and every measured survival time in the suite has become a coin flip.

import { readFileSync } from "node:fs";

const [aPath = "d1.txt", bPath = "d2.txt"] = process.argv.slice(2);
const a = readFileSync(aPath, "utf8").split(/\r?\n/);
const b = readFileSync(bPath, "utf8").split(/\r?\n/);

console.log(`${aPath}: ${a.length} lines, ${bPath}: ${b.length} lines`);

let differing = 0;
let expected = 0;
for (let i = 0; i < Math.max(a.length, b.length); i++) {
  if (a[i] === b[i]) continue;
  differing++;
  // The only legitimate difference: how long the machine took.
  if (/ms\/frame/.test(a[i] ?? "") && /ms\/frame/.test(b[i] ?? "")) {
    expected++;
    console.log(`  timing  line ${i + 1}: ${(a[i] ?? "").trim()}`);
    continue;
  }
  console.log(`  DIFF    line ${i + 1}\n    A: ${a[i] ?? ""}\n    B: ${b[i] ?? ""}`);
}

const unexpected = differing - expected;
console.log(
  `\n${differing} differing line${differing === 1 ? "" : "s"}, `
  + `${expected} of them timing.`,
);
console.log(
  unexpected === 0
    ? "Deterministic: the runs differ only in wall-clock timing.\n"
    : `NOT DETERMINISTIC: ${unexpected} unexplained difference(s).\n`,
);
if (unexpected > 0) process.exit(1);
