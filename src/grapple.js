import * as THREE from "three";
import { CFG } from "./config.js";

// Grapple winch: tap to reel yourself to a point. Not a physics swing.
//
// The one detail that matters more than anything else here: when the anchor is
// on the Trampler, it is stored in the hull's LOCAL space. Every frame we read
// it back out through the hull's current transform, so the anchor tracks a
// fortress that is walking and turning away from you. Without that, grappling
// back aboard a moving object is impossible, and if boarding is impossible then
// players never dismount and the whole ride-or-fight pillar is dead.

const _anchor = new THREE.Vector3();
const _to = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _mid = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);
const FORWARD_Z = new THREE.Vector3(0, 0, 1);

export class Grapple {
  constructor(scene, player, trampler, world) {
    this.player = player;
    this.trampler = trampler;

    this.active = false;
    this.cooldown = 0;
    this.timer = 0;
    this.stuckTime = 0;
    this.lastDist = Infinity;

    this.anchorLocal = new THREE.Vector3(); // hull space, when onHull
    this.anchorWorld = new THREE.Vector3(); // world space otherwise
    this.onHull = false;
    this.anchorWasAbove = false;

    this.aimValid = false;
    this.aimPoint = new THREE.Vector3();

    this.raycaster = new THREE.Raycaster();
    this.raycaster.far = CFG.grapple.maxRange;

    // Static list: nothing is added to or removed from the scene at runtime.
    this.candidates = [...world.grappleables, ...trampler.grappleables];

    this.#buildVisuals(scene);
  }

  #buildVisuals(scene) {
    const ropeMat = new THREE.MeshBasicMaterial({ color: 0x2b2b30 });
    this.rope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1, 6), ropeMat);
    this.rope.visible = false;
    this.rope.frustumCulled = false;
    scene.add(this.rope);

    this.hook = new THREE.Mesh(
      new THREE.SphereGeometry(0.22, 10, 8),
      new THREE.MeshBasicMaterial({ color: 0xffd27a }),
    );
    this.hook.visible = false;
    scene.add(this.hook);

    // Where the shot would land, so aiming at a moving hull is readable.
    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.3, 0.42, 18),
      new THREE.MeshBasicMaterial({ color: 0x6fd3ff, side: THREE.DoubleSide, transparent: true, opacity: 0.85 }),
    );
    this.marker.visible = false;
    scene.add(this.marker);
  }

  // -------------------------------------------------------------------- input

  handleInput(input) {
    if (!input.locked) return;
    if (this.player.station) return; // hands are on the gun
    // F is the station key now, so the winch is right mouse only.
    if (input.mousePressed(2)) this.tryFire();
  }

  tryFire() {
    if (this.active || this.cooldown > 0) return false;

    const hit = this.#castFromEye();
    if (!hit) return false;

    this.onHull = this.#belongsToHull(hit.object);
    if (this.onHull) {
      this.anchorLocal.copy(hit.point);
      this.trampler.worldToLocal(this.anchorLocal);
    } else {
      this.anchorWorld.copy(hit.point);
    }

    this.anchorWasAbove = hit.point.y > this.player.position.y;
    this.active = true;
    this.timer = 0;
    this.stuckTime = 0;
    this.lastDist = Infinity;

    // Hand the player over to world space immediately. While reeling, velocity
    // must not be interpreted relative to a hull we are flying toward.
    this.player.attachTo(null);
    return true;
  }

  // ------------------------------------------------------------------- update

  /** Called by the player while active; the winch owns velocity outright. */
  drive(dt) {
    const anchor = this.anchorPosition(_anchor);
    _to.subVectors(anchor, this.player.position);
    const dist = _to.length();

    if (dist <= CFG.grapple.releaseDistance) {
      this.release("arrived");
      return;
    }

    _to.divideScalar(dist);
    const v = this.player.velocity;

    // Brake on approach. Without this you arrive at full reel speed and the
    // residual momentum throws you straight over the deck and off the far side.
    const brake = Math.max(
      CFG.grapple.minSpeedFactor,
      Math.min(1, dist / CFG.grapple.brakeDistance),
    );
    v.copy(_to).multiplyScalar(CFG.grapple.reelSpeed * brake);

    // Extra lift while still far out, so you arc over a railing instead of
    // slamming into the hull plate underneath it. Fades as you close in.
    v.y += CFG.grapple.arcBoost * Math.min(1, dist / 18);

    this.timer += dt;
    if (this.timer > CFG.grapple.maxTime) {
      this.release("timeout");
      return;
    }

    // Stuck detection: if we are pinned on geometry and no longer closing,
    // let go rather than grinding against the hull.
    if (dist > this.lastDist - 0.02) {
      this.stuckTime += dt;
      if (this.stuckTime > 0.45) this.release("stuck");
    } else {
      this.stuckTime = 0;
    }
    this.lastDist = dist;
  }

  /**
   * How the rope ends decides how much speed you keep.
   *
   *   "cut"  -- player let go on purpose, mid-flight. Pure mobility, so keep
   *             everything. Cut while being reeled upward and you keep sailing
   *             upward. Combined with the approach brake, letting go early is
   *             fast and letting go late is not, which is the skill gradient.
   *   others -- arrived, timed out or came unstuck. Braked, so you land.
   */
  release(reason = "cut") {
    if (!this.active) return;
    this.active = false;
    this.releaseReason = reason;
    this.cooldown = CFG.grapple.cooldown;
    this.timer = 0;

    const g = CFG.grapple;
    const cut = reason === "cut";
    const keep = cut ? g.cutMomentum : g.arriveMomentum;
    const lift = cut ? g.cutLift : g.arriveLift;

    const v = this.player.velocity;
    v.multiplyScalar(keep);
    if (lift > 0 && this.anchorWasAbove) v.y += lift;
  }

  cancel() {
    this.active = false;
    this.timer = 0;
    this.cooldown = 0;
  }

  /** Visuals + aim feedback. Runs after the player, so the camera is current. */
  updateVisuals(dt) {
    this.cooldown = Math.max(0, this.cooldown - dt);

    if (this.active) {
      const anchor = this.anchorPosition(_anchor);
      this.player.handPosition(_hand);

      _dir.subVectors(anchor, _hand);
      const len = _dir.length();
      _mid.addVectors(_hand, anchor).multiplyScalar(0.5);

      this.rope.position.copy(_mid);
      this.rope.scale.set(1, Math.max(len, 0.001), 1);
      this.rope.quaternion.setFromUnitVectors(UP_Y, _dir.normalize());
      this.rope.visible = true;

      this.hook.position.copy(anchor);
      this.hook.visible = true;
      this.marker.visible = false;
      this.aimValid = false;
      return;
    }

    this.rope.visible = false;
    this.hook.visible = false;

    const hit = this.#castFromEye();
    this.aimValid = !!hit && this.cooldown <= 0;
    if (hit) {
      this.aimPoint.copy(hit.point);
      this.marker.position.copy(hit.point);
      if (hit.face) {
        // Lay the ring flat against the surface it is marking.
        _dir.copy(hit.face.normal);
        if (hit.object) _dir.transformDirection(hit.object.matrixWorld);
        this.marker.quaternion.setFromUnitVectors(FORWARD_Z, _dir);
        this.marker.position.addScaledVector(_dir, 0.05);
      }
      this.marker.visible = true;
    } else {
      this.marker.visible = false;
    }
  }

  // ------------------------------------------------------------------ helpers

  anchorPosition(out) {
    if (!this.onHull) return out.copy(this.anchorWorld);
    out.copy(this.anchorLocal);
    return this.trampler.localToWorld(out);
  }

  #castFromEye() {
    const origin = this.player.eyePosition(_hand);
    this.player.lookDirection(_dir);
    this.raycaster.set(origin, _dir);
    this.raycaster.far = CFG.grapple.maxRange;

    const hits = this.raycaster.intersectObjects(this.candidates, false);
    for (const h of hits) {
      if (CFG.grapple.hardpointsOnly && !h.object.userData.hardpoint) continue;
      return h;
    }
    return null;
  }

  #belongsToHull(obj) {
    let o = obj;
    while (o) {
      if (o === this.trampler.group) return true;
      o = o.parent;
    }
    return false;
  }
}
