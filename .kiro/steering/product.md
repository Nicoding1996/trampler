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

Six types. Each one attacks the pillar from a different angle, and none of them is
a health bar with a different colour on it. If a new type cannot be described as
"the reason to be somewhere", it should not exist.

- **Chewers** attack the legs from *inboard*, under the hull slab. The deck
  physically cannot see them. They are the reason to dismount.
- **Climbers** board via authored routes and eat the reactor. They are the
  reason not to stay down there.
- **Bulwarks** are armoured past the point where a rifle is a sensible answer —
  five damage a shot against 300 health. They are the reason the deck gun still
  matters after the first ten seconds of a wave, which it previously did not.
- **Burrowers** travel underground, where they cannot be shot, and surface beneath
  the hull. They are the reason camping a gun is not a strategy: every other ground
  threat has an approach you can shoot at, so a player parked at the bow could farm
  the horde and only ever lose to the boarders behind them.
- **Sappers** deal no contact damage at all. They plant a charge worth exactly one
  leg on a six-second fuse. They are the reason to go down there *right now*, and
  the only enemy that is a timer rather than a damage race.
- **The titan** is too tall to fit under the hull, so it works from outboard, in
  the open, where both guns reach it. It is the one fight that inverts the pillar
  and makes the deck the right place to be.

Losing the reactor ends the run. Losing legs stops the fortress dead.

## The run

Four landmarks, a siege at each, and between them a choice of two roads. Every
road carries a real cost — more enemies, tougher enemies, faster enemies, less
visibility — and pays on arrival, so the money for choosing the hard road is
spendable on surviving it. The quiet road exists and is deliberately the dull one:
a menu where one option is strictly best is a menu, not a decision.

The last landmark is the boss. About fifteen minutes for a biome, against a
30-45 minute target for a full run — biomes are the unit that repeats.

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

This is expressed as *income*, not just as caps: personal salvage is earned alone
and buys the unbounded track, shared scrap is earned by resolving a wave and buys
the bounded one. Invariant 22 is the enforced form. Splitting the currency on day
one was deliberate — one pooled pot generates a co-op argument every wave, and
retrofitting a split means re-deriving every price and payout.

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

**The fortress does not fight for you.** The strongest form of the rule above, and
it was learned by breaking it. Leg stomps were added to make the under-hull arena
feel dangerous, and they were deliberately too weak to kill a chewer on their own,
which seemed like protection enough. It was not: undefended survival rose by a
fifth and the fixed-force emitter test hit its ceiling.

Nothing looked wrong. The fortress simply defended itself, and the reason to be
down there evaporated. Two automated damage sources cannot be attributed — you can
no longer tell which one is carrying the fight — which is also why an automated
deck turret has been shelved three times. The feet now hurt the player and shove
bodies aside, and settle nothing. Invariant 2c holds the measurements and the two
things that protect it.

**Add to the roster, not to the count.** New enemy types substitute for existing
ones inside a wave rather than growing it, because the wave-size curve was tuned
against measured pacing and moving size and composition together means no later
difficulty change can be attributed to either. Invariant 19e is the enforced form.
The same discipline governs fixes and edits — see "One change at a time" in
`tech.md`.

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

Everything planned below the netcode tier is built and measured: the moving deck,
grapple boarding, six enemy types creating pressure in every direction, spatial
damage with repair, two manned guns, deployable shock emitters, a finish line, two
purses, unbounded personal stacks, three bounded hardpoints, a four-landmark
journey with branching roads, and a boss that inverts the pillar for one fight.

Sound is synthesised at runtime. The art is eight CC0 texture sets and one CC0
HDRI, vendored, and entirely optional — everything else is generated in code.

**The pillar is confirmed.** A solo playtest reported the intended rhythm —
picking off the approach from a gun, dropping down to fight and repair under the
hull, going back up when boarders reach the reactor. Roles emerged on their own,
which is the signal that co-op will work.

What is open is no longer arithmetic. Whether three hardpoints is an interesting
choice, whether the greedy road is ever tempting, whether the boss is an exam or a
wall, and whether being pinned at a gun feels powerful or trapped — none of that
can be measured, and all of it needs hands on the controls. See ROADMAP.md.

## Scope discipline

This is still a feel test, not a shippable game. What exists is there to answer a
design question; what does not exist is there because its question is not open yet.

Deliberately absent: netcode, meta-progression, a second biome, PvP, extraction,
and any polish on a system whose design question is still open. The art that does
exist is the minimum needed to stop a grey box reading as a grey box, because a
grey box distorts feel judgements too — sound was silent for months and was
demonstrably skewing them.

The prototype de-risks **feel only**. Networked players on a moving platform is the
largest engineering risk in the project, is completely untouched, and structurally
cannot be answered here. It needs a spike in the target engine.
