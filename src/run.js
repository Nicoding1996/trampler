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
// Structure:
//
//   TRAVEL   -> a road has been chosen, the fortress is walking. Buying is open.
//   SIEGE    -> the director runs a normal siege at the landmark.
//   CHOOSING -> the siege is HELD; two roads are offered and the crew picks one.
//   DONE     -> the biome is cleared.
//
// The choice IS the travel. There is no walking minigame, because the interesting
// part of "which way do we go" is the trade, not the walking.
//
// One deliberate constraint: nothing here advances on a timer. A finished siege
// sits in HELD until a human presses a key. Partly design -- finishing something
// should be a thing you get to sit in rather than something the game clears for
// you -- and partly so a headless test of "does a siege end" cannot be
// invalidated by the run structure quietly starting the next one.

export const RUN = {
  TRAVEL: "travel",
  SIEGE: "siege",
  CHOOSING: "choosing",
  DONE: "done",
};

export class Run {
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
   * Called every frame. The only thing it watches for is a siege being held, at
   * which point it offers roads -- it never advances anything by itself.
   */
  update() {
    if (this.phase === RUN.SIEGE && this.director.held) {
      if (this.isBossLeg) {
        this.phase = RUN.DONE;
      } else {
        this.phase = RUN.CHOOSING;
        this.#offerRoads();
      }
    }
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
    }

    this.lastArrival = {
      name: road.name,
      detail: road.detail,
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
