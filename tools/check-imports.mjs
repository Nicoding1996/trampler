// Resolve every import specifier in src/ the way the browser will.
//
//   node tools/check-imports.mjs
//
// This exists because the project has no bundler and no build step, so nothing
// ever validates the module graph until a browser tries to load it -- and a
// mistyped path fails as a blank canvas with one line in the console, which is a
// miserable way to find out. `node --check` will not catch it: it parses a file
// without resolving anything it imports.
//
// Bare specifiers are checked against the same importmap index.html declares, so
// this also catches the two of them drifting apart.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

// Pull the importmap straight out of the page rather than duplicating it here.
const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (!mapMatch) {
  console.error("no importmap found in index.html");
  process.exit(1);
}
const imports = JSON.parse(mapMatch[1]).imports;

const SPEC = /(?:^|[\s(])(?:import|export)\b[^;]*?from\s+["']([^"']+)["']/g;
const DYNAMIC = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(spec, fromFile) {
  if (spec.startsWith("node:")) return { ok: true, target: "builtin" };

  if (spec.startsWith("./") || spec.startsWith("../")) {
    const target = resolve(dirname(fromFile), spec);
    return { ok: existsSync(target), target };
  }

  // Exact importmap entry, then the longest trailing-slash prefix, which is how
  // the browser resolves them.
  if (imports[spec]) {
    const target = join(ROOT, imports[spec].replace(/^\//, ""));
    return { ok: existsSync(target), target };
  }
  for (const [prefix, to] of Object.entries(imports)) {
    if (prefix.endsWith("/") && spec.startsWith(prefix)) {
      const target = join(ROOT, to.replace(/^\//, ""), spec.slice(prefix.length));
      return { ok: existsSync(target), target };
    }
  }
  return { ok: false, target: `unmapped bare specifier "${spec}"` };
}

// WHAT IS SCANNED, AND WHY IT IS MORE THAN src/.
//
// This used to be src/ plus verify.mjs, and that gap cost something twice. worker/ and
// tools/ both import from src/ across a relative path, and nothing validated those at
// all: when the crew refactor landed, worker/sim-check.js went on importing fine and
// calling wrongly, and an earlier round trip was spent on a `CFG.ENEMY_TYPE` that does
// not exist. Neither is caught here, but the class is -- a renamed or moved module in
// src/ silently breaks every consumer outside src/, and those consumers are the two
// places nobody runs by habit.
//
// A HONEST NOTE ON WHAT THE BARE-SPECIFIER CHECK MEANS OUTSIDE src/. For src/ this
// resolves the way the BROWSER will, through index.html's importmap, which is the real
// resolver for those files. worker/ is resolved by wrangler's bundler and tools/ by
// Node, both through node_modules -- different resolvers. Since the importmap points
// into node_modules anyway, checking them here amounts to "the package is on disk",
// which is weaker than it looks for a bare specifier and exactly right for the relative
// paths that actually break. Said plainly rather than left to be assumed.
const jsIn = (dir, ext) =>
  readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => join(ROOT, dir, f));

const files = [
  ...readdirSync(join(ROOT, "src")).map((f) => join(ROOT, "src", f)),
  join(ROOT, "verify.mjs"),
  join(ROOT, "server.mjs"),
  ...jsIn("worker", ".js"),
  ...jsIn("tools", ".mjs"),
];

let bad = 0;
let checked = 0;

for (const file of files) {
  const src = readFileSync(file, "utf8");
  const specs = [
    ...[...src.matchAll(SPEC)].map((m) => m[1]),
    ...[...src.matchAll(DYNAMIC)].map((m) => m[1]),
  ];

  for (const spec of specs) {
    checked++;
    const { ok, target } = resolveSpec(spec, file);
    if (!ok) {
      bad++;
      console.log(`MISSING  ${file.slice(ROOT.length + 1)} -> ${spec}   (${target})`);
    }
  }
}

console.log(`${checked - bad}/${checked} import specifiers resolve`);
if (bad > 0) process.exit(1);
