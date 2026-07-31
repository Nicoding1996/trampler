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

  // BODIES TAKE RELIEF ONLY: normal and ARM maps, and deliberately NO diffuse.
  //
  // Every one of these was flat MeshStandardMaterial colour standing in a fully
  // textured world, which is most of why characters read as dropped in from another
  // game. But the obvious fix breaks something. #dress lerps a material's colour 55%
  // toward white when a diffuse map lands, because the map is then carrying the colour --
  // and for the horde that colour is doing gameplay work. The comment on the enemy skins
  // says it outright: it is the only cue available at 70 m through dust. A chewer's
  // 0x8f3540 washed 55% toward white is a pale pink, so texturing the crowd the ordinary
  // way trades invariant 8a's crowd legibility for surface detail.
  //
  // `relief` takes the normal map and the packed ARM map and skips the diffuse, so the
  // flatness goes and `mat.color` is never touched. Per-type hues and the crew's olive
  // survive exactly as authored.
  //
  // Set choice matters much less than usual for the same reason -- only the bumpiness
  // and the roughness/AO variation come through, not the photograph. `rock` is pitted
  // and organic, which is what a carapace wants; `rust` is coarse and flaky, which suits
  // the bulwark's plate and reads as heavy canvas at crew scale.
  enemy_chewer: { set: "rock", relief: true },
  enemy_climber: { set: "rock", relief: true },
  enemy_bulwark: { set: "rust", relief: true },
  enemy_burrower: { set: "rock", relief: true },
  enemy_sapper: { set: "rock", relief: true },
  enemy_titan: { set: "rock", relief: true },
  crew: { set: "rust", relief: true },
  crew_gear: { set: "panel", relief: true },
};

/**
 * How many metres one texture repeat covers on a body.
 *
 * These exist because ROLE_TEXTURE's own `tile` field is NOT read by anything -- tiling
 * happens at geometry build time, where the real dimensions are known, and every caller
 * passes its own number into tileBoxUVs. Those entries above are documentation of intent
 * rather than working config, which is worth knowing before trusting one.
 *
 * Body-scale rather than fortress-scale: the hull tiles at 2.6 m and its legs at 1.1, but
 * a crewmate's chest strap is 5 cm across and an enemy's mandible smaller still. Left at
 * a structural tile, a body would show a fraction of one enormous repeat and the relief
 * would read as a smooth blob instead of as a surface.
 */
const CREW_TILE = 0.5;
const HORDE_TILE = 0.8;

/**
 * Metre-normalise a box's UVs. Anything that is not a box passes through untouched.
 *
 * The type test is on BoxGeometry's own `parameters`, which is the only three.js
 * primitive carrying width AND height AND depth. That matters because tileBoxUVs assumes
 * the 6-face, 24-vertex box layout and would silently corrupt a sphere's or a cylinder's
 * UVs -- and both appear in these bodies, as heads, drill cones and bedrolls. Those keep
 * their own mapping, which is the right answer for small round parts anyway.
 */
function tileIfBox(geo, tile) {
  const p = geo.parameters;
  if (p && p.width !== undefined && p.height !== undefined && p.depth !== undefined) {
    tileBoxUVs(geo, p.width, p.height, p.depth, tile);
  }
  return geo;
}

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

    // A `relief` role wants surface detail without surrendering its colour, so it takes
    // the normal and ARM maps below and skips this branch entirely. See the character
    // entries in ROLE_TEXTURE for why the colour is not negotiable there.
    if (set.diff && !spec.relief) {
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
      //
      // THE BODIES ARE IN THAT SET TOO, and they had to be added the moment they started
      // taking maps at all. This branch does not consult ROLE_TEXTURE -- it defaults every
      // unlisted role to 0.55 -- so a chewer, a climber and a crewmate's coat would each
      // have become half-metallic on the frame the art loaded, which is invariant 33's
      // whole failure re-run on flesh and canvas. Only the bulwark's plate and the crew's
      // steel gear are left metallic, because those are the two that actually are.
      const nonMetal = new Set([
        "sand", "rock", "ruin",
        "enemy_chewer", "enemy_climber", "enemy_burrower", "enemy_sapper", "enemy_titan",
        "crew",
      ]);
      mat.metalness = nonMetal.has(mat.userData.role) ? 0.0 : 0.55;
    }
    mat.needsUpdate = true;
  }

  /** Re-dress every cached material. Called once assets are in. */
  #dressAll() {
    for (const mat of this.materials.values()) this.#dress(mat);
  }

  /** Dress only roles backed by one texture set, spreading shader invalidation over the load. */
  #dressSet(setName) {
    for (const mat of this.materials.values()) {
      if (ROLE_TEXTURE[mat.userData.role]?.set === setName) this.#dress(mat);
    }
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

    // One PBR set at a time: three image requests rather than all twenty-four at once. The
    // art is optional and the flat materials are already playable, so saturating a first-load
    // connection and decoding/uploading every 1K map together only buys a large hitch. Dressing
    // each completed set also spreads material recompiles across those network turns instead of
    // invalidating the whole scene on one frame.
    for (const [setName, entry] of Object.entries(manifest.textures ?? {})) {
      const [diff, nor, arm] = await Promise.all([
        entry.maps.diff ? load1(entry.maps.diff, true) : null,
        entry.maps.nor_gl ? load1(entry.maps.nor_gl, false) : null,
        entry.maps.arm ? load1(entry.maps.arm, false) : null,
      ]);
      this.textures.set(setName, { diff, nor, arm });
      this.#dressSet(setName);
    }

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
 * Which limb group a vertex belongs to, written into the `aRig` attribute.
 *
 * Two limb phases rather than a general skeleton, on purpose. This buys a walk
 * cycle for a 400-body crowd at zero draw calls and zero CPU, and the alternative
 * -- real skeletal animation -- is not available: three.js has no instanced
 * skinning in core, and a SkinnedMesh per enemy starts dropping frames somewhere
 * around two hundred. The pool cap here is 420.
 *
 * BODY is inert and is the default, so a part nobody classified cannot move.
 */
const PART = { BODY: 0, LIMB_A: 1, LIMB_B: 2 };

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
  const rig = [];

  // `part` is the optional trailing argument: [code, pivotY]. Anything not
  // classified is body, which is inert. Only limbs need a pivot, and it is the
  // height the limb hangs FROM -- the shader swings vertices by how far below it
  // they are, so a wrong pivot shows up as a leg that pivots at the wrong joint
  // rather than as a crash.
  const push = (geo, x, y, z, rx = 0, ry = 0, rz = 0, part = null) => {
    // UVs before the transforms, though the order is immaterial -- tileBoxUVs touches
    // only the uv attribute, so no position, no pivot and no extent measured by
    // tools/gait-extents.mjs moves because of it.
    tileIfBox(geo, HORDE_TILE);
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.translate(x, y, z);
    parts.push(geo);
    rig.push(part ?? [PART.BODY, 0]);
  };

  switch (key) {
    case "climber": {
      // Tall, thin, hunched forward -- reads as "climbing" even standing still.
      push(new THREE.BoxGeometry(r * 1.7, h * 0.62, r * 1.5), 0, h * 0.06, 0, 0.22);
      push(new THREE.SphereGeometry(r * 0.78, 10, 8), 0, h * 0.36, -r * 0.5);
      // Hooked forelimbs: the boarding tell.
      //
      // NOT classified as limbs, and the reason is worth keeping because the first
      // attempt got it wrong. A LIMB here means "something that hangs below a pivot
      // and swings fore and aft" -- a leg. These point FORWARD, so the rule only
      // produces motion if you put the pivot well above them, which is inventing a
      // joint that is not there to make the arithmetic give an answer. Measured, it
      // shoved a forward-pointing arm 18 cm further forward and nearly doubled how
      // far the climber's silhouette already reaches outside the box a shot tests
      // against -- on the one type whose job is to be shot before it boards.
      //
      // A reaching claw is a real animation and a DIFFERENT rule (a yaw scissor about
      // the limb's own base, not a hang-driven swing). It belongs to whoever adds
      // that rule, not to this one. Same call as the chewer's mandibles below.
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
          s * r * 0.95, -h * 0.3, 0,
          0, 0, 0, [s < 0 ? PART.LIMB_A : PART.LIMB_B, -h * 0.09]);
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
          s * r * 0.8, -h * 0.22, 0, 0, 0, s * 0.25,
          [s < 0 ? PART.LIMB_A : PART.LIMB_B, h * 0.055]);
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
          // A DIAGONAL TROT, which is what a four-legged thing actually does:
          // front-left moves with back-right. Same-sign pairs share a phase, so
          // (-x,-z) walks with (+x,+z). Putting both legs on a side in phase
          // instead reads as a pantomime horse, and it is the one gait error that
          // is obvious even at 70 m.
          const diagonal = (s < 0) === (z < 0) ? PART.LIMB_A : PART.LIMB_B;
          push(new THREE.CylinderGeometry(r * 0.2, r * 0.16, h * 0.5, 6),
            s * r * 0.95, -h * 0.22, z,
            0, 0, 0, [diagonal, h * 0.03]);
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

  return mergeGeometries(parts, rig);
}

/**
 * Give a horde material a walk cycle, in the vertex shader.
 *
 * WHY IT IS DONE HERE AND NOT ON THE CPU. The horde is six InstancedMesh and one
 * geometry per type; there is no Object3D per enemy and there cannot be one, since
 * the whole crowd is six draw calls and 1,192 triangles. Animating on the CPU would
 * mean touching 400 bodies a frame against a simulation budget of about a
 * millisecond, and animating with a skeleton is not on the table at all -- three.js
 * has no instanced skinning in core.
 *
 * So the motion is procedural and per-vertex: `aRig` says which limb group a vertex
 * belongs to and the height it hangs from, `aAnim` carries the phase and amplitude
 * for its instance, and one uniform carries the clock. Cost is two floats per
 * instance a frame, on a buffer that already ships sixteen for the matrix.
 *
 * TWO HONEST LIMITS, because neither is visible in a screenshot.
 *
 * Normals are NOT recomputed, so lighting does not follow the deformation. At a
 * swing this small, on a crowd at 20 to 70 m, the shading error is not perceptible
 * -- and recomputing them per vertex would cost more than the whole animation does.
 *
 * The SHADOW does not move. A shadow pass uses three's own depth material, which
 * carries none of this, so a body's shadow holds the rest pose while the body walks.
 * Fixable with a matching customDepthMaterial, and deliberately not fixed yet: the
 * displacement is centimetres, the shadows sit under bodies at distance, and a
 * second patched material is a second thing to keep in step for a gain nobody has
 * demonstrated.
 */
export function animateHorde(mat, gait) {
  // Held on the material so enemies.js can advance the clock whether or not a
  // shader was ever compiled -- which is the headless case, where onBeforeCompile
  // never runs and this must still be a harmless write.
  const u = {
    uGaitTime: { value: 0 },
    uGaitRate: { value: gait.rate },
    uGaitSwing: { value: gait.swing },
    uGaitBob: { value: gait.bob },
    uGaitSway: { value: gait.sway },
  };
  mat.userData.gait = u;

  mat.onBeforeCompile = (shader) => {
    // The SAME uniform objects every time. A material recompiles when anything
    // sets needsUpdate, and rebuilding these here would silently reset the clock.
    Object.assign(shader.uniforms, u);

    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */`
        #include <common>
        attribute vec2 aRig;
        attribute vec2 aAnim;
        uniform float uGaitTime;
        uniform float uGaitRate;
        uniform float uGaitSwing;
        uniform float uGaitBob;
        uniform float uGaitSway;
        `,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */`
        vec3 transformed = vec3( position );

        float gPhase = uGaitTime * uGaitRate + aAnim.x;
        float gAmp = aAnim.y;

        // Bob at twice the stride, because weight lands on every step rather than
        // every cycle. Sway at the stride, which is what stops a line of bodies
        // closing on the hull reading as a conveyor belt.
        float gBob = sin(gPhase * 2.0) * uGaitBob * gAmp;
        float gSway = sin(gPhase) * uGaitSway * gAmp;
        float gC = cos(gSway);
        float gS = sin(gSway);
        transformed.xz = vec2(
          gC * transformed.x + gS * transformed.z,
          -gS * transformed.x + gC * transformed.z
        );
        transformed.y += gBob;

        // Limbs swing fore and aft about the height they hang from. Only vertices
        // BELOW the pivot move, so a leg rotates at its joint rather than shearing
        // out of the body it is attached to. Read off the UNDISPLACED position,
        // since the pivot was authored in that frame.
        float gLimb = step(0.5, aRig.x);
        float gDir = 1.0 - 2.0 * step(1.5, aRig.x);
        float gHang = min(position.y - aRig.y, 0.0);
        transformed.z += sin(gPhase) * uGaitSwing * gAmp * gLimb * gDir * gHang;
        `,
      );
  };

  return mat;
}

/**
 * A crew operative, for the multiplayer avatars.
 *
 * Returned in THREE pieces rather than one merged mesh, and the split is the whole
 * design: a merged body cannot swing a leg, and a leg that swings is the single
 * strongest signal that a shape is a person rather than a prop. So the legs come
 * out separately, with their origin at the HIP, so the caller rotates them about
 * the joint a real leg pivots on.
 *
 *   canvas  coat, trousers, pack, arms -- the drab coat-and-webbing half
 *   gear    helmet, respirator, straps, rifle -- dark steel and leather
 *   signal  goggle band, shoulder bands, pack lamp, chest patch -- the seat colour
 *   leg     ONE leg, hip at the origin, used for both sides
 *
 * `leg` is shared because a boxy leg is symmetric across x, so mirroring is free
 * and a second geometry would only be a second thing to keep in step.
 *
 * WHY THREE MATERIALS AND NOT ONE. The first version painted the ENTIRE figure in the
 * seat colour, on the argument that a whole coloured body is identifiable across the
 * deck. It is, and it also read as a plastic toy standing in a dieselpunk desert --
 * reported in exactly those terms, from a screenshot, which is the only way it was ever
 * going to be caught. `seatColors` is a SIGNAL palette, four saturated hues chosen to be
 * told apart at a glance, and a signal palette applied to a whole human figure is a
 * category error: it fights the earthy, desaturated tones every enemy and the fortress
 * itself are drawn in.
 *
 * So the body is drab and the seat colour lives only on the signal pieces -- which are
 * deliberately MUCH larger than the pips they replace, because the config comment on
 * seatEmissive is right that a crewmate under the hull is in the one place the sun never
 * reaches. Bands rather than dots is how you keep that legibility without a coloured
 * body. It costs one extra draw call per avatar, three across a full crew.
 *
 * CENTRED ON THE ORIGIN, not standing on it. A relayed pose is the operative's
 * centre -- it is the position the box this replaces was built around -- so the
 * feet are at -height/2 and the top of the helmet at +height/2. Getting this
 * backwards puts the whole crew waist-deep in the deck.
 *
 * Local forward is -Z, matching every other body in the project, so the visor,
 * the rifle and the boot toes all point that way and the pack sits astern.
 *
 * One honest note on `radius`: the rifle and the pack reach past it. That is fine
 * here in a way it would not be for an enemy -- invariant 8 ties an enemy's drawn
 * silhouette to its hit box because the player shoots at it, and nothing whatsoever
 * collides with or shoots at a remote avatar. The radius sizes the torso; it is not
 * a claim about reach.
 */
export function operativeGeometry(radius, height) {
  const r = radius;
  const h = height;
  const half = h / 2;

  // Hips slightly below centre, which is where they are on a person. Everything
  // else is measured from here so the leg and the torso cannot drift apart.
  const hipY = -h * 0.07;
  const legLen = hipY + half;

  const canvas = [];
  const gear = [];
  const signal = [];
  const leg = [];

  const add = (list, geo, x, y, z, rx = 0, ry = 0, rz = 0) => {
    tileIfBox(geo, CREW_TILE);
    geo.rotateX(rx);
    geo.rotateY(ry);
    geo.rotateZ(rz);
    geo.translate(x, y, z);
    list.push(geo);
  };

  // ---- canvas: the coat, the trousers, the pack ---------------------------

  // Belt, then the flare of a heavy coat below it, then a narrower chest above. Three
  // slabs rather than one box, because a taper is what stops a torso reading as a
  // crate: the eye takes width changing with height as a body.
  add(canvas, new THREE.BoxGeometry(r * 1.20, h * 0.05, r * 0.86), 0, hipY + h * 0.025, 0);
  add(canvas, new THREE.BoxGeometry(r * 1.24, h * 0.13, r * 0.88), 0, hipY + h * 0.105, 0);
  add(canvas, new THREE.BoxGeometry(r * 1.12, h * 0.15, r * 0.80), 0, hipY + h * 0.245, 0);
  // Shoulder yoke, wider than the chest. This is what reads as "shoulders" at 40 m.
  add(canvas, new THREE.BoxGeometry(r * 1.62, h * 0.075, r * 0.86), 0, h * 0.255, 0);
  // Neck, so the head is not resting straight on the shoulders.
  add(canvas, new THREE.BoxGeometry(r * 0.34, h * 0.04, r * 0.34), 0, h * 0.305, -r * 0.02);
  add(canvas, new THREE.SphereGeometry(r * 0.36, 8, 6), 0, h * 0.375, -r * 0.03);
  // Pack, astern, with a bedroll lashed across the top of it.
  add(canvas, new THREE.BoxGeometry(r * 0.96, h * 0.17, r * 0.44), 0, h * 0.110, r * 0.74);
  add(canvas, new THREE.CylinderGeometry(r * 0.15, r * 0.15, r * 0.92, 6),
    0, h * 0.205, r * 0.70, 0, 0, Math.PI / 2);
  // Arms in two segments, upper and fore, so the elbow bends toward the weapon.
  // Slimmer and closer in than the first pass, which read as splayed.
  for (const s of [-1, 1]) {
    add(canvas, new THREE.BoxGeometry(r * 0.24, r * 0.24, h * 0.13),
      s * r * 0.66, h * 0.215, -r * 0.16, -0.22);
    add(canvas, new THREE.BoxGeometry(r * 0.21, r * 0.21, h * 0.13),
      s * r * 0.56, h * 0.150, -r * 0.60, -0.52);
  }
  // Thigh pouches, hung off the belt rather than off the leg, so they do not swing.
  for (const s of [-1, 1]) {
    add(canvas, new THREE.BoxGeometry(r * 0.26, h * 0.055, r * 0.24),
      s * r * 0.60, hipY - h * 0.005, -r * 0.08);
  }

  // ---- gear: dark steel and leather --------------------------------------
  //
  // A second tone, and it is the cheapest thing on this list that stops the figure
  // reading as a mannequin. One colour over a whole body is a mannequin whatever the
  // colour is; a helmet that is plainly a different material from a coat is a person.

  // Riveted helmet: a flattened cap with a brim over the eyes.
  add(gear, new THREE.BoxGeometry(r * 0.74, h * 0.055, r * 0.72), 0, h * 0.442, -r * 0.03);
  add(gear, new THREE.BoxGeometry(r * 0.80, h * 0.022, r * 0.30), 0, h * 0.422, -r * 0.40);
  // Respirator over the lower face. Dust is the setting's whole climate.
  add(gear, new THREE.BoxGeometry(r * 0.34, h * 0.05, r * 0.20), 0, h * 0.325, -r * 0.30);
  // Webbing across the chest, and a belt buckle.
  for (const s of [-1, 1]) {
    add(gear, new THREE.BoxGeometry(r * 0.13, h * 0.21, r * 0.06),
      s * r * 0.32, hipY + h * 0.20, -r * 0.42);
  }
  add(gear, new THREE.BoxGeometry(r * 0.30, h * 0.04, r * 0.10), 0, hipY + h * 0.025, -r * 0.45);
  // The rifle, in three pieces so it reads as a weapon rather than a stick. Not the
  // viewmodel: that is a different module at a different level of detail, because this
  // one is only ever seen from across a deck.
  add(gear, new THREE.BoxGeometry(r * 0.15, r * 0.16, h * 0.26), 0, h * 0.145, -r * 0.90);
  add(gear, new THREE.BoxGeometry(r * 0.12, r * 0.26, r * 0.22), 0, h * 0.085, -r * 0.70);
  add(gear, new THREE.BoxGeometry(r * 0.13, r * 0.19, r * 0.40), 0, h * 0.135, -r * 0.28);

  // ---- signal: the seat colour, emissive ---------------------------------
  //
  // BANDS, not pips. These are the only thing carrying "who is that", so they have to
  // survive both distance and the shadow under the hull, and they have to be readable
  // from every side: goggles from the front, shoulders from above and either flank, the
  // lamp from astern, the patch from the front at close range.

  add(signal, new THREE.BoxGeometry(r * 0.86, h * 0.045, r * 0.14), 0, h * 0.385, -r * 0.34);
  for (const s of [-1, 1]) {
    add(signal, new THREE.BoxGeometry(r * 0.30, h * 0.035, r * 0.60), s * r * 0.60, h * 0.297, 0);
  }
  add(signal, new THREE.BoxGeometry(r * 0.36, h * 0.05, r * 0.16), 0, h * 0.200, r * 0.94);
  add(signal, new THREE.BoxGeometry(r * 0.26, h * 0.06, r * 0.06), 0, hipY + h * 0.21, -r * 0.46);

  // ---- one leg, hip at the origin -----------------------------------------
  //
  // Thigh, shin and boot, so a knee exists. The boot stays in this material rather than
  // in `gear` on purpose: a leg has to rotate as one mesh, and splitting it by material
  // would double the leg draw calls to make a dark toecap somebody sees at 20 m.

  add(leg, new THREE.BoxGeometry(r * 0.36, legLen * 0.44, r * 0.38), 0, -legLen * 0.22, 0);
  add(leg, new THREE.BoxGeometry(r * 0.32, legLen * 0.40, r * 0.34), 0, -legLen * 0.64, 0);
  add(leg, new THREE.BoxGeometry(r * 0.40, legLen * 0.16, r * 0.62), 0, -legLen * 0.92, -r * 0.10);

  return {
    canvas: mergeGeometries(canvas),
    gear: mergeGeometries(gear),
    signal: mergeGeometries(signal),
    leg: mergeGeometries(leg),
    hip: { x: r * 0.46, y: hipY },
  };
}

/**
 * Merge a list of geometries into one, position/normal/uv only.
 *
 * three ships BufferGeometryUtils for this, but it lives in examples/jsm, and
 * importing an addon from a simulation module would put a path into the harness
 * that only resolves through the dev server. Forty lines here keeps enemies.js
 * loadable from plain node.
 *
 * `rig` is OPTIONAL and parallel to `list`: one `[partCode, pivotY]` pair per input
 * geometry, written out as an `aRig` attribute so a vertex shader can tell a leg
 * from a torso without the parts being separate meshes. Omit it and nothing is
 * added, which is what world.js's three callers want -- a merged rock field has no
 * parts and no business carrying two floats per vertex for them.
 */
export function mergeGeometries(list, rig = null) {
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
  const rigAttr = rig ? new Float32Array(vertexCount * 2) : null;

  let vo = 0;
  let io = 0;
  for (let gi = 0; gi < list.length; gi++) {
    const g = list[gi];
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;

    position.set(p.array.subarray(0, p.count * 3), vo * 3);
    if (n) normal.set(n.array.subarray(0, n.count * 3), vo * 3);
    if (t) uv.set(t.array.subarray(0, t.count * 2), vo * 2);

    if (rigAttr) {
      // Whatever the caller said about this part, repeated for every one of its
      // vertices. Defaulting a missing entry to the body code rather than to zero
      // by accident: a part nobody classified must be inert, not a limb.
      const [code, pivot] = rig[gi] ?? [PART.BODY, 0];
      for (let i = 0; i < p.count; i++) {
        rigAttr[(vo + i) * 2] = code;
        rigAttr[(vo + i) * 2 + 1] = pivot;
      }
    }

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
  if (rigAttr) out.setAttribute("aRig", new THREE.BufferAttribute(rigAttr, 2));
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
