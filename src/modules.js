import { CFG } from "./config.js";

// Fortress modules: the bounded build layer.
//
// Three sockets, six modules, installs permanent for the run. This is the game's
// identity rather than a feature -- "bounded structure, unbounded stacking" made
// physical. Personal upgrades pile up without limit on salvage; the fortress has
// a fixed number of places to bolt things, so a run has a readable silhouette
// instead of growing forever.
//
// Two rules this file exists to enforce.
//
// EFFECTS ARE INSTANCE MULTIPLIERS, NEVER EDITS TO CFG. Same discipline as the
// economy's refits, for the same two reasons: writing a run's build into global
// config leaks it into every later test in the same process, and a restart that
// kept the previous run's modules would make each attempt quietly easier, which
// destroys the point of a seeded fight.
//
// EFFECTS ARE RECOMPUTED ABSOLUTELY, NEVER INCREMENTED. `apply()` derives every
// multiplier from the current socket contents and writes it. So uninstalling,
// resetting and restoring are all the same code path, and there is no way for an
// increment to be applied twice or reverted once. The bug this avoids -- a
// modifier that survives a reset because someone added an install path and forgot
// the matching removal -- is invisible until two runs disagree.
//
// NOTHING HERE IS AN AUTOMATED WEAPON. Shock emitters already occupy the
// automation slot, and a second automated damage source makes it impossible to
// attribute a fight to either. Every module below buys time, buys legibility, or
// buffs something a player has to be present to use. Invariant 2b is what kept
// the list honest, and test 69 re-checks it with the whole build fitted.

/**
 * What each module does, expressed as a function of how many of it are fitted.
 *
 * Written as "count -> absolute value" rather than "on install, multiply", which
 * is what makes duplicate fits well defined: two floodlight modules is a shorter
 * burrow time than one, and removing one gets you exactly back.
 */
const EFFECTS = {
  floodlights: (ctx, n) => {
    // Burrowers surface sooner, so the thing that ignores your firing line at
    // least announces itself earlier.
    ctx.horde.revealScale = CFG.fortress.floodlightReveal ** n;
    // Real light under the hull. The arena is meant to be gloomy -- that is half of
    // why it is unpleasant down there -- so this is something you buy, not
    // something you start with. Attached rather than dimmed: a light at intensity
    // zero still costs per-pixel work in every material in the scene.
    ctx.trampler.setFloodlights?.(n > 0, 90);
  },

  emitterRack: (ctx, n) => {
    ctx.emitters.bonusSlots = CFG.fortress.emitterSlots * n;
    ctx.emitters.bonusCharge = CFG.fortress.emitterCharge * n;
  },

  ammoHoist: (ctx, n) => {
    for (const gun of ctx.guns) {
      gun.heatScale = CFG.fortress.heatScale ** n;
      gun.coolScale = CFG.fortress.coolScale ** n;
    }
  },

  baffles: (ctx, n) => {
    ctx.horde.climbScale = CFG.fortress.climbScale ** n;
  },

  actuators: (ctx, n) => {
    ctx.trampler.driveScale = CFG.fortress.driveScale ** n;
    ctx.trampler.turnScale = CFG.fortress.turnScale ** n;
  },

  casing: (ctx, n) => {
    const before = ctx.trampler.maxReactorHp;
    ctx.trampler.reactorScale = CFG.fortress.reactorScale ** n;
    ctx.trampler.slotBonus = CFG.fortress.slotBonus * n;
    // Fitting more capacity should be worth something immediately, so the extra
    // integrity arrives filled rather than as a bigger empty bar. Scaling the
    // current value by the same ratio also means fitting it while damaged does
    // not accidentally heal you to full.
    if (before > 0) {
      ctx.trampler.reactorHp *= ctx.trampler.maxReactorHp / before;
    }
  },
};

export class Modules {
  constructor(ctx) {
    // { trampler, horde, emitters, guns }
    this.ctx = ctx;
    this.sockets = new Array(CFG.fortress.sockets).fill(null);
    this.blockedReason = "";
    this.reset();
  }

  get catalogue() {
    return CFG.fortress.catalogue;
  }

  get freeSockets() {
    let n = 0;
    for (const s of this.sockets) if (s === null) n++;
    return n;
  }

  get fittedCount() {
    return this.sockets.length - this.freeSockets;
  }

  /** How many of a module are fitted. */
  count(id) {
    let n = 0;
    for (const s of this.sockets) if (s === id) n++;
    return n;
  }

  has(id) {
    return this.count(id) > 0;
  }

  costOf(index) {
    const item = this.catalogue[index];
    return item ? item.cost : Infinity;
  }

  /**
   * Can this module be fitted? Duplicates ARE allowed -- doubling down on one
   * capability instead of covering three is a legitimate build, and forbidding it
   * would turn three sockets into "pick three of six" rather than a decision.
   */
  canFit(index) {
    const item = this.catalogue[index];
    if (!item) {
      this.blockedReason = "NO SUCH MODULE";
      return false;
    }
    if (this.freeSockets <= 0) {
      this.blockedReason = "ALL HARDPOINTS OCCUPIED";
      return false;
    }
    this.blockedReason = "";
    return true;
  }

  /**
   * Bolt a module into the first free socket. Returns the item, or null.
   *
   * Installs are permanent for the run, and that is the design: a build you can
   * rearrange between waves is not a commitment, and without commitment the
   * choice of what to fit is a preference you can revisit for free rather than a
   * decision you have to live with.
   */
  fit(index) {
    if (!this.canFit(index)) return null;
    const item = this.catalogue[index];

    const socket = this.sockets.indexOf(null);
    this.sockets[socket] = item.id;
    this.ctx.trampler.fitSocketMesh?.(socket, item.id);
    this.apply();

    return { ...item, socket, fitted: this.count(item.id) };
  }

  /** Strip every socket and restore every baseline. Part of a run reset. */
  reset() {
    this.sockets.fill(null);
    this.ctx.trampler.clearSocketMeshes?.();
    this.apply();
  }

  /**
   * Recompute every module effect from the current sockets.
   *
   * Every effect runs on every call, including with a count of zero -- that is
   * what restores baselines, and it is why there is no separate uninstall path to
   * forget to write.
   */
  apply() {
    for (const item of this.catalogue) {
      EFFECTS[item.id](this.ctx, this.count(item.id));
    }
  }

  /** What the bay panel needs to draw itself. */
  get entries() {
    return this.catalogue.map((item, i) => ({
      key: CFG.fortress.keys[i],
      id: item.id,
      name: item.name,
      detail: item.detail,
      cost: item.cost,
      fitted: this.count(item.id),
    }));
  }

  /** Human-readable build, for the HUD and for a run summary. */
  get summary() {
    return this.sockets.map((id) => {
      if (!id) return "EMPTY";
      return this.catalogue.find((c) => c.id === id).name;
    });
  }
}
