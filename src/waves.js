import { CFG } from "./config.js";
import { CHEWER, CLIMBER, BULWARK, BURROWER, SAPPER, TITAN } from "./enemies.js";
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

    // Set by the Run when there is one. Absent, the director behaves exactly as it
    // did before the run structure existed -- one siege, no modifiers, no boss --
    // which is what keeps it usable on its own in a test.
    this.run = null;

    this.reset();
  }

  reset() {
    // Re-seeded here rather than in the constructor so restarting an encounter
    // replays the same sequence of wave bearings. A reset that continued the
    // stream would make two attempts at "wave 4" different fights.
    this.random = makeRandom(this.seed);

    this.elapsed = 0;

    // How many waves the crew has actually SEEN OFF. Not the same as `wave`:
    // stacking a new wave onto an unresolved one with Q means the first never
    // resolves on its own, so it never pays. The economy polls this counter rather
    // than being handed a callback, so the director stays unaware it exists.
    //
    // Deliberately NOT rewound by resetSiege: it accumulates across a whole run,
    // because the economy pays per resolved wave and rewinding it would pay for
    // the same waves twice at every landmark.
    this.resolved = 0;

    // Overridable by the Run, since the boss landmark is a shorter siege.
    this.siegeLength = CFG.waves.siegeLength;

    this.resetSiege(CFG.waves.firstDelay);
  }

  /**
   * Start a fresh siege, keeping the elapsed clock and the resolved count.
   *
   * The clock keeps running on purpose. Difficulty scales with elapsed time as the
   * anti-stall valve, and rewinding it at every landmark would let a slow crew
   * farm a whole biome at wave-one difficulty.
   */
  resetSiege(firstDelay = CFG.waves.minRest) {
    this.wave = 0;
    this.phase = PHASE.REST;
    this.timer = firstDelay;
    this.queueTypes = [];
    this.queue = 0;
    this.spawnAccum = 0;
    this.arcOffset = 0;
    this.forced = false;

    // Was the wave currently in play summoned early? Stays true until the next
    // wave begins, so the payout for resolving it still counts as part of the
    // gamble rather than falling outside it by a frame.
    this.calledEarly = false;
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

  /**
   * Enemy health multiplier: time survived, times whatever roads the crew took to
   * get here. The road term is cumulative across a run, so an early greedy choice
   * is a commitment for the rest of the biome rather than one hard wave.
   */
  hpScale() {
    return (1 + this.elapsed / CFG.waves.hpRamp) * (this.run?.threatScale ?? 1);
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

  /** Has the siege been held to its full length? */
  get held() {
    return this.phase === PHASE.HELD;
  }

  /** Is the wave about to arrive the boss? Used by the telegraph. */
  get nextIsBoss() {
    return !!this.run?.isBossWave(this.wave + 1);
  }

  /**
   * Bring the next wave now. Available from any phase except mid-release, and it
   * deliberately skips the preparation window -- getting no time to set up is the
   * price of choosing to stack.
   */
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

  /** Deterministic Fisher-Yates, so a wave's arrival order replays exactly. */
  #shuffle(list) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = (this.random() * (i + 1)) | 0;
      const t = list[i];
      list[i] = list[j];
      list[j] = t;
    }
    return list;
  }

  /**
   * How far along the ROSTER schedule a wave is, as opposed to how big it is.
   *
   * Two different counters on purpose. `wave` rewinds at every landmark, because the
   * size curve should: a first wave is a first wave, and the curve was tuned against
   * measured pacing. The roster should not rewind, and it used to -- landmark 2 wave
   * 1 was seven chewers and three climbers again, so the fight after a road was
   * structurally simpler than the one before it, which is why a playtester read the
   * road choice as "it just went next".
   */
  tierOf(wave) {
    const perLeg = CFG.enemies.composition.tierPerLeg;
    return wave + perLeg * Math.max(0, (this.run?.leg ?? 1) - 1);
  }

  /**
   * Decide exactly what a wave is made of.
   *
   * Specials SUBSTITUTE for chewers rather than adding to the total. The wave-size
   * curve was tuned against measured pacing, and growing it at the same time as
   * changing its composition moves two variables at once -- after which no
   * difficulty change can be attributed to either. Road modifiers are the one
   * thing allowed to change the count, and they are explicit about it.
   *
   * Waves one and two are chewers and climbers only. Those are the two pressures
   * the whole design rests on and they deserve to be learned without noise.
   *
   * @param wave decides the SIZE, and rewinds at every landmark.
   * @param tier decides the ROSTER, and carries across them. Defaults to `wave` so a
   *        caller asking "what is wave 5 made of" still gets a straight answer --
   *        which is what the harness wants when it is testing the schedule itself.
   */
  buildWave(wave, tier = wave) {
    const w = CFG.waves;
    const c = CFG.enemies.composition;
    const count = Math.max(
      1,
      w.baseCount + w.perWave * (wave - 1) + (this.run?.extraCount ?? 0),
    );

    const types = [];
    const push = (type, n) => {
      for (let i = 0; i < n; i++) types.push(type);
    };

    const ramp = (from, every, max) =>
      tier < from ? 0 : Math.min(max, 1 + Math.floor((tier - from) / every));

    // Chewers are the FLOOR of a wave, reserved before anything else is allowed in,
    // and the specials fill what is left in priority order.
    //
    // This used to be the other way round -- specials first, chewers as the remainder
    // -- with a comment observing that the caps were the only thing stopping the
    // remainder reaching zero. Carrying the tier across landmarks breaks that
    // immediately: at tier 7 the ramps want three bulwarks and three sappers, and a
    // first wave is ten enemies. A wave with no chewers has nothing under the hull,
    // which deletes the reason to dismount, and it would have happened quietly.
    //
    // Allocated in TWO passes, and the first one is the important half.
    //
    // A single pass in priority order starves whatever is last. Measured: at landmark
    // 3 the bulwark ramp wanted three and took the remaining room, and the SAPPER --
    // the only enemy that is a timer rather than a damage race, and the one that makes
    // going under the hull urgent -- vanished from the wave entirely. Escalating the
    // roster and then having it eat itself is worse than not escalating it.
    //
    // So: one of every type that is DUE at this tier first, because presence is what
    // "the roster grew" actually means to a player, and exact counts are texture. Then
    // the remainder in priority order, where the shares can dominate.
    //
    // Priority is the two pillar types first — the deck and the under-hull arena both
    // have to be populated before anything expensive is, since those two pressures ARE
    // the game.
    let room = Math.max(0, count - Math.max(1, Math.round(count * c.chewerFloor)));
    const wanted = [
      [CLIMBER, Math.round(count * w.climberShare)],
      [BURROWER, tier >= c.burrowerFromWave ? Math.round(count * c.burrowerShare) : 0],
      [BULWARK, ramp(c.bulwarkFromWave, c.bulwarkEvery, c.bulwarkMax)],
      [SAPPER, ramp(c.sapperFromWave, c.sapperEvery, c.sapperMax)],
    ];
    const got = wanted.map(() => 0);

    for (let i = 0; i < wanted.length && room > 0; i++) {
      if (wanted[i][1] > 0) {
        got[i] = 1;
        room--;
      }
    }
    for (let i = 0; i < wanted.length && room > 0; i++) {
      const more = Math.min(wanted[i][1] - got[i], room);
      if (more > 0) {
        got[i] += more;
        room -= more;
      }
    }
    for (let i = 0; i < wanted.length; i++) push(wanted[i][0], got[i]);

    push(CHEWER, Math.max(0, count - types.length));

    this.#shuffle(types);

    if (this.run?.isBossWave(wave)) {
      // The titan IS the wave. Keeping the full escort alongside it turns the
      // climax into a crowd-control problem you cannot see through, and dropping
      // the escort entirely turns it into a duel that throws away every system
      // except shooting.
      types.length = Math.max(1, Math.round(types.length * CFG.run.bossWaveScale));
      types.push(TITAN); // released first, since the queue pops from the end
    }

    return types;
  }

  #startWave() {
    // Captured before `forced` is cleared: this is what the economy pays a bonus
    // against, and it is the only record that this wave was a gamble.
    this.calledEarly = this.forced;
    this.forced = false;
    this.wave++;

    this.queueTypes = this.buildWave(this.wave, this.tierOf(this.wave));
    this.queue = this.queueTypes.length;
    this.spawnAccum = 0;
    this.phase = PHASE.SPAWNING;
  }

  #release(dt) {
    this.spawnAccum += dt * CFG.waves.spawnRate;

    while (this.spawnAccum >= 1 && this.queueTypes.length > 0) {
      this.spawnAccum -= 1;

      const type = this.queueTypes[this.queueTypes.length - 1];
      // The boss is authored, not ramped. A boss whose health scales with how
      // long you took makes both stalling and rushing wrong for unrelated
      // reasons, and it is the one fight whose numbers should be legible enough
      // to plan a build around.
      const scale = type === TITAN ? 1 : this.hpScale();

      if (this.horde.spawn(type, scale, this.arcOffset)) {
        this.queueTypes.pop();
      } else {
        // Pool full. Hand the budget back and try again next frame rather than
        // silently dropping an enemy, which would make wave size depend on how
        // crowded the field happened to be.
        this.spawnAccum += 1;
        break;
      }
    }

    this.queue = this.queueTypes.length;
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
        if (this.queueTypes.length <= 0) this.phase = PHASE.ENGAGED;
        break;

      case PHASE.ENGAGED:
        // No clock here on purpose. A wave ends when the crew has resolved it,
        // which is what stops waves stacking onto an unfinished fight.
        if (this.forced) {
          this.#pickBearing();
          this.#startWave();
        } else if (this.calm) {
          // Seen off. Counted here and nowhere else, so a wave that was buried
          // under a stacked one never pays -- which is part of what Q costs.
          this.resolved++;

          // Resolving the last wave of the siege ends it. Without a finish line
          // this is an endless fight, and losing on wave 4 reads as failure rather
          // than as nearly holding -- there is nothing being reached.
          if (this.wave >= this.siegeLength) {
            this.phase = PHASE.HELD;
            this.timer = 0;
          } else {
            this.phase = PHASE.REST;
            this.timer = w.minRest;
          }
        }
        break;

      case PHASE.HELD:
        // Terminal until something outside asks for another siege. The Run offers
        // roads here; nothing advances on a timer, because finishing should be a
        // state you get to sit in rather than one the game clears for you.
        break;
    }
  }
}
