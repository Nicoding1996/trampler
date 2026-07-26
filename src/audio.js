import { CFG } from "./config.js";
import { PHASE } from "./waves.js";

// Sound, entirely synthesised. There are no audio files in this project.
//
// Not a purity exercise. A stompy fortress is half a sound design problem, its
// total absence was distorting every feel judgement being made, and one synth
// voice per event is the shortest path from "silent" to "you can hear the thing
// you are standing on". Footfalls in particular were doing nothing at all for a
// mechanic whose entire subject is a walking building.
//
// Like fx.js, this module READS the simulation and is never called by it. Every
// sound is triggered by polling a counter the sim keeps for its own reasons --
// trampler.stepCount, weapon.shots, horde.killCount, player.hurtCount. So the
// simulation has no idea a mixer exists, and the headless harness never has to
// stub an AudioContext.
//
// Construction is lazy and guarded. Browsers refuse to start an AudioContext
// before a user gesture, so nothing is built until the click-to-play gate is
// satisfied, and every method is a no-op until then.

export class Audio {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;

    // Counters we watch. Captured on start so the first frame does not fire every
    // sound in the game at once.
    this.lastStep = 0;
    this.lastShots = 0;
    this.lastGunShots = 0;
    this.lastKills = 0;
    this.lastHurt = 0;
    this.lastPhase = null;
    this.lastFuses = 0;
    this.lastDeploy = 0;
    this.lastPurchases = 0;
  }

  /** Called from the pointer-lock gate, which is a real user gesture. */
  start() {
    if (this.ready) return;
    const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctor) return;

    try {
      this.ctx = new Ctor();
      const a = CFG.audio;

      this.master = this.ctx.createGain();
      this.master.gain.value = a.master;
      // A gentle limiter. Twelve footfalls, two guns and a horde dying at once
      // will clip a naive summing bus, and clipping is the one artefact that makes
      // synthesised audio sound broken rather than stylised.
      this.limiter = this.ctx.createDynamicsCompressor();
      this.limiter.threshold.value = -10;
      this.limiter.knee.value = 6;
      this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.003;
      this.limiter.release.value = 0.18;

      this.master.connect(this.limiter);
      this.limiter.connect(this.ctx.destination);

      this.noise = this.#noiseBuffer();
      this.#drone();
      this.ready = true;
    } catch (err) {
      console.warn(`[audio] unavailable: ${err.message}`);
      this.ready = false;
    }
  }

  /** Two seconds of white noise, reused by every percussive voice. */
  #noiseBuffer() {
    const len = this.ctx.sampleRate * 2;
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    // Deterministic, so a recording of one run matches a recording of the next.
    let s = 22222;
    for (let i = 0; i < len; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      d[i] = (s / 2147483648) - 1;
    }
    return buf;
  }

  /**
   * The fortress's noise floor: a diesel idle that rises with drive.
   *
   * Two detuned saws through a low-pass, which is enough to read as a large engine
   * somewhere below you. It is the only continuous voice, and it is what makes
   * silence between waves feel like a lull rather than like a bug.
   */
  #drone() {
    const g = this.ctx.createGain();
    g.gain.value = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 220;
    filter.Q.value = 1.2;

    for (const [freq, detune] of [[44, 0], [44, 11], [66, -7]]) {
      const osc = this.ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = freq;
      osc.detune.value = detune;
      osc.connect(filter);
      osc.start();
    }

    filter.connect(g);
    g.connect(this.master);
    this.droneGain = g;
    this.droneFilter = filter;
  }

  // ------------------------------------------------------------------- voices

  /** Filtered noise burst. The workhorse: impacts, footfalls, gunfire. */
  #burst({ volume = 0.4, duration = 0.2, type = "lowpass", freq = 600, q = 1, sweep = 0 }) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;

    const filter = this.ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    const now = this.ctx.currentTime;
    filter.frequency.setValueAtTime(freq, now);
    if (sweep) filter.frequency.exponentialRampToValueAtTime(Math.max(40, sweep), now + duration);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(volume, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    src.connect(filter);
    filter.connect(g);
    g.connect(this.master);
    src.start(now);
    src.stop(now + duration + 0.02);
  }

  /** Pitched tone. Alarms, horns, purchases, the reactor. */
  #tone({ volume = 0.2, duration = 0.3, freq = 440, to = null, type = "sine" }) {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    const now = this.ctx.currentTime;
    osc.frequency.setValueAtTime(freq, now);
    if (to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), now + duration);

    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(volume, now + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    osc.connect(g);
    g.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  // ------------------------------------------------------------------- update

  /**
   * Poll everything and play whatever changed.
   *
   * `near` is 0..1 for how close the fortress's feet are to the listener, so a
   * footfall you are standing next to lands harder than one forty metres astern.
   */
  update(dt, ctx) {
    if (!this.ready || this.muted) return;
    const a = CFG.audio;
    const {
      trampler, weapon, guns, horde, player, director, economy, emitters,
    } = ctx;

    // Engine idle tracks drive, and drops to a dead hum when the fortress stops.
    // The silence of an immobilised fortress is the most informative sound in the
    // game: you can hear that it has stopped without looking at the HUD.
    const drive = trampler.speedFactor();
    const target = trampler.immobilised ? 0.12 : 0.4 + drive * 0.6;
    this.droneGain.gain.value += (a.droneVolume * target - this.droneGain.gain.value)
      * Math.min(1, dt * 3);
    this.droneFilter.frequency.value = 150 + drive * 260;

    // Footfalls. One low thump plus a grit layer, and the whole reason the mixer
    // exists.
    if (trampler.stepCount !== this.lastStep) {
      const steps = Math.min(3, trampler.stepCount - this.lastStep);
      this.lastStep = trampler.stepCount;
      const gain = a.footVolume * (player.base ? 1 : 0.75);
      for (let i = 0; i < steps; i++) {
        this.#tone({ volume: 0.5 * gain, duration: 0.34, freq: 62, to: 30, type: "sine" });
        this.#burst({ volume: 0.28 * gain, duration: 0.3, freq: 900, sweep: 120 });
      }
    }

    // The rifle. Short, dry, and cheap -- it fires eight times a second and
    // anything with a tail turns sustained fire into mud.
    const gunShots = guns.reduce((n, g) => n + g.shots, 0);
    if (weapon.shots !== this.lastShots) {
      const manned = gunShots !== this.lastGunShots;
      this.lastShots = weapon.shots;
      this.lastGunShots = gunShots;
      if (manned) {
        // Deck gun: heavier, with a body to it. It should sound like the better
        // weapon, because it is.
        this.#tone({ volume: 0.4 * a.gunVolume, duration: 0.2, freq: 150, to: 46, type: "square" });
        this.#burst({ volume: 0.7 * a.gunVolume, duration: 0.18, freq: 2600, sweep: 300 });
      } else {
        this.#burst({ volume: a.rifleVolume, duration: 0.075, freq: 3400, sweep: 700 });
        this.#tone({ volume: 0.18 * a.rifleVolume, duration: 0.09, freq: 200, to: 80, type: "square" });
      }
    }

    // Kills, batched. Twelve simultaneous deaths must not be twelve voices.
    if (horde.killCount !== this.lastKills) {
      const n = Math.min(3, horde.killCount - this.lastKills);
      this.lastKills = horde.killCount;
      for (let i = 0; i < n; i++) {
        this.#burst({ volume: a.deathVolume, duration: 0.16, type: "bandpass", freq: 420, q: 2.2, sweep: 160 });
      }
    }

    // Taking damage. Deliberately the most unpleasant sound in the build.
    if (player.hurtCount !== this.lastHurt) {
      this.lastHurt = player.hurtCount;
      this.#burst({ volume: a.hitVolume * 1.6, duration: 0.26, freq: 1500, sweep: 90 });
      this.#tone({ volume: a.hitVolume, duration: 0.4, freq: 110, to: 55, type: "triangle" });
    }

    // Emitter discharge.
    const arcs = emitters?.arcs?.filter((x) => x.life > 0).length ?? 0;
    if (arcs > this.lastDeploy) {
      this.#burst({ volume: a.zapVolume, duration: 0.1, type: "highpass", freq: 2400, q: 3 });
    }
    this.lastDeploy = arcs;

    // Wave telegraph: a two-note horn, once per prep window. This is the cue the
    // preparation window exists to give, and it is far more useful in sound than
    // on screen -- you hear it while looking anywhere.
    if (director.phase !== this.lastPhase) {
      if (director.phase === PHASE.PREP) {
        const boss = director.nextIsBoss;
        this.#tone({ volume: a.hornVolume, duration: 0.9, freq: boss ? 70 : 132, to: boss ? 52 : 98, type: "sawtooth" });
        setTimeout(() => {
          if (this.ready) {
            this.#tone({ volume: a.hornVolume * 0.8, duration: 1.2, freq: boss ? 58 : 110, to: boss ? 44 : 88, type: "sawtooth" });
          }
        }, 520);
      } else if (director.phase === PHASE.HELD) {
        // Held. Three rising notes, and the only unambiguously good sound here.
        [262, 330, 392].forEach((f, i) => setTimeout(() => {
          if (this.ready) this.#tone({ volume: 0.3, duration: 0.5, freq: f, type: "triangle" });
        }, i * 170));
      }
      this.lastPhase = director.phase;
    }

    // A charge being set. A sapper is a timer, and a timer wants a tick.
    if (horde.fusesLit > this.lastFuses) {
      this.#tone({ volume: 0.3, duration: 0.5, freq: 880, to: 1400, type: "square" });
    }
    this.lastFuses = horde.fusesLit;

    // Purchases, so spending money has weight.
    if (economy && economy.purchases !== this.lastPurchases) {
      this.lastPurchases = economy.purchases;
      this.#tone({ volume: 0.24, duration: 0.12, freq: 520, type: "square" });
      setTimeout(() => {
        if (this.ready) this.#tone({ volume: 0.24, duration: 0.2, freq: 780, type: "square" });
      }, 70);
    }

    // Reactor alarm, and it ducks everything else rather than competing with it.
    const frac = trampler.reactorHp / trampler.maxReactorHp;
    const alarming = frac < 0.5 && !trampler.destroyed;
    this.master.gain.value = a.master * (alarming ? a.duckUnderAlarm : 1);
    if (alarming) {
      this.alarmAccum = (this.alarmAccum ?? 0) + dt;
      if (this.alarmAccum > 1.5) {
        this.alarmAccum = 0;
        this.#tone({ volume: 0.3, duration: 0.55, freq: 440, to: 330, type: "sawtooth" });
      }
    }
  }
}
