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

Two corollaries added with the new roster. **Armour is never immunity**: damage is
`max(raw - armour, raw * minDamageFraction)`, so a rifle still does 5 to a titan.
A magazine emptied into something with the health bar refusing to move is
indistinguishable from a bug. And **the one type that cannot be shot cannot stay
that way**: a burrower is untouchable only while submerged, on a hard clock, and it
surfaces on that clock wherever it has got to.
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

**22f. Holding a siege pays a free pick of three, and the pick is personal.** Being
handed something is a different beat from buying it, and it is the only acquisition
that does not compete with the fortress for money. Salvage items only — a free hull
plate would be one purse funding the other, which is 22 broken from the reward side.
Taking one clears the rest, because the whole value of a pick is what you gave up.
The boss leg pays nothing: an item you can never spend is a menu, not a reward.
→ tests 79, 96

**23. Buying happens between waves only.** Spending mid-fight would let a player
purchase their way out of trouble and would drain the tension the siege is built
on. It also gives the preparation window a second job.
→ test 63

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
→ tests 16, 50, 54, 55

**19b. Every wave is telegraphed, and a guaranteed rest precedes it.** Deep Rock
Galactic gives 15-20 s before a swarm so players can set defences; that window is
what makes deployable emitters a decision rather than an afterthought. Calling a
wave early with Q bypasses both the hold and the telegraph.
→ tests 16, 51, 56

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
→ test 67

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
