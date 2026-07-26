import { CFG, ENEMY_TYPE_KEYS } from "./config.js";
import { makeRandom } from "./util.js";
import { ITEM_EFFECTS } from "./items.js";
import { PHASE } from "./waves.js";
import { isSubmerged } from "./enemies.js";

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

// What each purchase does now lives in src/items.js, next to the runtime for the
// conditional and proc items that cannot be expressed as a function of stack count
// alone. One home for "what an upgrade does", rather than the static half here and
// the interesting half somewhere else.

export class Economy {
  // How many resolved waves have already been paid for. Polled against the
  // director rather than driven by a callback, so the director stays unaware that
  // an economy exists at all.
  #resolvedSeen = 0;

  constructor({
    player, trampler, weapon, repair, horde, director, modules = null, events = null,
  }) {
    this.player = player;
    this.trampler = trampler;
    this.weapon = weapon;
    this.repair = repair;
    this.horde = horde;
    this.director = director;
    this.modules = modules;
    this.events = events;

    // Every kill routes through Horde's kill choke point, whatever fired the shot
    // -- rifle, either deck gun, a shock emitter, or a foot coming down. Hooking it
    // in one place means no income source can be forgotten when a new weapon is
    // added.
    //
    // Subscribed rather than owning the callback outright, because items need the
    // same moment and two mechanisms for one event is how they drift apart.
    // Listeners are never removed on reset: the economy has to keep earning across
    // a restart, and a reset that unhooked it would stop all income silently.
    events?.onKill((e) => this.#onKill(e));

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

    // Written by the SCAVENGER RIG, and reset here with everything else. Kept on
    // the economy rather than passed around because this is the only place income
    // is calculated.
    this.salvageScale = 1;
    this.weapon.armourPierce = 0;

    // Re-seeded on reset for the same reason the horde and the director are: two
    // attempts at the same run have to be offered the same shop, or the seeds buy
    // nothing.
    this.random = makeRandom(CFG.economy.seed);
    this.rollOffers();

    // The free pick offered for holding a siege. Empty means nothing is pending, and
    // the run reads exactly that to know when the pick has been resolved.
    this.pendingPick = [];

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
      // Only the STATIC half is applied from stack counts. Conditional and proc
      // items have no entry here on purpose: they are rebuilt every frame by the
      // items runtime from the world's current state, because "while beneath the
      // hull" is not a function of how many you own.
      ITEM_EFFECTS[item.id]?.(this, this.stacks[item.id] ?? 0);
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
    // salvageScale is the SCAVENGER RIG, and it deliberately touches the personal
    // purse only. Scaling the shared pot from a personal item would let one player
    // inflate the crew's budget, which is the exact coupling the split exists to
    // prevent.
    const salvage = rate.salvage * mult * this.salvageScale;
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

  /**
   * Buying is a between-waves act, never a way to spend out of trouble — and
   * "between waves" has to mean a moment the crew can actually READ a shop in.
   *
   * This was three phases wide and a playtester described the result exactly: "in the
   * middle of the wave I am fighting, so I just spam buy items out of panic." They
   * were right, and the numbers are worse than the complaint. The old window was the
   * 10 s rest, which permits up to `holdUntilCleared` — EIGHT — enemies still alive,
   * plus the 12 s preparation window, which exists to announce an incoming wave with a
   * named bearing. So you could be told a wave was inbound, be fighting eight things,
   * and be shown a six-item shop, all at once, on a countdown.
   *
   * Two things are wrong with that and they are the same thing said twice:
   *
   * PREP is not spare time. Invariant 19b says what it is for — the window that makes
   * deploying an emitter a decision and gives the guns a reason to be manned at a
   * specific moment. A shop competing for it does not add an option, it takes the
   * preparation away.
   *
   * And a rest with eight hostiles in it is not a rest. `director.calm` is the
   * PACING threshold and is deliberately generous, because reinforcements should not
   * wait for a spotless field. Safety is a different question, and it is asked here
   * about the OPERATIVE rather than about the fortress: is anything close enough to
   * you, right now, that reading a shop is a bad idea.
   *
   * That second clause was originally "nothing beneath the hull and nothing on the
   * deck", and it was wrong in a way worth recording, because it sounded better than
   * it measured. Two things:
   *
   *   It cost a competent player exactly ZERO seconds and a struggling one up to a
   *   third of their window. The player who most needs to buy something was the only
   *   one it locked out, which is precisely backwards.
   *
   *   And the amount varied unpredictably between runs — two measured passes over the
   *   same seeds gave 64% and 97% of the rest available — because it depended on which
   *   enemies happened to be where. "Something is under the hull somewhere on a 26 m
   *   chassis" is not a state a player can see or fix in a second, so a refusal read
   *   as arbitrary. A playtester reported exactly that: they could not use the shop and
   *   could not tell why.
   *
   * `threatRange` is the same 6 m the contested-repair rule already owns, and reusing
   * it is deliberate: the two rules are asking the same question — is the operative
   * under enough pressure that this job should not be going well — so they should not
   * drift apart. The point of the change is that this is a rule you satisfy by MOVING.
   * Step back and the shop opens; the old one only opened when the fight was finished.
   *
   * The window that remains is a rest or a hold with nothing on top of you, and HELD
   * has no timer at all — so the unhurried moment to spend a siege's earnings is right
   * after holding one. That is where the money came from.
   *
   * Measured: about 52 s of shopping per five-wave siege, in windows of roughly 12 s.
   */
  get open() {
    const phase = this.director?.phase;
    if (phase !== PHASE.REST && phase !== PHASE.HELD) return false;
    return !this.#crowded();
  }

  /** Is anything close enough to the operative to make reading a menu a bad idea? */
  #crowded() {
    const pool = this.horde?.pool;
    if (!pool || !this.player) return false;
    const reach = CFG.repair.threatRange;
    const reach2 = reach * reach;
    const p = this.player.position;
    for (const e of pool) {
      // Burrowed things are underground and cannot touch you, so they must not hold the
      // shop shut either — the same exclusion the pacing pressure count makes, and for
      // the same reason: there is nothing the crew can act on yet.
      if (!e.alive || isSubmerged(e)) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const dz = e.z - p.z;
      if (dx * dx + dy * dy + dz * dz < reach2) return true;
    }
    return false;
  }

  /**
   * Price and escalation for an item, from its rarity tier.
   *
   * An explicit `cost` on the item wins. That is not a loophole, it is how the two
   * bounded scrap refits stay out of the rarity system: they are a capped, always
   * available track with prices set against each other, not draws from a pool.
   */
  #priceOf(item) {
    if (item.cost !== undefined) return item;
    return CFG.economy.rarity[item.rarity] ?? CFG.economy.rarity.common;
  }

  /**
   * Pick one catalogue index out of `pool`, tier first then item.
   *
   * Two stages rather than one weighted pass over every item, because the tiers hold
   * different numbers of items and a per-item weight therefore cannot express "one
   * offer in five should be rare". Measured with per-item weights of 6:3:1 the rares
   * came out at 8% of offers -- roughly one across a whole run, for the items the
   * pool exists to deliver. Choosing the tier first makes `weight` mean share.
   *
   * Mutates `pool`, returning the index it removed, or -1 if there was nothing left.
   */
  #drawFrom(pool) {
    if (pool.length === 0) return -1;
    const cat = CFG.economy.catalogue;
    const tiers = CFG.economy.rarity;

    // Only tiers that still have something in the pool can be chosen, so a tier
    // running dry hands its share to the others rather than wasting a key slot.
    const live = [];
    let total = 0;
    for (const name of Object.keys(tiers)) {
      if (!pool.some((i) => cat[i].rarity === name)) continue;
      live.push(name);
      total += tiers[name].weight;
    }
    if (live.length === 0) return pool.splice(0, 1)[0];

    let roll = this.random() * total;
    let chosen = live[live.length - 1]; // fallback covers float drift on the last step
    for (const name of live) {
      roll -= tiers[name].weight;
      if (roll <= 0) {
        chosen = name;
        break;
      }
    }

    // Uniform within the tier: rarity is the axis that is meant to matter, and a
    // second weighting inside it would be a balance lever nobody could reason about.
    const candidates = [];
    for (let i = 0; i < pool.length; i++) {
      if (cat[pool[i]].rarity === chosen) candidates.push(i);
    }
    const at = candidates[(this.random() * candidates.length) | 0];
    return pool.splice(at, 1)[0];
  }

  costOf(index) {
    const item = CFG.economy.catalogue[index];
    if (!item) return Infinity;
    // Each stack costs more than the last, so unbounded stacking still has a
    // natural brake without needing an arbitrary cap.
    const p = this.#priceOf(item);
    return Math.round(p.cost * p.growth ** this.stacks[item.id]);
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

    const beforeMaxHp = this.player.maxHp;
    this.applyAll();
    this.#onAcquired(beforeMaxHp);

    this.lastBought = { name: item.name, detail: item.detail, stacks: this.stacks[item.id], cost };
    return this.lastBought;
  }

  /**
   * Effects that have to pay off the instant an item is acquired, rather than at the
   * next natural opportunity.
   *
   * Deliberately NOT inside `applyAll`, for the reason applyAll exists: it also runs
   * on reset, and healing on a reset would be wrong.
   *
   * It lives in one method because there are now TWO acquisition paths -- buying and
   * taking a free pick -- and the pick skipped this for a while, so VITALS raised
   * your ceiling and left your health where it was while the panel and the toast
   * both said "healed". A defect nothing failed on, because neither the pick tests
   * nor the shop tests read health.
   *
   * Written as the max-health DELTA rather than as an `id === "vitals"` branch, so
   * it needs no per-item knowledge and cannot drift from the effect that produced
   * it. Any future item that raises the ceiling arrives filled, the same way the
   * reactor casing module already does.
   */
  #onAcquired(beforeMaxHp) {
    const gained = this.player.maxHp - beforeMaxHp;
    if (gained > 0) this.player.hp = Math.min(this.player.maxHp, this.player.hp + gained);
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
    return this.offers.map((catIndex, keyIndex) => {
      const item = CFG.economy.catalogue[catIndex];
      return {
        key: CFG.economy.keys[keyIndex],
        index: catIndex,
        name: item.name,
        detail: item.detail,
        pool: item.pool,
        stacks: this.stacks[item.id],
        max: item.max,
        cost: this.costOf(catIndex),
        soldOut: this.soldOut(catIndex),
        affordable: this.canBuy(catIndex),
      };
    });
  }

  /**
   * Everything the crew is actually carrying, for the build readout.
   *
   * Needed separately from `entries` because the shop deliberately shows a SUBSET:
   * four of sixteen personal items per landmark. Anything taken from a salvage pick,
   * or bought two landmarks ago and since rotated out of the stock, would otherwise
   * be invisible for the rest of the run -- and a build nobody can read is a build
   * nobody plays around. That matters more here than it did with four numeric
   * refits, because half the pool now only pays under a condition.
   *
   * Catalogue order rather than purchase order, so the list does not reshuffle
   * itself between two glances at it.
   */
  get carried() {
    const out = [];
    for (const item of CFG.economy.catalogue) {
      const stacks = this.stacks[item.id] ?? 0;
      if (stacks > 0) {
        out.push({
          id: item.id,
          name: item.name,
          rarity: item.rarity,
          pool: item.pool,
          stacks,
        });
      }
    }
    return out;
  }

  /**
   * Re-roll what the shop is currently selling.
   *
   * The catalogue outgrew the keyboard, and that is the point rather than a problem
   * to work around: eighteen items and six number keys means the shop has to show a
   * SUBSET, and a subset that changes is what makes two runs build differently.
   * Before this, every run bought the same four multipliers in the same order and
   * the only thing that varied across a whole playthrough was which road you took.
   *
   * The two scrap refits are always offered. That asymmetry is deliberate and it is
   * the same principle the modules follow: the bounded fortress track is dependable,
   * so you can plan around it, and the unbounded personal track is what varies.
   *
   * Seeded from its own stream, so a run replays identically -- and rolled from the
   * FULL catalogue every time rather than by mutating a pool, so the offer list can
   * never drift into a state that depends on how many times it has been rolled.
   */
  rollOffers() {
    const cat = CFG.economy.catalogue;
    const always = [];
    const pool = [];
    for (let i = 0; i < cat.length; i++) {
      if (cat[i].pool === "scrap") always.push(i);
      else pool.push(i);
    }

    const room = Math.max(0, CFG.economy.keys.length - always.length);
    const picked = [];
    // Weighted draw without replacement.
    //
    // Weighted, so a shop of four slots usually shows mostly floor with something
    // interesting in it. A uniform draw over eighteen items offered exotics as often
    // as a damage stack, which sounds generous and is not: the expensive items would
    // fill the list, most of them unaffordable, and the plain reliable option a
    // struggling run actually needs would frequently not be for sale at all.
    //
    // Without replacement, because the same item on two keys wastes a slot and reads
    // as a bug rather than as luck.
    for (let i = 0; i < room && pool.length > 0; i++) {
      const drawn = this.#drawFrom(pool);
      if (drawn < 0) break;
      picked.push(drawn);
    }

    this.offers = [...picked, ...always];
    return this.offers;
  }

  /**
   * Draw the free pick offered for holding a siege.
   *
   * Free, and that is the point rather than generosity: being handed something is a
   * different beat from buying it, and it is the only acquisition in the game that
   * does not compete with the fortress for money. It also widens exposure to the
   * pool -- four shop slots a landmark shows a run sixteen offers across a whole
   * biome, and three more draws here lifts that by three quarters.
   *
   * Salvage items only. A free hull plate would be the crew's bounded track handed
   * out for nothing, and that track is meant to be paid for together.
   */
  offerPick() {
    const cat = CFG.economy.catalogue;
    const pool = [];
    for (let i = 0; i < cat.length; i++) {
      if (cat[i].pool === "salvage") pool.push(i);
    }

    this.pendingPick = [];
    for (let i = 0; i < CFG.economy.pickCount && pool.length > 0; i++) {
      const drawn = this.#drawFrom(pool);
      if (drawn < 0) break;
      this.pendingPick.push(drawn);
    }
    return this.pendingPick;
  }

  /**
   * What the pick panel needs to draw itself.
   *
   * `index` is a CATALOGUE index, like everywhere else that publishes one. Note that
   * `takePick` below is the one method whose argument is a SLOT instead, which is why
   * its parameter is named `slot` rather than `index`.
   */
  get pickEntries() {
    return this.pendingPick.map((catIndex) => {
      const item = CFG.economy.catalogue[catIndex];
      return {
        index: catIndex,
        name: item.name,
        detail: item.detail,
        rarity: item.rarity,
        stacks: this.stacks[item.id],
      };
    });
  }

  /**
   * Is there a pick to take, AND is this a moment to read three items in?
   *
   * The pick panel used to appear the instant a pick was earned, which is the instant
   * a wave resolves — so a three-item menu 680 px wide arrived while the player was
   * often still fighting the remains of a wave, on the same screen anchor as the
   * health bars. The complaint about the shop was "I just spam buy items out of panic",
   * and the pick had the identical problem with none of the shop's protection.
   *
   * So it waits for the same window the shop does, and deliberately the SAME getter
   * rather than a second rule that means roughly the same thing: two nearly-identical
   * safety conditions drift, and then the shop and the pick disagree about whether
   * this moment is safe, which is unexplainable to a player.
   *
   * PAUSING was the alternative and it is rejected. Co-op is the primary experience
   * and you cannot stop a horde game for one player's menu — Risk of Rain 2 and Deep
   * Rock Galactic both decline to, for the same reason. Waiting costs the player
   * nothing: the offer is never withdrawn, and invariant 22f already guarantees it
   * cannot be stranded at the end of a biome.
   */
  get pickOpen() {
    return this.pendingPick.length > 0 && this.open;
  }

  /**
   * Take one of the offered picks. Clears the rest: this is a choice, not a
   * shopping list, and the whole value of it is what you give up.
   *
   * @param slot which of the three on offer, NOT a catalogue index. Named to say so,
   *        because it is the only method here that takes a position.
   */
  takePick(slot) {
    // The refusal lives here and not only in the router, because this is a public
    // method and the router is not the only thing that could reach it. A rule enforced
    // solely at the call site is a rule the next caller does not have.
    if (!this.pickOpen) return null;
    const catIndex = this.pendingPick[slot];
    if (catIndex === undefined) return null;
    const item = CFG.economy.catalogue[catIndex];

    this.stacks[item.id]++;
    this.purchases++;
    const beforeMaxHp = this.player.maxHp;
    this.applyAll();
    this.#onAcquired(beforeMaxHp);
    this.pendingPick = [];

    this.lastBought = {
      name: item.name,
      detail: `${item.detail} · salvaged`,
      stacks: this.stacks[item.id],
      cost: 0,
    };
    return this.lastBought;
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

      // Key position maps through the offer list to a CATALOGUE index. Purchases
      // stay addressed by catalogue index everywhere else, so nothing that looks an
      // item up has to care what the shop happens to be selling this landmark.
      const catIndex = this.offers[i];
      if (catIndex === undefined) continue;
      const bought = this.buy(catIndex);
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
 * Decide which of the four things competing for the number keys owns them this
 * frame, and run exactly that one.
 *
 * The refit panel wants 1-6, the refit bay wants 1-6, a road choice wants 1-2, and
 * a pending salvage pick wants 1-3. Two consumers of one key set is a bug waiting
 * for the frame both are visible -- you press 2 to take a road and also buy a rifle
 * stack with the same press.
 *
 * This lives here rather than in main.js so it can be tested. It was in the frame
 * loop, where nothing could reach it: the harness cannot import main.js, so the
 * one rule that keeps these UI states from fighting over one key set was the only
 * piece of wiring in the project with no coverage at all.
 *
 * Side effects on the HUD and the world stay with the caller. This returns a
 * descriptor and touches nothing it does not own.
 *
 * PRECEDENCE, most urgent first: salvage pick, road choice, refit bay, refit panel.
 * The ordering is by how stuck the crew is without it. A pick blocks the road behind
 * it; a road blocks the whole run; the bay and the panel are both things you can
 * simply walk away from.
 *
 * The pick and the road CAN now be live together, which they could not when a pick
 * only came from holding a siege: an untaken mid-siege pick is still pending when the
 * last wave falls, and the run then wants a road. So that pair is ordered because it
 * happens, not merely for safety, and the panels follow the same order — the route
 * panel steps aside for the pick, since they share a screen anchor.
 *
 * @param bayOpen whether the refit bay is up.
 */
export function routePurchaseInput({ economy, run, bayOpen, input, dt }) {
  // Highest precedence, because it is the only one of these states the crew cannot
  // leave by doing something else: the shop can be ignored and the bay can be shut,
  // but a pending pick blocks the road choice behind it until it is taken.
  //
  // Keyed off the pick list itself rather than off `run.picking`. A pick is now also
  // handed out part-way through a siege, where the run's phase is still SIEGE, and a
  // phase check would have left those picks with no owner for the keys at all — the
  // panel up, the prompt saying TAKE ONE, and nothing happening. The honest question
  // is "is there something to take", and that is what this asks.
  //
  // Gated on `pickOpen` rather than on the list alone, so a pick that is EARNED under
  // fire does not seize the number keys before it is takeable. If it did, the keys
  // would be dead for as long as the pick waited: owned by the pick, refused by
  // `takePick`, and unavailable to the shop or the bay.
  if (economy.pickOpen) {
    economy.update(dt, null);
    for (let i = 0; i < economy.pendingPick.length; i++) {
      if (!input.pressed(CFG.economy.keys[i])) continue;
      const took = economy.takePick(i);
      if (took) return { owner: "pick", took };
    }
    return { owner: "pick", took: null };
  }

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
