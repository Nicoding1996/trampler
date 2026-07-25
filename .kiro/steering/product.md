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

**Bounded structure, unbounded stacking.** The fortress has a limited number of
upgrade slots, so a run has a readable silhouette, while personal upgrades stack
without limit in the Risk of Rain style. Growth shows up as accretion on a fixed
frame, not as infinite geometry.

This is now expressed as *income*, not just as caps: personal salvage is earned
alone, per kill, and buys the unbounded track; shared scrap is earned together, by
resolving a wave, and buys the bounded one. Splitting the currency on day one was
deliberate — one pooled pot generates a co-op argument every wave, and retrofitting
a split means re-deriving every price and payout.

**A risk with no upside is not a decision.** Calling a wave early existed for a
long time with nothing to be greedy for, so nobody would ever press it. Any
mechanic offering the player a gamble needs a measurable payoff on the other side
of it, or it is dead weight that reads as a mistake waiting to happen.

**Difficulty scales with elapsed time, not wave number.** Getting stronger has to
be a race against a clock, not a staircase climbed at your own pace. This is also
the anti-stall valve: the rest phase cannot be farmed, because waiting makes
everything tougher.

**Pace off what the crew is actually enduring, not off a head count.** Following
Left 4 Dead's director: spawning stops entirely while pressure is high, then a
guaranteed calm follows. Pressure comes from health lost, hostiles under the hull,
hostiles aboard, and whether the fortress is stopped. Eight healthy enemies
loitering at 60 m are not the same problem as eight chewing the legs.

**On-screen panels accumulate, and the default has to be hidden.** Every panel was
a reasonable addition on its own; together they reached nine at once, two of them
overlapping into unreadable mush, and the effect of showing everything was that
none of it got read. What stays up while playing is only what a player *acts on*:
the stakes, the contextual prompt, the wave telegraph, and the refit list during
the window when buying is possible. Everything for whoever is tuning the thing is
behind a key. A readout that answers "is this working?" is instrumentation; a
readout that answers "what should I do now?" is UI.
→ test 67 guards it, since the headless harness cannot see the DOM

**Telegraph every wave.** A preparation window with a named bearing is what makes
deployable defences a decision and gives the guns a reason to be manned at a
specific moment. Borrowed from Deep Rock Galactic's swarm warning.

**Automation is the floor, manned action is the ceiling.** Deployable defences
exist to buy time while you are somewhere else, never to hold a position on their
own. The moment automation can cover a job unattended, the player stops going
there and a pillar dies. Measure this, do not estimate it — the first pass at
shock emitters looked weak on paper (a third of a player's damage) and held the
under-hull area indefinitely, because automation never aims, never dies, and
never has to break off to repair something.

**Separate "impossible" from "too demanding" before tuning anything.** Wave 3 was
called a wall three times and three different fixes were aimed at it. The useful
move was an **oracle defender** — teleports, never misses, never takes damage,
limited only to one action per frame — which survived past wave 6 untouched. That
proved the fight was winnable and the real constraint was travel and reaction
time, which points at completely different knobs. Build the upper bound before
adjusting numbers.

**Enemy speed is a human-facing knob, not a difficulty knob.** Slowing enemies 16%
changed the oracle's survival by one second in 227, because the oracle never
travels. Speed spends itself almost entirely on a human's travel and reaction
time, so it is the right lever for "this feels frantic" and the wrong lever for
"this is too easy".

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
