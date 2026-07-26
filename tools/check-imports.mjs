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

const files = [
  ...readdirSync(join(ROOT, "src")).map((f) => join(ROOT, "src", f)),
  join(ROOT, "verify.mjs"),
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
