import * as THREE from "three";
import { CFG } from "./config.js";

// The look: materials, textures, and the shared geometry tricks that make boxes
// stop reading as boxes.
//
// This module is imported by the SIMULATION modules -- world, trampler, enemies --
// so it has one hard requirement: it must work with no DOM and no renderer. The
// headless harness constructs the real World and the real Trampler, and if
// building a material reached for `document` the whole test suite would die on
// import.
//
// So everything here is in two layers:
//
//   Layer 1, always available. Materials, and geometry UV work. Pure three.js,
//   no canvas, no images. This is what the harness sees, and it is also the
//   fallback the game runs on for the first few frames before textures arrive.
//
//   Layer 2, browser only. Procedural canvas textures, the CC0 texture sets in
//   assets/, and the HDRI environment. Applied ASYNCHRONOUSLY to the material
//   instances layer 1 already handed out, which is why materials are cached by
//   role: `Look.load()` can reach back and attach maps to meshes that were built
//   thousands of frames earlier.
//
// The consequence worth stating plainly: art is optional at runtime. Delete
// assets/ and the game still runs, in flat colours. Nothing in the simulation can
// fail because a texture is missing.

const HEADLESS = typeof document === "undefined";

/**
 * Rewrite a box's UVs so texture density is CONSTANT IN METRES rather than
 * constant per face.
 *
 * This is the single change that stops tiled textures looking like a student
 * project. BoxGeometry gives every face UVs spanning 0..1, so a shared material
 * makes a 26 m hull and a 1.2 m crate show the same number of texture repeats --
 * the hull looks smeared and the crate looks like a photograph of rust. Scaling
 * each face's UVs by its own real dimensions fixes it for every box in the game
 * at once, and costs one pass over 24 vertices at build time.
 *
 * BoxGeometry lays faces out +x, -x, +y, -y, +z, -z, four vertices each.
 */
export function tileBoxUVs(geometry, w, h, d, tile = 2.0) {
  const uv = geometry.attributes.uv;
  if (!uv) return geometry;

  // Which real-world dimensions each face's u and v axes correspond to.
  const spans = [
    [d, h], [d, h],   // +x, -x
    [w, d], [w, d],   // +y, -y
    [w, h], [w, h],   // +z, -z
  ];

  for (let face = 0; face < 6; face++) {
    const [su, sv] = spans[face];
    const ru = Math.max(su / tile, 0.05);
    const rv = Math.max(sv / tile, 0.05);
    for (let i = 0; i < 4; i++) {
      const idx = face * 4 + i;
      uv.setXY(idx, uv.getX(idx) * ru, uv.getY(idx) * rv);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Which downloaded texture set backs each material role, and how big one tile of
 * it is in metres. Roles with no entry stay untextured, which is correct for
 * things that are supposed to read as emissive or as pure signal (hardpoints,
 * repair markers, tracers).
 */
const ROLE_TEXTURE = {
  hull: { set: "hull", tile: 2.6 },
  deck: { set: "grate", tile: 1.8 },
  trim: { set: "rust", tile: 1.6 },
  mast: { set: "panel", tile: 1.6 },
  leg: { set: "rust", tile: 1.2 },
  crate: { set: "panel", tile: 1.2 },
  rock: { set: "rock", tile: 3.0 },
  ruin: { set: "ruin", tile: 3.4 },
  sand: { set: "sand", tile: 7.0 },
  plate: { set: "deck", tile: 2.2 },
};

class LookRegistry {
  constructor() {
    this.materials = new Map();
    this.textures = new Map();
    this.ready = false;
    this.env = null;
    // Set once assets land, so callers can tell "flat because it is still
    // loading" from "flat because there is no art on disk".
    this.status = HEADLESS ? "headless" : "pending";
  }

  /**
   * A cached standard material for a role. Callers pass the flat-colour look they
   * want; maps are attached later if art is available.
   *
   * Cached by role AND by any override that changes the material's identity, so
   * two callers asking for "trim" get the same instance and both light up when
   * textures arrive.
   */
  std(role, params = {}) {
    const key = `${role}|${JSON.stringify(params)}`;
    const hit = this.materials.get(key);
    if (hit) return hit;

    const mat = new THREE.MeshStandardMaterial({
      color: 0x808080,
      roughness: 0.8,
      metalness: 0.1,
      ...params,
    });
    mat.userData.role = role;
    this.materials.set(key, mat);

    // If assets already arrived, a material created afterwards still gets them.
    if (this.ready) this.#dress(mat);
    return mat;
  }

  /**
   * Attach whatever maps exist for a material's role.
   *
   * Idempotent, and it has to be: it lerps the material's colour toward white, so
   * running twice on the same instance would wash it out. Materials are cached and
   * re-dressed whenever assets arrive, which is exactly the situation where that
   * would happen without the guard.
   */
  #dress(mat) {
    if (mat.userData.dressed) return;
    const spec = ROLE_TEXTURE[mat.userData.role];
    if (!spec) return;
    const set = this.textures.get(spec.set);
    if (!set) return;
    mat.userData.dressed = true;

    if (set.diff) {
      mat.map = set.diff;
      // The diffuse map carries the colour, so the flat tint has to step back or
      // everything ends up muddy. Kept slightly bright rather than pure white,
      // which is what preserves the authored palette through the texture.
      mat.color.lerp(new THREE.Color(0xffffff), 0.55);
    }
    if (set.nor) {
      mat.normalMap = set.nor;
      mat.normalScale = new THREE.Vector2(0.9, 0.9);
    }
    if (set.arm) {
      // One image, three channels: ambient occlusion, roughness, metalness. The
      // AO map needs uv2 in older three versions; from r151 it reads `uv` when
      // no `uv1` exists, so nothing extra is required here.
      mat.aoMap = set.arm;
      mat.roughnessMap = set.arm;
      mat.metalnessMap = set.arm;
      mat.aoMapIntensity = 0.85;
      // The maps MODULATE these, so they have to be near 1 to be visible at all --
      // a roughness of 0.7 multiplied by a roughness map is a much smoother surface
      // than either value suggests.
      mat.roughness = 1.0;

      // Metalness is CAPPED, not forced to 1.
      //
      // Setting it to 1 meant "trust the map completely", and for these particular
      // texture sets the packed blue channel is bright over most of the surface --
      // so the entire fortress became a mirror pointed at a desert sky, and the
      // result was the blown-out white a playtest described as being flash-banged.
      // A ceiling of 0.55 keeps the metal reading as painted, weathered steel,
      // which is what it is supposed to be.
      const nonMetal = new Set(["sand", "rock", "ruin"]);
      mat.metalness = nonMetal.has(mat.userData.role) ? 0.0 : 0.55;
    }
    mat.needsUpdate = true;
  }

  /** Re-dress every cached material. Called once assets are in. */
  #dressAll() {
    for (const mat of this.materials.values()) this.#dress(mat);
  }

  // ---------------------------------------------------------------- browser only

  /**
   * Load the CC0 texture sets and the HDRI environment, then retro-fit them onto
   * every material already handed out.
   *
   * Never throws. A missing manifest, a 404, a device that cannot decode the HDR
   * -- all of it degrades to flat colours, because a graphical nicety must not be
   * able to take the game down.
   */
  async load(renderer, scene) {
    if (HEADLESS) return false;

    let manifest;
    try {
      const res = await fetch("/assets/manifest.json", { cache: "force-cache" });
      if (!res.ok) throw new Error(`manifest ${res.status}`);
      manifest = await res.json();
    } catch (err) {
      this.status = `no assets (${err.message}) — run: node tools/fetch-assets.mjs`;
      console.warn(`[look] ${this.status}`);
      return false;
    }

    const loader = new THREE.TextureLoader();
    const maxAniso = renderer?.capabilities?.getMaxAnisotropy?.() ?? 4;

    const load1 = (url, srgb) => new Promise((resolve) => {
      loader.load(
        `/${url}`,
        (tex) => {
          tex.wrapS = THREE.RepeatWrapping;
          tex.wrapT = THREE.RepeatWrapping;
          tex.anisotropy = Math.min(8, maxAniso);
          // Colour maps are sRGB; normal and packed data maps are NOT, and
          // marking them so is the difference between plausible surfaces and
          // strangely flat, washed-out ones.
          if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
          resolve(tex);
        },
        undefined,
        () => resolve(null),
      );
    });

    await Promise.all(Object.entries(manifest.textures ?? {}).map(async ([role, entry]) => {
      const [diff, nor, arm] = await Promise.all([
        entry.maps.diff ? load1(entry.maps.diff, true) : null,
        entry.maps.nor_gl ? load1(entry.maps.nor_gl, false) : null,
        entry.maps.arm ? load1(entry.maps.arm, false) : null,
      ]);
      this.textures.set(role, { diff, nor, arm });
    }));

    // Environment lighting. This is the biggest single visual win available:
    // every metal surface in the scene gets its specular response from it, which
    // is what stops the fortress looking like flat grey plastic.
    const hdri = manifest.hdris?.sky;
    if (hdri && renderer && scene) {
      try {
        // Dynamically imported, and only ever on this side of the HEADLESS guard.
        // A static import of an addon would put a path in the module graph that
        // only resolves through the dev server's importmap, and the harness loads
        // this file from plain node.
        const { RGBELoader } = await import("three/addons/loaders/RGBELoader.js");
        const hdr = await new RGBELoader().loadAsync(`/${hdri.file}`);
        hdr.mapping = THREE.EquirectangularReflectionMapping;

        const pmrem = new THREE.PMREMGenerator(renderer);
        this.env = pmrem.fromEquirectangular(hdr).texture;
        pmrem.dispose();

        scene.environment = this.env;
        scene.background = hdr;
        // Rotate the sky so its brightest region sits roughly where our
        // directional light comes from. Without this the shadows point one way
        // and the sky glows the other, which reads as "wrong" long before anyone
        // can say why.
        scene.backgroundRotation = new THREE.Euler(0, CFG.world.skyRotation, 0);
        scene.environmentRotation = new THREE.Euler(0, CFG.world.skyRotation, 0);
        // Two separate dials, and they were one before: how much the sky LIGHTS the
        // scene, and how bright the sky is DRAWN. An HDRI used raw as a background
        // put a wall of blown-out white behind every silhouette in the game, which
        // is not a lighting problem and cannot be fixed by touching the lighting.
        scene.environmentIntensity = CFG.world.envIntensity;
        scene.backgroundIntensity = CFG.world.skyIntensity;
        // Fog still owns the far field, so the horizon dissolves into dust
        // instead of showing a hard line where the sky meets the sand.
        scene.backgroundBlurriness = 0.02;
      } catch (err) {
        console.warn(`[look] HDRI unavailable: ${err.message}`);
      }
    }

    this.ready = true;
    this.status = `${this.textures.size} texture sets, env ${this.env ? "on" : "off"}`;
    this.#dressAll();
    return true;
  }
}

export const Look = new LookRegistry();

// ---------------------------------------------------------------------------
// Geometry helpers. Pure three.js, so the harness runs them too -- which is the
// point: an enemy's DRAWN silhouette and its HIT BOX have to be built from the
// same numbers, and invariant 8 ("everything the player can see, the player can
// shoot") is only true if nobody can change one without the other.

/**
 * Body geometry for an enemy type, centred on its collision box.
 *
 * Deliberately built from the same radius/height the hit test uses, scaled only
 * by the type's `bulk`, so a heavier-looking enemy is still hit exactly where it
 * is drawn. The shapes differ per type because silhouette is the only way to
 * tell them apart at 60 m through dust: chewers are low and wide, climbers are
 * tall and narrow, the bulwark has a shield slab on its front, the sapper
 * carries a satchel, and the titan is unmistakable.
 */
export function enemyGeometry(key, cfg) {
  const r = cfg.radius * cfg.bulk;
  const h = cfg.height;
  const parts = [];

  const push = (geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.translate(x, y, z);
    parts.push(geo);
  };

  switch (key) {
    case "climber": {
      // Tall, thin, hunched forward -- reads as "climbing" even standing still.
      push(new THREE.BoxGeometry(r * 1.7, h * 0.62, r * 1.5), 0, h * 0.06, 0, 0.22);
      push(new THREE.SphereGeometry(r * 0.78, 10, 8), 0, h * 0.36, -r * 0.5);
      // Hooked forelimbs: the boarding tell.
      for (const s of [-1, 1]) {
        push(new THREE.BoxGeometry(r * 0.3, r * 0.3, h * 0.5),
          s * r * 1.0, h * 0.16, -r * 1.1, -0.5);
      }
      break;
    }

    case "bulwark": {
      // A walking shield. The slab on the front is the whole point: it is what
      // the player sees before they discover the rifle is the wrong tool.
      push(new THREE.BoxGeometry(r * 2.0, h * 0.55, r * 1.9), 0, -h * 0.06, 0);
      push(new THREE.BoxGeometry(r * 2.4, h * 0.72, r * 0.45), 0, h * 0.05, -r * 1.15);
      push(new THREE.BoxGeometry(r * 0.9, h * 0.2, r * 0.9), 0, h * 0.38, r * 0.2);
      for (const s of [-1, 1]) {
        push(new THREE.CylinderGeometry(r * 0.26, r * 0.3, h * 0.42, 6),
          s * r * 0.95, -h * 0.3, 0);
      }
      break;
    }

    case "burrower": {
      // A drill head on a segmented body, low to the ground.
      push(new THREE.ConeGeometry(r * 1.05, h * 0.55, 8), 0, h * 0.05, -r * 0.9, -Math.PI / 2);
      push(new THREE.SphereGeometry(r * 0.95, 10, 8), 0, -h * 0.06, r * 0.4);
      push(new THREE.SphereGeometry(r * 0.7, 8, 6), 0, -h * 0.1, r * 1.2);
      break;
    }

    case "sapper": {
      // Spindly, and carrying the thing you have to stop it planting.
      push(new THREE.BoxGeometry(r * 1.2, h * 0.5, r * 1.1), 0, 0, 0);
      push(new THREE.SphereGeometry(r * 0.6, 10, 8), 0, h * 0.34, -r * 0.35);
      push(new THREE.BoxGeometry(r * 1.0, r * 1.0, r * 0.85), 0, h * 0.02, r * 1.05);
      for (const s of [-1, 1]) {
        push(new THREE.CylinderGeometry(r * 0.12, r * 0.12, h * 0.55, 5),
          s * r * 0.8, -h * 0.22, 0, 0, 0, s * 0.25);
      }
      break;
    }

    case "titan": {
      // Boss silhouette: a slab of a torso on four legs, with a crown of horns.
      // Tall enough that it cannot fit under the hull, which is the fight's whole
      // design -- see the config comment.
      push(new THREE.BoxGeometry(r * 1.9, h * 0.34, r * 2.2), 0, h * 0.16, 0);
      push(new THREE.BoxGeometry(r * 2.2, h * 0.2, r * 0.5), 0, h * 0.3, -r * 0.9);
      push(new THREE.SphereGeometry(r * 0.72, 12, 10), 0, h * 0.34, -r * 1.3);
      for (const s of [-1, 1]) {
        push(new THREE.CylinderGeometry(r * 0.1, r * 0.02, h * 0.22, 5),
          s * r * 0.42, h * 0.5, -r * 1.2, s * 0.3);
        for (const z of [-r * 0.7, r * 0.8]) {
          push(new THREE.CylinderGeometry(r * 0.2, r * 0.16, h * 0.5, 6),
            s * r * 0.95, -h * 0.22, z);
        }
      }
      break;
    }

    default: {
      // Chewer: low, wide, mandibles forward. The commonest thing on screen, so
      // it is also the cheapest.
      push(new THREE.BoxGeometry(r * 1.9, h * 0.5, r * 2.2), 0, -h * 0.04, 0);
      push(new THREE.SphereGeometry(r * 0.7, 8, 6), 0, h * 0.14, -r * 1.0);
      for (const s of [-1, 1]) {
        push(new THREE.BoxGeometry(r * 0.22, r * 0.22, r * 1.1),
          s * r * 0.5, h * 0.06, -r * 1.6, 0, s * 0.22);
      }
      break;
    }
  }

  return mergeGeometries(parts);
}

/**
 * Merge a list of geometries into one, position/normal/uv only.
 *
 * three ships BufferGeometryUtils for this, but it lives in examples/jsm, and
 * importing an addon from a simulation module would put a path into the harness
 * that only resolves through the dev server. Forty lines here keeps enemies.js
 * loadable from plain node.
 */
export function mergeGeometries(list) {
  let vertexCount = 0;
  let indexCount = 0;
  for (const g of list) {
    vertexCount += g.attributes.position.count;
    indexCount += g.index ? g.index.count : g.attributes.position.count;
  }

  const position = new Float32Array(vertexCount * 3);
  const normal = new Float32Array(vertexCount * 3);
  const uv = new Float32Array(vertexCount * 2);
  const index = new Uint32Array(indexCount);

  let vo = 0;
  let io = 0;
  for (const g of list) {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;

    position.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (n) normal.set(n.array.subarray(0, n.count * 3), vo * 3);
    if (t) uv.set(t.array.subarray(0, t.count * 2), vo * 2);

    if (g.index) {
      for (let i = 0; i < g.index.count; i++) index[io + i] = g.index.array[i] + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) index[io + i] = i + vo;
      io += p.count;
    }
    vo += p.count;
    g.dispose();
  }

  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(position, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(normal, 3));
  out.setAttribute("uv", new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(index, 1));
  out.computeBoundingSphere();
  return out;
}

/**
 * Scatter small boxes over a surface to break up a flat plane.
 *
 * "Greebling" -- the model-maker's trick of gluing kit parts to a smooth shape so
 * the eye reads scale into it. A 26 m hull with clean faces reads as a 26 cm
 * hull with clean faces; the same hull with pipes and bolt strips on it reads as
 * enormous, because the detail gives the eye something to measure against.
 *
 * Deterministic: takes the seeded RNG, so the fortress is identical every load.
 */
export function greeble(rand, count, spread, opts = {}) {
  const {
    minSize = 0.12, maxSize = 0.5, thickness = 0.14, axis = "y",
  } = opts;
  const parts = [];

  for (let i = 0; i < count; i++) {
    const w = minSize + rand() * (maxSize - minSize);
    const d = minSize + rand() * (maxSize - minSize);
    const t = thickness * (0.5 + rand());

    const x = (rand() * 2 - 1) * spread.x;
    const y = (rand() * 2 - 1) * spread.y;
    const z = (rand() * 2 - 1) * spread.z;

    const geo = axis === "y"
      ? new THREE.BoxGeometry(w, t, d)
      : axis === "x"
        ? new THREE.BoxGeometry(t, w, d)
        : new THREE.BoxGeometry(w, d, t);
    geo.translate(x, y, z);
    parts.push(geo);
  }

  return mergeGeometries(parts);
}
