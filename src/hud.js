import * as THREE from "three";
import { CFG, releasePresetName } from "./config.js";
import { PHASE } from "./waves.js";

const _v = new THREE.Vector3();

const set = (el, text, cls) => {
  if (el.textContent !== text) el.textContent = text;
  if (cls !== undefined) {
    const want = `v ${cls}`.trim();
    if (el.className !== want) el.className = want;
  }
};

const fill = (el, frac) => {
  const f = Math.max(0, Math.min(1, frac));
  el.style.transform = `scaleX(${f})`;
};

export class Hud {
  constructor() {
    const id = (s) => document.getElementById(s);
    this.el = {
      speed: id("r-speed"),
      base: id("r-base"),
      grounded: id("r-grounded"),
      grapple: id("r-grapple"),
      mantle: id("r-mantle"),
      dist: id("r-dist"),
      tspeed: id("r-tspeed"),
      walking: id("r-walking"),
      turning: id("r-turning"),
      bob: id("r-bob"),
      hp: id("r-hp"),
      release: id("r-release"),
      fps: id("r-fps"),

      barHp: id("b-hp"),
      barReactor: id("b-reactor"),
      barHeat: id("b-heat"),
      drive: id("r-drive"),
      emitters: id("r-emitters"),
      wave: id("r-wave"),
      next: id("r-next"),
      pressure: id("r-pressure"),
      threat: id("r-threat"),
      live: id("r-live"),
      kd: id("r-kd"),
    };

    this.pips = [...document.querySelectorAll("#pips .pip")];
    this.prompt = document.getElementById("prompt");
    this.promptKey = document.getElementById("p-key");
    this.promptLabel = document.getElementById("p-label");
    this.promptBar = document.getElementById("p-bar");
    this.crosshair = document.getElementById("crosshair");
    this.help = document.getElementById("help");
    this.questions = document.getElementById("questions");
    this.banner = document.getElementById("banner");

    this.telegraph = document.getElementById("telegraph");
    this.telegraphHead = document.getElementById("t-head");
    this.telegraphSub = document.getElementById("t-sub");
    this.telegraphBar = document.getElementById("t-bar");
  }

  #showTelegraph(head, sub, frac) {
    if (this.telegraphHead.textContent !== head) this.telegraphHead.textContent = head;
    if (this.telegraphSub.textContent !== sub) this.telegraphSub.textContent = sub;
    fill(this.telegraphBar, frac);
    if (this.telegraph.className !== "show") this.telegraph.className = "show";
  }

  #hideTelegraph() {
    if (this.telegraph.className !== "") this.telegraph.className = "";
  }

  toggleHelp() {
    this.help.classList.toggle("hidden");
    this.questions.classList.toggle("hidden");
  }

  // Guarded against rewriting identical markup: this is called every frame
  // while the loss banner is up, and reassigning innerHTML at 60 Hz reparses
  // the DOM continuously and makes the text flicker.
  showBanner(html) {
    if (this.bannerHtml !== html) {
      this.banner.innerHTML = html;
      this.bannerHtml = html;
    }
    this.banner.classList.add("show");
  }

  hideBanner() {
    this.banner.classList.remove("show");
  }

  /**
   * `state` is one of "", "working", "contested", "blocked". A single state
   * rather than a pair of booleans, because "working" and "blocked" were both
   * settable at once and contested repair genuinely needs a third reading:
   * progress IS happening, just badly. Showing that in the red "blocked" style
   * said the opposite of what the filling bar said.
   */
  #prompt(key, label, progress, state = "") {
    if (this.promptKey.textContent !== key) this.promptKey.textContent = key;
    if (this.promptLabel.textContent !== label) this.promptLabel.textContent = label;
    fill(this.promptBar, progress);
    const cls = state ? `show ${state}` : "show";
    if (this.prompt.className !== cls) this.prompt.className = cls;
  }

  update(ctx) {
    const { player, trampler, grapple, horde, director, weapon, repair, emitters, gun, fps } = ctx;

    // ---- movement readout
    const world = player.worldVelocity(_v);
    set(this.el.speed, `${Math.hypot(world.x, world.z).toFixed(1)} m/s`);
    set(this.el.base, player.base ? "trampler" : "ground", player.base ? "on" : "");
    set(this.el.grounded, player.grounded ? "yes" : "airborne", player.grounded ? "" : "on");

    const gState = grapple.active ? "reeling" : grapple.cooldown > 0 ? "cooldown" : "ready";
    set(this.el.grapple, gState, grapple.active ? "on" : "");

    const mState = player.mantle.active ? "climbing" : player.mantleLock > 0 ? "cooldown" : "ready";
    set(this.el.mantle, mState, player.mantle.active ? "on" : "");

    set(this.el.dist, `${player.position.distanceTo(trampler.group.position).toFixed(0)} m`);

    // ---- test rig
    set(this.el.tspeed, `${CFG.trampler.speed.toFixed(1)} x${trampler.speedFactor().toFixed(2)}`);
    set(this.el.walking, trampler.walking ? "on" : "off", trampler.walking ? "on" : "off");
    set(this.el.turning, trampler.turning ? "on" : "off", trampler.turning ? "on" : "off");
    set(this.el.bob, CFG.trampler.bob ? "on" : "off", CFG.trampler.bob ? "on" : "off");
    set(this.el.hp, CFG.grapple.hardpointsOnly ? "on" : "off", CFG.grapple.hardpointsOnly ? "on" : "off");
    set(this.el.release, releasePresetName(), "on");
    set(this.el.fps, String(fps));

    // ---- combat
    fill(this.el.barHp, player.hp / player.maxHp);
    fill(this.el.barReactor, trampler.reactorHp / CFG.trampler.reactorHp);

    for (let i = 0; i < this.pips.length; i++) {
      const frac = trampler.legHp[i] / CFG.trampler.legHp;
      const cls = frac <= 0 ? "pip broken" : frac < 0.5 ? "pip hurt" : "pip";
      if (this.pips[i].className !== cls) this.pips[i].className = cls;
    }

    const drive = trampler.speedFactor();
    set(
      this.el.drive,
      trampler.immobilised
        ? `${trampler.workingLegs()} · STOPPED`
        : `${trampler.workingLegs()} · ${Math.round(drive * 100)}%`,
      trampler.immobilised ? "bad" : drive < 1 ? "" : "on",
    );

    // Deck gun heat
    if (gun) {
      fill(this.el.barHeat, gun.heat);
      const heatCls = gun.overheated ? "hot" : "";
      if (this.el.barHeat.className !== heatCls) this.el.barHeat.className = heatCls;
    }

    if (emitters) {
      const ready = emitters.canDeploy(player);
      set(
        this.el.emitters,
        `${emitters.available} / ${CFG.emitters.max}`,
        ready ? "on" : emitters.available <= 0 ? "off" : "",
      );
    }

    // Contextual prompt: the gun takes priority over repair, since standing at
    // the mount and standing at a repair point are never the same place.
    if (gun?.mounted) {
      this.#prompt(
        "F",
        gun.overheated ? `${gun.name}  OVERHEATED` : gun.name,
        1 - gun.heat,
        gun.overheated ? "blocked" : "working",
      );
    } else if (gun?.canMount) {
      this.#prompt("F", `MAN THE ${gun.name}`, 1);
    } else if (repair?.target) {
      // Contested work still happens, just slowly. Saying so matters: the player
      // needs to know the trade they are making, not be told no. Amber, not red --
      // red would contradict the bar, which is still filling.
      const pct = Math.round(repair.progress * 100);
      this.#prompt(
        "HOLD E",
        repair.threatened
          ? `CONTESTED  ·  ${repair.target.label}  ${pct}%`
          : `REPAIR ${repair.target.label}  ${pct}%`,
        repair.progress,
        repair.threatened ? "contested" : repair.active ? "working" : "",
      );
    } else if (this.prompt.className !== "") {
      this.prompt.className = "";
    }

    // Shown as progress toward the siege, not a bare count. The number only means
    // something if you can see what it is counting toward.
    set(
      this.el.wave,
      `${director.wave} / ${CFG.waves.siegeLength}`,
      director.held ? "on" : "",
    );
    // Pacing phase, so the player can read why nothing is happening yet.
    let pace = "";
    let paceCls = "";
    switch (director.phase) {
      case PHASE.REST:
        if (director.timer > 0) {
          pace = `rest ${Math.ceil(director.timer)} s`;
        } else {
          pace = `settling · ${Math.max(0, horde.liveCount - CFG.waves.holdUntilCleared)} left`;
          paceCls = "on";
        }
        break;
      case PHASE.PREP:
        pace = `PREP ${Math.ceil(director.timer)} s`;
        paceCls = "on";
        break;
      case PHASE.SPAWNING:
        pace = `incoming · ${director.queue} to come`;
        paceCls = "bad";
        break;
      case PHASE.HELD:
        pace = "siege held";
        paceCls = "on";
        break;
      default:
        pace = director.calm ? "resolving" : "engaged";
        paceCls = "bad";
    }
    set(this.el.next, pace, paceCls);

    const pressure = director.pressure;
    set(this.el.pressure, `${Math.round(pressure * 100)}%`,
      pressure >= CFG.waves.pressure.calmBelow ? "bad" : "on");

    // The anti-stall clock, made visible: resting does not make you safer.
    set(this.el.threat, `x${director.hpScale().toFixed(2)}`);

    if (director.phase === PHASE.PREP) {
      const next = director.wave + 1;
      this.#showTelegraph(
        next >= CFG.waves.siegeLength
          ? `FINAL WAVE INCOMING`
          : `WAVE ${next} OF ${CFG.waves.siegeLength} INCOMING`,
        `${director.bearingLabel}  ·  ${Math.ceil(director.timer)}s`,
        1 - director.timer / CFG.waves.prepTime,
      );
    } else {
      this.#hideTelegraph();
    }
    set(
      this.el.live,
      `${horde.liveCount}  (${horde.underHull ?? 0} under, ${horde.aboard ?? 0} aboard)`,
      (horde.underHull ?? 0) > 6 ? "bad" : "",
    );
    set(this.el.kd, `${weapon.kills} / ${player.deaths}`);

    let cls = grapple.active ? "" : grapple.cooldown > 0 ? "cooling" : grapple.aimValid ? "valid" : "";
    if (weapon.hitFlash > 0) cls = `${cls} hit`.trim();
    if (this.crosshair.className !== cls) this.crosshair.className = cls;
  }
}
