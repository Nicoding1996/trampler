import * as THREE from "three";
import { CFG, releasePresetName, enemyCfg } from "./config.js";
import { PHASE } from "./waves.js";
import { describeRoad } from "./run.js";
import { Look } from "./look.js";

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

const cls = (el, want) => {
  if (el.className !== want) el.className = want;
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
      assets: id("r-assets"),
      burrowed: id("r-burrowed"),
      draws: id("r-draws"),
      post: id("r-post"),
      exposure: id("r-exposure"),

      procs: id("r-procs"),

      barHp: id("b-hp"),
      barReactor: id("b-reactor"),
      drive: id("r-drive"),
      emitters: id("r-emitters"),
      // Both purses, on the always-visible panel as well as on the shop. The shop's
      // copy is the one you buy against; this one is the one you PLAN against, and it
      // exists because the shop is only up for about a third of a siege.
      purseSalvage: id("v-salvage"),
      purseScrap: id("v-scrap"),
      leg: id("r-leg"),
      wave: id("r-wave"),
      next: id("r-next"),
      pressure: id("r-pressure"),
      threat: id("r-threat"),
      live: id("r-live"),
      kd: id("r-kd"),
    };

    this.diagnostics = document.getElementById("hud");
    this.pips = [...document.querySelectorAll("#pips .pip")];
    this.prompt = document.getElementById("prompt");
    this.promptKey = document.getElementById("p-key");
    this.promptLabel = document.getElementById("p-label");
    this.promptBar = document.getElementById("p-bar");
    this.crosshair = document.getElementById("crosshair");
    this.help = document.getElementById("help");
    this.banner = document.getElementById("banner");

    this.telegraph = document.getElementById("telegraph");
    this.telegraphHead = document.getElementById("t-head");
    this.telegraphSub = document.getElementById("t-sub");
    this.telegraphBar = document.getElementById("t-bar");

    this.shop = document.getElementById("shop");
    this.shopItems = document.getElementById("shop-items");
    this.shopBonus = document.getElementById("shop-bonus");
    this.shopBuild = document.getElementById("shop-build");
    this.shopSalvage = document.getElementById("r-salvage");
    this.shopScrap = document.getElementById("r-scrap");
    this.shopSignature = "";

    this.bay = document.getElementById("bay");
    this.baySockets = document.getElementById("bay-sockets");
    this.bayItems = document.getElementById("bay-items");
    this.bayScrap = document.getElementById("bay-scrap");
    this.baySignature = "";
    this.bayOpen = false;

    this.route = document.getElementById("route");
    this.routeHead = document.getElementById("route-head");
    this.routeItems = document.getElementById("route-items");
    this.routeCarried = document.getElementById("route-carried");
    this.routeSignature = "";

    this.pick = document.getElementById("pick");
    this.pickHead = document.getElementById("pick-head");
    this.pickItems = document.getElementById("pick-items");
    this.pickSignature = "";

    this.buffs = document.getElementById("buffs");
    this.buffGain = document.getElementById("buff-gain");
    this.buffWhy = document.getElementById("buff-why");

    this.target = document.getElementById("target");
    this.targetName = document.getElementById("tgt-name");
    this.targetArmour = document.getElementById("tgt-armour");
    this.targetBar = document.getElementById("tgt-bar");

    // Full-frame feedback. Both are elements rather than post-processing passes
    // because both are UI: they say something about the player's state, not about
    // the scene, and they must be legible even if the composer is switched off.
    this.dmg = document.getElementById("dmg");
    this.alarm = document.getElementById("alarm");
    this.dmgTimer = 0;
    this.lastHurtCount = 0;
    this.lastKills = 0;
    this.killFlash = 0;
  }

  /**
   * The purchase list, rebuilt only when something about it actually changed.
   *
   * The signature guard is not premature optimisation: this panel is a dozen
   * elements of innerHTML and reassigning it every frame reparses the DOM at
   * 60 Hz, which made the loss banner visibly flicker when that mistake was made
   * there.
   */
  #shopPanel(economy, run) {
    if (!economy) return;

    // The bay and a pending salvage pick both borrow the same keys, so all three
    // panels are mutually exclusive. Showing two would put two readings of "press 3"
    // on screen at once — and worse than unreadable, it would be a lie: the router
    // gives the keys to the pick, so a press aimed at a refit spends the free pick
    // instead. The panel that does not own the keys has to be the one that goes away.
    //
    // Keyed off the pick list rather than the run's phase, matching the router. A
    // pick handed out mid-siege leaves the phase at SIEGE, so a phase check here
    // would leave the shop up and lying about what its keys do.
    const open = economy.open && !this.bayOpen && economy.pendingPick.length === 0;
    cls(this.shop, open ? "panel show" : "panel");
    if (!open) return;

    const entries = economy.entries;
    // Two things in this signature are easy to leave out and both go stale silently.
    //
    // `e.index` — WHICH items are on offer. Without it a re-roll that happened to
    // leave the prices and stacks alone would not redraw, and the panel would list
    // last landmark's stock. It only worked before because every road pays scrap on
    // arrival, so the purse moved in the same frame as the re-roll. That is a
    // coincidence of the road table, not a property of the shop.
    //
    // `purchases` — for the carried list below rather than the offer list: a salvage
    // pick grants an item that may not be on sale here at all, so nothing else would
    // move and the build readout would sit one item out of date.
    const signature = [
      Math.floor(economy.salvage), Math.floor(economy.scrap), economy.purchases,
      ...entries.map((e) =>
        `${e.index}:${e.stacks}:${e.cost}:${e.affordable ? 1 : 0}:${e.soldOut ? 1 : 0}`),
    ].join("|");
    if (signature === this.shopSignature) return;
    this.shopSignature = signature;

    this.shopSalvage.textContent = String(Math.floor(economy.salvage));
    this.shopScrap.textContent = String(Math.floor(economy.scrap));

    // Grouped by purse, because the split between them is the whole design and a
    // flat list hides it. Money earned alone buys unbounded personal power; money
    // earned together buys a fixed frame.
    let html = "";
    let pool = null;
    for (const e of entries) {
      if (e.pool !== pool) {
        pool = e.pool;
        html += `<div class="group">${
          pool === "salvage" ? "personal · stacks forever" : "fortress · bounded"
        }</div>`;
      }
      const state = e.soldOut ? "done" : e.affordable ? "can" : "cant";
      // Stacks are shown for everything, with a cap only where one exists: that is
      // the bounded-fortress versus unbounded-personal split made visible.
      const count = e.max === Infinity
        ? (e.stacks > 0 ? ` x${e.stacks}` : "")
        : ` ${e.stacks}/${e.max}`;
      const price = e.soldOut ? "MAX" : `${e.cost} ${e.pool === "scrap" ? "scrap" : "salv"}`;
      html += `<div class="item ${state}">`
        + `<span><span class="key">${e.key.replace("Digit", "")}</span> `
        + `<span class="nm">${e.name}${count}</span><br>`
        + `<span class="dt">${e.detail}</span></span>`
        + `<span class="px">${price}</span>`
        + `</div>`;
    }
    this.shopItems.innerHTML = html;

    // Only shown while the gamble is actually live, so it reads as a state you are
    // in rather than a rule you have to remember.
    const bonus = economy.bonus > 1
      ? `EARLY CALL · +${Math.round((economy.bonus - 1) * 100)}% THIS WAVE`
      : "";
    if (this.shopBonus.textContent !== bonus) this.shopBonus.textContent = bonus;

    // The build readout. Names and stack counts only -- the effects are on the offer
    // list above when an item is on sale, and eighteen lines of description here
    // would bury the four rows the player is actually choosing between.
    const carried = economy.carried;
    this.shopBuild.innerHTML = carried.length === 0
      ? `<span class="none">carrying nothing yet — salvage buys the list above</span>`
      : `<span class="none">carrying</span> `
        + carried
          .map((c) => `<span class="carried">${c.name}${c.stacks > 1 ? ` x${c.stacks}` : ""}</span>`)
          .join(" · ");
  }

  /** The refit bay: three sockets and the module list. */
  #bayPanel(economy, modules) {
    cls(this.bay, this.bayOpen ? "panel show" : "panel");
    if (!this.bayOpen || !modules) return;

    const entries = economy?.moduleEntries ?? modules.entries;
    const signature = [
      Math.floor(economy?.scrap ?? 0), modules.sockets.join(","), economy?.moduleCredits ?? 0,
      ...entries.map((e) => `${e.fitted}:${e.cost}:${e.affordable ? 1 : 0}`),
    ].join("|");
    if (signature === this.baySignature) return;
    this.baySignature = signature;

    this.baySockets.innerHTML = modules.summary
      .map((name, i) => `<div class="socket ${name === "EMPTY" ? "" : "filled"}">`
        + `HARDPOINT ${i + 1}<br>${name}</div>`)
      .join("");

    this.bayItems.innerHTML = entries.map((e) => {
      const state = e.affordable ? "can" : "cant";
      const count = e.fitted > 0 ? ` x${e.fitted}` : "";
      const price = e.cost === 0 ? "FREE" : `${e.cost} scrap`;
      return `<div class="item ${state}">`
        + `<span><span class="key">${e.key.replace("Digit", "")}</span> `
        + `<span class="nm">${e.name}${count}</span><br>`
        + `<span class="dt">${e.detail}</span></span>`
        + `<span class="px">${price}</span>`
        + `</div>`;
    }).join("");

    this.bayScrap.textContent = String(Math.floor(economy?.scrap ?? 0));
  }

  /**
   * The free salvage pick — paid every couple of waves, and again for holding a
   * siege.
   *
   * Driven off `economy.pickOpen`, never the run's phase. Two reasons, and the second
   * one was a bug waiting: the panel must not be up with nothing in it, because the one
   * thing it can never do is ask for a keypress that does nothing — and a mid-siege
   * pick leaves the run's phase at SIEGE, so a phase check would have hidden exactly
   * the picks this cadence exists to deliver.
   *
   * `pickOpen` rather than `pendingPick.length` because the panel must also not be up
   * at a moment the pick cannot be taken. It is a 680 px menu on the bottom-centre
   * anchor, and it arrived the instant a wave resolved, which is frequently while the
   * remains of that wave are still on you. Same window as the shop, same reason, and
   * the rule is computed in economy.js so it has a test behind it.
   */
  #pickPanel(economy) {
    const offers = economy?.pickOpen ? economy.pickEntries : [];
    const open = offers.length > 0;
    cls(this.pick, open ? "panel show" : "panel");
    if (!open) return;

    const signature = offers.map((e) => e.index).join(",");
    if (signature === this.pickSignature) return;
    this.pickSignature = signature;

    this.pickHead.textContent = `SALVAGE — TAKE ONE OF ${offers.length}`;
    this.pickItems.innerHTML = offers.map((e, i) => `<div class="it">`
      + `<div class="rn"><span class="key">${i + 1}</span> ${e.name}</div>`
      + `<div class="rd">${e.detail}</div>`
      + `<div class="rr ${e.rarity}">${e.rarity}</div>`
      + (e.stacks > 0 ? `<div class="rs">you carry ${e.stacks}</div>` : "")
      + `</div>`).join("");
  }

  /**
   * What the crosshair is on, and how much of it is left.
   *
   * Polled from `weapon.aimTarget`, which the simulation rescans every frame and
   * clips on geometry exactly as a shot would — so something standing behind the
   * hull correctly reads as no target rather than as one you cannot hit.
   *
   * The armour line is the point of this as much as the bar is. A bulwark carries
   * flat armour 20 against a 25-damage rifle, which is the design saying "wrong
   * tool", and the game had no way of saying it out loud: a playtester who had
   * fought them for an hour still described one as "the grey creature, the tank",
   * and could not tell a five-damage hit from a bug.
   */
  #targetPanel(weapon) {
    const e = weapon?.aimTarget;
    if (!e || !e.alive) {
      cls(this.target, "");
      return;
    }

    const cfg = enemyCfg(e.type);
    // Three states, not two, and the third is the one that teaches something.
    //
    // A bulwark's plate is only on its front, and a rule nobody is ever told about is
    // a rule nobody plays around: a player who never happens to walk behind one would
    // never learn the flank exists. So the line reports the armour actually in the way
    // RIGHT NOW — ARMOURED head-on, flipping to EXPOSED the moment you get behind it,
    // in the same place, while you are looking at the thing.
    //
    // `weapon.aimArmour` already has sabot rounds subtracted, so a build that bought
    // its way past armour also stops being nagged about it.
    const inTheWay = weapon.aimArmour ?? cfg.armour;
    const exposed = cfg.armour > 0 && inTheWay <= 0;

    // The state classes go on the CONTAINER rather than on the line, because `set`'s
    // third argument rewrites className to "v ..." and would drop the styling class
    // off an element that is not one of the diagnostics rows.
    cls(this.target, `show${e.hp < e.maxHp ? " hurt" : ""}${exposed ? " open" : ""}`);

    set(this.targetName, cfg.label);
    set(
      this.targetArmour,
      cfg.armour <= 0 ? "" : exposed ? "ARMOUR EXPOSED" : `ARMOURED ${Math.round(inTheWay)}`,
    );
    fill(this.targetBar, e.hp / Math.max(e.maxHp, 1e-6));
  }

  /**
   * The live conditional bonus: how much extra damage the rifle is doing right now,
   * and which items are the reason.
   *
   * This is the other half of the build readout, and it is a separate thing on
   * purpose. The refit panel answers "what have I got", between waves, when you are
   * choosing. This answers "why is my damage different this second", during a fight,
   * which is the only question a conditional item raises — "+30% beneath the hull"
   * with no feedback is indistinguishable from an item that does nothing, and the two
   * items that pay for MOVING between deck and ground are the last things in the pool
   * that should be invisible.
   *
   * Up only while something is actually live, like the prompt and the telegraph, so
   * it is not a panel and does not join the count of things always on screen.
   */
  #buffStrip(items) {
    const live = !!items && items.bonus > 0 && items.reasons.length > 0;
    cls(this.buffs, live ? "show" : "");
    if (!live) return;
    set(this.buffGain, `+${Math.round(items.bonus * 100)}%`);
    set(this.buffWhy, items.reasons.join(" · "));
  }

  /**
   * Road choice at a landmark. Only up while the run is actually asking.
   *
   * Steps aside for a pending pick, because the two share a screen anchor and the
   * router gives the pick the keys. An untaken mid-siege pick is still pending when
   * the last wave falls, so this pair genuinely overlaps now.
   */
  #routePanel(run, economy) {
    const open = !!run?.choosing && (economy?.pendingPick?.length ?? 0) === 0;
    cls(this.route, open ? "panel show" : "panel");
    if (!open) return;

    const signature = run.offers.map((r) => r.id).join(",");
    if (signature === this.routeSignature) return;
    this.routeSignature = signature;

    const nextLeg = run.leg + 1;
    const bossNext = nextLeg >= CFG.run.legs;
    this.routeHead.textContent = bossNext
      ? "CHOOSE THE ROAD — THE LAST ONE"
      : `CHOOSE THE ROAD — LANDMARK ${nextLeg} OF ${CFG.run.legs}`;

    this.routeItems.innerHTML = run.offers.map((r, i) => {
      const { costs, pays } = describeRoad(r);
      return `<div class="road">`
        + `<div class="rn"><span class="key">${i + 1}</span> ${r.name}</div>`
        + `<div class="rd">${r.detail}</div>`
        + `<div class="rc">${costs.join(" · ")}</div>`
        + `<div class="rp">pays ${pays.join(" · ")}</div>`
        + `</div>`;
    }).join("");

    // What the roads already taken have done, above the two on offer.
    //
    // This is the answer to "when I press one, does it matter?" — it does, permanently
    // and cumulatively, and until now nothing ever said so. Showing it HERE rather than
    // as a standing HUD row is deliberate: it is not something you act on mid-fight, it
    // is context for the choice being made, and it costs no always-visible space.
    const carried = run.modifiers;
    this.routeCarried.innerHTML = carried.length === 0
      ? `<span class="none">the roads so far have cost you nothing</span>`
      : `<span class="none">carrying, for the rest of the biome:</span> `
        + `<span class="rw">${carried.join(" · ")}</span>`
        + (run.roadsTaken.length
          ? ` <span class="none">(${run.roadsTaken.join(" → ")})</span>` : "");
  }

  #showTelegraph(head, sub, frac, boss) {
    if (this.telegraphHead.textContent !== head) this.telegraphHead.textContent = head;
    if (this.telegraphSub.textContent !== sub) this.telegraphSub.textContent = sub;
    fill(this.telegraphBar, frac);
    cls(this.telegraph, boss ? "show boss" : "show");
  }

  #hideTelegraph() {
    cls(this.telegraph, "");
  }

  /**
   * Diagnostics are off by default. Nine panels were on screen at once, two of
   * them overlapping into unreadable mush, and the effect of showing everything
   * was that none of it got read. What stays up while playing is only what a
   * player acts on; everything for whoever is tuning the thing lives here.
   */
  toggleDiagnostics() {
    this.diagnostics.classList.toggle("show");
  }

  toggleHelp() {
    this.help.classList.toggle("hidden");
  }

  /** Returns the new state, so the caller knows who owns the number keys. */
  toggleBay() {
    this.bayOpen = !this.bayOpen;
    this.baySignature = "";
    this.shopSignature = "";
    return this.bayOpen;
  }

  closeBay() {
    this.bayOpen = false;
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
    cls(this.prompt, state ? `show ${state}` : "show");
  }

  update(ctx) {
    const {
      player, trampler, grapple, horde, director, weapon, repair, emitters,
      economy, modules, run, items, events, gun, fps, renderer, post, dt = 0,
    } = ctx;
    this.#shopPanel(economy, run);
    this.#bayPanel(economy, modules);
    this.#pickPanel(economy);
    this.#routePanel(run, economy);
    this.#buffStrip(items);
    this.#targetPanel(weapon);

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
    // Whether the CC0 art actually loaded. Worth a readout: a fresh clone that has
    // not run the fetch script plays perfectly in flat colours, and without this
    // there is no way to tell that from a broken texture path.
    set(this.el.assets, Look.status, Look.ready ? "on" : "off");
    set(this.el.burrowed, String(horde.burrowed ?? 0), (horde.burrowed ?? 0) > 0 ? "bad" : "");

    // Proc counters. Instrumentation, deliberately: "has that item ever fired" is a
    // tuning question, and a chance-based effect is exactly the kind of thing that
    // can be wired up wrong and still look plausible in play.
    //
    // The chain depth is here too, because a splash that kills re-enters its own
    // listener and the interesting question about a proc build is not how often it
    // fires but how far it cascades. `x4!` means the cap is biting, which is a
    // balance signal rather than a fault — the cap exists so that case is bounded
    // instead of a blown stack.
    if (items) {
      const p = items.procs;
      const total = p.fragment + p.arc + p.executioner;
      const chain = events ? ` · x${events.deepest}${events.suppressed > 0 ? "!" : ""}` : "";
      set(
        this.el.procs,
        `${p.fragment} frag · ${p.arc} arc · ${p.executioner} exec${chain}`,
        total > 0 ? "on" : "",
      );
    }

    // Render cost, which is what a low frame rate is actually about. Draw calls are
    // the number that mattered: the first build ran ~1410 a frame against 55k
    // triangles, which is a CPU-bound scene, and no amount of simplifying geometry
    // would have helped.
    if (renderer?.info) {
      const i = renderer.info.render;
      set(
        this.el.draws,
        `${i.calls}  (${Math.round(i.triangles / 1000)}k tris)`,
        i.calls > CFG.render.maxDrawCalls ? "bad" : "on",
      );
    }
    if (post) {
      set(this.el.post, post.status, post.enabled ? "on" : "off");
      set(this.el.exposure, post.exposure.toFixed(2));
    }

    // ---- combat
    fill(this.el.barHp, player.hp / player.maxHp);
    const reactorFrac = trampler.reactorHp / trampler.maxReactorHp;
    fill(this.el.barReactor, reactorFrac);

    for (let i = 0; i < this.pips.length; i++) {
      const frac = trampler.legHp[i] / CFG.trampler.legHp;
      const c = frac <= 0 ? "pip broken" : frac < 0.5 ? "pip hurt" : "pip";
      if (this.pips[i].className !== c) this.pips[i].className = c;
    }

    const drive = trampler.speedFactor();
    set(
      this.el.drive,
      trampler.immobilised
        ? `${trampler.workingLegs()} · STOPPED`
        : `${trampler.workingLegs()} · ${Math.round(drive * 100)}%`,
      trampler.immobilised ? "bad" : drive < 1 ? "" : "on",
    );

    // Deck gun heat used to have a permanent bar here. It does not need one: the
    // contextual prompt's progress bar is literally `1 - gun.heat` while a gun is
    // manned, and the prompt says OVERHEATED in words when it is. Two readouts of one
    // number, one of them always on screen for a state that only exists while you are
    // sitting in a mount.

    if (emitters) {
      const ready = emitters.canDeploy(player);
      set(
        this.el.emitters,
        `${emitters.available} / ${emitters.capacity}`,
        ready ? "on" : emitters.available <= 0 ? "off" : "",
      );
    }

    // The purses. Salvage rises on every kill and scrap only when a wave resolves, so
    // seeing them apart is also the clearest statement invariant 22 has: one of these
    // you earned alone, and the other the crew earned together.
    if (economy) {
      set(this.el.purseSalvage, String(Math.floor(economy.salvage)),
        economy.open ? "on" : "");
      set(this.el.purseScrap, String(Math.floor(economy.scrap)),
        economy.open ? "on" : "");
    }

    if (run) {
      set(
        this.el.leg,
        run.done ? "COMPLETE" : `${run.leg} / ${CFG.run.legs}${run.isBossLeg ? " · FINAL" : ""}`,
        run.isBossLeg ? "bad" : "",
      );
    }

    // ---- contextual prompt
    //
    // Priority order matters, and it is: the road you are being asked to choose,
    // then the gun you are standing at, then the repair under your hands. Standing
    // at a mount and standing at a repair point are never the same place, so those
    // two cannot both be true, but a road choice can overlap either.
    if (economy?.pickOpen) {
      this.#prompt(`1-${economy.pendingPick.length}`, "TAKE SALVAGE", 1);
    } else if (run?.choosing) {
      this.#prompt("1-2", "CHOOSE A ROAD", 1);
    } else if (gun?.mounted) {
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
    } else if (horde.fusesLit > 0) {
      // A sapper is a timer, and a timer nobody can see is just a leg that
      // randomly failed. This is the only warning, so it outranks silence.
      this.#prompt(
        `${horde.fuseWarning.toFixed(1)}s`,
        horde.fusesLit > 1 ? `${horde.fusesLit} CHARGES SET — GET UNDER THE HULL` : "CHARGE SET — GET UNDER THE HULL",
        horde.fuseWarning / Math.max(CFG.enemies.sapper.fuse, 0.001),
        "blocked",
      );
    } else if (economy?.pendingPick?.length) {
      // A pick is banked but this is not a moment to read three items in. Lowest
      // priority on purpose — everything above it is something to do RIGHT NOW, and
      // this is the opposite: a reward that is already yours and cannot be lost.
      //
      // It has to be said at all, though. Making the panel wait without saying so
      // would mean the player earned something and simply never found out, which is
      // the same illegibility this whole update is about rather than a fix for it.
      this.#prompt("1-3", "SALVAGE BANKED — TAKE IT WHEN CLEAR", 1);
    } else if (this.prompt.className !== "") {
      cls(this.prompt, "");
    }

    // Shown as progress toward the siege, not a bare count. The number only means
    // something if you can see what it is counting toward.
    set(
      this.el.wave,
      `${director.wave} / ${director.siegeLength}`,
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
        pace = economy?.pendingPick?.length
          ? "take salvage"
          : run?.choosing ? "choose a road" : "siege held";
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
      const boss = director.nextIsBoss;
      this.#showTelegraph(
        boss
          ? "SIEGEBREAKER INBOUND"
          : next >= director.siegeLength
            ? "FINAL WAVE INCOMING"
            : `WAVE ${next} OF ${director.siegeLength} INCOMING`,
        boss
          ? `${director.bearingLabel}  ·  ${Math.ceil(director.timer)}s  ·  TOO TALL FOR THE HULL'S SHADOW`
          : `${director.bearingLabel}  ·  ${Math.ceil(director.timer)}s`,
        1 - director.timer / CFG.waves.prepTime,
        boss,
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

    this.#feedback(player, trampler, weapon, horde, grapple, reactorFrac, dt);
  }

  /**
   * Screen-space feedback: damage flash, reactor alarm, crosshair state.
   *
   * All driven off COUNTERS the simulation already keeps, polled here rather than
   * pushed from there. The alternative -- sim modules calling into the HUD -- is
   * what makes a simulation untestable headless.
   */
  #feedback(player, trampler, weapon, horde, grapple, reactorFrac, dt) {
    // Damage flash, triggered by the hurt counter rather than by watching health.
    // Watching health misses a hit that regeneration has already covered, and it
    // fires spuriously when max health changes on a vitals purchase.
    if (player.hurtCount !== this.lastHurtCount) {
      this.lastHurtCount = player.hurtCount;
      this.dmgTimer = 0.4;
      this.dmg.style.opacity = String(Math.min(0.9, 0.25 + player.lastHurt / 60));
    } else if (this.dmgTimer > 0) {
      this.dmgTimer -= dt;
      if (this.dmgTimer <= 0) this.dmg.style.opacity = "0";
    }

    // The reactor alarm is the one thing allowed to take over the whole frame,
    // because losing it ends the run and it is the single event a player cannot
    // afford to miss while looking the wrong way.
    const alarming = reactorFrac < 0.5 && !trampler.destroyed;
    cls(this.alarm, alarming ? "on" : "");

    // Crosshair: grapple validity AND weapon state. It used to report only the
    // winch, which became actively misleading the moment the left button started
    // firing -- a grey crosshair meant "grapple cooling", and players read it as
    // "cannot shoot".
    let c = "";
    if (grapple.active) c = "";
    else if (grapple.cooldown > 0) c = "cooling";
    else if (grapple.aimValid) c = "valid";

    if (weapon.cooldown > 0 && !c) c = "reload";
    if (horde.killCount !== this.lastKills) {
      this.lastKills = horde.killCount;
      this.killFlash = 0.12;
    }
    this.killFlash = Math.max(0, this.killFlash - dt);
    if (weapon.hitFlash > 0) c = `${c} hit`.trim();
    if (this.killFlash > 0) c = `${c} kill`.trim();
    cls(this.crosshair, c);
  }
}
