import { CFG } from "./config.js";
import { makeRandom } from "./util.js";

// The run: legs of a journey, a siege at each landmark, a boss at the end.
//
// Until this existed a siege WAS the game. That gave the prototype a finish line
// but no arc, which quietly broke the economy: you buy a rifle stack, hold five
// waves, and then nothing happens. Upgrades only mean something if there is a
// later fight to spend them in, and a boss only means something if you arrive at
// it carrying whatever you chose to build.
//
// Structure. Four phases, and that is the whole machine:
//
//   SIEGE    -> the director runs a siege at the landmark.
//   PICKING  -> the siege is HELD; a free pick of three items is offered.
//   CHOOSING -> the pick is taken; two roads are offered and the crew picks one.
//   DONE     -> the biome is cleared.
//
// PICKING and CHOOSING are SEQUENTIAL, never simultaneous. Two menus on one screen
// at the same moment is unreadable, and the number keys already had three contenders
// before the pick existed, which is why test 86 exists at all.
//
// There is deliberately NO travel phase, and this list used to claim one. The
// choice IS the travel: there is no walking minigame, because the interesting part
// of "which way do we go" is the trade, not the walking. The window a travel phase
// would have provided already exists as the director's own rest phase, which is
// when buying is open anyway -- so a fourth state would have duplicated it while
// looking, to anyone reading the header, like a feature that had been built.
//
// It was in fact declared, documented here, and never assigned or read by anything.
// Removed rather than wired: a state machine that describes more states than it has
// is worse than a small one, because the next person to touch it plans around a
// phase that does not exist. The inverse is just as bad and this header briefly had
// it — PICKING was added to the enum while the list above still said three.
//
// One deliberate constraint: nothing here advances on a timer. A finished siege
// sits in HELD until a human presses a key. Partly design -- finishing something
// should be a thing you get to sit in rather than something the game clears for
// you -- and partly so a headless test of "does a siege end" cannot be
// invalidated by the run structure quietly starting the next one.

/**
 * What a road costs and what it pays, as text.
 *
 * Exported and shared because two places need it and they must not drift: the route
 * panel, which describes a road you have not taken yet, and the arrival banner, which
 * has to say what the road you just took actually DID.
 *
 * The banner used to name only the payout — "+20 salvage, +60 scrap" — and say nothing
 * about the cost, which is half of why a playtester asked "when I press one, does it
 * matter? it seems like it just went next." It did matter. Nothing told them.
 */
export function describeRoad(road) {
  const costs = [];
  if (road.threat > 1) costs.push(`+${Math.round((road.threat - 1) * 100)}% enemy health`);
  if (road.count > 0) costs.push(`+${road.count} per wave`);
  if (road.speed > 1) costs.push(`+${Math.round((road.speed - 1) * 100)}% enemy speed`);
  if (road.fog < 1) costs.push("visibility falls");
  if (costs.length === 0) costs.push("no added risk");

  const pays = [];
  if (road.salvage) pays.push(`${road.salvage} salvage`);
  if (road.scrap) pays.push(`${road.scrap} scrap`);
  if (road.module) pays.push("a free module");

  return { costs, pays };
}

export const RUN = {
  SIEGE: "siege",
  // Holding a siege pays a free item BEFORE the road choice, not alongside it.
  // Sequential rather than simultaneous for two reasons: two menus on one screen at
  // the same moment is unreadable, and the number keys already have three
  // contenders (refit panel, refit bay, road) which is why test 86 exists at all. A
  // fourth simultaneous owner is exactly the bug that test was written to catch.
  PICKING: "picking",
  CHOOSING: "choosing",
  DONE: "done",
};

export class Run {
  /** @param economy pays arrival bonuses and owns the salvage pick offered on a hold. */
  constructor(director, horde, economy = null, seed = CFG.run.seed) {
    this.director = director;
    this.horde = horde;
    this.economy = economy;
    this.seed = seed;
    this.reset();
  }

  reset() {
    // Re-seeded on reset for the same reason the horde and the director are: the
    // point of the seeds is that two attempts at the same run are comparable, and
    // a stream that carried across a restart would hand the player a different
    // set of roads from the same seed.
    this.random = makeRandom(this.seed);

    this.leg = 1;
    this.phase = RUN.SIEGE;
    this.road = null;          // the road taken to get here
    this.offers = [];
    this.history = [];
    this.lastArrival = null;   // payout banner for the frame we arrived

    // Instance modifiers, never CFG edits. `threatScale` multiplies enemy health,
    // `extraCount` adds to every wave, and the horde's own speedScale is written
    // directly because that is where the horde reads it from.
    this.threatScale = 1;
    this.extraCount = 0;
    this.fogScale = 1;
    this.horde.speedScale = 1;

    // How many resolved waves have already been paid a pick. Polled against the
    // director rather than driven by a callback, the same way the economy watches
    // the same counter -- the director stays unaware that either exists.
    this.seenResolved = this.director?.resolved ?? 0;

    this.#configureSiege();
  }

  // ------------------------------------------------------------------ queries

  get isBossLeg() {
    return this.leg >= CFG.run.legs;
  }

  get legLabel() {
    return this.isBossLeg ? "FINAL LANDMARK" : `LANDMARK ${this.leg} OF ${CFG.run.legs}`;
  }

  get choosing() {
    return this.phase === RUN.CHOOSING;
  }

  get done() {
    return this.phase === RUN.DONE;
  }

  /** How long the siege at this landmark is. The boss leg is deliberately short. */
  get siegeLength() {
    return this.isBossLeg ? CFG.run.bossSiegeLength : CFG.waves.siegeLength;
  }

  /**
   * Is the wave now being released the boss wave?
   *
   * The titan arrives on the last wave of the last landmark. Read by the director
   * when it builds a wave, so the boss is part of the pacing rather than a
   * separate spawner that could fire during a rest phase.
   */
  isBossWave(wave) {
    return this.isBossLeg && wave >= this.siegeLength;
  }

  // ------------------------------------------------------------------ progress

  #configureSiege() {
    this.director.siegeLength = this.siegeLength;
    this.director.run = this;
  }

  /**
   * Called every frame. It pays the wave cadence's picks and watches for a siege
   * being held, at which point it offers roads -- it never advances anything itself.
   */
  update() {
    this.#payWavePick();

    if (this.phase === RUN.SIEGE && this.director.held) {
      if (this.isBossLeg) {
        // The boss leg pays no pick FOR HOLDING IT: the run is over at that moment,
        // and an item you can never spend is a menu rather than a reward.
        //
        // Anything still in hand goes with it, for the same reason. The wave cadence
        // does pay during the boss siege -- fighting the titan is exactly when one
        // more piece of build is worth having, and there is a wave left to spend it
        // on -- but an offer left untaken when the biome ends would sit on screen
        // asking for a keypress that can no longer matter.
        this.phase = RUN.DONE;
        if (this.economy) this.economy.pendingPick = [];
      } else {
        // Seeing off a siege earns a pick. This is the reward beat the shop cannot
        // provide -- buying something is not the same feeling as being handed it --
        // and it widens how much of the pool a run actually sees, since four shop
        // slots a landmark only ever exposes a fraction of it.
        //
        // Not offered over the top of one already in hand. Invariant 22f says an offer
        // must never be overwritten, because an item you were looking at vanishing
        // reads as a bug rather than as luck -- and the cadence's own payer already
        // honours that. This branch did not, and the gap only mattered once the pick
        // started WAITING for a safe window: before that a mid-siege offer was almost
        // always resolved within a frame or two of being earned, so the hold rarely
        // found one still open. The window made the rare case ordinary.
        this.phase = RUN.PICKING;
        if (!this.economy?.pendingPick?.length) this.economy?.offerPick();
      }
    }

    // The pick resolves into the road choice. Held here rather than inside
    // `takePick` so the run owns its own phase order, and so a pick that somehow
    // fails to resolve cannot strand the run in a state with no way out.
    if (this.phase === RUN.PICKING && !this.economy?.pendingPick?.length) {
      this.phase = RUN.CHOOSING;
      this.#offerRoads();
    }
  }

  get picking() {
    return this.phase === RUN.PICKING;
  }

  /**
   * Everything the roads have done to this run so far, as text, or an empty list.
   *
   * The modifiers were invisible. They are instance state on this object, they compound
   * across the whole biome, and the only place any of it surfaced was a single combined
   * number in the diagnostics panel — which is hidden by default and merges the road
   * effect with the elapsed-time ramp, so even there you could not tell them apart.
   *
   * A cost you cannot perceive is not a cost, and a decision whose consequences are
   * never shown is not a decision. This is read at the moment the next road is offered,
   * which is the moment the question gets asked.
   */
  get modifiers() {
    const out = [];
    if (this.threatScale > 1.0001) {
      out.push(`+${Math.round((this.threatScale - 1) * 100)}% enemy health`);
    }
    if (this.extraCount > 0) out.push(`+${this.extraCount} enemies per wave`);
    if (this.horde.speedScale > 1.0001) {
      out.push(`+${Math.round((this.horde.speedScale - 1) * 100)}% enemy speed`);
    }
    if (this.fogScale < 0.9999) {
      out.push(`visibility ${Math.round(this.fogScale * 100)}%`);
    }
    return out;
  }

  /** The roads taken so far, in order, by name. */
  get roadsTaken() {
    return this.history.map((id) => CFG.run.routes.find((r) => r.id === id)?.name ?? id);
  }

  /**
   * A free pick every few waves the crew sees off, not only at the end of a siege.
   *
   * The end-of-siege pick is a beat: you held the line, here is something, now
   * choose a road. It is also, on its own, unreachable — a playtest averaged wave
   * four of five, so the reward existed and the player had met it once. This is the
   * same reward on a cadence they can actually reach.
   *
   * Three things about how it is written:
   *
   * It watches the director's own resolved counter rather than taking a callback, so
   * a wave BURIED by pressing Q never pays one. That is not an edge case, it is part
   * of what calling a wave early costs, and it falls out for free by polling the
   * counter the economy already trusts for exactly the same reason.
   *
   * It uses the wave number WITHIN the siege, so the cadence is the same at every
   * landmark. The resolved counter accumulates across the whole run, and keying off
   * that would drift the rhythm — a pick after wave 3 at one landmark and after wave
   * 2 at the next, for no reason a player could ever infer.
   *
   * And it never offers on top of a pick already pending. Overwriting one would make
   * an offered item vanish and be replaced, which reads as a bug; the previous pick
   * simply stands until it is taken.
   */
  #payWavePick() {
    const d = this.director;
    if (!d || !this.economy) return;
    if (d.resolved === this.seenResolved) return;
    this.seenResolved = d.resolved;

    const every = CFG.run.pickEveryWaves;
    if (every <= 0) return;
    // The final wave of a siege is the hold's own business, and it pays a pick of
    // its own a moment later. Two offers a frame apart would replace the first.
    if (d.wave >= d.siegeLength) return;
    if (d.wave % every !== 0) return;
    if (this.economy.pendingPick.length > 0) return;

    this.economy.offerPick();
  }

  #offerRoads() {
    const pool = CFG.run.routes.slice();
    this.offers = [];

    for (let i = 0; i < CFG.run.branches && pool.length > 0; i++) {
      const pick = (this.random() * pool.length) | 0;
      this.offers.push(pool.splice(pick, 1)[0]);
    }

    // The last landmark before the boss always offers the quiet road as one of
    // its two. Arriving at a boss with a wrecked fortress and no money is a lost
    // run decided several minutes earlier, which reads as unfair rather than as
    // hard -- so there is always a way to arrive intact, and taking it always
    // costs you the payout that would have made the boss easier.
    const quiet = CFG.run.routes.find((r) => r.id === "foundry");
    if (this.leg === CFG.run.legs - 1 && quiet && !this.offers.includes(quiet)) {
      this.offers[this.offers.length - 1] = quiet;
    }
  }

  /**
   * Take one of the offered roads. Advances the leg, applies the modifiers, pays
   * the arrival bonus, and restarts the director for the next siege.
   *
   * Payouts land on ARRIVAL, before the fight, on purpose: you are paid for
   * choosing the hard road while you can still spend it on surviving the hard
   * road. Paying afterwards would make the gamble a punishment with a consolation
   * prize attached.
   */
  choose(index) {
    if (this.phase !== RUN.CHOOSING) return null;
    const road = this.offers[index];
    if (!road) return null;

    this.leg++;
    this.road = road;
    this.history.push(road.id);
    this.phase = RUN.SIEGE;
    this.offers = [];

    // Modifiers are cumulative across a run: a road's hardship stays with you for
    // the rest of the biome. That is what makes an early greedy choice a real
    // commitment rather than a single bad wave.
    this.threatScale *= road.threat;
    this.extraCount += road.count;
    this.fogScale *= road.fog;
    this.horde.speedScale *= road.speed;

    if (this.economy) {
      this.economy.grant(road.salvage, road.scrap, `ARRIVED: ${road.name}`);
      if (road.module) this.economy.grantModuleCredit();
      // A new landmark restocks the shop. This is the other half of what makes a
      // build vary: the pool is larger than the keyboard, so what is on sale changes
      // as you travel, and a plan made at the first landmark cannot simply be
      // repeated at the third.
      this.economy.rollOffers();
    }

    this.lastArrival = {
      name: road.name,
      detail: road.detail,
      // The road itself, so a caller can describe what it COST as well as what it paid.
      // The flattened payout fields below are kept because existing readers use them,
      // but anything new should go through `describeRoad(arrival.road)` rather than
      // growing this object a field at a time until it is a copy of the road.
      road,
      salvage: road.salvage,
      scrap: road.scrap,
      module: !!road.module,
      leg: this.leg,
      boss: this.isBossLeg,
    };

    // Fresh siege at the new landmark. resetSiege keeps the elapsed clock running,
    // because difficulty scaling with elapsed time is the anti-stall valve and
    // rewinding it at every landmark would let a slow crew farm the whole biome.
    this.director.resetSiege();
    this.#configureSiege();

    return this.lastArrival;
  }
}
