import * as THREE from "three";
import { CFG } from "./config.js";

// Shock emitters -- the tower-defence layer.
//
// A playtest found the real structural problem: one player cannot hold the
// under-hull area and the reactor at once, so legs die while you are up top and
// the run spirals with no way to recover. These convert "be in two places" into
// "invest before you leave", which is a decision rather than an impossibility.
//
// The critical detail: they mount to the HULL, in local space, not to the world.
// A defence placed on open ground would be four metres behind a fortress walking
// at 4.5 m/s within a second, so ground placement is refused outright. Parenting
// the mesh to the hull group means they ride it for free.
//
// They are intentionally feeble relative to a player. See config for why.

const _world = new THREE.Vector3();
const _target = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);

const ARCS = 6;

export class Emitters {
  constructor(scene, trampler, horde) {
    this.trampler = trampler;
    this.horde = horde;

    this.slots = [];
    this.blockReason = "";

    const leg = new THREE.MeshStandardMaterial({
      color: 0x39414a, roughness: 0.6, metalness: 0.5,
    });
    const coil = new THREE.MeshStandardMaterial({
      color: 0x123945, emissive: 0x49d8ff, emissiveIntensity: 1.4, roughness: 0.4,
    });

    for (let i = 0; i < CFG.emitters.max; i++) {
      const group = new THREE.Group();

      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.18, 10), leg);
      base.position.y = 0.09;
      group.add(base);

      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 1.3, 8), leg);
      post.position.y = 0.75;
      post.castShadow = true;
      group.add(post);

      const head = new THREE.Mesh(new THREE.SphereGeometry(0.26, 12, 8), coil);
      head.position.y = 1.5;
      group.add(head);

      group.visible = false;
      trampler.group.add(group);

      this.slots.push({
        group,
        head,
        live: false,
        local: new THREE.Vector3(),
        cd: 0,
        charge: CFG.emitters.charge,
      });
    }

    // Arc beams, same trick as weapon tracers.
    this.arcs = [];
    const geo = new THREE.CylinderGeometry(1, 1, 1, 5);
    const mat = new THREE.MeshBasicMaterial({
      color: 0x9fe8ff, transparent: true, opacity: 0.8, depthWrite: false,
    });
    for (let i = 0; i < ARCS; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.arcs.push({ mesh: m, life: 0 });
    }
  }

  get deployedCount() {
    let n = 0;
    for (const s of this.slots) if (s.live) n++;
    return n;
  }

  get available() {
    return CFG.emitters.max - this.deployedCount;
  }

  /** World position of a live emitter's coil. */
  emitterWorld(slot, out = new THREE.Vector3()) {
    out.copy(slot.local);
    out.y += 1.5;
    return this.trampler.localToWorld(out);
  }

  // ------------------------------------------------------------------ placing

  /**
   * Placement is only legal on foot, beneath the hull footprint. Refusing open
   * ground is a teaching rule, not a limitation: anything left out there is
   * abandoned within a second.
   */
  canDeploy(player) {
    if (this.available <= 0) {
      this.blockReason = "NO EMITTERS LEFT";
      return false;
    }
    if (player.base !== null || player.station) {
      this.blockReason = "MUST BE ON FOOT";
      return false;
    }
    if (!player.grounded) {
      this.blockReason = "MUST BE ON THE GROUND";
      return false;
    }

    const t = this.trampler;
    const local = _world.copy(player.position);
    t.worldToLocal(local);
    if (Math.abs(local.x) > t.halfW || Math.abs(local.z) > t.halfL) {
      this.blockReason = "MUST BE BENEATH THE HULL";
      return false;
    }

    this.blockReason = "";
    return true;
  }

  deploy(player) {
    if (!this.canDeploy(player)) return null;

    const slot = this.slots.find((s) => !s.live);
    if (!slot) return null;

    const t = this.trampler;
    const local = _world.copy(player.position);
    t.worldToLocal(local);

    slot.local.set(local.x, local.y - player.half.y, local.z); // sit it on the sand
    slot.group.position.copy(slot.local);
    slot.group.visible = true;
    slot.live = true;
    slot.cd = 0;
    slot.charge = CFG.emitters.charge; // deploys with a full bank
    return slot;
  }

  /** Pick the nearest one back up, so a bad placement is not permanent. */
  recall(player) {
    let best = null;
    let bestDist = CFG.emitters.recallRange;

    for (const s of this.slots) {
      if (!s.live) continue;
      const d = player.position.distanceTo(this.emitterWorld(s, _world));
      if (d < bestDist) {
        bestDist = d;
        best = s;
      }
    }

    if (!best) return false;
    best.live = false;
    best.group.visible = false;
    return true;
  }

  clear() {
    for (const s of this.slots) {
      s.live = false;
      s.group.visible = false;
    }
  }

  // ------------------------------------------------------------------- update

  update(dt, input, player) {
    const cfg = CFG.emitters;

    for (const a of this.arcs) {
      if (a.life <= 0) continue;
      a.life -= dt;
      if (a.life <= 0) a.mesh.visible = false;
    }

    if (input.pressed(cfg.deployKey)) this.deploy(player);
    if (input.pressed(cfg.recallKey)) this.recall(player);
    this.canDeploy(player); // refresh blockReason for the HUD

    const r2 = cfg.radius * cfg.radius;

    for (const slot of this.slots) {
      if (!slot.live) continue;

      slot.cd -= dt;
      slot.charge = Math.min(cfg.charge, slot.charge + cfg.recharge * dt);

      // Coil brightness is the charge readout: bright and full, dim and dry.
      slot.head.material.emissiveIntensity = 0.25 + (slot.charge / cfg.charge) * 1.5;

      if (slot.cd > 0 || slot.charge < 1) continue;

      this.emitterWorld(slot, _world);

      let victim = null;
      let bestD2 = r2;
      for (const e of this.horde.pool) {
        if (!e.alive) continue;
        const dx = e.x - _world.x;
        const dy = e.y - _world.y;
        const dz = e.z - _world.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < bestD2) {
          bestD2 = d2;
          victim = e;
        }
      }

      if (!victim) continue;

      _target.set(victim.x, victim.y, victim.z);
      this.horde.damage(victim, cfg.damage);
      slot.charge -= 1;
      slot.cd = cfg.interval;
      this.#arc(_world, _target);
    }
  }

  #arc(from, to) {
    const a = this.arcs.find((x) => x.life <= 0) ?? this.arcs[0];
    _dir.subVectors(to, from);
    const len = _dir.length();
    if (len < 1e-4) return;
    _dir.divideScalar(len);
    _mid.addVectors(from, to).multiplyScalar(0.5);

    a.mesh.position.copy(_mid);
    a.mesh.scale.set(0.05, len, 0.05);
    a.mesh.quaternion.setFromUnitVectors(UP_Y, _dir);
    a.mesh.visible = true;
    a.life = CFG.emitters.arcLife;
  }
}
