# Trampler — load-bearing invariants

These are the rules the design rests on. Each has a guarding test in
`verify.mjs`. If you change something and one of these fails, the *change* is
probably wrong, not the test. Read the test before repairing it.

## The pillar depends on these three

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
with no player present at all: 36 s undefended, 56 s with three emitters. The
first version had unlimited shots and held the under-hull area forever, which
would have meant never dismounting again. Any future automation — auto-turrets
especially — has to be checked against this.
→ test 48

**3. The crow's nest stays grapple-only.**
It is the one place with no walkable route. Chained mantles must not reach it.
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
→ test 27

**9. No enemy may be shielded by geometry it is standing inside.** Attackers close
on a target's *surface*, never its centre. Boarders inside the reactor box were
invulnerable because the reactor absorbed every bullet aimed at them.
→ test 26

**10. Shots must be visible.** Tracers are drawn from a muzzle offset, not from
the camera, and widen with range. Impact markers mark where rounds land.
→ tests 31, 44

## Fortress systems

**11. Below three working legs the fortress stops dead**, and cannot move again
until repaired. Drive scales 100/75/50/25/0 as legs are lost.
→ tests 32, 33

**12. Repair points sit where the player can find them** — beside the visible
leg, under the hull, with a lit ground marker — and repair progress is never
lost.
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
repairer, which breaks the division of labour co-op is built on. At 35% (38 hp/s)
contested leg repair roughly matches four chewers: hold a leg while someone else
clears, but do not win alone. Contested reactor repair (21 hp/s) still loses to
three boarders, so the reactor demands clearing either way. The HUD says
CONTESTED rather than refusing, so the player sees the trade.
→ test 53

**13. Only one station can be manned at a time, and manning one pins you.**
Zero drift across the deck while holding sprint and jump.
→ tests 36, 42

## Hygiene

**14. No spawn or teleport point may overlap a collider.** The deck spawn once sat
inside the reactor and every respawn silently shoved the player aside. Asserted as
a general rule, not as one case.
→ test 18

**15. Nothing flagged as aboard may float off the deck footprint.** Checked every
frame of every scenario, not in one test.
→ global invariant in `step()`

**16. No NaN in position or velocity, ever.** Also global.

**17. Death cannot loop.** Respawn grants brief immunity, because boarders may be
standing on the spawn point.
→ test 19

**18. Enemies must never become harmless.** With every leg destroyed, chewers
escalate to boarding rather than idling under a wrecked fortress.
→ test 20

**18b. An attacker that has reached its target rides it.** Chewers latch to a leg
rather than re-chasing it each frame, because the target moves faster than they
do: a leg's attack point is outboard, so the hull's yaw adds tangential speed on
top of its 4.5 m/s — measured at 4.71 m/s mean and **6.33 m/s peak** on the legs
outside a turn, which exceeds even the fastest chewer speed ever configured.
Chasing made leg damage fluctuate with the hull's turn phase, and below ~4.71 m/s
it collapsed to 0.5 hp/s from a nominal 9.9: the fortress walks on untouched and
the reason to fight beneath it disappears. This failed **silently** — nothing
looked wrong, the enemies were simply always slightly behind.

Latching decouples the two jobs: speed decides how fast they arrive, the latch
decides whether they can hold on. Never make an attacker's damage depend on
out-running a point attached to a turning fortress.
→ tests 15, 15b

**19. Waves must never stack onto an unresolved fight.** Pacing follows L4D's
model: REST → PREP → SPAWNING → ENGAGED, gated on measured crew *pressure* rather
than a head count. On a fixed clock, falling behind once was unrecoverable —
measured as 16 hostiles parked under an immobilised hull with more arriving on
schedule. A stopped fortress alone now halts reinforcements outright.
→ tests 16, 50, 54, 55

**19b. Every wave is telegraphed, and a guaranteed rest precedes it.** Deep Rock
Galactic gives 15-20 s before a swarm so players can set defences; that window is
what makes deployable emitters a decision rather than an afterthought. Calling a
wave early with Q bypasses both the hold and the telegraph — getting no prep time
is the price of stacking.
→ tests 16, 51, 56

**19d. The telegraph has to actually say something, so waves must arrive from
genuinely different bearings.** All three labels must occur and none may dominate.
This is in tension with arrival time: a wave committed near abeam gets walked past
by the fortress and spends the rest of the wave in a stern chase — measured at
23.2 s median to engage at 72° off the bow, against 7.1 s dead ahead, which a
playtester experienced as waiting around for enemies. `forwardArc` is the balance
point between those two failures, currently 0.9 rad. Narrow it and the telegraph
degenerates to always DEAD AHEAD; widen it and a third of waves are a stern chase.
The label threshold is derived from the arc rather than fixed, so the two cannot
drift apart.

Slowing the hull was the alternative and is strictly worse: a 29% cut only reaches
13.3 s, and hull speed already scales 4.5/3.4/2.3/1.1 with legs lost, so lowering
the base compresses the range that tells the player how damaged the fortress is.
→ test 59

**19c. Pacing is adaptive, so "buying time" is not measurable in wall-clock
terms.** Killing enemies faster lowers pressure, which brings the next wave
sooner. Any test of a defensive tool's contribution must take the director out of
the loop (fixed enemy set) or it will measure nothing.
→ test 48

**20. Enemies must never teleport.** Worst legitimate frame-to-frame movement is
about one stride. A climber used to snap up to 1.6 m sideways when it latched onto
a climb route, which read to a playtester as enemies materialising out of nowhere.
→ test 52

**21. The simulation is reproducible, including across a restart.** Every
stochastic choice draws from a seeded stream, never `Math.random`, and every seed
lives in `config.js`: spawn bearing, spawn radius, leg choice and climb-route
choice (`CFG.enemies.seed`), wave bearing and the climber interleave
(`CFG.waves.seed`), weapon cone spread (`CFG.combat.weapon.seed`), rock and ruin
scatter (`CFG.world.seed`). Before this, the same code measured 15.2 s and 19.3 s
on consecutive runs of the emitter test, so the assertion guarding invariant 2b
passed or failed at random. Two full runs of the suite now differ **only** in the
wall-clock perf reading.

Restarting has to rewind three things or the seeds buy nothing: `horde.clear()`
re-seeds, `director.reset()` re-seeds, and `trampler.resetPose()` puts the
fortress back on its start heading — spawn bearings are computed from that
heading, so a restart mid-patrol is measurably a different fight from the same
seed. The point of the seeds is comparing two attempts at the same wave.

Never reintroduce unseeded randomness into a simulation module. Note that
searching for it is easy to get wrong: four of the five hid behind grep patterns
that silently matched nothing.
→ test 57
