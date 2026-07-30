// What interval can a timer on THIS machine actually hold?
//
//   node tools/tick-granularity.mjs
//
// WHY
//
// tools/smoke-lobby.mjs measured a Durable Object ticking at 32.81 Hz against a
// requested 60, and both of its independent measurements agreed: the client saw
// 195 ticks in 5.94 s, and the DO's own deltas came out at p50 31 ms against
// 16.67 requested. Two clocks agreeing rules out a measurement error.
//
// It does NOT rule out the machine. 31-32 ms is almost exactly twice the 15.6 ms
// timer granularity Windows has had for decades: a 16.67 ms request that cannot be
// served at 15.6 rounds up to the next tick at 31.2. If plain node on this box
// shows the same ceiling, the finding is about Windows and says nothing about an
// edge PoP -- and the deployed number is the only one that describes a player.
//
// So this measures plain node, with no workerd and no network, at several
// requested intervals. A flat result across all of them is a granularity floor.
// A result that tracks the request is a real workerd limit.

const SAMPLE_MS = 2000;

// 16.67 is the one under test. The others bracket it: if 8 and 4 also land on
// ~15.6 then the floor is the clock, and asking for less than a frame is free.
const REQUESTS = [1000 / 30, 1000 / 60, 8, 4, 1];

function percentiles(values) {
  const d = [...values].sort((a, b) => a - b);
  const at = (q) => d[Math.min(d.length - 1, Math.floor(d.length * q))];
  return { p50: at(0.5), p95: at(0.95), max: d[d.length - 1] };
}

function measure(requestedMs) {
  return new Promise((resolve) => {
    const deltas = [];
    let ticks = 0;
    let last = performance.now();
    const started = last;
    const timer = setInterval(() => {
      const now = performance.now();
      deltas.push(now - last);
      last = now;
      ticks++;
    }, requestedMs);
    setTimeout(() => {
      clearInterval(timer);
      const elapsed = (performance.now() - started) / 1000;
      resolve({ requestedMs, ticks, elapsed, hz: ticks / elapsed, ...percentiles(deltas) });
    }, SAMPLE_MS);
  });
}

console.log(`plain node ${process.version} on ${process.platform}\n`);
console.log("requested    achieved      delta p50    p95      max");

for (const r of REQUESTS) {
  const m = await measure(r);
  console.log(
    `${r.toFixed(2).padStart(6)} ms  `
    + `${m.hz.toFixed(2).padStart(7)} Hz  `
    + `${m.p50.toFixed(2).padStart(9)} ms  `
    + `${m.p95.toFixed(2).padStart(6)}  `
    + `${m.max.toFixed(2).padStart(7)}`,
  );
}

console.log(
  "\nA flat floor across every request is the OS clock, not the runtime."
  + "\nIf that floor is ~15.6 ms then a 16.67 ms request rounds to ~31 ms, which"
  + "\nis the number the lobby probe reported — and the fix is an accumulator that"
  + "\nasks for a SHORTER interval and steps on measured elapsed time, which is the"
  + "\nfixed-timestep work already first on the plan.",
);
