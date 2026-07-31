// Ask a LOCAL running Worker whether the real simulation can load and step inside it,
// and how much it costs per frame there.
//
//   npm run dev:mp                    (in one terminal)
//   node tools/sim-check.mjs
//
// This is the spike that decides whether the Durable Object runtime can host the
// authoritative simulation, or whether the simulation has to stay on a client and the
// DO becomes an arbitrator. worker/sim-check.js has the reasoning; this file's job is
// to exercise that runtime boundary and produce a local measurement that can be trusted.
//
// This tool is deliberately loopback-only. The deployed Worker returns 404 for the
// expensive unauthenticated endpoint; `BASE` is checked before any request so this
// script cannot accidentally probe a deployment. Use `npm run sim` as a local
// planning/reference proxy; the CPU available on edge hardware remains unknown.
//
// THE SERVER CLOCK IS NOT TRUSTED, SO THIS FILE DOES THE TIMING.
//
// Cloudflare freezes Date.now() and performance.now() during synchronous execution to
// mitigate Spectre, and local workerd can undercount synchronous CPU too. A loop of
// 400-enemy frames may therefore look implausibly cheap if timed inside the Worker.
// The first version trusted that clock and could print "COMFORTABLE" from a measurement
// of nothing.
//
// The fix is DIFFERENCING TWO RUNS ON THIS CLOCK. Ask for a short run and a long run;
// both pay the same fixed cost (fetch, startup, building the world, filling the pool,
// JSON), so subtracting cancels it and what remains is the marginal cost of the extra
// frames. No server clock is involved at any point.
//
// That is the same move worker/index.js already makes for the tick rate -- "the
// measurement that cannot lie is on the client: count how far `tick` advanced over an
// interval the CLIENT timed" -- for the same underlying reason.

// Trimmed because `set BASE=http://... && node ...` in cmd puts the trailing space
// INSIDE the value, and the resulting error names an invalid URL rather than the
// stray space that caused it.
const BASE = (process.env.BASE ?? "http://127.0.0.1:8787").trim();

let baseUrl;
try {
  baseUrl = new URL(BASE);
} catch {
  console.log(`invalid BASE URL: ${BASE}`);
  process.exit(1);
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
if (!LOOPBACK_HOSTS.has(baseUrl.hostname.toLowerCase())) {
  console.log("sim-check is local-only; refusing to request a non-loopback Worker.");
  console.log(`BASE resolved to ${baseUrl.origin}`);
  process.exit(1);
}

// WHAT THE TWO RUN LENGTHS ARE FOR, AND WHY NEITHER OF THEM IS SHORT.
//
// The first version used 30 and 600, on the theory that the short run prices the fixed
// overhead -- fetch, isolate startup, building the world, filling 400 bodies -- so
// subtracting it leaves frame cost. The measured numbers said that was wrong, and the
// direction gave it away: it reported 0.362 ms/frame against 0.938 measured warm in
// plain node, i.e. workerd apparently 2.6x faster than Node at running the same V8 on
// the same machine. Not credible, so the measurement was wrong rather than the runtime
// being fast.
//
// THE SCENARIO IS NOT IN A STEADY STATE, AND IT GETS MORE EXPENSIVE, NOT LESS.
//
// Measured with tools/sim-cost-window.mjs, which exists because of this. 400 chewers
// spawn on a ring 63 m out and converge under an 8 m hull; the neighbour separation runs
// through a uniform spatial hash, so per-body cost scales with how many others share a
// cell. Over 1200 frames the crowd's hull-space spread falls from 34.0 m to 6.7 m and
// per-frame cost climbs from about 0.30 ms to 1.25-1.95 ms. A six-fold swing, driven
// entirely by density.
//
// So the cheapest moment in the whole run is the first second, while they are still
// spread around the ring. That is exactly the window test 17 times, which is why it
// reports 0.36 ms/frame while the same 400 bodies cost 0.833 ms/frame averaged over a
// full run. Neither number is wrong; the short one is just not a characterisation of the
// simulation, and it is the one the steering had been quoting.
//
// This project's own "sampling at the wrong moment in a sequence" trap, in a profiler
// rather than a test: the boss's escort measured on the frame the boss appears, the
// chewer floor read off a wave that does not exist.
//
// Both runs therefore sit well past the first second, and the difference prices the
// marginal cost of a frame in the CONVERGED, expensive state. That is the right way
// round for a server budget -- a worst case rather than a floor -- and it is why the
// thresholds below are not generous.
//
// (An earlier version of this comment claimed the opposite: that bodies latch and the
// tail is cheap. The latched count peaks at 27 of 400 and falls back to zero, because
// they crowd and contend around the legs rather than settling. Recorded because the
// wrong version sounded just as plausible and was written with the same confidence.)
const FRAMES = Number(process.env.FRAMES ?? 1200);
const BASELINE_FRAMES = Number(process.env.BASELINE_FRAMES ?? 600);

// Pairs, and the difference is taken WITHIN a pair. The first version took the global
// minimum of every short run and the global minimum of every long run and subtracted
// those -- which pairs runs from different moments, and the isolate gets steadily faster
// as it warms, so it could subtract a late warm short from an earlier colder long. The
// measured spread showed it: 252, 126 and 68 ms for the same 30-frame request.
//
// Differencing adjacent runs cancels warmup to first order because both halves of a pair
// are equally warm. The minimum is then taken over the PAIR DELTAS, not over the raw
// timings, because every error source here is additive -- a GC pause, a scheduling
// hiccup, another process on the box -- so the smallest delta is the closest to the true
// marginal cost, while a mean folds the noise in.
const REPEATS = Number(process.env.REPEATS ?? 3);

async function run(frames) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/lobby/sim-check?frames=${frames}`);
  const body = await res.json();
  // Read AFTER the JSON is parsed, so the fixed cost being cancelled includes parsing.
  const wallMs = performance.now() - t0;
  return { body, wallMs };
}

console.log(`sim-check against ${BASE}\n`);

let first;
try {
  first = await run(BASELINE_FRAMES);
} catch (err) {
  console.log(`could not reach ${BASE} — ${err.message}`);
  console.log(
    "\nStart the lobby with `npm run dev:mp`."
    + "\nTo check the spike's own wiring without a server at all:"
    + "\n    node tools/sim-check-node.mjs",
  );
  process.exit(1);
}

const r = first.body;

if (!r.ok) {
  console.log(`FAIL at stage "${r.stage}"`);
  if (r.error) console.log(`  ${r.error}`);
  for (const line of r.stack ?? []) console.log(`  ${line.trim()}`);

  // TWO DIFFERENT FAILURES, AND CONFLATING THEM IS EXPENSIVE.
  //
  // "spike-stale" means worker/sim-check.js is calling the simulation with the wrong
  // arguments — the runtime is fine and nothing about the architecture follows. Every
  // other stage means the real modules could not load, construct or step in workerd,
  // which is the answer that changes the plan.
  //
  // They were the same message until a Crew landed and this file reported a stale
  // argument list as though a Durable Object could not host the simulation.
  if (r.stage === "spike-stale") {
    console.log(
      `\n${r.note ?? "The spike is stale."}`
      + "\n\nFix worker/sim-check.js to match the current module signatures, then re-run."
      + "\nNothing has been learned about workerd yet."
      + "\n\n`node tools/sim-check-node.mjs` reproduces this in plain node in a second,"
      + "\nwhich is the fast way to iterate on the repair.",
    );
  } else {
    console.log(
      "\nThis is a RESULT, not an obstacle. A simulation that cannot load in workerd"
      + "\nmeans the authoritative sim stays on a client and the Durable Object becomes"
      + "\nan arbitrator instead — a different architecture, and better known now.",
    );
  }
  process.exit(1);
}

console.log("ok   the real modules loaded, constructed and stepped inside the Worker");
console.log(`     crew of ${r.crew}, so the crew-wide systems were actually exercised`);
console.log(`     pool filled to ${r.pooled}, ${r.live} still alive after the run`);
console.log(`     director phase "${r.phase}", hull travelled ${r.hullMoved} m`);
console.log(`     finite: player ${r.playerFinite}, whole crowd ${r.crowdFinite}`);

// ---- the measurement ------------------------------------------------------------

console.log(
  `\ntiming on this machine's clock: ${REPEATS} pairs of`
  + ` ${BASELINE_FRAMES} and ${FRAMES} frames, differenced within each pair`,
);

const deltaFrames = FRAMES - BASELINE_FRAMES;
const deltas = [];

// The very first request of the session is discarded rather than used as a timing
// sample. It pays for isolate startup and for bundling three.js, which no later request
// does, and it was previously folded straight into pair 1 as though it were comparable.
console.log(`  (first request ${first.wallMs.toFixed(1)} ms — discarded, isolate startup)`);

for (let i = 0; i < REPEATS; i++) {
  const short = await run(BASELINE_FRAMES);
  const long = await run(FRAMES);
  if (!short.body.ok || !long.body.ok) {
    console.log(`  a timing run failed at stage "${(short.body.ok ? long : short).body.stage}"`);
    process.exit(1);
  }
  const delta = long.wallMs - short.wallMs;
  deltas.push(delta);
  console.log(
    `  pair ${i + 1}: ${short.wallMs.toFixed(1)} ms at ${BASELINE_FRAMES}f,`
    + ` ${long.wallMs.toFixed(1)} ms at ${FRAMES}f,`
    + ` delta ${delta.toFixed(1)} ms -> ${(delta / deltaFrames).toFixed(3)} ms/frame`,
  );
}

const deltaMs = Math.min(...deltas);
const msPerFrame = deltaMs / deltaFrames;
const perSecond = msPerFrame * 60;

// A FAILED MEASUREMENT IS REJECTED BEFORE ANY FIGURE IS PRINTED, and the order is the
// whole point.
//
// If the long run comes back no slower than the short one, something other than frame
// cost dominated: a cold isolate, a network hiccup, or a server that did not run the
// frames it was asked for. There is no number to report in that case.
//
// The first version of this file had the identical guard sitting BELOW the reporting, so
// a failed measurement printed a confident `0.xxx ms/frame` and a verdict and only then
// admitted the measurement was void. That is precisely the frozen clock's mistake in a
// new costume — a figure emitted first and qualified afterwards — written into the tool
// built to fix it. Caught re-reading the file rather than by any check.
if (!(deltaFrames > 0)) {
  console.log(
    `\nBAD CONFIGURATION — FRAMES (${FRAMES}) must exceed BASELINE_FRAMES`
    + ` (${BASELINE_FRAMES}).`
    + "\nThe measurement is the difference between them, so there is nothing to divide by.",
  );
  process.exit(1);
}
if (!(deltaMs > 0) || !Number.isFinite(msPerFrame)) {
  console.log(
    "\nMEASUREMENT FAILED — the longer run was not slower than the shorter one."
    + `\n  deltas: ${deltas.map((d) => d.toFixed(1)).join(", ")} ms`
    + "\nThat is not a result, and no ms/frame figure follows from it. Re-run; if it"
    + "\npersists, the frames are not being executed or the fixed overhead is swamping"
    + "\nthe signal. Raise FRAMES.",
  );
  process.exit(1);
}

// The spread across pairs is reported because it is the only indication of how much to
// trust the figure. A tight spread means the differencing worked; a wide one means
// something other than frame cost is moving, and the number should be read as an order
// of magnitude rather than a measurement.
const spread = Math.max(...deltas) - Math.min(...deltas);
console.log(
  `\n     best delta ${deltaMs.toFixed(1)} ms for ${deltaFrames} steady-state frames`
  + `  ->  ${msPerFrame.toFixed(3)} ms/frame`,
);
console.log(
  `     spread across pairs ${spread.toFixed(1)} ms`
  + ` (${((spread / deltaFrames) * 1000).toFixed(0)} us/frame)`
  + `${spread > deltaMs * 0.5 ? " — WIDE, treat the figure as approximate" : ""}`,
);
console.log(
  "\n     WHAT THIS IS: the marginal cost of a frame with 400 bodies CONVERGED under the"
  + "\n     hull, which is the expensive state — measured at 4-6x the cost of the same 400"
  + "\n     while still spread around the spawn ring. Both runs are past that opening"
  + "\n     second, so the cheap phase cancels and what is left is the worst case."
  + "\n     `node tools/sim-cost-window.mjs` prints the whole curve if the number here"
  + "\n     ever looks wrong; test 17's 0.36 ms/frame is the ring phase, not this one.",
);

// What the server thought, kept only as corroboration and clearly labelled. Null when
// the runtime's clock did not advance, which is a valid runtime limitation rather than
// a fast result.
if (r.selfTimedMsPerFrame === null) {
  console.log(
    `\n     (the Worker could not time itself: ${r.clockNote})`,
  );
} else {
  console.log(
    `\n     (the Worker self-timed ${r.selfTimedMsPerFrame} ms/frame over ${r.frames}`
    + ` frames — corroboration only, and it is measuring the short run)`,
  );
  // AND DO NOT RECONCILE IT WITH NODE, BECAUSE IT DOES NOT RECONCILE.
  //
  // Measured on one machine, same scenario, same 400 bodies, both past warmup: local
  // workerd self-reports ~0.34 ms/frame for a full 600-frame run where plain node
  // measures ~0.94. Two builds of V8 on the same hardware do not differ by 2.8x, so the
  // low reading is a measurement artefact, not a fast runtime -- most likely the same
  // Spectre timer gating in a weaker local form, advancing the clock at I/O boundaries
  // and undercounting a long synchronous loop.
  //
  // Which means the self-timed figure is untrustworthy even LOCALLY, not just when
  // deployed, and the fact that it happens to sit near the differenced figure above is
  // two low readings agreeing rather than confirmation. Plain Node is the more stable
  // local planning/reference proxy; it is not a worst-case bound on edge hardware.
  //
  // Recorded here rather than resolved because the local architecture check still has
  // roughly 17x headroom in a 16.7 ms tick under either local measurement. That establishes
  // runtime compatibility and local feasibility, not deployed edge CPU. It is worth knowing
  // before anyone tries to tune against this number.
  console.log(
    "     NOTE: a self-timed figure well below `npm run sim` is expected and is an"
    + "\n     artefact of workerd's timer gating, not a fast runtime. Do not tune on it.",
  );
}

// 16.7 ms is one frame at 60 Hz. Anything approaching it means the DO cannot keep up
// with real time at all. The useful comparison is against the whole budget, not against
// the 30 s CPU ceiling -- but note the ceiling is not irrelevant either: it resets on
// every inbound WebSocket message, so a session whose clients all fall silent is
// burning that budget with nothing replenishing it. At 53 ms/s that is about nine
// minutes to eviction, which is why clients send input every tick even when idle.
// Judged against the FLOOR, so the thresholds are deliberately conservative: a figure
// that only just passed here would not be a pass, because the real worst case is higher
// than what this measures. 200 ms/s is a twelfth of a core and roughly 4x the node
// figure for a full run, which is the margin that makes a floor usable as a verdict.
const verdict = perSecond < 200
  ? "COMFORTABLE — local workerd can host this at 60 Hz"
  : perSecond < 600
    ? "TIGHT — it fits locally, but leaves too little margin to rely on"
    : "TOO SLOW — the simulation cannot run server-side at 60 Hz here";
console.log(`\n${verdict}   (${perSecond.toFixed(1)} ms of CPU per second of wall clock)`);
console.log(
  `     one frame at 60 Hz is 16.7 ms, so this is using`
  + ` ${((msPerFrame / 16.667) * 100).toFixed(1)}% of the tick`,
);

console.log(
  "\nThis was LOCAL workerd on this machine. It verifies runtime compatibility, not"
  + "\nedge hardware. The deployed endpoint is deliberately disabled; use `npm run sim`"
  + "\nas a local planning/reference proxy. Edge CPU remains unknown.",
);
