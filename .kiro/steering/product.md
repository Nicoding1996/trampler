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
  The plate is on the **front** only, so there is a skill answer and it is a
  positional one: 60 rifle rounds head-on, 12 from behind. The gun keeps its job
  because the bulwark is slower than the hull and the intended meeting is head-on
  during the approach.
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

Every couple of waves the crew sees off pays a free pick of three items, and holding a
siege pays one more before the road choice — so a landmark has a shape: fight, get
handed something, fight, get handed something, spend what you earned, then gamble on a
road. Three per landmark. It used to be one, paid only for holding the whole siege, and
a playtester averaging wave four of five had met it once in an evening. A reward the
player does not reach is not a reward, it is a rumour.

The roster escalates across landmarks as well: arriving somewhere new means meeting the
types you had earned by mid-siege, not starting the schedule over. Wave *size* still
rewinds — that curve was tuned against measured pacing — so a landmark is a step up in
kind rather than in volume. Before this, the fight immediately after a road was
structurally simpler than the one before it, which is why the road choice read as a
counter ticking over.

## The salvage table

Eighteen items, and the interesting thing about them is what they are *for* rather
than how big their numbers are. Four numeric multipliers is not a build: every run
bought the same +25% damage in the same order, and the only thing that differed
between two runs was which road you took.

Six of them are still plain numbers, deliberately. A pool of nothing but exotic
effects has no baseline to judge them against, and "just more damage" is a real pick
when the alternative does not suit the build you already have. The other twelve fall
into categories chosen because of what they pay you for:

| category | pays you for | example |
|---|---|---|
| position | being in one of the two places | +30% beneath the hull |
| transition | *moving* between them | +40% for 3 s after boarding |
| job-linked | doing the work | +30% for 5 s after a repair |
| risk | the state you would rather not be in | +35% while the reactor is failing |
| tooling | changing which tool is correct | pierces a bulwark's armour |
| proc | a chain reaction off your own kills | splash on kill |

The transition pair is the one to protect: one item pays for getting aboard and
another for dropping off, so a build carrying both is paid for oscillating. That is
the pillar restated as an upgrade, which is the opposite of what a roguelike item
pool usually does to a positional game.

Rarity is three tiers, and it carries the price as well as the odds — items declare
a tier and inherit cost and growth from it. A landmark's shop shows four of the
sixteen personal items, re-rolled each time, which is why two runs build
differently. The two fortress refits are always on sale: the bounded track has to be
dependable enough to plan around.

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

**Growth has to be qualitative, or the unbounded track is just a number going up.**
The personal side had four multipliers for a long time, and it worked in the sense
that the arithmetic kept up with the enemy health curve. It failed in the sense that
nothing about it was a decision: there was one correct order to buy things in, and
by the third run you knew it. A pool that shows you a subset is what makes the
question "what does this run want" rather than "have I bought enough damage yet".

Note which way that pushed the item design. The obvious roguelike items for a game
like this — an auto-repair drone, a deployable turret, something that reaches under
the hull from the deck — are all *convenience*, and every one of them deletes a
reason to move. Invariant 2b-i is the enforced form.

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

**But an upper bound is not an answer, and it is easy to present one as though it were.**
The buy window was measured at 52 s of shoppable time per five-wave siege, which sounded
like a finding and was a *ceiling*: it was taken with a defender that clears the field,
and the rule being measured only ever bit when the field was not clear. For a competent
player the restriction cost nothing at all; for a struggling one it cost up to a third of
the window, and it varied 64% to 97% between two passes on the *same seeds*. The number
that mattered was the floor, and the probe was structurally incapable of reporting it.

So the rule is the oracle principle's other half: **an oracle tells you whether something
is possible, never what it costs.** When a mechanic exists to protect the player who is
losing, measure the player who is losing.

**And separate both of those from "illegible", which is the one that keeps happening.**
A playtest produced four complaints, and the striking thing was that not one of them was
about balance:

| what was said | what it actually was |
|---|---|
| "the grey creature, the tank — why are they hard to kill?" | no enemy damage feedback existed at all |
| "I just spam buy items out of panic" | the buy window overlapped the fight |
| "when I press one, does it matter? it seems like it just went next" | road costs were never displayed, and the roster reset |
| "I barely survive wave 4" | possibly all three of the above |

Every one of them was the player being unable to *see* a system that was working
correctly. And the fourth is why the order matters: a difficulty report from a player
who cannot read the fight is not attributable to difficulty. Notice also what the item
update did NOT change — the player reported the same wave-4 ceiling before and after
eighteen new items, which is strong evidence they could not tell what to buy or when.

So the rule is: **when a playtest complaint could be either a number or a readout, fix
the readout first.** It is cheaper, it is reversible, and it converts the next report
into something you can act on. Tuning first means tuning against an unmeasured feeling.

The corollary is a discipline about *when* to display something. A readout at the moment
the question is asked beats a permanent panel: what you carry sits on the shop, which is
only up when you are choosing what to buy; what the roads have cost sits on the route
panel, which is only up when you are choosing the next one. Neither costs a line of
always-visible screen, and both answer the question at the moment it arises.

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
purses, an eighteen-item salvage table with rarity tiers and a re-rolled shop, a free
pick of three at every landmark, three bounded hardpoints, a four-landmark journey
with branching roads, and a boss that inverts the pillar for one fight.

Sound is synthesised at runtime. The art is eight CC0 texture sets and one CC0
HDRI, vendored, and entirely optional — everything else is generated in code.

Update 1.5 made all of it readable rather than adding to it: enemies show damage, the
crosshair names what it is on and whether its armour is in the way, the shop only opens
when you are genuinely safe, picks arrive often enough to learn from, and a road says
what it cost as well as what it paid.

Update 1.6 fixed where all of that is *drawn*. Four things were anchored to the bottom
centre of the screen, three of them transient, and they covered the health and reactor bars
at exactly the moments those matter. Vitals moved to the empty bottom-left corner and lost
every row shown elsewhere; both purses were added, since they had only ever been visible
during the third of a siege when the shop was up.

Update 1.7 made **buying a place**. There is a refit terminal on the deck now, and the shop
is where it is. Three versions of a timing rule had all failed the same way — the panel
appeared at you, on a clock you could not see, during a "rest" that legally permits eight
live enemies — and the fix was to stop asking *when* and start asking *where*. It is the
depression-clamp lesson again: geometry enforces "you cannot buy your way out of trouble"
better than a phase check, because the console is on the deck and the fight is underneath
it. Reading was split from buying at the same time, so the panel is legible whenever you
stand there and the window itself is one keypress rather than ten seconds of frantic
comparison. The guaranteed window doubled, and — unlike the number it replaced — it is a
floor every player gets rather than a ceiling only a good one sees.

**The pillar is confirmed.** A solo playtest reported the intended rhythm —
picking off the approach from a gun, dropping down to fight and repair under the
hull, going back up when boarders reach the reactor. Roles emerged on their own,
which is the signal that co-op will work.

What is open is no longer arithmetic. Whether three hardpoints is an interesting
choice, whether the greedy road is ever tempting, whether the boss is an exam or a
wall, and whether being pinned at a gun feels powerful or trapped — none of that
can be measured, and all of it needs hands on the controls. See ROADMAP.md.

The salvage table adds its own open questions, and they are the same kind. Whether a
conditional item reads as a reason to move or as a tax on standing still. Whether the
transition pair is felt at all, or whether three seconds is too short to notice.
Whether four shop slots is enough exposure to the pool across a biome, or whether a
run ends without having seen anything interesting. The composition is measured
(51/29/20 across the tiers, about three rare offers a run); whether that *feels* like
a build is not something the harness can answer.

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
