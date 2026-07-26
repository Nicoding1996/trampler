// Ask the dev server for every file the page actually needs, and report the
// status, content type and size of each.
//
//   npm start            (in one terminal)
//   node tools/smoke-serve.mjs
//
// This is the only automated check that touches the HTTP layer. The headless
// harness runs the simulation modules directly from disk and never goes through
// the server, so a wrong MIME type, a path the server refuses, or an asset that
// was never fetched all present identically in a browser: a blank canvas.

const BASE = process.env.BASE ?? "http://127.0.0.1:5173";

const paths = [
  "/",
  "/src/main.js",
  "/src/look.js",
  "/src/render.js",
  "/src/fx.js",
  "/src/audio.js",
  "/src/viewmodel.js",
  "/node_modules/three/build/three.module.js",
  "/node_modules/three/examples/jsm/postprocessing/EffectComposer.js",
  "/node_modules/three/examples/jsm/postprocessing/UnrealBloomPass.js",
  "/node_modules/three/examples/jsm/postprocessing/SMAAPass.js",
  "/node_modules/three/examples/jsm/postprocessing/OutputPass.js",
  "/node_modules/three/examples/jsm/loaders/RGBELoader.js",
  "/assets/manifest.json",
];

let bad = 0;

// Every asset the manifest promises, so a half-finished fetch is caught here
// rather than as a texture that silently never arrives.
try {
  const res = await fetch(`${BASE}/assets/manifest.json`);
  if (res.ok) {
    const m = await res.json();
    for (const entry of Object.values(m.hdris ?? {})) paths.push(`/${entry.file}`);
    for (const entry of Object.values(m.textures ?? {})) {
      for (const file of Object.values(entry.maps ?? {})) paths.push(`/${file}`);
    }
  }
} catch {
  console.log("note: no manifest served — the game will run in flat colours");
}

// The server deliberately hands out EVERY file under the project root -- that is
// why it is bound to loopback only -- so `/package.json` returning 200 is correct
// and not worth asserting against. The property that matters is that nothing
// OUTSIDE the root is reachable.
//
// Note that `fetch` collapses `/../` in a URL before it is ever sent, so a plain
// `/../secret` tests nothing at all; the first version of this check asserted
// exactly that and reported a failure against a server behaving correctly. These
// are percent-encoded so the traversal survives to the server and the guard is
// what has to refuse it.
// Only paths that resolve OUTSIDE the root belong here. An encoded traversal that
// lands back inside it -- `%2e%2e%2fpackage.json` becomes `package.json` -- is
// served, correctly, and asserting otherwise reports a failure against a server
// doing its job. That was the second wrong expectation this check made; the
// traversal is neutralised by being clamped into the root, not by being refused.
const mustFail = [
  "/%2e%2e%2f%2e%2e%2f%2e%2e%2fWindows/win.ini",
  "/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fUsers/nicov/.npmrc",
  "/nope.js",
];

for (const p of paths) {
  try {
    const res = await fetch(BASE + p);
    const body = await res.arrayBuffer();
    const type = res.headers.get("content-type") ?? "?";
    const okStatus = res.status === 200 && body.byteLength > 0;
    if (!okStatus) bad++;
    console.log(
      `${okStatus ? "ok  " : "FAIL"} ${String(res.status)} `
      + `${(body.byteLength / 1024).toFixed(0).padStart(6)} KB  ${type.padEnd(34)} ${p}`,
    );
  } catch (err) {
    bad++;
    console.log(`FAIL  ---            ${p}   ${err.message}`);
  }
}

for (const p of mustFail) {
  try {
    const res = await fetch(BASE + p);
    const refused = res.status >= 400;
    if (!refused) bad++;
    console.log(`${refused ? "ok  " : "FAIL"} ${res.status} refused as expected  ${p}`);
  } catch {
    console.log(`ok   refused (connection)  ${p}`);
  }
}

console.log(`\n${paths.length + mustFail.length - bad}/${paths.length + mustFail.length} served correctly`);
if (bad > 0) process.exit(1);
