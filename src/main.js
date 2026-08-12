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
import { Crew } from "./crew.js";
import { Grapple } from "./grapple.js";
import { Horde } from "./enemies.js";
import { Director } from "./waves.js";
import { Weapon } from "./weapon.js";
import { Repair } from "./repair.js";
import { DeckGun, handleStationInput } from "./deckgun.js";
import { Emitters } from "./emitters.js";
import {
  Economy, purchaseInputContext, purchaseInputOwner, routePurchaseInput,
} from "./economy.js";
import { Events } from "./events.js";
import { Items } from "./items.js";
import { Modules } from "./modules.js";
import { Run, describeRoad } from "./run.js";
import { Hud } from "./hud.js";
import { CameraPresentation, createRenderer, Post, Shake } from "./render.js";
import { Fx } from "./fx.js";
import { ViewModel } from "./viewmodel.js";
import { Audio } from "./audio.js";
import { Net } from "./net.js";
import { configureRecovery, recoveryInputFor, stepRecovery } from "./recovery.js";
import { resetSession } from "./session.js";

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

  // A crew of one for now. The three systems that ask about the crew as a GROUP take
  // this; everything else still takes the operative directly, because everything else
  // is about one specific person and becomes one instance per person later.
  const crew = new Crew([player]);

  const horde = new Horde(scene, trampler);
  const director = new Director(horde, trampler, crew);
  const weapon = new Weapon(scene, player, horde, world, trampler);
  // Repair takes the crew as well as the operative, and it is the one per-operative
  // system that does: a repair point admits one welder, so it has to be able to ask who
  // else is on it. At one member the answer is always nobody.
  const repair = new Repair(player, trampler, horde, crew);
  const guns = CFG.deckGun.mounts.map((m) => new DeckGun(scene, trampler, m));
  const emitters = new Emitters(scene, trampler, horde);

  // The bus the kill and hit moments publish to. Created before anything that
  // subscribes, and attached to the publishers by assignment so the simulation
  // modules do not have to take it as a constructor argument they may not want --
  // tools/scene-cost.mjs builds a Horde and a Weapon with no bus at all.
  //
  // Listener order is registration order, which is construction order, which is
  // fixed. That is what keeps a build deterministic when several items react to the
  // same kill.
  const events = new Events();
  horde.events = events;
  weapon.events = events;

  // Modules before Economy: the economy owns the purse that buys them and calls
  // modules.reset() from its own reset. Economy before Run: the run pays arrival
  // bonuses into it. Constructed in dependency order so nothing has to be patched
  // together afterwards.
  const modules = new Modules({ trampler, horde, emitters, guns });
  const economy = new Economy({
    player, trampler, weapon, repair, horde, director, modules, events,
  });
  // After the economy, because it reads stack counts from it. Subscribes to the bus
  // for its procs and rebuilds the conditional damage bonus every frame.
  const items = new Items({
    economy, player, trampler, weapon, horde, repair, events,
  });
  // Note the dependency runs one way only: Items reads the economy's stack counts,
  // and the economy has no idea Items exists. There was a back-reference here for a
  // while and nothing ever read it -- the shop, the pick panel and the build readout
  // are all driven off the catalogue and `stacks`, so the economy never needs to ask
  // the runtime anything.
  // The crew, because the road is put to it. At one member a majority is one keypress.
  const run = new Run(director, horde, economy, crew);

  // Whichever mount the HUD should be talking about: the one THIS operative is in,
  // else the one they are standing next to.
  //
  // `player.station` rather than a search for an occupied gun, for the reason
  // handleStationInput gives at length: with a crew, "the manned one" is a question
  // about the ship and this is a question about you. The HUD would otherwise draw
  // somebody else's heat bar and offer to dismount a seat you are not sitting in.
  const activeGun = () =>
    player.station ?? guns.find((g) => g.canMount) ?? null;

  const input = new Input(canvas, gate);
  const cameraPresentation = new CameraPresentation(player, input, camera);
  const hud = new Hud();
  const post = new Post(renderer, scene, camera);
  const shake = new Shake();
  const fx = new Fx(scene, camera);
  const viewmodel = new ViewModel(camera, scene);
  const audio = new Audio();
  // Browser-only, like the four above it, and a RELAY rather than multiplayer: it
  // broadcasts where this operative is standing and draws where the others are.
  // Nothing in the simulation knows it exists, and nothing may come to depend on it
  // -- the harness cannot import this file, so a rule that lived here would have no
  // test behind it.
  // The objects a snapshot is applied TO. A bag rather than a growing argument list,
  // because `applySnapshot` already needs four of them and slices 2 and 3 add the horde and
  // the operatives. Built here rather than inside Net so that the one place which knows how
  // this game is wired stays the one place that says so.
  const localOperative = {
    // Filled from the lobby hello before the first snapshot. Zero cannot collide with a real
    // seat and lets sparse IDs remain identities rather than array positions.
    seat: 0, player, weapon, grapple, repair, items, economy, input, bayOpen: false,
  };
  const localSim = {
    scene, camera, world, trampler, player, crew, grapple, horde, director, weapon,
    repair, guns, emitters, modules, economy, items, run, events, input,
    operatives: [localOperative],
    recoveryTargets: [],
    treasury: economy.treasury,
    networked: false,
    autoReset: false,
    resetId: 0,
    lossTimer: 0,
  };
  const net = new Net(scene, player, trampler, localSim);
  // Number-key ownership is part of the edge, not of the later fixed step that sends it.
  // A snapshot may change the run between those moments, so resolve against the panel that
  // was visible in the DOM keydown event. Solo keeps no metadata and routes exactly as before.
  input.setPurchaseOwnerResolver((code) => {
    if (!net.multiplayer || !CFG.economy.keys.includes(code)) return undefined;
    return {
      owner: purchaseInputOwner({
        economy,
        run,
        bayOpen: localOperative.bayOpen,
      }),
      context: purchaseInputContext(localSim.resetId, run),
    };
  });

  // Art remains optional, but play now waits until every available map is decoded, uploaded
  // and represented in a compiled shader. Rendering continues behind the gate, so the page is
  // responsive and the post chain warms while this runs; only control ownership is withheld.
  gate.classList.add("loading");
  gate.dataset.loading = "LOADING ART...";
  gate.setAttribute("aria-busy", "true");
  const artLoad = Look.load(renderer, scene);

  // A failed optional warm-up already falls back to lazy rendering. Give a promise that never
  // settles the same escape route: vendored local art should never consume this thirty-second
  // backstop, but a suspended rAF or wedged driver must not make the play gate permanent.
  const graphicsReadyBy = performance.now() + 30_000;
  const adaptiveWasEnabled = post.adaptive;
  post.adaptive = false;

  function beforeGraphicsDeadline(stage, work) {
    const remaining = graphicsReadyBy - performance.now();
    if (remaining <= 0) {
      return Promise.reject(new Error(`graphics warm-up timed out during ${stage}`));
    }

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`graphics warm-up timed out during ${stage}`));
      }, remaining);
    });
    return Promise.race([Promise.resolve().then(work), timeout])
      .finally(() => clearTimeout(timer));
  }

  const nextPaint = (stage) => beforeGraphicsDeadline(
    stage,
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );

  async function prepareGraphics() {
    try {
      await beforeGraphicsDeadline("art loading", () => artLoad);

      // A TextureLoader callback means the image is decoded, not that WebGL has uploaded it.
      // Force that last step under the gate instead of charging whichever gameplay frame first
      // sees the material. The HDR background and PMREM are included defensively; PMREM normally
      // initializes both while building the environment, and initTexture is idempotent.
      const textures = new Set();
      for (const set of Look.textures.values()) {
        for (const texture of Object.values(set)) {
          if (texture?.isTexture) textures.add(texture);
        }
      }
      if (scene.background?.isTexture) textures.add(scene.background);
      if (Look.env?.isTexture) textures.add(Look.env);

      if (textures.size > 0) {
        let uploaded = 0;
        gate.dataset.loading = `PREPARING TEXTURES ${uploaded}/${textures.size}`;
        await nextPaint("texture preparation");
        for (const texture of textures) {
          renderer.initTexture(texture);
          uploaded++;
          // One PBR set per paint. This keeps the loading indicator alive on a slow GPU
          // without spreading uploads into interactive play.
          if (uploaded % 3 === 0 || uploaded === textures.size) {
            gate.dataset.loading = `PREPARING TEXTURES ${uploaded}/${textures.size}`;
            await nextPaint("texture preparation");
          }
        }
      }

      // compileAsync traverses hidden meshes too, so this prepares tracers, impacts and the
      // grapple as well as what the start camera can see. Compile twice because the muzzle light
      // changes the active point-light count on a shot, which selects a different standard-
      // material program. Fx would normally hide an expired flash each frame, so hold its timer
      // open while the four-light variant finishes compiling.
      gate.dataset.loading = "PREPARING SHADERS 1/2";
      await nextPaint("shader preparation");
      await beforeGraphicsDeadline(
        "the first shader pass",
        () => renderer.compileAsync(scene, camera),
      );

      const lightVisible = fx.muzzleLight.visible;
      const lightIntensity = fx.muzzleLight.intensity;
      const lightTimer = fx.muzzleTimer;
      fx.muzzleLight.visible = true;
      fx.muzzleLight.intensity = 0;
      fx.muzzleTimer = Infinity;
      gate.dataset.loading = "PREPARING SHADERS 2/2";
      try {
        await nextPaint("shader preparation");
        await beforeGraphicsDeadline(
          "the muzzle-light shader pass",
          () => renderer.compileAsync(scene, camera),
        );
      } finally {
        fx.muzzleLight.visible = lightVisible;
        fx.muzzleLight.intensity = lightIntensity;
        fx.muzzleTimer = lightTimer;
      }
    } catch (err) {
      // Warm-up is a performance feature, never a startup requirement. The renderer's ordinary
      // lazy path remains a working fallback just as flat materials remain one for missing art.
      console.warn(`[startup] graphics warm-up unavailable: ${err.message}`);
    } finally {
      // Upload and compile stalls describe startup, not sustainable frame cost. Start the
      // adaptive scaler with a clean history, then let queued lobby admission and pointer lock
      // become available from the same readiness transition.
      post.resetAdaptiveSamples();
      post.adaptive = adaptiveWasEnabled;
      input.setReady();
      net.setGraphicsReady();
    }
  }
  prepareGraphics();

  // Sound needs a real user gesture before a browser will allow an AudioContext,
  // and the click-to-play gate is exactly that. A loading click is not that gesture:
  // it neither owns control nor starts work the player cannot yet hear.
  canvas.addEventListener("pointerdown", () => {
    if (input.ready) audio.start();
  });
  gate.addEventListener("click", () => {
    if (input.ready) audio.start();
  });

  // AND TELL THE SERVER TO BEGIN, which is the message that makes anything shared at all.
  //
  // The Durable Object builds its authoritative world on `start` and on nothing else. Without
  // this line it stayed a lobby: no snapshots, every client running its own complete simulation,
  // two tabs playing two separate games. That was the state through four slices of otherwise
  // working netcode, because the only thing that had ever sent `start` was the smoke test.
  //
  // Bound to the same gesture as the mixer, and for the same reason: clicking the gate is the
  // one unambiguous "I am ready to play". The explicit current host alone may start, and
  // `net.start()` also holds the gesture until at least one crewmate is present.
  gate.addEventListener("click", () => {
    if (input.ready) net.start();
  });
  canvas.addEventListener("pointerdown", () => {
    if (input.ready) net.start();
  });

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
    resetSession(localSim);
    hud.closeBay();
    hud.hideBanner();
    lossTimer = 0;
  }

  // ---- test-rig toggles -----------------------------------------------------
  // Every knob that could plausibly be the difference between "this feels good"
  // and "this feels awful" is bound to a key, so it can be judged live rather
  // than argued about.
  function toggles() {
    // Presentation controls stay local in every mode: they alter neither the authoritative
    // simulation nor any value prediction depends on.
    if (input.pressed("KeyH")) hud.toggleHelp();
    if (input.pressed("Backquote")) hud.toggleDiagnostics();
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

    // Every remaining toggle mutates simulation state or a CFG value prediction reads.
    // In multiplayer its edge must remain untouched for readInput(), or be ignored entirely;
    // consuming it here would either fork the client or prevent the authority seeing Q/K.
    if (net.multiplayer) return;

    if (input.pressed("KeyP")) trampler.walking = !trampler.walking;
    if (input.pressed("KeyY")) trampler.turning = !trampler.turning;
    if (input.pressed("KeyB")) CFG.trampler.bob = !CFG.trampler.bob;
    if (input.pressed("KeyG")) CFG.grapple.hardpointsOnly = !CFG.grapple.hardpointsOnly;
    if (input.pressed("KeyM")) applyReleasePreset(CFG.releasePreset + 1);
    if (input.pressed("KeyR")) player.respawnOnDeck();
    if (input.pressed("KeyT")) player.dropToGround();
    // Q is routed inside simStep after recovery has claimed this frame's hands.
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

  // The authority publishes a new object only when road history changes. Remember that
  // identity so a snapshot-driven client shows the arrival once rather than once per step.
  // Resetting the run clears `lastArrival`, which re-arms the edge for the next attempt.
  let shownArrival = null;

  function showArrival(a) {
    world.setFogScale(run.fogScale);
    // Names the COST as well as the payout, and both through the same describer the
    // route panel used a moment ago, so the banner cannot promise something the panel
    // did not. It used to list only the money, which is why a playtester pressed 1,
    // got paid, and concluded the choice had done nothing.
    const { costs, pays } = describeRoad(a.road);
    toast(
      `ARRIVED — ${a.name}`
      + `<small>${costs.join(" · ")}, for the rest of the biome`
      + `<br>paid ${pays.join(" · ")}`
      + `${a.boss ? "<br>SOMETHING IS WAITING AT THIS ONE" : ""}</small>`,
      4.5,
    );
  }

  /**
   * Hand the number keys to whichever of the three competing panels owns them,
   * then deal with the HUD and world side effects the router deliberately does not.
   *
   * The routing rule itself lives in economy.js so the harness can test it — the
   * harness cannot import this file, so anything decided here is uncovered.
   */
  function handlePurchasing(dt, actionInput = input) {
    // The authority owns every purchase, vote, pick and bay toggle. The client predicts only
    // the bay's visibility, then adopts the operative bit repeated by each snapshot.
    if (net.multiplayer) {
      if (actionInput.pressed(CFG.fortress.toggleKey)) {
        localOperative.bayOpen = !localOperative.bayOpen;
      }
      if (run.choosing || run.picking) localOperative.bayOpen = false;
      hud.setBayOpen(localOperative.bayOpen);

      // Road votes resolve on the authority, so there is no local `routed.arrival` to draw.
      // `applySnapshot` reconstructs this edge from road history; consuming it here keeps the
      // multiplayer route decision as legible as the unchanged solo path.
      if (!run.lastArrival) {
        shownArrival = null;
      } else if (run.lastArrival !== shownArrival) {
        shownArrival = run.lastArrival;
        showArrival(run.lastArrival);
      }
      return;
    }

    if (actionInput.pressed(CFG.fortress.toggleKey)) hud.toggleBay();
    // A pick or a road choice is a decision the run is blocked on, so the bay gets
    // out of the way rather than sitting underneath it.
    if (run.choosing || run.picking) hud.closeBay();

    const routed = routePurchaseInput({
      economy, run, bayOpen: hud.bayOpen, input: actionInput, dt,
    });

    if (routed.took) {
      const t = routed.took;
      toast(`SALVAGED — ${t.name}<small>${t.detail} · now x${t.stacks}</small>`, 3);
    }

    if (routed.arrival) {
      shownArrival = routed.arrival;
      showArrival(routed.arrival);
    }
  }

  // ---- loop ---------------------------------------------------------------
  // The simulation's one and only dt, in seconds and in milliseconds. Held in both
  // units because the accumulator works in milliseconds -- performance.now() is
  // milliseconds, and converting each way per frame is a rounding error nobody
  // needs in the one number that has to be exact.
  const STEP = 1 / CFG.loop.stepHz;
  const STEP_MS = 1000 / CFG.loop.stepHz;
  let accumulator = 0;
  let last = performance.now();
  let controlsSuspended = document.hidden || !document.hasFocus() || !input.locked;
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;
  let lossTimer = 0;

  // A background tab may receive no animation frames at all, then return with seconds of
  // elapsed wall time. Release its authority before throttling begins and discard that gap on
  // return: replaying old W/fire state as a burst is neither prediction nor useful catch-up.
  // Blur, visibility and pointer-lock loss often fire together, so the state bit makes all
  // paths idempotent. Pointer lock is part of ownership: Escape can release it without blur,
  // and that must neutralise the authoritative operative just as quickly as alt-tab does.
  function suspendControls() {
    if (controlsSuspended) return;
    controlsSuspended = true;
    input.clear();
    net.suspendInput();
    accumulator = 0;
  }

  function resumeControls() {
    if (!controlsSuspended || document.hidden || !document.hasFocus() || !input.locked) return;
    controlsSuspended = false;
    input.clear();
    net.resumeFromPause();
    accumulator = 0;
    last = performance.now();
  }

  addEventListener("blur", suspendControls);
  addEventListener("focus", resumeControls);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) suspendControls();
    else resumeControls();
  });
  document.addEventListener("pointerlockchange", () => {
    if (input.locked) resumeControls();
    else suspendControls();
  });

  let lastStepCount = 0;
  let lastHurtCount = 0;
  let lastKillRef = null;
  let lastSwaps = 0;
  let lastRefitCallouts = 0;

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
    modules, run, items, events, guns, input, world, renderer, post,
    gun: null, fps: 0, dt: 0,
  };

  /**
   * ONE FIXED SIMULATION STEP. `dt` is always STEP -- never a measured frame time.
   *
   * Extracted from frame() rather than left inline for two reasons. It is the game's
   * counterpart to verify.mjs's step(), so the two can be read side by side; and
   * audit check 9 compares the per-frame calls in both, which is the only thing
   * standing between "the tests pass" and "the tests test what ships". That check
   * knows to look in here.
   *
   * Order matters, and it is the same order the harness uses: the hull moves first
   * so everything standing on it inherits this step's motion, the grapple fires
   * before the player so a shot takes effect on the step it was pressed, and the
   * horde reads the hull's transform after it has moved.
   *
   * The banner and toast block stays in here rather than moving to the presentation
   * layer because what it reads is simulation state and what it can DO is
   * resetEncounter(). Every branch is either idempotent or guarded by a counter, so
   * a frame that runs two steps cannot double-fire anything.
   */
  function simStep(dt) {
    // WHAT THE SERVER OWNS ONCE A SNAPSHOT HAS ARRIVED.
    //
    // `net.authoritative` is false solo and false until the first snapshot lands, so the solo
    // path through this function is byte-identical to what it always was. Once it is true,
    // four things must NOT run locally, and each one would be a distinct bug:
    //
    //   resolveStomps   deals damage and pays income. Run locally it would kill bodies that
    //                   are alive on the server, and credit a purse the snapshot owns.
    //   director.update advances a phase the snapshot overwrites AND spawns bodies the server
    //                   never spawned, which then vanish on the next correction.
    //   run.update      advances legs and offers picks — run state the server decides.
    //   horde.update    runs enemy AI over positions just handed to this client, so it
    //                   immediately disagrees with the authority and is corrected 20 times a
    //                   second. That is rubber-banding, and it is the relay's own failure at
    //                   a smaller scale.
    //
    // `trampler.update` deliberately still runs. The fortress consumes no input, so a client
    // predicts it exactly rather than approximately — see structure.md on predicting the hull.
    // src/session.js's stepSessionClient is the same list, and verify.mjs section 119 asserts
    // a client moves no enemy of its own accord.
    const authoritative = net.authoritative;

    // The future fallback duration is fixed before a stomp or contact hit can put
    // somebody down. Snapshot targets complete the roster for browser prediction.
    configureRecovery(localSim.operatives, localSim.recoveryTargets);
    trampler.update(dt);
    // Immediately after the hull moves, so a foot that came down this frame
    // resolves against where things actually are.
    if (!authoritative) trampler.resolveStomps(horde, crew);

    // Recovery measures the hull-carried pose and current held E before any other
    // gameplay system can consume it. Raw input remains untouched for networking.
    player.prepareStep(input);
    stepRecovery(localSim.operatives, dt, {
      targets: localSim.recoveryTargets,
      // A multiplayer browser never owns lifecycle outcomes, even before its first
      // baseline or while transport is down. Snapshot availability controls what
      // can be predicted; session role controls who may recover or medevac.
      authoritative: !net.multiplayer,
    });
    const actionInput = recoveryInputFor(player, input);
    if (!authoritative && actionInput.pressed("KeyQ")) director.callEarly();

    if (trampler.destroyed) {
      hud.showBanner("REACTOR LOST<small>resetting…</small>");
      // In multiplayer the shared session owns this timer and reset generation. A local reset
      // would be overwritten by the still-destroyed authority on the very next snapshot.
      if (!authoritative) {
        lossTimer += dt;
        if (lossTimer > CFG.run.resetDelay) resetEncounter();
      }
    } else {
      lossTimer = 0;
      // Both gated: the server owns pacing and the journey. A client running them would be a
      // second spawner for one horde and a second opinion about which landmark this is.
      if (!authoritative) {
        director.update(dt);
        run.update();
      }

      // Banner priority, highest first: losing the reactor, being downed, finishing
      // the run, a tuning toast, then immobilisation. A recovery state must not be
      // hidden by an unrelated transient while the operative has no other actions.
      if (player.downed) {
        const remaining = player.medevacRemaining.toFixed(1);
        const detail = player.rescuerSeat > 0
          ? `CREW ${player.rescuerSeat} RECOVERING`
          : player.recoveryHasCrew
            ? `CREW CAN RECOVER YOU · EMERGENCY RECOVERY IN ${remaining}s`
            : `EMERGENCY RECOVERY IN ${remaining}s`;
        hud.showBanner(`DOWNED<small>${detail}</small>`);
      } else if (run.done) {
        hud.showBanner(
          `BIOME CLEARED<small>${CFG.run.legs} landmarks and the siegebreaker`
          + ` · press K to run it again</small>`,
        );
      } else if (toastTimer > 0) {
        toastTimer -= dt;
        hud.showBanner(toastHtml);
      } else if (economy.pickOpen) {
        // The pick panel says what to do; a banner over it would cover the three
        // things being chosen between. Keyed off `pickOpen` rather than `run.picking`,
        // because a pick is now also paid part-way through a siege, where the phase is
        // still SIEGE -- and rather than off the pick list, because a pick that is
        // banked but waiting for a safe window has no panel to protect.
        hud.hideBanner();
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

    // Look and hull carry were prepared before recovery arbitration. Every gameplay
    // consumer now sees the routed input, while physical input remains available to
    // endFrame() and the network command capture.
    handleStationInput(guns, actionInput, player);
    grapple.handleInput(actionInput);
    player.update(dt, actionInput);
    // Resolve whether work genuinely owns the carried hands before its trigger is read.
    // Progress stays after both weapon paths, preserving the established rule that clearing
    // the final nearby hostile earns full-rate repair on this same frame.
    repair.admit(dt, actionInput);
    weapon.update(dt, actionInput);
    for (const g of guns) g.update(dt, actionInput, player, weapon);
    repair.work(dt);
    // A client updates placement readiness for its prompt, never the rack clocks, placement
    // list, targeting or damage. Those are shared state and advance once on the authority.
    if (authoritative) emitters.updateClient(dt, player);
    else emitters.update(dt, actionInput, player);
    // After repair and the player, so the conditional bonuses are rebuilt from the
    // position and the health this frame actually ENDED with, and before the horde
    // reads anything.
    //
    // Note what that costs, because an earlier version of this comment claimed the
    // opposite: `weapon.update` fires above, so a shot this frame resolves against
    // LAST frame's conditions. That is a deliberate trade rather than an oversight.
    // Rebuilding before the player moves would read the position they started the
    // frame in, which is wrong in the same way but harder to reason about, and every
    // condition in the pool either persists for many frames (under the hull, on a
    // station, low health) or runs on a three-to-five second timer, where a single
    // frame at the start is given back at the end. The HUD is not affected at all --
    // `hud.update` runs after this, so the buff strip is always current.
    items.update(dt);
    // After the director, so a wave resolved this frame pays this frame.
    handlePurchasing(dt, actionInput);
    // Named on the swap, polled from a counter like every other pure reader. The
    // silhouette in your hands is the standing readout for which weapon is up; this
    // is the one moment a WORD is worth more than a shape, because "useless past
    // 20 m" is not something a model can say.
    if (weapon.swaps !== lastSwaps) {
      lastSwaps = weapon.swaps;
      toast(`${weapon.weaponName}<small>${weapon.profile.detail}</small>`, 1.4);
    }
    if (economy.lastEvent) {
      const ev = economy.lastEvent;
      toast(
        ev.kind === "bought"
          ? `${ev.name}<small>${ev.detail} · stack ${ev.stacks} · spent ${ev.cost}</small>`
          : `CANNOT BUY<small>${ev.reason}</small>`,
        1.8,
      );
    }
    // The buy window opened somewhere the console is not visible -- under the hull
    // most of the time, which is the one place the kiosk's lamp cannot reach. Polled
    // off a counter like every other pure reader, and it names the PLACE as well as
    // the state, because "you may buy now" is useless to someone who then has to
    // work out where from.
    if (economy.refitCallouts !== lastRefitCallouts) {
      lastRefitCallouts = economy.refitCallouts;
      toast("REFIT OPEN<small>terminal on the bow bridge</small>", 2.5);
    }
    // Enemy AI, and the one call the server most definitively owns. Skipped when
    // authoritative so a client never argues with the positions it was just handed; the
    // instanced draw is refreshed by the snapshot's own write, not by this.
    if (!authoritative) horde.update(dt, crew);
    // The kiosk advertises whether it is worth crossing the deck, so use the
    // economy's shared safety half rather than `open`, which only becomes true
    // after the player has already arrived. Emissive materials do the signalling;
    // this does not add a light to the scene.
    trampler.setTerminalAvailable(economy.safeMoment);
    // The winch's cooldown, and only that. Same slot the visual call used to occupy,
    // so the timing is unchanged -- what changed is that it now ticks on STEP rather
    // than on however long the last rendered frame took.
    grapple.update(dt);
  }

  /**
   * The rendered frame: absorb real time into whole fixed steps, then draw once.
   *
   * `renderDt` is real elapsed time and is what the presentation layer gets. That
   * split is the point -- particles, camera shake, the mixer and the net client all
   * want wall-clock time, while the simulation must never see anything but STEP.
   */
  function frame(now) {
    // How long the frame ACTUALLY took, unclamped. The renderer's quality scaler
    // needs this one: a clamp would report every slow frame as exactly the clamp,
    // which hides the entire range a scaler is supposed to react to.
    const frameMs = now - last;
    last = now;

    // A network client must not emit the solo loop's full 15-step catch-up burst. Six steps
    // cover an ordinary slow visible frame; focus/visibility resume discards its gap entirely.
    const catchUpMs = net.multiplayer
      ? CFG.net.maxClientCatchUpMs
      : CFG.loop.maxCatchUpMs;
    const absorbMs = Math.min(frameMs, catchUpMs);
    const renderDt = absorbMs / 1000;

    fpsAccum += renderDt;
    fpsFrames++;
    if (fpsAccum >= 0.5) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsAccum = 0;
      fpsFrames = 0;
    }

    if (!controlsSuspended) toggles();

    // THE SERVER'S CORRECTION GOES IN HERE, BEFORE ANY STEP, AND THE ORDER IS THE POINT.
    //
    // `trampler.update` captures the previous frame's inverse transform at its top, and
    // `player.#applyBasedMovement` uses that capture to carry whoever is standing on the
    // deck from the old hull frame into the new one. So a correction applied AFTER a step is
    // read by the following step as though the hull had really travelled that far, and it
    // drags the local operative along with it — measured at 114 cm of deck-relative shove
    // from a one-metre correction, several times a second.
    //
    // Applied first, the step's own capture happens after the correction and the correction
    // is invisible to based movement, which is what it should be: it is bookkeeping, not
    // travel. src/session.js carries the full reasoning, and verify.mjs section 118 asserts
    // the shove is gone.
    //
    // Deliberately NOT inside the accumulator loop. One correction describes one moment; a
    // frame that owes three steps should apply it once and then predict forward three times,
    // which is exactly what a client does between packets anyway.
    net.applyPending(renderDt);
    cameraPresentation.rebase(renderDt);

    if (!controlsSuspended) accumulator += absorbMs;
    let steps = 0;
    while (accumulator >= STEP_MS) {
      accumulator -= STEP_MS;
      // ONE COMMAND PER STEP, WITH THE EDGES ON THE FIRST ONE ONLY.
      //
      // Physical state is CAPTURED before the step, so its sequence, mouse delta and edges
      // describe exactly what prediction consumes. It is SENT after the step, so repair's
      // current-frame admission can commit either repair or fire when both keys are held.
      // That split preserves immediate prediction without allowing authority to invent a
      // fallback shot when a simultaneous remote claim rejects the repair.
      //
      // Edges only on the first step because the local Input holds one set of one-shot presses
      // per frame and `pressed()` consumes them — so exactly one step may legitimately claim
      // them. Repeating them across a multi-step frame would fire one keypress twice on the
      // authority, which is a second grapple or a doubled purchase.
      const waitingForBaseline = net.awaitingAuthority;
      const command = waitingForBaseline ? null : net.prepareInput(input, steps === 0);
      if (!waitingForBaseline) {
        cameraPresentation.beforeStep();
        simStep(STEP);
        cameraPresentation.afterStep();
        const sent = net.sendInput(command);
        // AFTER the step, so what is recorded is the OUTCOME of that command rather than the
        // state before it. Solo steps have no command and therefore no prediction mark.
        if (sent) net.recordPrediction();
      }
      steps++;

      // A physical mouse delta and every one-shot edge belong to ONE fixed step. Clearing
      // immediately after the first completed step preserves transients across zero-step
      // high-refresh frames, but prevents a 30 Hz render frame from applying the same turn to
      // both of its 60 Hz simulation steps.
      if (steps === 1) input.endFrame();
    }

    // Delayed network transforms are presentation only. Gameplay above ran against the newest
    // authority restored by applyPending(); drawing now uses the smooth server-tick cursor.
    net.applyPresentation(renderDt);

    // A release event outlives the simulation state that produced it. Consume it only now,
    // once per rendered frame and after multiplayer has installed the delayed body pose; this
    // is what keeps a shot visible when catch-up steps begin and end FIRING between renders.
    horde.presentSpikerShots(renderDt);

    // Simulation remains fixed-step; only the camera is drawn between its two newest poses.
    // This also restores the unshaken base transform on every rendered frame.
    cameraPresentation.apply(accumulator / STEP_MS);

    // Per rendered frame, not per step: it draws the rope against the camera, and
    // the camera is only final once. Still inside frame() rather than in simStep,
    // which is what audit check 9 compares -- and the harness drives it per step
    // because it has no camera and no renderer to be out of date with.
    grapple.updateVisuals();

    world.updateSun(player.position);

    // ---- feel: shake, then everything that reads the camera --------------
    //
    // Shake is applied AFTER camera presentation has restored the interpolated
    // base transform. It stays additive and keeps the existing impulse tuning.
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
    shake.update(renderDt, camera);

    ctx.fps = fps;
    ctx.dt = renderDt;
    ctx.gun = activeGun();
    // With the other pure readers, and AFTER player.update, so the pose it sends is
    // the position this frame actually ended in rather than the one it started from.
    // It is deliberately not handed `ctx`: it reads the player and the hull directly,
    // so it never becomes a fifth reader the frame context has to satisfy.
    net.update(renderDt);
    viewmodel.update(renderDt, ctx);
    fx.update(renderDt, ctx);
    audio.update(renderDt, ctx);
    hud.update(ctx);

    // Hurt tint on the grade pass rises as health falls. Post-processing, unlike
    // the HUD's damage flash, is about the world looking wrong rather than about a
    // number changing.
    post.render(renderDt, Math.max(0, 1 - player.hp / player.maxHp) * 0.55, frameMs);
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
