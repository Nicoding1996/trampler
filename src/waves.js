import { CFG } from "./config.js";
import { CHEWER, CLIMBER } from "./enemies.js";

// Wave director.
//
// Difficulty scales off ELAPSED TIME, not wave number. That is the Risk of Rain
// transplant: getting stronger has to be a race against a clock rather than a
// staircase you climb at your own pace.
//
// Calling a wave early with E is pacing control here. The greed loop it is meant
// to serve -- loot more, fight worse -- needs a reward economy that does not
// exist yet, so for now this only proves the cadence is controllable.

export class Director {
  constructor(horde) {
    this.horde = horde;
    this.reset();
  }

  reset() {
    this.wave = 0;
    this.elapsed = 0;
    this.timer = CFG.waves.firstDelay;
    this.queue = 0;
    this.queueClimbers = 0;
    this.spawnAccum = 0;
    this.forced = false;
  }

  /** Enemy health multiplier from time survived. */
  hpScale() {
    return 1 + this.elapsed / CFG.waves.hpRamp;
  }

  get spawning() {
    return this.queue > 0;
  }

  /** True when the clock has run out but the field is still too crowded. */
  get holding() {
    return !this.spawning
      && this.timer <= 0
      && this.horde.liveCount > CFG.waves.holdUntilCleared;
  }

  callEarly() {
    if (this.spawning) return false;
    // Deliberately bypasses the hold: stacking waves is the player's call.
    this.forced = true;
    this.timer = 0;
    return true;
  }

  #startWave() {
    const w = CFG.waves;
    this.wave++;
    const count = w.baseCount + w.perWave * (this.wave - 1);
    this.queueClimbers = Math.round(count * w.climberShare);
    this.queue = count;
    this.spawnAccum = 0;
    this.timer = w.between;
  }

  update(dt) {
    this.elapsed += dt;

    if (!this.spawning) {
      this.timer -= dt;
      if (this.timer > 0) return;

      // Hold the next wave until the field thins, unless the player asked for it.
      if (!this.forced && this.horde.liveCount > CFG.waves.holdUntilCleared) return;

      this.forced = false;
      this.#startWave();
      return;
    }

    // Release the wave over a few seconds rather than in one instant lump.
    this.spawnAccum += dt * CFG.waves.spawnRate;
    while (this.spawnAccum >= 1 && this.queue > 0) {
      this.spawnAccum -= 1;

      // Interleave climbers through the wave so both pressures arrive together.
      const wantClimber = this.queueClimbers > 0
        && Math.random() < this.queueClimbers / this.queue;

      if (wantClimber) {
        if (this.horde.spawn(CLIMBER, this.hpScale())) this.queueClimbers--;
      } else {
        this.horde.spawn(CHEWER, this.hpScale());
      }
      this.queue--;
    }
  }
}
