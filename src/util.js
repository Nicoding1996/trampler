import * as THREE from "three";

/** Axis-aligned box collider. Used in world space or in Trampler-local space. */
export function box(minX, minY, minZ, maxX, maxY, maxZ, tag = "") {
  return {
    min: new THREE.Vector3(minX, minY, minZ),
    max: new THREE.Vector3(maxX, maxY, maxZ),
    tag,
  };
}

/** Build a mesh that exactly matches a collider box. */
export function boxToMesh(b, material) {
  const size = new THREE.Vector3().subVectors(b.max, b.min);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), material);
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
