// What the renderer is actually being asked to do, measured without a renderer.
//
//   node tools/scene-cost.mjs
//
// The scene graph is built by real three.js in plain node, so draw calls,
// shadow-caster counts and triangle budgets can all be counted exactly. That
// matters because "the game is laggy" has several possible causes with completely
// different fixes, and guessing between them is how you spend a day optimising
// the wrong thing:
//
//   many DRAW CALLS  -> CPU-side driver overhead, fixed by batching
//   many TRIANGLES   -> GPU vertex cost, fixed by simplifying or culling
//   many SHADOW CASTERS -> the whole scene drawn twice, fixed by being selective
//   full-screen PASSES  -> GPU fill rate, fixed by resolution or fewer passes
//
// The simulation cost is already known and tiny (0.4 ms/frame for 400 enemies),
// so if the frame rate is bad it is one of the four above.

import * as THREE from "three";
import { CFG } from "../src/config.js";
import { World } from "../src/world.js";
import { Trampler } from "../src/trampler.js";
import { Horde } from "../src/enemies.js";
import { Emitters } from "../src/emitters.js";
import { DeckGun } from "../src/deckgun.js";
import { Repair } from "../src/repair.js";
import { Player } from "../src/player.js";
import { Grapple } from "../src/grapple.js";
import { Weapon } from "../src/weapon.js";

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 2000);
const world = new World(scene);
const trampler = new Trampler(scene);
const player = new Player(camera, world, trampler);
const grapple = new Grapple(scene, player, trampler, world);
player.grapple = grapple;
const horde = new Horde(scene, trampler);
new Weapon(scene, player, horde, world, trampler);
new Repair(player, trampler, horde);
for (const m of CFG.deckGun.mounts) new DeckGun(scene, trampler, m);
new Emitters(scene, trampler, horde);
scene.updateMatrixWorld(true);

const triCount = (geo) => {
  if (!geo) return 0;
  if (geo.index) return geo.index.count / 3;
  const pos = geo.attributes?.position;
  return pos ? pos.count / 3 : 0;
};

const groups = new Map();
let drawCalls = 0;
let shadowCalls = 0;
let triangles = 0;
let shadowTriangles = 0;
let lights = 0;
let shadowLights = 0;
const materials = new Set();

/** Attribute a mesh to whichever subsystem owns it, for a readable breakdown. */
function owner(obj) {
  let node = obj;
  const names = [];
  while (node) {
    if (node.name) names.push(node.name);
    node = node.parent;
  }
  if (obj.name?.startsWith("horde_")) return "horde";
  if (names.includes("trampler")) return "fortress";
  return "world / scatter";
}

trampler.group.name = "trampler";

// Match WebGLRenderer: an invisible object prunes its entire subtree.
scene.traverseVisible((obj) => {
  if (obj.isLight) {
    lights++;
    if (obj.castShadow) shadowLights++;
    return;
  }
  if (!obj.isMesh && !obj.isInstancedMesh && !obj.isPoints && !obj.isLine) return;

  const tris = triCount(obj.geometry) * (obj.isInstancedMesh ? (obj.count || 1) : 1);
  const key = owner(obj);
  const g = groups.get(key) ?? { calls: 0, tris: 0, casters: 0, instanced: 0 };
  g.calls++;
  g.tris += tris;
  if (obj.castShadow) g.casters++;
  if (obj.isInstancedMesh) g.instanced++;
  groups.set(key, g);

  drawCalls++;
  triangles += tris;
  if (obj.material) {
    for (const m of [].concat(obj.material)) materials.add(m);
  }
  if (obj.castShadow) {
    shadowCalls++;
    shadowTriangles += tris;
  }
});

const pad = (s, n) => String(s).padStart(n);

console.log("\nScene cost, as built\n");
console.log("  subsystem            calls    triangles   shadow casters  instanced");
for (const [name, g] of [...groups].sort((a, b) => b[1].calls - a[1].calls)) {
  console.log(
    `  ${name.padEnd(20)}${pad(g.calls, 5)}  ${pad(Math.round(g.tris).toLocaleString(), 11)}`
    + `  ${pad(g.casters, 14)}  ${pad(g.instanced, 9)}`,
  );
}

console.log(`\n  total draw calls        ${drawCalls}`);
console.log(`  of which shadow casters ${shadowCalls}`);
console.log(`  distinct materials      ${materials.size}`);
console.log(`  triangles               ${Math.round(triangles).toLocaleString()}`);
console.log(`  triangles in shadow map ${Math.round(shadowTriangles).toLocaleString()}`);
console.log(`  lights                  ${lights} (${shadowLights} casting)`);

// A shadow-casting directional light re-draws every caster, so the real per-frame
// figure is the sum.
console.log(`\n  per-frame draw calls    ~${drawCalls + shadowCalls * shadowLights}`);

console.log("\nLighting budget");
{
  let total = 0;
  scene.traverse((o) => {
    if (o.isLight) {
      total += o.intensity;
      console.log(`  ${o.type.padEnd(20)} intensity ${o.intensity}`);
    }
  });
  console.log(`  sum of light intensities  ${total.toFixed(2)}`);
  console.log(`  environment intensity     ${CFG.world.envIntensity}`);
  console.log(`  tone mapping exposure     ${CFG.render.exposure}`);
  console.log(`  bloom threshold           ${CFG.render.bloom.threshold}`);
}

console.log("\nHorizon geometry placement (does it intrude on the play area?)");
{
  // Anything whose bounding sphere reaches inside the patrol ring is in the way,
  // has no collider, and will occlude the fight while the player walks through it.
  const patrol = CFG.world.patrolRadius;
  let worst = Infinity;
  scene.traverse((o) => {
    if (!o.isMesh || o.parent !== scene) return;
    const bs = o.geometry?.boundingSphere;
    if (!bs) return;
    const reach = bs.center.length() - bs.radius;
    if (bs.radius > 100) {
      console.log(
        `  ${o.geometry.attributes.position.count} verts, `
        + `bounding radius ${bs.radius.toFixed(0)} m, `
        + `nearest approach to the origin ${reach.toFixed(0)} m`,
      );
      worst = Math.min(worst, reach);
    }
  });
  console.log(`  patrol radius ${patrol} m — anything reaching inside that is in the way`);
}

console.log("");
