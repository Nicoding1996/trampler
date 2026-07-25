# Trampler — roadmap

Design context is in `.kiro/steering/`. Read `product.md` first, then
`invariants.md` before changing anything.

## Where we are

The four-step prove-it plan set out before any code was written is complete.

| Step | Status |
|---|---|
| 1. Walking on a moving kinematic deck | done |
| 2. Grapple boarding a moving fortress | done |
| 3. Enemies that create pressure in both directions | done |
| 4. Spatial damage, repair, and a reason to be on the deck | done |
| 5. Deployable defences — the tower-defence layer | done |

198 headless checks pass. The prototype contains both halves of the pillar, makes
them mutually exclusive, and gives one player a way to cover their own absence.

## The pillar is confirmed

A solo playtest produced the intended rhythm unprompted: pick off the approach
from a gun, drop down to fight and repair beneath the hull, climb back up when
boarders reach the reactor. Roles emerged without being assigned, which is the
signal that co-op will work.

Two problems came out of the same session, both now addressed:

- **Wave 3 was unrecoverable.** Measured cause: repair did 45 hp/s against
  48-154 hp/s of chewer damage, so falling behind could never be reversed at any
  wave size. Repair is now 110 hp/s, and shock emitters buy time while you are
  elsewhere.
- **The gun was only an opening move.** The approach window is about 12 seconds
  against 28-second waves, so it is a small slice of playtime by construction.
  Still open — see Tier 2.

## Still to judge in play

- Does the recovery loop hold at wave 3+ now, or does it just fail later?
- Where do you choose to place three emitters, and is that an interesting call?
- Does being pinned at a gun feel **powerful** or **trapped** when boarders come
  up behind you? Fine line, and it decides whether stations work at all.
- Is switching between bow and stern a meaningful call or just legwork?
- Re-test the live toggles now that mantling exists: **G** (free-surface grapple
  vs hardpoints only) and **M** (release feel). Mantling made boarding far more
  forgiving, so earlier answers may have moved.

## Tier 1 — turn an encounter into a run

Nothing here is polish. Without it there is no roguelike, just an endless fight.

1. **Economy.** Kills drop scrap; scrap buys things. This is the current blocker
   on everything else: the "call the wave early" key exists and works, but there
   is nothing to be greedy *for*, so the risk/reward loop the design is built
   around cannot be tested. **Split the currency from the start** — shared scrap
   for the fortress, personal salvage for your own kit — because one pooled pot
   generates a co-op argument every wave and is painful to retrofit.
2. **Modules on hardpoints.** The bounded build layer — a limited number of
   sockets on the fortress, so a run has a readable silhouette. This is the
   game's identity, not a feature.
3. **Stacking personal upgrades.** The unbounded layer, Risk of Rain rules:
   passive, automatic, never managed, hyperbolic curves on anything that would
   break at 100%. Separate currency from the fortress, or co-op turns into an
   argument every wave.
4. **Travel and siege cadence.** Legs of a journey with branching route choice,
   a siege at each landmark, a boss at the end of a biome. Runs of 30-45 minutes.

## Tier 1.5 — give the gun a reason mid-wave

The gun is currently an opening move only, which matches its design but makes it
a small fraction of playtime. Two candidate fixes, cheapest first:

- Push spawns out from 74 m to ~110 m, roughly doubling the approach window.
- Add an **armoured enemy** the rifle can barely dent, which has to be killed at
  range before it arrives. That turns the gun from an opener into the answer to a
  recurring threat, which pulls the player back up repeatedly rather than once.

## Tier 2 — feel and content

- **Leg stomp damage.** Pitched early as the thing that makes the under-hull arena
  feel dangerous rather than merely dark; legs currently have no collision at all
  and pass harmlessly through everything.
- **Audio.** Completely absent. A stompy fortress is half a sound design problem
  and its absence is probably distorting every feel judgement being made.
- **More enemy types.** Burrowers that ignore pathing, saboteurs that plant
  charges on a leg and must be interrupted.
- **An automated deck turret.** Still held back: shock emitters already occupy the
  automation slot, and adding a second automated source makes it impossible to
  tell which one is carrying the fight. If it is added, check it against
  invariant 2b — automation must never hold a position unattended.
- **Enemy collision against deck scenery.** They currently clip through crates and
  rocks; the worst cases were fixed by halting on target, the rest is cosmetic.
- **Crosshair only reports grapple validity**, which is misleading now that the
  left button fires.

## Tier 3 — the risk that is still entirely unproven

**Networked players on a moving platform.** Flagged as the largest engineering
risk in the project on day one and untouched since. The browser prototype
de-risks *feel only* and says nothing about prediction, reconciliation, or
authority over a moving frame of reference.

This needs a spike in the target engine before any production commitment. Related
open decision: Unreal versus staying on the web. Crowd counts were the argument
for leaving the browser, but 400 enemies at 0.4 ms/frame suggests the browser is
holding up better than expected.

## Deliberately absent

Art, audio, netcode, meta-progression, PvP, extraction. Do not add polish to a
system whose design question is still open.

## Working notes

- `node verify.mjs` after every change. It has caught genuine bugs repeatedly,
  including several that looked correct in review.
- Roughly one in three bugs found in this project came from *interaction* between
  systems that were each correct alone: the reactor landing on the spawn point,
  boarders standing inside the reactor eating bullets, the mantle fighting a
  deliberate drop, a gun shooting its own railings. Playtest reports have been
  worth more than code review.
