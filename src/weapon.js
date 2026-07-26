import * as THREE from "three";
import { CFG, enemyCfg, armourAt } from "./config.js";
import { makeRandom } from "./util.js";

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

    // What a shot fired RIGHT NOW would connect with, or null. Rescanned every
    // frame and polled by the HUD, following the same rule as every other reader:
    // the simulation publishes state and has no idea a HUD exists.
    //
    // This lives on the weapon rather than in hud.js for the reason the number-key
    // router does: a rule that matters belongs in a module, because the harness
    // cannot import main.js and cannot see the DOM. It is also the honest place for
    // it -- the question the readout answers is "would this shot land", which is
    // the weapon's own question, and it therefore goes through the same occlusion
    // clip that keeps chewers safe under the hull. A target you cannot shoot is
    // correctly reported as no target at all.
    this.aimTarget = null;
    this.aimDist = 0;
    // How much armour a shot RIGHT NOW would actually meet, which is not the same as
    // the type's armour once a plate is directional. Published so the readout can say
    // "your rifle works from here", which is the only way the flank rule ever gets
    // taught -- a player who never happens to walk behind a bulwark would otherwise
    // never learn it exists.
    this.aimArmour = 0;

    this.raycaster = new THREE.Raycaster();

    // Multipliers owned by the economy. 1 means no upgrades. Instance fields
    // rather than CFG edits, so a run's build cannot leak into global config or
    // into the next attempt at the same seeded wave.
    this.damageScale = 1;
    this.fireRateScale = 1;
    // Additive, conditional, and rewritten from current conditions every frame by
    // the item runtime. Zero when nothing applies.
    this.damageBonus = 0;
    // Flat armour ignored per shot, from SABOT ROUNDS. Zero by default, so the
    // bulwark keeps making the rifle the wrong tool until a run decides otherwise.
    this.armourPierce = 0;

    // Assigned by whoever owns the bus, not taken as a constructor argument, so
    // tools/scene-cost.mjs can build a Weapon to count draw calls without one.
    this.events = null;

    // Cone spread is seeded, like every other stochastic part of the sim. At
    // 0.007 rad it scatters a shot by ~0.2 m at 30 m, which was enough to make a
    // measured tracer length differ between otherwise identical runs.
    this.random = makeRandom(CFG.combat.weapon.seed);

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

  /**
   * Rescan what the crosshair is on.
   *
   * Traced from the eye along the look direction, which is what the crosshair
   * actually points at whether or not a station owns the trigger. A manned gun
   * fires from its own mount with its own traverse clamp, so the readout answers
   * "what are you looking at" rather than "what can that mount reach" -- naming the
   * thing under the reticle is the useful answer, and the gun's own arc is already
   * legible from the fact that it refuses to depress.
   *
   * Clipped on geometry first, like every shot, so something standing behind the
   * hull reads as nothing rather than as a target.
   */
  scanTarget() {
    const range = CFG.combat.weapon.range;
    this.player.eyePosition(_origin);
    this.player.lookDirection(_dir);

    // Note the order, which is the REVERSE of shootFrom's and is the whole reason
    // this is affordable to run every frame.
    //
    // A shot has to clip on geometry first, because the clip decides where the
    // tracer ends and whether the round hit the fortress. This does not: if the
    // horde is not on the ray at all then no clip can produce a target, so the
    // expensive half is skipped entirely whenever the crosshair is on empty desert
    // — which is most of the time. Doing it the other way round cost 0.21 ms a
    // frame at a full pool, against a whole-simulation budget of one millisecond,
    // for a readout under the crosshair.
    //
    // `intersectObjects` is the expensive call, not the pool walk: the world's
    // static scenery is merged into a few large meshes, and three.js tests those
    // triangle by triangle.
    const hit = this.horde.raycast(_origin, _dir, range);
    if (!hit) {
      this.aimTarget = null;
      this.aimDist = 0;
      this.aimArmour = 0;
      return null;
    }

    // Something is on the ray. Now find out whether the fortress is in the way,
    // because naming a chewer you cannot shoot through the hull would be worse than
    // naming nothing at all — the readout has to agree with what a shot would do.
    this.raycaster.set(_origin, _dir);
    this.raycaster.far = hit.distance;
    const solid = this.raycaster.intersectObjects(this.occluders, false);
    const blocked = solid.length > 0 && solid[0].distance < hit.distance;

    this.aimTarget = blocked ? null : hit.enemy;
    this.aimDist = blocked ? 0 : hit.distance;
    // The pierce a purchase bought is folded in here too, so the readout answers "will
    // my armour problem actually bite from this angle with this build", rather than
    // reciting a number off the type.
    this.aimArmour = blocked
      ? 0
      : Math.max(0, armourAt(enemyCfg(hit.enemy.type), hit.enemy.yaw, _dir.x, _dir.z)
        - this.armourPierce);
    return this.aimTarget;
  }

  update(dt, input) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    // Before the station early-return below, so the readout keeps working while a
    // deck gun owns the trigger. Being told what you are aiming at matters MORE
    // from a mount, because that is where the armoured things are answered from.
    this.scanTarget();

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
      this.cooldown = 1 / (CFG.combat.weapon.fireRate * this.fireRateScale);
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
      const a = this.random() * Math.PI * 2;
      const r = Math.sqrt(this.random()) * profile.spread;
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
      // damageScale is where personal upgrades land. Applied here rather than by
      // editing CFG, so a run's upgrades cannot leak into global config -- and it
      // covers the rifle and both deck guns, since every shot routes through here.
      // damageBonus is the CONDITIONAL half, recomputed from scratch every frame by
      // the item runtime: "while beneath the hull", "for three seconds after
      // boarding", "while the reactor is failing". It is kept separate from
      // damageScale rather than folded into it because damageScale is derived
      // absolutely from stack counts, and a timed effect writing into it would
      // either be lost on the next recompute or accumulate forever.
      const dealt = profile.damage * (this.damageScale + this.damageBonus);
      // "player" because both the rifle and the manned deck guns come through here,
      // and a manned gun is the crew aiming. Only automation is excluded.
      //
      // TWO pierce terms, added together, and expressing the flank as a pierce is what
      // keeps armour resolved in exactly one place (Horde.damage) rather than growing a
      // second armour path here.
      //
      // armourPierce is SABOT ROUNDS -- a thing you bought.
      // The second is a thing you DID: a shot arriving inside a type's rear cone goes
      // around the plate instead of through it, so the bypass is worth exactly the
      // plate you walked around. Composes with sabot for free, and stays zero for
      // every type whose armour is omnidirectional.
      const cfg = enemyCfg(hit.enemy.type);
      const flank = cfg.armour - armourAt(cfg, hit.enemy.yaw, dir.x, dir.z);
      if (this.horde.damage(hit.enemy, dealt, "player", this.armourPierce + flank)) {
        this.kills++;
      }
      // After the damage, so an on-hit item sees the enemy in the state the shot
      // left it in -- including dead, which is what lets "on hit" and "on kill"
      // items stack on the same shot rather than racing each other.
      this.events?.emitHit(hit.enemy, dealt);
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
