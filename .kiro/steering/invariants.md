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

**12c. Repair is blocked while hostiles are within 6 m.** A fresh 120 hp leg
survives about three seconds against four chewers, so patching without clearing
first is always a losing trade. It used to be *allowed* but futile, which is a
hidden trap. Blocking it, and saying CLEAR THE AREA, makes the intended order
explicit: kill, then patch.
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

**19. Waves must never stack onto an unresolved fight.** The next wave waits for
the field to thin below a threshold. On a fixed clock, falling behind once was
unrecoverable — measured as 16 hostiles parked under an immobilised hull with more
arriving on schedule. Calling a wave early with Q deliberately bypasses the hold,
so stacking stays a player choice.
→ tests 50, 51

**20. Enemies must never teleport.** Worst legitimate frame-to-frame movement is
about one stride. A climber used to snap up to 1.6 m sideways when it latched onto
a climb route, which read to a playtester as enemies materialising out of nowhere.
→ test 52
