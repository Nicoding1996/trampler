// Headless verification of the two mechanics this prototype exists to test.
// Runs the real simulation modules with no renderer and no DOM, because the
// failure modes here (drift, being yanked off a turning deck, an anchor that
// does not track the hull) are invisible to a syntax check and tedious to
// confirm by hand.
//
//   node verify.mjs

import * as THREE from "three";
import {
  CFG, applyReleasePreset, releasePresetName, applyEnemySpeedScale,
} from "./src/config.js";
import { World } from "./src/world.js";
import { Trampler } from "./src/trampler.js";
import { Player } from "./src/player.js";
import { Grapple } from "./src/grapple.js";
import { Horde, CHEWER, CLIMBER } from "./src/enemies.js";
import { Director, PHASE } from "./src/waves.js";
import { Weapon } from "./src/weapon.js";
import { Repair } from "./src/repair.js";
import { DeckGun, handleStationInput } from "./src/deckgun.js";
import { Emitters } from "./src/emitters.js";

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
    mouseHeld: new Set(),
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

  const horde = new Horde(scene, trampler);
  const director = new Director(horde, trampler, player);
  const weapon = new Weapon(scene, player, horde, world, trampler);
  const repair = new Repair(player, trampler, horde);
  const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
  const emitters = new Emitters(scene, trampler, horde);

  scene.updateMatrixWorld(true);

  return {
    scene, camera, world, trampler, player, grapple,
    horde, director, weapon, repair, guns, gun: guns[0], emitters,
    input: makeInput(),
    waves: false, // opt in per test, so random spawns cannot pollute a scenario
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
    sim.trampler.update(dt);
    if (sim.waves) sim.director.update(dt);
    handleStationInput(sim.guns, sim.input, sim.player);
    sim.grapple.handleInput(sim.input);
    sim.player.update(dt, sim.input);
    sim.weapon.update(dt, sim.input);
    for (const g of sim.guns) g.update(dt, sim.input, sim.player, sim.weapon);
    sim.repair.update(dt, sim.input);
    sim.emitters.update(dt, sim.input, sim.player);
    sim.horde.update(dt, sim.player);
    sim.grapple.updateVisuals(dt);
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
console.log("\n19. Death cannot loop on a boarder standing at the spawn");
{
  const sim = makeSim();
  const { player } = sim;
  step(sim, 30);

  player.hurt(1000);
  ok("first hit killed and respawned", player.deaths === 1 && player.hp === player.maxHp);
  ok("grace window opened", player.spawnGrace > 0);

  player.hurt(1000);
  player.hurt(1000);
  ok("further hits during grace are ignored", player.deaths === 1, `${player.deaths} deaths`);

  step(sim, 90); // 1.5 s, past the 1.2 s grace
  ok("grace expired", player.spawnGrace === 0);
  player.hurt(1000);
  ok("and damage lands again afterwards", player.deaths === 2, `${player.deaths} deaths`);
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

ok("no boarder ever floated off the deck footprint", !sawFloatingBoarder);
ok("no NaN in position or velocity across every scenario", !sawNaN);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILING`);
  process.exit(1);
}
