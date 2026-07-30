// WHERE DOES THE SIMULATION'S PER-FRAME COST ACTUALLY GO, OVER A RUN?
//
//   node tools/sim-cost-window.mjs
//
// Written to settle three conflicting readings of the same quantity, all taken on the
// same machine in the same session:
//
//   0.36 ms/frame   test 17, timing the harness's own step() just after 400 spawn
//   0.94 ms/frame   tools/sim-check-node.mjs, timing 600 frames from a fresh world
//   0.88 ms/frame   the figure carried in the steering as 53 ms of CPU per wall second
//
// The harness's step() does strictly MORE per frame than the spike's loop -- guns,
// repair, emitters, items, the purchase router, the winch -- so it cannot legitimately
// be 2.6x cheaper. One of the readings is measuring something other than what it says.
//
// Two candidate explanations, and they predict opposite things, which is why this
// measures rather than argues:
//
//   THE CLOCK. The spike uses Date.now() because it was written to run in workerd,
//   where performance.now() is frozen too. On Windows Date.now() has a coarse tick, so
//   it is the obvious suspect. Prediction: the two clocks disagree on one run.
//
//   THE CROWD'S DENSITY. 400 bodies spawn on a ring 63 m out and converge under an 8 m
//   hull. The separation query is a uniform spatial hash, so cost per body scales with
//   how many NEIGHBOURS share its cell -- near zero while they are spread around a
//   ring, and large once they are packed beneath the hull. Prediction: cost per frame
//   RISES over a run, and a short window just after spawn is the cheapest moment there
//   is. Which would make test 17's number the unrepresentative one, not the spike's.
//
// This prints both clocks and a per-window cost curve, so whichever it is is visible
// rather than inferred.

import * as THREE from "three";
import { CFG } from "../src/config.js";
import { World } from "../src/world.js";
import { Trampler } from "../src/trampler.js";
import { Player } from "../src/player.js";
import { Crew } from "../src/crew.js";
import { Horde, CHEWER } from "../src/enemies.js";
import { Director } from "../src/waves.js";
import { Weapon } from "../src/weapon.js";
import { Events } from "../src/events.js";

const STEP = 1 / CFG.loop.stepHz;
const POOL = Number(process.env.POOL ?? 400);
const WINDOW = Number(process.env.WINDOW ?? 60);
const WINDOWS = Number(process.env.WINDOWS ?? 20);

function stubInput() {
  return {
    locked: false,
    down: () => false,
    pressed: () => false,
    mouseDown: () => false,
    mousePressed: () => false,
    mouse: { dx: 0, dy: 0 },
    endFrame() {},
  };
}

function build() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 2000);
  camera.rotation.order = "YXZ";
  scene.add(camera);
  const world = new World(scene);
  const trampler = new Trampler(scene);
  const player = new Player(camera, world, trampler);
  const crew = new Crew([player]);
  const horde = new Horde(scene, trampler);
  const events = new Events();
  horde.events = events;
  const weapon = new Weapon(scene, player, horde, world, trampler);
  weapon.events = events;
  const director = new Director(horde, trampler, crew);
  scene.updateMatrixWorld(true);
  for (let i = 0; i < POOL; i++) horde.spawn(CHEWER);
  return { trampler, horde, director, player, weapon, crew, input: stubInput() };
}

/** Mean hull-space spread of the live crowd, as a stand-in for density. */
function spread(horde, trampler) {
  const p = new THREE.Vector3();
  let n = 0;
  let sx = 0;
  let sz = 0;
  let sxx = 0;
  let szz = 0;
  for (const e of horde.pool) {
    if (!e.alive) continue;
    p.set(e.x, e.y, e.z);
    trampler.worldToLocal(p);
    n++;
    sx += p.x; sz += p.z; sxx += p.x * p.x; szz += p.z * p.z;
  }
  if (n === 0) return 0;
  const vx = sxx / n - (sx / n) ** 2;
  const vz = szz / n - (sz / n) ** 2;
  return Math.sqrt(Math.max(0, vx) + Math.max(0, vz));
}

// Warm the JIT on a throwaway sim, so the first window is not measuring the compiler.
{
  const w = build();
  for (let i = 0; i < 300; i++) {
    w.trampler.update(STEP);
    w.trampler.resolveStomps(w.horde, w.crew);
    w.director.update(STEP);
    w.player.update(STEP, w.input);
    w.weapon.update(STEP, w.input);
    w.horde.update(STEP, w.crew);
  }
}

const sim = build();
console.log(
  `per-frame cost across a run: ${WINDOWS} windows of ${WINDOW} frames,`
  + ` ${POOL} bodies, both clocks\n`,
);
console.log("  window   frames     perf.now    Date.now    live   latched   spread(m)");

let totalPerf = 0;
let totalDate = 0;

for (let w = 0; w < WINDOWS; w++) {
  const p0 = performance.now();
  const d0 = Date.now();
  for (let i = 0; i < WINDOW; i++) {
    sim.trampler.update(STEP);
    sim.trampler.resolveStomps(sim.horde, sim.crew);
    sim.director.update(STEP);
    sim.player.update(STEP, sim.input);
    sim.weapon.update(STEP, sim.input);
    sim.horde.update(STEP, sim.crew);
    sim.input.endFrame();
  }
  const perfMs = performance.now() - p0;
  const dateMs = Date.now() - d0;
  totalPerf += perfMs;
  totalDate += dateMs;

  let latched = 0;
  for (const e of sim.horde.pool) if (e.alive && e.latched) latched++;

  console.log(
    `  ${String(w + 1).padStart(6)}`
    + `${String((w + 1) * WINDOW).padStart(9)}`
    + `${(perfMs / WINDOW).toFixed(3).padStart(12)}`
    + `${(dateMs / WINDOW).toFixed(3).padStart(12)}`
    + `${String(sim.horde.liveCount).padStart(7)}`
    + `${String(latched).padStart(10)}`
    + `${spread(sim.horde, sim.trampler).toFixed(1).padStart(12)}`,
  );
}

const frames = WINDOW * WINDOWS;
console.log(
  `\n  whole run: ${(totalPerf / frames).toFixed(3)} ms/frame by perf.now,`
  + ` ${(totalDate / frames).toFixed(3)} by Date.now`,
);
console.log(
  `  budget at 60 Hz: ${((totalPerf / frames) * 60).toFixed(1)} ms of CPU per wall second`,
);
console.log(
  "\n  Read the CURVE, not the total. If cost rises as spread falls, the crowd's"
  + "\n  density is the driver and a short window just after spawn is the cheapest"
  + "\n  moment in the run -- which makes it the wrong basis for a server budget.",
);
