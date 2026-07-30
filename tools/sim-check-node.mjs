// Run the Durable Object spike's own code in PLAIN NODE.
//
//   node tools/sim-check-node.mjs
//   FRAMES=600 node tools/sim-check-node.mjs
//
// WHY THIS EXISTS, WHICH IS A STORY ABOUT WHY THE SPIKE ROTTED
//
// worker/sim-check.js answers the question that can invalidate the netcode plan: can
// the real simulation load, construct and step inside workerd? Reading that answer
// needed a running wrangler (`npm run dev:mp`), so it was never run again after it was
// written -- and when the Crew refactor changed three signatures underneath it, it
// broke silently and stayed broken. Worse, it broke in the one way that lies: the
// failure surfaced as `{ ok: false, stage: "step" }`, which reads as "a Durable Object
// cannot host this simulation" when it actually meant "this file is three arguments
// stale".
//
// Nothing caught that. `npm run audit` and `npm run imports` both scope to src/, and
// no static check can catch a Player passed where a Crew was wanted -- both are
// objects, and the call is arity-legal because `seed` defaults.
//
// So the spike is split in two by WHAT IT CAN ANSWER:
//
//   this file            is the CODE correct? Node, no wrangler, runs in a second.
//   tools/sim-check.mjs  is the RUNTIME capable? needs workerd, and the deployed edge.
//
// The first is the one that rots, so the first is the one that has to be cheap. The
// second is the one that decides the architecture, and it is still the number to trust
// for that -- edge hardware is not this machine, and Node is not workerd.
//
// The ms/frame figure here is therefore a REFERENCE, not the verdict. Compare it
// against test 17, which times the same 400 bodies through the harness's own step().

import { simCheck } from "../worker/sim-check.js";

// 600 frames is ten seconds of simulated time. The spike's old default of 120 was two
// seconds, and at that length the figure is substantially JIT WARMUP rather than steady
// state -- V8 optimises a hot loop after a few thousand iterations, and 120 frames of a
// 400-body pool does not get there. Measured on this machine: 1.242 ms/frame at 120
// frames against a materially lower figure once warm.
//
// Worth stating because the file's own docstring said "`frames` is small by default
// because the question is 'does this execute', not 'how fast'" -- which was fair, and
// then it reported a ms/frame figure and a COMFORTABLE/TIGHT/TOO SLOW verdict off it
// anyway. A measurement that cannot support a verdict should not be handed one.
const FRAMES = Number(process.env.FRAMES ?? 600);

// Thrown away. Its only job is to get the simulation's hot paths optimised before the
// run that is reported, which is the difference between measuring the code and measuring
// the compiler catching up with it.
const WARMUP_FRAMES = Number(process.env.WARMUP_FRAMES ?? 240);

console.log(`sim-check in plain node (${process.version})\n`);

const warmup = simCheck(WARMUP_FRAMES);
if (!warmup.ok) {
  console.log(`FAIL during warmup at stage "${warmup.stage}"`);
  if (warmup.error) console.log(`  ${warmup.error}`);
  if (warmup.stage === "spike-stale") console.log(`\n${warmup.note ?? ""}`);
  process.exit(1);
}

const r = simCheck(FRAMES);

if (!r.ok) {
  console.log(`FAIL at stage "${r.stage}"`);
  if (r.error) console.log(`  ${r.error}`);
  for (const line of r.stack ?? []) console.log(`  ${line.trim()}`);
  if (r.stage === "spike-stale") {
    console.log(`\n${r.note ?? ""}`);
    console.log(
      "\nThe simulation modules are fine. worker/sim-check.js needs updating to match"
      + "\nthe current signatures. Run this after any change to a simulation module's"
      + "\nconstructor or update() arguments -- it is the only thing that catches it.",
    );
  } else {
    console.log(
      "\nA failure HERE is about the code, not about workerd: this is plain node, the"
      + "\nsame runtime the harness passes 1015 assertions in. So a fault at any stage"
      + "\nother than \"spike-stale\" means the spike and the harness disagree about the"
      + "\nsame modules, which is worth understanding before reading anything into a"
      + "\nWorker result.",
    );
  }
  process.exit(1);
}

console.log("ok   the real modules loaded, constructed and stepped");
console.log(`     crew of ${r.crew}, so the crew-wide systems were actually exercised`);
console.log(`     pool filled to ${r.pooled}, ${r.live} still alive after the run`);
console.log(`     director phase "${r.phase}", hull travelled ${r.hullMoved} m`);
console.log(`     finite: player ${r.playerFinite}, whole crowd ${r.crowdFinite}`);

// Node's clock is a real clock, so the self-timed figure is legitimate HERE and is
// exactly what is unavailable on a deployed Worker. Guarded on `clockAdvanced` anyway,
// because a null printed as a number is how the frozen-clock bug read as a fast result.
if (!r.clockAdvanced || r.selfTimedMsPerFrame === null) {
  console.log(`\n     no timing: ${r.clockNote}`);
} else {
  console.log(
    `\n     ${r.frames} warm frames in ${r.cpuMsForFrames} ms`
    + `  ->  ${r.selfTimedMsPerFrame} ms/frame`,
  );
  console.log(`     ${r.selfTimedBudgetAt60Hz}`);
  console.log(`     (after ${WARMUP_FRAMES} discarded warmup frames)`);
  console.log("     compare against test 17, which times the same 400 through the harness");
}

console.log(
  "\nThis says the SPIKE IS WIRED CORRECTLY, and prices the simulation on THIS machine."
  + "\nIt says nothing about workerd or about the edge -- for that, `npm run dev:mp` then"
  + "\n`node tools/sim-check.mjs`, and then again with BASE= against the deployed Worker."
  + "\nThat script does its own timing on the client's clock, because a deployed Worker"
  + "\ncannot time itself: Cloudflare freezes Date.now() and performance.now() outside"
  + "\nI/O to mitigate Spectre.",
);
