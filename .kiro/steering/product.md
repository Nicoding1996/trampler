# Trampler — product context

A first-person game about a crew and a giant walking fortress. Roguelike wave
defence rather than an extraction shooter: the enemies come to you.

Reference point for the fantasy is SAND: Raiders of Sophie (giant modular
walkers, alt-1910 dieselpunk). We are **not** building that game — no PvP, no
extraction, no persistent economy. The overlap is "player-operated walking
fortress in first person" and nothing else.

## The pillar

**You can ride the fortress or fight on foot, and you cannot do both.**

Everything in the prototype exists to test whether players naturally oscillate
between those two positions because the fight forces them to. If one position
dominates, the pillar is broken and the design needs rethinking.

The oscillation is created by two opposing pressures, not by giving the player
options. Options do not create gameplay; pressure does.

| | Deck | Ground |
|---|---|---|
| Strong against | the wave at range, via a manned gun | chewers under the hull |
| Cannot touch | anything beneath the hull | the incoming wave (rifle only) |
| Also | reactor repair | leg repair, and deploying shock emitters |
| Cost | manning a gun pins you in place | you are exposed, and enemies board while you are down |

## Enemy roles

- **Chewers** attack the legs from *inboard*, under the hull slab. The deck
  physically cannot see them. They are the reason to dismount.
- **Climbers** board via authored routes and eat the reactor. They are the
  reason not to stay down there.

Losing the reactor ends the run. Losing legs stops the fortress dead.

## Design principles earned the hard way

**Geometry should enforce rules, not magic numbers.** The gun's depression clamp
was originally set to -12 degrees to stop it shooting under the hull. That was
belt-and-braces: the 3 m hull slab already blocks every such ray at any angle.
The clamp cost 47 m of minimum engagement range for nothing. Relaxed to -40 and
the rule became spatial and legible: *the hull's shadow is the safe zone*.

Prefer rules a player can see. "You cannot shoot through your own fortress" is
better than "the gun elevates between -12 and +35 degrees".

**Bounded structure, unbounded stacking.** The intended roguelike shape (not yet
built): the fortress has a limited number of hardpoints, so a run has a readable
silhouette, while personal upgrades stack without limit in the Risk of Rain
style. Growth shows up as accretion on a fixed frame, not as infinite geometry.

**Difficulty scales with elapsed time, not wave number.** Getting stronger has to
be a race against a clock, not a staircase climbed at your own pace.

**Automation is the floor, manned action is the ceiling.** Deployable defences
exist to buy time while you are somewhere else, never to hold a position on their
own. The moment automation can cover a job unattended, the player stops going
there and a pillar dies. Measure this, do not estimate it — the first pass at
shock emitters looked weak on paper (a third of a player's damage) and held the
under-hull area indefinitely, because automation never aims, never dies, and
never has to break off to repair something.

**Solo is designed, not scaled down.** Co-op is the primary experience, but the
solo answer is a system (deployables, in the Deep Rock Galactic / Bosco mould),
not a difficulty slider.

## Current state

Steps 1-4 of the prove-it plan are complete: moving deck, grapple boarding,
enemies creating both pressures, spatial damage with repair, two manned guns, and
deployable shock emitters.

**The pillar is confirmed.** A solo playtest reported the intended rhythm —
picking off the approach from a gun, dropping down to fight and repair under the
hull, going back up when boarders reach the reactor. Roles emerged on their own,
which is the signal that co-op will work.

Open: whether the recovery loop now holds up under wave 3+ pressure. See
ROADMAP.md.

## Scope discipline

This is a grey-box feel test, not a game. Deliberately absent: art, audio,
netcode, run structure, economy, modules, meta-progression. Do not add polish to
systems whose design question is still open.

The prototype de-risks **feel only**. Networked players on a moving platform is
the largest engineering risk in the project and is completely untouched.
