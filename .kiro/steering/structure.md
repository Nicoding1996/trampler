# Trampler — code structure

28 modules, ~14,900 lines in `src/`, plus an ~11,300-line headless harness and a
~900-line Worker.

Line counts below are rounded to the nearest ten and are there for a sense of
weight, not as a fact to rely on. They drift every commit.

```
index.html          canvas, HUD markup, importmap, click-to-play gate
server.mjs          loopback-only static server
verify.mjs          headless harness — every simulation module, no DOM, no GL
wrangler.jsonc      deployed: static assets + the Worker, scoped to /lobby/*
wrangler.dev.jsonc  local: the lobby only, no assets block — see its own comment
worker/
  index.js     600  the Worker + the Lobby Durable Object: join codes, 4 seats,
                    a 60 Hz accumulator tick, pose fan-out, named refusals
  sim-check.js 300  SPIKE: can the real simulation load and step inside workerd?
tools/
  audit.mjs         static checks the harness structurally cannot make
  scene-cost.mjs    draw calls, triangles, shadow casters, lights — no renderer
  fetch-assets.mjs  pulls the CC0 art from Poly Haven, md5-checked, idempotent
  check-imports.mjs resolves every import against index.html's real importmap
  smoke-serve.mjs   asks the running server for every file the page needs
  smoke-lobby.mjs   asks a running lobby for its tick rate and its refusals
  sim-check.mjs     reads the spike from a running Worker, and TIMES it itself
  sim-check-node.mjs  runs the spike in plain node, no wrangler needed
  sim-cost-window.mjs per-frame cost across a run, to catch a density effect
  tick-granularity.mjs  the ~15.5 ms timer floor that forced the accumulator
  per-operative-probe.mjs  crew-scaling measurements
  economy-collision.mjs    shop/pick/road key-routing collisions
  diff-runs.mjs     two runs must differ only in the wall-clock timing
  summarise.mjs     failures + totals from a run, since the output is 700 lines
assets/             vendored CC0 textures + HDRI, plus manifest.json
src/
  config.js   2110  every tunable, with a comment explaining each value
  util.js       60  box(), boxToMesh(), seeded RNG, clamp/lerp/damp/smoothstep
  look.js      480  HEADLESS-SAFE materials, UV tiling, enemy silhouettes
  collision.js 180  space-agnostic AABB resolve, ground probe, mantle search
  world.js     440  terrain, lighting, scatter, horizon silhouettes, fog
  trampler.js 1290  the fortress: geometry, gait, spatial damage, transforms
  player.js    570  FPS controller, based movement, mantle, health
  crew.js      140  1-4 operatives: the roster, and the aggregates ABOUT them
  grapple.js   280  winch: hull-local anchors, brake, cut-vs-arrive release
  enemies.js  1560  pooled horde, instanced draw, spatial hash, wounded tint
  waves.js     510  director: pacing, size vs roster tier, composition, the boss
  run.js       500  legs, the pick cadence, road vote, cumulative modifiers
  weapon.js    490  the single hitscan path, the aim scan, tracers, impacts
  deckgun.js   300  manned mounts, hull-local traverse arcs, heat, one operator
  repair.js    260  contextual repair, one welder per point, ground markers
  emitters.js  300  hull-mounted shock emitters: the tower-defence layer
  modules.js   200  three hardpoints, six modules, absolute-from-count effects
  events.js    130  the kill/hit bus items hang procs off, with a depth cap
  items.js     370  the salvage table: static effects, conditionals, procs
  economy.js  1170  a shared Treasury + one Economy per operative, shop, pick
  hud.js      1020  gauges, prompts, shop, bay, pick, route, target, buffs
  render.js    390  renderer, EffectComposer chain, camera shake
  fx.js        470  one pooled particle system, muzzle light
  viewmodel.js 290  the rifle in your hands
  audio.js     290  synthesised mixer, no audio files
  net.js       490  BROWSER-ONLY multiplayer client — today a pose RELAY
  input.js      90  keyboard/mouse, pointer lock
  main.js      570  wiring, the fixed-timestep accumulator, and the frame loop
```

## The headless boundary

This is the most important structural rule in the project, and it is what makes an
11,000-line test harness possible at all — and, it turns out, an authoritative server.

The harness constructs the **real** `World`, `Trampler`, `Player`, `Horde`,
`Director`, `Weapon`, `Repair`, `DeckGun`, `Emitters`, `Modules`, `Events`,
`Economy`, `Items` and `Run` in plain node, with no GL context and no DOM. So:

- Anything those modules import must work with no `document` and no `window`.
  `look.js` is the only visual module they are allowed to touch, and it checks
  `typeof document === "undefined"` once at load and degrades to flat materials.
- `render.js`, `fx.js`, `viewmodel.js` and `audio.js` are imported by `main.js`
  **only**. They are browser-only by design.
- Those four are **pure readers**. They poll counters the simulation already keeps
  for its own reasons — `trampler.footfalls`, `trampler.stepCount`, `weapon.shots`,
  `horde.killCount`, `horde.lastKill`, `player.hurtCount`, `economy.purchases`,
  `economy.earned`. The simulation has no idea a renderer, a particle system or a mixer
  exists.

  `economy.earned` is the newest and it makes the pattern explicit: **poll a counter, do
  not watch a value.** The income tick needs "what just arrived", and the obvious source
  is the purses — but those go DOWN on a purchase, so the readout would report spending as
  negative income and would lose a payout that a purchase in the same frame cancelled out.
  `earned` only ever rises within a run, which is what makes a frame-to-frame delta on it
  mean what it looks like. Same shape as the damage flash reading `hurtCount` rather than
  health, and for the same reason. A reset zeroes it, so the reader has to treat a negative
  delta as "re-baseline", not as a number to draw.
- Addon imports (`three/addons/...`) only appear in the browser-only modules, or
  behind the headless guard as a dynamic `import()`. A static addon import in a
  simulation module would put a path in the graph that resolves only through the
  dev server, and the harness would die on load.

`npm run imports` enforces the resolution half of this by parsing the importmap
out of `index.html` and checking every specifier. In a project with no build step,
a mistyped path is a blank canvas and one line in the console.

### And the boundary paid for itself somewhere it was not designed for

The rule was written so a test harness could exist. Its unplanned dividend is that
**the simulation runs unmodified inside a Cloudflare Durable Object** — measured, not
assumed: `npm run sim:worker` constructs the real `World`, `Trampler`, `Player`, `Crew`,
`Horde`, `Director`, `Weapon` and `Events` in workerd, fills a 400-body pool and steps
it, with every position finite. That is the question that could have torn up the netcode
plan, and the answer is yes with roughly a 17x margin inside a 16.7 ms tick.

workerd is a *stricter* environment than the harness, which is worth stating because it
inverts the usual reading of this rule. Node has no `document` either, but `look.js`
degrades to flat materials and carries on. workerd has no DOM and no shim for one, so the
same reach is a load failure at import time — before any of the server's own error
reporting runs, which is how it would present as "the simulation cannot run here".
`npm run audit` now holds the boundary over `worker/` for exactly that reason, and holds
the no-`Math.random` rule there too: on the authority, an unseeded draw desyncs every
client at once and presents as rubber-banding rather than as a determinism bug.

One caveat on the bundle. Every simulation module imports `Vector3` or `Matrix4`, so
three.js is in the deployed Worker unconditionally — about 921 KB. That is the
architecture's cost, not the spike's, which settles the question of whether
`worker/sim-check.js` earns its place: it is free, and it stays.

## Architectural patterns

### Frame-relative simulation

Everything attached to the fortress is stored in **hull-local space** and read
back out through the hull's current transform. This is the single most important
pattern in the codebase and it is why a walking, turning fortress needs almost no
special-case code.

Applies to: player position and velocity while aboard, grapple anchors, mantle
start/destination, enemy climb routes, boarders standing on the deck, latched
attackers riding a leg, leg repair points, gun mounts and their traverse arcs,
deployed shock emitters, module sockets, foot positions for the stomp, and the refit
terminal's interaction point — stored world-space it would be four metres astern within a
second and the shop would open and close as the fortress walked out from under it.

If something needs to stay put relative to the fortress, parent its mesh to
`trampler.group` and store its position in local space. Anything anchored in
world space is four metres behind within a second.

The player's `velocity` is stored **relative to its base** while attached.
`attachTo()` converts between frames so world motion is unchanged by the switch.
Consequences that all point the right way: holding W walks at walk speed
regardless of hull speed; stepping off carries the hull's momentum including the
tangential component from yaw; a straight-up jump lands where it took off.

When arriving somewhere aboard, set `base` and zero `velocity` **directly**.
Letting `attachTo()` convert a zeroed world velocity injects a backwards kick
equal to the hull's speed. This bug has been fixed three times in three places.

### Space-agnostic collision

`collision.js` takes positions, boxes and velocities in whatever space the caller
uses. Terrain is resolved in world space; the deck is resolved in hull-local
space. Because the hull only ever yaws, local-space AABB collision is **exact**,
not an approximation — that is the whole reason the deck never pitches or rolls.

Boarders reuse the same idea with a cheaper solver: `#avoidDeckScenery` pushes
them out of `trampler.deckObstacles` on x/z only, in hull space. `deckObstacles`
is a *subset* of `colliders` — the hull slab and deck skin are floors, and
including them would push every boarder off the ship.

### Crowds

Enemies are plain objects in a fixed pool, drawn with `InstancedMesh`, with a
uniform spatial hash for neighbour separation. There is no `Object3D` per enemy.
Built this way from the start because retrofitting crowd tech is a rewrite.

**Cost is a function of DENSITY, not of head count, and the figure in these files was
taken at the cheapest moment in a run.** 0.40 ms/frame was quoted here and in `tech.md`
for a long time. It is what test 17 measures, and test 17 times a short window straight
after 400 bodies spawn — on a ring 63 m out, maximally dispersed, sharing almost no
spatial-hash cells. Then they converge under an 8 m hull.

Measured with `node tools/sim-cost-window.mjs`, 400 chewers over 1200 frames:

| crowd spread, hull space | ms/frame |
|---|---|
| 34 m — just spawned, on the ring | 0.30 |
| 20 m — closing | 1.12 |
| 9 m — packed under the hull | 1.25 – 1.95 |

Whole run: **0.6 – 0.95 ms/frame, so roughly 40 – 55 ms of CPU per wall-clock second.**
Six-fold between the cheapest and dearest phases, and the expensive phase is the one the
game is actually about — bodies contending around the legs is the under-hull arena, not
an edge case.

**Quote that as a range, because it will not reproduce tighter than that.** Four runs of
identical code on one machine gave 0.62, 0.83, 0.88 and 0.94 ms/frame; the spread is
background load, and the earlier single-figure readings in these files were each one
sample presented as a measurement. The *ratio* between phases is solid — both clocks
agree to three decimals within a run — and it is the ratio that carries the lesson. Any
budget argument that needs better than ±35% on the absolute number needs a repeated
measurement first.

Two things follow. Quote the whole-run figure, not test 17's, for anything that is a
budget. And note that this is the same trap the test suite has been caught by three
times: *sampling at the wrong moment in a sequence*. It happened here in a profiler,
with a number that then sat in two steering files for months.

The pool cap is `CFG.enemies.max` at 420; 400 is what test 17 fills and what every
measurement above is taken against.

Six types, one `InstancedMesh` each, plus one for the spoil heaps that mark a
burrowing enemy. Per-type numbers come from `enemyCfg(type)` — there are **no**
`type === CHEWER ? a : b` ternaries left anywhere, because that pattern is how a
newly added type silently inherits the wrong numbers.

Nothing allocates in the per-enemy loop. `_yAxis` was hoisted out of it after
being spotted as 400 `Vector3`s a frame, and test 17 pins the whole simulation
step under a millisecond.

### One hitscan path, one armour path

`Weapon.shootFrom(origin, dir, profile, muzzle)` is the **only** place geometry
occlusion is applied. The rifle and both deck guns route through it, so the rule
that keeps chewers safe beneath the hull cannot drift between weapons.

`Horde.damage` is the **only** place armour is applied, for the same reason: every
damage source in the game funnels through it, so a newly added weapon cannot
accidentally ignore armour and quietly make the bulwark pointless. It is also
where `onKill` fires, which is how the economy hears about every kill.

Railings are excluded from the bullet occluder set: they are collision geometry
for bodies, not for bullets.

### Driven player states

Three things take over the player's position and skip normal movement and
collision: grapple reeling, mantling, and manning a station. `Player.update`
branches on them in that order of priority. Each is responsible for restoring a
sane `base` and `velocity` when it ends.

### Upgrades and modules are instance multipliers, recomputed absolutely

`economy.js` and `modules.js` both apply every purchase as a multiplier on the
owning object — `weapon.damageScale`, `weapon.fireRateScale`, `player.damageScale`,
`player.maxHp`, `trampler.damageScale`, `trampler.driveScale`,
`trampler.reactorScale`, `repair.rateScale`, `horde.climbScale`,
`emitters.bonusSlots`, `gun.heatScale`. Never by editing `CFG`.

Two reasons this matters more than it looks. Writing a run's upgrades into `CFG`
would leak them into every later test in the same process, which a debug knob very
nearly did once already. And a restart that kept the previous run's stats would
make each attempt quietly easier, which destroys the whole point of the seeded
fight: two attempts at the same wave being comparable.

And every effect is a function of the **current stack count**, written absolutely
rather than incremented on purchase. So `applyAll()` with every count at zero *is*
the reset, and there is no separate revert path to forget to write. The bug that
rules out — a modifier surviving a reset because someone added a purchase path and
not its opposite — is invisible until two runs disagree.

Effects live in `ITEM_EFFECTS` in `items.js` and `EFFECTS` in `modules.js`; their
sizes live in `config.js` next to their rationale. `tech.md` has the convention
under "Config conventions".

### Conditional effects are a SEPARATE field, rebuilt every frame

Half the salvage table only pays under a condition — beneath the hull, on a
station, for three seconds after boarding, while the reactor is failing. None of
that can live in `weapon.damageScale`, and the reason is the rule above: that field
is derived absolutely from stack counts, so a timed write into it is either erased
by the next recompute or accumulates forever.

So conditionals land in `weapon.damageBonus`, which `Items.update` **clears and
rebuilds from current conditions every frame**. Absolute again, for the same
reason, and the shot reads `damageScale + damageBonus`. Two fields, one discipline.
`Items` also publishes `bonus` and `reasons` — `["UNDER HULL", "BOARDED"]` — which
is what the buff strip draws, because a condition the player cannot see is a
condition they cannot learn.

Note what that means for a reset: `economy.reset()` restores the static half via
`applyAll()` at zero, and the conditional half is restored by the next frame's
recompute finding no stacks to read. Neither has an uninstall path. Test 92 reads
all nine affected fields in one place, so an effect that starts writing somewhere
new shows up as an unreverted value rather than as two runs disagreeing later.

### Procs hang off a bus, and gate on who caused the kill

`events.js` is a two-channel bus — `onKill` and `onHit` — with named arrays and
named emit methods rather than a string-keyed map, because a misspelled channel
name fails *silently* in both directions and a typo should be a `TypeError`.
`Horde.#kill` and `Weapon.shootFrom` are the publishers; `Economy` (income) and
`Items` (procs) are the subscribers, and their listeners are **never** removed on
reset or income stops silently.

Two things about it are load-bearing:

- **A depth cap.** An on-kill item that deals damage re-enters its own listener,
  and two perfectly reasonable items compose into unbounded recursion.
  `CFG.events.maxProcDepth` is 4, applied with `try/finally` so a throwing item
  cannot leave the counter high and kill every proc for the rest of the run.
- **`source` gates procs, not income.** `Horde.damage(e, amount, source, pierce)`.
  Emitters pass `"emitter"`, the rifle and both manned guns pass `"player"`, and
  every proc requires `"player"`. Without that gate an emitter kill triggers a
  splash that kills two more, which is automation compounding itself with nobody
  present — invariant 2b failing in a way nothing looks wrong about. Income
  deliberately ignores `source` and pays either way.

### What a predicting client may and may not run

Two decisions taken before the snapshot layer exists, because both are hazards *now* —
the code that would trip them is the next thing anyone writes, and both fail silently.
Recorded at their hazards as well, in `economy.js` and `weapon.js`.

**A CLIENT DEALS NO DAMAGE.** Its shot is presentation only: muzzle, tracer, recoil,
audio. It never routes through `Horde.damage`, so `emitKill` and `emitHit` never fire
locally, so no local kill, no local proc, no local income. The server runs the real
`shootFrom` and the snapshot carries the consequences.

This is load-bearing rather than tidy, because of a rule that is already true: every
`Economy` and every `Treasury` subscribes to the kill bus in its constructor and
listeners are **deliberately never removed**. A client still needs an Economy —
`applyAll()` is what writes `weapon.damageScale`, `player.maxHp` and the rest, and
predicting your own movement and damage needs those right locally — so a client Economy
that also heard kills would be a second writer to a purse the snapshot overwrites twenty
times a second. The symptom is an income tick that flickers or double-counts, which
nobody would read as a netcode bug. `Items` subscribes to `onHit` as well, so the same
mistake fires procs and advances the proc stream too.

Guarded twice on purpose. A client passes **no bus** at all: `events` is read for nothing
except the subscription, so `events: null` yields a fully working Economy that cannot pay
anybody, and the existing `?.` makes that free. Rule one is the design; rule two is what
holds when somebody later has a good reason to emit locally.

**A STREAM IS ORDER-DEPENDENT, SO ANYTHING THE CLIENT MUST AGREE ABOUT IS KEYED ON AN
INDEX INSTEAD.** `shootFrom` draws cone spread from `CFG.combat.weapon.seed`, two values
per pellet. A client and a server each holding `makeRandom(sameSeed)` agree only while
they make identical draws in identical order — and they will not, because a client
mispredicts a shot the server refused for heat or for a station change. From that frame
the two are permanently one draw apart. Not drift: two different sequences, and a tracer
that points where the authoritative round did not go, for the rest of the run.

So spread becomes a hash of `(input sequence, shot index, pellet index)` — values both
sides already have, since the server knows which input sequence it processed. Order-
independent, so a mispredicted shot costs nothing. Invariant 21 is untouched: a hash of a
sequence number is still reproducible and still has no `Math.random` in it.

The general form is the useful part. **Anything the client must agree with the server
about is keyed on an agreed index; anything the server decides alone keeps its stream,
because the client is told the outcome rather than reproducing it.** Spawn bearings, wave
composition, road offers, shop stock and item procs are all the second kind and change
not at all. Surveyed, and cone spread is the *only* value of the first kind in the
project — `player.js`, `grapple.js`, `deckgun.js`, `repair.js` and `emitters.js` hold no
seeded stream, and `items.js`'s proc stream never advances on a client that deals no
damage.

### Wave SIZE and wave ROSTER run on different counters

`buildWave(wave, tier)`. `wave` rewinds at every landmark and decides how many
enemies arrive; `tier` carries across landmarks and decides which types.

They were one counter, and the result was the flattest thing in the run: a landmark's
first wave was always seven chewers and three climbers, so the fight *after* a road
was structurally simpler than the one before it. Four repetitions of one five-wave
curve, escalating only through multipliers on enemy health nobody can perceive.

The split is invariant 19e restated. Size was tuned against measured pacing and is
not what was wrong; moving both at once is what makes a later difficulty change
impossible to attribute to either.

Two things protect the arena the escalation happens in, and both were found by
measuring rather than by reasoning:

- **Chewers are a reserved floor, not the remainder.** They used to be whatever was
  left after the specials, with a comment noting the caps were the only thing
  stopping that reaching zero. Carry the tier across landmarks and the ramps want
  three bulwarks and three sappers against a ten-enemy first wave. A wave with no
  chewers has nothing under the hull, which deletes half the pillar silently.
- **Allocation is two passes, and the first one is why.** One of every type *due* at
  this tier, then the remainder in priority order. A single priority pass let the
  bulwark ramp take the room and the SAPPER vanished from the wave — the one enemy
  that is a timer rather than a damage race. Escalating a roster and having it eat
  itself is worse than not escalating it.

### The simulation publishes what the HUD needs; the HUD computes nothing

Established by the pure readers (`fx.js` polls `trampler.footfalls`), and Update 1.5
added three more:

- `weapon.aimTarget` / `aimDist` / `aimArmour` — what a shot fired right now would
  hit. In `weapon.js` rather than `hud.js` for the reason the number-key router is in
  `economy.js`: the harness cannot import `main.js` or see the DOM, so a rule that
  lives in the HUD has no test behind it. It is also the honest home, since "would
  this shot land" is the weapon's own question and therefore goes through the same
  occlusion clip that keeps chewers safe under the hull.
- `items.bonus` / `items.reasons` — the live conditional damage and why.
- `run.modifiers` / `run.roadsTaken` — what the roads have cost so far.
- `emitters.ready` — whether X would do anything from where the operative is standing.
  Published rather than left as a call the HUD makes for itself, and the reason is small
  but worth keeping: `canDeploy()` writes `blockReason` as a side effect, so a pure reader
  invoking it is reaching in to mutate the module it reads. Idempotent, and still the wrong
  direction. The prompt asks every frame, so it wants a field.
- `economy.atTerminal` / `browsing` / `open` / `safeMoment` / `pickOpen` / `closedReason` —
  the shop's whole state, decided in the module and merely drawn. Both the panels and the
  number-key router read the same getters, which is the point: a HUD that decided for
  itself when to show the pick would be a second safety rule, and two nearly-identical
  safety rules drift until the shop and the pick disagree about whether the moment is safe.

  The layering is worth stating because it is easy to collapse. `safeMoment` is the shared
  safety half — no wave out, nothing within 6 m. `open` adds `atTerminal`; `pickOpen` does
  not, because buying happens at a console and a pick is handed to you. `browsing` is
  `atTerminal` alone, which is what makes the panel readable before it is usable.
  `closedReason` exists so a refusal names the clause that refused rather than a generic
  "not now" that sends the player to fix the wrong thing.

Note the ORDER lesson buried in the aim scan. `shootFrom` clips on geometry first,
because the clip decides where the tracer ends. The scan must do the opposite — walk
the horde first and only clip if something is on the ray — because no clip can produce
a target when the horde is not there. Copying the shot's order cost 0.21 ms a frame at
a full pool, against a whole-simulation budget of one millisecond, for a readout under
the crosshair. `intersectObjects` is the expensive call, not the pool walk.

### Run modifiers are instance state too

`run.threatScale`, `run.extraCount`, `run.fogScale` and `horde.speedScale` are the
road modifiers. Same discipline, same reason. `world.setFogScale()` exists rather
than a `CFG.world.fogNear` edit.

### Enemy types are built by a factory that throws

`config.js` spreads every type from `ENEMY_BASE` through `enemyType()`, which
**throws** if an override introduces a key the base does not have. That is the
exact shape of the bug that has happened twice: a field added to one type and
nowhere else reads as `undefined` on the others, and `d < undefined` is always
false, which silently makes that enemy harmless. You cannot write it any more
without the module failing to load. Test 68 checks the other direction — that all
six types have an identical field set.

### Frame order matters

```
trampler.update            hull moves first, so everything aboard inherits this frame
trampler.resolveStomps     footfalls resolve against where things actually are
director.update            waves
run.update                 offers a pick then roads if held; advances nothing itself
player.prepareStep         apply look + hull carry before any action reads the pose
handleStationInput         mount/dismount, so it takes effect the same frame
grapple.handleInput        fire before the player's driven movement
player.update              driven states, integrate, collide, camera
repair.admit               claims carried hands from current range, health and ownership
weapon.update              active repair suppresses firing, not cooldown or aim scanning
gun.update                 aim visuals, fire, heat
repair.work                samples remaining threats and applies progress in its old slot
emitters.update
items.update               conditionals built from the position this frame ENDED in
handlePurchasing           pick, road, bay or refits — exactly one owns the keys
horde.update               reads the hull transform after it has moved
grapple.updateVisuals      against a fresh camera
world.updateSun
shake.update               AFTER player.update, which writes the camera outright
viewmodel / fx / audio     pure readers
hud.update
input.endFrame
post.render
```

Repair admission has to run after movement but before the personal weapon. Its `active`
state includes the real range, target health and one-welder claim, so gating on
`player.repairing` suppresses only work that actually happens — not raw E. Progress is a
separate post-weapon call: threat sampling stays where repair lived before hands arbitration,
so a carried or station shot that clears the final nearby hostile still earns full-rate work
on that same frame. The same split in `main.js`, the harness and both session loops prevents
a first-frame shot without changing contested timing.

A browser predicts only its own operative, so its `Crew` cannot answer which point a
remote welder owns. Operative snapshots therefore carry `repairTarget` as an exact key
(`reactor` or `leg:n`), and `Repair` replaces its external claims from every newest
snapshot. The same key becomes a temporary preference for the local operative: position
stays predicted, but two overlapping points cannot remain disagreed merely because the
position error is smaller than reconciliation's dead-zone. Range, damage and ownership are
still revalidated locally, so the key grants no work. These are absolute snapshot facts, not
events; teardown clears both remote claims and the local preference, and respawn clears the
published player claim at the teleport itself.

The input command is captured before prediction but committed afterwards: if repair was
admitted it carries repair without carried fire; otherwise it carries fire without repair.
On the first simultaneous request both clients may predict the weld and authority still
chooses one, but the loser receives no surprise fallback shot; once the exact claim
returns, that client can immediately choose to cover instead. The authority independently
rejects carried fire from an untrusted on-foot packet that retains both bits, so bypassing
client commitment cannot recreate that fallback shot.

A manned station is the deliberate exception. Its trigger belongs to the deck gun, not the
carried weapon, so admitted reactor repair preserves the fire bit while mounted. The
personal `Weapon` returns before arbitration whenever a station is occupied; deck-gun
behaviour and tuning are therefore unchanged.

`trampler.resolveStomps(horde, player)` is called explicitly rather than from
inside `update()`. The fortress does not get to hold references to the horde or
the player: keeping the coupling at the call site is what lets a test drive a
footfall and assert on it directly, and it keeps the order visible.

`shake.update` must come after `player.update`, because the controller assigns
`camera.position` and `camera.rotation` outright every frame. Anything added
before it is discarded — the same class of mistake as reading a clamped value
inside a frame hook.

`scene.updateMatrixWorld(true)` is called once after setup, because raycasting
needs current matrices and the renderer only refreshes them at draw time — which
is after the frame's grapple cast.

`scene.add(camera)` is required, because the viewmodel is parented to the camera
and children of a camera are only traversed if the camera is in the graph.

### The number keys have exactly one owner per frame

The refit panel (1-6), the refit bay (Tab, then 1-6), a road choice (1-2) and a
pending salvage pick (1-3) all want the same keys. `routePurchaseInput` in
`economy.js` picks one owner in priority order — **pick, road, bay, panel** — and
hands `null` as the input to the others. Two consumers of one key set is a bug
waiting for the frame both are visible.

The pick's claim is gated on `economy.pickOpen`, not on the offer existing. A pick now
*waits* for a safe window, and a claim it cannot act on is worse than no claim: the keys
would be owned by something that refuses them and unavailable to the shop or the bay for
as long as the pick sat there. **An owner that can refuse must not claim.**

The refit panel is the exception that proves the rule, and it is deliberate: it is *up*
whenever you are at the terminal but only *acts* when a purchase is legal, so it does hold
the keys while refusing them. That is fine because it is the lowest-priority owner — there
is nothing behind it to starve — and because it says so on its own title bar. Anything with
a consumer behind it must not.

The precedence is ordered by how stuck the crew is without it. A pending pick
blocks the road behind it; a road blocks the whole run; the bay and the panel are
both things you can walk away from.

The rule lives in `economy.js` rather than in the frame loop **so that it can be
tested**. It was in `main.js`, which the harness cannot import, and an audit of the
harness's frame order against the game's found it was the only piece of wiring in
the project with no coverage at all. Anything decided inside `main.js` is
untestable by construction; if a rule matters, it belongs in a module.

## Render cost, and where it comes from

A playtest reported bad lag, and the measurement is the useful part: **~1,410 draw
calls per frame against 55,698 triangles**. That ratio is the diagnosis. A trivial
triangle count with an enormous call count is a CPU-bound scene, and no amount of
simplifying geometry addresses it. It is now 175 calls.

Four things cost frames here, and they have completely different fixes. Guessing
between them is how you spend a day optimising the wrong one:

| symptom | cause | fix |
|---|---|---|
| many draw calls, few triangles | CPU driver overhead | batch or instance |
| many triangles | GPU vertex cost | simplify, or cull |
| many shadow casters | the scene drawn twice | be selective about `castShadow` |
| slow at high resolution only | GPU fill rate | resolution scale, fewer passes |

`node tools/scene-cost.mjs` reports all four from the real scene graph, headlessly.
Run it before optimising anything.

The rules that came out of it:

- **Anything static that shares a material gets merged.** One mesh per rock was 646
  draw calls for scenery nobody interacts with. Merged geometry loses per-object
  frustum culling, which is a good trade at this scale: one always-drawn call
  beating two hundred culled ones.
- **`castShadow` is opt-in, not a default.** A shadow pass is the whole scene drawn
  again. Rocks and ruins cast because a low sun throwing a ruin's shadow forty
  metres across the pan is most of what sells the scale; loose chunks and rebar do
  not, because their shadows are invisible at any distance you see them from.
- **Lights are a budget, currently four.** Every light is per-pixel work in every
  `MeshStandardMaterial`, and **a light at intensity zero costs exactly as much as
  one at full brightness** — three dark spotlights were being paid for by every
  surface in the game. Changing the count also forces every material to recompile,
  which is a visible hitch. Glow that does not need to illuminate anything should
  be emissive plus bloom, which is free.
- **Tighter shadow bounds are cheaper AND sharper.** ±46 m rather than ±80 m is the
  same texel budget over a smaller area.
- Batching was only safe because decorative geometry carries no collider — see
  "Visual layer notes" below. None of it was load-bearing for movement.

## Visual layer notes

- `tileBoxUVs` rewrites a box's UVs so texture density is constant **in metres**
  rather than per face. Without it a 26 m hull and a 1.2 m crate sharing a
  material show the same number of repeats. It is called from `boxToMesh`, so
  every collider-matching mesh in the game gets it for free.
- `Look.std(role, params)` caches materials by role. `Look.load()` then attaches
  downloaded maps to the *same instances* later, which is how art can arrive
  asynchronously and retro-fit meshes built thousands of frames earlier.
- Decorative geometry carries **no collider**, ever. Every collider on the deck is
  part of the movement puzzle, and adding thirty more would change the mantle
  graph that invariant 3 depends on. Rock chunks, ruin caps, greebling, module
  hardware and the whole horizon are all non-solid.
- The play area is flat because ground collision is one box with its top at y=0.
  Relief lives outside the patrol ring, where nothing walks.
- `mergeGeometries` is hand-rolled in `look.js` rather than imported from
  `BufferGeometryUtils`, precisely to keep an addon path out of the harness's
  module graph.
