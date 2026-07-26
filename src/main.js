import * as THREE from "three";
import {
  CFG, applyReleasePreset, applyEnemySpeedScale, ENEMY_TYPE_KEYS,
} from "./config.js";
import { clamp } from "./util.js";
import { Look } from "./look.js";
import { Input } from "./input.js";
import { World } from "./world.js";
import { Trampler } from "./trampler.js";
import { Player } from "./player.js";
import { Grapple } from "./grapple.js";
import { Horde } from "./enemies.js";
import { Director } from "./waves.js";
import { Weapon } from "./weapon.js";
import { Repair } from "./repair.js";
import { DeckGun, handleStationInput } from "./deckgun.js";
import { Emitters } from "./emitters.js";
import { Economy, routePurchaseInput } from "./economy.js";
import { Modules } from "./modules.js";
import { Run } from "./run.js";
import { Hud } from "./hud.js";
import { createRenderer, Post, Shake } from "./render.js";
import { Fx } from "./fx.js";
import { ViewModel } from "./viewmodel.js";
import { Audio } from "./audio.js";

const canvas = document.getElementById("c");
const gate = document.getElementById("gate");
const gateErr = document.getElementById("gate-err");

const _v = new THREE.Vector3();

function boot() {
  const renderer = createRenderer(canvas);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(85, innerWidth / innerHeight, 0.1, 2000);
  camera.rotation.order = "YXZ";
  // The viewmodel is parented to the camera, and children of a camera are only
  // traversed if the camera itself is in the graph.
  scene.add(camera);

  const world = new World(scene);
  const trampler = new Trampler(scene);
  const player = new Player(camera, world, trampler);
  const grapple = new Grapple(scene, player, trampler, world);
  player.grapple = grapple;

  const horde = new Horde(scene, trampler);
  const director = new Director(horde, trampler, player);
  const weapon = new Weapon(scene, player, horde, world, trampler);
  const repair = new Repair(player, trampler, horde);
  const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
  const emitters = new Emitters(scene, trampler, horde);

  // Modules before Economy: the economy owns the purse that buys them and calls
  // modules.reset() from its own reset. Economy before Run: the run pays arrival
  // bonuses into it. Constructed in dependency order so nothing has to be patched
  // together afterwards.
  const modules = new Modules({ trampler, horde, emitters, guns });
  const economy = new Economy({
    player, trampler, weapon, repair, horde, director, modules,
  });
  const run = new Run(director, horde, economy);

  // Whichever mount the HUD should be talking about: the manned one, else the
  // one you are standing next to.
  const activeGun = () =>
    guns.find((g) => g.mounted) ?? guns.find((g) => g.canMount) ?? null;

  const input = new Input(canvas, gate);
  const hud = new Hud();
  const post = new Post(renderer, scene, camera);
  const shake = new Shake();
  const fx = new Fx(scene, camera);
  const viewmodel = new ViewModel(camera);
  const audio = new Audio();

  // Art is loaded asynchronously and applied to materials that already exist, so
  // the first frames draw in flat colours and then dress themselves. A missing
  // assets/ directory is a visual downgrade and nothing more.
  Look.load(renderer, scene);

  // Sound needs a real user gesture before a browser will allow an AudioContext,
  // and the click-to-play gate is exactly that.
  canvas.addEventListener("pointerdown", () => audio.start());
  gate.addEventListener("click", () => audio.start());

  // Raycasting needs current world matrices. The renderer only refreshes them
  // at draw time, which is after the frame's grapple cast, so seed them once
  // here -- the terrain is static, so a single pass is enough for it.
  scene.updateMatrixWorld(true);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    post.setSize(innerWidth, innerHeight);
  });

  function resetEncounter() {
    horde.clear();
    emitters.clear();
    // Wipes both purses AND reverts every upgrade, and calls modules.reset(), which
    // strips the three hardpoints and restores every module multiplier. Carrying
    // stats across a restart would make each attempt quietly easier, which defeats
    // the seeded fight.
    economy.reset();
    trampler.repairAll();
    // Rewind the patrol too, not just the damage. Spawn bearings derive from the
    // hull's heading, so leaving it mid-patrol makes a restart a different fight
    // from the same seed.
    trampler.resetPose();
    director.reset();
    // After the director, because the run re-seeds its own road stream and then
    // reconfigures the director's siege length for landmark one.
    run.reset();
    world.setFogScale(1);
    player.hp = player.maxHp;
    for (const g of guns) {
      g.dismount(player);
      g.heat = 0;
      g.overheated = false;
    }
    player.respawnOnDeck();
    hud.closeBay();
    hud.hideBanner();
    lossTimer = 0;
  }

  // ---- test-rig toggles -----------------------------------------------------
  // Every knob that could plausibly be the difference between "this feels good"
  // and "this feels awful" is bound to a key, so it can be judged live rather
  // than argued about.
  function toggles() {
    if (input.pressed("KeyP")) trampler.walking = !trampler.walking;
    if (input.pressed("KeyY")) trampler.turning = !trampler.turning;
    if (input.pressed("KeyB")) CFG.trampler.bob = !CFG.trampler.bob;
    if (input.pressed("KeyG")) CFG.grapple.hardpointsOnly = !CFG.grapple.hardpointsOnly;
    if (input.pressed("KeyM")) applyReleasePreset(CFG.releasePreset + 1);
    if (input.pressed("KeyH")) hud.toggleHelp();
    if (input.pressed("Backquote")) hud.toggleDiagnostics();
    if (input.pressed("KeyR")) player.respawnOnDeck();
    if (input.pressed("KeyT")) player.dropToGround();
    // E is held for repair, so calling a wave early moved to Q.
    if (input.pressed("KeyQ")) director.callEarly();
    if (input.pressed("KeyK")) resetEncounter();
    if (input.pressed("KeyN")) {
      toast(`POST-PROCESSING ${post.toggle() ? "ON" : "OFF"}`, 1.2);
    }
    // Brightness, live. A playtest reported being flash-banged, and while the whole
    // lighting chain came down in response, "too bright" is finally a
    // monitor-and-eyes judgement that no measurement settles -- so it gets a knob
    // and a readout, like enemy speed did.
    if (input.pressed("Minus")) {
      toast(`EXPOSURE ${post.adjustExposure(-CFG.render.exposureStep).toFixed(2)}`, 1.2);
    }
    if (input.pressed("Equal")) {
      toast(`EXPOSURE ${post.adjustExposure(+CFG.render.exposureStep).toFixed(2)}`, 1.2);
    }
    if (input.pressed("KeyV")) {
      post.adaptive = !post.adaptive;
      toast(
        `ADAPTIVE RESOLUTION ${post.adaptive ? "ON" : "OFF"}`
        + `<small>currently ${post.status}</small>`,
        1.8,
      );
    }

    const d = CFG.debug;
    if (input.pressed("BracketLeft")) {
      CFG.trampler.speed = clamp(CFG.trampler.speed - d.speedStep, d.minSpeed, d.maxSpeed);
    }
    if (input.pressed("BracketRight")) {
      CFG.trampler.speed = clamp(CFG.trampler.speed + d.speedStep, d.minSpeed, d.maxSpeed);
    }

    if (input.pressed("Comma")) tuneEnemySpeed(-d.enemyScaleStep);
    if (input.pressed("Period")) tuneEnemySpeed(+d.enemyScaleStep);
  }

  // Enemy speed is a feel question that no measurement can answer, so it gets a
  // live knob and an on-screen readout rather than a decided value.
  function tuneEnemySpeed(delta) {
    const r = applyEnemySpeedScale(CFG.debug.enemySpeedScale + delta);
    toast(
      `ENEMY SPEED ${r.scale.toFixed(2)}x<small>chewer ${r.chewer.toFixed(1)} · `
      + `climber ${r.climber.toFixed(1)} m/s · you walk ${CFG.player.walkSpeed}`
      + (r.outrun
        ? ` <br>under the hull's ${CFG.trampler.speed} m/s — they still arrive head-on, `
          + `but the fortress outruns anything it gets past`
        : "")
      + `</small>`,
    );
  }

  /**
   * Hand the number keys to whichever of the three competing panels owns them,
   * then deal with the HUD and world side effects the router deliberately does not.
   *
   * The routing rule itself lives in economy.js so the harness can test it — the
   * harness cannot import this file, so anything decided here is uncovered.
   */
  function handlePurchasing(dt) {
    if (input.pressed(CFG.fortress.toggleKey)) hud.toggleBay();
    // A road choice is a decision the run is blocked on, so the bay gets out of
    // the way rather than sitting underneath it.
    if (run.choosing) hud.closeBay();

    const routed = routePurchaseInput({
      economy, run, bayOpen: hud.bayOpen, input, dt,
    });

    if (routed.arrival) {
      const a = routed.arrival;
      world.setFogScale(run.fogScale);
      toast(
        `${a.name}<small>${a.detail} · +${a.salvage} salvage`
        + ` · +${a.scrap} scrap${a.module ? " · a free module" : ""}`
        + `${a.boss ? " <br>SOMETHING IS WAITING AT THIS ONE" : ""}</small>`,
        4,
      );
    }
  }

  // ---- loop ---------------------------------------------------------------
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;
  let lossTimer = 0;
  let lastStepCount = 0;
  let lastHurtCount = 0;
  let lastKillRef = null;

  // The banner is otherwise driven by persistent states and cleared every frame,
  // so a transient message needs its own timer or the next frame erases it.
  let toastTimer = 0;
  let toastHtml = "";
  function toast(html, seconds = 2.5) {
    toastHtml = html;
    toastTimer = seconds;
  }

  const ctx = {
    player, trampler, grapple, horde, director, weapon, repair, emitters, economy,
    modules, run, guns, input, world, renderer, post,
    gun: null, fps: 0, dt: 0,
  };

  function frame(now) {
    // Clamped so an alt-tab or a stall cannot tunnel the player through the hull.
    const dt = Math.min((now - last) / 1000, 1 / 30);
    last = now;

    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }

    toggles();

    // Order matters: the hull moves first so everything standing on it inherits
    // this frame's motion, the grapple fires before the player so a shot takes
    // effect on the frame it was pressed, the horde reads the hull's transform
    // after it has moved, and visuals update last against a fresh camera.
    trampler.update(dt);
    // Immediately after the hull moves, so a foot that came down this frame
    // resolves against where things actually are.
    trampler.resolveStomps(horde, player);

    if (trampler.destroyed) {
      lossTimer += dt;
      hud.showBanner("REACTOR LOST<small>resetting…</small>");
      if (lossTimer > 3.5) resetEncounter();
    } else {
      director.update(dt);
      run.update();

      // Banner priority, highest first: losing the reactor, finishing the run,
      // being asked to choose a road, a tuning toast, being immobilised. Each one
      // outranks the next because each is a state you can do less about.
      if (run.done) {
        hud.showBanner(
          `BIOME CLEARED<small>${CFG.run.legs} landmarks and the siegebreaker`
          + ` · press K to run it again</small>`,
        );
      } else if (toastTimer > 0) {
        toastTimer -= dt;
        hud.showBanner(toastHtml);
      } else if (run.choosing) {
        // Deliberately blank. The route panel and the contextual prompt both say
        // what to do, and a banner would sit on top of the roads being chosen
        // between.
        //
        // There is no `director.held` branch below this, and that is not an
        // omission: run.update() runs earlier in this same frame and turns a held
        // siege into either CHOOSING or DONE, so `director.held` is never reachable
        // here. A branch for it looked sensible and was dead.
        hud.hideBanner();
      } else if (trampler.immobilised) {
        hud.showBanner("TRAMPLER IMMOBILISED<small>repair a leg to get it walking again</small>");
      } else {
        hud.hideBanner();
      }
    }

    handleStationInput(guns, input, player);
    grapple.handleInput(input);
    player.update(dt, input);
    weapon.update(dt, input);
    for (const g of guns) g.update(dt, input, player, weapon);
    repair.update(dt, input);
    emitters.update(dt, input, player);
    // After the director, so a wave resolved this frame pays this frame.
    handlePurchasing(dt);
    if (economy.lastEvent) {
      const ev = economy.lastEvent;
      toast(
        ev.kind === "bought"
          ? `${ev.name}<small>${ev.detail} · stack ${ev.stacks} · spent ${ev.cost}</small>`
          : `CANNOT BUY<small>${ev.reason}</small>`,
        1.8,
      );
    }
    horde.update(dt, player);
    grapple.updateVisuals(dt);

    world.updateSun(player.position);

    // ---- feel: shake, then everything that reads the camera --------------
    //
    // Shake is applied AFTER player.update, which writes the camera transform
    // outright every frame. Anything added before it is discarded.
    if (trampler.stepCount !== lastStepCount) {
      // Attenuated by distance to the nearest foot that landed, so a leg astern
      // does not shake the view as hard as the one you are standing beside.
      for (const fall of trampler.footfalls) {
        trampler.localToWorld(_v.copy(fall.local));
        shake.addAt(_v, camera, CFG.render.shake.step * (player.base ? 2.2 : 1.4), 34);
      }
      lastStepCount = trampler.stepCount;
    }
    if (trampler.playerStomped) shake.add(CFG.render.shake.stomp);
    if (player.hurtCount !== lastHurtCount) {
      lastHurtCount = player.hurtCount;
      shake.add(CFG.render.shake.hurt);
    }
    // Something big going down. Compared on object identity rather than on the
    // kill counter, because a sapper's charge completing removes it without paying
    // anybody and never touches killCount.
    if (horde.lastKill && horde.lastKill !== lastKillRef) {
      lastKillRef = horde.lastKill;
      const key = ENEMY_TYPE_KEYS[lastKillRef.type];
      if (key === "titan" || key === "bulwark") {
        _v.set(lastKillRef.x, lastKillRef.y, lastKillRef.z);
        shake.addAt(_v, camera, CFG.render.shake.titan, 60);
      }
    }
    shake.update(dt, camera);

    ctx.fps = fps;
    ctx.dt = dt;
    ctx.gun = activeGun();
    viewmodel.update(dt, ctx);
    fx.update(dt, ctx);
    audio.update(dt, ctx);
    hud.update(ctx);

    input.endFrame();
    // Hurt tint on the grade pass rises as health falls. Post-processing, unlike
    // the HUD's damage flash, is about the world looking wrong rather than about a
    // number changing.
    post.render(dt, Math.max(0, 1 - player.hp / player.maxHp) * 0.55);
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}

try {
  boot();
} catch (err) {
  console.error(err);
  gateErr.textContent = `Failed to start: ${err.message}`;
}
