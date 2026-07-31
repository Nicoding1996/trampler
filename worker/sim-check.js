// CAN THE REAL SIMULATION RUN INSIDE A DURABLE OBJECT?
//
// A spike, and the same kind as the tick-rate probe: it exists to answer the one
// question that can invalidate the next large piece of work before that work starts.
//
// The plan has the Durable Object running the authoritative simulation. That assumes
// the simulation modules load in workerd, which is NOT Node -- no `fs`, no `process`,
// a different module resolver, and a hard limit on the size of the deployed script.
// Every one of those is a way this fails, and none of them is visible from the
// harness, which runs the same modules in Node where they all work.
//
// Three things to find out, and they have different consequences:
//
//   1. Does it BUNDLE? `three` is ~1 MB of ES module and look.js reaches for addons.
//      wrangler prints the upload size on startup; a Worker has a compressed script
//      limit, so this is a real ceiling rather than a formality.
//   2. Does it LOAD? A module touching `document`, `window` or a Node builtin at
//      import time throws before any of our code runs.
//   3. Does it STEP? Constructing and advancing the real modules is the actual claim.
//
// If any of the three fails, the answer is not "try harder" -- it is that the
// simulation stays on a client and the DO becomes a relay with authority over
// arbitration only. That is a completely different amount of work, which is exactly
// why it is worth an hour now.
//
// Imported dynamically by index.js so that a normal lobby session does not pay for
// any of this, and deliberately kept in one file so deleting it is one delete.

import * as THREE from "three";
import { CFG } from "../src/config.js";
import { World } from "../src/world.js";
import { Trampler } from "../src/trampler.js";
import { Player } from "../src/player.js";
import { Crew } from "../src/crew.js";
import { Horde } from "../src/enemies.js";
import { Director } from "../src/waves.js";
import { Weapon } from "../src/weapon.js";
import { Events } from "../src/events.js";
// From enemies.js, not config.js: the type ids are indices into ENEMY_TYPE_KEYS and
// they are exported alongside the pool that uses them. Reaching for a non-existent
// `ENEMY_TYPE` on CFG once cost a round trip here. That miss predates the expanded
// checks: `npm run audit` now scans worker/, tools/ and server.mjs as well as src/.
import { CHEWER } from "../src/enemies.js";

const STEP = 1 / CFG.loop.stepHz;

// The same 400 test 17 uses. The first version of this spike let the director spawn a
// wave and measured FOUR enemies at 0.3 ms/frame, then reported "comfortable" -- a
// number taken from a load that stresses nothing, which is the exact shape of the
// vacuous measurements this project keeps catching. The worst case is a full pool, so
// the worst case is what gets measured, and it is directly comparable to the harness's
// own figure for the same 400.
const STRESS_POOL = 400;

/**
 * IS THE SPIKE ITSELF CORRECTLY WIRED?
 *
 * Asked separately, before anything is measured, and reported under its own stage —
 * because this file has already produced the one failure that matters most here: a
 * result that lies about which side of the network the fault is on.
 *
 * The crew refactor changed three signatures. `Director`'s third argument became a
 * Crew, and `resolveStomps` and `Horde.update` both went from taking a Player to
 * iterating one. This spike still passed a Player to all three, so `for (const p of
 * crew)` threw "player is not iterable" — inside the try/catch below, which faithfully
 * reported `{ ok: false, stage: "step" }`. Run against a deployed Worker that reads as
 * THE SIMULATION CANNOT RUN IN WORKERD, which is the single answer that would tear up
 * the netcode plan. It actually meant the spike was three arguments stale.
 *
 * So a miswiring gets its own stage and says so in words. `tech.md` has the general
 * form under "Tests that lie": scaffolding that fights the thing it is measuring, and a
 * red result that is wrong is more expensive than no result at all.
 *
 * Static coverage now closes part of this: `npm run audit` and `npm run imports`
 * include worker/, tools/ and server.mjs as well as src/, so this file's CFG paths,
 * imports and named exports are checked. But no static check catches "a Player was
 * passed where a Crew was wanted": both are objects and the call is arity-legal,
 * because `seed` defaults. The only thing that catches it is running this file, which
 * is the argument for running it after any change to a simulation module's signature
 * rather than only before a deploy.
 */
function wiringFault({ crew, player, horde, trampler, director }) {
  if (typeof crew?.worstHealthFraction !== "function") {
    return "crew is not a Crew — Director.#pressureOf calls crew.worstHealthFraction()";
  }
  if (typeof crew[Symbol.iterator] !== "function") {
    return "crew is not iterable — resolveStomps and Horde.update both walk it";
  }
  if (crew.seatOf(player) !== 1) {
    return "the operative is not seated in the crew, so nothing crew-wide can see them";
  }
  if (director.crew !== crew) {
    return "the director was handed something other than the crew";
  }
  // Cheap proof that the crew-wide path actually executes, rather than trusting that a
  // Crew-shaped object satisfies it. Reading pressure walks every term in #pressureOf,
  // which is where the stale Player threw.
  if (!Number.isFinite(director.pressure)) {
    return "director.pressure is not finite, so the crew aggregates are not readable";
  }
  if (!Number.isFinite(horde.liveCount) || !Number.isFinite(trampler.reactorHp)) {
    return "horde or trampler did not construct into a readable state";
  }
  return null;
}

/**
 * Build the real modules, step them, and report what happened.
 *
 * Deliberately mirrors the harness's makeSim() rather than inventing a lighter
 * scaffold: a cut-down version that avoided whichever module turns out to be the
 * problem would report success and prove nothing. `frames` is small by default
 * because the question is "does this execute", not "how fast".
 */
export function simCheck(frames = 120) {
  const t0 = Date.now();
  const report = { ok: false, stage: "start", frames, notes: [] };

  try {
    report.stage = "scene";
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(85, 16 / 9, 0.1, 2000);
    camera.rotation.order = "YXZ";
    scene.add(camera);

    // world.js is the riskiest import: it builds lighting, scatter and a horizon, and
    // it is the module most likely to reach for something only a browser has.
    report.stage = "world";
    const world = new World(scene);

    report.stage = "trampler";
    const trampler = new Trampler(scene);

    report.stage = "player";
    const player = new Player(camera, world, trampler);

    report.stage = "horde";
    const horde = new Horde(scene, trampler);

    report.stage = "wiring";
    const events = new Events();
    horde.events = events;
    const weapon = new Weapon(scene, player, horde, world, trampler);
    weapon.events = events;
    // A crew of one, exactly as the harness's makeSim builds it. The three crew-wide
    // systems take this rather than the operative: pacing aggregates over the crew, a
    // foot crushes whoever is under it, and contact damage hurts whoever is adjacent.
    const crew = new Crew([player]);
    const director = new Director(horde, trampler, crew);

    // Matrices, because the harness does this once after setup and raycasting needs
    // current ones.
    scene.updateMatrixWorld(true);

    // BEFORE the pool is filled and before anything is timed. A stale spike must not be
    // able to present itself as a runtime failure — see wiringFault above.
    const fault = wiringFault({ crew, player, horde, trampler, director });
    if (fault) {
      report.ok = false;
      report.stage = "spike-stale";
      report.error = fault;
      report.note =
        "THIS IS A FAULT IN THE SPIKE, NOT IN THE RUNTIME. The simulation modules"
        + " loaded and constructed; this file is calling them with the wrong arguments."
        + " Nothing about whether a Durable Object can host the simulation follows.";
      return report;
    }

    report.stage = "spawn";
    // Fill the pool directly, exactly as test 17 does. The director is still wired up
    // and stepped below, but relying on it to populate the field would measure
    // whatever it happened to release in the first two seconds.
    for (let i = 0; i < STRESS_POOL; i++) horde.spawn(CHEWER);

    // SCENARIO GUARD before any timing is reported. A pool that failed to fill would
    // still produce a fast, meaningless ms/frame and a confident verdict.
    report.pooled = horde.liveCount;
    if (horde.liveCount < STRESS_POOL) {
      report.ok = false;
      report.stage = "pool";
      report.error = `pool only reached ${horde.liveCount} of ${STRESS_POOL}`;
      return report;
    }

    report.stage = "step";
    // ONE input stub, hoisted out of the timed loop and reused, which is what the
    // harness does with `input: makeInput()`. The previous version built two fresh
    // objects per frame INSIDE the measured region, and the number this file exists to
    // produce is a ms/frame figure that decides an architecture. Allocating inside the
    // thing you are timing is small here and is the wrong habit in the one place the
    // measurement is the whole point.
    const input = stubInput();
    const cpu0 = Date.now();
    for (let i = 0; i < frames; i++) {
      // Same relative order as main.js's simStep and the harness's step(): the hull
      // moves first so everything aboard inherits it, footfalls resolve against where
      // bodies actually are, and the horde reads the hull transform after it has moved.
      // A subset of the game's order, never a reordering of it — audit check 9 exists
      // because that order is load-bearing.
      trampler.update(STEP);
      trampler.resolveStomps(horde, crew);
      director.update(STEP);
      player.update(STEP, input);
      weapon.update(STEP, input);
      horde.update(STEP, crew);
      // Production records after the complete authority tick. Include the same 420-slot
      // write here or this architecture budget omits the server-only rewind cost.
      horde.recordCombatFrame(i + 1);
      input.endFrame();
    }
    const cpuMs = Date.now() - cpu0;

    // THIS CLOCK DOES NOT TICK WHEN DEPLOYED, AND THAT IS NOT A DETAIL.
    //
    // Cloudflare freezes `Date.now()` AND `performance.now()` during synchronous
    // execution as a Spectre mitigation: they advance only after I/O. The loop above is
    // one synchronous run with no I/O in it, so on the deployed Worker `cpuMs` is
    // exactly 0 -- which made `msPerFrame` 0, made `budgetAt60Hz` read "0.0 ms of CPU
    // per wall-clock second", and made tools/sim-check.mjs print
    // "COMFORTABLE -- a DO can host this at 60 Hz" with total confidence, off a
    // measurement of nothing. On the number that decides the architecture.
    //
    // The reason it went unnoticed is the worst available: LOCAL WORKERD ADVANCES
    // TIMERS NORMALLY. So the figure is plausible under `npm run dev:mp` and fabricated
    // against the deployed Worker -- which is the run that was supposed to be the
    // authoritative one, because edge hardware is not a dev machine.
    //
    // So this is reported as a SELF-DESCRIBING measurement rather than as a number.
    // `clockAdvanced` is the honest part: false means "this runtime refused to time
    // itself", and the caller must not turn that into a verdict. The real figure is
    // taken on the CLIENT'S clock by differencing two runs of different lengths, which
    // needs no server clock at all -- exactly the trick worker/index.js already uses
    // for the tick rate, where the same freeze applies and the same comment says so.
    report.clockAdvanced = cpuMs > 0;

    report.stage = "assert";
    const p = player.position;
    const finite = [p.x, p.y, p.z].every(Number.isFinite);

    // Every pooled body finite too, not just the player. One NaN in the crowd is the
    // failure invariant 16 exists for, and a 400-strong pool is where it would appear.
    const crowdFinite = horde.pool.every(
      (e) => !e.alive || [e.x, e.y, e.z].every(Number.isFinite),
    );

    report.ok = finite && crowdFinite && horde.liveCount > 0;
    report.stage = "done";
    // Reported so the reader can see the crew-wide path was actually exercised rather
    // than trusting that it was. One is the solo case and is byte-identical by
    // construction; this number is what will change when the DO seats a real crew.
    report.crew = crew.size;
    report.live = horde.liveCount;
    report.crowdFinite = crowdFinite;
    report.phase = director.phase;
    report.hullMoved = Number(trampler.group.position.length().toFixed(2));
    report.playerFinite = finite;
    report.cpuMsForFrames = cpuMs;
    // Deliberately NOT called msPerFrame any more. It was, and a name that asserts a
    // measurement is what let a frozen clock's zero be read as a fast result. These say
    // what they are: numbers derived from a clock that may not have moved, meaningful
    // only when `clockAdvanced` is true, and corroboration even then.
    report.selfTimedMsPerFrame = cpuMs > 0 ? Number((cpuMs / frames).toFixed(3)) : null;
    report.selfTimedBudgetAt60Hz = report.selfTimedMsPerFrame === null
      ? null
      : `${(report.selfTimedMsPerFrame * 60).toFixed(1)} ms of CPU per wall-clock second`;
    report.wallMs = cpuMs > 0 ? Date.now() - t0 : null;
    report.clockNote = report.clockAdvanced
      ? "this runtime's clock advanced during synchronous execution, so the self-timed"
        + " figure is usable as corroboration (node, or local workerd)"
      : "THIS RUNTIME FROZE ITS CLOCK during the run, so it cannot time itself at all."
        + " Deployed Workers freeze Date.now() and performance.now() outside I/O to"
        + " mitigate Spectre. Use the client-differenced figure from tools/sim-check.mjs;"
        + " a null here is correct behaviour, not a fault.";
  } catch (err) {
    report.ok = false;
    report.error = String(err && err.message ? err.message : err);
    report.stack = String(err && err.stack ? err.stack : "").split("\n").slice(0, 6);
  }

  return report;
}

/**
 * The harness supplies a duck-typed input rather than importing input.js, because
 * input.js binds to `window` at construction. Same trick here, and the same reason
 * it is safe: nothing in the simulation asks for anything else.
 */
function stubInput() {
  return {
    locked: false,
    down: () => false,
    pressed: () => false,
    mouseDown: () => false,
    mousePressed: () => false,
    mouse: { dx: 0, dy: 0 },
    endFrame() {},
  };
}
