# Trampler — load-bearing invariants

These are the rules the design rests on. Each has a guarding test in `verify.mjs`.
When one fails after a change, the change is usually wrong rather than the test, so
read the test first and find out what it measured.

The exception is real and worth naming: when behaviour changes on purpose, the old
assertion fails *correctly*, and repairing it is then the right move. What is never
right is repairing an assertion without knowing which measurement it encoded.

## The pillar depends on these

**1. Nothing on top of the fortress can shoot beneath it.**
The 3 m hull slab blocks every such ray, at any angle, from any mount. This is
what makes chewers a problem solvable only on foot, and therefore what makes
players dismount at all. Enforced by geometry, not by aim clamps.
→ tests 12, 28, 37, 40

**2. The grapple is the only way aboard from the ground.**
Jumping, mantling, and chaining climbs must never ladder a player onto the deck.
Verified against 15 seconds of relentless jumping at the hull's flank.
→ tests 23, 24

**2b. Automation is the floor, never the ceiling.**
Shock emitters must *delay* the fortress being crippled, not prevent it. Measured
with no player present at all: 67.7 s undefended, 83.7 s with three emitters, and
131.1 s with **every defensive system in the game fitted at once** — four hull
plates, three repair rigs, an emitter rack, floodlights, baffles, and five emitters
deployed. It buys time. It never holds.

This has to be re-checked whenever anything defensive is added, including upgrades
and modules, because combinations are not covered by either system's own test. The
failure is silent: nothing looks broken, the player simply stops having a reason to
go down there and half the pillar quietly dies.
→ tests 48, 66, 77

**2b-i. NO ITEM MAY AUTOMATE A JOB THE PLAYER HAS TO BE PRESENT FOR.**
The salvage table is eighteen items and several of them are on-kill effects. A
splash-on-kill and a rack of shock emitters are each individually fine; together,
ungated, an emitter kills a chewer, the splash kills two more, and each of those
splashes again — automation compounding itself with nobody within a hundred metres.
That failure would arrive through an item nobody thinks of as defensive.

The gate is `source === "player"` on every proc, and a manned deck gun counts as the
player because somebody is sitting in it. Measured: the whole salvage table three
stacks deep, on top of four hull plates, three repair rigs, three modules and five
emitters, still leaves the fortress crippled at **131.1 s with nobody aboard** —
identical to the number before the item layer existed — with **0 procs across 23
unattended kills**.

The same rule rules items out at design time: an auto-repair drone, a deployable
turret, anything that reaches under the hull from the deck. All ordinary roguelike
items, and each one deletes the reason to oscillate. The categories that exist
instead pay you for BEING somewhere or for MOVING between the two positions, which
pushes the other way.
→ tests 77, 94

**2c. THE FORTRESS DOES NOT FIGHT FOR YOU. The feet deal no enemy damage.**
This is the newest invariant and it was learned by breaking it. A leg stomp that
dealt 30 damage — *below* a chewer's 50 hp, so incapable of killing anything alone,
which seemed like sufficient protection — pushed undefended time-to-crippled from
67.7 s to 81.0 s and made test 48's fixed-force measurement hit its 45 s ceiling.
Emitters plus feet held fourteen chewers off the legs for the whole window with
nobody present. Neither system did that alone.

A damaging foot is a second automated damage source wearing a different hat, which
is the same reason the automated deck turret is still shelved: with two of them you
cannot attribute a fight to either.

The feet hurt the **player** and shove bodies aside. Two things protect this:
geometry — the feet sit at local x ±9.9, outboard of the 8 m half-width, 2.9 m from
a latched attacker at ±7.0 against a 2.0 m radius — and the shove skipping anything
already latched, so it cannot break an attacker off a leg either.
→ test 72

**3. The crow's nest stays grapple-only.**
It is the one place with no walkable route. Chained mantles must not reach it.
This is why **decorative geometry never carries a collider**: a new 1.4 m ledge is
exactly the sort of thing that quietly turns three chained climbs into a route up.
→ test 24

## Movement fidelity

**4. Based movement is exact.** Zero drift across the deck over 15 seconds of
walking and turning. World velocity preserved to 0 across frame switches. A
straight-up jump lands within 2 cm of take-off.
→ tests 1, 3, 4

**5. Anything anchored to the hull is stored in hull-local space** and tracks the
fortress as it walks and turns. A climb lands within 2 cm of its intended spot in
hull space while the hull travels 1.4 m underneath.
→ tests 5, 25

**6. Fast movement cannot tunnel.** A grapple exit can exceed 50 m/s, which is
over 1.7 m per frame at the 1/30 dt clamp, against railings 0.5 m thick.
Integration substeps to keep each move shorter than the thinnest wall.
→ test 11

**7. A deliberate drop must always be possible.** Walking backwards off the deck
means facing the thing you are leaving, so the mantle must gate on *approach
intent measured in the hull's frame*, not on look direction.
→ tests 29, 30

## Combat legibility

**8. Everything the player can see, the player can shoot.** Enemies are hit as
boxes matching what is drawn, not spheres, and a ray starting inside a box counts
as a hit so point-blank enemies are killable.

**8a. And the player must be able to SEE that a shot worked.** This clause was
implicit in 8 for a long time — "a magazine emptied into something with the health bar
refusing to move is indistinguishable from a bug" — and then a playtest found the game
had no such feedback at all beyond a one-frame white flash. Against a bulwark carrying
740 hp at the ramp it actually spawns on, a player could not tell "wrong tool" from
"broken game", and said so.

Two mechanisms, because a crowd and a target are different questions:

- **The crowd reads from the enemies themselves.** Wounded bodies are drawn darker,
  quantised into four bands, written into the per-instance colour buffer the hit flash
  already allocated. No UI, no draw calls, and an untouched crowd costs no upload.
  Deliberately not forty-five floating bars: the two shipped games nearest this one
  omit those on purpose and invest in in-world feedback instead.
- **The thing under the crosshair gets a number**, plus its name and whether its
  armour is in the way. One target, one readout, up only while something is there.

The flash and a lit fuse both OUTRANK the tint. That ordering is deliberate: the flash
is the only "that connected" signal in the game, and a wounded body quietly swallowing
it would trade the more urgent reading for the less urgent one.
→ tests 84, 97, 98

Two corollaries added with the new roster. **Armour is never immunity**: damage is
`max(raw - armour, raw * minDamageFraction)`, so a rifle still does 5 to a titan.
A magazine emptied into something with the health bar refusing to move is
indistinguishable from a bug. And **the one type that cannot be shot cannot stay
that way**: a burrower is untouchable only while submerged, on a hard clock, and it
surfaces on that clock wherever it has got to.

That second corollary has a converse which was broken for an entire update: **while it
is submerged, NOTHING may reach it — not just shots.** Fragmentation splash and the arc
chain do not route through `shootFrom` and so get no occlusion clip; both were written
with an exclusion for burrowers and neither exclusion worked, because both tested a
per-enemy `burrowed` field that does not exist. A proc could kill a thing the player
cannot see or shoot. The predicate is now exported from `enemies.js` as `isSubmerged` so
the mistake is not spellable; `tech.md` has the general lesson.
→ test 94

**8b. Armour has a POSITIONAL answer, not an aim-based one.** A playtester asked for
headshot damage, and the instinct was right — there was no way to out-*play* armour at
all, only to out-buy it. A head multiplier was the wrong shape though: it would have
handed the rifle a bulwark and taken away the recurring job the bulwark exists to give
the deck gun, after which the deck stops mattering past the opening ten seconds again.

So the bulwark's plate is on its FRONT only, 70° either side of directly behind it.
Measured: 60 rifle rounds head-on against 12 from behind. Abeam is deliberately not
enough — you have to be behind it. That turns "which weapon" into "which side of it am
I on", which is the pillar's own question rather than a new one, and it reads spatially
rather than as a number: a bulwark locked onto a leg has its back to the open ground.

Three things hold it in place. The intended meeting is still head-on during the
approach, from a mount, at range, because the bulwark is slower than the hull. The
titan keeps an omnidirectional plate, because that is the one fight built around the
deck (13c) and a rifle answer found by walking round the back would undo the geometry
it is made of. And **only `shootFrom` consults the facing**, so a shock emitter always
meets the full plate — automation does not get rewarded for standing in the right
place, because it never chose where to stand.
→ tests 69, 84
→ tests 8, 27, 69, 71

**9. No enemy may be shielded by geometry it is standing inside.** Attackers close
on a target's *surface*, never its centre. Boarders inside the reactor box were
invulnerable because the reactor absorbed every bullet aimed at them.
→ test 26

**9b. Boarders walk around deck furniture, not through it.** Resolved on x/z in
hull space against `deckObstacles`, which is a subset of the colliders — the hull
slab and deck skin are floors, and including them would push every boarder off the
ship.
→ test 75

**10. Shots must be visible.** Tracers are drawn from a muzzle offset, not from
the camera, and widen with range. Impact markers mark where rounds land.
→ tests 31, 44

**10b. The crosshair must report the WEAPON, not only the winch.** It described
grapple validity alone for a long time, which became actively misleading the moment
the left button started firing — grey meant "grapple cooling" and read as "cannot
shoot".

## Fortress systems

**11. Below three working legs the fortress stops dead**, and cannot move again
until repaired. Drive scales 100/75/50/25/0 as legs are lost.
→ tests 32, 33

**12. Repair points sit where the player can find them** — beside the visible
leg, under the hull, with a lit ground marker — and repair progress is never
lost. The default `inboardOffset` is shared between the chewer's attack point and
the repair point, so it must never move: at 5.9 it sat four metres inboard of the
visible foot and walking up to a damaged leg offered nothing.
→ tests 34, 43

**12b. Repair must be able to win once the area is clear.** At 45 hp/s it could
never beat chewer damage of 48-154 hp/s at any wave size, so falling behind was
unrecoverable. Now 110 hp/s: a dead leg takes about a second.
→ test 45

**12c. Contested repair is slowed to 35%, never blocked.** Blocking it was an
over-correction and was reverted. Repair does 110 hp/s against roughly 40 hp/s of
chewing, so the operative's own health — 40 hp/s incoming against 100 hp — was
always the real limiter; the rule was redundant. It also measures hostiles near
the *player*, so a hard block froze the work whenever a teammate fought beside the
repairer, which breaks the division of labour co-op is built on. The HUD says
CONTESTED rather than refusing, so the player sees the trade.
→ test 53

**13. Only one station can be manned at a time, and manning one pins you.**
Zero drift across the deck while holding sprint and jump.
→ tests 36, 42

**13b. The reactor can only be engaged by a limited number of attackers.**
Reactor time-to-death used to be 9.3 s at wave 1 falling to 3.5 s at wave 4, which
is less than the time to notice, grapple up, turn and engage — a reaction-time wall
rather than a decision. Three slots hold it at 45 dps regardless of wave size:
measured, twelve boarders take 9.0 s and three take 9.0 s, a ratio of 1.00 where it
used to be 4.

Three candidate fixes existed and were deliberately **not** tried together, because
three simultaneous changes to one number cannot be attributed afterwards. The cap
also can never reach zero — a reactor nothing can attack cannot be lost, and losing
it is the run.
→ test 74

**13c. The boss cannot use the hull's shadow.** The titan is 5.2 m against 4.5 m of
clearance, so it physically cannot fit underneath and attacks from an outboard
offset, in the open, where both guns reach it. The one fight where the deck is the
right place to be, arrived at through geometry rather than a rule.
→ test 70

## Economy and the build

**22. The two purses never mix.** Salvage is personal and paid per kill; scrap is
shared and paid only when the crew *resolves* a wave. Funding the shared pot from
the shared objective is what stops one player farming the crew's budget, and the
split is the "bounded structure, unbounded stacking" principle expressed as income:
money earned alone buys unbounded personal power, money earned together buys a
fixed frame.
→ tests 61, 62

**22b. Anything that would break at 100% stacks hyperbolically.** Not a matter of
taste: an unbounded fire rate eventually divides by zero, and total damage immunity
removes the ground's cost, which is half the pillar. Fire rate approaches +120% and
never arrives; damage taken approaches zero and is still 6.8% at two hundred stacks.
→ test 78

**22c. The fortress has fewer hardpoints than modules, and fitting is permanent.**
Three sockets, six modules, duplicates allowed. Permanence is the point — a build
you can rearrange between waves is not a commitment, and without commitment the
choice is a preference you can revisit for free. There is deliberately no `unfit`.
→ test 76

**22d. The personal track is a POOL, and the shop shows a subset of it.** Eighteen
items against six number keys, so a landmark offers four personal slots drawn from
sixteen. That constraint is the mechanism, not a limitation worked around: before
it, every run bought the same four multipliers in the same order and the only thing
that varied across a whole playthrough was which road you took.

The two scrap refits are **always** offered. That asymmetry is 22 restated — the
bounded fortress track has to be dependable enough to plan a run around, and the
unbounded personal track is the half that varies.

Rarity supplies cost and growth; items declare only a tier. Hand-set prices were 32
unrelated numbers and nothing kept a proc priced above a flat damage stack. And the
draw picks a **tier first, then uniformly within it**, because per-item weights
cannot express "one offer in five should be rare" when the tiers hold different
numbers of items: measured at 6:3:1 per item, rares came out at 8% of offers, about
one across a whole run, for the items the pool exists to deliver. Now 51/29/20
against 50/30/20 configured. Fixing it the other way would have required rare items
to carry a *higher* number than uncommons in order to appear *less* often — a config
that lies to the next reader.
→ tests 91, 95

**22e. Every item in the catalogue must actually do something.** Eighteen entries
maintained by hand, and the failure mode is an item that is priced, listed, buyable
and wired to nothing. Nothing throws; the player spends 95 salvage and the game does
not change, which gets filed as "that item feels weak" rather than "that item does
not exist". Every id must have a static effect or be read by the runtime, and every
rarity tier must be populated or its weight is a dead letter.
→ test 91

**22f. A free pick of three arrives on a cadence the player actually reaches, and the
pick is personal.** Being handed something is a different beat from buying it, and it is
the only acquisition that does not compete with the fortress for money. Salvage items
only — a free hull plate would be one purse funding the other, which is 22 broken from
the reward side. Taking one clears the rest, because the whole value of a pick is what
you gave up.

The cadence clause is the one a playtest forced. The pick was paid ONLY for holding a
siege — wave five of five — and the player averaged wave four, so the headline reward of
the whole item update was behind a gate they had passed once in an evening. A reward the
player does not reach is not a reward, it is a rumour. It now pays every two waves the
crew *sees off*, on top of the hold's own: three per landmark, first one at wave 2.

Three properties fall out of polling the director's resolved counter rather than taking
a callback, and all three are wanted. A wave BURIED by pressing Q pays nothing, which is
part of what calling early costs. The cadence keys off the wave number *within* a siege,
so the rhythm is identical at every landmark rather than drifting for no reason a player
could infer. And an offer already in hand is never overwritten, because an item you were
looking at vanishing reads as a bug rather than as luck.

Nothing may be left on offer once the biome is done, from either source — an item you
can never spend is a menu, not a reward. The boss leg pays no pick for *holding* it, but
the cadence does pay during the boss siege, because there is still a titan to spend it
on.

**And the pick waits for the same SAFETY window the shop does**, through the same getter
rather than a second rule that means roughly the same thing. The pick panel is a 680 px
menu of three items on the bottom-centre anchor and it used to appear the instant a pick
was earned — which is the instant a wave resolves, frequently with the remains of that wave
still on you. That is the shop's "I just spam buy items out of panic" with none of the
shop's protection.

It does **not** wait for the shop's place clause. See 23c: buying happens at a terminal,
and a pick is handed to you wherever you are standing.

Three things make the wait free rather than a punishment. The offer is **banked, never
withdrawn**, so nothing is lost by not being ready. The keys are **not owned by it while
it waits**, or they would be dead — claimed by something that refuses to act on them and
unavailable to the shop or the bay. And the prompt **says** it is banked, because a
reward the player earned and never found out about is the same illegibility this was
meant to fix.

Pausing was the alternative and it is rejected: co-op is the primary experience and you
cannot stop a horde game for one player's menu. Risk of Rain 2 and Deep Rock Galactic
both decline to, for the same reason.

One consequence worth recording, because it turned a rare bug into an ordinary one: a
pick that waits is far more likely to still be in hand when the siege is held, and the
hold's payer was overwriting it. The cadence's payer already guarded against that; the
hold's did not.
→ tests 79, 96, 99

**23. BUYING IS A PLACE, and between waves.** Spending mid-fight would let a player
purchase their way out of trouble and would drain the tension the siege is built on.

There is a refit terminal on the deck, starboard amidships, and the shop is where it is.
Three clauses, each doing a different job:

- **At the terminal**, within `economy.terminalRange`. This is the clause that carries
  "no spending your way out of trouble", and it carries it *visibly*.
- **No wave actively out** — rest, prep or a held siege, but never SPAWNING or ENGAGED.
- **Nothing within `repair.threatRange` of the operative.** Reused from the contested
  repair rule rather than given its own number, because the two ask the same question and
  two nearly-identical thresholds drift apart.

It took three tries to get here and the failures are the useful part:

- **V1** was rest + prep + the wave itself. "In the middle of the wave I am fighting, so I
  just spam buy items out of panic."
- **V2** was a rest with the fortress clear. Measured badly: **zero cost to a competent
  player and up to a third of the window for a struggling one** — precisely backwards for a
  rule meant to protect the player who is losing — varying 64% to 97% across two passes on
  the *same seeds*, because it depended on where the horde happened to be. "Some enemy is
  under the hull somewhere on a 26 m chassis" is not a state anyone can see or fix.
- **V3** asked about the operative instead, at 6 m. Better, because you could satisfy it by
  moving. But the next playtest reported the thing all three had in common: "it shows up a
  short time and sometimes it shows up while I am fighting."

That last report is the real fault, and no threshold fixes it. The shop was **push** — it
appeared at you, on a clock you cannot see, and left on its own. `holdUntilCleared` is
EIGHT, so a wave counts as resolved and the rest begins with eight enemies still alive; a
proximity test only ever promised that none of them was on top of you.

A place fixes it, and it is the **depression-clamp lesson** applied to the economy. The gun
was clamped to -12° to stop it shooting under the hull; the 3 m hull slab already did that,
so the number came out and the rule became something a player can see. Here, "you cannot
buy your way out of trouble" stops being a phase check and becomes geometry: the console is
1.1 m above a deck 7.5 m above the sand, so nothing standing underneath is within 3 m of
it, and the ground physically cannot shop. The config knob does not need to say "and you
must be aboard" — the arithmetic already does, and a test asserts it rather than trusting
two numbers in different files to stay in the right relationship.

It also gives buying a cost made of the pillar's own material: being at the console is
being on the deck, not under the hull, and not at a gun.

**WHERE it goes is the hard part, and it took four attempts.** A 26 × 16 m deck already
carrying a mast, a reactor, two gun sponsons, three crates, an engine block and eight
boarding-route exits has almost no free space, and each rejection was a real constraint
discovered:

| position | why it was wrong |
|---|---|
| (-5.6, 2.1) port amidships | 2.37 m from the deck spawn, **inside** the interaction radius, so the panel was up the instant the player appeared — the push behaviour it exists to remove |
| (5.6, 2.1) starboard amidships | **1.5 m from a boarding route exit**, reactor corner 3.2 m off. The proximity clause would have fired permanently, and hardest for whoever was losing the boarding fight — V2's failure in a new costume |
| (0, -4.1) centreline, forward of the mast | clears every route by 6.9 m and broke two movement tests instantly. Test 2's own comment says why: *"local z = -4 is the one lane clear of the mast, the crates, the bow step and the engine block"* |
| **(4.05, 2.1, -7.65) bow bridge, outboard** | correct |

The bridge works because it is a raised platform that **already exists**, so nothing new
obstructs the deck floor at all — and hugging the outboard edge leaves a 1.0 m walkway
inboard, so the route up the centreline step to the bow gun is untouched. It is also the
most legible spot on the ship: raised, facing the deck, visible from most of the hull, which
matters when it is the only way to buy anything.

**And the proximity measurement is about the REACTOR, not the boarding routes.** A climber
transiting a route passes within 6 m for a second or two and walks on, which is legible and
harmless. A boarder *attacking the reactor* stops and stays, and that is what would keep the
shop shut. The bridge is 10.8 m from the reactor's surface — the place attackers actually
stand, per invariant 9. The comment that once defended the amidships position claimed "6.3 m
from the reactor, deliberately marginal", and it was measuring to the reactor's **centre**,
which nothing ever occupies, and had never looked at the climb routes at all.

**PREP IS BACK IN, AND THAT IS A DELIBERATE REVERSAL OF V2.** 19b says the preparation
window exists to make deploying an emitter a decision, and V2 excluded the shop on the
grounds that a competing panel takes the preparation away. That argument was about a shop
that appears *on its own*. A console you walk to takes nothing — choosing to spend prep at
the terminal instead of placing an emitter is exactly the trade 19b wants to exist.

**MEASURED AS A FLOOR THIS TIME, NOT A CEILING.** `minRest` is a guaranteed breather after
every resolved wave and `prepTime` is a fixed timer; neither shortens because the fight is
going badly. So the window is **22 s per wave and 110 s across a five-wave siege,
guaranteed to every player regardless of skill** — against V2's 52 s that only a competent
player ever saw. A held siege still has no timer at all, so the unhurried moment to spend a
siege's earnings is right after holding one, which is where the money came from.

**And WHICH clause refuses is measured too, because that is the whole question.** Camped at
the console for a 400 s stretch with a deliberately weak defender — boarders let through,
peak 3 riding the deck, the siege stalling at wave 4 — the split is **310 s refused by a
live wave against 1.8 s by proximity, 0.6% of all refusals**. Six windows, about 15 s each.

Two things fall out of that and both are the point. The refusal a player experiences is
always "wait for the wave", which is predictable and legible. And **struggling does not
shorten the window, it reduces the number of windows** — each one is still the full 22 s,
because both phases are timers. That is the opposite of V2, where doing badly ate the window
itself.

Note the assertion does NOT claim proximity never fires. An earlier version did, and failed:
a boarder does occasionally walk past the bridge. It claims proximity stays a rounding error
next to the phase clause, which is a measurement rather than a hope.

**23b. BROWSING AND BUYING ARE DIFFERENT QUESTIONS.** The panel is up whenever you are at
the terminal, including mid-wave; only the keys wait. This is the fix for "it shows up a
short time", and the diagnosis is that twelve seconds was never short because twelve
seconds is short — it was short because the panel existed *only* while a purchase was
legal, so the player spent the whole window reading six items of two lines each, cold, with
no earlier moment in which to have read them. Reading and deciding now happen before the
window; the window itself is one keypress.

Browsing mid-wave costs standing still on the deck while a wave is out, which is a real
price. And the panel must **say** which state it is in — title, dimmed list, grey key caps —
because a panel headed REFIT that silently swallows every keypress is worse than one that
is absent. Same principle as contested repair reporting CONTESTED rather than refusing:
tell the player the trade.

A refusal also names *which* clause refused — `NOT AT THE REFIT TERMINAL`, `NOT WHILE A
WAVE IS OUT`, `HOSTILES TOO CLOSE`. One generic "NOT BETWEEN WAVES" was being shown for
causes that had nothing to do with waves, and a refusal that misdescribes itself sends the
player to fix the wrong thing.

**23c. THE PICK IS NOT GATED ON THE PLACE, ONLY ON THE SAFETY.** `open` is
`atTerminal && safeMoment`; `pickOpen` is `pending && safeMoment`. One shared safety
getter, and the extra clause only where it belongs. Making you walk to a console to spend
money is the point; making you walk to one to collect a reward you already earned would
undo 22f's argument that being handed something is a different beat from buying it.
→ test 63, test 84 for the locked panel, test 96 for the pick's half

**24. Every kill pays, whatever killed it.** The hook is on `Horde.damage`, the one
choke point all damage routes through, so a newly added weapon cannot silently pay
nothing. Wounding pays nothing, or chip damage becomes an income farm. Payouts are
looked up by type *name*, not by a ternary, so a new type cannot silently pay a
chewer's rate.
→ test 61

**25. A restart reverts every upgrade, every module, both purses, and the whole
journey.** Effects are recomputed absolutely from stack counts, so `applyAll()` with
zero stacks *is* the reset and there is no separate revert path to forget. Leaving
state in place would make every subsequent attempt quietly easier and destroy the
point of the seeded fight.

The conditional half of the item pool follows the same rule by a second route: it is
cleared and rebuilt from current conditions every frame, so a reset is the next
frame finding no stacks to read. Nine fields are affected and test 92 reads all nine
in one place — an effect that starts writing somewhere new shows up there as an
unreverted value rather than as two runs disagreeing later, which is the hardest
failure in this project to trace back to a cause.
→ tests 65, 76, 82, 92

**26. Calling a wave early must pay.** Q existed for a long time with nothing to be
greedy for: the cost was losing a 12 s preparation window and the reward was
nothing, so a risk with no upside was not a decision. It now costs three things —
no prep, a tougher combined fight, and the buried wave's clear payout, since only
resolved waves pay — against a 1.5x multiplier on everything that wave earns.
→ tests 64, 51

**26b. Road payouts land on ARRIVAL, before the fight they paid for.** You are paid
for choosing the hard road while the money is still spendable on surviving it.
Paying afterwards would make the gamble a punishment with a consolation prize.
→ test 79

## Hygiene

**14. No spawn or teleport point may overlap a collider.** The deck spawn once sat
inside the reactor and every respawn silently shoved the player aside. Asserted as
a general rule, not as one case.
→ test 18

**15. Nothing flagged as aboard may float off the deck footprint.** Checked every
frame of every scenario, not in one test.
→ global invariant in `step()`

**16. No NaN in position or velocity, ever.** Also global. Extended to the
particle buffers: one NaN position collapses the bounding sphere and the entire
system vanishes, which reads as "particles do not work".
→ global, and test 83

**17. Death cannot loop.** Respawn grants brief immunity, because boarders may be
standing on the spawn point.
→ test 19

**18. Enemies must never become harmless.** With every leg destroyed, chewers
escalate to boarding rather than idling under a wrecked fortress. And no type may
carry a zero where a zero means "does nothing" — the sapper's zero *contact*
damage is the one exception, and it has a fuse instead.
→ tests 20, 68

**18b. An attacker that has reached its target rides it.** Chewers latch to a leg
rather than re-chasing it each frame, because the target moves faster than they
do: a leg's attack point is outboard, so the hull's yaw adds tangential speed on
top of its 4.5 m/s — measured at 4.71 m/s mean and **6.33 m/s peak** on the legs
outside a turn, which exceeds even the fastest chewer speed ever configured.
Chasing made leg damage fluctuate with the hull's turn phase, and below ~4.71 m/s
it collapsed to 0.5 hp/s from a nominal 9.9: the fortress walks on untouched and
the reason to fight beneath it disappears. This failed **silently**.

Latching decouples the two jobs: speed decides how fast they arrive, the latch
decides whether they can hold on. Never make an attacker's damage depend on
out-running a point attached to a turning fortress.
→ tests 15, 15b

**19. Waves must never stack onto an unresolved fight.** Pacing follows L4D's
model: REST → PREP → SPAWNING → ENGAGED, gated on measured crew *pressure* rather
than a head count. On a fixed clock, falling behind once was unrecoverable —
measured as 16 hostiles parked under an immobilised hull with more arriving on
schedule. A stopped fortress alone now halts reinforcements outright.

A burrowing enemy is deliberately **excluded** from the pressure count: there is
nothing the crew can act on yet, and pacing should not be gated on something
invisible.

**But the halt withholds the next wave, NOT credit for the last one.** That distinction
was missing for a long time and nothing asserted it either way. `immobileWeight` is 0.40
against a `calmBelow` of 0.35, so while the fortress is below a tripod the hull term alone
put `calm` arithmetically out of reach — at full health, with an empty field, for ever.
One getter was gating two unrelated questions, so a crew that killed every last enemy with
four legs down never had the wave marked resolved.

Everything downstream of `resolved` is payment for work already done: the wave-clear
scrap, the pick cadence, the end of a siege, and the phase clause the refit terminal
reads. So a wrecked fortress withheld the money for the fight the crew had just won, and
shut the shop that sells the repair rig at the one moment it is wanted. The refusal even
named the wrong clause — `NOT WHILE A WAVE IS OUT`, with nothing on the field — which is
exactly the failure 23b's three separate reasons exist to prevent. Reported in those
words: "I killed all the enemies but I cannot shop".

Two getters now. `settled` asks about the **field** and ends an ENGAGED wave; `calm` is
`settled && !immobilised` and is what lets a REST become a PREP. The hull clause is
unchanged and deliberate — nothing arrives while you are dead in the sand — and the
measurements behind it are untouched: still 0 spawned while immobilised, still held for a
full minute, byte-identical.

Worth naming the shape, because it is the third time this project has hit it: **one
predicate serving two questions is a bug waiting for the questions to diverge.** Same
family as `open` versus `pickOpen` sharing `safeMoment` but not `atTerminal`, and as the
two pressure halves here. When a condition is asked for two reasons, split it before the
reasons drift.

The stalling *incentive* this exposed is deliberately NOT addressed. A crippled fortress
still halts reinforcements indefinitely, priced only by the elapsed-time hp ramp, and
whether that price is right is unmeasured. Measuring it wants a losing player's ledger —
total stall time and accumulated ramp cost across a siege with a deliberately weak
defender — which is the same shape as the 400 s camped-at-the-console measurement in 23.
Two variables, one at a time.
→ tests 16, 50, 54, 55, 105

**19b. Every wave is telegraphed, and a guaranteed rest precedes it.** Deep Rock
Galactic gives 15-20 s before a swarm so players can set defences; that window is
what makes deployable emitters a decision rather than an afterthought. Calling a
wave early with Q bypasses both the hold and the telegraph.

The prep window is now also shoppable, and that reversal is recorded in 23. The rule this
clause actually protects is "prep must be spent on a DECISION", and a shop that appears on
its own competes with that while a console you walk to becomes one more thing to spend it
on. What would still break 19b is a panel that arrives uninvited during prep.
→ tests 16, 51, 56, 63

**19c. Pacing is adaptive, so "buying time" is not measurable in wall-clock
terms.** Killing enemies faster lowers pressure, which brings the next wave
sooner. Any test of a defensive tool's contribution must take the director out of
the loop (fixed enemy set) or it will measure nothing.
→ test 48

**19d. The telegraph has to actually say something, so waves must arrive from
genuinely different bearings.** All three labels must occur and none may dominate.
This is in tension with arrival time: a wave committed near abeam gets walked past
by the fortress and spends the rest of the wave in a stern chase — measured at
23.2 s median to engage at 72° off the bow, against 7.1 s dead ahead, which a
playtester experienced as waiting around for enemies. `forwardArc` is the balance
point between those two failures, currently 0.9 rad. The label threshold is
derived from the arc rather than fixed, so the two cannot drift apart.

Slowing the hull was the alternative and is strictly worse: a 29% cut only reaches
13.3 s, and hull speed already scales 4.5/3.4/2.3/1.1 with legs lost, so lowering
the base compresses the range that tells the player how damaged the fortress is.
→ test 59

**19e. New enemy types SUBSTITUTE within the wave count, they do not add to it.**
The size curve was tuned against measured pacing, and changing size and composition
together moves two variables at once — after which no difficulty change can be
attributed to either. Road modifiers are the one thing allowed to change the count,
and they say so explicitly.

**19f. The journey escalates in KIND, and the size curve rewinds at every landmark.**
Same principle, applied across landmarks rather than within a siege, and it was added
because the opposite was shipping: `resetSiege()` rewinds the wave counter, composition
was keyed off it, and so a landmark's first wave was always seven chewers and three
climbers. You fought thirty enemies with two bulwarks and a sapper, chose a road, and
the next fight was structurally SIMPLER than the one you had survived. A playtester read
that exactly as it was — "when I press one, does it matter? it seems like it just went
next."

Composition now runs on a tier that carries across landmarks; size still comes from the
per-siege wave number. Measured: landmark 1 is byte-identical to before, sizes are
10/15/20/25/30 at every leg, and landmark 2 opens with the roster it took three waves to
earn the first time.

Two guards, both found by measuring rather than reasoning. **Chewers are a reserved
floor** (40%), not the remainder, or the ramps squeeze them to zero at higher tiers and a
wave with nothing under the hull deletes half the pillar silently. And **one of every
due type is allocated before any type gets a second**, because a single priority pass let
the bulwark ramp take the room and the sapper — the only enemy that is a timer rather
than a damage race — disappeared entirely. The boss wave is the explicit exception to the
floor: `bossWaveScale` truncates a shuffled escort on purpose, and a thinner arena is the
point of the one fight the deck wins.
→ test 81

**20. Enemies must never teleport.** Worst legitimate frame-to-frame movement is
about one stride. A climber used to snap up to 1.6 m sideways when it latched onto
a climb route, which read to a playtester as enemies materialising out of nowhere.
The lesson recurred with the foot shove: as a 0.9 m instant displacement it
measured 0.73 m in a single frame. **Anything that repositions a body must do it
through velocity and let the integrator carry it.**
→ tests 52, 72

**21. The simulation is reproducible, including across a restart.** Every
stochastic choice draws from a seeded stream, never `Math.random`, and every seed
lives in `config.js`: spawn bearing, spawn radius, leg choice, climb-route choice
and the shove's degenerate direction (`CFG.enemies.seed`), wave bearing and the
composition shuffle (`CFG.waves.seed`), road offers (`CFG.run.seed`), the shop's
stock and the salvage pick (`CFG.economy.seed`), item proc chances
(`CFG.items.seed`), weapon cone spread (`CFG.combat.weapon.seed`), rock and ruin
scatter and the horizon (`CFG.world.seed`), fortress greebling and the viewmodel's
detail (local seeds).

Restarting has to rewind six things or the seeds buy nothing: `horde.clear()`
re-seeds, `director.reset()` re-seeds, `run.reset()` re-seeds and returns to the
first landmark, `economy.reset()` reverts every upgrade, strips every hardpoint and
re-rolls the shop from a re-seeded stream, `items.reset()` re-seeds the proc stream
and clears every timed buff, and `trampler.resetPose()` puts the fortress back on
its start heading — spawn bearings are computed from that heading, so a restart
mid-patrol is measurably a different fight from the same seed.

A proc chance is exactly the kind of thing that looks harmless on `Math.random` and
is not: two attempts at the same seeded wave would diverge on whether an arc fired,
which is the one property the seeds exist to protect.

Two full runs of the suite differ **only** in the wall-clock perf reading.

Never reintroduce unseeded randomness into a simulation module. Note that
searching for it is easy to get wrong: four of the five original cases hid behind
grep patterns that silently matched nothing.
→ tests 57, 79, 81, 82, 95, 96

## Presentation

**27. On-screen panels accumulate, and the default has to be hidden.** Exactly one
panel is visible while playing. Everything else is behind a key, and test 67
enforces it by reading `index.html` as text: every id `hud.js` reaches for must
exist, no two always-visible panels may share a screen anchor, at most two may be
up while playing, and any panel that is not always up must be referenced from
`hud.js` or it is dead markup.

Two things follow from this, and the item pool tested both. **A readout the player
acts on between waves belongs on the panel that is already up then** — what you are
carrying is a footer on the refit list, not a panel of its own, and there is no new
key for it. **A readout about the current second is transient, not a panel** — the
live conditional bonus is up only while a condition is actually being met, like the
prompt and the telegraph, and so it never joins the count. The temptation both times
was one more always-on box.

**27b. A PERMANENT READOUT OWNS ITS SCREEN ZONE OUTRIGHT.** Nothing transient may share
an anchor with something always visible, because a thing that comes and goes draws on
top of the thing that is always there.

This is 27's blind spot, and it shipped for two updates behind two green checks. The
vitals panel, the contextual prompt, the salvage pick and the road choice were *all*
anchored bottom-centre. The anchor check only compared always-visible panels to each
other, so three of the four were out of scope; and the prompt is not a `.panel` at all,
so it was invisible to the test twice over. The health and reactor bars — the two numbers
the whole run hangs on — were therefore covered at precisely the moments they matter:
while repairing under fire, while choosing an item, while choosing a road. Reported in
those words: "it covers the health and the other stats".

The fix moved the *permanent* thing, not the transient ones, and the reason generalises:
a permanent readout can be placed once and learned, while a prompt has to appear where
the player is already looking. Vitals went to the empty bottom-left corner — the FPS
convention, in the lower visual field — and bottom-centre is now transient-only.

Asserted by **screen zone** rather than by pixel rectangles, and that limit is
deliberate. Heights here are content-driven and the harness has no DOM, so a rectangle
test would need heights invented inside the test: a number that agrees with the layout
the day it is written and then silently stops agreeing. A zone comes straight out of the
CSS and cannot drift from what the browser does. The set of boxes is **derived**, not
listed — every `.panel`, plus anything `position: fixed` that the HUD writes into — since
a hard-coded list is exactly how the prompt escaped in the first place.

The move also paid for a trim, and the test for each row was "is this shown anywhere
else, and does the player act on it". The deck-gun heat bar went because the prompt's
progress bar already *is* `1 - gun.heat` while a gun is manned; the hardpoints count went
because the bay draws its own sockets. Both purses were **added**, because they lived
only on the shop panel — which is up for about a third of a siege, so for the rest of it
the player was earning money they could not see. The owner asked whether scrap still
existed. It did.

**AND THE CONSEQUENCE THAT COSTS SOMETHING: THE RETICLE IS NOT AVAILABLE.** This needs
recording because the idea it rules out is a *good* one that will be had again.

The comment on `#combat` defends bottom-left partly as "the FPS convention". That half of
the defence does not hold up. The convention is habituation rather than optimisation, and
the measured version of the argument is Dreadnought's: they put ship health and energy at
bottom-centre, were told by their own team it belonged in the lower corners like a
shooter, tried it, found it *worse*, and ended up flanking the crosshair with two arcs for
a better-than-fourfold improvement in index of difficulty — after which they could make
the elements smaller. The honest reading of 27b's own history is that bottom-left was
chosen by **elimination**, because every other corner was taken, and then rationalised.

So "move the vitals next to the crosshair" is live, correct-sounding, and now closed off —
not by taste, but because the reticle became the most transient-dense zone on screen while
27b was being obeyed. `centre-middle` holds the target readout 26 px below the crosshair
and the income tick 52 px above it, and both of them belong there: one names what you are
aiming at, the other says what a kill just paid. A permanent gauge among them is 27b's own
failure with the roles swapped, and test 67 says so outright — a permanent box at
`left: 50%; top: 50%` reports as covered by both.

Note that the zone model cannot tell "beside the reticle" from "under it", and that is the
same deliberate limit recorded above rather than a second one. The two really would not
overlap at ±70 px horizontally. But they would not overlap *only because of vertical
separation the test cannot see*, between boxes whose heights are content-driven — which is
exactly the drift a rectangle test was rejected for inviting.

**What was done instead is the other half of Dreadnought's own equation.** Their model is
distance OVER signal strength, so the two trade: raising the signal at a fixed distance
buys what moving closer buys. See 27c.
→ test 67

**27c. A PERMANENT READOUT HAS TO SURVIVE BEING SEEN OUT OF THE CORNER OF THE EYE.**
27b decided where the vitals panel goes. This is about what it may carry once it is there,
and it is the clause that made 27b's corner good enough to keep.

Peripheral vision resolves brightness, hue and motion. It does not resolve fine detail,
and it does not resolve text at all — letters crowd each other, so a string outside the
couple of degrees you are actually looking at is not "hard to read", it is unreadable.
Four rules fall out, and every one of them was being broken:

- **A gauge states its BAND, not only its length.** Health and the reactor were green
  gradients scaled on x, so the entire reading was a bar being somewhat shorter, and
  length is the single property the periphery judges worst. At a glance a green bar at 20%
  and one at 60% are the same object. They now carry amber and red bands from
  `CFG.hud.hurtBelow` / `criticalBelow`, and the reactor's amber point is *the same knob*
  that fires the full-frame alarm, so the bar and the alarm cannot come to disagree about
  when the reactor is in trouble. The leg pips had always done this; the two bars the run
  actually hangs on had not, which is the asymmetry that gave it away.
- **A count is a numeral and a place is a marker; neither is a sentence.** `hostiles 9
  (4 under, 0 aboard)` gave three numbers with different jobs identical weight in a form
  none of them could be read in. The total is ambient pressure — the pacing rule already
  says eight enemies loitering at 60 m are not eight chewing the legs. What you act on is
  the other two, and each names one of the two positions the whole game is about. They are
  now a 26 px numeral plus two markers drawn ONLY when non-zero, because a marker
  *appearing* is motion, and `0 aboard` was a reading that cost attention and said
  nothing.
- **A total answers a planning question; an ARRIVAL needs its own signal.** Both purses
  stay on the panel — 27b put them there for a good reason — but a small tabular figure in
  the corner cannot report that something just happened. So income also arrives as a
  transient figure above the reticle, accumulated over `CFG.hud.tickHold` so a burst of
  four kills is one growing number rather than four fighting for the same 20 px. Polled as
  a delta on `economy.earned`, which never decreases within a run: watching the purses
  instead would report a purchase as income running backwards.
- **A readout that can only be acted on in one PLACE belongs on the prompt.** The emitter
  rack's `3 / 3` named a key and a ratio, never said what an emitter was, and was
  actionable only while on foot beneath the hull. It is a contextual prompt now, which
  means the placement rule teaches itself by the prompt appearing as you step under the
  hull — the depression-clamp lesson, applied to a HUD row. The evidence that the old form
  was not working is as direct as it gets: the owner asked what the row meant.

One behaviour was deliberately dropped. The hostiles total no longer turns red above six
under the hull. That was a bare `6` in the presentation layer colouring the TOTAL by a
different number, and an amber `7 UNDER HULL` says it better, in the place the count
lives, from the first hostile rather than the seventh.
→ tests 67, 84

**28. The number keys have exactly one owner per frame.** The refit panel, the refit
bay, a road choice and a pending salvage pick all want 1-6. `routePurchaseInput`
picks one in priority order — **pick, road, bay, panel**, ordered by how stuck the
crew is without it — and hands `null` to the others, so a single press can never buy
a refit *and* take a road. Income is paid whoever owns the keys, because income is
not key-driven.

A rule that matters belongs in a module, not in the frame loop. This one lived in
`main.js`, which the harness cannot import, and was therefore the only piece of
wiring in the project with no test at all. `structure.md` has how that was found.
→ test 86

**30. The HUD and the mixer are executed, not merely parsed.** Between them they
are 850 lines of branching that nothing ran: with no `AudioContext` the mixer's
`start()` bails and every method becomes a no-op, so it would pass a naive smoke
test by doing nothing at all. Both now run against stubs — and the DOM stub is
deliberately faithful, returning an element only for ids that genuinely exist in
`index.html`, because a permissive stub would execute the code while throwing away
the check test 67 exists for.
→ tests 84, 85

**29. Art is optional and its absence must be distinguishable from a fault.**
Delete `assets/` and the game plays identically in flat colours. The diagnostics
panel reports which state it is in, because "no art" and "broken texture path"
otherwise look the same.

**31. Nothing decorative may reach into the play area.** Horizon geometry is placed
by its EXTENT, never by its centre. Placing dune centres outside
`patrolRadius + 90` sounded like clearance and was not: a dune is up to 170 m
across, so one centred at 255 m reached inward to 85 m — a hill inside the 165 m
patrol ring, hiding the enemies behind it, with no collider, so the only way past it
was to walk through it. Asserted from the vertices, not from the arithmetic that
placed them.
→ test 87

**32. The scene has a draw-call budget, and it is the number that matters.** It is
175 against a budget of 220, down from ~1,410 against only 55,698 triangles — a call
count that large beside a triangle count that small is a CPU-bound scene, and
simplifying geometry does nothing for it. Anything static that shares a material
gets merged, `castShadow` is opt-in, and lights are a budget of four. `structure.md`
has the four possible symptoms and the fix for each, under "Render cost".
→ test 88

**33. The brightness chain has four separate dials and they compound.** Sun
intensity, environment intensity, how brightly the sky is *drawn* as opposed to how
much it *lights*, and material metalness. A playtest reported being flash-banged and
turning any single one of them down did not fix it — the decisive one was metalness
forced to 1.0, which with these packed ARM maps meant the whole fortress mirrored a
desert sky. These sets carry a bright blue channel over most of their area, so
trusting the map completely is what did it: a lighting symptom with a material
cause. Bloom must threshold above 1.0 so only genuinely emissive things bloom,
and exposure is live on `-` and `=` because past a point this is an eyes-and-monitor
call rather than a measurable one.
→ test 89
