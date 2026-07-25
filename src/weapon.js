import * as THREE from "three";
import { CFG } from "./config.js";

// Hitscan rifle. Deliberately plain -- it exists so there is something to do
// about the horde, not because gunplay is the question under test.
//
// The one part that matters: every shot is clipped by world geometry BEFORE
// enemies are considered. Without that you could shoot chewers straight through
// the hull, and the whole reason they hide underneath it would evaporate.

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _end = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);

const TRACERS = 12;
const IMPACTS = 16;

export class Weapon {
  constructor(scene, player, horde, world, trampler) {
    this.player = player;
    this.horde = horde;

    this.cooldown = 0;
    this.shots = 0;
    this.hits = 0;
    this.kills = 0;
    this.blockedByHull = 0; // diagnostic: shots that hit the fortress instead
    this.hitFlash = 0;      // drives the crosshair hitmarker

    this.raycaster = new THREE.Raycaster();

    // Railings are collision geometry for BODIES, not for bullets. They are
    // solid boxes only so the player cannot walk through them; a real railing is
    // mostly air. Leaving them in the occluder set meant the deck gun shot its
    // own gunwale on almost every depressed angle.
    //
    // This does not weaken the rule that matters: chewers under the hull are
    // shielded by the 3 m hull slab, not by the railings.
    this.occluders = [
      ...world.grappleables,
      ...trampler.grappleables.filter((m) => m.userData.tag !== "rail"),
    ];

    // Unit-length cylinder along +Y, scaled per shot. Radius 1 so the tracer's
    // thickness can be set purely by scale.
    this.tracers = [];
    const beam = new THREE.CylinderGeometry(1, 1, 1, 6);
    const beamMat = new THREE.MeshBasicMaterial({
      color: 0xfff0b0, transparent: true, opacity: 0.75, depthWrite: false,
    });
    for (let i = 0; i < TRACERS; i++) {
      const m = new THREE.Mesh(beam, beamMat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }

    // Impact markers. At range these, not the beam, are what tell you where the
    // shot landed -- and the colour tells you whether you hit flesh or fortress.
    this.impacts = [];
    const puff = new THREE.SphereGeometry(1, 12, 8);
    this.impactMat = {
      solid: new THREE.MeshBasicMaterial({
        color: 0xd8c9a8, transparent: true, opacity: 0.38, depthWrite: false,
      }),
      flesh: new THREE.MeshBasicMaterial({
        color: 0xff8a5c, transparent: true, opacity: 0.95, depthWrite: false,
      }),
    };
    for (let i = 0; i < IMPACTS; i++) {
      const m = new THREE.Mesh(puff, this.impactMat.solid);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.impacts.push({ mesh: m, life: 0 });
    }
  }

  update(dt, input) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const p of this.impacts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) p.mesh.visible = false;
    }

    // Manning a station hands the trigger over to that station's weapon.
    if (this.player.station) return;

    if (input.locked && input.mouseDown(0) && this.cooldown <= 0) {
      this.fire();
      this.cooldown = 1 / CFG.combat.weapon.fireRate;
    }
  }

  fire() {
    this.player.eyePosition(_origin);
    this.player.lookDirection(_dir);
    return this.shootFrom(_origin, _dir, CFG.combat.weapon, null);
  }

  /**
   * Shared hitscan. Both the rifle and the deck gun come through here, so the
   * geometry-occlusion rule -- the thing that keeps chewers safe beneath the
   * hull -- exists in exactly one place and cannot drift between weapons.
   *
   * `profile` supplies damage, spread and range. `muzzle` is where the tracer is
   * drawn from; null means the player's hand.
   */
  shootFrom(origin, dir, profile, muzzle = null) {
    const w = CFG.combat.weapon;
    this.shots++;

    // Cone spread, built from a basis around the aim direction.
    if (profile.spread > 0) {
      _right.crossVectors(dir, UP_Y).normalize();
      _up.crossVectors(_right, dir).normalize();
      const a = Math.random() * Math.PI * 2;
      const r = Math.sqrt(Math.random()) * profile.spread;
      dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
    }

    // Clip on world and fortress geometry first.
    this.raycaster.set(origin, dir);
    this.raycaster.far = profile.range;
    const solid = this.raycaster.intersectObjects(this.occluders, false);
    const limit = solid.length > 0 ? solid[0].distance : profile.range;

    const hit = this.horde.raycast(origin, dir, limit);

    let dist = limit;
    if (hit) {
      dist = hit.distance;
      this.hits++;
      this.hitFlash = w.hitFlash;
      if (this.horde.damage(hit.enemy, profile.damage)) this.kills++;
    } else if (solid.length > 0) {
      this.blockedByHull++;
    }

    // Traced from the eye but DRAWN from a muzzle, so the beam crosses the view
    // instead of hiding along its axis.
    _end.copy(origin).addScaledVector(dir, dist);
    this.#tracer(_end, muzzle);
    this.#impact(_end, dist, !!hit);

    return hit;
  }

  /**
   * Distance to whatever a ray is looking at, geometry or enemy. Used by weapons
   * whose muzzle is offset from the operator's eye and therefore have to
   * converge on the crosshair rather than fire parallel to it.
   */
  aimDistance(origin, dir, maxRange) {
    this.raycaster.set(origin, dir);
    this.raycaster.far = maxRange;
    const solid = this.raycaster.intersectObjects(this.occluders, false);
    const limit = solid.length > 0 ? solid[0].distance : maxRange;
    const hit = this.horde.raycast(origin, dir, limit);
    return hit ? hit.distance : limit;
  }

  #tracer(endPoint, muzzle) {
    const w = CFG.combat.weapon;
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];

    if (muzzle) _muzzle.copy(muzzle);
    else this.player.handPosition(_muzzle);

    _beamDir.subVectors(endPoint, _muzzle);
    const len = _beamDir.length();
    if (len < 1e-4) return;
    _beamDir.divideScalar(len);

    _mid.addVectors(_muzzle, endPoint).multiplyScalar(0.5);

    // Widen with distance or the far end drops below a pixel.
    const r = w.tracerRadius + len * w.tracerWiden;

    t.mesh.position.copy(_mid);
    t.mesh.scale.set(r, len, r);
    t.mesh.quaternion.setFromUnitVectors(UP_Y, _beamDir);
    t.mesh.visible = true;
    t.life = w.tracerLife;
  }

  #impact(point, dist, onEnemy) {
    const w = CFG.combat.weapon;
    const p = this.impacts.find((x) => x.life <= 0) ?? this.impacts[0];

    const scale = w.impactSize * (1 + dist * w.impactGrow)
      * (onEnemy ? 1 : w.impactSolidScale);

    p.mesh.position.copy(point);
    p.mesh.scale.setScalar(scale);
    p.mesh.material = onEnemy ? this.impactMat.flesh : this.impactMat.solid;
    p.mesh.visible = true;
    p.life = w.impactLife;
  }
}
