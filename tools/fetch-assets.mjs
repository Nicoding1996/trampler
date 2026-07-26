// Fetch the public-domain art this build uses, from Poly Haven's API.
//
//   node tools/fetch-assets.mjs
//
// Everything downloaded here is CC0, so it can be committed and served from the
// project root like any other file. That matters: the prototype is offline-first
// by design -- three.js is served out of node_modules for exactly the same
// reason -- so art is VENDORED, never hot-linked. A game that needs the network
// to look right does not run on the plane where most of the tuning happens.
//
// The script is idempotent and md5-checked, so re-running it is free and a
// half-finished download repairs itself rather than leaving a corrupt texture
// that fails in the renderer with no explanation.
//
// Nothing here is required at runtime. `src/assets.js` treats the whole set as
// optional and falls back to procedural textures if `assets/manifest.json` is
// missing, so a fresh clone that has not run this still plays.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "assets");
const API = "https://api.polyhaven.com";

// Diffuse, OpenGL-convention normals, and the packed ARM map (ambient occlusion
// in red, roughness in green, metalness in blue). Three maps instead of five,
// and the packed one is a quarter the size of the three separate greyscales.
const TEX_MAPS = [
  ["Diffuse", "diff"],
  ["nor_gl", "nor_gl"],
  ["arm", "arm"],
];

// 1k is deliberate. These are tiled across large surfaces at close range in a
// game that also wants to hold 60 fps with 400 instanced enemies; 4k would cost
// 16x the VRAM to resolve detail the tiling repeat already hides.
const RES = "1k";

/**
 * Every asset, with the role it plays. The role is what `src/assets.js` looks up,
 * so the slug can be swapped for a different CC0 asset without touching any
 * rendering code.
 */
const WANT = {
  hdris: [
    // Environment lighting AND the sky. A wasteland sky is doing double duty
    // here: it is the single biggest visual upgrade available, because every PBR
    // material in the scene gets its specular response from it.
    { role: "sky", slug: "wasteland_clouds_puresky" },
  ],
  textures: [
    { role: "sand", slug: "sand_02" },              // the desert floor
    { role: "hull", slug: "rusty_metal_02" },       // fortress plating
    { role: "deck", slug: "metal_plate" },          // the walkable surface
    { role: "rust", slug: "rust_coarse_01" },       // legs and weathered trim
    { role: "panel", slug: "corrugated_iron" },     // crates, sponson, engine block
    { role: "grate", slug: "metal_grate_rusty" },   // catwalks
    { role: "rock", slug: "rock_boulder_dry" },     // scatter rocks
    { role: "ruin", slug: "concrete_wall_007" },    // the tall ruins
  ],
};

const md5 = (buf) => createHash("md5").update(buf).digest("hex");

async function getJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.json();
}

/** Download unless an identical file is already on disk. */
async function download(url, dest, expectMd5) {
  try {
    const existing = await readFile(dest);
    if (!expectMd5 || md5(existing) === expectMd5) {
      return { skipped: true, bytes: existing.length };
    }
  } catch {
    // not there yet, or unreadable: fall through and fetch it
  }

  const res = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (expectMd5 && md5(buf) !== expectMd5) {
    throw new Error(`checksum mismatch for ${url}`);
  }

  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  return { skipped: false, bytes: buf.length };
}

const rel = (p) => p.slice(ROOT.length + 1).replaceAll("\\", "/");

async function main() {
  const manifest = { source: "polyhaven.com", license: "CC0", hdris: {}, textures: {} };
  const credits = [];
  let downloaded = 0;
  let skipped = 0;
  let bytes = 0;

  for (const { role, slug } of WANT.hdris) {
    const [files, info] = await Promise.all([
      getJson(`${API}/files/${slug}`),
      getJson(`${API}/info/${slug}`),
    ]);
    const entry = files.hdri?.[RES]?.hdr;
    if (!entry) throw new Error(`no ${RES} hdr for ${slug}`);

    const dest = join(OUT, "hdri", `${slug}_${RES}.hdr`);
    const r = await download(entry.url, dest, entry.md5);
    r.skipped ? skipped++ : downloaded++;
    bytes += r.bytes;

    manifest.hdris[role] = { slug, file: rel(dest) };
    credits.push({ slug, name: info.name, authors: info.authors, kind: "HDRI" });
    console.log(`${r.skipped ? "have" : "got "}  hdri/${role}  ${slug}`);
  }

  for (const { role, slug } of WANT.textures) {
    const [files, info] = await Promise.all([
      getJson(`${API}/files/${slug}`),
      getJson(`${API}/info/${slug}`),
    ]);

    const maps = {};
    for (const [apiKey, suffix] of TEX_MAPS) {
      const entry = files[apiKey]?.[RES]?.jpg;
      // Not every texture ships every map. A missing ARM is survivable -- the
      // material just keeps its authored roughness -- so warn instead of dying.
      if (!entry) {
        console.log(`      note: ${slug} has no ${apiKey} at ${RES}`);
        continue;
      }
      const dest = join(OUT, "textures", slug, `${slug}_${suffix}_${RES}.jpg`);
      const r = await download(entry.url, dest, entry.md5);
      r.skipped ? skipped++ : downloaded++;
      bytes += r.bytes;
      maps[suffix] = rel(dest);
    }

    manifest.textures[role] = { slug, maps };
    credits.push({ slug, name: info.name, authors: info.authors, kind: "Texture" });
    console.log(`${Object.keys(maps).length}/3   tex/${role}   ${slug}`);
  }

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  const lines = [
    "# Third-party assets",
    "",
    "Every asset in `assets/` came from [Poly Haven](https://polyhaven.com) and is",
    "released under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/),",
    "which places it in the public domain. No attribution is legally required;",
    "it is recorded here because crediting the people whose work makes this look",
    "like a game rather than a grey box is the decent thing to do.",
    "",
    "Regenerate with `node tools/fetch-assets.mjs`.",
    "",
    "| Asset | Kind | Author(s) | Source |",
    "| --- | --- | --- | --- |",
    ...credits.map((c) => {
      const authors = Object.keys(c.authors ?? {}).join(", ") || "Poly Haven";
      return `| ${c.name} | ${c.kind} | ${authors} | https://polyhaven.com/a/${c.slug} |`;
    }),
    "",
    "## Everything else",
    "",
    "All geometry, shaders, procedural textures and audio in this project are",
    "generated in code. There are no imported meshes: the fortress, the horde and",
    "the terrain are all built at runtime, which is why the whole build is a few",
    "hundred kilobytes of source plus the textures above.",
    "",
  ];
  await writeFile(join(ROOT, "ATTRIBUTION.md"), lines.join("\n"));

  console.log(
    `\n${downloaded} downloaded, ${skipped} already present, `
    + `${(bytes / 1048576).toFixed(1)} MB total in assets/`,
  );
}

main().catch((err) => {
  console.error(`\nfetch-assets failed: ${err.message}`);
  console.error("The game still runs -- src/assets.js falls back to procedural textures.");
  process.exit(1);
});
