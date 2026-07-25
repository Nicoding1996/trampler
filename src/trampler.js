import * as THREE from "three";
import { CFG } from "./config.js";
import { box, boxToMesh, clamp } from "./util.js";

// The walking fortress.
//
// Two deliberate constraints, both load-bearing for the whole project:
//
//  1. The deck TRANSLATES and YAWS only -- never pitches or rolls. That single
//     restriction removes most of the pain of standing on a moving object,
//     because the deck stays axis-aligned in its own local space. Leg motion is
//     faked on top. Optional vertical bob exists purely so we can find out
//     whether it ruins comfort (toggle with B).
//
//  2. Colliders live in LOCAL space. Because the hull only yaws, local-space
//     collision is exact, not an approximation, and the player controller can
//     reuse the same AABB code it uses for terrain.
//
// Local origin sits at the centre of the deck surface, so local y=0 is the
// floor you walk on and negative y is inside the hull.

const HALF_W = 8;
const HALF_L = 13;
const HULL_DEPTH = 3;
const RAIL_H = 1.1;
const RAIL_T = 0.5;
const GAP = 3; // boarding gap half-length on each flank

export class Trampler {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.colliders = [];   // local space
    this.grappleables = [];
    this.hardpoints = [];

    // Spatial damage. Six independent legs plus the reactor, rather than one
    // hull health bar, so a leak in the defence has a specific consequence you
    // can see and feel instead of a number going down.
    this.legHp = new Array(CFG.trampler.legCount).fill(CFG.trampler.legHp);
    this.reactorHp = CFG.trampler.reactorHp;
    this.destroyed = false;

    // Incoming damage multiplier, owned by the economy's hull plating. 1 is
    // unarmoured. Applied to legs and the reactor alike, in damageLeg and
    // damageReactor, so no attacker can bypass it by using a different path.
    this.damageScale = 1;

    // Deck extents, so other systems can ask whether something is still aboard.
    this.halfW = HALF_W;
    this.halfL = HALF_L;

    this.yaw = 0;
    this.yawRate = 0;
    this.yawDelta = 0;
    this.linVel = new THREE.Vector3();
    this.walking = true;
    this.turning = true;
    this.time = 0;

    this.matrix = new THREE.Matrix4();
    this.matrixInverse = new THREE.Matrix4();
    this.prevMatrixInverse = new THREE.Matrix4();
    this.prevPos = new THREE.Vector3();

    this.#build();

    // Start somewhere on the patrol ring, facing along it.
    const r = CFG.world.patrolRadius;
    this.group.position.set(r, CFG.trampler.deckHeight, 0);
    this.yaw = Math.PI; // forward is -Z locally, so this heads toward +Z
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);
    this.matrix.copy(this.group.matrixWorld);
    this.matrixInverse.copy(this.matrix).invert();
    this.prevMatrixInverse.copy(this.matrixInverse);
    this.prevPos.copy(this.group.position);
  }

  // ---------------------------------------------------------------- geometry

  #build() {
    const hullMat = new THREE.MeshStandardMaterial({ color: 0x4a4e57, roughness: 0.75, metalness: 0.25 });
    const deckMat = new THREE.MeshStandardMaterial({ color: 0x6c6255, roughness: 0.9 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x8d5a3a, roughness: 0.7, metalness: 0.15 });
    const mastMat = new THREE.MeshStandardMaterial({ color: 0x585d66, roughness: 0.7, metalness: 0.3 });
    const legMat = new THREE.MeshStandardMaterial({ color: 0x3c4046, roughness: 0.65, metalness: 0.4 });
    const reactorMat = new THREE.MeshStandardMaterial({
      color: 0x2a3f2c, emissive: 0x63e06a, emissiveIntensity: 0.9, roughness: 0.5,
    });
    this.reactorMat = reactorMat;
    this.legMat = legMat;

    const structural = [
      // hull block: you walk on its top face, and shelter underneath it
      [box(-HALF_W, -HULL_DEPTH, -HALF_L, HALF_W, 0, HALF_L, "hull"), hullMat],

      // deck skin, purely so the walkable surface reads differently from hull
      [box(-HALF_W + 0.4, -0.06, -HALF_L + 0.4, HALF_W - 0.4, 0.02, HALF_L - 0.4, "deck"), deckMat],

      // railings, with a deliberate boarding gap amidships on both flanks
      [box(-HALF_W, 0, -HALF_L, -HALF_W + RAIL_T, RAIL_H, -GAP, "rail"), trimMat],
      [box(-HALF_W, 0, GAP, -HALF_W + RAIL_T, RAIL_H, HALF_L, "rail"), trimMat],
      [box(HALF_W - RAIL_T, 0, -HALF_L, HALF_W, RAIL_H, -GAP, "rail"), trimMat],
      [box(HALF_W - RAIL_T, 0, GAP, HALF_W, RAIL_H, HALF_L, "rail"), trimMat],
      [box(-HALF_W, 0, -HALF_L, HALF_W, RAIL_H, -HALF_L + RAIL_T, "rail"), trimMat],
      [box(-HALF_W, 0, HALF_L - RAIL_T, HALF_W, RAIL_H, HALF_L, "rail"), trimMat],

      // bow bridge, reachable by a step so it is walkable as well as grappleable
      [box(-4.5, 0, -11.5, 4.5, 1.0, -6.5, "bridge"), hullMat],
      [box(-2.4, 0, -6.5, 2.4, 0.5, -5.7, "step"), hullMat],

      // Raised gun sponson on the bow. Height is not decoration: a gun mounted
      // at deck level cannot depress at all without its own deck blocking the
      // shot -- at 12 degrees the ray meets the hull's top face 5 m out, well
      // inside the 8 m half-width. Lifting the mount clears the deck edge.
      [box(-2.6, 1.0, -11.4, 2.6, 2.0, -7.6, "sponson"), mastMat],

      // stern engine block
      [box(-5, 0, 8.5, 5, 2.6, 12, "engine"), mastMat],

      // the reactor: what boarders come for, and what losing ends the run
      [box(-2.5, 0, 3, 2.5, 2.4, 7, "reactor"), reactorMat],

      // central mast with an overhanging crow's nest -- the nest cannot be
      // walked to, so it is a pure grapple destination
      [box(-1.3, 0, -1.3, 1.3, 9, 1.3, "mast"), mastMat],
      [box(-3.2, 8.6, -3.2, 3.2, 9.0, 3.2, "nest"), mastMat],

      // deck clutter for cover and short parkour
      [box(-6.0, 0, 5.0, -3.0, 1.5, 8.0, "crate"), trimMat],
      [box(3.0, 0, 4.0, 5.6, 1.2, 7.0, "crate"), trimMat],
      [box(2.0, 0, -3.5, 4.4, 2.0, -1.0, "crate"), trimMat],
    ];

    for (const [b, mat] of structural) {
      this.colliders.push(b);
      const mesh = boxToMesh(b, mat);
      mesh.userData.tag = b.tag; // lets other systems treat parts differently
      this.group.add(mesh);
      if (b.tag !== "deck") this.grappleables.push(mesh);

      if (b.tag === "reactor") {
        this.reactorMesh = mesh;
        this.reactorBox = b;
        this.reactorLocal = new THREE.Vector3(0, 1.2, 5); // centre, for AI targeting
      }
    }

    this.#buildHardpoints();
    this.#buildLegs(legMat);
  }

  // Authored attach points. One of the real design questions this prototype
  // exists to settle: free-surface grapple everywhere, or only these?
  #buildHardpoints() {
    const geo = new THREE.SphereGeometry(0.42, 14, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1b3b46,
      emissive: 0x49d8ff,
      emissiveIntensity: 1.5,
      roughness: 0.4,
    });

    const spots = [];
    for (const z of [-9.5, -3.5, 3.5, 9.5]) {
      spots.push([-HALF_W - 0.15, -1.5, z], [HALF_W + 0.15, -1.5, z]);
    }
    // Two boarding beacons at the railing gaps, set well INBOARD of the hull
    // edge. An anchor flush with the edge drops you alongside the hull with
    // nothing under your feet; pulling to a point over the deck actually
    // boards you.
    spots.push([-(HALF_W - 2.2), RAIL_H + 0.6, 0], [HALF_W - 2.2, RAIL_H + 0.6, 0]);
    // One under the nest, so the high perch is reachable.
    spots.push([0, 8.3, 3.6]);

    for (const [x, y, z] of spots) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.userData.hardpoint = true;
      this.group.add(m);
      this.grappleables.push(m);
      this.hardpoints.push(m);
    }
  }

  // Cosmetic legs on an alternating tripod gait. They carry no collision and
  // are not grappleable: they move independently of the local transform that
  // grapple anchors are stored in, so anchoring to them would drift.
  #buildLegs(mat) {
    this.legs = [];
    const reach = CFG.trampler.deckHeight - HULL_DEPTH; // hull bottom to ground
    let i = 0;

    for (const side of [-1, 1]) {
      for (const z of [-8.5, 0, 8.5]) {
        const pivot = new THREE.Group();
        pivot.position.set(side * (HALF_W - 0.6), -HULL_DEPTH + 0.4, z);
        this.group.add(pivot);

        const thigh = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.9, 0.9), mat);
        thigh.position.set(side * 1.3, -0.5, 0);
        thigh.rotation.z = side * -0.45;
        thigh.castShadow = true;
        pivot.add(thigh);

        const shin = new THREE.Mesh(new THREE.BoxGeometry(0.7, reach, 0.7), mat);
        shin.position.set(side * 2.5, -0.9 - reach / 2, 0);
        shin.castShadow = true;
        pivot.add(shin);

        const foot = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.5, 2.4), mat);
        foot.position.set(side * 2.5, -0.9 - reach, 0);
        foot.castShadow = true;
        pivot.add(foot);

        // Alternating tripod: every other leg swings in phase.
        pivot.userData.phase = (i % 2 === 0) ? 0 : Math.PI;
        pivot.userData.baseY = pivot.position.y;
        pivot.userData.side = side;
        pivot.userData.z = z;
        pivot.userData.parts = [thigh, shin, foot];
        this.legs.push(pivot);
        i++;
      }
    }

    this.#buildClimbPoints();
  }

  // Authored boarding routes for enemies. Climbers do not path up a navmesh --
  // they ride a fixed local-space line from the hull's flank to the deck edge,
  // which means the route tracks the walking hull for free and costs nothing.
  #buildClimbPoints() {
    this.climbRoutes = [];
    const groundY = -CFG.trampler.deckHeight + CFG.enemies.climber.height / 2;
    const deckY = CFG.enemies.climber.height / 2;

    for (const side of [-1, 1]) {
      for (const z of [-9, -3, 3, 9]) {
        this.climbRoutes.push({
          start: new THREE.Vector3(side * (HALF_W + 0.7), groundY, z),
          end: new THREE.Vector3(side * (HALF_W - 1.2), deckY, z),
        });
      }
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    // Last frame's inverse is what turns a world point into the local frame the
    // player was standing in before we move. Capture it before anything changes.
    this.prevMatrixInverse.copy(this.matrixInverse);
    this.prevPos.copy(this.group.position);
    const prevYaw = this.yaw;

    const factor = this.speedFactor();
    const speed = this.walking ? CFG.trampler.speed * factor : 0;

    // Gait freezes completely when immobilised -- a fortress that has lost its
    // tripod should look dead, not idling.
    this.time += factor <= 0
      ? 0
      : dt * (0.25 + (speed / Math.max(CFG.trampler.speed, 0.001)) * 0.75);

    // Turning needs legs too. Without this an immobilised fortress pivots on the
    // spot, which looks wrong and quietly changes the fight: a rotating hull
    // sweeps the leg attack points, so chewers never settle.
    if (this.turning && factor > 0) {
      // Steer toward a carrot point further along the patrol ring.
      const p = this.group.position;
      const r = CFG.world.patrolRadius;
      const ang = Math.atan2(p.z, p.x) + 0.35;
      const dx = Math.cos(ang) * r - p.x;
      const dz = Math.sin(ang) * r - p.z;

      // Local forward is -Z, so a heading of (dx, dz) means yaw = atan2(-dx, -dz).
      const targetYaw = Math.atan2(-dx, -dz);

      let diff = targetYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxStep = CFG.trampler.turnRate * dt;
      this.yaw += Math.max(-maxStep, Math.min(maxStep, diff));
    }

    // Forward is -Z in local space, matching three.js convention.
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.group.position.addScaledVector(fwd, speed * dt);
    this.group.rotation.y = this.yaw;

    this.group.position.y = CFG.trampler.deckHeight + (CFG.trampler.bob
      ? Math.sin(this.time * CFG.trampler.bobSpeed * Math.PI * 2) * CFG.trampler.bobAmount
      : 0);

    this.#animateLegs();

    this.group.updateMatrixWorld(true);
    this.matrix.copy(this.group.matrixWorld);
    this.matrixInverse.copy(this.matrix).invert();

    if (dt > 0) {
      this.linVel.subVectors(this.group.position, this.prevPos).divideScalar(dt);
      this.yawRate = (this.yaw - prevYaw) / dt;
    }
    this.yawDelta = this.yaw - prevYaw;
  }

  #animateLegs() {
    const cycle = this.time * CFG.trampler.gaitSpeed * Math.PI * 2;
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];

      if (this.legHp[i] <= 0) {
        // Dead leg: stops striding and sags outward. The limp is the damage
        // readout -- you should be able to see which leg went without a HUD.
        leg.rotation.x = -0.42;
        leg.rotation.z = leg.userData.side * 0.30;
        leg.position.y = leg.userData.baseY - 0.55;
        continue;
      }

      const p = cycle + leg.userData.phase;
      leg.rotation.x = Math.sin(p) * 0.26;
      leg.rotation.z = 0;
      leg.position.y = leg.userData.baseY + Math.max(0, Math.cos(p)) * 0.30;
    }
  }

  // ------------------------------------------------------------------ damage

  brokenLegs() {
    let n = 0;
    for (const hp of this.legHp) if (hp <= 0) n++;
    return n;
  }

  workingLegs() {
    return this.legHp.length - this.brokenLegs();
  }

  /** True when too few legs remain to hold a tripod: a hard stop, not a limp. */
  get immobilised() {
    return this.workingLegs() < CFG.trampler.legsForWalking;
  }

  /**
   * Speed as a fraction of full. Degrades leg by leg, then drops to a hard zero
   * once a walking tripod is no longer possible.
   */
  speedFactor() {
    const need = CFG.trampler.legsForWalking;
    const working = this.workingLegs();
    if (working < need) return 0;
    return clamp((working - (need - 1)) / (this.legHp.length - (need - 1)), 0, 1);
  }

  /** Human-readable leg name, so a repair prompt can say which one. */
  legLabel(index) {
    const u = this.legs[index].userData;
    const side = u.side < 0 ? "PORT" : "STBD";
    const fore = u.z < -1 ? "FORE" : u.z > 1 ? "AFT" : "MID";
    return `${side} ${fore}`;
  }

  #legMaterial(index) {
    const broken = this.legHp[index] <= 0;
    const mat = broken
      ? (this.brokenLegMat ??= new THREE.MeshStandardMaterial({
          color: 0x24262a, roughness: 0.9, metalness: 0.1,
        }))
      : this.legMat;
    for (const part of this.legs[index].userData.parts) part.material = mat;
  }

  damageLeg(index, amount) {
    if (this.legHp[index] <= 0) return false;
    this.legHp[index] = Math.max(0, this.legHp[index] - amount * this.damageScale);

    if (this.legHp[index] <= 0) {
      this.#legMaterial(index);
      return true; // just broke
    }
    return false;
  }

  /** Returns true if this repair brought a dead leg back into service. */
  repairLeg(index, amount) {
    const max = CFG.trampler.legHp;
    if (this.legHp[index] >= max) return false;

    const wasBroken = this.legHp[index] <= 0;
    this.legHp[index] = Math.min(max, this.legHp[index] + amount);

    if (wasBroken && this.legHp[index] > 0) {
      this.#legMaterial(index);
      return true;
    }
    return false;
  }

  #refreshReactorLook() {
    // Dim and redden as it fails, so the stakes are legible from across the deck.
    const frac = this.reactorHp / CFG.trampler.reactorHp;
    this.reactorMat.emissiveIntensity = 0.15 + frac * 0.85;
    this.reactorMat.emissive.setHSL(0.33 * frac, 0.85, 0.5);
  }

  damageReactor(amount) {
    if (this.destroyed) return;
    this.reactorHp = Math.max(0, this.reactorHp - amount * this.damageScale);
    this.#refreshReactorLook();
    if (this.reactorHp <= 0) this.destroyed = true;
  }

  repairReactor(amount) {
    if (this.destroyed || this.reactorHp >= CFG.trampler.reactorHp) return false;
    this.reactorHp = Math.min(CFG.trampler.reactorHp, this.reactorHp + amount);
    this.#refreshReactorLook();
    return true;
  }

  repairAll() {
    this.legHp.fill(CFG.trampler.legHp);
    this.reactorHp = CFG.trampler.reactorHp;
    this.destroyed = false;
    this.#refreshReactorLook();
    for (let i = 0; i < this.legs.length; i++) this.#legMaterial(i);
  }

  /**
   * Put the fortress back at its starting point on the patrol ring.
   *
   * Restarting an encounter has to rewind this too, not just the damage. Enemy
   * spawn bearings are computed from the hull's heading, so a restart that left
   * the fortress mid-patrol produced a measurably different fight from the same
   * seed -- which defeats the reason the seeds exist, namely being able to
   * compare two attempts at the same wave.
   */
  resetPose() {
    const r = CFG.world.patrolRadius;
    this.group.position.set(r, CFG.trampler.deckHeight, 0);
    this.yaw = Math.PI;
    this.yawRate = 0;
    this.yawDelta = 0;
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);
  }

  /**
   * Where a chewer plants itself to attack a leg: well INBOARD of the hull
   * edge, underneath the slab. The hull blocks line of sight straight down, so
   * this position cannot be shot from the deck. That is the point.
   */
  legAttackLocal(index, out = new THREE.Vector3()) {
    const leg = this.legs[index];
    return out.set(
      leg.userData.side * CFG.enemies.chewer.inboardOffset,
      -CFG.trampler.deckHeight + CFG.enemies.chewer.height / 2,
      leg.userData.z,
    );
  }

  legAttackWorld(index, out = new THREE.Vector3()) {
    return this.localToWorld(this.legAttackLocal(index, out));
  }

  reactorWorld(out = new THREE.Vector3()) {
    return this.localToWorld(out.copy(this.reactorLocal));
  }

  /**
   * Nearest point on the reactor's SURFACE to a world position.
   *
   * Attackers have to close on this rather than on the centre. The reactor is a
   * 5 x 2.4 x 4 box, so anything that stops within 2.4 m of its centre is
   * standing inside it -- and an enemy inside the reactor cannot be shot,
   * because the reactor's own mesh occludes every bullet aimed at it.
   */
  reactorSurfaceWorld(worldPos, out = new THREE.Vector3()) {
    const b = this.reactorBox;
    out.copy(worldPos);
    this.worldToLocal(out);
    out.set(
      clamp(out.x, b.min.x, b.max.x),
      clamp(out.y, b.min.y, b.max.y),
      clamp(out.z, b.min.z, b.max.z),
    );
    return this.localToWorld(out);
  }

  // ------------------------------------------------------------- transforms

  localToWorld(v) {
    return v.applyMatrix4(this.matrix);
  }

  worldToLocal(v) {
    return v.applyMatrix4(this.matrixInverse);
  }

  /** World point -> the local frame as it was before this frame's movement. */
  worldToPrevLocal(v) {
    return v.applyMatrix4(this.prevMatrixInverse);
  }

  /**
   * Velocity of the hull at a given world point: linear plus the tangential
   * component from yaw rotation. This is what makes stepping off a moving,
   * turning fortress carry the momentum you expect instead of yanking you.
   */
  velocityAt(worldPoint, out = new THREE.Vector3()) {
    const rx = worldPoint.x - this.group.position.x;
    const rz = worldPoint.z - this.group.position.z;
    // omega = (0, yawRate, 0); omega x r = (yawRate*rz, 0, -yawRate*rx)
    out.set(
      this.linVel.x + this.yawRate * rz,
      this.linVel.y,
      this.linVel.z - this.yawRate * rx,
    );
    return out;
  }

  /** A safe spawn spot on the deck. */
  /**
   * Open deck amidships, port side. Must stay clear of every collider: the
   * previous spot at (0, 1.2, 6) ended up INSIDE the reactor once that was
   * added, so every respawn silently shoved the player aft to squeeze out of it.
   */
  deckSpawn(out = new THREE.Vector3()) {
    return this.localToWorld(out.set(-4.5, 1.2, 0));
  }

  /** A spot on the ground ahead of the hull, so it walks toward you. */
  groundAhead(distance = 34, out = new THREE.Vector3()) {
    this.localToWorld(out.set(0, 0, -HALF_L - distance));
    out.y = 1.2;
    return out;
  }
}
