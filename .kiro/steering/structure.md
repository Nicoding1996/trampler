# Trampler — code structure

16 modules, ~4,000 lines in `src/`, plus a 1,975-line headless harness.

```
index.html          canvas, HUD markup, importmap, click-to-play gate
server.mjs          loopback-only static server
verify.mjs          headless test harness (49 sections, 198 checks)
src/
  config.js    365   every tunable, with a comment explaining each value
  util.js       49   box(), boxToMesh(), seeded RNG, clamp/lerp/damp/smoothstep
  collision.js 177   space-agnostic AABB resolve, ground probe, mantle search
  world.js     132   terrain, lighting, rocks and ruins, sun follow
  trampler.js  516   the fortress: geometry, gait, spatial damage, transforms
  player.js    556   FPS controller, based movement, mantle, health
  grapple.js   260   winch: hull-local anchors, brake, cut-vs-arrive release
  enemies.js   509   pooled horde, instanced draw, spatial hash, two AI types
  waves.js      81   director; difficulty from elapsed time
  weapon.js    216   the single hitscan path, tracers, impacts
  deckgun.js   245   manned mounts, hull-local traverse arcs, heat
  repair.js    139   contextual repair, ground markers, grace window
  emitters.js  250   hull-mounted shock emitters: the tower-defence layer
  hud.js       174   readouts, bars, leg pips, contextual prompt
  input.js      86   keyboard/mouse, pointer lock
  main.js      176   wiring and the frame loop
```

## Architectural patterns

### Frame-relative simulation

Everything attached to the fortress is stored in **hull-local space** and read
back out through the hull's current transform. This is the single most important
pattern in the codebase and it is why a walking, turning fortress needs almost no
special-case code.

Applies to: player position and velocity while aboard, grapple anchors, mantle
start/destination, enemy climb routes, boarders standing on the deck, leg repair
points, gun mounts and their traverse arcs, deployed shock emitters.

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

### Crowds

Enemies are plain objects in a fixed pool, drawn with `InstancedMesh`, with a
uniform spatial hash for neighbour separation. There is no `Object3D` per enemy.
400 enemies simulate in about 0.4 ms/frame. Built this way from the start because
retrofitting crowd tech is a rewrite.

### One hitscan path

`Weapon.shootFrom(origin, dir, profile, muzzle)` is the **only** place geometry
occlusion is applied. The rifle and both deck guns route through it, so the rule
that keeps chewers safe beneath the hull cannot drift between weapons.

Railings are excluded from the bullet occluder set: they are collision geometry
for bodies, not bullets.

### Driven player states

Three things take over the player's position and skip normal movement and
collision: grapple reeling, mantling, and manning a station. `Player.update`
branches on them in that order of priority. Each is responsible for restoring a
sane `base` and `velocity` when it ends.

### Frame order matters

```
trampler.update       hull moves first, so everything aboard inherits this frame
director.update       waves
handleStationInput    mount/dismount, so it takes effect the same frame
grapple.handleInput   fire before the player, so a shot lands the frame it is pressed
player.update         look, based movement, driven states, integrate, collide
weapon.update         suppressed while manning a station
gun.update            aim visuals, fire, heat
repair.update
horde.update          reads the hull transform after it has moved
grapple.updateVisuals last, against a fresh camera
hud.update
input.endFrame
render
```

`scene.updateMatrixWorld(true)` is called once after setup, because raycasting
needs current matrices and the renderer only refreshes them at draw time — which
is after the frame's grapple cast.
