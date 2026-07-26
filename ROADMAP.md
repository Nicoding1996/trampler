# Trampler — roadmap

Design context is in `.kiro/steering/`. Read `product.md` first, then
`invariants.md` before changing anything.

```
npm start      # http://localhost:5173
npm run verify  # 101 sections, 715 checks, headless
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
| Update 1 The Salvage Table — build variety | done |
| Update 1.5 Legibility — make it all readable | done |
| Update 1.6 HUD layout and the buy window | done |
| Update 2 The Roster — enemy variety | next, after a playtest |
| Tier 3 Networked players on a moving platform | untouched, and needs an engine spike |

715 headless checks pass. Two consecutive full runs differ in exactly one line:
the wall-clock performance reading.

## What is actually missing, and the three updates that fix it

Everything on this document below Tier 3 is built. That is not the same as the game
being finished, and the gap is worth naming precisely rather than reaching for the
next system.

**There is a complete roguelike skeleton here with exactly one of everything.**
What varies between two runs:

| | Variety | after Update 1 |
|---|---|---|
| Weapons | 1 rifle, never changes | unchanged |
| Personal upgrades | 4, all numeric multipliers, always offered, same prices, same order | **16 in a pool, 3 rarity tiers, 4 offered per landmark, plus 3 free picks** |
| Fortress | 2 refits + 6 modules, always offered | unchanged, deliberately — the bounded track is the dependable one |
| Enemies | 6 types, on a fixed introduction schedule | same six, but the schedule now **carries across landmarks** — Update 2 adds types |
| Boss | 1 | unchanged — Update 3 |
| Roads | 6 in the table, 2 offered per landmark | unchanged |
| Biome | 1 | unchanged — Update 3 |

The road choice *was* the **only** thing in the game that differed run to run.
Everything else was identical every time. So the next phase is not a new mechanic; it
is populating the systems that already exist until two runs diverge — starting with
the thinnest one, which was the unbounded track.

The updates are deliberately sequenced one variable at a time. Shipping items and
enemies together would make the playtest unattributable, which is the same mistake
the wave-4 reactor fix avoided by trying one candidate instead of three.

### Update 1 — The Salvage Table (build variety) — DONE

Four numeric multipliers is not a build. Risk of Rain's identity is *qualitative*
items that change how you play, and that is what was asked for on day one.

Shipped: 18 items in `CFG.economy.catalogue`, three rarity tiers carrying cost and
growth, a shop that re-rolls four personal slots per landmark, a free pick of three
for holding a siege, a two-channel event bus for procs, and 56 new checks. Suite 558
→ 643. `product.md` has the categories and why each one exists; `invariants.md` has
22d-f and 2b-i.

Seven things are worth carrying forward from doing it:

- **The catalogue outgrowing the keyboard is the mechanism, not a problem.** The
  crash that forced the shop to become a subset was `hud.js` reading
  `e.key.replace` on entry 7 of 18 against six configured keys. A fixed shop cannot
  hold a pool, and a subset that changes is the entire reason two runs build
  differently.
- **Per-item rarity weights cannot express tier share.** Measured at 6:3:1 per item,
  rares came out at 8% of offers — about one across a whole run, for the items the
  pool exists to deliver. The tiers hold different numbers of items, so the fix is to
  pick the **tier** first and then uniformly within it. Fixing it the other way would
  have needed rare items to carry a *higher* number than uncommons in order to appear
  *less* often, which is a config that lies.
- **Conditional effects need their own field.** `weapon.damageScale` is derived
  absolutely from stack counts, so a timed write into it is either erased by the next
  recompute or accumulates forever. `weapon.damageBonus` is cleared and rebuilt every
  frame instead. Two fields, one discipline.
- **A proc bus needs a depth cap.** An on-kill item that deals damage re-enters its
  own listener; two reasonable items compose into a blown stack. Cap 4, with
  `try/finally` so a throwing item cannot wedge the bus for the rest of the run.
- **The build readout is two different readouts.** What you carry belongs on the
  refit panel, which is already up when you act on it. What is live *this second*
  belongs on screen during a fight, and only while it is live. One always-on panel
  showing both would have been panel accumulation again.
- **Two existing tests were asserting the roll rather than the thing they claimed.**
  Both passed only while the catalogue was small enough to fit on the keys. That is a
  new entry in `tech.md`'s list of tests that lie.
- **A green suite hid five real defects, and a review pass found them.** All five were
  invisible to the harness for the same structural reason: each sat in a *second* path
  through something the tests exercised once. VITALS healed when bought and not when
  picked, because there were two acquisition paths and the tests read the purse rather
  than health. Dying paid the boarding buff, because `respawnOnDeck` is both the death
  path and the spawn path — and the test for boarding used it. The restart test claimed
  to mirror `main.js` and had stopped doing so, leaving the item seed's rewind
  unasserted. The shop panel stayed up during the pick advertising six keys the router
  had already handed away. And the manned-gun proc check supplied the very string it
  was testing for. The lesson is narrower than "review your work": **when a change adds
  a second way to reach an existing effect, the test that covered the first way is now
  covering half of what it claims.**

**The rule that kept this from wrecking the game.** Every item was checked against
one question: *does it let one position do the other's job?* An auto-repair drone, a
deployable turret, anything that reaches under the hull from the deck — each is a
perfectly ordinary roguelike item and each one deletes the reason to oscillate.
Invariant 2b-i is the enforced form, and the measurement is that the whole table
three stacks deep changes unattended time-to-crippled by **nothing at all**: 131.1 s
before the item layer existed, 131.1 s with it, and 0 procs across 23 unattended
kills.

### Update 1.5 — Legibility — DONE

Not planned. It came out of the first playtest of Update 1, and the striking thing about
that playtest was that **none of the four complaints was about balance**:

| what was said | what it actually was |
|---|---|
| "the grey creature, the tank — why are they hard to kill?" | no enemy damage feedback existed at all |
| "I just spam buy items out of panic" | the buy window overlapped the fight |
| "when I press one, does it matter? it seems like it just went next" | road costs were never shown, and the roster reset each landmark |
| "I barely survive wave 4" | plausibly all three of the above |

The last row is the one that set the order. A difficulty report from a player who cannot
read the fight is not attributable to difficulty — and note that the player reported the
same wave-4 ceiling *before and after* eighteen new items, which is strong evidence they
could not tell what to buy or when. So: fix every readout, change no difficulty number,
then ask again.

Five items, suite 643 → 697.

1. **Enemy damage feedback**, which the game had none of. Wounded bodies are drawn
   darker in four bands through the per-instance colour buffer the hit flash already
   allocated — free, no UI, and an untouched crowd costs no upload. The thing under the
   crosshair gets a name, a bar, and whether its armour is in the way. Deliberately not
   forty-five floating bars: the two shipped games nearest this one omit those on purpose.
2. **A pick every two waves**, not only for holding a siege. The old cadence put the
   headline reward of Update 1 behind wave five of five, and the player averaged four —
   they had met it once in an evening. Three per landmark now, first at wave 2.
3. **The buy window narrowed** to a rest or a hold *with the fortress clear*. It used to
   include the incoming-wave telegraph and a rest that permits eight live enemies.
   Measured after: 52 s of shopping across a 152 s siege, in windows of about 12 s, and
   with a competent defender the clear-field clause never bites.
4. **The journey escalates in kind.** Composition runs on a tier that carries across
   landmarks while wave size still rewinds, so landmark 2 opens with the roster it took
   three waves to earn — instead of the fight after a road being *simpler* than the one
   before it. Plus the road readout: the arrival banner names the cost as well as the
   payout, and the route panel shows what the biome has already taken from you.
5. **The bulwark's plate is on its front only.** This is the answer to a playtester
   asking for headshot damage. The instinct was right — armour could only be out-bought,
   never out-played — but a head multiplier would have handed the rifle a bulwark and
   taken the deck gun's recurring job away. 60 rounds head-on, 12 from behind, and abeam
   is not enough. Skill answer, positional, so it reinforces the pillar instead of
   competing with it.

**One thing deliberately NOT done: the road costs were not retuned.** They are measured
and they are tiny — four of six roads cost essentially nothing, and the worst is +18%
enemy health against a time ramp already at x2.40:

| road | real cost | pays |
|---|---|---|
| THE OLD FOUNDRY | **nothing** | 30 scrap |
| SALT FLATS | +12% enemy speed | 45 salvage, 15 scrap |
| THE DUST BOWL | fog to 55% | 20 salvage, 60 scrap |
| THE RIFT | +4 enemies per wave | 55 salvage, 70 scrap |
| THE BONEYARD | +18% enemy health | 30 salvage, 20 scrap, a free module |
| SCRAP FIELDS | +10% health, +2 per wave | 95 salvage, 25 scrap |

The reason for waiting is the update's own thesis: I cannot yet tell whether those costs
are imperceptible *as numbers* or imperceptible *because nothing displayed them*. Now
that both are displayed, the next playtest can produce the attributable version — "I saw
+18% and did not feel it" — and that is a fact worth tuning against. Raising them is
also a difficulty increase, and the player is already struggling.

Four things it also fixed on the way, each found by measuring rather than by review:

- **Chewers could have hit zero.** They were the *remainder* after specials, and carrying
  the tier across landmarks made the ramps want more than a ten-enemy wave holds. A wave
  with no chewers has nothing under the hull, which deletes half the pillar silently.
  They are a reserved 40% floor now.
- **The sapper vanished at landmark 3.** A single-pass priority allocation let the bulwark
  ramp eat the room, and the one enemy that is a timer rather than a damage race dropped
  out of the wave. Fixed by allocating one of every due type before any type gets two.
- **`Horde.clear()` left three counters stale.** Harmless until the buy window started
  reading `underHull`, at which point the shop stayed shut on the frame a run began.
- **Two tests were firing into a bulwark's back without knowing it**, and had passed only
  because angle used to be irrelevant. The geometric form of "sampling at the wrong
  moment", now an entry in `tech.md`.

### Update 1.6 — the HUD layout, and a rule written backwards

The playtest after 1.5 produced two complaints, and both were about 1.5's own work rather
than about anything older. Suite 697 → 715.

**"It covers the health and the other stats."** Four things were anchored to the bottom
centre of the screen — the vitals panel, the contextual prompt, the salvage pick and the
road choice — and the three transient ones drew on top of the permanent one. So the health
and reactor bars were hidden at precisely the moments they matter: repairing under fire,
choosing an item, choosing a road.

It shipped for two updates behind a green test, which is the interesting part. Test 67
compared always-visible panels *to each other*, so the three that come and go were out of
scope; and the prompt is not a `.panel`, so it was invisible twice over. The test was
extended **first**, made to fail naming all three offenders, and only then was anything
moved. It now asserts by screen zone that a permanent readout owns its anchor outright,
over a set of boxes it derives rather than one written down — a hard-coded list is how the
prompt escaped originally.

Vitals moved to the empty bottom-left corner and lost every row shown elsewhere: the
deck-gun heat bar, because the prompt's progress bar already *is* `1 - gun.heat` while a
gun is manned; the hardpoints count, because the bay draws its own sockets. Both purses
were added, which answers the other complaint — **"is the scrap shop gone? I can't seem
to use it"**. Scrap was fine. The purses were only ever drawn on the shop panel, which is
up for about a third of a siege, so for the rest of it the player was earning money they
could not see.

**And the buy window was rewritten, because 1.5's version measured badly.** "Nothing
beneath the hull and nothing on the deck" sounded better than it performed: it cost a
competent player exactly zero seconds and a struggling one up to a third of their window,
and it varied 64% to 97% between two passes on the *same seeds*. The player who most
needs to buy something was the only one locked out, and could not tell why — "some enemy
is under the hull somewhere on a 26 m chassis" is not a state you can see or fix in a
second. It now asks whether anything is within 6 m of **you**, reusing the range the
contested-repair rule already owns. The property that matters is that you satisfy it by
stepping back; the old one could only be satisfied by finishing the fight.

The salvage pick waits for that same window now, through the same getter rather than a
second rule that means roughly the same thing. A 680 px three-item menu used to open the
instant a wave resolved, which is frequently while the remains of it are still on you —
the shop's panic problem with none of the shop's protection. Rejected: **pausing**. Co-op
is the primary experience and you cannot stop a horde game for one player's menu.

Three bugs found on the way, and the first is the one worth remembering:

- **A live invariant violation hidden behind a field that does not exist.** Three places
  tested `enemy.burrowed` to decide whether something was underground. There is no such
  field — `horde.burrowed` is a *count* — so every check read `undefined`, every branch
  said "not underground", and all three exclusions excluded nothing. Two were live:
  fragmentation splash and the arc chain could damage a submerged burrower, which is
  invariant 8's "the one type that cannot be shot cannot stay that way" read backwards.
  Nothing caught it because the shot path has its own occlusion clip and the tests
  followed the shot. Found by writing the same wrong line a fourth time and having a new
  test disagree. Fixed with an exported `isSubmerged` predicate, so the mistake is now a
  load error rather than a silent falsy read.
- **Holding a siege re-rolled a pick still in hand**, which invariant 22f forbids. Latent
  for as long as picks resolved within a frame or two of being earned; making the pick
  *wait* turned a rare case into an ordinary one.
- **My own overlap test misread the CSS twice** — any percentage offset as "centred", so
  the telegraph at `top: 8%` landed in the middle of the screen, and only `display: none`
  as "hidden", so a banner that fades on `opacity` counted as permanent. Both reported a
  bogus failure with complete confidence.

**Still not done: the road costs.** Deferred again, and for the same reason as in 1.5 —
the next playtest is the one that can say "I saw +18% and did not feel it", which is a
fact worth tuning against. When it is done, the lever is **speed and fog** rather than
health: enemy speed spends itself on a human's travel and reaction time, which is what
these roads are supposed to tax.

### Update 2 — The Roster (enemy variety) ← next

- **A ranged enemy.** The one genuinely missing role: all six current types deal
  contact damage, so nothing punishes standing in the open, nothing makes cover
  matter, and nothing can threaten a manned station at all. That last point is a
  direct answer to the open question about whether a gun feels powerful or trapped —
  at present nothing can reach you there.
- **Elite affixes.** The cheapest variety multiplier available: armoured, swift,
  volatile, shielded, applied to the six existing AIs. Reads as a much larger roster
  for a fraction of the work and plugs into the existing wave schedule.

### Update 3 — The Second Biome (content volume)

A second road table and a second boss. Held until 1 and 2 prove out, because volume
before variety means building more of something that might not be fun yet.

Parked, and not forgotten: the netcode spike and the engine decision. The one
question that spike must answer first is now known — the harness runs a fixed
`DT = 1/60` while the game runs `dt = Math.min(frameMs / 1000, 1/30)`, so two
machines at different frame rates already diverge before a network is involved.
Everything else here is unusually well suited to rollback: seeded RNG throughout,
hull-local storage, pooled enemies with no `Object3D` per entity, one hitscan path.
The variable timestep is the single structural blocker.

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
plates, three repair rigs, an emitter rack, floodlights, baffles, five emitters
deployed, **and three stacks of every one of the sixteen personal items**. The
fortress is still crippled unattended, at 131.1 s against 90.2 s with refits alone.
Adding the whole salvage table moved that number by zero, and fired zero procs across
23 unattended kills. It buys time. It does not hold.
→ tests 76, 77, 94

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
- **Does a conditional item read as a reason to move, or as a tax on standing
  still?** The transition pair is the whole thesis of the categories — one item pays
  for boarding, another for dropping off — and three seconds may be too short to
  notice at all.
- **Now that a road states its cost, is +18% enemy health a cost you can feel?** This is
  the question Update 1.5 deliberately left open rather than pre-emptively tuning. If the
  answer is no, the road table needs bigger numbers — and the ones worth raising are
  speed and fog, because those are what a human perceives, not health.
- **Does the wounded tint let you pick out a nearly-dead enemy in a crowd of thirty?**
  Four bands, floored at 42% brightness so a dying body does not disappear at 70 m
  through dust. Eyes-only.
- **Is the flank on a bulwark something you actually do, or something you know about and
  never bother with?** It costs leaving the fortress. If nobody does it, the readout
  saying ARMOUR EXPOSED is doing nothing and the arc should widen.
- **Do three picks a landmark feel generous or noisy?** It went from one to three in one
  step, which is also a power increase — so if wave 4 suddenly stops being a wall, that
  is a candidate cause and not necessarily the legibility work.
- **Is four shop slots enough exposure to the pool across a biome?** Sixteen offers
  plus three picks a landmark. If a run regularly ends without having seen anything
  interesting, `CFG.economy.pickCount` is cheaper to raise than the key count.
- **Does the rarity feel like rarity?** Measured at 51/29/20 with about three rare
  offers a run. Whether that reads as "the good stuff shows up sometimes" or as "the
  good stuff never shows up" is not something the harness can answer.
- **Is `+75% UNDER HULL · LAST STAND` legible mid-fight, or noise in the corner?**
  The buff strip is the only feedback that a conditional item is doing anything.

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
