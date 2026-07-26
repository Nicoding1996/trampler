# Trampler — stack and working discipline

## Stack

- Plain ES modules, no build step, no bundler, no framework.
- three.js 0.170.0, pinned exact, served from `node_modules` so it runs offline.
  The importmap in `index.html` maps `three` and `three/addons/`.
- Post-processing, the HDRI loader and everything else visual comes from
  `three/examples/jsm`, which ships in the npm package. Nothing is downloaded at
  runtime.
- `server.mjs` is a zero-dependency static server bound to 127.0.0.1 only — it
  serves every file under the project root and has no business being reachable
  from the network.

## Art is vendored, and optional

`assets/` holds eight CC0 PBR texture sets and one CC0 HDRI from Poly Haven,
fetched by `npm run assets` and credited in `ATTRIBUTION.md`. Vendored rather than
hot-linked for the same reason three.js is served from `node_modules`: this has to
run offline, because that is where most of the tuning happens.

The whole set is optional at runtime. `src/look.js` treats a missing
`assets/manifest.json` as a visual downgrade and nothing more, and the diagnostics
panel reports which state you are in — otherwise "no art" and "broken texture
path" look identical.

## Commands

```
npm start           # serve on http://localhost:5173
npm run verify      # the whole test suite, headless
npm run audit       # static checks the suite structurally cannot make
npm run imports     # resolve every import against index.html's importmap
npm run smoke       # ask the running server for everything the page needs
npm run assets      # re-fetch the CC0 art
node --check <file> # syntax only

node tools/summarise.mjs run.txt          # failures + totals from a run
node tools/summarise.mjs run.txt 87 88    # ...plus those sections in full
node tools/scene-cost.mjs                 # draw calls, triangles, shadows, lights

# invariant 21, after a change to a simulation module or a seed
node verify.mjs > d1.txt && node verify.mjs > d2.txt && npm run diff
```

## Working discipline

### Done means

- `npm run verify` green. It prints `N/N checks passed` with nothing above it
  marked FAIL.
- `npm run audit` clean, if the change touched `src/`, `index.html` or the frame
  loop.
- `npm run imports` clean, if the change touched an import.
- `npm run smoke` clean, if the change touched `server.mjs`, `index.html` or
  `assets/`. Needs the server running.
- Two runs diffed, if the change touched a simulation module or a seed. That is
  the only thing that confirms invariant 21, and it is the only reason to run the
  suite twice.

None of these needs asking about. They are read-only or write to scratch files,
and they are the fastest way to find out whether a change is right.

### One change at a time

The project's own history is the argument. Three candidate answers to the reactor
wall existed and exactly one was tried, because three simultaneous changes to one
number cannot be attributed afterwards. Wave size and composition are held apart
for the same reason.

That applies to edits as much as to design:

- Do not tune an adjacent number you noticed on the way. Mention it instead.
- Do not fold a refactor, a rename or a comment cleanup into a behaviour change.
  A diff that mixes them cannot be read.
- Do not widen the task. `ROADMAP.md` and the open questions at the end of
  `product.md` are a list of things deliberately not being done yet, not a menu.
- If the request looks mistaken or a better approach exists, say so in a sentence
  and do the thing that was asked.

### Ask before

Almost everything here is local and reversible, so act. Three things are not:

- Changing a seed in `config.js`. Every measured number in these steering files
  and in the test comments was taken under the current seeds. Changing one breaks
  nothing visibly; it silently invalidates the record.
- `npm run assets`, which reaches the network. `assets/` is vendored precisely so
  that nothing routine depends on that.
- Deleting `assets/`. It is a legitimate test of invariant 29 and a re-download to
  undo.

### Delegation

`src/` is 26 files and the map is in `structure.md`, already in context. `npm run
audit` answers most structural questions faster than a search does, and the
harness answers most behavioural ones. A subagent is worth it for a genuinely
wide, independent investigation. For anything finishable in a handful of tool
calls, work directly — and do not delegate verification, because the suite *is*
the verification.

## Verification

`verify.mjs` runs the real simulation modules in Node with no DOM and no
renderer: 98 sections, 643 assertions. The failure modes here — drift, being
yanked off a turning deck, an anchor that does not track the hull, an enemy
shielded by geometry, an automated defence that quietly holds a position — are
invisible to inspection and tedious to confirm by hand.

It has repeatedly caught real bugs that looked fine in review, including both of
the significant findings in the most recent pass. Treat a failure as information,
not as an obstacle, and read the test before repairing it: the assertion usually
encodes a measurement someone took on purpose.

`npm run imports` exists because a project with no build step never validates its
own module graph until a browser tries to load it, and a mistyped path presents as
a blank canvas with one line in the console.

`npm run audit` covers what the harness structurally cannot: that every `CFG.x.y`
path referenced in code resolves, that every element id and CSS class the code
writes exists in the markup, that the headless boundary holds, that no simulation
module has reintroduced `Math.random`, that nothing is exported and forgotten,
that no config knob is unread, that `main.js`'s frame context provides every field
its readers destructure, and that the harness's frame order matches the game's.

That last one earned its keep immediately: it found the only piece of wiring in
the project with no test behind it. The lesson generalises, and it lives in
`structure.md` under "The number keys have exactly one owner per frame".

`npm run smoke` is the only check that touches the HTTP layer, and it needs the
server running. The harness loads modules straight off disk, so a wrong MIME type,
a path the server refuses, or a texture that was never fetched all present
identically in a browser — as nothing at all. It also asserts that nothing outside
the project root is reachable, which is the one security property a server bound to
loopback and serving the whole tree actually has.

Note what that check taught: `fetch` collapses `/../` in a URL before sending it,
and the server clamps a decoded traversal back into the root rather than refusing
it. Two versions of that assertion reported failures against a server behaving
correctly. Only paths that genuinely resolve outside the root are worth asserting.

## Environment quirks

- **The shell wrapper in this environment always reports `Exit Code: 1`**,
  regardless of the real exit status. Ignore it and read the output.
- **The wrapper does not always wait for a child process.** A long run can return
  immediately with no output while still writing. Poll the output file rather than
  trusting the empty return.
- Output is often truncated or mangled. Redirect to a file and read the file:
  `node verify.mjs > out.txt 2>&1`. Clean the file up afterwards.
- **The shell also mangles complex inline `node -e` scripts**, particularly
  regexes containing `^` inside a character class — it silently eats characters
  and you get a `SyntaxError` for code you did not write. Put anything non-trivial
  in a file under `tools/` and run the file.
- **Writing a file and running it in the same tool block races.** The run can
  execute the previous version. Issue the write, then the run, separately.
- **Reusing an output filename fails** with "the process cannot access the file"
  while a previous run still holds it. Use a fresh name, and delete the scratch
  files afterwards.
- **`npm run diff` on a file that is still being written reports a false negative.**
  It printed "NOT DETERMINISTIC: 239 unexplained differences" against two identical
  runs, purely because the second file had reached 594 of its 832 lines. Confirm both
  files end with the `N/N checks passed` line before believing the comparison —
  `node tools/summarise.mjs` on each is the quick way.
- **Grep `includePattern` only honours globs starting with `**/`.** `src/*.js` and
  brace lists like `{a.js,b.js}` silently match *nothing*, which reads as "clean"
  and is how unseeded `Math.random` calls went unnoticed through several searches.
  Use `**/*.js` or `**/enemies.js`.
- Redirecting through PowerShell writes UTF-16, which `findstr` refuses. Redirect
  from cmd, or read the file with the file tools.

## Tests that lie — check for these before trusting a pass

Every one of these produced a green or red result that was wrong:

- **Vacuous tests.** A tunnelling test "passed" because friction ate the velocity
  before impact and the player never reached the wall. The newest example: a test
  of whether road modifiers accumulate took whatever the seeded stream offered,
  got two roads with no modifiers at all, and asserted `1.00 >= 1.00`. A test of
  accumulation has to be *handed something to accumulate*. Always assert that the
  scenario actually happened before asserting its outcome.
- **Asserting the ROLL rather than the thing.** Two tests hard-coded the shop's
  contents — one looked for "RIFLE CALIBRATION" in the panel, the other pressed key
  1 and expected `stacks.rifle === 1`. Both were correct only while the catalogue
  was small enough to fit on the keys, and the moment the shop became a re-rolled
  subset they were measuring the draw. Neither *claimed* to be about the draw: one
  claimed the panel renders, the other claimed key routing works. Read what the
  system is actually offering, then assert on that.
- **A test that supplies the mechanism it is testing.** The proc gate is
  `source === "player"`, and the tempting version of the check calls
  `horde.damage(e, n, "emitter")` directly. That proves the gate works and says
  nothing about whether `emitters.js` passes the string at all — which is the half
  that can rot. Deploy the real emitter and let it kill something.
- **Sampling an oscillating state at one instant.** "Is the chewer parked" and
  "is the gun overheated" both cycle. Measure over a window, or track whether the
  state was *ever* reached.
- **Sampling at the wrong moment in a sequence.** The boss is released first and
  its escort trickles in behind it, so checking the escort's health on the frame
  the boss appears measures an empty set and passes for the wrong reason.
- **Waiting for a coincidence.** A test that waited for a foot to happen to land
  on an enemy measured whether the timing lined up, not whether the shove worked.
  Drive the mechanism directly.
- **Reading a value inside the frame hook.** The hook runs *before* the frame, so
  it sees your raw input, not the clamped result. Sample after the step.
- **Stale transforms.** Setting an aim and immediately reading a muzzle position
  gives you last frame's orientation unless matrices are refreshed.
- **Assertions the fix deliberately invalidated.** When behaviour intentionally
  changes, old assertions fail *correctly*, and repairing the test is then the
  right move. Read it first and be able to say which measurement it encoded.
- **Anything DOM-shaped.** The harness has no DOM, so HUD markup is checked as
  *text*: test 67 asserts every id `hud.js` reaches for exists in `index.html`,
  that no two always-visible panels share a screen anchor, and that no more than
  two are up while playing. A `getElementById` that misses returns null and only
  throws later, somewhere unrelated-looking.
  Test 83 goes further and stubs the two DOM calls `fx.js` actually makes, then
  runs the real particle system and viewmodel against the real simulation. It is
  not a rendering test and cannot be one; it catches "does this execute and stay
  finite", which is otherwise 600 lines nothing in CI ever runs.
- **Nondeterministic scenarios.** Spawn arcs were on `Math.random`, so the same
  code measured 15.2 s and 19.3 s on consecutive runs and an assertion guarding a
  pillar invariant passed or failed at random. If a result moves when nothing
  changed, suspect entropy before suspecting your edit. Everything stochastic is
  seeded now — invariant 21 holds the inventory and the restart rules.
- **Test scaffolding that inherits the wrong state.** A helper that placed the
  operative with `player.position.y || 1.2` picked up their *deck* height on the
  first call, so they hovered above the leg and no repair was ever offered. Set
  the axis you mean explicitly the first time; only preserve values you want
  carried.
- **Sharing a module-level scratch vector with the harness's own invariant
  checks.** `_probe` is used by `step()`. Declare a local one in a test block.

## Performance

"The game is laggy" has four possible causes with four different fixes, and picking
wrong costs a day. `node tools/scene-cost.mjs` reports all four from the real scene
graph in plain node, with no renderer. Run it before optimising anything. The four
symptoms, the fix for each, and what this project actually turned out to have are
in `structure.md` under "Render cost, and where it comes from".

The instinct worth correcting: it is rarely the GPU and rarely a browser limit.
WebGL draws on the GPU, the whole simulation costs 0.40 ms a frame with 400
enemies, and browsers hold 60 fps comfortably at a few hundred draw calls. Reach
for the measurement before reaching for that explanation.

## Coordinate traps

- **Local y = 0 is the DECK SURFACE, not the ground.** The ground is at
  `-CFG.trampler.deckHeight`. Placing something at local y 1.2 puts it in mid-air
  above the hull. This has caused two separate test bugs.
- Local forward is -Z, so a heading of `(dx, dz)` is `yaw = atan2(-dx, -dz)`.
- `probeGround` treats anything within 0.35 m below the feet as ground, so a
  player can count as grounded while slightly airborne.
- The feet sit at local x ±9.9, outboard of the 8 m hull half-width, while
  attackers latch at ±7.0. That 2.9 m gap is load-bearing — see invariant 2c.

## Config conventions

Every feel-relevant number lives in `src/config.js` with a comment explaining
why it has that value, especially where the value was arrived at empirically.

Add a per-enemy-type field to `ENEMY_BASE` first, with a default. `enemyType()`
throws if an override introduces a key the base lacks — `structure.md` has the
bug that rule exists to prevent, under "Enemy types are built by a factory that
throws".

Effect sizes go in config; effect behaviour does not. `CFG.fortress.driveScale` is
data. The closure that applies it lives in `modules.js`, next to the other
closures, because a function in a config file cannot be read beside the number it
modifies.

Never write a run's state into `CFG`. Upgrades, modules and road modifiers are all
instance multipliers on the owning object, recomputed absolutely from their stack
count. `structure.md` has the reasoning under "Upgrades and modules are instance
multipliers".

### Adding an item to the salvage table

Four places, and test 91 fails loudly if you miss one:

1. `CFG.economy.catalogue` — `id`, `name`, `detail` (one line a player can read
   while a wave is inbound), `pool`, `max`, and a `rarity` tier. Do **not** set a
   `cost`: the tier supplies cost and growth, and an explicit cost is reserved for
   the two bounded scrap refits.
2. `CFG.items.<id>` — the numbers, additive to the weapon's base 1 so "+0.30" reads
   as +30%.
3. Either `ITEM_EFFECTS` in `items.js`, if it is a function of stack count alone, or
   `Items.update` / `#onKill` / `#onHit` if it depends on the world. Not both.
4. Nothing in `hud.js`. The shop, the pick panel and the build readout are all driven
   off the catalogue.

Then ask the question invariant 2b-i exists for: **does this let one position do the
other's job?** If it is a proc, it must gate on `source === "player"`, and test 77
has to still report the fortress crippled at 131.1 s with the item fitted.
