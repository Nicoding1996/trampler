import * as THREE from "three";
import { CFG } from "./config.js";

// Hold a key near a damaged system to restore it.
//
// The placement is the design. A leg's repair point is the SAME spot chewers
// attack from -- under the hull slab, out of sight of the deck. So fixing the
// fortress means standing in the worst place on the map, which gives the ground
// a job beyond shooting and makes the walk down there a decision.
//
// The reactor's repair point is on the deck, so the two jobs pull in opposite
// directions exactly like the two enemy types do.
//
// Two things this has to get right, both learned from playtesting:
//
//   Findability. The spot has to be marked on the ground, because "somewhere
//   under the hull near a leg" is not something a player can locate by guessing.
//
//   Forgiveness. The spot rides a hull walking at 4.5 m/s, so you jog along
//   underneath to keep working. Losing the interaction the instant you drift
//   makes that feel broken, even though restored health is never lost.

const _p = new THREE.Vector3();

export class Repair {
  constructor(player, trampler, horde) {
    this.player = player;
    this.trampler = trampler;
    this.horde = horde;

    this.target = null;    // { kind: "leg" | "reactor", index?, label }
    this.progress = 0;     // 0..1 of the target's health
    this.active = false;   // currently holding the key and in range
    this.threatened = false; // a hostile is close enough to SLOW the work
    this.grace = 0;        // keeps the interaction alive through brief drift
    this.restored = 0;     // legs brought back from dead, for the HUD

    this.#buildMarkers();
  }

  /** A lit ring on the ground under each leg, shown only when it needs work. */
  #buildMarkers() {
    const t = this.trampler;
    this.markers = [];

    const geo = new THREE.RingGeometry(0.75, 1.05, 20);
    for (let i = 0; i < t.legHp.length; i++) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffb347, transparent: true, opacity: 0.75,
        side: THREE.DoubleSide, depthWrite: false,
      });
      const ring = new THREE.Mesh(geo, mat);
      ring.rotation.x = -Math.PI / 2;

      const at = t.legAttackLocal(i, new THREE.Vector3());
      // Sit it on the ground rather than at the enemy's chest height.
      ring.position.set(at.x, -CFG.trampler.deckHeight + 0.05, at.z);
      ring.visible = false;
      ring.frustumCulled = false;

      t.group.add(ring);
      this.markers.push({ mesh: ring, mat });
    }
  }

  #updateMarkers() {
    const t = this.trampler;
    for (let i = 0; i < this.markers.length; i++) {
      const frac = t.legHp[i] / CFG.trampler.legHp;
      const m = this.markers[i];
      const show = frac < 1;
      if (m.mesh.visible !== show) m.mesh.visible = show;
      if (!show) continue;
      // Red once the leg is dead, amber while it is merely damaged.
      m.mat.color.setHex(frac <= 0 ? 0xff5a5a : 0xffb347);
    }
  }

  /** Is anything close enough to interrupt the work? */
  #underThreat() {
    if (!this.horde) return false;
    const reach = CFG.repair.threatRange;
    const reach2 = reach * reach;
    const p = this.player.position;

    for (const e of this.horde.pool) {
      if (!e.alive) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const dz = e.z - p.z;
      if (dx * dx + dy * dy + dz * dz < reach2) return true;
    }
    return false;
  }

  update(dt, input) {
    this.#updateMarkers();

    const t = this.trampler;
    const r = CFG.repair;
    const holding = input.down(r.key);
    this.threatened = this.#underThreat();

    let best = null;
    let bestDist = r.range;

    for (let i = 0; i < t.legHp.length; i++) {
      if (t.legHp[i] >= CFG.trampler.legHp) continue;
      t.legAttackWorld(i, _p);
      const d = this.player.position.distanceTo(_p);
      if (d < bestDist) {
        bestDist = d;
        best = { kind: "leg", index: i, label: `${t.legLabel(i)} LEG` };
      }
    }

    if (!t.destroyed && t.reactorHp < CFG.trampler.reactorHp) {
      t.reactorSurfaceWorld(this.player.position, _p);
      const d = this.player.position.distanceTo(_p);
      if (d < bestDist) {
        bestDist = d;
        best = { kind: "reactor", label: "REACTOR" };
      }
    }

    // Hold the interaction through short gaps, so jogging along under a moving
    // hull does not keep dropping it.
    if (best) {
      this.grace = r.graceTime;
      this.target = best;
    } else {
      this.grace = Math.max(0, this.grace - dt);
      if (this.grace <= 0) this.target = null;
    }

    if (!this.target) {
      this.progress = 0;
      this.active = false;
      return;
    }

    const tgt = this.target;
    this.progress = tgt.kind === "leg"
      ? t.legHp[tgt.index] / CFG.trampler.legHp
      : t.reactorHp / CFG.trampler.reactorHp;

    // Work only happens while genuinely in range. Grace keeps the prompt alive
    // through brief drift, never the progress.
    this.active = holding && !!best;
    if (!this.active) return;

    // Contested work is slowed, not stopped. Your own health is the real limit on
    // standing here, and a hard stop would break co-op: it measures hostiles near
    // the player, so a teammate defending you would freeze the repair.
    const rate = this.threatened ? r.contestedRate : 1;

    if (tgt.kind === "leg") {
      if (t.repairLeg(tgt.index, r.legRate * rate * dt)) this.restored++;
    } else {
      t.repairReactor(r.reactorRate * rate * dt);
    }
  }
}
