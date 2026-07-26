import { CFG, ENEMY_TYPE_KEYS, hyperGain } from "./config.js";
import { PHASE } from "./waves.js";

// The economy, and the reason it exists is Q.
//
// Calling a wave early has been in the build since the pacing rework and nobody
// would ever press it: the cost is losing a 12 second preparation window and the
// reward was nothing at all. A risk with no upside is not a decision. Everything
// here exists to put something on the other side of that key.
//
// Two pools, split from the start rather than retrofitted:
//
//   SALVAGE is personal, earned from what you kill, and buys unbounded personal
//   upgrades. This is the term that has to grow, because enemy strength is
//   quadratic while base damage is flat.
//
//   SCRAP is shared, earned when the crew RESOLVES a wave rather than per kill,
//   and buys the bounded fortress: refits, and modules for the three hardpoints.
//   Funding it from the shared objective means nobody can farm the crew's budget
//   on their own.
//
// One pooled pot would generate a co-op argument every wave and is painful to
// unpick later, since every price and payout has to be re-derived.
//
// Effects are applied as multipliers on the OWNING INSTANCE -- weapon.damageScale,
// trampler.damageScale, repair.rateScale, player.damageScale -- never by mutating
// CFG. A debug knob that wrote to CFG very nearly poisoned every test that ran
// after it, and a run's upgrades leaking into global config would do the same
// thing permanently.
//
// And they are recomputed ABSOLUTELY from the stack count rather than incremented
// on purchase. That is what makes `reset()` trivially correct: it is the same code
// path with every count at zero. The bug it rules out -- a modifier that survives
// a reset because someone added a purchase path and forgot the matching revert --
// is invisible until two attempts at the same seeded wave disagree.

/**
 * What each purchase actually does, as a function of how many are stacked.
 *
 * Kept here rather than in config.js because config holds tunable DATA; this is
 * behaviour, and a closure in a config file cannot be read at a glance next to
 * the number it modifies.
 */
const EFFECTS = {
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
};

export class Economy {
  // How many resolved waves have already been paid for. Polled against the
  // director rather than driven by a callback, so the director stays unaware that
  // an economy exists at all.
  #resolvedSeen = 0;

  constructor({ player, trampler, weapon, repair, horde, director, modules = null }) {
    this.player = player;
    this.trampler = trampler;
    this.weapon = weapon;
    this.repair = repair;
    this.horde = horde;
    this.director = director;
    this.modules = modules;

    // Every kill routes through Horde.damage, whatever fired the shot -- rifle,
    // either deck gun, a shock emitter, or a foot coming down. Hooking it in one
    // place means no income source can be forgotten when a new weapon is added.
    horde.onKill = (e) => this.#onKill(e);

    this.reset();
  }

  reset() {
    this.scrap = 0;
    this.salvage = 0;
    this.earned = { scrap: 0, salvage: 0 };
    this.stacks = {};
    for (const item of CFG.economy.catalogue) this.stacks[item.id] = 0;

    this.purchases = 0;
    this.lastBought = null;
    this.blockedReason = "";
    // Free module fits, granted by the Boneyard road. Spent before scrap.
    this.moduleCredits = 0;

    // What happened this frame, for the on-screen banner. Cleared every update, so
    // reading it is always about the current frame and never a stale message.
    this.lastEvent = null;
    this.bonusPaid = 0; // how much the early-call gamble has actually returned

    // Restoring the baseline matters as much as applying the upgrades. A restart
    // that left the previous run's stats in place would silently make every
    // subsequent attempt easier, and the seeded fight exists precisely so two
    // attempts are comparable.
    this.applyAll();
    this.player.hp = Math.min(this.player.hp, this.player.maxHp);
    this.modules?.reset();

    this.#resolvedSeen = this.director ? this.director.resolved : 0;
  }

  /**
   * Recompute every upgrade from its stack count.
   *
   * Every effect runs on every call, including at zero, which is what restores the
   * baselines. There is deliberately no separate revert path to forget to write.
   */
  applyAll() {
    for (const item of CFG.economy.catalogue) {
      EFFECTS[item.id](this, this.stacks[item.id] ?? 0);
    }
  }

  // ------------------------------------------------------------------- income

  /** Multiplier on everything this wave pays, from having called it early. */
  get bonus() {
    return this.director?.calledEarly ? 1 + CFG.economy.earlyCallBonus : 1;
  }

  #onKill(e) {
    // Looked up by type NAME rather than by a ternary on the type id. A ternary is
    // how a newly added enemy silently pays a chewer's rate, or nothing at all.
    const rate = CFG.economy[ENEMY_TYPE_KEYS[e.type]] ?? CFG.economy.chewer;
    const mult = this.bonus;
    const salvage = rate.salvage * mult;
    const scrap = rate.scrap * mult;

    this.salvage += salvage;
    this.scrap += scrap;
    this.earned.salvage += salvage;
    this.earned.scrap += scrap;
    if (mult > 1) this.bonusPaid += (salvage + scrap) - (rate.salvage + rate.scrap);
  }

  /** Paid to the shared pot when a wave is resolved, not per kill. */
  #payWaveClear(wave) {
    const cfg = CFG.economy;
    const amount = (cfg.waveClearScrap + cfg.waveClearGrowth * (wave - 1)) * this.bonus;
    this.scrap += amount;
    this.earned.scrap += amount;
  }

  /**
   * Direct payment, used by the run when the crew arrives somewhere.
   *
   * Road payouts land on ARRIVAL rather than on departure, so the money for
   * choosing the hard road is spendable on surviving it.
   */
  grant(salvage, scrap, label = "") {
    this.salvage += salvage;
    this.scrap += scrap;
    this.earned.salvage += salvage;
    this.earned.scrap += scrap;
    // Always assigned, never conditionally. Setting it only when a label was
    // supplied meant an unlabelled grant returned the PREVIOUS grant, which is the
    // kind of stale read that is correct in every current caller and wrong the
    // first time somebody adds one.
    this.lastGrant = { salvage, scrap, label };
    return this.lastGrant;
  }

  /** One free module fit, from the Boneyard road. */
  grantModuleCredit(n = 1) {
    this.moduleCredits += n;
    return this.moduleCredits;
  }

  // ------------------------------------------------------------------ buying

  /** Buying is a between-waves act, never a way to spend out of trouble. */
  get open() {
    const phase = this.director?.phase;
    return phase === PHASE.REST || phase === PHASE.PREP || phase === PHASE.HELD;
  }

  costOf(index) {
    const item = CFG.economy.catalogue[index];
    if (!item) return Infinity;
    // Each stack costs more than the last, so unbounded stacking still has a
    // natural brake without needing an arbitrary cap.
    return Math.round(item.cost * item.growth ** this.stacks[item.id]);
  }

  soldOut(index) {
    const item = CFG.economy.catalogue[index];
    return !!item && this.stacks[item.id] >= item.max;
  }

  canBuy(index) {
    const item = CFG.economy.catalogue[index];
    if (!item) return false;
    if (this.soldOut(index)) return false;
    if (!this.open) return false;
    return this[item.pool] >= this.costOf(index);
  }

  /** Returns the item bought, or null with `blockedReason` set. */
  buy(index) {
    const item = CFG.economy.catalogue[index];
    if (!item) return null;

    if (!this.open) {
      this.blockedReason = "NOT BETWEEN WAVES";
      return null;
    }
    if (this.soldOut(index)) {
      this.blockedReason = `${item.name} AT MAXIMUM`;
      return null;
    }
    const cost = this.costOf(index);
    if (this[item.pool] < cost) {
      this.blockedReason = `NEED ${Math.ceil(cost - this[item.pool])} MORE ${item.pool.toUpperCase()}`;
      return null;
    }

    this[item.pool] -= cost;
    this.stacks[item.id]++;
    this.purchases++;
    this.blockedReason = "";

    this.applyAll();

    // Anything that should pay off the instant it is bought rather than at the
    // next natural opportunity happens here, outside applyAll, because applyAll
    // also runs on reset and healing on reset would be wrong.
    if (item.id === "vitals") {
      this.player.hp = Math.min(this.player.maxHp, this.player.hp + 25);
    }

    this.lastBought = { name: item.name, detail: item.detail, stacks: this.stacks[item.id], cost };
    return this.lastBought;
  }

  // ------------------------------------------------------------------ modules

  moduleCost(index) {
    if (this.moduleCredits > 0) return 0;
    return this.modules?.costOf(index) ?? Infinity;
  }

  canFitModule(index) {
    if (!this.modules) return false;
    if (!this.open) return false;
    if (!this.modules.canFit(index)) return false;
    return this.scrap >= this.moduleCost(index);
  }

  /**
   * Buy and bolt on a module. Returns what was fitted, or null with a reason.
   *
   * Separate from `buy` because it is a different kind of transaction: refits
   * stack on systems that already exist, modules occupy one of three physical
   * hardpoints and are permanent for the run.
   */
  buyModule(index) {
    if (!this.modules) return null;

    if (!this.open) {
      this.blockedReason = "NOT BETWEEN WAVES";
      return null;
    }
    if (!this.modules.canFit(index)) {
      this.blockedReason = this.modules.blockedReason;
      return null;
    }

    const cost = this.moduleCost(index);
    if (this.scrap < cost) {
      this.blockedReason = `NEED ${Math.ceil(cost - this.scrap)} MORE SCRAP`;
      return null;
    }

    const fitted = this.modules.fit(index);
    if (!fitted) {
      this.blockedReason = this.modules.blockedReason;
      return null;
    }

    if (cost === 0) this.moduleCredits--;
    else this.scrap -= cost;

    this.purchases++;
    this.blockedReason = "";
    this.lastBought = {
      name: fitted.name,
      detail: `${fitted.detail} · hardpoint ${fitted.socket + 1}`,
      stacks: fitted.fitted,
      cost,
    };
    return this.lastBought;
  }

  /** What the refit panel needs to draw the list. */
  get entries() {
    return CFG.economy.catalogue.map((item, i) => ({
      key: CFG.economy.keys[i],
      name: item.name,
      detail: item.detail,
      pool: item.pool,
      stacks: this.stacks[item.id],
      max: item.max,
      cost: this.costOf(i),
      soldOut: this.soldOut(i),
      affordable: this.canBuy(i),
    }));
  }

  /** What the refit bay needs, with affordability folded in. */
  get moduleEntries() {
    if (!this.modules) return [];
    return this.modules.entries.map((e, i) => ({
      ...e,
      cost: this.moduleCost(i),
      free: this.moduleCredits > 0,
      affordable: this.canFitModule(i),
    }));
  }

  // ------------------------------------------------------------------ update

  /**
   * @param input omit or pass null to skip key handling. The refit bay borrows the
   *        same number keys, so whichever panel is open owns them -- two consumers
   *        of one key set is a bug waiting for the frame both are visible.
   */
  update(dt, input) {
    this.lastEvent = null;

    // Pay out any waves resolved since the last frame. Polling a counter rather
    // than taking a callback keeps the director unaware the economy exists.
    if (this.director) {
      while (this.#resolvedSeen < this.director.resolved) {
        this.#resolvedSeen++;
        this.#payWaveClear(this.#resolvedSeen);
      }
    }

    if (!input) return;
    const keys = CFG.economy.keys;
    for (let i = 0; i < keys.length; i++) {
      if (!input.pressed(keys[i])) continue;

      const bought = this.buy(i);
      // A refusal has to say WHY. A key that silently does nothing reads as broken
      // rather than as "you cannot afford that yet".
      this.lastEvent = bought
        ? { kind: "bought", ...bought }
        : { kind: "blocked", reason: this.blockedReason };
    }
  }

  /** Key handling for the refit bay, called instead of the refit panel's. */
  handleBayInput(input) {
    this.lastEvent = null;
    const keys = CFG.fortress.keys;
    for (let i = 0; i < keys.length; i++) {
      if (!input.pressed(keys[i])) continue;
      const fitted = this.buyModule(i);
      this.lastEvent = fitted
        ? { kind: "bought", ...fitted }
        : { kind: "blocked", reason: this.blockedReason };
    }
  }
}

/**
 * Decide which of the three things competing for the number keys owns them this
 * frame, and run exactly that one.
 *
 * The refit panel wants 1-6, the refit bay wants 1-6, and a road choice wants 1-2.
 * Two consumers of one key set is a bug waiting for the frame both are visible --
 * you press 2 to take a road and also buy a rifle stack with the same press.
 *
 * This lives here rather than in main.js so it can be tested. It was in the frame
 * loop, where nothing could reach it: the harness cannot import main.js, so the
 * one rule that keeps three UI states from fighting over one key set was the only
 * piece of wiring in the project with no coverage at all.
 *
 * Side effects on the HUD and the world stay with the caller. This returns a
 * descriptor and touches nothing it does not own.
 *
 * @param bayOpen whether the refit bay is up. Priority order is road choice, then
 *        bay, then panel -- a road choice outranks both because the run is blocked
 *        on it.
 */
export function routePurchaseInput({ economy, run, bayOpen, input, dt }) {
  if (run?.choosing) {
    // Income still has to be paid while the crew is deciding; only key handling
    // is handed over.
    economy.update(dt, null);
    for (let i = 0; i < CFG.run.branches; i++) {
      if (!input.pressed(CFG.economy.keys[i])) continue;
      const arrival = run.choose(i);
      if (arrival) return { owner: "route", arrival };
    }
    return { owner: "route", arrival: null };
  }

  if (bayOpen) {
    economy.update(dt, null);
    economy.handleBayInput(input);
    return { owner: "bay", arrival: null };
  }

  economy.update(dt, input);
  return { owner: "refit", arrival: null };
}
