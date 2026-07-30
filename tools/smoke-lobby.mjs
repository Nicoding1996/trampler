// Ask a running lobby whether a Durable Object can actually host a 60 Hz
// authoritative simulation, and whether the join rules hold.
//
//   npm run dev:mp                     (in one terminal)
//   node tools/smoke-lobby.mjs
//
//   BASE=https://trampler.<subdomain>.workers.dev node tools/smoke-lobby.mjs
//
// WHY THIS EXISTS
//
// The Worker is the first code in this repo with no check behind it -- the
// harness cannot import it, `npm run audit` scopes to src/, and `npm run smoke`
// asks the local static server, which knows nothing about /lobby. That is the
// same gap the frame-order audit found, and it found the only piece of wiring in
// the project with no coverage at all.
//
// WHAT THE HEADLINE NUMBER IS, AND WHY IT IS NOT THE OBVIOUS ONE
//
// Cloudflare freezes `Date.now()` during synchronous execution and advances it
// only across I/O, so a server-side tick delta is measured against a clock that
// is not a normal clock. Trusting it would be measuring the runtime's timekeeping
// and reporting it as tick fidelity.
//
// So the headline is computed with no server clock at all: how far the server's
// own tick COUNTER advanced, divided by an interval this process timed itself.
// The DO's internal jitter figures are printed underneath as corroboration, and
// if the two disagree it is the clock that is wrong, not the tick.
//
// Run it against the deployed Worker as well as against wrangler dev. Local
// workerd and an edge PoP are different machines under different load, and the
// only number that describes what a player gets is the deployed one.

import { readFileSync } from "node:fs";

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const WS_BASE = BASE.replace(/^http/, "ws");

// Long enough that a 20 Hz stream yields ~120 samples, so a p95 means something.
const SAMPLE_MS = Number(process.env.SAMPLE_MS ?? 6000);
const PINGS = 12;

const CREW_MAX = 4;
const TICK_HZ = 60;
const SNAPSHOT_HZ = 20;
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ";

let checks = 0;
let bad = 0;

function ok(pass, label, detail = "") {
  checks++;
  if (!pass) bad++;
  console.log(`${pass ? "ok  " : "FAIL"} ${label}${detail ? `   ${detail}` : ""}`);
}

function note(label) {
  console.log(`     ${label}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function percentiles(values) {
  const d = [...values].sort((a, b) => a - b);
  const at = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
  return {
    n: d.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: d[d.length - 1],
  };
}

/**
 * Open a socket and resolve once the server has said hello, or reject with the
 * close code if it refused. A refusal is a RESULT here, not an error -- three of
 * the checks below are about being turned away for the right reason.
 */
function connect(code, name) {
  return new Promise((resolve, reject) => {
    const url = `${WS_BASE}/lobby/${code}${name ? `?name=${encodeURIComponent(name)}` : ""}`;
    const socket = new WebSocket(url);
    const frames = [];
    const snaps = [];
    let hello = null;

    const timer = setTimeout(() => {
      reject(new Error("no hello within 8 s"));
      try { socket.close(); } catch { /* already gone */ }
    }, 8000);

    // BINARY AS ArrayBuffer, not Blob. Same reason net.js sets it: a Blob is read
    // asynchronously, so every snapshot would arrive a microtask late and out of order --
    // and the immediate symptom here is worse, because `JSON.parse` on a Blob throws inside
    // a listener and takes the whole handler down.
    //
    // Worth recording that this line was MISSING when state snapshots first went on the
    // wire, and the failure was this tool crashing rather than the feature not working.
    socket.binaryType = "arraybuffer";

    socket.addEventListener("message", (ev) => {
      // Binary is a state snapshot; text is session bookkeeping. Branch on the frame type,
      // because a compact binary snapshot has no room for a discriminator string.
      if (ev.data instanceof ArrayBuffer) {
        snaps.push({ bytes: ev.data.byteLength, buffer: ev.data, at: performance.now() });
        return;
      }
      const msg = JSON.parse(ev.data);
      if (msg.t === "hello") {
        hello = msg;
        clearTimeout(timer);
        // performance.now(), not Date.now(): this is the clock the headline
        // measurement rests on, so it needs to be monotonic.
        resolve({ socket, hello, frames, snaps, openedAt: performance.now() });
        return;
      }
      frames.push({ msg, at: performance.now() });
    });

    socket.addEventListener("close", (ev) => {
      clearTimeout(timer);
      if (!hello) {
        reject(Object.assign(new Error(ev.reason || "closed"), { code: ev.code }));
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timer);
      if (!hello) reject(new Error("socket error — is the server running?"));
    });
  });
}

/** Resolve with the close code, for the cases where being refused is the pass. */
async function expectRefusal(code) {
  try {
    const c = await connect(code);
    try { c.socket.close(); } catch { /* ignore */ }
    return { refused: false };
  } catch (err) {
    return { refused: true, code: err.code, reason: err.message };
  }
}

const status = async (code) => (await fetch(`${BASE}/lobby/${code}/status`)).json();

if (typeof WebSocket === "undefined") {
  console.log("FAIL this needs Node 22+ for a global WebSocket");
  process.exit(1);
}

console.log(`lobby smoke against ${BASE}\n`);

// ---- minting -------------------------------------------------------------
let code;
try {
  const res = await fetch(`${BASE}/lobby/new`, { method: "POST" });
  const body = await res.json();
  code = body.code;
  ok(res.status === 200 && typeof code === "string", "POST /lobby/new mints a code", code);
  ok(code?.length === 6, "code is 6 characters", `${code?.length}`);
  ok(
    [...(code ?? "")].every((ch) => CODE_ALPHABET.includes(ch)),
    "code avoids 0/O 1/I/L U",
    code,
  );
  ok(body.crewMax === CREW_MAX, "server agrees the crew is capped at 4", `${body.crewMax}`);
} catch (err) {
  console.log(`FAIL could not reach ${BASE}/lobby/new — ${err.message}`);
  console.log("\nStart the Worker first:  npm run dev:mp");
  process.exit(1);
}

// A code the server has never seen must not 500 or invent a session.
{
  const res = await fetch(`${BASE}/lobby/NOT-A-CODE-AT-ALL/status`);
  ok(res.status === 400, "a malformed code is refused with 400", `${res.status}`);
}

// The root must explain itself rather than 404ing.
//
// `wrangler dev` prints a "[b] open a browser" shortcut that lands on exactly this
// path, so it is the first thing anyone sees after starting the lobby — and a bare
// "Not Found" there reads as "the thing I just started is broken". It is not; the
// game is on another port. Asserted because a hint that goes stale is worse than no
// hint: it would send the next person to a port nothing is listening on.
{
  const res = await fetch(`${BASE}/`);
  const body = await res.text();
  ok(res.status === 200, "the lobby root answers rather than 404ing", `${res.status}`);
  ok(body.includes("5173"), "and it names the port the game is actually on");
  ok(
    body.includes(`?lobby=${BASE}`),
    "and hands back a URL that already carries the override",
    `expected ?lobby=${BASE}`,
  );
  // A mistyped path must still be a 404. A blanket 200 would hide real mistakes,
  // which is the same argument as the shop naming which clause refused it.
  const miss = await fetch(`${BASE}/definitely-not-a-route`);
  ok(miss.status === 404, "but a mistyped path is still a 404", `${miss.status}`);
}

// ---- CORS, scoped to loopback -------------------------------------------
// Local development puts the page on one port and the lobby on another, so every
// fetch between them is cross-origin. That allowance must NOT extend to the whole
// internet on a deployed instance: /lobby/new is a write endpoint.
//
// The loopback case is asserted FIRST and on purpose. Node lets `Origin` be set where
// a browser would not, and if it ever stopped, a test that only checked "a foreign
// origin is refused" would pass because no origin was sent at all — a vacuous pass on
// a security property. Requiring the positive case to work proves the header arrived.
{
  const local = await fetch(`${BASE}/lobby/new`, {
    method: "POST",
    headers: { origin: "http://localhost:5173" },
  });
  const allowed = local.headers.get("access-control-allow-origin");
  ok(
    allowed === "http://localhost:5173",
    "a loopback origin is allowed, and echoed rather than wildcarded",
    `${allowed}`,
  );
  ok(
    (local.headers.get("vary") ?? "").toLowerCase().includes("origin"),
    "and it varies on origin, so a cache cannot leak one origin's allowance",
  );

  const foreign = await fetch(`${BASE}/lobby/new`, {
    method: "POST",
    headers: { origin: "https://not-your-game.example" },
  });
  ok(
    foreign.headers.get("access-control-allow-origin") === null,
    "a foreign origin gets no allowance at all",
    `${foreign.headers.get("access-control-allow-origin")}`,
  );

  // Nothing preflights today, but it will the moment a POST gains a content-type,
  // and that failure is indistinguishable from the missing-CORS bug.
  const pre = await fetch(`${BASE}/lobby/new`, {
    method: "OPTIONS",
    headers: { origin: "http://127.0.0.1:5173" },
  });
  ok(pre.status === 204, "a loopback preflight is answered", `${pre.status}`);
  ok(
    (pre.headers.get("access-control-allow-methods") ?? "").includes("POST"),
    "and it permits the method the client actually uses",
  );
}

// ---- seating -------------------------------------------------------------
const crew = [];
for (let i = 1; i <= CREW_MAX; i++) {
  const c = await connect(code, `CREW ${i}`);
  crew.push(c);
  ok(c.hello.seat === i, `seat ${i} assigned in join order`, `got ${c.hello.seat}`);
}
ok(crew[0].hello.tickHz === TICK_HZ, "server ticks at 60 Hz", `${crew[0].hello.tickHz}`);
ok(
  crew[0].hello.snapshotHz === SNAPSHOT_HZ,
  "snapshots at 20 Hz, decoupled from the tick",
  `${crew[0].hello.snapshotHz}`,
);

{
  const fifth = await expectRefusal(code);
  ok(fifth.refused, "a fifth player is refused");
  ok(fifth.code === 4001, "refusal names FULL rather than a generic close", `code ${fifth.code}`);
  note(`reason: "${fifth.reason}"`);
}

// ---- the measurement -----------------------------------------------------
// Take the sample on seat 1, which has been connected longest.
const seat1 = crew[0];
seat1.frames.length = 0;
const sampleStart = performance.now();
await sleep(SAMPLE_MS);
const sampleEnd = performance.now();
const elapsed = (sampleEnd - sampleStart) / 1000;

const snaps = seat1.frames.filter((f) => f.msg.t === "snap");

// SCENARIO GUARD, before any rate is asserted. A tick-rate check computed from
// two frames would pass on a server that had almost stopped, which is the exact
// shape of the vacuous tests this project keeps finding: assert that the thing
// being measured actually happened first.
const expectedSnaps = SNAPSHOT_HZ * elapsed;
ok(
  snaps.length >= expectedSnaps * 0.5,
  "enough snapshots arrived to measure anything",
  `${snaps.length} in ${elapsed.toFixed(2)}s (expected ~${expectedSnaps.toFixed(0)})`,
);

if (snaps.length >= 2) {
  const firstTick = snaps[0].msg.tick;
  const lastTick = snaps[snaps.length - 1].msg.tick;
  const span = (snaps[snaps.length - 1].at - snaps[0].at) / 1000;
  const effectiveHz = (lastTick - firstTick) / span;

  const arrivals = [];
  for (let i = 1; i < snaps.length; i++) arrivals.push(snaps[i].at - snaps[i - 1].at);
  const a = percentiles(arrivals);

  console.log("");
  ok(
    effectiveHz >= TICK_HZ * 0.95 && effectiveHz <= TICK_HZ * 1.05,
    "THE HEADLINE: the DO holds 60 Hz",
    `${effectiveHz.toFixed(2)} Hz measured from the tick counter over a locally timed ${span.toFixed(2)}s`,
  );
  ok(
    a.p95 <= (1000 / SNAPSHOT_HZ) * 2,
    "snapshot arrival p95 within 2x nominal",
    `p95 ${a.p95.toFixed(1)}ms against 50ms nominal`,
  );
  note(
    `arrival p50 ${a.p50.toFixed(1)}  p95 ${a.p95.toFixed(1)}  `
    + `p99 ${a.p99.toFixed(1)}  max ${a.max.toFixed(1)} ms   (n=${a.n})`,
  );
  note(`ticks ${firstTick} -> ${lastTick} = ${lastTick - firstTick} in ${span.toFixed(2)}s`);
}

// ---- round trip ----------------------------------------------------------
{
  const rtts = [];
  for (let i = 0; i < PINGS; i++) {
    const sent = performance.now();
    const got = new Promise((resolve) => {
      const onMsg = (ev) => {
        // Skip state snapshots. Every ad-hoc listener in this file has to, now that the
        // server sends binary: JSON.parse on an ArrayBuffer throws inside the handler and
        // takes the check down with it, which reads as a server fault rather than a tool one.
        if (ev.data instanceof ArrayBuffer) return;
        const msg = JSON.parse(ev.data);
        if (msg.t === "pong" && msg.id === i) {
          seat1.socket.removeEventListener("message", onMsg);
          resolve(performance.now() - sent);
        }
      };
      seat1.socket.addEventListener("message", onMsg);
    });
    seat1.socket.send(JSON.stringify({ t: "ping", id: i }));
    rtts.push(await got);
    await sleep(40);
  }
  const p = percentiles(rtts);
  console.log("");
  ok(rtts.length === PINGS, "every ping came back", `${rtts.length}/${PINGS}`);
  note(`rtt p50 ${p.p50.toFixed(1)}  p95 ${p.p95.toFixed(1)}  max ${p.max.toFixed(1)} ms`);
  note("against localhost this is a floor, not a latency figure — rerun with BASE set");
}

// ---- what the DO thinks --------------------------------------------------
{
  const s = await status(code);
  console.log("");
  ok(s.crew === CREW_MAX, "DO reports a full crew", `${s.crew}/${s.crewMax}`);
  ok(s.ticking === true, "DO reports its tick loop running");
  ok(
    s.seats.length === CREW_MAX && new Set(s.seats.map((x) => x.seat)).size === CREW_MAX,
    "four distinct seats, no duplicates",
  );
  if (s.jitter) {
    note(
      `DO wake deltas (corroboration only, see the header): `
      + `p50 ${s.jitter.p50}  p95 ${s.jitter.p95}  p99 ${s.jitter.p99}  `
      + `max ${s.jitter.max} ms, asking for ${s.jitter.requestedWakeMs}`,
    );
    // The ratio is the whole point of separating these. A wake p50 far above the
    // requested interval is a coarse OS timer, and steps-per-wake above 1 is the
    // accumulator absorbing it. Both being true at once is a healthy server on a
    // bad clock -- which is precisely the state this machine is in, and precisely
    // the state a single "60 Hz?" yes/no could not describe.
    note(
      `steps ${s.tick} over ${s.wakes} wakes = `
      + `${(s.tick / Math.max(1, s.wakes)).toFixed(2)} steps per wake `
      + `(1.00 means the timer is fine, >1 means the accumulator is earning its keep)`,
    );
  }
}

// ---- the pose relay ------------------------------------------------------
// The relay is what src/net.js rides on, and none of it is reachable from the
// harness: net.js is browser-only and the DO cannot be imported at all. So the
// round trip is asserted here or nowhere.
{
  console.log("");

  // Seat 2 broadcasts a pose in HULL-LOCAL space; seat 1 must receive it verbatim.
  // Local y = 0 is the deck surface, not the ground, so 0.9 is a body standing on
  // the deck rather than one buried in it — the coordinate trap that has produced
  // two separate test bugs in this project.
  const sent = { t: "pose", x: 4.05, y: 0.9, z: -7.65, yaw: 1.25, b: 1 };
  const heard = new Promise((resolve) => {
    const onMsg = (ev) => {
      if (ev.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(ev.data);
      if (msg.t !== "poses") return;
      const mine = msg.seats.find((s) => s.seat === 2);
      if (!mine) return;
      seat1.socket.removeEventListener("message", onMsg);
      resolve({ msg, mine });
    };
    seat1.socket.addEventListener("message", onMsg);
  });
  crew[1].socket.send(JSON.stringify(sent));
  const got = await Promise.race([heard, sleep(2000).then(() => null)]);

  ok(got !== null, "a pose sent by seat 2 reaches seat 1");
  if (got) {
    ok(
      got.mine.x === sent.x && got.mine.y === sent.y && got.mine.z === sent.z,
      "the hull-local position survives the round trip unaltered",
      `${got.mine.x},${got.mine.y},${got.mine.z}`,
    );
    ok(got.mine.b === 1, "the frame flag survives, so the client knows which space it is in");
    // SCENARIO GUARD: seats 3 and 4 have never sent a pose, and a relay that
    // reported them anyway would be putting bodies at the local origin — which on
    // this hull is inside the reactor. Asserting the absence is the point.
    ok(
      !got.msg.seats.some((s) => s.seat === 3 || s.seat === 4),
      "seats that have not reported are omitted, not placed at the origin",
      `carried seats: ${got.msg.seats.map((s) => s.seat).join(",")}`,
    );
  }

  // A NaN from one client must not reach the others. Invariant 16 is global in the
  // harness; nothing enforced it across the wire until now. JSON cannot even carry
  // NaN, so the realistic attack is a string or a null, which is what is sent here.
  const poisoned = new Promise((resolve) => {
    const onMsg = (ev) => {
      if (ev.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(ev.data);
      if (msg.t !== "poses") return;
      const mine = msg.seats.find((s) => s.seat === 2);
      if (!mine || mine.x === sent.x) return; // still the previous, good pose
      seat1.socket.removeEventListener("message", onMsg);
      resolve(mine);
    };
    seat1.socket.addEventListener("message", onMsg);
  });
  crew[1].socket.send(JSON.stringify({ t: "pose", x: "haha", y: null, z: 3, yaw: 0, b: 0 }));
  const dirty = await Promise.race([poisoned, sleep(1500).then(() => null)]);
  ok(dirty !== null, "the poisoned pose was relayed at all (test is not vacuous)");
  if (dirty) {
    ok(
      Number.isFinite(dirty.x) && Number.isFinite(dirty.y) && Number.isFinite(dirty.z),
      "non-numeric fields are coerced, so one client cannot NaN everybody else",
      `x=${dirty.x} y=${dirty.y} z=${dirty.z}`,
    );
  }

  // The two halves of the send-rate decision live in different files — CFG.net.sendHz
  // in src/config.js and SNAPSHOT_EVERY in worker/index.js — with no build step to
  // reconcile them. This is the assertion that stops them drifting.
  const cfg = readFileSync("src/config.js", "utf8");
  const declared = Number(cfg.match(/sendHz:\s*(\d+)/)?.[1]);
  ok(
    declared === crew[0].hello.snapshotHz,
    "the client's send rate matches the rate the server advertises",
    `CFG.net.sendHz ${declared} vs server ${crew[0].hello.snapshotHz}`,
  );
}

// ---- joining a run in progress ------------------------------------------
{
  const phased = new Promise((resolve) => {
    const onMsg = (ev) => {
      if (ev.data instanceof ArrayBuffer) return;
      const msg = JSON.parse(ev.data);
      if (msg.t === "phase") {
        seat1.socket.removeEventListener("message", onMsg);
        resolve(msg.phase);
      }
    };
    seat1.socket.addEventListener("message", onMsg);
  });
  seat1.socket.send(JSON.stringify({ t: "start" }));
  const phase = await Promise.race([phased, sleep(2000).then(() => "timeout")]);
  console.log("");
  ok(phase === "running", "seat 1 can start the run", `phase ${phase}`);

  // ---- THE SHARED FORTRESS, over a real socket -----------------------------
  //
  // Everything above this line tests the LOBBY: seats, refusals, tick fidelity, the pose
  // relay. None of it touches the thing slice 1 added, which is that starting a run makes
  // the Durable Object build the real simulation and broadcast it as state.
  //
  // Asserted here or nowhere. The harness proves the codec and the apply logic (sections
  // 117 and 118) but cannot open a socket; this is the only check that the two halves are
  // actually connected — and "the module is correct but nothing calls it" is precisely the
  // state this project was in an hour ago.
  {
    // Building the world is not instant: the DO dynamically imports the simulation and
    // three.js, constructs a 420-slot pool and a flow field. Poll rather than guess, and
    // report the wait, because a fixed sleep here would either be flaky or slow.
    let ready = null;
    const waitStart = performance.now();
    for (let i = 0; i < 60; i++) {
      const s = await status(code);
      if (s.sim?.ready) { ready = s; break; }
      if (s.sim?.error) break;
      await sleep(250);
    }
    const buildMs = performance.now() - waitStart;

    ok(ready !== null, "starting a run builds the authoritative simulation",
      ready ? `ready in ${buildMs.toFixed(0)} ms` : "never became ready");

    if (ready) {
      // A tick counter can advance without a world behind it, so assert the WORLD moved.
      // This is the difference between "the server is running" and "the server is
      // simulating", and only the second one is what a shared fortress needs.
      seat1.snaps.length = 0;
      const before = ready.sim;
      await sleep(2000);
      const after = (await status(code)).sim;

      // THE CHORD BETWEEN TWO SAMPLES, not the distance from the origin. The fortress walks
      // a patrol circle, so `position.length()` is a constant 165 m however far it goes —
      // asserting that it grows reported the hull going backwards, 165.15 to 163.86.
      // At 4.5 m/s a 2 s sample is about 9 m of arc, and on a 165 m radius the chord is
      // nearly the same, so a 5 m floor is generous without being vacuous.
      const moved = Math.hypot(after.hullX - before.hullX, after.hullZ - before.hullZ);
      ok(moved > 5,
        "the fortress actually walks on the server, not just a counter",
        `${moved.toFixed(1)} m of chord in 2 s at ${(moved / 2).toFixed(1)} m/s`);
      ok(after.elapsed > before.elapsed + 1.5,
        "and the server owns the clock every client will read",
        `elapsed ${before.elapsed} s -> ${after.elapsed} s`);
      // Counts ticks lost to BUILDING the world, which is now zeroed when the run starts.
      // Previously it counted from the tick loop's own start and so reported every tick the
      // crew spent in the lobby — 405 of them, for a world that built in 29 ms.
      ok(after.ticksBeforeSim < TICK_HZ,
        "the world built fast enough that barely a tick stepped nothing",
        `${after.ticksBeforeSim} ticks lost to the build`);

      // BINARY SNAPSHOTS ARRIVED, AND THEY DECODE. Decoded with the real module, so this
      // asserts the server and the client agree about the format rather than that bytes
      // showed up.
      const got = seat1.snaps.length;
      ok(got >= SNAPSHOT_HZ * 1.5,
        "state snapshots arrive as binary frames at roughly the snapshot rate",
        `${got} in 2 s (expected ~${SNAPSHOT_HZ * 2})`);

      if (got > 0) {
        const { decode, snapshotBytes } = await import("../src/snapshot.js");
        let decoded = 0;
        let failure = "";
        let firstTick = 0;
        let lastTick = 0;
        for (const s of seat1.snaps) {
          try {
            const st = decode(s.buffer);
            if (!decoded) firstTick = st.tick;
            lastTick = st.tick;
            decoded++;
          } catch (err) {
            failure = err.message;
            break;
          }
        }
        ok(decoded === seat1.snaps.length,
          "every snapshot decodes with the client's own codec",
          failure || `${decoded}/${seat1.snaps.length}`);
        ok(lastTick > firstTick,
          "and the tick inside them advances, so they are not a repeated frame",
          `tick ${firstTick} -> ${lastTick}`);

        // Derived from the complete decoded contents rather than a literal or a subset of
        // repeated-section counts. Protocol v4 adds progression, guns and emitters; omitting
        // any one of those arrays makes the predictor silently treat it as empty.
        const bytes = seat1.snaps[0].bytes;
        const first = decode(seat1.snaps[0].buffer);
        const expectFirst = snapshotBytes(first);
        ok(bytes === expectFirst, "a snapshot is exactly the size its contents imply",
          `${bytes} B for ${first.entities.length} bodies and ${first.operatives.length}`
          + ` operatives -> ${(bytes * SNAPSHOT_HZ / 1024).toFixed(2)} KiB/s per client`);

        // The one thing a socket can tell us that the harness cannot: does the fortress in
        // the snapshot match the fortress the DO reports over HTTP? Two independent paths
        // out of the same object, so agreement means the encoder is reading the live world
        // rather than a stale copy.
        const last = decode(seat1.snaps[seat1.snaps.length - 1].buffer);
        const overHttp = after.elapsed;
        ok(Math.abs(last.elapsedMs / 1000 - overHttp) < 1.0,
          "the clock in the snapshot matches the clock the DO reports over HTTP",
          `snapshot ${(last.elapsedMs / 1000).toFixed(2)} s vs status ${overHttp} s`);
        ok(last.legHp.length === 6,
          "and the leg array arrives whole", `[${last.legHp.join(",")}]`);

        // ---- AND THE HORDE, WHICH TAKES A WAIT ------------------------------
        //
        // Every snapshot up to this point has carried ZERO enemies, because the first wave
        // has not arrived yet — the opening rest and the telegraph come first by design. So
        // the checks above prove the socket carries a snapshot and prove nothing whatsoever
        // about the entity section, which is the part that actually costs bandwidth.
        //
        // That is worth waiting for rather than skipping. The harness proves the codec
        // (section 119) and this is the only thing that proves the bytes cross a real
        // socket — and "the module is correct but nothing calls it" is a state this project
        // has already been in twice today.
        //
        // Bounded and polled rather than a fixed sleep: the wait is however long
        // CFG.waves.firstDelay plus the telegraph takes, and hard-coding that here would be a
        // second owner of two numbers config already owns.
        note("waiting for the first wave, so the entity section can be measured…");
        let withHorde = null;
        const waveStart = performance.now();
        for (let i = 0; i < 90; i++) {
          seat1.snaps.length = 0;
          await sleep(500);
          const found = seat1.snaps.find((s) => decode(s.buffer).entities.length > 0);
          if (found) { withHorde = decode(found.buffer); break; }
        }
        const waveWait = (performance.now() - waveStart) / 1000;

        ok(withHorde !== null,
          "a snapshot carrying live enemies reaches the client",
          withHorde
            ? `${withHorde.entities.length} bodies after ${waveWait.toFixed(1)} s`
            : `no enemies within ${waveWait.toFixed(0)} s`);

        if (withHorde) {
          const n = withHorde.entities.length;
          const crewN = withHorde.operatives.length;
          // Derived from every decoded repeated array, so adding authoritative metadata moves
          // the measured bandwidth without teaching this socket check a second wire layout.
          const expect = snapshotBytes(withHorde);
          const actual = seat1.snaps.find(
            (s) => decode(s.buffer).entities.length === n,
          )?.bytes;
          ok(actual === expect,
            "and its byte size matches the codec's own layout",
            `${actual} B for ${n} bodies and ${crewN} operatives (expected ${expect})`);

          // Every body has to be somewhere real. A NaN or an absurd coordinate arriving from
          // the authority would be broadcast to every client at once, which is invariant 16
          // at its widest blast radius.
          const finite = withHorde.entities.every(
            (e) => Number.isFinite(e.x) && Number.isFinite(e.y) && Number.isFinite(e.z),
          );
          ok(finite, "every body on the wire has a finite position");

          const ids = new Set(withHorde.entities.map((e) => e.id));
          ok(ids.size === n,
            "and a unique pool id each, which is what lets a client interpolate them",
            `${ids.size} distinct ids`);

          note(
            `at ${n} bodies that is ${(expect * SNAPSHOT_HZ / 1024).toFixed(2)} KiB/s`
            + ` per client, ${(expect * SNAPSHOT_HZ * 4 / 1024).toFixed(2)} for a full crew`,
          );
        }

        // ---- INPUT GOING THE OTHER WAY --------------------------------------
        //
        // Everything above is state travelling down. This is intent travelling up, and it is
        // what makes the server an authority rather than a broadcaster: seat 1 sends "I am
        // holding W" and the server decides where that puts them.
        //
        // Only assertable here. The harness proves the codec and the queue (section 121) and
        // cannot open a socket; the DO cannot be imported at all. So the round trip is checked
        // in this file or nowhere — the same gap that left the whole Worker uncovered until
        // this tool existed.
        const { encodeInput, HELD_BIT } = await import("../src/snapshot.js");

        const seatOf = (s, seat) => s.operatives?.find((o) => o.seat === seat);
        const startSnap = decode(seat1.snaps[seat1.snaps.length - 1].buffer);
        const mineBefore = seatOf(startSnap, 1);

        ok(mineBefore !== undefined,
          "the snapshot carries an operative for this seat",
          mineBefore ? `seat 1 at (${mineBefore.x}, ${mineBefore.z})` : "no seat 1 found");

        if (mineBefore) {
          // Held-only, no edges, one per tick for a second. Held rather than edged on purpose:
          // an edge is consumed exactly once and would prove far less about whether the
          // operative is being driven.
          const TICKS = 60;
          for (let i = 1; i <= TICKS; i++) {
            seat1.socket.send(encodeInput({
              seq: i, clientTick: i, held: HELD_BIT.forward, edges: 0, lookDx: 0, lookDy: 0,
            }).buffer);
            await sleep(1000 / 60);
          }
          await sleep(200);

          const endSnap = decode(seat1.snaps[seat1.snaps.length - 1].buffer);
          const mineAfter = seatOf(endSnap, 1);
          const moved = Math.hypot(
            mineAfter.x - mineBefore.x, mineAfter.y - mineBefore.y, mineAfter.z - mineBefore.z,
          );

          ok(moved > 0.5,
            "the operative MOVES because the server acted on the input it was sent",
            `${moved.toFixed(2)} m over ${TICKS} commands`);
          ok(mineAfter.ackSeq > 0,
            "and the server reports which command it last simulated for this seat",
            `ack ${mineAfter.ackSeq} of ${TICKS} sent`);
          ok(mineAfter.ackSeq >= TICKS * 0.5,
            "having consumed most of them rather than dropping the queue on the floor",
            `${mineAfter.ackSeq}/${TICKS} = ${((mineAfter.ackSeq / TICKS) * 100).toFixed(0)}%`);

          // The per-seat counters, so a failure above names which of three things went wrong
          // rather than leaving "the operative did not move" to be diagnosed by guesswork.
          const diag = (await status(code)).sim?.seats?.find((x) => x.seat === 1);
          if (diag) {
            note(
              `seat 1: ${diag.received} received, ${diag.bad} undecodable, `
              + `${diag.queued} queued, ack ${diag.ack}, ${diag.starved} starved, `
              + `${diag.dropped} dropped`,
            );
            ok(diag.received >= TICKS * 0.9,
              "the commands actually arrived at the Durable Object",
              `${diag.received} of ${TICKS}`);
            const simState = (await status(code)).sim;
            ok(diag.bad === 0,
              "and every one of them decoded on the server side",
              diag.bad
                ? `${diag.bad} undecodable — "${simState?.lastInputError}" `
                  + `(arrived as ${simState?.lastInputShape})`
                : "0 undecodable");
          }

          // NOTHING ELSE MOVED BECAUSE OF IT. Input is per seat, and a bug that applied one
          // client's command to every operative would look like the crew marching in lockstep.
          const others = endSnap.operatives.filter((o) => o.seat !== 1);
          const othersMoved = others.map((o) => {
            const was = seatOf(startSnap, o.seat);
            return was ? Math.hypot(o.x - was.x, o.z - was.z) : 0;
          });
          ok(othersMoved.every((d) => d < 0.2),
            "and no other seat moved, so input is per operative rather than shared",
            others.length
              ? `${others.length} other seat(s), worst ${(Math.max(...othersMoved) * 100).toFixed(0)} cm`
              : "no other seats connected at this point");

          // A malformed command must cost that client one tick, not everybody's session.
          seat1.socket.send(new ArrayBuffer(3));
          await sleep(300);
          const s = await status(code);
          ok(s.sim?.ready === true,
            "a malformed input packet does not take the session down",
            `still simulating, elapsed ${s.sim?.elapsed} s`);
        }
      }
    } else {
      const s = await status(code);
      note(`sim state: ${JSON.stringify(s.sim)}`);
    }
  }

  // Free a seat first, so this is genuinely testing the phase clause and not
  // hitting the FULL clause on the way past. Without this the check would pass
  // for the wrong reason and report 4001 as though it were 4002.
  crew[3].socket.close();
  await sleep(300);
  const s = await status(code);
  ok(s.crew === CREW_MAX - 1, "leaving frees a seat", `${s.crew}/${s.crewMax}`);

  const late = await expectRefusal(code);
  ok(late.refused, "a late joiner is refused even with a seat free");
  ok(late.code === 4002, "refusal names IN PROGRESS, not FULL", `code ${late.code}`);
  note(`reason: "${late.reason}"`);
}

// ---- teardown ------------------------------------------------------------
for (const c of crew) {
  try { c.socket.close(); } catch { /* already closed */ }
}
await sleep(600);
{
  const s = await status(code);
  console.log("");
  ok(s.crew === 0, "every seat released on disconnect", `${s.crew}`);
  ok(s.ticking === false, "tick loop stops with the last player, so the DO can evict");
}

console.log(`\n${checks - bad}/${checks} checks passed`);
if (bad > 0) process.exit(1);
