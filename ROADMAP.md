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

244 headless checks pass. The prototype contains both halves of the pillar, makes
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

## The wave-3 wall, and what is behind it

Wave 3 was reported as a wall three times. Three separate fixes were aimed at it
— repair rate, pressure-gated pacing, contested repair — and the third playtest
finally cleared it, reaching wave 4 "barely".

Before the third fix, the wall was diagnosed properly instead of guessed at, with
an **oracle defender**: teleports, never misses, never takes damage, perfect
information, and exactly one real limitation — a single action per frame, shoot or
repair. It is a strict upper bound on solo play.

| Scenario | Outcome |
|---|---|
| Nobody defending | reactor lost at 53.8 s, wave 1 |
| Oracle defender | survived past wave 6, reactor untouched, all legs full |
| Oracle, enemies 16% slower | past wave 6 again — 226 s vs 228 s |

Two conclusions, both load-bearing:

- **The arithmetic is not the wall.** A player who is always in the right place
  wins comfortably. What beats a real player is getting there.
- **Enemy speed is therefore a human-facing knob, not a difficulty knob.** It
  barely moved the oracle, because the oracle never travels. Everything it buys
  goes to a human's travel and reaction time. So it was settled in play with a live
  knob (`,` / `.`) rather than by argument: **chewers 4.70 m/s, climbers 4.52**,
  against the hull's 4.5 and a walking player's 7.0.

  Raw speed-vs-hull comparison badly overstates the risk of going low. Climbers at
  4.52 still put 8 of 8 boarders on a hull walking at full speed, only 0.7 s later
  than at 5.2, because waves arrive head-on and the fortress walks a circle that
  trailing enemies cut inside. What low speed actually costs is the stern chase:
  closing a 30 m gap from behind went from 24 s to 81 s, so a healthy fortress now
  sheds anything it gets past.

  Dropping to 4.70 exposed a **silent** bug that had been there all along: chewers
  chased a leg attack point moving at up to 6.33 m/s and simply fell behind, dealing
  0.5 hp/s instead of 9.9 — the under-hull threat evaporating with nothing looking
  wrong. Chewers now latch onto a leg and ride the hull. Four on one leg finally
  deal the 39.6 hp/s the rest of the design was already tuned against.

  Side effect to watch: every speed reduction makes automation relatively stronger,
  because emitters do not have to chase anything. The fixed-force emitter measure
  has gone 1.37x -> 1.54x -> 2.18x across these cuts. Invariant 2b still holds, but
  it is the guard that will break first if speed drops again.

- **Waiting around for enemies was the wave bearing, not the hull speed.** The
  director picked each wave's bearing across ±72°, and a wave committed near abeam
  got walked past — 23.2 s median to engage against 7.1 s dead ahead, so roughly a
  third of waves were a stern chase. `forwardArc` narrowed 1.25 → 0.9 rad, worst
  case now 10.3 s. Slowing the hull was the proposed fix and measured worse: a 29%
  cut only reached 13.3 s, and it does not stop bad bearings being handed out. The
  bearing-label threshold is now derived from the arc so the telegraph cannot
  silently degenerate to always DEAD AHEAD.

**The next wall is already visible in the numbers.** Reactor time-to-death, if
every climber in a wave reaches it:

| Wave | Climbers | Reactor dps | Dies in |
|---|---|---|---|
| 1 | 3 | 45 | 9.3 s |
| 2 | 5 | 75 | 5.6 s |
| 3 | 6 | 90 | 4.7 s |
| 4 | 8 | 120 | 3.5 s |

Repair is 60 hp/s, so from wave 2 onward the reactor cannot be out-repaired while
boarders stand on it — by design. But 3.5 s is less than the time to notice,
grapple up, turn and engage, which makes wave 4 a reaction-time wall rather than a
decision. Candidate fixes, to be tried **one at a time** so the effect is
measurable: cap how many boarders can engage the reactor at once, flatten
`climberShare` growth, or give the reactor a visible countdown so the trip up is
planned rather than reactive.

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

0. **A finish line — done.** A siege is `CFG.waves.siegeLength` waves (5, about
   three minutes) and ends in a HELD state that stops spawning and does not
   auto-reset. Added because a playtester averaging wave 4 read it as repeated
   failure when it is a reasonable curve against a fixed rifle; nothing was being
   reached. Deliberately shipped **without** nerfing difficulty, because enemy
   strength is quadratic (count x time-scaled hp) against a flat 200 dps — the
   missing half is the player's power curve, and nerfing now would have to be undone
   the moment upgrades land. Move `siegeLength`, not the enemy numbers.
   → test 60

1. **Economy — done.** Split from the start, as planned. Salvage is personal and
   paid per kill; scrap is shared and paid only when the crew *resolves* a wave, so
   nobody can farm the crew's budget alone. Four refits, bought with `1`-`4` between
   waves: rifle calibration and vitals stack without limit on salvage, hull plating
   (max 4) and a repair rig (max 3) are bounded and cost scrap. That asymmetry is
   the "bounded structure, unbounded stacking" principle expressed as income.

   **Q finally has a reason to exist.** Calling a wave early pays 1.5x on everything
   that wave earns, against three costs: no preparation window, a tougher combined
   fight, and the buried wave's clear payout, since only *resolved* waves pay.

   A full 5-wave siege budgets roughly 260 salvage and 280 scrap — about three
   personal stacks or two fortress upgrades, deliberately not both.

   Still open, and only playtesting can answer it: is the greed actually tempting,
   or is the safe line always correct? If nobody presses Q, raise
   `CFG.economy.earlyCallBonus` before touching anything else.
   → tests 61-66
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

- ~~Push spawns out from 74 m to ~110 m, roughly doubling the approach window.~~
  **Rejected.** This looked cheap and is actively harmful now. A playtest reported
  waiting around for enemies, measured as 23.2 s for a wave committed near abeam to
  engage, and the fix was narrowing the bearing arc to bring the worst case down to
  10.3 s. Pushing the spawn ring out scales every one of those numbers back up and
  reintroduces exactly the dead air we just removed. Approach *window* and approach
  *wait* are the same quantity seen from two positions — the gun wants it long, the
  player on foot wants it short, and the gun does not get to win that trade by
  making everyone wait.
- Add an **armoured enemy** the rifle can barely dent, which has to be killed at
  range before it arrives. That turns the gun from an opener into the answer to a
  recurring threat, which pulls the player back up repeatedly rather than once.
  Now the only candidate here, since it buys the gun a job without lengthening the
  approach for anyone else.

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
