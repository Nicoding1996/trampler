# Trampler — stack and working discipline

## Stack

- Plain ES modules, no build step, no bundler, no framework.
- three.js **0.170.0**, pinned exact, served from `node_modules` so it runs
  offline. The importmap in `index.html` points at
  `/node_modules/three/build/three.module.js`.
- `server.mjs` is a zero-dependency static server bound to **127.0.0.1 only** —
  it serves every file under the project root and has no business being reachable
  from the network.

## Commands

```
npm start          # serve on http://localhost:5173
node verify.mjs    # the whole test suite, headless
node --check <file> # syntax only
```

## Verification

`verify.mjs` runs the real simulation modules in Node with no DOM and no
renderer. 61 sections, 272 assertions. **Run it after every change.** The
failure modes here — drift, being yanked off a turning deck, an anchor that does
not track the hull, an enemy shielded by geometry — are invisible to inspection
and tedious to confirm by hand.

It has repeatedly caught real bugs that looked fine in review. Treat a failure as
information, not as an obstacle.

## Environment quirks

- **The shell wrapper in this environment always reports `Exit Code: 1`**,
  regardless of the real exit status. Ignore it and read the output.
- Output is often truncated or mangled. Redirect to a file and read the file:
  `node verify.mjs > out.txt 2>&1`. Clean the file up afterwards.
- **Writing a file and running it in the same tool block races.** The run can
  execute the previous version. Issue the write, then the run, separately.
- **Reusing an output filename fails** with "the process cannot access the file"
  while a previous run still holds it. Use a fresh name, and delete the scratch
  files afterwards.
- **Grep `includePattern` only honours globs starting with `**/`.** `src/*.js` and
  brace lists like `{a.js,b.js}` silently match *nothing*, which reads as "clean"
  and is how unseeded `Math.random` calls went unnoticed through several searches.
  Use `**/*.js` or `**/enemies.js`.
- Redirecting through PowerShell writes UTF-16, which `findstr` refuses. Redirect
  from cmd, or read the file with the file tools.

## Tests that lie — check for these before trusting a pass

Every one of these produced a green or red result that was wrong:

- **Vacuous tests.** A tunnelling test "passed" because friction ate the velocity
  before impact and the player never reached the wall. Always assert that the
  scenario actually happened before asserting its outcome.
- **Sampling an oscillating state at one instant.** "Is the chewer parked" and
  "is the gun overheated" both cycle. Measure over a window, or track whether the
  state was *ever* reached.
- **Reading a value inside the frame hook.** The hook runs *before* the frame, so
  it sees your raw input, not the clamped result. Sample after the step.
- **Stale transforms.** Setting an aim and immediately reading a muzzle position
  gives you last frame's orientation unless matrices are refreshed.
- **Assertions the fix deliberately invalidated.** When behaviour intentionally
  changes, old assertions fail *correctly*. Read before repairing.
- **Nondeterministic scenarios.** Spawn arcs were on `Math.random`, so the same
  code measured 15.2 s and 19.3 s on consecutive runs and an assertion guarding a
  pillar invariant passed or failed at random. The horde now draws from a seeded
  stream (`CFG.enemies.seed`). If a result moves when nothing changed, suspect
  entropy before suspecting your edit — and confirm by running the suite twice.
- **Test scaffolding that inherits the wrong state.** A helper that placed the
  operative with `player.position.y || 1.2` picked up their *deck* height on the
  first call, so they hovered above the leg and no repair was ever offered. Set
  the axis you mean explicitly the first time; only preserve values you want
  carried.

## Coordinate traps

- **Local y = 0 is the DECK SURFACE, not the ground.** The ground is at
  `-CFG.trampler.deckHeight`. Placing something at local y 1.2 puts it in mid-air
  above the hull. This has caused two separate test bugs.
- Local forward is **-Z**, so a heading of `(dx, dz)` is `yaw = atan2(-dx, -dz)`.
- `probeGround` treats anything within 0.35 m below the feet as ground, so a
  player can count as grounded while slightly airborne.

## Config conventions

Every feel-relevant number lives in `src/config.js` with a comment explaining
*why* it has that value, especially where the value was arrived at empirically.

**Per-enemy-type fields must be added to every type.** Adding `climbTime` or
`reactorReach` to climbers but not chewers produces `d < undefined`, which is
always false, and silently makes that enemy harmless. This has happened twice.
