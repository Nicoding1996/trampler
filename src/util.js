import * as THREE from "three";
import { tileBoxUVs } from "./look.js";

/** Axis-aligned box collider. Used in world space or in Trampler-local space. */
export function box(minX, minY, minZ, maxX, maxY, maxZ, tag = "") {
  return {
    min: new THREE.Vector3(minX, minY, minZ),
    max: new THREE.Vector3(maxX, maxY, maxZ),
    tag,
  };
}

/**
 * Build a mesh that exactly matches a collider box.
 *
 * `tile` is the size in metres of one repeat of whatever texture the material
 * carries. It matters more than it looks: BoxGeometry maps every face to 0..1, so
 * without this a 26 m hull and a 1.2 m crate sharing a material show the same
 * number of texture repeats -- the hull smeared, the crate a photograph. Passing
 * the real dimensions through makes texel density constant across the whole
 * fortress, which is most of the difference between "textured" and "finished".
 */
export function boxToMesh(b, material, tile = 2.0) {
  const size = new THREE.Vector3().subVectors(b.max, b.min);
  const geo = new THREE.BoxGeometry(size.x, size.y, size.z);
  tileBoxUVs(geo, size.x, size.y, size.z, tile);
  const mesh = new THREE.Mesh(geo, material);
  mesh.position.set(
    (b.min.x + b.max.x) / 2,
    (b.min.y + b.max.y) / 2,
    (b.min.z + b.max.z) / 2,
  );
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Deterministic RNG so the world is identical every reload. */
export function makeRandom(seed = 1337) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * A uniform [0,1) from a set of integers. ORDER-INDEPENDENT, which is the whole point.
 *
 * `makeRandom` above is a stream, and a stream's next value depends on how many draws came
 * before it. That is exactly right for anything the server decides alone — spawn bearings, wave
 * composition, road offers, shop stock, item procs — because the client is told the outcome and
 * never has to reproduce it.
 *
 * It is exactly wrong for anything the CLIENT must agree with the server about. Weapon cone
 * spread is the only such value in the project: the client fires locally so the tracer appears
 * immediately, and the server fires authoritatively, and the two have to scatter the round the
 * same way or the beam points somewhere the shot did not go. Two streams from one seed agree
 * only while they make identical draws in identical order, and they will not — a shot draws two
 * values per pellet, and a client mispredicting one shot the server refused leaves the two
 * permanently one draw apart. Not drift: two different sequences, for the rest of the run.
 *
 * Keyed on an index both sides already have, the question does not arise. A mispredicted shot
 * costs nothing because the next agreed index is unchanged.
 *
 * The mixing is the finalizer from MurmurHash3, which is a well-studied avalanche step rather
 * than something invented here: adjacent inputs have to produce unrelated outputs, or a burst of
 * pellets keyed on consecutive indices would land in a neat line instead of a cone.
 *
 * Invariant 21 is preserved: still reproducible, still no `Math.random`.
 */
export function hashUnit(...ints) {
  let h = 0x9e3779b9;
  for (const n of ints) {
    h ^= (n | 0) + 0x9e3779b9 + (h << 6) + (h >>> 2);
    h >>>= 0;
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export const damp = (current, target, rate, dt) =>
  current + (target - current) * (1 - Math.exp(-rate * dt));

export const lerp = (a, b, t) => a + (b - a) * t;

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Smooth ease in/out on [0,1]. */
export const smoothstep = (t) => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
