import * as THREE from "three";
import { CFG, releasePresetName } from "./config.js";

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

  #prompt(key, label, progress, working, blocked = false) {
    if (this.promptKey.textContent !== key) this.promptKey.textContent = key;
    if (this.promptLabel.textContent !== label) this.promptLabel.textContent = label;
    fill(this.promptBar, progress);
    const cls = blocked ? "show blocked" : working ? "show working" : "show";
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
        !gun.overheated,
      );
    } else if (gun?.canMount) {
      this.#prompt("F", `MAN THE ${gun.name}`, 1, false);
    } else if (repair?.target) {
      // Saying WHY the work is blocked is the whole point: repairing while
      // hostiles are still chewing is a losing trade the player cannot see.
      if (repair.threatened) {
        this.#prompt("!", `CLEAR THE AREA  ·  ${repair.target.label}`, repair.progress, false, true);
      } else {
        this.#prompt(
          "HOLD E",
          `REPAIR ${repair.target.label}  ${Math.round(repair.progress * 100)}%`,
          repair.progress,
          repair.active,
        );
      }
    } else if (this.prompt.className !== "") {
      this.prompt.className = "";
    }

    set(this.el.wave, String(director.wave));
    set(
      this.el.next,
      director.spawning
        ? "incoming"
        : director.holding
          ? `held · clear ${horde.liveCount - CFG.waves.holdUntilCleared}  (Q)`
          : `${Math.max(0, director.timer).toFixed(0)} s  (Q)`,
      director.spawning ? "bad" : director.holding ? "on" : "",
    );
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
