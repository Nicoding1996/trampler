import * as THREE from "three";
import { CFG, applyReleasePreset, applyEnemySpeedScale } from "./config.js";
import { clamp } from "./util.js";
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
import { Hud } from "./hud.js";

const canvas = document.getElementById("c");
const gate = document.getElementById("gate");
const gateErr = document.getElementById("gate-err");

function boot() {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(85, innerWidth / innerHeight, 0.1, 1400);
  camera.rotation.order = "YXZ";

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

  // Whichever mount the HUD should be talking about: the manned one, else the
  // one you are standing next to.
  const activeGun = () =>
    guns.find((g) => g.mounted) ?? guns.find((g) => g.canMount) ?? null;

  const input = new Input(canvas, gate);
  const hud = new Hud();

  // Raycasting needs current world matrices. The renderer only refreshes them
  // at draw time, which is after the frame's grapple cast, so seed them once
  // here -- the terrain is static, so a single pass is enough for it.
  scene.updateMatrixWorld(true);

  addEventListener("resize", () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });

  function resetEncounter() {
    horde.clear();
    emitters.clear();
    trampler.repairAll();
    // Rewind the patrol too, not just the damage. Spawn bearings derive from the
    // hull's heading, so leaving it mid-patrol makes a restart a different fight
    // from the same seed.
    trampler.resetPose();
    director.reset();
    player.hp = player.maxHp;
    for (const g of guns) {
      g.dismount(player);
      g.heat = 0;
      g.overheated = false;
    }
    player.respawnOnDeck();
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
    if (input.pressed("KeyR")) player.respawnOnDeck();
    if (input.pressed("KeyT")) player.dropToGround();
    // E is held for repair, so calling a wave early moved to Q.
    if (input.pressed("KeyQ")) director.callEarly();
    if (input.pressed("KeyK")) resetEncounter();

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

  // ---- loop ---------------------------------------------------------------
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;
  let lossTimer = 0;

  // The banner is otherwise driven by persistent states and cleared every frame,
  // so a transient message needs its own timer or the next frame erases it.
  let toastTimer = 0;
  let toastHtml = "";
  function toast(html, seconds = 2.5) {
    toastHtml = html;
    toastTimer = seconds;
  }

  const hudCtx = {
    player, trampler, grapple, horde, director, weapon, repair, emitters,
    gun: null, fps: 0,
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

    if (trampler.destroyed) {
      lossTimer += dt;
      hud.showBanner("REACTOR LOST<small>resetting…</small>");
      if (lossTimer > 3.5) resetEncounter();
    } else {
      director.update(dt);
      // A tuning toast briefly outranks the immobilised notice; losing the reactor
      // outranks everything. Holding the siege outranks everything except a loss,
      // and unlike the others it does NOT auto-reset -- finishing a run should be
      // something you get to sit in, not something the game clears for you.
      if (director.held) {
        hud.showBanner(
          `SIEGE HELD<small>${CFG.waves.siegeLength} waves · press K to run it again</small>`,
        );
      } else if (toastTimer > 0) {
        toastTimer -= dt;
        hud.showBanner(toastHtml);
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
    horde.update(dt, player);
    grapple.updateVisuals(dt);

    world.updateSun(player.position);
    hudCtx.fps = fps;
    hudCtx.gun = activeGun();
    hud.update(hudCtx);

    input.endFrame();
    renderer.render(scene, camera);
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
