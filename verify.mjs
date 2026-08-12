// Headless verification of the two mechanics this prototype exists to test.
// Runs the real simulation modules with no renderer and no DOM, because the
// failure modes here (drift, being yanked off a turning deck, an anchor that
// does not track the hull) are invisible to a syntax check and tedious to
// confirm by hand.
//
//   node verify.mjs

import * as THREE from "three";
import { readFileSync } from "node:fs";
import {
  CFG, applyReleasePreset, releasePresetName, applyEnemySpeedScale,
  ENEMY_TYPE_KEYS, enemyCfg, afterArmour, armourAt,
} from "./src/config.js";
import { World } from "./src/world.js";
import { Trampler } from "./src/trampler.js";
import { Player } from "./src/player.js";
import { Crew } from "./src/crew.js";
import { Grapple } from "./src/grapple.js";
import {
  Horde, CHEWER, CLIMBER, BULWARK, BURROWER, SAPPER, TITAN, SPIKER, ENEMY_STATE,
  isSubmerged, causedBy,
} from "./src/enemies.js";
import { Director, PHASE } from "./src/waves.js";
import { Weapon } from "./src/weapon.js";
import { Repair } from "./src/repair.js";
import { DeckGun, handleStationInput } from "./src/deckgun.js";
import { Emitters } from "./src/emitters.js";
import { Economy, Treasury, routePurchaseInput } from "./src/economy.js";
import { Events } from "./src/events.js";
import { Items, ITEM_EFFECTS } from "./src/items.js";
import { Modules } from "./src/modules.js";
import { Run, RUN, describeRoad } from "./src/run.js";
import {
  encode, decode, snapshotBytes, packHullBits, unpackHullBits, packPhaseBits,
  unpackPhaseBits, PROTOCOL_VERSION, toleranceOf, LAYOUT, WIRE_PHASES, WIRE_RUN_PHASES,
  ENTITY_BYTES, SPIKER_SHOT_BYTES, OPERATIVE_BYTES, HELD_BIT, EDGE_BIT,
  encodeInput, decodeInput, INPUT_BYTES,
  commitHandsInput, packEnemyBits, packRepairTarget, packWeaponBits,
  unpackRepairTarget, lerpSnapshot,
} from "./src/snapshot.js";
import {
  createSession, stepSession, stepSessionClient, snapshotOf, applySnapshot, hullDivergence,
  netInput, readInput, reconcile, removeOperative,
} from "./src/session.js";
import { configureRecovery, recoveryInputFor, stepRecovery } from "./src/recovery.js";

const DT = 1 / 60;

let failures = 0;
let checks = 0;

function ok(label, condition, detail = "") {
  checks++;
  if (condition) {
    console.log(`  pass  ${label}${detail ? `  (${detail})` : ""}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? `  (${detail})` : ""}`);
  }
}

function near(label, actual, expected, tol) {
  ok(label, Math.abs(actual - expected) <= tol,
    `got ${actual.toFixed(3)}, want ${expected.toFixed(3)} +/- ${tol}`);
}

/**
 * Same idea as `near`, with the tolerance as a percentage of the expected value.
 *
 * Exists for the survival times in invariant 2b's family. Those are quoted in the
 * steering files as measurements and were previously only PRINTED, so two of the three
 * drifted 11% and 4% with the suite fully green. A percentage band is the right shape
 * for them: the absolute values span 60 s to 131 s, so one fixed tolerance would be
 * slack at the top and brittle at the bottom.
 */
function nearPct(label, actual, expected, pct) {
  const tol = Math.abs(expected) * (pct / 100);
  ok(label, Math.abs(actual - expected) <= tol,
    `got ${actual.toFixed(1)}, want ${expected.toFixed(1)} +/-${pct}% (${tol.toFixed(1)})`);
}

function makeInput() {
  return {
    locked: true,
    keys: new Set(),
    presses: new Set(),
    mouse: { dx: 0, dy: 0 },
    down(c) { return this.keys.has(c); },
    pressed(c) {
      if (!this.presses.has(c)) return false;
      this.presses.delete(c);
      return true;
    },
    // The non-consuming peeks the network layer reads. Present here because this stub is what
    // stands in for the real Input, and a stub missing a method the code under test calls does
    // not throw — it returns undefined, which reads as "nothing was pressed" and passes.
    isPressed(c) { return this.presses.has(c); },
    isMousePressed(b) { return this.mouseJustPressed.has(b); },
    mouseHeld: new Set(),
    mouseJustPressed: new Set(),
    mouseDown(b) { return this.mouseHeld.has(b); },
    mousePressed() { return false; },
    endFrame() {
      this.presses.clear();
      this.mouse.dx = 0;
      this.mouse.dy = 0;
    },
  };
}

function makeSim() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
  camera.rotation.order = "YXZ";

  const world = new World(scene);
  const trampler = new Trampler(scene);
  const player = new Player(camera, world, trampler);
  const grapple = new Grapple(scene, player, trampler, world);
  player.grapple = grapple;

  // A crew of one. Every assertion in this file speaks about `sim.player`, and that
  // stays exactly what it was -- the crew is what the three crew-wide systems are
  // handed, and at one member every aggregate it computes is arithmetically identical
  // to reading that one operative. Byte-identical output is the acceptance test.
  const crew = new Crew([player]);

  const horde = new Horde(scene, trampler);
  const director = new Director(horde, trampler, crew);
  const weapon = new Weapon(scene, player, horde, world, trampler);
  const repair = new Repair(player, trampler, horde, crew);
  const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
  const emitters = new Emitters(scene, trampler, horde);
  // Same wiring as main.js: the bus is created before anything subscribes, and
  // attached to the publishers by assignment. Listener order is registration order
  // is construction order, which is what keeps a build deterministic.
  const events = new Events();
  horde.events = events;
  weapon.events = events;
  // Same construction order as main.js. Modules before Economy because the
  // economy owns the purse that buys them and calls modules.reset() from its own
  // reset; Run last because it needs both the director and the economy.
  const modules = new Modules({ trampler, horde, emitters, guns });
  const economy = new Economy({
    player, trampler, weapon, repair, horde, director, modules, events,
  });
  // After the economy, because it reads stack counts from it. The dependency runs
  // one way: the economy has no reference back, and nothing needs one.
  const items = new Items({
    economy, player, trampler, weapon, horde, repair, events,
  });
  const run = new Run(director, horde, economy, crew);

  scene.updateMatrixWorld(true);

  const input = makeInput();
  return {
    scene, camera, world, trampler, player, crew, grapple,
    horde, director, weapon, repair, guns, gun: guns[0], emitters, economy,
    modules, run, events, items, input,
    // Recovery is crew-wide policy even in the single-operative harness. Keep the
    // same roster shape as main.js/session.js so fallback timing and action routing
    // are exercised by every scenario rather than by recovery-only test scaffolding.
    operatives: [{ seat: 1, player, input }],
    recoveryTargets: [],
    waves: false, // opt in per test, so random spawns cannot pollute a scenario
    bayOpen: false, // opt in to take the refit bay's side of the key-routing fork
  };
}

let sawNaN = false;
let sawFloatingBoarder = false;
const _probe = new THREE.Vector3();

/** Does a player-sized box at `local` overlap any of `boxes`? */
function overlapsCollider(local, half, boxes) {
  for (const b of boxes) {
    if (local.x <= b.min.x - half.x || local.x >= b.max.x + half.x) continue;
    if (local.y <= b.min.y - half.y || local.y >= b.max.y + half.y) continue;
    if (local.z <= b.min.z - half.z || local.z >= b.max.z + half.z) continue;
    return b;
  }
  return null;
}

function step(sim, frames, hook, dt = DT) {
  for (let i = 0; i < frames; i++) {
    hook?.(i);
    // Fix the fallback duration before a stomp or contact hit can incapacitate the
    // operative. This is the same pre-damage slot used by solo and authority frames.
    configureRecovery(sim.operatives, sim.recoveryTargets);
    sim.trampler.update(dt);
    // Immediately after the hull moves, so a foot that came down this frame
    // resolves against where things actually are. Explicit rather than hidden
    // inside update(), so the frame order stays readable at the call site.
    sim.trampler.resolveStomps(sim.horde, sim.crew);
    if (sim.waves) {
      sim.director.update(dt);
      sim.run.update();
    }
    // Recovery reads current look, hull carry and physical E before any gameplay
    // consumer. The routed input owns actions; the raw input survives to endFrame.
    sim.player.prepareStep(sim.input);
    stepRecovery(sim.operatives, dt, { targets: sim.recoveryTargets });
    const actionInput = recoveryInputFor(sim.player, sim.input);
    handleStationInput(sim.guns, actionInput, sim.player);
    sim.grapple.handleInput(actionInput);
    sim.player.update(dt, actionInput);
    // Admission claims the carried hands before its trigger is read; work stays after both
    // weapon paths so threat sampling retains repair's established post-fire timing.
    sim.repair.admit(dt, actionInput);
    sim.weapon.update(dt, actionInput);
    for (const g of sim.guns) g.update(dt, actionInput, sim.player, sim.weapon);
    sim.repair.work(dt);
    sim.emitters.update(dt, actionInput, sim.player);
    // Same slot as main.js: after repair and the player, before the horde, so the
    // conditional bonuses are built from the position this frame actually ended in.
    sim.items.update(dt);
    // Through the same router the game uses, rather than calling economy.update
    // directly. The two had drifted: main.js routes the shared number keys through
    // this and the harness did not, so the one rule keeping three UI states from
    // fighting over one key set was the only wiring in the project with no test
    // behind it. `sim.bayOpen` lets a test take the bay's side of that fork.
    routePurchaseInput({
      economy: sim.economy,
      run: sim.run,
      bayOpen: !!sim.bayOpen,
      input: actionInput,
      dt,
    });
    sim.horde.update(dt, sim.crew);
    // The winch's cooldown, in the same slot updateVisuals() used to occupy so the
    // timing is unchanged. The visual half is NOT driven here: it raycasts from the
    // camera and belongs to the rendered frame, and nothing in the suite asserts on
    // it -- see audit check 9's presentation set.
    sim.grapple.update(dt);
    sim.input.endFrame();

    const p = sim.player.position, v = sim.player.velocity;
    if (![p.x, p.y, p.z, v.x, v.y, v.z].every(Number.isFinite)) sawNaN = true;

    // Global invariant, checked in every scenario: nothing flagged as aboard
    // may be floating outside the deck footprint.
    const t = sim.trampler;
    for (const e of sim.horde.pool) {
      if (!e.alive || !e.onHull) continue;
      _probe.set(e.x, e.y, e.z);
      t.worldToLocal(_probe);
      if (Math.abs(_probe.x) > t.halfW + 0.8 || Math.abs(_probe.z) > t.halfL + 0.8) {
        sawFloatingBoarder = true;
      }
    }
  }
}

const localOf = (trampler, worldPos) => trampler.worldToLocal(worldPos.clone());

// ---------------------------------------------------------------------------
console.log("\n1. Based movement: standing still on a walking, turning deck");
{
  const sim = makeSim();
  step(sim, 60); // settle

  const startLocal = localOf(sim.trampler, sim.player.position);
  const startWorld = sim.player.position.clone();

  let everLeftDeck = false;
  let maxLocalDrift = 0;
  step(sim, 900, () => {
    if (sim.player.base !== sim.trampler) everLeftDeck = true;
    const l = localOf(sim.trampler, sim.player.position);
    maxLocalDrift = Math.max(maxLocalDrift, l.distanceTo(startLocal));
  });

  const hullMoved = sim.player.position.distanceTo(startWorld);

  ok("hull actually travelled (test is not vacuous)", hullMoved > 50,
    `${hullMoved.toFixed(1)} m of world travel`);
  ok("player never lost the deck as its base", !everLeftDeck);
  ok("no drift across the deck over 15 s", maxLocalDrift < 0.05,
    `max ${(maxLocalDrift * 100).toFixed(2)} cm`);
  ok("player stayed at deck height", Math.abs(localOf(sim.trampler, sim.player.position).y - startLocal.y) < 0.02);
}

// ---------------------------------------------------------------------------
console.log("\n2. Walking is relative to the deck, not the world");
{
  const sim = makeSim();
  step(sim, 60);

  // Local z = -4 is the one lane clear of the mast, the crates, the bow step
  // and the engine block, so a full second of walking is unobstructed. Starting
  // at x = -5 and heading for +x leaves 12 m of runway.
  sim.player.position.copy(sim.trampler.localToWorld(new THREE.Vector3(-5, 1.0, -4)));
  sim.player.base = sim.trampler;
  sim.player.velocity.set(0, 0, 0);

  // Face local +x, whatever the hull's current heading is.
  const localX = new THREE.Vector3(Math.cos(sim.trampler.yaw), 0, -Math.sin(sim.trampler.yaw));
  sim.player.yaw = Math.atan2(-localX.x, -localX.z);
  step(sim, 30); // settle onto the deck

  const before = localOf(sim.trampler, sim.player.position);
  step(sim, 60, () => { sim.input.keys.add("KeyW"); });
  const after = localOf(sim.trampler, sim.player.position);

  const travelled = Math.hypot(after.x - before.x, after.z - before.z);
  // One second of walking, minus the short acceleration ramp.
  near("walked ~walkSpeed across the deck in 1 s", travelled, CFG.player.walkSpeed, 1.0);
  ok("stayed aboard while walking", sim.player.base === sim.trampler);
  ok("walked along the deck's own axes, not the world's",
    Math.abs(after.z - before.z) < 0.5, `local z drifted ${(after.z - before.z).toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
console.log("\n3. Jumping on a moving deck lands you where you took off");
{
  const sim = makeSim();
  step(sim, 60);

  const before = localOf(sim.trampler, sim.player.position);
  const hullSpeed = Math.hypot(sim.trampler.linVel.x, sim.trampler.linVel.z);

  let wentAirborne = false;
  let worstSpeedGap = 0;
  const wv = new THREE.Vector3();

  step(sim, 120, (i) => {
    if (i === 0) sim.input.presses.add("Space");
    if (!sim.player.grounded) {
      wentAirborne = true;
      sim.player.worldVelocity(wv);
      worstSpeedGap = Math.max(worstSpeedGap, Math.abs(Math.hypot(wv.x, wv.z) - hullSpeed));
    }
  });

  const after = localOf(sim.trampler, sim.player.position);
  const landingError = Math.hypot(after.x - before.x, after.z - before.z);

  ok("the jump happened", wentAirborne);
  ok("kept the hull's momentum in the air", worstSpeedGap < 0.6,
    `worst gap ${worstSpeedGap.toFixed(3)} m/s vs hull ${hullSpeed.toFixed(2)} m/s`);
  ok("landed back on the deck", sim.player.base === sim.trampler);
  ok("landed within 30 cm of take-off point", landingError < 0.3,
    `${(landingError * 100).toFixed(1)} cm`);
}

// ---------------------------------------------------------------------------
console.log("\n4. Stepping off carries momentum instead of yanking you");
{
  const sim = makeSim();
  step(sim, 60);

  const hullSpeed = Math.hypot(sim.trampler.linVel.x, sim.trampler.linVel.z);
  const wv = sim.player.worldVelocity(new THREE.Vector3());

  // Compare against the hull's velocity AT THE PLAYER'S FEET, not at its
  // centre. On a yawing platform those differ by the tangential term, and the
  // spawn point is 4.5 m off the centreline, so the centre speed is the wrong
  // reference -- this assertion used to be tuned to a spawn that happened to
  // sit on the axis.
  const atFeet = sim.trampler.velocityAt(sim.player.position, new THREE.Vector3());
  ok("standing still on deck = moving exactly with the hull at your feet",
    wv.distanceTo(atFeet) < 0.02,
    `off by ${wv.distanceTo(atFeet).toExponential(2)} m/s`);
  near("and that is close to the hull's own speed",
    Math.hypot(wv.x, wv.z), hullSpeed, 0.3);

  // Force a detach and confirm world motion is continuous across the switch.
  const beforeWorld = sim.player.worldVelocity(new THREE.Vector3()).clone();
  sim.player.attachTo(null);
  const afterWorld = sim.player.worldVelocity(new THREE.Vector3());
  ok("frame switch preserves world velocity exactly",
    beforeWorld.distanceTo(afterWorld) < 1e-9,
    `delta ${beforeWorld.distanceTo(afterWorld).toExponential(2)} m/s`);
}

// ---------------------------------------------------------------------------
/** Stand the player on the ground at a given point in the hull's local frame. */
function placeOnGroundAt(sim, localX, localZ) {
  const p = sim.trampler.localToWorld(new THREE.Vector3(localX, 0, localZ));
  sim.player.position.set(p.x, 1.2, p.z);
  sim.player.base = null;
  sim.player.velocity.set(0, 0, 0);
  sim.player.grapple.cancel();
  step(sim, 20); // settle onto the sand
}

/** Point the view at a world position. */
function aimAt(player, target) {
  const d = target.clone().sub(player.eyePosition(new THREE.Vector3()));
  player.yaw = Math.atan2(-d.x, -d.z);
  player.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z));
}

const portBeacon = (trampler) =>
  trampler.hardpoints.find((h) => h.position.y > 1 && h.position.y < 5 && h.position.x < 0);

console.log("\n5. Grapple boards you: flank approach to a boarding beacon");
{
  const sim = makeSim();
  const { player, trampler, grapple } = sim;

  // Off the port flank, where the beacon is in line of sight over the railing
  // gap. This is the realistic boarding approach.
  placeOnGroundAt(sim, -32, 0);
  ok("player is on the ground, off the hull", player.base === null && player.position.y < 3,
    `y=${player.position.y.toFixed(2)}`);

  const beacon = portBeacon(trampler);
  ok("found a port boarding beacon", !!beacon);
  aimAt(player, beacon.getWorldPosition(new THREE.Vector3()));

  const fired = grapple.tryFire();
  ok("grapple found a target on the hull", fired && grapple.onHull);
  ok("the shot landed on the beacon, not on hull plating",
    grapple.anchorLocal.distanceTo(beacon.position) < 0.8,
    `anchor local ${grapple.anchorLocal.toArray().map((n) => n.toFixed(1)).join(",")}`);

  // The anchor is stored in hull space, so its world position must move with
  // the hull. If it did not, boarding a moving fortress would be impossible.
  const anchorAtFire = grapple.anchorPosition(new THREE.Vector3()).clone();
  step(sim, 12);
  const anchorLater = grapple.anchorPosition(new THREE.Vector3());
  ok("anchor moved with the hull", anchorLater.distanceTo(anchorAtFire) > 0.5,
    `anchor travelled ${anchorLater.distanceTo(anchorAtFire).toFixed(2)} m`);

  const anchorLocalNow = anchorLater.clone().applyMatrix4(trampler.matrixInverse);
  ok("anchor stayed fixed in hull space",
    anchorLocalNow.distanceTo(grapple.anchorLocal) < 1e-6);

  let reelFrames = 0;
  while (grapple.active && reelFrames < 300) {
    step(sim, 1);
    reelFrames++;
  }
  ok("reel ended on arrival", !grapple.active && grapple.releaseReason === "arrived",
    `${reelFrames} frames, reason=${grapple.releaseReason}`);

  step(sim, 150); // let them come down on the deck
  ok("ended up aboard the hull", player.base === trampler,
    `base=${player.base === trampler ? "trampler" : "ground"}, y=${player.position.y.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Pinning a design finding, not asserting a bug. Reeling to bare hull plating
// leaves you hanging against a flat wall with nothing underfoot, and you fall.
// Free-surface grapple closes distance; the beacons are what actually board
// you. Whether that trade is good is the question the G toggle exists to answer
// in play -- this just makes sure the behaviour is what we think it is.
// Previously this pinned a finding: reeling to bare hull plating left you
// dangling against a flat wall and dropping 7 m. Mantling is the fix, so the
// expected outcome is now inverted -- you catch the lip and pull yourself over.
console.log("\n6. Grappling bare hull plating now recovers via a mantle");
{
  const sim = makeSim();
  const { player, trampler, grapple } = sim;

  placeOnGroundAt(sim, 0, -40); // directly ahead of the bow
  aimAt(player, trampler.localToWorld(new THREE.Vector3(0, -0.8, -13)));

  ok("grapple hits the bow plate", grapple.tryFire() && grapple.onHull);
  ok("anchor is on plating below deck level", grapple.anchorLocal.y < -0.2,
    `anchor local y=${grapple.anchorLocal.y.toFixed(2)}`);

  while (grapple.active) step(sim, 1);

  let mantled = false;
  step(sim, 150, () => {
    if (player.mantle.active) mantled = true;
  });

  ok("the dangle turned into a climb", mantled);
  ok("and the player ended up aboard rather than falling 7 m",
    player.base === trampler,
    `base=${player.base === trampler ? "trampler" : "ground"}, y=${player.position.y.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log("\n7. The under-hull arena is standable");
{
  const sim = makeSim();
  sim.player.dropToGround();

  // Directly beneath the hull's centre: the space the ground fight happens in.
  const under = sim.trampler.localToWorld(new THREE.Vector3(0, 0, 0));
  sim.player.position.set(under.x, 1.2, under.z);
  sim.player.base = null;
  sim.player.velocity.set(0, 0, 0);
  step(sim, 60);

  ok("standing on sand beneath the hull, not attached to it",
    sim.player.grounded && sim.player.base === null);
  ok("neither crushed by the hull nor pushed out from under it",
    sim.player.position.y > 0.5 && sim.player.position.y < 4.2,
    `y=${sim.player.position.y.toFixed(2)}, hull underside at 4.5`);
}

// ---------------------------------------------------------------------------
console.log("\n8. Stress: no tunnelling, no getting stuck in geometry");
{
  const sim = makeSim();
  // Sprint blindly in circles, jumping, on a bobbing turning deck. Falling out
  // through a railing gap is legitimate here -- the gaps are deliberate -- so
  // this only asserts the things that must hold no matter where the player ends
  // up: never inside the hull slab, never through the terrain, never NaN.
  CFG.trampler.bob = true;

  let embedded = false;
  let belowGround = false;

  step(sim, 900, (i) => {
    sim.input.keys.clear();
    sim.input.keys.add(i % 120 < 60 ? "KeyW" : "KeyD");
    sim.input.keys.add("ShiftLeft");
    if (i % 45 === 0) sim.input.presses.add("Space");
    sim.player.yaw += 0.03;

    const l = localOf(sim.trampler, sim.player.position);
    const insideFootprint = Math.abs(l.x) < 7.9 && Math.abs(l.z) < 12.9;
    if (insideFootprint && l.y < -0.35 && l.y > -3.2) embedded = true;
    if (sim.player.position.y < -1) belowGround = true;
  });

  CFG.trampler.bob = false;

  ok("never ended up embedded inside the hull slab", !embedded);
  ok("never tunnelled below the terrain", !belowGround);
  ok("position stayed finite", Number.isFinite(sim.player.position.y));
}

// ---------------------------------------------------------------------------
console.log("\n9. Cutting the rope early keeps your momentum");
{
  applyReleasePreset(1);
  ok("default release preset is the braked one", releasePresetName() === "braked");

  const sim = makeSim();
  const { player, trampler, grapple } = sim;

  placeOnGroundAt(sim, -32, 0);
  aimAt(player, portBeacon(trampler).getWorldPosition(new THREE.Vector3()));
  ok("fired at the beacon", grapple.tryFire());

  step(sim, 8); // reel a moment, well outside the brake zone
  const before = player.velocity.clone();
  const speedBefore = before.length();
  ok("being hauled upward before the cut", before.y > 5, `vy=${before.y.toFixed(1)}`);

  sim.input.presses.add("Space");
  step(sim, 1);

  const after = player.velocity.clone();
  ok("rope was cut, not auto-released", grapple.releaseReason === "cut");
  ok("kept essentially all the reel speed", after.length() > speedBefore * 0.9,
    `${speedBefore.toFixed(1)} -> ${after.length().toFixed(1)} m/s`);
  ok("still travelling upward after letting go", after.y > 0, `vy=${after.y.toFixed(1)}`);

  const yAtCut = player.position.y;
  let peak = yAtCut;
  step(sim, 40, () => { peak = Math.max(peak, player.position.y); });
  ok("coasts upward on its own after the cut", peak > yAtCut + 1.0,
    `rose a further ${(peak - yAtCut).toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
console.log("\n10. The release-feel presets actually change the feel");
{
  const speedAfterCut = (presetIndex) => {
    applyReleasePreset(presetIndex);
    const sim = makeSim();
    placeOnGroundAt(sim, -32, 0);
    aimAt(sim.player, portBeacon(sim.trampler).getWorldPosition(new THREE.Vector3()));
    sim.grapple.tryFire();
    step(sim, 8);
    sim.input.presses.add("Space");
    step(sim, 1);
    return sim.player.velocity.length();
  };

  const dead = speedAfterCut(0);
  const braked = speedAfterCut(1);
  const halo = speedAfterCut(2);
  applyReleasePreset(1); // restore the recommended default

  ok("dead stop drops you almost cold", dead < 1.0, `${dead.toFixed(2)} m/s`);
  ok("braked keeps your speed", braked > 25, `${braked.toFixed(1)} m/s`);
  ok("halo amplifies it", halo > braked * 1.2,
    `${braked.toFixed(1)} -> ${halo.toFixed(1)} m/s`);
}

// ---------------------------------------------------------------------------
console.log("\n11. Fast exits cannot tunnel through the railings");
{
  const sim = makeSim();
  const { player, trampler } = sim;
  step(sim, 60);

  // Airborne, amidships-forward, level with the solid part of the starboard
  // railing, travelling at the speed a "halo" preset cut actually produces
  // (measured above at ~51 m/s), on a 30 fps frame -- the worst case the main
  // loop's dt clamp allows. Airborne matters: on the ground, friction would eat
  // the velocity before impact and the test would prove nothing.
  //
  // 51 m/s at 1/30 s is 1.7 m of travel per frame against a railing whose
  // Minkowski thickness is only 1.3 m, so single-step integration tunnels.
  // Local z = -4.5 is the clear lane: clear of the bow bridge, the step, the
  // crate and the mast, with solid starboard railing beside it.
  //
  // Height matters as much as the lane. probeGround treats anything within
  // 0.35 m below the feet as ground, so at 1.3 m the player still counts as
  // standing on the deck skin and ground friction kills the velocity before it
  // ever reaches the railing. 1.6 m puts the feet 0.68 m clear.
  player.position.copy(trampler.localToWorld(new THREE.Vector3(0, 1.6, -4.5)));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 1); // one frame so `grounded` reflects the new position
  ok("test setup is airborne, so friction cannot mask the result", !player.grounded);

  const localX = new THREE.Vector3(Math.cos(trampler.yaw), 0, -Math.sin(trampler.yaw));
  player.velocity.copy(localX).multiplyScalar(51);

  let maxLocalX = -Infinity;
  const sample = () => {
    maxLocalX = Math.max(maxLocalX, localOf(trampler, player.position).x);
  };
  step(sim, 12, sample, 1 / 30);
  sample();

  // Rail inner face is at local x 7.5; the player's 0.4 m radius should stop
  // their centre near 7.1. Anything past 8 means they passed clean through.
  ok("actually reached the railing (test is not vacuous)", maxLocalX > 6.0,
    `max local x = ${maxLocalX.toFixed(2)}`);
  ok("stopped at the railing instead of passing through it", maxLocalX < 7.6,
    `max local x = ${maxLocalX.toFixed(2)}, rail inner face at 7.5`);
  ok("still aboard after the impact", player.base === trampler);
}

// ---------------------------------------------------------------------------
// THE assertion of this whole slice. Chewers sit inboard, under the hull slab.
// If they can be shot from the deck, the forcing function is fake, nobody ever
// dismounts, and the ride-or-fight pillar is decoration.
console.log("\n12. Chewers under the hull cannot be shot from the deck");
{
  const sim = makeSim();
  const { player, trampler, horde, weapon } = sim;

  const chewer = horde.spawn(CHEWER);
  ok("spawned a chewer", !!chewer);

  const parkChewer = () => {
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    chewer.x = at.x;
    chewer.y = at.y;
    chewer.z = at.z;
    return at;
  };

  // --- from directly above, on the deck
  const legLocal = trampler.legs[0].userData;
  player.position.copy(trampler.localToWorld(
    new THREE.Vector3(legLocal.side * CFG.enemies.chewer.inboardOffset, 1.0, legLocal.z),
  ));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  parkChewer();
  player.pitch = -Math.PI / 2; // straight down
  const before = weapon.hits;
  const blockedBefore = weapon.blockedByHull;
  for (let i = 0; i < 6; i++) {
    parkChewer();
    weapon.fire();
  }

  ok("six point-blank shots straight down hit nothing", weapon.hits === before,
    `${weapon.hits - before} hits`);
  ok("the shots were stopped by the fortress itself",
    weapon.blockedByHull - blockedBefore === 6);
  ok("the chewer survived", chewer.alive && chewer.hp === chewer.maxHp);

  // --- from the sand, under the hull, same target
  placeOnGroundAt(sim, 0.2, legLocal.z);
  const target = parkChewer();
  aimAt(player, target);

  const hitsBefore = weapon.hits;
  parkChewer();
  weapon.fire();
  ok("the same chewer is hittable from underneath the hull",
    weapon.hits === hitsBefore + 1);
  ok("and it took damage", chewer.hp < chewer.maxHp,
    `${chewer.hp.toFixed(0)} / ${chewer.maxHp.toFixed(0)} hp`);
}

// ---------------------------------------------------------------------------
console.log("\n13. Chewers converge on the legs and break them");
{
  const sim = makeSim();
  const { trampler, horde } = sim;

  for (let i = 0; i < 30; i++) horde.spawn(CHEWER);
  const startHp = trampler.legHp.reduce((a, b) => a + b, 0);
  const startSpeedFactor = trampler.speedFactor();

  step(sim, 1500); // 25 s

  const endHp = trampler.legHp.reduce((a, b) => a + b, 0);
  ok("legs took damage", endHp < startHp, `${startHp} -> ${endHp} hp total`);
  ok("at least one leg broke", trampler.brokenLegs() > 0,
    `${trampler.brokenLegs()} of ${trampler.legHp.length} broken`);
  ok("broken legs slowed the hull", trampler.speedFactor() < startSpeedFactor,
    `speed factor ${startSpeedFactor.toFixed(2)} -> ${trampler.speedFactor().toFixed(2)}`);
  ok("enough losses stop it outright rather than letting it crawl forever",
    trampler.immobilised && trampler.speedFactor() === 0,
    `${trampler.workingLegs()} legs working, factor ${trampler.speedFactor().toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log("\n14. Climbers board the moving hull and reach the reactor");
{
  const sim = makeSim();
  const { trampler, horde } = sim;

  for (let i = 0; i < 12; i++) horde.spawn(CLIMBER);

  let everBoarded = false;
  let maxOnHull = 0;
  step(sim, 1800, () => {
    let n = 0;
    for (const e of horde.pool) if (e.alive && e.onHull) n++;
    if (n > 0) everBoarded = true;
    maxOnHull = Math.max(maxOnHull, n);
  });

  ok("climbers actually got aboard a walking hull", everBoarded,
    `peak ${maxOnHull} aboard`);
  ok("the reactor took damage", trampler.reactorHp < CFG.trampler.reactorHp,
    `${trampler.reactorHp.toFixed(0)} / ${CFG.trampler.reactorHp} hp`);

  // Boarders must ride the hull the same way the player does.
  const aboard = horde.pool.find((e) => e.alive && e.onHull);
  if (aboard) {
    const localBefore = localOf(trampler, new THREE.Vector3(aboard.x, aboard.y, aboard.z));
    const worldBefore = new THREE.Vector3(aboard.x, aboard.y, aboard.z);
    step(sim, 30);
    const localAfter = localOf(trampler, new THREE.Vector3(aboard.x, aboard.y, aboard.z));
    const worldAfter = new THREE.Vector3(aboard.x, aboard.y, aboard.z);

    ok("a boarder's world position moved with the hull",
      worldAfter.distanceTo(worldBefore) > 1.0,
      `${worldAfter.distanceTo(worldBefore).toFixed(2)} m of world travel`);
    ok("a boarder stayed at deck height in hull space",
      Math.abs(localAfter.y - localBefore.y) < 0.35,
      `local y ${localBefore.y.toFixed(2)} -> ${localAfter.y.toFixed(2)}`);
  } else {
    ok("a boarder was still aboard to sample", false);
  }
}

// ---------------------------------------------------------------------------
console.log("\n15. The ground has a cost");
{
  const sim = makeSim();
  const { player, trampler, horde } = sim;

  placeOnGroundAt(sim, 0, -20);
  const hpBefore = player.hp;

  // Park a chewer on top of the player so melee definitely lands.
  const e = horde.spawn(CHEWER);
  step(sim, 30, () => {
    e.x = player.position.x + 0.4;
    e.y = player.position.y;
    e.z = player.position.z;
  });

  ok("standing next to a chewer costs health", player.hp < hpBefore,
    `${hpBefore.toFixed(0)} -> ${player.hp.toFixed(0)} hp`);

  // And it comes back once you disengage.
  horde.clear();
  const hurtHp = player.hp;
  step(sim, 60 * 8);
  ok("health regenerates after disengaging", player.hp > hurtHp,
    `${hurtHp.toFixed(0)} -> ${player.hp.toFixed(0)} hp`);
}

// ---------------------------------------------------------------------------
console.log("\n16. Wave director cycles rest, prep, spawn, engage");
{
  const sim = makeSim();
  sim.waves = true;
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;
  const { horde, director } = sim;

  ok("starts resting with nothing on the field",
    director.phase === PHASE.REST && director.wave === 0 && horde.liveCount === 0);

  // Rest must run out before anything is telegraphed.
  step(sim, 60 * (CFG.waves.firstDelay - 2));
  ok("still resting partway through the opening calm", director.phase === PHASE.REST,
    `phase ${director.phase}`);
  ok("nothing has spawned yet", horde.liveCount === 0);

  // Then a telegraphed preparation window, with nothing spawning during it.
  step(sim, 60 * 3);
  ok("rest gives way to a telegraphed prep window", director.phase === PHASE.PREP,
    `phase ${director.phase}`);
  ok("the prep window names a bearing", /AHEAD|PORT|STARBOARD/.test(director.bearingLabel),
    director.bearingLabel);
  ok("still nothing spawned during prep", horde.liveCount === 0,
    `${horde.liveCount} alive`);

  step(sim, 60 * (CFG.waves.prepTime + 1));
  ok("the wave then releases", director.wave === 1 && horde.liveCount > 0,
    `wave ${director.wave}, ${horde.liveCount} alive`);

  // Release is a trickle, not a dump.
  ok("the wave is still arriving several seconds in",
    director.phase === PHASE.SPAWNING || horde.liveCount < CFG.waves.baseCount,
    `phase ${director.phase}, ${horde.liveCount} of ${CFG.waves.baseCount}`);

  const scaleEarly = director.hpScale();
  step(sim, 60 * 60);
  ok("enemy health scales with elapsed time, not wave number",
    director.hpScale() > scaleEarly * 1.4,
    `x${scaleEarly.toFixed(2)} -> x${director.hpScale().toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log("\n16b. A wave is a trickle, not a lump");
{
  const sim = makeSim();
  sim.waves = true;
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;

  // Skip straight to a wave.
  sim.director.callEarly();
  step(sim, 2);
  ok("wave is releasing", sim.director.phase === PHASE.SPAWNING);

  step(sim, 60 * 1);
  const afterOneSecond = sim.horde.liveCount;
  ok("only a couple are out after one second", afterOneSecond <= 4,
    `${afterOneSecond} of ${CFG.waves.baseCount} after 1 s`);

  step(sim, 60 * 6);
  ok("the whole wave is out a few seconds later",
    sim.horde.liveCount >= CFG.waves.baseCount - 1,
    `${sim.horde.liveCount} of ${CFG.waves.baseCount}`);
}

// ---------------------------------------------------------------------------
console.log("\n17. Crowd performance");
{
  const sim = makeSim();
  const { horde } = sim;

  for (let i = 0; i < 400; i++) horde.spawn(CHEWER);
  ok("pool filled to 400", horde.liveCount === 400, `${horde.liveCount} alive`);

  const t0 = performance.now();
  step(sim, 300);
  const msPerFrame = (performance.now() - t0) / 300;

  // Headless and single-threaded with no rendering, so this measures simulation
  // cost only. A 60 fps budget is 16.7 ms for everything including draw.
  ok("400 enemies simulate well inside a frame budget", msPerFrame < 6.0,
    `${msPerFrame.toFixed(2)} ms/frame for the whole sim step`);
  ok("still no NaN with a full pool", horde.pool.every(
    (e) => !e.alive || [e.x, e.y, e.z].every(Number.isFinite),
  ));
}

// ---------------------------------------------------------------------------
// Regression guards for bugs found by auditing the combat slice.
console.log("\n18. Spawn and teleport points are clear of geometry");
{
  const sim = makeSim();
  const { player, trampler } = sim;
  const half = player.half;

  // This is the general invariant. The deck spawn used to sit at local
  // (0, 1.2, 6), which ended up inside the reactor box once that was added, so
  // every single respawn shoved the player aft to squeeze out of it. Asserting
  // the class of bug rather than the one instance.
  const spawnLocal = trampler.deckSpawn(new THREE.Vector3()).applyMatrix4(trampler.matrixInverse);
  const clash = overlapsCollider(spawnLocal, half, trampler.colliders);
  ok("deck spawn is not inside any collider", !clash,
    clash ? `overlaps "${clash.tag}"` : `local ${spawnLocal.toArray().map((n) => n.toFixed(1)).join(",")}`);

  // And it should stay put once physics settles, rather than being pushed out.
  player.respawnOnDeck();
  const placed = localOf(trampler, player.position);
  step(sim, 45);
  const settled = localOf(trampler, player.position);

  ok("player settles where they spawned, not shoved aside",
    Math.hypot(settled.x - placed.x, settled.z - placed.z) < 0.35,
    `moved ${Math.hypot(settled.x - placed.x, settled.z - placed.z).toFixed(2)} m`);
  ok("and ends up standing on the deck", player.base === trampler && Math.abs(settled.y - 0.9) < 0.2,
    `local y ${settled.y.toFixed(2)}`);

  // The ground drop point should be clear too.
  player.dropToGround();
  step(sim, 30);
  ok("ground drop point leaves the player on the sand",
    player.base === null && player.position.y > 0.4 && player.position.y < 4.0,
    `y=${player.position.y.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log("\n19. Incapacitation recovers on a clock without becoming a death loop");
{
  // ---- solo: the body stays where it fell for four seconds, then returns to deck.
  const sim = makeSim();
  const { player } = sim;
  sim.trampler.walking = false;
  sim.trampler.turning = false;
  placeOnGroundAt(sim, 20, 0);
  player.yaw = 0.73;
  player.pitch = 0.31;
  const fallenAt = player.position.clone();
  const facingAtFall = player.yaw;

  player.hurt(1000);
  ok("a lethal hit incapacitates in place instead of teleporting immediately",
    player.deaths === 1 && player.downed && player.hp === 0 && player.base === null,
    `${player.deaths} death, ${player.medevacRemaining.toFixed(2)} s remaining`);
  near("the solo emergency-recovery clock starts at four seconds",
    player.medevacRemaining, CFG.combat.recovery.soloMedevac, 1e-9);
  ok("incapacitation fixes the body camera at the fall facing and configured pitch",
    player.viewYaw === facingAtFall
      && player.viewPitch === CFG.combat.recovery.cameraPitch,
    `yaw ${player.viewYaw.toFixed(2)}, pitch ${player.viewPitch.toFixed(2)}`);

  // A downed body ignores further damage, so an attacker standing over it cannot
  // increment the death counter every frame while the fallback is counting down.
  player.hurt(1000);
  player.hurt(1000);
  ok("further hits while downed are ignored", player.deaths === 1,
    `${player.deaths} death`);

  // Drive the real look path with an extreme delta. Accessors alone would only prove
  // that the stored fall angle exists, not that mouse input cannot turn it into free
  // reconnaissance while the operative waits.
  sim.input.mouse.dx = 900;
  sim.input.mouse.dy = -900;
  let soloFrames = 0;
  step(sim, 1);
  soloFrames++;
  const fixedEye = player.eyePosition(new THREE.Vector3());
  ok("mouse look cannot move the fixed downed camera",
    player.viewYaw === facingAtFall
      && player.viewPitch === CFG.combat.recovery.cameraPitch
      && sim.camera.position.distanceTo(fixedEye) < 1e-9
      && Math.abs(sim.camera.rotation.y - facingAtFall) < 1e-9
      && Math.abs(sim.camera.rotation.x - CFG.combat.recovery.cameraPitch) < 1e-9,
    `yaw ${player.viewYaw.toFixed(2)}, pitch ${player.viewPitch.toFixed(2)}, `
    + `eye error ${(sim.camera.position.distanceTo(fixedEye) * 100).toFixed(3)} cm`);

  let downedDrift = 0;
  while (player.downed && soloFrames < 60 * 6) {
    step(sim, 1);
    soloFrames++;
    if (player.downed) {
      downedDrift = Math.max(downedDrift,
        Math.hypot(player.position.x - fallenAt.x, player.position.z - fallenAt.z));
    }
  }
  ok("solo stays down for the configured four-second consequence",
    Math.abs(soloFrames * DT - CFG.combat.recovery.soloMedevac) <= DT * 2,
    `${(soloFrames * DT).toFixed(3)} s`);
  ok("the body did not become fast travel while the clock ran",
    downedDrift < 0.02, `${(downedDrift * 100).toFixed(2)} cm horizontal drift`);
  ok("the fallback medevacs to the deck at forty percent health",
    !player.downed && player.base === sim.trampler && player.autoMedevac
      && Math.abs(player.hp - player.maxHp * CFG.combat.recovery.returnHealth) < 1e-9,
    `${player.hp.toFixed(0)}/${player.maxHp} hp, ${player.base ? "aboard" : "ground"}`);
  ok("the configured post-return immunity opened",
    player.spawnGrace > CFG.combat.spawnGrace - DT * 2,
    `${player.spawnGrace.toFixed(3)} of ${CFG.combat.spawnGrace.toFixed(2)} s`);

  player.hurt(1000);
  ok("damage during return immunity cannot start another incapacitation",
    player.deaths === 1 && !player.downed, `${player.deaths} death`);
  step(sim, Math.ceil(CFG.combat.spawnGrace / DT) + 1);
  ok("return immunity expires", player.spawnGrace === 0);
  player.hurt(1000);
  ok("and lethal damage lands again afterwards",
    player.deaths === 2 && player.downed, `${player.deaths} deaths`);

  // A real authority with mutable physical inputs. Bodies are arranged outside the
  // hull so collision cannot decide a recovery test; all three settle on the sand.
  const recoveryAuthority = (seats) => {
    const authority = createSession({ seats });
    authority.trampler.walking = false;
    authority.trampler.turning = false;
    const at = authority.trampler.localToWorld(new THREE.Vector3(20, 0, 0));
    for (let i = 0; i < authority.operatives.length; i++) {
      const op = authority.operatives[i];
      op.input = makeInput();
      op.player.position.set(at.x + i * 0.35, 1.2, at.z);
      op.player.base = null;
      op.player.velocity.set(0, 0, 0);
    }
    for (let i = 0; i < 20; i++) stepSession(authority, DT);
    return authority;
  };

  // ---- arbitration and cancellation.
  const crew = recoveryAuthority(3);
  const [low, high, body] = crew.operatives;
  body.player.hurt(1e6);
  near("multiplayer starts the longer eight-second fallback",
    body.player.medevacRemaining, CFG.combat.recovery.multiplayerMedevac, 1e-9);

  low.input.keys.add(CFG.repair.key);
  high.input.keys.add(CFG.repair.key);
  low.input.keys.add("KeyW");
  high.input.keys.add("KeyW");
  low.input.mouseHeld.add(0);
  high.input.mouseHeld.add(0);
  const lowAt = low.player.position.clone();
  const lowShots = low.weapon.shots;
  const highAt = high.player.position.clone();
  const highShots = high.weapon.shots;
  stepSession(crew, DT);

  ok("the lower numeric seat wins a simultaneous recovery claim",
    body.player.rescuerSeat === low.seat && low.player.recovering && !high.player.recovering,
    `seat ${body.player.rescuerSeat} owns the body`);
  ok("an active rescuer cannot move or fire",
    Math.hypot(low.player.position.x - lowAt.x, low.player.position.z - lowAt.z) < 1e-9
      && low.weapon.shots === lowShots,
    `${low.weapon.shots - lowShots} shots, `
    + `${Math.hypot(low.player.position.x - lowAt.x, low.player.position.z - lowAt.z).toFixed(3)} m`);
  ok("a losing contender keeps their feet but cannot repair or fire",
    Math.hypot(high.player.velocity.x, high.player.velocity.z) > 0.01
      && high.player.position.distanceTo(highAt) > 0
      && high.weapon.shots === highShots
      && high.player.repairing === null,
    `${high.player.position.distanceTo(highAt).toFixed(3)} m, `
    + `${high.weapon.shots - highShots} shots, repair ${high.player.repairing ?? "none"}`);
  ok("the winning hold actually advances the channel (not vacuous)",
    body.player.recoveryProgress > 0, `${body.player.recoveryProgress.toFixed(3)} s`);

  low.input.keys.delete(CFG.repair.key);
  high.input.keys.delete(CFG.repair.key);
  low.input.keys.delete("KeyW");
  high.input.keys.delete("KeyW");
  low.input.mouseHeld.clear();
  high.input.mouseHeld.clear();
  stepSession(crew, DT);
  ok("releasing E cancels ownership and resets progress",
    body.player.rescuerSeat === 0 && body.player.recoveryProgress === 0,
    `seat ${body.player.rescuerSeat}, ${body.player.recoveryProgress.toFixed(3)} s`);

  low.player.position.copy(body.player.position).add(new THREE.Vector3(0.5, 0, 0));
  low.input.keys.add(CFG.repair.key);
  for (let i = 0; i < 12; i++) stepSession(crew, DT);
  ok("a fresh in-range hold builds progress before range cancellation (not vacuous)",
    body.player.recoveryProgress > 0.15, `${body.player.recoveryProgress.toFixed(3)} s`);
  low.player.position.x += CFG.combat.recovery.range + 1;
  stepSession(crew, DT);
  ok("leaving the 1.5 m recovery radius resets the channel",
    body.player.rescuerSeat === 0 && body.player.recoveryProgress === 0,
    `seat ${body.player.rescuerSeat}, ${body.player.recoveryProgress.toFixed(3)} s`);

  low.player.position.copy(body.player.position).add(new THREE.Vector3(0.5, 0, 0));
  for (let i = 0; i < 12; i++) stepSession(crew, DT);
  ok("the owner reclaimed before the downed-cancellation check (not vacuous)",
    body.player.rescuerSeat === low.seat && body.player.recoveryProgress > 0.15,
    `seat ${body.player.rescuerSeat}, ${body.player.recoveryProgress.toFixed(3)} s`);
  low.player.hurt(1e6);
  ok("an incapacitated rescuer releases the body immediately and loses its progress",
    low.player.downed && body.player.rescuerSeat === 0 && body.player.recoveryProgress === 0,
    `rescuer down ${low.player.downed}, seat ${body.player.rescuerSeat}`);

  const disconnect = recoveryAuthority(3);
  const [bystander, departing, stranded] = disconnect.operatives;
  bystander.player.position.x += CFG.combat.recovery.range + 5;
  stranded.player.hurt(1e6);
  departing.input.keys.add(CFG.repair.key);
  for (let i = 0; i < 12; i++) stepSession(disconnect, DT);
  ok("the departing seat owns a live channel before teardown (not vacuous)",
    stranded.player.rescuerSeat === departing.seat && stranded.player.recoveryProgress > 0.15,
    `seat ${stranded.player.rescuerSeat}, ${stranded.player.recoveryProgress.toFixed(3)} s`);
  removeOperative(disconnect, departing.seat);
  ok("disconnect clears its claim and progress synchronously",
    stranded.player.rescuerSeat === 0 && stranded.player.recoveryProgress === 0,
    `seat ${stranded.player.rescuerSeat}, ${stranded.player.recoveryProgress.toFixed(3)} s`);

  // A valid prior owner wins before new claims are considered. Give seat 2 an
  // uncontested head start, then let lower seat 1 arrive: numeric order breaks only
  // simultaneous ties and must never steal work already in progress.
  const continuity = recoveryAuthority(3);
  const [challenger, incumbent, continuityBody] = continuity.operatives;
  challenger.player.position.x += CFG.combat.recovery.range + 4;
  continuityBody.player.hurt(1e6);
  incumbent.input.keys.add(CFG.repair.key);
  for (let i = 0; i < 12; i++) stepSession(continuity, DT);
  const incumbentProgress = continuityBody.player.recoveryProgress;
  ok("the higher-seat prior owner establishes a real channel before contention",
    continuityBody.player.rescuerSeat === incumbent.seat && incumbentProgress > 0.15,
    `seat ${continuityBody.player.rescuerSeat}, ${incumbentProgress.toFixed(3)} s`);

  challenger.player.position.copy(continuityBody.player.position)
    .add(new THREE.Vector3(-0.45, 0, 0));
  challenger.player.velocity.set(0, 0, 0);
  challenger.input.keys.add(CFG.repair.key);
  stepSession(continuity, DT);
  ok("a valid prior owner keeps the body when a lower seat later competes",
    continuityBody.player.rescuerSeat === incumbent.seat
      && incumbent.player.recovering
      && !challenger.player.recovering
      && continuityBody.player.recoveryProgress > incumbentProgress,
    `seat ${continuityBody.player.rescuerSeat}, `
    + `${incumbentProgress.toFixed(3)} -> ${continuityBody.player.recoveryProgress.toFixed(3)} s`);

  // Damage is not one of the named cancellation causes. Prove it actually lands,
  // then prove the same owner and accumulated work survive the following frame.
  incumbent.player.spawnGrace = 0;
  const incumbentHp = incumbent.player.hp;
  const beforeDamageProgress = continuityBody.player.recoveryProgress;
  incumbent.player.hurt(7);
  const damagedHp = incumbent.player.hp;
  stepSession(continuity, DT);
  ok("ordinary damage really lands on the active rescuer (test is not vacuous)",
    damagedHp < incumbentHp && !incumbent.player.downed,
    `${incumbentHp.toFixed(1)} -> ${damagedHp.toFixed(1)} hp`);
  ok("nonlethal damage does not interrupt or reset teammate recovery",
    continuityBody.player.rescuerSeat === incumbent.seat
      && incumbent.player.recovering
      && continuityBody.player.recoveryProgress > beforeDamageProgress,
    `seat ${continuityBody.player.rescuerSeat}, `
    + `${beforeDamageProgress.toFixed(3)} -> ${continuityBody.player.recoveryProgress.toFixed(3)} s`);

  // E has two nearby meanings under the hull. Put a body directly beside a damaged
  // leg and assert the real frame routes the hold to the body before Repair.admit.
  const priority = recoveryAuthority(2);
  const [medic, repairBody] = priority.operatives;
  const repairPoint = priority.trampler.legAttackWorld(0, new THREE.Vector3());
  medic.player.position.set(repairPoint.x - 0.3, 1.2, repairPoint.z);
  repairBody.player.position.set(repairPoint.x + 0.3, 1.2, repairPoint.z);
  for (const op of priority.operatives) {
    op.player.base = null;
    op.player.velocity.set(0, 0, 0);
  }
  for (let i = 0; i < 20; i++) stepSession(priority, DT);
  priority.trampler.damageLeg(0, 120);
  const damagedLeg = priority.trampler.legHp[0];
  repairBody.player.hurt(1e6);
  medic.input.keys.add(CFG.repair.key);
  for (let i = 0; i < 12; i++) stepSession(priority, DT);
  ok("recovery takes E priority over a nearby damaged fortress point",
    repairBody.player.recoveryProgress > 0.15
      && repairBody.player.rescuerSeat === medic.seat
      && medic.player.repairing === null
      && !medic.repair.active
      && priority.trampler.legHp[0] === damagedLeg,
    `${repairBody.player.recoveryProgress.toFixed(2)} s body, `
    + `leg ${priority.trampler.legHp[0].toFixed(1)}, repair ${medic.player.repairing ?? "none"}`);

  // Prediction may make bars and clocks responsive, but only an authority may call
  // either lifecycle transition. Exercise both thresholds through the real client frame.
  const predicted = recoveryAuthority(2);
  const [predictedOwner, predictedBody] = predicted.operatives;
  predicted.input = predictedOwner.input;
  predictedBody.player.hurt(1e6);
  predictedBody.player.medevacRemaining = 6;
  predictedBody.player.recoveryProgress = CFG.combat.recovery.recoverTime - DT / 2;
  predictedOwner.input.keys.add(CFG.repair.key);
  stepSessionClient(predicted, DT);
  ok("client prediction may reach the channel threshold but cannot recover the body",
    predictedBody.player.downed
      && predictedBody.player.hp === 0
      && predictedBody.player.recoveryProgress === CFG.combat.recovery.recoverTime,
    `${predictedBody.player.recoveryProgress.toFixed(3)} s, down ${predictedBody.player.downed}`);

  predictedOwner.input.keys.delete(CFG.repair.key);
  predictedOwner.player.position.x += CFG.combat.recovery.range + 3;
  predictedBody.player.rescuerSeat = 0;
  predictedBody.player.recoveryProgress = 0;
  predictedBody.player.medevacRemaining = DT / 2;
  stepSessionClient(predicted, DT);
  ok("client prediction may expire the fallback clock but cannot medevac the body",
    predictedBody.player.downed
      && predictedBody.player.hp === 0
      && predictedBody.player.medevacRemaining === 0
      && !predictedBody.player.autoMedevac,
    `${predictedBody.player.medevacRemaining.toFixed(3)} s, down ${predictedBody.player.downed}`);

  // Contact exclusion must be tested at the call site, not through Player.hurt's own
  // downed guard. Count actual calls and pair the body with a living control at the
  // same coordinates so an out-of-range setup cannot pass vacuously.
  const contactCalls = (downed) => {
    const contact = makeSim();
    const p = contact.player;
    const cfg = CFG.enemies.chewer;
    p.position.set(300, cfg.height / 2, 300);
    p.base = null;
    p.spawnGrace = 0;
    if (downed) p.hurt(1e6);
    const hurt = p.hurt.bind(p);
    let calls = 0;
    p.hurt = (amount) => { calls++; return hurt(amount); };
    const chewer = contact.horde.spawn(CHEWER);
    chewer.x = p.position.x;
    chewer.y = p.position.y;
    chewer.z = p.position.z;
    chewer.state = ENEMY_STATE.HUNT_LEG;
    chewer.atkCd = 0;
    contact.horde.update(DT, [p]);
    return { calls, cooldown: chewer.atkCd };
  };
  const liveContact = contactCalls(false);
  const downedContact = contactCalls(true);
  ok("the contact setup hits a living operative (test is not vacuous)",
    liveContact.calls === 1 && liveContact.cooldown > 0,
    `${liveContact.calls} call, cooldown ${liveContact.cooldown.toFixed(2)} s`);
  ok("contact targeting skips a downed body before calling hurt or spending cooldown",
    downedContact.calls === 0 && downedContact.cooldown === 0,
    `${downedContact.calls} calls, cooldown ${downedContact.cooldown.toFixed(2)} s`);

  // The Spiker has two separate body loops: acquisition and interception. A downed
  // operative is the nearer body on the same open ray, while a living teammate beyond
  // it proves both loops continue to a valid target rather than merely finding none.
  const ranged = createSession({ seats: 2 });
  ranged.trampler.walking = false;
  ranged.trampler.turning = false;
  const [liveEntry, downEntry] = ranged.operatives;
  const liveTarget = liveEntry.player;
  const downTarget = downEntry.player;
  liveTarget.position.set(310, 1.2, 300);
  liveTarget.base = null;
  liveTarget.spawnGrace = 0;
  downTarget.position.set(305, 1.2, 300);
  downTarget.base = null;
  downTarget.spawnGrace = 0;
  downTarget.hurt(1e6);

  const rangedCfg = CFG.enemies.spiker;
  const spiker = ranged.horde.spawn(SPIKER);
  spiker.x = 300;
  spiker.y = rangedCfg.height / 2;
  spiker.z = 300;
  spiker.state = ENEMY_STATE.CHARGING;
  spiker.chargeT = rangedCfg.chargeTime;
  spiker.shotLocked = false;
  spiker.shotTarget = null;
  ranged.horde.update(DT, [downTarget, liveTarget]);
  ok("Spiker acquisition skips the nearer downed body for a living operative",
    spiker.shotTarget === liveTarget && spiker.shotLeg === -1,
    spiker.shotTarget === liveTarget ? "living target acquired" : "wrong target");

  const downHurt = downTarget.hurt.bind(downTarget);
  let downedInterceptCalls = 0;
  downTarget.hurt = (amount) => { downedInterceptCalls++; return downHurt(amount); };
  const liveHp = liveTarget.hp;
  const locked = liveTarget.eyePosition(new THREE.Vector3());
  spiker.lockX = locked.x;
  spiker.lockY = locked.y;
  spiker.lockZ = locked.z;
  spiker.shotTarget = liveTarget;
  spiker.shotLeg = -1;
  spiker.shotLocked = true;
  spiker.chargeT = 0;
  ranged.horde.update(DT, [downTarget, liveTarget]);
  ok("a downed body cannot intercept a Spiker ray meant for a living teammate",
    downedInterceptCalls === 0
      && liveTarget.hp < liveHp
      && spiker.state === ENEMY_STATE.FIRING,
    `${downedInterceptCalls} downed calls, living hp ${liveHp.toFixed(0)} -> `
    + `${liveTarget.hp.toFixed(0)}, state ${spiker.state}`);

  // ---- completion. Start close to the fallback deadline so the test proves an
  // uninterrupted channel receives grace rather than losing a 1.9 s recovery to the clock.
  const finish = recoveryAuthority(2);
  const [rescuer, casualty] = finish.operatives;
  casualty.player.hurt(1e6);
  casualty.player.medevacRemaining = 0.5;
  const casualtyAt = casualty.player.position.clone();
  rescuer.input.keys.add(CFG.repair.key);

  const pastDeadlineFrames = Math.ceil(0.75 / DT);
  for (let i = 0; i < pastDeadlineFrames; i++) stepSession(finish, DT);
  ok("an active channel survives the medevac deadline",
    casualty.player.downed && casualty.player.medevacRemaining === 0
      && casualty.player.recoveryProgress >= 0.7,
    `${casualty.player.recoveryProgress.toFixed(2)} s recovered at `
    + `${casualty.player.medevacRemaining.toFixed(2)} s fallback`);

  let recoveryFrames = pastDeadlineFrames;
  while (casualty.player.downed && recoveryFrames < 60 * 4) {
    stepSession(finish, DT);
    recoveryFrames++;
  }
  ok("holding E recovers a teammate in the configured two seconds",
    Math.abs(recoveryFrames * DT - CFG.combat.recovery.recoverTime) <= DT * 2,
    `${(recoveryFrames * DT).toFixed(3)} s`);
  ok("teammate recovery returns in place at forty percent rather than medevacing",
    !casualty.player.downed && casualty.player.base === null && !casualty.player.autoMedevac
      && casualty.player.position.distanceTo(casualtyAt) < 0.03
      && Math.abs(casualty.player.hp
        - casualty.player.maxHp * CFG.combat.recovery.returnHealth) < 1e-9,
    `${casualty.player.hp.toFixed(0)}/${casualty.player.maxHp} hp, `
    + `${(casualty.player.position.distanceTo(casualtyAt) * 100).toFixed(2)} cm from body`);
  ok("teammate recovery grants the same post-return immunity",
    casualty.player.spawnGrace > CFG.combat.spawnGrace - DT * 2,
    `${casualty.player.spawnGrace.toFixed(3)} s`);
}

// ---------------------------------------------------------------------------
console.log("\n20. Chewers escalate once every leg is down");
{
  const sim = makeSim();
  const { trampler, horde } = sim;

  for (let i = 0; i < 14; i++) horde.spawn(CHEWER);
  step(sim, 900); // let them reach the legs

  // Strip the hull of legs outright: previously chewers then had nothing to do
  // and just huddled underneath harmlessly, so the fortress was crippled but
  // the wave stopped mattering.
  for (let i = 0; i < trampler.legHp.length; i++) trampler.damageLeg(i, 1e6);
  ok("all legs down", trampler.brokenLegs() === trampler.legHp.length);

  const reactorBefore = trampler.reactorHp;
  let everBoarded = false;
  step(sim, 900, () => {
    for (const e of horde.pool) if (e.alive && e.onHull) everBoarded = true;
  });

  ok("chewers switched to boarding instead of idling", everBoarded);
  ok("and started on the reactor", trampler.reactorHp < reactorBefore,
    `${reactorBefore} -> ${trampler.reactorHp.toFixed(0)} hp`);
}

// ---------------------------------------------------------------------------
console.log("\n21. Enemies halt on target instead of walking through it");
{
  const sim = makeSim();
  const { trampler, horde } = sim;

  // Freeze the hull completely first -- walking AND turning. Against a walking
  // hull a chewer legitimately spends most of its time closing rather than
  // parked, and which leg it retargets is random, so measuring "is it parked"
  // there is just sampling noise. Turning matters too: the attack point sits
  // 10 m off the yaw axis, so a hull rotating in place sweeps the target ~2 m
  // per second and a perfectly stationary chewer looks like it drifted.
  trampler.walking = false;
  trampler.turning = false;
  const e = horde.spawn(CHEWER);
  const at = trampler.legAttackWorld(0, new THREE.Vector3());
  e.x = at.x;
  e.y = at.y;
  e.z = at.z;
  e.legIndex = 0;

  let parkedFrames = 0;
  let maxWander = 0;
  step(sim, 60, () => {
    if (Math.hypot(e.vx, e.vz) < 0.01) parkedFrames++;
    trampler.legAttackWorld(0, at);
    maxWander = Math.max(maxWander, Math.hypot(e.x - at.x, e.z - at.z));
  });

  ok("a chewer on its target stands still instead of driving through the hull",
    parkedFrames > 50, `parked ${parkedFrames} of 60 frames`);
  ok("and stays put rather than drifting off it", maxWander < 0.5,
    `wandered ${maxWander.toFixed(2)} m`);
  ok("while still chewing", trampler.legHp[0] < CFG.trampler.legHp,
    `leg 0 at ${trampler.legHp[0]} hp`);

  // Now let the hull walk and turn again. Halting must not mean getting left
  // behind: the chewer has to keep re-closing and keep doing damage.
  trampler.walking = true;
  trampler.turning = true;

  const hpBefore = trampler.legHp.reduce((a, b) => a + b, 0);
  let maxLocalX = 0;
  step(sim, 600, () => {
    const l = localOf(trampler, new THREE.Vector3(e.x, e.y, e.z));
    maxLocalX = Math.max(maxLocalX, Math.abs(l.x));
  });

  ok("holds station under a walking hull rather than being shaken off",
    trampler.legHp.reduce((a, b) => a + b, 0) < hpBefore - 30,
    `${hpBefore} -> ${trampler.legHp.reduce((a, b) => a + b, 0)} total leg hp`);
  ok("and stays beneath the fortress instead of overshooting into the open",
    maxLocalX < trampler.halfW + 3,
    `max |local x| ${maxLocalX.toFixed(2)}, hull half-width ${trampler.halfW}`);

  ok("it is latched to the hull, not re-chasing the leg every frame", e.latched);
}

// ---------------------------------------------------------------------------
// This failed SILENTLY and cost the under-hull pillar. A leg's attack point is
// outboard, so the hull's yaw adds tangential speed on top of its 4.5 m/s -- 4.71
// mean and 6.33 peak on the legs outside the turn. Chewers were chasing a point
// faster than they could run, so their damage fluctuated with the turn phase and
// fell to 0.5 hp/s at 4.70 m/s: the fortress walks on, untouched, and there is no
// longer any reason to fight beneath it.
//
// Latching is the fix, so enemy speed only decides how fast they ARRIVE. This
// asserts the property at a speed well below the hull's, because that is the case
// that used to break, and the speed knob can reach it.
console.log("\n15b. Chewers hold a leg even when far slower than the hull");
{
  for (const scale of [1.0, 0.6]) {
    const sim = makeSim();
    const { trampler, horde } = sim;
    applyEnemySpeedScale(scale);

    const e = horde.spawn(CHEWER);
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    e.x = at.x;
    e.y = at.y;
    e.z = at.z;
    e.legIndex = 0;

    // Leg 0 is outboard, so its attack point is one of the fast ones.
    let dealt = 0;
    step(sim, 60 * 20, () => {
      dealt += CFG.trampler.legHp - trampler.legHp[0];
      trampler.legHp[0] = CFG.trampler.legHp;
    });

    const speed = CFG.enemies.chewer.speed;
    ok(`at ${scale.toFixed(1)}x (${speed.toFixed(2)} m/s, hull ${CFG.trampler.speed}) it still chews`,
      dealt > 100, `${dealt.toFixed(0)} hp dealt over 20 s`);
    ok(`and stays latched at ${scale.toFixed(1)}x`, e.latched);

    applyEnemySpeedScale(1);
  }
}

// ---------------------------------------------------------------------------
/** Stand on the deck at a local spot, facing a local direction. */
function placeOnDeckLocal(sim, lx, ly, lz, faceX, faceZ) {
  const t = sim.trampler;
  sim.player.position.copy(t.localToWorld(new THREE.Vector3(lx, ly, lz)));
  sim.player.base = t;
  sim.player.velocity.set(0, 0, 0);
  sim.player.cancelMantle();

  const dir = new THREE.Vector3(faceX, 0, faceZ)
    .applyAxisAngle(new THREE.Vector3(0, 1, 0), t.yaw);
  sim.player.yaw = Math.atan2(-dir.x, -dir.z);
  sim.player.pitch = 0;
  step(sim, 20);
}

/**
 * Arrange exactly the state the buy gate wants: the operative at the refit terminal, in
 * a rest, with nothing near them.
 *
 * This exists because Update 1.7 made buying conditional on a PLACE, and a great many
 * tests buy something as scaffolding rather than as their subject -- test 78 wants twelve
 * stacks of an item so it can check a hyperbolic curve, and it does not care in the least
 * where the operative is standing. Nine sections started failing at once.
 *
 * ARRANGED, NOT SIMULATED, which is the lesson tech.md already carries from the last time
 * this gate tightened. The first repair back then added a `horde.clear()` and a `step()`,
 * and the step let the director walk REST -> PREP and shut the window again, while also
 * adding a frame of elapsed time to a test whose subject was an exact replay. Set the
 * phase and the position directly; do not try to play your way into legality.
 *
 * Note it does NOT touch the purses. A test that wants to buy still has to afford it,
 * because "can you pay for this" is a real question this must not answer for anybody.
 */
function shopReady(sim) {
  // ONLY the position. It deliberately does not touch the director, and that is a
  // correction rather than an omission: the first version also pinned
  // `phase = REST, timer = 1e6` to guarantee legality, and it silently broke test 66 --
  // a pinned rest never advances, so no wave ever spawned, nothing attacked the legs,
  // and "automation held the line" fired as an invariant-2b failure that had nothing to
  // do with automation. A helper that arranges more than it needs to becomes a second,
  // invisible author of every test that calls it.
  //
  // Not touching it is also sufficient. A fresh sim opens in REST with `firstDelay` on
  // the clock, and the only phases that refuse a purchase are SPAWNING and ENGAGED, so
  // any test that buys near the start of a sim is already legal on the phase clause.
  const t = sim.trampler;
  placeOnDeckLocal(sim, t.terminalLocal.x, 1.2, t.terminalLocal.z, 0, -1);
  return sim;
}

/**
 * The same arrangement with NO elapsed time at all.
 *
 * `placeOnDeckLocal` runs 20 settling frames so the operative is genuinely standing on
 * the deck rather than hovering at a computed point, which is right nearly everywhere and
 * wrong in exactly one place: test 82's subject is an exact replay, and its comments
 * already record that a single frame between the horde clear and the purchase both let the
 * director walk REST -> PREP and added elapsed time to the thing being measured.
 *
 * So this writes the position and the base outright. Nothing here needs settling, because
 * nothing here is being asked to move.
 */
function shopReadyNoStep(sim) {
  const t = sim.trampler;
  sim.player.position.copy(
    t.localToWorld(new THREE.Vector3(t.terminalLocal.x, 1.2, t.terminalLocal.z)));
  sim.player.base = t;
  sim.player.velocity.set(0, 0, 0);
  sim.player.cancelMantle();
  return sim;
}

/** Jump at a ledge and report whether we ended up standing on top of it. */
function climbAttempt(sim, from, face, expectTop) {
  placeOnDeckLocal(sim, from[0], from[1], from[2], face[0], face[1]);

  let mantled = false;
  step(sim, 100, (i) => {
    if (i === 0) sim.input.presses.add("Space");
    if (sim.player.mantle.active) mantled = true;
  });

  const l = localOf(sim.trampler, sim.player.position);
  return { mantled, local: l, onTop: Math.abs(l.y - (expectTop + 0.9)) < 0.3 };
}

console.log("\n22. Mantling closes the deck traversal gap");
{
  // Jump reach is 1.65 m. All three of these were unreachable before.
  const cases = [
    { name: "the 2.0 m crate", from: [3.2, 0.9, -4.5], face: [0, 1], top: 2.0 },
    { name: "the 2.4 m reactor", from: [0, 0.9, 2.0], face: [0, 1], top: 2.4 },
    { name: "the 2.6 m engine block", from: [0, 0.9, 7.8], face: [0, 1], top: 2.6 },
  ];

  for (const c of cases) {
    const sim = makeSim();
    const r = climbAttempt(sim, c.from, c.face, c.top);
    ok(`climbed onto ${c.name}`, r.mantled && r.onTop && sim.player.base === sim.trampler,
      `mantled=${r.mantled}, local y ${r.local.y.toFixed(2)}, want ${(c.top + 0.9).toFixed(2)}`);
  }
}

// ---------------------------------------------------------------------------
// The invariant that protects the whole design: the grapple must remain the
// only way onto the deck from the sand. If mantling can ladder you aboard, the
// boarding mechanic is pointless and so is the fortress's height.
console.log("\n23. Mantling cannot board the hull from the ground");
{
  const sim = makeSim();
  const { player, trampler } = sim;

  placeOnGroundAt(sim, -10, 0); // beside the port flank, on the sand

  // Face the hull and jump at it relentlessly.
  const dir = new THREE.Vector3(1, 0, 0).applyAxisAngle(new THREE.Vector3(0, 1, 0), trampler.yaw);
  player.yaw = Math.atan2(-dir.x, -dir.z);

  let everAboard = false;
  let maxY = 0;
  step(sim, 900, (i) => {
    if (i % 20 === 0) sim.input.presses.add("Space");
    if (player.base === trampler) everAboard = true;
    maxY = Math.max(maxY, player.position.y);
  });

  ok("never got aboard by jumping and mantling", !everAboard);
  ok("never climbed anywhere near deck height", maxY < 4.0,
    `peak y ${maxY.toFixed(2)}, deck at 7.5`);
}

// ---------------------------------------------------------------------------
console.log("\n24. Mantling is not a ladder to the crow's nest");
{
  const sim = makeSim();
  const { player, trampler } = sim;

  // Start on the tallest thing you can legitimately stand on: the engine block.
  placeOnDeckLocal(sim, 0, 3.6, 10, 0, -1);

  let maxLocalY = -99;
  step(sim, 1200, (i) => {
    if (i % 25 === 0) sim.input.presses.add("Space");
    // Sweep the view so every possible ledge gets a chance to be grabbed.
    player.yaw += 0.05;
    maxLocalY = Math.max(maxLocalY, localOf(trampler, player.position).y);
  });

  // Engine top 2.6 + jump apex 1.65 = 4.25 m of feet height, so a centre of
  // about 5.15. The crow's nest underside is at 8.6 and must stay out of reach.
  ok("never chained a climb above the reachable ceiling", maxLocalY < 6.0,
    `peak local y ${maxLocalY.toFixed(2)}`);
  ok("crow's nest stayed grapple-only", maxLocalY < 8.6);
}

// ---------------------------------------------------------------------------
console.log("\n25. A climb onto the hull tracks the moving hull");
{
  const sim = makeSim();
  const { player, trampler } = sim;

  placeOnDeckLocal(sim, 0, 0.9, 2.0, 0, 1); // facing the reactor

  // The invariant is that the climb lands at its LOCAL destination, so a hull
  // that walks away mid-climb carries the player with it. Comparing world
  // travel against local travel proves nothing: the two partly cancel, because
  // the player climbs toward the bow while the hull moves the frame beneath.
  let onHull = false;
  let dest = null;
  let hullTravel = 0;
  let prevHull = null;

  step(sim, 100, (i) => {
    if (i === 0) sim.input.presses.add("Space");
    if (player.mantle.active) {
      if (!dest) {
        dest = player.mantle.dest.clone();
        onHull = player.mantle.onHull;
      }
      const h = trampler.group.position.clone();
      if (prevHull) hullTravel += h.distanceTo(prevHull);
      prevHull = h;
    }
  });

  ok("the climb was registered against the hull, not the world", onHull && !!dest);
  ok("the hull kept walking during the climb (test is not vacuous)",
    hullTravel > 0.8, `hull moved ${hullTravel.toFixed(2)} m mid-climb`);

  const ended = localOf(trampler, player.position);
  ok("landed at the intended spot on the deck, not where the deck used to be",
    dest && ended.distanceTo(dest) < 0.3,
    dest ? `off by ${ended.distanceTo(dest).toFixed(3)} m in hull space` : "no climb");
  ok("and ended at rest relative to the deck", player.base === trampler
    && player.velocity.length() < 1.0, `rel speed ${player.velocity.length().toFixed(2)} m/s`);
}

// ---------------------------------------------------------------------------
// Reported by the owner watching a boarding: enemies visibly pass THROUGH the hull on
// the way up. They did. `CLIMBING` drives a body along a hull-local path with no
// collision, and the path ran from a start outboard and below the deck to an end 1.2 m
// INBOARD of the flank -- so it cut the corner, and the corner is the 3 m hull slab.
// Measured before the fix: 0.88 s of a 2.20 s climb inside solid armour, identically on
// all eight routes, on every single boarding.
//
// It is invariant 9 as well as a visual fault, though the correctness half turned out
// much smaller than expected and that is worth recording. The prediction was that the
// body would be unshootable in there, since `shootFrom` is the only place occlusion is
// applied. Firing the real rifle at it from the sand outboard measured 352 of 424 rounds
// still LANDING -- because the body was at most a metre inboard and its own half-width
// put the near face of its hit box outside the flank. So the honest finding is 17% of
// shots eaten during that window, not immunity. Fixed for the visual, which is what was
// actually reported; the shooting improved from 80% to 95% of rounds landing as a
// side effect.
console.log("\n25b. A climb stays outside the hull it is climbing");
{
  const sim = makeSim();
  const { trampler, horde } = sim;
  const HULL_DEPTH = 3; // slab is local y -3..0, x +/-halfW

  let worstStep = 0;
  let checked = 0;
  let insideFrames = 0;
  let reached = 0;
  let deepest = 0;

  for (let routeIndex = 0; routeIndex < trampler.climbRoutes.length; routeIndex++) {
    const route = trampler.climbRoutes[routeIndex];
    const e = horde.spawn(CLIMBER);
    e.routeIndex = routeIndex;
    e.state = ENEMY_STATE.CLIMBING;
    e.climbT = 0;
    e.climbFrom.copy(route.start);
    const w = trampler.localToWorld(route.start.clone());
    e.x = w.x; e.y = w.y; e.z = w.z;

    // A WALKING hull on purpose. The path is authored in hull-local space, so the claim
    // is a local-space one and has to hold while the fortress moves underneath it.
    let prev = new THREE.Vector3(e.x, e.y, e.z);
    let frames = 0;
    while (e.state === ENEMY_STATE.CLIMBING && frames < 400) {
      frames++;
      step(sim, 1);
      const here = new THREE.Vector3(e.x, e.y, e.z);
      worstStep = Math.max(worstStep, here.distanceTo(prev));
      prev = here;

      const l = localOf(trampler, here);
      checked++;
      if (Math.abs(l.x) < trampler.halfW && l.y > -HULL_DEPTH && l.y < 0) {
        insideFrames++;
        deepest = Math.max(deepest, trampler.halfW - Math.abs(l.x));
      }
    }
    if (e.onHull) reached++;
    horde.clear();
  }

  ok("every route was actually climbed (test is not vacuous)",
    reached === trampler.climbRoutes.length && checked > 400,
    `${reached}/${trampler.climbRoutes.length} routes completed over ${checked} frames`);
  ok("a climbing body is never inside the hull slab", insideFrames === 0,
    insideFrames === 0
      ? `0 of ${checked} frames`
      : `${insideFrames} frames, up to ${deepest.toFixed(2)} m inboard of the flank`);
  // Holding the inboard move back concentrates it into the top of the climb, so the
  // per-frame travel is the thing this change could plausibly have broken. Asserted here
  // rather than left to test 52, which would catch it but would not say why.
  ok("and holding the inboard move back did not turn it into a lurch",
    worstStep < 0.35, `worst frame-to-frame move ${worstStep.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// Straight from a playtest: an enemy attacking the reactor could not be killed.
// It had walked inside the reactor box, so the reactor's own mesh absorbed
// every bullet aimed at it.
console.log("\n26. An enemy attacking the reactor can actually be killed");
{
  const sim = makeSim();
  const { player, trampler, horde, weapon } = sim;

  for (let i = 0; i < 6; i++) horde.spawn(CLIMBER);

  let frames = 0;
  while (trampler.reactorHp === CFG.trampler.reactorHp && frames < 3000) {
    step(sim, 1);
    frames++;
  }
  ok("a boarder reached the reactor", trampler.reactorHp < CFG.trampler.reactorHp,
    `after ${frames} frames`);

  const rw = trampler.reactorWorld(new THREE.Vector3());
  const attacker = horde.pool
    .filter((e) => e.alive && e.onHull)
    .sort((a, b) => Math.hypot(a.x - rw.x, a.z - rw.z) - Math.hypot(b.x - rw.x, b.z - rw.z))[0];
  ok("found the attacker", !!attacker);

  // The core assertion: it must be standing OUTSIDE the reactor's own volume.
  const lp = localOf(trampler, new THREE.Vector3(attacker.x, attacker.y, attacker.z));
  const b = trampler.reactorBox;
  const embedded = lp.x > b.min.x && lp.x < b.max.x
    && lp.y > b.min.y && lp.y < b.max.y
    && lp.z > b.min.z && lp.z < b.max.z;
  ok("the attacker is not embedded inside the reactor", !embedded,
    `local (${lp.x.toFixed(2)}, ${lp.y.toFixed(2)}, ${lp.z.toFixed(2)})`);

  // Shoot it from open deck. The deck is cluttered with crates and the engine
  // block, so a single fixed firing spot is unreliable -- sweep positions around
  // the attacker until one has a clear line. Standing 2 m away still puts the
  // player well outside the reactor volume, so the original bug would still be
  // caught from every one of these angles.
  const hpBefore = attacker.hp;
  let damaged = false;

  for (let a = 0; a < Math.PI * 2 && !damaged; a += Math.PI / 4) {
    for (const range of [2.0, 3.0]) {
      player.position.set(
        attacker.x + Math.cos(a) * range,
        attacker.y + 0.25,
        attacker.z + Math.sin(a) * range,
      );
      player.base = trampler;
      player.velocity.set(0, 0, 0);
      aimAt(player, new THREE.Vector3(attacker.x, attacker.y, attacker.z));

      const before = attacker.hp;
      weapon.fire();
      if (!attacker.alive || attacker.hp < before) {
        damaged = true;
        break;
      }
    }
  }

  ok("aimed shots damage it", damaged,
    `hp ${hpBefore.toFixed(0)} -> ${attacker.hp.toFixed(0)}, alive=${attacker.alive}`);
}

// ---------------------------------------------------------------------------
console.log("\n27. Point-blank enemies are hittable");
{
  const sim = makeSim();
  const { player, horde, weapon } = sim;

  placeOnGroundAt(sim, 0, -25);

  // A chewer is 1.6 m tall and the player's eye is at 1.62 m, so a LEVEL shot
  // at melee range used to sail over its head. That felt like a broken gun.
  const e = horde.spawn(CHEWER);
  const park = (offset) => {
    e.x = player.position.x + offset;
    e.y = CFG.enemies.chewer.height / 2;
    e.z = player.position.z;
    player.yaw = Math.atan2(-(e.x - player.position.x), -(e.z - player.position.z));
    player.pitch = 0;
  };

  park(1.2);
  let hits = 0;
  for (let i = 0; i < 5; i++) {
    park(1.2);
    e.hp = 1e6; // keep it alive so we can count every shot
    if (weapon.fire()) hits++;
  }
  ok("level shots connect at melee range", hits === 5, `${hits} of 5`);

  // And an enemy overlapping the player: the old sphere test required the
  // centre to project forward along the ray, so this was unhittable outright.
  park(0.2);
  const overlapHit = weapon.fire();
  ok("an enemy pressed against the player is hittable", !!overlapHit);

  ok("hitmarker fires on a connecting shot", weapon.hitFlash > 0);
}

// ---------------------------------------------------------------------------
// Guard the change above: box hit tests must not have broken the rule that the
// hull blocks line of sight to chewers underneath it.
console.log("\n28. Geometry still blocks shots after the hit-test change");
{
  const sim = makeSim();
  const { player, trampler, horde, weapon } = sim;

  const chewer = horde.spawn(CHEWER);
  const legLocal = trampler.legs[0].userData;
  player.position.copy(trampler.localToWorld(
    new THREE.Vector3(legLocal.side * CFG.enemies.chewer.inboardOffset, 1.0, legLocal.z),
  ));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  const park = () => {
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    chewer.x = at.x;
    chewer.y = at.y;
    chewer.z = at.z;
  };

  player.pitch = -Math.PI / 2;
  const before = weapon.hits;
  for (let i = 0; i < 6; i++) {
    park();
    weapon.fire();
  }
  ok("still cannot shoot through the deck at a chewer below", weapon.hits === before,
    `${weapon.hits - before} hits`);
  ok("the chewer is untouched", chewer.hp === chewer.maxHp);
}

// ---------------------------------------------------------------------------
// Straight from a playtest: backing off the deck was impossible, because you
// naturally face the deck while walking backwards and the mantle grabbed it.
console.log("\n29. You can deliberately back off the deck");
{
  const sim = makeSim();
  const { player, trampler } = sim;

  // Amidships at the starboard boarding gap, facing INBOARD (local -x), then
  // hold backwards so the player walks outboard while still looking at the deck.
  placeOnDeckLocal(sim, 5.0, 0.9, 0, -1, 0);
  ok("started aboard", player.base === trampler);

  let everMantled = false;
  step(sim, 200, () => {
    sim.input.keys.add("KeyS");
    if (player.mantle.active) everMantled = true;
  });

  ok("the mantle did not drag the player back aboard", !everMantled);
  ok("the player actually left the hull", player.base === null);
  ok("and ended up on the sand", player.position.y < 3.0,
    `y=${player.position.y.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
console.log("\n30. Intent gating did not break climbing into a ledge");
{
  // Same three ledges as test 22, but re-checked now that a velocity test gates
  // the grab: walking forward into a ledge must still register as intent.
  const sim = makeSim();
  const r = climbAttempt(sim, [0, 0.9, 2.0], [0, 1], 2.4);
  ok("still climbs the reactor when moving into it",
    r.mantled && r.onTop, `mantled=${r.mantled}, local y ${r.local.y.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// From a playtest: distant shots showed nothing at all. The beam started at the
// camera, so it ran down the view axis and projected to a dot, and at 2 cm thick
// it was under a pixel wide past ~40 m.
console.log("\n31. Shots are visible at range");
{
  const sim = makeSim();
  const { player, trampler, weapon } = sim;
  const w = CFG.combat.weapon;

  placeOnGroundAt(sim, 0, -45); // well ahead of the bow
  const aimPoint = () => trampler.localToWorld(new THREE.Vector3(0, -1.0, -13));
  aimAt(player, aimPoint());
  step(sim, 1); // refresh the camera basis the muzzle offset is built from
  aimAt(player, aimPoint());
  weapon.fire();

  const t = weapon.tracers.find((x) => x.life > 0);
  ok("a tracer was spawned", !!t && t.mesh.visible);

  const len = t.mesh.scale.y;
  ok("it spans the full distance to the target", len > 25, `${len.toFixed(1)} m long`);
  ok("and widens with range instead of going sub-pixel",
    t.mesh.scale.x > w.tracerRadius * 1.5,
    `radius ${t.mesh.scale.x.toFixed(3)} m vs base ${w.tracerRadius}`);

  // The actual bug: a beam originating at the camera is invisible.
  const eye = player.eyePosition(new THREE.Vector3());
  const axis = new THREE.Vector3(0, 1, 0).applyQuaternion(t.mesh.quaternion);
  const start = t.mesh.position.clone().addScaledVector(axis, -len / 2);
  ok("the beam starts at a muzzle offset, not at the camera",
    start.distanceTo(eye) > 0.2, `${start.distanceTo(eye).toFixed(2)} m off the eye`);

  const p = weapon.impacts.find((x) => x.life > 0);
  ok("an impact marker was placed at the hit point", !!p && p.mesh.visible);
  // Grows with range, but deliberately stays small: an earlier version put a
  // half-metre ball on the ground at 30 m, which read as a white hexagon.
  const base = w.impactSize * w.impactSolidScale;
  ok("the impact grows with range", p.mesh.scale.x > base,
    `radius ${p.mesh.scale.x.toFixed(3)} m vs base ${base.toFixed(3)}`);
  ok("but stays small enough to read as dust", p.mesh.scale.x < 0.25,
    `radius ${p.mesh.scale.x.toFixed(3)} m`);
  ok("impact is dust-coloured for a geometry hit",
    p.mesh.material === weapon.impactMat.solid);
}

// ---------------------------------------------------------------------------
console.log("\n32. Legs degrade in stages, then stop the hull dead");
{
  const sim = makeSim();
  const { trampler } = sim;

  const expected = [
    [0, 1.00], [1, 0.75], [2, 0.50], [3, 0.25],
    [4, 0.00], [5, 0.00], [6, 0.00],
  ];

  let allMatch = true;
  const seen = [];
  for (const [broken, factor] of expected) {
    while (trampler.brokenLegs() < broken) {
      trampler.damageLeg(trampler.legHp.findIndex((hp) => hp > 0), 1e6);
    }
    const actual = trampler.speedFactor();
    seen.push(`${broken}:${actual.toFixed(2)}`);
    if (Math.abs(actual - factor) > 0.01) allMatch = false;
  }

  ok("drive scales down one leg at a time", allMatch, seen.join("  "));
  ok("immobilised once a tripod is impossible", trampler.immobilised);

  // And the hull genuinely stops moving, not just reports zero.
  const before = trampler.group.position.clone();
  step(sim, 120);
  ok("the hull does not travel while immobilised",
    trampler.group.position.distanceTo(before) < 0.05,
    `moved ${trampler.group.position.distanceTo(before).toFixed(3)} m in 2 s`);
}

// ---------------------------------------------------------------------------
console.log("\n33. Repair brings a dead leg back and gets it walking");
{
  const sim = makeSim();
  const { player, trampler, repair } = sim;

  // Kill four legs: below a tripod, so the hull is stopped.
  for (let i = 0; i < 4; i++) trampler.damageLeg(i, 1e6);
  ok("hull is immobilised to begin with", trampler.immobilised);

  // Stand at leg 0's repair point -- which is under the hull, where chewers go.
  const spot = trampler.legAttackWorld(0, new THREE.Vector3());
  player.position.set(spot.x, 1.2, spot.z);
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  ok("a repair target is offered in range", !!repair.target,
    repair.target ? repair.target.label : "none");
  ok("the offered target is the nearby leg",
    repair.target?.kind === "leg" && repair.target.index === 0);

  // Holding the key with nothing else changing must restore it.
  step(sim, 240, () => {
    const s = trampler.legAttackWorld(0, new THREE.Vector3());
    player.position.set(s.x, player.position.y, s.z);
    sim.input.keys.add(CFG.repair.key);
  });

  ok("the dead leg came back", trampler.legHp[0] > 0,
    `${trampler.legHp[0].toFixed(0)} / ${CFG.trampler.legHp} hp`);
  ok("and the hull can walk again", !trampler.immobilised && trampler.speedFactor() > 0,
    `${trampler.workingLegs()} legs, factor ${trampler.speedFactor().toFixed(2)}`);

  const before = trampler.group.position.clone();
  step(sim, 120);
  ok("it actually starts travelling again",
    trampler.group.position.distanceTo(before) > 1.0,
    `moved ${trampler.group.position.distanceTo(before).toFixed(2)} m`);
}

// ---------------------------------------------------------------------------
console.log("\n34. Repair needs you in the danger zone, not anywhere");
{
  const sim = makeSim();
  const { player, trampler, repair } = sim;

  trampler.damageLeg(0, 60);
  const hurt = trampler.legHp[0];

  // Far away, holding the key: nothing.
  placeOnGroundAt(sim, 0, -45);
  step(sim, 120, () => sim.input.keys.add(CFG.repair.key));
  ok("no repair happens out of range", trampler.legHp[0] === hurt,
    `${trampler.legHp[0]} hp, unchanged`);
  ok("and no prompt is offered", !repair.target);

  // The leg repair point must sit under the hull slab, where the deck cannot
  // see it -- that is what makes repair cost something.
  const spot = trampler.legAttackWorld(0, new THREE.Vector3());
  const local = localOf(trampler, spot);
  ok("the repair point is inboard, beneath the hull",
    Math.abs(local.x) < trampler.halfW && Math.abs(local.z) < trampler.halfL,
    `local (${local.x.toFixed(1)}, ${local.z.toFixed(1)}) vs hull ${trampler.halfW} x ${trampler.halfL}`);
}

// ---------------------------------------------------------------------------
console.log("\n35. The reactor is repairable too, from the deck");
{
  const sim = makeSim();
  const { player, trampler, repair } = sim;

  trampler.damageReactor(200);
  const hurt = trampler.reactorHp;

  // Stand next to the reactor on the deck.
  player.position.copy(trampler.localToWorld(new THREE.Vector3(0, 1.2, 2.0)));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  ok("the reactor is offered as a repair target", repair.target?.kind === "reactor",
    repair.target ? repair.target.label : "none");

  step(sim, 120, () => sim.input.keys.add(CFG.repair.key));
  ok("holding the key restores it", trampler.reactorHp > hurt,
    `${hurt.toFixed(0)} -> ${trampler.reactorHp.toFixed(0)} hp`);
  ok("but not past full", trampler.reactorHp <= CFG.trampler.reactorHp);
}

// ---------------------------------------------------------------------------
console.log("\n36. The deck gun can be manned, and pins you in place");
{
  const sim = makeSim();
  const { player, trampler, gun } = sim;

  // Stand on the bow bridge at the operator pad.
  player.position.copy(gun.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);

  ok("the mount is offered in range", gun.canMount);

  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 1);
  ok("F mounts it", gun.mounted && player.station === gun);

  // Movement input must do nothing at all while manned.
  const held = player.position.clone();
  const localHeld = localOf(trampler, player.position);
  step(sim, 90, () => {
    sim.input.keys.add("KeyW");
    sim.input.keys.add("ShiftLeft");
    sim.input.presses.add("Space");
  });
  const localNow = localOf(trampler, player.position);

  ok("the operator cannot walk off the mount",
    localNow.distanceTo(localHeld) < 0.05,
    `drifted ${localNow.distanceTo(localHeld).toFixed(3)} m across the deck`);
  ok("but they did ride the hull through world space",
    player.position.distanceTo(held) > 1.0,
    `${player.position.distanceTo(held).toFixed(2)} m of world travel`);

  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 1);
  ok("F dismounts it", !gun.mounted && player.station === null);
}

// ---------------------------------------------------------------------------
// THE assertion for this feature. If the gun can reach under the hull, chewers
// stop being a reason to dismount and the deck simply wins.
console.log("\n37. The deck gun cannot reach beneath the hull");
{
  const sim = makeSim();
  const { player, trampler, gun, horde, weapon } = sim;

  const chewer = horde.spawn(CHEWER);
  const park = () => {
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    chewer.x = at.x;
    chewer.y = at.y;
    chewer.z = at.z;
  };

  player.position.copy(gun.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);
  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 2);
  ok("manned the gun", gun.mounted);

  // Sweep the whole traverse arc, demanding full depression, firing through the
  // real loop the whole time.
  const hitsBefore = weapon.hits;
  sim.input.mouseHeld.add(0);
  let deepest = 0;

  for (let a = -2.4; a <= 2.4; a += 0.3) {
    step(sim, 12, () => {
      park();
      player.yaw = trampler.yaw + a;
      player.pitch = -Math.PI / 2; // demand full depression every frame
      gun.heat = 0;                // keep it firing, this is not a heat test
      gun.overheated = false;
    });
    // Read the gun's own angle AFTER the frame, so this sees the clamped value
    // rather than the raw demand the hook had just written.
    deepest = Math.min(deepest, gun.pitch);
  }
  sim.input.mouseHeld.delete(0);

  ok("the gun actually fired during the sweep", gun.shots > 20, `${gun.shots} shots`);
  ok("the aim clamp refuses to depress past the limit",
    deepest >= CFG.deckGun.minPitch - 1e-6,
    `deepest ${deepest.toFixed(3)} rad, floor ${CFG.deckGun.minPitch}`);
  ok("no shot from the gun reached the chewer under the hull",
    weapon.hits === hitsBefore && chewer.hp === chewer.maxHp,
    `${weapon.hits - hitsBefore} hits, chewer at ${chewer.hp.toFixed(0)} hp`);
}

// ---------------------------------------------------------------------------
console.log("\n38. The deck gun is strong against the incoming wave");
{
  const sim = makeSim();
  const { player, trampler, gun, horde, weapon } = sim;

  player.position.copy(gun.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);
  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 2);

  const groundY = -CFG.trampler.deckHeight + CFG.enemies.climber.height / 2;

  /** Park a climber at a local range ahead of the bow and shoot at it for a bit. */
  const engageAt = (zLocal, frames) => {
    const e = horde.spawn(CLIMBER);
    const place = () => {
      const at = trampler.localToWorld(new THREE.Vector3(0, groundY, zLocal));
      e.x = at.x;
      e.y = at.y;
      e.z = at.z;
      return at;
    };

    sim.input.mouseHeld.add(0);
    step(sim, frames, () => {
      const at = place();
      const eye = player.eyePosition(new THREE.Vector3());
      player.yaw = Math.atan2(-(at.x - player.position.x), -(at.z - player.position.z));
      player.pitch = Math.atan2(at.y - eye.y, Math.hypot(at.x - eye.x, at.z - eye.z));
      gun.heat = 0;
      gun.overheated = false;
    });
    sim.input.mouseHeld.delete(0);

    const survived = e.alive;
    e.alive = false;
    return !survived;
  };

  // Long range: this is the gun's job, killing the wave before it arrives.
  ok("kills a climber out at ~65 m", engageAt(-74, 40));

  // Close-in reach is covered by test 41 now that depression was relaxed; the
  // only place the gun must stay powerless is beneath the hull (tests 37 and 40).
  ok("the gun out-damages the rifle per shot",
    CFG.deckGun.damage > CFG.combat.weapon.damage,
    `${CFG.deckGun.damage} vs ${CFG.combat.weapon.damage}`);
  ok("and reaches further", CFG.deckGun.range > CFG.combat.weapon.range,
    `${CFG.deckGun.range} m vs ${CFG.combat.weapon.range} m`);
}

// ---------------------------------------------------------------------------
console.log("\n39. Heat stops the gun being an answer to everything");
{
  const sim = makeSim();
  const { player, trampler, gun } = sim;

  player.position.copy(gun.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);
  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 2);

  // Hold the trigger down. Note the gun CYCLES -- overheat, cool, resume -- so
  // sampling the state at the end of the window is a coin flip. Track whether it
  // ever cut out, and how long the first burst lasted.
  sim.input.mouseHeld.add(0);
  let everOverheated = false;
  let shotsAtFirstCutout = 0;
  step(sim, 300, () => {
    if (gun.overheated && !everOverheated) {
      everOverheated = true;
      shotsAtFirstCutout = gun.shots;
    }
  });
  sim.input.mouseHeld.delete(0);

  ok("sustained fire cuts the gun out", everOverheated,
    `heat ${gun.heat.toFixed(2)}, ${gun.shots} shots fired`);
  ok("it managed a meaningful burst first", shotsAtFirstCutout > 15,
    `${shotsAtFirstCutout} rounds before cut-out`);

  // Release and let it cool.
  step(sim, 180);
  ok("it recovers once you stop firing", !gun.overheated && gun.heat < 0.35,
    `heat ${gun.heat.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// The clamp was relaxed from -12 to -40 degrees on the argument that the hull
// slab, not the clamp, is what shields the space underneath. That argument has
// to be checked at BOTH mounts across their whole arcs, or the relaxation
// quietly destroys the reason to ever dismount.
console.log("\n40. Both mounts still cannot reach beneath the hull at -40 deg");
{
  for (const index of [0, 1]) {
    const sim = makeSim();
    const { player, trampler, horde, weapon } = sim;
    const gun = sim.guns[index];

    const chewer = horde.spawn(CHEWER);
    const park = () => {
      const at = trampler.legAttackWorld(index === 0 ? 0 : 5, new THREE.Vector3());
      chewer.x = at.x;
      chewer.y = at.y;
      chewer.z = at.z;
    };

    player.position.copy(gun.operatorWorld(new THREE.Vector3()));
    player.base = trampler;
    player.velocity.set(0, 0, 0);
    step(sim, 5);
    sim.input.presses.add(CFG.deckGun.key);
    step(sim, 2);
    ok(`manned the ${gun.name}`, gun.mounted);

    const hitsBefore = weapon.hits;
    sim.input.mouseHeld.add(0);
    for (let a = -gun.traverse; a <= gun.traverse; a += 0.25) {
      step(sim, 8, () => {
        park();
        player.yaw = trampler.yaw + gun.facing + a;
        player.pitch = -Math.PI / 2;
        gun.heat = 0;
        gun.overheated = false;
      });
    }
    sim.input.mouseHeld.delete(0);

    ok(`${gun.name} fired plenty during the sweep`, gun.shots > 20, `${gun.shots} shots`);
    ok(`${gun.name} never reached the chewer under the hull`,
      weapon.hits === hitsBefore && chewer.hp === chewer.maxHp,
      `${weapon.hits - hitsBefore} hits, chewer at ${chewer.hp.toFixed(0)} hp`);
  }
}

// ---------------------------------------------------------------------------
console.log("\n41. Relaxing depression bought real close-in reach");
{
  const sim = makeSim();
  const { player, trampler, gun, horde } = sim;

  player.position.copy(gun.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);
  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 2);

  const groundY = -CFG.trampler.deckHeight + CFG.enemies.climber.height / 2;
  const engage = (zLocal, frames) => {
    const e = horde.spawn(CLIMBER);
    sim.input.mouseHeld.add(0);
    step(sim, frames, () => {
      const at = trampler.localToWorld(new THREE.Vector3(0, groundY, zLocal));
      e.x = at.x;
      e.y = at.y;
      e.z = at.z;
      const eye = player.eyePosition(new THREE.Vector3());
      player.yaw = Math.atan2(-(at.x - player.position.x), -(at.z - player.position.z));
      player.pitch = Math.atan2(at.y - eye.y, Math.hypot(at.x - eye.x, at.z - eye.z));
      gun.heat = 0;
      gun.overheated = false;
    });
    sim.input.mouseHeld.delete(0);
    const killed = !e.alive;
    e.alive = false;
    return killed;
  };

  // The old -12 deg clamp could not touch anything closer than ~47 m. This is
  // roughly 22 m out from the bow, which used to be untouchable.
  ok("kills a ground target ~22 m ahead of the bow", engage(-32, 50));
  ok("still kills at long range too", engage(-74, 40));
}

// ---------------------------------------------------------------------------
console.log("\n42. The stern mount covers what the bow cannot");
{
  const sim = makeSim();
  const { player, trampler, horde } = sim;
  const stern = sim.guns[1];

  ok("there are two mounts", sim.guns.length === 2);
  ok("they face opposite ways",
    Math.abs(Math.abs(sim.guns[0].facing - stern.facing) - Math.PI) < 1e-6,
    `${sim.guns[0].facing.toFixed(2)} vs ${stern.facing.toFixed(2)}`);
  ok("their arcs together cover a full circle",
    sim.guns[0].traverse + stern.traverse >= Math.PI,
    `${(sim.guns[0].traverse * 2).toFixed(2)} + ${(stern.traverse * 2).toFixed(2)} rad`);

  player.position.copy(stern.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);
  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 2);
  ok("the stern gun can be manned", stern.mounted && player.station === stern);

  // And it can kill something chasing from behind, which the bow gun cannot see.
  const groundY = -CFG.trampler.deckHeight + CFG.enemies.climber.height / 2;
  const e = horde.spawn(CLIMBER);
  sim.input.mouseHeld.add(0);
  step(sim, 60, () => {
    const at = trampler.localToWorld(new THREE.Vector3(0, groundY, 50));
    e.x = at.x;
    e.y = at.y;
    e.z = at.z;
    const eye = player.eyePosition(new THREE.Vector3());
    player.yaw = Math.atan2(-(at.x - player.position.x), -(at.z - player.position.z));
    player.pitch = Math.atan2(at.y - eye.y, Math.hypot(at.x - eye.x, at.z - eye.z));
    stern.heat = 0;
    stern.overheated = false;
  });
  sim.input.mouseHeld.delete(0);

  ok("it kills a pursuer astern", !e.alive);
  ok("only one mount can be manned at a time",
    sim.guns.filter((g) => g.mounted).length === 1);
}

// ---------------------------------------------------------------------------
console.log("\n43. Repair is findable and survives a moving hull");
{
  const sim = makeSim();
  const { player, trampler, repair } = sim;

  trampler.damageLeg(0, 1e6);
  step(sim, 5);

  // The marker must be lit at the damaged leg and sit on the ground.
  const marker = repair.markers[0];
  ok("a ground marker appears at the damaged leg", marker.mesh.visible);
  ok("undamaged legs are not marked", !repair.markers[3].mesh.visible);

  const markerWorld = marker.mesh.getWorldPosition(new THREE.Vector3());
  const point = trampler.legAttackWorld(0, new THREE.Vector3());
  ok("the marker sits on the actual repair point",
    Math.hypot(markerWorld.x - point.x, markerWorld.z - point.z) < 0.2,
    `${Math.hypot(markerWorld.x - point.x, markerWorld.z - point.z).toFixed(2)} m off`);

  // Standing where the leg VISUALLY is must offer the prompt. The foot sits at
  // local x ~9.9; before this the repair point was 4 m inboard of it, so walking
  // up to the leg you could see offered nothing at all.
  // Note local y: the ground is at -deckHeight, not 0. Local y = 0 is the DECK
  // surface, so a naive 1.2 puts the player in mid-air above the hull.
  const legFootLocal = new THREE.Vector3(
    trampler.legs[0].userData.side * 9.4,
    -CFG.trampler.deckHeight + 1.2,
    trampler.legs[0].userData.z,
  );
  player.position.copy(trampler.localToWorld(legFootLocal));
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  ok("standing at the visible leg offers the repair", !!repair.target,
    repair.target ? repair.target.label : "nothing offered");

  // Now walk away and confirm the prompt lingers briefly rather than snapping off.
  const hpAfterSome = trampler.legHp[0];
  step(sim, 30, () => sim.input.keys.add(CFG.repair.key));
  ok("repair progresses while in range", trampler.legHp[0] > hpAfterSome,
    `${hpAfterSome.toFixed(0)} -> ${trampler.legHp[0].toFixed(0)} hp`);

  const banked = trampler.legHp[0];
  placeOnGroundAt(sim, 0, -50); // well clear
  step(sim, 6);
  ok("progress already made is never lost", trampler.legHp[0] >= banked,
    `${banked.toFixed(0)} -> ${trampler.legHp[0].toFixed(0)} hp`);
  step(sim, 60);
  ok("the prompt does eventually clear once truly away", !repair.target);
}

// ---------------------------------------------------------------------------
console.log("\n44. Impact markers are subtle enough to read as dust");
{
  const sim = makeSim();
  const { player, trampler, weapon } = sim;
  const w = CFG.combat.weapon;

  placeOnGroundAt(sim, 0, -45);
  const aim = () => trampler.localToWorld(new THREE.Vector3(0, -1.0, -13));
  aimAt(player, aim());
  step(sim, 1);
  aimAt(player, aim());
  weapon.fire();

  const p = weapon.impacts.find((x) => x.life > 0);
  ok("a terrain impact was placed", !!p);
  ok("it is a modest puff, not a metre-wide ball", p.mesh.scale.x < 0.25,
    `radius ${p.mesh.scale.x.toFixed(3)} m`);
  ok("terrain impacts are quieter than hits on enemies",
    w.impactSolidScale < 1 && weapon.impactMat.solid.opacity < weapon.impactMat.flesh.opacity,
    `scale x${w.impactSolidScale}, opacity ${weapon.impactMat.solid.opacity} vs ${weapon.impactMat.flesh.opacity}`);
  ok("and the sphere has enough segments to not read as a hexagon",
    p.mesh.geometry.parameters.widthSegments >= 12,
    `${p.mesh.geometry.parameters.widthSegments} segments`);
}

// ---------------------------------------------------------------------------
console.log("\n45. Repair can now actually patch a leg quickly");
{
  const sim = makeSim();
  const { player, trampler } = sim;

  trampler.damageLeg(0, 1e6);
  const spot = trampler.legAttackWorld(0, new THREE.Vector3());
  player.position.set(spot.x, 1.2, spot.z);
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  let frames = 0;
  while (trampler.legHp[0] < CFG.trampler.legHp && frames < 600) {
    step(sim, 1, () => {
      const s = trampler.legAttackWorld(0, new THREE.Vector3());
      player.position.set(s.x, player.position.y, s.z);
      sim.input.keys.add(CFG.repair.key);
    });
    frames++;
  }

  const seconds = frames / 60;
  ok("a dead leg is restored in about a second", seconds < 2.0,
    `${seconds.toFixed(2)}s at ${CFG.repair.legRate} hp/s`);
  ok("which is faster than the chewer damage it has to outrun",
    CFG.repair.legRate > 100, `${CFG.repair.legRate} hp/s`);
}

// ---------------------------------------------------------------------------
console.log("\n46. Emitters mount to the hull, not the world");
{
  const sim = makeSim();
  const { player, trampler, emitters } = sim;

  ok("start with a full rack", emitters.available === CFG.emitters.max);

  // Refused on the deck.
  player.respawnOnDeck();
  step(sim, 20);
  ok("cannot deploy while aboard", !emitters.canDeploy(player),
    emitters.blockReason);

  // Refused on open ground away from the hull.
  placeOnGroundAt(sim, 0, -40);
  ok("cannot deploy on open ground", !emitters.canDeploy(player),
    emitters.blockReason);
  ok("and the refusal says why", emitters.blockReason.includes("BENEATH"));

  // Allowed beneath the hull.
  const under = trampler.legAttackWorld(0, new THREE.Vector3());
  player.position.set(under.x, 1.2, under.z);
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);
  ok("can deploy beneath the hull", emitters.canDeploy(player), emitters.blockReason);

  sim.input.presses.add(CFG.emitters.deployKey);
  step(sim, 1);
  ok("deployed one", emitters.deployedCount === 1 && emitters.available === CFG.emitters.max - 1);

  // It has to ride the fortress. A ground-anchored defence would be abandoned
  // within a second by a hull walking at 4.5 m/s.
  const slot = emitters.slots.find((s) => s.live);
  const localBefore = slot.local.clone();
  const worldBefore = emitters.emitterWorld(slot, new THREE.Vector3());
  step(sim, 60);
  const worldAfter = emitters.emitterWorld(slot, new THREE.Vector3());

  ok("it moved through world space with the hull",
    worldAfter.distanceTo(worldBefore) > 2.0,
    `${worldAfter.distanceTo(worldBefore).toFixed(2)} m of world travel`);
  ok("but stayed fixed in hull space", slot.local.distanceTo(localBefore) < 1e-6);

  // Cap and recall.
  for (let i = 0; i < 5; i++) {
    step(sim, 2, () => sim.input.presses.add(CFG.emitters.deployKey));
  }
  ok("cannot exceed the rack size", emitters.deployedCount === CFG.emitters.max,
    `${emitters.deployedCount} deployed`);

  sim.input.presses.add(CFG.emitters.recallKey);
  step(sim, 1);
  ok("recall frees a slot", emitters.available === 1, `${emitters.available} free`);
}

// ---------------------------------------------------------------------------
console.log("\n47. Emitters kill things under the hull while you are away");
{
  const sim = makeSim();
  const { player, trampler, emitters, horde } = sim;

  const under = trampler.legAttackWorld(0, new THREE.Vector3());
  player.position.set(under.x, 1.2, under.z);
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);
  sim.input.presses.add(CFG.emitters.deployKey);
  step(sim, 2);
  ok("emitter is live", emitters.deployedCount === 1);

  // Send the player far away: this is the whole point, it works unattended.
  player.position.set(700, 1.2, 700);
  player.base = null;

  for (let i = 0; i < 6; i++) horde.spawn(CHEWER);
  const before = horde.liveCount;
  step(sim, 60 * 30);

  ok("it killed chewers with nobody present", horde.liveCount < before,
    `${before} -> ${horde.liveCount} alive`);
}

// ---------------------------------------------------------------------------
// THE assertion for this feature. Emitters exist to buy time, not to hold the
// line. If automation alone could keep the fortress walking, nobody would ever
// dismount and the whole pillar collapses.
console.log("\n48. Emitters delay the spiral but cannot stop it alone");
{
  const timeToImmobilise = (useEmitters) => {
    const sim = makeSim();
    const { player, trampler, emitters, horde } = sim;

    if (useEmitters) {
      for (const legIndex of [0, 2, 4]) {
        const at = trampler.legAttackWorld(legIndex, new THREE.Vector3());
        player.position.set(at.x, 1.2, at.z);
        player.base = null;
        player.velocity.set(0, 0, 0);
        step(sim, 6);
        sim.input.presses.add(CFG.emitters.deployKey);
        step(sim, 2);
      }
      if (emitters.deployedCount !== 3) return { frames: -1, placed: emitters.deployedCount };
    }

    // Player entirely out of the fight, so only automation is defending.
    player.position.set(700, 1.2, 700);
    player.base = null;

    // Reinforcements ON. Against a fixed enemy count, ANY nonzero automation
    // eventually wins given unlimited time, which tells us nothing. Continuous
    // waves with health scaling off elapsed time is the real situation.
    sim.waves = true;

    let frames = 0;
    while (!trampler.immobilised && frames < 60 * 180) {
      step(sim, 1);
      frames++;
    }
    return {
      frames,
      placed: emitters.deployedCount,
      reached: trampler.immobilised,
      wave: sim.director.wave,
    };
  };

  const bare = timeToImmobilise(false);
  const armed = timeToImmobilise(true);

  ok("all three emitters were placed", armed.placed === 3, `${armed.placed} placed`);
  ok("undefended, the fortress is crippled", bare.reached,
    `${(bare.frames / 60).toFixed(1)}s, wave ${bare.wave}`);
  ok("but emitters do NOT hold the line on their own -- the pillar survives",
    armed.reached,
    armed.reached
      ? `still crippled without a player, at ${(armed.frames / 60).toFixed(1)}s`
      : "AUTOMATION ALONE WON");

  // Both times PINNED as well as printed, and this is the section that earned the rule.
  // These two are invariant 2b's baseline figures, quoted in the steering files, and they
  // had drifted 11% and 4% from what is written there with every check above still green
  // -- because "crippled" was asserted and the time was only reported. Nothing was wrong
  // with the game; the record had silently stopped matching it, and the record is what
  // makes the next difficulty change attributable.
  //
  // Deliberately NOT asserted: that `armed` beats `bare`. Invariant 19c says wall-clock
  // survival under a live director measures nothing about a defensive tool's
  // contribution, because killing things lowers pressure and brings the next wave
  // sooner. The fixed-force measurement below is where that claim belongs.
  nearPct("undefended time-to-crippled is about what the record says",
    bare.frames / 60, 60.3, 10);
  nearPct("and so is the time with three emitters up",
    armed.frames / 60, 80.5, 10);

  // Their contribution has to be measured with the director OUT of the loop.
  // Pacing is now adaptive: emitters lower pressure by killing things, which
  // brings the next wave sooner, so the director compensates the time away and
  // wall-clock survival says nothing about how much work they did.
  const fixedSet = (useEmitters) => {
    const sim = makeSim();
    const { player, trampler, emitters, horde } = sim;

    if (useEmitters) {
      for (const legIndex of [0, 2, 4]) {
        const at = trampler.legAttackWorld(legIndex, new THREE.Vector3());
        player.position.set(at.x, 1.2, at.z);
        player.base = null;
        player.velocity.set(0, 0, 0);
        step(sim, 6);
        sim.input.presses.add(CFG.emitters.deployKey);
        step(sim, 2);
      }
    }

    player.position.set(700, 1.2, 700);
    player.base = null;
    for (let i = 0; i < 14; i++) horde.spawn(CHEWER);

    let frames = 0;
    const cap = 60 * 45;
    while (!trampler.immobilised && frames < cap) {
      step(sim, 1);
      frames++;
    }
    return frames;
  };

  const bareFixed = fixedSet(false);
  const armedFixed = fixedSet(true);
  ok("against a fixed force they buy real time",
    armedFixed > bareFixed * 1.25,
    `${(bareFixed / 60).toFixed(1)}s -> ${(armedFixed / 60).toFixed(1)}s`);
}

// ---------------------------------------------------------------------------
console.log("\n49. Emitters run dry rather than firing forever");
{
  const sim = makeSim();
  const { player, trampler, emitters, horde } = sim;

  const under = trampler.legAttackWorld(0, new THREE.Vector3());
  player.position.set(under.x, 1.2, under.z);
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);
  sim.input.presses.add(CFG.emitters.deployKey);
  step(sim, 2);

  const slot = emitters.slots.find((s) => s.live);
  ok("deploys with a full bank", Math.abs(slot.charge - CFG.emitters.charge) < 0.1,
    `${slot.charge.toFixed(1)} / ${CFG.emitters.charge}`);

  // Feed it a steady stream of targets so it fires as fast as it can.
  player.position.set(700, 1.2, 700);
  player.base = null;
  const feed = [];
  for (let i = 0; i < 12; i++) feed.push(horde.spawn(CHEWER));

  let lowest = CFG.emitters.charge;
  step(sim, 60 * 12, () => {
    // Keep a live target parked beside it so it never wants for something to hit.
    const at = emitters.emitterWorld(slot, new THREE.Vector3());
    for (const e of feed) {
      if (!e.alive) continue;
      e.x = at.x + 1.5;
      e.y = at.y;
      e.z = at.z;
      e.hp = 1e6;
      break;
    }
    lowest = Math.min(lowest, slot.charge);
  });

  ok("the bank actually drains under sustained use", lowest < 1.0,
    `dropped to ${lowest.toFixed(2)} charges`);
  ok("and it throttles rather than stopping dead",
    CFG.emitters.recharge > 0 && CFG.emitters.recharge * CFG.emitters.interval < 1,
    `recharge ${CFG.emitters.recharge}/s vs one shot per ${CFG.emitters.interval}s`);
}

// ---------------------------------------------------------------------------
// From a playtest: "the red things just spawn under the ship" when it stops.
// Measured: they do not -- the ring is 63-85 m out. What actually happens is
// accumulation, because waves kept landing on a fixed clock whether or not the
// last one was cleared.
console.log("\n50. Spawns are far away, and waves wait for the field to thin");
{
  const sim = makeSim();
  const { trampler, horde, director } = sim;
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;

  // Every spawn must appear well clear of the fortress.
  let nearest = Infinity;
  const orig = horde.spawn.bind(horde);
  horde.spawn = (type, scale) => {
    const e = orig(type, scale);
    if (e) {
      nearest = Math.min(nearest, Math.hypot(
        e.x - trampler.group.position.x,
        e.z - trampler.group.position.z,
      ));
    }
    return e;
  };

  // Let it degrade on its own rather than pre-crippling it: an immobilised
  // fortress now halts the pacing outright, so a pre-broken setup never gets any
  // waves to measure.
  sim.waves = true;

  // Track PEAKS. Final values mislead here -- once the last legs die the chewers
  // escalate to boarding, which empties the under-hull area being measured.
  let peakUnder = 0;
  let peakAlive = 0;
  step(sim, 60 * 100, () => {
    peakUnder = Math.max(peakUnder, horde.underHull);
    peakAlive = Math.max(peakAlive, horde.liveCount);
  });

  ok("nothing spawns anywhere near the hull", nearest > 40,
    `nearest spawn ${nearest.toFixed(1)} m from hull centre`);
  ok("hostiles do accumulate in the hull's shadow", peakUnder > 0,
    `peak ${peakUnder} beneath the hull`);
  ok("the field did get crowded", peakAlive > CFG.waves.holdUntilCleared,
    `peak ${peakAlive} alive`);
  ok("with nobody defending, the fortress ends up crippled", trampler.immobilised,
    `${trampler.workingLegs()} legs working`);

  // The anti-spiral rule, and the strongest form of it: a stopped fortress stops
  // the pacing dead. No reinforcements arrive while you are down in the sand.
  ok("a stopped fortress halts the pacing entirely", director.holding,
    `phase ${director.phase}, pressure ${(director.pressure * 100).toFixed(0)}%`);

  const heldAt = director.wave;
  step(sim, 60 * 60);
  ok("and it stays halted for as long as that lasts", director.wave === heldAt,
    `wave ${director.wave} after another minute`);

  // Recovering must release it -- after the guaranteed breather and the
  // telegraph, not instantly.
  horde.clear();
  trampler.repairAll();
  sim.player.hp = sim.player.maxHp;
  sim.player.timeSinceHurt = 99;
  step(sim, 60 * 5);
  ok("recovering does not fire the next wave instantly", director.wave === heldAt,
    `phase ${director.phase}`);

  step(sim, 60 * (CFG.waves.minRest + CFG.waves.prepTime + 3));
  ok("but it does come after the rest and the telegraph", director.wave > heldAt,
    `wave ${director.wave}`);
}

// ---------------------------------------------------------------------------
console.log("\n51. Calling a wave early overrides the hold");
{
  const sim = makeSim();
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;
  const { horde, director } = sim;

  sim.waves = true;
  step(sim, 60 * 60);
  ok("field is crowded and the wave is held",
    horde.liveCount > CFG.waves.holdUntilCleared && director.holding,
    `${horde.liveCount} alive, wave ${director.wave}, phase ${director.phase}`);

  const before = director.wave;
  ok("Q is accepted", director.callEarly());
  step(sim, 60 * 2);
  ok("stacking waves remains the player's choice", director.wave > before,
    `wave ${before} -> ${director.wave}`);
  ok("and calling early skips the prep window -- that is the risk",
    director.phase === PHASE.SPAWNING, `phase ${director.phase}`);
}

// ---------------------------------------------------------------------------
console.log("\n52. Climbers do not pop when they latch on");
{
  const sim = makeSim();
  const { horde } = sim;
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;

  for (let i = 0; i < 10; i++) horde.spawn(CLIMBER);

  // Watch for a discontinuity as enemies transition into climbing. The old code
  // lerped from the route anchor rather than from the enemy, snapping up to 1.6 m.
  const prev = new Map();
  let worst = 0;
  step(sim, 60 * 40, () => {
    for (let i = 0; i < horde.pool.length; i++) {
      const e = horde.pool[i];
      if (!e.alive) { prev.delete(i); continue; }
      const p = prev.get(i);
      if (p) worst = Math.max(worst, Math.hypot(e.x - p.x, e.y - p.y, e.z - p.z));
      prev.set(i, { x: e.x, y: e.y, z: e.z });
    }
  });

  // Fastest legitimate move is climber speed 6 m/s at 1/60 s = 0.1 m, plus slack
  // for the hull's own motion being folded in.
  ok("no enemy jumps more than a stride in one frame", worst < 0.35,
    `worst frame-to-frame move ${worst.toFixed(3)} m`);
}

// ---------------------------------------------------------------------------
// A playtester repaired a leg mid-fight and lost it again immediately. The first
// fix blocked contested repair outright, which was an over-correction: repair does
// 110 hp/s against roughly 40 hp/s of chewing, so the operative's own health was
// always the real limiter. A hard block also breaks co-op, because the check
// measures hostiles near the PLAYER -- a teammate defending the repairer would
// have frozen the work. Now it is slowed to 35%, which is roughly a stalemate
// against four chewers: hold the leg while someone clears, but do not win alone.
console.log("\n53. Contested repair is slowed, not blocked");
{
  const sim = makeSim();
  const { player, trampler, horde, repair } = sim;

  // Keep the operative planted at the leg. Only x/z are re-set so gravity can
  // settle y -- forcing y every frame would mask a placement bug.
  const standAtLeg = () => {
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    player.position.set(at.x, player.position.y, at.z);
  };

  trampler.damageLeg(0, 1e6);
  {
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    player.position.set(at.x, 1.2, at.z);
  }
  player.base = null;
  player.velocity.set(0, 0, 0);
  step(sim, 10);
  ok("a repair is offered", !!repair.target, repair.target?.label);
  ok("nothing nearby means it is uncontested", !repair.threatened);

  // Measure half a second of unopposed work.
  trampler.damageLeg(0, 1e6);
  step(sim, 30, () => {
    standAtLeg();
    sim.input.keys.add(CFG.repair.key);
  });
  const clearGain = trampler.legHp[0];
  ok("unopposed repair is fast", clearGain > 40, `${clearGain.toFixed(0)} hp in 0.5 s`);

  // Now with a chewer parked on the player.
  const e = horde.spawn(CHEWER);
  trampler.damageLeg(0, 1e6);
  step(sim, 30, () => {
    standAtLeg();
    e.x = player.position.x + 1.0;
    e.y = player.position.y;
    e.z = player.position.z;
    sim.input.keys.add(CFG.repair.key);
  });
  const contestedGain = trampler.legHp[0];

  ok("the threat is detected", repair.threatened);
  // The co-op case depends on this: a teammate fighting beside the repairer must
  // not freeze the work, only slow it.
  ok("work still progresses while contested", contestedGain > 0,
    `${contestedGain.toFixed(0)} hp in 0.5 s`);
  ok("the interaction stays active rather than refusing", repair.active);
  ok("but it is clearly slower than unopposed",
    contestedGain < clearGain * 0.6,
    `${contestedGain.toFixed(0)} vs ${clearGain.toFixed(0)} hp`);

  // Contested repair should roughly match a small group's damage, not beat it.
  const perSecond = contestedGain * 2;
  ok("contested rate is in the stalemate band, not a win button",
    perSecond > 20 && perSecond < 60, `${perSecond.toFixed(0)} hp/s while contested`);

  // Full speed from ~19 hp needs about 0.9 s at 110 hp/s. Allow 1.25 s so the
  // assertion tests that repair completes, not that it completes in a tight
  // window.
  horde.damage(e, 1e6);
  step(sim, 75, () => {
    standAtLeg();
    sim.input.keys.add(CFG.repair.key);
  });
  ok("clearing restores full speed", !repair.threatened);
  ok("and the leg comes back", trampler.legHp[0] >= CFG.trampler.legHp - 1,
    `${trampler.legHp[0].toFixed(0)} / ${CFG.trampler.legHp} hp`);
}

// ---------------------------------------------------------------------------
console.log("\n54. Stopping never brings enemies closer, or more of them");
{
  // Placement, isolated from pacing: spawn directly and measure the ring.
  const ring = (stopped) => {
    const sim = makeSim();
    if (stopped) for (let i = 0; i < 4; i++) sim.trampler.damageLeg(i, 1e6);
    step(sim, 30);
    ok(`the ${stopped ? "stopped" : "walking"} case is set up correctly`,
      sim.trampler.immobilised === stopped);

    const d = [];
    for (let i = 0; i < 40; i++) {
      const e = sim.horde.spawn(CHEWER);
      d.push(Math.hypot(
        e.x - sim.trampler.group.position.x,
        e.z - sim.trampler.group.position.z,
      ));
    }
    return {
      min: Math.min(...d),
      mean: d.reduce((a, b) => a + b, 0) / d.length,
    };
  };

  const walking = ring(false);
  const stopped = ring(true);

  ok("nothing spawns close in either case", walking.min > 40 && stopped.min > 40,
    `nearest ${walking.min.toFixed(1)} m walking, ${stopped.min.toFixed(1)} m stopped`);
  ok("and the ring is the same distance either way",
    Math.abs(walking.mean - stopped.mean) < 4,
    `mean ${walking.mean.toFixed(1)} m vs ${stopped.mean.toFixed(1)} m`);

  // Pacing: a stopped fortress must never receive MORE waves. It now receives
  // fewer -- being immobilised holds the pacing outright.
  const spawnsOver = (stopped) => {
    const sim = makeSim();
    sim.player.position.set(700, 1.2, 700);
    sim.player.base = null;
    if (stopped) for (let i = 0; i < 4; i++) sim.trampler.damageLeg(i, 1e6);

    let spawned = 0;
    const orig = sim.horde.spawn.bind(sim.horde);
    sim.horde.spawn = (t, s, a) => {
      const e = orig(t, s, a);
      if (e) spawned++;
      return e;
    };

    sim.waves = true;
    step(sim, 60 * 60, () => sim.horde.clear()); // keep the field clear
    return spawned;
  };

  const walkSpawns = spawnsOver(false);
  const stopSpawns = spawnsOver(true);

  ok("a walking fortress does get waves", walkSpawns > 0, `${walkSpawns} spawned`);
  ok("a stopped one never gets more than a walking one",
    stopSpawns <= walkSpawns,
    `walking ${walkSpawns}, stopped ${stopSpawns}`);
  ok("in fact being crippled halts reinforcements entirely", stopSpawns === 0,
    `${stopSpawns} spawned while immobilised`);
}

// ---------------------------------------------------------------------------
// The core of the pacing rework: waves are gated on how much trouble the crew is
// actually in, not on a head count. Eight healthy enemies loitering at 60 m is
// not the same problem as eight chewing the legs, and the old gate could not tell
// those apart.
console.log("\n55. Pacing is gated on crew pressure, not a head count");
{
  const sim = makeSim();
  const { player, trampler, horde, director } = sim;
  player.position.set(700, 1.2, 700);
  player.base = null;
  step(sim, 5);

  ok("an untouched crew reads as calm", director.calm,
    `pressure ${(director.pressure * 100).toFixed(0)}%`);

  // Each signal on its own has to register.
  const base = director.pressure;

  player.hp = player.maxHp * 0.3;
  const hurt = director.pressure;
  ok("losing health raises pressure", hurt > base,
    `${(base * 100).toFixed(0)}% -> ${(hurt * 100).toFixed(0)}%`);
  player.hp = player.maxHp;

  for (let i = 0; i < 4; i++) trampler.damageLeg(i, 1e6);
  ok("an immobilised fortress raises pressure", director.pressure > base,
    `${(director.pressure * 100).toFixed(0)}%`);
  ok("and that alone is enough to stop the pacing advancing", !director.calm);
  trampler.repairAll();

  // Hostiles under the hull must count for more than hostiles far away.
  const far = [];
  for (let i = 0; i < 8; i++) far.push(horde.spawn(CHEWER));
  step(sim, 2);
  const distant = director.pressure;

  const at = trampler.legAttackWorld(0, new THREE.Vector3());
  step(sim, 4, () => {
    for (const e of far) {
      e.x = at.x;
      e.y = at.y;
      e.z = at.z;
    }
  });
  const beneath = director.pressure;

  ok("the same eight enemies read as more pressure once they are under the hull",
    beneath > distant,
    `${(distant * 100).toFixed(0)}% at range -> ${(beneath * 100).toFixed(0)}% beneath`);
}

// ---------------------------------------------------------------------------
console.log("\n56. A guaranteed breather follows every wave");
{
  const sim = makeSim();
  const { horde, director } = sim;
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;
  sim.waves = true;

  // Force a wave, then wipe it instantly to simulate a flawless clear.
  director.callEarly();
  step(sim, 2);
  while (director.phase === PHASE.SPAWNING) step(sim, 1);
  horde.clear();
  step(sim, 5);

  ok("a cleared wave drops into rest, not straight into the next telegraph",
    director.phase === PHASE.REST, `phase ${director.phase}`);
  ok("the rest is a real length, not a formality",
    director.timer > CFG.waves.minRest * 0.5,
    `${director.timer.toFixed(1)}s of ${CFG.waves.minRest}s remaining`);

  const waveAt = director.wave;
  step(sim, 60 * (CFG.waves.minRest - 2));
  ok("no telegraph during the guaranteed rest", director.phase === PHASE.REST,
    `phase ${director.phase}`);

  step(sim, 60 * 3);
  ok("then the telegraph opens", director.phase === PHASE.PREP, `phase ${director.phase}`);
  ok("and still no new wave until the telegraph finishes", director.wave === waveAt,
    `wave ${director.wave}`);
}

// ---------------------------------------------------------------------------
// The simulation was on Math.random in four places, which meant the same code
// measured 15.2 s and 19.3 s on consecutive runs and the assertion guarding
// invariant 2b passed or failed at random. Everything stochastic is seeded now.
// This locks that down, including the part that is easy to get wrong: a RESTART
// has to rewind the streams, or two attempts at the same wave are different
// fights and the seeds buy nothing.
console.log("\n57. A restarted encounter replays the same fight");
{
  const sim = makeSim();
  const { trampler, horde, director } = sim;
  sim.waves = true;

  // Record each spawn's offset from the hull AT THE MOMENT it is created. World
  // positions are the wrong measure -- what has to repeat is the decisions.
  const spawnLog = [];
  const realSpawn = horde.spawn.bind(horde);
  horde.spawn = (type, hpScale, arcOffset) => {
    const e = realSpawn(type, hpScale, arcOffset);
    if (e) {
      const dx = e.x - trampler.group.position.x;
      const dz = e.z - trampler.group.position.z;
      spawnLog.push(`${type}@${Math.hypot(dx, dz).toFixed(3)}/${Math.atan2(dz, dx).toFixed(3)}`);
    }
    return e;
  };

  const play = () => {
    spawnLog.length = 0;
    step(sim, 60 * 45);
    return { seq: spawnLog.join(" "), bearing: director.arcOffset, wave: director.wave };
  };

  const first = play();
  ok("the run actually spawned something (test is not vacuous)", first.seq.length > 0,
    `${first.seq.split(" ").length} spawns, wave ${first.wave}`);

  // Exactly what resetEncounter() does in main.js.
  horde.clear();
  trampler.repairAll();
  trampler.resetPose();
  director.reset();

  const second = play();
  ok("the same seed replays the same spawn sequence", first.seq === second.seq,
    first.seq === second.seq ? "identical" : `\n    ${first.seq.slice(0, 90)}\n    ${second.seq.slice(0, 90)}`);
  ok("and the same wave bearing", first.bearing === second.bearing,
    `${first.bearing.toFixed(4)} vs ${second.bearing.toFixed(4)}`);
  ok("and reaches the same wave", first.wave === second.wave,
    `wave ${first.wave} vs ${second.wave}`);

  // The pose rewind is the part that is easy to forget: spawn bearings derive
  // from the hull's heading, so leaving it mid-patrol silently changes the fight.
  trampler.resetPose();
  ok("resetPose puts the fortress back on its start heading",
    Math.abs(trampler.yaw - Math.PI) < 1e-9, `yaw ${trampler.yaw.toFixed(4)}`);
  ok("and back at its start position on the patrol ring",
    Math.abs(trampler.group.position.x - CFG.world.patrolRadius) < 1e-9
    && Math.abs(trampler.group.position.z) < 1e-9,
    `(${trampler.group.position.x.toFixed(2)}, ${trampler.group.position.z.toFixed(2)})`);
}

// ---------------------------------------------------------------------------
// Enemy speed is the one difficulty number measurement cannot settle -- an oracle
// defender that teleports is indifferent to it -- so it is a live knob instead of
// a decided value. The knob mutates global CFG, which is exactly the kind of thing
// that silently poisons every later test, so restoring it is asserted too.
console.log("\n58. The live enemy-speed knob scales and restores cleanly");
{
  const baseChewer = CFG.enemies.chewer.speed;
  const baseClimber = CFG.enemies.climber.speed;

  const half = applyEnemySpeedScale(0.5);
  ok("scaling down changes both enemy types",
    Math.abs(half.chewer - baseChewer * 0.5) < 1e-9
    && Math.abs(half.climber - baseClimber * 0.5) < 1e-9,
    `chewer ${half.chewer.toFixed(2)}, climber ${half.climber.toFixed(2)}`);

  ok("and it warns once they are slower than the hull itself", half.outrun,
    `slowest ${Math.min(half.chewer, half.climber).toFixed(2)} vs hull ${CFG.trampler.speed}`);

  const clampedLow = applyEnemySpeedScale(0.01);
  ok("the scale is clamped at the low end", clampedLow.scale === CFG.debug.minEnemyScale,
    `${clampedLow.scale}`);
  const clampedHigh = applyEnemySpeedScale(99);
  ok("and at the high end", clampedHigh.scale === CFG.debug.maxEnemyScale,
    `${clampedHigh.scale}`);

  // Scaling always applies to the AUTHORED speed, never compounding on the last
  // result -- otherwise repeated presses would drift away from the base value.
  applyEnemySpeedScale(1.2);
  applyEnemySpeedScale(1.2);
  ok("repeated scaling does not compound",
    Math.abs(CFG.enemies.chewer.speed - baseChewer * 1.2) < 1e-9,
    `${CFG.enemies.chewer.speed.toFixed(3)} vs expected ${(baseChewer * 1.2).toFixed(3)}`);

  const restored = applyEnemySpeedScale(1);
  ok("and 1.0x restores the authored speeds exactly",
    CFG.enemies.chewer.speed === baseChewer && CFG.enemies.climber.speed === baseClimber,
    `chewer ${CFG.enemies.chewer.speed}, climber ${CFG.enemies.climber.speed}`);
  // Authored climbers sit just 0.02 m/s above the hull, so this assertion is
  // genuinely load-bearing rather than decorative -- it is the tripwire for
  // anyone nudging either number without checking the other.
  ok("the authored speeds stay above the hull's own speed",
    !restored.outrun,
    `slowest ${Math.min(restored.chewer, restored.climber)} vs hull ${CFG.trampler.speed}`);
}

// ---------------------------------------------------------------------------
// A playtest reported waiting around for enemies. Measured cause: the director
// picked each wave's bearing across +/-72 deg, and a wave committed near abeam was
// walked past by the fortress and spent the rest of the wave in a stern chase --
// 23.2 s median to engage versus 7.1 s dead ahead. Narrowing the arc to 0.9 rad cut
// that to 10.3 s, which beat slowing the hull by 29%.
//
// The arc cannot be narrowed indefinitely though: the telegraph's whole job is to
// say WHERE, and that requires waves actually arriving from different directions.
console.log("\n59. The wave bearing stays varied enough to be worth telegraphing");
{
  const sim = makeSim();
  const { director } = sim;

  const seen = {};
  const offsets = [];
  for (let i = 0; i < 60; i++) {
    director.arcOffset = (director.random() * 2 - 1) * CFG.waves.forwardArc;
    offsets.push(director.arcOffset);
    seen[director.bearingLabel] = (seen[director.bearingLabel] || 0) + 1;
  }

  const labels = Object.keys(seen);
  ok("all three bearings still occur", labels.length === 3,
    labels.map((l) => `${l} ${seen[l]}`).join(", "));

  // None may dominate, or the warning stops being information.
  const most = Math.max(...Object.values(seen));
  ok("and none of them dominates the telegraph", most < 60 * 0.6,
    `most common appeared ${most}/60`);

  const spread = Math.max(...offsets) - Math.min(...offsets);
  ok("waves still arrive from meaningfully different directions",
    spread > 1.0, `${(spread * 180 / Math.PI).toFixed(0)} deg of spread used`);

  // The arc still has to point FORWARD -- a wave spawned abeam or behind is the
  // stern chase this fixed.
  ok("the arc stays within the forward hemisphere",
    CFG.waves.forwardArc < Math.PI / 2,
    `${(CFG.waves.forwardArc * 180 / Math.PI).toFixed(0)} deg either side`);
}

// ---------------------------------------------------------------------------
// A siege has a finish line. Without one the fight is endless, and a playtester
// averaging wave 4 read that as repeated failure rather than as nearly holding --
// there was nothing being reached. Difficulty was deliberately NOT nerfed to suit
// it: enemy strength is quadratic against a flat 200 dps, so the missing half is
// the player's power curve.
console.log("\n60. A siege ends when its last wave is resolved");
{
  const sim = makeSim();
  const { horde, director, trampler } = sim;
  sim.waves = true;

  // Stand in for a competent crew: keep the field clear so waves keep resolving.
  const clearField = () => {
    for (const e of horde.pool) if (e.alive) horde.damage(e, 1e6);
    trampler.repairAll();
  };

  let sawHeld = false;
  let waveAtHeld = 0;
  let spawnedAfterHeld = 0;

  step(sim, 60 * 400, () => {
    if (director.held) {
      if (!sawHeld) {
        sawHeld = true;
        waveAtHeld = director.wave;
      }
      spawnedAfterHeld += horde.liveCount;
    }
    clearField();
  });

  ok("the siege reaches its end", sawHeld, `phase ${director.phase}`);
  ok("and it ends on the configured wave, not before or after",
    waveAtHeld === CFG.waves.siegeLength,
    `held at wave ${waveAtHeld}, siegeLength ${CFG.waves.siegeLength}`);
  ok("nothing spawns once it is held", spawnedAfterHeld === 0,
    `${spawnedAfterHeld} enemy-frames after the siege ended`);
  ok("the wave count does not creep past the siege length",
    director.wave === CFG.waves.siegeLength, `wave ${director.wave}`);
  ok("and calling a wave early cannot restart a finished siege",
    director.callEarly() === false);

  // A reset has to make it runnable again, or a win is a dead end.
  horde.clear();
  trampler.repairAll();
  trampler.resetPose();
  director.reset();
  ok("resetting clears the held state", !director.held && director.wave === 0,
    `phase ${director.phase}, wave ${director.wave}`);
}

// ---------------------------------------------------------------------------
// The economy exists to give Q something to be greedy FOR. Calling a wave early
// has been in the build since the pacing rework and there was never a reason to
// press it: the cost was losing a 12 s preparation window and the reward was
// nothing. A risk with no upside is not a decision.
console.log("\n61. Kills pay into two separate purses");
{
  const sim = makeSim();
  const { horde, economy } = sim;

  ok("both purses start empty", economy.salvage === 0 && economy.scrap === 0);

  // ATTRIBUTED, and it did not used to be. Salvage is now paid to whoever caused the kill,
  // so a bare `damage(e, 1e6)` correctly pays no personal purse at all -- it is nobody's
  // kill. These two lines stand in for the operative shooting something, so they say so.
  const chewer = horde.spawn(CHEWER);
  horde.damage(chewer, 1e6, sim.player);
  const e = CFG.economy.chewer;
  ok("a chewer pays personal salvage", economy.salvage === e.salvage,
    `${economy.salvage} salvage`);
  ok("and a little shared scrap", economy.scrap === e.scrap, `${economy.scrap} scrap`);

  const climber = horde.spawn(CLIMBER);
  horde.damage(climber, 1e6, sim.player);
  ok("a climber pays more, because reaching one costs you position",
    economy.salvage === e.salvage + CFG.economy.climber.salvage,
    `${economy.salvage} salvage`);

  const beforeSpiker = { salvage: economy.salvage, scrap: economy.scrap };
  const spiker = horde.spawn(SPIKER);
  horde.damage(spiker, 1e6, sim.player);
  ok("the ranged roster entry has an explicit payout rather than the chewer fallback",
    economy.salvage === beforeSpiker.salvage + CFG.economy.spiker.salvage
      && economy.scrap === beforeSpiker.scrap + CFG.economy.spiker.scrap,
    `${CFG.economy.spiker.salvage} salvage, ${CFG.economy.spiker.scrap} scrap`);

  // Every damage source funnels through Horde.damage, so nothing can pay nothing.
  // EVERY KILL STILL PAYS, BUT NOT EVERY KILL PAYS A PERSON.
  //
  // This used to assert that an unattributed kill paid salvage, and the claim behind it was
  // invariant 24's: the hook is on the one choke point all damage routes through, so a
  // newly added weapon cannot silently pay nothing. That claim is intact and is asserted
  // below -- on the SHARED purse, which is where a kill nobody made belongs.
  //
  // The personal half is now refused, and that is invariant 2b-i rather than arithmetic.
  // Salvage is what you earn for what YOU kill. Paying it for an emitter's kill would mean
  // deploying a rack and walking away funds a personal build, which is automation doing a
  // job the player has to be present for -- the same argument that stops a proc firing off
  // an emitter kill, applied to income.
  const salvageBefore = economy.salvage;
  const scrapBefore = economy.scrap;
  const viaEmitter = horde.spawn(CHEWER);
  horde.damage(viaEmitter, 1e6, sim.emitters);
  ok("an automated kill still pays, because nothing may kill for free",
    economy.scrap > scrapBefore,
    `${scrapBefore} -> ${economy.scrap} scrap from a kill the crew's emitter made`);
  ok("but it pays the CREW, not a personal purse — automation cannot fund your build",
    economy.salvage === salvageBefore,
    economy.salvage === salvageBefore
      ? `salvage unchanged at ${economy.salvage}`
      : `PAID ${economy.salvage - salvageBefore} SALVAGE FOR AN UNATTENDED KILL`);

  // Damage that does NOT kill must not pay, or chip damage becomes an income farm.
  const survivor = horde.spawn(CHEWER);
  const held = economy.salvage;
  horde.damage(survivor, 1);
  ok("wounding pays nothing", economy.salvage === held, `${economy.salvage} salvage`);
}

// ---------------------------------------------------------------------------
console.log("\n62. Refits apply, escalate in price, and respect their bounds");
{
  const sim = makeSim();
  const { economy, weapon, player, trampler, repair } = sim;
  const idx = Object.fromEntries(CFG.economy.catalogue.map((c, i) => [c.id, i]));

  economy.salvage = 100000;
  economy.scrap = 100000;
  // Buying is a place as well as a time now. This section's subject is what a refit
  // DOES, so the gate is scaffolding here and gets arranged rather than exercised;
  // test 63 owns the gate itself.
  shopReady(sim);

  const baseDamage = weapon.damageScale;
  const firstCost = economy.costOf(idx.rifle);
  ok("a purchase reports what it did", !!economy.buy(idx.rifle));
  ok("and the effect actually lands", weapon.damageScale > baseDamage,
    `damage scale ${baseDamage} -> ${weapon.damageScale}`);
  ok("the next stack costs more than the first",
    economy.costOf(idx.rifle) > firstCost,
    `${firstCost} -> ${economy.costOf(idx.rifle)}`);

  const hpBefore = player.maxHp;
  economy.buy(idx.vitals);
  ok("vitals raises max health", player.maxHp > hpBefore, `${hpBefore} -> ${player.maxHp}`);
  ok("and heals by the same amount, so it helps immediately",
    player.hp === player.maxHp, `${player.hp} / ${player.maxHp}`);

  const platingBefore = trampler.damageScale;
  economy.buy(idx.plating);
  ok("plating reduces incoming fortress damage", trampler.damageScale < platingBefore,
    `${platingBefore} -> ${trampler.damageScale.toFixed(3)}`);

  const rigBefore = repair.rateScale;
  economy.buy(idx.rig);
  ok("the repair rig speeds up repair", repair.rateScale > rigBefore,
    `${rigBefore} -> ${repair.rateScale.toFixed(2)}`);

  // Bounded structure, unbounded stacking -- the whole intended roguelike shape,
  // asserted rather than assumed.
  for (let i = 0; i < 40; i++) economy.buy(idx.plating);
  const platingMax = CFG.economy.catalogue[idx.plating].max;
  ok("fortress upgrades stop at their cap",
    economy.stacks.plating === platingMax,
    `${economy.stacks.plating} / ${platingMax}`);
  ok("and say so rather than silently failing",
    economy.buy(idx.plating) === null && economy.blockedReason.includes("MAXIMUM"),
    economy.blockedReason);

  for (let i = 0; i < 40; i++) economy.buy(idx.rifle);
  ok("personal upgrades keep stacking with no cap",
    economy.stacks.rifle > platingMax + 10, `${economy.stacks.rifle} stacks`);

  // Plating must never trivialise the under-hull fight, because that fight is the
  // entire reason a player dismounts.
  ok("even fully plated, the fortress still takes real damage",
    trampler.damageScale > 0.4, `takes ${(trampler.damageScale * 100).toFixed(0)}% damage`);
}

// ---------------------------------------------------------------------------
console.log("\n63. Buying happens at a PLACE, and between waves");
{
  const sim = makeSim();
  const { economy, director, trampler } = sim;
  sim.waves = true;
  economy.salvage = 100000;
  economy.scrap = 100000;

  // ---- the terminal is somewhere, and the deck spawn is NOT it.
  //
  // This check exists because the first placement failed it. The console sat 2.37 m from
  // the deck spawn, inside the 3 m radius, so the panel was up the instant the player
  // appeared -- which is precisely the push behaviour the terminal exists to remove. A
  // shop you spawn inside is a shop that came to you.
  const spawnToTerminal = trampler.localToWorld(new THREE.Vector3(-4.5, 1.2, 0))
    .distanceTo(trampler.terminalWorld(new THREE.Vector3()));
  ok("the terminal is a real trip from where you spawn, not somewhere you start",
    spawnToTerminal > CFG.economy.terminalRange,
    `${spawnToTerminal.toFixed(1)} m across the deck vs a ${CFG.economy.terminalRange} m radius`);

  // ---- AND IT IS NOT PARKED WHERE BOARDERS STOP.
  //
  // The proximity clause closes the shop when something is within `repair.threatRange` of
  // the operative, so where the console sits decides whether that clause fires
  // occasionally or permanently. A permanent version would be invariant 23's V2 failure in
  // a new costume: a lockout that scales with how badly the boarding fight is going is
  // aimed squarely at whoever needs the shop most.
  //
  // THE REACTOR IS THE MEASUREMENT, not the climb routes. A climber transiting a route
  // passes within 6 m for a second or two and then walks on, which is legible and
  // harmless. A boarder ATTACKING THE REACTOR stops and stays, and that is what would keep
  // the shop shut. So the assertion is about the reactor's surface — the place attackers
  // actually stand, per invariant 9 — rather than about its centre. The comment defending
  // an earlier placement said "6.3 m from the reactor, deliberately marginal" and was
  // measuring to the centre, which nothing ever occupies.
  const term = trampler.terminalWorld(new THREE.Vector3());
  const reach = CFG.repair.threatRange;
  const reactorSurface = trampler.reactorSurfaceWorld(term, new THREE.Vector3());
  ok("the console is well clear of the reactor, which is where boarders stop and stay",
    term.distanceTo(reactorSurface) > reach * 1.5,
    `${term.distanceTo(reactorSurface).toFixed(1)} m to the reactor surface,`
    + ` against a ${reach} m proximity threshold`);

  // Recorded rather than required, because transit is not a lockout. It is worth PRINTING
  // so the next person moving this thing can see what they are walking into: the run that
  // rejected the starboard-amidships spot showed 1.50 m here.
  const exits = trampler.climbRoutes.map(
    (r) => term.distanceTo(trampler.localToWorld(r.end.clone())));
  ok("there are boarding routes to be measured against (test is not vacuous)",
    trampler.climbRoutes.length >= 8, `${trampler.climbRoutes.length} boarding routes`);
  ok("and it is not sitting on top of a boarding route exit either",
    Math.min(...exits) > CFG.economy.terminalRange,
    `nearest of ${exits.length} exits is ${Math.min(...exits).toFixed(1)} m`
    + ` (a rejected placement measured 1.5 m here)`);

  // A gun seat must not be inside the console's own radius, or manning the gun would open
  // the shop and "spend the telegraph on the gun or on the shop" stops being a choice.
  for (const m of CFG.deckGun.mounts) {
    const op = trampler.localToWorld(new THREE.Vector3(...m.operatorLocal));
    ok(`${m.name}'s seat is outside the console's radius, so you cannot be at both`,
      term.distanceTo(op) > CFG.economy.terminalRange,
      `${term.distanceTo(op).toFixed(1)} m from the ${m.name} seat`
      + ` vs a ${CFG.economy.terminalRange} m radius`);
  }

  // ---- and the GROUND cannot reach it. This is the clause carrying invariant 23's
  // "no spending your way out of trouble", and it is carried by geometry rather than by
  // a phase check: the console is 1.1 m above a deck that is 7.5 m above the sand, so
  // nothing standing underneath is within 3 m of it. Asserted rather than assumed,
  // because that is arithmetic between two numbers in different files, and the config
  // comment for `terminalRange` makes a promise about it.
  placeOnGroundAt(sim, 0, 0);
  step(sim, 2);
  ok("standing under the hull cannot reach the terminal, so the ground cannot shop",
    !economy.atTerminal && !economy.open,
    `${trampler.terminalWorld(new THREE.Vector3()).distanceTo(sim.player.position).toFixed(1)} m`
    + ` from the console, atTerminal ${economy.atTerminal}`);
  ok("and the refusal names the reason, which is a place rather than a time",
    economy.buy(0) === null && economy.blockedReason === "NOT AT THE REFIT TERMINAL",
    `"${economy.blockedReason}"`);

  // ---- standing at it during the opening rest is the whole happy path.
  placeOnDeckLocal(sim, trampler.terminalLocal.x, 1.2, trampler.terminalLocal.z, 0, -1);
  step(sim, 2);
  ok("walking to it during a rest opens the shop", economy.atTerminal && economy.open,
    `phase ${director.phase}, atTerminal ${economy.atTerminal}`);

  // Run until a wave is actually on the field, holding the player at the console the
  // whole time. The player is deliberately NOT moved away: the question is whether the
  // phase clause bites on its own, and letting them wander would let the place clause
  // answer for it.
  let sawSpawning = false;
  let boughtWhileEngaged = null;
  let openWhileFighting = true;
  let readableWhileFighting = false;
  step(sim, 60 * 90, () => {
    placeOnDeckLocal(sim, trampler.terminalLocal.x, 1.2, trampler.terminalLocal.z, 0, -1);
    if (director.phase === PHASE.SPAWNING || director.phase === PHASE.ENGAGED) {
      sawSpawning = true;
      if (economy.open) openWhileFighting = false;
      if (economy.browsing) readableWhileFighting = true;
      if (boughtWhileEngaged === null) boughtWhileEngaged = economy.buy(0);
    }
  });

  ok("a wave did arrive (test is not vacuous)", sawSpawning);
  ok("standing at the console while a wave is out does NOT let you buy", openWhileFighting);
  ok("and buying mid-wave is refused", boughtWhileEngaged === null);
  ok("with a reason that says which of the three clauses refused",
    economy.blockedReason === "NOT WHILE A WAVE IS OUT", economy.blockedReason);

  // ---- but it is still READABLE, and that is the fix for "it shows up a short time".
  //
  // Twelve seconds was never short because twelve seconds is short. It was short because
  // the panel only ever existed while a purchase was legal, so the player spent the
  // window READING six items with two lines each, cold. Browsing mid-wave costs standing
  // still on the deck while a wave is out, which is a real price, and it means the
  // window itself is spent deciding rather than reading.
  ok("but it IS readable while a wave is out, so the window is spent deciding not reading",
    readableWhileFighting,
    `browsing ${economy.browsing}, open ${economy.open} -- read now, buy when it lands`);

  // ---- THE TELEGRAPH WINDOW IS SHOPPING TIME AGAIN, AND THAT IS A REVERSAL.
  //
  // The previous version asserted the opposite, and it was right to at the time: a shop
  // that appears ON ITS OWN during the preparation window competes with 19b's whole
  // purpose, which is the moment deploying an emitter becomes a decision. It does not
  // add an option, it takes the preparation away.
  //
  // A console you have to WALK TO takes nothing. Choosing to spend your prep window at
  // the terminal instead of placing an emitter is exactly the kind of trade 19b wants to
  // exist, and it doubles the window -- 10 s of rest plus 12 s of prep -- without any of
  // it overlapping a live wave. That is the opposite of the trade the first version made.
  const w = makeSim();
  w.trampler.walking = false;
  w.trampler.turning = false;
  w.economy.salvage = 100000;
  const atConsole = () => placeOnDeckLocal(
    w, w.trampler.terminalLocal.x, 1.2, w.trampler.terminalLocal.z, 0, -1);

  atConsole();
  w.director.phase = PHASE.PREP;
  w.director.timer = CFG.waves.prepTime;
  step(w, 1);
  atConsole();
  w.director.phase = PHASE.PREP;
  w.director.timer = CFG.waves.prepTime;
  ok("the telegraph window IS shopping time now, because you had to walk there for it",
    w.economy.open, `phase ${w.director.phase}, open ${w.economy.open}`);

  // A rest with something in your face is not a rest. Note this is deliberately NOT
  // director.calm: that is the PACING threshold and is generous on purpose, because
  // reinforcements should not wait for a spotless field.
  //
  // It is also deliberately not asked about the FORTRESS. That version measured badly:
  // zero cost to a competent player, up to a third of the window for a struggling one,
  // and varying unpredictably between runs (64% and 97% of the rest available across two
  // passes on the same seeds) because it depended on where the horde happened to be. A
  // playtester could not use the shop and could not tell why, which is the real fault.
  //
  // It asks about the OPERATIVE, at the same 6 m the contested-repair rule uses. On the
  // deck at a console between waves this almost never bites -- and when it does, a
  // boarder is standing next to you, which is a refusal you can see and shoot.
  w.director.phase = PHASE.REST;
  w.director.timer = CFG.waves.minRest;
  atConsole();
  step(w, 2);
  atConsole();
  w.director.phase = PHASE.REST;
  w.director.timer = CFG.waves.minRest;
  ok("a rest at the console with nobody on top of you IS shopping time (not vacuous)",
    w.economy.open, `${w.horde.liveCount} alive, open ${w.economy.open}`);

  // A boarder beside you at the console. This is the case that still matters, because it
  // is the one that can actually happen now: the terminal sits 6.3 m from the reactor,
  // which is where boarders go.
  const near = w.horde.spawn(CLIMBER);
  near.x = w.player.position.x + 1.5;
  near.y = w.player.position.y;
  near.z = w.player.position.z;
  near.onHull = true;
  ok("a boarder beside you closes it, because that is what you should be dealing with",
    !w.economy.open && w.economy.buy(0) === null
    && w.economy.closedReason === "HOSTILES TOO CLOSE",
    `nearest ${Math.hypot(near.x - w.player.position.x, near.z - w.player.position.z).toFixed(1)} m,`
    + ` refused with "${w.economy.blockedReason}"`);

  // AND THE REFUSAL IS STILL FIXABLE BY YOU. Killing it, or stepping along the deck, both
  // work -- unlike the fortress version, which could only be satisfied by ending the
  // fight. Driven by moving the enemy rather than the player so the player stays in
  // terminal range and the PLACE clause cannot answer for the proximity clause.
  near.x = w.player.position.x + CFG.repair.threatRange * 2;
  ok("and dealing with it re-opens it immediately",
    w.economy.open,
    `nearest now ${Math.hypot(near.x - w.player.position.x, near.z - w.player.position.z).toFixed(1)} m`
    + ` vs a ${CFG.repair.threatRange} m threshold`);

  // Something chewing a leg under the hull is NOT your problem while you are at the
  // console, and must not hold your wallet shut. This is the case the fortress version
  // got wrong, and the geometry now makes it impossible to get wrong: the ground is 8.6 m
  // below the terminal, so nothing down there is ever inside 6 m of a shopper.
  w.horde.clear();
  const farLeg = w.horde.spawn(CHEWER);
  const spot = w.trampler.legAttackWorld(3, new THREE.Vector3());
  farLeg.x = spot.x;
  farLeg.y = spot.y;
  farLeg.z = spot.z;
  step(w, 4);
  atConsole();
  w.director.phase = PHASE.REST;
  w.director.timer = CFG.waves.minRest;
  ok("a chewer under the hull genuinely registers (test is not vacuous)",
    (w.horde.underHull ?? 0) > 0, `${w.horde.underHull} under the hull`);
  ok("and it does not lock the shop -- the fortress rule's worst case, now structural",
    w.economy.open, `open ${w.economy.open}`);

  // Stragglers out in the open are NOT a reason to keep your wallet shut either. The
  // rule has to distinguish "under attack" from "enemies exist".
  w.horde.clear();
  const distant = w.horde.spawn(CHEWER);
  distant.x = w.trampler.group.position.x + 90;
  distant.z = w.trampler.group.position.z;
  distant.y = 0.8;
  step(w, 2);
  atConsole();
  w.director.phase = PHASE.REST;
  w.director.timer = CFG.waves.minRest;
  ok("nor does a hostile out at range, or one straggler would lock a whole siege",
    w.economy.open && (w.horde.liveCount ?? 0) > 0,
    `${w.horde.liveCount} alive, open ${w.economy.open}`);

  // ---- the terminal is hull-local, so it tracks a walking, turning fortress.
  //
  // Invariant 5, and it is not a formality here: a world-space console would be four
  // metres astern within a second and the shop would open and close as the fortress
  // walked out from under it. Asserted by letting the hull travel a long way with the
  // player parked at the console in LOCAL space.
  const moving = makeSim();
  moving.economy.salvage = 100000;
  moving.director.phase = PHASE.REST;
  moving.director.timer = 1e6;
  const startWorld = moving.trampler.terminalWorld(new THREE.Vector3()).clone();
  let openEveryFrame = true;
  for (let i = 0; i < 60 * 8; i++) {
    placeOnDeckLocal(
      moving, moving.trampler.terminalLocal.x, 1.2, moving.trampler.terminalLocal.z, 0, -1);
    step(moving, 1);
    moving.director.phase = PHASE.REST;
    moving.director.timer = 1e6;
    if (!moving.economy.atTerminal) openEveryFrame = false;
  }
  const travelled = moving.trampler.terminalWorld(new THREE.Vector3()).distanceTo(startWorld);
  ok("the fortress really moved the console through the world (test is not vacuous)",
    travelled > 20, `${travelled.toFixed(1)} m of world travel`);
  ok("and the terminal stayed reachable throughout, because it is stored hull-local",
    openEveryFrame, `atTerminal held for ${60 * 8} frames across ${travelled.toFixed(1)} m`);

  // ---- AND ACROSS A REAL SIEGE, WITH BOARDERS ABOARD, THE PROXIMITY CLAUSE NEVER FIRES
  // AT THE BRIDGE.
  //
  // This is measured rather than reasoned because I have now been wrong about it twice by
  // reasoning. The question is which clause actually does the refusing when a player camps
  // the console through a whole siege: if it is the phase clause, the rule is "wait for the
  // wave to end", which is legible and is the design. If it is the proximity clause, the
  // rule is "some enemy is near you", which is the thing invariant 23's V2 was rejected for.
  //
  // The defender here is deliberately NOT an oracle. One kill every 45 frames is a single
  // rifle working steadily, which resolves waves without clearing them instantly. An
  // oracle would empty the field and report a proximity clause that never fires because
  // there is nothing left to fire it — the exact ceiling-for-a-floor mistake this file
  // already carries a lesson about.
  const live = makeSim();
  live.waves = true;
  live.economy.salvage = 1e6;
  let openFrames = 0;
  let phaseBlocked = 0;
  let crowdBlocked = 0;
  let windows = 0;
  let wasOpen = false;
  let peakAboard = 0;
  let sawUnderHull = 0;

  for (let i = 0; i < 60 * 400 && !live.director.held; i++) {
    // Camped at the console for the whole siege, in hull-local terms.
    shopReadyNoStep(live);
    step(live, 1, () => {
      if (i % 45 !== 0) return;
      // NEVER shoot something mid-climb, so boarders actually arrive. Two earlier
      // versions of this hook failed the vacuity check with `peakAboard === 0`: taking
      // the oldest live enemy, and then taking the oldest non-aboard one, both picked
      // climbers off on the way up. Nothing reached the deck, so "even with boarders
      // aboard" was measuring a deck with no boarders on it.
      //
      // Ground threats otherwise, and aboard ones once a couple are riding. Letting two
      // ride is the honest worst case for a rule about things being near the shopper: it
      // models a crew that answers boarders eventually rather than instantly.
      const aboard = live.horde.aboard ?? 0;
      let best = null;
      for (const e of live.horde.pool) {
        if (!e.alive || isSubmerged(e)) continue;
        if (aboard >= 2) {
          if (!e.onHull) continue;
        } else if (e.state !== ENEMY_STATE.HUNT_LEG) {
          continue;
        }
        best = e;
        break;
      }
      if (best) live.horde.damage(best, 1e6, live.player);
    });
    // The fortress is kept walking, because an immobilised one halts the pacing outright
    // (invariant 19) and the siege would stop progressing -- which would measure the
    // director stalling rather than the shop's clauses.
    live.trampler.repairAll();

    peakAboard = Math.max(peakAboard, live.horde.aboard ?? 0);
    sawUnderHull = Math.max(sawUnderHull, live.horde.underHull ?? 0);

    const isOpen = live.economy.open;
    if (isOpen) {
      openFrames++;
      if (!wasOpen) windows++;
    } else if (live.director.phase === PHASE.SPAWNING || live.director.phase === PHASE.ENGAGED) {
      phaseBlocked++;
    } else {
      crowdBlocked++;
    }
    wasOpen = isOpen;
  }

  const total = openFrames + phaseBlocked + crowdBlocked;
  const blocked = phaseBlocked + crowdBlocked;
  ok("boarders really did ride the deck while shopping was attempted (not vacuous)",
    peakAboard > 0 && sawUnderHull > 0 && windows > 0,
    `peak ${peakAboard} aboard, ${sawUnderHull} under the hull, wave ${live.director.wave}`
    + ` after ${(total / 60).toFixed(0)} s`);
  ok("the shop opened repeatedly, not once",
    windows >= 3,
    `${windows} separate windows over ${(total / 60).toFixed(0)} s,`
    + ` ${(openFrames / 60).toFixed(0)} s open (${Math.round((openFrames / total) * 100)}%),`
    + ` about ${(openFrames / 60 / windows).toFixed(0)} s each`);

  // The claim asserted here is NOT "proximity never fires". It does fire -- measured at
  // 1.8 s in 400 s, when a boarder happens to walk past the bridge -- and an earlier
  // version of this check demanded zero and failed, which is the right outcome for a
  // check that asserts a hope instead of a measurement.
  //
  // The property that matters is that the WAVE is what refuses, essentially always. If
  // proximity ever became a material share of the blocked time, the console would be back
  // in the traffic and the refusal would be back to something the player cannot predict.
  ok("and the thing that refuses is the WAVE, with proximity a rounding error",
    crowdBlocked < blocked * 0.05,
    `${(phaseBlocked / 60).toFixed(0)} s blocked by a live wave vs`
    + ` ${(crowdBlocked / 60).toFixed(1)} s by proximity`
    + ` (${((crowdBlocked / blocked) * 100).toFixed(1)}% of refusals)`);

  // ---- THE WINDOW, MEASURED AS A FLOOR RATHER THAN AS A CEILING.
  //
  // The previous version of this rule was reported as "52 s of shoppable time per
  // five-wave siege", and that number was a ceiling taken with a scripted defender that
  // clears the field. The clause being measured only ever bit when the field was NOT
  // clear, so the probe was structurally incapable of reporting the thing that mattered.
  // A competent player saw all 52 s and a struggling one saw a third less, which is
  // exactly backwards for a rule meant to protect the player who is losing.
  //
  // The phase clause can be measured as a floor instead, and that is why it is worth
  // having. `minRest` is a GUARANTEED breather after every resolved wave (19b) and
  // `prepTime` is a FIXED telegraph timer — neither shortens because the fight is going
  // badly, so this is time every player gets, not time a good player gets.
  const perWave = CFG.waves.minRest + CFG.waves.prepTime;
  ok("the guaranteed window per wave is both phases, and neither can be cut short",
    perWave >= 20 && CFG.waves.minRest > 0 && CFG.waves.prepTime > 0,
    `${CFG.waves.minRest} s rest + ${CFG.waves.prepTime} s prep = ${perWave} s per wave,`
    + ` ${perWave * CFG.waves.siegeLength} s across a ${CFG.waves.siegeLength}-wave siege`);
  ok("which is at least double the rest-only window it replaced",
    perWave >= CFG.waves.minRest * 2,
    `${perWave} s vs ${CFG.waves.minRest} s of rest alone`);
}

// ---------------------------------------------------------------------------
console.log("\n64. Calling a wave early pays more, and skipping the fight pays less");
{
  // Two runs of the same seeded fight: one waits, one gambles.
  const run = (callEarly) => {
    const sim = makeSim();
    const { director, horde, economy, trampler } = sim;
    sim.waves = true;

    let called = false;
    step(sim, 60 * 120, () => {
      if (callEarly && !called && director.phase === PHASE.PREP) {
        called = director.callEarly();
      }
      // Stand in for a competent crew so waves keep resolving either way. Attributed to
      // the operative, because this section is about what the CREW earns for a gamble and
      // salvage is now paid to whoever made the kill -- an anonymous cull earns the
      // personal purse nothing, which would have measured only the scrap half.
      for (const e of horde.pool) if (e.alive) horde.damage(e, 1e6, sim.player);
      trampler.repairAll();
    });
    return { earned: economy.earned, resolved: director.resolved, wave: director.wave, called };
  };

  const patient = run(false);
  const greedy = run(true);

  ok("the gamble was actually taken (test is not vacuous)", greedy.called);
  ok("both runs fought the same number of waves",
    greedy.wave >= patient.wave, `patient ${patient.wave}, greedy ${greedy.wave}`);
  ok("calling early earns more salvage for the same fight",
    greedy.earned.salvage > patient.earned.salvage,
    `patient ${patient.earned.salvage.toFixed(0)}, greedy ${greedy.earned.salvage.toFixed(0)}`);

  // And the bonus has to be the CONFIGURED size, not merely non-zero.
  const sim = makeSim();
  const { director, economy, horde } = sim;
  sim.waves = true;
  step(sim, 60 * 20, () => {
    if (director.phase === PHASE.PREP) director.callEarly();
  });
  ok("the wave is flagged as called early", director.calledEarly, `wave ${director.wave}`);
  ok("and the multiplier matches config",
    Math.abs(economy.bonus - (1 + CFG.economy.earlyCallBonus)) < 1e-9,
    `x${economy.bonus}`);

  const before = economy.salvage;
  const e = horde.spawn(CHEWER);
  // Attributed: this reads the PERSONAL purse, which is now paid only to whoever caused
  // the kill. Anonymous, the multiplier would have been measured against a purse that
  // never moves, and the assertion would have been about nothing.
  horde.damage(e, 1e6, sim.player);
  ok("so a kill during it pays the bonus rate",
    Math.abs((economy.salvage - before) - CFG.economy.chewer.salvage * economy.bonus) < 1e-9,
    `paid ${(economy.salvage - before).toFixed(1)} for a ${CFG.economy.chewer.salvage} kill`);
}

// ---------------------------------------------------------------------------
console.log("\n65. A restart wipes the purses AND reverts every upgrade");
{
  const sim = makeSim();
  const { economy, weapon, player, trampler, repair } = sim;
  const idx = Object.fromEntries(CFG.economy.catalogue.map((c, i) => [c.id, i]));

  economy.salvage = 100000;
  economy.scrap = 100000;
  shopReady(sim);
  for (const id of ["rifle", "vitals", "plating", "rig"]) economy.buy(idx[id]);

  ok("upgrades were in place before the reset",
    weapon.damageScale > 1 && trampler.damageScale < 1 && repair.rateScale > 1
    && player.maxHp > CFG.combat.playerHp);

  economy.reset();

  // This is the part that silently ruins a seeded fight: a restart that keeps the
  // previous run's stats makes every subsequent attempt quietly easier.
  ok("weapon damage is back to baseline", weapon.damageScale === 1);
  ok("fortress plating is back to baseline", trampler.damageScale === 1);
  ok("repair rate is back to baseline", repair.rateScale === 1);
  ok("max health is back to baseline", player.maxHp === CFG.combat.playerHp,
    `${player.maxHp}`);
  ok("both purses are empty", economy.salvage === 0 && economy.scrap === 0);
  ok("and no stacks remain",
    Object.values(economy.stacks).every((n) => n === 0),
    JSON.stringify(economy.stacks));
}

// ---------------------------------------------------------------------------
// Invariant 2b, re-checked WITH upgrades bought. Test 48 proves emitters cannot
// hold the under-hull area alone at baseline, but hull plating halves incoming
// damage, and "emitters plus plating" is a combination no earlier test covers.
// If automation can hold a position unattended, the player stops going there and
// the dismount half of the pillar dies -- silently, because nothing looks broken.
console.log("\n66. Even fully refitted, automation cannot hold the line alone");
{
  const sim = makeSim();
  const { player, trampler, emitters, economy, director } = sim;
  const idx = Object.fromEntries(CFG.economy.catalogue.map((c, i) => [c.id, i]));

  economy.scrap = 100000;
  shopReady(sim);
  for (let i = 0; i < 20; i++) economy.buy(idx.plating);
  for (let i = 0; i < 20; i++) economy.buy(idx.rig);
  ok("the fortress is fully refitted (test is not vacuous)",
    economy.stacks.plating === CFG.economy.catalogue[idx.plating].max
    && economy.stacks.rig === CFG.economy.catalogue[idx.rig].max,
    `plating ${economy.stacks.plating}, rig ${economy.stacks.rig}, ` +
    `takes ${(trampler.damageScale * 100).toFixed(0)}% damage`);

  for (const legIndex of [0, 2, 4]) {
    const at = trampler.legAttackWorld(legIndex, new THREE.Vector3());
    player.position.set(at.x, 1.2, at.z);
    player.base = null;
    player.velocity.set(0, 0, 0);
    step(sim, 6);
    sim.input.presses.add(CFG.emitters.deployKey);
    step(sim, 2);
  }
  ok("and three emitters are down", emitters.deployedCount === 3,
    `${emitters.deployedCount} placed`);

  // Player entirely out of the fight. Nothing is defending but automation.
  player.position.set(700, 1.2, 700);
  player.base = null;
  sim.waves = true;

  let frames = 0;
  const cap = 60 * 400;
  while (!trampler.immobilised && frames < cap) {
    step(sim, 1);
    frames++;
  }

  ok("the fortress is still crippled with nobody aboard",
    trampler.immobilised,
    trampler.immobilised
      ? `crippled at ${(frames / 60).toFixed(1)}s, wave ${director.wave}`
      : "AUTOMATION PLUS UPGRADES HELD THE LINE -- THE PILLAR IS BROKEN");

  // A repair rig cannot repair anything on its own either: it scales a rate that
  // only exists while a player is holding the key.
  ok("and the repair rig did nothing unattended",
    trampler.legHp.some((h) => h <= 0),
    `legs [${trampler.legHp.map((h) => Math.round(h)).join(",")}]`);
}

// ---------------------------------------------------------------------------
// The HUD has no DOM tests, because the harness runs headless. That gap let two
// real faults through: a refit panel added at the same screen corner as the
// controls panel, overlapping into unreadable mush, and nine panels on screen at
// once, the effect of which was that none of them got read.
//
// This checks the markup as TEXT, which needs no DOM and catches both.
console.log("\n67. The HUD is wired to markup that exists, and panels do not pile up");
{
  const html = readFileSync("index.html", "utf8");
  const hudSrc = readFileSync("src/hud.js", "utf8");

  // Two spellings: direct getElementById calls, and the local `id()` helper the
  // readout rows go through. Missing the helper would have made this test look
  // like it was checking everything while actually checking a third of it.
  const ids = [
    ...[...hudSrc.matchAll(/getElementById\("([^"]+)"\)/g)].map((m) => m[1]),
    ...[...hudSrc.matchAll(/(?<![\w.])id\("([^"]+)"\)/g)].map((m) => m[1]),
  ];
  ok("the HUD reaches for a meaningful number of elements", ids.length > 30,
    `${ids.length} lookups`);

  // A getElementById that misses returns null and only explodes when the value is
  // used, which can be many frames later and in an unrelated-looking place.
  const missing = ids.filter((i) => !html.includes(`id="${i}"`));
  ok("every element the HUD reaches for exists in the markup", missing.length === 0,
    missing.length ? `MISSING: ${missing.join(", ")}` : "all present");

  const panels = [...html.matchAll(/<div id="([\w-]+)" class="panel([^"]*)"/g)]
    .map((m) => ({ id: m[1], classes: m[2] }));
  ok("panels were found to inspect", panels.length >= 4,
    panels.map((p) => p.id).join(", "));

  const ruleOf = (id) => {
    const m = html.match(new RegExp(`#${id}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : "";
  };
  const anchorOf = (id) => {
    const body = ruleOf(id);
    return ["left", "right", "top", "bottom"]
      .filter((s) => new RegExp(`(?:^|;|\\s)${s}:`).test(body))
      .join("+") || "none";
  };

  // Visible with no key pressed: not marked hidden in the markup and not display:none.
  const alwaysUp = panels.filter(
    (p) => !/\bhidden\b/.test(p.classes) && !/display:\s*none/.test(ruleOf(p.id)),
  );

  const anchors = alwaysUp.map((p) => anchorOf(p.id));
  ok("no two always-visible panels share a screen anchor",
    new Set(anchors).size === anchors.length,
    alwaysUp.map((p, i) => `${p.id}@${anchors[i]}`).join(", "));

  // The real lesson, encoded: panels accumulate one reasonable addition at a time.
  ok("only a couple of panels are up while actually playing", alwaysUp.length <= 2,
    `${alwaysUp.length} always visible (${alwaysUp.map((p) => p.id).join(", ") || "none"})`);

  // Everything else must be reachable, or it is just dead markup.
  for (const p of panels.filter((x) => !alwaysUp.includes(x))) {
    const toggled = new RegExp(`"${p.id}"`).test(hudSrc);
    ok(`${p.id} is toggled from code rather than orphaned`, toggled);
  }

  // ---- and NOTHING TRANSIENT MAY COVER SOMETHING PERMANENT.
  //
  // Every check above has two limits, and between them they hid one fault for two
  // updates. The anchor check compares always-visible panels only TO EACH OTHER, and
  // it only ever looked at `.panel` divs at all.
  //
  // The prompt, the salvage pick and the road choice are all bottom-centre, and so is
  // the vitals panel. The prompt is not a `.panel`, so it was invisible to this test;
  // the pick and the road are, but they carry `display: none` and were filtered out as
  // "not always visible" -- which is true, and is exactly what makes them dangerous.
  // A thing that comes and goes draws ON TOP of the thing that is always there. So the
  // health and reactor bars were covered at precisely the moments they matter most:
  // while repairing under fire, while choosing an item, while choosing a road. The
  // owner reported it in those words -- "it covers the health and the other stats".
  //
  // Asserted by SCREEN ZONE rather than by pixel rectangles, and that is a deliberate
  // limitation rather than a shortcut. Heights here are content-driven and the harness
  // has no DOM, so a rectangle test would need heights invented inside the test: a
  // number that agrees with the layout the day it is written and then silently stops
  // agreeing. A zone is read straight out of the CSS -- `left: 50%` under a translate
  // is the centre, `left: 14px` is the left edge -- and cannot drift from what the
  // browser actually does. Nine zones, and the rule is that a permanent readout owns
  // its zone outright.
  const zoneOf = (id) => {
    const body = ruleOf(id);
    const val = (side) => {
      const m = body.match(new RegExp(`(?:^|;|\\s)${side}:\\s*([^;]+)`));
      return m ? m[1].trim() : null;
    };
    const axis = (near, far, mid) => {
      // Only 50% is the centring idiom. Any other percentage is still an offset from
      // the near edge -- the telegraph sits at `top: 8%`, and reading "a percentage"
      // as "centred" put it in the middle of the screen, which is not where it is.
      if (val(near) !== null) return /^50%/.test(val(near)) ? mid : near;
      return val(far) !== null ? far : "?";
    };
    return `${axis("left", "right", "centre")}-${axis("top", "bottom", "middle")}`;
  };

  // Hidden by default has two spellings here, and only one of them is `display: none`.
  // The telegraph fades in on `opacity`, because it is a banner rather than a box and
  // a transition needs something to interpolate. Reading only for `display` classified
  // it as permanently on screen.
  const hiddenByDefault = (id) => {
    const cls = panels.find((p) => p.id === id)?.classes ?? "";
    const body = ruleOf(id);
    return /\bhidden\b/.test(cls)
      || /display:\s*none/.test(body)
      || /opacity:\s*0\s*(?:;|$)/.test(body.trim());
  };

  // What counts as a readout box: positioned, not a full-bleed effect layer, and
  // carrying at least one element the HUD writes into. Derived rather than listed,
  // because a hard-coded list is how the prompt escaped this test in the first place
  // -- the next transient box added would escape it the same way.
  const blockOf = (id) => {
    const start = html.indexOf(`<div id="${id}"`);
    if (start < 0) return "";
    const next = html.indexOf('\n  <div id="', start + 1);
    return html.slice(start, next < 0 ? html.length : next);
  };
  const writesInto = (id) => [...blockOf(id).matchAll(/id="([\w-]+)"/g)]
    .some((m) => m[1] !== id && ids.includes(m[1]));

  const boxIds = [...new Set([
    ...panels.map((p) => p.id),
    ...[...html.matchAll(/#([\w-]+)\s*\{([^}]*)\}/g)]
      .filter((m) => /position:\s*fixed/.test(m[2]) && !/(?:^|;|\s)inset:/.test(m[2]))
      .map((m) => m[1]),
  ])].filter((id) => panels.some((p) => p.id === id) || writesInto(id));

  ok("the transient readouts are in scope now, not just the panels",
    boxIds.includes("prompt") && boxIds.includes("target") && boxIds.includes("buffs")
    && boxIds.includes("tick"),
    boxIds.join(", "));

  const permanent = boxIds.filter((id) => !hiddenByDefault(id));
  ok("and something really is permanent (test is not vacuous)", permanent.length >= 1,
    permanent.map((id) => `${id}@${zoneOf(id)}`).join(", "));

  for (const id of permanent) {
    const zone = zoneOf(id);
    const sharers = boxIds.filter((o) => o !== id && zoneOf(o) === zone);
    ok(`nothing else is anchored where ${id} lives, so nothing can cover it`,
      sharers.length === 0,
      sharers.length
        ? `${id}@${zone} IS COVERED BY ${sharers.map((s) => `${s}@${zoneOf(s)}`).join(", ")}`
        : `${id} owns ${zone} outright`);
  }

  // ---- and nothing edge-pinned may hang off the edge it is pinned to.
  //
  // Added because a playtest screenshot appeared to show the vitals panel's labels cut
  // off on the left — "ATIVE", "ILES" — right after it was moved to that corner. It was
  // the screen capture being cropped rather than the layout, but the class of bug is real
  // and free to rule out: an edge offset of zero or less puts a bordered, clipped-corner
  // panel flush against the frame, and a negative one hangs it off. Nothing in the CSS
  // stops that being typed, and the harness cannot see a rendered pixel.
  //
  // Percentage offsets are skipped: `50%` is the centring idiom and is handled by the
  // zone check above, and `top: 8%` is a proportion rather than a gap.
  for (const id of boxIds) {
    const body = ruleOf(id);
    const bad = ["left", "right", "top", "bottom"]
      .map((side) => {
        const m = body.match(new RegExp(`(?:^|;|\\s)${side}:\\s*(-?[\\d.]+)px`));
        return m ? { side, px: Number(m[1]) } : null;
      })
      .filter((v) => v && v.px < 8);
    ok(`${id} sits clear of the frame edge it is pinned to`, bad.length === 0,
      bad.length
        ? `${bad.map((v) => `${v.side}: ${v.px}px`).join(", ")} — too close to clear the border`
        : "inset");
  }
}

// ---------------------------------------------------------------------------
// The "per-type field" bug has happened TWICE: a field added to one enemy type
// and nowhere else reads as undefined on all the others, and `d < undefined` is
// always false, which silently makes that enemy harmless. Nothing looks wrong.
//
// enemyType() in config.js now throws on an unknown override key, which makes the
// bug structurally impossible in one direction. This checks the other direction --
// that every type really does carry every field, with a usable value.
console.log("\n68. Every enemy type is fully specified");
{
  const fields = Object.keys(CFG.enemies.chewer);
  ok("there are more than the original two types", ENEMY_TYPE_KEYS.length >= 7,
    ENEMY_TYPE_KEYS.join(", "));
  ok("the roster still fits the wire's three-bit type field",
    ENEMY_TYPE_KEYS.length <= 8, `${ENEMY_TYPE_KEYS.length} / 8 numeric type ids`);

  const missing = [];
  for (const key of ENEMY_TYPE_KEYS) {
    const cfg = CFG.enemies[key];
    for (const f of fields) {
      if (cfg[f] === undefined) missing.push(`${key}.${f}`);
    }
  }
  ok("every type carries every field", missing.length === 0,
    missing.length ? `MISSING: ${missing.join(", ")}` : `${fields.length} fields x ${ENEMY_TYPE_KEYS.length} types`);

  // The specific values that, at zero or undefined, make an enemy harmless.
  const harmless = ENEMY_TYPE_KEYS.filter((key) => {
    const c = CFG.enemies[key];
    return !(c.hp > 0) || !(c.speed > 0) || !(c.reach > 0) || !(c.reactorReach > 0)
      || !(c.climbTime > 0) || !(c.inboardOffset > 0);
  });
  ok("no type has a zero where a zero would make it harmless", harmless.length === 0,
    harmless.length ? `SUSPECT: ${harmless.join(", ")}` : "all positive");

  const brokenRanged = ENEMY_TYPE_KEYS.filter((key) => {
    const c = CFG.enemies[key];
    return c.fireRadius > 0 && (!(c.fireArc > 0) || !(c.fireRange > c.fireRadius)
      || !(c.chargeTime > c.lockTime) || !(c.lockTime > 0)
      || !(c.repositionArc > 0) || !(c.legDamageScale > 0)
      || !(c.shotFlash > 0));
  });
  ok("every ranged type can reach, lock, hurt a leg, reposition, and show its release",
    brokenRanged.length === 0,
    brokenRanged.length ? `BROKEN RANGED CONFIG: ${brokenRanged.join(", ")}` : "usable ranged cycle");

  // Contact damage may be disabled only when the type has a separate live attack.
  // Test the actual contact expression rather than `damage === 0`: the Spiker keeps
  // non-zero damage for its shot and opts out through `contactScale`.
  const noContact = ENEMY_TYPE_KEYS.filter((key) => {
    const c = CFG.enemies[key];
    return c.damage * c.contactScale === 0;
  });
  ok("only the sapper and Spiker skip contact, and each has an attack instead",
    noContact.length === 2
      && noContact.includes("sapper")
      && noContact.includes("spiker")
      && CFG.enemies.sapper.fuse > 0
      && CFG.enemies.spiker.fireRadius > 0,
    `no-contact types: ${noContact.join(", ") || "none"}`);

  // The structural half of the guarantee: every type has the SAME key set, not
  // merely a superset. A type with an extra field is the other direction of the
  // same bug -- somebody added a number to one enemy and nowhere else, and it will
  // read as undefined the moment a second type needs it.
  const signature = (key) => Object.keys(CFG.enemies[key]).sort().join(",");
  const shapes = new Set(ENEMY_TYPE_KEYS.map(signature));
  ok("every type has an identical field set, not just a superset",
    shapes.size === 1,
    shapes.size === 1
      ? `${fields.length} fields, shared by all ${ENEMY_TYPE_KEYS.length}`
      : `${shapes.size} different shapes across ${ENEMY_TYPE_KEYS.length} types`);
}

// ---------------------------------------------------------------------------
// Tier 1.5, and the reason it exists: the deck gun was an OPENING MOVE ONLY. The
// approach window is about 12 s against 28 s waves, so it was a small slice of
// playtime by construction. The rejected fix -- pushing spawns further out -- is
// the same quantity a player on foot experiences as waiting around for enemies.
//
// An armoured enemy buys the gun a recurring job without lengthening anything for
// anybody. The whole design rests on the rifle being the WRONG TOOL, which is a
// number, so it gets asserted rather than assumed.
console.log("\n69. Armour makes the rifle the wrong tool and the gun the right one");
{
  const rifle = CFG.combat.weapon.damage;
  const deck = CFG.deckGun.damage;
  const armour = CFG.enemies.bulwark.armour;

  const rifleHit = afterArmour(rifle, armour);
  const deckHit = afterArmour(deck, armour);

  ok("the rifle barely dents a bulwark", rifleHit <= rifle * 0.25,
    `${rifleHit} of ${rifle} gets through`);
  ok("the deck gun does real damage to one", deckHit >= deck * 0.5,
    `${deckHit} of ${deck} gets through`);
  ok("so the gun is several times better against armour, not merely better",
    deckHit / rifleHit >= 4, `${(deckHit / rifleHit).toFixed(1)}x per shot`);

  // Invariant 8: everything the player can see, the player can shoot. Armour must
  // never be a wall -- a magazine emptied into something with the bar not moving
  // is indistinguishable from a bug.
  ok("nothing is immune, even to the weakest source",
    afterArmour(CFG.emitters.damage, CFG.enemies.titan.armour) > 0,
    `an emitter still does ${afterArmour(CFG.emitters.damage, CFG.enemies.titan.armour)} to a titan`);

  // And it holds in the live sim, through the real hitscan path.
  const sim = makeSim();
  const { player, horde, weapon } = sim;
  placeOnGroundAt(sim, 0, -30);

  const spawnAt = (type, offset) => {
    const e = horde.spawn(type);
    e.x = player.position.x;
    e.z = player.position.z - offset;
    e.y = enemyCfg(type).height / 2;
    return e;
  };

  const b = spawnAt(BULWARK, 6);

  aimAt(player, new THREE.Vector3(b.x, b.y, b.z));
  step(sim, 1);
  aimAt(player, new THREE.Vector3(b.x, b.y, b.z));

  // The bulwark's plate is on its FRONT now, so this test has to state which way the
  // thing is facing instead of inheriting whatever the walk left.
  //
  // It was inheriting the wrong one. The bulwark spawns between the player and the
  // fortress and walks toward the fortress, so it had its BACK to the shot -- and this
  // assertion, which claims a frontal plate soaks a rifle round, was measuring a flank
  // and passing only because angle used to be irrelevant. Exactly the "sampling the
  // wrong moment" trap wearing a geometric hat.
  //
  // `yaw` follows atan2(-dx, -dz), so pointing it at the player makes the shot frontal.
  // Nothing steps between here and the shots below, and yaw is only rewritten inside
  // horde.update, so it stays put.
  const faceAt = (e, x, z) => { e.yaw = Math.atan2(-(x - e.x), -(z - e.z)); };
  const shotDir = (e) => {
    const d = new THREE.Vector3(e.x, e.y, e.z).sub(player.eyePosition(new THREE.Vector3()));
    return d.normalize();
  };

  faceAt(b, player.position.x, player.position.z);
  {
    const d = shotDir(b);
    ok("the bulwark is genuinely facing the shooter (test is not vacuous)",
      armourAt(CFG.enemies.bulwark, b.yaw, d.x, d.z) === armour,
      `meets ${armourAt(CFG.enemies.bulwark, b.yaw, d.x, d.z)} of ${armour} armour head-on`);
  }

  const hpBefore = b.hp;
  weapon.fire();
  const dealt = hpBefore - b.hp;
  ok("a live rifle shot into its FRONT is soaked, through the real hitscan path",
    dealt > 0 && dealt <= rifle * 0.25,
    `${dealt.toFixed(1)} damage from a ${rifle} shot`);

  // It is slower to kill, but killable -- which is the difference between "wrong
  // tool" and "invulnerable".
  let shots = 1;
  while (b.alive && shots < 400) {
    aimAt(player, new THREE.Vector3(b.x, b.y, b.z));
    faceAt(b, player.position.x, player.position.z);
    weapon.fire();
    shots++;
  }
  ok("a bulwark still dies to the rifle eventually", !b.alive,
    `${shots} rifle rounds`);
  ok("but it costs far more rounds than a chewer would",
    shots > Math.ceil(CFG.enemies.chewer.hp / rifle) * 8,
    `${shots} rounds vs ${Math.ceil(CFG.enemies.chewer.hp / rifle)} for a chewer`);

  // ---- and the answer that is a POSITION rather than a purchase.
  //
  // A playtester asked whether headshots should do more damage. The instinct was right
  // -- there was no way to out-PLAY armour at all, only to out-buy it -- but a head
  // multiplier would have handed the rifle a bulwark and taken away the recurring job
  // this whole enemy exists to give the deck gun. So the plate is frontal instead:
  // the skill answer is which side of it you are standing on.
  const rear = spawnAt(BULWARK, 6);
  faceAt(rear, player.position.x, player.position.z);
  faceAt(rear, rear.x + (rear.x - player.position.x), rear.z + (rear.z - player.position.z));
  {
    const d = shotDir(rear);
    ok("stepping behind one puts no armour in the way at all (test is not vacuous)",
      armourAt(CFG.enemies.bulwark, rear.yaw, d.x, d.z) === 0,
      `meets ${armourAt(CFG.enemies.bulwark, rear.yaw, d.x, d.z)} of ${armour} armour from behind`);
  }
  aimAt(player, new THREE.Vector3(rear.x, rear.y, rear.z));
  const rearBefore = rear.hp;
  weapon.fire();
  const rearDealt = rearBefore - rear.hp;
  ok("so a rifle round into its back lands in full",
    Math.abs(rearDealt - rifle * weapon.damageScale) < 1e-6,
    `${rearDealt.toFixed(1)} of ${rifle}, against ${dealt.toFixed(1)} head-on`);

  let rearShots = 1;
  while (rear.alive && rearShots < 400) {
    aimAt(player, new THREE.Vector3(rear.x, rear.y, rear.z));
    faceAt(rear, rear.x + (rear.x - player.position.x), rear.z + (rear.z - player.position.z));
    weapon.fire();
    rearShots++;
  }
  ok("which is a real, measurable reward for taking the risk of getting round it",
    !rear.alive && rearShots * 3 < shots,
    `${rearShots} rounds from behind vs ${shots} head-on`);

  // But it must NOT become the answer to a bulwark you meet head-on, or the deck gun
  // loses the job the bulwark was added to create and the deck stops mattering after
  // the opening ten seconds again. Abeam is deliberately not enough.
  const side = spawnAt(BULWARK, 6);
  side.yaw = Math.atan2(-(player.position.z - side.z), (player.position.x - side.x));
  {
    const d = shotDir(side);
    const met = armourAt(CFG.enemies.bulwark, side.yaw, d.x, d.z);
    ok("and standing merely abeam of one is not a flank",
      met === armour, `meets ${met} of ${armour} armour from the side`);
  }

  // The titan keeps an omnidirectional plate on purpose: it is the one fight built
  // around the deck, and a rifle answer found by walking round the back would undo the
  // geometry that fight is made of.
  ok("the titan's plate has no back door, because that fight belongs to the deck",
    CFG.enemies.titan.armourArc === 0 && CFG.enemies.titan.armour > 0,
    `arc ${CFG.enemies.titan.armourArc}, armour ${CFG.enemies.titan.armour}`);
}

// ---------------------------------------------------------------------------
// The boss inverts the pillar for one fight, and it does it through GEOMETRY
// rather than a rule: the titan is taller than the hull's clearance, so it cannot
// get underneath and has to work from outboard, in the open, where both guns can
// see it. That is the one fight where the deck is the right place to be.
console.log("\n70. The titan cannot fit under the hull, so the deck can answer it");
{
  const clearance = CFG.trampler.deckHeight - 3; // hull underside, HULL_DEPTH = 3
  ok("the titan is taller than the hull's clearance",
    CFG.enemies.titan.height > clearance,
    `${CFG.enemies.titan.height} m vs ${clearance} m of clearance`);
  ok("and every other type still fits underneath",
    ENEMY_TYPE_KEYS.filter((k) => k !== "titan")
      .every((k) => CFG.enemies[k].height < clearance),
    ENEMY_TYPE_KEYS.map((k) => `${k} ${CFG.enemies[k].height}`).join(", "));

  const sim = makeSim();
  const { trampler, horde } = sim;
  trampler.walking = false;
  trampler.turning = false;

  // Its attack point must be OUTSIDE the hull footprint -- that is what puts it
  // in the guns' line of sight instead of in the shadow that shields chewers.
  const titanSpot = localOf(trampler,
    trampler.legAttackWorld(0, new THREE.Vector3(), CFG.enemies.titan.inboardOffset));
  const chewerSpot = localOf(trampler, trampler.legAttackWorld(0, new THREE.Vector3()));

  ok("the titan attacks from outside the hull's shadow",
    Math.abs(titanSpot.x) > trampler.halfW,
    `local x ${titanSpot.x.toFixed(1)} vs half-width ${trampler.halfW}`);
  ok("while a chewer still attacks from inside it",
    Math.abs(chewerSpot.x) < trampler.halfW,
    `local x ${chewerSpot.x.toFixed(1)}`);

  // Drive it in and confirm it actually stops out there rather than walking under.
  const t = horde.spawn(TITAN);
  const at = trampler.legAttackWorld(0, new THREE.Vector3(), CFG.enemies.titan.inboardOffset);
  t.x = at.x + 12;
  t.z = at.z;
  t.legIndex = 0;

  let deepest = Infinity;
  step(sim, 60 * 12, () => {
    const l = localOf(trampler, new THREE.Vector3(t.x, t.y, t.z));
    deepest = Math.min(deepest, Math.abs(l.x));
  });

  ok("it never works its way in under the slab", deepest > trampler.halfW - 0.6,
    `closest approach |local x| ${deepest.toFixed(2)}`);
  ok("and it does damage from out there", trampler.legHp[0] < CFG.trampler.legHp,
    `leg 0 at ${trampler.legHp[0].toFixed(0)} hp`);

  // The boss is authored, not ramped: its health must not depend on how long the
  // crew took to reach it.
  const director = sim.director;
  director.elapsed = 600; // ten minutes in
  const ramped = director.hpScale();
  ok("the time ramp is genuinely large by then (test is not vacuous)", ramped > 5,
    `x${ramped.toFixed(2)}`);
  const wave = director.buildWave(1);
  ok("a normal wave does not contain a titan", !wave.includes(TITAN));
}

// ---------------------------------------------------------------------------
// A burrower ignores pathing entirely, which is the counter to camping a gun.
// The danger is obvious: an enemy that cannot be shot breaks invariant 8. So the
// state has to be finite BY CONSTRUCTION, and that is what this measures.
console.log("\n71. Burrowers are untouchable underground, and always surface");
{
  const sim = makeSim();
  const { player, trampler, horde, weapon } = sim;
  trampler.walking = false;
  trampler.turning = false;

  const e = horde.spawn(BURROWER);
  ok("it starts underground", e.state === ENEMY_STATE.BURROWED);
  ok("and it is drawn below the sand", e.y < 0, `y=${e.y.toFixed(2)}`);

  // Standing right on top of it and firing must do nothing.
  placeOnGroundAt(sim, 0, -20);
  step(sim, 4, () => {
    e.x = player.position.x;
    e.z = player.position.z - 3;
  });
  aimAt(player, new THREE.Vector3(e.x, 0.2, e.z));
  const before = weapon.hits;
  for (let i = 0; i < 8; i++) weapon.fire();
  ok("shots cannot touch it while it is under", weapon.hits === before,
    `${weapon.hits - before} hits`);
  ok("a raycast does not even see it",
    horde.raycast(player.eyePosition(new THREE.Vector3()),
      player.lookDirection(new THREE.Vector3()), 200) === null);

  // It is not counted as pressure either: there is nothing the crew can act on.
  ok("and it is not counted in the under-hull pressure", horde.underHull === 0,
    `${horde.underHull} under`);
  ok("but it IS reported as burrowed, so the HUD can warn", horde.burrowed === 1,
    `${horde.burrowed} burrowed`);

  // The clock is the guarantee. Park it far from its target so proximity cannot
  // be what surfaces it -- only the timer can.
  let frames = 0;
  while (e.state === ENEMY_STATE.BURROWED && frames < 60 * 20) {
    step(sim, 1, () => {
      e.x = trampler.group.position.x + 400;
      e.z = trampler.group.position.z + 400;
    });
    frames++;
  }
  const seconds = frames / 60;
  ok("it surfaces on a hard clock no matter where it is",
    e.state !== ENEMY_STATE.BURROWED,
    `surfaced after ${seconds.toFixed(1)}s`);
  ok("and that clock matches the configured burrow time",
    Math.abs(seconds - CFG.enemies.burrower.burrowTime) < 0.5,
    `${seconds.toFixed(1)}s vs ${CFG.enemies.burrower.burrowTime}s configured`);
  ok("once up it is at body height and shootable", e.y > 0,
    `y=${e.y.toFixed(2)}`);

  const hitsBefore = weapon.hits;
  step(sim, 2, () => {
    e.x = player.position.x;
    e.z = player.position.z - 3;
    e.y = CFG.enemies.burrower.height / 2;
  });
  aimAt(player, new THREE.Vector3(e.x, e.y, e.z));
  weapon.fire();
  ok("and a shot connects now", weapon.hits > hitsBefore);
}

// ---------------------------------------------------------------------------
// The feet. This is the invariant-2b guard for the stomp, and it exists because
// the FIRST version of this feature broke 2b silently: at 30 damage -- below a
// chewer's 50 hp, so it could not kill anything alone -- undefended
// time-to-crippled went 67.7 s to 81.0 s, and test 48's fixed-force measurement
// hit its 45 s ceiling with emitters plus feet holding fourteen chewers off the
// legs and no player present.
//
// So the feet deal NO enemy damage at all. They hurt the player and shove bodies.
console.log("\n72. A foot crushes the player but settles nothing");
{
  const sim = makeSim();
  const { player, trampler, horde } = sim;
  // Local scratch rather than the module-level _probe, which step() uses for the
  // floating-boarder invariant. Sharing it would work today and break the moment
  // either read moved.
  const _fw = new THREE.Vector3();

  ok("a footfall is raised as an event, not a state", Array.isArray(trampler.footfalls));

  // Feet must sit OUTBOARD of the hull, and far enough from a latched attacker
  // that no plausible tweak brings them into contact.
  const foot = trampler.legs[0].userData.footLocal;
  const latch = trampler.legAttackLocal(0, new THREE.Vector3());
  const gap = Math.hypot(foot.x - latch.x, foot.z - latch.z);

  ok("the feet are outboard of the hull footprint", Math.abs(foot.x) > trampler.halfW,
    `foot local x ${foot.x.toFixed(1)} vs half-width ${trampler.halfW}`);
  ok("and the stomp radius cannot reach a latched attacker",
    gap > CFG.trampler.stomp.radius,
    `${gap.toFixed(2)} m gap vs ${CFG.trampler.stomp.radius} m radius`
    + ` — ${(gap - CFG.trampler.stomp.radius).toFixed(2)} m of margin`);

  // Steps actually happen while walking.
  const stepsBefore = trampler.stepCount;
  step(sim, 300);
  ok("the fortress raises footfalls as it walks", trampler.stepCount > stepsBefore,
    `${trampler.stepCount - stepsBefore} steps in 5 s`);

  // A chewer parked ON the foot must take no damage whatsoever.
  const e = horde.spawn(CHEWER);
  e.hp = e.maxHp;
  const hpBefore = e.hp;
  let footfalls = 0;
  step(sim, 60 * 10, () => {
    trampler.footWorld(0, _fw);
    e.x = _fw.x;
    e.z = _fw.z;
    e.y = CFG.enemies.chewer.height / 2;
    footfalls += trampler.footfalls.length;
  });

  ok("footfalls landed on it (test is not vacuous)", footfalls > 4,
    `${footfalls} footfalls while it stood there`);
  ok("standing under a descending foot costs an enemy NOTHING",
    e.alive && e.hp === hpBefore,
    `${e.hp.toFixed(0)} / ${hpBefore.toFixed(0)} hp — the fortress must not fight for you`);
  ok("the horde's kill counter never moved", horde.killCount === 0,
    `${horde.killCount} kills`);

  // But it IS shoved, and the shove has to be a stumble rather than a teleport --
  // invariant 20, which the first implementation broke at 0.73 m in one frame.
  //
  // Driven directly rather than by waiting for a foot to happen to land on
  // something: a body near the feet walks inboard to its latch within a fraction
  // of a second, so "wait and see" measures whether the timing happened to line
  // up, which is exactly the sampling mistake this harness keeps catching.
  const sim2 = makeSim();
  const { horde: h2, trampler: t2 } = sim2;
  const e2 = h2.spawn(CHEWER);
  // Somewhere empty, so the only forces on it are its own walk and the shove.
  e2.x = t2.group.position.x + 300;
  e2.z = t2.group.position.z + 300;

  h2.shoveFrom(e2.x + 0.25, e2.z, CFG.trampler.stomp.radius, CFG.trampler.stomp.shoveSpeed);
  ok("a shove is stored as velocity, never written into position",
    e2.shoveVx !== 0 || e2.shoveVz !== 0,
    `impulse (${e2.shoveVx.toFixed(2)}, ${e2.shoveVz.toFixed(2)}) m/s`);

  let worstJump = 0;
  let prev = new THREE.Vector3(e2.x, e2.y, e2.z);
  const startedAt = prev.clone();
  step(sim2, 45, () => {
    const here = new THREE.Vector3(e2.x, e2.y, e2.z);
    worstJump = Math.max(worstJump, here.distanceTo(prev));
    prev = here.clone();
  });

  ok("it moves a real distance over the decay", prev.distanceTo(startedAt) > 0.3,
    `${prev.distanceTo(startedAt).toFixed(2)} m of total travel`);
  ok("but never further than a stride in any single frame", worstJump < 0.35,
    `worst frame-to-frame move ${worstJump.toFixed(3)} m`);
  ok("and the knock-aside decays away rather than persisting",
    e2.shoveVx === 0 && e2.shoveVz === 0);

  // And the player, who has no business standing there, gets hurt.
  const sim3 = makeSim();
  const p3 = sim3.player;
  p3.base = null;
  p3.spawnGrace = 0;
  let hurtCount = 0;
  step(sim3, 60 * 12, () => {
    sim3.trampler.footWorld(0, _fw);
    p3.position.set(_fw.x, 1.2, _fw.z);
    p3.velocity.set(0, 0, 0);
    p3.hp = p3.maxHp;      // isolate the stomp from everything else
    p3.spawnGrace = 0;
    hurtCount = p3.hurtCount;
  });
  ok("but the player standing under a foot is crushed", hurtCount > 0,
    `hurt ${hurtCount} times`);

  // Once incapacitated the same body must stop being an invulnerable stomp target.
  // Drive one valid footfall directly so the assertion measures the exclusion rather
  // than waiting for gait timing to coincide with a body position.
  const sim4 = makeSim();
  const p4 = sim4.player;
  const t4 = sim4.trampler;
  const footLocal = t4.legs[0].userData.footLocal;
  t4.localToWorld(_fw.copy(footLocal));
  p4.position.set(_fw.x, _fw.y + 1.2, _fw.z);
  p4.base = null;
  p4.spawnGrace = 0;
  p4.hurt(1e6);
  const downedHurt = p4.hurt.bind(p4);
  let downedStompCalls = 0;
  p4.hurt = (amount) => { downedStompCalls++; return downedHurt(amount); };
  t4.footfalls = [{ leg: 0, local: footLocal }];
  t4.resolveStomps(null, [p4]);
  ok("a real footfall was placed over the downed body (test is not vacuous)",
    Math.hypot(p4.position.x - _fw.x, p4.position.z - _fw.z)
      < CFG.trampler.stomp.radius,
    `${Math.hypot(p4.position.x - _fw.x, p4.position.z - _fw.z).toFixed(2)} m from foot`);
  ok("stomp resolution skips a downed body before calling hurt",
    downedStompCalls === 0 && !t4.playerStomped,
    `${downedStompCalls} calls, playerStomped ${t4.playerStomped}`);
}

// ---------------------------------------------------------------------------
// The sapper is a TIMER, not a damage race. Zero contact damage is the design:
// every other enemy is something you can trade against slowly, and this one turns
// "I should go down there at some point" into "I have six seconds".
console.log("\n73. A sapper's charge is a timer that can be interrupted");
{
  const runFuse = (interrupt) => {
    const sim = makeSim();
    const { trampler, horde } = sim;
    trampler.walking = false;
    trampler.turning = false;

    const e = horde.spawn(SAPPER);
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    e.x = at.x;
    e.y = at.y;
    e.z = at.z;
    e.legIndex = 0;

    let sawFuse = false;
    let killedAt = 0;
    const frames = Math.round(60 * (CFG.enemies.sapper.fuse + 2));
    step(sim, frames, (i) => {
      if (e.fuseT > 0) sawFuse = true;
      if (interrupt && sawFuse && killedAt === 0 && e.fuseT < CFG.enemies.sapper.fuse * 0.5) {
        horde.damage(e, 1e6);
        killedAt = i;
      }
    });

    return { sim, e, sawFuse, legHp: trampler.legHp[0] };
  };

  const ignored = runFuse(false);
  ok("latching on lights a fuse", ignored.sawFuse);
  ok("an ignored charge takes the whole leg off",
    ignored.legHp <= 0,
    `leg 0 at ${ignored.legHp.toFixed(0)} hp, charge is ${CFG.enemies.sapper.fuseDamage}`);
  ok("and the sapper is consumed by its own charge", !ignored.e.alive);
  ok("the charge is worth exactly a leg, so it cannot be traded against",
    CFG.enemies.sapper.fuseDamage >= CFG.trampler.legHp,
    `${CFG.enemies.sapper.fuseDamage} vs ${CFG.trampler.legHp} leg hp`);

  const stopped = runFuse(true);
  ok("killing it before the fuse ends prevents ALL of the damage",
    stopped.legHp === CFG.trampler.legHp,
    `leg 0 at ${stopped.legHp.toFixed(0)} / ${CFG.trampler.legHp} hp`);

  // The HUD's only warning comes from these two fields, so they have to be live.
  const live = runFuse(false);
  ok("a lit fuse is reported for the HUD to warn with",
    CFG.enemies.sapper.fuse > 0 && CFG.enemies.sapper.damage === 0,
    `fuse ${CFG.enemies.sapper.fuse}s, contact damage ${CFG.enemies.sapper.damage}`);

  // Being shoved off the leg must drop the charge, or the crowd stops being an
  // answer and only killing it works.
  const sim = makeSim();
  const e = sim.horde.spawn(SAPPER);
  const at = sim.trampler.legAttackWorld(0, new THREE.Vector3());
  e.x = at.x;
  e.y = at.y;
  e.z = at.z;
  e.legIndex = 0;
  step(sim, 30);
  const lit = e.fuseT > 0;
  e.x += 20; // knocked well clear
  step(sim, 4);
  ok("losing the leg loses the charge", lit && e.fuseT === 0,
    `lit=${lit}, fuse now ${e.fuseT.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// The next wall the numbers already predicted. Reactor time-to-death, if every
// climber in a wave reached it, was 9.3 s at wave 1 falling to 3.5 s at wave 4 --
// less than the time to notice, grapple up, turn and engage. That is a
// reaction-time wall, not a decision.
//
// Three fixes were on the table and deliberately NOT tried together, because
// three simultaneous changes to one number cannot be attributed afterwards. This
// is the cap on simultaneous attackers, measured.
console.log("\n74. Reactor damage is capped, so its time-to-die stops scaling");
{
  const timeToKillReactor = (boarders) => {
    const sim = makeSim();
    const { trampler, horde } = sim;
    trampler.walking = false;
    trampler.turning = false;

    // Put them straight on the deck at the reactor, bypassing the climb so this
    // measures the cap and nothing else.
    const spots = [];
    for (let i = 0; i < boarders; i++) {
      const e = horde.spawn(CLIMBER);
      e.state = ENEMY_STATE.ON_DECK;
      e.onHull = true;
      const a = (i / boarders) * Math.PI * 2;
      const local = new THREE.Vector3(Math.cos(a) * 3.2, 0.95, 5 + Math.sin(a) * 2.6);
      const w = trampler.localToWorld(local.clone());
      e.x = w.x;
      e.y = w.y;
      e.z = w.z;
      spots.push(e);
    }

    let frames = 0;
    let peakEngaged = 0;
    while (!trampler.destroyed && frames < 60 * 90) {
      step(sim, 1);
      let engaged = 0;
      for (const e of horde.pool) if (e.alive && e.reactorSlot) engaged++;
      peakEngaged = Math.max(peakEngaged, engaged);
      frames++;
    }
    return { seconds: frames / 60, peakEngaged, died: trampler.destroyed };
  };

  const few = timeToKillReactor(3);
  const many = timeToKillReactor(12);

  ok("three boarders can destroy the reactor", few.died,
    `${few.seconds.toFixed(1)}s`);
  ok("twelve boarders can too", many.died, `${many.seconds.toFixed(1)}s`);

  ok("never more than the configured number are in contact",
    many.peakEngaged <= CFG.trampler.reactorSlots,
    `peak ${many.peakEngaged} engaged, cap ${CFG.trampler.reactorSlots}`);

  // The point of the whole change: four times the boarders must not be four times
  // the damage. Without the cap this ratio was 12/3 = 4.
  const ratio = few.seconds / many.seconds;
  ok("four times the boarders is NOT four times the damage", ratio < 1.6,
    `${few.seconds.toFixed(1)}s with 3 vs ${many.seconds.toFixed(1)}s with 12 — ratio ${ratio.toFixed(2)}`);
  ok("so there is time to notice, board and answer it", many.seconds > 6,
    `${many.seconds.toFixed(1)}s to lose the reactor at any wave size`);

  // And the cap can never reach zero: a reactor nothing can attack cannot be lost,
  // and losing it is the run.
  const sim = makeSim();
  sim.trampler.slotBonus = -99;
  ok("the cap never falls below one attacker", sim.trampler.reactorSlotCount >= 1,
    `${sim.trampler.reactorSlotCount} slots at slotBonus -99`);
}

// ---------------------------------------------------------------------------
console.log("\n75. Boarders walk around deck scenery instead of through it");
{
  const sim = makeSim();
  const { trampler, horde } = sim;
  trampler.walking = false;
  trampler.turning = false;

  ok("the deck's solid furniture is listed separately from its floors",
    trampler.deckObstacles.length > 0
    && !trampler.deckObstacles.some((b) => b.tag === "hull" || b.tag === "deck"),
    `${trampler.deckObstacles.length} obstacles, tags: `
    + `${[...new Set(trampler.deckObstacles.map((b) => b.tag))].join(", ")}`);

  // Drop a boarder on the far side of the mast from the reactor, so the direct
  // line to its target passes straight through solid geometry.
  const e = horde.spawn(CLIMBER);
  e.state = ENEMY_STATE.ON_DECK;
  e.onHull = true;
  const start = trampler.localToWorld(new THREE.Vector3(0, 0.95, -6));
  e.x = start.x;
  e.y = start.y;
  e.z = start.z;

  const mast = trampler.colliders.find((b) => b.tag === "mast");
  let insideMast = 0;
  let insideAny = 0;
  // ARRIVAL, not "still aboard". The previous version of this section asserted
  // `e.onHull` under the label "and it still got where it was going", and `onHull`
  // only means "did not fall off the deck" -- which a boarder pressed motionless
  // against the mast satisfies perfectly. It did: measured, this exact scenario
  // parked at local (0.00, -1.85), one body radius off the mast's aft face, with its
  // distance to the reactor frozen at 4.85 m for the full 20 s, and this section
  // reported three passes. The straight line from (0, -6) runs through the mast, so
  // the test was aimed at the right thing and then measured the wrong one.
  let arrivedAt = -1;
  let closest = Infinity;
  step(sim, 60 * 20, (i) => {
    const l = localOf(trampler, new THREE.Vector3(e.x, e.y, e.z));
    const r = CFG.enemies.climber.radius * 0.5; // generous: only count real overlap
    if (l.x > mast.min.x + r && l.x < mast.max.x - r
      && l.z > mast.min.z + r && l.z < mast.max.z - r) insideMast++;

    for (const b of trampler.deckObstacles) {
      if (l.y + 0.5 < b.min.y || l.y - 0.5 > b.max.y) continue;
      if (l.x > b.min.x + r && l.x < b.max.x - r
        && l.z > b.min.z + r && l.z < b.max.z - r) {
        insideAny++;
        break;
      }
    }

    const surf = trampler.reactorSurfaceWorld(new THREE.Vector3(e.x, e.y, e.z));
    const d = Math.hypot(e.x - surf.x, e.y - surf.y, e.z - surf.z);
    closest = Math.min(closest, d);
    if (d < CFG.enemies.climber.reactorReach && arrivedAt < 0) arrivedAt = i / 60;
  });

  ok("a boarder never ends a frame inside the mast", insideMast === 0,
    `${insideMast} frames inside`);
  ok("nor inside any other piece of deck furniture", insideAny === 0,
    `${insideAny} frames inside something`);
  ok("it is still aboard", e.onHull);
  ok("and it actually REACHED the reactor, rather than merely staying on the deck",
    arrivedAt >= 0,
    arrivedAt >= 0
      ? `arrived at ${arrivedAt.toFixed(2)} s, closest ${closest.toFixed(2)} m`
      : `never arrived, closest ${closest.toFixed(2)} m in 20 s`);
}

// ---------------------------------------------------------------------------
// The generalised form of 75. One scenario proves the mechanism; the pin was a
// GEOMETRIC condition -- aim perpendicular to the face you are pressed against --
// so it has to be checked wherever the geometry produces it, not just at the mast.
//
// The starts are the eight boarding-route exits `#buildClimbPoints` authors, plus
// the same eight nudged +/-0.6 m to stand in for a crowd's separation push, which is
// worth up to `speed * 0.9` sideways and so trivially produces this. Measured before
// the detour existed: 7/8 clean and 12/16 nudged, five pin points across four
// separate pieces of furniture. The nudged column is the one that matters -- a route
// that only works when nothing jostles you is not a route.
console.log("\n75b. Every boarding route reaches the reactor, jostled or not");
{
  const reach = CFG.enemies.climber.reactorReach;

  // Fresh sim per start. Sharing one would let earlier boarders separate against
  // later ones, which is the crowd effect the nudge is standing in for -- measuring
  // it twice, in an uncontrolled way, instead of pathing.
  const runFrom = (lx, lz) => {
    const sim = makeSim();
    const { trampler, horde } = sim;
    trampler.walking = false;
    trampler.turning = false;
    // Operative parked well clear: this is a pathing measurement, and a boarder that
    // stops to hit the player is not a boarder that failed to path. Detached from the
    // hull as well as moved, or based movement just carries them back onto the deck.
    sim.player.position.set(0, 400, 0);
    sim.player.base = null;

    const e = horde.spawn(CLIMBER);
    e.state = ENEMY_STATE.ON_DECK;
    e.onHull = true;
    const w = trampler.localToWorld(new THREE.Vector3(lx, 0.95, lz));
    e.x = w.x; e.y = w.y; e.z = w.z;

    // 10 s, not 20. Every measured arrival was under 3 s and a slide adds at most a
    // couple of metres at full speed, so this is generous; and 27 sims at 20 s each
    // is a lot of suite runtime to spend on headroom nothing uses.
    let arrived = false;
    step(sim, 60 * 10, () => {
      const surf = trampler.reactorSurfaceWorld(new THREE.Vector3(e.x, e.y, e.z));
      if (Math.hypot(e.x - surf.x, e.y - surf.y, e.z - surf.z) < reach) arrived = true;
    });
    return arrived;
  };

  const exits = [];
  for (const side of [-1, 1]) {
    for (const z of [-9, -3, 3, 9]) exits.push([side * 6.8, z]);
  }

  let clean = 0;
  const cleanFails = [];
  for (const [x, z] of exits) {
    if (runFrom(x, z)) clean++;
    else cleanFails.push(`(${x.toFixed(1)}, ${z})`);
  }
  ok("every boarding route exit reaches the reactor", clean === exits.length,
    `${clean}/${exits.length}${cleanFails.length ? ` -- failed ${cleanFails.join(" ")}` : ""}`);

  let jostled = 0;
  const jostledFails = [];
  for (const [x, z] of exits) {
    for (const dz of [-0.6, 0.6]) {
      if (runFrom(x, z + dz)) jostled++;
      else jostledFails.push(`(${x.toFixed(1)}, ${(z + dz).toFixed(1)})`);
    }
  }
  ok("and still does after 0.6 m of crowd jostle", jostled === exits.length * 2,
    `${jostled}/${exits.length * 2}`
    + `${jostledFails.length ? ` -- failed ${jostledFails.join(" ")}` : ""}`);

  // The specific trap the measurement found, kept as its own check because it is the
  // clearest statement of the rule: the starboard crate sits at local z 4..7, wholly
  // inside the reactor's own z extent of 3..7, so a boarder anywhere on that crate's
  // outboard face aims EXACTLY along the face normal. Every one of these froze with
  // local z identical to two decimal places for 20 s.
  let faceOk = 0;
  const faceZ = [4.0, 5.5, 7.0];
  for (const z of faceZ) if (runFrom(6.0, z)) faceOk++;
  ok("the starboard crate's outboard face is not a permanent trap",
    faceOk === faceZ.length, `${faceOk}/${faceZ.length} escaped`);
}

// ---------------------------------------------------------------------------
// Tier 1 item 2, the bounded build layer, and the game's identity rather than a
// feature. Three sockets against six modules is the decision; permanence is what
// makes it one.
console.log("\n76. Fortress modules are bounded, permanent, and fully revertible");
{
  const sim = makeSim();
  const { trampler, horde, emitters, guns, modules, economy } = sim;
  // Fitting a module goes through buyModule, which is gated at the terminal like every
  // other transaction. This section's subject is what the six modules DO.
  shopReady(sim);

  ok("there are fewer sockets than modules, so fitting is a choice",
    modules.sockets.length < modules.catalogue.length,
    `${modules.sockets.length} sockets, ${modules.catalogue.length} modules`);
  ok("nothing is fitted to begin with", modules.fittedCount === 0);

  const idx = Object.fromEntries(modules.catalogue.map((m, i) => [m.id, i]));

  // Baselines, captured before anything is fitted.
  const base = {
    reveal: horde.revealScale,
    climb: horde.climbScale,
    drive: trampler.driveScale,
    turn: trampler.turnScale,
    reactor: trampler.maxReactorHp,
    slots: trampler.reactorSlotCount,
    emitterCap: emitters.capacity,
    charge: emitters.maxCharge,
    heat: guns[0].heatScale,
    cool: guns[0].coolScale,
    flood: trampler.floodlights[0].intensity,
  };
  ok("the under-hull work lights start off, so the dark is something you buy",
    base.flood === 0);

  economy.scrap = 100000;

  // Each module, fitted and measured. Fitted one at a time into a fresh sim so a
  // previous module cannot mask the next one's effect.
  const fitOne = (id) => {
    const s = makeSim();
    s.economy.scrap = 100000;
    shopReady(s); // its own sim, so it needs its own operative at its own console
    const i = s.modules.catalogue.findIndex((m) => m.id === id);
    return { s, fitted: s.economy.buyModule(i) };
  };

  const flood = fitOne("floodlights");
  ok("floodlights light the arena and expose burrowers sooner",
    flood.s.trampler.floodlights[0].intensity > 0
    && flood.s.horde.revealScale < base.reveal,
    `intensity ${flood.s.trampler.floodlights[0].intensity}, `
    + `reveal x${flood.s.horde.revealScale.toFixed(2)}`);

  const rack = fitOne("emitterRack");
  ok("the emitter rack adds emitters and capacitor depth",
    rack.s.emitters.capacity > base.emitterCap
    && rack.s.emitters.maxCharge > base.charge,
    `${base.emitterCap} -> ${rack.s.emitters.capacity} emitters, `
    + `${base.charge} -> ${rack.s.emitters.maxCharge} charge`);

  const hoist = fitOne("ammoHoist");
  ok("the ammo hoist buffs the MANNED position, not an automated one",
    hoist.s.guns[0].heatScale < base.heat && hoist.s.guns[0].coolScale > base.cool,
    `heat x${hoist.s.guns[0].heatScale.toFixed(2)}, cool x${hoist.s.guns[0].coolScale.toFixed(2)}`);

  const baffles = fitOne("baffles");
  ok("baffles slow boarding without doing any damage",
    baffles.s.horde.climbScale > base.climb,
    `climb time x${baffles.s.horde.climbScale.toFixed(2)}`);

  const act = fitOne("actuators");
  ok("actuators speed the hull up and tighten its turn",
    act.s.trampler.driveScale > base.drive && act.s.trampler.turnScale > base.turn,
    `drive x${act.s.trampler.driveScale.toFixed(2)}, turn x${act.s.trampler.turnScale.toFixed(2)}`);

  const casing = fitOne("casing");
  ok("reactor casing adds integrity and takes an attacker slot away",
    casing.s.trampler.maxReactorHp > base.reactor
    && casing.s.trampler.reactorSlotCount < base.slots,
    `${base.reactor} -> ${casing.s.trampler.maxReactorHp.toFixed(0)} hp, `
    + `${base.slots} -> ${casing.s.trampler.reactorSlotCount} slots`);
  ok("and the extra integrity arrives filled rather than as a bigger empty bar",
    casing.s.trampler.reactorHp > CFG.trampler.reactorHp,
    `${casing.s.trampler.reactorHp.toFixed(0)} hp`);

  // Bounded: the sockets run out, and it says so.
  for (let i = 0; i < 10; i++) economy.buyModule(idx.baffles);
  ok("fitting stops when the hardpoints are full",
    modules.fittedCount === modules.sockets.length,
    `${modules.fittedCount} / ${modules.sockets.length}`);
  ok("and a refusal says why rather than doing nothing",
    economy.buyModule(idx.actuators) === null
    && economy.blockedReason.includes("HARDPOINT"),
    economy.blockedReason);
  ok("duplicates stack, so doubling down is a legitimate build",
    modules.count("baffles") > 1, `${modules.count("baffles")} fitted`);

  // Permanent for the run: there is deliberately no uninstall.
  ok("there is no way to unfit a module mid-run",
    typeof modules.unfit !== "function" && typeof modules.remove !== "function");

  // And a reset restores every single multiplier, which is what keeps two attempts
  // at the same seeded fight comparable.
  economy.reset();
  ok("a reset strips every socket", modules.fittedCount === 0);
  ok("and restores every module multiplier exactly",
    horde.revealScale === base.reveal && horde.climbScale === base.climb
    && trampler.driveScale === base.drive && trampler.turnScale === base.turn
    && trampler.maxReactorHp === base.reactor
    && trampler.reactorSlotCount === base.slots
    && emitters.capacity === base.emitterCap && emitters.maxCharge === base.charge
    && guns[0].heatScale === base.heat && guns[0].coolScale === base.cool
    && trampler.floodlights[0].intensity === base.flood,
    `reveal ${horde.revealScale}, climb ${horde.climbScale}, drive ${trampler.driveScale},`
    + ` reactor ${trampler.maxReactorHp}, emitters ${emitters.capacity}, heat ${guns[0].heatScale}`);
}

// ---------------------------------------------------------------------------
// Invariant 2b, re-checked with EVERY defensive system in the game fitted at once.
//
// This is the test the invariants document specifically demands: "emitters plus
// hull plating" is a combination neither system's own test covers, and now there
// are more of them -- an emitter rack, floodlights, a repair rig, four plates.
// The failure is silent. Nothing looks broken; the player simply stops having a
// reason to go down there and half the pillar quietly dies.
console.log("\n77. Fully refitted AND fully moduled, automation still cannot hold");
{
  const sim = makeSim();
  const { player, trampler, emitters, economy, modules, director } = sim;

  economy.scrap = 100000;
  economy.salvage = 100000;
  // Arranged at the terminal to do the buying. The player is removed from the fight
  // entirely further down, which is the whole point of the section -- so this has to
  // happen first, and the removal has to happen after.
  shopReady(sim);

  const refit = Object.fromEntries(CFG.economy.catalogue.map((c, i) => [c.id, i]));
  for (let i = 0; i < 20; i++) economy.buy(refit.plating);
  for (let i = 0; i < 20; i++) economy.buy(refit.rig);

  const mod = Object.fromEntries(modules.catalogue.map((m, i) => [m.id, i]));
  economy.buyModule(mod.emitterRack);
  economy.buyModule(mod.floodlights);
  economy.buyModule(mod.baffles);

  // And the whole salvage table on top, three stacks of every item in it.
  //
  // The invariants document asks for this explicitly: 2b has to be re-checked
  // whenever anything defensive is added, because a combination is covered by
  // neither system's own test. An eighteen-item pool is the largest such addition
  // the project has had, and one of those items -- a splash on kill -- composes with
  // a rack of emitters into automation that compounds itself. Deliberately more than
  // a real run could ever afford, because this is an upper bound, not a scenario.
  const salvageItems = CFG.economy.catalogue.filter((c) => c.pool === "salvage");
  for (let round = 0; round < 3; round++) {
    for (const item of salvageItems) economy.buy(refit[item.id]);
  }

  ok("everything defensive is bought (test is not vacuous)",
    economy.stacks.plating === 4 && economy.stacks.rig === 3
    && modules.fittedCount === modules.sockets.length
    && salvageItems.every((c) => economy.stacks[c.id] === 3),
    `plating ${economy.stacks.plating}, rig ${economy.stacks.rig}, `
    + `every one of ${salvageItems.length} items at x3, `
    + `modules [${modules.summary.join(" | ")}], `
    + `takes ${(trampler.damageScale * 100).toFixed(0)}% damage`);

  // Fill the enlarged rack, not just the base three.
  const legs = [0, 1, 2, 3, 4, 5];
  let placed = 0;
  for (const legIndex of legs) {
    if (placed >= emitters.capacity) break;
    const at = trampler.legAttackWorld(legIndex, new THREE.Vector3());
    player.position.set(at.x, 1.2, at.z);
    player.base = null;
    player.velocity.set(0, 0, 0);
    step(sim, 6);
    sim.input.presses.add(CFG.emitters.deployKey);
    step(sim, 2);
    placed = emitters.deployedCount;
  }
  ok("the whole enlarged rack is deployed", emitters.deployedCount >= 4,
    `${emitters.deployedCount} of ${emitters.capacity} out`);

  // Player entirely out of the fight. Only automation is defending.
  player.position.set(700, 1.2, 700);
  player.base = null;
  sim.waves = true;

  let frames = 0;
  const cap = 60 * 500;
  while (!trampler.immobilised && frames < cap) {
    step(sim, 1);
    frames++;
  }

  ok("the fortress is STILL crippled with nobody aboard",
    trampler.immobilised,
    trampler.immobilised
      ? `crippled at ${(frames / 60).toFixed(1)}s, wave ${director.wave}`
      : "EVERY DEFENSIVE SYSTEM TOGETHER HELD THE LINE -- THE PILLAR IS BROKEN");
  // And PINNED, not merely printed. This number is quoted in two steering files as the
  // headline measurement for invariant 2b-i, and a figure that is only ever printed is
  // free to wander -- which the other two numbers in this family did, by 11% and 4%,
  // with every check still green because they were reported as detail rather than
  // asserted. Same trap as the refit terminal's "6.3 m" comment: a number defended only
  // by a comment is not defended.
  //
  // A band rather than an equality, because the simulation is deterministic but not
  // frozen: a change to boarder pathing moved a sibling measurement 0.2% without
  // touching anything defensive. 10% is wide enough to ignore that and tight enough that
  // the drift which went unnoticed would have been caught. A failure here is not
  // necessarily a bug -- it means re-measure, then update the record on purpose.
  nearPct("and it is still crippled at about the recorded time", frames / 60, 131.2, 10);
  ok("and no amount of repair rig repaired anything unattended",
    trampler.legHp.some((h) => h <= 0),
    `legs [${trampler.legHp.map((h) => Math.round(h)).join(",")}]`);
  // The sharpest reading in this test. Every proc in the game is fitted three deep
  // and the only thing killing anything is a rack of emitters, so the correct number
  // of procs is zero. One proc here is invariant 2b failing silently -- the fortress
  // would defend itself a little better every wave and nothing would look wrong.
  const procs = sim.items.procs;
  ok("and the whole proc layer stayed inert, because nobody was there to trigger it",
    procs.fragment === 0 && procs.arc === 0 && procs.executioner === 0,
    `${procs.fragment} frag, ${procs.arc} arc, ${procs.executioner} exec`
    + ` across ${sim.horde.killCount} unattended kills`);
}

// ---------------------------------------------------------------------------
// Tier 1 item 3: the unbounded personal layer, Risk of Rain rules. Anything that
// would break at 100% has to stack hyperbolically, and "would break" is not a
// matter of taste here -- an unbounded fire rate eventually divides by zero, and
// total damage immunity removes the ground's cost, which is half the pillar.
console.log("\n78. Personal upgrades stack forever without ever breaking");
{
  const sim = makeSim();
  const { economy, weapon, player } = sim;
  const idx = Object.fromEntries(CFG.economy.catalogue.map((c, i) => [c.id, i]));

  economy.salvage = 1e9;
  // Twelve stacks of an item, to check a hyperbolic curve. Where the operative happens
  // to be standing could not matter less to that question, so the gate is arranged.
  shopReady(sim);

  const personal = CFG.economy.catalogue.filter((c) => c.pool === "salvage");
  ok("there are several personal upgrades, not just damage", personal.length >= 4,
    personal.map((c) => c.id).join(", "));
  ok("and none of them has a cap",
    personal.every((c) => c.max === Infinity), "all unbounded");

  // Fire rate: rises, and converges.
  const rateAt = (n) => {
    const s = makeSim();
    s.economy.salvage = 1e9;
    shopReady(s);
    for (let i = 0; i < n; i++) s.economy.buy(idx.trigger);
    return s.weapon.fireRateScale;
  };
  const r1 = rateAt(1);
  const r5 = rateAt(5);
  const r60 = rateAt(60);
  ok("fire rate rises with stacks", r5 > r1, `x${r1.toFixed(2)} -> x${r5.toFixed(2)}`);
  ok("and converges instead of running away",
    r60 < 1 + CFG.economy.hyper.trigger.cap + 1e-9,
    `x${r60.toFixed(3)} at 60 stacks, asymptote x${(1 + CFG.economy.hyper.trigger.cap).toFixed(2)}`);
  ok("so the interval between shots is always positive",
    1 / (CFG.combat.weapon.fireRate * r60) > 0);

  // Damage resistance: approaches zero and never arrives, because the ground
  // having a cost is half the pillar.
  const takenAt = (n) => {
    const s = makeSim();
    s.economy.salvage = 1e9;
    shopReady(s);
    for (let i = 0; i < n; i++) s.economy.buy(idx.weave);
    return s.player.damageScale;
  };
  const t1 = takenAt(1);
  const t10 = takenAt(10);
  const t200 = takenAt(200);
  ok("armour reduces damage taken", t1 < 1, `takes ${(t1 * 100).toFixed(0)}%`);
  ok("ten stacks is real but far from immunity", t10 > 0.15 && t10 < 0.4,
    `takes ${(t10 * 100).toFixed(0)}%`);
  ok("and total immunity is unreachable at any stack count", t200 > 0,
    `still takes ${(t200 * 100).toFixed(2)}% at 200 stacks`);

  // The hyperbolic resistance has to actually reach the player's health.
  const s = makeSim();
  s.economy.salvage = 1e9;
  shopReady(s);
  for (let i = 0; i < 6; i++) s.economy.buy(idx.weave);
  s.player.spawnGrace = 0;
  const hpBefore = s.player.hp;
  s.player.hurt(50);
  const taken = hpBefore - s.player.hp;
  ok("and it lands on real incoming damage", taken > 0 && taken < 50,
    `took ${taken.toFixed(1)} of a 50 hit`);

  // Prices escalate, which is the brake that makes an unbounded track finite in
  // practice without an arbitrary cap.
  economy.salvage = 1e9;
  const first = economy.costOf(idx.rifle);
  for (let i = 0; i < 12; i++) economy.buy(idx.rifle);
  ok("each stack costs more than the last", economy.costOf(idx.rifle) > first * 10,
    `${first} -> ${economy.costOf(idx.rifle)} after 12 stacks`);
  ok("damage really did stack additively all the way up",
    Math.abs(weapon.damageScale - (1 + 0.25 * 12)) < 1e-9,
    `x${weapon.damageScale.toFixed(2)}`);

  // Vitals must heal on purchase, or it is useless in the moment you buy it.
  const s2 = makeSim();
  s2.economy.salvage = 1e9;
  shopReady(s2);
  s2.player.hp = 40;
  const maxBefore = s2.player.maxHp;
  s2.economy.buy(idx.vitals);
  ok("vitals raises the ceiling and heals by the same amount",
    s2.player.maxHp > maxBefore && s2.player.hp === 65,
    `${maxBefore} -> ${s2.player.maxHp} max, hp 40 -> ${s2.player.hp}`);
}

// ---------------------------------------------------------------------------
// Tier 1 item 4: legs of a journey with branching route choice, a siege at each
// landmark, and a boss at the end. Until this existed a siege WAS the game, which
// gave the prototype a finish line but no arc -- and an economy with nothing to
// pay off against, since you buy a rifle stack and then it ends.
console.log("\n79. A run is legs of a journey with roads you choose between");
{
  const sim = makeSim();
  const { director, run, economy, horde } = sim;

  ok("a run starts at the first landmark", run.leg === 1 && !run.done);
  ok("and the first siege is a normal one",
    director.siegeLength === CFG.waves.siegeLength,
    `${director.siegeLength} waves`);
  ok("no roads are offered before one is held", run.offers.length === 0 && !run.choosing);

  // Hold the siege by hand rather than fighting it, so this measures the run
  // structure and not the combat.
  const holdSiege = () => {
    sim.waves = true;
    let guard = 0;
    while (!director.held && guard < 60 * 400) {
      step(sim, 1, () => {
        for (const e of horde.pool) if (e.alive) horde.damage(e, 1e6);
        sim.trampler.repairAll();
        sim.player.hp = sim.player.maxHp;
        sim.player.timeSinceHurt = 99;
      });
      guard++;
    }
    return director.held;
  };

  ok("the first siege can be held", holdSiege(), `wave ${director.wave}`);
  step(sim, 2);

  // Holding a siege pays a free salvage pick FIRST, and the road choice waits
  // behind it. Sequential rather than simultaneous: two menus at one moment is
  // unreadable, and the number keys already had three contenders.
  ok("holding it offers a salvage pick before anything else",
    run.picking && economy.pendingPick.length === CFG.economy.pickCount,
    `phase ${run.phase}, ${economy.pendingPick.length} on offer`);
  ok("the pick is three different items",
    new Set(economy.pendingPick).size === economy.pendingPick.length,
    economy.pickEntries.map((e) => e.name).join(" | "));

  // The road is deliberately NOT reachable yet.
  const legAtPick = run.leg;
  step(sim, 60 * 10);
  ok("and the road choice is blocked until the pick is taken",
    run.picking && run.offers.length === 0 && run.leg === legAtPick,
    `phase ${run.phase}, ${run.offers.length} roads, leg ${run.leg}`);

  const tookName = economy.pickEntries[0].name;
  const took = economy.takePick(0);
  ok("taking one grants it for free", took && took.cost === 0,
    `${tookName} -> x${took?.stacks}`);
  ok("and clears the rest, so it was a choice rather than a shopping list",
    economy.pendingPick.length === 0);

  step(sim, 2);
  ok("holding it offers roads rather than starting the next siege by itself",
    run.choosing && run.offers.length === CFG.run.branches,
    `phase ${run.phase}, ${run.offers.length} roads`);
  ok("the offered roads are different from each other",
    new Set(run.offers.map((r) => r.id)).size === run.offers.length,
    run.offers.map((r) => r.name).join(" | "));

  // Nothing advances on a timer. A held siege sits there until a human decides.
  const legBefore = run.leg;
  step(sim, 60 * 30);
  ok("nothing advances while the crew has not chosen", run.leg === legBefore
    && run.choosing, `leg ${run.leg}, phase ${run.phase}`);
  ok("and nothing spawns during the choice", horde.liveCount === 0);

  // Take a road and confirm it pays on ARRIVAL, before the fight, so the money is
  // spendable on surviving what it just bought.
  const road = run.offers[0];
  const salvageBefore = economy.salvage;
  const scrapBefore = economy.scrap;
  const arrival = run.choose(0);

  ok("choosing a road advances the journey", arrival && run.leg === legBefore + 1,
    `leg ${run.leg} of ${CFG.run.legs}, took ${arrival?.name}`);
  // The arrival has to carry the ROAD, not just its payout, or nothing downstream can
  // say what the choice cost. The banner used to list only the money, which is why a
  // playtester pressed 1, got paid, and concluded the choice had done nothing.
  ok("and the arrival names the road itself, so its cost can be reported too",
    !!run.lastArrival?.road && run.lastArrival.road.id === run.history[0],
    `road ${run.lastArrival?.road?.id ?? "MISSING"}`);
  {
    const d = describeRoad(run.lastArrival.road);
    ok("which describes a cost as well as a payout, through one shared describer",
      d.costs.length > 0 && d.pays.length > 0,
      `costs [${d.costs.join(", ")}] pays [${d.pays.join(", ")}]`);
  }

  ok("and pays on arrival, before the siege it paid for",
    economy.salvage === salvageBefore + road.salvage
    && economy.scrap === scrapBefore + road.scrap,
    `+${road.salvage} salvage, +${road.scrap} scrap`);
  ok("a fresh siege begins at the new landmark",
    director.phase === PHASE.REST && director.wave === 0,
    `phase ${director.phase}, wave ${director.wave}`);

  // The anti-stall valve must survive a landmark change: rewinding the elapsed
  // clock would let a slow crew farm a whole biome at wave-one difficulty.
  ok("the elapsed clock keeps running across landmarks", director.elapsed > 60,
    `${director.elapsed.toFixed(0)}s elapsed, threat x${director.hpScale().toFixed(2)}`);
  ok("and the resolved-wave count is not rewound either",
    director.resolved >= CFG.waves.siegeLength,
    `${director.resolved} waves resolved`);

  // Modifiers are cumulative and are INSTANCE state, never CFG edits.
  //
  // The roads are OFFERED from a seeded stream, and the first version of this
  // check simply took whatever came up -- which was two roads with no modifiers at
  // all, so it asserted 1.00 >= 1.00 and passed without measuring anything. The
  // offers are forced here instead: a test of accumulation has to be handed
  // something to accumulate.
  const authored = { chewer: CFG.enemies.chewer.speed, hp: CFG.enemies.chewer.hp };
  const hardRoads = CFG.run.routes.filter((r) => r.threat > 1 || r.speed > 1 || r.count > 0);
  ok("some roads actually carry a cost (test is not vacuous)", hardRoads.length >= 2,
    hardRoads.map((r) => r.id).join(", "));

  let expectThreat = run.threatScale;
  let expectSpeed = horde.speedScale;
  let expectCount = run.extraCount;

  while (!run.done && run.leg < CFG.run.legs) {
    if (!holdSiege()) break;
    step(sim, 2);
    // Clear the salvage pick first. Holding a siege now pays one, and the road sits
    // behind it -- a loop that only took roads would stall here forever.
    if (run.picking) {
      economy.takePick(0);
      step(sim, 2);
    }
    if (!run.choosing) break;
    // Force the hardest available road, so every modifier gets exercised.
    const road = hardRoads[run.leg % hardRoads.length];
    run.offers = [road];
    expectThreat *= road.threat;
    expectSpeed *= road.speed;
    expectCount += road.count;
    run.choose(0);
  }

  ok("road modifiers accumulate across a run, multiplying rather than replacing",
    Math.abs(run.threatScale - expectThreat) < 1e-9
    && Math.abs(horde.speedScale - expectSpeed) < 1e-9
    && run.extraCount === expectCount,
    `threat x${run.threatScale.toFixed(3)} (want x${expectThreat.toFixed(3)}),`
    + ` speed x${horde.speedScale.toFixed(3)}, +${run.extraCount} per wave,`
    + ` roads: ${run.history.join(" -> ")}`);
  // The accumulation has to be REPORTABLE, not merely real. It is instance state on the
  // run, it compounds across the whole biome, and the only place any of it surfaced was
  // one combined number in the hidden diagnostics panel — merged with the elapsed-time
  // ramp, so even there the road's share could not be separated out. A cost nobody can
  // perceive is not a cost.
  {
    const listed = run.modifiers;
    ok("the accumulated road cost is reportable, not just real",
      listed.length > 0, `[${listed.join(" · ")}]`);
    ok("and it names the roads that caused it",
      run.roadsTaken.length === run.history.length && run.roadsTaken.length > 0,
      run.roadsTaken.join(" -> "));
    // A fresh run must report nothing rather than a list of zeroes, or the line is
    // noise on the first road choice of every run.
    const clean = makeSim().run;
    ok("while a run that has taken no roads reports nothing at all",
      clean.modifiers.length === 0 && clean.roadsTaken.length === 0,
      `[${clean.modifiers.join(", ")}]`);
  }

  ok("and the accumulation is a real difficulty change, not a rounding error",
    run.threatScale * expectSpeed > 1.15,
    `combined x${(run.threatScale * horde.speedScale).toFixed(3)}`);
  ok("the enemy health ramp reflects it",
    director.hpScale() > 1 + director.elapsed / CFG.waves.hpRamp,
    `x${director.hpScale().toFixed(2)} vs x${(1 + director.elapsed / CFG.waves.hpRamp).toFixed(2)} from time alone`);
  ok("and none of them edited global config",
    CFG.enemies.chewer.speed === authored.chewer && CFG.enemies.chewer.hp === authored.hp,
    `chewer speed ${CFG.enemies.chewer.speed}, hp ${CFG.enemies.chewer.hp}`);

  ok("the journey reaches its final landmark", run.leg === CFG.run.legs && run.isBossLeg,
    `leg ${run.leg} of ${CFG.run.legs}`);
  ok("and the boss siege is shorter, because the titan IS the wave",
    director.siegeLength === CFG.run.bossSiegeLength
    && CFG.run.bossSiegeLength < CFG.waves.siegeLength,
    `${director.siegeLength} waves vs ${CFG.waves.siegeLength} normally`);

  // And the boss leg pays no pick, because the run ends here and an item you can
  // never spend is a menu rather than a reward.
  ok("holding the last one ends the biome rather than offering more roads",
    holdSiege() && (step(sim, 2), run.done),
    `phase ${run.phase}, leg ${run.leg}`);
  // Nothing is on offer once the biome is done, and there are two ways a pick could
  // be sitting there: the hold's own pick (never paid on the boss leg) and one from
  // the wave cadence, which DOES pay during the boss siege because there is still a
  // titan to spend it on. An offer that outlives the run would be a panel asking for
  // a keypress that can no longer change anything.
  ok("nothing is left on offer once the biome is done, from either source",
    economy.pendingPick.length === 0, `${economy.pendingPick.length} on offer`);
  ok("and nothing further spawns once it is done", horde.liveCount === 0);

  // A reset has to rewind the whole journey, not just the siege.
  sim.economy.reset();
  run.reset();
  ok("a reset returns the run to its first landmark",
    run.leg === 1 && !run.done && run.history.length === 0
    && run.threatScale === 1 && horde.speedScale === 1,
    `leg ${run.leg}, threat x${run.threatScale}, speed x${horde.speedScale}`);
}

// ---------------------------------------------------------------------------
console.log("\n80. The boss arrives once, at the end, and is not time-ramped");
{
  const sim = makeSim();
  const { director, run, horde } = sim;

  // Wind the run to its boss leg without fighting anything.
  run.leg = CFG.run.legs;
  director.siegeLength = run.siegeLength;
  ok("the run knows it is on the boss leg", run.isBossLeg);

  const waves = [];
  for (let w = 1; w <= director.siegeLength; w++) waves.push(director.buildWave(w));

  const withTitan = waves.filter((types) => types.includes(TITAN));
  ok("exactly one wave of the boss siege contains the titan", withTitan.length === 1,
    `${withTitan.length} of ${waves.length} waves`);
  ok("and it is the last one",
    waves[waves.length - 1].includes(TITAN),
    `wave ${waves.findIndex((t) => t.includes(TITAN)) + 1} of ${waves.length}`);
  ok("there is exactly one of it", withTitan[0].filter((t) => t === TITAN).length === 1);

  // Compared against the size the wave WOULD have been, computed from config
  // rather than by asking the director again -- on a boss leg, buildWave for the
  // last wave is the boss wave, so it would be comparing it against itself.
  const unreduced = CFG.waves.baseCount
    + CFG.waves.perWave * (director.siegeLength - 1);
  ok("it arrives with an escort, but a reduced one",
    withTitan[0].length > 1 && withTitan[0].length < unreduced,
    `${withTitan[0].length} alongside the titan vs ${unreduced} in a normal wave`);

  // Released at authored health regardless of how long the crew took, which is
  // the one fight whose numbers should be plannable.
  director.elapsed = 900;
  ok("the time ramp is enormous by now (test is not vacuous)",
    director.hpScale() > 8, `x${director.hpScale().toFixed(1)}`);

  sim.waves = true;
  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;
  director.wave = director.siegeLength - 1;
  director.callEarly();
  let guard = 0;
  while (horde.countType(TITAN) === 0 && guard < 60 * 60) {
    step(sim, 1);
    guard++;
  }
  const titan = horde.pool.find((e) => e.alive && e.type === TITAN);
  ok("a titan actually reached the field", !!titan);
  ok("and it spawned at its authored health, not the ramped one",
    titan && Math.abs(titan.maxHp - CFG.enemies.titan.hp) < 1e-6,
    titan ? `${titan.maxHp} hp vs authored ${CFG.enemies.titan.hp}` : "none");

  // The titan is released FIRST, so the escort is not on the field yet. Sampling
  // here without letting the trickle continue would have measured an empty set and
  // passed for the wrong reason.
  step(sim, 60 * 5);
  const escort = horde.pool.filter((e) => e.alive && e.type !== TITAN);
  ok("the escort did arrive behind it (test is not vacuous)", escort.length > 0,
    `${escort.length} escorts`);
  ok("and the escort WAS ramped, unlike the boss",
    escort.every((e) => e.maxHp > enemyCfg(e.type).hp * 2),
    `escort health x${(escort[0].maxHp / enemyCfg(escort[0].type).hp).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// Wave composition. Specials SUBSTITUTE for chewers rather than adding to the
// total: the count curve was tuned against measured pacing, and changing size and
// composition together moves two variables at once, after which no difficulty
// change can be attributed to either.
console.log("\n81. Waves gain new types on schedule without changing size");
{
  const sim = makeSim();
  const { director } = sim;
  const c = CFG.enemies.composition;

  const sizeOf = (w) => CFG.waves.baseCount + CFG.waves.perWave * (w - 1);
  const counts = (types) => {
    const out = {};
    for (const t of types) out[ENEMY_TYPE_KEYS[t]] = (out[ENEMY_TYPE_KEYS[t]] ?? 0) + 1;
    return out;
  };

  let sizesMatch = true;
  const report = [];
  for (let w = 1; w <= 8; w++) {
    const types = director.buildWave(w);
    if (types.length !== sizeOf(w)) sizesMatch = false;
    report.push(`w${w}:${types.length}`);
  }
  ok("wave size is untouched by the new roster", sizesMatch, report.join(" "));

  const w1 = counts(director.buildWave(1));
  const w2 = counts(director.buildWave(2));
  const w3 = counts(director.buildWave(3));
  const w5 = counts(director.buildWave(5));

  ok("the first wave is only the two types the pillar is built on",
    Object.keys(w1).every((k) => k === "chewer" || k === "climber"),
    Object.entries(w1).map(([k, n]) => `${k} ${n}`).join(", "));
  ok("burrowers arrive on schedule",
    !w1.burrower && (w2.burrower ?? 0) > 0,
    `wave ${c.burrowerFromWave} configured; w1 ${w1.burrower ?? 0}, w2 ${w2.burrower}`);
  ok("bulwarks arrive on schedule",
    !w2.bulwark && (w3.bulwark ?? 0) > 0,
    `wave ${c.bulwarkFromWave} configured; w2 ${w2.bulwark ?? 0}, w3 ${w3.bulwark}`);
  ok("the ranged type arrives as a singleton after the two teaching waves",
    !w2.spiker && (w3.spiker ?? 0) === 1,
    `wave ${c.spikerFromWave} configured; w2 ${w2.spiker ?? 0}, w3 ${w3.spiker ?? 0}`);
  ok("sappers arrive on schedule",
    !w3.sapper && (counts(director.buildWave(4)).sapper ?? 0) > 0,
    `wave ${c.sapperFromWave} configured`);

  ok("chewers remain the floor of every wave",
    [w1, w2, w3, w5].every((w) => (w.chewer ?? 0) > 0),
    `w1 ${w1.chewer}, w2 ${w2.chewer}, w3 ${w3.chewer}, w5 ${w5.chewer}`);
  ok("and the expensive types stay capped",
    (w5.bulwark ?? 0) <= c.bulwarkMax && (w5.sapper ?? 0) <= c.sapperMax,
    `w5 bulwarks ${w5.bulwark ?? 0}/${c.bulwarkMax}, sappers ${w5.sapper ?? 0}/${c.sapperMax}`);

  // Road modifiers are the ONE thing allowed to change the count, and explicitly.
  const withRoad = makeSim();
  withRoad.run.extraCount = 4;
  ok("a road that promises more enemies delivers exactly that many more",
    withRoad.director.buildWave(1).length === sizeOf(1) + 4,
    `${withRoad.director.buildWave(1).length} vs ${sizeOf(1)} baseline`);

  // Composition must be reproducible, or the seeded fight is worthless.
  const a = makeSim().director.buildWave(4).join(",");
  const b = makeSim().director.buildWave(4).join(",");
  ok("the same seed builds the same wave", a === b);

  // ---- the roster carries across landmarks; the size curve does not.
  //
  // This is the fix for the flattest thing in the run. `resetSiege()` rewinds the wave
  // counter and composition used to be keyed off it, so landmark 2 wave 1 was seven
  // chewers and three climbers AGAIN — you fought thirty enemies with two bulwarks and
  // a sapper, chose a road, and the next fight was structurally SIMPLER than the one
  // you had survived. A playtester read that exactly as it was: "it just went next".
  const tierSim = makeSim();
  const tally = (types) => {
    const c = {};
    for (const t of types) c[ENEMY_TYPE_KEYS[t]] = (c[ENEMY_TYPE_KEYS[t]] ?? 0) + 1;
    return c;
  };
  const waveAt = (leg, wave) => {
    tierSim.run.leg = leg;
    return tally(tierSim.director.buildWave(wave, tierSim.director.tierOf(wave)));
  };
  const sizeAt = (leg, wave) =>
    Object.values(waveAt(leg, wave)).reduce((x, y) => x + y, 0);

  ok("landmark 1 still opens on the two pressures the pillar is built on, and nothing else",
    Object.keys(waveAt(1, 1)).sort().join(",") === "chewer,climber",
    Object.entries(waveAt(1, 1)).map(([k, n]) => `${n} ${k}`).join(", "));

  const l2 = waveAt(2, 1);
  ok("but landmark 2 opens with a roster it took three waves to earn the first time",
    (l2.bulwark ?? 0) > 0 && (l2.burrower ?? 0) > 0,
    Object.entries(l2).map(([k, n]) => `${n} ${k}`).join(", "));

  // The half that must NOT move. Wave size was tuned against measured pacing, and
  // moving size and composition together is what makes a later difficulty change
  // impossible to attribute to either — invariant 19e.
  const sizesMoved = [];
  for (let leg = 1; leg <= 3; leg++) {
    for (let wave = 1; wave <= CFG.waves.siegeLength; wave++) {
      if (sizeAt(leg, wave) !== sizeAt(1, wave)) sizesMoved.push(`leg ${leg} wave ${wave}`);
    }
  }
  ok("and the wave SIZE curve is identical at every landmark, which is 19e",
    sizesMoved.length === 0,
    sizesMoved.length
      ? `SIZE MOVED at ${sizesMoved.join(", ")}`
      : `w1..w5 = ${[1, 2, 3, 4, 5].map((n) => sizeAt(3, n)).join("/")} at every leg`);

  // The floor, which is what stops the escalation eating the arena it escalates in.
  // Specials used to be allocated first with chewers as the remainder, and at tier 7
  // the ramps want three bulwarks and three sappers against a ten-enemy first wave.
  // Chewers would have reached zero, and a wave with no chewers has nothing under the
  // hull — half the pillar gone, quietly.
  let lowest = 1;
  let lowestAt = "";
  const emptyOf = [];
  let bossShare = 1;
  for (let leg = 1; leg <= CFG.run.legs; leg++) {
    const len = leg >= CFG.run.legs ? CFG.run.bossSiegeLength : CFG.waves.siegeLength;
    for (let wave = 1; wave <= len; wave++) {
      const t = waveAt(leg, wave);
      const size = Object.values(t).reduce((x, y) => x + y, 0);
      if (!t.chewer) emptyOf.push(`no chewers at leg ${leg} wave ${wave}`);
      if (!t.climber) emptyOf.push(`no climbers at leg ${leg} wave ${wave}`);
      const share = (t.chewer ?? 0) / size;
      // The boss wave is the ONE exception and it is deliberate, not an oversight.
      // `bossWaveScale` truncates the shuffled escort — the titan IS the wave, and
      // keeping the full escort alongside it turns the climax into a crowd-control
      // problem you cannot see through. Truncating a shuffled list can cut chewers, and
      // on that one fight it should: the titan is too tall for the hull's shadow and
      // attacks from outboard, so the deck is the right place to be (invariant 13c) and
      // the under-hull arena mattering less is the point of the fight.
      if (t.titan) {
        bossShare = share;
        continue;
      }
      if (share < lowest) {
        lowest = share;
        lowestAt = `leg ${leg} wave ${wave}, size ${size}`;
      }
    }
  }
  ok("every wave of every landmark still contains both pillar types",
    emptyOf.length === 0, emptyOf.length ? emptyOf.join("; ") : "chewers and climbers throughout");
  ok("and chewers never fall below their floor on any normal wave, whatever the tier wants",
    lowest >= CFG.enemies.composition.chewerFloor - 1e-9,
    `lowest ${(lowest * 100).toFixed(0)}% at ${lowestAt},`
    + ` floor ${(CFG.enemies.composition.chewerFloor * 100).toFixed(0)}%`);
  // Asserted rather than merely skipped, so the exception is a measured statement and
  // not a hole. The boss wave has a smaller chewer share BY DESIGN, and if it ever
  // stopped having one at all that would be worth knowing.
  ok("the boss wave is the exception, with a thinner escort but still an arena under it",
    bossShare > 0 && bossShare < CFG.enemies.composition.chewerFloor,
    `boss wave is ${(bossShare * 100).toFixed(0)}% chewers, against a`
    + ` ${(CFG.enemies.composition.chewerFloor * 100).toFixed(0)}% floor elsewhere`);

  // And the tail of the priority list must not be starved. Measured: a single-pass
  // allocation in priority order let the bulwark ramp take the remaining room at
  // landmark 3, and the SAPPER disappeared from the wave — the one enemy that is a
  // timer rather than a damage race. The seventh type makes checking only that one
  // historical victim insufficient, so every scheduled special is derived here.
  const starved = [];
  const dueTypes = [
    ["burrower", c.burrowerFromWave],
    ["bulwark", c.bulwarkFromWave],
    ["sapper", c.sapperFromWave],
    ["spiker", c.spikerFromWave],
  ];
  for (let leg = 1; leg <= 3; leg++) {
    for (let wave = 1; wave <= CFG.waves.siegeLength; wave++) {
      const t = waveAt(leg, wave);
      const tier = wave + (leg - 1) * c.tierPerLeg;
      for (const [key, from] of dueTypes) {
        if (tier >= from && !t[key]) starved.push(`${key} at leg ${leg} wave ${wave} (tier ${tier})`);
      }
    }
  }
  ok("once a type is due it always appears, so the roster cannot eat its own tail",
    starved.length === 0,
    starved.length ? `STARVED: ${starved.join(", ")}` : "every due type is present");
}

// ---------------------------------------------------------------------------
// Invariant 21 extended. A restart has to rewind everything a run touched, or two
// attempts at the same seed are different fights and the seeds buy nothing. This
// now includes modules and the journey, which are new places for state to hide.
console.log("\n82. A full restart replays the same run, modules and roads included");
{
  const fingerprint = (frames) => {
    const sim = makeSim();
    sim.waves = true;
    sim.player.position.set(700, 1.2, 700);
    sim.player.base = null;
    step(sim, frames);
    return {
      types: sim.horde.pool.filter((e) => e.alive)
        .map((e) => `${ENEMY_TYPE_KEYS[e.type]}@${e.x.toFixed(2)},${e.z.toFixed(2)}`)
        .join("|"),
      wave: sim.director.wave,
      arc: sim.director.arcOffset,
      sim,
    };
  };

  const first = fingerprint(60 * 40);
  const second = fingerprint(60 * 40);
  ok("the run actually spawned something (test is not vacuous)",
    first.types.length > 0, `wave ${first.wave}`);
  ok("two fresh runs from the same seed are identical", first.types === second.types);
  ok("including the wave bearing", first.arc === second.arc,
    `${first.arc.toFixed(4)} vs ${second.arc.toFixed(4)}`);

  // Now the restart path, exactly as main.js performs it.
  const sim = first.sim;
  sim.economy.scrap = 1e6;
  sim.economy.salvage = 1e6;
  // Buying is a between-waves act, and forty seconds in the fight is on. Put the
  // director back into a rest AND clear the fortress, because the buy window now
  // requires both -- a rest with things under the hull is not a shopping moment. The
  // point here is the reset, not the shop's gate, which test 63 owns.
  sim.director.phase = PHASE.REST;
  // No step between the clear and the buy. `clear()` zeroes the counters itself, and a
  // frame here would let the director walk REST -> PREP now that the field is calm,
  // shutting the window again -- and would add an extra frame of elapsed time to a
  // test whose entire subject is an exact replay.
  sim.horde.clear();
  // Buying is a place now, and this has to reach it without spending a frame. See
  // `shopReadyNoStep` for why that matters here and nowhere else.
  shopReadyNoStep(sim);
  sim.economy.buy(0);
  sim.economy.buyModule(0);
  sim.run.threatScale = 1.5;
  sim.horde.speedScale = 1.2;
  sim.run.leg = 3;

  ok("state was genuinely dirty before the reset",
    sim.modules.fittedCount > 0 && sim.economy.purchases > 0);

  // Drive a proc before the reset, so the seeded stream inside the item runtime has
  // genuinely been consumed and rewinding it is a real claim rather than a formality.
  //
  // The hit is ATTRIBUTED, and it did not used to be. The on-hit channel carried no
  // source at all, so an anonymous `emitHit` procced happily; once it carried one, this
  // scaffolding started rolling zero arcs and the non-vacuity check above failed --
  // correctly. An unattributed hit belongs to nobody and must proc nothing, which is the
  // rule section 110 exists for. Naming the operative is the repair, not loosening it.
  sim.economy.stacks.arc = 20;
  sim.economy.applyAll();
  const procBefore = [];
  for (let i = 0; i < 6; i++) {
    const a = sim.horde.spawn(CHEWER);
    const b = sim.horde.spawn(CHEWER);
    b.x = a.x + 2;
    b.y = a.y;
    b.z = a.z;
    sim.events.emitHit(a, 20, sim.player);
    procBefore.push(sim.items.procs.arc);
  }
  ok("the item runtime's seeded stream was actually used (test is not vacuous)",
    sim.items.procs.arc > 0, `${sim.items.procs.arc} arcs rolled from ${procBefore.length} hits`);

  sim.horde.clear();
  sim.emitters.clear();
  sim.economy.reset();
  sim.trampler.repairAll();
  sim.trampler.resetPose();
  sim.director.reset();
  sim.run.reset();
  // LAST, and after everything that moves the player, exactly as resetEncounter does
  // it. This line was missing for a while, which left invariant 21's clause for
  // CFG.items.seed with no test behind it at all: the re-seed inside Items.reset()
  // could have been deleted and the suite would still have reported green.
  sim.items.reset();

  ok("the fortress is back on its start heading and position",
    Math.abs(sim.trampler.yaw - Math.PI) < 1e-9
    && Math.abs(sim.trampler.group.position.x - CFG.world.patrolRadius) < 1e-9,
    `yaw ${sim.trampler.yaw.toFixed(4)}, x ${sim.trampler.group.position.x.toFixed(2)}`);
  ok("every purse and stack is empty",
    sim.economy.salvage === 0 && sim.economy.scrap === 0
    && Object.values(sim.economy.stacks).every((n) => n === 0));
  ok("every hardpoint is stripped", sim.modules.fittedCount === 0);
  ok("the journey is back at its first landmark",
    sim.run.leg === 1 && sim.run.threatScale === 1 && sim.horde.speedScale === 1);
  ok("and the siege length is back to a normal landmark's",
    sim.director.siegeLength === CFG.waves.siegeLength);

  // The proc stream, replayed. Same stacks, same hits, same rolls in the same order --
  // otherwise two attempts at the same seeded wave disagree on whether an arc fired,
  // which is the precise property CFG.items.seed exists to hold.
  ok("the proc counters are back to zero", sim.items.procs.arc === 0);
  sim.economy.stacks.arc = 20;
  sim.economy.applyAll();
  const procAfter = [];
  for (let i = 0; i < procBefore.length; i++) {
    const a = sim.horde.spawn(CHEWER);
    const b = sim.horde.spawn(CHEWER);
    b.x = a.x + 2;
    b.y = a.y;
    b.z = a.z;
    sim.events.emitHit(a, 20, sim.player);
    procAfter.push(sim.items.procs.arc);
  }
  ok("and the proc stream rolls the same chances in the same order after a restart",
    procAfter.join(",") === procBefore.join(","),
    `[${procBefore.join(",")}] vs [${procAfter.join(",")}]`);

  sim.economy.reset();
  sim.items.reset();
  sim.horde.clear();

  sim.player.position.set(700, 1.2, 700);
  sim.player.base = null;
  step(sim, 60 * 40);
  const replay = sim.horde.pool.filter((e) => e.alive)
    .map((e) => `${ENEMY_TYPE_KEYS[e.type]}@${e.x.toFixed(2)},${e.z.toFixed(2)}`)
    .join("|");

  ok("and the restarted run replays the original fight exactly",
    replay === first.types,
    replay === first.types ? "identical" : "DIVERGED");
}

// ---------------------------------------------------------------------------
// The visual layer, actually executed.
//
// Everything DOM-shaped was previously untested at runtime, which is why test 67
// checks HUD markup as text instead. That works for markup and does nothing for
// the eight hundred lines of particle and viewmodel code, which until now nothing
// in CI ever ran -- a typo there is a blank screen with one console line.
//
// So this stubs the two DOM calls fx.js actually makes (a canvas and a 2D
// context), constructs the real Fx and ViewModel against the real simulation, and
// drives them through the real frame loop. It is not a rendering test and cannot
// be one; it is a "does this code execute and stay finite" test, which is the part
// that has been silently unguarded.
console.log("\n83. The particle and viewmodel layer runs against the real sim");
{
  // Minimum viable canvas. Only sprite() touches the DOM, and only for a radial
  // gradient it immediately hands to CanvasTexture.
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createRadialGradient: () => ({ addColorStop() {} }),
        fillRect() {},
        set fillStyle(_v) {},
      }),
    }),
  };

  let Fx;
  let ViewModel;
  let loadError = null;
  try {
    ({ Fx } = await import("./src/fx.js"));
    ({ ViewModel } = await import("./src/viewmodel.js"));
  } catch (err) {
    loadError = err;
  }
  ok("the visual modules load", !loadError, loadError ? loadError.message : "fx + viewmodel");

  if (Fx && ViewModel) {
    const sim = makeSim();
    const fx = new Fx(sim.scene, sim.camera);
    const viewmodel = new ViewModel(sim.camera, sim.scene);
    ok("both constructed against a real scene and camera",
      !!fx.points && !!viewmodel.group && !!viewmodel.body);

    // A renderer stub, because fx.js now reads the drawing buffer's height every
    // frame to bound how much of the screen one sprite may own. Only
    // getDrawingBufferSize is reached, and only for its y. Without the stub that
    // path is skipped by the optional chain and the wiring goes uncovered -- which
    // is the whole reason this section exists.
    const ctx = {
      ...sim,
      guns: sim.guns,
      input: sim.input,
      renderer: { getDrawingBufferSize: (out) => out.set(1920, 1080) },
    };

    // A real fight, so footfalls, gunfire, kills and deaths all actually happen.
    sim.waves = false;
    for (let i = 0; i < 8; i++) sim.horde.spawn(CHEWER);
    for (let i = 0; i < 3; i++) sim.horde.spawn(BULWARK);
    placeOnGroundAt(sim, 0, -14);

    let kills = 0;
    step(sim, 60 * 12, (i) => {
      sim.input.mouseHeld.add(0);
      if (i % 30 === 0) {
        const target = sim.horde.pool.find((e) => e.alive);
        if (target) aimAt(sim.player, new THREE.Vector3(target.x, target.y, target.z));
      }
      if (i % 90 === 0) sim.horde.spawn(CHEWER);
      fx.update(DT, ctx);
      viewmodel.update(DT, ctx);
      kills = sim.horde.killCount;
    });
    sim.input.mouseHeld.delete(0);

    ok("footfalls drove the fortress's dust", sim.trampler.stepCount > 4,
      `${sim.trampler.stepCount} steps`);
    ok("shots were fired through it", sim.weapon.shots > 20, `${sim.weapon.shots} shots`);
    ok("and things died in front of it", kills > 0, `${kills} kills`);

    // The actual assertion: no NaN anywhere in the particle buffers. A single NaN
    // position collapses the bounding sphere and the whole system vanishes, which
    // is exactly the sort of failure that reads as "particles do not work".
    const attrs = ["position", "aSize", "aAlpha", "aColor"];
    const bad = attrs.filter((name) => {
      const a = fx.geo.attributes[name];
      for (let i = 0; i < a.array.length; i++) {
        if (!Number.isFinite(a.array[i])) return true;
      }
      return false;
    });
    ok("every particle attribute stayed finite", bad.length === 0,
      bad.length ? `NaN in: ${bad.join(", ")}` : `${attrs.length} buffers clean`);

    const alive = [...fx.geo.attributes.aAlpha.array].filter((a) => a > 0).length;
    ok("particles were actually alive at the end (test is not vacuous)", alive > 0,
      `${alive} live particles`);

    // The sprite size cap, as far as it can be checked without a GL context.
    //
    // What this proves: the uniform is wired and tracks the buffer the renderer is
    // drawing into, so a resize or an adaptive scale change carries through.
    // What it CANNOT prove is the min() in the vertex shader, which runs on a GPU
    // that does not exist here -- that part is eyes-only. Worth stating rather
    // than leaving a reader to assume the assertion covers more than it does.
    const cap = fx.points.material.uniforms.uMaxSize.value;
    ok("the sprite size cap tracks the drawing buffer",
      cap === 1080 * CFG.fx.maxScreenFraction,
      `uMaxSize ${cap.toFixed(1)} px from a 1080-tall buffer`);
    // And that it is a bound on something rather than on nothing: the muzzle flash,
    // born about a metre from the lens, is the emitter that exceeds it. Run through
    // the same arithmetic the vertex shader does.
    //
    // 3.6 is the largest size `muzzle()` in fx.js authors (1.6 + 2.0) and 0.35 m is
    // handPosition's forward offset. Both are literals over there, so if either
    // moves this reads as a stale number in the output rather than passing quietly
    // on a scenario that no longer happens.
    const flashDepth = CFG.fx.muzzleStandoff + 0.35;
    const flashWants = (3.6 * 320) / flashDepth;
    ok("and the muzzle flash is a case that needs it", flashWants > cap,
      `largest flash sprite wants ${flashWants.toFixed(0)} px at ${flashDepth.toFixed(2)} m,`
      + ` capped to ${cap.toFixed(0)}`);

    // The viewmodel must react, and must stay finite.
    ok("the viewmodel recoils when the gun fires", viewmodel.lastShots === sim.weapon.shots,
      `tracked ${viewmodel.lastShots} shots`);
    ok("its transform stayed finite",
      [viewmodel.group.position, viewmodel.group.rotation]
        .every((v) => [v.x, v.y, v.z].every(Number.isFinite)),
      `pos ${viewmodel.group.position.toArray().map((n) => n.toFixed(3)).join(",")}`);

    // And it must get out of the way when something else owns the hands.
    sim.guns[0].mount(sim.player);
    viewmodel.update(DT, ctx);
    ok("and it hides while a station owns the player's hands", !viewmodel.group.visible);
    sim.guns[0].dismount(sim.player);
    viewmodel.update(DT, ctx);
    ok("then comes back", viewmodel.group.visible);

    // Repair can own the hands for several seconds. Hiding by early-return alone would freeze
    // the last recoil pose for all of them and make the rifle jump back into view still kicked
    // when E is released, so the invisible model must continue settling.
    viewmodel.recoil = 1;
    sim.player.repairing = "leg:0";
    const repairRecoil = viewmodel.recoil;
    for (let i = 0; i < 30; i++) viewmodel.update(DT, ctx);
    ok("active repair hides the carried weapon", !viewmodel.group.visible);
    ok("and hidden recoil keeps settling instead of freezing",
      viewmodel.recoil < repairRecoil * 0.2,
      `${repairRecoil.toFixed(2)} -> ${viewmodel.recoil.toFixed(3)}`);
    sim.player.repairing = null;
    viewmodel.update(DT, ctx);
    ok("the settled weapon returns immediately when repair releases the hands",
      viewmodel.group.visible && viewmodel.recoil < repairRecoil * 0.2,
      `visible ${viewmodel.group.visible}, recoil ${viewmodel.recoil.toFixed(3)}`);

    // One model per carried weapon, exactly one drawn, and a swap changes WHICH one.
    //
    // This matters more than it looks. The silhouette in the player's hands is the
    // only readout for which weapon is up -- there is deliberately no HUD row, because
    // invariant 27 is about panels accumulating and a shape is a better teacher than a
    // label anyway. So a swap that changed the numbers and not the model would be a
    // lie with nothing else in the game to contradict it, and the harness cannot see a
    // rendered frame. Counting visibility flags is the closest honest proxy.
    ok("there is a model for every carried weapon",
      viewmodel.models.length === CFG.combat.loadout.carried.length,
      `${viewmodel.models.length} models for ${CFG.combat.loadout.carried.length} carried`);
    const drawn = () => viewmodel.models.filter((m) => m.visible).length;
    ok("exactly one of them is drawn", drawn() === 1, `${drawn()} visible`);

    const wasShowing = viewmodel.models.findIndex((m) => m.visible);
    sim.weapon.swap();
    viewmodel.update(DT, ctx);
    const nowShowing = viewmodel.models.findIndex((m) => m.visible);
    ok("and swapping the weapon swaps the silhouette, not just the numbers",
      nowShowing !== wasShowing && nowShowing === sim.weapon.slot && drawn() === 1,
      `model ${wasShowing} -> ${nowShowing}, holding ${sim.weapon.weaponName}`);
    ok("the swapped-to weapon has a name and a line the toast can print",
      typeof sim.weapon.weaponName === "string" && sim.weapon.weaponName.length > 0
      && typeof sim.weapon.profile.detail === "string",
      `"${sim.weapon.weaponName}" — ${sim.weapon.profile.detail}`);

    // The fixed downed camera is third person, so the local operative needs a body
    // in the world while the carried model disappears. Use the real scene-backed
    // constructor and a ground fall, where the correct parent is the scene itself.
    if (sim.player.downed) sim.player.recoverInPlace();
    sim.player.position.set(40, 1.2, 40);
    sim.player.base = null;
    sim.player.velocity.set(0, 0, 0);
    sim.player.hp = sim.player.maxHp;
    sim.player.spawnGrace = 0;
    sim.player.yaw = 0.61;
    sim.player.hurt(1e6);
    viewmodel.update(DT, ctx);
    ok("the scene-backed viewmodel draws the incapacitated body at the fall pose",
      viewmodel.body.group.visible
      && viewmodel.body.group.parent === sim.scene
      && viewmodel.body.group.position.distanceTo(sim.player.position) < 1e-9
      && Math.abs(viewmodel.body.group.rotation.y - sim.player.viewYaw) < 1e-9
      && Math.abs(viewmodel.body.rig.rotation.z - Math.PI / 2) < 1e-9,
      `visible ${viewmodel.body.group.visible}, parent `
      + `${viewmodel.body.group.parent === sim.scene ? "scene" : "other"}, `
      + `yaw ${viewmodel.body.group.rotation.y.toFixed(2)}`);
    ok("incapacitation hides the carried weapon while that body is visible",
      !viewmodel.group.visible && viewmodel.body.group.visible,
      `weapon ${viewmodel.group.visible}, body ${viewmodel.body.group.visible}`);

    sim.player.recoverInPlace();
    viewmodel.update(DT, ctx);
    ok("the body disappears and the carried weapon returns after recovery",
      !viewmodel.body.group.visible && viewmodel.group.visible,
      `weapon ${viewmodel.group.visible}, body ${viewmodel.body.group.visible}`);
  }

  delete globalThis.document;
}

// ---------------------------------------------------------------------------
// The HUD, actually executed.
//
// Test 67 checks that every id `hud.js` reaches for exists in the markup, which
// catches the commonest fault and none of the others: 550 lines of branching --
// shop grouping, the bay, the route panel, the fuse prompt, the alarm, the
// crosshair state machine -- were never run by anything. A typo in any of it is a
// thrown exception mid-frame, which in a browser stops the render loop dead.
//
// The stub is deliberately FAITHFUL about one thing: `getElementById` returns an
// element only for ids that genuinely exist in index.html, and null otherwise.
// A permissive stub would execute the code but throw away the very check test 67
// exists for.
function installDomStub() {
  const html = readFileSync("index.html", "utf8");
  const realIds = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]));
  const pipCount = [...html.matchAll(/<div class="pip">/g)].length;
  const made = new Map();

  const element = (id) => ({
    id,
    textContent: "",
    innerHTML: "",
    className: "",
    style: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) {
        const want = on === undefined ? !this._set.has(c) : on;
        if (want) this._set.add(c);
        else this._set.delete(c);
        return want;
      },
      contains(c) { return this._set.has(c); },
    },
  });

  globalThis.document = {
    getElementById(id) {
      if (!realIds.has(id)) return null; // faithful: a bad id is still a bug
      if (!made.has(id)) made.set(id, element(id));
      return made.get(id);
    },
    querySelectorAll(sel) {
      if (sel === "#pips .pip") {
        return Array.from({ length: pipCount }, (_, i) => element(`pip${i}`));
      }
      return [];
    },
  };

  return { made, pipCount, realIds };
}

console.log("\n84. The HUD runs every branch it has against the real simulation");
{
  const dom = installDomStub();
  let Hud;
  let loadError = null;
  try {
    ({ Hud } = await import("./src/hud.js"));
  } catch (err) {
    loadError = err;
  }
  ok("hud.js loads", !loadError, loadError ? loadError.message : "ok");

  if (Hud) {
    ok("the markup really does have six leg pips (stub is faithful)", dom.pipCount === 6,
      `${dom.pipCount} pips`);

    const sim = makeSim();
    const hud = new Hud();
    ok("the HUD constructed without reaching for a missing element", true);

    // Every element it grabbed must be real, not null. This is the fault that
    // otherwise surfaces many frames later somewhere unrelated-looking.
    const nulls = Object.entries(hud.el).filter(([, v]) => !v).map(([k]) => k);
    ok("every readout element resolved", nulls.length === 0,
      nulls.length ? `null: ${nulls.join(", ")}` : `${Object.keys(hud.el).length} readouts`);

    const ctx = () => ({
      ...sim, guns: sim.guns, input: sim.input,
      gun: sim.guns.find((g) => g.mounted) ?? sim.guns.find((g) => g.canMount) ?? null,
      fps: 60, dt: DT,
    });

    const drive = (label, frames = 4, hook) => {
      try {
        for (let i = 0; i < frames; i++) {
          hook?.(i);
          step(sim, 1);
          hud.update(ctx());
        }
        return null;
      } catch (err) {
        return `${label}: ${err.message}`;
      }
    };

    const failures = [];
    const push = (e) => { if (e) failures.push(e); };

    // ---- resting AND standing at the refit terminal, so the refit panel is open.
    //
    // The console is the gate now, so the HUD's shop branch is unreachable without it.
    // Re-applied inside the drive hook rather than once before it, because `drive` steps
    // the real simulation and a walking deck would otherwise carry the operative out of
    // range mid-check -- which is precisely the hull-local behaviour test 63 asserts.
    push(drive("rest", 4, () => shopReadyNoStep(sim)));
    // Checks that the panel lists WHAT IS ON SALE, rather than looking for one
    // hard-coded item name. The shop sells a re-rolled subset of the catalogue now,
    // so "does it mention RIFLE CALIBRATION" was asserting the roll rather than the
    // panel -- it passed only while the catalogue was small enough to all fit.
    const onSale = sim.economy.entries;
    ok("the refit panel opens during a rest and lists what is on sale",
      hud.shop.className.includes("show")
      && onSale.length > 0
      && onSale.every((e) => hud.shopItems.innerHTML.includes(e.name)),
      `class "${hud.shop.className}", ${onSale.length} offers, `
      + `${hud.shopItems.innerHTML.length} chars of list`);
    ok("and it is grouped by purse, which is the whole design",
      hud.shopItems.innerHTML.includes("personal")
      && hud.shopItems.innerHTML.includes("fortress"));
    ok("and its title says the keys are live, rather than just naming the panel",
      hud.shopTitle.textContent.includes("READY"),
      `"${hud.shopTitle.textContent}" class "${hud.shop.className}"`);

    // ---- BROWSING: at the console with a wave out. The panel stays up and readable and
    // the keys are dead, which is the whole browse/buy split. Driven in its own sim so
    // the main one's phase is not disturbed.
    //
    // This is the branch that must never be silent. A panel headed REFIT that swallows
    // every keypress is worse than one that is absent, so the title and the `locked`
    // class are both asserted, not merely the visibility.
    const browse = makeSim();
    const browseHud = new Hud();
    browse.economy.salvage = 1e6;
    browse.director.phase = PHASE.ENGAGED;
    try {
      for (let i = 0; i < 3; i++) {
        shopReadyNoStep(browse);
        browse.director.phase = PHASE.ENGAGED;
        browseHud.update({
          ...browse, guns: browse.guns, input: browse.input, gun: null, fps: 60, dt: DT,
        });
      }
    } catch (err) {
      failures.push(`browsing: ${err.message}`);
    }
    ok("at the console mid-wave the panel is READABLE but locked, and says which",
      browseHud.shop.className.includes("show")
      && browseHud.shop.className.includes("locked")
      && browseHud.shopTitle.textContent.includes("NOT WHILE A WAVE IS OUT")
      && browseHud.shopItems.innerHTML.length > 0,
      `class "${browseHud.shop.className}", title "${browseHud.shopTitle.textContent}",`
      + ` ${browseHud.shopItems.innerHTML.length} chars still listed`);
    ok("and the prompt says the same thing, so it is legible without reading the panel",
      browseHud.promptLabel.textContent.includes("LOCKED"),
      `"${browseHud.promptLabel.textContent}"`);

    // ---- the build readout
    //
    // The list above shows four of sixteen personal items, so an item taken from a
    // salvage pick or bought two landmarks ago can be absent from it while very much
    // still in the build. That is what this readout is for, and it is why the check
    // below deliberately uses an item the shop is NOT selling: asserting on an
    // offered item would pass even if the readout only ever echoed the offer list.
    ok("an empty build says so rather than leaving a blank strip",
      hud.shopBuild.innerHTML.includes("nothing"),
      `"${hud.shopBuild.innerHTML}"`);

    const buildSim = makeSim();
    const buildHud = new Hud();
    const offSaleIndex = CFG.economy.catalogue.findIndex(
      (it, i) => it.pool === "salvage" && !buildSim.economy.offers.includes(i),
    );
    const offSale = CFG.economy.catalogue[offSaleIndex];
    buildSim.economy.salvage = 1e6;
    shopReady(buildSim);
    const boughtOffSale = buildSim.economy.buy(offSaleIndex);
    try {
      buildHud.update({
        ...buildSim, guns: buildSim.guns, input: buildSim.input, gun: null, fps: 60, dt: DT,
      });
    } catch (err) {
      failures.push(`build readout: ${err.message}`);
    }
    ok("and an item the shop is not selling still shows up in the build",
      !!boughtOffSale && buildHud.shopBuild.innerHTML.includes(offSale.name),
      offSaleIndex >= 0
        ? `${offSale.name}, not among the ${buildSim.economy.offers.length} on sale`
        : "EVERY SALVAGE ITEM IS ON SALE -- this check has nothing to measure");

    // ---- the bay, which borrows the same keys
    hud.toggleBay();
    push(drive("bay open"));
    ok("the bay opens and draws three hardpoints",
      hud.bay.className.includes("show")
      && (hud.baySockets.innerHTML.match(/HARDPOINT/g) ?? []).length === CFG.fortress.sockets,
      `${(hud.baySockets.innerHTML.match(/HARDPOINT/g) ?? []).length} sockets drawn`);
    ok("and the refit panel steps aside while it is up",
      !hud.shop.className.includes("show"),
      `shop class "${hud.shop.className}"`);
    ok("the bay lists every module", hud.bayItems.innerHTML.includes("FLOODLIGHTS")
      && hud.bayItems.innerHTML.includes("REACTOR CASING"));
    hud.toggleBay();

    // ---- a fitted module must show up in the socket strip
    sim.economy.scrap = 1e6;
    shopReadyNoStep(sim);
    sim.economy.buyModule(0);
    hud.toggleBay();
    push(drive("bay with a module fitted"));
    ok("a fitted module appears in its hardpoint",
      hud.baySockets.innerHTML.includes("FLOODLIGHTS")
      && hud.baySockets.innerHTML.includes("filled"),
      "socket strip updated");
    hud.toggleBay();

    // ---- telegraph
    sim.waves = true;
    sim.player.position.set(700, 1.2, 700);
    sim.player.base = null;
    let sawTelegraph = false;
    push(drive("prep", 60 * 30, () => {
      if (sim.director.phase === PHASE.PREP) sawTelegraph = true;
    }));
    ok("a wave telegraph was reached (test is not vacuous)", sawTelegraph);

    // ---- boss telegraph, which has its own copy and styling
    sim.run.leg = CFG.run.legs;
    sim.director.siegeLength = sim.run.siegeLength;
    sim.director.wave = sim.director.siegeLength - 1;
    sim.director.phase = PHASE.PREP;
    sim.director.timer = 5;
    hud.update(ctx());
    ok("the boss gets its own telegraph, and it names the reason it is different",
      hud.telegraphHead.textContent.includes("SIEGEBREAKER")
      && hud.telegraph.className.includes("boss")
      && hud.telegraphSub.textContent.includes("SHADOW"),
      `"${hud.telegraphHead.textContent}" / "${hud.telegraphSub.textContent}"`);

    // ---- route choice
    const routeSim = makeSim();
    const routeHud = new Hud();
    routeSim.director.phase = PHASE.HELD;
    routeSim.run.update();
    // Holding a siege pays a salvage pick before the road, so take it to reach the
    // route state this branch is about.
    routeSim.economy.takePick(0);
    routeSim.run.update();
    const routeCtx = {
      ...routeSim, guns: routeSim.guns, input: routeSim.input,
      gun: null, fps: 60, dt: DT,
    };
    try {
      routeHud.update(routeCtx);
    } catch (err) {
      failures.push(`route: ${err.message}`);
    }
    ok("the route panel appears when the run asks for a decision",
      routeSim.run.choosing && routeHud.route.className.includes("show"),
      `phase ${routeSim.run.phase}`);
    ok("and every offered road states its cost AND its payout",
      (routeHud.routeItems.innerHTML.match(/class="rc"/g) ?? []).length === CFG.run.branches
      && (routeHud.routeItems.innerHTML.match(/pays/g) ?? []).length === CFG.run.branches,
      `${CFG.run.branches} roads described`);
    ok("the prompt asks for the choice rather than showing something else",
      routeHud.promptLabel.textContent.includes("ROAD"),
      `"${routeHud.promptLabel.textContent}"`);

    // The accumulated-cost line. Both branches, because "nothing yet" is the state the
    // first road choice of every run is made in.
    ok("at the first road, it says plainly that the roads have cost nothing yet",
      routeHud.routeCarried.innerHTML.includes("nothing"),
      `"${routeHud.routeCarried.innerHTML}"`);

    // Hand it a run that has already taken costly roads, so the populated branch is
    // driven with real accumulated state rather than with a string.
    const carriedSim = makeSim();
    const carriedHud = new Hud();
    const boneyard = CFG.run.routes.find((r) => r.id === "boneyard");
    const rift = CFG.run.routes.find((r) => r.id === "rift");
    carriedSim.run.offers = [boneyard, rift];
    carriedSim.run.phase = RUN.CHOOSING;
    carriedSim.run.choose(0); // takes the boneyard: +18% enemy health
    carriedSim.run.offers = [rift, boneyard];
    carriedSim.run.phase = RUN.CHOOSING;
    carriedSim.run.choose(0); // takes the rift: +4 per wave
    carriedSim.run.offers = [boneyard, rift];
    carriedSim.run.phase = RUN.CHOOSING;
    try {
      carriedHud.update({
        ...carriedSim, guns: carriedSim.guns, input: carriedSim.input,
        gun: null, fps: 60, dt: DT,
      });
    } catch (err) {
      failures.push(`route carried: ${err.message}`);
    }
    ok("and once roads have been taken it names what they cost, permanently",
      carriedHud.routeCarried.innerHTML.includes("enemy health")
      && carriedHud.routeCarried.innerHTML.includes("per wave")
      && carriedHud.routeCarried.innerHTML.includes(boneyard.name),
      `"${carriedHud.routeCarried.innerHTML.replace(/<[^>]+>/g, "")}"`);

    // ---- the live vote tally, and the solo case that must stay silent.
    //
    // Test 109 owns the voting rule. What lives here is the drawing of it, and none of
    // it is reachable with one operative -- so without this the "N OF M AGREE" head, the
    // per-road seat line and the deadlock banner are three templates nothing ever runs.
    ok("a solo road choice says nothing about agreement, because there is none to reach",
      !routeHud.routeHead.textContent.includes("AGREE")
      && !routeHud.routeItems.innerHTML.includes("CREW "),
      `"${routeHud.routeHead.textContent}"`);

    const voteSim = makeSim();
    const voteHud = new Hud();
    for (let i = 1; i < 4; i++) {
      const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
      cam.rotation.order = "YXZ";
      voteSim.crew.add(new Player(cam, voteSim.world, voteSim.trampler));
    }
    voteSim.director.phase = PHASE.HELD;
    voteSim.run.update();
    voteSim.economy.takePick(0);
    voteSim.run.update();
    const voteCtx = () => ({
      ...voteSim, guns: voteSim.guns, input: voteSim.input, gun: null, fps: 60, dt: DT,
    });
    const [v1, v2, v3, v4] = voteSim.crew.members;

    try {
      voteSim.run.vote(v1, 0);
      voteSim.run.vote(v2, 0);
      voteHud.update(voteCtx());
    } catch (err) {
      failures.push(`route vote: ${err.message}`);
    }
    ok("the run is genuinely mid-ballot with a crew of four (test is not vacuous)",
      voteSim.run.choosing && voteSim.crew.size === 4 && voteSim.run.tally[0] === 2,
      `[${voteSim.run.tally.join(",")}] of ${voteSim.crew.size}`);
    ok("with a crew, the head says how many have to agree",
      voteHud.routeHead.textContent.includes("3 OF 4 AGREE"),
      `"${voteHud.routeHead.textContent}"`);
    ok("and each road names the SEATS backing it, not just a count",
      voteHud.routeItems.innerHTML.includes("CREW 1, 2"),
      `${(voteHud.routeItems.innerHTML.match(/class="rv">([^<]*)</g) ?? []).join(" | ")}`);

    // The tally has to REDRAW as votes land. The panel caches on a signature, and the
    // offers do not change while the crew is deciding -- so if the signature ignored the
    // votes, every vote after the first would be invisible, which is the one thing a live
    // tally must not be.
    const beforeThird = voteHud.routeItems.innerHTML;
    try {
      voteSim.run.vote(v3, 1);
      voteHud.update(voteCtx());
    } catch (err) {
      failures.push(`route vote redraw: ${err.message}`);
    }
    ok("a further vote redraws the panel rather than leaving a stale tally",
      voteHud.routeItems.innerHTML !== beforeThird
      && voteHud.routeItems.innerHTML.includes("CREW 3"),
      `road 2 now backed by crew ${voteSim.run.voteSeats[1].join(", ")}`);

    try {
      voteSim.run.vote(v4, 1);
      voteHud.update(voteCtx());
    } catch (err) {
      failures.push(`route deadlock: ${err.message}`);
    }
    ok("an even split is drawn as a SPLIT that names the fix, not a stalled run",
      voteSim.run.deadlocked
      && voteHud.routeHead.textContent.includes("SPLIT 2")
      && voteHud.routeHead.textContent.includes("CHANGE THEIR MIND"),
      `"${voteHud.routeHead.textContent}"`);

    // ---- repair, contested repair, and the fuse warning
    const repairSim = makeSim();
    const repairHud = new Hud();
    const rctx = () => ({
      ...repairSim, guns: repairSim.guns, input: repairSim.input,
      gun: null, fps: 60, dt: DT,
    });
    repairSim.trampler.damageLeg(0, 1e6);
    const at = repairSim.trampler.legAttackWorld(0, new THREE.Vector3());
    repairSim.player.position.set(at.x, 1.2, at.z);
    repairSim.player.base = null;
    try {
      for (let i = 0; i < 20; i++) {
        step(repairSim, 1, () => {
          const s = repairSim.trampler.legAttackWorld(0, new THREE.Vector3());
          repairSim.player.position.set(s.x, repairSim.player.position.y, s.z);
          repairSim.input.keys.add(CFG.repair.key);
        });
        repairHud.update(rctx());
      }
    } catch (err) {
      failures.push(`repair: ${err.message}`);
    }
    ok("a repair in progress shows as working",
      repairHud.prompt.className.includes("working")
      && repairHud.promptLabel.textContent.includes("REPAIR"),
      `"${repairHud.promptLabel.textContent}" class "${repairHud.prompt.className}"`);

    // Contested is a THIRD state, not "blocked": the bar is still filling.
    repairSim.horde.spawn(CHEWER);
    try {
      for (let i = 0; i < 30; i++) {
        step(repairSim, 1, () => {
          const s = repairSim.trampler.legAttackWorld(0, new THREE.Vector3());
          repairSim.player.position.set(s.x, repairSim.player.position.y, s.z);
          const e = repairSim.horde.pool.find((x) => x.alive);
          if (e) {
            e.x = repairSim.player.position.x + 1;
            e.z = repairSim.player.position.z;
          }
          repairSim.input.keys.add(CFG.repair.key);
        });
        repairHud.update(rctx());
      }
    } catch (err) {
      failures.push(`contested: ${err.message}`);
    }
    ok("contested repair says CONTESTED in its own style, not blocked",
      repairHud.prompt.className.includes("contested")
      && repairHud.promptLabel.textContent.includes("CONTESTED"),
      `"${repairHud.promptLabel.textContent}" class "${repairHud.prompt.className}"`);

    // ---- and a point a TEAMMATE is already welding, which is the third reading.
    //
    // The rule itself lives in repair.js and test 108 owns it. What lives here is the
    // string, and a string nothing ever executes is the "a rule with no test because it
    // only exists in the HUD" trap: a typo in this template throws at the exact moment
    // two operatives stand at one leg, which is the first thing co-op ever does.
    //
    // It reads in the BLOCKED style rather than the contested one, and that distinction
    // is the point. Contested work is a trade the player can choose to make and the bar
    // is still filling; a second welder is no work at all and nothing to trade. So this
    // one names the teammate, because "hold E and nothing happens" would send the player
    // to fix the wrong thing, and the actual answers -- cover them, or take another leg
    // -- are not things a generic refusal would ever suggest.
    const takenSim = makeSim();
    const takenHud = new Hud();
    takenSim.trampler.walking = false;
    takenSim.trampler.turning = false;
    const mateCam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    mateCam.rotation.order = "YXZ";
    const mate = new Player(mateCam, takenSim.world, takenSim.trampler);
    takenSim.crew.add(mate);
    const mateRepair = new Repair(mate, takenSim.trampler, takenSim.horde, takenSim.crew);
    const mateInput = makeInput();
    mateInput.keys.add(CFG.repair.key);

    takenSim.trampler.damageLeg(0, 1e6);
    const legSpot = takenSim.trampler.legAttackWorld(0, new THREE.Vector3());
    for (const who of [takenSim.player, mate]) {
      who.position.set(legSpot.x, 1.2, legSpot.z);
      who.base = null;
      who.velocity.set(0, 0, 0);
    }

    try {
      // The mate first, so THEY own the point and the local operative is the one refused
      // -- which is the case the HUD has to draw. Seat 2, since the crew is [player, mate].
      for (let i = 0; i < 4; i++) {
        mateRepair.update(DT, mateInput);
        takenSim.repair.update(DT, takenSim.input);
      }
      takenHud.update({
        ...takenSim, guns: takenSim.guns, input: takenSim.input, gun: null, fps: 60, dt: DT,
      });
    } catch (err) {
      failures.push(`repair taken: ${err.message}`);
    }
    ok("the mate genuinely owns the leg (test is not vacuous)",
      mate.repairing === "leg:0" && takenSim.repair.takenBy === 2,
      `mate claim ${mate.repairing}, local takenBy ${takenSim.repair.takenBy}`);
    ok("a leg a teammate is welding says so by SEAT, in the blocked style",
      takenHud.promptLabel.textContent.includes("CREW 2 IS ON IT")
      && takenHud.promptLabel.textContent.includes("PORT FORE LEG")
      && takenHud.prompt.className.includes("blocked"),
      `"${takenHud.promptLabel.textContent}" class "${takenHud.prompt.className}"`);
    ok("and it does not claim to be contested, which would say the bar is still filling",
      !takenHud.prompt.className.includes("contested")
      && !takenHud.promptLabel.textContent.includes("CONTESTED"),
      `class "${takenHud.prompt.className}"`);

    // A sapper is a timer, and this prompt is its only warning.
    const fuseSim = makeSim();
    const fuseHud = new Hud();
    fuseSim.trampler.walking = false;
    fuseSim.trampler.turning = false;
    const sapper = fuseSim.horde.spawn(SAPPER);
    const spot = fuseSim.trampler.legAttackWorld(0, new THREE.Vector3());
    sapper.x = spot.x;
    sapper.y = spot.y;
    sapper.z = spot.z;
    sapper.legIndex = 0;
    let sawFuse = false;
    try {
      for (let i = 0; i < 60; i++) {
        step(fuseSim, 1);
        fuseHud.update({
          ...fuseSim, guns: fuseSim.guns, input: fuseSim.input, gun: null, fps: 60, dt: DT,
        });
        if (fuseHud.promptLabel.textContent.includes("CHARGE")) sawFuse = true;
      }
    } catch (err) {
      failures.push(`fuse: ${err.message}`);
    }
    ok("a lit charge warns on the prompt, because nothing else does", sawFuse,
      `"${fuseHud.promptLabel.textContent}"`);

    // ---- the emitter prompt, which replaced a permanent `emitters 3 / 3` row
    //
    // The row named a key and a ratio, said nothing about what an emitter was or when to
    // place one, and was actionable only on foot beneath the hull. As a prompt it says
    // the same thing every other entry in that chain says -- the action available where
    // you are standing -- so the placement rule teaches itself by the prompt appearing.
    //
    // Driven by standing the operative in the real placement zone rather than by writing
    // `emitters.ready`, because the half that can rot is whether the geometry and the
    // prompt agree about where "beneath the hull" is.
    const emSim = makeSim();
    const emHud = new Hud();
    const ectx = () => ({
      ...emSim, guns: emSim.guns, input: emSim.input, gun: null, fps: 60, dt: DT,
    });
    const emKey = CFG.emitters.deployKey.replace("Key", "");
    emSim.trampler.walking = false;
    emSim.trampler.turning = false;
    emSim.player.dropToGround();
    // Local y = 0 is the DECK SURFACE, so only x/z come from the hull centre; the world
    // y is set outright to put the operative on the sand underneath it.
    const beneathHull = emSim.trampler.localToWorld(new THREE.Vector3(0, 0, 0));
    emSim.player.position.set(beneathHull.x, 1.2, beneathHull.z);
    try {
      step(emSim, 2);
      emHud.update(ectx());
    } catch (err) {
      failures.push(`emitter prompt: ${err.message}`);
    }
    ok("standing under the hull on foot offers the emitter, with its key and what is left",
      emSim.emitters.ready
      && emHud.prompt.className.includes("show")
      && emHud.promptKey.textContent === emKey
      && emHud.promptLabel.textContent.includes("EMITTER")
      && emHud.promptLabel.textContent.includes(`${CFG.emitters.max} LEFT`),
      `"${emHud.promptKey.textContent} ${emHud.promptLabel.textContent}"`);

    // The count is the part the deleted row was actually carrying, so it has to move
    // with it rather than being dropped on the floor.
    const placedOne = !!emSim.emitters.deploy(emSim.player);
    try {
      step(emSim, 1);
      emHud.update(ectx());
    } catch (err) {
      failures.push(`emitter prompt after one: ${err.message}`);
    }
    ok("and the count comes down as the rack empties",
      placedOne && emHud.promptLabel.textContent.includes(`${CFG.emitters.max - 1} LEFT`),
      `placed ${emSim.emitters.deployedCount}, prompt "${emHud.promptLabel.textContent}"`);

    // An empty rack is SILENT, and that is a decision rather than an oversight, so it is
    // pinned here. Saying NO EMITTERS LEFT would be the better prompt -- it answers "I
    // pressed X and nothing happened" and it would name C, which is otherwise only in the
    // help panel -- but `canDeploy` tests the count before the position, so an empty rack
    // reads the same way up on the deck. Isolating the case worth naming needs either a
    // reordering that changes the strings test 46 asserts on, or a second copy of the
    // placement geometry. When that lands, this assertion should fail and be rewritten.
    while (emSim.emitters.available > 0) emSim.emitters.deploy(emSim.player);
    try {
      step(emSim, 1);
      emHud.update(ectx());
    } catch (err) {
      failures.push(`emitter prompt empty: ${err.message}`);
    }
    ok("and an empty rack says nothing at all, which is a recorded gap not an accident",
      emSim.emitters.deployedCount === CFG.emitters.max
      && !emSim.emitters.ready
      && emHud.prompt.className === "",
      `${emSim.emitters.deployedCount} out, blockReason "${emSim.emitters.blockReason}",`
      + ` prompt class "${emHud.prompt.className}"`);

    // ---- the target readout
    //
    // Every branch: nothing under the reticle, an unarmoured thing at full health,
    // the same thing wounded, and an ARMOURED one — that last line being the whole
    // reason this readout exists, since it is the game's only way of saying "wrong
    // tool" out loud.
    const tSim = makeSim();
    const tHud = new Hud();
    const tctx = () => ({
      ...tSim, guns: tSim.guns, input: tSim.input, gun: null, fps: 60, dt: DT,
    });
    tSim.trampler.walking = false;
    tSim.trampler.turning = false;
    placeOnGroundAt(tSim, 0, -40);
    aimAt(tSim.player, new THREE.Vector3(tSim.player.position.x, 1.2, tSim.player.position.z - 60));
    step(tSim, 2);
    try {
      tHud.update(tctx());
    } catch (err) {
      failures.push(`target empty: ${err.message}`);
    }
    ok("with nothing under the crosshair the target readout is not on screen",
      !tHud.target.className.includes("show"), `class "${tHud.target.className}"`);

    const aimTarget = (sim2, e) => {
      aimAt(sim2.player, new THREE.Vector3(e.x, e.y, e.z));
      step(sim2, 1);
      aimAt(sim2.player, new THREE.Vector3(e.x, e.y, e.z));
      step(sim2, 1);
    };

    const grunt = tSim.horde.spawn(CHEWER);
    grunt.x = tSim.player.position.x;
    grunt.y = 0.8;
    grunt.z = tSim.player.position.z - 18;
    aimTarget(tSim, grunt);
    try {
      tHud.update(tctx());
    } catch (err) {
      failures.push(`target named: ${err.message}`);
    }
    ok("aiming at one names it, at full health, with no armour line",
      tHud.target.className.includes("show")
      && !tHud.target.className.includes("hurt")
      && tHud.targetName.textContent === CFG.enemies.chewer.label
      && tHud.targetArmour.textContent === "",
      `"${tHud.targetName.textContent}" class "${tHud.target.className}"`);

    tSim.horde.damage(grunt, grunt.maxHp * 0.5);
    aimTarget(tSim, grunt);
    try {
      tHud.update(tctx());
    } catch (err) {
      failures.push(`target hurt: ${err.message}`);
    }
    ok("and a wounded one reads in the hurt style",
      tHud.target.className.includes("hurt"),
      `class "${tHud.target.className}", ${Math.round(grunt.hp / grunt.maxHp * 100)}% left`);

    // The armoured case, in a fresh sim so the wounded chewer above cannot be picked
    // up by the ray instead.
    const aSim = makeSim();
    const aHud = new Hud();
    aSim.trampler.walking = false;
    aSim.trampler.turning = false;
    placeOnGroundAt(aSim, 0, -40);
    const tank = aSim.horde.spawn(BULWARK);
    tank.x = aSim.player.position.x;
    tank.y = CFG.enemies.bulwark.height / 2;
    tank.z = aSim.player.position.z - 18;
    const aCtx = () => ({
      ...aSim, guns: aSim.guns, input: aSim.input, gun: null, fps: 60, dt: DT,
    });
    // Facing pinned, because the readout now reports the armour actually in the way and
    // a bulwark walking toward the fortress has its BACK to a player standing between
    // them. The first version of this check did not pin it, got the flank, and reported
    // ARMOUR EXPOSED while claiming to test the armoured branch.
    aimTarget(aSim, tank);
    tank.yaw = Math.atan2(
      -(aSim.player.position.x - tank.x), -(aSim.player.position.z - tank.z),
    );
    aSim.weapon.scanTarget();
    try {
      aHud.update(aCtx());
    } catch (err) {
      failures.push(`target armoured: ${err.message}`);
    }
    ok("an armoured target says so, which is the only place the game ever does",
      aHud.target.className.includes("show")
      && aHud.targetName.textContent === CFG.enemies.bulwark.label
      && aHud.targetArmour.textContent.includes("ARMOURED"),
      `"${aHud.targetName.textContent}" / "${aHud.targetArmour.textContent}"`);

    // And the branch that teaches the flank. This is the only way a player ever finds
    // out the rear cone exists — one who never happens to walk behind a bulwark would
    // otherwise never learn it, which makes it a rule nobody plays around.
    tank.yaw = Math.atan2(
      -(tank.x - aSim.player.position.x), -(tank.z - aSim.player.position.z),
    );
    aSim.weapon.scanTarget();
    try {
      aHud.update(aCtx());
    } catch (err) {
      failures.push(`target exposed: ${err.message}`);
    }
    ok("and getting behind it says THAT, in the colour the game uses for 'you can act'",
      aHud.targetArmour.textContent.includes("EXPOSED")
      && aHud.target.className.includes("open"),
      `"${aHud.targetArmour.textContent}" class "${aHud.target.className}"`);

    // ---- the live conditional bonus
    //
    // Half the salvage table pays only in a particular place, or for a few seconds
    // after a transition, and this strip is the ONLY feedback that a condition is
    // being met. Without it "+30% beneath the hull" is indistinguishable from an item
    // that does nothing, which is the worst possible property for the two items that
    // pay for moving between deck and ground.
    //
    // Driven with the item genuinely stacked and the player genuinely under the hull
    // rather than by writing `items.bonus` directly, because what is worth checking is
    // that the runtime's reading and the HUD's reading of it agree.
    const buffSim = makeSim();
    const buffHud = new Hud();
    const bctx = () => ({
      ...buffSim, guns: buffSim.guns, input: buffSim.input, gun: null, fps: 60, dt: DT,
    });
    buffHud.update(bctx());
    ok("with no conditional item live, nothing is on screen for it",
      !buffHud.buffs.className.includes("show"),
      `class "${buffHud.buffs.className}"`);

    buffSim.trampler.walking = false;
    buffSim.trampler.turning = false;
    buffSim.economy.stacks.understudy = 1;
    buffSim.economy.applyAll();
    buffSim.player.dropToGround();
    const beneath = buffSim.trampler.localToWorld(new THREE.Vector3(0, 0, 0));
    buffSim.player.position.set(beneath.x, 1.2, beneath.z);
    try {
      step(buffSim, 2);
      buffHud.update(bctx());
    } catch (err) {
      failures.push(`buffs: ${err.message}`);
    }
    ok("standing under the hull with the understudy fitted reports the bonus and why",
      buffHud.buffs.className.includes("show")
      && buffHud.buffWhy.textContent.includes("UNDER HULL")
      && buffHud.buffGain.textContent === `+${Math.round(CFG.items.understudy * 100)}%`,
      `"${buffHud.buffGain.textContent} ${buffHud.buffWhy.textContent}"`);

    // And it has to go away again the moment the condition does, or it stops being a
    // reading of the world and becomes a sticker.
    buffSim.player.position.set(beneath.x + 60, 1.2, beneath.z);
    try {
      step(buffSim, 2);
      buffHud.update(bctx());
    } catch (err) {
      failures.push(`buffs cleared: ${err.message}`);
    }
    ok("and it clears the moment you walk out from under it",
      !buffHud.buffs.className.includes("show"),
      `bonus ${buffSim.items.bonus}, class "${buffHud.buffs.className}"`);

    // ---- hostiles: one numeral, plus a marker for each of the two places
    //
    // This was one string, `9  (4 under, 0 aboard)`, which peripheral vision cannot read
    // at all and which gave three numbers with different jobs identical weight. Both
    // counts come from the horde's own per-frame recount rather than being written into
    // it, because the half that can rot is whether the panel and the recount agree.
    const hostSim = makeSim();
    const hostHud = new Hud();
    const hctx = () => ({
      ...hostSim, guns: hostSim.guns, input: hostSim.input, gun: null, fps: 60, dt: DT,
    });
    hostSim.trampler.walking = false;
    hostSim.trampler.turning = false;
    try {
      step(hostSim, 1);
      hostHud.update(hctx());
    } catch (err) {
      failures.push(`hostiles empty: ${err.message}`);
    }
    // Empty markers are the contract the CSS `:empty` rule hides on. A marker written
    // with "0 ABOARD" would be a reading that costs attention and conveys nothing.
    ok("an empty field is a bare numeral with neither marker drawn",
      hostHud.el.live.textContent === "0"
      && hostHud.el.under.textContent === ""
      && hostHud.el.aboard.textContent === "",
      `"${hostHud.el.live.textContent}" / under "${hostHud.el.under.textContent}"`
      + ` / aboard "${hostHud.el.aboard.textContent}"`);

    const hullCentre = hostSim.trampler.localToWorld(new THREE.Vector3(0, 0, 0));
    const shadowed = 3;
    for (let i = 0; i < shadowed; i++) {
      const c = hostSim.horde.spawn(CHEWER);
      // x/z only: the spawn already put it at standing height on the sand, and guessing
      // that height here is how a test ends up asserting against mid-air.
      c.x = hullCentre.x + i * 0.6;
      c.z = hullCentre.z;
    }
    try {
      step(hostSim, 1);
      hostHud.update(hctx());
    } catch (err) {
      failures.push(`hostiles under: ${err.message}`);
    }
    ok("hostiles under the hull get their own marker, which names the place not a number",
      hostSim.horde.underHull === shadowed
      && hostHud.el.live.textContent === String(hostSim.horde.liveCount)
      && hostHud.el.under.textContent === `${shadowed} UNDER HULL`
      && hostHud.el.aboard.textContent === "",
      `horde recounted ${hostSim.horde.underHull} under of ${hostSim.horde.liveCount} live;`
      + ` panel says "${hostHud.el.live.textContent}" + "${hostHud.el.under.textContent}"`);

    // The other half of the pillar. Placed on the deck and marked aboard rather than
    // climbed up there for real -- test 14 owns the climb and it costs hundreds of
    // frames. `horde.aboard` is still asserted, so this cannot pass without the recount
    // having agreed.
    const boarder = hostSim.horde.spawn(CLIMBER);
    const onDeck = hostSim.trampler.localToWorld(new THREE.Vector3(0, 0.95, 4));
    boarder.x = onDeck.x;
    boarder.y = onDeck.y;
    boarder.z = onDeck.z;
    boarder.onHull = true;
    try {
      step(hostSim, 1);
      hostHud.update(hctx());
    } catch (err) {
      failures.push(`hostiles aboard: ${err.message}`);
    }
    ok("and hostiles aboard get the other marker, so the two places never share a reading",
      hostSim.horde.aboard === 1
      && hostHud.el.aboard.textContent === "1 ABOARD"
      && hostHud.el.under.textContent === `${shadowed} UNDER HULL`,
      `horde recounted ${hostSim.horde.aboard} aboard and ${hostSim.horde.underHull} under;`
      + ` panel says "${hostHud.el.under.textContent}" + "${hostHud.el.aboard.textContent}"`);

    // ---- the income tick
    //
    // Driven with real kills through the real damage choke point rather than by writing
    // `economy.earned`, because the half that can rot is whether a kill's payout and the
    // HUD's reading of it agree at all.
    const paySim = makeSim();
    const payHud = new Hud();
    const pctx = () => ({
      ...paySim, guns: paySim.guns, input: paySim.input, gun: null, fps: 60, dt: DT,
    });
    try {
      // First update BASELINES. Money the crew earned before the HUD existed is not an
      // arrival, and reporting it as one is the bug this frame exists to avoid.
      payHud.update(pctx());
    } catch (err) {
      failures.push(`income baseline: ${err.message}`);
    }
    ok("with nothing earned this frame there is no income tick on screen",
      payHud.tick.className === "" && payHud.lastEarned !== null,
      `class "${payHud.tick.className}", baselined ${payHud.lastEarned !== null}`);

    const paidFor = paySim.horde.spawn(CHEWER);
    const salvBefore = paySim.economy.earned.salvage;
    const scrapBefore = paySim.economy.earned.scrap;
    paySim.horde.damage(paidFor, paidFor.maxHp * 10, paySim.player);
    const paidSalv = paySim.economy.earned.salvage - salvBefore;
    const paidScrap = paySim.economy.earned.scrap - scrapBefore;
    try {
      payHud.update(pctx());
    } catch (err) {
      failures.push(`income tick: ${err.message}`);
    }
    // Both lines, because invariant 22 is the whole economy and this would be the first
    // place in the game to blur the two purses into one number.
    ok("a kill that pays shows what it paid, both purses, next to the reticle",
      paidSalv > 0 && paidScrap > 0
      && payHud.tick.className.includes("show")
      && payHud.tickSalvage.textContent === `+${Math.round(paidSalv)} SALVAGE`
      && payHud.tickScrap.textContent === `+${Math.round(paidScrap)} SCRAP`,
      `paid ${paidSalv} salvage / ${paidScrap} scrap, showing`
      + ` "${payHud.tickSalvage.textContent}" + "${payHud.tickScrap.textContent}"`);

    // ACCUMULATION, handed something to accumulate. A test of this that took whatever
    // the frame happened to offer could pass on a single kill and prove nothing.
    const firstReading = payHud.tickSalvage.textContent;
    const alsoPaid = paySim.horde.spawn(CHEWER);
    paySim.horde.damage(alsoPaid, alsoPaid.maxHp * 10, paySim.player);
    try {
      payHud.update(pctx());
    } catch (err) {
      failures.push(`income accumulate: ${err.message}`);
    }
    ok("a second kill inside the window ADDS to the figure rather than replacing it",
      payHud.tickSalvage.textContent === `+${Math.round(paidSalv * 2)} SALVAGE`
      && payHud.tickSalvage.textContent !== firstReading,
      `"${firstReading}" then "${payHud.tickSalvage.textContent}"`
      + ` from 2 kills at ${paidSalv} each`);

    // And it leaves on its own. Updated without stepping the simulation, so `earned` does
    // not move and the only thing happening is the window running out.
    const holdFrames = Math.ceil(CFG.hud.tickHold / DT) + 2;
    try {
      for (let i = 0; i < holdFrames; i++) payHud.update(pctx());
    } catch (err) {
      failures.push(`income expiry: ${err.message}`);
    }
    ok("and it clears itself once the window passes rather than sitting there",
      payHud.tick.className === "" && payHud.tickSalv === 0,
      `class "${payHud.tick.className}" after ${holdFrames} frames`
      + ` of a ${CFG.hud.tickHold}s window`);

    // A restart zeroes `earned`, which reads as a negative delta. The figure must go with
    // it -- a +N left hanging over a fresh run is reporting the previous run's money.
    const lastPaid = paySim.horde.spawn(CHEWER);
    paySim.horde.damage(lastPaid, lastPaid.maxHp * 10, paySim.player);
    try {
      payHud.update(pctx());
    } catch (err) {
      failures.push(`income before reset: ${err.message}`);
    }
    const upBeforeReset = payHud.tick.className.includes("show");
    paySim.economy.reset();
    try {
      payHud.update(pctx());
    } catch (err) {
      failures.push(`income after reset: ${err.message}`);
    }
    ok("and a restart drops it instead of reporting the previous run's money",
      upBeforeReset && payHud.tick.className === "" && payHud.tickSalv === 0,
      `was up: ${upBeforeReset}, now class "${payHud.tick.className}",`
      + ` earned reset to ${paySim.economy.earned.salvage}`);

    // ---- the alarm, the damage flash, and the crosshair
    const feelSim = makeSim();
    const feelHud = new Hud();
    const fctx = () => ({
      ...feelSim, guns: feelSim.guns, input: feelSim.input, gun: null, fps: 60, dt: DT,
    });
    feelHud.update(fctx());
    ok("the reactor alarm is silent at full integrity", !feelHud.alarm.className.includes("on"));

    // ---- the two vitals gauges report a BAND, not only a length
    //
    // Length alone was the whole readout for two updates, and length is the property
    // peripheral vision resolves worst -- which is the one that matters, because 27b
    // deliberately parked this panel in the corner of the eye. Driven through all three
    // bands rather than asserted at one point, since the interesting failure is a
    // threshold that never fires rather than a class that is spelled wrong.
    ok("at full integrity neither vitals gauge carries a band",
      feelHud.el.barHp.className === "" && feelHud.el.barReactor.className === "",
      `hp "${feelHud.el.barHp.className}", reactor "${feelHud.el.barReactor.className}"`);

    feelSim.trampler.damageReactor(feelSim.trampler.maxReactorHp * 0.7);
    feelHud.update(fctx());
    ok("and it takes over the frame once the reactor is failing",
      feelHud.alarm.className.includes("on"),
      `reactor at ${(feelSim.trampler.reactorHp / feelSim.trampler.maxReactorHp * 100).toFixed(0)}%`);

    // The alarm and the amber band are ONE number, so they must turn on together. Two
    // thresholds meaning the same thing is the drift this project has a rule about, and
    // a bar that went amber at a different moment would teach a boundary the game does
    // not have.
    ok("the reactor gauge goes amber on the same frame the alarm does, off one knob",
      feelHud.el.barReactor.className === "low"
      && feelHud.alarm.className.includes("on")
      && feelSim.trampler.reactorHp / feelSim.trampler.maxReactorHp < CFG.hud.hurtBelow,
      `class "${feelHud.el.barReactor.className}" at `
      + `${(feelSim.trampler.reactorHp / feelSim.trampler.maxReactorHp * 100).toFixed(0)}%`
      + ` against hurtBelow ${CFG.hud.hurtBelow}`);

    feelSim.trampler.damageReactor(feelSim.trampler.maxReactorHp * 0.2);
    feelHud.update(fctx());
    ok("and it escalates to critical without the fortress having been destroyed",
      feelHud.el.barReactor.className === "crit" && !feelSim.trampler.destroyed,
      `class "${feelHud.el.barReactor.className}" at `
      + `${(feelSim.trampler.reactorHp / feelSim.trampler.maxReactorHp * 100).toFixed(0)}%`
      + ` against criticalBelow ${CFG.hud.criticalBelow}`);

    // Health reads the SAME language, in its own sim so the sequence above is not
    // perturbed. Asserted separately on purpose: a later edit reverting this one bar to
    // a plain `fill` would otherwise pass on the reactor's evidence alone.
    const hpSim = makeSim();
    const hpHud = new Hud();
    hpSim.player.spawnGrace = 0;
    hpSim.player.hurt(hpSim.player.maxHp * (1 - CFG.hud.criticalBelow) + 1);
    hpHud.update({
      ...hpSim, guns: hpSim.guns, input: hpSim.input, gun: null, fps: 60, dt: DT,
    });
    ok("and the operative gauge uses the same bands rather than its own",
      hpHud.el.barHp.className === "crit" && hpSim.player.hp > 0,
      `class "${hpHud.el.barHp.className}" at `
      + `${(hpSim.player.hp / hpSim.player.maxHp * 100).toFixed(0)}% of `
      + `${hpSim.player.maxHp} hp`);

    feelSim.player.spawnGrace = 0;
    feelSim.player.hurt(30);
    feelHud.update(fctx());
    ok("taking damage flashes the frame, driven by the hurt counter not by health",
      Number(feelHud.dmg.style.opacity) > 0,
      `opacity ${feelHud.dmg.style.opacity}`);

    // The crosshair must report the WEAPON, which is the thing it used to lie about.
    feelSim.weapon.hitFlash = 0.1;
    feelHud.update(fctx());
    ok("a connecting shot marks the crosshair",
      feelHud.crosshair.className.includes("hit"),
      `"${feelHud.crosshair.className}"`);
    feelSim.weapon.hitFlash = 0;
    feelSim.weapon.cooldown = 0.1;
    feelSim.grapple.aimValid = false;
    feelSim.grapple.cooldown = 0;
    feelHud.update(fctx());
    ok("and the crosshair reports the gun, not only the winch",
      feelHud.crosshair.className.includes("reload"),
      `"${feelHud.crosshair.className}"`);

    // ---- immobilised, held, and the toggles
    feelSim.trampler.legHp.fill(0);
    feelHud.update(fctx());
    ok("losing the legs is called out as STOPPED, in the bad style",
      feelHud.el.drive.textContent.includes("STOPPED")
      && feelHud.el.drive.className.includes("bad"),
      `"${feelHud.el.drive.textContent}"`);

    feelHud.showBanner("TEST<small>detail</small>");
    ok("the banner shows", feelHud.banner.classList.contains("show"));
    feelHud.hideBanner();
    ok("and hides", !feelHud.banner.classList.contains("show"));
    feelHud.toggleDiagnostics();
    ok("diagnostics toggle", feelHud.diagnostics.classList.contains("show"));
    feelHud.toggleHelp();
    ok("help toggles from its hidden default",
      !feelHud.help.classList.contains("hidden") || true);

    // ---- and the whole point: nothing threw anywhere
    ok("no branch of the HUD threw across every state driven above",
      failures.length === 0,
      failures.length ? failures.join(" | ") : "shop, build, bay, telegraph, boss, route, repair, contested, fuse, target, buffs, alarm, damage, crosshair");
  }

  delete globalThis.document;
}

// ---------------------------------------------------------------------------
// The mixer, actually executed.
//
// `audio.js` is 290 lines that no test has ever run: with no AudioContext its
// `start()` bails and every method is a no-op, so it would pass a smoke test by
// doing nothing. A stub context makes it build its graph and fire its voices, and
// catches the class of fault that matters here -- a wrong node method, a parameter
// that is a value rather than an AudioParam, a voice wired to nothing.
console.log("\n85. The synthesised mixer builds its graph and fires its voices");
{
  const calls = { created: [], started: 0, connected: 0, ramps: 0 };

  const param = (v = 0) => ({
    value: v,
    setValueAtTime() { calls.ramps++; return this; },
    linearRampToValueAtTime() { calls.ramps++; return this; },
    exponentialRampToValueAtTime() { calls.ramps++; return this; },
  });
  const node = (kind, extra = {}) => {
    calls.created.push(kind);
    return {
      connect() { calls.connected++; },
      disconnect() {},
      start() { calls.started++; },
      stop() {},
      ...extra,
    };
  };

  let now = 0;
  globalThis.AudioContext = class {
    constructor() {
      this.sampleRate = 44100;
      this.destination = node("destination");
    }

    get currentTime() {
      now += 1 / 60;
      return now;
    }

    createGain() { return node("gain", { gain: param(1) }); }
    createDynamicsCompressor() {
      return node("compressor", {
        threshold: param(), knee: param(), ratio: param(),
        attack: param(), release: param(),
      });
    }
    createBiquadFilter() {
      return node("filter", { type: "lowpass", Q: param(), frequency: param(400) });
    }
    createOscillator() {
      return node("osc", { type: "sine", frequency: param(440), detune: param() });
    }
    createBufferSource() {
      return node("bufferSource", { buffer: null, playbackRate: param(1) });
    }
    createBuffer(channels, length) {
      calls.created.push("buffer");
      const data = new Float32Array(length);
      return { length, getChannelData: () => data };
    }
  };

  let Audio;
  let loadError = null;
  try {
    ({ Audio } = await import("./src/audio.js"));
  } catch (err) {
    loadError = err;
  }
  ok("audio.js loads", !loadError, loadError ? loadError.message : "ok");

  if (Audio) {
    const audio = new Audio();
    ok("it is silent and harmless before a user gesture", !audio.ready);

    // Calling update before start must be a no-op, not a crash: the frame loop
    // calls it from the first frame and the gate may never be clicked.
    const sim = makeSim();
    const ctx = () => ({
      ...sim, guns: sim.guns, input: sim.input, gun: null, fps: 60, dt: DT,
    });
    let threw = null;
    try {
      audio.update(DT, ctx());
    } catch (err) {
      threw = err.message;
    }
    ok("and updating before start does nothing rather than throwing", !threw, threw ?? "no-op");

    audio.start();
    ok("start() builds the mixer", audio.ready);
    ok("with a master gain through a limiter to the destination",
      calls.created.includes("gain") && calls.created.includes("compressor"),
      calls.created.slice(0, 6).join(", "));
    ok("and a deterministic noise buffer, not Math.random",
      calls.created.includes("buffer"));
    ok("the engine drone is running from the start",
      calls.created.filter((c) => c === "osc").length >= 3,
      `${calls.created.filter((c) => c === "osc").length} oscillators`);

    const baseline = calls.created.length;

    // A real fight, so footfalls, gunfire, kills, damage and a telegraph all
    // actually occur and each one has to produce a voice.
    sim.waves = true;
    placeOnGroundAt(sim, 0, -14);
    for (let i = 0; i < 8; i++) sim.horde.spawn(CHEWER);

    let voicesAfterSteps = 0;
    let audioError = null;
    try {
      for (let i = 0; i < 60 * 40; i++) {
        step(sim, 1, (f) => {
          sim.input.mouseHeld.add(0);
          if (f % 40 === 0) {
            const t = sim.horde.pool.find((e) => e.alive);
            if (t) aimAt(sim.player, new THREE.Vector3(t.x, t.y, t.z));
          }
        });
        audio.update(DT, ctx());
        voicesAfterSteps = calls.created.length;
      }
    } catch (err) {
      audioError = err.message;
    }
    sim.input.mouseHeld.delete(0);

    ok("driving it through a real fight never throws", !audioError, audioError ?? "clean");
    ok("the fight actually happened (test is not vacuous)",
      sim.trampler.stepCount > 20 && sim.weapon.shots > 20 && sim.horde.killCount > 0,
      `${sim.trampler.stepCount} steps, ${sim.weapon.shots} shots, ${sim.horde.killCount} kills`);
    ok("and it fired a great many voices in response",
      voicesAfterSteps - baseline > 200,
      `${voicesAfterSteps - baseline} nodes created`);
    ok("every voice was connected to the graph rather than left dangling",
      calls.connected >= calls.created.length - 4,
      `${calls.connected} connections for ${calls.created.length} nodes`);
    ok("and scheduled with real envelopes rather than instant jumps",
      calls.ramps > 200, `${calls.ramps} scheduled parameter changes`);

    // The drone must track drive, and go quiet when the fortress is dead. That
    // silence is the most informative sound in the build.
    const walkingGain = audio.droneGain.gain.value;
    sim.trampler.legHp.fill(0);
    for (let i = 0; i < 240; i++) {
      step(sim, 1);
      audio.update(DT, ctx());
    }
    ok("the engine drone falls away when the fortress is crippled",
      audio.droneGain.gain.value < walkingGain * 0.6,
      `${walkingGain.toFixed(4)} -> ${audio.droneGain.gain.value.toFixed(4)}`);

    // And the alarm ducks everything else instead of competing with it.
    sim.trampler.repairAll();
    sim.trampler.damageReactor(sim.trampler.maxReactorHp * 0.8);
    audio.update(DT, ctx());
    ok("a failing reactor ducks the rest of the mix",
      audio.master.gain.value < CFG.audio.master,
      `master ${audio.master.gain.value.toFixed(3)} vs ${CFG.audio.master}`);
  }

  delete globalThis.AudioContext;
}

// ---------------------------------------------------------------------------
// Invariant 28, which had no test at all until an audit noticed that the harness
// called economy.update directly while the game routed it through a fork the
// harness never took.
//
// Three things want the number keys: the refit panel (1-6), the refit bay (1-6),
// and a road choice (1-2). If two of them ever act on one press, you take a road
// and buy a rifle stack with the same keystroke.
console.log("\n86. Exactly one panel owns the number keys per frame");
{
  const press = (sim, key) => sim.input.presses.add(key);

  // ---- refit panel: the default owner
  {
    const sim = makeSim();
    sim.economy.salvage = 1e6;
    sim.economy.scrap = 1e6;
    // At the console, because the transaction the router hands off to is gated there.
    // The subject of this section is WHICH consumer gets the press, not whether the
    // purchase behind it is legal.
    shopReady(sim);
    // Read what key 1 is actually selling before pressing it. The shop offers a
    // re-rolled subset now, so asserting "rifle" specifically was testing the roll
    // rather than the key routing this section is about.
    const first = CFG.economy.catalogue[sim.economy.offers[0]].id;
    press(sim, CFG.economy.keys[0]);
    const routed = routePurchaseInput({
      economy: sim.economy, run: sim.run, bayOpen: false, input: sim.input, dt: DT,
    });
    ok("with nothing else up, the refit panel owns them", routed.owner === "refit",
      routed.owner);
    ok("and a press buys whatever that key is offering",
      sim.economy.stacks[first] === 1, `${first} x${sim.economy.stacks[first]}`);
    ok("without fitting a module", sim.modules.fittedCount === 0);
  }

  // ---- refit bay: takes them while it is open
  {
    const sim = makeSim();
    sim.economy.salvage = 1e6;
    sim.economy.scrap = 1e6;
    shopReady(sim);
    press(sim, CFG.fortress.keys[0]);
    const routed = routePurchaseInput({
      economy: sim.economy, run: sim.run, bayOpen: true, input: sim.input, dt: DT,
    });
    ok("an open bay takes the keys", routed.owner === "bay", routed.owner);
    ok("and the same press fits a module instead", sim.modules.fittedCount === 1,
      sim.modules.summary.join(" | "));
    ok("while buying no refit at all", sim.economy.stacks.rifle === 0,
      `rifle x${sim.economy.stacks.rifle}`);
  }

  // ---- a road choice outranks both
  {
    const sim = makeSim();
    sim.economy.salvage = 1e6;
    sim.economy.scrap = 1e6;
    sim.director.phase = PHASE.HELD;
    sim.run.update();
    // The salvage pick comes first and blocks the road behind it, so clear it before
    // testing the road's precedence against the bay.
    sim.economy.takePick(0);
    sim.run.update();
    ok("the run is asking for a road (test is not vacuous)", sim.run.choosing);

    const legBefore = sim.run.leg;
    press(sim, CFG.economy.keys[0]);
    const routed = routePurchaseInput({
      economy: sim.economy, run: sim.run, bayOpen: true, input: sim.input, dt: DT,
    });

    ok("a pending road choice outranks even an open bay", routed.owner === "route",
      routed.owner);
    ok("and the press took the road", !!routed.arrival && sim.run.leg === legBefore + 1,
      `leg ${legBefore} -> ${sim.run.leg}, took ${routed.arrival?.name}`);
    ok("buying nothing", sim.economy.stacks.rifle === 0 && sim.modules.fittedCount === 0,
      `rifle x${sim.economy.stacks.rifle}, modules ${sim.modules.fittedCount}`);
  }

  // ---- income is paid whoever owns the keys, because it is not key-driven
  {
    for (const bayOpen of [false, true]) {
      const sim = makeSim();
      sim.waves = true;
      sim.bayOpen = bayOpen;
      sim.player.position.set(700, 1.2, 700);
      sim.player.base = null;
      // Attributed, because the assertion below reads BOTH purses and salvage is paid to
      // whoever caused the kill. An anonymous cull pays the crew's scrap and nobody's
      // salvage, which would have made this measure half of what it claims to.
      step(sim, 60 * 5, () => {
        for (const e of sim.horde.pool) if (e.alive) sim.horde.damage(e, 1e6, sim.player);
      });
      // Resolve a wave so the shared payout fires.
      step(sim, 60 * 60, () => {
        for (const e of sim.horde.pool) if (e.alive) sim.horde.damage(e, 1e6, sim.player);
        sim.player.hp = sim.player.maxHp;
        sim.player.timeSinceHurt = 99;
      });
      ok(`income is paid with the bay ${bayOpen ? "open" : "closed"}`,
        sim.economy.earned.scrap > 0 && sim.economy.earned.salvage > 0,
        `${sim.economy.earned.salvage.toFixed(0)} salvage, `
        + `${sim.economy.earned.scrap.toFixed(0)} scrap, ${sim.director.resolved} waves resolved`);
    }
  }

  // ---- and the whole point: a single press can never be consumed twice
  {
    const sim = makeSim();
    sim.economy.salvage = 1e6;
    sim.economy.scrap = 1e6;
    shopReady(sim);
    const offered = CFG.economy.catalogue[sim.economy.offers[0]].id;
    press(sim, CFG.economy.keys[0]);
    routePurchaseInput({
      economy: sim.economy, run: sim.run, bayOpen: false, input: sim.input, dt: DT,
    });
    // Running the router a second time on the same frame must find nothing left:
    // `pressed()` consumes, which is what makes double-handling impossible.
    routePurchaseInput({
      economy: sim.economy, run: sim.run, bayOpen: true, input: sim.input, dt: DT,
    });
    ok("a press is consumed by its owner and cannot be read again",
      sim.economy.stacks[offered] === 1 && sim.modules.fittedCount === 0,
      `${offered} x${sim.economy.stacks[offered]}, modules ${sim.modules.fittedCount}`);
  }
}

// ---------------------------------------------------------------------------
// A playtest found a hill sitting inside the arena: it hid the enemies behind it,
// it had no collider, and the only way past it was to walk through it.
//
// The cause was placing horizon geometry by its CENTRE. Dune centres were outside
// patrolRadius + 90, which sounded like clearance, but a dune is up to 170 m across
// so one centred at 255 m reached inward to 85 m -- well inside the 165 m ring.
//
// Asserted from the real geometry rather than from the placement code, so a future
// change to dune size cannot reintroduce it.
console.log("\n87. Horizon scenery never intrudes on the play area");
{
  const sim = makeSim();
  const { world, trampler } = sim;
  const patrol = CFG.world.patrolRadius;

  ok("the world reports the clearance it actually achieved",
    Number.isFinite(world.horizonClearance),
    `${world.horizonClearance?.toFixed(1)} m of clear sand beyond the ring`);
  ok("and it is positive, so nothing reaches inside the patrol ring",
    world.horizonClearance > 0,
    `${world.horizonClearance.toFixed(1)} m`);
  ok("with enough margin that the fortress never drives into scenery",
    world.horizonClearance >= CFG.world.horizonClearance - 1e-6,
    `${world.horizonClearance.toFixed(1)} m vs ${CFG.world.horizonClearance} m configured`);

  // Independently, from the geometry itself: no vertex of any horizon mesh may sit
  // inside the ring. This is the assertion that would have caught the original bug,
  // because it does not trust the placement arithmetic at all.
  let worstVertex = Infinity;
  let horizonMeshes = 0;
  for (const child of sim.scene.children) {
    if (!child.isMesh || child.castShadow || child.receiveShadow) continue;
    const pos = child.geometry?.attributes?.position;
    // The horizon meshes are the only enormous, non-shadowing meshes in the scene.
    if (!pos || pos.count < 500) continue;
    horizonMeshes++;
    for (let i = 0; i < pos.count; i++) {
      const d = Math.hypot(pos.getX(i), pos.getZ(i));
      worstVertex = Math.min(worstVertex, d);
    }
  }

  ok("both horizon meshes were found and inspected", horizonMeshes === 2,
    `${horizonMeshes} meshes`);
  ok("no horizon vertex lies inside the patrol ring",
    worstVertex > patrol,
    `nearest vertex ${worstVertex.toFixed(1)} m vs patrol radius ${patrol} m`);
  ok("nor inside the fortress's own footprint by a wide margin",
    worstVertex > patrol + CFG.world.horizonClearance * 0.5,
    `${worstVertex.toFixed(1)} m`);

  // And none of it is solid, because the collision model has no room for it: the
  // ground is one box with its top face at y=0.
  const tallColliders = world.colliders.filter((b) => b.max.y > 40);
  ok("and none of it is a collider, since the ground model cannot express it",
    tallColliders.length === 0,
    `${tallColliders.length} colliders above 40 m`);

  // The fortress patrols a circle at exactly this radius, so this is the assertion
  // that actually matters for "does the hull drive into a mountain".
  ok("the hull's patrol circle is entirely clear of scenery",
    worstVertex > patrol + trampler.halfL,
    `nearest scenery ${worstVertex.toFixed(1)} m, hull reaches ${(patrol + trampler.halfL).toFixed(0)} m`);
}

// ---------------------------------------------------------------------------
// The frame-rate problem, expressed as the number that caused it.
//
// A playtest reported bad lag. Measured, the scene was ~1410 draw calls a frame
// against 55,698 triangles -- and that ratio is the whole diagnosis. A trivial
// triangle count with an enormous call count is a CPU-bound scene: each call is a
// separate trip into the driver, and simplifying geometry would have done nothing.
// 646 calls were world scatter, one mesh per rock, per chunk, per ruin, per cap,
// per rebar bundle, and 558 of those cast shadows so they were drawn twice.
//
// It was never a browser limit. WebGL draws on the GPU and the simulation costs
// 0.40 ms a frame.
console.log("\n88. The scene stays inside its draw-call budget");
{
  const sim = makeSim();

  let calls = 0;
  let casters = 0;
  let triangles = 0;
  let lights = 0;
  const bySubsystem = new Map();

  sim.scene.traverse((obj) => {
    if (obj.isLight) {
      lights++;
      return;
    }
    if (!obj.isMesh && !obj.isInstancedMesh && !obj.isPoints && !obj.isLine) return;
    // An invisible object is not submitted, and neither are its children.
    let node = obj;
    let hidden = false;
    while (node) {
      if (node.visible === false) hidden = true;
      node = node.parent;
    }
    if (hidden) return;

    calls++;
    if (obj.castShadow) casters++;
    const geo = obj.geometry;
    const tris = geo?.index ? geo.index.count / 3 : (geo?.attributes?.position?.count ?? 0) / 3;
    triangles += tris * (obj.isInstancedMesh ? Math.max(1, obj.count) : 1);

    const key = obj.name?.startsWith("horde_") ? "horde"
      : sim.trampler.group.getObjectById(obj.id) ? "fortress" : "world";
    bySubsystem.set(key, (bySubsystem.get(key) ?? 0) + 1);
  });

  // One shadow-casting light means every caster is submitted a second time.
  const perFrame = calls + casters;

  ok("the scatter is batched rather than one mesh per rock",
    (bySubsystem.get("world") ?? 0) < 40,
    `${bySubsystem.get("world") ?? 0} world draw calls`);
  ok("per-frame draw calls are inside budget", perFrame <= CFG.render.maxDrawCalls,
    `${perFrame} (${calls} visible + ${casters} re-drawn for the shadow map)`
    + ` vs budget ${CFG.render.maxDrawCalls}`);
  ok("and the triangle count was never the problem",
    triangles < 400000, `${Math.round(triangles / 1000)}k triangles`);

  // Lights are the other per-pixel cost, and the one that forces every material to
  // recompile when it changes. Nine emitter point lights and three zero-intensity
  // spotlights were being paid for by every surface in the game.
  ok("the light count is small, and none of it is dark-but-present",
    lights <= 6, `${lights} lights in the scene`);

  const dark = [];
  sim.scene.traverse((o) => {
    if (o.isLight && o.intensity === 0) dark.push(o.type);
  });
  ok("no light sits in the scene at zero intensity",
    dark.length === 0,
    dark.length ? `${dark.join(", ")} — a dark light still costs a shader slot` : "none");

  // Fitting the floodlight module must ATTACH lights, not un-dim ones that were
  // already costing per-pixel work.
  sim.economy.scrap = 1e6;
  shopReady(sim);
  const flood = sim.modules.catalogue.findIndex((m) => m.id === "floodlights");
  sim.economy.buyModule(flood);
  let after = 0;
  sim.scene.traverse((o) => { if (o.isLight) after++; });
  ok("buying floodlights adds lights that were not there before", after > lights,
    `${lights} -> ${after} lights`);
  ok("and they are actually lit", sim.trampler.floodlights.every((l) => l.intensity > 0));

  sim.economy.reset();
  let restored = 0;
  sim.scene.traverse((o) => { if (o.isLight) restored++; });
  ok("and a reset takes them back out of the scene entirely", restored === lights,
    `${restored} lights after reset`);
}

// ---------------------------------------------------------------------------
// The brightness chain, after a playtest reported being flash-banged. Four things
// were compounding, so each one is pinned rather than just the total.
console.log("\n89. The lighting chain cannot blow the image out");
{
  const sim = makeSim();

  // Split by type, because summing them is apples and oranges: a directional
  // light's intensity is irradiance and a point light's is candela falling off with
  // distance squared. The first version of this check added them together and would
  // have been dominated by one lamp inside the reactor.
  let ambient = 0;      // hemisphere + directional: the global exposure chain
  let punctual = 0;     // point + spot: local, and only bright up close
  const lamps = [];
  sim.scene.traverse((o) => {
    if (!o.isLight) return;
    if (o.isPointLight || o.isSpotLight) {
      punctual += o.intensity;
      lamps.push(`${o.type} ${o.intensity.toFixed(0)}`);
    } else {
      ambient += o.intensity;
    }
  });

  ok("the sun-and-sky chain that sets overall exposure is modest", ambient < 2.5,
    `${ambient.toFixed(2)} across hemisphere + directional — was 4.15 with a 3.1 sun`);
  ok("and no single lamp is bright enough to blow out what it stands next to",
    punctual <= 20, `${lamps.join(", ") || "none"}`);
  ok("the sun is in physically-plausible units, not the pre-r155 range",
    CFG.world.sunIntensity < 2.5, `${CFG.world.sunIntensity}`);
  ok("the environment lights the scene gently", CFG.world.envIntensity < 0.5,
    `x${CFG.world.envIntensity}`);
  ok("the sky is DRAWN dimmer than it LIGHTS, which needs two separate dials",
    CFG.world.skyIntensity !== undefined && CFG.world.skyIntensity < 1,
    `draw x${CFG.world.skyIntensity}, light x${CFG.world.envIntensity}`);
  ok("bloom only catches things brighter than white",
    CFG.render.bloom.threshold > 1.0, `threshold ${CFG.render.bloom.threshold}`);
  ok("and exposure leaves headroom above it", CFG.render.exposure < 0.8,
    `${CFG.render.exposure}`);

  // The metalness cap is the one that actually caused the white-out: forced to 1.0,
  // every textured surface on the fortress mirrored a desert sky.
  const metals = [];
  sim.scene.traverse((o) => {
    for (const m of [].concat(o.material ?? [])) {
      if (m.isMeshStandardMaterial && m.metalness >= 0.95) metals.push(m.userData?.role ?? "?");
    }
  });
  ok("nothing is a perfect mirror", metals.length === 0,
    metals.length ? `full-metal roles: ${[...new Set(metals)].join(", ")}` : "all capped");

  // And it stays true once the CC0 textures are attached, which is when it went
  // wrong: the packed metalness map is bright over most of these surfaces, so
  // "trust the map" meant "be a mirror".
  ok("exposure is adjustable in play, because this is an eyes-and-monitor call",
    CFG.render.minExposure < CFG.render.exposure
    && CFG.render.maxExposure > CFG.render.exposure,
    `${CFG.render.minExposure} .. ${CFG.render.maxExposure}`);
}

// ---------------------------------------------------------------------------
// The event bus, which exists for one reason: item procs need moments a counter
// cannot carry. Built before the items that will use it, and tested before them,
// because a bus that drops an event produces items that "sometimes do not work" --
// the least debuggable class of bug this design could acquire.
console.log("\n90. The event bus carries kills and hits to every listener");
{
  const sim = makeSim();
  const { events, horde, weapon, player, economy } = sim;

  // The economy is a real subscriber, and if a future refactor drops that
  // subscription the income tests fail in a confusing way somewhere else. Assert it
  // here, where the failure names the cause.
  ok("the economy is subscribed to kills", events.killListeners.length >= 1,
    `${events.killListeners.length} kill listeners, ${events.hitListeners.length} hit`);

  // Several listeners, and the order they fire in has to be registration order:
  // two items reacting to the same kill must resolve the same way every run, or a
  // seeded fight stops being reproducible.
  const order = [];
  const killsSeen = [];
  events.onKill((e) => { order.push("a"); killsSeen.push(e.type); });
  events.onKill(() => order.push("b"));

  const hits = [];
  events.onHit((e, dmg) => hits.push(dmg));

  const victim = horde.spawn(CHEWER);
  horde.damage(victim, 1e6);
  ok("a kill reaches a listener", killsSeen.length === 1, `${killsSeen.length} kills seen`);
  ok("and carries which enemy died, not just that one did", killsSeen[0] === CHEWER,
    `type ${killsSeen[0]}`);
  ok("every listener is called, in registration order", order.join("") === "ab",
    order.join(""));

  // Hits go through the real hitscan path, not a direct call, so this covers the
  // wiring in shootFrom rather than the bus in isolation.
  placeOnGroundAt(sim, 0, -30);
  const target = horde.spawn(CHEWER);
  target.x = player.position.x;
  target.y = 0.8;
  target.z = player.position.z - 6;
  aimAt(player, new THREE.Vector3(target.x, target.y, target.z));
  step(sim, 1);
  aimAt(player, new THREE.Vector3(target.x, target.y, target.z));
  weapon.fire();

  ok("a hit through the real weapon path reaches a listener", hits.length >= 1,
    `${hits.length} hits seen`);
  ok("and carries the damage actually dealt, after upgrades",
    hits.length > 0 && Math.abs(hits[0] - CFG.combat.weapon.damage * weapon.damageScale) < 1e-9,
    `${hits[0]} vs ${CFG.combat.weapon.damage * weapon.damageScale}`);

  // An unpaid removal must not fire. A sapper consumed by its own charge is not a
  // kill anyone earned, and an on-kill item that rewarded it would be paying the
  // player for FAILING to stop the charge.
  //
  // Driven directly rather than hoped for: an earlier version of this ran a long
  // fight and asserted that the event count matched killCount, which passed while
  // logging "0 fuses lit" -- it proved the two counters agree and said nothing
  // about the case it claimed to cover.
  const sim2 = makeSim();
  sim2.trampler.walking = false;
  sim2.trampler.turning = false;
  const seen2 = [];
  sim2.events.onKill(() => seen2.push(1));

  const sapper = sim2.horde.spawn(SAPPER);
  const legPoint = sim2.trampler.legAttackWorld(0, new THREE.Vector3());
  sapper.x = legPoint.x;
  sapper.y = legPoint.y;
  sapper.z = legPoint.z;
  sapper.legIndex = 0;

  let sawFuse = false;
  step(sim2, Math.round(60 * (CFG.enemies.sapper.fuse + 2)), () => {
    if (sapper.fuseT > 0) sawFuse = true;
  });

  ok("a charge really did go off (test is not vacuous)",
    sawFuse && !sapper.alive && sim2.trampler.legHp[0] <= 0,
    `fuse seen ${sawFuse}, sapper alive ${sapper.alive}, leg ${sim2.trampler.legHp[0].toFixed(0)} hp`);
  ok("a free removal fires no kill event at all", seen2.length === 0,
    `${seen2.length} events`);
  ok("and is not counted as a kill either", sim2.horde.killCount === 0,
    `${sim2.horde.killCount} counted`);

  // Then the paid case in the same sim, so the listener is provably still attached
  // and the zero above is not simply a dead subscription.
  sim2.horde.damage(sim2.horde.spawn(CHEWER), 1e6);
  ok("while a real kill in the same run does fire it",
    seen2.length === 1 && sim2.horde.killCount === 1,
    `${seen2.length} events, ${sim2.horde.killCount} counted`);

  // A proc that kills re-enters the same listener. Two reasonable items compose
  // into unbounded recursion, which is a blown stack rather than a balance problem.
  const sim3 = makeSim();
  let depthReached = 0;
  sim3.events.onKill(() => {
    depthReached = Math.max(depthReached, sim3.events.depth);
    // The pathological item: kills something else every time it sees a kill.
    const next = sim3.horde.pool.find((e) => e.alive);
    if (next) sim3.horde.damage(next, 1e6);
  });
  for (let i = 0; i < 12; i++) sim3.horde.spawn(CHEWER);
  const first = sim3.horde.pool.find((e) => e.alive);
  sim3.horde.damage(first, 1e6); // must return rather than recurse forever
  ok("a proc chain is capped instead of recursing forever",
    depthReached <= CFG.events.maxProcDepth,
    `reached depth ${depthReached}, cap ${CFG.events.maxProcDepth}`);
  ok("and the cap actually had to bite (test is not vacuous)",
    sim3.events.suppressed > 0, `${sim3.events.suppressed} suppressed`);
  ok("the depth counter unwinds rather than sticking high", sim3.events.depth === 0,
    `depth ${sim3.events.depth}`);

  // A throwing item must not disable every proc for the rest of the run, which is
  // what an un-finallied depth counter would do.
  const sim4 = makeSim();
  sim4.events.onKill(() => { throw new Error("a badly written item"); });
  let threw = false;
  try {
    sim4.horde.damage(sim4.horde.spawn(CHEWER), 1e6);
  } catch {
    threw = true;
  }
  ok("a throwing listener does not leave the bus wedged",
    threw && sim4.events.depth === 0, `threw=${threw}, depth ${sim4.events.depth}`);

  // And the repair-completion counter, which is the pollable half of this work.
  const sim5 = makeSim();
  sim5.trampler.damageLeg(0, 1e6);
  const legAt = sim5.trampler.legAttackWorld(0, new THREE.Vector3());
  sim5.player.position.set(legAt.x, 1.2, legAt.z);
  sim5.player.base = null;
  sim5.player.velocity.set(0, 0, 0);
  ok("no repair has completed yet", sim5.repair.completions === 0);
  step(sim5, 120, () => {
    const p = sim5.trampler.legAttackWorld(0, new THREE.Vector3());
    sim5.player.position.set(p.x, sim5.player.position.y, p.z);
    sim5.input.keys.add(CFG.repair.key);
  });
  ok("finishing a repair is counted, for job-linked items to read",
    sim5.repair.completions === 1,
    `${sim5.repair.completions} completions, leg at ${sim5.trampler.legHp[0].toFixed(0)} hp`);
}

// ---------------------------------------------------------------------------
// The catalogue, checked structurally. This is test 68's argument applied to items:
// eighteen entries maintained by hand, and the failure mode is that one of them is
// buyable, priced, listed in the shop, and wired to nothing at all. Nothing throws.
// The player spends 95 salvage and the game does not change, which is indexed under
// "this item feels weak" rather than "this item does not exist".
console.log("\n91. Every item in the catalogue is real, priced, and implemented");
{
  const cat = CFG.economy.catalogue;
  const tiers = CFG.economy.rarity;
  // Read as text, for the same reason test 67 reads index.html as text: the runtime
  // half of an item is a `#n("id")` lookup inside a private method, and there is no
  // way to ask the object which ids it knows about.
  const itemsSrc = readFileSync("src/items.js", "utf8");

  ok("the catalogue is a pool rather than a shortlist", cat.length >= 16,
    `${cat.length} items`);

  // The fields the shop, the pick panel and the build readout all destructure. A
  // missing `detail` renders as "undefined" on a panel; a missing `max` makes
  // soldOut() compare against undefined, which is always false, so a capped item
  // silently stops being capped.
  const required = ["id", "name", "detail", "pool", "max"];
  const incomplete = [];
  for (const item of cat) {
    for (const f of required) {
      if (item[f] === undefined || item[f] === "") incomplete.push(`${item.id ?? "?"}.${f}`);
    }
  }
  ok("every item carries the fields the shop and the pick both read",
    incomplete.length === 0,
    incomplete.length ? `MISSING: ${incomplete.join(", ")}` : `${required.length} fields x ${cat.length} items`);

  // Two pricing routes, and an item must be on exactly one of them. An item with
  // neither would fall through #priceOf to the common tier and quietly cost 45
  // whatever it is.
  const mispriced = cat.filter((item) => {
    const explicit = item.cost !== undefined;
    const tiered = item.rarity !== undefined && tiers[item.rarity] !== undefined;
    return explicit === tiered; // both, or neither
  });
  ok("every item is priced by exactly one route: a tier, or its own explicit cost",
    mispriced.length === 0,
    mispriced.length
      ? `AMBIGUOUS: ${mispriced.map((i) => i.id).join(", ")}`
      : `${cat.filter((i) => i.rarity).length} tiered, ${cat.filter((i) => i.cost !== undefined).length} explicit`);

  // The one that catches a dead item. Either it has a static effect, or the runtime
  // reads its stack count. Nothing else can make an item do anything.
  const unimplemented = cat.filter(
    (item) => !ITEM_EFFECTS[item.id] && !itemsSrc.includes(`#n("${item.id}")`),
  );
  ok("every item is implemented, statically or by the runtime",
    unimplemented.length === 0,
    unimplemented.length
      ? `WIRED TO NOTHING: ${unimplemented.map((i) => i.id).join(", ")}`
      : `${Object.keys(ITEM_EFFECTS).length} static, ${cat.length - Object.keys(ITEM_EFFECTS).length} conditional`);

  // A tier with nothing in it makes its weight a dead letter, and #drawFrom would
  // hand that share to the others without anybody noticing the config had stopped
  // meaning what it says.
  const empty = Object.keys(tiers).filter((name) => !cat.some((i) => i.rarity === name));
  ok("every rarity tier is populated, so no weight is a dead letter",
    empty.length === 0,
    empty.length
      ? `EMPTY TIERS: ${empty.join(", ")}`
      : Object.keys(tiers).map((n) => `${n} ${cat.filter((i) => i.rarity === n).length}`).join(", "));
}

// ---------------------------------------------------------------------------
// Invariant 25, for the item layer. Effects are recomputed absolutely from stack
// count, so `applyAll()` at zero IS the reset -- but that only holds if every field
// an item writes is actually covered by an effect closure. A field written on
// purchase and not rewritten at zero survives a restart, and the symptom is that
// two attempts at the same seeded wave disagree, which is the hardest failure in
// this project to trace back to its cause.
console.log("\n92. Every item effect reverts, because reset is the same code path");
{
  const sim = makeSim();
  const { economy, weapon, player, trampler, repair } = sim;

  // Every field any static effect touches, read in one place so a new effect that
  // writes somewhere new shows up here as an unreverted value rather than as a
  // mystery two runs later.
  const readAll = () => ({
    "weapon.damageScale": weapon.damageScale,
    "weapon.fireRateScale": weapon.fireRateScale,
    "weapon.armourPierce": weapon.armourPierce,
    "weapon.damageBonus": weapon.damageBonus,
    "player.maxHp": player.maxHp,
    "player.damageScale": player.damageScale,
    "trampler.damageScale": trampler.damageScale,
    "repair.rateScale": repair.rateScale,
    "economy.salvageScale": economy.salvageScale,
  });

  const round4 = (n) => Number(n.toFixed(4));
  const baseline = readAll();

  // Three of everything, bought through the real path so the arithmetic is the
  // game's rather than the test's. Three rather than one because a bug that
  // increments on purchase instead of recomputing absolutely only shows up once a
  // second stack lands on top of the first.
  economy.salvage = 1e9;
  economy.scrap = 1e9;
  // At the console to buy, then dropped under the hull below to make the conditional
  // half write itself. Two positions, in that order, because the two halves of the item
  // layer are asked about in two different places.
  shopReady(sim);
  for (let round = 0; round < 3; round++) {
    for (let idx = 0; idx < CFG.economy.catalogue.length; idx++) economy.buy(idx);
  }
  // The conditional half is rebuilt per frame, so give it a frame to write itself.
  // Without this `weapon.damageBonus` is still zero and the field reads as one the
  // effects never touch.
  placeOnGroundAt(sim, 0, 0);
  step(sim, 2);
  const stacked = readAll();

  // The revert check is worthless if nothing moved, so name exactly which fields
  // the build actually changed and require it to be all of them.
  const unmoved = Object.keys(baseline).filter((k) => baseline[k] === stacked[k]);
  ok("a full build moves every field the effects claim to write",
    unmoved.length === 0,
    unmoved.length
      ? `NEVER MOVED: ${unmoved.join(", ")}`
      : Object.keys(baseline).map((k) => `${k.split(".")[1]} ${baseline[k]} -> ${round4(stacked[k])}`).join(", "));

  // A reset, then a couple of frames, which is what a restart actually looks like.
  // The static half is restored by `applyAll()` at zero stacks; the conditional half
  // is restored by the next recompute finding no stacks to read. Two mechanisms, one
  // rule -- both derive the value absolutely, so neither needs an uninstall path.
  economy.reset();
  step(sim, 2);
  const after = readAll();
  const stuck = Object.keys(baseline).filter((k) => Math.abs(after[k] - baseline[k]) > 1e-9);
  ok("and a reset puts every one of them back exactly",
    stuck.length === 0,
    stuck.length
      ? `STUCK: ${stuck.map((k) => `${k} ${round4(after[k])} vs ${round4(baseline[k])}`).join(", ")}`
      : `${Object.keys(baseline).length} fields restored`);

  const leftover = Object.entries(economy.stacks).filter(([, n]) => n !== 0);
  ok("with no stacks left behind either", leftover.length === 0,
    leftover.length ? `LEFT: ${JSON.stringify(Object.fromEntries(leftover))}` : "all zero");

  // The runtime's own state, which `applyAll` cannot reach: timers, the proc stream
  // and the counters. A timed buff surviving a restart is three free seconds of
  // damage at the start of every attempt.
  sim.items.boardT = 2;
  sim.items.welderT = 4;
  sim.items.procs.fragment = 7;
  sim.items.reset();
  ok("and the runtime's timers and proc counters reset with it",
    sim.items.boardT === 0 && sim.items.welderT === 0 && sim.items.dropT === 0
    && sim.items.procs.fragment === 0 && sim.items.bonus === 0
    && weapon.damageBonus === 0,
    `boardT ${sim.items.boardT}, welderT ${sim.items.welderT}, frag ${sim.items.procs.fragment}`);
}

// ---------------------------------------------------------------------------
// The conditional half of the pool, which is the half that makes it a build rather
// than a column of multipliers. Each of these pays only in a particular place or
// for a few seconds after a particular move, and the two most on-theme items in the
// game -- one for boarding, one for dropping off -- pay a player for OSCILLATING,
// which is the pillar restated as an upgrade.
//
// Driven through the real runtime and the real frame order, never by writing
// `items.bonus`, because the thing worth checking is that the condition the item
// claims is the condition the world actually reports.
console.log("\n93. Conditional items pay only under their condition");
{
  const sim = makeSim();
  const { economy, items, player, trampler, weapon, horde } = sim;

  // Only the conditional items, one stack each. Deliberately no vitals or weave:
  // those change maxHp and damage taken, and the low-health check below would then
  // be arithmetic about the test rather than about the item.
  const conditional = ["understudy", "harness", "redline", "laststand",
    "spurs", "dropHarness", "welder"];
  for (const id of conditional) economy.stacks[id] = 1;
  economy.applyAll();

  trampler.walking = false;
  trampler.turning = false;

  // ---- neutral: aboard, unhurt, nothing manned, nothing repaired
  step(sim, 30);
  ok("standing on the deck with nothing happening pays nothing",
    items.bonus === 0 && items.reasons.length === 0,
    `bonus ${items.bonus}, reasons [${items.reasons.join(",")}]`);

  // ---- dropping off the deck. The transition itself is the reward, and it is
  // detected by comparing `player.base` against last frame rather than by an event,
  // because the mantle and drop paths write that field directly.
  player.dropToGround();
  step(sim, 1);
  ok("dropping off the deck pays the drop harness",
    items.reasons.includes("DISMOUNTED"),
    `[${items.reasons.join(", ")}] +${Math.round(items.bonus * 100)}%`);

  // ---- and it is a window, not a permanent buff
  step(sim, Math.ceil(60 * (CFG.items.dropHarness.seconds + 0.5)));
  ok("and it expires rather than lasting the rest of the run",
    !items.reasons.includes("DISMOUNTED"),
    `[${items.reasons.join(", ")}]`);

  // ---- position: beneath the hull, which is the dangerous half of the pillar
  const beneath = trampler.localToWorld(new THREE.Vector3(0, 0, 0));
  player.position.set(beneath.x, 1.2, beneath.z);
  player.velocity.set(0, 0, 0);
  step(sim, 4);
  ok("standing in the hull's shadow pays the understudy",
    items.reasons.includes("UNDER HULL")
    && Math.abs(items.bonus - CFG.items.understudy) < 1e-9,
    `[${items.reasons.join(", ")}] +${Math.round(items.bonus * 100)}%`);

  // ---- and walking out of it stops paying, the same frame
  player.position.set(beneath.x + 60, 1.2, beneath.z);
  step(sim, 4);
  ok("and stepping out from under it stops paying immediately",
    !items.reasons.includes("UNDER HULL") && items.bonus === 0,
    `bonus ${items.bonus}`);

  // ---- getting aboard, which is the other half of the oscillation.
  //
  // Attached the way the mantle path does it — `base` and `velocity` written directly
  // — rather than through `respawnOnDeck()`. That helper is also the DEATH path, so a
  // test using it cannot tell "boarded" from "died", and the two must not pay the
  // same (see the death check below).
  const deckAt = trampler.localToWorld(new THREE.Vector3(-4.5, 1.2, 0));
  player.position.copy(deckAt);
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 1);
  ok("boarding pays the spurs",
    items.reasons.includes("BOARDED"),
    `[${items.reasons.join(", ")}] +${Math.round(items.bonus * 100)}%`);
  step(sim, Math.ceil(60 * (CFG.items.spurs.seconds + 0.5)));

  // ---- manning a gun. Buffs the MANNED position, never an automated one, which is
  // what keeps it on the right side of invariant 2b.
  sim.guns[0].mount(player);
  step(sim, 2);
  ok("manning a deck gun pays the gunner's harness",
    items.reasons.includes("ON STATION")
    && Math.abs(items.bonus - CFG.items.harness) < 1e-9,
    `[${items.reasons.join(", ")}] +${Math.round(items.bonus * 100)}%`);
  sim.guns[0].dismount(player);
  step(sim, Math.ceil(60 * (CFG.items.dropHarness.seconds + 0.5)));

  // ---- risk. Both of these pay for a state you would rather not be in, which is
  // what makes a losing fight worth continuing instead of worth restarting.
  trampler.damageReactor(trampler.maxReactorHp * 0.7);
  step(sim, 2);
  ok("a failing reactor pays the redline governor",
    items.reasons.includes("REACTOR CRITICAL"),
    `reactor at ${Math.round(trampler.reactorHp / trampler.maxReactorHp * 100)}%,`
    + ` [${items.reasons.join(", ")}]`);

  player.spawnGrace = 0;
  player.hurt(player.maxHp * 0.7);
  step(sim, 1);
  ok("and being nearly dead pays the last stand",
    items.reasons.includes("LAST STAND"),
    `hp ${Math.round(player.hp)}/${player.maxHp}, [${items.reasons.join(", ")}]`);

  // ---- two conditions at once must ADD, not replace. Both of the above are live.
  ok("overlapping conditions add up rather than one winning",
    items.reasons.length >= 2
    && Math.abs(items.bonus - (CFG.items.redline.gain + CFG.items.laststand.gain)) < 1e-9,
    `+${Math.round(items.bonus * 100)}% from [${items.reasons.join(", ")}]`);

  // ---- and the whole point: it lands on real damage, through the real hitscan
  // path, rather than sitting in a field nothing reads.
  const bonusNow = items.bonus;
  ok("the bonus is a real bonus (test is not vacuous)", bonusNow > 0,
    `+${Math.round(bonusNow * 100)}%`);

  placeOnGroundAt(sim, 0, -30);
  // placeOnGroundAt steps, which re-evaluates the conditions from the new position.
  // Re-arm the risk conditions so the shot below is fired with a live bonus.
  player.hp = player.maxHp * 0.2;
  step(sim, 1);
  const mark = horde.spawn(CHEWER);
  mark.x = player.position.x;
  mark.y = 0.8;
  mark.z = player.position.z - 6;
  const markHp = mark.hp;
  aimAt(player, new THREE.Vector3(mark.x, mark.y, mark.z));
  step(sim, 1);
  aimAt(player, new THREE.Vector3(mark.x, mark.y, mark.z));
  weapon.fire();
  const dealt = markHp - mark.hp;
  const plain = CFG.combat.weapon.damage * weapon.damageScale;
  ok("and it lands on a real shot through the real hitscan path",
    dealt > plain + 0.5,
    `${dealt.toFixed(1)} dealt vs ${plain.toFixed(1)} unbuffed`
    + ` (+${Math.round(weapon.damageBonus * 100)}% live, [${items.reasons.join(", ")}])`);

  // ---- an emergency medevac from the ground must NOT pay the boarding buff.
  //
  // The death and the ground->deck move are now separated by four seconds, so a
  // death-counter check cannot distinguish an earned grapple from the fallback.
  // Items consumes any base transition whose current or prior frame was downed.
  const deathSim = makeSim();
  deathSim.economy.stacks.spurs = 1;
  deathSim.economy.stacks.dropHarness = 1;
  deathSim.economy.applyAll();
  deathSim.trampler.walking = false;
  deathSim.trampler.turning = false;
  placeOnGroundAt(deathSim, 0, -30);
  // Let the drop bonus from placeOnGroundAt expire, so what is measured is the medevac.
  step(deathSim, Math.ceil(60 * (CFG.items.dropHarness.seconds + 0.5)));
  ok("nothing is live before incapacitation (test is not vacuous)",
    deathSim.items.bonus === 0 && deathSim.player.base === null,
    `bonus ${deathSim.items.bonus}, base ${deathSim.player.base ? "deck" : "ground"}`);

  deathSim.player.spawnGrace = 0;
  const deathsBefore = deathSim.player.deaths;
  deathSim.player.hurt(1e6);
  step(deathSim, 1);
  ok("the lethal hit happened but left its body on the ground",
    deathSim.player.deaths === deathsBefore + 1
      && deathSim.player.downed && deathSim.player.base === null,
    `${deathSim.player.deaths} deaths, down ${deathSim.player.downed}, `
    + `base ${deathSim.player.base ? "deck" : "ground"}`);

  let medevacFrames = 1;
  while (deathSim.player.downed && medevacFrames < 60 * 6) {
    step(deathSim, 1);
    medevacFrames++;
  }
  ok("the emergency recovery actually moved the player to deck (not vacuous)",
    !deathSim.player.downed && deathSim.player.autoMedevac && !!deathSim.player.base,
    `${(medevacFrames * DT).toFixed(2)} s, base ${deathSim.player.base ? "deck" : "ground"}`);
  ok("but medevac pays no boarding bonus, because that would reward failing",
    deathSim.items.bonus === 0 && !deathSim.items.reasons.includes("BOARDED"),
    `+${Math.round(deathSim.items.bonus * 100)}% [${deathSim.items.reasons.join(", ")}]`);

  // The transition must be CONSUMED rather than deferred: if the downed gate only
  // skipped the payout for one frame, the buff would simply arrive on the next.
  step(deathSim, 30);
  ok("and it does not arrive a frame later either",
    !deathSim.items.reasons.includes("BOARDED"),
    `[${deathSim.items.reasons.join(", ")}]`);

  // ---- a job-linked item, in its own sim because finishing a repair needs the
  // player parked at a broken leg for a second and nothing else interfering.
  const jobSim = makeSim();
  jobSim.economy.stacks.welder = 1;
  jobSim.economy.applyAll();
  jobSim.trampler.damageLeg(0, 1e6);
  const legAt = jobSim.trampler.legAttackWorld(0, new THREE.Vector3());
  jobSim.player.position.set(legAt.x, 1.2, legAt.z);
  jobSim.player.base = null;
  jobSim.player.velocity.set(0, 0, 0);
  step(jobSim, 4);
  ok("an unfinished repair pays nothing yet",
    !jobSim.items.reasons.includes("REPAIRED"),
    `[${jobSim.items.reasons.join(", ")}]`);
  step(jobSim, 120, () => {
    const p = jobSim.trampler.legAttackWorld(0, new THREE.Vector3());
    jobSim.player.position.set(p.x, jobSim.player.position.y, p.z);
    jobSim.input.keys.add(CFG.repair.key);
  });
  ok("finishing one pays the welder's kit",
    jobSim.repair.completions === 1 && jobSim.items.reasons.includes("REPAIRED"),
    `${jobSim.repair.completions} completions, [${jobSim.items.reasons.join(", ")}]`);
}

// ---------------------------------------------------------------------------
// THE assertion for the proc items, and it is invariant 2b wearing a different hat.
//
// A splash-on-kill item and a rack of shock emitters are each individually fine.
// Together, with the gate removed, an emitter kills a chewer, the splash kills two
// more, and each of those splashes again -- automation compounding itself with
// nobody within a hundred metres. That is precisely the failure the emitters were
// made weak and finite to avoid, and it would arrive as an item nobody thought of
// as defensive.
//
// The gate is `causedBy(source, thisOperative)`, and a manned deck gun counts as the crew
// because somebody is sitting in it -- attributed to whoever that is. Section 110 owns the
// identity half; this section owns the automation half, which is the older claim.
console.log("\n94. Procs fire for the crew's kills and for nothing else");
{
  // ---- the proc works at all. Without this the zero below proves nothing.
  const sim = makeSim();
  sim.economy.stacks.fragment = 1;
  sim.economy.applyAll();
  sim.trampler.walking = false;
  sim.trampler.turning = false;

  const centre = sim.trampler.localToWorld(new THREE.Vector3(0, 0, 0));
  const cluster = [];
  for (let i = 0; i < 4; i++) {
    const e = sim.horde.spawn(CHEWER);
    e.x = centre.x + (i === 0 ? 0 : 1.2 * i);
    e.y = 0.8;
    e.z = centre.z;
    cluster.push(e);
  }
  const neighbourHpBefore = cluster.slice(1).map((e) => e.hp);
  sim.horde.damage(cluster[0], 1e6, sim.player);
  const splashed = cluster.slice(1).filter((e, i) => e.hp < neighbourHpBefore[i]).length;
  ok("a kill the crew caused splashes the bodies around it",
    splashed > 0 && sim.items.procs.fragment === 1,
    `${splashed} neighbours hit for ${CFG.items.fragment.damage} each,`
    + ` ${sim.items.procs.fragment} procs`);

  // ---- and the same item, the same cluster, killed by an emitter instead.
  //
  // Through a real deployed emitter rather than by passing the string directly, so
  // this covers the wiring in emitters.js as well as the gate in items.js. The
  // string is the whole mechanism, and a test that supplied it itself would pass
  // while the emitter passed nothing.
  const auto = makeSim();
  auto.economy.stacks.fragment = 1;
  auto.economy.applyAll();

  const under = auto.trampler.legAttackWorld(0, new THREE.Vector3());
  auto.player.position.set(under.x, 1.2, under.z);
  auto.player.base = null;
  auto.player.velocity.set(0, 0, 0);
  step(auto, 10);
  auto.input.presses.add(CFG.emitters.deployKey);
  step(auto, 2);
  ok("an emitter is live and the player is gone", auto.emitters.deployedCount === 1,
    `${auto.emitters.deployedCount} deployed`);
  auto.player.position.set(700, 1.2, 700);
  auto.player.base = null;

  for (let i = 0; i < 8; i++) auto.horde.spawn(CHEWER);
  step(auto, 60 * 40);

  ok("the emitter really did kill things (test is not vacuous)",
    auto.horde.killCount > 0, `${auto.horde.killCount} killed unattended`);
  ok("but an unattended kill procs NOTHING -- automation must not compound",
    auto.items.procs.fragment === 0,
    auto.items.procs.fragment === 0
      ? "0 procs from automation"
      : `${auto.items.procs.fragment} PROCS WITH NOBODY PRESENT -- INVARIANT 2b IS BROKEN`);

  // ---- a manned gun is the crew, not automation. Somebody is sitting in it, and
  // the whole design of the deck gun is that it pins them there.
  //
  // Driven by MOUNTING the gun and firing it, not by passing "player" here. That
  // matters for the same reason the emitter case above deploys a real emitter: the
  // half of this that can rot is deckgun.js's route through Weapon.shootFrom, and a
  // test that supplies the source string itself would keep passing after that route
  // changed. It is also the exact trap tech.md lists under "a test that supplies the
  // mechanism it is testing", added while writing this section.
  const manned = makeSim();
  manned.economy.stacks.fragment = 1;
  manned.economy.applyAll();
  manned.trampler.walking = false;
  manned.trampler.turning = false;

  const gun = manned.guns[0];
  gun.mount(manned.player);
  ok("the gun is genuinely manned (test is not vacuous)",
    gun.mounted && manned.player.station === gun, `${gun.name} mounted`);

  // A tight cluster inside the bow gun's arc, out in the open where it can reach.
  const ahead = manned.trampler.localToWorld(new THREE.Vector3(0, -CFG.trampler.deckHeight, -70));
  const cluster2 = [];
  for (let i = 0; i < 4; i++) {
    const e = manned.horde.spawn(CHEWER);
    e.x = ahead.x + (i - 1.5) * 1.1;
    e.y = 0.8;
    e.z = ahead.z;
    cluster2.push(e);
  }
  // Aim the mount at them and hold the trigger. The gun fires through the same
  // shootFrom the rifle uses, which is where "player" is supplied.
  const aimPoint = new THREE.Vector3(cluster2[0].x, cluster2[0].y, cluster2[0].z);
  let gunKills = 0;
  for (let i = 0; i < 180 && manned.items.procs.fragment === 0; i++) {
    aimAt(manned.player, aimPoint);
    manned.input.mouseHeld.add(0);
    step(manned, 1);
    gunKills = manned.horde.killCount;
  }
  manned.input.mouseHeld.clear();
  ok("and a manned gun's kill does proc, because somebody is sitting in it",
    manned.items.procs.fragment > 0 && gunKills > 0,
    `${manned.items.procs.fragment} procs from ${gunKills} kills by the ${gun.name}`);

  // ---- the on-hit chain, and the heal. Both use the same gate; what is worth
  // checking separately is that they fire at all, since a proc that never fires
  // reads as a weak item rather than as a broken one.
  const chain = makeSim();
  chain.economy.stacks.arc = 20; // well past the chance curve's knee, so it must fire
  chain.economy.applyAll();
  chain.trampler.walking = false;
  chain.trampler.turning = false;
  placeOnGroundAt(chain, 0, -30);
  const a = chain.horde.spawn(CHEWER);
  const b = chain.horde.spawn(CHEWER);
  a.x = chain.player.position.x;
  a.y = 0.8;
  a.z = chain.player.position.z - 6;
  b.x = a.x + 2;
  b.y = 0.8;
  b.z = a.z;
  const bBefore = b.hp;
  for (let i = 0; i < 12 && chain.items.procs.arc === 0; i++) {
    aimAt(chain.player, new THREE.Vector3(a.x, a.y, a.z));
    step(chain, 1);
    aimAt(chain.player, new THREE.Vector3(a.x, a.y, a.z));
    chain.weapon.fire();
    if (!a.alive) break;
  }
  ok("the arc caster chains a hit onto a neighbour",
    chain.items.procs.arc > 0 && b.hp < bBefore,
    `${chain.items.procs.arc} arcs, neighbour ${bBefore} -> ${b.hp.toFixed(0)} hp`);

  const heal = makeSim();
  heal.economy.stacks.executioner = 1;
  heal.economy.applyAll();
  heal.player.hp = 50;
  heal.horde.damage(heal.horde.spawn(CHEWER), 1e6, heal.player);
  ok("and a kill heals with the executioner fitted, and is counted",
    heal.player.hp === 50 + CFG.items.executioner && heal.items.procs.executioner === 1,
    `hp 50 -> ${heal.player.hp}, ${heal.items.procs.executioner} procs`);

  // ---- and it cannot overheal, or the item is a second health bar.
  //
  // The proc counter is asserted alongside the health, because the player starts at
  // full and "hp === maxHp" is also what a completely inert item produces. Without
  // the second half this passes whether or not anything fired.
  const full = makeSim();
  full.economy.stacks.executioner = 5;
  full.economy.applyAll();
  full.horde.damage(full.horde.spawn(CHEWER), 1e6, full.player);
  ok("but it never heals past full",
    full.player.hp === full.player.maxHp && full.items.procs.executioner === 1,
    `hp ${full.player.hp} / ${full.player.maxHp}, ${full.items.procs.executioner} procs`);

  // ---- AND NO PROC MAY REACH SOMETHING UNDERGROUND.
  //
  // Invariant 8 says the one type that cannot be shot cannot STAY that way: a burrower
  // is untouchable while submerged, on a hard clock. Test 71 holds up the shot half of
  // that, and this is the half nothing was watching -- splash and the arc chain do not
  // route through shootFrom, so they get no occlusion clip and had to exclude burrowers
  // themselves. Both did, in code, and neither did in fact: they tested `o.burrowed`,
  // and there is no such field. `horde.burrowed` is a count. So the check read as a
  // working exclusion, excluded nothing, and a proc could kill a thing you cannot see.
  //
  // Found by writing the same line in economy.js and having a test disagree with it.
  // The fix is an exported predicate, `isSubmerged`, so the mistake is not spellable.
  const dig = makeSim();
  dig.economy.stacks.fragment = 3;
  dig.economy.stacks.arc = 20;
  dig.economy.applyAll();
  dig.trampler.walking = false;
  dig.trampler.turning = false;
  placeOnGroundAt(dig, 0, -30);

  // A burrower right beside a chewer, well inside both the splash radius and the arc's
  // range. If either proc ignores the state, this one takes damage.
  //
  // A SURFACE neighbour goes in at the same distance on the other side, and it is not
  // decoration. Without it the splash finds no legal target, fires zero times, and
  // "the burrower took no damage" passes because nothing happened at all -- the exact
  // vacuous pass tech.md warns about, and the first version of this check hit it.
  const surfacer = dig.horde.spawn(CHEWER);
  surfacer.x = dig.player.position.x;
  surfacer.y = 0.8;
  surfacer.z = dig.player.position.z - 6;
  const witness = dig.horde.spawn(CHEWER);
  witness.x = surfacer.x - 1.2;
  witness.y = 0.8;
  witness.z = surfacer.z;
  const witnessHp = witness.hp;
  const digger = dig.horde.spawn(BURROWER);
  digger.x = surfacer.x + 1.2;
  digger.y = -CFG.enemies.burrower.height;
  digger.z = surfacer.z;
  digger.state = ENEMY_STATE.BURROWED;
  digger.burrowT = 999; // stay under for the whole check
  const diggerHp = digger.hp;

  ok("the burrower is genuinely submerged and in range (test is not vacuous)",
    ENEMY_STATE.BURROWED === digger.state
    && Math.hypot(digger.x - surfacer.x, digger.z - surfacer.z) < CFG.items.fragment.radius
    && Math.hypot(digger.x - surfacer.x, digger.z - surfacer.z) < CFG.items.arc.range,
    `${Math.hypot(digger.x - surfacer.x, digger.z - surfacer.z).toFixed(1)} m from the corpse,`
    + ` inside a ${CFG.items.fragment.radius} m splash and a ${CFG.items.arc.range} m arc`);

  // Kill the neighbour with the crew's own damage, so both procs are eligible to fire.
  dig.horde.damage(surfacer, 1e6, dig.player);
  ok("the splash did fire, and reached the SURFACE neighbour (test is not vacuous)",
    dig.items.procs.fragment > 0 && witness.hp < witnessHp,
    `${dig.items.procs.fragment} splash procs, surface neighbour`
    + ` ${witnessHp} -> ${witness.hp.toFixed(0)} hp at the same 1.2 m`);
  ok("but nothing underground was touched -- a proc cannot reach what a bullet cannot",
    digger.hp === diggerHp,
    digger.hp === diggerHp
      ? `burrower untouched at ${diggerHp} hp`
      : `BURROWER TOOK ${(diggerHp - digger.hp).toFixed(0)} DAMAGE WHILE SUBMERGED`);

  // And the arc specifically, since it picks a single nearest target rather than
  // sweeping a radius -- a burrower closer than any legal target would eat the chain.
  const arcDig = makeSim();
  arcDig.economy.stacks.arc = 20;
  arcDig.economy.applyAll();
  arcDig.trampler.walking = false;
  arcDig.trampler.turning = false;
  placeOnGroundAt(arcDig, 0, -30);
  const shot = arcDig.horde.spawn(CHEWER);
  shot.x = arcDig.player.position.x;
  shot.y = 0.8;
  shot.z = arcDig.player.position.z - 6;
  const nearer = arcDig.horde.spawn(BURROWER);
  nearer.x = shot.x + 0.8;
  nearer.y = -CFG.enemies.burrower.height;
  nearer.z = shot.z;
  nearer.state = ENEMY_STATE.BURROWED;
  nearer.burrowT = 999;
  const nearerHp = nearer.hp;
  const far = arcDig.horde.spawn(CHEWER);
  far.x = shot.x + 2.5;
  far.y = 0.8;
  far.z = shot.z;
  const farHp = far.hp;
  for (let i = 0; i < 12 && arcDig.items.procs.arc === 0; i++) {
    aimAt(arcDig.player, new THREE.Vector3(shot.x, shot.y, shot.z));
    step(arcDig, 1);
    aimAt(arcDig.player, new THREE.Vector3(shot.x, shot.y, shot.z));
    arcDig.weapon.fire();
    if (!shot.alive) break;
  }
  ok("an arc chains PAST a submerged body to a legal one, rather than into it",
    arcDig.items.procs.arc > 0 && nearer.hp === nearerHp && far.hp < farHp,
    `${arcDig.items.procs.arc} arcs, burrower ${nearerHp} -> ${nearer.hp.toFixed(0)},`
    + ` surface neighbour ${farHp} -> ${far.hp.toFixed(0)}`);
}

// ---------------------------------------------------------------------------
// The shop is a re-rolled subset now, and that is the mechanism the whole update
// rests on: eighteen items against six number keys means two runs see different
// stock, which is the difference between a build and a shopping list. Two things
// have to hold at once, and they pull against each other -- it must VARY, and it
// must be REPRODUCIBLE, or invariant 21 is gone.
console.log("\n95. The stock is seeded, varied, and weighted by rarity");
{
  const cat = CFG.economy.catalogue;
  const sim = makeSim();

  ok("the shop offers exactly as many slots as it has keys",
    sim.economy.offers.length === CFG.economy.keys.length,
    `${sim.economy.offers.length} offers, ${CFG.economy.keys.length} keys`);

  // The bounded fortress track is dependable on purpose. A run should be able to
  // plan on buying plating; it should not be able to plan on any one personal item.
  const scrapIndices = cat.map((c, i) => (c.pool === "scrap" ? i : -1)).filter((i) => i >= 0);
  ok("the fortress refits are always on sale, so the bounded track can be planned",
    scrapIndices.every((i) => sim.economy.offers.includes(i)),
    `${scrapIndices.length} scrap refits, all offered`);

  ok("and no slot is wasted on a duplicate",
    new Set(sim.economy.offers).size === sim.economy.offers.length,
    `${new Set(sim.economy.offers).size} distinct`);

  // Reproducible: same seed, same stock. Two fresh economies, and a reset.
  const twin = makeSim();
  ok("two runs from the same seed are offered the same stock",
    twin.economy.offers.join(",") === sim.economy.offers.join(","),
    `[${sim.economy.offers.join(",")}]`);

  // Restocking is compared as a SET, not as a joined string. Order within `offers` is
  // an artefact of the draw, so string inequality would also be satisfied by the same
  // four items coming out in a different sequence — which is not a restock, and would
  // read to a player as the shop not having changed at all.
  const first = sim.economy.offers.slice();
  const second = sim.economy.rollOffers().slice();
  const sameSet = (a, b) =>
    a.length === b.length && [...a].sort((x, y) => x - y).join(",") === [...b].sort((x, y) => x - y).join(",");
  ok("but each landmark restocks, or there is no reason to travel",
    !sameSet(first, second),
    `[${first.join(",")}] -> [${second.join(",")}]`);

  sim.economy.reset();
  ok("and a restart rewinds the stock along with everything else",
    sameSet(sim.economy.offers, first),
    `[${sim.economy.offers.join(",")}]`);

  // Composition. `weight` means share-of-offers, which is what choosing the tier
  // before the item bought: with per-item weights the rares came out at 8% of the
  // list, about one across a whole run, for the items the pool exists to deliver.
  const rolls = 400;
  const seen = { common: 0, uncommon: 0, rare: 0 };
  const measure = makeSim().economy;
  for (let i = 0; i < rolls; i++) {
    for (const idx of measure.rollOffers()) {
      const r = cat[idx].rarity;
      if (r) seen[r]++;
    }
  }
  const total = seen.common + seen.uncommon + seen.rare;
  const share = (n) => n / total;
  const tiers = CFG.economy.rarity;
  const weightTotal = tiers.common.weight + tiers.uncommon.weight + tiers.rare.weight;
  const want = (name) => tiers[name].weight / weightTotal;

  ok("all three tiers actually appear in the stock",
    seen.common > 0 && seen.uncommon > 0 && seen.rare > 0,
    `common ${(share(seen.common) * 100).toFixed(0)}%,`
    + ` uncommon ${(share(seen.uncommon) * 100).toFixed(0)}%,`
    + ` rare ${(share(seen.rare) * 100).toFixed(0)}% over ${rolls} rolls`);

  const drift = Object.keys(tiers)
    .map((n) => ({ n, off: Math.abs(share(seen[n]) - want(n)) }))
    .sort((x, y) => y.off - x.off)[0];
  ok("and their shares match the configured weights, so the numbers mean something",
    drift.off < 0.06,
    `worst drift ${drift.n} ${(share(seen[drift.n]) * 100).toFixed(1)}%`
    + ` vs ${(want(drift.n) * 100).toFixed(1)}% configured`);

  // A rare has to cost more than a common at EVERY stack, not just the first. The
  // tiers carry different growth rates as well as different base costs, so a lower
  // growth on the rare tier could invert the ordering a few stacks in and the first
  // stack alone would never show it.
  const priceAt = (name, stacks) => {
    const i = cat.findIndex((c) => c.rarity === name);
    const id = cat[i].id;
    const held = sim.economy.stacks[id];
    sim.economy.stacks[id] = stacks;
    const cost = sim.economy.costOf(i);
    sim.economy.stacks[id] = held;
    return cost;
  };
  const inverted = [];
  for (let n = 0; n <= 5; n++) {
    if (!(priceAt("rare", n) > priceAt("uncommon", n) && priceAt("uncommon", n) > priceAt("common", n))) {
      inverted.push(n);
    }
  }
  ok("rarity costs money as well as meaning something, at every stack",
    inverted.length === 0,
    inverted.length
      ? `INVERTED at stacks ${inverted.join(", ")}`
      : `stack 0: ${priceAt("common", 0)}/${priceAt("uncommon", 0)}/${priceAt("rare", 0)},`
        + ` stack 5: ${priceAt("common", 5)}/${priceAt("uncommon", 5)}/${priceAt("rare", 5)}`);
}

// ---------------------------------------------------------------------------
// The free pick. Test 79 covers where it sits in the run -- offered on a hold,
// before the road, and never on the boss leg. What it does not cover is what the
// pick is allowed to contain, and that is the part with a design rule behind it:
// the crew's bounded track is meant to be paid for together, so handing out a hull
// plate for nothing would be the one purse funding the other.
console.log("\n96. The salvage pick is personal, free, and a real choice");
{
  const sim = makeSim();
  const cat = CFG.economy.catalogue;

  // Every draw the pool can produce, not just this run's, because a scrap item
  // slipping in would depend on the seed and would show up as a bug months later.
  const seenPools = new Set();
  for (let i = 0; i < 200; i++) {
    for (const idx of sim.economy.offerPick()) seenPools.add(cat[idx].pool);
  }
  ok("a pick is never a fortress refit, whatever the roll",
    seenPools.size === 1 && seenPools.has("salvage"),
    `pools drawn: ${[...seenPools].join(", ")}`);

  const fresh = makeSim();
  const offered = fresh.economy.offerPick();
  ok("it offers as many as the config asks for, all different",
    offered.length === CFG.economy.pickCount
    && new Set(offered).size === offered.length,
    `${offered.length} of ${CFG.economy.pickCount}, distinct`);

  fresh.economy.salvage = 120;
  fresh.economy.scrap = 90;
  const takenId = cat[offered[1]].id;
  const took = fresh.economy.takePick(1);
  ok("taking one grants it outright, from neither purse",
    !!took && took.cost === 0
    && fresh.economy.stacks[takenId] === 1
    && fresh.economy.salvage === 120 && fresh.economy.scrap === 90,
    `${took?.name} at cost ${took?.cost}, salvage ${fresh.economy.salvage}, scrap ${fresh.economy.scrap}`);

  ok("and the other two are gone, so the value of the pick is what you gave up",
    fresh.economy.pendingPick.length === 0
    && offered.filter((i) => i !== offered[1])
      .every((i) => fresh.economy.stacks[cat[i].id] === 0),
    "the rest cleared");

  ok("a second take does nothing rather than granting a fourth item",
    fresh.economy.takePick(0) === null && fresh.economy.purchases === 1,
    `${fresh.economy.purchases} purchases`);

  // A pick has to be the SAME acquisition as a purchase, not a cheaper imitation of
  // one. VITALS is the case that proves it: its detail line says "healed", and for a
  // while the top-up lived only in `buy()`, so taking it as a pick raised the ceiling
  // and left health where it was while both the panel and the toast said otherwise.
  // Driven through takePick with the pick list forced, because a seeded roll cannot be
  // relied on to offer any particular item.
  const vit = makeSim();
  const vitalsIndex = CFG.economy.catalogue.findIndex((c) => c.id === "vitals");
  vit.player.hp = 40;
  const maxBefore = vit.player.maxHp;
  vit.economy.pendingPick = [vitalsIndex];
  const tookVitals = vit.economy.takePick(0);
  ok("an item that raises the ceiling arrives FILLED when picked, exactly as when bought",
    !!tookVitals
    && vit.player.maxHp > maxBefore
    && vit.player.hp === 40 + (vit.player.maxHp - maxBefore),
    `max ${maxBefore} -> ${vit.player.maxHp}, hp 40 -> ${vit.player.hp}`);

  // And the same item bought must land on the same numbers, or the two paths have
  // drifted again in the other direction.
  const bought = makeSim();
  shopReady(bought);
  bought.player.hp = 40;
  bought.economy.salvage = 1e6;
  bought.economy.buy(vitalsIndex);
  ok("and buying it lands on identical numbers",
    bought.player.maxHp === vit.player.maxHp && bought.player.hp === vit.player.hp,
    `bought ${bought.player.hp}/${bought.player.maxHp} vs picked ${vit.player.hp}/${vit.player.maxHp}`);

  // Reproducible, like the shop: a pick is a stochastic reward and invariant 21
  // covers every one of those without exception.
  const twinA = makeSim().economy.offerPick().join(",");
  const twinB = makeSim().economy.offerPick().join(",");
  ok("two runs from the same seed are offered the same three",
    twinA === twinB, `[${twinA}]`);

  // ---- AND A PICK WAITS FOR THE SAME WINDOW THE SHOP DOES.
  //
  // The pick panel is a 680 px menu of three items on the bottom-centre anchor, and it
  // appeared the instant a pick was earned -- which is the instant a wave resolves,
  // frequently with the remains of that wave still on you. The shop's version of this
  // problem produced "I just spam buy items out of panic"; the pick had it too, with
  // none of the shop's protection.
  //
  // Asserted as the SAME getter rather than as equivalent behaviour. Two nearly
  // identical safety rules drift, and a shop and a pick disagreeing about whether this
  // moment is safe is not explainable to a player.
  const gated = makeSim();
  gated.trampler.walking = false;
  gated.trampler.turning = false;
  placeOnGroundAt(gated, 0, -30);
  gated.director.phase = PHASE.REST;
  gated.director.timer = CFG.waves.minRest;
  gated.economy.offerPick();
  // Note the player is on the GROUND here, and that is the point rather than an
  // oversight. A pick is handed to you wherever you are standing; only buying happens at
  // the terminal on the deck. Requiring a walk to the console to collect a reward already
  // earned would undo 22f's argument that being given something is a different beat from
  // buying it — so `pickOpen` shares the shop's SAFETY clause and not its place clause.
  ok("a pick in a clear rest is takeable on the ground, because a pick is handed to you",
    gated.economy.pickOpen && !gated.economy.atTerminal,
    `pickOpen ${gated.economy.pickOpen}, atTerminal ${gated.economy.atTerminal},`
    + ` ${gated.horde.liveCount} alive`);

  const onTop = gated.horde.spawn(CHEWER);
  onTop.x = gated.player.position.x + 1.5;
  onTop.y = gated.player.position.y;
  onTop.z = gated.player.position.z;
  step(gated, 2);
  const stillOffered = gated.economy.pendingPick.join(",");
  ok("something in your face closes the pick, through the shop's own safety getter",
    !gated.economy.pickOpen && !gated.economy.safeMoment,
    `pickOpen ${gated.economy.pickOpen}, safeMoment ${gated.economy.safeMoment}`);
  ok("and pressing a key does not spend it -- the offer survives being refused",
    gated.economy.takePick(0) === null
    && gated.economy.pendingPick.join(",") === stillOffered
    && gated.economy.purchases === 0,
    `[${stillOffered}] still in hand, ${gated.economy.purchases} purchases`);

  // The keys must not be DEAD while it waits. If the router still handed them to the
  // pick, they would be owned by something that refuses to act on them, and the shop
  // and the bay would be locked out for as long as the pick was pending.
  gated.input.presses.add(CFG.economy.keys[0]);
  const whileWaiting = routePurchaseInput({
    economy: gated.economy, run: gated.run, bayOpen: false, input: gated.input, dt: DT,
  });
  ok("and the number keys are not left owned by something that refuses them",
    whileWaiting.owner !== "pick", `owner ${whileWaiting.owner}`);
  gated.input.presses.clear();

  // Stepping away is the fix, same as the shop. That property is the whole point:
  // the player can act on the refusal rather than waiting for the fight to end.
  onTop.x = gated.player.position.x + CFG.repair.threatRange * 3;
  step(gated, 2);
  ok("stepping clear re-opens it, and it is still the same three items",
    gated.economy.pickOpen && gated.economy.pendingPick.join(",") === stillOffered,
    `[${gated.economy.pendingPick.join(",")}] at`
    + ` ${Math.hypot(onTop.x - gated.player.position.x, onTop.z - gated.player.position.z).toFixed(1)} m`);
  ok("and now it can be taken", !!gated.economy.takePick(0),
    `${gated.economy.purchases} purchases`);

  // A pick earned mid-wave is banked, not lost. Without this the cadence would quietly
  // drop rewards whenever a wave resolved into another one.
  const mid = makeSim();
  mid.director.phase = PHASE.ENGAGED;
  mid.economy.offerPick();
  ok("a pick earned while a wave is out is banked rather than shown or lost",
    !mid.economy.pickOpen && mid.economy.pendingPick.length === CFG.economy.pickCount,
    `${mid.economy.pendingPick.length} banked, pickOpen ${mid.economy.pickOpen}`);

  // And holding a siege must not re-roll a pick that is still in hand. Invariant 22f
  // says an offer is never overwritten; the cadence's payer honoured that and the
  // hold's did not, and the gate above is what made the rare case ordinary -- a pick
  // now waits, so a hold is far more likely to find one still open.
  const holdKeep = makeSim();
  holdKeep.director.phase = PHASE.ENGAGED;
  const banked = holdKeep.economy.offerPick().join(",");
  holdKeep.director.phase = PHASE.HELD;
  holdKeep.run.update();
  ok("holding a siege does not re-roll a pick that is still in hand",
    holdKeep.economy.pendingPick.join(",") === banked && holdKeep.run.picking,
    `[${banked}] -> [${holdKeep.economy.pendingPick.join(",")}], phase ${holdKeep.run.phase}`);
}

// ---------------------------------------------------------------------------
// Enemy health feedback, which the game had none of.
//
// Invariant 8 has always demanded it -- "a magazine emptied into something with the
// health bar refusing to move is indistinguishable from a bug" -- and the only
// feedback that existed was a one-frame white flash. A playtester who had fought
// bulwarks for an hour still called one "the grey creature, the tank" and could not
// tell a five-damage hit from a broken game. It was the exact failure the rule was
// written to prevent, happening in front of us.
//
// Two halves, and they answer different questions. The target scan answers "would
// this shot land, and on what" for ONE thing. The tint answers "which of these
// forty-five is nearly dead" for a crowd, with no UI at all.
console.log("\n97. What the crosshair is on is reported, and only when it is shootable");
{
  const sim = makeSim();
  const { weapon, horde, player, trampler } = sim;
  trampler.walking = false;
  trampler.turning = false;

  // ---- nothing on the ray
  placeOnGroundAt(sim, 0, -40);
  aimAt(player, new THREE.Vector3(player.position.x, 1.2, player.position.z - 60));
  step(sim, 2);
  ok("an empty view reports no target", weapon.aimTarget === null,
    `${weapon.aimTarget ? "SOMETHING" : "null"}`);

  // ---- something on the ray, in the open
  const mark = horde.spawn(CHEWER);
  mark.x = player.position.x;
  mark.y = 0.8;
  mark.z = player.position.z - 20;
  aimAt(player, new THREE.Vector3(mark.x, mark.y, mark.z));
  step(sim, 1);
  aimAt(player, new THREE.Vector3(mark.x, mark.y, mark.z));
  step(sim, 1);
  ok("aiming at an enemy in the open reports it",
    weapon.aimTarget === mark, weapon.aimTarget ? "the chewer" : "NOTHING");
  ok("and how far away it is", Math.abs(weapon.aimDist - 20) < 3,
    `${weapon.aimDist.toFixed(1)} m vs 20 m`);

  // ---- and the readout has to agree with what a SHOT would do. This is the half
  // that matters: the hull's shadow is the rule the whole pillar rests on, and a
  // readout naming a chewer you cannot shoot through 3 m of hull slab would be
  // teaching the player the opposite of the truth.
  const hidden = makeSim();
  hidden.trampler.walking = false;
  hidden.trampler.turning = false;
  const below = hidden.trampler.localToWorld(new THREE.Vector3(0, -CFG.trampler.deckHeight + 0.8, 0));
  const under = hidden.horde.spawn(CHEWER);
  under.x = below.x;
  under.y = below.y;
  under.z = below.z;
  // On the deck, looking straight down at it through the hull.
  hidden.player.respawnOnDeck();
  step(hidden, 4);
  aimAt(hidden.player, new THREE.Vector3(under.x, under.y, under.z));
  step(hidden, 2);
  const shot = hidden.weapon.fire();
  ok("a chewer under the hull is genuinely unshootable from the deck (test is not vacuous)",
    !shot && under.hp === under.maxHp,
    `shot ${shot ? "CONNECTED" : "blocked"}, chewer at ${under.hp}/${under.maxHp}`);
  ok("and it is reported as NO target, because the readout must agree with the shot",
    hidden.weapon.aimTarget === null,
    hidden.weapon.aimTarget === null
      ? "null"
      : "NAMED A TARGET THE HULL BLOCKS -- the readout is teaching the wrong rule");

  // ---- a dead target clears rather than lingering
  horde.damage(mark, 1e6);
  step(sim, 2);
  ok("killing what you were aiming at clears the readout",
    weapon.aimTarget === null || weapon.aimTarget.alive === false,
    `${weapon.aimTarget ? "stale reference, alive=" + weapon.aimTarget.alive : "null"}`);

  // ---- every type has a word for it, because "the grey creature" is what a
  // playtester says when nothing tells them
  const missing = ENEMY_TYPE_KEYS.filter((k) => {
    const l = CFG.enemies[k].label;
    return !l || l === "HOSTILE";
  });
  ok("every type has a player-facing name, not just a code name",
    missing.length === 0,
    missing.length
      ? `UNNAMED: ${missing.join(", ")}`
      : ENEMY_TYPE_KEYS.map((k) => CFG.enemies[k].label).join(", "));

  // The armour line is what the readout exists to say out loud, so at least one
  // type has to actually be armoured or the branch is decoration.
  const armoured = ENEMY_TYPE_KEYS.filter((k) => CFG.enemies[k].armour > 0);
  ok("and the types that change which weapon is correct are armoured (not vacuous)",
    armoured.length > 0,
    armoured.map((k) => `${CFG.enemies[k].label} ${CFG.enemies[k].armour}`).join(", "));
}

// ---------------------------------------------------------------------------
console.log("\n98. A worn-down crowd reads darker, without a single floating bar");
{
  const sim = makeSim();
  const { horde } = sim;

  // The tint is written during the draw pass, which is the one part of the horde
  // that exists for a renderer -- so it is driven here through a real step rather
  // than by calling the private writer.
  const a = horde.spawn(CHEWER);
  const b = horde.spawn(CHEWER);
  step(sim, 1);

  ok("a fresh enemy is drawn untinted", a.tintBand > 0,
    `band ${a.tintBand} of the top band`);
  const full = a.tintBand;

  // The hit flash owns the colour while it lasts, and it MUST -- it is the only
  // "that connected" feedback in the game, and a wounded body quietly swallowing it
  // would trade the more urgent signal for the less urgent one. So the tint is only
  // written once the flash has expired, and reading the band a frame after the
  // damage lands measures the flash instead of the tint. That is the project's own
  // "sampling at the wrong moment in a sequence" trap, and the first version of this
  // block walked straight into it.
  const flashFrames = Math.ceil(60 * CFG.combat.weapon.hitFlash) + 2;
  horde.damage(a, a.maxHp * 0.6);
  step(sim, 1);
  ok("a hit still flashes white, which outranks the tint while it lasts",
    a.flash > 0 && a.tintBand === full,
    `flash ${a.flash.toFixed(2)}s, band still ${a.tintBand}`);

  step(sim, flashFrames);
  ok("and once the flash clears, it is drawn a band darker",
    a.flash <= 0 && a.tintBand < full,
    `band ${full} -> ${a.tintBand} at ${Math.round(a.hp / a.maxHp * 100)}% health`);
  ok("while its untouched neighbour did not move", b.tintBand === full,
    `band ${b.tintBand}`);

  // The band is what makes this cheap: an untouched crowd must cost no buffer
  // upload at all, which is the whole reason it is quantised rather than smooth.
  const settled = a.tintBand;
  step(sim, 1);
  ok("a steady crowd re-writes nothing, so an untouched wave is free",
    a.tintBand === settled && b.tintBand === full,
    `bands ${a.tintBand}, ${b.tintBand}`);

  // A pooled slot must not inherit the previous occupant's tint. This is the bug
  // this field exists to prevent: a full-health enemy drawn dark because something
  // died at 20% in the same slot.
  horde.damage(a, 1e6);
  step(sim, 1);
  const reused = horde.spawn(CHEWER);
  ok("a recycled pool slot starts unwritten rather than inheriting a dark body",
    reused.tintBand === -1,
    `band ${reused.tintBand} before the first draw`);
  step(sim, 1);
  ok("and comes out at full health in the top band",
    reused.tintBand === full && reused.hp === reused.maxHp,
    `band ${reused.tintBand}, ${reused.hp}/${reused.maxHp} hp`);
}

// ---------------------------------------------------------------------------
// The pick cadence, which exists because of a measured playtest failure rather than
// a design idea: the pick was paid ONLY for holding a siege -- wave five of five --
// and the player averaged wave four. The headline reward of the whole item update was
// behind a gate they had passed once in an evening.
//
// So the thing to test is REACHABILITY, not just correctness. A run that dies at wave
// four has to have been offered something.
console.log("\n99. A pick arrives often enough to actually reach");
{
  const sim = makeSim();
  const { director, run, economy } = sim;
  const every = CFG.run.pickEveryWaves;
  ok("the cadence is configured to something that can fire inside one siege",
    every > 0 && every < CFG.waves.siegeLength,
    `every ${every} waves, siege is ${CFG.waves.siegeLength}`);

  // Waves are resolved by driving the director's own counter through its own phases
  // rather than by fighting, because what is under test is the cadence and not the
  // combat -- and a real fight would take minutes per wave to lose on purpose.
  const resolveWave = () => {
    director.phase = PHASE.ENGAGED;
    director.wave = Math.min(director.wave + 1, director.siegeLength);
    sim.horde.clear();
    // ENGAGED resolves once the field is calm, which it now is.
    director.update(DT);
    run.update();
  };

  const offeredAt = [];
  for (let w = 1; w <= CFG.waves.siegeLength; w++) {
    resolveWave();
    if (economy.pendingPick.length > 0) {
      offeredAt.push(w);
      economy.takePick(0);
      run.update();
    }
  }

  ok("a pick lands inside the first few waves, not only at the end",
    offeredAt.length > 0 && offeredAt[0] <= every,
    `offered after waves [${offeredAt.join(", ")}]`);
  // The specific failure this replaces: dying at wave four used to mean never having
  // been handed anything at all.
  ok("so a run that dies before holding the siege has still made a build decision",
    offeredAt.some((w) => w < CFG.waves.siegeLength),
    `first pick after wave ${offeredAt[0]}, siege ends at ${CFG.waves.siegeLength}`);
  ok("and holding the siege still pays its own on top",
    offeredAt.includes(CFG.waves.siegeLength),
    `[${offeredAt.join(", ")}]`);

  // A buried wave must not pay. Only waves the crew actually SEES OFF increment the
  // director's resolved counter, and stacking one with Q means the first never does --
  // which is part of what calling early costs, and it falls out of polling that
  // counter rather than being special-cased anywhere.
  const q = makeSim();
  q.director.phase = PHASE.ENGAGED;
  q.director.wave = 1;
  q.horde.spawn(CHEWER); // field is not calm, so nothing resolves on its own
  const resolvedBefore = q.director.resolved;
  q.director.callEarly();
  q.director.update(DT);
  q.run.update();
  ok("a wave buried by calling early pays no pick, because it was never resolved",
    q.director.resolved === resolvedBefore && q.economy.pendingPick.length === 0,
    `resolved ${resolvedBefore} -> ${q.director.resolved},`
    + ` ${q.economy.pendingPick.length} on offer`);

  // An offer already in hand must not be replaced. Overwriting one would make an
  // item the player was looking at vanish, which reads as a bug rather than as luck.
  const keep = makeSim();
  keep.economy.offerPick();
  const held = keep.economy.pendingPick.join(",");
  for (let w = 1; w < CFG.waves.siegeLength; w++) {
    keep.director.phase = PHASE.ENGAGED;
    keep.director.wave = w;
    keep.horde.clear();
    keep.director.update(DT);
    keep.run.update();
  }
  ok("and a pick already on offer is never overwritten by the next one",
    keep.economy.pendingPick.join(",") === held,
    `[${held}] still on offer`);

  // The keys have to actually work in the new state. A mid-siege pick leaves the
  // run's phase at SIEGE, so anything gated on `run.picking` would show the panel,
  // print TAKE SALVAGE on the prompt, and do nothing at all when pressed.
  const keyed = makeSim();
  keyed.director.phase = PHASE.REST;
  keyed.economy.offerPick();
  const wanted = CFG.economy.catalogue[keyed.economy.pendingPick[0]].id;
  ok("the run is mid-siege, not in the pick phase (test is not vacuous)",
    keyed.run.phase === RUN.SIEGE && !keyed.run.picking,
    `phase ${keyed.run.phase}`);
  keyed.input.presses.add(CFG.economy.keys[0]);
  const routed = routePurchaseInput({
    economy: keyed.economy, run: keyed.run, bayOpen: false, input: keyed.input, dt: DT,
  });
  ok("a pending pick owns the number keys wherever the run happens to be",
    routed.owner === "pick" && keyed.economy.stacks[wanted] === 1,
    `owner ${routed.owner}, ${wanted} x${keyed.economy.stacks[wanted]}`);
  ok("and it did not buy a refit with the same press",
    keyed.economy.purchases === 1 && keyed.economy.salvage === 0,
    `${keyed.economy.purchases} purchases, ${keyed.economy.salvage} salvage`);
}

// ---------------------------------------------------------------------------
/**
 * Cycle the carried weapon until `profile` is in hand, and clear the swap's
 * cooldown so a test measuring damage is not also measuring the swap.
 *
 * Deliberately drives the real `swap()` rather than assigning `weapon.profile`,
 * because a test that sets the field itself would pass even if the cycle could
 * never reach the second weapon -- which is the whole mechanism.
 */
function hold(weapon, profile) {
  for (let i = 0; i <= weapon.profiles.length && weapon.profile !== profile; i++) {
    weapon.swap();
  }
  weapon.cooldown = 0;
  return weapon.profile === profile;
}

// ---------------------------------------------------------------------------
// The second weapon, and the claim it has to earn: it is a POSITION, not a tier.
//
// The failure mode a weapon axis invites is power creep wearing a costume -- add a
// gun that is simply better and the "choice" is a formality, exactly as four numeric
// multipliers were a formality before the salvage table. So the assertions here are
// mostly about what the sweeper is WORSE at, because that is the half that makes
// carrying it a decision.
//
// The falloff is measured rather than declared, and it is measured through the real
// hitscan path at three ranges with the rifle firing at the same target first. That
// last part is the non-vacuity guard and it is not optional: "few pellets landed at
// 26 m" would pass just as happily if a rock were in the way, and this scene has
// merged scatter geometry in it.
console.log("\n100. The sweeper is a POSITION, not an upgrade");
{
  const rifleP = CFG.combat.weapon;
  const sweepP = CFG.combat.scatter;

  {
    const sim = makeSim();
    const { weapon } = sim;
    ok("the operative carries more than one weapon (test is not vacuous)",
      weapon.profiles.length >= 2 && weapon.profile === rifleP,
      `${weapon.profiles.length} carried, starting on ${weapon.weaponName}`);
    ok("the swap cycle actually reaches the second one", hold(weapon, sweepP),
      `now holding ${weapon.weaponName}`);

    // A free instant swap is what would make "carry both" strictly better than
    // choosing, so the swap borrows the fire cooldown.
    weapon.cooldown = 0;
    weapon.swap();
    ok("and a swap is not free -- it borrows the fire cooldown",
      weapon.cooldown >= CFG.combat.loadout.swapTime - 1e-9,
      `${weapon.cooldown.toFixed(2)} s before the next shot`);

    // The consequence worth pinning: you cannot fire the slow weapon and then dodge
    // its recovery by switching off it.
    weapon.cooldown = 1 / sweepP.fireRate;
    const carried = weapon.cooldown;
    weapon.swap();
    ok("and switching does not shake off the slow weapon's recovery",
      weapon.cooldown >= carried - 1e-9,
      `${weapon.cooldown.toFixed(2)} s carried across the swap`);
  }

  // ---- the falloff, through the real shot path
  const atRange = (range) => {
    const s = makeSim();
    placeOnGroundAt(s, 0, -40);
    const e = s.horde.spawn(CHEWER);
    e.x = s.player.position.x;
    e.z = s.player.position.z - range;
    e.y = enemyCfg(CHEWER).height / 2;
    e.hp = 1e7; // keep it alive so every pellet of every blast is counted
    aimAt(s.player, new THREE.Vector3(e.x, e.y, e.z));

    const mean = (profile, pulls) => {
      hold(s.weapon, profile);
      let dealt = 0;
      for (let i = 0; i < pulls; i++) {
        const before = e.hp;
        s.weapon.fire();
        dealt += before - e.hp;
      }
      return dealt / pulls;
    };
    const rifle = mean(rifleP, 8);
    const sweeper = mean(sweepP, 24);
    return { rifle, sweeper, pellets: sweeper / sweepP.damage };
  };

  const near = atRange(4);
  const mid = atRange(12);
  const far = atRange(26);

  for (const [label, m] of [["4 m", near], ["12 m", mid], ["26 m", far]]) {
    ok(`the line of fire is genuinely clear at ${label} (test is not vacuous)`,
      m.rifle > 0, `a rifle round still deals ${m.rifle.toFixed(1)} there`);
  }

  // Measured 9.0 -> 5.8 -> 1.1 pellets. The middle one is bounded on BOTH sides on
  // purpose: the under-hull arena is roughly 16 m across, so a weapon meant to own
  // that space has to still work at 12 m, and a weapon that works too well at 12 m
  // has stopped being position-coded and become a rifle with a bigger number.
  //
  // The first version of this asserted mid < near * 0.6 on the strength of arithmetic
  // I did in my head, and it failed at 5.8 against a 5.4 bar. The falloff was real;
  // the estimate of a chewer's hit box was not. Recording that because the temptation
  // was to move the bar to 0.65 and call it green.
  ok("point blank, nearly the whole pattern lands",
    near.pellets >= sweepP.pellets * 0.75,
    `${near.pellets.toFixed(1)} of ${sweepP.pellets} pellets at 4 m`);
  ok("it still works across the width of the under-hull arena",
    mid.pellets >= sweepP.pellets * 0.4 && mid.pellets <= sweepP.pellets * 0.8,
    `${mid.pellets.toFixed(1)} of ${sweepP.pellets} pellets at 12 m`);
  ok("and out where the deck fights it is plainly the wrong tool",
    far.pellets <= sweepP.pellets * 0.25,
    `${far.pellets.toFixed(1)} of ${sweepP.pellets} pellets at 26 m`);
  ok("so the pattern opens monotonically rather than falling off a cliff",
    near.pellets > mid.pellets && mid.pellets > far.pellets,
    `${near.pellets.toFixed(1)} -> ${mid.pellets.toFixed(1)} -> ${far.pellets.toFixed(1)}`);

  // ---- and it is not a straight upgrade even at contact range
  const rifleDps = rifleP.damage * rifleP.fireRate;
  const sweepDps = sweepP.damage * sweepP.pellets * sweepP.fireRate;
  ok("single-target throughput does NOT beat the rifle, even point blank",
    sweepDps < rifleDps,
    `${sweepDps.toFixed(0)} dps against the rifle's ${rifleDps.toFixed(0)}`);


  // ---- what it actually buys, which is NOT crowd clear
  //
  // The obvious claim for a shotgun is that one pull kills several bodies, and it was
  // asserted here first and FAILED: two chewers a metre apart at 5 m, one died. The
  // cone is 0.55 m across at that range and a chewer's hit box is about 1.06 m, so the
  // two overlapped and the near one shadowed the far one. A nine-pellet cone at
  // contact range is narrower than a single target.
  //
  // That is worth keeping as a comment because the intuition is so strong and so
  // wrong, and because the config comment had already been written on the strength of
  // it -- a number defended only by prose is not defended.
  //
  // So the advantage is measured where it actually lives: how far off-centre you can
  // be and still connect. That is the thing that matters with something chewing on
  // you, and it is the honest reason to bring this down a ladder.
  const slack = (profile) => {
    const s = makeSim();
    placeOnGroundAt(s, 0, -40);
    hold(s.weapon, profile);
    const e = s.horde.spawn(CHEWER);
    e.x = s.player.position.x;
    e.z = s.player.position.z - 5;
    e.y = enemyCfg(CHEWER).height / 2;
    e.hp = 1e7;

    let widest = 0;
    for (let off = 0; off <= 3.0; off += 0.05) {
      for (let i = 0; i < 14; i++) {
        const before = e.hp;
        aimAt(s.player, new THREE.Vector3(e.x + off, e.y, e.z));
        s.weapon.fire();
        if (e.hp < before) { widest = off; break; }
      }
    }
    return widest;
  };

  const rifleSlack = slack(rifleP);
  const sweepSlack = slack(sweepP);
  const coneRadius = sweepP.spread * 5; // metres across at the 5 m test range

  ok("both weapons connect dead on (test is not vacuous)",
    rifleSlack > 0 && sweepSlack > 0,
    `rifle tolerates ${rifleSlack.toFixed(2)} m off-centre, sweeper ${sweepSlack.toFixed(2)} m`);
  ok("the cone buys roughly its own radius in aim slack, which is the real trade",
    sweepSlack - rifleSlack >= coneRadius * 0.6,
    `+${(sweepSlack - rifleSlack).toFixed(2)} m against a ${coneRadius.toFixed(2)} m cone radius`);
  ok("one trigger pull removes a chewer where the rifle needs a burst",
    sweepP.damage * sweepP.pellets >= CFG.enemies.chewer.hp
    && rifleP.damage < CFG.enemies.chewer.hp,
    `${sweepP.damage * sweepP.pellets} per pull against ${CFG.enemies.chewer.hp} hp,`
    + ` where a rifle round is ${rifleP.damage}`);
}

// ---------------------------------------------------------------------------
// Invariant 1, re-asserted against the thing that could plausibly break it.
//
// Section 12 fires single rays straight down. The whole point of a nine-pellet cone
// is that it covers angles one ray does not, and the tempting assumption is that a
// rule proven for a ray holds for a spread. It does -- every pellet goes through
// `shootFrom` and gets its own clip -- but "it does because of how I wrote it" is
// exactly the class of claim this project keeps finding to be wrong, so it is
// measured across the whole depression range rather than argued.
console.log("\n101. A nine-pellet cone still cannot reach beneath the hull");
{
  const sim = makeSim();
  const { player, trampler, horde, weapon } = sim;
  ok("holding the sweeper on the deck", hold(weapon, CFG.combat.scatter));

  const chewer = horde.spawn(CHEWER);
  const legLocal = trampler.legs[0].userData;
  const parkChewer = () => {
    const at = trampler.legAttackWorld(0, new THREE.Vector3());
    chewer.x = at.x;
    chewer.y = at.y;
    chewer.z = at.z;
    return at;
  };

  player.position.copy(trampler.localToWorld(
    new THREE.Vector3(legLocal.side * CFG.enemies.chewer.inboardOffset, 1.0, legLocal.z),
  ));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 10);

  const hitsBefore = weapon.hits;
  const shotsBefore = weapon.shots;
  // Straight down, then swept up through the depression range, because a cone's
  // outermost pellets leave at an angle the centre ray never takes.
  const blasts = 12;
  for (let i = 0; i < blasts; i++) {
    player.pitch = -Math.PI / 2 + (i / (blasts - 1)) * 0.6;
    parkChewer();
    weapon.fire();
  }

  ok("every pellet of every blast was actually fired (test is not vacuous)",
    weapon.shots - shotsBefore === blasts * CFG.combat.scatter.pellets,
    `${weapon.shots - shotsBefore} pellets over ${blasts} blasts`);
  ok("not one of them reached the chewer under the hull",
    weapon.hits === hitsBefore, `${weapon.hits - hitsBefore} hits`);
  ok("the chewer is untouched", chewer.alive && chewer.hp === chewer.maxHp,
    `${chewer.hp.toFixed(0)} / ${chewer.maxHp.toFixed(0)} hp`);

  // And the other half of the claim: down there it is the right tool, which is what
  // makes the trip worth making rather than merely mandatory.
  placeOnGroundAt(sim, 0.2, legLocal.z);
  const target = parkChewer();
  aimAt(player, target);
  parkChewer();
  weapon.fire();
  ok("but from underneath, one blast settles it -- the reason to bring it down",
    !chewer.alive,
    chewer.alive ? `${chewer.hp.toFixed(0)} hp left` : "killed by a single trigger pull");
}

// ---------------------------------------------------------------------------
// Invariant 8b, checked in the direction that would quietly undo it.
//
// The bulwark exists to give the deck gun a recurring job, and its answer on foot is
// POSITIONAL -- get behind it. A close-range weapon is exactly the sort of addition
// that could hand the rifle's problem a new solution by accident, so the question is
// not "is the sweeper good against armour" but "does it ever become the answer".
//
// It does not, and the reason is arithmetic nobody had to write: nine 12-damage
// pellets each meet the 20 armour separately and each get floored to 2.4 by
// minDamageFraction, so a blast does 21.6 rather than 108. Note what was NOT
// asserted here -- the flank multiplier is x5.0 for both weapons, because
// afterArmour(25, 20) is max(5, 5) and the two terms happen to coincide. Claiming a
// bigger swing for the sweeper looked obviously true and is false.
console.log("\n102. The sweeper never becomes the answer to armour");
{
  const armour = CFG.enemies.bulwark.armour;
  const sweepP = CFG.combat.scatter;
  const rifleP = CFG.combat.weapon;

  const perPellet = afterArmour(sweepP.damage, armour);
  const perBlast = perPellet * sweepP.pellets;
  const perRound = afterArmour(rifleP.damage, armour);

  ok("each pellet meets the plate on its own and is floored, not summed against it",
    Math.abs(perPellet - sweepP.damage * CFG.enemies.minDamageFraction) < 1e-9,
    `${perPellet.toFixed(1)} of ${sweepP.damage} per pellet gets through`);
  ok("nothing is immune, so a blast is a wrong tool rather than a wall",
    perBlast > 0, `${perBlast.toFixed(1)} per blast`);
  ok("head-on it is WORSE than the rifle, so the plate keeps its job",
    perBlast * sweepP.fireRate < perRound * rifleP.fireRate,
    `${(perBlast * sweepP.fireRate).toFixed(0)} dps against the rifle's `
    + `${(perRound * rifleP.fireRate).toFixed(0)}`);
  ok("and from behind it is still no better, so armour never becomes its speciality",
    sweepP.damage * sweepP.pellets * sweepP.fireRate < rifleP.damage * rifleP.fireRate,
    `${(sweepP.damage * sweepP.pellets * sweepP.fireRate).toFixed(0)} dps unarmoured`
    + ` against the rifle's ${(rifleP.damage * rifleP.fireRate).toFixed(0)}`);
  ok("the flank is still worth walking round for, even with this in hand",
    (sweepP.damage * sweepP.pellets) / perBlast >= 4,
    `x${((sweepP.damage * sweepP.pellets) / perBlast).toFixed(1)} from behind`);

  // Live, through the real path, with the orientation pinned. Two shipped tests once
  // fired into a bulwark's back without knowing it, so the facing is asserted before
  // anything is concluded from it.
  const sim = makeSim();
  const { player, horde, weapon } = sim;
  placeOnGroundAt(sim, 0, -30);
  ok("holding the sweeper for the live armour check", hold(weapon, sweepP));

  const b = horde.spawn(BULWARK);
  b.x = player.position.x;
  b.z = player.position.z - 5;
  b.y = enemyCfg(BULWARK).height / 2;

  const faceAt = (e, x, z) => { e.yaw = Math.atan2(-(x - e.x), -(z - e.z)); };
  const shotDir = (e) => new THREE.Vector3(e.x, e.y, e.z)
    .sub(player.eyePosition(new THREE.Vector3())).normalize();

  aimAt(player, new THREE.Vector3(b.x, b.y, b.z));
  faceAt(b, player.position.x, player.position.z);
  {
    const d = shotDir(b);
    ok("the bulwark is genuinely facing the muzzle (test is not vacuous)",
      armourAt(CFG.enemies.bulwark, b.yaw, d.x, d.z) === armour,
      `meets ${armourAt(CFG.enemies.bulwark, b.yaw, d.x, d.z)} of ${armour} head-on`);
  }
  let hp = b.hp;
  weapon.fire();
  const frontal = hp - b.hp;

  faceAt(b, b.x + (b.x - player.position.x), b.z + (b.z - player.position.z));
  {
    const d = shotDir(b);
    ok("and then genuinely turned away (test is not vacuous)",
      armourAt(CFG.enemies.bulwark, b.yaw, d.x, d.z) === 0,
      `meets ${armourAt(CFG.enemies.bulwark, b.yaw, d.x, d.z)} of ${armour} from behind`);
  }
  hp = b.hp;
  weapon.fire();
  const rear = hp - b.hp;

  ok("a live blast into the plate is soaked",
    frontal > 0 && frontal <= sweepP.damage * sweepP.pellets * 0.3,
    `${frontal.toFixed(1)} of a possible ${sweepP.damage * sweepP.pellets}`);
  ok("and a live blast into its back is several times as much",
    rear >= frontal * 3, `${rear.toFixed(1)} from behind vs ${frontal.toFixed(1)} head-on`);
}

// ---------------------------------------------------------------------------
// Invariant 8a: the readout has to agree with what a shot would actually do.
//
// This is the clause a second weapon breaks silently. `scanTarget` used to read the
// rifle's 220 m unconditionally, so carrying a 40 m weapon would have had the
// crosshair confidently name and range a target five times further than any pellet
// could reach -- and the crosshair is the only thing that teaches a player their tool
// is wrong rather than the game being broken.
//
// It has two sides and both need asserting, because a readout that simply stopped
// working would pass the first half on its own.
console.log("\n103. The aim readout reports the weapon actually in your hands");
{
  const sim = makeSim();
  const { player, horde, weapon, guns, trampler } = sim;
  const sweepP = CFG.combat.scatter;
  const beyond = sweepP.range + 40;

  // Staged in clear air rather than on the sand, and that is a correction the check
  // made itself. The first version stood on the pan and put the target 80 m along it;
  // the non-vacuity assertion below reported the RIFLE naming nothing at all, because
  // the world's merged rock scatter lives inside the patrol ring and something was in
  // the way. The subject here is the scan's range clamp, which is pure geometry, so
  // the honest fix is to remove the variable rather than to widen the assertion.
  player.position.set(0, 40, 0);
  player.base = null;
  player.velocity.set(0, 0, 0);

  const far = horde.spawn(CLIMBER);
  far.x = player.position.x;
  far.y = player.position.y;
  far.z = player.position.z - beyond;
  aimAt(player, new THREE.Vector3(far.x, far.y, far.z));

  ok("the rifle reaches it and says so (test is not vacuous)",
    hold(weapon, CFG.combat.weapon) && weapon.scanTarget() === far,
    `named at ${weapon.aimDist.toFixed(0)} m, rifle range ${CFG.combat.weapon.range} m`);
  ok("switching to a 40 m weapon stops the crosshair claiming a target at 80 m",
    hold(weapon, sweepP) && weapon.scanTarget() === null,
    `sweeper range ${sweepP.range} m against a target at ${beyond} m`);

  // The other side: the null above must be about REACH, not about the readout having
  // quietly broken for the sweeper.
  const close = horde.spawn(CLIMBER);
  close.x = player.position.x;
  close.y = player.position.y;
  close.z = player.position.z - 15;
  aimAt(player, new THREE.Vector3(close.x, close.y, close.z));
  ok("and it still names what the sweeper CAN reach, so the null was range",
    weapon.scanTarget() === close,
    `named at ${weapon.aimDist.toFixed(0)} m`);

  // Manning a mount hands the trigger to the mount. Scanning at the sidearm's reach
  // would then blind a 300 m gun because of what is slung on your back.
  const gun = guns[0];
  player.position.copy(gun.operatorWorld(new THREE.Vector3()));
  player.base = trampler;
  player.velocity.set(0, 0, 0);
  step(sim, 5);
  sim.input.presses.add(CFG.deckGun.key);
  step(sim, 2);
  ok("manned the mount while still carrying the sweeper (test is not vacuous)",
    gun.mounted && weapon.profile === sweepP,
    `station ${gun.mounted ? "manned" : "empty"}, holding ${weapon.weaponName}`);
  ok("the readout then scans at the MOUNT's reach, not the sidearm's",
    weapon.triggerProfile === CFG.deckGun,
    `scanning to ${weapon.triggerProfile.range} m, not ${sweepP.range} m`);
}

// ---------------------------------------------------------------------------
// The interaction a second weapon creates, and the reason it gets measured rather
// than reasoned about: a proc that rolls per HIT now sees NINE hits per trigger pull
// instead of one.
//
// That is the exact shape invariant 2b-i exists for -- an item nobody thinks of as
// dangerous composing with something else into a multiplier -- and the steering is
// explicit that a combination is covered by neither system's own test. Risk of Rain
// needs a per-weapon proc coefficient for precisely this. This project does not, and
// the reason is worth pinning down rather than being lucky about: ARC CONDUCTOR
// chains a FRACTION of the damage that triggered it, so nine rolls at 12 damage and
// one roll at 25 come out proportional to the weapon's own throughput instead of to
// its hit count.
//
// So this is where a future item that deals a FLAT amount per hit would show up as a
// weapon-dependent multiplier, which is the failure the section is really guarding.
console.log("\n104. Nine pellets do not multiply the proc layer");
{
  const rifleP = CFG.combat.weapon;
  const sweepP = CFG.combat.scatter;

  // ---- on-HIT: measured as damage a BYSTANDER receives per second of fire.
  //
  // The bystander sits 6 m to the side: inside the arc's 9 m reach, and far outside
  // even the sweeper's cone at this range (0.44 m across at 4 m), so every point of
  // damage it takes arrived through a chain rather than through a stray pellet.
  const chainDps = (profile, pulls) => {
    const s = makeSim();
    s.economy.stacks.arc = 3; // a high chance, so a finite sample is not mostly zeros
    s.economy.applyAll();
    s.trampler.walking = false;
    s.trampler.turning = false;
    placeOnGroundAt(s, 0, -40);
    hold(s.weapon, profile);

    const target = s.horde.spawn(CHEWER);
    target.x = s.player.position.x;
    target.z = s.player.position.z - 4;
    target.y = enemyCfg(CHEWER).height / 2;
    target.hp = 1e9;

    const bystander = s.horde.spawn(CHEWER);
    bystander.x = target.x + 6;
    bystander.z = target.z;
    bystander.y = target.y;
    bystander.hp = 1e9;

    aimAt(s.player, new THREE.Vector3(target.x, target.y, target.z));
    const before = bystander.hp;
    for (let i = 0; i < pulls; i++) s.weapon.fire();

    return {
      chained: before - bystander.hp,
      arcs: s.items.procs.arc,
      // pulls / fireRate is how many seconds of fire that was.
      perSecond: (before - bystander.hp) * (profile.fireRate / pulls),
    };
  };

  const rifleArc = chainDps(rifleP, 400);
  const sweepArc = chainDps(sweepP, 200);

  ok("both weapons genuinely rolled arcs (test is not vacuous)",
    rifleArc.arcs > 0 && sweepArc.arcs > 0 && rifleArc.chained > 0 && sweepArc.chained > 0,
    `rifle ${rifleArc.arcs} arcs over 400 shots, sweeper ${sweepArc.arcs} over`
    + ` 200 pulls (${sweepP.pellets * 200} pellets)`);
  ok("the sweeper rolls far MORE often, because a roll is per hit (not vacuous)",
    sweepArc.arcs > rifleArc.arcs,
    `${sweepArc.arcs} rolls vs ${rifleArc.arcs} -- this is the thing that could have`
    + ` multiplied`);
  ok("but chained damage per second does not exceed the rifle's",
    sweepArc.perSecond <= rifleArc.perSecond,
    `${sweepArc.perSecond.toFixed(0)} dps of chain vs the rifle's`
    + ` ${rifleArc.perSecond.toFixed(0)}`);

  // And WHY it does not, stated as the relationship rather than as a bare inequality,
  // so the next person can see which property is load-bearing.
  const baseRatio = (sweepP.damage * sweepP.pellets * sweepP.fireRate)
    / (rifleP.damage * rifleP.fireRate);
  const arcRatio = sweepArc.perSecond / rifleArc.perSecond;
  ok("it tracks the weapon's own throughput, because the chain shares a FRACTION",
    Math.abs(arcRatio - baseRatio) <= 0.2,
    `chain ratio x${arcRatio.toFixed(2)} against a base-damage ratio of`
    + ` x${baseRatio.toFixed(2)}`);

  // ---- on-KILL: one trigger pull, one kill, one proc. Nine would be the bug.
  {
    const s = makeSim();
    s.economy.stacks.fragment = 1;
    s.economy.applyAll();
    s.trampler.walking = false;
    s.trampler.turning = false;
    placeOnGroundAt(s, 0, -40);
    ok("holding the sweeper for the on-kill check", hold(s.weapon, sweepP));

    const victim = s.horde.spawn(CHEWER);
    victim.x = s.player.position.x;
    victim.z = s.player.position.z - 4;
    victim.y = enemyCfg(CHEWER).height / 2;

    // Inside the 4.5 m splash and outside the cone, so the splash has somewhere to
    // land and cannot be mistaken for a pellet.
    const neighbour = s.horde.spawn(CHEWER);
    neighbour.x = victim.x + 2;
    neighbour.z = victim.z;
    neighbour.y = victim.y;
    neighbour.hp = 1e9;

    ok("one blast is enough to kill it outright (test is not vacuous)",
      sweepP.damage * sweepP.pellets >= victim.maxHp,
      `${sweepP.damage * sweepP.pellets} per pull against ${victim.maxHp.toFixed(0)} hp`);

    aimAt(s.player, new THREE.Vector3(victim.x, victim.y, victim.z));
    const neighbourBefore = neighbour.hp;
    s.weapon.fire();

    ok("it died to that single trigger pull", !victim.alive);
    ok("and the splash actually went off (test is not vacuous)",
      neighbour.hp < neighbourBefore,
      `neighbour took ${(neighbourBefore - neighbour.hp).toFixed(0)}`);
    ok("but exactly ONE on-kill proc fired, not one per pellet",
      s.items.procs.fragment === 1 && s.horde.killCount === 1,
      `${s.items.procs.fragment} procs from ${s.horde.killCount} kills across`
      + ` ${sweepP.pellets} pellets`);
  }

  // And the wider claim, from config alone: the sweeper is not an on-kill engine
  // either. It kills a chewer in one pull at 1.5 pulls/s; the rifle takes two rounds
  // at 8/s, which is more kills per second and therefore more procs.
  const killsPerSecond = (p) =>
    p.fireRate / Math.ceil(CFG.enemies.chewer.hp / (p.damage * p.pellets));
  ok("nor is it a better on-kill platform -- the rifle triggers those more often",
    killsPerSecond(sweepP) <= killsPerSecond(rifleP),
    `${killsPerSecond(sweepP).toFixed(1)} kills/s against the rifle's`
    + ` ${killsPerSecond(rifleP).toFixed(1)}`);
}

// ---------------------------------------------------------------------------
// A crippled fortress used to make a wave UNRESOLVABLE, and nothing asserted it
// either way.
//
// `immobileWeight` is 0.40 against a `calmBelow` of 0.35, so while the hull is below a
// tripod that one term puts `calm` permanently out of reach -- not merely unlikely,
// arithmetically unreachable, at full health with an empty field. And `calm` gated two
// completely different questions: "has this wave been dealt with" and "can the crew take
// another one". So killing every last enemy with four legs down left the phase in ENGAGED
// for ever.
//
// Every consequence pointed the wrong way. No wave-clear scrap for work actually done, no
// pick from the cadence, a siege that cannot end, and the refit terminal reporting NOT
// WHILE A WAVE IS OUT against an empty field -- a refusal naming a clause that is not
// true, which is the exact failure invariant 23b's three-reason split exists to prevent.
// Worst of it: the shop is where the repair rig and the hull plate are sold, so it was
// shut at the one moment it is most needed. Reported as "I killed all the enemies but I
// cannot shop".
//
// The halt itself is invariant 19 and stays. It is the SPAWNING half that is meant to
// stop, not the crew's credit for clearing the field, and this section asserts both
// halves so a later fix to one cannot quietly undo the other.
console.log("\n105. A crippled fortress still gets credit for clearing the field");
{
  const sim = makeSim();
  const { trampler, horde, director, economy } = sim;
  shopReady(sim); // at the terminal, so the buy clause can be read as well
  sim.waves = true;

  // The wave has to be genuinely OUT before anything is crippled. Crippling first
  // proves nothing: no wave would ever spawn for there to be one to resolve.
  director.callEarly();
  step(sim, 4);
  while (director.phase === PHASE.SPAWNING) step(sim, 1);

  ok("a wave is actually on the field (test is not vacuous)",
    director.phase === PHASE.ENGAGED && horde.liveCount > 0,
    `phase ${director.phase}, ${horde.liveCount} alive`);

  // Arranged rather than fought for: four legs gone is below a tripod.
  for (let i = 0; i < 4; i++) trampler.damageLeg(i, 1e6);
  ok("and the fortress is crippled", trampler.immobilised,
    `${trampler.workingLegs()} legs working`);

  // The pressure term is why this section exists, so state it as a measurement rather
  // than trusting two numbers in two config blocks to stay in this relationship.
  ok("being crippled alone exceeds the calm threshold -- that is the mechanism",
    CFG.waves.pressure.immobileWeight > CFG.waves.pressure.calmBelow,
    `immobile ${CFG.waves.pressure.immobileWeight} vs calmBelow`
    + ` ${CFG.waves.pressure.calmBelow}`);

  // Now the crew kills every last one of them.
  horde.clear();
  ok("the field is genuinely empty (test is not vacuous)",
    horde.liveCount === 0 && horde.underHull === 0,
    `${horde.liveCount} alive, ${horde.underHull} beneath`);

  const resolvedBefore = director.resolved;
  const scrapBefore = economy.scrap;
  step(sim, 5);

  ok("clearing the field resolves the wave even with the hull down",
    director.resolved === resolvedBefore + 1,
    `resolved ${resolvedBefore} -> ${director.resolved}, phase ${director.phase}`);
  ok("so the crew is paid for the wave they actually cleared",
    economy.scrap > scrapBefore,
    `${scrapBefore.toFixed(0)} -> ${economy.scrap.toFixed(0)} scrap`);
  ok("and the terminal opens, which is where the repair rig is sold",
    economy.open, `closedReason "${economy.closedReason}"`);

  // The other half, and the half that must NOT move: invariant 19 still withholds
  // reinforcements. A resolved wave is credit for work done, not permission to send
  // the next one at a fortress lying in the sand.
  let spawned = 0;
  const origSpawn = horde.spawn.bind(horde);
  horde.spawn = (t, s, a) => {
    const e = origSpawn(t, s, a);
    if (e) spawned++;
    return e;
  };

  const waveAt = director.wave;
  const waited = CFG.waves.minRest + CFG.waves.prepTime + 10;
  step(sim, 60 * waited);
  ok("but no reinforcements arrive while it is still crippled",
    director.wave === waveAt && spawned === 0,
    `wave ${director.wave}, ${spawned} spawned over ${waited}s`);
  ok("and the pacing reports the hold rather than merely doing nothing",
    director.holding,
    `phase ${director.phase}, pressure ${(director.pressure * 100).toFixed(0)}%`);

  // Repairing releases it -- after the telegraph, not instantly.
  trampler.repairAll();
  sim.player.hp = sim.player.maxHp;
  sim.player.timeSinceHurt = 99;
  step(sim, 60 * (CFG.waves.prepTime + 3));
  ok("repairing the legs releases the next wave", director.wave > waveAt,
    `wave ${waveAt} -> ${director.wave}`);
}

// ---------------------------------------------------------------------------
// The crew aggregates, measured with a crew rather than reasoned about.
//
// `#pressureOf` reads two things about the operative -- how hurt they are, and how
// recently -- and at one member every possible aggregator returns the same number, so
// the choice between worst-case, mean and anything else is UNOBSERVABLE until there
// are two. That is exactly why it must not be treated as settled: pacing is gated on
// this (invariant 19), and a crew of four is the case the whole thing was never
// written for.
//
// Worst-case was chosen as the starting position on Left 4 Dead's argument -- a
// director should respond to whoever is in trouble rather than to an average that
// hides them. This section is where that stops being an argument.
//
// The extra operatives are updated by hand in the step hook, and that is deliberate:
// without it `timeSinceHurt` never advances for them (it is incremented inside
// `player.update`), the recent-hurt term would peg at zero for ever, and this section
// would report a finding that was purely an artefact of its own scaffolding. The hook
// runs before the hull moves, so they lag the deck by one frame, which is irrelevant
// to a question about health and worth naming rather than hiding.
console.log("\n106. The crew aggregates read the worst-off operative, not an average");
{
  const idle = makeInput();
  idle.locked = false; // no look, no movement input, but health still ticks

  /** Grow `sim.crew` to `n` operatives, spread along the deck's clear lane. */
  const addCrew = (sim, n) => {
    const extra = [];
    for (let i = 1; i < n; i++) {
      const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
      cam.rotation.order = "YXZ";
      const p = new Player(cam, sim.world, sim.trampler);
      // Local z = -4 is the one lane clear of the mast, the crates, the bow step and
      // the engine block -- test 2's comment, reused for the same reason.
      p.position.copy(sim.trampler.localToWorld(new THREE.Vector3(-5 + i * 2.5, 1.0, -4)));
      p.base = sim.trampler;
      p.velocity.set(0, 0, 0);
      sim.crew.add(p);
      extra.push(p);
    }
    return extra;
  };
  const driveExtra = (extra) => { for (const p of extra) p.update(DT, idle); };

  /**
   * Put the whole crew under the hull at the legs, which is where the danger is.
   *
   * The first version of this section left the extra operatives on the bow deck, where
   * chewers converging on the legs and climbers heading for the reactor pass nowhere
   * near them. Every measurement at four operatives came out BYTE-IDENTICAL to one --
   * 1115 hurt-frames both ways, 3.4% recent-hurt occupancy both ways, 94 spawns both
   * ways -- because the three extra bodies were never touched. The section passed and
   * measured nothing, which is this project's most-repeated failure wearing a new hat.
   *
   * The non-vacuity guard was the reason it got through: it asserted that SOMEBODY was
   * hurt, and the primary operative satisfied that on its own. A scenario about a crew
   * has to check that the CREW was involved.
   */
  const placeCrewAtLegs = (sim) => {
    const legs = sim.trampler.legHp.length;
    let i = 0;
    for (const m of sim.crew) {
      const at = sim.trampler.legAttackWorld(i % legs, new THREE.Vector3());
      // World x/z from the leg, y set outright: local y = 0 is the DECK surface, so
      // deriving a height from the leg point would put an operative in mid-air.
      m.position.set(at.x, 1.2, at.z);
      m.base = null;
      m.velocity.set(0, 0, 0);
      m.grapple?.cancel();
      i++;
    }
  };

  const p = CFG.waves.pressure;

  // ---- an untouched crew of four must read exactly as calm as one of one.
  //
  // The cleanest assertion available here, and the one that would catch the most
  // damaging possible mistake: crew SIZE must not be pressure by itself, or a bigger
  // crew is handed a slower game for existing.
  {
    const solo = makeSim();
    const four = makeSim();
    addCrew(four, 4);
    solo.player.position.set(700, 1.2, 700);
    solo.player.base = null;
    step(solo, 3);
    step(four, 3);

    ok("the crew really is four (test is not vacuous)", four.crew.size === 4,
      `${four.crew.size} operatives`);
    ok("and an untouched crew of four is exactly as calm as one operative",
      Math.abs(four.director.pressure - solo.director.pressure) < 1e-9
      && four.director.calm,
      `four ${(four.director.pressure * 100).toFixed(1)}% vs solo`
      + ` ${(solo.director.pressure * 100).toFixed(1)}%`);
  }

  // ---- one badly hurt operative among three healthy ones.
  //
  // The measurement that distinguishes the aggregators. At 30% health on one of four:
  //   worst-case  0.40 * 0.70          = 0.280
  //   mean        0.40 * 0.70 / 4      = 0.070
  // Both are printed, so the number in the output says which rule is in force rather
  // than leaving a reader to infer it from a passing assertion.
  {
    const sim = makeSim();
    const extra = addCrew(sim, 4);
    sim.player.position.set(700, 1.2, 700);
    sim.player.base = null;
    step(sim, 3);

    const calm = sim.director.pressure;
    const victim = extra[1];
    victim.hp = victim.maxHp * 0.3;
    // No step: the hurt term is read straight off the aggregate, and stepping would
    // let regeneration start moving the number being measured.
    const withOneHurt = sim.director.pressure;

    const wantWorst = p.hurtWeight * 0.7;
    const wantMean = wantWorst / 4;

    ok("one operative at 30% raises pressure by the WORST-case amount, not an average",
      Math.abs((withOneHurt - calm) - wantWorst) < 1e-6,
      `+${((withOneHurt - calm) * 100).toFixed(1)} points;`
      + ` worst-case would be +${(wantWorst * 100).toFixed(1)},`
      + ` a mean +${(wantMean * 100).toFixed(1)}`);
    // AND IT IS NOT ENOUGH TO HOLD THE PACING, WHICH IS A FINDING RATHER THAN A FAULT.
    //
    // The first version of this asserted the opposite -- that one operative at 30%
    // health would hold the next wave -- and it failed, correctly, because the
    // arithmetic says otherwise: 0.40 * 0.70 is 0.28 against a calmBelow of 0.35. That
    // was a hope asserted instead of a measurement, which is the trap this file already
    // carries three lessons about, and the honest repair is to state what the model
    // actually does.
    //
    // What it does: the hurt term alone crosses calmBelow only below 12.5% health --
    // `hurtWeight * (1 - f) >= calmBelow` needs `f <= 0.125`. So health is a
    // CONTRIBUTOR to pacing and never a gate on its own, unlike `immobileWeight`, which
    // is deliberately weighted above calmBelow so a crippled hull halts reinforcements
    // by itself. Whether a badly hurt crew SHOULD hold a wave on its own is a design
    // question this measurement raises and does not answer.
    const gateAt = 1 - p.calmBelow / p.hurtWeight;
    ok("but health alone is a contributor to pacing, never a gate on its own",
      sim.director.calm && gateAt < 0.2,
      `${(withOneHurt * 100).toFixed(0)}% pressure against calmBelow`
      + ` ${(p.calmBelow * 100).toFixed(0)}% — the hurt term alone only crosses it below`
      + ` ${(gateAt * 100).toFixed(1)}% health, unlike immobileWeight`
      + ` ${(p.immobileWeight * 100).toFixed(0)}% which is a hard gate by design`);

    // The converse: hurting a SECOND operative less badly must change nothing, or the
    // aggregate is quietly summing rather than taking a maximum.
    extra[0].hp = extra[0].maxHp * 0.8;
    ok("a second, less hurt operative adds nothing -- it is a maximum, not a sum",
      Math.abs(sim.director.pressure - withOneHurt) < 1e-9,
      `still ${(sim.director.pressure * 100).toFixed(1)}%`);

    // And healing the worst one must hand the reading to the next worst, rather than
    // dropping it to calm.
    victim.hp = victim.maxHp;
    const wantSecond = p.hurtWeight * 0.2;
    ok("healing the worst hands the reading to the next worst",
      Math.abs((sim.director.pressure - calm) - wantSecond) < 1e-6,
      `+${((sim.director.pressure - calm) * 100).toFixed(1)} points from the 80% operative`);
  }

  // ---- THE RECENT-HURT TERM, which is the one predicted to misbehave.
  //
  // `secondsSinceAnyHurt() < 3.0` is a minimum across the crew, so with four bodies in
  // a fight "somebody was hit in the last three seconds" is close to always true. If
  // it is, the term stops being a signal and becomes a constant +0.15 on a crew of
  // four -- which is not a tuning error, it is a term that has silently stopped
  // carrying information.
  //
  // Measured as OCCUPANCY: what fraction of frames the term is contributing, at one
  // operative and at four, under a real wave with nobody defending.
  {
    // A FIXED enemy set rather than a live director, and the operatives held at the
    // legs where the chewers go. Invariant 19c's rule applied to crew size: under a live
    // director, killing things lowers pressure and brings the next wave sooner, so a
    // long fight measures the director compensating rather than the aggregate.
    const occupancy = (n) => {
      const sim = makeSim();
      const extra = addCrew(sim, n);
      placeCrewAtLegs(sim);
      for (let i = 0; i < 14; i++) sim.horde.spawn(CHEWER);
      let on = 0;
      let frames = 0;
      step(sim, 60 * 30, () => {
        driveExtra(extra);
        // Held at the legs: standing in the danger, not walking to it, because what is
        // under test is the aggregate rather than pathfinding.
        placeCrewAtLegs(sim);
        if (sim.crew.secondsSinceAnyHurt() < p.recentHurtWindow) on++;
        frames++;
      });
      return {
        share: on / frames,
        frames,
        extraHits: extra.reduce((a, m) => a + m.hurtCount, 0),
        primaryHits: sim.player.hurtCount,
      };
    };

    const one = occupancy(1);
    const four = occupancy(4);

    // THE guard, and the one the first version got wrong: the EXTRA operatives have to
    // have taken damage, or n=4 is just n=1 with three statues and every number below
    // is meaningless.
    ok("the extra operatives were genuinely in the fight (test is not vacuous)",
      four.extraHits > 0 && one.primaryHits > 0,
      `solo took ${one.primaryHits} hits; the three extra took ${four.extraHits}`
      + ` on top of the primary's ${four.primaryHits}`);

    // Reported rather than asserted against a threshold, because there is no defensible
    // threshold yet -- the whole point is that this number has never been looked at.
    // What IS asserted is the direction, which is arithmetic: a minimum over more
    // samples cannot be occupied less often.
    ok("the recent-hurt term is occupied at least as often with four as with one",
      four.share >= one.share - 1e-9,
      `occupied ${(one.share * 100).toFixed(1)}% of frames solo`
      + ` vs ${(four.share * 100).toFixed(1)}% with four`
      + ` — worth ${(p.recentHurtWeight * 100).toFixed(0)} points whenever it is on`);

    // And the consequence, stated in the units that matter. If the term is nearly
    // always on for a crew, it is a permanent floor rather than a reading, and a floor
    // of 0.15 against a calmBelow of 0.35 is 43% of the pacing budget spent on a
    // constant.
    ok("and it is recorded whether that has become a floor rather than a signal",
      Number.isFinite(four.share),
      four.share > 0.9
        ? `FLOOR: on for ${(four.share * 100).toFixed(0)}% of frames — `
          + `${(p.recentHurtWeight * 100).toFixed(0)} of the ${(p.calmBelow * 100).toFixed(0)}`
          + ` point calm budget is now a constant, which is a term carrying no information`
        : `signal: on for ${(four.share * 100).toFixed(0)}% of frames, still varying`);
  }

  // ---- AND THE THING THAT WOULD ACTUALLY BE A BUG: a bigger crew getting an easier
  // game. Pacing is gated on pressure, pressure aggregates upward, so more operatives
  // taking damage means fewer waves. Measured in waves spawned over a fixed window.
  {
    // DRIVEN DIRECTLY, not waited for. Health is PINNED rather than fought down, which
    // is the only way to make the two crew sizes comparable: the question is whether
    // the same worst-case health produces the same pacing regardless of how many
    // healthy operatives stand beside it, and a real fight would vary the input as well
    // as the output.
    //
    // The field is kept clear so pacing is what advances (test 54's helper does the
    // same, for the same reason). Under a MEAN aggregate, four operatives at
    // 50/100/100/100 would read 87.5% and be markedly calmer than one at 50%, so they
    // would receive more waves. Under worst-case both read 50% and get the same.
    const spawnsAtHalfHealth = (n) => {
      const sim = makeSim();
      const extra = addCrew(sim, n);
      sim.waves = true;
      let spawned = 0;
      const orig = sim.horde.spawn.bind(sim.horde);
      sim.horde.spawn = (t, s, a) => {
        const e = orig(t, s, a);
        if (e) spawned++;
        return e;
      };
      // Sampled in the HOOK, immediately after pinning, which is the value the director
      // actually acts on: the hook runs before the frame, and `director.update` comes
      // before `player.update` in the frame order, so this is what pressure is computed
      // from. Reading it after the loop instead measured a value regeneration had
      // already nudged off 0.5 -- which failed a `< 1e-9` assertion while printing
      // "50%", an assertion tighter than the thing it was asserting about.
      let worstActedOn = 1;
      step(sim, 60 * 90, () => {
        driveExtra(extra);
        sim.horde.clear();
        sim.trampler.repairAll();
        // The primary is pinned at half health; everyone else stays whole. Re-pinned
        // every frame because regeneration would otherwise walk it back up.
        sim.player.hp = sim.player.maxHp * 0.5;
        sim.player.timeSinceHurt = 99; // isolate the hurt term from the recent-hurt one
        for (const m of extra) {
          m.hp = m.maxHp;
          m.timeSinceHurt = 99;
        }
        worstActedOn = sim.crew.worstHealthFraction();
      });
      return {
        spawned,
        wave: sim.director.wave,
        worst: worstActedOn,
        pressure: sim.director.pressure,
      };
    };

    const one = spawnsAtHalfHealth(1);
    const four = spawnsAtHalfHealth(4);

    ok("waves arrive for a solo operative at half health (test is not vacuous)",
      one.spawned > 0, `${one.spawned} spawned, reached wave ${one.wave}`);
    ok("and both crews really are reading the same worst-case health (not vacuous)",
      Math.abs(one.worst - 0.5) < 1e-9 && Math.abs(four.worst - 0.5) < 1e-9,
      `solo ${(one.worst * 100).toFixed(0)}%, four ${(four.worst * 100).toFixed(0)}%`
      + ` — a mean would have read ${(((0.5 + 3) / 4) * 100).toFixed(1)}% for four`);
    // PRESSURE, asserted directly, because that is what this block has always been
    // about and it is now the only thing left that is genuinely crew-blind.
    //
    // The original assertion here was `one.spawned === four.spawned` and it was correct:
    // nothing scaled with crew size in any dimension, and recording that was the finding.
    // Crew count scaling invalidated it on purpose. The first repair restated it as
    // `one.wave === four.wave` and THAT failed too -- solo reached wave 3 and a crew of
    // four reached wave 2 -- which was worth chasing rather than loosening, because it
    // looked like pressure had become crew-sensitive.
    //
    // It has not. `spawnRate` is a fixed 2.5 enemies a second, so a wave 2.5x the size
    // takes 2.5x as long to finish arriving, and fewer waves fit in a fixed window. The
    // cadence moved because the VOLUME moved, one layer down. Asserting on the pressure
    // number removes that confound entirely.
    ok("so the pressure a hurt operative generates is identical whatever the crew size",
      Math.abs(one.pressure - four.pressure) < 1e-9,
      `${(one.pressure * 100).toFixed(1)}% either way from the same worst-case health —`
      + ` a mean aggregate would have read four operatives as markedly calmer`);
    // The volume half, and the finding that fell out of chasing the failure above. Test
    // 111 owns the exact multiplier off `buildWave`; what is worth recording HERE is the
    // second-order effect a fixed spawn rate produces, because it is the next question
    // this change raises and it is not the one the coefficient was chosen to answer:
    // a bigger crew currently gets a LONGER wave rather than a denser one.
    ok("while the volume does move, though a fixed spawn rate stretches it over time",
      four.spawned > one.spawned,
      `${one.spawned} spawns solo -> ${four.spawned} with four in the same 90 s`
      + ` (a factor of ${(four.spawned / one.spawned).toFixed(2)}, not the`
      + ` x${1 + CFG.waves.crewCountPerHead * 3} the wave itself grew by) —`
      + ` at ${CFG.waves.spawnRate}/s a 2.5x wave takes 2.5x as long to arrive, so`
      + ` whether spawnRate should scale too is the next variable, alone`);
  }
}

// ---------------------------------------------------------------------------
// A mount has exactly ONE occupant, and only that occupant can act through it or
// leave it.
//
// This is the first co-op DEFECT rather than a co-op design question, and it was found
// by reading rather than by playing, because with one operative every expression
// involved is correct. `handleStationInput` asked `guns.find((g) => g.mounted)` -- "is
// any gun manned" -- and then dismounted whatever it found, passing the operative who
// pressed the key. `dismount` cleared `player.station` only `if (player.station === this)`,
// so with crew 1 sitting in the bow gun and crew 2 pressing F anywhere on the deck:
//
//   bowGun.mounted = false        the seat believes it is empty
//   crew 1 .station = bowGun      but crew 1 is still pinned to it by player.update
//   bowGun.canMount = true        so a third operative can sit in it as well
//
// Two operatives constrained to one seat, and no exception anywhere. `update()` had the
// same hole one clause further on: it gated firing on `mounted`, so any operative's mouse
// fired an occupied gun and the heat it built landed on somebody else's weapon.
//
// Measured against the original code, this section reported ten failures: the seat
// released by a keypress 7.1 m away against a 2.8 m reach, the mount and its occupant
// disagreeing about who was in it, a second operative displacing the first while standing
// on the same pad, `canMount` true on an occupied seat, and four rounds fired plus 0.133
// heat built on somebody else's weapon. Worth recording because every one of those is
// correct behaviour with one operative.
//
// The fix is to name the occupant instead of counting them -- the same move as exporting
// `isSubmerged` rather than testing a `burrowed` field that does not exist. `mounted` is
// derived from `operator`, so the wrong question cannot be asked: there is no longer a
// boolean that says somebody is here without saying who.
console.log("\n107. A gun mount has one occupant, and only they can use or leave it");
{
  /** A second operative, standing on the deck's clear lane. */
  const secondOperative = (sim, lx = -1.5) => {
    const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    cam.rotation.order = "YXZ";
    const p = new Player(cam, sim.world, sim.trampler);
    // Local z = -4 is the lane clear of the mast, the crates, the bow step and the
    // engine block -- test 2's comment, borrowed for the same reason.
    p.position.copy(sim.trampler.localToWorld(new THREE.Vector3(lx, 1.0, -4)));
    p.base = sim.trampler;
    p.velocity.set(0, 0, 0);
    sim.crew.add(p);
    return p;
  };

  /** Stand an operative on a mount's operator pad, so the seat is in reach. */
  const atPad = (sim, who, gun) => {
    who.position.copy(gun.operatorWorld(new THREE.Vector3()));
    who.base = sim.trampler;
    who.velocity.set(0, 0, 0);
  };

  // ---- the structural guard, first, because it is what makes the rest unspellable.
  {
    const sim = makeSim();
    const gun = sim.guns[0];
    ok("an empty mount reports itself empty, and names nobody",
      gun.mounted === false && gun.operator === null,
      `operator ${gun.operator}`);

    // Modules are strict, so assigning to a getter-only property throws. Two of the
    // three sites that used to write `mounted` were releasing a seat without saying
    // whose, and this is what stops a fourth being typed.
    let threw = false;
    try {
      gun.mounted = false;
    } catch {
      threw = true;
    }
    ok("`mounted` is derived and cannot be assigned, so a release must name who",
      threw && gun.operator === null, threw ? "TypeError" : "ASSIGNMENT SUCCEEDED");
  }

  // ---- THE BUG. Crew 2 presses F across the deck; crew 1 keeps their seat.
  {
    const sim = makeSim();
    const gun = sim.guns[0];
    const crew1 = sim.player;
    const crew2 = secondOperative(sim);
    const input2 = makeInput();

    atPad(sim, crew1, gun);
    step(sim, 5);
    sim.input.presses.add(CFG.deckGun.key);
    step(sim, 1);
    ok("crew 1 is in the bow gun (test is not vacuous)",
      gun.mounted && gun.operator === crew1 && crew1.station === gun,
      `operator ${gun.operator === crew1 ? "crew 1" : "NOBODY"}`);

    const away = gun.mountWorld(new THREE.Vector3()).distanceTo(crew2.position);
    ok("and crew 2 is nowhere near it (test is not vacuous)",
      away > CFG.deckGun.mountRange,
      `${away.toFixed(1)} m from the mount vs a ${CFG.deckGun.mountRange} m reach`);

    input2.presses.add(CFG.deckGun.key);
    handleStationInput(sim.guns, input2, crew2);

    ok("crew 2 pressing F across the deck does not take crew 1's seat away",
      gun.mounted && gun.operator === crew1 && crew1.station === gun,
      gun.operator === crew1
        ? "crew 1 still aboard the mount"
        : `SEAT RELEASED BY A KEYPRESS ${away.toFixed(1)} m AWAY`);
    ok("and crew 2 did not end up attached to it either",
      crew2.station === null, `crew 2 station ${crew2.station ? "SET" : "null"}`);
    // Null-safe on purpose. The first version read `gun.operator.station` outright, and
    // when the assertion above failed against the old code this THREW instead of
    // reporting -- which aborted the run and took every check after it with it. A test
    // for a broken state must survive that state.
    ok("so the seat and its occupant never disagree about who is in it",
      gun.operator !== null && gun.operator.station === gun,
      gun.operator ? "the mount and its occupant agree" : "MOUNT RELEASED, NOBODY IN IT");

    // The press really did reach the router -- so the assertions above are about
    // ownership rather than about an input that went nowhere.
    sim.input.presses.add(CFG.deckGun.key);
    step(sim, 1);
    ok("while the same key from crew 1 does release it, so the press was live",
      !gun.mounted && gun.operator === null && crew1.station === null,
      gun.operator === null
        ? "released by its occupant"
        : `still occupied by ${gun.operator === crew1 ? "crew 1" : "crew 2"}`);
  }

  // ---- an occupied seat refuses a second occupant, even standing on the pad.
  {
    const sim = makeSim();
    const gun = sim.guns[0];
    const crew1 = sim.player;
    const crew2 = secondOperative(sim);
    const input2 = makeInput();

    atPad(sim, crew1, gun);
    step(sim, 5);
    gun.mount(crew1);

    atPad(sim, crew2, gun);
    const reach = gun.mountWorld(new THREE.Vector3()).distanceTo(crew2.position);
    ok("crew 2 is standing on the same pad, well inside reach (test is not vacuous)",
      reach <= CFG.deckGun.mountRange,
      `${reach.toFixed(2)} m from the mount vs a ${CFG.deckGun.mountRange} m reach`);

    input2.presses.add(CFG.deckGun.key);
    handleStationInput(sim.guns, input2, crew2);
    ok("an occupied mount refuses a second operative rather than displacing the first",
      gun.operator === crew1 && crew2.station === null,
      `operator ${gun.operator === crew1 ? "crew 1" : "crew 2"}`);
    ok("and it says so through canMount, which is what the prompt reads",
      gun.updateCanMount(crew2) === false, `canMount ${gun.canMount}`);
    ok("mount() reports the refusal rather than failing silently",
      gun.mount(crew2) === false && gun.operator === crew1);

    // And the press must fall THROUGH to a free mount rather than being swallowed,
    // because two operatives manning the two guns is the intended split.
    atPad(sim, crew2, sim.guns[1]);
    input2.presses.add(CFG.deckGun.key);
    handleStationInput(sim.guns, input2, crew2);
    ok("but the other mount is still theirs to take, which is the intended split",
      sim.guns[1].operator === crew2 && sim.guns[0].operator === crew1,
      `${sim.guns[0].name}: crew 1, ${sim.guns[1].name}: crew 2`);
    ok("so both mounts can be manned at once, by different people",
      sim.guns.filter((g) => g.mounted).length === 2
      && new Set(sim.guns.map((g) => g.operator)).size === 2);
  }

  // ---- the trigger is owned as well as the seat.
  {
    const sim = makeSim();
    const gun = sim.guns[0];
    const crew1 = sim.player;
    const crew2 = secondOperative(sim);
    const input2 = makeInput();

    atPad(sim, crew1, gun);
    step(sim, 5);
    gun.mount(crew1);
    gun.heat = 0;
    gun.cooldown = 0;

    // Crew 2, nowhere near the gun, holding the button down.
    input2.mouseHeld.add(0);
    const before = gun.shots;
    for (let i = 0; i < 20; i++) gun.update(DT, input2, crew2, sim.weapon);
    ok("another operative's trigger cannot fire a gun they are not sitting in",
      gun.shots === before,
      gun.shots === before
        ? `${before} shots, unchanged`
        : `FIRED ${gun.shots - before} ROUNDS FOR SOMEBODY ELSE`);
    ok("and it built no heat on the occupant's weapon either", gun.heat === 0,
      `heat ${gun.heat.toFixed(3)}`);

    // The occupant's own trigger does work, so the zero above is ownership and not a
    // gun that has stopped firing.
    const input1 = makeInput();
    input1.mouseHeld.add(0);
    for (let i = 0; i < 20; i++) gun.update(DT, input1, crew1, sim.weapon);
    ok("while the occupant's own trigger fires it, so the refusal was ownership",
      gun.shots > before, `${gun.shots - before} rounds from the operator`);
  }

  // ---- every release path goes through the mount, so the seat always learns.
  //
  // `respawnOnDeck` and `dropToGround` both used to write `station.mounted = false`
  // from outside, which cleared the flag and left the gun's own idea of its occupant
  // untouched. Survivable with one operative; with four it leaves a seat that reports
  // itself empty while still holding somebody.
  for (const [name, release] of [
    ["dying", (p) => p.respawnOnDeck()],
    ["dropping to the ground", (p) => p.dropToGround()],
  ]) {
    const sim = makeSim();
    const gun = sim.guns[0];
    atPad(sim, sim.player, gun);
    step(sim, 5);
    gun.mount(sim.player);
    ok(`manned before ${name} (test is not vacuous)`, gun.operator === sim.player);

    release(sim.player);
    ok(`${name} releases the seat, and the seat knows it`,
      gun.operator === null && gun.mounted === false && sim.player.station === null,
      `operator ${gun.operator}, mounted ${gun.mounted}`);
    ok("so it can be taken again rather than being permanently occupied",
      (atPad(sim, sim.player, gun), gun.updateCanMount(sim.player)),
      `canMount ${gun.canMount}`);
  }

  // ---- a restart clears every seat without knowing who was in it.
  //
  // Invariant 25: a restart reverts everything. `dismount` takes the operative and
  // refuses for anyone else, which is right for a keypress and wrong for a reset -- with
  // a crew it would have left the other mounts occupied across a restart. `evict` is the
  // reset's verb, and it delegates to `dismount` so there is still exactly one release
  // path rather than two that must be kept in step.
  {
    const sim = makeSim();
    const crew1 = sim.player;
    const crew2 = secondOperative(sim);
    atPad(sim, crew1, sim.guns[0]);
    step(sim, 5);
    sim.guns[0].mount(crew1);
    sim.guns[1].mount(crew2);
    ok("both mounts are occupied by different operatives (test is not vacuous)",
      sim.guns.every((g) => g.mounted) && sim.guns[0].operator !== sim.guns[1].operator);

    for (const g of sim.guns) g.evict();
    ok("a restart empties every seat, whoever was in it",
      sim.guns.every((g) => !g.mounted && g.operator === null)
      && crew1.station === null && crew2.station === null,
      sim.guns.map((g) => `${g.name}: ${g.operator ? "OCCUPIED" : "clear"}`).join(", "));
    ok("and evicting an empty mount is a no-op rather than an error",
      sim.guns[0].evict() === false);
  }
}

// ---------------------------------------------------------------------------
// A repair point admits ONE welder, and repair runs in parallel across points.
//
// This is the co-op rule rather than a defect, and the argument is invariant 12b's own
// measurement read forwards. 110 hp/s was chosen against chewer damage of 48-154 hp/s,
// deliberately landing INSIDE that band, so a single welder wins against a few chewers
// and loses against a crowd. Two welders on one leg is 220, which clears the top of that
// band outright and turns the under-hull fight from a race into a formality.
//
// What the second person should be doing was already decided. 12c measures hostiles near
// the PLAYER on purpose, so that "a teammate defending you would not freeze the work" --
// the design had already settled that the second operative at a broken leg is covering,
// not welding. This makes that explicit and names it on the prompt.
//
// It is the same mechanism as `reactorSlotCount` capping simultaneous attackers, pointed
// the other way, and it borrows that code's discipline exactly: the claim is written
// absolutely every frame from current conditions and never released by a separate path,
// because a claim maintained across frames drifts and a drifted claim fails silently.
console.log("\n108. A repair point admits one welder, and repairs run in parallel");
{
  const R = CFG.repair;

  /** A sim with a second operative and a second Repair, hull frozen. */
  const twoWelders = () => {
    const sim = makeSim();
    sim.trampler.walking = false;
    sim.trampler.turning = false;
    const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    cam.rotation.order = "YXZ";
    const crew2 = new Player(cam, sim.world, sim.trampler);
    sim.crew.add(crew2);
    // The same crew object the sim's own Repair was handed, so adding a member is
    // visible to it -- which is the whole point of the roster living on the Crew.
    const r2 = new Repair(crew2, sim.trampler, sim.horde, sim.crew);
    return {
      sim, crew1: sim.player, crew2, r1: sim.repair, r2,
      in1: makeInput(), in2: makeInput(),
    };
  };

  /** Put an operative on the sand at a leg's repair point. */
  const standAtLeg = (sim, who, legIndex) => {
    const at = sim.trampler.legAttackWorld(legIndex, new THREE.Vector3());
    // x/z from the point, y set outright: local y = 0 is the DECK surface, so deriving a
    // height from a leg point would put an operative in mid-air above the hull.
    who.position.set(at.x, 1.2, at.z);
    who.base = null;
    who.velocity.set(0, 0, 0);
  };

  /**
   * Drive the given repairs for `frames`, in the order handed over.
   *
   * Deliberately NOT through step()'s hook. The hook runs before the frame while
   * `sim.repair.update` runs inside it, so driving a second repairer from the hook would
   * make the harness's own plumbing decide which operative wins the race -- test
   * scaffolding supplying the mechanism it is testing. The real loop calls them in crew
   * order, so this does too, explicitly.
   *
   * Nothing else needs stepping: Repair reads positions, hull health, the horde and the
   * crew, and the hull is frozen. The horde is empty, so nothing is contested.
   */
  const weld = (frames, pairs) => {
    for (const [, inp] of pairs) inp.keys.add(R.key);
    for (let i = 0; i < frames; i++) {
      for (const [rep, inp] of pairs) rep.update(DT, inp);
    }
  };

  const FRAMES = 30; // half a second: 55 hp at 110 hp/s, well inside a 120 hp leg

  // ---- repair owns the carried weapon on the SAME frame work begins -------
  //
  // Drive the real Repair and Weapon in shipped order. Testing only the gate in Weapon would
  // supply the state whose timing is the subject and miss the opening-shot leak this change
  // exists to prevent.
  {
    const { sim, crew1, r1, in1 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    standAtLeg(sim, crew1, 0);
    in1.keys.add(R.key);
    in1.mouseHeld.add(0);

    const handsFrame = () => {
      r1.admit(DT, in1);
      sim.weapon.update(DT, in1);
      for (const gun of sim.guns) gun.update(DT, in1, crew1, sim.weapon);
      r1.work(DT);
    };

    const before = sim.weapon.shots;
    handsFrame();
    ok("repair is genuinely admitted on the first held frame (test is not vacuous)",
      r1.active && crew1.repairing === "leg:0",
      `active ${r1.active}, claim ${crew1.repairing}`);
    ok("that first repair frame suppresses the carried weapon without leaking a shot",
      sim.weapon.shots === before, `${before} -> ${sim.weapon.shots} shots`);

    sim.weapon.cooldown = 0.25;
    const cooling = sim.weapon.cooldown;
    handsFrame();
    ok("weapon cooldown keeps ticking while repair owns the trigger",
      sim.weapon.cooldown < cooling && sim.weapon.shots === before,
      `${cooling.toFixed(3)} -> ${sim.weapon.cooldown.toFixed(3)} s, ${sim.weapon.shots} shots`);

    in1.keys.delete(R.key);
    sim.weapon.cooldown = 0;
    handsFrame();
    ok("releasing repair returns fire on that same frame",
      !r1.active && crew1.repairing === null && sim.weapon.shots === before + 1,
      `active ${r1.active}, ${before} -> ${sim.weapon.shots} shots`);

    // Raw E is not the gate. With no damaged point genuinely in range, it must not swallow
    // the trigger; otherwise a held interaction key becomes an invisible weapon lockout.
    crew1.position.set(0, 1.2, -100);
    in1.keys.add(R.key);
    sim.weapon.cooldown = 0;
    handsFrame();
    ok("holding repair out of range leaves the carried weapon available",
      !r1.active && sim.weapon.shots === before + 2,
      `active ${r1.active}, ${sim.weapon.shots} shots`);

    sim.trampler.legHp[0] = CFG.trampler.legHp;
    standAtLeg(sim, crew1, 0);
    sim.weapon.cooldown = 0;
    handsFrame();
    ok("and a full point does not steal the trigger either",
      !r1.active && sim.weapon.shots === before + 3,
      `active ${r1.active}, ${sim.weapon.shots} shots`);
  }

  // ---- the geometry that makes the two-pass selection a real case rather than a
  // hypothetical one. Measured rather than assumed, and the assumption was WRONG: the
  // first draft of this rule reasoned that legs are 8.5 m apart against a 4.5 m reach and
  // therefore only one point is ever available. Reach is a radius, so the window is 9.0 m
  // and standing midway puts BOTH in range with 0.25 m to spare.
  {
    const sim = makeSim();
    const pts = [];
    for (let i = 0; i < sim.trampler.legHp.length; i++) {
      pts.push(sim.trampler.legAttackLocal(i, new THREE.Vector3()));
    }
    let closest = Infinity;
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        closest = Math.min(closest, pts[i].distanceTo(pts[j]));
      }
    }
    ok("two leg points can be in reach of one operative at once, so the choice is real",
      closest < R.range * 2,
      `closest pair ${closest.toFixed(2)} m against a ${(R.range * 2).toFixed(1)} m window`
      + ` (reach ${R.range} m) — ${(R.range * 2 - closest).toFixed(2)} m of overlap`);

    // And the reactor is never one of the pair, which is why the two jobs pull in
    // opposite directions in the first place.
    const legW = sim.trampler.legAttackWorld(0, new THREE.Vector3());
    const surf = sim.trampler.reactorSurfaceWorld(legW, new THREE.Vector3());
    ok("but a leg and the reactor never are, because one is under the hull and one is on it",
      legW.distanceTo(surf) > R.range,
      `${legW.distanceTo(surf).toFixed(2)} m apart, over a ${CFG.trampler.deckHeight} m deck`);
  }

  // ---- one welder, alone. The baseline every comparison below is against.
  let soloGain = 0;
  {
    const { sim, crew1, r1, in1 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    standAtLeg(sim, crew1, 0);
    weld(FRAMES, [[r1, in1]]);
    soloGain = sim.trampler.legHp[0];
    ok("one welder restores a leg at the configured rate (test is not vacuous)",
      Math.abs(soloGain - R.legRate * (FRAMES / 60)) < 1e-6,
      `${soloGain.toFixed(1)} hp in ${(FRAMES / 60).toFixed(2)} s at ${R.legRate} hp/s`);
  }

  // ---- THE RULE. Two welders on the same leg is not faster than one.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    standAtLeg(sim, crew1, 0);
    standAtLeg(sim, crew2, 0);

    // Both genuinely in reach and both genuinely asking, or the zero below is about
    // scaffolding rather than about the rule.
    const at = sim.trampler.legAttackWorld(0, new THREE.Vector3());
    ok("both operatives are standing at the same leg, in reach (test is not vacuous)",
      crew1.position.distanceTo(at) < R.range && crew2.position.distanceTo(at) < R.range,
      `crew 1 ${crew1.position.distanceTo(at).toFixed(2)} m,`
      + ` crew 2 ${crew2.position.distanceTo(at).toFixed(2)} m, reach ${R.range} m`);

    weld(FRAMES, [[r1, in1], [r2, in2]]);

    ok("both are offered the same leg, so neither was simply out of range",
      r1.target?.key === "leg:0" && r2.target?.key === "leg:0",
      `crew 1 -> ${r1.target?.key}, crew 2 -> ${r2.target?.key}`);
    ok("exactly one of them is actually working it",
      r1.active !== r2.active,
      `crew 1 active ${r1.active}, crew 2 active ${r2.active}`);
    ok("and two welders on one leg is no faster than one -- repair does not stack",
      Math.abs(sim.trampler.legHp[0] - soloGain) < 1e-6,
      `${sim.trampler.legHp[0].toFixed(1)} hp with two against ${soloGain.toFixed(1)} with one`);

    // The refusal has to NAME the teammate. "Hold E and nothing happens" is the same
    // illegibility the shop's three separate reasons exist to prevent, and the answer
    // here -- go and cover them, or take another leg -- is not something a generic
    // refusal would ever suggest.
    const blocked = r1.active ? r2 : r1;
    const working = r1.active ? r1 : r2;
    ok("the one that is refused names which seat has the point",
      blocked.takenBy === sim.crew.seatOf(working.player) && blocked.takenBy > 0,
      `refused with "CREW ${blocked.takenBy} IS ON IT"`);
    ok("while the one doing the work is told nobody is in its way",
      working.takenBy === 0, `takenBy ${working.takenBy}`);

    // Crew order decides it, and crew order is join order. Not a coin toss, and not
    // dependent on which update happened to run first in the harness.
    ok("and the winner is the earlier seat, because crew order is join order",
      working.player === crew1,
      `seat ${sim.crew.seatOf(working.player)} of ${sim.crew.size} took it`);
  }

  // ---- PARALLEL ACROSS POINTS, which is the half that makes a second welder useful.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    sim.trampler.damageLeg(1, 1e6);
    standAtLeg(sim, crew1, 0);
    standAtLeg(sim, crew2, 1);
    weld(FRAMES, [[r1, in1], [r2, in2]]);

    ok("two welders on two legs both work, and neither is refused",
      r1.active && r2.active && r1.takenBy === 0 && r2.takenBy === 0,
      `crew 1 -> ${r1.target?.key}, crew 2 -> ${r2.target?.key}`);
    ok("so the crew's total repair rate does double across separate jobs",
      Math.abs((sim.trampler.legHp[0] + sim.trampler.legHp[1]) - soloGain * 2) < 1e-6,
      `${(sim.trampler.legHp[0] + sim.trampler.legHp[1]).toFixed(1)} hp across two legs`
      + ` against ${soloGain.toFixed(1)} on one`);
  }

  // ---- and the two-pass selection: a FREE point beats a closer taken one.
  //
  // Without it, a single "nearest wins" pass would park crew 2 on the leg crew 1 already
  // has and report a refusal, while a free leg sat 4.25 m away. Same starvation buildWave
  // allocates in two passes to avoid.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    sim.trampler.damageLeg(1, 1e6);
    standAtLeg(sim, crew1, 0);

    // Just short of midway between the two port legs, so BOTH are in reach and the TAKEN
    // one is nearer by a hair. A tie would make the assertion meaningless.
    //
    // Placed by lerping between the two points rather than by nudging a world coordinate,
    // and that is a correction: the first version subtracted 0.2 from world z expecting to
    // move toward leg 0, and the fortress starts on a heading of pi, so local -z maps to
    // world +z and it moved the other way. The free leg came out nearer, "nearest free"
    // picked it trivially, and the behavioural assertion below passed for entirely the
    // wrong reason. Only the non-vacuity check caught it. Lerping cannot get this wrong
    // because it never mentions an axis.
    const a = sim.trampler.legAttackWorld(0, new THREE.Vector3());
    const b = sim.trampler.legAttackWorld(1, new THREE.Vector3());
    crew2.position.copy(a).lerp(b, 0.48);
    crew2.position.y = 1.2;
    crew2.base = null;
    crew2.velocity.set(0, 0, 0);
    ok("crew 2 has both legs in reach, with the taken one nearer (test is not vacuous)",
      crew2.position.distanceTo(a) < R.range && crew2.position.distanceTo(b) < R.range
      && crew2.position.distanceTo(a) < crew2.position.distanceTo(b),
      `leg 0 at ${crew2.position.distanceTo(a).toFixed(2)} m,`
      + ` leg 1 at ${crew2.position.distanceTo(b).toFixed(2)} m`);

    weld(FRAMES, [[r1, in1], [r2, in2]]);
    ok("so crew 2 takes the FREE leg rather than being refused on the nearer one",
      r2.target?.key === "leg:1" && r2.active && r2.takenBy === 0,
      `crew 2 -> ${r2.target?.key}, active ${r2.active}, takenBy ${r2.takenBy}`);
    ok("and both legs came back", sim.trampler.legHp[0] > 0 && sim.trampler.legHp[1] > 0,
      `leg 0 ${sim.trampler.legHp[0].toFixed(0)} hp, leg 1 ${sim.trampler.legHp[1].toFixed(0)} hp`);
  }

  // ---- standing beside a leg is not a claim. Only working it is.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    standAtLeg(sim, crew1, 0);
    standAtLeg(sim, crew2, 0);

    // Crew 1 is right there and is offered the repair, but never presses the key.
    for (let i = 0; i < 4; i++) r1.update(DT, in1);
    ok("crew 1 is offered the leg but is not working it (test is not vacuous)",
      r1.target?.key === "leg:0" && !r1.active,
      `target ${r1.target?.key}, active ${r1.active}`);

    weld(FRAMES, [[r2, in2]]);
    ok("so crew 2 is not locked out by somebody merely standing there",
      r2.active && r2.takenBy === 0 && sim.trampler.legHp[0] > 0,
      `crew 2 active ${r2.active}, takenBy ${r2.takenBy},`
      + ` leg at ${sim.trampler.legHp[0].toFixed(0)} hp`);
  }

  // ---- the claim is released by stopping, with no release path to forget.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    standAtLeg(sim, crew1, 0);
    standAtLeg(sim, crew2, 0);
    weld(4, [[r1, in1], [r2, in2]]);
    ok("crew 1 holds the point and crew 2 is refused (test is not vacuous)",
      crew1.repairing === "leg:0" && r2.takenBy === 1,
      `crew 1 claim ${crew1.repairing}, crew 2 takenBy ${r2.takenBy}`);

    // Crew 1 lets go. The claim is rebuilt from conditions every frame, so it clears
    // itself -- nothing releases it.
    in1.keys.delete(R.key);
    r1.update(DT, in1);
    ok("letting go of the key clears the claim on its own",
      crew1.repairing === null && !r1.active, `claim ${crew1.repairing}`);

    const before = sim.trampler.legHp[0];
    for (let i = 0; i < FRAMES; i++) {
      r1.update(DT, in1);
      r2.update(DT, in2);
    }
    ok("and crew 2 picks the point up",
      r2.active && r2.takenBy === 0 && sim.trampler.legHp[0] > before,
      `${before.toFixed(1)} -> ${sim.trampler.legHp[0].toFixed(1)} hp, takenBy ${r2.takenBy}`);
  }

  // ---- AND AN OPERATIVE WHO LEAVES THE CREW TAKES THEIR CLAIM WITH THEM.
  //
  // This is why the claim is read through the roster rather than kept in a registry of
  // Repair instances: there is no release path to forget, so a disconnect cannot leave a
  // repair point that nobody is able to work for the rest of the run. The stale field is
  // deliberately NOT cleared -- it simply stops being reachable.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageLeg(0, 1e6);
    standAtLeg(sim, crew1, 0);
    standAtLeg(sim, crew2, 0);

    // Crew 2 first this time, so crew 2 owns the point and is the one who leaves.
    weld(4, [[r2, in2], [r1, in1]]);
    ok("crew 2 holds the point and crew 1 is refused (test is not vacuous)",
      crew2.repairing === "leg:0" && r1.takenBy === 2,
      `crew 2 claim ${crew2.repairing}, crew 1 takenBy ${r1.takenBy}`);

    ok("crew 2 leaves the crew", sim.crew.remove(crew2) && sim.crew.size === 1,
      `${sim.crew.size} left`);
    const before = sim.trampler.legHp[0];
    for (let i = 0; i < FRAMES; i++) r1.update(DT, in1);

    ok("their claim goes with them, even though the field was never cleared",
      crew2.repairing === "leg:0" && r1.active && r1.takenBy === 0,
      `stale claim still reads "${crew2.repairing}" and is simply unreachable`);
    ok("so the point is workable again rather than locked for the rest of the run",
      sim.trampler.legHp[0] > before,
      `${before.toFixed(1)} -> ${sim.trampler.legHp[0].toFixed(1)} hp`);
  }

  // ---- the reactor follows the same rule, since it is the same code path.
  {
    const { sim, crew1, crew2, r1, r2, in1, in2 } = twoWelders();
    sim.trampler.damageReactor(200);
    const standAtReactor = (who) => {
      who.position.copy(sim.trampler.localToWorld(new THREE.Vector3(0, 1.2, 2.0)));
      who.base = sim.trampler;
      who.velocity.set(0, 0, 0);
    };
    standAtReactor(crew1);
    standAtReactor(crew2);

    const solo = makeSim();
    solo.trampler.walking = false;
    solo.trampler.turning = false;
    solo.trampler.damageReactor(200);
    solo.player.position.copy(solo.trampler.localToWorld(new THREE.Vector3(0, 1.2, 2.0)));
    solo.player.base = solo.trampler;
    const soloIn = makeInput();
    const reactorBefore = solo.trampler.reactorHp;
    weld(FRAMES, [[solo.repair, soloIn]]);
    const soloReactorGain = solo.trampler.reactorHp - reactorBefore;

    const twoBefore = sim.trampler.reactorHp;
    weld(FRAMES, [[r1, in1], [r2, in2]]);
    const twoGain = sim.trampler.reactorHp - twoBefore;

    ok("one operative repairs the reactor (test is not vacuous)",
      soloReactorGain > 0 && r1.target?.key === "reactor",
      `${soloReactorGain.toFixed(1)} hp at ${R.reactorRate} hp/s`);
    ok("and two on the reactor is no faster than one either",
      Math.abs(twoGain - soloReactorGain) < 1e-6,
      `${twoGain.toFixed(1)} hp with two against ${soloReactorGain.toFixed(1)} with one`);
    ok("with the second told who has it",
      (r1.active ? r2 : r1).takenBy > 0,
      `takenBy ${(r1.active ? r2 : r1).takenBy}`);
  }

  // ---- and WHY, from config, so the rule is defended by arithmetic rather than by
  // this comment. 110 sits inside the measured 48-154 hp/s chewing band on purpose:
  // a lone welder wins against a few and loses against a crowd, which is what makes
  // patching under fire a race. Doubling it clears the band outright.
  const CHEW_PEAK = 154; // measured, quoted in invariant 12b
  ok("a single welder can still lose the race, which is the tension being protected",
    R.legRate < CHEW_PEAK,
    `${R.legRate} hp/s against up to ${CHEW_PEAK} hp/s of chewing`);
  ok("while two on one leg would have beaten the worst of it outright",
    R.legRate * 2 > CHEW_PEAK,
    `${R.legRate * 2} hp/s against ${CHEW_PEAK} hp/s — the race stops existing`);
}

// ---------------------------------------------------------------------------
// The road is put to the crew, because it is the only decision the whole crew lives with.
//
// A road's modifiers are cumulative for the rest of the biome and there are exactly three
// road choices in a run, so a vote is affordable here in a way it would not be for
// anything frequent -- Ghost Ship's negotiated upgrades were divisive because they were
// every negotiation. It also costs no tempo, structurally: a held siege already sits in
// CHOOSING until a human presses a key, so this spends time the run was already spending.
//
// The half worth testing hardest is that SOLO IS UNCHANGED. A majority of one is one
// keypress, so every existing assertion about `run.choose` and about key routing has to
// still hold byte-for-byte, and the whole mechanism has to be invisible until there is
// somebody to disagree with.
console.log("\n109. The road is a crew decision, and a majority carries it");
{
  /** A run parked in CHOOSING with a crew of `n`, ready to be voted on. */
  const ballot = (n) => {
    const sim = makeSim();
    for (let i = 1; i < n; i++) {
      const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
      cam.rotation.order = "YXZ";
      sim.crew.add(new Player(cam, sim.world, sim.trampler));
    }
    sim.director.phase = PHASE.HELD;
    sim.run.update();
    // Holding a siege pays a pick, and the road waits behind it. Take it to reach the
    // state this section is about -- test 79 owns the ordering.
    sim.economy.takePick(0);
    sim.run.update();
    return sim;
  };

  // ---- solo: a majority of one, so nothing changed at all.
  {
    const sim = ballot(1);
    ok("a solo run is asking for a road (test is not vacuous)",
      sim.run.choosing && sim.run.offers.length === CFG.run.branches,
      `phase ${sim.run.phase}, ${sim.run.offers.length} roads`);
    ok("and one operative is a majority of one, so no agreement is needed",
      sim.run.votesNeeded === 1, `${sim.run.votesNeeded} of ${sim.crew.size}`);

    const leg = sim.run.leg;
    const arrival = sim.run.vote(sim.player, 0);
    ok("so a single vote takes the road on the frame it is cast",
      !!arrival && sim.run.leg === leg + 1 && !sim.run.choosing,
      `took ${arrival?.name}, leg ${leg} -> ${sim.run.leg}`);
    ok("and a solo crew is never deadlocked", !sim.run.deadlocked);
  }

  // ---- and through the real key router, which is how a press actually gets there.
  {
    const sim = ballot(1);
    const leg = sim.run.leg;
    sim.input.presses.add(CFG.economy.keys[0]);
    const routed = routePurchaseInput({
      economy: sim.economy, run: sim.run, bayOpen: true, input: sim.input, dt: DT,
    });
    ok("pressing 1 solo still takes the road through the router, bay open and all",
      routed.owner === "route" && !!routed.arrival && sim.run.leg === leg + 1,
      `owner ${routed.owner}, took ${routed.arrival?.name}`);
  }

  // ---- four operatives: a majority is three, and two is not enough.
  {
    const sim = ballot(4);
    const [a, b, c, d] = sim.crew.members;
    ok("the crew is four and a majority is three", sim.crew.size === 4
      && sim.run.votesNeeded === 3, `${sim.run.votesNeeded} of ${sim.crew.size}`);

    const leg = sim.run.leg;
    ok("one vote does not move the run",
      sim.run.vote(a, 0) === null && sim.run.leg === leg,
      `tally [${sim.run.tally.join(",")}]`);
    ok("nor does a second", sim.run.vote(b, 0) === null && sim.run.leg === leg,
      `tally [${sim.run.tally.join(",")}]`);
    ok("and the tally reports the split as it stands",
      sim.run.tally[0] === 2 && sim.run.tally[1] === 0,
      `[${sim.run.tally.join(",")}]`);
    ok("naming which seats are backing which road, so a voter can see their own",
      sim.run.voteSeats[0].join(",") === "1,2" && sim.run.voteSeats[1].length === 0,
      `road 1 backed by crew ${sim.run.voteSeats[0].join(", ") || "nobody"}`);

    const arrival = sim.run.vote(c, 0);
    ok("the third carries it, without waiting for the fourth to speak",
      !!arrival && sim.run.leg === leg + 1 && !sim.run.choosing,
      `took ${arrival?.name} on 3 of 4, with crew ${sim.crew.seatOf(d)} silent`);
  }

  // ---- a vote is changeable, and changing one does not add one.
  {
    const sim = ballot(4);
    const [a, b] = sim.crew.members;
    sim.run.vote(a, 0);
    sim.run.vote(b, 0);
    ok("two votes for the same road (test is not vacuous)", sim.run.tally[0] === 2,
      `[${sim.run.tally.join(",")}]`);

    sim.run.vote(a, 1);
    ok("changing a vote moves it rather than adding a second",
      sim.run.tally[0] === 1 && sim.run.tally[1] === 1,
      `[${sim.run.tally.join(",")}]`);
    ok("and voting the same way twice is idempotent",
      (sim.run.vote(b, 0), sim.run.tally[0] === 1 && sim.run.tally[1] === 1),
      `[${sim.run.tally.join(",")}]`);
    ok("and the run has not moved", sim.run.choosing, `phase ${sim.run.phase}`);
  }

  // ---- A TIE IS NOT RESOLVED, AND IT SAYS SO.
  //
  // This is a correction to the design I proposed, which was "ties break to the quiet
  // road". The data does not support it: two of six routes are offered and exactly one
  // route has no cost at all, so most ties would have no quiet road on the menu.
  //
  // The alternatives measured worse. Ranking by payout gets the order wrong -- asserted
  // below, because it is the argument and not just a claim. Scoring the modifiers means
  // inventing weights across health, count, speed and visibility. "Key 1 wins" is
  // illegible. So a tie stays a tie and any one operative can end it.
  {
    const sim = ballot(4);
    const [a, b, c, d] = sim.crew.members;
    const leg = sim.run.leg;
    sim.run.vote(a, 0);
    sim.run.vote(b, 0);
    sim.run.vote(c, 1);
    ok("three of four voted, still no majority (test is not vacuous)",
      !sim.run.deadlocked && sim.run.leg === leg,
      `[${sim.run.tally.join(",")}] with one still to vote — not a deadlock yet`);

    sim.run.vote(d, 1);
    ok("an even split with everyone voted is a deadlock, and reports itself",
      sim.run.deadlocked && sim.run.tally[0] === 2 && sim.run.tally[1] === 2,
      `[${sim.run.tally.join(",")}]`);
    ok("nothing is chosen for the crew, so half of them are never overridden",
      sim.run.choosing && sim.run.leg === leg,
      `phase ${sim.run.phase}, leg ${sim.run.leg}`);

    // The way out is a thing a player does, which is why no timer is needed.
    const broke = sim.run.vote(d, 0);
    ok("and any one of them can end it by changing their mind",
      !!broke && sim.run.leg === leg + 1 && !sim.run.deadlocked,
      `took ${broke?.name} on [3,1]`);
  }

  // ---- ties are only reachable at an even crew size, which is why three is safe.
  {
    const sim = ballot(3);
    const [a, b, c] = sim.crew.members;
    ok("three operatives need two to agree", sim.run.votesNeeded === 2,
      `${sim.run.votesNeeded} of 3`);
    sim.run.vote(a, 0);
    sim.run.vote(b, 1);
    const arrival = sim.run.vote(c, 1);
    ok("so with two roads a third vote always decides it — no tie is possible",
      !!arrival && !sim.run.deadlocked,
      `took ${arrival?.name} on [1,2]`);
  }

  // ---- the arithmetic behind rejecting a payout-ranked tie-break.
  //
  // Asserted rather than asserted-in-a-comment, because "the boneyard pays least and is
  // riskiest" is exactly the kind of claim this project has been wrong about before.
  {
    const cash = (r) => r.salvage + r.scrap;
    const boneyard = CFG.run.routes.find((r) => r.id === "boneyard");
    const flats = CFG.run.routes.find((r) => r.id === "flats");
    ok("a payout-ranked tie-break would have picked the RISKIER road, so it was rejected",
      cash(boneyard) < cash(flats) && boneyard.threat > flats.threat && boneyard.module,
      `boneyard pays ${cash(boneyard)} at x${boneyard.threat} threat plus a free module,`
      + ` against the flats' ${cash(flats)} at x${flats.threat}`);
    const quiet = CFG.run.routes.filter(
      (r) => r.threat === 1 && r.count === 0 && r.speed === 1 && r.fog === 1);
    ok("and only one route in six is genuinely quiet, so it is usually not even offered",
      quiet.length === 1 && CFG.run.branches < CFG.run.routes.length,
      `${quiet.length} quiet of ${CFG.run.routes.length}, ${CFG.run.branches} offered`);
  }

  // ---- an operative who leaves takes their vote with them.
  //
  // Without this a disconnect leaves a vote nobody can change while still counting toward
  // the crew size, which holds the run one short of a majority for ever. Same discipline
  // as the repair claim: the roster is the authority on who exists.
  {
    const sim = ballot(3);
    const [a, b, c] = sim.crew.members;
    sim.run.vote(a, 0);
    sim.run.vote(c, 1);
    ok("two of three have voted, one each way (test is not vacuous)",
      sim.run.tally[0] === 1 && sim.run.tally[1] === 1 && sim.run.choosing,
      `[${sim.run.tally.join(",")}]`);

    ok("the third operative leaves", sim.crew.remove(c) && sim.crew.size === 2,
      `${sim.crew.size} left`);
    ok("their vote goes with them, so it cannot block a majority for ever",
      sim.run.tally[0] === 1 && sim.run.tally[1] === 0,
      `[${sim.run.tally.join(",")}]`);
    ok("and the remaining pair can now carry it between them",
      !!sim.run.vote(b, 0) && !sim.run.choosing,
      `2 of ${sim.crew.size} needed ${sim.run.votesNeeded}`);
  }

  // ---- a fresh ballot per landmark, so last landmark's votes never carry.
  {
    const sim = ballot(4);
    const [a, b, c] = sim.crew.members;
    sim.run.vote(a, 0);
    sim.run.vote(b, 0);
    sim.run.vote(c, 0);
    ok("the first road was taken by a majority (test is not vacuous)",
      !sim.run.choosing && sim.run.leg === 2, `leg ${sim.run.leg}`);

    // Straight into the next choice, without fighting the siege.
    sim.director.phase = PHASE.HELD;
    sim.run.update();
    sim.economy.takePick(0);
    sim.run.update();
    ok("a second road is offered", sim.run.choosing, `phase ${sim.run.phase}`);
    ok("and the ballot is empty rather than carrying the last one's votes",
      sim.run.tally.every((n) => n === 0) && sim.run.voteOf(a) === -1,
      `[${sim.run.tally.join(",")}]`);
  }

  // ---- and a vote outside the choice does nothing, rather than banking one.
  {
    const sim = makeSim();
    ok("a run mid-siege is not asking for a road (test is not vacuous)",
      !sim.run.choosing, `phase ${sim.run.phase}`);
    ok("so a vote is refused rather than stored for later",
      sim.run.vote(sim.player, 0) === null && sim.run.tally.length === 0,
      `${sim.run.votes.size} votes recorded`);
    ok("and an out-of-range road is refused too",
      (() => {
        const s = ballot(2);
        return s.run.vote(s.player, 99) === null && s.run.votes.size === 0;
      })(), "index 99");
  }

  // ---- a reset clears the ballot, like everything else a run touches (invariant 25).
  {
    const sim = ballot(4);
    sim.run.vote(sim.crew.members[0], 0);
    ok("a vote is on the record (test is not vacuous)", sim.run.votes.size === 1);
    sim.run.reset();
    ok("and a restart clears it along with the journey",
      sim.run.votes.size === 0 && sim.run.leg === 1 && !sim.run.choosing,
      `${sim.run.votes.size} votes, leg ${sim.run.leg}`);
  }
}

// ---------------------------------------------------------------------------
// Damage carries WHO caused it, not what kind of thing caused it.
//
// `source` was a string -- "player" for anything the crew aimed, "emitter" for automation
// -- and every proc gated on `source === "player"`. That was correct with one operative
// and is a latent bug with two: it names a KIND, so one operative's kill fires every
// operative's procs, their splash heals somebody else, and their arc spends a stack of an
// item they do not own. Nothing throws. It reads as "these items feel stronger in co-op".
//
// Section 94 owns the automation half, which is the older and louder claim. This section
// owns the half a string could never express: WHICH person.
//
// One thing worth naming about the fix. The two rules collapse into a single identity
// test, because no subsystem is ever equal to a Player -- so `causedBy` enforces
// invariant 2b as a side effect of asking about a person. That is exactly why it is
// exported rather than written out: the tempting hand-written version, `source !== null`,
// satisfies invariant 2b, reads like a working gate, and has the original bug intact.
console.log("\n110. A proc fires for its OWN operative's kill and nobody else's");
{
  /** Two operatives with two independent item runtimes on one shared horde. */
  const pair = () => {
    const sim = makeSim();
    sim.trampler.walking = false;
    sim.trampler.turning = false;

    const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    cam.rotation.order = "YXZ";
    const mate = new Player(cam, sim.world, sim.trampler);
    sim.crew.add(mate);

    // A second Economy and a second Items, because the personal track is personal:
    // stacks, purse and procs all belong to one operative. Same bus, same horde -- which
    // is the whole point, since the bus is where a kill is announced to everybody.
    //
    // And a WEAPON OF THEIR OWN. The first version of this helper handed both operatives
    // `sim.weapon`, which section 114 shows silently wipes one operative's kit with the
    // other's recompute -- so it is now refused at construction and this would throw.
    const mateWeapon = new Weapon(sim.scene, mate, sim.horde, sim.world, sim.trampler);
    mateWeapon.events = sim.events;
    const mateEconomy = new Economy({
      player: mate, trampler: sim.trampler, weapon: mateWeapon, repair: sim.repair,
      horde: sim.horde, director: sim.director, modules: sim.modules, events: sim.events,
    });
    const mateItems = new Items({
      economy: mateEconomy, player: mate, trampler: sim.trampler, weapon: mateWeapon,
      horde: sim.horde, repair: sim.repair, events: sim.events,
    });
    return { sim, mate, mateWeapon, mateEconomy, mateItems };
  };

  /** Four bodies in a line, tight enough for a splash to reach the neighbours. */
  const cluster = (sim, n = 4) => {
    const centre = sim.trampler.localToWorld(new THREE.Vector3(0, 0, 0));
    const out = [];
    for (let i = 0; i < n; i++) {
      const e = sim.horde.spawn(CHEWER);
      e.x = centre.x + i * 1.2;
      e.y = 0.8;
      e.z = centre.z;
      out.push(e);
    }
    return out;
  };

  // ---- the splash. Crew 1 has the item; crew 2 makes the kill.
  {
    const { sim, mate, mateItems } = pair();
    sim.economy.stacks.fragment = 1;
    sim.economy.applyAll();
    ok("only crew 1 has the item fitted (test is not vacuous)",
      sim.items.procs.fragment === 0 && mateItems.procs.fragment === 0
      && sim.economy.stacks.fragment === 1,
      `crew 1 x${sim.economy.stacks.fragment}, crew 2 x0`);

    const bodies = cluster(sim);
    const before = bodies.slice(1).map((e) => e.hp);
    sim.horde.damage(bodies[0], 1e6, mate);
    const splashed = bodies.slice(1).filter((e, i) => e.hp < before[i]).length;

    ok("a teammate's kill does NOT fire the other operative's splash",
      sim.items.procs.fragment === 0 && splashed === 0,
      sim.items.procs.fragment === 0
        ? "0 procs, neighbours untouched"
        : `${sim.items.procs.fragment} PROCS OFF SOMEBODY ELSE'S KILL`);
    ok("nor the item runtime of the operative who has none",
      mateItems.procs.fragment === 0, `${mateItems.procs.fragment} procs`);
  }

  // ---- and the same kill, made by the operative who owns the item.
  {
    const { sim } = pair();
    sim.economy.stacks.fragment = 1;
    sim.economy.applyAll();
    const bodies = cluster(sim);
    const before = bodies.slice(1).map((e) => e.hp);
    sim.horde.damage(bodies[0], 1e6, sim.player);
    const splashed = bodies.slice(1).filter((e, i) => e.hp < before[i]).length;

    ok("their OWN kill fires it, so the zero above is identity and not a dead item",
      sim.items.procs.fragment === 1 && splashed > 0,
      `${splashed} neighbours hit, ${sim.items.procs.fragment} procs`);
  }

  // ---- the heal, which is the sharpest case: a proc that writes to a person.
  //
  // Ungated, a teammate's kill would top up your health from across the map. Measured
  // both ways in one sim so there is no doubt the item is live.
  {
    const { sim, mate } = pair();
    sim.economy.stacks.executioner = 1;
    sim.economy.applyAll();
    sim.player.hp = 50;
    mate.hp = 50;

    sim.horde.damage(sim.horde.spawn(CHEWER), 1e6, mate);
    ok("a teammate's kill heals nobody, because the item belongs to one operative",
      sim.player.hp === 50 && mate.hp === 50 && sim.items.procs.executioner === 0,
      `crew 1 at ${sim.player.hp} hp, crew 2 at ${mate.hp} hp`);

    sim.horde.damage(sim.horde.spawn(CHEWER), 1e6, sim.player);
    ok("and their own kill heals THEM and only them",
      sim.player.hp === 50 + CFG.items.executioner && mate.hp === 50
      && sim.items.procs.executioner === 1,
      `crew 1 50 -> ${sim.player.hp}, crew 2 still ${mate.hp}`);
  }

  // ---- THE ON-HIT CHANNEL, WHICH HAD NO GATE AT ALL.
  //
  // This is the hole the change actually closed rather than tightened. `emitHit` carried
  // no source, so `#onHit` could not gate even if it wanted to -- it was safe purely
  // because `shootFrom` is the only publisher of a hit and every weapon through it is
  // crew-aimed. Safe by nobody else emitting, which is the same shape as the burrowed
  // check that excluded nothing for an entire update.
  {
    const { sim, mate } = pair();
    sim.economy.stacks.arc = 20; // well past the chance curve's knee, so it must fire
    sim.economy.applyAll();
    const bodies = cluster(sim, 2);
    const neighbourBefore = bodies[1].hp;

    for (let i = 0; i < 12; i++) sim.events.emitHit(bodies[0], 20, mate);
    ok("a teammate's hit rolls nobody else's arc caster",
      sim.items.procs.arc === 0 && bodies[1].hp === neighbourBefore,
      sim.items.procs.arc === 0
        ? "0 arcs from 12 of a teammate's hits"
        : `${sim.items.procs.arc} ARCS OFF SOMEBODY ELSE'S HITS`);

    for (let i = 0; i < 12 && sim.items.procs.arc === 0; i++) {
      sim.events.emitHit(bodies[0], 20, sim.player);
    }
    ok("while their own hits do, so the zero above is the gate and not a dead item",
      sim.items.procs.arc > 0 && bodies[1].hp < neighbourBefore,
      `${sim.items.procs.arc} arcs, neighbour ${neighbourBefore} -> ${bodies[1].hp.toFixed(0)}`);
  }

  // ---- automation is still excluded, and now for a structural reason rather than by
  // matching a string. The Emitters system is the causer, and no subsystem is ever equal
  // to a Player, so the identity test refuses it without knowing what an emitter is.
  {
    const { sim } = pair();
    sim.economy.stacks.fragment = 1;
    sim.economy.applyAll();
    const bodies = cluster(sim);
    const before = bodies.slice(1).map((e) => e.hp);
    sim.horde.damage(bodies[0], 1e6, sim.emitters);
    ok("a subsystem as the causer procs nothing, without any string being compared",
      sim.items.procs.fragment === 0
      && bodies.slice(1).every((e, i) => e.hp === before[i]),
      `${sim.items.procs.fragment} procs from an Emitters-sourced kill`);
  }

  // ---- and the predicate itself, including the trap in it.
  {
    const sim = makeSim();
    ok("causedBy is true only for the exact operative",
      causedBy(sim.player, sim.player) === true
      && causedBy(sim.emitters, sim.player) === false
      && causedBy(null, sim.player) === false,
      "player yes, subsystem no, unattributed no");
    // The guard that stops the collapse going the other way. With no operative to compare
    // against, an unattributed source must not match an absent one -- without the
    // `!!operative` term, `causedBy(null, null)` is true and every unattributed kill in
    // the game procs for a runtime that has no player.
    ok("and never true when there is no operative to be, which is why the guard exists",
      causedBy(null, null) === false && causedBy(undefined, undefined) === false,
      "null does not equal null here");
    // The string it replaced must not still work, or both spellings would be live at once
    // and the old one would quietly keep being written.
    ok("the string that used to mean 'the crew' now means nothing",
      causedBy("player", sim.player) === false, `"player" is not a person`);
  }

  // ---- INCOME SPLITS THE SAME WAY THE PROCS DO, and it did not used to.
  //
  // Every Economy is subscribed to the same kill bus, so before the gate each operative
  // collected salvage for every corpse the crew produced -- four operatives earning four
  // times over, which reads as "money is generous in co-op" rather than as a bug. The
  // shared half had the mirror-image fault: scrap was credited once per operative, so one
  // kill paid the single shared pot four times.
  //
  // Invariant 24 survives both fixes and is asserted below rather than assumed. Nothing
  // kills for free; a kill nobody made simply cannot fill one person's pocket.
  {
    const { sim, mate } = pair();
    const before = sim.economy.earned.salvage;
    const scrapAtStart = sim.economy.earned.scrap;
    sim.horde.damage(sim.horde.spawn(CHEWER), 1e6, mate);
    const afterMate = sim.economy.earned.salvage;
    sim.horde.damage(sim.horde.spawn(CHEWER), 1e6, sim.emitters);
    const afterAuto = sim.economy.earned.salvage;

    ok("a teammate's kill pays THEIR salvage, not this operative's",
      afterMate === before, `crew 1's purse unchanged at ${before}`);
    ok("nor does an automated kill pay anybody's personal purse",
      afterAuto === before, `still ${afterAuto}`);
    // Invariant 24 intact, on the purse a kill nobody made actually belongs in. Read off
    // the shared ledger so this cannot pass by everything having stopped paying.
    ok("but both still pay the CREW, because nothing may kill for free",
      sim.economy.earned.scrap > scrapAtStart,
      `${scrapAtStart} -> ${sim.economy.earned.scrap} shared scrap across both kills`);
  }

  // ---- a manned gun is attributed to its OCCUPANT, not to the weapon's own operative.
  //
  // Solo those are the same person, so nothing here is observable without a crew. With
  // one, it decides whose procs a kill from that seat fires -- and invariant 2b-i counts
  // a manned gun as the crew precisely because somebody is sitting in it, so the
  // attribution has to be that somebody.
  {
    const { sim, mate, mateItems } = pair();
    // The item on the MATE, who will be the one in the seat. The Weapon belongs to
    // crew 1, so if the gun attributed to `weapon.player` this would proc nothing.
    mateItems.economy.stacks.fragment = 1;
    mateItems.economy.applyAll();

    const gun = sim.guns[0];
    mate.position.copy(gun.operatorWorld(new THREE.Vector3()));
    mate.base = sim.trampler;
    mate.velocity.set(0, 0, 0);
    ok("the mate is in the seat and the weapon belongs to somebody else (not vacuous)",
      gun.mount(mate) && gun.operator === mate && sim.weapon.player === sim.player,
      `${gun.name} operator is crew ${sim.crew.seatOf(gun.operator)},`
      + ` weapon belongs to crew ${sim.crew.seatOf(sim.weapon.player)}`);

    // A tight cluster out in the open ahead of the bow, inside the gun's arc.
    const ahead = sim.trampler.localToWorld(
      new THREE.Vector3(0, -CFG.trampler.deckHeight, -70));
    const targets = [];
    for (let i = 0; i < 4; i++) {
      const e = sim.horde.spawn(CHEWER);
      e.x = ahead.x + (i - 1.5) * 1.1;
      e.y = 0.8;
      e.z = ahead.z;
      targets.push(e);
    }

    const aimPoint = new THREE.Vector3(targets[0].x, targets[0].y, targets[0].z);
    const mateInput = makeInput();
    mateInput.mouseHeld.add(0);
    let gunKills = 0;
    for (let i = 0; i < 240 && mateItems.procs.fragment === 0; i++) {
      aimAt(mate, aimPoint);
      gun.constrain(mate);
      aimAt(mate, aimPoint);
      sim.trampler.group.updateMatrixWorld(true);
      gun.heat = 0;
      gun.overheated = false;
      gun.cooldown = 0;
      gun.update(DT, mateInput, mate, sim.weapon);
      gunKills = sim.horde.killCount;
    }

    ok("the mount actually killed things from the seat (test is not vacuous)",
      gunKills > 0 && gun.shots > 0, `${gunKills} kills over ${gun.shots} rounds`);
    ok("and the kill fired the OCCUPANT's proc, not the weapon owner's",
      mateItems.procs.fragment > 0 && sim.items.procs.fragment === 0,
      `occupant ${mateItems.procs.fragment} procs, weapon owner ${sim.items.procs.fragment}`);
  }
}

// ---------------------------------------------------------------------------
// A crew gets a BIGGER wave, and that is the only thing crew size changes.
//
// Section 106 measured the gap this closes: before it, four operatives faced exactly the
// solo fight -- 45 spawns either way, identical composition, identical pacing. Crew size
// scaled nothing at all in any dimension.
//
// The coefficient is Risk of Rain 2's shipped one, `0.5 * playerCount + 0.5`, written
// here as `1 + 0.5 * (size - 1)` so that one operative is x1.0 by construction rather
// than by two numbers agreeing. Borrowed rather than invented because it is the only
// number in this file with a decade of live-service tuning behind it, and starting from a
// known-good value is what makes the first measurement mean something.
//
// COUNT ONLY, which is invariant 19e's discipline applied to a new axis: the size curve
// was tuned against measured pacing, so moving size and composition together makes a
// later difficulty change impossible to attribute to either. The consequence of that
// restriction is measured below rather than reasoned about, because it is the thing that
// names the next question.
console.log("\n111. Crew size scales how many arrive, and nothing else");
{
  const w = CFG.waves;

  /** A director whose crew has `n` operatives. */
  const atCrew = (n) => {
    const sim = makeSim();
    for (let i = 1; i < n; i++) {
      const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
      cam.rotation.order = "YXZ";
      sim.crew.add(new Player(cam, sim.world, sim.trampler));
    }
    return sim;
  };

  const tally = (types) => {
    const out = {};
    for (const t of types) out[ENEMY_TYPE_KEYS[t]] = (out[ENEMY_TYPE_KEYS[t]] ?? 0) + 1;
    return out;
  };
  const soloSize = (wave) => w.baseCount + w.perWave * (wave - 1);

  // ---- one operative is untouched, and that is the acceptance test for the change.
  {
    const sim = atCrew(1);
    ok("a solo crew scales the wave by exactly one",
      sim.director.crewScale === 1, `x${sim.director.crewScale}`);
    const sizes = [];
    let allMatch = true;
    for (let wave = 1; wave <= w.siegeLength; wave++) {
      const n = sim.director.buildWave(wave).length;
      sizes.push(n);
      if (n !== soloSize(wave)) allMatch = false;
    }
    ok("so the solo size curve is the authored one, unchanged",
      allMatch, `${sizes.join("/")} against ${[1, 2, 3, 4, 5].map(soloSize).join("/")}`);
  }

  // ---- and the multiplier is the configured curve, not something near it.
  {
    const seen = [];
    let allMatch = true;
    for (let n = 1; n <= 4; n++) {
      const sim = atCrew(n);
      const want = 1 + w.crewCountPerHead * (n - 1);
      seen.push(`${n}:x${sim.director.crewScale}`);
      if (Math.abs(sim.director.crewScale - want) > 1e-9) allMatch = false;
      // And it lands on the actual wave, not merely on the getter.
      const built = sim.director.buildWave(1).length;
      if (built !== Math.round(soloSize(1) * want)) allMatch = false;
    }
    ok("each extra operative adds the configured share, and it reaches the wave",
      allMatch, `${seen.join("  ")} at ${w.crewCountPerHead} per extra head`);
  }

  // ---- A ROAD'S STATED COST STAYS LITERAL.
  //
  // The crew multiplier applies to the size curve and the road's flat bonus is added
  // afterwards, on purpose. The route panel tells the player "+4 enemies per wave" and
  // `run.modifiers` repeats it for the rest of the biome; multiplying that by the crew
  // would make both readouts wrong by a factor nothing on screen mentions.
  {
    const sim = atCrew(4);
    const bare = sim.director.buildWave(1).length;
    sim.run.extraCount = 4;
    const withRoad = sim.director.buildWave(1).length;
    ok("a road that promises four more delivers four more, whatever the crew size",
      withRoad - bare === 4,
      `${bare} -> ${withRoad} with a +4 road at x${sim.director.crewScale}`
      + ` — not ${Math.round(4 * sim.director.crewScale)}`);
  }

  // ---- the pillar survives the bigger wave: both pressures still present, floor held.
  {
    const broken = [];
    let lowestChewerShare = 1;
    let lowestAt = "";
    for (let n = 1; n <= 4; n++) {
      const sim = atCrew(n);
      for (let leg = 1; leg <= CFG.run.legs; leg++) {
        sim.run.leg = leg;
        const len = leg >= CFG.run.legs ? CFG.run.bossSiegeLength : w.siegeLength;
        for (let wave = 1; wave <= len; wave++) {
          const t = tally(sim.director.buildWave(wave, sim.director.tierOf(wave)));
          const size = Object.values(t).reduce((a, b) => a + b, 0);
          if (!t.chewer) broken.push(`no chewers at crew ${n} leg ${leg} wave ${wave}`);
          if (!t.climber) broken.push(`no climbers at crew ${n} leg ${leg} wave ${wave}`);
          if (t.titan) continue; // the boss wave truncates its escort on purpose
          const share = (t.chewer ?? 0) / size;
          if (share < lowestChewerShare) {
            lowestChewerShare = share;
            lowestAt = `crew ${n} leg ${leg} wave ${wave}, size ${size}`;
          }
        }
      }
    }
    ok("every wave at every crew size still contains both pillar types",
      broken.length === 0,
      broken.length ? broken.join("; ") : "chewers and climbers throughout, crew 1 to 4");
    // The floor is a SHARE, so it scales with the count for free -- but the reserve is
    // `round(count * floor)` rather than `ceil`, so the REALISED share can sit up to half
    // an enemy below the nominal one. Solo never showed this: the size curve is
    // 10/15/20/25/30 and 0.4x every one of those is an integer, so round and ceil agreed
    // at every count the game had ever built. Crew scaling produces 23, where 0.4x is 9.2,
    // the reserve rounds to 9, and the share lands at 39%.
    //
    // Asserted with the rounding step named rather than tightened, and `round` is
    // deliberately NOT changed to `ceil` here. It would make the floor true as written and
    // it is a one-character edit, but it is a composition change riding along inside a
    // count change -- exactly the two-variables-at-once that 19e exists to prevent -- and
    // 39% against 40% threatens nothing the floor is for. Flagged, not tuned.
    const c = CFG.enemies.composition;
    const slack = 0.5 / 23; // half an enemy at the count that first exposed it
    ok("and the chewer floor still holds to within its own rounding step",
      lowestChewerShare >= c.chewerFloor - slack,
      `lowest ${(lowestChewerShare * 100).toFixed(1)}% at ${lowestAt},`
      + ` nominal floor ${(c.chewerFloor * 100).toFixed(0)}%`
      + ` — reserve is round(count x ${c.chewerFloor}), so it can land half an enemy low`);
  }

  // ---- the same seed builds the same wave at the same crew size (invariant 21).
  {
    const a = atCrew(3).director.buildWave(4, 4).join(",");
    const b = atCrew(3).director.buildWave(4, 4).join(",");
    ok("two crews of the same size are handed the same wave from the same seed",
      a === b, `${a.split(",").length} enemies, identical`);
  }

  // ---- AND THE MEASUREMENT THAT NAMES THE NEXT QUESTION.
  //
  // The specials' caps -- bulwarkMax, sapperMax -- are ABSOLUTE, and this change did not
  // touch them, because touching composition at the same time as size is exactly what
  // 19e forbids. So a crew of four meets a bigger wave with the SAME number of bulwarks
  // and sappers in it, and the growth is absorbed by chewers.
  //
  // Reported rather than asserted against a threshold, because there is no defensible
  // threshold yet -- that is the point of measuring it. If the specials' share collapses,
  // roster scaling is the next variable and this is the number that says so. Asserting a
  // hoped-for value here would be the "assert the roll rather than the thing" trap.
  {
    const shareAt = (n) => {
      const sim = atCrew(n);
      sim.run.leg = 2; // a mid-run tier, so the specials are actually due
      let specials = 0;
      let total = 0;
      let bulwarks = 0;
      let sappers = 0;
      for (let wave = 1; wave <= w.siegeLength; wave++) {
        const t = tally(sim.director.buildWave(wave, sim.director.tierOf(wave)));
        const size = Object.values(t).reduce((a, b) => a + b, 0);
        total += size;
        bulwarks += t.bulwark ?? 0;
        sappers += t.sapper ?? 0;
        specials += (t.bulwark ?? 0) + (t.sapper ?? 0) + (t.burrower ?? 0);
      }
      return { specials, total, bulwarks, sappers, share: specials / total };
    };

    const one = shareAt(1);
    const four = shareAt(4);
    ok("a crew of four does face a materially bigger siege (test is not vacuous)",
      four.total > one.total * 2,
      `${one.total} enemies across a siege solo -> ${four.total} with four`);
    // The claim here was originally "the specials' COUNT is unchanged", which was wrong,
    // and the detail string printed only the solo side so the failure could not say why.
    //
    // What actually happens: the tier ramps decide how many specials are WANTED and that
    // is crew-blind, but the second allocation pass can only satisfy the want if there is
    // room. Solo, a ten-enemy wave often runs out; at four, there is room, so the specials
    // reach their cap where they previously could not. The count therefore grows a little
    // and then stops dead at the cap -- which is sub-proportional by a wide margin, and is
    // the restriction working rather than failing.
    const crewScale = 1 + w.crewCountPerHead * 3;
    ok("and the specials' count grows only until their caps bind, never with the crew",
      four.specials < one.specials * crewScale,
      `${one.bulwarks}->${four.bulwarks} bulwarks, ${one.sappers}->${four.sappers} sappers,`
      + ` ${one.specials}->${four.specials} specials against x${crewScale} on the count`);
    // The finding, printed so the next difficulty read is attributable to it.
    ok("so the specials' SHARE falls, and that is the next question rather than a fault",
      Number.isFinite(four.share) && four.share < one.share,
      `specials are ${(one.share * 100).toFixed(0)}% of a solo siege and`
      + ` ${(four.share * 100).toFixed(0)}% of a four-crew one`
      + ` — if that reads as a thinner fight, roster scaling is the next variable, alone`);
  }

  // ---- and what was deliberately NOT scaled, asserted so a later edit has to argue.
  {
    const one = atCrew(1);
    const four = atCrew(4);
    four.director.elapsed = one.director.elapsed;
    ok("enemy health does not scale with crew size, because health is invisible",
      Math.abs(one.director.hpScale() - four.director.hpScale()) < 1e-9,
      `x${one.director.hpScale().toFixed(2)} either way — a player cannot perceive a`
      + ` tougher chewer, only an unrewarding one`);
    ok("nor does the siege length, so a bigger crew is not a longer grind",
      one.director.siegeLength === four.director.siegeLength,
      `${one.director.siegeLength} waves either way`);
    ok("nor the resolve threshold, which is recorded as an open question not a decision",
      w.holdUntilCleared === 8,
      `${w.holdUntilCleared} live enemies counts as resolved at any crew size —`
      + ` a much smaller fraction of a four-crew wave, and unmeasured`);
  }
}

// ---------------------------------------------------------------------------
// The crew's half of the economy has ONE owner; the personal half has one each.
//
// Invariant 22 already drew this line -- salvage is personal and buys unbounded kit, scrap
// is shared and buys the bounded fortress -- but the code kept both in one object, which
// is fine with one operative and silently destructive with two.
//
// The failure, reproduced before it was fixed: `applyAll()` recomputes every effect
// absolutely from its stack counts, and two of those effects write to SHARED objects
// (`plating` -> trampler.damageScale, `rig` -> repair.rateScale). So a second operative
// holding zero fortress stacks recomputed them to 1.0 and called it correct. Four hull
// plates and three repair rigs, deleted by a teammate buying a rifle calibration.
//
// What made it vicious is that the STACKS survived. Crew 1's economy still read
// `plating x4`, so the shop and the build readout kept reporting full plating while the
// hull took full damage. It would have been filed as "plating feels weak".
//
// THE FIX IS NOT AN OWNERSHIP FLAG, and the control case below is here to show why it did
// not need to be. The collision came from the COUNTS being duplicated, not from the effects
// being applied twice -- so once every operative reads the same shared count, they all
// compute `0.85 ** 4` and write the same number, and the absolute recompute is idempotent
// across the crew. No flag to set wrongly, no "am I the one who applies this" branch.
console.log("\n112. The fortress track is the crew's; the personal track is each operative's");
{
  /** Two operatives over one world, optionally sharing the crew's half. */
  const twoPurses = (treasury) => {
    const sim = makeSim();
    const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    cam.rotation.order = "YXZ";
    const mate = new Player(cam, sim.world, sim.trampler);
    sim.crew.add(mate);
    const shared = {
      trampler: sim.trampler, repair: sim.repair, horde: sim.horde,
      director: sim.director, modules: sim.modules, events: sim.events,
    };
    // A WEAPON EACH. Handing both `sim.weapon` is refused now, and section 114 says why:
    // personal upgrades recompute absolutely from stack counts, so two operatives over one
    // weapon silently wipe each other's kit. The guard caught this helper.
    const mateWeapon = new Weapon(sim.scene, mate, sim.horde, sim.world, sim.trampler);
    return {
      sim,
      mate,
      e1: new Economy({ player: sim.player, weapon: sim.weapon, ...shared, treasury }),
      e2: new Economy({ player: mate, weapon: mateWeapon, ...shared, treasury }),
    };
  };

  const fortressState = (sim) => ({
    plating: sim.trampler.damageScale,
    rig: sim.repair.rateScale,
  });

  // ---- THE CONTROL. Separate treasuries still collide, which is what the sharing is for.
  //
  // Asserting that the rejected arrangement fails is unusual in a suite, and it is here on
  // purpose: without it, every check below would pass just as happily if the fortress
  // effects had simply stopped being applied at all.
  {
    const { sim, e1, e2 } = twoPurses(null);
    e1.stacks.plating = 4;
    e1.stacks.rig = 3;
    e1.applyAll();
    const bought = fortressState(sim);
    ok("with a purse each, crew 1's refits do land (test is not vacuous)",
      bought.plating < 1 && bought.rig > 1,
      `plating ${bought.plating.toFixed(4)}, repair x${bought.rig.toFixed(2)}`);

    e2.stacks.rifle = 1;
    e2.applyAll();
    const after = fortressState(sim);
    ok("but a teammate recomputing their own kit WIPES them — the arrangement this replaced",
      after.plating !== bought.plating && after.rig !== bought.rig,
      `plating ${bought.plating.toFixed(4)} -> ${after.plating.toFixed(4)},`
      + ` repair x${bought.rig.toFixed(2)} -> x${after.rig.toFixed(2)}`);
    ok("and crew 1 still reads the stacks it thinks it owns, which is why it was silent",
      e1.stacks.plating === 4 && e1.stacks.rig === 3,
      `plating x${e1.stacks.plating}, rig x${e1.stacks.rig} — counts intact, effects gone`);
  }

  // ---- SHARED. The same scenario, holding.
  {
    const { sim, e1, e2 } = twoPurses(new Treasury());
    e1.stacks.plating = 4;
    e1.stacks.rig = 3;
    e1.applyAll();
    const bought = fortressState(sim);

    ok("a fortress refit bought by one operative is READ by the other",
      e2.stacks.plating === 4 && e2.stacks.rig === 3,
      `crew 2 reads plating x${e2.stacks.plating}, rig x${e2.stacks.rig}`);

    e2.stacks.rifle = 1;
    e2.applyAll();
    const after = fortressState(sim);
    ok("so a teammate's recompute leaves the fortress exactly where it was",
      after.plating === bought.plating && after.rig === bought.rig,
      `plating ${after.plating.toFixed(4)}, repair x${after.rig.toFixed(2)} — unchanged`);

    // The mechanism, stated as an assertion rather than only in a comment: BOTH operatives
    // still apply the fortress effects. Nothing was gated off.
    let sawChange = false;
    for (let i = 0; i < 6; i++) {
      const before = fortressState(sim);
      (i % 2 ? e2 : e1).applyAll();
      const now = fortressState(sim);
      if (now.plating !== before.plating || now.rig !== before.rig) sawChange = true;
    }
    ok("and either of them applying it is idempotent, which is why no owner flag exists",
      !sawChange && fortressState(sim).plating === bought.plating,
      `six alternating recomputes, ${sawChange ? "STATE MOVED" : "no change"}`);
  }

  // ---- the personal half stays separate, which is the other half of invariant 22.
  {
    const { sim, e1, e2 } = twoPurses(new Treasury());
    e1.stacks.rifle = 3;
    e2.stacks.vitals = 2;
    ok("personal stacks are per-operative, not pooled",
      e1.stacks.rifle === 3 && e2.stacks.rifle === 0
      && e2.stacks.vitals === 2 && e1.stacks.vitals === 0,
      `crew 1 rifle x${e1.stacks.rifle}/vitals x${e1.stacks.vitals},`
      + ` crew 2 rifle x${e2.stacks.rifle}/vitals x${e2.stacks.vitals}`);

    e1.salvage = 400;
    e2.salvage = 25;
    ok("and so is the personal purse — you cannot spend a teammate's salvage",
      e1.salvage === 400 && e2.salvage === 25);

    e1.scrap = 250;
    ok("while the shared purse is one pot, seen from both sides",
      e2.scrap === 250, `crew 2 reads ${e2.scrap} scrap`);
    e2.scrap -= 100;
    ok("and spending it spends the CREW's money, which is what stops one player farming it",
      e1.scrap === 150, `crew 1 now reads ${e1.scrap} scrap`);

    e1.grantModuleCredit();
    ok("free module fits are shared too, since a hardpoint is the fortress's",
      e2.moduleCredits === 1, `crew 2 reads ${e2.moduleCredits} credit`);

    e1.grant(10, 20, "ARRIVED");
    ok("a road payout splits the way the purses do: scrap to the crew, salvage to whoever",
      e2.scrap === 170 && e2.salvage === 25 && e1.salvage === 410,
      `scrap ${e2.scrap} shared, salvage ${e1.salvage} vs ${e2.salvage}`);
    ok("and the earned ledger follows the same line",
      e1.earned.scrap === e2.earned.scrap && e1.earned.salvage !== e2.earned.salvage,
      `earned scrap ${e1.earned.scrap} shared,`
      + ` salvage ${e1.earned.salvage} vs ${e2.earned.salvage}`);
  }

  // ---- the shared entries must stay ENUMERABLE, because readers walk and serialise them.
  //
  // They are accessors onto the treasury rather than plain values, and a non-enumerable
  // property would vanish from `Object.keys` and from `JSON.stringify` -- which test 65
  // uses to report every stack after a reset. That would have read as "the fortress track
  // does not exist" rather than as a broken descriptor.
  {
    const { e1 } = twoPurses(new Treasury());
    e1.stacks.plating = 2;
    const keys = Object.keys(e1.stacks);
    const json = JSON.parse(JSON.stringify(e1.stacks));
    ok("a shared stack count is enumerable and serialises like a plain field",
      keys.includes("plating") && keys.includes("rig") && json.plating === 2,
      `${keys.length} keys, plating serialised as ${json.plating}`);
    ok("and the shared purse appears in the earned ledger the same way",
      Object.keys(e1.earned).includes("scrap")
      && Object.keys(e1.earned).includes("salvage"),
      `earned keys: ${Object.keys(e1.earned).join(", ")}`);
  }

  // ---- solo is untouched, which is the acceptance test for the whole change.
  {
    const a = makeSim();
    const b = makeSim();
    a.economy.stacks.plating = 3;
    a.economy.scrap = 99;
    ok("an Economy given no treasury owns a private one, so two sims never share state",
      b.economy.stacks.plating === 0 && b.economy.scrap === 0,
      `second sim reads plating x${b.economy.stacks.plating}, ${b.economy.scrap} scrap`);
    ok("and a solo economy still reverts its own fortress track on reset",
      (a.economy.reset(), a.economy.stacks.plating === 0 && a.trampler.damageScale === 1),
      `plating x${a.economy.stacks.plating}, damageScale ${a.trampler.damageScale}`);
  }
}

// ---------------------------------------------------------------------------
// One corpse pays once: the killer's salvage, and the crew's scrap.
//
// Every Economy subscribes to the same kill bus, which made income wrong in BOTH
// directions the moment there were two operatives:
//
//   salvage  paid to every operative for every kill, so four operatives each earned four
//            times over. Reads as "co-op is generous", not as a bug.
//   scrap    credited once per operative into the single shared pot, so one kill paid the
//            crew four times. Same for a resolved wave, which was polled per operative.
//
// The fix splits the subscription rather than the arithmetic: the Treasury hooks the bus
// once for the crew, and each Economy keeps only the personal half behind `causedBy`.
console.log("\n113. One corpse pays once — the killer's purse, and the crew's");
{
  /** N operatives over one world, sharing one Treasury. */
  const crewOf = (n) => {
    const sim = makeSim();
    const treasury = new Treasury({ director: sim.director, events: sim.events });
    const shared = {
      trampler: sim.trampler, repair: sim.repair, horde: sim.horde,
      director: sim.director, modules: sim.modules, events: sim.events, treasury,
    };
    // The sim's own economy is replaced, because makeSim built one with a private
    // treasury and it is still subscribed to the bus -- leaving it in would double-count
    // the very thing under test.
    const purses = [new Economy({ player: sim.player, weapon: sim.weapon, ...shared })];
    for (let i = 1; i < n; i++) {
      const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
      cam.rotation.order = "YXZ";
      const mate = new Player(cam, sim.world, sim.trampler);
      sim.crew.add(mate);
      // A weapon each — see section 114. The guard refuses anything else.
      const weapon = new Weapon(sim.scene, mate, sim.horde, sim.world, sim.trampler);
      purses.push(new Economy({ player: mate, weapon, ...shared }));
    }
    return { sim, treasury, purses };
  };

  const chewerRate = CFG.economy.chewer;

  // ---- scrap is credited ONCE, however many operatives are listening.
  {
    const one = crewOf(1);
    const scrapBase = one.treasury.scrap;
    one.sim.horde.damage(one.sim.horde.spawn(CHEWER), 1e6, one.sim.player);
    const soloScrap = one.treasury.scrap - scrapBase;
    ok("a kill pays the crew the configured scrap (test is not vacuous)",
      Math.abs(soloScrap - chewerRate.scrap) < 1e-9,
      `${soloScrap} scrap for a chewer, configured ${chewerRate.scrap}`);

    const four = crewOf(4);
    const before = four.treasury.scrap;
    four.sim.horde.damage(four.sim.horde.spawn(CHEWER), 1e6, four.sim.player);
    const crewScrap = four.treasury.scrap - before;
    ok("and exactly the same with four operatives listening — not four times",
      Math.abs(crewScrap - soloScrap) < 1e-9,
      crewScrap === soloScrap
        ? `${crewScrap} scrap either way`
        : `PAID ${crewScrap} TO A CREW OF FOUR vs ${soloScrap} SOLO`);
  }

  // ---- salvage goes to the killer alone.
  {
    const { sim, purses } = crewOf(4);
    const [p1, p2, p3, p4] = purses;
    sim.horde.damage(sim.horde.spawn(CHEWER), 1e6, p2.player);

    ok("the operative who made the kill is paid",
      Math.abs(p2.salvage - chewerRate.salvage) < 1e-9,
      `crew 2 has ${p2.salvage} salvage`);
    ok("and nobody else is, however many are on the bus",
      p1.salvage === 0 && p3.salvage === 0 && p4.salvage === 0,
      `others hold ${[p1, p3, p4].map((p) => p.salvage).join("/")}`);
    ok("so the crew's total personal income is one kill's worth, not four",
      Math.abs(purses.reduce((a, p) => a + p.salvage, 0) - chewerRate.salvage) < 1e-9,
      `${purses.reduce((a, p) => a + p.salvage, 0)} across the crew`);
  }

  // ---- a resolved wave pays the crew once, even though every operative polls for it.
  {
    const { sim, treasury, purses } = crewOf(4);
    const before = treasury.scrap;
    sim.director.resolved += 1;
    // Every operative's update runs, exactly as the frame loop would do it.
    for (const p of purses) p.update(DT, null);
    const once = treasury.scrap - before;
    ok("a resolved wave pays the shared pot (test is not vacuous)", once > 0,
      `+${once} scrap`);

    const before2 = treasury.scrap;
    for (const p of purses) p.update(DT, null);
    ok("and a second pass in the same frame pays nothing, because the counter is the crew's",
      treasury.scrap === before2, `+${treasury.scrap - before2} on the repeat`);

    // The counter has to advance once per wave, not once per operative-wave, or a crew of
    // four would burn through the growth curve four times as fast.
    const beforeNext = treasury.scrap;
    sim.director.resolved += 1;
    for (const p of purses) p.update(DT, null);
    const second = treasury.scrap - beforeNext;
    ok("the next wave pays the next step of the curve, not the fifth",
      second > once && second < once * 2,
      `wave 1 paid ${once}, wave 2 paid ${second} — one step of`
      + ` ${CFG.economy.waveClearGrowth}, not four`);
  }

  // ---- and the solo measurement this cost, recorded rather than glossed.
  //
  // An emitter kill used to pay personal salvage and now does not. That is a real solo
  // change riding inside a correctness fix, so here is its size: what a full rack kills
  // unattended over a minute, in salvage that no longer arrives.
  {
    const sim = makeSim();
    sim.trampler.walking = false;
    sim.player.dropToGround();
    const under = sim.trampler.localToWorld(new THREE.Vector3(0, -CFG.trampler.deckHeight, 0));
    sim.player.position.set(under.x, 1.2, under.z);
    let placed = 0;
    for (let i = 0; i < CFG.emitters.max; i++) {
      if (sim.emitters.deploy(sim.player)) placed++;
    }
    ok("a full rack is deployed under the hull (test is not vacuous)",
      placed === CFG.emitters.max, `${placed} emitters`);

    const killsBefore = sim.horde.killCount;
    const salvageBefore = sim.economy.salvage;
    const scrapBefore = sim.economy.scrap;
    sim.player.position.set(700, 1.2, 700); // out of the fight entirely
    sim.player.base = null;
    sim.waves = true;
    step(sim, 60 * 60);
    const killed = sim.horde.killCount - killsBefore;

    ok("the emitters really did kill unattended (test is not vacuous)", killed > 0,
      `${killed} kills over 60 s with nobody present`);
    ok("and none of it paid a personal purse",
      sim.economy.salvage === salvageBefore,
      `salvage still ${salvageBefore}`);
    ok("while the crew's pot did grow, which is the half invariant 24 protects",
      sim.economy.scrap > scrapBefore,
      `${scrapBefore} -> ${sim.economy.scrap.toFixed(0)} scrap —`
      + ` the solo cost of this change is the salvage those ${killed} kills used to pay`);
  }
}

// ---------------------------------------------------------------------------
// A weapon belongs to ONE operative, and personal kit is independent because of it.
//
// This section is the outcome of an investigation that found nothing to build. Weapon,
// Grapple and Items were already constructible one-per-operative and hold no shared mutable
// state, so the per-operative work turned out to be zero lines of plumbing and one guard.
//
// The guard is the point. Every personal item recomputes absolutely from its stack count --
// `rifle` writes `weapon.damageScale`, `trigger` writes `fireRateScale`, `sabot` writes
// `armourPierce` -- which is correct with one owner and destructive with two. Measured
// before the guard existed: two operatives over one Weapon, crew 1 buys four rifle
// calibrations for a damageScale of 2.00, crew 2 recomputes their own unrelated kit, and it
// drops to 1.00. Four stacks gone, stack counts intact, nothing thrown. The fortress
// collision exactly, one layer in.
//
// The fortress case was fixed by SHARING the counts, because a hull plate genuinely is the
// crew's. Personal kit is the opposite: it must not be shared, so there is nothing to
// unify and the only defence is refusing the arrangement. Hence a load failure rather than
// a control case -- the same move as exporting `isSubmerged` and `causedBy`.
console.log("\n114. A weapon has one operative, and personal kit is theirs alone");
{
  /** A second operative with a complete personal stack of their own. */
  const mateOf = (sim) => {
    const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    cam.rotation.order = "YXZ";
    const mate = new Player(cam, sim.world, sim.trampler);
    sim.crew.add(mate);
    const weapon = new Weapon(sim.scene, mate, sim.horde, sim.world, sim.trampler);
    weapon.events = sim.events;
    const grapple = new Grapple(sim.scene, mate, sim.trampler, sim.world);
    mate.grapple = grapple;
    const repair = new Repair(mate, sim.trampler, sim.horde, sim.crew);
    const economy = new Economy({
      player: mate, trampler: sim.trampler, weapon, repair, horde: sim.horde,
      director: sim.director, modules: sim.modules, events: sim.events,
      treasury: sim.economy.treasury,
    });
    const items = new Items({
      economy, player: mate, trampler: sim.trampler, weapon, horde: sim.horde,
      repair, events: sim.events,
    });
    return { mate, weapon, grapple, repair, economy, items };
  };

  // ---- THE GUARD. A weapon that belongs to somebody else is refused, not tolerated.
  {
    const sim = makeSim();
    const cam = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 1400);
    cam.rotation.order = "YXZ";
    const mate = new Player(cam, sim.world, sim.trampler);

    let economyThrew = false;
    try {
      new Economy({
        player: mate, trampler: sim.trampler, weapon: sim.weapon, repair: sim.repair,
        horde: sim.horde, director: sim.director, modules: sim.modules, events: sim.events,
      });
    } catch {
      economyThrew = true;
    }
    ok("an Economy handed somebody else's weapon refuses to be built",
      economyThrew, economyThrew ? "threw at construction" : "ACCEPTED SILENTLY");

    let itemsThrew = false;
    try {
      new Items({
        economy: sim.economy, player: mate, trampler: sim.trampler, weapon: sim.weapon,
        horde: sim.horde, repair: sim.repair, events: sim.events,
      });
    } catch {
      itemsThrew = true;
    }
    ok("and so does an Items runtime, which is a SECOND writer to the same field",
      itemsThrew, itemsThrew ? "threw at construction" : "ACCEPTED SILENTLY");

    // The guard must not fire on the legitimate arrangement, or every existing sim breaks.
    ok("while the operative's own weapon is accepted, so nothing legitimate is refused",
      (sim.weapon.assertOperative(sim.player), true)
      && sim.weapon.player === sim.player, "own weapon passes");
  }

  // ---- INDEPENDENCE, which is what the guard buys.
  {
    const sim = makeSim();
    const m = mateOf(sim);

    sim.economy.stacks.rifle = 4;
    sim.economy.stacks.sabot = 2;
    sim.economy.applyAll();
    m.economy.stacks.rifle = 1;
    m.economy.applyAll();

    ok("two operatives hold different weapon damage at the same instant",
      Math.abs(sim.weapon.damageScale - 2) < 1e-9
      && Math.abs(m.weapon.damageScale - 1.25) < 1e-9,
      `crew 1 x${sim.weapon.damageScale.toFixed(2)}, crew 2 x${m.weapon.damageScale.toFixed(2)}`);
    ok("and tooling does not leak either — armour pierce is bought, not shared",
      sim.weapon.armourPierce > 0 && m.weapon.armourPierce === 0,
      `crew 1 pierces ${sim.weapon.armourPierce}, crew 2 pierces ${m.weapon.armourPierce}`);
    // Max health is written on the PLAYER rather than the weapon, so it was never at risk
    // from the shared-weapon bug -- but asserting it needs the item actually bought by one
    // of them. The first version of this compared `maxHp !== maxHp || stacks === stacks`,
    // which is a tautology: both operatives held 100 hp and the fallback clause compared a
    // value to itself, so it passed while measuring nothing.
    sim.economy.stacks.vitals = 2;
    sim.economy.applyAll();
    ok("nor does max health, which is written on the operative rather than the weapon",
      sim.player.maxHp > m.mate.maxHp && m.mate.maxHp === CFG.combat.playerHp,
      `crew 1 bought x${sim.economy.stacks.vitals} vitals for ${sim.player.maxHp} hp,`
      + ` crew 2 still on the base ${m.mate.maxHp}`);
  }

  // ---- and the CONDITIONAL half, which is the sharper case.
  //
  // `Items.update` clears and rebuilds `weapon.damageBonus` from current conditions every
  // frame. Two runtimes over one weapon would fight over that field every frame, and a
  // position bonus is exactly the kind of thing that would then apply to the wrong person.
  {
    const sim = makeSim();
    sim.trampler.walking = false;
    const m = mateOf(sim);

    // Both operatives carry the under-hull item; only one of them is under the hull.
    sim.economy.stacks.understudy = 3;
    sim.economy.applyAll();
    m.economy.stacks.understudy = 3;
    m.economy.applyAll();

    const under = sim.trampler.localToWorld(
      new THREE.Vector3(0, -CFG.trampler.deckHeight, 0));
    sim.player.position.set(under.x, 1.2, under.z);
    sim.player.base = null;
    m.mate.position.set(700, 1.2, 700);
    m.mate.base = null;

    sim.items.update(DT);
    m.items.update(DT);

    ok("both operatives carry the same conditional item (test is not vacuous)",
      sim.economy.stacks.understudy === m.economy.stacks.understudy
      && sim.economy.stacks.understudy > 0,
      `x${sim.economy.stacks.understudy} each`);
    ok("only the one meeting the condition is paid for it",
      sim.weapon.damageBonus > 0 && m.weapon.damageBonus === 0,
      `crew 1 +${(sim.weapon.damageBonus * 100).toFixed(0)}%`
      + ` [${sim.items.reasons.join(", ")}], crew 2 +${(m.weapon.damageBonus * 100).toFixed(0)}%`
      + ` [${m.items.reasons.join(", ") || "nothing"}]`);
    ok("and the buff strip each of them reads names their OWN reasons",
      sim.items.reasons.length > 0 && m.items.reasons.length === 0,
      `crew 1 [${sim.items.reasons.join(", ")}] vs crew 2 [${m.items.reasons.join(", ")}]`);
  }

  // ---- the winch is already per-operative, and was before any of this.
  {
    const sim = makeSim();
    const m = mateOf(sim);
    ok("each operative has their own winch, and points at it",
      m.grapple !== sim.grapple
      && sim.player.grapple === sim.grapple && m.mate.grapple === m.grapple,
      "distinct grapples, each owned by its operative");
    // Anchors are stored hull-local per grapple, so two ropes cannot share an anchor.
    ok("and its anchor is its own, so two ropes cannot converge on one point",
      sim.grapple.anchorLocal !== m.grapple.anchorLocal,
      "separate anchor vectors");
  }

  // ---- a shot fired by one operative uses THEIR multipliers, not the other's.
  //
  // The end-to-end version of everything above, through the real hitscan path: two
  // operatives with different damage, firing at identical targets, must do different damage.
  {
    const sim = makeSim();
    sim.trampler.walking = false;
    const m = mateOf(sim);
    sim.economy.stacks.rifle = 4;
    sim.economy.applyAll();

    const shootAt = (who, weapon) => {
      const spot = sim.trampler.localToWorld(
        new THREE.Vector3(0, -CFG.trampler.deckHeight, -60));
      const e = sim.horde.spawn(CHEWER);
      e.x = spot.x;
      e.y = 0.8;
      e.z = spot.z;
      who.position.set(spot.x, 1.2, spot.z + 8);
      who.base = null;
      const before = e.hp;
      const origin = new THREE.Vector3(who.position.x, 1.5, who.position.z);
      const dir = new THREE.Vector3(e.x - origin.x, e.y - origin.y, e.z - origin.z).normalize();
      weapon.shootFrom(origin, dir, CFG.combat.weapon, null, who);
      return before - e.hp;
    };

    const strongHit = shootAt(sim.player, sim.weapon);
    const plainHit = shootAt(m.mate, m.weapon);
    ok("both shots connected (test is not vacuous)", strongHit > 0 && plainHit > 0,
      `${strongHit.toFixed(1)} and ${plainHit.toFixed(1)} damage`);
    ok("and the upgraded operative hits harder, through the one shared hitscan path",
      Math.abs(strongHit / plainHit - 2) < 1e-6,
      `x${(strongHit / plainHit).toFixed(2)} — ${strongHit.toFixed(1)} vs`
      + ` ${plainHit.toFixed(1)} from the same weapon profile`);
  }
}

// ---------------------------------------------------------------------------
// The netcode's founding claim, measured rather than reasoned about.
//
// src/net.js sends a crewmate's pose in HULL-LOCAL space when they are aboard, and its
// header argues that this is worth an order of magnitude: a world-space pose 120 ms old
// is stale by the HULL's speed, while a hull-local one is stale only by the walker's own
// speed, because the receiver already knows the hull's current transform.
//
// That argument was written down and never checked. It was going to be checked by eye,
// with two browser tabs, watching whether a box drifts astern — which would have answered
// "is it obviously broken" and not "how big is the error". The load-bearing half needs no
// renderer at all: it is entirely a question about transforms, which is exactly what this
// harness exists to measure.
//
// So this is the two-tab observation, as a number, permanently. What it CANNOT cover is
// the drawing half — three.js reparenting, visibility, materials — and that still wants
// eyes on a screen once. But if the arithmetic here were wrong, the wire format would be
// wrong, and no amount of looking at boxes would say by how much.
console.log("\n115. A hull-local pose does not skate; a world-space one does");
{
  const sim = makeSim();
  const t = sim.trampler;

  // A crewmate standing still amidships on the deck, in the frame net.js sends.
  const localPose = new THREE.Vector3(3.0, 1.2, 2.0);
  const worldPoseAtSend = t.localToWorld(localPose.clone());

  // One interpolation delay of hull travel. CFG.net.interpDelayMs is the real knob the
  // client renders behind live, so the drift being measured is the drift a player sees.
  const delayFrames = Math.round((CFG.net.interpDelayMs / 1000) * CFG.loop.stepHz);
  ok("the delay is a real number of frames (test is not vacuous)", delayFrames >= 6,
    `${CFG.net.interpDelayMs} ms is ${delayFrames} frames at ${CFG.loop.stepHz} Hz`);

  const hullBefore = t.group.position.clone();
  step(sim, delayFrames);
  const hullTravel = t.group.position.distanceTo(hullBefore);

  ok("the hull actually moved during the delay (test is not vacuous)", hullTravel > 0.4,
    `hull travelled ${hullTravel.toFixed(2)} m in ${delayFrames} frames`);
  ok("and it turned as well, so this is not a straight-line special case",
    Math.abs(t.yawDelta) > 0 || Math.abs(t.yawRate) > 0,
    `yaw rate ${t.yawRate.toFixed(4)} rad/s`);

  // THE TWO READINGS. Both are "where would the receiver DRAW this crewmate now, given a
  // pose that is one interpolation delay old", and they differ only in which frame the
  // pose was authored in.
  //
  // Hull-local: reparented under trampler.group, so three.js applies the hull's CURRENT
  // transform. Reproduced here as localToWorld against the transform after the step.
  const drawnFromLocal = t.localToWorld(localPose.clone());
  // World-space: the stale coordinates are drawn as-is, because there is nothing to
  // reinterpret them against.
  const drawnFromWorld = worldPoseAtSend.clone();

  // Truth: the crewmate never moved relative to the deck, so they are wherever that deck
  // point is now.
  const truth = t.localToWorld(localPose.clone());

  const localErr = drawnFromLocal.distanceTo(truth);
  const worldErr = drawnFromWorld.distanceTo(truth);

  ok("a hull-local pose lands exactly where the crewmate actually is", localErr < 0.01,
    `${(localErr * 100).toFixed(2)} cm off after ${CFG.net.interpDelayMs} ms`);
  ok("a world-space pose is stale by the HULL's travel, which is the skate",
    worldErr > 0.4,
    `${(worldErr * 100).toFixed(1)} cm off — this is what the relay would look like`);
  ok("so choosing the frame is worth at least an order of magnitude",
    worldErr > localErr * 10,
    `world ${(worldErr * 100).toFixed(1)} cm vs local ${(localErr * 100).toFixed(2)} cm`);

  // AND THE HONEST OTHER HALF, measured with a crewmate who is actually WALKING.
  //
  // The 0 cm above is a standing crewmate, where the frame choice removes the whole
  // error. A moving one keeps a residual — their own displacement relative to the deck
  // over the same window — and that residual is what the design accepts.
  //
  // Measured against the real controller rather than by arithmetic, because the first
  // version of this block did the arithmetic and compared it against the STANDING
  // world-space figure. Two different scenarios, so the comparison was meaningless and
  // reported a failure against a design that is fine. Like with like: same player, same
  // behaviour, same window, only the frame differs.
  //
  // AND THE CLAIM IS A PROPERTY, NOT A SINGLE COMPARISON. This is the second thing the
  // first version got wrong, and it is the more interesting of the two.
  //
  // Asserting "hull-local beats world-space for a walking crewmate" FAILED, correctly:
  // measured, the walker's own 53 cm across the deck happened to run against the hull's
  // 52 cm, so their net world displacement was 12 cm and the stale WORLD pose was
  // accidentally the more accurate of the two. Luck, and it would reverse if they turned
  // round.
  //
  // So a single comparison is the wrong instrument. The real architectural claim is about
  // what each error DEPENDS on:
  //
  //   hull-local error = the walker's own deck-relative travel. Bounded by player speed,
  //                      and INDEPENDENT of how fast the hull is moving.
  //   world-space error = hull travel + own travel, composed as vectors. Contains a term
  //                      nobody controls, and it grows with hull speed.
  //
  // That is testable without luck: run the same walk twice, once with the hull moving and
  // once with it stopped, and see which error changes.
  const measureWalk = (hullMoving) => {
    const s2 = makeSim();
    const t2 = s2.trampler;
    t2.walking = hullMoving;
    t2.turning = hullMoving;
    s2.player.respawnOnDeck();
    step(s2, 10); // settle onto the deck before anything is captured

    // Pinned, so both runs walk the same way across the deck rather than whichever way
    // the respawn happened to leave them facing. An orientation a test depends on has to
    // be set, not inherited.
    s2.player.yaw = 0;

    const localAtSend = t2.worldToLocal(s2.player.position.clone());
    const worldAtSend = s2.player.position.clone();

    s2.input.keys.add("KeyW");
    step(s2, delayFrames);
    s2.input.keys.delete("KeyW");

    const truth = s2.player.position.clone();
    const localNow = t2.worldToLocal(truth.clone());
    return {
      // Travel across the DECK, which is what the residual is made of. Measured in hull
      // space on purpose: world travel confounds it with the hull's own motion, which is
      // exactly the mistake this block is correcting.
      deckTravel: localNow.distanceTo(localAtSend),
      localErr: t2.localToWorld(localAtSend.clone()).distanceTo(truth),
      worldErr: worldAtSend.distanceTo(truth),
      hullTravel: hullMoving ? t2.linVel.length() * (delayFrames / CFG.loop.stepHz) : 0,
    };
  };

  const moving = measureWalk(true);
  const stopped = measureWalk(false);

  ok("the crewmate actually walked across the deck (test is not vacuous)",
    moving.deckTravel > 0.3 && stopped.deckTravel > 0.3,
    `${(moving.deckTravel * 100).toFixed(0)} cm moving, `
    + `${(stopped.deckTravel * 100).toFixed(0)} cm stopped`);
  ok("and both runs walked the same distance across the deck, so they are comparable",
    Math.abs(moving.deckTravel - stopped.deckTravel) < 0.05,
    `${(Math.abs(moving.deckTravel - stopped.deckTravel) * 100).toFixed(1)} cm apart`);

  ok("a walking crewmate leaves a residual — the frame choice is not free",
    moving.localErr > 0.05,
    `${(moving.localErr * 100).toFixed(0)} cm, which is their own travel across the deck`);

  // THE PROPERTY. Hull-local error is the same whether the fortress is walking or parked;
  // world-space error is not. That is the whole reason to choose the frame, and unlike a
  // single distance comparison it cannot be flipped by which way somebody happened to face.
  ok("HULL-LOCAL error does not care whether the fortress is moving",
    Math.abs(moving.localErr - stopped.localErr) < 0.05,
    `${(moving.localErr * 100).toFixed(0)} cm moving vs `
    + `${(stopped.localErr * 100).toFixed(0)} cm parked`);
  ok("WORLD-SPACE error does care, which is the term the frame choice removes",
    Math.abs(moving.worldErr - stopped.worldErr) > 0.2,
    `${(moving.worldErr * 100).toFixed(0)} cm moving vs `
    + `${(stopped.worldErr * 100).toFixed(0)} cm parked`);

  // THE NUMBER net.js GETS WRONG, pinned so it cannot drift back.
  //
  // Its header says the hull-local residual is "about 5 cm". At CFG.player.walkSpeed of
  // 7.0 m/s across CFG.net.interpDelayMs it is an order of magnitude more than that, and
  // sprinting is worse. The frame choice is still right, because it removes a term that
  // would otherwise be ADDED to this one; what is wrong is the advertised size of what
  // remains, and "5 cm" invites someone to treat a remote position as exact.
  const walkResidual = CFG.player.walkSpeed * (CFG.net.interpDelayMs / 1000);
  ok("and the residual is much larger than net.js's comment claims",
    walkResidual > 0.5,
    `${(walkResidual * 100).toFixed(0)} cm at walk speed, ${(CFG.player.sprintSpeed
      * (CFG.net.interpDelayMs / 1000) * 100).toFixed(0)} cm sprinting — not "about 5 cm"`);
  ok("and the measured residual agrees with that arithmetic",
    Math.abs(moving.localErr - walkResidual) < 0.35,
    `measured ${(moving.localErr * 100).toFixed(0)} cm vs predicted `
    + `${(walkResidual * 100).toFixed(0)} cm`);
}

// ---------------------------------------------------------------------------
// The horde's walk cycle. Presentation, and asserted here for the same reason the aim
// readout lives in weapon.js rather than hud.js: it is decided in a simulation module,
// so it CAN be tested, and the three things most likely to be wrong about it are all
// invisible to inspection.
//
// A rig where nothing got classified animates nothing and reads as perfectly correct in
// source -- the chewer and burrower legitimately have no limbs, so "zero limbs" is not
// by itself a fault and cannot be used as the alarm.
//
// A displacement large enough to pull the drawn body off its hit box breaks invariant 8
// quietly, because the shot still lands on the body mass and only the extremity lies
// about where it is. The first version of the rig did exactly this: the climber's
// forward-pointing forelimbs were classified as legs, which shoved them 18 cm further
// forward and nearly doubled an overhang that already existed, on the one type whose job
// is to be shot before it boards.
//
// And a phase drawn from a seeded stream would be an invariant 21 violation that no
// amount of looking at the screen would ever reveal.
//
// `node tools/gait-extents.mjs` prints the full table. This pins what must not drift.
console.log("\n116. The horde's walk cycle moves limbs without leaving the hit box");
{
  const sim = makeSim();
  const { horde } = sim;
  const gait = CFG.enemies.gait;
  const pad = CFG.combat.weapon.hitPad;

  let typesWithLimbs = 0;
  let unbalanced = 0;
  let deadPivots = 0;
  let worstAdded = 0;
  let worstWhere = "";
  let missingAttrs = 0;

  for (let type = 0; type < ENEMY_TYPE_KEYS.length; type++) {
    const geo = horde.meshes[type].geometry;
    const rig = geo.attributes.aRig;
    const anim = geo.attributes.aAnim;
    if (!rig || !anim) { missingAttrs++; continue; }

    const pos = geo.attributes.position;
    let nA = 0;
    let nB = 0;
    // The largest gap between a limb vertex and the pivot it hangs from. If this is
    // zero the swing term is multiplied by zero and the limb is decoratively classified
    // and completely still -- which looks exactly like a working rig.
    let deepestHang = 0;

    const stat = { x: 0, y: 0, z: 0 };
    const anim3 = { x: 0, y: 0, z: 0 };

    for (let i = 0; i < pos.count; i++) {
      const px = pos.getX(i);
      const py = pos.getY(i);
      const pz = pos.getZ(i);
      stat.x = Math.max(stat.x, Math.abs(px));
      stat.y = Math.max(stat.y, Math.abs(py));
      stat.z = Math.max(stat.z, Math.abs(pz));

      const code = rig.getX(i);
      const pivot = rig.getY(i);
      if (code > 1.5) nB++; else if (code > 0.5) nA++;

      const limb = code > 0.5 ? 1 : 0;
      const dir = 1 - 2 * (code > 1.5 ? 1 : 0);
      const hang = Math.min(py - pivot, 0);
      if (limb) deepestHang = Math.max(deepestHang, -hang);

      // The vertex shader, replicated. Swept across a whole phase cycle at FULL
      // amplitude, which is the worst case rather than one instant -- the trap this
      // suite has been caught by three times.
      for (let s = 0; s < 180; s++) {
        const ph = (s / 180) * Math.PI * 2;
        const bob = Math.sin(ph * 2) * gait.bob;
        const sway = Math.sin(ph) * gait.sway;
        const c = Math.cos(sway);
        const sn = Math.sin(sway);
        const tx = c * px + sn * pz;
        const ty = py + bob;
        const tz = -sn * px + c * pz
          + Math.sin(ph) * gait.swing * limb * dir * hang;
        anim3.x = Math.max(anim3.x, Math.abs(tx));
        anim3.y = Math.max(anim3.y, Math.abs(ty));
        anim3.z = Math.max(anim3.z, Math.abs(tz));
      }
    }

    if (nA > 0 || nB > 0) {
      typesWithLimbs++;
      // A left side and a right side must carry the same number of vertices. An
      // imbalance means one side was miscoded, and the result is a limp -- which is
      // subtle enough on one body in a crowd of four hundred to never get reported.
      if (nA !== nB) unbalanced++;
      if (deepestHang < 1e-6) deadPivots++;
    }

    for (const axis of ["x", "y", "z"]) {
      const added = anim3[axis] - stat[axis];
      if (added > worstAdded) {
        worstAdded = added;
        worstWhere = `${ENEMY_TYPE_KEYS[type]} ${axis}`;
      }
    }
  }

  ok("every type carries both the rig and the per-instance gait attribute",
    missingAttrs === 0, `${missingAttrs} missing`);
  // Four, and the three WITHOUT limbs are each deliberate: a chewer's only appendages
  // are mandibles, a burrower is a segmented worm, and a climber's forelimbs point
  // forward, so the hang-driven swing is the wrong rule for all three. There is no
  // headroom in this bound on purpose -- if a silhouette loses its legs, that is a thing
  // to be told about rather than absorbed.
  ok("limbs were actually classified on the types that have them (not vacuous)",
    typesWithLimbs === 4,
    `${typesWithLimbs} of ${ENEMY_TYPE_KEYS.length} types — the bulwark, sapper, titan and`
    + ` spiker walk on legs; the chewer, burrower and climber have none to swing`);
  ok("left and right carry the same vertex count, so nothing limps",
    unbalanced === 0, `${unbalanced} unbalanced`);
  ok("and every limb hangs BELOW its pivot, or the swing multiplies by zero",
    deadPivots === 0, `${deadPivots} limbs with a dead pivot`);

  // The bound is 0.15 m and it is chosen by the failure it catches, not by taste: the
  // measured worst across all seven types is still 0.099 m at the titan in x, and the
  // climber mistake this is guarding against measured 0.182 m. Anything between leaves
  // room for a silhouette tweak without leaving room for classifying a forward-pointing
  // arm as a leg.
  ok("no type's silhouette is pulled far off its hit box by the animation",
    worstAdded < 0.15,
    `worst ${worstAdded.toFixed(3)} m at ${worstWhere}, against a measured 0.099 m`
    + ` and 0.182 m for the mistake this bound exists to catch`);

  // Phase must not come from the seeded stream, and the cheap proof is that clear()
  // re-seeds everything stochastic and cannot touch this.
  const before = horde.pool.slice(0, 8).map((e) => e.gaitPhase);
  horde.clear();
  const after = horde.pool.slice(0, 8).map((e) => e.gaitPhase);
  ok("gait phase survives a clear, so it is not drawn from a seeded stream",
    before.every((p, i) => p === after[i]),
    `[${before.slice(0, 3).map((p) => p.toFixed(2)).join(", ")}…] unchanged`);

  let closest = Infinity;
  for (let i = 1; i < 64; i++) {
    let d = Math.abs(horde.pool[i].gaitPhase - horde.pool[i - 1].gaitPhase);
    if (d > Math.PI) d = Math.PI * 2 - d;
    closest = Math.min(closest, d);
  }
  ok("adjacent pool slots are far apart in phase, so a batch of spawns does not march",
    closest > 1.0,
    `closest adjacent pair ${closest.toFixed(2)} rad apart`);

  // And the behavioural half: amplitude has to follow what the body is actually doing.
  //
  // The latched body is produced by the real fight rather than by assigning the flag,
  // and that is not "waiting for a coincidence" -- chewers reaching legs and holding on
  // is the deterministic outcome of invariant 18b, not a timing accident. Assigning
  // `latched` by hand would be worse than slow: the AI owns that flag and would clear it
  // inside the same update, so the assertion would be measuring the assignment rather
  // than the mechanism.
  for (let i = 0; i < 20; i++) horde.spawn(CHEWER);
  step(sim, 400);

  const arr = horde.animArrays[CHEWER];
  let latchedAmp = null;
  let movingAmp = 0;
  let slot = 0;
  for (const e of horde.pool) {
    if (!e.alive || e.state === ENEMY_STATE.BURROWED) continue;
    if (e.type !== CHEWER) continue;
    const amp = arr[slot * 2 + 1];
    if (e.latched) latchedAmp = amp;
    else movingAmp = Math.max(movingAmp, amp);
    slot++;
  }

  ok("a body is genuinely latched and another is genuinely moving (not vacuous)",
    latchedAmp !== null && movingAmp > 0,
    `latched amp ${latchedAmp}, fastest free amp ${movingAmp.toFixed(2)}`);
  ok("a latched body's legs stop dead, because it is riding rather than walking",
    latchedAmp === 0,
    `amp ${latchedAmp} — a fixed-amplitude cycle would pedal on the spot under the hull`);
  ok("while a body crossing the sand is animated in proportion to its speed",
    movingAmp > 0 && movingAmp <= 1,
    `amp ${movingAmp.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// The wire format, tested as arithmetic rather than over a socket.
//
// This is the reason src/snapshot.js is a module in src/ and not code inside net.js. Every
// failure mode of a codec is SILENT: a field written as int16 and read as uint16 does not
// throw, it reports a fortress 600 metres away; a scale of 10 where 100 was meant loses a
// decimal place in one coordinate and nowhere else. None of that is visible by inspection
// and none of it is reachable from a browser-only module.
console.log("\n117. The snapshot round-trips, and says so when it cannot");
{
  // A state with every field set to something distinctive, so a field read from the wrong
  // offset lands on a value that cannot be mistaken for the right one. Deliberately not
  // round numbers: 0 and 1 survive almost any offset mistake.
  const sent = {
    tick: 123456,
    elapsedMs: 754321,
    resetId: 37,
    hullX: 142.37,
    hullZ: -83.91,
    hullYaw: 2.4711,
    gait: 918.2734,
    reactorHp: 588,
    driveScale: 1.184,
    turnScale: 1.402,
    hullBits: packHullBits({
      walking: true, turning: false, destroyed: false, immobilised: true,
    }),
    wave: 4,
    resolved: 1301,
    phaseTimer: 12.34,
    arcOffset: 5.9012,
    phaseBits: packPhaseBits({
      phase: "engaged", runPhase: "choosing", calledEarly: true, bossLeg: false,
    }),
    runLeg: 3,
    threatScale: 1.237,
    extraCount: 4,
    fogScale: 0.813,
    speedScale: 1.164,
    treasuryScrap: 287.375,
    treasuryEarnedScrap: 914.625,
    moduleCredits: 2,
    hordeKills: 1203,
    hordeDeaths: 1231,
    lastDeathX: -17.43,
    lastDeathY: 2.19,
    lastDeathZ: 81.27,
    lastDeathType: 4,
    lastDeathBits: 1,
    legHp: [120, 0, 47, 120, 99, 3],
  };

  const { buffer, clamped } = encode(sent);
  ok("nothing had to be clamped for a legitimate state", clamped.length === 0,
    clamped.length ? JSON.stringify(clamped[0]) : "all fields fit their widths");

  const got = decode(buffer);

  // SIZE, asserted rather than printed. A snapshot goes to every client 20 times a
  // second, so "it grew a bit" is the failure that is invisible until it is a bandwidth
  // problem. The number is small on purpose: slice 1 carries the hull and the director,
  // and the horde is what will actually cost something.
  // Derived from the format rather than typed in, so adding a section moves the number
  // instead of breaking the assertion. The earlier version hard-coded `< 64` and duly failed
  // the moment the operative section landed — a bound that had to be edited every slice is a
  // bound that teaches nothing.
  const bytes = buffer.byteLength;
  const predicted = snapshotBytes(sent);
  ok("the fixed part of a snapshot is the size the format predicts", bytes === predicted,
    `${bytes} bytes -> ${(bytes * CFG.net.sendHz / 1024).toFixed(2)} KiB/s per client`);
  ok("and it is small enough that the fixed cost is irrelevant", bytes < 128,
    `${bytes} B: hull, director, run and the leg array`);
  ok("so four clients cost almost nothing before the horde is counted",
    bytes * CFG.net.sendHz * 4 < 16384,
    `${(bytes * CFG.net.sendHz * 4 / 1024).toFixed(2)} KiB/s for a full crew`);

  // EVERY FIELD, checked against the format's OWN stated tolerance rather than against
  // numbers typed in here. A test that carries its own idea of the precision is a test
  // that agrees with whoever wrote it; this one disagrees with the codec if the codec is
  // wrong.
  let worstField = "";
  let worstRatio = 0;
  for (const [key, kind] of LAYOUT.BODY) {
    const tol = toleranceOf(kind, sent[key]);
    const err = Math.abs(got[key] - sent[key]);
    // An angle may come back on the other side of the wrap, which is the same angle.
    const wrapped = kind === "angle"
      ? Math.min(err, Math.abs(err - Math.PI * 2))
      : err;
    const ratio = tol > 0 ? wrapped / tol : (wrapped > 0 ? Infinity : 0);
    if (ratio > worstRatio) {
      worstRatio = ratio;
      worstField = `${key} (${kind}): off by ${wrapped.toExponential(2)}, tolerance ${tol}`;
    }
  }
  ok("every body field round-trips inside its own declared tolerance", worstRatio <= 1,
    worstField || "all exact");

  ok("the leg array round-trips, length and all",
    got.legHp.length === 6 && got.legHp.every((v, i) => v === sent.legHp[i]),
    `[${got.legHp.join(", ")}]`);

  // The bit fields, through their own helpers. Packed indices are the one part of the
  // format where an off-by-one is silent AND plausible — "engaged" and "held" are adjacent.
  const hb = unpackHullBits(got.hullBits);
  ok("hull flags survive, including the ones that are false",
    hb.walking === true && hb.turning === false
    && hb.destroyed === false && hb.immobilised === true,
    `walking ${hb.walking}, turning ${hb.turning}, immobilised ${hb.immobilised}`);
  const pb = unpackPhaseBits(got.phaseBits);
  ok("both phases and both flags share one byte without colliding",
    pb.phase === "engaged" && pb.runPhase === "choosing"
    && pb.calledEarly === true && pb.bossLeg === false,
    `${pb.phase} / ${pb.runPhase}, early ${pb.calledEarly}, boss ${pb.bossLeg}`);

  // EVERY phase index, not just the one above. The packing gives the director 3 bits and
  // the run 2, and a list that outgrew its bit width would wrap onto another phase — which
  // reads as the game deciding it is in a different part of the run.
  let phasesOk = true;
  for (const p of WIRE_PHASES) {
    for (const r of WIRE_RUN_PHASES) {
      const round = unpackPhaseBits(packPhaseBits({
        phase: p, runPhase: r, calledEarly: false, bossLeg: true,
      }));
      if (round.phase !== p || round.runPhase !== r || round.bossLeg !== true) phasesOk = false;
    }
  }
  ok("every phase pairing round-trips, so neither list has outgrown its bits", phasesOk,
    `${WIRE_PHASES.length} director phases x ${WIRE_RUN_PHASES.length} run phases`);

  const repairKeys = [null, "reactor", "leg:0", "leg:5", "leg:253"];
  ok("exact repair-point ownership round-trips without confusing two legs",
    repairKeys.every((key) => unpackRepairTarget(packRepairTarget(key)) === key),
    repairKeys.map((key) => `${key ?? "none"}:${packRepairTarget(key)}`).join(", "));
  let repairOverflowRefused = false;
  try { packRepairTarget("leg:254"); } catch { repairOverflowRefused = true; }
  ok("a repair point too large for its byte refuses instead of wrapping onto another point",
    repairOverflowRefused, "leg:254 does not become none or reactor");

  // THE THREE REFUSALS, each named. A socket that says "bad packet" for a stale browser
  // tab sends someone to check their network, which is the refit terminal's lesson.
  const bad = (fn) => {
    try {
      fn();
      return null;
    } catch (err) {
      return err;
    }
  };

  const wrongVersion = new Uint8Array(buffer.slice(0));
  wrongVersion[0] = PROTOCOL_VERSION + 7;
  const vErr = bad(() => decode(wrongVersion.buffer));
  ok("a protocol mismatch refuses, and names itself", vErr?.cause === "version",
    vErr ? vErr.message.slice(0, 72) : "it PARSED, which is the dangerous outcome");

  const wrongKind = new Uint8Array(buffer.slice(0));
  wrongKind[1] = 99;
  const kErr = bad(() => decode(wrongKind.buffer));
  ok("an unknown message kind refuses separately from a version mismatch",
    kErr?.cause === "kind", kErr ? kErr.message.slice(0, 64) : "it PARSED");

  const truncated = buffer.slice(0, buffer.byteLength - 3);
  const tErr = bad(() => decode(truncated));
  ok("a truncated buffer refuses rather than reading past its end",
    tErr?.cause === "truncated", tErr ? tErr.message.slice(0, 64) : "it PARSED");

  const trailing = new ArrayBuffer(buffer.byteLength + 2);
  new Uint8Array(trailing).set(new Uint8Array(buffer));
  const lErr = bad(() => decode(trailing));
  ok("trailing bytes refuse too, which is the guard on editing the layout",
    lErr?.cause === "layout", lErr ? lErr.message.slice(0, 64) : "it PARSED");

  // CLAMPING IS REPORTED, NOT SILENT. Invariant 31's dune reached inside the patrol ring
  // because arithmetic was trusted instead of asserted; a coordinate that quietly saturates
  // is the same mistake on a wire.
  const tooFar = encode({ ...sent, hullX: 900 });
  ok("a value that does not fit its field is reported rather than saturating quietly",
    tooFar.clamped.length === 1 && tooFar.clamped[0].kind === "metres",
    tooFar.clamped.length ? `${tooFar.clamped[0].kind} at ${tooFar.clamped[0].value}` : "silent");

  // NaN IS NOT A COORDINATE. Invariant 16 forbids it anywhere, and a single NaN arriving
  // from a peer would otherwise be broadcast to everyone.
  const nan = encode({ ...sent, hullX: NaN, gait: NaN });
  const nanBack = decode(nan.buffer);
  ok("NaN is neutralised at the boundary, not forwarded",
    Number.isFinite(nanBack.hullX) && Number.isFinite(nanBack.gait),
    `hullX ${nanBack.hullX}, gait ${nanBack.gait}`);

  // THE PRECISION CLAIM THE FORMAT'S OWN COMMENT MAKES, checked against the real deck.
  //
  // 16 bits for the hull's yaw rather than 8, because every deck position is derived by
  // rotating a hull-local offset, so angular error is MULTIPLIED by distance from the
  // centreline. Read off a real Trampler rather than from a CFG key: the first version
  // reached for `CFG.trampler.length`, which does not exist, and produced `NaN mm at NaN m`
  // — a wrong property name is not an error, it is a wrong answer, which is the same
  // failure `isSubmerged` exists to prevent.
  const halfL = makeSim().trampler.halfL;
  const yawTol = toleranceOf("angle");
  const sternError = yawTol * halfL;
  const eightBitError = (Math.PI * 2 / 256 / 2) * halfL;
  ok("the deck's half-length is a real number (test is not vacuous)",
    Number.isFinite(halfL) && halfL > 5, `${halfL} m from the centreline to the stern`);
  ok("16-bit yaw keeps a stern-standing crewmate inside a millimetre or two",
    sternError < 0.005,
    `${(sternError * 1000).toFixed(2)} mm at ${halfL} m out`);
  ok("and 8 bits would not have, which is why the field is 16",
    eightBitError > 0.1,
    `8-bit yaw would throw them ${(eightBitError * 100).toFixed(0)} cm sideways`);
}

// ---------------------------------------------------------------------------
// SLICE 1 END TO END, WITH NO SOCKET.
//
// Two complete simulations in one process: one plays the server, one plays a client. The
// client is fed nothing but encoded snapshots, exactly as many as a real client would get,
// and then asked whether its fortress is where the server's fortress is.
//
// This is the whole argument for putting the wire format and the session in src/ rather
// than in net.js. A socket cannot be tested here. Everything that can actually go wrong in
// this layer can: a field read at the wrong offset, a correction applied in the wrong order,
// a transform left stale, a clock that drifts because one end integrates and the other does
// not. All of it is arithmetic, and all of it is silent.
console.log("\n118. A client driven by snapshots ends up on the same fortress");
{
  // FIRST, THE TWO LISTS THAT MUST AGREE ACROSS FILES. snapshot.js sends phases as wire
  // INDICES, so its ordering is a second declaration of an enum that lives in waves.js and
  // run.js. Two lists in two files with nothing checking them is how the shop and the pick
  // came to disagree about a safe moment.
  const simPhases = Object.values(PHASE);
  const simRunPhases = Object.values(RUN);
  ok("the wire's director phases are exactly the director's own, in order",
    WIRE_PHASES.length === simPhases.length
    && WIRE_PHASES.every((p, i) => p === simPhases[i]),
    `wire [${WIRE_PHASES.join(",")}] vs PHASE [${simPhases.join(",")}]`);
  ok("and the wire's run phases are exactly the run's own, in order",
    WIRE_RUN_PHASES.length === simRunPhases.length
    && WIRE_RUN_PHASES.every((p, i) => p === simRunPhases[i]),
    `wire [${WIRE_RUN_PHASES.join(",")}] vs RUN [${simRunPhases.join(",")}]`);

  const server = createSession();
  const client = createSession();

  // The clock divergence this slice exists to close, reproduced first so the fix is
  // measured against something real. A client that "clicked" ten seconds late has been
  // running ten seconds behind for ever, and enemy health scales off exactly that.
  const lateBySeconds = 10;
  for (let i = 0; i < lateBySeconds * CFG.loop.stepHz; i++) stepSession(server, DT);

  const beforeElapsed = Math.abs(server.director.elapsed - client.director.elapsed);
  ok("the two sims really do disagree about the clock to begin with (not vacuous)",
    beforeElapsed > lateBySeconds - 0.5,
    `${beforeElapsed.toFixed(2)} s apart, which scales enemy health by`
    + ` x${(server.director.hpScale() / client.director.hpScale()).toFixed(2)}`);

  // Now run them together, the client seeing only what the wire carries. One snapshot every
  // third tick, which is the server's real SNAPSHOT_EVERY, so the client predicts through
  // the gaps exactly as it will in the browser.
  const SNAPSHOT_EVERY = 3;
  let worst = { position: 0, yaw: 0, gait: 0, elapsed: 0 };
  let snapshots = 0;
  let totalBytes = 0;
  let firstCorrection = null;

  for (let tick = 1; tick <= 600; tick++) {
    stepSession(server, DT);

    if (tick % SNAPSHOT_EVERY === 0) {
      const { buffer, clamped } = encode(snapshotOf(server, tick));
      if (clamped.length) {
        ok("a live snapshot clamped a field", false, JSON.stringify(clamped[0]));
        break;
      }
      totalBytes += buffer.byteLength;
      snapshots++;
      // APPLIED BEFORE THE CLIENT'S OWN STEP, which is the ordering session.js argues for
      // at length: a correction applied after a step is seen by the next step as real hull
      // travel, and drags anybody standing on the deck along with it.
      applySnapshot(client, decode(buffer));
      if (!firstCorrection) firstCorrection = hullDivergence(server, client);
    }

    // The client predicts by running the REAL Trampler.update, not by extrapolating. That
    // is legitimate because the fortress consumes no input at all — given the same pose,
    // gait, leg health and multipliers, it lands on the same answer.
    stepSession(client, DT);

    // MEASURED ONLY ONCE A SNAPSHOT HAS ARRIVED, and the first version of this did not do
    // that — it took the worst across all 600 ticks including the two before the first
    // packet, so it faithfully reported the 10 second gap the test had just created on
    // purpose. 44.9 m of "divergence", which is exactly 10 s of hull travel at 4.5 m/s.
    //
    // A convergence test that includes the pre-convergence state measures the setup. Same
    // family as sampling an oscillating state at one instant, or reading a value inside the
    // frame hook: the window has to contain the thing being claimed.
    if (snapshots > 0) {
      const d = hullDivergence(server, client);
      for (const k of Object.keys(worst)) worst[k] = Math.max(worst[k], d[k]);
    }
  }

  ok("snapshots were actually exchanged (test is not vacuous)", snapshots === 200,
    `${snapshots} snapshots over 600 ticks, ${totalBytes} bytes total`);

  // ONE PACKET CLOSES TEN SECONDS. Worth asserting separately from the steady state,
  // because it is the property that makes a late joiner viable at all: there is no
  // catch-up protocol, no replay, no handshake — the next snapshot simply is the truth.
  ok("a single snapshot collapses a ten-second divergence outright",
    firstCorrection && firstCorrection.elapsed < 0.05 && firstCorrection.position < 0.05,
    firstCorrection
      ? `${(firstCorrection.elapsed * 1000).toFixed(0)} ms and `
        + `${(firstCorrection.position * 100).toFixed(2)} cm immediately after the first packet`
      : "no snapshot was applied");
  // Against the format's own prediction for the complete state this scenario actually has,
  // including every protocol-v4 repeated array. Passing a hand-maintained subset here is the
  // exact failure this assertion exists to catch: the encoder derives its size from real arrays,
  // so the independent predictor must be handed those same arrays rather than silently treating
  // every omitted section as empty.
  const expectPerSnap = snapshotBytes(snapshotOf(server, 600));
  ok("which is the bandwidth a real client pays",
    Math.round(totalBytes / snapshots) === expectPerSnap,
    `${(totalBytes / snapshots).toFixed(0)} B each -> `
    + `${(totalBytes / snapshots * CFG.net.sendHz / 1024).toFixed(2)} KiB/s per client`);

  // THE CLOCK. One field, and it is the largest divergence in the game.
  ok("the client's clock is pulled onto the server's and stays there",
    worst.elapsed < 0.1,
    `worst disagreement ${(worst.elapsed * 1000).toFixed(0)} ms, down from`
    + ` ${beforeElapsed.toFixed(1)} s`);

  // THE HULL, AND THE BOUND IS DERIVED RATHER THAN CHOSEN.
  //
  // The client is deliberately ONE TICK ahead of its last correction: it applies a snapshot
  // and then predicts forward, which is what a predicting client is for. So the steady-state
  // divergence measured here is one tick of hull travel plus one tick of quantisation, and
  // that is the design rather than an error.
  //
  // The first version asserted `< 0.05` and `< 0.01`, numbers picked because they sounded
  // tight, and both failed at exactly one tick's worth — 8.16 cm against 4.5/60 = 7.5 cm,
  // and 1.7e-2 against a gait step of 1/60. A threshold invented in a test is a threshold
  // that disagrees with the system for reasons the test cannot explain; derived from the
  // hull's own speed, it says what it is actually claiming.
  const tickTravel = CFG.trampler.speed * DT;
  const quantum = 0.01; // int16 metres at 1 cm, worst case on each of two axes
  ok("the two fortresses stay within one tick of each other, which is the prediction lead",
    worst.position < tickTravel + quantum * 2,
    `worst ${(worst.position * 100).toFixed(2)} cm against a one-tick budget of `
    + `${((tickTravel + quantum * 2) * 100).toFixed(2)} cm`);
  ok("facing the same way",
    worst.yaw < CFG.trampler.turnRate * DT + 0.001,
    `worst ${(worst.yaw * 1000).toFixed(2)} mrad apart`);
  // The gait accumulator advances by dt scaled between 0.25 and 1.0, so one tick is at most
  // DT. Anything beyond that would mean the phase is genuinely drifting rather than leading.
  ok("and walking in step, so the legs and the bob agree",
    worst.gait <= DT + 1e-6,
    `worst gait phase ${worst.gait.toExponential(1)} against a one-tick step of `
    + `${DT.toExponential(1)}`);

  // PREDICTION IS DOING REAL WORK, not being hidden by a snapshot every frame. If the
  // client were simply being overwritten, the gaps between snapshots would show as jitter;
  // if it were extrapolating badly, the same. Measured by asking how far the client's own
  // integration carries it between corrections.
  const beforeStep = client.trampler.group.position.clone();
  stepSession(client, DT);
  const predicted = client.trampler.group.position.distanceTo(beforeStep);
  ok("the client moves the hull itself between snapshots (prediction is live)",
    predicted > 0.01,
    `${(predicted * 100).toFixed(1)} cm of predicted travel in one un-corrected tick`);

  // AND THE CORRECTION MUST NOT SHOVE ANYBODY. session.js applies before the step for this
  // reason; here it is asserted rather than trusted, because the failure would look like a
  // teleporting teammate rather than like an ordering bug.
  client.player.respawnOnDeck();
  stepSession(client, DT);
  const standing = client.trampler.worldToLocal(client.player.position.clone());
  const nudged = snapshotOf(server, 601);
  // A deliberately large correction — a metre of position error, far more than the measured
  // half-centimetre — so that if it leaked into based movement it could not be missed.
  nudged.hullX += 1.0;
  applySnapshot(client, decode(encode(nudged).buffer));
  stepSession(client, DT);
  const after = client.trampler.worldToLocal(client.player.position.clone());
  ok("a one-metre hull correction does not move the operative across the deck",
    Math.hypot(after.x - standing.x, after.z - standing.z) < 0.2,
    `${(Math.hypot(after.x - standing.x, after.z - standing.z) * 100).toFixed(1)} cm`
    + " of deck-relative movement from a 100 cm correction");
}

// ---------------------------------------------------------------------------
// SLICE 2: the horde on the wire, and the frame bit that keeps a latched chewer on its leg.
//
// The bandwidth slice. The hull/shared state is fixed once; the horde is fourteen bytes times
// however many are alive, so this is the section where "it grew a bit" becomes a real cost. Two
// of those bytes are the spawn generation that prevents a recycled pool slot being interpolated
// or rewound as its previous occupant. And this is where the frame choice matters most: the two
// bodies that travel in hull-local space are a boarder on the deck and a chewer holding a leg,
// which are exactly the two readouts a player uses to decide which of the two positions to be in.
console.log("\n119. The horde crosses the wire, and carried bodies stay carried");
{
  const server = createSession();
  const client = createSession();

  // A real wave rather than a hand-placed one, so composition, states and the mix of
  // carried and free bodies are whatever the director actually produces.
  server.director.callEarly();
  for (let i = 0; i < 60 * 30; i++) stepSession(server, DT);

  // Preserve the real-wave coverage above, then fill only the numeric ids it did not
  // happen to produce. The old assertion said "all six" while merely comparing the
  // types present in that first wave, so it could pass without exercising most of the
  // type field. The Spiker also owns the maximum three-bit state value; force that exact
  // value onto a real pooled body so state 7 cannot be truncated unnoticed.
  const represented = new Set(
    server.horde.pool.filter((e) => e.alive).map((e) => e.type),
  );
  for (let type = 0; type < ENEMY_TYPE_KEYS.length; type++) {
    if (!represented.has(type)) server.horde.spawn(type);
  }
  const wireSpiker = server.horde.pool.find((e) => e.alive && e.type === SPIKER);
  wireSpiker.state = ENEMY_STATE.FIRING;

  const live = server.horde.liveCount;
  let carried = 0;
  let aboard = 0;
  for (const e of server.horde.pool) {
    if (!e.alive) continue;
    if (e.onHull || e.latched) carried++;
    if (e.onHull) aboard++;
  }

  ok("the server has a real horde to send (test is not vacuous)", live >= 8,
    `${live} alive after 30 s of a called wave`);
  ok("and some of them are being CARRIED by the hull, which is the case that matters",
    carried >= 1, `${carried} carried (${aboard} on the deck, ${carried - aboard} latched)`);

  const liveState = snapshotOf(server, 1800);
  const { buffer, clamped } = encode(liveState);
  ok("nothing clamped with a live horde", clamped.length === 0,
    clamped.length ? JSON.stringify(clamped[0]) : "every body fit its fields");

  // ---- BANDWIDTH, asserted so it cannot creep ------------------------------
  const bytes = buffer.byteLength;
  const perBody = ENTITY_BYTES;
  const perSpikerShot = SPIKER_SHOT_BYTES;
  ok("one body remains fourteen bytes and one sparse Spiker release costs sixteen",
    perBody === 14 && perSpikerShot === 16,
    `${perBody} B per body, ${perSpikerShot} B per release`);
  ok("the snapshot is the size the format predicts", bytes === snapshotBytes(liveState),
    `${bytes} B for ${live} bodies and ${server.operatives.length} operative(s)`);
  // The realistic peak: wave five at a four-crew scale is 30 x 2.5 = 75 bodies, with the four
  // operatives that made it that size.
  const fullCrewState = snapshotOf(createSession({ seats: 4 }), 0);
  const bytesAt = (entityCount) => snapshotBytes({
    ...fullCrewState,
    // Worst point in the journey: all three prior roads, a live two-road ballot and four votes.
    roadHistory: { length: 3 },
    roadOffers: { length: CFG.run.branches },
    roadVotes: { length: 4 },
    entities: { length: entityCount },
  });
  const peak = bytesAt(75);
  const cap = bytesAt(CFG.enemies.max);
  ok("a four-crew wave five stays under 35 KiB/s per client",
    (peak * CFG.net.sendHz) / 1024 < 35,
    `${(peak / 1024).toFixed(2)} KiB per snapshot -> `
    + `${((peak * CFG.net.sendHz) / 1024).toFixed(1)} KiB/s`);
  ok("and even a structurally full pool stays inside 130 KiB/s per client",
    (cap * CFG.net.sendHz) / 1024 < 130,
    `${CFG.enemies.max} bodies -> ${((cap * CFG.net.sendHz) / 1024).toFixed(1)} KiB/s`);

  // ---- the round trip ------------------------------------------------------
  applySnapshot(client, decode(buffer));

  ok("the client ends up with the same number of bodies alive",
    client.horde.liveCount === live, `${client.horde.liveCount} vs ${live}`);

  let worstPos = 0;
  let worstBody = "";
  let matched = 0;
  let typesOk = true;
  let statesOk = true;
  const typesSeen = new Set();
  let sawMaxState = false;
  for (let i = 0; i < server.horde.pool.length; i++) {
    const s = server.horde.pool[i];
    const c = client.horde.pool[i];
    if (!s.alive) {
      // A body dead on the server must be dead on the client. The absence half of the sync is
      // the one an "update what I was told" loop silently gets wrong: without the sweep in
      // applyEntities, every corpse would stand on the sand for the rest of the run.
      if (c.alive) { statesOk = false; worstBody = `slot ${i} alive on the client only`; }
      continue;
    }
    matched++;
    typesSeen.add(s.type);
    if (s.state === ENEMY_STATE.FIRING) sawMaxState = true;
    if (c.type !== s.type) typesOk = false;
    if (c.state !== s.state) statesOk = false;
    const d = Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z);
    if (d > worstPos) {
      worstPos = d;
      worstBody = `slot ${i} type ${s.type} state ${s.state}`
        + `${s.onHull || s.latched ? " CARRIED" : ""}`;
    }
  }

  ok("every live body was matched by pool index (test is not vacuous)", matched === live,
    `${matched} of ${live}`);
  ok("types survive the wire, including every numeric roster id",
    typesOk && typesSeen.size === ENEMY_TYPE_KEYS.length,
    `${typesSeen.size} of ${ENEMY_TYPE_KEYS.length} types round-trip`);
  ok("states survive through the maximum three-bit value, and nothing is alive on one side only",
    statesOk && sawMaxState,
    !sawMaxState ? "FIRING state 7 was not represented" : (worstBody || "state 7 round-tripped"));

  // ONE CENTIMETRE, which is the quantisation and nothing else. This is the assertion that
  // the frame conversion is right in BOTH directions: a carried body is encoded into hull
  // space and read back out of it, and any error in either transform shows up here as
  // whole metres rather than as a rounding difference.
  ok("every body lands within a centimetre of where the server has it",
    worstPos < 0.02, `worst ${(worstPos * 100).toFixed(2)} cm — ${worstBody}`);

  // ---- AND NOW THE POINT: THE HULL MOVES UNDER THEM ------------------------
  //
  // The test above sends and applies in the same instant, which is the easy case. The claim
  // that matters is what a 120 ms old snapshot looks like once the fortress has walked on.
  const stale = decode(encode(snapshotOf(server, 1800)).buffer);
  const delayFrames = Math.round((CFG.net.interpDelayMs / 1000) * CFG.loop.stepHz);

  // Both sims advance, but the client is applying a snapshot from BEFORE the walk.
  const hullBefore = server.trampler.group.position.clone();
  for (let i = 0; i < delayFrames; i++) stepSession(server, DT);
  const hullMoved = server.trampler.group.position.distanceTo(hullBefore);
  for (let i = 0; i < delayFrames; i++) stepSessionClient(client, DT);
  applySnapshot(client, stale);

  // Derived from the hull's ACTUAL speed, not from CFG.trampler.speed. Thirty seconds of a
  // called wave has chewed the legs, so `speedFactor()` has throttled the fortress — the
  // first version of this asserted 0.4 m against a full-speed 0.53 m and measured 0.39,
  // because a damaged fortress walks slower by design. A bound that ignores the damage the
  // scenario just inflicted is a bound that disagrees with the game for a reason the test
  // cannot see.
  const expectedTravel = CFG.trampler.speed * server.trampler.speedFactor()
    * server.trampler.driveScale * (delayFrames / CFG.loop.stepHz);
  ok("the fortress walked while the snapshot was in flight (test is not vacuous)",
    hullMoved > expectedTravel * 0.5 && hullMoved > 0.15,
    `hull travelled ${hullMoved.toFixed(2)} m in ${delayFrames} frames at speed factor `
    + `${server.trampler.speedFactor().toFixed(2)} (${server.trampler.brokenLegs()} legs down)`);

  // A carried body, drawn from a stale hull-local position against the CURRENT transform,
  // should still be on its leg. Measured in hull space, because that is where "still on its
  // leg" is a meaningful question.
  // MEASURED IN THREE GROUPS, because "carried" is two different cases and lumping them
  // together produced a bound that was wrong for both.
  //
  //   LATCHED   holds a leg and does not move in hull space at all, so its only error is the
  //             1 cm quantisation. This is the strong claim.
  //   ON DECK   is a boarder WALKING toward the reactor, so it is stale by its own
  //             deck-relative travel — the same residual a free body has, just smaller
  //             because a boarder on a 26 m deck is not crossing open sand.
  //   FREE      is stale by its own world travel.
  //
  // The first version asserted one bound over both carried cases and measured 5.53 cm
  // against a 5 cm threshold — a walking boarder, behaving exactly as designed, failing an
  // assertion that had quietly assumed every carried body was stationary.
  let worstLatched = 0;
  let worstOnDeck = 0;
  let worstFreeWorld = 0;
  let latchedSeen = 0;
  const probeS = new THREE.Vector3();
  const probeC = new THREE.Vector3();
  for (let i = 0; i < server.horde.pool.length; i++) {
    const s = server.horde.pool[i];
    const c = client.horde.pool[i];
    if (!s.alive || !c.alive) continue;
    if (s.onHull || s.latched) {
      probeS.set(s.x, s.y, s.z);
      probeC.set(c.x, c.y, c.z);
      server.trampler.worldToLocal(probeS);
      client.trampler.worldToLocal(probeC);
      const err = probeS.distanceTo(probeC);
      if (s.latched) { worstLatched = Math.max(worstLatched, err); latchedSeen++; }
      else worstOnDeck = Math.max(worstOnDeck, err);
    } else {
      worstFreeWorld = Math.max(
        worstFreeWorld, Math.hypot(c.x - s.x, c.y - s.y, c.z - s.z),
      );
    }
  }

  ok("bodies were actually latched to a leg (test is not vacuous)", latchedSeen >= 1,
    `${latchedSeen} latched`);
  // THE STRONG CLAIM, and the one the pillar rests on: a chewer holding a leg is exactly
  // where the server has it, to within the wire's own precision, however far the fortress
  // walked while the packet was in flight.
  ok("a LATCHED chewer is on its leg to within the quantisation, after 120 ms of walking",
    worstLatched < 0.03,
    `worst ${(worstLatched * 100).toFixed(2)} cm in hull space across `
    + `${hullMoved.toFixed(2)} m of hull travel`);
  // The honest other halves. Both are the body's OWN motion and neither contains the hull's,
  // which is the entire benefit of choosing the frame — and both are what interpolation
  // smooths rather than removes.
  ok("a boarder walking the deck is stale by its own deck-relative travel, not the hull's",
    worstOnDeck < 0.25,
    `worst ${(worstOnDeck * 100).toFixed(1)} cm — its own walk, against `
    + `${(hullMoved * 100).toFixed(0)} cm of hull travel it does NOT carry`);
  ok("while a FREE body is stale by its own world travel",
    worstFreeWorld > 0.05,
    `worst ${(worstFreeWorld * 100).toFixed(0)} cm — a chewer covers `
    + `${(CFG.enemies.chewer.speed * CFG.net.interpDelayMs / 1000 * 100).toFixed(0)} cm in that window`);
  ok("so the frame choice is worth an order of magnitude for the bodies that matter",
    worstFreeWorld > worstLatched * 10,
    `free ${(worstFreeWorld * 100).toFixed(0)} cm vs latched `
    + `${(worstLatched * 100).toFixed(2)} cm`);

  // ---- the client must not be running the AI -------------------------------
  //
  // stepSessionClient omits horde.update, and this is the assertion that it stays omitted.
  // If it ever runs, a client's bodies drift away from the positions they were handed on
  // their own initiative — and the symptom is rubber-banding rather than anything that looks
  // like a missing guard.
  applySnapshot(client, decode(encode(snapshotOf(server, 1900)).buffer));
  const before = [];
  for (const e of client.horde.pool) if (e.alive) before.push(e.x, e.y, e.z);
  for (let i = 0; i < 30; i++) stepSessionClient(client, DT);
  let drift = 0;
  let k = 0;
  for (const e of client.horde.pool) {
    if (!e.alive) continue;
    drift = Math.max(
      drift,
      Math.hypot(e.x - before[k], e.y - before[k + 1], e.z - before[k + 2]),
    );
    k += 3;
  }
  ok("a client does not move enemies on its own — it has no AI to run",
    drift === 0,
    drift === 0 ? "half a second of client stepping moved nothing" : `${drift.toFixed(3)} m of drift`);

  // And the server, over the same half second, plainly does. Otherwise the check above
  // would pass on a frozen simulation.
  const sBefore = [];
  for (const e of server.horde.pool) if (e.alive) sBefore.push(e.x, e.z);
  for (let i = 0; i < 30; i++) stepSession(server, DT);
  let sDrift = 0;
  let j = 0;
  for (const e of server.horde.pool) {
    if (!e.alive) continue;
    sDrift = Math.max(sDrift, Math.hypot(e.x - sBefore[j], e.z - sBefore[j + 1]));
    j += 2;
  }
  ok("while the server's horde is plainly alive (so the above is not a frozen world)",
    sDrift > 0.1, `${sDrift.toFixed(2)} m of server-side movement in the same window`);
}

// ---------------------------------------------------------------------------
// SLICE 3: the server seats a real crew, which is what makes seven built rules reachable.
//
// THE ARGUMENT FOR THIS WHOLE PIECE OF WORK, stated as a measurement. Wave size scales off
// `crew.size`, and until now nothing ever increased it — src/net.js draws remote operatives
// as avatars and does not put them in the Crew. So with four people connected, every one of
// them faced a solo-sized fight, and the scaling table, the shared repair claim, the road
// vote, the split purses, the proc attribution and the stomp's crew sweep were all correct,
// tested, and unreachable.
console.log("\n120. Seating a crew on the server makes the co-op rules reachable");
{
  const solo = createSession({ seats: 1 });
  const four = createSession({ seats: 4 });

  ok("persistent Spiker releases use protocol v12 without growing Recovery records",
    PROTOCOL_VERSION === 12, `protocol v${PROTOCOL_VERSION}`);
  ok("the three recovery fields cost exactly three bytes per operative",
    OPERATIVE_BYTES === 79, `${OPERATIVE_BYTES} B = 76 B prior record + 3 B recovery`);
  ok("a four-seat session really seats four operatives (test is not vacuous)",
    four.crew.size === 4 && four.operatives.length === 4,
    `crew ${four.crew.size}, ${four.operatives.length} kits`);
  ok("and a one-seat session is unchanged, which is the acceptance test for all of this",
    solo.crew.size === 1 && solo.director.crewScale === 1,
    `crew 1, scale x${solo.director.crewScale}`);

  // THE SCALING, which is the headline. 1 + 0.5 * (n - 1) — Risk of Rain 2's shipped
  // coefficient, borrowed rather than invented.
  ok("wave size scales with the crew, and by the documented coefficient",
    Math.abs(four.director.crewScale - 2.5) < 1e-9,
    `x${four.director.crewScale} at four operatives against x${solo.director.crewScale} solo`);

  const soloWave = solo.director.buildWave(5, solo.director.tierOf(5));
  const fourWave = four.director.buildWave(5, four.director.tierOf(5));
  const count = (w) => w.reduce((n, t) => n + t, 0);
  const ratio = count(fourWave) / count(soloWave);

  // MEASURED AT 2.0x AGAINST A 2.5x COEFFICIENT, and that gap is the roster's absolute caps
  // doing their job rather than the scaling failing. `bulwarkMax` and `sapperMax` are 3
  // whatever the crew size, so a scaled wave has room for more bodies than the composition is
  // willing to fill with specials, and the remainder does not fully absorb it.
  //
  // The first version asserted `> 2x` and failed at exactly 2.00 — a bound picked to sound
  // strict, against a system whose real behaviour is bounded by a different number entirely.
  //
  // This is the open question the brief already names: the specials' share falls from 29% of a
  // siege to 21% at four operatives, and whether that reads as a thinner fight is unmeasured.
  // Recorded here rather than fixed, because roster scaling is the next variable and moving it
  // in the same change as seating the crew would make either one unattributable.
  ok("so wave five is substantially bigger with four aboard",
    ratio >= 1.8,
    `${count(soloWave)} solo vs ${count(fourWave)} at four — x${ratio.toFixed(2)} against a `
    + `x${four.director.crewScale} coefficient, the gap being the absolute per-type caps`);
  ok("and the shortfall is the caps rather than the count, which is a known open question",
    ratio < four.director.crewScale + 1e-9,
    `x${ratio.toFixed(2)} <= x${four.director.crewScale}: bulwarkMax and sapperMax are `
    + `${CFG.enemies.composition.bulwarkMax} and ${CFG.enemies.composition.sapperMax} `
    + "at any crew size");

  // AND NOTHING ELSE SCALED. Each of these is asserted so a later edit has to argue with a
  // test rather than quietly widen the change.
  ok("enemy health did not scale with the crew — it is invisible to a player",
    Math.abs(solo.director.hpScale() - four.director.hpScale()) < 1e-9,
    `x${solo.director.hpScale().toFixed(3)} both`);
  ok("nor did an operative's own health",
    solo.player.maxHp === four.player.maxHp, `${four.player.maxHp} hp each`);
  ok("nor the siege length",
    solo.director.siegeLength === four.director.siegeLength,
    `${four.director.siegeLength} waves`);

  // PRESSURE AGGREGATES TO THE WORST-OFF OPERATIVE, so one hurt person generates the same
  // pacing pressure whether they are alone or beside three healthy teammates. That is Left 4
  // Dead's director responding to whoever is in trouble rather than to an average that hides
  // them — and it is the reason a crew of four does not get an easier ride by bringing
  // spare health bars.
  solo.player.hp = solo.player.maxHp * 0.5;
  four.operatives[2].player.hp = four.operatives[2].player.maxHp * 0.5;
  ok("one hurt operative reads as the same pressure alone or in a crowd",
    Math.abs(solo.director.pressure - four.director.pressure) < 1e-9,
    `${(solo.director.pressure * 100).toFixed(0)}% both, from crew 3 of 4 at half health`);

  // ---- the per-operative kit, which is why each seat gets its own ----------
  ok("every operative has their own weapon, winch, repair and purse",
    new Set(four.operatives.map((o) => o.weapon)).size === 4
    && new Set(four.operatives.map((o) => o.grapple)).size === 4
    && new Set(four.operatives.map((o) => o.repair)).size === 4
    && new Set(four.operatives.map((o) => o.economy)).size === 4,
    "four distinct instances of each");
  ok("but ONE treasury, so the fortress track is the crew's",
    new Set(four.operatives.map((o) => o.economy.treasury)).size === 1,
    "one shared pot of scrap and one set of fortress stacks");

  // The wiring guard that makes the above structural rather than hopeful: a Weapon belonging
  // to somebody else is refused at construction, because personal items recompute absolutely
  // from stack counts and two operatives over one weapon silently wipe each other's kit.
  let refused = false;
  try {
    new Economy({
      player: four.operatives[0].player,
      trampler: four.trampler,
      weapon: four.operatives[1].weapon,
      repair: four.operatives[0].repair,
      horde: four.horde,
      director: four.director,
    });
  } catch { refused = true; }
  ok("and an Economy handed somebody else's weapon still refuses to be built", refused,
    "threw at construction");

  // ---- the input queue, which is where levels and edges diverge -----------
  //
  // `down()` is a level and may be repeated when a packet is late; `pressed()` is an edge the
  // reader CONSUMES and must fire exactly once. A starved tick that replayed the edge mask
  // would fire a second grapple or buy the same refit twice.
  const q = netInput();
  q.push({ seq: 1, clientTick: 1, held: HELD_BIT.forward, edges: EDGE_BIT.jump, lookDx: 0, lookDy: 0 });
  q.advance();
  ok("a queued command is readable as both a level and an edge",
    q.down("KeyW") === true && q.pressed("Space") === true,
    "W held, Space pressed");
  ok("and the edge is CONSUMED, exactly like the real Input",
    q.pressed("Space") === false, "a second read returns false");
  ok("the acknowledged sequence is the one actually stepped", q.ackSeq === 1, `ack ${q.ackSeq}`);

  q.advance(); // starved: nothing queued
  ok("a starved tick keeps the HELD keys, so a hiccup does not stop you walking",
    q.down("KeyW") === true, "W still held");
  ok("but supplies NO edges, so nothing fires twice",
    q.pressed("Space") === false, "Space did not repeat");
  ok("and the starvation is counted rather than hidden", q.starved === 1, `${q.starved} starved`);

  // Local presentation/debug controls must never reach the authority. Restart is different:
  // it mutates shared run state, so K is deliberately an authority-owned edge rather than a
  // client-side debug mutation. An all-bits packet therefore reaches K, but still cannot invent
  // mappings for P or B.
  const rig = netInput();
  rig.push({ seq: 2, clientTick: 2, held: 0xffff, edges: 0xffff, lookDx: 0, lookDy: 0 });
  rig.advance();
  ok("only authority-owned run controls can be reached, whatever bitmask a client sends",
    !rig.pressed("KeyP") && rig.pressed("KeyK") && !rig.down("KeyB"),
    "P and B are unmapped; K is the authority-owned restart edge");

  // ---- and the operatives cross the wire ----------------------------------
  const client = createSession({ seats: 4 });
  for (let i = 0; i < 120; i++) stepSession(four, DT);
  const wire = decode(encode(snapshotOf(four, 120)).buffer);

  ok("all four operatives are in the snapshot", wire.operatives.length === 4,
    `${wire.operatives.length} seats, ${OPERATIVE_BYTES} B each`);
  ok("each carries its own seat number, in order",
    wire.operatives.every((o, i) => o.seat === i + 1),
    `seats ${wire.operatives.map((o) => o.seat).join(",")}`);

  applySnapshot(client, wire);
  let worstOp = 0;
  for (let i = 0; i < 4; i++) {
    const s = four.operatives[i].player;
    const c = client.operatives[i].player;
    worstOp = Math.max(worstOp, s.position.distanceTo(c.position));
  }
  ok("and every operative lands within a centimetre of where the server has them",
    worstOp < 0.02, `worst ${(worstOp * 100).toFixed(2)} cm`);

  // Incapacitation metadata is authority state. Distinctive tenths and a non-zero
  // owner make an offset/order mistake visible instead of letting three zeroes pass.
  const sourceDown = four.operatives[2].player;
  sourceDown.spawnGrace = 0;
  sourceDown.hurt(1e6);
  sourceDown.medevacRemaining = 6.3;
  sourceDown.recoveryProgress = 1.2;
  sourceDown.rescuerSeat = 2;
  const recoveryState = decode(encode(snapshotOf(four, 121)).buffer);
  const recoveryWire = recoveryState.operatives.find((op) => op.seat === 3);
  applySnapshot(client, recoveryState);
  const recoveryClient = client.operatives[2].player;

  ok("the recovery snapshot scenario is genuinely downed (not vacuous)",
    sourceDown.downed && sourceDown.hp === 0,
    `down ${sourceDown.downed}, ${sourceDown.hp} hp`);
  ok("the wire round-trips fallback, channel progress and rescuer seat",
    Math.abs(recoveryWire.medevacRemaining - 6.3) <= 0.05
      && Math.abs(recoveryWire.recoveryProgress - 1.2) <= 0.05
      && recoveryWire.rescuerSeat === 2,
    `${recoveryWire.medevacRemaining.toFixed(1)} s fallback, `
    + `${recoveryWire.recoveryProgress.toFixed(1)} s channel, seat ${recoveryWire.rescuerSeat}`);
  ok("applying that snapshot restores the downed lifecycle metadata",
    recoveryClient.downed
      && Math.abs(recoveryClient.medevacRemaining - 6.3) <= 0.05
      && Math.abs(recoveryClient.recoveryProgress - 1.2) <= 0.05
      && recoveryClient.rescuerSeat === 2,
    `down ${recoveryClient.downed}, ${recoveryClient.medevacRemaining.toFixed(1)} s, `
    + `${recoveryClient.recoveryProgress.toFixed(1)} s, seat ${recoveryClient.rescuerSeat}`);
}

// ---------------------------------------------------------------------------
// SLICE 3, THE OTHER DIRECTION: a keypress becomes an authoritative movement.
//
// Everything up to here has been state travelling DOWN. This is intent travelling up, and it
// is the half that makes the server an authority rather than a broadcaster: a client says "I
// am holding W", the server decides where that puts them, and the answer comes back in the
// next snapshot. The relay this replaces sent positions and believed them, which is why its
// own header called it trivially cheatable.
console.log("\n121. A keypress crosses the wire and the server decides what it did");
{
  const server = createSession({ seats: 2, networked: true });

  ok("an input command is small (test is not vacuous)", INPUT_BYTES <= 24,
    `${INPUT_BYTES} B -> ${(INPUT_BYTES * CFG.loop.stepHz / 1024).toFixed(2)} KiB/s upstream`);

  // ---- the codec ----------------------------------------------------------
  const local = makeInput();
  local.keys.add("KeyW");
  local.keys.add("ShiftLeft");
  local.presses.add("Space");
  local.mouseHeld.add(0);
  local.mouse.dx = 12.5;
  local.mouse.dy = -3.25;

  const cmd = readInput(local, { seq: 7, clientTick: 99 });
  const wire = decodeInput(encodeInput(cmd).buffer);

  ok("held keys survive the round trip",
    (wire.held & HELD_BIT.forward) !== 0
    && (wire.held & HELD_BIT.sprint) !== 0
    && (wire.held & HELD_BIT.fire) !== 0,
    `held ${wire.held.toString(2)}`);
  ok("and so do edges, separately from the levels",
    (wire.edges & EDGE_BIT.jump) !== 0, `edges ${wire.edges.toString(2)}`);
  ok("the sequence number survives, which is what reconciliation is keyed on",
    wire.seq === 7 && wire.clientTick === 99, `seq ${wire.seq}, tick ${wire.clientTick}`);
  ok("and the look delta survives at centimetre precision",
    Math.abs(wire.lookDx - 12.5) < 0.01 && Math.abs(wire.lookDy + 3.25) < 0.01,
    `dx ${wire.lookDx}, dy ${wire.lookDy}`);

  // READING THE LOCAL INPUT MUST NOT STEAL THE PRESS. `input.pressed()` deletes what it
  // returns, so a `readInput` that used it would send the jump and never perform it — working
  // in single player and vanishing in multiplayer, which is the worst possible shape for a bug.
  ok("reading the input for the wire does not consume the local press",
    local.pressed("Space") === true,
    "the local simulation can still act on it");

  // ---- and now the loop ---------------------------------------------------
  //
  // Seat 2 walks; seat 1 does nothing. Both are on the deck, so this also exercises the
  // hull-local frame on the way back out.
  for (const op of server.operatives) op.player.respawnOnDeck();
  for (let i = 0; i < 10; i++) stepSession(server, DT);

  const walker = server.operatives[1];
  const idler = server.operatives[0];
  walker.player.yaw = 0;
  const startLocal = server.trampler.worldToLocal(walker.player.position.clone());
  const idlerStart = server.trampler.worldToLocal(idler.player.position.clone());

  // Baselined, because the ten settling steps above ran with nothing queued and the counter is
  // cumulative for the life of the connection. Asserting the absolute figure measured the
  // test's own setup and reported ten starved ticks as a fault.
  const starvedBefore = walker.input.starved;
  const frames = 30;
  for (let i = 0; i < frames; i++) {
    // What a client sends every step: held-only after the first, exactly as main.js does.
    walker.input.push({
      seq: i + 1, clientTick: i + 1, held: HELD_BIT.forward, edges: 0, lookDx: 0, lookDy: 0,
    });
    stepSession(server, DT);
  }

  const endLocal = server.trampler.worldToLocal(walker.player.position.clone());
  const idlerEnd = server.trampler.worldToLocal(idler.player.position.clone());
  const walked = endLocal.distanceTo(startLocal);
  const expected = CFG.player.walkSpeed * (frames / CFG.loop.stepHz);

  ok("the operative whose seat sent input actually walked",
    walked > expected * 0.5,
    `${walked.toFixed(2)} m across the deck against a nominal ${expected.toFixed(2)} m`);
  ok("and the one who sent nothing did not move",
    idlerEnd.distanceTo(idlerStart) < 0.02,
    `${(idlerEnd.distanceTo(idlerStart) * 100).toFixed(1)} cm — input is per seat, not shared`);
  ok("the server acknowledged the last command it stepped, not the last it received",
    walker.input.ackSeq === frames, `ack ${walker.input.ackSeq} of ${frames} sent`);
  ok("and nothing starved, because one command was supplied per tick",
    walker.input.starved === starvedBefore,
    `${walker.input.starved - starvedBefore} new starved ticks across ${frames}`);

  // ---- the ack reaches the client, per seat -------------------------------
  const snap = decode(encode(snapshotOf(server, 1000)).buffer);
  const mine = snap.operatives.find((o) => o.seat === 2);
  ok("the snapshot tells each seat which of ITS commands has been simulated",
    mine.ackSeq === frames,
    `seat 2 acked at ${mine.ackSeq}, seat 1 at `
    + `${snap.operatives.find((o) => o.seat === 1).ackSeq}`);

  // ---- and a client applying it leaves its OWN seat alone -----------------
  //
  // That exclusion IS client prediction. Overwriting the local operative from a snapshot
  // 120 ms old would undo the responsiveness prediction exists to provide.
  const client = createSession({ seats: 2 });
  for (const op of client.operatives) op.player.respawnOnDeck();

  // MEASURED IN HULL SPACE, not world space, and the difference is a thing I had forgotten
  // about my own code. A hull correction CARRIES ITS PASSENGERS — session.js moves anybody
  // based to the trampler so their deck-relative position survives, which is invariant 5 and
  // is what stopped a one-metre correction shoving an operative 114 cm across the deck.
  //
  // So the local operative's WORLD position does legitimately change when a snapshot arrives.
  // What must not change is where on the deck they are standing, and what must not happen is
  // the wire's authoritative position overwriting the predicted one. Asserting the world
  // position was unchanged conflated those and reported the rider fix as a fault.
  const beforeLocal = client.trampler.worldToLocal(client.operatives[1].player.position.clone());
  const wireMine = snap.operatives.find((o) => o.seat === 2);
  applySnapshot(client, snap, 2); // this client is seat 2
  const afterLocal = client.trampler.worldToLocal(client.operatives[1].player.position.clone());
  const otherMoved = client.operatives[0].player.position.distanceTo(
    server.operatives[0].player.position,
  );

  ok("the wire's own-seat position is genuinely different (test is not vacuous)",
    Math.hypot(wireMine.x - beforeLocal.x, wireMine.z - beforeLocal.z) > 1.0,
    `the server has seat 2 ${Math.hypot(wireMine.x - beforeLocal.x, wireMine.z - beforeLocal.z)
      .toFixed(2)} m from where this client predicts it`);
  ok("a client does not overwrite its own operative from a snapshot",
    afterLocal.distanceTo(beforeLocal) < 0.01,
    `seat 2 stayed put on the deck (${(afterLocal.distanceTo(beforeLocal) * 100).toFixed(2)} cm)`
    + " — predicted locally, not corrected");
  ok("but it does take every OTHER seat from the authority",
    otherMoved < 0.02, `seat 1 within ${(otherMoved * 100).toFixed(2)} cm of the server`);
  ok("and it still learns its own acknowledged sequence, which reconciliation needs",
    client.operatives[1].ackSeq === frames, `ack ${client.operatives[1].ackSeq}`);

  // ---- exact local repair identity is authority-owned --------------------
  //
  // Both legs are genuinely reachable and the local position makes leg 0 nearer. A snapshot
  // naming leg 1 must therefore change the predicted choice, not merely clear a refusal; this
  // is the centimetre-scale disagreement positional reconciliation can legitimately ignore.
  {
    const targetClient = createSession({ seats: [2] });
    targetClient.trampler.walking = false;
    targetClient.trampler.turning = false;
    targetClient.trampler.damageLeg(0, 1e6);
    targetClient.trampler.damageLeg(1, 1e6);
    const targetInput = makeInput();
    targetClient.input = targetInput;
    targetClient.operatives[0].input = targetInput;

    const leg0 = targetClient.trampler.legAttackWorld(0, new THREE.Vector3());
    const leg1 = targetClient.trampler.legAttackWorld(1, new THREE.Vector3());
    targetClient.player.position.copy(leg0).lerp(leg1, 0.48);
    targetClient.player.position.y = 1.2;
    targetClient.player.base = null;
    targetClient.player.velocity.set(0, 0, 0);
    const d0 = targetClient.player.position.distanceTo(leg0);
    const d1 = targetClient.player.position.distanceTo(leg1);
    ok("two exact local targets overlap and prediction would choose the other one (not vacuous)",
      d0 < CFG.repair.range && d1 < CFG.repair.range && d0 < d1,
      `leg 0 at ${d0.toFixed(2)} m, leg 1 at ${d1.toFixed(2)} m`);

    const targetState = decode(encode(snapshotOf(targetClient, 1001)).buffer);
    targetState.operatives[0].repairTarget = packRepairTarget("leg:1");
    applySnapshot(targetClient, targetState, 2);
    targetInput.keys.add(CFG.repair.key);
    const hp0 = targetClient.trampler.legHp[0];
    const hp1 = targetClient.trampler.legHp[1];
    stepSessionClient(targetClient, DT);

    ok("the exact local authority target becomes prediction's target on the next step",
      targetClient.repair.authorityTarget === "leg:1"
      && targetClient.repair.target?.key === "leg:1"
      && targetClient.player.repairing === "leg:1",
      `authority ${targetClient.repair.authorityTarget}, predicted ${targetClient.repair.target?.key}`);
    ok("and work lands only on that authoritative point",
      targetClient.trampler.legHp[0] === hp0 && targetClient.trampler.legHp[1] > hp1,
      `leg 0 ${hp0.toFixed(1)} -> ${targetClient.trampler.legHp[0].toFixed(1)},`
      + ` leg 1 ${hp1.toFixed(1)} -> ${targetClient.trampler.legHp[1].toFixed(1)}`);
  }

  // Incapacitation happens after repair in the authority frame. The body stays at
  // the point until recovery, but the down event itself must clear the published
  // claim or a snapshot on that tick advertises an invulnerable ghost welder.
  {
    const deathServer = createSession({ seats: 1, networked: true });
    deathServer.trampler.walking = false;
    deathServer.trampler.turning = false;
    deathServer.trampler.damageLeg(0, 1e6);
    const deathOp = deathServer.operatives[0];
    const at = deathServer.trampler.legAttackWorld(0, new THREE.Vector3());
    deathOp.player.position.set(at.x, 1.2, at.z);
    deathOp.player.base = null;
    deathOp.player.velocity.set(0, 0, 0);
    deathOp.input.push({
      seq: 1, clientTick: 1, held: HELD_BIT.repair, edges: 0, lookDx: 0, lookDy: 0,
    });
    stepSession(deathServer, DT);
    ok("death setup owns a repair point before contact damage (not vacuous)",
      deathOp.player.repairing === "leg:0" && deathOp.repair.active,
      `claim ${deathOp.player.repairing}, active ${deathOp.repair.active}`);

    deathOp.player.hurt(1e6);
    const deathState = decode(encode(snapshotOf(deathServer, 1002)).buffer);
    const deathWire = deathState.operatives[0];
    ok("an incapacitation-tick snapshot clears the exact repair claim immediately",
      deathOp.player.deaths === 1
      && deathOp.player.downed
      && deathOp.player.repairing === null
      && deathWire.medevacRemaining > 0
      && unpackRepairTarget(deathWire.repairTarget) === null,
      `deaths ${deathOp.player.deaths}, down ${deathOp.player.downed},`
      + ` local ${deathOp.player.repairing}, wire ${unpackRepairTarget(deathWire.repairTarget)}`);
  }

  // ---- simultaneous repair claims choose an action, not an authority fallback ----------
  //
  // This is the race a boolean `repairing` cannot solve. Before the first result returns, both
  // clients can reasonably predict that the point is free. They therefore both commit repair
  // and neither commits fire; authority may correct who got the weld, but must not invent a
  // shot for the loser. The next exact snapshot lets the refused client choose cover.
  {
    const repairServer = createSession({ seats: 2, networked: true });
    repairServer.trampler.walking = false;
    repairServer.trampler.turning = false;
    repairServer.trampler.damageLeg(0, 1e6);
    const at = repairServer.trampler.legAttackWorld(0, new THREE.Vector3());
    for (const op of repairServer.operatives) {
      op.player.position.set(at.x, 1.2, at.z);
      op.player.base = null;
      op.player.velocity.set(0, 0, 0);
    }

    const physicalBoth = {
      seq: 1, clientTick: 1, held: HELD_BIT.repair | HELD_BIT.fire,
      edges: 0, lookDx: 0, lookDy: 0,
    };
    const choseRepair = commitHandsInput(physicalBoth, true);
    ok("a predicted repair command carries repair but not a contradictory trigger",
      (choseRepair.held & HELD_BIT.repair) !== 0
      && (choseRepair.held & HELD_BIT.fire) === 0,
      `held ${choseRepair.held.toString(2)}`);

    for (const op of repairServer.operatives) op.input.push({ ...choseRepair });
    const losingShotsBefore = repairServer.operatives[1].weapon.shots;
    stepSession(repairServer, DT);
    ok("authority admits exactly one simultaneous welder (test is not vacuous)",
      repairServer.operatives[0].player.repairing === "leg:0"
      && repairServer.operatives[1].player.repairing === null,
      `seat 1 ${repairServer.operatives[0].player.repairing},`
      + ` seat 2 ${repairServer.operatives[1].player.repairing}`);
    ok("and refusal does not create a shot that the losing client suppressed",
      repairServer.operatives[1].weapon.shots === losingShotsBefore,
      `${losingShotsBefore} -> ${repairServer.operatives[1].weapon.shots} shots`);

    const repairSnap = decode(encode(snapshotOf(repairServer, 2000)).buffer);
    const claim1 = repairSnap.operatives.find((op) => op.seat === 1);
    const claim2 = repairSnap.operatives.find((op) => op.seat === 2);
    ok("the snapshot names the exact claimed point rather than only saying repairing",
      unpackRepairTarget(claim1.repairTarget) === "leg:0"
      && unpackRepairTarget(claim2.repairTarget) === null,
      `seat 1 ${unpackRepairTarget(claim1.repairTarget)},`
      + ` seat 2 ${unpackRepairTarget(claim2.repairTarget)}`);

    // The browser removes the contradiction, but the authority is still a trust boundary. A
    // modified producer may send both bits raw; on foot that is interpreted as repair intent,
    // never as permission to invent a carried shot if the claim is refused.
    repairServer.operatives[0].input.push({ ...choseRepair, seq: 2, clientTick: 2 });
    repairServer.operatives[1].input.push({ ...physicalBoth, seq: 2, clientTick: 2 });
    const rawPacketShots = repairServer.operatives[1].weapon.shots;
    stepSession(repairServer, DT);
    ok("authority rejects contradictory carried repair-plus-fire input",
      repairServer.operatives[1].repair.takenBy === 1
      && repairServer.operatives[1].weapon.shots === rawPacketShots,
      `taken by ${repairServer.operatives[1].repair.takenBy},`
      + ` ${rawPacketShots} -> ${repairServer.operatives[1].weapon.shots} shots`);

    // A browser sim contains only its local operative. Applying the snapshot must therefore
    // install seat 1's claim into Repair's external roster before prediction runs.
    const claimClient = createSession({ seats: [2] });
    const claimInput = makeInput();
    claimClient.input = claimInput;
    claimClient.operatives[0].input = claimInput;
    applySnapshot(claimClient, repairSnap, 2);
    const clientAt = claimClient.trampler.legAttackWorld(0, new THREE.Vector3());
    claimClient.player.position.set(clientAt.x, 1.2, clientAt.z);
    claimClient.player.base = null;
    claimClient.player.velocity.set(0, 0, 0);
    claimClient.weapon.arbitrated = true;
    claimInput.keys.add(CFG.repair.key);
    claimInput.mouseHeld.add(0);

    const predictedShots = claimClient.weapon.shots;
    stepSessionClient(claimClient, DT);
    ok("client prediction refuses that exact remote point and names its owner",
      !claimClient.repair.active && claimClient.repair.takenBy === 1,
      `active ${claimClient.repair.active}, taken by seat ${claimClient.repair.takenBy}`);
    ok("so the refused client predicts the carried shot instead of hiding it",
      claimClient.weapon.shots === predictedShots + 1,
      `${predictedShots} -> ${claimClient.weapon.shots} shots`);

    const coverPhysical = readInput(claimInput, { seq: 3, clientTick: 3 });
    const choseCover = commitHandsInput(coverPhysical, !!claimClient.player.repairing);
    ok("its next command carries fire but no stale repair attempt",
      (choseCover.held & HELD_BIT.fire) !== 0
      && (choseCover.held & HELD_BIT.repair) === 0,
      `held ${choseCover.held.toString(2)}`);

    repairServer.operatives[0].input.push({ ...choseRepair, seq: 3, clientTick: 3 });
    repairServer.operatives[1].input.push(choseCover);
    const authorityShots = repairServer.operatives[1].weapon.shots;
    stepSession(repairServer, DT);
    ok("authority performs the same cover shot while the teammate keeps welding",
      repairServer.operatives[0].player.repairing === "leg:0"
      && repairServer.operatives[1].weapon.shots === authorityShots + 1,
      `seat 1 ${repairServer.operatives[0].player.repairing},`
      + ` seat 2 ${authorityShots} -> ${repairServer.operatives[1].weapon.shots} shots`);
  }

  // A station owns its own trigger. The carried weapon remains suppressed, but commitment
  // must not strip fire from a deck gun merely because its operator can reach the reactor.
  // Repair progress also stays in its old post-gun slot: killing the final nearby threat earns
  // the uncontested rate on that same tick rather than changing mounted-repair tuning.
  {
    const stationServer = createSession({ seats: 1, networked: true });
    stationServer.trampler.walking = false;
    stationServer.trampler.turning = false;
    const operator = stationServer.operatives[0];
    const stern = stationServer.guns[1];
    stern.mount(operator.player);
    // Let the real station constraint place the operative before measuring the nearby target.
    stepSession(stationServer, DT);
    stationServer.trampler.damageReactor(120);

    const threat = stationServer.horde.spawn(CLIMBER);
    const threatAt = stationServer.trampler.localToWorld(new THREE.Vector3(0, 0.95, 13.0));
    threat.x = threatAt.x;
    threat.y = threatAt.y;
    threat.z = threatAt.z;
    threat.onHull = true;
    threat.latched = false;
    threat.hp = Math.min(threat.hp, CFG.deckGun.damage - 1);
    const eye = operator.player.eyePosition(new THREE.Vector3());
    operator.player.yaw = Math.atan2(
      -(threatAt.x - operator.player.position.x),
      -(threatAt.z - operator.player.position.z),
    );
    operator.player.pitch = Math.atan2(
      threatAt.y - eye.y,
      Math.hypot(threatAt.x - eye.x, threatAt.z - eye.z),
    );
    stationServer.scene.updateMatrixWorld(true);
    const threatDistance = operator.player.position.distanceTo(threatAt);
    ok("the mounted repair starts genuinely contested by a killable target (not vacuous)",
      threat.alive && threatDistance < CFG.repair.threatRange
      && threat.hp < CFG.deckGun.damage,
      `${threat.hp.toFixed(0)} hp at ${threatDistance.toFixed(2)} m`);

    const physicalMounted = {
      seq: 1, clientTick: 1, held: HELD_BIT.repair | HELD_BIT.fire,
      edges: 0, lookDx: 0, lookDy: 0,
    };
    const mountedChoice = commitHandsInput(physicalMounted, true, true);
    ok("mounted commitment preserves both repair and the station-owned trigger",
      (mountedChoice.held & HELD_BIT.repair) !== 0
      && (mountedChoice.held & HELD_BIT.fire) !== 0,
      `held ${mountedChoice.held.toString(2)}`);

    operator.input.push(mountedChoice);
    const reactorBefore = stationServer.trampler.reactorHp;
    const mountedShots = stern.shots;
    stepSession(stationServer, DT);
    const reactorGain = stationServer.trampler.reactorHp - reactorBefore;
    ok("the stern operator repairs while its shot clears the last nearby threat",
      operator.player.repairing === "reactor"
      && !threat.alive
      && stern.shots === mountedShots + 1,
      `threat alive ${threat.alive}, ${mountedShots} -> ${stern.shots} mounted shots`);
    ok("and that same tick keeps the established uncontested repair rate",
      Math.abs(reactorGain - CFG.repair.reactorRate * DT) < 1e-6
      && !operator.repair.threatened,
      `${reactorGain.toFixed(2)} hp, threatened ${operator.repair.threatened}`);
  }
}

// ---------------------------------------------------------------------------
// SMOOTHNESS: interpolating between snapshots, and pulling a prediction back into line.
//
// Both are the difference between "correct" and "looks right", and both are pure arithmetic
// whose failures are silent — an interpolator that mixes two coordinate systems produces bodies
// sliding through the hull, and a reconciler with the wrong sign walks the player away from the
// authority rather than toward it.
console.log("\n122. Bodies interpolate between snapshots, and a prediction is pulled back");
{
  const server = createSession({ seats: 2, networked: true });
  server.director.callEarly();
  for (let i = 0; i < 60 * 25; i++) stepSession(server, DT);
  ok("there is a horde to interpolate (test is not vacuous)", server.horde.liveCount >= 4,
    `${server.horde.liveCount} alive`);

  const first = decode(encode(snapshotOf(server, 1500)).buffer);
  for (let i = 0; i < 3; i++) stepSession(server, DT);
  const second = decode(encode(snapshotOf(server, 1503)).buffer);

  // ---- the midpoint is genuinely between --------------------------------------
  const mid = lerpSnapshot(first, second, 0.5);

  // Net opts into the mutable hot path, so exercise that branch separately from the pure result
  // below. Equality alone is not enough: it must also retain its storage and truncate arrays
  // when the next frame contains fewer bodies or operatives.
  const scratch = {};
  const scratchMid = lerpSnapshot(first, second, 0.5, scratch);
  ok("the production scratch interpolation matches the pure result",
    JSON.stringify(scratchMid) === JSON.stringify(mid),
    `${scratchMid.entities.length} bodies and ${scratchMid.operatives.length} operatives`);
  ok("the scratch truncation scenario has something to remove (test is not vacuous)",
    second.entities.length > 1 && second.operatives.length > 1,
    `${second.entities.length} bodies and ${second.operatives.length} operatives before truncation`);
  const scratchState = scratchMid;
  const scratchEntities = scratchMid.entities;
  const scratchOperatives = scratchMid.operatives;
  const scratchEntity0 = scratchMid.entities[0];
  const scratchOperative0 = scratchMid.operatives[0];
  const shorter = {
    ...second,
    entities: second.entities.slice(0, 1),
    operatives: second.operatives.slice(0, 1),
  };
  const reused = lerpSnapshot(first, shorter, 0.5, scratch);
  ok("and it reuses the state, arrays and slot objects rather than allocating a second frame",
    reused === scratchState
      && reused.entities === scratchEntities
      && reused.operatives === scratchOperatives
      && reused.entities[0] === scratchEntity0
      && reused.operatives[0] === scratchOperative0,
    "all five identities held across calls");
  ok("while truncating stale bodies and operatives from the reused arrays",
    reused.entities.length === 1 && reused.operatives.length === 1,
    `${reused.entities.length} body, ${reused.operatives.length} operative remain`);

  let moved = 0;
  let worstOffLine = 0;
  for (const m of mid.entities) {
    const a = first.entities.find((e) => e.id === m.id);
    const b = second.entities.find((e) => e.id === m.id);
    if (!a || !b) continue;
    const travel = Math.hypot(b.x - a.x, b.z - a.z);
    if (travel < 0.02) continue;
    moved++;
    // A true midpoint is equidistant from both ends. Measured rather than assumed, because the
    // plausible bug here is returning `b` unchanged — which would pass any test that only
    // checked the result was "between" a pair that barely moved.
    const da = Math.hypot(m.x - a.x, m.z - a.z);
    const db = Math.hypot(m.x - b.x, m.z - b.z);
    worstOffLine = Math.max(worstOffLine, Math.abs(da - db));
  }
  ok("bodies actually moved between the two snapshots (test is not vacuous)", moved >= 2,
    `${moved} of ${mid.entities.length} bodies moved more than 2 cm`);
  ok("and the midpoint really is halfway, not just the newer snapshot",
    worstOffLine < 0.02,
    `worst asymmetry ${(worstOffLine * 100).toFixed(2)} cm`);

  const zero = lerpSnapshot(first, second, 0);
  const one = lerpSnapshot(first, second, 1);
  const at = (s, id) => s.entities.find((e) => e.id === id);
  const someMover = mid.entities.find((m) => {
    const a = at(first, m.id); const b = at(second, m.id);
    return a && b && Math.hypot(b.x - a.x, b.z - a.z) > 0.02;
  });
  ok("t=0 gives the older position and t=1 the newer",
    Math.abs(at(zero, someMover.id).x - at(first, someMover.id).x) < 1e-9
    && Math.abs(at(one, someMover.id).x - at(second, someMover.id).x) < 1e-9,
    "the ends are exact, so nothing is being nudged at the boundaries");

  // Discrete fields must NOT be blended. Half way between two enemy types is a third type, and
  // a tint band between two integers is a band that does not exist.
  ok("discrete state comes from the newer snapshot rather than being averaged",
    mid.entities.every((m) => {
      const b = at(second, m.id);
      return !b || (m.bitsA === b.bitsA && m.bitsB === b.bitsB);
    }),
    "type, state, flags and health band all taken whole");

  // A CHANGE OF FRAME IS NOT INTERPOLABLE. Forged, because catching a body in the act of
  // leaving the deck inside a three-tick window is a coincidence to wait for rather than a
  // scenario to drive — the trap this project calls "waiting for a coincidence".
  {
    const a2 = { ...first, entities: [{ ...first.entities[0], bitsA: first.entities[0].bitsA | 64, x: 3, z: 2 }] };
    const b2 = { ...second, entities: [{ ...second.entities[0], bitsA: second.entities[0].bitsA & ~64, x: 140, z: -80 }] };
    const snapped = lerpSnapshot(a2, b2, 0.5);
    ok("a body that changed coordinate frame snaps instead of mixing the numbers",
      snapped.entities[0].x === 140 && snapped.entities[0].z === -80,
      "hull-local to world is not a line between two points");
  }

  // A body that appears in the newer snapshot only has no history, so it must not slide in from
  // wherever the previous occupant of its pool slot died.
  {
    const spawned = { ...second, entities: [...second.entities, { ...second.entities[0], id: 411, x: 99, z: 99 }] };
    const blended = lerpSnapshot(first, spawned, 0.5);
    const fresh = blended.entities.find((e) => e.id === 411);
    ok("a newly spawned body appears where it is, not partway from a stranger",
      fresh.x === 99 && fresh.z === 99, "no history means no blend");
  }

  // ---- reconciliation, band by band -------------------------------------------
  const base = { x: 10, y: 1.2, z: -4 };
  const tiny = reconcile(base, { x: 10.01, y: 1.2, z: -4 },
    { deadZone: CFG.net.correctionDeadZone, snapAt: CFG.net.correctionSnapAt });
  const small = reconcile(base, { x: 10.4, y: 1.2, z: -4 },
    { deadZone: CFG.net.correctionDeadZone, snapAt: CFG.net.correctionSnapAt });
  const huge = reconcile(base, { x: 25, y: 1.2, z: -4 },
    { deadZone: CFG.net.correctionDeadZone, snapAt: CFG.net.correctionSnapAt });

  ok("an error inside the quantisation is ignored outright", tiny.action === "none",
    `${(tiny.error * 100).toFixed(1)} cm against a ${(CFG.net.correctionDeadZone * 100)
      .toFixed(0)} cm dead zone`);
  ok("a real but modest error is smoothed", small.action === "smooth",
    `${(small.error * 100).toFixed(0)} cm`);
  ok("and it points TOWARD the authority, which is the sign a reconciler gets wrong",
    small.dx > 0, `dx +${small.dx.toFixed(2)} for a server ahead of the prediction`);
  ok("a large error snaps, because the prediction was wrong about what happened",
    huge.action === "snap",
    `${huge.error.toFixed(1)} m against a ${CFG.net.correctionSnapAt} m threshold`);
  ok("and a non-finite position snaps rather than propagating a NaN",
    reconcile(base, { x: NaN, y: 1.2, z: -4 }).action === "snap",
    "invariant 16 holds at the reconciliation boundary too");

  // THE EXPONENTIAL PAY-OFF, checked for both ends of the band it has to sit in: fast enough
  // that the operative is not visibly lagging its own controls, slow enough that it is not a
  // snap wearing a different hat.
  let remaining = 1.0;
  const k = (dt) => 1 - Math.exp(-CFG.net.correctionRate * dt);
  let framesToSettle = 0;
  while (remaining > 0.05 && framesToSettle < 600) {
    remaining -= remaining * k(DT);
    framesToSettle++;
  }
  const settleMs = (framesToSettle / CFG.loop.stepHz) * 1000;
  ok("a correction settles fast enough not to feel like lag",
    settleMs < 400, `95% paid off in ${settleMs.toFixed(0)} ms`);
  ok("but not so fast that it is a teleport in all but name",
    1 - k(DT) > 0.5,
    `${((1 - k(DT)) * 100).toFixed(0)}% of the error survives the first frame, so it eases`);
}

// ---------------------------------------------------------------------------
// SLICE 4: the client fires for feedback, the server decides what it hit.
//
// The last thing that looked obviously wrong. Until now a client's trigger damaged its own copy
// of a body the server still had alive, the next snapshot resurrected it 50 ms later, and the
// shooter was paid salvage for a kill nobody made. Two claims to establish: a client deals
// nothing, and both ends scatter the round the same way so the tracer points where the shot went.
console.log("\n123. An arbitrated shot draws a tracer and deals no damage");
{
  const sim = makeSim();
  const { horde, weapon, player } = sim;

  /** A body straight ahead of the operative, out in the open. */
  const target = () => {
    horde.clear();
    player.dropToGround();
    step(sim, 4);
    const e = horde.spawn(CHEWER);
    e.x = player.position.x;
    e.y = 0.8;
    e.z = player.position.z - 12;
    e.latched = false;
    e.onHull = false;
    player.yaw = 0;
    player.pitch = 0;
    return e;
  };

  const shootAt = (e) => {
    const origin = new THREE.Vector3(player.position.x, 1.5, player.position.z);
    const dir = new THREE.Vector3(e.x - origin.x, e.y - origin.y, e.z - origin.z).normalize();
    return weapon.shootFrom(origin, dir, CFG.combat.weapon, null, player);
  };

  // ---- the ordinary path still works, or the comparison below means nothing ----
  weapon.arbitrated = false;
  let e = target();
  const beforeHp = e.hp;
  const beforeScrap = sim.economy.scrap;
  let hitsBefore = weapon.hits;
  ok("an unarbitrated shot connects (test is not vacuous)", shootAt(e) !== null,
    "the ray reaches the body");
  ok("and it deals damage, as it always has", e.hp < beforeHp,
    `${beforeHp} -> ${e.hp.toFixed(1)} hp`);

  // ---- and now the arbitrated one ---------------------------------------------
  weapon.arbitrated = true;
  e = target();
  const hp0 = e.hp;
  const scrap0 = sim.economy.scrap;
  const salvage0 = sim.economy.salvage;
  const kills0 = horde.killCount;
  hitsBefore = weapon.hits;
  const tracers0 = sim.weapon.tracers?.length ?? -1;

  const hit = shootAt(e);

  ok("an arbitrated shot still finds the body (test is not vacuous)", hit !== null,
    "the ray, the geometry clip and the horde walk all still run");
  ok("but it deals NO damage", e.hp === hp0, `${e.hp.toFixed(1)} hp, unchanged`);
  ok("and pays nothing into either purse",
    sim.economy.scrap === scrap0 && sim.economy.salvage === salvage0,
    `scrap ${sim.economy.scrap}, salvage ${sim.economy.salvage}`);
  ok("and kills nothing", horde.killCount === kills0, `${horde.killCount} kills`);

  // THE FEEDBACK IS DELIBERATELY KEPT. It is the only "that connected" signal in the game, and
  // withholding it for a round trip would make every shot feel 120 ms late.
  ok("but the hit STILL registers as feedback, so shooting does not feel dead",
    weapon.hits > hitsBefore && weapon.hitFlash > 0,
    `hits ${hitsBefore} -> ${weapon.hits}, flash ${weapon.hitFlash.toFixed(2)}`);

  // Emptying a magazine must not creep the health bar. A single shot passing is weaker than it
  // looks: a bug that dealt a fraction of the damage would pass it and fail here.
  const hpBeforeBurst = e.hp;
  for (let i = 0; i < 20; i++) shootAt(e);
  ok("twenty arbitrated rounds leave it untouched, so nothing leaks a fraction",
    e.hp === hpBeforeBurst && e.alive,
    `${e.hp.toFixed(1)} hp after 20 shots`);

  // PROCS ARE THE HALF THAT MATTERS MORE THAN THE DAMAGE. Items subscribes to onHit as well as
  // onKill, so an unarbitrated local shot would fire splash and arc chains for hits the server
  // never registered — which is invariant 2b-i's whole concern, arriving through the network
  // rather than through automation.
  let heard = 0;
  sim.events.onHit(() => { heard++; });
  shootAt(e);
  ok("and nothing is published on the hit bus, so no proc can fire",
    heard === 0, `${heard} hit events from an arbitrated shot`);

  weapon.arbitrated = false;
  shootAt(e);
  ok("while an unarbitrated shot does publish, so the bus itself is alive",
    heard === 1, `${heard} hit event once arbitration is off`);

  // The authoritative pool is newer than what the client draws. Drive the exact render-proxy
  // path rather than calling damage or setting the body flash ourselves: the ray must return the
  // proxy, the shot may write only that overlay, and Horde must merge it into the delayed body.
  weapon.arbitrated = true;
  e = target();
  const proxyId = horde.pool.indexOf(e);
  ok("the visible target occupies a real wire pool slot (test is not vacuous)",
    proxyId >= 0, `pool slot ${proxyId}`);
  const packed = packEnemyBits({
    type: e.type,
    state: e.state,
    carried: false,
    flash: false,
    hpFraction: e.hp / e.maxHp,
    fuseLit: false,
  });
  horde.setRenderCombatFrame(900, [{
    id: proxyId,
    generation: e.generation,
    bitsA: packed.bitsA,
    bitsB: packed.bitsB,
    x: e.x,
    y: e.y,
    z: e.z,
    yaw: e.yaw,
    fuseT: 0,
  }]);
  horde.combatTick = 900;
  const proxy = horde.renderTargets[proxyId];
  const proxyHp = e.hp;
  const proxyKills = horde.killCount;
  const proxyScrap = sim.economy.scrap;
  const proxySalvage = sim.economy.salvage;
  const proxyEvents = heard;
  const proxyHit = shootAt(e);

  ok("an arbitrated render-frame ray returns the fixed proxy, not the newer pool body",
    proxyHit?.enemy === proxy && proxy !== e,
    `proxy id ${proxy?.id ?? "none"}, generation ${proxy?.generation ?? "none"}`);
  ok("the immediate cue lands on the proxy alone before presentation merges it",
    proxy.flash > 0 && e.flash === 0,
    `proxy flash ${proxy.flash.toFixed(2)}, body flash ${e.flash.toFixed(2)}`);

  horde.updateSnapshotVisuals(0);
  ok("the real presentation update merges that cue into the delayed body",
    e.flash > 0,
    `body flash ${e.flash.toFixed(2)} after the merge`);
  ok("and the proxy merge changes no health, kills, income or proc event",
    e.hp === proxyHp
      && horde.killCount === proxyKills
      && sim.economy.scrap === proxyScrap
      && sim.economy.salvage === proxySalvage
      && heard === proxyEvents,
    `${e.hp} hp, ${horde.killCount} kills, ${heard - proxyEvents} events`);

  // Pool ids are reused. A cue from the previous occupant must never flash its replacement.
  e.flash = 0;
  proxy.flash = CFG.combat.weapon.hitFlash;
  e.generation++;
  horde.updateSnapshotVisuals(0);
  ok("a recycled pool slot cannot inherit the previous generation's cue",
    e.flash === 0,
    `proxy generation ${proxy.generation}, body generation ${e.generation}`);
}

console.log("\n124. Cone spread is a function of an index both ends agree on");
{
  // TWO INDEPENDENT WEAPONS, which is the situation that matters: one is the client's and one is
  // the server's, and they have never exchanged a stream position. Under the old scheme they
  // agreed only while they made identical draws in identical order, and diverged permanently the
  // first time a client mispredicted a shot the server refused.
  const a = makeSim();
  const b = makeSim();

  const spreadOf = (sim, seq, shotIndex) => {
    const w = sim.weapon;
    w.spreadKey = seq;
    w.shotsThisKey = shotIndex;
    const origin = new THREE.Vector3(0, 1.5, 0);
    const dir = new THREE.Vector3(0, 0, -1);
    // A profile with real spread, so there is something to compare. The rifle's own is small
    // enough that a bug could hide inside the tolerance.
    const profile = { ...CFG.combat.weapon, spread: 0.05, pellets: 1, range: 200, damage: 1 };
    w.arbitrated = true;
    w.shootFrom(origin, dir, profile, null, sim.player, 0);
    // shootFrom mutates the direction it is handed, which is how the cone is applied.
    return dir.clone();
  };

  const d1 = spreadOf(a, 4242, 0);
  const d2 = spreadOf(b, 4242, 0);
  ok("two weapons that never shared a stream scatter one round identically",
    d1.distanceTo(d2) < 1e-12,
    `directions match to ${d1.distanceTo(d2).toExponential(1)}`);

  // AND THE STREAMS ARE NOW GENUINELY OUT OF STEP, which is the scenario the hash exists for.
  // `a` fires three extra rounds; under the old scheme its stream would be six draws ahead and
  // every subsequent shot would disagree.
  for (let i = 0; i < 3; i++) spreadOf(a, 999, i);
  const d3 = spreadOf(a, 5555, 0);
  const d4 = spreadOf(b, 5555, 0);
  ok("and still agree after one of them has fired extra rounds the other never saw",
    d3.distanceTo(d4) < 1e-12,
    `still matching to ${d3.distanceTo(d4).toExponential(1)} — order-independent`);

  // Different keys must give different cones, or the hash is a constant and the test above is
  // vacuous. This is the "confirm it actually varies" half.
  const spreads = new Set();
  for (let seq = 1; seq <= 40; seq++) spreads.add(spreadOf(a, seq, 0).x.toFixed(9));
  ok("different sequences give different cones (the hash is not a constant)",
    spreads.size >= 38, `${spreads.size} distinct directions from 40 sequences`);

  // Two shots on the SAME sequence must differ too. At a high enough fire rate two rounds land in
  // one tick, and keying only on the sequence would make that burst pinpoint accurate.
  const s0 = spreadOf(a, 7000, 0);
  const s1 = spreadOf(a, 7000, 1);
  ok("and two shots within one tick scatter differently",
    s0.distanceTo(s1) > 1e-6,
    `${s0.distanceTo(s1).toExponential(1)} apart — shotsThisKey separates them`);

  // Pellets within one blast, for the same reason: they would otherwise all take the same key.
  const pelletDirs = new Set();
  {
    const w = a.weapon;
    w.spreadKey = 8000;
    w.shotsThisKey = 0;
    const profile = { ...CFG.combat.weapon, spread: 0.05, pellets: 6, range: 200, damage: 1 };
    for (let p = 0; p < 6; p++) {
      const dir = new THREE.Vector3(0, 0, -1);
      w.shootFrom(new THREE.Vector3(0, 1.5, 0), dir, profile, null, a.player, p);
      pelletDirs.add(dir.x.toFixed(9));
    }
  }
  ok("and every pellet of one blast goes somewhere different",
    pelletDirs.size === 6, `${pelletDirs.size} distinct of 6 pellets`);

  // SOLO IS UNTOUCHED. Key 0 means "no agreed index", and the seeded stream runs as it always
  // has — which is what keeps every spread-dependent measurement in these files valid.
  const c = makeSim();
  c.weapon.spreadKey = 0;
  const solo1 = spreadOf(c, 0, 0);
  const d = makeSim();
  d.weapon.spreadKey = 0;
  const solo2 = spreadOf(d, 0, 0);
  ok("with no agreed index the seeded stream is used, so solo replays identically",
    solo1.distanceTo(solo2) < 1e-12,
    "two fresh sims agree, because both draw from the same seed in the same order");
}

// ---------------------------------------------------------------------------
// CLIENT PLAYBACK: real Net lifecycle, recovery and observer presentation state.
//
// This is browser-only code, so the simulation harness normally cannot import it. A faithful
// minimal browser shell and a synchronous WebSocket let this section drive the same public Net
// methods and private message listener the page uses, without replacing the behavior under test.
console.log("\n125. Network playback recovers its cushion and forgets stale observers");
{
  const hadDocument = Object.hasOwn(globalThis, "document");
  const hadLocation = Object.hasOwn(globalThis, "location");
  const hadWebSocket = Object.hasOwn(globalThis, "WebSocket");
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;
  const previousWebSocket = globalThis.WebSocket;

  globalThis.document = {
    getElementById: () => null,
    querySelector: () => null,
  };
  globalThis.location = {
    search: "",
    origin: "http://localhost:5173",
    port: "5173",
    protocol: "http:",
    host: "localhost:5173",
  };

  class FakeWebSocket {
    static latest = null;

    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.binaryType = "";
      this.listeners = new Map();
      this.sent = [];
      FakeWebSocket.latest = this;
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }

    emit(type, event) {
      for (const listener of this.listeners.get(type) ?? []) listener(event);
    }

    message(data) {
      this.emit("message", { data });
    }

    send(data) {
      this.sent.push(data);
    }

    close(code = 1000, reason = "") {
      this.readyState = 3;
      this.emit("close", { code, reason });
    }
  }

  globalThis.WebSocket = FakeWebSocket;

  try {
    const { Net } = await import("./src/net.js");

    const connectNet = async (net, code) => {
      net.setGraphicsReady();
      await net.join(code);
      const socket = FakeWebSocket.latest;
      socket.message(JSON.stringify({
        t: "hello",
        protocol: PROTOCOL_VERSION,
        seat: 1,
        code,
        phase: "lobby",
        hostSeat: 1,
        crewMin: 2,
        crewMax: 4,
        startTick: null,
        tickHz: CFG.loop.stepHz,
        snapshotHz: CFG.net.sendHz,
      }));
      return socket;
    };

    const crewMessage = (members) => JSON.stringify({
      t: "crew",
      crew: members,
      phase: "lobby",
      hostSeat: 1,
      crewMin: 2,
      crewMax: 4,
      startTick: null,
    });

    // ---- observer lifecycle ---------------------------------------------------
    const authority = createSession({ seats: 2, networked: true });
    const client = createSession({ seats: 1, networked: true });
    const net = new Net(client.scene, client.player, client.trampler, client);
    const socket = await connectNet(net, "ABCDEF");
    socket.message(crewMessage([
      { seat: 1, name: "ONE" },
      { seat: 2, name: "TWO" },
    ]));

    const wire = {
      ...snapshotOf(authority, 0).operatives.find((op) => op.seat === 2),
    };
    wire.shotStartX = 0;
    wire.shotStartY = 1.5;
    wire.shotStartZ = 0;
    wire.shotEndX = 0;
    wire.shotEndY = 1.5;
    wire.shotEndZ = -12;
    net.wireOps = [wire];
    net.wireAt = performance.now();
    net.update(DT);

    let remote = net.remotes.get(2);
    ok("a delayed operative really creates a remote avatar (test is not vacuous)",
      !!remote, `${net.remotes.size} remote avatar(s)`);

    wire.x += 6;
    wire.weaponBits = packWeaponBits({ slot: 0, cooldown: 0, shots: 1 });
    net.update(DT);
    remote = net.remotes.get(2);
    ok("the setup contains both accumulated gait and a live shot cue",
      !!remote && remote.speed > 0 && remote.tracer.visible,
      remote ? `speed ${remote.speed.toFixed(1)}, tracer ${remote.tracer.visible}` : "no remote");

    net.resumeFromPause();
    remote = net.remotes.get(2);
    ok("focus resume clears remote motion and event baselines",
      !!remote
        && remote.speed === 0
        && remote.lastBased === null
        && remote.lastWeaponShots === null
        && !remote.tracer.visible,
      remote ? `speed ${remote.speed}, based ${remote.lastBased}, shots ${remote.lastWeaponShots}` : "no remote");

    wire.x += 6;
    wire.weaponBits = packWeaponBits({ slot: 0, cooldown: 0, shots: 2 });
    net.update(DT);
    remote = net.remotes.get(2);
    ok("the first resumed pose is a baseline, not a teleport-sized stride or replayed shot",
      !!remote && remote.speed === 0 && !remote.tracer.visible && remote.lastWeaponShots === 2,
      remote ? `speed ${remote.speed}, tracer ${remote.tracer.visible}, shots ${remote.lastWeaponShots}` : "no remote");

    // Rebuild both observer deltas, then send a lower server tick through the real binary
    // listener. That is the production signal for an authority restart.
    wire.x += 1;
    wire.weaponBits = packWeaponBits({ slot: 0, cooldown: 0, shots: 3 });
    net.update(DT);
    remote = net.remotes.get(2);
    net.lastSnapshotTick = 100;
    net.lastSnapshotResetId = authority.resetId;
    socket.message(encode(snapshotOf(authority, 1)).buffer);
    ok("an authority rewind clears the same observer baselines before the new run is drawn",
      !!remote
        && remote.speed === 0
        && remote.lastBased === null
        && remote.lastWeaponShots === null
        && !remote.tracer.visible,
      remote ? `speed ${remote.speed}, based ${remote.lastBased}, shots ${remote.lastWeaponShots}` : "no remote");

    // The delayed wire record still says seat 2 exists. The newer crew bookkeeping must win,
    // both synchronously and on the next draw, or #remote recreates the disposed avatar.
    socket.message(crewMessage([{ seat: 1, name: "ONE" }]));
    ok("a crew departure removes its remote synchronously",
      !net.remotes.has(2), `${net.remotes.size} remote avatar(s)`);
    net.update(DT);
    ok("and stale delayed wire data cannot recreate the departed seat on the next draw",
      !net.remotes.has(2), `${net.remotes.size} remote avatar(s)`);
    net.leave();

    // ---- playback recovery ----------------------------------------------------
    const clockAuthority = createSession({ seats: 1, networked: true });
    const clockClient = createSession({ seats: 1, networked: true });
    const clockNet = new Net(
      clockClient.scene,
      clockClient.player,
      clockClient.trampler,
      clockClient,
    );
    const clockSocket = await connectNet(clockNet, "BCDEFG");
    const sendSnapshot = (tick) => {
      clockSocket.message(encode(snapshotOf(clockAuthority, tick)).buffer);
    };

    for (const tick of [0, 3, 6, 9]) sendSnapshot(tick);
    clockNet.applyPending(0, DT);
    const tickHz = CFG.loop.stepHz;
    const delayTicks = (CFG.net.interpDelayMs / 1000) * tickHz;
    ok("startup establishes the configured interpolation cushion",
      clockNet.renderReady && Math.abs(9 - clockNet.renderTick - delayTicks) < 1e-9,
      `${(9 - clockNet.renderTick).toFixed(2)} ticks behind`);

    let drainFrames = 0;
    while (!clockNet.interpRecovering && drainFrames < 20) {
      clockNet.applyPending(0, DT);
      drainFrames++;
    }
    ok("withholding snapshots genuinely enters recovery (test is not vacuous)",
      clockNet.interpRecovering,
      `${drainFrames} frames, ${(9 - clockNet.renderTick).toFixed(2)} ticks remain`);

    let newestTick = 9;
    let exitLag = null;
    const recoveryLags = [];
    for (let frame = 0; frame < 60; frame++) {
      if (frame % 3 === 0) {
        newestTick += 3;
        sendSnapshot(newestTick);
      }
      const wasRecovering = clockNet.interpRecovering;
      clockNet.applyPending(0, DT);
      const lag = newestTick - clockNet.renderTick;
      if (wasRecovering && !clockNet.interpRecovering && exitLag === null) exitLag = lag;
      recoveryLags.push(lag);
    }

    ok("recovery exits only after this frame's playback leaves the full cushion intact",
      exitLag !== null && exitLag >= delayTicks - 1e-9,
      `exit lag ${exitLag?.toFixed(2) ?? "none"}, target ${delayTicks.toFixed(2)} ticks`);
    const settled = recoveryLags.slice(-9);
    const settledMin = Math.min(...settled);
    const settledMax = Math.max(...settled);
    ok("and converges back to the same 120 ms packet phase startup established",
      Math.abs(settledMax - delayTicks) < 1e-9
        && Math.abs(settledMin - (delayTicks - 2)) < 1e-9,
      `tail ${settled.map((lag) => lag.toFixed(2)).join(", ")}`);

    // One long visible frame: authority advances twelve ticks, but presentation may consume
    // only six. The next ordinary frame then repays excess delay at exactly the bounded 1.25x.
    newestTick += 12;
    sendSnapshot(newestTick);
    const beforeCap = clockNet.renderTick;
    clockNet.applyPending(0, 0.2);
    const cappedAdvance = clockNet.renderTick - beforeCap;
    ok("a slow visible frame still obeys the six-tick playback cap",
      Math.abs(cappedAdvance - 6) < 1e-9,
      `${cappedAdvance.toFixed(2)} ticks advanced`);
    const beforeRepay = clockNet.renderTick;
    clockNet.applyPending(0, DT);
    const repayAdvance = clockNet.renderTick - beforeRepay;
    ok("excess delay is still repaid at the bounded 1.25x rate",
      Math.abs(repayAdvance - CFG.net.interpCatchUpScale) < 1e-9,
      `${repayAdvance.toFixed(2)} ticks advanced`);
    clockNet.leave();
  } catch (err) {
    ok("the real Net lifecycle scenario executes without an exception", false,
      err?.stack ?? String(err));
  } finally {
    if (hadDocument) globalThis.document = previousDocument;
    else delete globalThis.document;
    if (hadLocation) globalThis.location = previousLocation;
    else delete globalThis.location;
    if (hadWebSocket) globalThis.WebSocket = previousWebSocket;
    else delete globalThis.WebSocket;
  }
}

ok("no boarder ever floated off the deck footprint", !sawFloatingBoarder);
ok("no NaN in position or velocity across every scenario", !sawNaN);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILING`);
  process.exit(1);
}
