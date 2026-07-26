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
