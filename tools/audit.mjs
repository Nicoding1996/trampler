// Static audit of the things neither `node --check` nor the harness can see.
//
//   node tools/audit.mjs
//
// Every check here corresponds to a failure mode this project has actually hit,
// or to a boundary it depends on:
//
//   A misspelled CFG path reads as `undefined`. `d < undefined` is always false,
//   which is how an enemy silently became harmless -- twice.
//
//   A misspelled element id returns null from getElementById and only throws
//   later, somewhere unrelated-looking.
//
//   A CSS class set from code with no matching rule is invisible and silent: the
//   state changes and nothing on screen does.
//
//   A static `three/addons/...` import in a simulation module puts a path in the
//   graph that only resolves through the dev server, which kills the harness on
//   load.
//
//   An unseeded Math.random makes the simulation unreproducible, which is fatal
//   for a harness that measures survival times.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CFG } from "../src/config.js";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

const files = readdirSync(SRC).filter((f) => f.endsWith(".js"));
const sources = new Map(files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));
sources.set("verify.mjs", readFileSync(join(ROOT, "verify.mjs"), "utf8"));

/**
 * EVERYTHING OUTSIDE src/ THAT IMPORTS FROM src/ — and why this is not simply folded
 * into `sources` above.
 *
 * The gap being closed: every check in this file scoped to src/ plus verify.mjs, so
 * worker/ and tools/ had no static validation of any kind. That has now cost something
 * twice. Once on a `CFG.ENEMY_TYPE` that does not exist, which check 1 would have caught
 * instantly and which worker/sim-check.js's own comment records as a wasted round trip.
 * And once far more expensively, when the Crew refactor changed three signatures and
 * worker/sim-check.js kept passing a Player — the spike that decides whether a Durable
 * Object can host the authoritative simulation, broken and silent, reporting its own
 * staleness as though workerd could not run the game.
 *
 * SEPARATE RATHER THAN MERGED, because the checks do not all apply out here and merging
 * would have opted these files into the two checks that are documented to produce false
 * results on files they were not designed for:
 *
 *   check 2 (element ids)   — nothing outside src/ touches the DOM, so there is nothing
 *                             to find, and the scraper works on RAW source including
 *                             comments.
 *   check 3 (CSS classes)   — same, and this is the check that once produced 137 false
 *                             problems from a single comment containing a backtick.
 *                             Widening its input for no possible gain is how that
 *                             happens again.
 *
 * So each check opts in deliberately below, and says what it is claiming. A checker
 * built on pattern matching over source text has to have its matching justified, not
 * just its verdict read.
 */
const outside = new Map();
for (const [dir, ext] of [["worker", ".js"], ["tools", ".mjs"]]) {
  for (const f of readdirSync(join(ROOT, dir)).filter((n) => n.endsWith(ext))) {
    outside.set(`${dir}/${f}`, readFileSync(join(ROOT, dir, f), "utf8"));
  }
}

/**
 * Server-side simulation code: outside src/, but running the real modules.
 *
 * The headless boundary and the seeded-randomness rule both apply here, and arguably
 * harder than in src/ — workerd has no DOM at all, so a `document` touch is a load
 * failure rather than a degraded material, and unseeded randomness on an AUTHORITATIVE
 * server desyncs every client at once rather than making one harness run unreproducible.
 *
 * tools/ is deliberately excluded: those are dev scripts in Node, where `Math.random`
 * in a probe is nobody's problem and there is no DOM to protect.
 */
const SERVER = new Set([...outside.keys()].filter((f) => f.startsWith("worker/")));

let problems = 0;
const report = (label, detail) => {
  problems++;
  console.log(`  PROBLEM  ${label}${detail ? `  — ${detail}` : ""}`);
};

/**
 * Strip comments and string LITERALS so matches come from real code only.
 *
 * One pass rather than five independent regexes, and both changes were forced by
 * defects rather than chosen for elegance.
 *
 * THE ORDERING BUG. The old version stripped line comments BEFORE template literals,
 * so a template containing `//` -- a protocol separator -- was read as the start of a
 * comment. The rest of that line was deleted, the now-unmatched backtick paired with
 * a later one, and everything between them was swallowed. Five CFG references in
 * net.js disappeared and check 1 reported a clean pass over a file it had partly
 * stopped reading. The `[^:]` guard in front of `//` only ever covered the `://`
 * spelling, which is why this survived so long: the one template in the codebase that
 * hit it was `"https:" ? ... }://` and the colon saved it by accident.
 *
 * SUBSTITUTIONS ARE CODE AND ARE NOW KEPT. The old version replaced whole templates,
 * so `${CFG.render.exposureStep}` in main.js and four others like it were never
 * validated by check 1 at all. Worse for check 5: a `Math.random()` inside a
 * substitution would have been invisible, which is exactly how unseeded randomness
 * hid from a search the first time -- `tech.md` has that under "Grep includePattern".
 * A check that silently reads less than it claims is the worst kind here.
 *
 * KNOWN LIMITATION, unchanged: regex literals are not recognised, so a regex holding
 * an odd number of quote characters would mis-tokenize from there on. Nothing in src/
 * does -- the only two are in net.js and neither contains one -- and telling `/` as
 * division from `/` as a regex needs real parsing rather than a scanner.
 */
/*
 * `keepStrings` emits string literals intact instead of collapsing them to `""`.
 *
 * Added for check 11, which is the one check whose subject IS the string contents — a
 * protocol message type is a string literal and nothing else. Every other check wants
 * literals gone, because a CFG path or a class name quoted in prose is exactly the false
 * positive this function exists to prevent, so the flag defaults to off and all ten
 * earlier callers are byte-for-byte unaffected.
 *
 * A second scanner was the alternative and was rejected: this file's own comment argues
 * for one pass over five regexes, and the ordering bug recorded above — a template
 * containing `//` read as a comment, silently deleting five CFG references — is precisely
 * what a hand-rolled second stripper would reintroduce.
 */
function code(src, keepStrings = false) {
  let out = "";
  let i = 0;
  // One entry per template literal we are inside. The value is the brace depth within
  // its current `${...}`, or -1 when we are in the template's literal TEXT.
  const stack = [];
  const inText = () => stack.length > 0 && stack[stack.length - 1] === -1;

  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];

    if (inText()) {
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { stack.pop(); out += "``"; i++; continue; }
      if (c === "$" && d === "{") { stack[stack.length - 1] = 0; out += " "; i += 2; continue; }
      // Newlines are kept so the output still lines up with the source.
      if (c === "\n") out += "\n";
      i++;
      continue;
    }

    if (c === "/" && d === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      out += " ";
      continue;
    }
    if (c === "/" && d === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'") {
      const from = i;
      i++;
      while (i < src.length) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === c) { i++; break; }
        i++;
      }
      out += keepStrings ? src.slice(from, i) : c + c;
      continue;
    }
    if (c === "`") { stack.push(-1); i++; continue; }

    // Brace tracking, so a substitution containing an object literal or an arrow
    // function body does not end at the wrong `}`.
    if (stack.length > 0) {
      if (c === "{") {
        stack[stack.length - 1]++;
      } else if (c === "}") {
        if (stack[stack.length - 1] === 0) {
          stack[stack.length - 1] = -1;
          out += " ";
          i++;
          continue;
        }
        stack[stack.length - 1]--;
      }
    }

    out += c;
    i++;
  }
  return out;
}

/**
 * Simulation modules: whatever the harness reaches, transitively, from
 * verify.mjs. These may not statically import an addon and may not touch the DOM.
 *
 * DERIVED rather than listed, because a hand-maintained list is wrong the moment
 * an import changes. The first version of this audit hardcoded it, included
 * input.js — which the harness does not import at all, since it supplies its own
 * duck-typed input — and reported a DOM violation against a browser-only module.
 */
const SIM = (() => {
  const seen = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = sources.get(file);
    if (!src) return;
    for (const m of src.matchAll(/from\s+["']\.\/(?:src\/)?([\w.-]+\.js)["']/g)) walk(m[1]);
    for (const m of src.matchAll(/from\s+["']\.\/src\/([\w.-]+\.js)["']/g)) walk(m[1]);
  };
  walk("verify.mjs");
  seen.delete("verify.mjs");
  return seen;
})();

// ---------------------------------------------------------------------------
console.log("\n1. Every CFG path referenced in code actually exists");
{
  // Longest-first member chains off CFG. Trailing call/computed access is dropped,
  // because CFG.economy.keys[i] only needs `keys` to exist.
  //
  // SCANS OUTSIDE src/ TOO. This is the check whose absence out there was recorded as a
  // known gap in worker/sim-check.js — "note it would NOT have been caught by
  // `npm run audit`, whose CFG-path check scopes to src/ and never looks at worker/".
  // A CFG typo in the Durable Object is the same silent `undefined` it is anywhere
  // else, except that the code reading it is the authority for four clients.
  const seen = new Map();
  for (const [file, src] of [...sources, ...outside]) {
    for (const m of code(src).matchAll(/\bCFG((?:\.[A-Za-z_$][\w$]*)+)/g)) {
      const path = m[1].slice(1).split(".");
      const key = path.join(".");
      if (!seen.has(key)) seen.set(key, new Set());
      seen.get(key).add(file);
    }
  }

  let checked = 0;
  for (const [path, where] of [...seen].sort()) {
    let node = CFG;
    let ok = true;
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      if (node === null || node === undefined || typeof node !== "object") {
        // Reached a leaf earlier than the path implies -- e.g. a method call on a
        // number. Only a problem if the remaining segment is not a JS builtin.
        ok = /^(toFixed|toString|length|map|filter|find|some|every|slice|join|includes|reduce|indexOf|findIndex|sort|at|concat|forEach|keys|values|entries|push|repeat|replace|split|padStart|padEnd|trim|toUpperCase|toLowerCase)$/
          .test(parts[i]);
        break;
      }
      if (!(parts[i] in node)) {
        ok = false;
        break;
      }
      node = node[parts[i]];
    }
    checked++;
    if (!ok) report(`CFG.${path}`, `read in ${[...where].join(", ")}`);
  }
  console.log(`  checked ${checked} distinct CFG paths`);
}

// ---------------------------------------------------------------------------
console.log("\n2. Every element id reached for from any module exists in the markup");
{
  // src/ and verify.mjs only, deliberately — see the note on `outside`. Nothing in
  // worker/ or tools/ touches the DOM, so widening this finds nothing and only exposes
  // more raw source to a scraper that reads comments.
  //
  // Raw source, NOT the comment/string-stripped version: the thing being
  // extracted here IS a string literal. Running this against code() found zero
  // ids and reported a clean pass, which is the exact shape of a vacuous check.
  const ids = new Map();
  for (const [file, src] of sources) {
    for (const m of src.matchAll(/getElementById\(\s*"([^"]+)"\s*\)/g)) {
      if (!ids.has(m[1])) ids.set(m[1], new Set());
      ids.get(m[1]).add(file);
    }
    // The local `id()` helper hud.js routes its readouts through.
    for (const m of src.matchAll(/(?<![\w.])id\(\s*"([^"]+)"\s*\)/g)) {
      if (!ids.has(m[1])) ids.set(m[1], new Set());
      ids.get(m[1]).add(file);
    }
    // querySelector / querySelectorAll with an id or a descendant selector.
    for (const m of src.matchAll(/querySelector(?:All)?\(\s*"#([\w-]+)/g)) {
      if (!ids.has(m[1])) ids.set(m[1], new Set());
      ids.get(m[1]).add(file);
    }
  }

  for (const [id, where] of ids) {
    if (!html.includes(`id="${id}"`)) report(`missing id="${id}"`, [...where].join(", "));
  }
  console.log(`  checked ${ids.size} element ids`);
}

// ---------------------------------------------------------------------------
console.log("\n3. Every CSS class assigned from code has a rule behind it");
{
  // Classes are written either as a whole className string or via classList.
  const assigned = new Map();
  // Only accept things that are actually valid class names. Without this, regex
  // literals elsewhere in the source get scraped as "class names" like `panel([^`
  // and the check dies building a RegExp out of them.
  const VALID = /^[a-zA-Z][\w-]*$/;
  const add = (name, file) => {
    if (!VALID.test(name ?? "")) return;
    if (!assigned.has(name)) assigned.set(name, new Set());
    assigned.get(name).add(file);
  };

  for (const [file, src] of sources) {
    // cls(el, "panel show"), className = "pip hurt", classList.add("show")
    for (const m of src.matchAll(/classList\.(?:add|remove|toggle)\(\s*"([^"]+)"/g)) {
      add(m[1], file);
    }
    for (const m of src.matchAll(/(?:cls\([^,]+,\s*|className\s*=\s*)"([^"]*)"/g)) {
      for (const part of m[1].split(/\s+/)) add(part, file);
    }
    // Template-literal class lists, e.g. `show ${state}` or `item ${state}`.
    for (const m of src.matchAll(/(?:cls\([^,]+,\s*|className\s*=\s*)`([^`]*)`/g)) {
      for (const part of m[1].split(/\s+/)) {
        if (!part.includes("${")) add(part, file);
      }
    }
    // Classes baked into innerHTML strings.
    for (const m of src.matchAll(/class="([^"$]*)"/g)) {
      for (const part of m[1].split(/\s+/)) add(part, file);
    }
  }

  for (const [name, where] of assigned) {
    // A rule can be `.name`, `#id.name`, `.other.name`, or the class can appear on
    // an element in the markup that a descendant selector then targets.
    const rule = new RegExp(`\\.${name}(?![\\w-])`);
    const inMarkup = new RegExp(`class="[^"]*\\b${name}\\b`);
    if (!rule.test(html) && !inMarkup.test(html)) {
      report(`class "${name}" has no CSS rule`, [...where].join(", "));
    }
  }
  console.log(`  checked ${assigned.size} class names`);
}

// ---------------------------------------------------------------------------
console.log("\n4. The headless boundary holds");
{
  for (const [file, src] of sources) {
    if (!SIM.has(file)) continue;
    const c = code(src);

    // Static addon imports are the fatal case; a dynamic one behind the headless
    // guard is fine and is how look.js loads the HDRI reader.
    if (/(?:^|\s)import[^(][^;]*?from\s+["']three\/addons/.test(src)) {
      report(`${file} statically imports a three addon`, "the harness cannot resolve it");
    }
    // DOM access outside a typeof guard.
    for (const m of c.matchAll(/\b(document|window|navigator|localStorage)\b/g)) {
      const guarded = /typeof\s+(document|window)\s*[=!]==?\s*["']undefined["']/.test(src);
      if (!guarded) {
        report(`${file} touches ${m[1]} without a typeof guard`);
        break;
      }
    }
  }

  // AND THE SAME BOUNDARY FOR SERVER-SIDE CODE, which is a stricter case.
  //
  // The harness degrades: look.js checks for `document` once and falls back to flat
  // materials, so a DOM touch in src/ is a visual downgrade at worst. workerd has no
  // DOM at all and no shim for one, so the same line there is a load failure — the
  // module throws at import time, before any of the spike's own reporting runs, and the
  // result reads as "the simulation cannot run in a Worker".
  //
  // That is precisely the misdiagnosis this whole slice exists to prevent, so it is
  // worth catching statically rather than at the far end of a deploy.
  for (const [file, src] of outside) {
    if (!SERVER.has(file)) continue;
    const c = code(src);
    if (/(?:^|\s)import[^(][^;]*?from\s+["']three\/addons/.test(src)) {
      report(`${file} statically imports a three addon`, "workerd cannot resolve it");
    }
    for (const m of c.matchAll(/\b(document|window|localStorage)\b/g)) {
      const guarded = /typeof\s+(document|window)\s*[=!]==?\s*["']undefined["']/.test(src);
      if (!guarded) {
        report(`${file} touches ${m[1]}`, "workerd has no DOM, so this throws on import");
        break;
      }
    }
    // `navigator` is deliberately absent from the list above. Workers DO expose a
    // navigator (navigator.userAgent), so flagging it here would be a false problem —
    // the same over-broad matching that check 3 has been burned by. Only the globals
    // that genuinely do not exist server-side are worth asserting.
  }
  console.log(
    `  checked ${SIM.size} simulation modules, and ${SERVER.size} server-side modules`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n5. No unseeded randomness in any simulation module");
{
  for (const [file, src] of sources) {
    if (!SIM.has(file)) continue;
    if (/Math\.random/.test(code(src))) {
      report(`${file} uses Math.random`, "invariant 21: draw from a seeded stream");
    }
  }

  // Server-side too, and the stakes are higher rather than equal. In src/ an unseeded
  // draw makes one harness run unreproducible. On an authoritative server it desyncs
  // every connected client at once, and it does so invisibly — each client's prediction
  // is corrected toward a world that rolled differently, which presents as rubber-banding
  // rather than as a determinism bug.
  //
  // `crypto.getRandomValues` is untouched by this and should be: minting a join code is
  // not simulation, and it wants real entropy precisely because it must not be
  // predictable.
  for (const [file, src] of outside) {
    if (!SERVER.has(file)) continue;
    if (/Math\.random/.test(code(src))) {
      report(
        `${file} uses Math.random`,
        "invariant 21 on the authoritative server: every client diverges at once",
      );
    }
  }
  console.log(
    `  checked ${SIM.size} simulation modules and ${SERVER.size} server-side modules`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n6. Nothing exported is left unused");
{
  // WRANGLER CONFIG COUNTS AS A CONSUMER, and without this the extension below
  // produces a confident false problem.
  //
  // NOTE THE INHERENT WEAKNESS OF THIS CHECK, since it now reads more files. "Used"
  // means the bare name appears anywhere in any scanned source, INCLUDING COMMENTS.
  // Demonstrated by accident while verifying the extension: a throwaway module
  // exporting `probe` was not reported, because prose elsewhere in this very file
  // contained the word. Pre-existing rather than introduced, and the practical risk is
  // low because export names are rarely ordinary English -- but it is the same family
  // as check 3's comment sensitivity, and it means a suspiciously silent check 6 is
  // worth testing with a deliberately odd name rather than a plausible one.
  //
  // `export class Lobby` in worker/index.js is referenced from nowhere in JavaScript:
  // the runtime instantiates it because wrangler.jsonc names it in `class_name`, and
  // the code reaches it through the `LOBBY` binding, which is a different string. So
  // the honest set of consumers includes the deployment config, exactly as check 2's
  // set of consumers includes the markup.
  //
  // A false problem here would be worse than the gap it closes: this is the check that
  // finds code written and forgotten, and one standing false report is how a whole
  // check stops being read.
  const wranglerConfigs = readdirSync(ROOT)
    .filter((f) => /^wrangler.*\.jsonc?$/.test(f))
    .map((f) => readFileSync(join(ROOT, f), "utf8"))
    .join("\n");

  const exported = new Map();
  // worker/ is included; tools/ is not. A tool is an entry point by definition — it is
  // run by name from package.json or from a terminal — so "nothing imports it" is its
  // normal state and not a finding.
  const scanned = new Map([...sources, ...[...outside].filter(([f]) => f.startsWith("worker/"))]);
  for (const [file, src] of scanned) {
    if (file === "verify.mjs") continue;
    for (const m of src.matchAll(
      /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm,
    )) {
      exported.set(`${file}:${m[1]}`, m[1]);
    }
    for (const m of src.matchAll(/^export\s*\{([^}]+)\}/gm)) {
      for (const part of m[1].split(",")) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) exported.set(`${file}:${name}`, name);
      }
    }
  }

  for (const [key, name] of exported) {
    // `worker/index.js:Lobby` splits on the LAST colon, not the first. Keys outside src/
    // carry a directory prefix, so `key.split(":")[0]` returned "worker/index.js" only by
    // luck of there being no colon in the path — it would have silently mis-attributed
    // any key it did contain one in.
    const file = key.slice(0, key.lastIndexOf(":"));
    const others = [...scanned.entries(), ...outside.entries()].filter(([f]) => f !== file);
    const usedElsewhere = others.some(([, s]) => new RegExp(`\\b${name}\\b`).test(s))
      || new RegExp(`\\b${name}\\b`).test(wranglerConfigs);
    if (usedElsewhere) continue;

    // Distinguish genuinely dead code from an over-broad export. A helper used
    // only inside its own module is a needlessly public API, not a bug; something
    // referenced nowhere at all is code that was written and forgotten.
    const own = scanned.get(file);
    const uses = [...own.matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
    if (uses <= 1) report(`${file} exports ${name} and nothing anywhere uses it`);
    else console.log(`  note: ${file} exports ${name}, used only inside ${file}`);
  }
  console.log(`  checked ${exported.size} exports`);
}

// ---------------------------------------------------------------------------
console.log("\n7. Config knobs that nothing reads");
{
  // A tunable nobody reads is either dead weight or a wiring bug -- a number was
  // added with the intention of using it and the use never landed.
  // INCLUDES worker/, EXCLUDES tools/, and the asymmetry is deliberate.
  //
  // Every addition here makes this check WEAKER, because "read" is a bare name match
  // across the whole corpus: more text means more chances that an unread knob's leaf name
  // appears incidentally and passes. So an addition has to earn it.
  //
  // worker/ earns it. Server code legitimately reads config, and once the Durable Object
  // runs the simulation it will read knobs `src/` may not — at which point excluding it
  // produces false problems telling someone to delete a number the authority depends on.
  //
  // tools/ does not. A probe referencing a knob is not the game reading it, and
  // `npm run sim`'s own variable names would have counted as the game reading one. The
  // first version of this extension included tools/ anyway and was reverted.
  //
  // A NOTE ON HOW THAT REVERT WAS JUSTIFIED, because the first attempt at justifying it
  // was worthless. The stated reason was "the check was clean before and after, so nothing
  // was rescued" — measured at a moment when this check was VACUOUS, as the comment below
  // now records at length. A clean result from a check that cannot fail is not evidence of
  // anything, and citing it was the same mistake as reading a verdict without verifying
  // the matching. The narrowing happens to be right, and it is right because the check
  // passes now that it genuinely works, with the config literal excluded from the corpus.
  const allCode = [...sources.entries(), ...[...outside].filter(([f]) => f.startsWith("worker/"))]
    .filter(([f]) => f !== "config.js")
    .map(([, s]) => s)
    .join("\n");
  const configSrc = sources.get("config.js");

  // config.js's OWN HELPERS count as readers: enemyCfg(), enemyType() and
  // applyReleasePreset() all legitimately read knobs, and excluding them would report
  // every enemy field as dead. But the CFG LITERAL ITSELF must not count, or a leaf
  // matches the line declaring it and the check passes unconditionally.
  //
  // THAT IS EXACTLY WHAT IT DID, for as long as this check has existed. The old form
  // was `configSrc.split(/export function|export const/).slice(1)`, and
  // `export const CFG = {` is the FIRST `export const` in the file -- so the whole
  // config literal was in the corpus, every leaf matched its own declaration, and the
  // report below was unreachable code. It printed "walked the whole config tree" and
  // could not fail. Found by planting a knob nothing reads and watching it pass.
  //
  // Two lessons, and the second is the one worth keeping. A keyword split is a bad way
  // to find a boundary when the keyword occurs inside the region being bounded. And a
  // check that can quietly become vacuous needs to notice: hence the located bounds
  // below reporting staleness if they fail, and hence printing the two counts rather
  // than the word "clean". `structure.md` and `tech.md` both already say a checker's
  // MATCHING has to be verified and not just its verdict read -- this was that, in the
  // one place nobody had pointed it at.
  const cfgStart = configSrc.indexOf("export const CFG = {");
  const cfgEnd = cfgStart < 0 ? -1 : configSrc.indexOf("\n};", cfgStart);
  let helpers = "";
  if (cfgStart < 0 || cfgEnd < 0) {
    report(
      "could not locate config.js's CFG literal",
      "check 7 cannot tell a helper from the config data, so it is checking nothing",
    );
  } else {
    helpers = configSrc.slice(0, cfgStart) + configSrc.slice(cfgEnd);
  }

  let leaves = 0;
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      const here = path ? `${path}.${key}` : key;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        // Enemy type objects are read generically through enemyCfg(), so their
        // fields are looked up by name rather than by path.
        const generic = /^enemies\.(chewer|climber|bulwark|burrower|sapper|titan)$/.test(here);
        if (!generic) walk(value, here);
        continue;
      }
      leaves++;
      // Still a bare name match, which is the documented weakness of this check and is
      // unchanged: a leaf whose name appears incidentally anywhere passes. What changed
      // is that the config's own data no longer counts as one of those places.
      const word = new RegExp(`\\b${key}\\b`);
      if (!word.test(allCode) && !word.test(helpers)) report(`CFG.${here} is never read`);
    }
  };
  walk(CFG, "");
  // BOTH counts are printed on purpose. The leaf count is the "confirm the count moved"
  // discipline this project learned from check 3. The helper-line count is what makes
  // the vacuity above visible: config.js is ~2100 lines and the literal is nearly all of
  // it, so a three-figure number here means the literal really was cut out. If this ever
  // prints four figures, the corpus has swallowed the data again and the check is dead.
  console.log(
    `  walked the whole config tree — ${leaves} leaves, against`
    + ` ${helpers.split("\n").length} lines of helper code in config.js`,
  );
}

// ---------------------------------------------------------------------------
console.log("\n8. The frame context provides everything its readers destructure");
{
  // fx, viewmodel, audio and hud are pure readers handed one `ctx` bag by main.js.
  // A reader that starts destructuring a new field is a silent `undefined` at
  // runtime, and for something like `guns` that means a TypeError mid-frame.
  const main = sources.get("main.js");

  const provided = new Set();
  const literal = main.match(/const ctx = \{([\s\S]*?)\n {2}\};/);
  if (!literal) {
    report("could not find main.js's ctx literal", "this check has gone stale");
  } else {
    for (const part of literal[1].split(/[,\n]/)) {
      const name = part.trim().split(":")[0].trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) provided.add(name);
    }
  }
  // Fields assigned later in the loop, e.g. ctx.gun = activeGun().
  for (const m of main.matchAll(/\bctx\.([A-Za-z_$][\w$]*)\s*=/g)) provided.add(m[1]);

  let checkedReaders = 0;
  for (const file of ["fx.js", "viewmodel.js", "audio.js", "hud.js"]) {
    const src = sources.get(file);
    if (!src) continue;
    for (const m of src.matchAll(/const\s*\{([^}]+)\}\s*=\s*ctx\s*;/g)) {
      checkedReaders++;
      for (const part of m[1].split(",")) {
        const raw = part.trim();
        if (!raw) continue;
        const name = raw.split(/[=:]/)[0].trim();
        if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
        const optional = raw.includes("=");
        if (!provided.has(name)) {
          if (optional) console.log(`  note: ${file} reads optional ctx.${name}, not provided`);
          else report(`${file} destructures ctx.${name}, main.js does not provide it`);
        }
      }
    }
  }
  console.log(`  ctx provides ${provided.size} fields to ${checkedReaders} readers`);
}

// ---------------------------------------------------------------------------
console.log("\n9. The harness's frame order matches the game's");
{
  // If main.js gains a per-frame call and verify.mjs's step() does not, the tests
  // stop testing the thing that ships -- quietly, and in the most expensive
  // possible way, because everything still passes.
  const main = sources.get("main.js");
  const verify = sources.get("verify.mjs");

  const frame = main.match(/function frame\(now\)\s*\{([\s\S]*?)\n {2}\}/);
  const stepFn = verify.match(/function step\(sim, frames, hook, dt = DT\)\s*\{([\s\S]*?)\n\}/);

  if (!frame || !stepFn) {
    report("could not isolate the frame loop or step()", "this check has gone stale");
  } else {
    // Per-frame simulation calls, normalised to "object.method". Repair's admission and
    // work phases are named separately because trigger ownership must precede Weapon while
    // contested progress retains its post-gun timing; omitting either would make this check
    // falsely green on the exact order it exists to protect.
    const grab = (body, strip) => new Set(
      [...body.matchAll(/\b(\w+)\.(update|resolveStomps|handleInput|updateVisuals|endFrame|admit|work)\(/g)]
        .map((m) => `${m[1].replace(strip, "")}.${m[2]}`),
    );

    // frame() calls per-frame helpers, so their bodies are part of the frame.
    // Comparing frame() alone reported economy.update as harness-only, when in fact
    // the game reached it one level down -- which was still worth knowing, because
    // the two really had diverged over how the shared keys are routed.
    //
    // `simStep` is where the simulation itself moved when the loop went to a fixed
    // timestep, and it is the direct counterpart of verify.mjs's step(). Without it
    // here this check reports every simulation call as harness-only, which is loud
    // and correct: the calls really did leave frame()'s body.
    const helpers = ["toggles", "handlePurchasing", "simStep"]
      .map((name) => main.match(new RegExp(`function ${name}\\(\\w*\\)\\s*\\{([\\s\\S]*?)\\n {2}\\}`)))
      .filter(Boolean)
      .map((m) => m[1])
      .join("\n");

    const inGame = grab(`${frame[1]}\n${helpers}`, /^$/);
    const inHarness = grab(stepFn[1], /^sim$/);
    // The harness deliberately omits the presentation layer and the run's own
    // update is opt-in behind sim.waves, which is handled inside step().
    //
    // THE TEST FOR ADDING SOMETHING HERE, because this list is the one way to
    // silence this check and it must not become the easy way out: an entry qualifies
    // only if its module is imported by main.js and by nothing the harness reaches --
    // i.e. it is browser-only by construction, so there is no version of the harness
    // that COULD drive it. `net.update` qualifies on exactly that basis, the same as
    // fx and viewmodel. Anything the harness could import belongs in step(), not here.
    //
    // Not derived, and the reason is worth recording rather than hiding: the obvious
    // derivation is "the module is not in SIM", but three of these do not map a call
    // prefix to a module that way -- `world.update` is a browser-only method on a
    // module the harness DOES construct, and `shake` and `post` both live in
    // render.js. Making this derived means resolving main.js's local names back
    // through its imports, which is a separate change with its own reasoning.
    const presentation = new Set([
      "viewmodel.update", "fx.update", "audio.update", "hud.update", "world.update",
      "shake.update", "post.update", "net.update",
      // Raycasts from the camera to place the aim ring. It qualifies because the
      // harness has no rendered frame to be current with, and because the simulation
      // half of the winch is now `grapple.update`, which IS driven in both.
      "grapple.updateVisuals",
    ]);

    const missing = [...inGame].filter((c) => !inHarness.has(c) && !presentation.has(c));
    const extra = [...inHarness].filter((c) => !inGame.has(c));

    if (missing.length) {
      report("the harness does not drive", `${missing.join(", ")} — tests are not testing what ships`);
    }
    if (extra.length) {
      report("the harness drives something the game does not", extra.join(", "));
    }

    // ---- AND THE SERVER'S ORDER, WHICH IS NOW A THIRD COPY -------------------
    //
    // `src/session.js`'s stepSession() is what the Durable Object runs. It is the same
    // simulation in the same order as main.js's simStep and verify.mjs's step(), and
    // nothing was comparing it to either — which is precisely the position
    // worker/sim-check.js was in when the Crew refactor broke it silently.
    //
    // The stakes are higher for this copy than for the harness's. A harness that drifts
    // stops testing what ships; a SERVER that drifts runs a different game from the one
    // every client is predicting, and the symptom is not a failed test but every player
    // rubber-banding for reasons no test reproduces.
    //
    // Compared against the harness rather than against main.js, deliberately: the harness
    // is already asserted equal to the game above, and it shares the server's shape — no
    // camera, no renderer, no presentation layer. Comparing to main.js would report the
    // whole presentation set as missing and need a second exemption list saying the same
    // thing twice.
    const session = sources.get("session.js");
    if (!session) {
      report("session.js is missing", "the server has no step order to check");
    } else {
      const stepSession = session.match(/export function stepSession\([^)]*\)\s*\{([\s\S]*?)\n\}/);
      if (!stepSession) {
        report("could not isolate stepSession()", "this check has gone stale");
      } else {
        const inServer = grab(stepSession[1], /^sim$/);
        // The harness drives the winch's visual half and its own input stub bookkeeping
        // through the same names; both are present in the server too, so nothing needs
        // exempting today. If that changes, the test for adding an entry here is the same
        // one the presentation list carries: it qualifies only if there is no version of
        // the server that COULD drive it.
        const serverMissing = [...inHarness].filter((c) => !inServer.has(c));
        const serverExtra = [...inServer].filter((c) => !inHarness.has(c));
        if (serverMissing.length) {
          report(
            "the SERVER does not drive",
            `${serverMissing.join(", ")} — the authority runs a different game from the tests`,
          );
        }
        if (serverExtra.length) {
          report(
            "the SERVER drives something the harness does not",
            `${serverExtra.join(", ")} — untested behaviour on the authority`,
          );
        }
        console.log(
          `  ${inServer.size} of them on the server too`
          + `${serverMissing.length || serverExtra.length ? " — MISMATCH" : ""}`,
        );
      }
    }

    // Membership alone cannot protect an ordering rule: a Set still contains all five
    // calls if admission slips below Weapon, or if work moves above the station gun. Check
    // the repair/hands subsequence explicitly in every frame loop that executes it. This is
    // intentionally a semantic sequence rather than "all calls match": authority and client
    // prediction each omit different server-owned work, while these five slots must agree.
    const repairHandsOrder = [
      "player.update",
      "repair.admit",
      "weapon.update",
      "g.update",
      "repair.work",
    ];
    const orderedLoops = [
      [
        "browser simStep()",
        main.match(/function simStep\(dt\)\s*\{([\s\S]*?)\n {2}\}/),
        /^$/,
      ],
      [
        "harness step()",
        verify.match(/function step\(sim, frames, hook, dt = DT\)\s*\{([\s\S]*?)\n\}/),
        /^sim$/,
      ],
      [
        "authority stepSession()",
        session?.match(/export function stepSession\([^)]*\)\s*\{([\s\S]*?)\n\}/),
        /^sim$/,
      ],
      [
        "client stepSessionClient()",
        session?.match(/export function stepSessionClient\([^)]*\)\s*\{([\s\S]*?)\n\}/),
        /^sim$/,
      ],
    ];
    let orderedMatches = 0;
    for (const [label, match, strip] of orderedLoops) {
      if (!match) {
        report(`could not isolate ${label}`, "the repair/hands order check has gone stale");
        continue;
      }
      // Strip comments and literals first: a prose mention of repair.admit() must not be
      // capable of satisfying the check that protects the executable call's position.
      const calls = [...code(match[1]).matchAll(
        /\b(\w+)\.(update|resolveStomps|handleInput|updateVisuals|endFrame|admit|work)\(/g,
      )].map((m) => `${m[1].replace(strip, "")}.${m[2]}`);
      const actual = calls.filter((call) => repairHandsOrder.includes(call));
      const matches = actual.length === repairHandsOrder.length
        && actual.every((call, i) => call === repairHandsOrder[i]);
      if (!matches) {
        report(
          `${label} repair/hands order differs`,
          `expected ${repairHandsOrder.join(" -> ")}; found ${actual.join(" -> ") || "nothing"}`,
        );
      } else {
        orderedMatches++;
      }
    }
    console.log(`  repair/hands order matched in ${orderedMatches}/${orderedLoops.length} frame loops`);

    console.log(
      `  ${inHarness.size} simulation calls per frame, matched in both`
      + `${missing.length || extra.length ? " — MISMATCH" : ""}`,
    );

    // ---- and the simulation may only ever be stepped by the FIXED step.
    //
    // The accumulator lives in main.js, which the harness cannot import, so this
    // rule has no test and never will have one. It is also exactly the rule someone
    // breaks while fixing something else: the obvious cure for judder on a
    // high-refresh display is to hand simStep the real frame time, and that silently
    // restores the variable timestep the whole change existed to remove. Nothing
    // would fail. Two clients would just quietly disagree about the last second.
    // The lookbehind excludes the DECLARATION, `function simStep(dt)`. Without it
    // this check reported its own parameter name as a violation and was completely
    // confident about it -- the same failure as the panel-overlap check reading
    // `top: 8%` as centred. A check that derives facts from source text needs its
    // derivation verified against the real thing.
    const stepArgs = [...code(main).matchAll(/(?<!function )\bsimStep\(([^)]*)\)/g)]
      .map((m) => m[1].trim());
    if (stepArgs.length === 0) {
      report("no simStep call found in main.js", "this check has gone stale");
    } else {
      const wrong = stepArgs.filter((a) => a !== "STEP");
      if (wrong.length) {
        report(
          "the simulation is stepped by something other than the fixed step",
          `simStep(${wrong.join("), simStep(")}) — a measured dt here is a variable timestep`,
        );
      }
      // And STEP has to actually come from the config knob, not be a literal that
      // happens to match it today.
      if (!/\bconst STEP\s*=\s*1\s*\/\s*CFG\.loop\.stepHz\b/.test(code(main))) {
        report("STEP is not derived from CFG.loop.stepHz", "a literal here can drift from the harness");
      }
      console.log(`  simStep is called ${stepArgs.length}x, always with STEP`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n10. The wrangler configs agree with the Worker's actual exports");
{
  // NOTHING IS DEPLOYED YET, which is exactly why this is worth asserting now.
  //
  // Three things have to line up between a JSON file and a JS file, and none of them is
  // checked by anything: `main` has to point at a file that exists, every `class_name`
  // in a Durable Object binding has to name a class the entry point actually exports,
  // and the migration's class list has to match those bindings. Get any of them wrong
  // and the failure is at deploy time or, worse, at runtime on a binding that resolves
  // to nothing.
  //
  // The migration clause matters most for the pair of configs. wrangler.dev.jsonc's own
  // comment says it: "Must match wrangler.jsonc's migration, or the local DO is a
  // different class from the deployed one and a bug reproduces in exactly one of the two
  // places." That is a rule stated in a comment and defended by nothing, which is the
  // shape this project has already been caught by — a number defended only by a comment
  // is not defended.
  const configs = readdirSync(ROOT).filter((f) => /^wrangler.*\.jsonc?$/.test(f));
  if (configs.length === 0) report("no wrangler config found", "this check has gone stale");

  /**
   * Strip JSONC line comments, STRING-AWARE.
   *
   * The first version only dropped lines whose trimmed text began with `//`, which
   * handles every comment currently in these files and breaks on the first trailing one
   * somebody adds — `"main": "worker/index.js", // the entry point` would fail to parse
   * and this check would report "does not parse as JSONC" against a perfectly valid
   * config. A loud false problem rather than a silent one, but still a check crying wolf
   * about the wrong thing.
   *
   * Tracking quotes is what makes it safe to strip mid-line, and it is not optional: a
   * naive `//`-to-end-of-line would eat the second half of any URL in a string value.
   * That is the exact ordering bug `code()` above carries a long comment about, so
   * repeating it here would be repeating a fixed mistake.
   */
  const stripJsonc = (raw) => {
    let out = "";
    let inString = false;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (inString) {
        out += c;
        if (c === "\\") { out += raw[++i] ?? ""; continue; }
        if (c === '"') inString = false;
        continue;
      }
      if (c === '"') { inString = true; out += c; continue; }
      if (c === "/" && raw[i + 1] === "/") {
        while (i < raw.length && raw[i] !== "\n") i++;
        out += "\n";
        continue;
      }
      if (c === "/" && raw[i + 1] === "*") {
        i += 2;
        while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
        i += 1;
        continue;
      }
      out += c;
    }
    // Trailing commas are legal in JSONC and not in JSON, and wrangler's own docs use
    // them. Removed after comments, since a comment can sit between a comma and its
    // closing brace.
    return out.replace(/,(\s*[}\]])/g, "$1");
  };

  for (const name of configs) {
    const raw = readFileSync(join(ROOT, name), "utf8");

    let cfg;
    try {
      cfg = JSON.parse(stripJsonc(raw));
    } catch (err) {
      report(`${name} does not parse as JSONC`, err.message);
      continue;
    }

    const main = cfg.main;
    if (!main) {
      report(`${name} has no "main"`, "the Worker has no entry point");
      continue;
    }
    if (!existsSync(join(ROOT, main))) {
      report(`${name} main -> ${main}`, "that file does not exist");
      continue;
    }

    const entry = readFileSync(join(ROOT, main), "utf8");
    const bound = (cfg.durable_objects?.bindings ?? []).map((b) => b.class_name);

    for (const cls of bound) {
      // The export has to be a real named class export in the entry point. A DO class
      // reached through a re-export would need resolving properly; nothing does that
      // here, and a check that quietly accepted one would be worse than one that says
      // it cannot see it.
      if (!new RegExp(`export\\s+class\\s+${cls}\\b`).test(entry)) {
        report(
          `${name} binds class_name "${cls}"`,
          `${main} does not export a class by that name`,
        );
      }
    }

    // Every migrated class must be bound, and every bound class migrated. A class in
    // one list and not the other is a namespace that either cannot be created or is
    // created and unreachable.
    const migrated = (cfg.migrations ?? [])
      .flatMap((m) => [...(m.new_sqlite_classes ?? []), ...(m.new_classes ?? [])]);
    for (const cls of bound) {
      if (!migrated.includes(cls)) {
        report(`${name} binds "${cls}" with no migration`, "the namespace is never created");
      }
    }
    for (const cls of migrated) {
      if (!bound.includes(cls)) {
        report(`${name} migrates "${cls}" with no binding`, "nothing can reach it");
      }
    }
    console.log(`  ${name}: main ${main}, classes ${bound.join(", ") || "none"}`);
  }

  // AND THE TWO CONFIGS MUST DECLARE THE SAME CLASSES. This is the rule
  // wrangler.dev.jsonc's comment states and nothing enforced.
  const classesOf = (name) => {
    try {
      const cfg = JSON.parse(stripJsonc(readFileSync(join(ROOT, name), "utf8")));
      return (cfg.durable_objects?.bindings ?? []).map((b) => b.class_name).sort().join(",");
    } catch {
      return null;
    }
  };
  const dev = configs.find((f) => f.includes(".dev."));
  const prod = configs.find((f) => !f.includes(".dev."));
  if (dev && prod) {
    const a = classesOf(dev);
    const b = classesOf(prod);
    if (a !== null && b !== null && a !== b) {
      report(
        "the dev and production configs declare different Durable Object classes",
        `${dev} has [${a}], ${prod} has [${b}] — a bug would reproduce in only one`,
      );
    } else if (a !== null) {
      console.log(`  dev and production agree on [${a}]`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n11. Every protocol message is both sent and handled");
{
  /*
   * THE CHECK THAT WOULD HAVE CAUGHT FOUR SLICES OF NETCODE BEING UNREACHABLE.
   *
   * The Durable Object builds its authoritative world on one message, `{t:"start"}`, and
   * `src/net.js` never sent it. So the server stayed a lobby, sent no snapshots, and every
   * client ran its own complete simulation: two browser tabs, two separate games, which is
   * exactly the state before any of this was built. The hull sync, the shared director, the
   * horde codec, the input queue and the shot arbitration were all correct, all tested, and
   * none of them ran in a browser.
   *
   * Nothing caught it because `tools/smoke-lobby.mjs` sends `start` ITSELF in order to
   * exercise the server. Every live check passed against a working server and a client that
   * never asked it to do anything — the project's own recurring lesson, that a module can be
   * correct and simply uncalled, which is why `routePurchaseInput` was moved out of main.js
   * and why check 9 exists. This is the same lesson at the protocol layer.
   *
   * Writing it found TWO MORE of the same fault immediately, which is the argument for a
   * general check over a bespoke "is start wired" assertion:
   *
   *   `ping` — the server echoes it so the client can measure RTT against its own clock,
   *            since the server's clock is untrustworthy. Never sent, so there was no
   *            latency measurement at all, only a readout with nothing behind it.
   *   `name` — a rename path. The joining name arrives as a URL parameter, so this one is
   *            merely inert rather than load-bearing, and it is listed rather than fixed.
   *
   * BIDIRECTIONAL, because both directions fail silently and differently. An unsent message
   * is a feature that does nothing. An unhandled one is a client shouting into a socket that
   * drops it on the floor, which looks like packet loss and gets debugged as networking.
   *
   * SCOPING, and its honest limitation. Each side has exactly one `switch (msg.t)` and no
   * other switch statement at all, asserted below, so taking every `case "..."` label in the
   * file is exact rather than approximate. If a second string switch is ever added the check
   * reports a handler as unreachable when it is not — a loud false positive, which is the
   * right direction to fail in: the alternative designs all risked reading less than they
   * claimed, and `tech.md` records what that costs. Strings are kept here and comments are
   * not, so prose quoting a message name cannot register as a send.
   */
  const server = outside.get("worker/index.js") ?? "";
  const client = sources.get("net.js") ?? "";

  const switches = (src) => [...src.matchAll(/\bswitch\s*\(/g)].length;
  for (const [label, src] of [["worker/index.js", server], ["net.js", client]]) {
    const n = switches(code(src));
    if (n !== 1) {
      report(
        `${label} has ${n} switch statements, so check 11's case scraping is no longer exact`,
        "scope the labels to the `switch (msg.t)` block, or this check reports phantom faults",
      );
    }
  }

  const labels = (src) => new Set([...code(src, true).matchAll(/\bcase\s+"([\w-]+)"\s*:/g)].map((m) => m[1]));
  const sends = (src) => new Set([...code(src, true).matchAll(/\bt:\s*"([\w-]+)"/g)].map((m) => m[1]));

  const serverHandles = labels(server);
  const serverSends = sends(server);
  const clientHandles = labels(client);

  // The client's sends are gathered across ALL of src/, not just net.js. Nothing else emits
  // today, but a module reaching for the socket directly is a thing to catch rather than a
  // thing to assume away.
  const clientSends = new Set();
  for (const src of sources.values()) for (const t of sends(src)) clientSends.add(t);
  // net.js also holds the RECEIVE switch, whose labels are inbound names. Those are not
  // sends and must not be credited as such.
  for (const t of clientHandles) if (!sends(client).has(t)) clientSends.delete(t);

  /*
   * The binary channel is deliberately outside this check. Input packets carry no `t` field
   * at all — they are a typed array with a version byte, routed by `typeof ev.data !== "string"`
   * rather than by name — so there is no literal here to match. `verify.mjs` covers that
   * path directly through the codec, which is stronger than a text scrape.
   */
  const BINARY = new Set();

  const missing = [...serverHandles].filter((t) => !clientSends.has(t) && !BINARY.has(t));
  const dropped = [...clientSends].filter((t) => !serverHandles.has(t));
  const deadIn = [...clientHandles].filter((t) => !serverSends.has(t));
  const unheard = [...serverSends].filter((t) => !clientHandles.has(t));

  /*
   * KNOWN AND DELIBERATELY NOT WIRED — recorded here rather than fixed, because folding
   * three more protocol changes into the one that made `start` reachable would produce a
   * diff nobody can read, and `tech.md` is explicit about that.
   *
   * SELF-CLEANING, which is the part that stops this becoming a way to hide things. An
   * entry that is no longer a fault is itself reported below, so wiring one of these up
   * forces the entry out instead of leaving a stale exemption behind. A silencing list with
   * no expiry is how a false green survives, and this file has been bitten by that twice.
   */
  const KNOWN = new Map([
    ["ping", "the latency probe: the server echoes it so the client can time RTT on its own"
      + " clock, since the server's is frozen outside I/O. Never sent, so there is no latency"
      + " measurement at all — a readout with nothing behind it. Worth wiring, on its own."],
    ["pong", "the other half of `ping`. Unhandled only because nothing asks; the two are one"
      + " change and are deferred together."],
    ["name", "a RENAME path. The joining name arrives as a URL parameter, so this is inert"
      + " rather than load-bearing: you simply cannot change your name mid-session."],
    ["snap", "a JSON heartbeat sent ONLY while the world is still building, so a client can"
      + " tell a loading server from a dead one. Largely superseded by `sim`, which the client"
      + " does handle; its `waiting` and `error` fields are the part going unread."],
  ]);

  const faults = [
    ...missing.map((t) => [t, `the server handles "${t}" and no client ever sends it`,
      "unreachable from the browser — this is how `start` hid for four slices"]),
    ...dropped.map((t) => [t, `the client sends "${t}" and the server has no case for it`,
      "silently discarded"]),
    ...deadIn.map((t) => [t, `net.js handles "${t}" and the server never sends it`,
      "dead inbound branch"]),
    ...unheard.map((t) => [t, `the server sends "${t}" and net.js has no case for it`,
      "silently discarded"]),
  ];

  const seen = new Set();
  for (const [t, label, detail] of faults) {
    seen.add(t);
    if (KNOWN.has(t)) console.log(`  note: "${t}" — ${KNOWN.get(t)}`);
    else report(label, detail);
  }
  for (const [t, why] of KNOWN) {
    if (!seen.has(t)) {
      report(
        `"${t}" is listed as a known protocol gap but is now fully wired`,
        `delete the entry — a stale exemption silences the next real fault. It said: ${why}`,
      );
    }
  }

  const real = faults.filter(([t]) => !KNOWN.has(t)).length;
  if (real === 0) {
    console.log(
      `  ${serverHandles.size} inbound and ${serverSends.size} outbound message types;`
      + ` every one either wired or a recorded gap (${KNOWN.size})`,
    );
  }
}

console.log(
  problems === 0
    ? "\nAudit clean.\n"
    : `\n${problems} problem${problems === 1 ? "" : "s"} found.\n`,
);
if (problems > 0) process.exit(1);
