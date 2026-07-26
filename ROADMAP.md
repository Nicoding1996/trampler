# Trampler — roadmap

Design context is in `.kiro/steering/`. Read `product.md` first, then
`invariants.md` before changing anything.

```
npm start      # http://localhost:5173
npm run verify  # 91 sections, 556 checks, headless
npm run audit   # static checks the harness structurally cannot make
npm run cost    # draw calls, triangles, shadow casters, lights — no renderer needed
npm run imports # every import specifier resolves
npm run smoke   # every file the page needs is actually served
npm run assets # re-fetch the CC0 art (optional; the game runs without it)
```

## Where we are

Everything that was on this roadmap below Tier 3 is built and measured.

| | Status |
|---|---|
| 1. Walking on a moving kinematic deck | done |
| 2. Grapple boarding a moving fortress | done |
| 3. Enemies that create pressure in both directions | done |
| 4. Spatial damage, repair, and a reason to be on the deck | done |
| 5. Deployable defences — the tower-defence layer | done |
| Tier 1.0 A finish line | done |
| Tier 1.1 Economy, two purses | done |
| Tier 1.2 Modules on hardpoints | done |
| Tier 1.3 Stacking personal upgrades | done |
| Tier 1.4 Travel and siege cadence | done — one biome |
| Tier 1.5 An armoured enemy, to give the gun a mid-wave job | done |
| Tier 2 Leg stomp, more enemy types, enemy/deck collision, crosshair | done |
| Tier 2 Audio | done — synthesised, no files |
| Tier 2 An automated deck turret | **still deliberately shelved**, see below |
| Tier 3 Networked players on a moving platform | untouched, and needs an engine spike |

556 headless checks pass. Two consecutive full runs differ in exactly one line:
the wall-clock performance reading.

## The performance and brightness pass

A playtest reported three things: the image was blinding, a hill was sitting in the
arena hiding enemies, and the frame rate was bad. All three were mine, and the
third was worth measuring before touching anything.

**It was never a browser limit, and it was not the GPU.** `tools/scene-cost.mjs`
builds the real scene graph in plain node and counts what the renderer is asked to
do. The answer was **~1,410 draw calls per frame against 55,698 triangles**, and
that ratio *is* the diagnosis: a trivial triangle count with an enormous call count
is a CPU-bound scene, where each call is a separate trip into the driver.
Simplifying geometry would have achieved nothing. 646 of those calls were world
scatter — one mesh per rock, per rock chunk, per ruin, per broken cap, per rebar
bundle — and 558 of them cast shadows, so they were drawn a second time. The
simulation, for comparison, costs 0.40 ms a frame with 400 enemies on the field.

| | before | after |
|---|---|---|
| per-frame draw calls | ~1,410 | **175** |
| world scatter calls | 646 | 9 |
| shadow casters | 558 | 65 |
| lights in the scene | 16 | 4 |
| triangles | 55,698 | 49,000 |

What did it:

- **Batched the scatter.** Everything static that shares a material is merged into
  one geometry, built with each part's own tiled UVs so batching costs nothing
  visually. The colliders were never meshes, so they are untouched; the merged
  meshes replace 196 individual raycast candidates in the grapple and occluder
  lists, which makes every raycast cheaper too.
- **Stopped small detail casting shadows.** Rock chunks and rebar are centimetres
  of geometry whose shadows are invisible at any distance you see them from, and a
  shadow pass is the whole scene drawn again.
- **Cut sixteen lights to four.** Nine emitter point lights and three spotlights
  sitting at intensity zero — a dark light still occupies a shader slot and still
  costs per-pixel work in every standard material, and changing how many exist
  forces every material to recompile, so deploying an emitter caused a hitch as
  well as a permanent cost. Emitter glow is emissive plus bloom now, which is how
  it is normally done and is free. The floodlight module *attaches* its lights
  instead of un-dimming them.
- **Tightened the shadow camera** from ±80 m to ±46 m: sharper and cheaper at once,
  the same texel budget over a smaller area.
- **Capped the pixel ratio at 1.5** and added adaptive resolution, which measures
  the raw frame interval and walks the render scale between 0.6 and 1.0 in steps on
  a one-second cadence. Deliberately slow and hysteretic — a scaler that reacts
  quickly oscillates, and visible oscillation is worse than a steady lower
  resolution. Below full scale it drops antialiasing, which is refining edges the
  upscale would blur anyway.

  Its thresholds are **ratios of the display's refresh interval**, and the first
  version's absolute ones were a bug worth recording: against a fixed 15.5 ms target
  a healthy vsynced 60 Hz frame of 16.7 ms read as too slow, so every 60 Hz machine
  walked down to 0.6, switched its antialiasing off on the way, and could never
  recover because the 11.0 ms release needed 90 fps that vsync will not hand out. A
  permanently soft image and four render-target reallocations, on hardware with
  nothing wrong with it. The measurement was also taking the simulation's clamped
  dt, which reports everything below 30 fps as 33.3 ms — the scaler could not
  distinguish 30 fps from 5 fps.
- **PCF instead of PCFSoft** shadows: four times fewer samples for a penumbra
  nobody is examining.

→ test 88 now asserts a 220-call budget, so this cannot creep back

**The white-out was four mistakes compounding**, which is why turning one number
down had not fixed it. The sun was at 3.1 (three.js has used physically-correct
light units since r155, where that is glaring); the environment map lit the scene
at 0.85; the sky was drawn as the raw HDRI with no dimming at all; and every
textured metal surface had its metalness *forced to 1.0*, so the whole fortress was
a mirror pointed at a desert sky. Then bloom at a 0.85 threshold smeared the result
over everything else. Sun 1.35, environment 0.32, a separate 0.42 for how brightly
the sky is *drawn* as opposed to how much it *lights*, metalness capped at 0.55,
bloom threshold above 1.0 so only genuinely emissive things bloom, and exposure
0.62. Tunable live with `-` and `=`, because past a certain point that is a
monitor-and-eyes call.
→ test 89

**The hill in the arena was a units mistake in placement.** Horizon geometry was
positioned by its *centre*: dune centres sat outside `patrolRadius + 90`, which
sounded like clearance, but a dune is up to 170 m across, so one centred at 255 m
reached inward to 85 m — well inside the 165 m patrol ring. With no collider, the
only way past it was to walk through it. Every part now reserves its own half-width
before being positioned, and the achieved clearance is measured and asserted from
the vertices rather than from the arithmetic that produced them.
→ test 87

## What the audit pass found

After the work above was finished and green, everything was re-checked for damage
done in passing. `tools/audit.mjs` exists because of it, and it found four things:

- **The harness's frame order had drifted from the game's.** `economy.update` was
  called directly by the harness while `main.js` routed it through a fork the
  harness never took — so the rule keeping the refit panel, the refit bay and the
  road choice from fighting over the number keys was the only piece of wiring in
  the project with nothing testing it. That rule now lives in `economy.js` as
  `routePurchaseInput`, and test 86 drives every branch of it. The lesson is
  general: anything decided inside `main.js` is untestable by construction.
- **The HUD and the mixer were never executed.** 850 lines of branching, and the
  mixer would have passed a naive smoke test by doing nothing, since without an
  `AudioContext` every method is a no-op. Tests 84 and 85 now run both against
  stubs through a real fight. Neither had a bug in it, which is worth knowing
  rather than assuming.
- **A burrowing enemy exerted separation on surface enemies** — an invisible force
  shoving the crowd from several metres underground. The kind of thing that gets
  reported as "something pushed me" and never reproduces.
- **Dead code from the pass itself**: an unreachable banner branch, three unused
  counters, a JSDoc parameter that did not exist, and one export nothing used.

Two of my own new checks were also wrong before they were right: the audit's
element-id scan ran against comment-and-string-stripped source and confidently
reported zero ids, and the server smoke test asserted twice that a path traversal
should be refused when the server was correctly clamping it back inside the root.
Both are the same failure as a vacuous test, and both are noted in `tech.md`.

## What a run is now

Four landmarks. A siege at each, five waves long, except the last which is three
waves and ends with the Siegebreaker. Between landmarks the crew picks one of two
roads, and the road's modifier stays with them for the rest of the biome.

Roughly fifteen minutes, against the 30-45 minute target for a full run — this is
one biome, and biomes are the unit that repeats.

## The roster, and what each type is for

Each type exists to attack the pillar from a different angle. None of them is a
health bar with a different colour.

| | Job |
|---|---|
| **Chewer** | eats the legs from inboard, under the slab, where no gun can see it. The reason to dismount. |
| **Climber** | boards and eats the reactor. The reason not to stay down there. |
| **Bulwark** | armour 20 against a 25-damage rifle. Five per shot, 300 hp, and it is slower than the hull. Must be killed at range. |
| **Burrower** | travels underground, unshootable, and surfaces under the hull. The reason camping a gun is not a strategy. |
| **Sapper** | zero contact damage. Plants a charge worth exactly one leg on a six-second fuse. The reason to go down there *now*. |
| **Titan** | 5.2 m against 4.5 m of hull clearance, so it cannot fit underneath and has to work from outboard, in the open. The one fight the deck wins. |

Specials **substitute** for chewers rather than adding to the wave count, so the
size curve the pacing was tuned against did not move. Burrowers from wave 2,
bulwarks from wave 3, sappers from wave 4; waves one and two are the original two
types, learned without noise.
→ tests 68-71, 73, 81

## Two things measured the hard way this pass

**A leg stomp that damages enemies breaks invariant 2b, silently.** The first
version dealt 30 — below a chewer's 50 hp, so it could not kill anything on its
own, which seemed like enough of a safeguard. It was not. Undefended
time-to-crippled went 67.7 s → 81.0 s, and test 48's fixed-force measurement hit
its 45 s ceiling: emitters plus feet held fourteen chewers off the legs for the
entire window with no player present. Neither system did that alone.

Nothing looked broken. The fortress simply defended itself, and the reason to go
down there quietly evaporated. This is the same reasoning that keeps the automated
deck turret shelved — a damaging foot is a second automated damage source wearing
a different hat, and with two of them you cannot attribute a fight to either.

The feet now hurt only the *player* and shove bodies aside. Fixed-force is back to
exactly 16.4 s → 25.1 s, byte-identical to before the feature.
→ tests 72, 48

**The shove has to be an impulse, not a displacement.** As a 0.9 m instant move it
tripped test 52 at 0.73 m in one frame, against a worst legitimate stride of about
0.15 m. That is a teleport, and invariant 20 exists because a playtester described
exactly that as enemies materialising out of nowhere. As a 4.5 m/s impulse decaying
at 9/s it is 0.125 m per frame. This lesson keeps recurring: anything that
repositions a body must do it through velocity and let the integrator carry it.

## The wave-4 reactor wall, closed

Reactor time-to-death if every climber in a wave reached it used to be 9.3 s at
wave 1 falling to 3.5 s at wave 4 — less than the time to notice, grapple up, turn
and engage. A reaction-time wall, not a decision.

Three candidate fixes were on the table and were deliberately **not** tried
together, because three simultaneous changes to one number cannot be attributed
afterwards. The one taken is a cap on simultaneous attackers: three slots, so
reactor damage is 45 dps regardless of wave size. Measured, twelve boarders now
take the reactor in 9.0 s and three take it in 9.0 s — a ratio of 1.00 where it
used to be 4.
→ test 74

## Bounded structure, made physical

Three hardpoints on the hull's outer flanks, six modules, installs permanent for
the run. Duplicates stack, so doubling down on one capability is a legitimate
build.

Deliberately absent from that list: an automated gun. Every module either buys
time, buys legibility, or buffs something a player has to be present to use.

| | Effect |
|---|---|
| Floodlights | lights the under-hull arena; burrowers surface at 60% of their timer |
| Emitter rack | +2 emitters, +2 charge each — still finite, still hand-placed |
| Ammo hoist | deck guns take 40% less heat and cool 50% faster |
| Boarding baffles | climbs take 50% longer |
| Stride actuators | +18% hull speed, +40% turn rate |
| Reactor casing | +40% integrity, one fewer boarder can reach the core |

Module geometry carries **no collider**. Anything solid on the deck joins the
mantle graph, and a new 1.4 m ledge is exactly the sort of thing that quietly
turns three chained climbs into a route to the crow's nest, which invariant 3
forbids.

Invariant 2b re-checked with everything defensive bought at once — four hull
plates, three repair rigs, an emitter rack, floodlights, baffles, and five
emitters deployed. The fortress is still crippled unattended, at 131.1 s against
90.2 s with refits alone. It buys time. It does not hold.
→ tests 76, 77

## The art

Everything geometric, procedural or synthesised is generated in code: the
fortress, the horde, the terrain, the particles, every sound. The only imported
assets are eight CC0 PBR texture sets and one CC0 HDRI from
[Poly Haven](https://polyhaven.com), listed in `ATTRIBUTION.md` and vendored into
`assets/` by `npm run assets`.

Vendored, not hot-linked, for the same reason three.js is served out of
`node_modules`: this thing has to run offline, because that is where most of the
tuning happens. And it is all optional — delete `assets/` and the game plays
identically in flat colours, which the diagnostics panel reports so that state is
distinguishable from a broken texture path.

The one piece of visual work worth calling out as a technique rather than a
decision: `tileBoxUVs` rewrites every box's UVs so texture density is constant in
metres rather than per face. Without it a 26 m hull and a 1.2 m crate sharing a
material show the same number of repeats — the hull smeared, the crate a
photograph. It is twenty lines and it is most of the difference between
"textured" and "finished".

## Still to judge in play

Nothing below can be settled by measurement. All of it needs hands on the
controls.

- Does the recovery loop hold at wave 3+ now, with modules and personal stacks in
  the mix?
- Where do you spend three hardpoints, and is that an interesting call or an
  obvious one? If one module is always correct, it is priced wrong.
- Is calling a wave early ever tempting? If nobody presses Q, raise
  `CFG.economy.earlyCallBonus` before touching anything else.
- Is the road choice a real decision, or is the quiet road always right? The
  payouts are front-loaded specifically so the greedy line is spendable on
  surviving itself.
- Does being pinned at a gun feel **powerful** or **trapped** when boarders come
  up behind you? Fine line, and it decides whether stations work at all.
- Is the boss a good exam for the build you made, or a damage-sponge wall? It has
  2600 hp behind 30 armour and it cannot be answered from under the hull.
- Re-test **G** (free-surface grapple vs hardpoints only) and **M** (release feel)
  now that mantling exists.
- The sapper's six seconds: enough to react to, or a coin flip?

## Tier 2 — what is left in it

- **An automated deck turret. Still shelved, and now for a measured reason.**
  Shock emitters occupy the automation slot, and the leg-stomp experiment above is
  a concrete demonstration of what a second automated source does: it does not
  look like anything, it just removes the reason to be somewhere. If it is ever
  added, it needs test 77 re-run with it fitted, not an argument.
- **Enemy collision against world scenery.** Boarders now walk around deck
  furniture (test 75) but still clip rocks on the ground. Cosmetic.
- **More biomes.** The run structure is generic; the roads and the boss are one
  table and one type.

## Tier 3 — the risk that is still entirely unproven

**Networked players on a moving platform.** Flagged as the largest engineering
risk in the project on day one and still untouched. Everything in this repo
de-risks *feel*, and says nothing about prediction, reconciliation, or authority
over a moving frame of reference.

This cannot be done here. It needs a spike in the target engine, and it is the
one item on this document that a browser prototype is structurally unable to
answer. Related open decision: Unreal versus staying on the web. Crowd counts
were the original argument for leaving — 400 enemies now simulate in 0.40 ms a
frame, which is not the argument it was.

## Deliberately absent

Meta-progression, PvP, extraction, a second biome, art beyond what a grey box
needs to stop reading as a grey box. Do not add polish to a system whose design
question is still open.

## Working notes

- `npm run verify` after every change. It has caught genuine bugs repeatedly this
  pass, including both of the measured findings above, and both of them looked
  correct in review.
- `npm run imports` catches the failure mode of a no-build-step project: a
  mistyped path is a blank canvas and one console line.
- Roughly one in three bugs in this project came from *interaction* between
  systems that were each correct alone. The two newest examples are in this
  document: emitters plus feet, and a shove plus an integrator. Playtest reports
  and cross-system tests have been worth more than code review.
