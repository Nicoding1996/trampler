import { CFG } from "./config.js";
import { CHEWER, CLIMBER } from "./enemies.js";
import { makeRandom } from "./util.js";

// Wave director, built on the pacing model Left 4 Dead uses: build up, sustain
// peak, fade, relax. Four phases here, and the two rules that matter more than
// any of the numbers:
//
//   1. Spawning stops completely while the crew is under real pressure, and a
//      guaranteed calm period follows before anything else happens. Pressure is
//      measured from the crew's actual situation -- health, hostiles under the
//      hull, hostiles aboard, whether the fortress is stopped -- not from a head
//      count. Eight healthy enemies wandering at 60 m are not the same problem as
//      eight chewing your legs, and the old head-count gate could not tell them
//      apart.
//
//   2. Every wave is telegraphed. Deep Rock Galactic gives players 15-20 seconds
//      before a swarm specifically so they can pick a position and set up
//      defences. That window is what makes our deployable emitters a decision.
//
// Difficulty still scales off ELAPSED TIME, which is the anti-stall valve: the
// rest phase cannot be farmed, because waiting makes everything tougher.

export const PHASE = {
  REST: "rest",         // enforced calm, nothing spawning
  PREP: "prep",         // telegraphed warning, nothing spawning yet
  SPAWNING: "spawning", // trickling the wave onto the field
  ENGAGED: "engaged",   // wave is out; ends when the crew resolves it
  HELD: "held",         // the siege is over and won; nothing further spawns
};

export class Director {
  constructor(horde, trampler, player, seed = CFG.waves.seed) {
    this.horde = horde;
    this.trampler = trampler;
    this.player = player;
    this.seed = seed;

    this.reset();
  }

  reset() {
    // Re-seeded here rather than in the constructor so restarting an encounter
    // replays the same sequence of wave bearings. A reset that continued the
    // stream would make two attempts at "wave 4" different fights.
    this.random = makeRandom(this.seed);

    this.wave = 0;
    this.elapsed = 0;
    this.phase = PHASE.REST;
    this.timer = CFG.waves.firstDelay;
    this.queue = 0;
    this.queueClimbers = 0;
    this.spawnAccum = 0;
    this.arcOffset = 0;
    this.forced = false;
  }

  // ----------------------------------------------------------------- pressure

  /** 0..1 estimate of how much trouble the crew is actually in. */
  get pressure() {
    const p = CFG.waves.pressure;
    const pl = this.player;

    let v = p.hurtWeight * (1 - pl.hp / pl.maxHp);
    v += p.underWeight * Math.min(1, (this.horde.underHull ?? 0) / p.underFull);
    v += p.aboardWeight * Math.min(1, (this.horde.aboard ?? 0) / p.aboardFull);
    if (this.trampler.immobilised) v += p.immobileWeight;
    if (pl.timeSinceHurt < p.recentHurtWindow) v += p.recentHurtWeight;

    return Math.min(1, v);
  }

  /** Has the fight actually settled? Both the pressure and the field must ease. */
  get calm() {
    return this.pressure < CFG.waves.pressure.calmBelow
      && this.horde.liveCount <= CFG.waves.holdUntilCleared;
  }

  /** Enemy health multiplier from time survived. The anti-stall valve. */
  hpScale() {
    return 1 + this.elapsed / CFG.waves.hpRamp;
  }

  get spawning() {
    return this.phase === PHASE.SPAWNING;
  }

  /** The next wave is being withheld because the fight is not resolved. */
  get holding() {
    if (this.phase === PHASE.ENGAGED) return !this.calm;
    return this.phase === PHASE.REST && this.timer <= 0 && !this.calm;
  }

  /**
   * Threshold is a third of the bearing arc, so the three labels stay roughly
   * equally likely. It was a fixed 0.4 rad, which was fine against a 1.25 rad arc
   * but made 13 of 24 waves read DEAD AHEAD once the arc narrowed to 0.9 -- a
   * telegraph that mostly says one thing is not telling the player anything.
   */
  get bearingLabel() {
    if (Math.abs(this.arcOffset) < CFG.waves.forwardArc / 3) return "DEAD AHEAD";
    return this.arcOffset > 0 ? "OFF THE STARBOARD BOW" : "OFF THE PORT BOW";
  }

  /**
   * Bring the next wave now. Available from any phase except mid-release, and it
   * deliberately skips the preparation window -- getting no time to set up is the
   * price of choosing to stack.
   */
  /** Has the siege been held to its full length? */
  get held() {
    return this.phase === PHASE.HELD;
  }

  callEarly() {
    if (this.phase === PHASE.SPAWNING || this.phase === PHASE.HELD) return false;
    this.forced = true;
    this.timer = 0;
    return true;
  }

  // ------------------------------------------------------------------- phases

  #pickBearing() {
    this.arcOffset = (this.random() * 2 - 1) * CFG.waves.forwardArc;
  }

  #beginPrep() {
    this.phase = PHASE.PREP;
    this.timer = CFG.waves.prepTime;
    // Commit to a bearing now so the telegraph can name it.
    this.#pickBearing();
  }

  #startWave() {
    const w = CFG.waves;
    this.forced = false;
    this.wave++;

    const count = w.baseCount + w.perWave * (this.wave - 1);
    this.queueClimbers = Math.round(count * w.climberShare);
    this.queue = count;
    this.spawnAccum = 0;
    this.phase = PHASE.SPAWNING;
  }

  #release(dt) {
    this.spawnAccum += dt * CFG.waves.spawnRate;

    while (this.spawnAccum >= 1 && this.queue > 0) {
      this.spawnAccum -= 1;

      // Interleave climbers through the wave so both pressures arrive together.
      const wantClimber = this.queueClimbers > 0
        && this.random() < this.queueClimbers / this.queue;

      if (wantClimber) {
        if (this.horde.spawn(CLIMBER, this.hpScale(), this.arcOffset)) this.queueClimbers--;
      } else {
        this.horde.spawn(CHEWER, this.hpScale(), this.arcOffset);
      }
      this.queue--;
    }
  }

  update(dt) {
    this.elapsed += dt;
    const w = CFG.waves;

    switch (this.phase) {
      case PHASE.REST:
        this.timer -= dt;
        if (this.forced) {
          this.#pickBearing();
          this.#startWave();
        } else if (this.timer <= 0 && this.calm) {
          this.#beginPrep();
        }
        break;

      case PHASE.PREP:
        this.timer -= dt;
        if (this.forced || this.timer <= 0) this.#startWave();
        break;

      case PHASE.SPAWNING:
        this.#release(dt);
        if (this.queue <= 0) this.phase = PHASE.ENGAGED;
        break;

      case PHASE.ENGAGED:
        // No clock here on purpose. A wave ends when the crew has resolved it,
        // which is what stops waves stacking onto an unfinished fight.
        if (this.forced) {
          this.#pickBearing();
          this.#startWave();
        } else if (this.calm) {
          // Resolving the last wave of the siege ends it. Without a finish line
          // this is an endless fight, and losing on wave 4 reads as failure rather
          // than as nearly holding -- there is nothing being reached.
          if (this.wave >= w.siegeLength) {
            this.phase = PHASE.HELD;
            this.timer = 0;
          } else {
            this.phase = PHASE.REST;
            this.timer = w.minRest;
          }
        }
        break;

      case PHASE.HELD:
        // Terminal. The siege is won; nothing else is coming.
        break;
    }
  }
}
