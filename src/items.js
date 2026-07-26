import * as THREE from "three";
import { CFG, hyperGain } from "./config.js";
import { makeRandom } from "./util.js";
import { isSubmerged } from "./enemies.js";

// The salvage table: what a purchase actually does.
//
// This file exists because four numeric multipliers is not a build. Every run
// bought the same +25% damage in the same order, so the only thing that differed
// between two runs was which road you took. Growth in a roguelike has to be
// QUALITATIVE -- items that change how you play -- or the whole unbounded track is
// just a number going up.
//
// Three disciplines, and they are the reason this is a separate file rather than
// more of economy.js.
//
// 1. STATIC EFFECTS ARE RECOMPUTED ABSOLUTELY FROM STACK COUNT. `ITEM_EFFECTS[id]`
//    is `(ctx, n) => void` and it writes a value rather than adding to one. Reset,
//    revert and restore are then all the same code path with n at zero, and there
//    is no separate uninstall to forget. Same rule the fortress modules follow.
//
// 2. CONDITIONAL EFFECTS ARE REBUILT EVERY FRAME, into a SEPARATE field.
//    "While beneath the hull" and "for three seconds after boarding" cannot live in
//    `weapon.damageScale`, because that is derived from stack counts: a timed write
//    into it is either erased by the next recompute or accumulates forever. So
//    those land in `weapon.damageBonus`, which the runtime clears and rebuilds from
//    current conditions on every update. Absolute, again, for the same reason.
//
// 3. PROCS ONLY FIRE FOR KILLS THE CREW CAUSED. An on-kill splash triggered by a
//    shock emitter is automation compounding itself with nobody present -- exactly
//    what invariant 2b forbids, and exactly why the emitters were made weak and
//    finite. Every proc gates on `source === "player"`, and a manned deck gun counts
//    as the player because somebody is sitting in it.
//
// THE RULE FOR ADDING ANY ITEM HERE: does it let one position do the other's job?
// An auto-repair drone, a deployable turret, anything that reaches under the hull
// from the deck -- all perfectly ordinary roguelike items, and each one deletes the
// reason to oscillate, which is the entire game. The categories below were chosen
// because they pay you for MOVING between positions or for being in a specific one,
// which pushes the other way.

// Reusable scratch. `coversPoint` transforms the vector it is given, so it needs
// one it is allowed to destroy, and this runs every frame.
const _probe = new THREE.Vector3();

/**
 * Static effects, applied from stack count. Nothing here reads the world; anything
 * that depends on where you are or what just happened belongs in the runtime below.
 */
export const ITEM_EFFECTS = {
  // ---------------------------------------------------------------- the floor
  //
  // Plain numbers, kept deliberately. A pool of nothing but exotic effects has no
  // baseline to measure them against, and "just more damage" is a legitimate pick
  // when the alternative does not suit the build you already have.

  // Additive, and legible: three stacks is plainly +75% rather than a compounding
  // number nobody can predict mid-fight.
  rifle: (ctx, n) => { ctx.weapon.damageScale = 1 + 0.25 * n; },

  vitals: (ctx, n) => { ctx.player.maxHp = CFG.combat.playerHp + 25 * n; },

  // Hyperbolic, because it breaks at 100%: an unbounded fire rate eventually
  // divides by zero, and long before that it stops being a gun and starts being
  // a hose. Approaches +120% and never arrives.
  trigger: (ctx, n) => {
    const h = CFG.economy.hyper.trigger;
    ctx.weapon.fireRateScale = 1 + hyperGain(n, h.cap, h.k);
  },

  // Also hyperbolic, and for a design reason rather than a numerical one: total
  // immunity would remove the ground's cost, and the ground having a cost is half
  // the pillar. At ten stacks you still take 22% of every hit.
  weave: (ctx, n) => {
    ctx.player.damageScale = 1 / (1 + CFG.economy.hyper.weave.k * n);
  },

  // Multiplicative, so stacking has diminishing returns and four stacks is 52%
  // damage taken rather than 40%: plating must never trivialise the under-hull
  // fight, because that fight is why anyone dismounts.
  plating: (ctx, n) => { ctx.trampler.damageScale = 0.85 ** n; },

  rig: (ctx, n) => { ctx.repair.rateScale = 1 + 0.30 * n; },

  // ------------------------------------------------------------------ economy
  //
  // Compounding income rather than power. Bought early it is worth more than
  // anything else in the pool; bought at the last landmark it is worth nothing.
  // An item whose value depends on WHEN you take it is a decision for free.
  scavenger: (ctx, n) => { ctx.salvageScale = 1 + CFG.items.scavenger * n; },

  // ------------------------------------------------------------------- armour
  //
  // The one static item that changes which TOOL is correct rather than how well it
  // works. Bulwarks exist to make the rifle wrong and the deck gun right (test 69);
  // this partially undoes that on purpose, so "I can answer armour on foot now" is
  // a build a run can actually arrive at. Flat pierce against flat armour, and the
  // minimum-damage floor in afterArmour still applies, so nothing becomes immune in
  // reverse.
  sabot: (ctx, n) => { ctx.weapon.armourPierce = CFG.items.sabot * n; },
};

/**
 * Conditional and timed damage, and the procs.
 *
 * Kept as a class rather than more entries in ITEM_EFFECTS because all of it is
 * per-frame state: timers that run down, conditions that come and go, and a seeded
 * stream for the chance rolls.
 */
export class Items {
  constructor({ economy, player, trampler, weapon, horde, repair, events, seed }) {
    this.economy = economy;
    this.player = player;
    this.trampler = trampler;
    this.weapon = weapon;
    this.horde = horde;
    this.repair = repair;
    this.seed = seed ?? CFG.items.seed;

    // Seeded, like every other stochastic part of this simulation. A proc chance on
    // Math.random would make two attempts at the same seeded wave differ, which is
    // the whole thing the seeds exist to prevent.
    this.random = makeRandom(this.seed);

    // Subscribed once, never unsubscribed -- same rule as the economy's income. A
    // reset zeroes the stacks, and an item with no stacks does nothing, so there is
    // nothing to detach.
    events?.onKill((e, source) => this.#onKill(e, source));
    events?.onHit((e, damage) => this.#onHit(e, damage));

    this.reset();
  }

  reset() {
    this.random = makeRandom(this.seed);

    // Timed buffs, in seconds remaining.
    this.boardT = 0;
    this.dropT = 0;
    this.welderT = 0;

    // Last frame's readings, for detecting the transitions.
    this.wasAboard = !!this.player?.base;
    this.seenCompletions = this.repair?.completions ?? 0;
    // Dying respawns you on the deck, which is a ground->aboard transition as far as
    // `player.base` can tell. Paying the boarding buff for it would be paying the
    // player for FAILING, which is the same objection that stops an on-kill item
    // rewarding a sapper's charge going off.
    this.seenDeaths = this.player?.deaths ?? 0;

    // Diagnostics, and the HUD's "what is my build doing" readout.
    this.procs = { fragment: 0, arc: 0, executioner: 0 };
    this.bonus = 0;
    this.reasons = [];

    this.weapon.damageBonus = 0;
  }

  /** How many of an item are stacked. */
  #n(id) {
    return this.economy?.stacks?.[id] ?? 0;
  }

  // ------------------------------------------------------------------- procs

  #onKill(e, source) {
    // The invariant-2b gate. An emitter kill must not chain.
    if (source !== "player") return;

    const frag = this.#n("fragment");
    if (frag > 0) this.#splash(e, CFG.items.fragment.damage * frag, CFG.items.fragment.radius);

    const exec = this.#n("executioner");
    if (exec > 0 && this.player) {
      const heal = CFG.items.executioner * exec;
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + heal);
      // Counted like the other two. A proc counter that is declared and never
      // written reads as "this item has never fired" on the diagnostics panel,
      // which is worse than having no counter at all.
      this.procs.executioner++;
    }
  }

  #onHit(e, damage) {
    const arc = this.#n("arc");
    if (arc === 0) return;
    // One roll per hit, not per stack, so stacking raises the chance rather than
    // multiplying the number of rolls -- otherwise ten stacks is ten arcs a shot.
    const chance = hyperGain(arc, CFG.items.arc.chanceCap, CFG.items.arc.chanceK);
    if (this.random() >= chance) return;

    const nearest = this.#nearestOther(e, CFG.items.arc.range);
    if (!nearest) return;
    this.procs.arc++;
    // Damage from a proc is still "player" damage: the crew pulled the trigger that
    // started it. The event bus's depth cap is what stops a chain going forever.
    this.horde.damage(nearest, damage * CFG.items.arc.share, "player");
  }

  /** Damage everything within `radius` of a corpse, except the corpse. */
  #splash(dead, amount, radius) {
    const r2 = radius * radius;
    const pool = this.horde.pool;
    let struck = 0;
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i];
      if (!o.alive || o === dead) continue;
      // Burrowed things are underground and untouchable -- invariant 8's other half.
      // This read `o.burrowed` for an entire update and therefore excluded NOTHING:
      // there is no such per-enemy field, so splash was reaching enemies a bullet
      // cannot touch. Hence the imported predicate. See `isSubmerged` in enemies.js.
      if (isSubmerged(o)) continue;
      const dx = o.x - dead.x;
      const dz = o.z - dead.z;
      if (dx * dx + dz * dz > r2) continue;
      this.horde.damage(o, amount, "player");
      struck++;
      if (struck >= CFG.items.fragment.maxTargets) break;
    }
    if (struck > 0) this.procs.fragment++;
  }

  #nearestOther(from, range) {
    const r2 = range * range;
    const pool = this.horde.pool;
    let best = null;
    let bestD = r2;
    for (let i = 0; i < pool.length; i++) {
      const o = pool[i];
      // Same silent bug as #splash: an arc could chain INTO something underground.
      if (!o.alive || o === from || isSubmerged(o)) continue;
      const dx = o.x - from.x;
      const dz = o.z - from.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = o;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ update

  /**
   * Rebuild every conditional bonus from scratch.
   *
   * Cleared and recomputed rather than adjusted, so the value can never drift and a
   * condition that stops applying stops contributing the same frame.
   */
  update(dt) {
    const p = this.player;
    const t = this.trampler;

    // ---- transitions. Detected by comparing this frame's base against last
    // frame's, rather than by an event, because the mantle and drop paths write
    // `player.base` directly and an event threaded through attachTo would miss them.
    //
    // A death is filtered out first. `respawnOnDeck` moves you from the ground to the
    // deck, which is indistinguishable from boarding by looking at `player.base`, and
    // paying the boarding buff for dying would reward the failure. The base reading is
    // still updated, so the transition is CONSUMED rather than deferred -- otherwise
    // the buff would simply fire on the next frame instead.
    const deaths = p.deaths ?? 0;
    const died = deaths !== this.seenDeaths;
    if (died) this.seenDeaths = deaths;

    const aboard = !!p.base;
    if (aboard !== this.wasAboard) {
      if (died) {
        // consumed, unpaid
      } else if (aboard) {
        this.boardT = CFG.items.spurs.seconds;
      } else {
        this.dropT = CFG.items.dropHarness.seconds;
      }
      this.wasAboard = aboard;
    }

    // ---- a finished repair
    const done = this.repair?.completions ?? 0;
    if (done !== this.seenCompletions) {
      this.seenCompletions = done;
      this.welderT = CFG.items.welder.seconds;
    }

    this.boardT = Math.max(0, this.boardT - dt);
    this.dropT = Math.max(0, this.dropT - dt);
    this.welderT = Math.max(0, this.welderT - dt);

    let bonus = 0;
    const why = this.reasons;
    why.length = 0;

    // ---- position. Being under the hull is the dangerous half of the pillar, so
    // paying for it pushes toward the thing the design wants and away from camping
    // the deck.
    const under = this.#n("understudy");
    if (under > 0 && !aboard && t.coversPoint(_probe.copy(p.position))) {
      bonus += CFG.items.understudy * under;
      why.push("UNDER HULL");
    }

    // ---- manning a station. Buffs a MANNED position, never an automated one, so
    // it stays on the right side of invariant 2b.
    const harness = this.#n("harness");
    if (harness > 0 && p.station) {
      bonus += CFG.items.harness * harness;
      why.push("ON STATION");
    }

    // ---- risk. Both of these pay for the state you would rather not be in, which
    // makes a losing fight worth continuing rather than worth restarting.
    const redline = this.#n("redline");
    if (redline > 0 && t.maxReactorHp > 0
      && t.reactorHp / t.maxReactorHp < CFG.items.redline.below) {
      bonus += CFG.items.redline.gain * redline;
      why.push("REACTOR CRITICAL");
    }

    const last = this.#n("laststand");
    if (last > 0 && p.hp / p.maxHp < CFG.items.laststand.below) {
      bonus += CFG.items.laststand.gain * last;
      why.push("LAST STAND");
    }

    // ---- transitions paying out. These two are the most on-theme items in the
    // pool: one rewards getting aboard, the other rewards dropping off, so a build
    // that takes both is paid for oscillating, which is the entire pillar.
    const spurs = this.#n("spurs");
    if (spurs > 0 && this.boardT > 0) {
      bonus += CFG.items.spurs.gain * spurs;
      why.push("BOARDED");
    }

    const drop = this.#n("dropHarness");
    if (drop > 0 && this.dropT > 0) {
      bonus += CFG.items.dropHarness.gain * drop;
      why.push("DISMOUNTED");
    }

    const welder = this.#n("welder");
    if (welder > 0 && this.welderT > 0) {
      bonus += CFG.items.welder.gain * welder;
      why.push("REPAIRED");
    }

    this.bonus = bonus;
    this.weapon.damageBonus = bonus;
  }
}
