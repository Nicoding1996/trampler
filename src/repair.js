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
    // Browser prediction simulates only the local operative. Exact claims from the newest
    // authoritative snapshot live here as key -> seat and are replaced wholesale each time;
    // accumulating them would leave a disconnected welder owning a point forever.
    this.externalClaims = new Map();
    // The authority chooses the exact point for generic repair intent. Once a snapshot names
    // this operative's point, prediction prefers that key while it remains a valid free target;
    // otherwise two points inside one overlap can disagree forever inside position dead-zone.
    this.authorityTarget = null;

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

  /** Replace the remote point claims supplied by the newest authoritative snapshot. */
  setExternalClaims(claims = []) {
    this.externalClaims.clear();
    for (const claim of claims) {
      const seat = Number(claim?.seat);
      const key = claim?.key;
      if (!Number.isInteger(seat) || seat <= 0) continue;
      if (key !== "reactor" && !/^leg:\d+$/.test(key ?? "")) continue;
      const current = this.externalClaims.get(key);
      // Duplicate ownership is an authority fault, but choosing the earlier seat keeps the
      // client deterministic and matches the simulation's join-order tie break.
      if (current === undefined || seat < current) this.externalClaims.set(key, seat);
    }
  }

  /** Replace the exact point authority selected for this predicted operative. */
  setAuthorityTarget(key = null) {
    this.authorityTarget = key === "reactor" || /^leg:\d+$/.test(key ?? "") ? key : null;
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
   * Seat of the operative already working `key`, or zero. Never this one.
   *
   * A full authority reads the live Crew. Browser prediction has only its local Player, so
   * the newest snapshot supplies the same exact question through `externalClaims`. Both are
   * absolute state: leaving the crew or disappearing from a snapshot releases the point
   * without a second cleanup path that can drift.
   */
  #claimantSeat(key) {
    // Deliberately NOT guarded against a missing crew. A `if (!this.crew) return 0`
    // here would turn "somebody forgot to wire the roster" into "the one-welder rule
    // quietly stopped applying", which is unobservable solo and reads as a balance
    // problem in co-op. Let it throw on the first frame instead.
    for (const other of this.crew) {
      if (other === this.player) continue;
      if (other.repairing === key) return this.crew.seatOf(other);
    }
    return this.externalClaims.get(key) ?? 0;
  }

  /** Decide whether repair owns the carried hands from this frame's final position. */
  admit(dt, input) {
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
    // A snapshot preference reconciles one continuous hold. Releasing starts a new choice;
    // retaining the old key across a release could pull the next press back to a point the
    // operative deliberately left.
    if (!holding) this.authorityTarget = null;

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
    // The newest exact authority result wins among still-valid free points. This is only a
    // tie-break over targets prediction can genuinely reach; it cannot grant range, health or
    // ownership. Without it, centimetre-scale position disagreement inside the correction
    // dead-zone can leave client and authority repairing different legs indefinitely.
    const authoritative = this.authorityTarget
      ? found.find((c) => c.target.key === this.authorityTarget
        && this.#claimantSeat(c.target.key) === 0)
      : null;
    const free = authoritative ?? found.find((c) => this.#claimantSeat(c.target.key) === 0);
    const pick = free ?? found[0] ?? null;
    const best = pick?.target ?? null;
    this.takenBy = best ? this.#claimantSeat(best.key) : 0;

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
    // contested rule applied by `work`, and deliberately so: contested repair is a trade
    // the player can choose to make, while a second welder on one leg is not a trade at
    // all -- it is the same job done twice. The prompt says which of the two it is.
    this.active = holding && !!best && this.takenBy === 0;

    // Claimed only once the work is genuinely happening, so standing beside a leg
    // without pressing the key never locks a teammate out of it.
    if (this.active) this.player.repairing = this.target.key;
  }

  /** Apply admitted work after personal and station weapons have resolved this frame. */
  work(dt) {
    // This sample deliberately remains in repair's old post-weapon slot. A gun that clears
    // the final nearby hostile earns full-rate repair on that same tick; moving the sample
    // into admission would silently change contested timing and mounted-gun behaviour.
    this.threatened = this.#underThreat();
    if (!this.active || !this.target) return;

    const t = this.trampler;
    const r = CFG.repair;
    const tgt = this.target;

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

  /** One-call form for focused callers that do not interleave weapon resolution. */
  update(dt, input) {
    this.admit(dt, input);
    this.work(dt);
  }
}
