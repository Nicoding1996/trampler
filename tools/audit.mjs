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

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { CFG } from "../src/config.js";

const ROOT = resolve(import.meta.dirname, "..");
const SRC = join(ROOT, "src");
const html = readFileSync(join(ROOT, "index.html"), "utf8");

const files = readdirSync(SRC).filter((f) => f.endsWith(".js"));
const sources = new Map(files.map((f) => [f, readFileSync(join(SRC, f), "utf8")]));
sources.set("verify.mjs", readFileSync(join(ROOT, "verify.mjs"), "utf8"));

let problems = 0;
const report = (label, detail) => {
  problems++;
  console.log(`  PROBLEM  ${label}${detail ? `  — ${detail}` : ""}`);
};

/** Strip comments and strings so matches come from real code only. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\.|[^`\\])*`/g, "``")
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
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
  const seen = new Map();
  for (const [file, src] of sources) {
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
  console.log(`  checked ${SIM.size} simulation modules`);
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
  console.log(`  checked ${SIM.size} simulation modules for Math.random`);
}

// ---------------------------------------------------------------------------
console.log("\n6. Nothing exported is left unused");
{
  const exported = new Map();
  for (const [file, src] of sources) {
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
    const file = key.split(":")[0];
    const others = [...sources.entries()].filter(([f]) => f !== file);
    const usedElsewhere = others.some(([, s]) => new RegExp(`\\b${name}\\b`).test(s));
    if (usedElsewhere) continue;

    // Distinguish genuinely dead code from an over-broad export. A helper used
    // only inside its own module is a needlessly public API, not a bug; something
    // referenced nowhere at all is code that was written and forgotten.
    const own = sources.get(file);
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
  const allCode = [...sources.entries()]
    .filter(([f]) => f !== "config.js")
    .map(([, s]) => s)
    .join("\n");
  const configSrc = sources.get("config.js");

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
      const leaf = key;
      const readSomewhere = new RegExp(`\\b${leaf}\\b`).test(allCode)
        || new RegExp(`\\b${leaf}\\b`).test(configSrc.split(/export function|export const/).slice(1).join("\n"));
      if (!readSomewhere) report(`CFG.${here} is never read`);
    }
  };
  walk(CFG, "");
  console.log("  walked the whole config tree");
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
    // Per-frame simulation calls, normalised to "object.method".
    const grab = (body, strip) => new Set(
      [...body.matchAll(/\b(\w+)\.(update|resolveStomps|handleInput|updateVisuals|endFrame)\(/g)]
        .map((m) => `${m[1].replace(strip, "")}.${m[2]}`),
    );

    // frame() calls two per-frame helpers, so their bodies are part of the frame.
    // Comparing frame() alone reported economy.update as harness-only, when in fact
    // the game reached it one level down -- which was still worth knowing, because
    // the two really had diverged over how the shared keys are routed.
    const helpers = ["toggles", "handlePurchasing"]
      .map((name) => main.match(new RegExp(`function ${name}\\(\\w*\\)\\s*\\{([\\s\\S]*?)\\n {2}\\}`)))
      .filter(Boolean)
      .map((m) => m[1])
      .join("\n");

    const inGame = grab(`${frame[1]}\n${helpers}`, /^$/);
    const inHarness = grab(stepFn[1], /^sim$/);
    // The harness deliberately omits the presentation layer and the run's own
    // update is opt-in behind sim.waves, which is handled inside step().
    const presentation = new Set([
      "viewmodel.update", "fx.update", "audio.update", "hud.update", "world.update",
      "shake.update", "post.update",
    ]);

    const missing = [...inGame].filter((c) => !inHarness.has(c) && !presentation.has(c));
    const extra = [...inHarness].filter((c) => !inGame.has(c));

    if (missing.length) {
      report("the harness does not drive", `${missing.join(", ")} — tests are not testing what ships`);
    }
    if (extra.length) {
      report("the harness drives something the game does not", extra.join(", "));
    }
    console.log(
      `  ${inHarness.size} simulation calls per frame, matched in both`
      + `${missing.length || extra.length ? " — MISMATCH" : ""}`,
    );
  }
}

console.log(
  problems === 0
    ? "\nAudit clean.\n"
    : `\n${problems} problem${problems === 1 ? "" : "s"} found.\n`,
);
if (problems > 0) process.exit(1);
