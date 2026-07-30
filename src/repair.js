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

// ONE OPERATIVE PER POINT, and that is the co-op rule rather than a limitation worked
// around.
//
// The argument is invariant 12b's own measurement read forwards. 110 hp/s was chosen
// against chewer damage of 48-154 hp/s, deliberately landing INSIDE that band: a single
// welder wins against a few and loses against a crowd, so patching a leg under fire is a
// race you can lose. Two welders on one leg is 220, which clears the top of the band
// outright, and the under-hull fight stops being a race at all.
//
// What the second person should do instead was already settled, in the contested-repair
// rule: 12c measures hostiles near the PLAYER specifically so that "a teammate defending
// you would not freeze the work". They are not welding, they are covering.
//
// So repair is PARALLEL ACROSS POINTS and capped at one per point -- 220 hp/s across two
// legs is the division of labour co-op exists for, and it is the same mechanism as
// `reactorSlotCount` capping simultaneous attackers, pointed the other way.

export class Repair {
  constructor(player, trampler, horde, crew) {
    this.player = player;
    this.trampler = trampler;
    this.horde = horde;
    // The roster, for one question only: is somebody ELSE on this point. At one member
    // that question is arithmetically always "no", which is why this whole rule is
    // invisible solo and why the suite's output is unchanged by it.
    this.crew = crew;

    this.target = null;    // { kind: "leg" | "reactor", index?, label, key }
    this.progress = 0;     // 0..1 of the target's health
    this.active = false;   // currently holding the key and in range
    this.threatened = false; // a hostile is close enough to SLOW the work
    this.takenBy = 0;      // seat of the operative already on this point, 0 for nobody
    this.grace = 0;        // keeps the interaction alive through brief drift
    this.restored = 0;     // legs brought back from dead, for the HUD
    this.rateScale = 1;    // multiplier owned by the economy's repair rig

    // Repairs finished: a leg or the reactor taken all the way back to full.
    //
    // A counter rather than an event, because at most one repair can complete in a
    // frame, so nothing is lost by polling it. `restored` is a different moment and
    // both are worth having: that one counts legs brought back from DEAD, which is
    // the recovery the HUD cares about, while this one counts work finished, which
    // is what a job-linked item should pay out for.
    this.completions = 0;

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

  /**
   * The operative already working `key`, or null. Never this one.
   *
   * Read off the other operatives rather than off a registry of Repair instances,
   * because the crew is already the authority on who exists: an operative who leaves the
   * crew stops being iterated, so their claim goes with them and there is no release
   * path to forget. That is the same reason the reactor recounts its engagement slots
   * from scratch every frame instead of keeping a running total -- a claim maintained
   * across frames drifts, and a drifted claim fails silently.
   */
  #claimant(key) {
    // Deliberately NOT guarded against a missing crew. A `if (!this.crew) return null`
    // here would turn "somebody forgot to wire the roster" into "the one-welder rule
    // quietly stopped applying", which is unobservable solo and reads as a balance
    // problem in co-op. Let it throw on the first frame instead.
    for (const other of this.crew) {
      if (other === this.player) continue;
      if (other.repairing === key) return other;
    }
    return null;
  }

  update(dt, input) {
    this.#updateMarkers();

    // Cleared here and rebuilt from this frame's conditions at the bottom, never
    // released by a separate path. Absolute rather than incremental, for the reason
    // `weapon.damageBonus` is: a field written on one event and cleared on another
    // survives whenever somebody adds the first without the second.
    //
    // Note what this means across operatives. Their updates run in crew order, so an
    // operative earlier in the order sees last frame's claim and one later in the order
    // sees this frame's. Both readings are correct -- a claim is only ever one frame
    // stale, and the claimant is still standing there -- and the tie-break is therefore
    // crew order, which is join order, which is stable. Same property that makes
    // listener order deterministic on the event bus.
    this.player.repairing = null;

    const t = this.trampler;
    const r = CFG.repair;
    const holding = input.down(r.key);
    this.threatened = this.#underThreat();

    // Every point in reach, rather than the single nearest, because the choice is now
    // two-pass: a free point beats a closer one somebody else is already welding. A
    // single "nearest wins" pass would let a taken leg starve a free one standing right
    // beside it -- the same starvation `buildWave` allocates in two passes to avoid.
    const found = [];
    for (let i = 0; i < t.legHp.length; i++) {
      if (t.legHp[i] >= CFG.trampler.legHp) continue;
      t.legAttackWorld(i, _p);
      const d = this.player.position.distanceTo(_p);
      if (d < r.range) {
        found.push({
          d,
          target: { kind: "leg", index: i, label: `${t.legLabel(i)} LEG`, key: `leg:${i}` },
        });
      }
    }

    if (!t.destroyed && t.reactorHp < t.maxReactorHp) {
      t.reactorSurfaceWorld(this.player.position, _p);
      const d = this.player.position.distanceTo(_p);
      if (d < r.range) {
        found.push({ d, target: { kind: "reactor", label: "REACTOR", key: "reactor" } });
      }
    }

    // Stable sort, so an exact distance tie keeps the order the legs were walked in --
    // which is what the old progressive `d < bestDist` comparison did.
    found.sort((a, b) => a.d - b.d);

    // Nearest free point; failing that, the nearest point at all, so a fully claimed
    // area still names what is happening instead of offering nothing. A refusal that
    // shows the player an empty prompt sends them to fix the wrong thing.
    const free = found.find((c) => !this.#claimant(c.target.key));
    const pick = free ?? found[0] ?? null;
    const best = pick?.target ?? null;
    const heldBy = best ? this.#claimant(best.key) : null;
    this.takenBy = heldBy ? this.crew.seatOf(heldBy) : 0;

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
      : t.reactorHp / t.maxReactorHp;

    // Work only happens while genuinely in range. Grace keeps the prompt alive
    // through brief drift, never the progress.
    //
    // `takenBy` refuses outright rather than slowing, which is the opposite of the
    // contested rule two lines down, and deliberately so: contested repair is a trade
    // the player can choose to make, while a second welder on one leg is not a trade at
    // all -- it is the same job done twice. The prompt says which of the two it is.
    this.active = holding && !!best && this.takenBy === 0;
    if (!this.active) return;

    // Claimed only once the work is genuinely happening, so standing beside a leg
    // without pressing the key never locks a teammate out of it.
    this.player.repairing = this.target.key;

    // Contested work is slowed, not stopped. Your own health is the real limit on
    // standing here, and a hard stop would break co-op: it measures hostiles near
    // the player, so a teammate defending you would freeze the repair.
    const rate = (this.threatened ? r.contestedRate : 1) * this.rateScale;

    if (tgt.kind === "leg") {
      const wasFull = t.legHp[tgt.index] >= CFG.trampler.legHp;
      if (t.repairLeg(tgt.index, r.legRate * rate * dt)) this.restored++;
      if (!wasFull && t.legHp[tgt.index] >= CFG.trampler.legHp) this.completions++;
    } else {
      const wasFull = t.reactorHp >= t.maxReactorHp;
      t.repairReactor(r.reactorRate * rate * dt);
      if (!wasFull && t.reactorHp >= t.maxReactorHp) this.completions++;
    }
  }
}
