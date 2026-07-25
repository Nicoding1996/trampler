import { CFG } from "./config.js";
import { CHEWER } from "./enemies.js";
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
//   and buys bounded fortress upgrades. Funding it from the shared objective means
//   nobody can farm the crew's budget on their own.
//
// One pooled pot would generate a co-op argument every wave and is painful to
// unpick later, since every price and payout has to be re-derived.
//
// Effects are applied as multipliers on the OWNING INSTANCE -- weapon.damageScale,
// trampler.damageScale, repair.rateScale -- never by mutating CFG. A debug knob
// that wrote to CFG very nearly poisoned every test that ran after it, and a run's
// upgrades leaking into global config would do the same thing permanently.

/**
 * What each purchase actually does. Kept here rather than in config.js because
 * config holds tunable DATA; this is behaviour, and closures in a config file
 * cannot be read at a glance next to the number they modify.
 */
const EFFECTS = {
  rifle: (ctx) => { ctx.weapon.damageScale += 0.25; },
  vitals: (ctx) => {
    ctx.player.maxHp += 25;
    // Healed by the same amount, so it is useful the moment you buy it rather
    // than only after the next regen cycle.
    ctx.player.hp = Math.min(ctx.player.maxHp, ctx.player.hp + 25);
  },
  // Multiplicative, so stacking has diminishing returns and four stacks is 52%
  // damage taken rather than 40%: plating must never trivialise the under-hull
  // fight, because that fight is why anyone dismounts.
  plating: (ctx) => { ctx.trampler.damageScale *= 0.85; },
  rig: (ctx) => { ctx.repair.rateScale += 0.30; },
};

export class Economy {
  // How many resolved waves have already been paid for. Polled against the
  // director rather than driven by a callback, so the director stays unaware that
  // an economy exists at all.
  #resolvedSeen = 0;

  constructor({ player, trampler, weapon, repair, horde, director }) {
    this.player = player;
    this.trampler = trampler;
    this.weapon = weapon;
    this.repair = repair;
    this.horde = horde;
    this.director = director;

    // Every kill routes through Horde.damage, whatever fired the shot -- rifle,
    // either deck gun, or a shock emitter. Hooking it in one place means no income
    // source can be forgotten when a new weapon is added.
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

    // What happened this frame, for the on-screen banner. Cleared every update, so
    // reading it is always about the current frame and never a stale message.
    this.lastEvent = null;
    this.bonusPaid = 0; // how much the early-call gamble has actually returned

    // Restoring the baseline matters as much as applying the upgrades. A restart
    // that left the previous run's stats in place would silently make every
    // subsequent attempt easier, and the seeded fight exists precisely so two
    // attempts are comparable.
    this.weapon.damageScale = 1;
    this.trampler.damageScale = 1;
    this.repair.rateScale = 1;
    this.player.maxHp = CFG.combat.playerHp;
    this.player.hp = Math.min(this.player.hp, this.player.maxHp);

    this.#resolvedSeen = this.director ? this.director.resolved : 0;
  }

  // ------------------------------------------------------------------- income

  /** Multiplier on everything this wave pays, from having called it early. */
  get bonus() {
    return this.director?.calledEarly ? 1 + CFG.economy.earlyCallBonus : 1;
  }

  #onKill(e) {
    const rate = e.type === CHEWER ? CFG.economy.chewer : CFG.economy.climber;
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

    EFFECTS[item.id]({
      player: this.player,
      trampler: this.trampler,
      weapon: this.weapon,
      repair: this.repair,
    });

    this.lastBought = { name: item.name, detail: item.detail, stacks: this.stacks[item.id], cost };
    return this.lastBought;
  }

  /** What the HUD needs to draw the list. */
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

  // ------------------------------------------------------------------ update

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
}
