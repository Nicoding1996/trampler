import * as THREE from "three";
import { CFG } from "./config.js";
import { resolveBoxes, probeGround, findMantleTarget } from "./collision.js";
import { clamp, damp, lerp, smoothstep } from "./util.js";

// First-person controller with "based movement" -- the mechanic that makes
// standing on a moving fortress work.
//
// The key idea: while the player is standing on the Trampler, `velocity` is
// stored RELATIVE TO THE HULL, not in world space. That has three consequences
// that all point the right way:
//
//   * Holding W moves you at walk speed across the deck, regardless of how fast
//     the hull is stomping along underneath you.
//   * Each frame we take the player's position, express it in the hull's frame
//     from BEFORE the hull moved, then convert it back out using the hull's
//     frame AFTER it moved. The player is carried along exactly, including
//     through turns, with no drift and no fighting the collision solver.
//   * Stepping or jumping off adds the hull's velocity at your feet back into
//     your world velocity -- including the tangential component from yaw -- so
//     you leave a moving, turning platform carrying the momentum you expect
//     instead of being yanked backwards.
//
// Everything else here is a fairly ordinary AABB FPS controller.

const UP = new THREE.Vector3(0, 1, 0);
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _baseVel = new THREE.Vector3();
const _mv1 = new THREE.Vector3();
const _mv2 = new THREE.Vector3();
const _mv3 = new THREE.Vector3();
const _mv4 = new THREE.Vector3();
const _mv5 = new THREE.Vector3();

export class Player {
  constructor(camera, world, trampler) {
    this.camera = camera;
    this.world = world;
    this.trampler = trampler;

    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3(); // relative to `base` when attached
    this.half = new THREE.Vector3(CFG.player.radius, CFG.player.height / 2, CFG.player.radius);

    this.yaw = 0;
    this.pitch = 0;

    this.base = null;      // null = world, otherwise the Trampler
    this.grounded = true;
    this.prevFeetY = 0;

    this.timeSinceGrounded = 99;
    this.jumpQueued = 0;
    this.jumpLock = 0;
    this.dip = 0;

    // Mantle state. When the ledge belongs to the hull, both endpoints are held
    // in hull-local space so a climb onto a walking fortress tracks it -- the
    // same trick the grapple anchor uses.
    this.mantleLock = 0;
    this.mantle = {
      active: false,
      t: 0,
      onHull: false,
      start: new THREE.Vector3(),
      dest: new THREE.Vector3(),
    };

    // Health exists so the ground has a cost. Without it, dismounting is free
    // and the ride-or-fight decision is not a decision.
    this.maxHp = CFG.combat.playerHp;
    this.hp = this.maxHp;
    this.timeSinceHurt = 99;
    this.spawnGrace = 0;
    this.deaths = 0;
    // Incoming damage multiplier, owned by the economy's kinetic weave. 1 is
    // unarmoured. Hyperbolic on the economy's side so it can never reach zero:
    // the ground having a cost is half the pillar.
    this.damageScale = 1;
    // Counters for the mixer and the camera. Polled rather than pushed, so the
    // controller stays unaware that either exists.
    this.hurtCount = 0;
    this.lastHurt = 0;

    this.grapple = null;   // assigned by main, checked for velocity override
    this.station = null;   // a manned mount takes over movement and the trigger

    // Which repair point this operative is working this frame, or null. Written by their
    // own Repair and read by everyone else's, which is how a leg admits one welder.
    // It lives on the Player rather than inside Repair because it is the answer to a
    // question OTHER operatives ask, and they can reach a Player through the crew
    // without needing a registry of Repair instances to exist.
    this.repairing = null;

    this.respawnOnDeck();
  }

  // --------------------------------------------------------------- base frame

  /** Velocity of a base at the player's current position, or zero for world. */
  #baseVelocity(base, out) {
    if (!base) return out.set(0, 0, 0);
    return base.velocityAt(this.position, out);
  }

  /**
   * Switch reference frames, converting stored velocity so the player's actual
   * world-space motion is unchanged by the switch.
   */
  attachTo(base) {
    if (this.base === base) return;
    const oldV = this.#baseVelocity(this.base, _v1);
    const newV = this.#baseVelocity(base, _v2);
    this.velocity.add(oldV).sub(newV);
    this.base = base;
  }

  worldVelocity(out = new THREE.Vector3()) {
    return out.copy(this.velocity).add(this.#baseVelocity(this.base, _v3));
  }

  setWorldVelocity(v) {
    this.velocity.copy(v).sub(this.#baseVelocity(this.base, _v3));
  }

  /** Carry the player along with the hull, including through turns. */
  #applyBasedMovement() {
    const t = this.trampler;
    if (this.base !== t) return;
    if (t.yawDelta === 0 && t.linVel.lengthSq() === 0) return;

    // position: express in the pre-move hull frame, then read back out of the
    // post-move hull frame.
    t.worldToPrevLocal(this.position);
    t.localToWorld(this.position);

    if (t.yawDelta !== 0) {
      // The view and the relative velocity both live in world axes, so they
      // have to be spun by however much the hull turned this frame.
      this.yaw += t.yawDelta;
      this.velocity.applyAxisAngle(UP, t.yawDelta);
    }
  }

  // -------------------------------------------------------------------- frame

  update(dt, input) {
    this.#look(input);
    this.#applyBasedMovement();

    // Manning a station: it owns position and clamps the aim arc. No movement,
    // no jumping, no grapple, no mantle -- being stuck in place is the price of
    // the firepower.
    if (this.station) {
      this.station.constrain(this);
      this.mantleLock = Math.max(0, this.mantleLock - dt);
      this.#updateHealth(dt);
      this.dip = damp(this.dip, 0, CFG.player.landDipRecover, dt);
      this.#updateCamera();
      return;
    }

    // Space is consumed once, then routed: mid-reel it cuts the rope, otherwise
    // it queues a jump. Reading it twice would let the jump buffer eat the input
    // before the grapple ever saw it.
    const jumpPressed = input.pressed("Space");
    this.jumpLock = Math.max(0, this.jumpLock - dt);

    if (this.grapple?.active) {
      if (jumpPressed) this.grapple.release("cut");
    } else if (jumpPressed) {
      this.jumpQueued = CFG.player.jumpBuffer;
    }
    this.jumpQueued = Math.max(0, this.jumpQueued - dt);

    this.mantleLock = Math.max(0, this.mantleLock - dt);

    // Firing the winch abandons a climb rather than fighting it for control.
    if (this.mantle.active && this.grapple?.active) this.cancelMantle();

    if (this.mantle.active) {
      // A climb is fully driven: no gravity, no input, no collision.
      this.#driveMantle(dt);
    } else if (this.grapple?.active) {
      // The winch owns velocity outright while it is running.
      this.grapple.drive(dt);
      this.#integrate(dt);
    } else {
      this.#move(dt, input);
      this.#tryJump();
      if (!this.#tryStartMantle()) this.#integrate(dt);
    }

    this.#updateBase(dt);

    if (this.position.y < -30) this.respawnOnDeck();

    this.#updateHealth(dt);
    this.dip = damp(this.dip, 0, CFG.player.landDipRecover, dt);
    this.#updateCamera();
  }

  #look(input) {
    if (!input.locked) return;
    this.yaw -= input.mouse.dx * CFG.player.lookSensitivity;
    this.pitch -= input.mouse.dy * CFG.player.lookSensitivity;
    this.pitch = clamp(this.pitch, -CFG.player.pitchLimit, CFG.player.pitchLimit);
  }

  #move(dt, input) {
    const p = CFG.player;

    let fx = 0, fz = 0;
    if (input.down("KeyW")) fz -= 1;
    if (input.down("KeyS")) fz += 1;
    if (input.down("KeyA")) fx -= 1;
    if (input.down("KeyD")) fx += 1;

    const sprinting = input.down("ShiftLeft") || input.down("ShiftRight");
    const speed = sprinting ? p.sprintSpeed : p.walkSpeed;

    // Camera-relative wish direction on the horizontal plane.
    // right = (cos yaw, 0, -sin yaw), forward = (-sin yaw, 0, -cos yaw),
    // and fz is -1 for W, so the forward term folds in with a + sign.
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
    let wx = fx * cos + fz * sin;
    let wz = -fx * sin + fz * cos;
    const wlen = Math.hypot(wx, wz);

    if (wlen > 0) {
      wx = (wx / wlen) * speed;
      wz = (wz / wlen) * speed;

      const accel = this.grounded ? p.groundAccel : p.airAccel;
      const dvx = wx - this.velocity.x;
      const dvz = wz - this.velocity.z;
      const dlen = Math.hypot(dvx, dvz);
      if (dlen > 1e-5) {
        const step = Math.min(dlen, accel * dt);
        this.velocity.x += (dvx / dlen) * step;
        this.velocity.z += (dvz / dlen) * step;
      }
    } else if (this.grounded) {
      this.velocity.x = damp(this.velocity.x, 0, p.groundFriction, dt);
      this.velocity.z = damp(this.velocity.z, 0, p.groundFriction, dt);
    } else {
      this.velocity.x = damp(this.velocity.x, 0, p.airDrag, dt);
      this.velocity.z = damp(this.velocity.z, 0, p.airDrag, dt);
    }

    this.velocity.y = Math.max(this.velocity.y - p.gravity * dt, -p.maxFallSpeed);
  }

  #tryJump() {
    if (this.jumpQueued <= 0 || this.jumpLock > 0) return;
    const canJump = this.grounded || this.timeSinceGrounded < CFG.player.coyoteTime;
    if (!canJump) return;

    this.velocity.y = CFG.player.jumpSpeed;
    this.jumpQueued = 0;
    // The ground probe still sees the deck for a frame or two after take-off,
    // so lock out a second jump for slightly longer than that.
    this.jumpLock = 0.14;
    this.grounded = false;
    this.timeSinceGrounded = 99;
  }

  /**
   * Integrate and collide in substeps. A grapple exit can exceed 35 m/s, and
   * with dt clamped at 1/30 that is over a metre of travel per frame against
   * railings only 0.5 m thick -- single-step integration tunnels straight
   * through them. Substepping keeps each move shorter than the thinnest wall.
   */
  // ------------------------------------------------------------------ mantle

  /**
   * Look for a ledge to climb. Gated on being airborne and unable to jump
   * rather than on how high the ledge is, which is what lets one mechanic serve
   * both jobs: jump at the reactor and climb onto it, or catch yourself on the
   * hull after a grapple drops you against bare plating.
   *
   * Only fires near the apex or on the way down, so it reads as a save rather
   * than snatching you out of a rising jump.
   */
  #tryStartMantle() {
    const m = CFG.player.mantle;
    if (this.mantleLock > 0) return false;
    if (this.grounded || this.timeSinceGrounded <= CFG.player.coyoteTime) return false;
    if (this.velocity.y > m.maxUpVelocity) return false;

    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const wv = this.worldVelocity(_mv3);

    let worldHit = findMantleTarget(this.position, this.half, fx, fz, this.world.colliders, m);
    if (worldHit && this.#movingAway(
      worldHit.x - this.position.x, worldHit.z - this.position.z, wv.x, wv.z)) {
      worldHit = null;
    }

    // The hull is searched in its own local space, so a climb onto a walking,
    // turning fortress needs no special handling.
    const t = this.trampler;
    const lp = _mv1.copy(this.position);
    t.worldToLocal(lp);
    const lf = _mv2.set(fx, 0, fz).applyAxisAngle(UP, -t.yaw);
    let hullHit = findMantleTarget(lp, this.half, lf.x, lf.z, t.colliders, m);

    if (hullHit) {
      // Intent has to be judged in the HULL's frame. On a fortress walking at
      // 4.5 m/s, someone stepping slowly off the stern is still moving "toward"
      // it in world space, so a world-space test would drag them back aboard.
      const rel = _mv4.copy(wv)
        .sub(t.velocityAt(this.position, _mv5))
        .applyAxisAngle(UP, -t.yaw);
      if (this.#movingAway(hullHit.x - lp.x, hullHit.z - lp.z, rel.x, rel.z)) {
        hullHit = null;
      }
    }

    // Lowest ledge wins, compared in world terms: grab what is in front of you,
    // not the roof above it.
    let hit = worldHit;
    let onHull = false;
    if (hullHit && (!worldHit || hullHit.top + t.group.position.y < worldHit.top)) {
      hit = hullHit;
      onHull = true;
    }
    if (!hit) return false;

    const mn = this.mantle;
    mn.active = true;
    mn.t = 0;
    mn.onHull = onHull;
    mn.dest.set(hit.x, hit.y, hit.z);
    mn.start.copy(this.position);
    if (onHull) t.worldToLocal(mn.start);

    this.base = null;
    this.velocity.set(0, 0, 0);
    return true;
  }

  /**
   * Is the player heading away from this ledge? Both the direction and the
   * velocity must be given in the same space -- world for terrain, hull-relative
   * for the deck.
   */
  #movingAway(dx, dz, vx, vz) {
    const m = CFG.player.mantle;
    const len = Math.hypot(dx, dz);
    const speed = Math.hypot(vx, vz);
    if (len < 1e-4) return false;
    if (speed < m.stillSpeed) return false; // standing still: no intent either way
    return (dx * vx + dz * vz) / (len * speed) < m.minApproachDot;
  }

  #driveMantle(dt) {
    const m = CFG.player.mantle;
    const mn = this.mantle;
    mn.t = Math.min(1, mn.t + dt / m.duration);

    // Up first, then over, with the phases overlapping so it does not read as
    // two separate scripted moves.
    const yT = smoothstep(mn.t / 0.55);
    const xzT = smoothstep((mn.t - 0.40) / 0.60);

    _mv1.set(
      lerp(mn.start.x, mn.dest.x, xzT),
      lerp(mn.start.y, mn.dest.y, yT),
      lerp(mn.start.z, mn.dest.z, xzT),
    );
    if (mn.onHull) this.trampler.localToWorld(_mv1);

    this.position.copy(_mv1);
    this.velocity.set(0, 0, 0);

    if (mn.t >= 1) {
      mn.active = false;
      this.mantleLock = m.cooldown;
      // Arrive at rest RELATIVE to whatever we climbed onto. Letting attachTo
      // convert a zeroed world velocity would inject a backwards kick equal to
      // the hull's speed.
      this.base = mn.onHull ? this.trampler : null;
      this.velocity.set(0, 0, 0);
    }
  }

  cancelMantle() {
    if (!this.mantle.active) return;
    this.mantle.active = false;
    this.mantleLock = CFG.player.mantle.cooldown;
  }

  #integrate(dt) {
    const travel = this.velocity.length() * dt;
    const steps = Math.min(8, Math.max(1, Math.ceil(travel / 0.25)));
    const sub = dt / steps;

    for (let i = 0; i < steps; i++) {
      this.prevFeetY = this.position.y - this.half.y;
      this.position.addScaledVector(this.velocity, sub);
      this.#collide();
    }
  }

  #collide() {
    const out = { grounded: false, ground: null };
    const wasFalling = this.velocity.y;

    // 1) terrain, in world space
    resolveBoxes(this.position, this.half, this.world.colliders, this.velocity, this.prevFeetY, out);

    // 2) the Trampler, in its own local space. Exact rather than approximate,
    //    because the hull only ever yaws.
    const t = this.trampler;
    const lp = _v1.copy(this.position);
    t.worldToLocal(lp);
    const lv = _v2.copy(this.velocity).applyAxisAngle(UP, -t.yaw);
    const localPrevFeetY = this.prevFeetY - t.group.position.y;

    resolveBoxes(lp, this.half, t.colliders, lv, localPrevFeetY, out);

    t.localToWorld(lp);
    this.position.copy(lp);
    this.velocity.copy(lv).applyAxisAngle(UP, t.yaw);

    if (out.grounded && wasFalling < -8) {
      this.dip = CFG.player.landDip * Math.min(1, -wasFalling / 22);
    }
  }

  /**
   * Decide which surface we are standing on. Done as a separate probe rather
   * than reusing the collision result, because the answer has to be stable on
   * frames with no penetration -- it selects next frame's reference frame.
   */
  #updateBase(dt) {
    const t = this.trampler;

    // A climb drives position outright, so ground detection must not fight it.
    if (this.mantle.active) {
      this.grounded = false;
      this.timeSinceGrounded += dt;
      return;
    }

    const worldGround = probeGround(this.position, this.half, this.world.colliders);

    const lp = _v1.copy(this.position);
    t.worldToLocal(lp);
    const localGround = probeGround(lp, this.half, t.colliders);

    let base = null;
    if (localGround && worldGround) {
      // Prefer whichever surface is actually higher.
      base = localGround.max.y + t.group.position.y >= worldGround.max.y ? t : null;
    } else if (localGround) {
      base = t;
    }

    this.grounded = !!(worldGround || localGround);
    this.timeSinceGrounded = this.grounded ? 0 : this.timeSinceGrounded + dt;

    // Grappling always runs in world space so the winch can aim at a point on
    // a hull that is moving relative to us.
    this.attachTo(this.grapple?.active ? null : base);
  }

  #updateCamera() {
    this.eyePosition(this.camera.position);
    this.camera.rotation.set(this.pitch, this.yaw, 0, "YXZ");
  }

  // ------------------------------------------------------------------ helpers

  #updateHealth(dt) {
    this.timeSinceHurt += dt;
    this.spawnGrace = Math.max(0, this.spawnGrace - dt);

    const c = CFG.combat;
    if (this.hp > 0 && this.hp < this.maxHp && this.timeSinceHurt > c.regenDelay) {
      this.hp = Math.min(this.maxHp, this.hp + c.regenRate * dt);
    }
  }

  hurt(amount) {
    if (this.hp <= 0 || this.spawnGrace > 0) return;
    const taken = amount * this.damageScale;
    this.hp -= taken;
    this.timeSinceHurt = 0;
    this.dip = Math.max(this.dip, 0.1);
    this.hurtCount++;
    this.lastHurt = taken;

    if (this.hp <= 0) {
      // Instant respawn on the deck, deliberately cheap for a feel test. A real
      // death needs a delay and a cost; this only needs to interrupt you.
      // The grace window stops boarders standing on the spawn from killing you
      // again on the very next frame.
      this.deaths++;
      this.hp = this.maxHp;
      this.respawnOnDeck();
      this.spawnGrace = CFG.combat.spawnGrace;
    }
  }

  eyePosition(out = new THREE.Vector3()) {
    return out.set(
      this.position.x,
      this.position.y - this.half.y + CFG.player.eyeHeight - this.dip,
      this.position.z,
    );
  }

  /** Forward vector matching the YXZ camera basis, without touching the camera. */
  lookDirection(out = new THREE.Vector3()) {
    const cp = Math.cos(this.pitch);
    return out.set(
      -Math.sin(this.yaw) * cp,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cp,
    );
  }

  /** Where the rope leaves the player, roughly a right hand. */
  handPosition(out = new THREE.Vector3()) {
    const right = _v1.set(1, 0, 0).applyQuaternion(this.camera.quaternion);
    const fwd = _v2.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    out.copy(this.camera.position);
    out.addScaledVector(right, 0.28);
    out.addScaledVector(fwd, 0.35);
    out.y -= 0.22;
    return out;
  }

  respawnOnDeck() {
    // Dying throws you off the gun. Through the mount, so the seat learns it is empty
    // -- writing `station.mounted = false` from out here left the gun's own idea of its
    // occupant untouched, which is survivable with one operative and not with four.
    this.station?.dismount(this);
    // Repair ownership is published on Player for the rest of the crew and for snapshots.
    // Death can happen after this frame's Repair pass, so clear it at the teleport itself;
    // waiting for the next frame would advertise a deck-spawned ghost welder for one packet.
    this.repairing = null;
    this.trampler.deckSpawn(this.position);
    // Set the frame directly rather than going through attachTo: we want to be
    // at rest RELATIVE to the deck, not at rest in world space.
    this.base = this.trampler;
    this.velocity.set(0, 0, 0);
    this.grapple?.cancel();
    this.cancelMantle();
    this.dip = 0;
  }

  dropToGround() {
    this.station?.dismount(this);
    // After the dismount, which parks the operative back on the hull -- this is the
    // one release that wants to end up off it.
    this.base = null;
    this.velocity.set(0, 0, 0);
    this.trampler.groundAhead(34, this.position);
    this.grapple?.cancel();
    this.cancelMantle();

    // Face the hull so it is immediately visible walking toward you.
    const dx = this.trampler.group.position.x - this.position.x;
    const dz = this.trampler.group.position.z - this.position.z;
    this.yaw = Math.atan2(-dx, -dz);
    this.pitch = 0;
    this.dip = 0;
  }
}
