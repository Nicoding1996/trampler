# Trampler — code structure

24 modules, ~9,700 lines in `src/`, plus a ~5,100-line headless harness.

Line counts below are rounded to the nearest ten and are there for a sense of
weight, not as a fact to rely on. They drift every commit.

```
index.html          canvas, HUD markup, importmap, click-to-play gate
server.mjs          loopback-only static server
verify.mjs          headless harness — every simulation module, no DOM, no GL
tools/
  audit.mjs         static checks the harness structurally cannot make
  scene-cost.mjs    draw calls, triangles, shadow casters, lights — no renderer
  fetch-assets.mjs  pulls the CC0 art from Poly Haven, md5-checked, idempotent
  check-imports.mjs resolves every import against index.html's real importmap
  smoke-serve.mjs   asks the running server for every file the page needs
  diff-runs.mjs     two runs must differ only in the wall-clock timing
  summarise.mjs     failures + totals from a run, since the output is 700 lines
assets/             vendored CC0 textures + HDRI, plus manifest.json
src/
  config.js   1400  every tunable, with a comment explaining each value
  util.js       60  box(), boxToMesh(), seeded RNG, clamp/lerp/damp/smoothstep
  look.js      480  HEADLESS-SAFE materials, UV tiling, enemy silhouettes
  collision.js 180  space-agnostic AABB resolve, ground probe, mantle search
  world.js     440  terrain, lighting, scatter, horizon silhouettes, fog
  trampler.js  990  the fortress: geometry, gait, spatial damage, transforms
  player.js    570  FPS controller, based movement, mantle, health
  grapple.js   260  winch: hull-local anchors, brake, cut-vs-arrive release
  enemies.js   980  pooled horde, instanced draw, spatial hash, six AI types
  waves.js     340  director: pacing on crew pressure, composition, the boss
  run.js       200  legs of a journey, road choice, cumulative modifiers
  weapon.js    230  the single hitscan path, tracers, impacts
  deckgun.js   250  manned mounts, hull-local traverse arcs, heat
  repair.js    160  contextual repair, ground markers, grace window
  emitters.js  290  hull-mounted shock emitters: the tower-defence layer
  modules.js   200  three hardpoints, six modules, absolute-from-count effects
  economy.js   430  two purses, refits, modules, the early-call bonus
  hud.js       580  gauges, prompts, refit panel, refit bay, route choice
  render.js    330  renderer, EffectComposer chain, camera shake
  fx.js        440  one pooled particle system, muzzle light
  viewmodel.js 160  the rifle in your hands
  audio.js     290  synthesised mixer, no audio files
  input.js      90  keyboard/mouse, pointer lock
  main.js      390  wiring and the frame loop
```

## The headless boundary

This is the most important structural rule in the project, and it is what makes a
5,100-line test harness possible at all.

The harness constructs the **real** `World`, `Trampler`, `Player`, `Horde`,
`Director`, `Weapon`, `Repair`, `DeckGun`, `Emitters`, `Modules`, `Economy` and
`Run` in plain node, with no GL context and no DOM. So:

- Anything those modules import must work with no `document` and no `window`.
  `look.js` is the only visual module they are allowed to touch, and it checks
  `typeof document === "undefined"` once at load and degrades to flat materials.
- `render.js`, `fx.js`, `viewmodel.js` and `audio.js` are imported by `main.js`
  **only**. They are browser-only by design.
- Those four are **pure readers**. They poll counters the simulation already keeps
  for its own reasons — `trampler.footfalls`, `trampler.stepCount`, `weapon.shots`,
  `horde.killCount`, `horde.lastKill`, `player.hurtCount`, `economy.purchases`. The
  simulation has no idea a renderer, a particle system or a mixer exists.
- Addon imports (`three/addons/...`) only appear in the browser-only modules, or
  behind the headless guard as a dynamic `import()`. A static addon import in a
  simulation module would put a path in the graph that resolves only through the
  dev server, and the harness would die on load.

`npm run imports` enforces the resolution half of this by parsing the importmap
out of `index.html` and checking every specifier. In a project with no build step,
a mistyped path is a blank canvas and one line in the console.

## Architectural patterns

### Frame-relative simulation

Everything attached to the fortress is stored in **hull-local space** and read
back out through the hull's current transform. This is the single most important
pattern in the codebase and it is why a walking, turning fortress needs almost no
special-case code.

Applies to: player position and velocity while aboard, grapple anchors, mantle
start/destination, enemy climb routes, boarders standing on the deck, latched
attackers riding a leg, leg repair points, gun mounts and their traverse arcs,
deployed shock emitters, module sockets, foot positions for the stomp.

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
400 enemies simulate in about 0.40 ms/frame. Built this way from the start because
retrofitting crowd tech is a rewrite.

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

Effects live in `EFFECTS` maps in `economy.js` and `modules.js`; their sizes live
in `config.js` next to their rationale. `tech.md` has the convention under "Config
conventions".

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
run.update                 offers roads if the siege is held; advances nothing itself
handleStationInput         mount/dismount, so it takes effect the same frame
grapple.handleInput        fire before the player, so a shot lands the frame it is pressed
player.update              look, based movement, driven states, integrate, collide
weapon.update              suppressed while manning a station
gun.update                 aim visuals, fire, heat
repair.update
emitters.update
handlePurchasing           refits, the bay, or a road choice — exactly one owns the keys
horde.update               reads the hull transform after it has moved
grapple.updateVisuals      against a fresh camera
world.updateSun
shake.update               AFTER player.update, which writes the camera outright
viewmodel / fx / audio     pure readers
hud.update
input.endFrame
post.render
```

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

The refit panel (1-6), the refit bay (Tab, then 1-6) and a road choice (1-2) all
want the same keys. `routePurchaseInput` in `economy.js` picks one owner in
priority order — road choice, then bay, then panel — and hands `null` as the input
to the others. Two consumers of one key set is a bug waiting for the frame both
are visible.

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
