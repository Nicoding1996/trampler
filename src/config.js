// Every feel-relevant number lives here so it can be dialled in one place.
// Units are metres and seconds. Gravity is deliberately far above 9.81 --
// realistic gravity feels floaty in an FPS.

// ---------------------------------------------------------------------------
// Enemy type schema.
//
// EVERY per-type field must exist on EVERY type. This was a written rule for a
// while and it was broken twice anyway: adding `climbTime` to climbers but not
// chewers produces `d < undefined`, which is always false, and silently makes
// that enemy harmless. Nothing looks wrong -- the enemy simply stops mattering.
//
// So the rule is now structural rather than remembered. Types are spread from
// ENEMY_BASE, and `enemyType()` THROWS if an override introduces a key the base
// does not have. That is the exact shape of the bug: a field added to one type
// and nowhere else. You cannot write it any more without the module failing to
// load, which is a much better failure than a harmless enemy.
const ENEMY_BASE = {
  hp: 50,
  speed: 4.5,
  damage: 9,
  attackRate: 1.1,
  radius: 0.5,
  height: 1.6,
  reach: 2.0,

  // Flat damage soak, applied before the floor in CFG.enemies.minDamageFraction.
  // Zero for everything unarmoured, which is most things.
  armour: 0,

  // How far inboard of the centreline this type plants itself to attack a leg.
  // For anything that fits under the hull this must stay inside the 8 m half
  // width, because being in the hull's shadow is what makes it unshootable from
  // the deck. Anything too tall to fit under there wants a value OUTSIDE it.
  inboardOffset: 7.0,

  // Seconds to climb a boarding route. Needed on every type, not just climbers:
  // once every leg is down, anything still alive escalates to boarding.
  climbTime: 3.2,

  // Measured to the reactor's SURFACE, not its centre, or the attacker ends up
  // standing inside the reactor where its own mesh eats every bullet.
  reactorReach: 1.1,

  // "legs" plants under the hull and gnaws; "reactor" boards and goes for the
  // core. These are the two halves of the pillar, and nothing else is valid.
  goal: "legs",

  // Seconds spent travelling underground, where it cannot be hit. Zero means it
  // walks in the open like everything else. Finite by construction: an enemy
  // that could stay under forever would be unkillable, which breaks invariant 8.
  burrowTime: 0,

  // Plants a charge instead of gnawing: `fuse` seconds after latching on it
  // deals `fuseDamage` and dies. Zero disables the whole behaviour.
  fuse: 0,
  fuseDamage: 0,

  // How far a foot coming down shoves this type, as a multiplier. Big things
  // barely notice. No damage is involved -- see the stomp block in CFG.trampler
  // for why the feet deliberately cannot hurt anything.
  shoveScale: 1,

  // Purely visual: multiplier on the drawn body, so a silhouette can read as
  // heavier than its collision box without changing the hit test.
  bulk: 1,

  // Emissive strength on the eyes, so dangerous things glow harder. Visual only.
  glow: 1,
};

const ENEMY_FIELDS = new Set(Object.keys(ENEMY_BASE));

function enemyType(overrides) {
  for (const key of Object.keys(overrides)) {
    if (!ENEMY_FIELDS.has(key)) {
      throw new Error(
        `enemy field "${key}" is not on ENEMY_BASE. Add it there with a default `
        + `first: a field that exists on one type only reads as undefined on all `
        + `the others, and "d < undefined" is always false, which makes those `
        + `enemies silently harmless.`,
      );
    }
  }
  return { ...ENEMY_BASE, ...overrides };
}

export const CFG = {
  player: {
    radius: 0.4,
    height: 1.8,
    eyeHeight: 1.62,

    walkSpeed: 7.0,
    sprintSpeed: 11.0,
    groundAccel: 70,
    airAccel: 24,
    groundFriction: 11,

    // Deliberately zero. Air drag is applied in world space, but a player who
    // jumps off a moving deck has world velocity that includes the hull's --
    // damping it would drag them toward the stern mid-jump. No drag means a
    // straight-up jump lands you exactly where you took off from, which is what
    // anyone standing on a moving platform expects.
    airDrag: 0,

    jumpSpeed: 9.6,
    gravity: 28,
    maxFallSpeed: 70,

    coyoteTime: 0.12,   // grace period to still jump after leaving a ledge
    jumpBuffer: 0.12,   // grace period to queue a jump before landing

    // Mantling. Jump reach is 9.6^2 / (2 * 28) = 1.65 m, which left the 2.0 m
    // crate, the 2.4 m reactor and the 2.6 m engine block unreachable. This
    // closes that gap, and doubles as the recovery when a grapple leaves you
    // hanging on bare hull plating with nothing underfoot.
    //
    // Deliberately NOT gated on rise height, but on being airborne and unable
    // to jump. That is what makes it work both as "jump at a crate and climb
    // it" and as "save me, I am falling down the side of the hull".
    mantle: {
      // Low, on purpose. A higher threshold leaves a dead band: the 2.0 m crate
      // sits 0.35 m above a jump apex, too high to land on but too low to grab.
      // Being grabby is not a risk here because the trigger already requires
      // being airborne, near apex, and looking at the ledge.
      minRise: 0.25,
      maxRise: 1.7,        // low enough that the deck is still grapple-only
      reach: 1.1,
      duration: 0.32,
      maxUpVelocity: 1.5,  // near apex or descending: a save, not a snatch
      cooldown: 0.25,
      facing: 0.35,        // must be looking roughly at the ledge
      insetSteps: [0, 0.7, 1.4, 2.1], // walk inboard past railings and lips

      // Looking at a ledge is not enough intent to grab it. Walking backwards
      // off the deck means facing the thing you just left, so a look-only test
      // yanks you straight back aboard and you can never drop off on purpose.
      // Reject any ledge the player is actively moving away from.
      minApproachDot: -0.1,
      stillSpeed: 0.6,     // below this, treat as stationary and allow the grab
    },

    lookSensitivity: 0.0022,
    pitchLimit: 1.5,    // radians from horizontal

    // Camera roll/step feedback. Keep subtle; this is a comfort knob.
    landDip: 0.16,
    landDipRecover: 7.0,
  },

  grapple: {
    maxRange: 55,
    reelSpeed: 34,

    // Extra upward push while reeling, so you arc over a railing instead of
    // slamming into the hull below it. Scales down as you close in.
    arcBoost: 9.0,

    // A constant-speed winch arrives at 34 m/s and flings you clean over the
    // deck and off the far side -- verified, not theoretical. So the reel brakes
    // as it closes: full speed beyond brakeDistance, tapering to minSpeedFactor
    // on arrival. Boarding only works if you arrive slow enough to land.
    brakeDistance: 9,
    minSpeedFactor: 0.30,

    releaseDistance: 1.6,   // auto-detach once this close to the anchor

    // The two ways a rope ends want opposite things, so they get separate
    // numbers. ARRIVING is a precision job -- you are landing on a deck that is
    // translating and turning, and overshooting puts you off the far side. The
    // brake above already buys that precision, so retention here can be high.
    // CUTTING early is a mobility job with no target, so it keeps everything.
    //
    // Because the reel brakes as it closes, cutting early keeps full reel speed
    // while cutting late keeps very little. The skill gradient falls out of a
    // system that already exists.
    arriveMomentum: 0.85,
    arriveLift: 2.5,        // small upward kick to clear the deck lip
    cutMomentum: 1.0,
    cutLift: 0,

    maxTime: 4.0,           // safety valve so you can never be stuck reeling
    cooldown: 0.3,

    // Design question this test exists to answer: should players be able to
    // grapple any surface, or only authored hardpoints? Toggle live with G.
    hardpointsOnly: false,
  },

  // Release-feel presets, cycled live with M. The point is to judge these with
  // hands on the controls rather than by argument. "braked" is the recommended
  // starting point; "dead stop" and "halo" bracket it on either side.
  releasePresets: [
    { name: "dead stop", arriveMomentum: 0, arriveLift: 0, cutMomentum: 0, cutLift: 0 },
    { name: "braked", arriveMomentum: 0.85, arriveLift: 2.5, cutMomentum: 1.0, cutLift: 0 },
    { name: "halo", arriveMomentum: 1.0, arriveLift: 2.5, cutMomentum: 1.35, cutLift: 1.5 },
  ],
  releasePreset: 1,


  trampler: {
    speed: 4.5,             // m/s -- slow and stompy
    turnRate: 0.22,         // rad/s (~12.6 deg/s)
    deckHeight: 7.5,        // world Y of the deck surface

    // Spatial damage, FTL-style: no single health bar. Each leg is its own
    // system, and losing one slows the hull. The reactor is the run.
    legHp: 120,
    reactorHp: 420,

    // A hexapod walks on an alternating tripod, so it needs at least three
    // working legs to move at all. Below that it is immobilised outright rather
    // than crawling: a hard stop is a far more legible failure state than a
    // vague slow-down, and it turns repair into a forced objective.
    //
    // Speed scales as (working - 2) / 4, so: 6 legs 100%, 5 -> 75%, 4 -> 50%,
    // 3 -> 25%, 2 or fewer -> stopped.
    legsForWalking: 3,

    // Deck pitch/roll is intentionally absent. Only translation + yaw.
    // Vertical bob is optional so we can find out whether it wrecks comfort.
    bob: false,
    bobAmount: 0.18,
    bobSpeed: 1.55,

    legCount: 6,
    gaitSpeed: 0.85,

    // How many boarders can be in contact with the reactor at once.
    //
    // This is the fix for the next wall the numbers already predicted. Reactor
    // time-to-death, if every climber in a wave reached it, was:
    //
    //   wave 1  3 climbers   45 dps   9.3 s
    //   wave 2  5 climbers   75 dps   5.6 s
    //   wave 3  6 climbers   90 dps   4.7 s
    //   wave 4  8 climbers  120 dps   3.5 s
    //
    // 3.5 seconds is less than the time to notice, grapple up, turn and engage,
    // which makes wave 4 a reaction-time wall rather than a decision. Three
    // candidate fixes were on the table -- cap the attackers, flatten
    // climberShare, or add a countdown -- and they were deliberately NOT tried
    // together, because three simultaneous changes to one number cannot be
    // attributed afterwards. This is the cap, and the harness measures it.
    //
    // Three slots holds reactor dps at 45 no matter how big the wave is, so the
    // reactor always takes the same 9.3 seconds to die. The trip up stops being a
    // reflex test and goes back to being a decision about when to leave.
    //
    // The queued boarders do not vanish: they stand around the core waiting for a
    // slot, which is both readable and still dangerous, because they are between
    // you and the thing you came up to save.
    reactorSlots: 3,

    // ------------------------------------------------------------------- stomp
    //
    // The feet carry damage. Pitched early as the thing that makes the under-hull
    // arena feel dangerous rather than merely dark, since the legs previously had
    // no collision at all and swept harmlessly through everything.
    //
    // The critical geometry: a foot sits at local x of about +/-9.9, which is
    // OUTBOARD of the 8 m hull half width, while chewers latch at +/-7.0. So a
    // stomp physically cannot clear the enemies that are actually eating the
    // legs. That is not a lucky accident, it is the reason this is safe to add at
    // all -- invariant 2b says automation must never hold a position unattended,
    // and a fortress that killed its own attackers by walking would be exactly
    // that, with nothing looking broken.
    //
    // What it does hit is things crossing under the feet on their way in, and
    // the player, who has no business standing under a descending leg.
    // THE FEET DEAL NO DAMAGE TO ENEMIES. This was measured, not assumed, and it
    // is the most important comment in this block.
    //
    // The first version dealt 30 -- below a chewer's 50 hp, so it could not kill
    // anything on its own, which seemed like enough of a safeguard. It was not.
    // Undefended time-to-crippled went 67.7 s -> 81.0 s, and the fixed-force
    // emitter measurement in test 48 went from 25.1 s to hitting its 45 s ceiling:
    // emitters plus feet held fourteen chewers off the legs for the entire
    // measurement window with no player present. Neither system did that alone.
    //
    // That is invariant 2b failing in exactly the way it warns about -- silently.
    // Nothing looked broken. The fortress simply defended itself, and the reason
    // to go down there quietly evaporated.
    //
    // It is also the reason an automated deck turret is still on the shelf:
    // emitters already occupy the automation slot, and a second automated damage
    // source makes it impossible to attribute a fight to either. A damaging foot
    // IS a second automated source, wearing a different hat.
    //
    // So the feature keeps the job it was actually raised for. The complaint was
    // that legs "pass harmlessly through everything" and that the under-hull arena
    // was dark but not dangerous -- dangerous TO THE PLAYER. A foot now hurts you
    // and shoves bodies out of the way, and settles nothing.
    stomp: {
      // 2.0, and the margin is deliberate. A foot sits at local x 9.9 and a
      // latched chewer at 7.0 at the same z, so the gap is 2.9 m. This keeps 0.9 m
      // of clearance, and test 72 asserts it rather than trusting it -- the shove
      // must not be able to break an attacker off a leg either, because that would
      // be the same automation problem with the damage removed.
      radius: 2.0,

      playerDamage: 34,   // heavy, not lethal from full: a lesson, not a death

      // The shove is an IMPULSE IN METRES PER SECOND, not a displacement.
      //
      // The first version moved bodies 0.9 m instantly and test 52 caught it at
      // once: 0.73 m in a single frame, against a worst legitimate stride of
      // about 0.15 m. That is a teleport, and invariant 20 exists because a
      // playtester described exactly this as enemies materialising out of nowhere.
      // The lesson keeps recurring in this codebase -- anything that repositions a
      // body has to do it through velocity and let the integrator carry it.
      //
      // 4.5 m/s decaying at `shoveDecay` displaces roughly half a metre over a
      // quarter of a second, which reads as being knocked aside.
      shoveSpeed: 4.5,
      shoveDecay: 9.0,
    },
  },

  // ---------------------------------------------------------------------------
  // Fortress modules: the bounded build layer, and the game's identity rather
  // than a feature.
  //
  // Three sockets, six modules, installs are permanent for the run. That is the
  // "bounded structure, unbounded stacking" principle made physical: personal
  // upgrades stack without limit on salvage, while the fortress has a fixed
  // number of places to bolt things, so a run has a readable silhouette instead
  // of growing without limit.
  //
  // Permanence is the point. A build you can rearrange between waves is not a
  // commitment, and without commitment the choice of what to fit is not a
  // decision -- it is a preference you can revisit for free.
  //
  // Note what is NOT here: an automated gun. Shock emitters already occupy the
  // automation slot, and a second automated damage source makes it impossible to
  // tell which one is carrying the fight. Every module below either buys time,
  // buys legibility, or buffs something a player has to be present to use.
  // Invariant 2b is the rule that kept the list honest.
  fortress: {
    sockets: 3,
    keys: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"],
    toggleKey: "Tab",

    catalogue: [
      {
        id: "floodlights",
        name: "FLOODLIGHTS",
        detail: "lights the under-hull arena, exposes burrowers early",
        cost: 55,
      },
      {
        id: "emitterRack",
        name: "EMITTER RACK",
        detail: "+2 emitters, +2 charge each",
        cost: 90,
      },
      {
        id: "ammoHoist",
        name: "AMMO HOIST",
        detail: "deck guns: 40% less heat, 50% faster cooling",
        cost: 75,
      },
      {
        id: "baffles",
        name: "BOARDING BAFFLES",
        detail: "climbs take 50% longer",
        cost: 70,
      },
      {
        id: "actuators",
        name: "STRIDE ACTUATORS",
        detail: "+18% hull speed, +40% turn rate",
        cost: 80,
      },
      {
        id: "casing",
        name: "REACTOR CASING",
        detail: "+40% reactor integrity, one fewer boarder can reach it",
        cost: 95,
      },
    ],

    // Module effect sizes live here rather than inline in the effect closures, so
    // a number can be found next to the comment explaining it. The closures
    // themselves are in src/modules.js, because behaviour is not data.
    floodlightReveal: 0.6,   // burrowers surface at 60% of their burrow time
    emitterSlots: 2,
    emitterCharge: 2,
    heatScale: 0.6,
    coolScale: 1.5,
    climbScale: 1.5,
    driveScale: 1.18,
    turnScale: 1.4,
    reactorScale: 1.4,
    slotBonus: -1,
  },

  world: {
    // Rock and ruin scatter. Kept at its original value so the terrain players
    // have been testing against does not move.
    seed: 20260725,

    fogColor: 0xc7b299,
    fogNear: 70,
    fogFar: 460,
    groundColor: 0xb99f78,
    patrolRadius: 165,

    // Sky orientation and how hard the environment map lights the scene.
    //
    // The rotation exists to line the HDRI's bright quarter up with the direction
    // our own sun light comes from. Get this wrong and shadows fall one way while
    // the sky glows the other -- which everyone can see is wrong and almost nobody
    // can name, so it just reads as "cheap".
    skyRotation: 2.35,

    // Both down hard from 0.85. `envIntensity` is how much the sky LIGHTS the
    // scene; `skyIntensity` is how bright the sky is DRAWN. They were one value at
    // 0.85 and no dimming respectively, which put a blown-out white wall behind
    // every silhouette in the game.
    //
    // Keeping them separate matters: the environment is what gives metal its
    // specular response and wants to stay meaningful, while the sky is just a
    // backdrop and can be pushed right down without costing anything.
    envIntensity: 0.32,
    skyIntensity: 0.42,

    // Light intensities. three.js has used physically-correct units since r155, so
    // a directional light at 3.1 is glaring rather than sunny. The measured sum of
    // every light in the scene was 93; it is now a fraction of that.
    sunIntensity: 1.35,
    hemiIntensity: 0.4,
    bounceIntensity: 0.28,

    // Distant terrain. All of it lives OUTSIDE the patrol ring, and none of it has
    // a collider.
    //
    // That is not laziness, it is the only safe way to add relief here: ground
    // collision is a single box with its top face at y=0, and `probeGround` reads
    // box tops. Displacing the visible ground into dunes inside the play area
    // would put the art and the collision in different places, and the player
    // would sink into or float above every slope. The fight happens on a dry lake
    // bed, which is flat for a reason -- so the scenery is a horizon, not terrain.
    //
    // THE CLEARANCE IS MEASURED FROM THE EXTENT, NOT THE CENTRE, and that was the
    // bug a playtest hit. Dune centres were placed outside patrolRadius + 90, but a
    // dune is up to 170 m across, so one centred at 255 m reached inward to 85 m --
    // well inside the 165 m patrol ring. The result was a hill sitting in the
    // arena, hiding enemies, with no collider, so the only way past it was to walk
    // through it.
    //
    // 90 m of clear sand beyond the ring, guaranteed against the widest part of
    // whatever is placed. Test 87 asserts it.
    horizonClearance: 90,
    duneCount: 130,
    mesaCount: 26,
    debrisCount: 260,   // small parallax detail on the pan itself
  },

  combat: {
    playerHp: 100,
    regenDelay: 4.0,
    regenRate: 14,

    // Brief immunity after dying. Respawn drops you on the deck, and if boarders
    // happen to be standing there you would be killed again on the same frame,
    // over and over. Applies to death only, not the debug respawn key.
    spawnGrace: 1.2,

    weapon: {
      damage: 25,
      fireRate: 8,      // shots per second
      spread: 0.007,    // radians of cone
      seed: 4242,       // cone spread draws from this, never Math.random
      range: 220,

      // Enemies are hit as BOXES matching what is drawn, not as spheres. A
      // sphere disagrees with the rendered silhouette, so the crosshair could
      // sit visibly on an enemy and still miss. The pad is deliberate aim
      // assist: a chewer is only 1.6 m tall, so at melee range a level shot
      // passes just over its head, which felt like the gun was broken.
      hitPad: 0.18,

      // Tracers are drawn from a MUZZLE offset, not from the eye. A beam that
      // starts at the camera runs straight down the view axis and projects to a
      // dot behind the crosshair -- invisible. Offsetting it makes the beam
      // converge across the view, which is what reads as a shot.
      //
      // Thickness also has to grow with distance: a 2 cm beam is under a pixel
      // wide past ~40 m, so distant shots simply vanished.
      tracerLife: 0.07,
      tracerRadius: 0.045,
      tracerWiden: 0.0013,   // extra radius per metre of travel

      // Impact markers. The first pass was far too aggressive: 0.15 base radius
      // growing 0.022 per metre put a half-metre ball on the ground at 30 m, and
      // an 8x6 sphere at that size reads as a white hexagon rather than dust.
      // Now small, rounder, and much subtler for terrain than for flesh.
      impactLife: 0.09,
      impactSize: 0.09,
      impactGrow: 0.013,
      impactSolidScale: 0.6,   // dirt puffs stay quiet; hits on enemies pop

      hitFlash: 0.12,   // hitmarker + enemy flash duration
    },
  },

  enemies: {
    max: 420,

    // Spawn bearings, spawn radius, leg choice and climb-route choice all draw
    // from one seeded stream per Horde rather than Math.random. A fixed seed
    // means a scenario replays identically, which the harness needs: with random
    // arcs, the same emitter test measured 15.2 s and 19.3 s on back-to-back
    // runs. Change this number to get a different but still reproducible fight.
    seed: 20260725,

    // Chewers attack the legs from INBOARD, under the hull slab. That is not
    // decoration: the deck physically blocks line of sight to anything directly
    // beneath it, so they cannot be answered from up top. This is the forcing
    // function that makes players dismount at all.
    // Speed is a HUMAN-facing knob, not a difficulty knob. Measured with an
    // oracle defender that teleports and never misses: dropping enemy speed 16%
    // changed its survival by one second out of 227, because it never had to
    // travel. Everything speed buys goes to a real player's travel and reaction
    // time, which is what actually decides these fights. So it was settled in
    // play, with the , and . keys, not by argument -- 0.87x of the previous
    // 5.4/5.2 was the chosen feel.
    //
    // 4.70 gives a walking player (7.0) 2.3 m/s of room to back off while
    // shooting, against 0.8 originally.
    //
    // Speed used to be secretly coupled to the hull's turn rate and leg geometry:
    // a chewer chased a leg attack point that moves at 4.71 m/s mean and 6.33 peak
    // on the legs outside a turn, so at 4.70 it fell behind forever and dealt
    // 0.5 hp/s instead of 9.9. Chewers now LATCH to a leg once in reach and are
    // carried by the hull, so this number only decides how fast they ARRIVE and
    // can be tuned freely. See the latch in enemies.js and test 15b.
    chewer: enemyType({
      hp: 50, speed: 4.7, damage: 9, attackRate: 1.1,
      radius: 0.5, height: 1.6, reach: 2.0,

      // How far inboard of centre they plant themselves. This doubles as the
      // leg's repair point, so it has to sit NEXT TO the leg you can see -- at
      // 5.9 it was four metres inboard of the visible foot, so walking up to a
      // damaged leg offered no repair prompt at all. 7.0 is beside the leg hip
      // and still under the 8 m hull slab, which is what keeps it unshootable
      // from the deck.
      inboardOffset: 7.0,
      // Used only when every leg is already down and they escalate to boarding.
      // They are not built for it, so they are slower up the hull than climbers.
      climbTime: 3.2,
      // Needed for the same reason: once escalated they attack the reactor, and
      // a missing value here silently makes them harmless (d < undefined).
      reactorReach: 1.1,
    }),

    // Climbers board via authored attach points and go for the reactor, which
    // is the opposite pressure: staying on the ground too long costs you.
    climber: enemyType({
      // 4.52 sits 0.02 m/s above the hull's 4.5, which is a rounding error rather
      // than a margin -- so this was measured before being trusted. Boarding is
      // unharmed: 8 of 8 climbers still get aboard a hull walking at full speed,
      // arriving 0.7 s later than at 5.2, and the reactor is still destroyed.
      //
      // Two reasons the near-zero margin does not matter. Waves spawn in the
      // FORWARD arc, so the approach is head-on at a ~9 m/s closing speed, and the
      // fortress walks a patrol CIRCLE, so it is always turning and a trailing
      // enemy cuts the corner. Raw speed comparison against the hull overstates
      // the danger badly -- even 4.40 still boards.
      //
      // What it does cost is the stern chase: closing a 30 m gap from behind went
      // from 24 s to 81 s. A healthy fortress now sheds anything it gets past.
      // If climbers ever stop reaching the deck, this is the first number to
      // suspect, because losing boarders removes the reason to go back up and
      // takes half the pillar with it. Guarded by tests 14 and 26.
      hp: 80, speed: 4.52, damage: 15, attackRate: 1.0,
      radius: 0.55, height: 1.9, reach: 2.4,
      climbTime: 2.2,

      // Measured to the reactor's SURFACE, not its centre. Reach 2.4 from the
      // centre of a 5 x 2.4 x 4 box puts boarders inside it, where the reactor's
      // own mesh absorbs every bullet aimed at them -- they became unkillable.
      reactorReach: 1.2,
      goal: "reactor",
      glow: 1.4,
    }),

    // ----------------------------------------------------------------- bulwark
    //
    // The armoured one, and the reason the deck gun has a job after the opening
    // seconds of a wave.
    //
    // The gun was previously an OPENING MOVE ONLY: the approach window is about
    // 12 seconds against 28-second waves, so it was a small slice of playtime by
    // construction. The rejected fix was pushing spawns out to lengthen the
    // approach, which is the same quantity a player on foot experiences as
    // waiting around for enemies -- measured at 23.2 s to engage on a bad
    // bearing, and the thing we had just finished removing.
    //
    // An armoured enemy buys the gun a recurring job without lengthening
    // anything for anybody. Armour 20 against a 25-damage rifle leaves 5 per
    // shot -- 40 dps, so 300 hp takes seven and a half seconds of unbroken fire
    // while it eats a leg at 17.6 hp/s and walks into your face. The same armour
    // against the gun's 45 leaves 25 -- one heat burst kills two of them.
    //
    // It is deliberately SLOWER than the hull (2.9 against 4.5), so a healthy
    // fortress that dealt with it during the approach never sees it again, and
    // one that ignored it meets it on the next lap of the patrol circle.
    bulwark: enemyType({
      hp: 300, speed: 2.9, damage: 22, attackRate: 0.8,
      radius: 0.85, height: 2.4, reach: 2.4,
      armour: 20,
      climbTime: 5.0,
      reactorReach: 1.5,
      shoveScale: 0.5,
      bulk: 1.15,
      glow: 1.8,
    }),

    // ---------------------------------------------------------------- burrower
    //
    // Ignores pathing entirely: it travels underground, where it cannot be shot,
    // and surfaces under the hull.
    //
    // This is the counter to camping a gun. Every other ground threat has an
    // approach you can shoot at, so a player parked at the bow can farm the
    // horde and only lose to the boarders behind them. A burrower's approach is
    // simply not there to shoot, so the under-hull area gets refreshed with
    // things that were never on the surface.
    //
    // burrowTime is finite on purpose and asserted in the harness. An enemy that
    // could stay submerged indefinitely would be unkillable, which breaks
    // invariant 8 -- "everything the player can see, the player can shoot" only
    // means anything if everything eventually becomes visible.
    burrower: enemyType({
      hp: 40, speed: 5.6, damage: 7, attackRate: 1.3,
      radius: 0.45, height: 1.2, reach: 2.0,
      burrowTime: 4.5,
      climbTime: 3.4,
      bulk: 0.9,
      glow: 0.6,
    }),

    // ------------------------------------------------------------------ sapper
    //
    // Does no contact damage at all. It latches onto a leg, lights a fuse, and
    // six seconds later takes the whole leg off in one hit and dies.
    //
    // Zero damage is the design, not an oversight. Every other enemy is a damage
    // race you can lose slowly; this one is a TIMER, and the only answer is to
    // stop it. It also cannot be ignored the way a chewer can be traded against,
    // because 120 hp is exactly a leg. So it converts "I should probably go down
    // there at some point" into "I have six seconds", which is the thing the
    // under-hull arena was missing.
    sapper: enemyType({
      hp: 70, speed: 4.9, damage: 0, attackRate: 1.0,
      radius: 0.5, height: 1.7, reach: 2.0,
      fuse: 6.0,
      fuseDamage: 120,
      bulk: 0.95,
      glow: 2.2,
    }),

    // ------------------------------------------------------------------- titan
    //
    // The biome boss, and it inverts the pillar for one fight.
    //
    // It is 5.2 m tall against 4.5 m of hull clearance, so it physically CANNOT
    // get underneath. That is the whole design: it has to attack the legs from
    // outboard, which puts it in the open where both deck guns can reach it. The
    // one fight in the game where the right place to be is up top, arrived at
    // through geometry rather than through a rule.
    //
    // inboardOffset is therefore 11, outside the 8 m half width, unlike every
    // other type.
    //
    // Armour 30 against a 25-damage rifle is the floor -- 5 a shot, 2600 hp,
    // eighty seconds of continuous fire. Against the gun's 45 it is 15 a shot.
    // A player who spent the run on rifle stacks feels that; a player who spent
    // it on the fortress feels the legs holding. It is the exam for whichever
    // power curve you actually built.
    titan: enemyType({
      hp: 2600, speed: 2.2, damage: 45, attackRate: 0.7,
      radius: 1.9, height: 5.2, reach: 3.6,
      armour: 30,
      inboardOffset: 11.0,
      climbTime: 9.0,
      reactorReach: 2.2,
      // A foot glances off something this big. It is also the only enemy tall
      // enough that a leg coming down meets its shoulder rather than its back.
      shoveScale: 0.08,
      bulk: 1.0,
      glow: 3.0,
    }),

    // Nothing is ever fully immune. Armour subtracts flat damage, and this is the
    // fraction of the raw hit that always gets through regardless -- so a rifle
    // against the titan's 30 armour still does 5 rather than nothing.
    //
    // A hard zero would be an invisible wall: the player would empty a magazine
    // into something, see hit flashes, and watch the health bar not move, with no
    // way to tell that from a bug. 20% is slow enough to say "wrong tool" and
    // fast enough to prove the gun works.
    minDamageFraction: 0.2,

    // Which types appear in a wave, and from when.
    //
    // Specials SUBSTITUTE for chewers rather than adding to the wave count. The
    // count curve was tuned against measured pacing, and adding on top of it
    // would silently change wave size as well as wave composition -- two
    // variables moving at once, which is how you end up unable to attribute a
    // difficulty change to either.
    //
    // Waves one and two are chewers and climbers only. Those are the two
    // pressures the entire design rests on, and they deserve to be learned
    // without noise.
    composition: {
      burrowerFromWave: 2,
      burrowerShare: 0.15,
      bulwarkFromWave: 3,
      sapperFromWave: 4,
      // Bulwarks and sappers grow every other wave rather than every wave, and
      // are capped. They are expensive to answer, so a linear ramp on both at
      // once outruns the player's ability to be in two places long before the
      // health ramp does.
      bulwarkEvery: 2,
      bulwarkMax: 3,
      sapperEvery: 2,
      sapperMax: 3,
    },

    separation: 1.5,
    playerReach: 2.1,
  },

  // The manned deck gun: the reason the deck is worth standing on.
  //
  // It out-guns the rifle badly at range, which makes the bow the powerful
  // position against an incoming wave. What it cannot do is depress far enough
  // to shoot under the hull, so chewers remain a problem only solvable on foot.
  // That is the whole point: two seats, each strictly better at one job.
  //
  // Heat stops it being an answer to everything -- roughly two seconds of
  // sustained fire, then a forced pause.
  deckGun: {
    key: "KeyF",
    mountRange: 2.8,

    maxPitch: 0.61,    // ~35 deg up

    // -40 degrees, relaxed from -12. The clamp was never what protected the
    // under-hull space: the 3 m hull slab is. Any ray from a mount on top of the
    // fortress toward something beneath it crosses the deck's own top face and
    // dies there, at ANY angle. The tight clamp was belt-and-braces that cost
    // enormously in feel -- it pushed the gun's minimum engagement range out to
    // 47 m, so it could not touch anything that was actually threatening yet.
    //
    // The real rule is much better as a piece of design, because it is spatial
    // rather than numeric: the hull's shadow is the safe zone. Enemies are
    // shootable right up until they step underneath you.
    minPitch: -0.70,

    // Two stations, facing opposite ways, each with a 115-degree arc. Together
    // they cover everything; individually neither does. You can only man one, so
    // "the gun is limited" becomes "which threat are you answering", which is the
    // decision the whole prototype is about.
    mounts: [
      {
        name: "BOW GUN",
        mountLocal: [0, 2.0, -10.4],    // on the raised bow sponson
        operatorLocal: [0, 2.9, -8.8],
        facing: 0,
        traverse: 2.0,
      },
      {
        name: "STERN GUN",
        mountLocal: [0, 2.6, 10.6],     // on top of the engine block
        operatorLocal: [0, 3.5, 9.2],
        facing: Math.PI,
        traverse: 2.0,
      },
    ],

    damage: 45,
    fireRate: 14,
    spread: 0.010,
    range: 300,

    // Heat gain must clearly beat cooling or the limiter does nothing. At 14
    // shots/sec this gains 0.91/s against 0.40/s of cooling, so roughly two
    // seconds of fire (about 27 rounds) then a 1.6 s forced pause.
    heatPerShot: 0.065,
    coolRate: 0.40,
    resumeHeat: 0.35,  // after an overheat, must cool to here before firing
  },

  // Repair. Leg repair points sit UNDER the hull, in the same spot chewers
  // attack from, so fixing a leg means standing in the danger zone. That is the
  // point: it gives the ground a second job beyond killing things.
  repair: {
    key: "KeyE",

    // Generous, because the repair point rides a hull walking at 4.5 m/s and you
    // have to jog along underneath it to keep working.
    range: 4.5,

    // Drifting briefly out of range must not cancel the interaction. Progress
    // was never actually lost -- restored health is permanent -- but the prompt
    // vanishing made it look like it was.
    graceTime: 0.7,

    threatRange: 6.0,

    // Contested repair is SLOWED, not blocked. Blocking it was an
    // over-correction: repair already does 110 hp/s against roughly 40 hp/s of
    // chewing, so the real limiter was always the operative's own health, not the
    // repair rate. A hard block also removed a legitimate risky play.
    //
    // Worse, the check measures hostiles near the PLAYER -- so in co-op a
    // teammate fighting beside the repairer would have stopped the work dead,
    // breaking the exact division of labour the game is built around.
    //
    // At 35%, contested leg repair (38 hp/s) roughly matches four chewers' damage
    // (40 hp/s): you can hold a leg while someone else clears, but you cannot fix
    // it alone under fire. Contested reactor repair (21 hp/s) loses to three
    // boarders (45 hp/s), so the reactor still demands clearing.
    contestedRate: 0.35,

    // Raised from 45. Measured: chewers deal 48-154 hp/s to the legs, so at 45
    // hp/s repair could never win the race at ANY wave size -- once you fell
    // behind you could not catch up, which is the arithmetic root of the
    // wave-three spiral a playtest ran into.
    //
    // The fix is not to make repair beat their damage, it is to make KILLING the
    // time cost and patching quick. What stops you standing there repairing under
    // fire is your own health: four engaged chewers do ~40 hp/s to a 100 hp
    // player. So you must clear the area first, then patch in about a second.
    legRate: 110,     // a dead leg takes ~1.1 s once the area is clear
    reactorRate: 60,
  },

  // Shock emitters: the tower-defence layer, and the answer to "I cannot be in
  // two places at once". Deploy them under the hull and they hold a little of
  // the line while you go up to deal with boarders.
  //
  // They are deliberately WEAK. One emitter is about 22 dps against a player
  // rifle's 200 -- roughly 11%. Three together are a third of one player. If
  // automation could hold the under-hull area alone, nobody would ever dismount
  // and the entire pillar would collapse. They slow the bleed; they do not hold
  // the line. And they cannot repair, so the trip down is still mandatory.
  emitters: {
    deployKey: "KeyX",
    recallKey: "KeyC",
    max: 3,
    radius: 6.0,
    damage: 20,
    interval: 0.9,

    // Capacitor banks, and this is what keeps the pillar alive. A first pass gave
    // them unlimited shots at a third of a player's rifle dps, reasoning that a
    // third of a player is harmless. It was not: an emitter has perfect uptime,
    // never aims, never dies, and never has to break off to repair something.
    // Three of them held the under-hull area indefinitely with the player absent,
    // which would have meant never dismounting again.
    //
    // A finite pool with a slow trickle makes them a BURST of cover -- enough to
    // hold your spot while you deal with boarders, then they run dry.
    charge: 6,
    recharge: 0.35,   // charges per second, about 2.9 s per shot once empty

    recallRange: 3.2,
    arcLife: 0.08,
  },

  waves: {
    // Pacing follows Left 4 Dead's director shape: build up, peak, fade, relax.
    // Four phases -- REST, PREP, SPAWNING, ENGAGED -- with two rules that matter
    // more than the numbers:
    //
    //   Spawning stops entirely while the players are under real pressure, and a
    //   guaranteed calm period follows before anything else happens. L4D stops
    //   spawning at peak intensity for exactly this reason.
    //
    //   Every wave is telegraphed with a preparation window. Deep Rock Galactic
    //   gives 15-20 s before a swarm specifically so players can set up defences,
    //   which is the moment our emitters exist for and previously never had.
    // Wave bearing and the climber interleave draw from this seed rather than
    // Math.random, so a run is reproducible and a difficulty change can be
    // compared against the same fight instead of a different one.
    seed: 90210,

    // How many waves make up one siege. THIS IS THE FINISH LINE, and it exists
    // because the fight was previously endless: a playtester averaging wave 4 read
    // that as repeated failure, when against a fixed rifle and no upgrades yet it
    // is a perfectly reasonable curve. Nothing was being reached.
    //
    // Five waves is about three minutes, which is one leg of the intended journey
    // rather than a whole run. Difficulty is deliberately NOT being tuned to fit
    // this: enemy strength is quadratic (count x time-scaled hp) against a flat
    // 200 dps, so the missing half is the player's power curve, not a nerf. Move
    // this number, not the enemy numbers, if a siege feels the wrong length.
    siegeLength: 5,

    firstDelay: 12,   // calm before the very first telegraph
    minRest: 10,      // guaranteed breather once a wave is resolved
    prepTime: 12,     // telegraphed warning window

    baseCount: 10,
    perWave: 5,
    climberShare: 0.3,
    spawnRadius: 74,
    // Trickle, do not dump. At 9/s a wave of twenty was fully on the field in
    // 2.2 seconds, which is why the deck guns only ever got one pass at an
    // approach. Both reference directors release continuously.
    spawnRate: 2.5,   // enemies per second released into a wave

    // Each wave commits to ONE bearing, chosen when its telegraph starts, and
    // arrives in a tight cone around it. A wave smeared across the full 143 deg
    // arc cannot be warned about usefully or defended against deliberately.
    waveSpread: 0.35,
    hpRamp: 100,      // seconds of elapsed time to double enemy health

    // The next wave waits for the field to thin out. Without this, waves land on
    // a fixed 28 s clock whether or not you cleared the last one, so falling
    // behind once is unrecoverable -- the classic wave-game death spiral, and the
    // measured reason wave 3 was a wall. Immobilised, 16 hostiles were parked
    // under the hull at once with more arriving on schedule.
    //
    // Calling a wave early with Q deliberately IGNORES this, so stacking waves
    // stays available as a choice.
    holdUntilCleared: 8,

    // Our equivalent of L4D's "survivor intensity". Counting live enemies is a
    // crude proxy: eight healthy ones wandering at 60 m held a wave exactly as
    // hard as eight chewing your legs. These are the signals that actually mean
    // the crew is in trouble.
    pressure: {
      hurtWeight: 0.40,        // how far the operative's health has fallen
      underWeight: 0.25,       // hostiles in the hull's shadow
      underFull: 6,
      aboardWeight: 0.20,      // hostiles on the deck
      aboardFull: 4,
      // A stopped fortress is on its own enough to hold the pacing: it is the
      // clearest possible signal the crew is in trouble, and it is the exact
      // state the wave-three spiral used to happen in. Weighted above calmBelow
      // deliberately, so no new wave arrives while you are dead in the sand.
      immobileWeight: 0.40,
      recentHurtWeight: 0.15,
      recentHurtWindow: 3.0,   // seconds since last taking damage
      calmBelow: 0.35,         // must fall under this before pacing advances
    },

    // Spawn inside the hull's forward arc. Enemies behind a walking fortress
    // spend the whole wave jogging after it and never arrive.
    //
    // Narrowed from 1.25 (72 deg) after a playtest reported waiting around for
    // enemies. Measured time for a wave to engage, by the bearing it committed to:
    //
    //   dead ahead   7.1 s median, 10.0 s slowest
    //   23 deg       7.1 s median,  8.3 s
    //   46 deg       8.8 s median, 19.0 s
    //   72 deg      23.2 s median, 35.7 s   <- a third of all waves landed here
    //
    // At 72 deg a wave is effectively abeam: the fortress walks past it and the
    // rest of the wave is a stern chase, which enemies now barely win at all.
    // 0.9 rad (52 deg) cuts that worst case to 10.3 s.
    //
    // Slowing the hull was the other candidate and is strictly worse: it takes a
    // 29% cut (4.5 -> 3.2 m/s) to reach 13.3 s, it does not stop bad bearings being
    // handed out, and hull speed already scales 4.5/3.4/2.3/1.1 with legs lost, so
    // lowering the base compresses the range that tells the player how hurt the
    // fortress is.
    //
    // Also used as the scatter for unaimed spawns, which wants the same thing.
    // Do not narrow this much further: the bearing telegraph derives its three
    // labels from a third of this arc, and if waves stop arriving from noticeably
    // different directions the warning stops being information at all, which
    // removes the reason the preparation window exists. Guarded by test 59.
    forwardArc: 0.9, // radians either side of the hull's heading
  },

  // ---------------------------------------------------------------------------
  // The run: legs of a journey, a siege at each landmark, a boss at the end.
  //
  // Until now a siege was the whole game, which meant the prototype had a finish
  // line but no ARC. Five waves is one leg of the intended journey, not a run,
  // and without something above it the upgrade economy has nothing to pay off
  // against -- you buy a rifle stack and then the game ends.
  //
  // A leg is: hold a siege, then choose which road to take next. The choice is
  // the travel: there is no travel minigame here, because the interesting part of
  // "which way do we go" is the trade, not the walking.
  //
  // Each road is a modifier plus a payout, and every modifier is a real cost, so
  // the safe road exists and is deliberately the dull one. A route menu where one
  // option is strictly best is a menu, not a decision.
  run: {
    seed: 31337,

    // Four landmarks, the last one a boss. At roughly three minutes a siege plus
    // the rest phases, that is a run of about fifteen minutes -- short of the
    // 30-45 minute target, but this is one biome, and biomes are the unit that
    // repeats.
    legs: 4,

    // Two roads offered at each landmark. Three would be more choice and less
    // decision: with three, one is almost always obviously worst, which just adds
    // reading.
    branches: 2,

    // The boss siege is shorter, because the titan IS the wave. Running a full
    // five-wave siege and then a boss on top turns the climax into an endurance
    // tax on whatever you had left.
    bossSiegeLength: 3,

    // How much of the normal wave still arrives alongside the titan. All of it
    // and the boss becomes a crowd-control problem you cannot see through; none
    // of it and it is a duel, which throws away every system except shooting.
    bossWaveScale: 0.55,

    // Roads. `threat` multiplies enemy health, `count` adds to every wave,
    // `speed` scales enemy movement, `fog` tightens visibility, and the payouts
    // land the moment you arrive.
    //
    // Payouts are front-loaded on purpose: you get paid for choosing the hard
    // road BEFORE you find out whether you can survive it, so the money is
    // spendable on the thing that makes it survivable. Paying afterwards would
    // make the gamble a punishment with a consolation prize.
    routes: [
      {
        id: "foundry", name: "THE OLD FOUNDRY",
        detail: "quiet road", threat: 1, count: 0, speed: 1, fog: 1,
        salvage: 0, scrap: 30, module: false,
      },
      {
        id: "flats", name: "SALT FLATS",
        detail: "open ground — they come in fast", threat: 1, count: 0,
        speed: 1.12, fog: 1, salvage: 45, scrap: 15, module: false,
      },
      {
        id: "dustbowl", name: "THE DUST BOWL",
        detail: "you will not see them coming", threat: 1, count: 0,
        speed: 1, fog: 0.55, salvage: 20, scrap: 60, module: false,
      },
      {
        id: "rift", name: "THE RIFT",
        detail: "more of them, every wave", threat: 1, count: 4,
        speed: 1, fog: 1, salvage: 55, scrap: 70, module: false,
      },
      {
        id: "boneyard", name: "THE BONEYARD",
        detail: "older, tougher things live here", threat: 1.18, count: 0,
        speed: 1, fog: 1, salvage: 30, scrap: 20, module: true,
      },
      {
        id: "scrapfields", name: "SCRAP FIELDS",
        detail: "armour, and plenty of it", threat: 1.1, count: 2,
        speed: 1, fog: 1, salvage: 95, scrap: 25, module: false,
      },
    ],
  },

  // The economy, and the two currencies are deliberately separate FROM THE START.
  //
  // One pooled pot generates a co-op argument every single wave -- whoever spends
  // it spent everyone's money -- and it is painful to retrofit a split later
  // because every price and payout has to be re-derived. So:
  //
  //   SALVAGE is personal and comes from what YOU kill. It buys your own kit and
  //   stacks without limit, Risk of Rain style.
  //   SCRAP is shared and comes from the crew HOLDING A WAVE, which is the shared
  //   objective. It buys fortress upgrades, which are bounded.
  //
  // That mapping is the point: the money you earn alone buys unbounded personal
  // power, the money you earn together buys a fixed frame. It is the "bounded
  // structure, unbounded stacking" principle expressed as income.
  economy: {
    // Per kill. Climbers pay more because reaching them costs you position --
    // they are up on the deck or climbing toward it, so killing one means leaving
    // whatever you were doing underneath.
    chewer: { salvage: 2, scrap: 1 },
    climber: { salvage: 4, scrap: 2 },

    // The rest of the roster, keyed by the same type names. Payouts track what
    // killing one COSTS you rather than how much health it had: a sapper is worth
    // more than its 70 hp suggests because answering it means dropping whatever
    // you were doing right now, and a burrower pays well because it appears
    // somewhere you were not.
    bulwark: { salvage: 12, scrap: 5 },
    burrower: { salvage: 5, scrap: 2 },
    sapper: { salvage: 9, scrap: 4 },
    titan: { salvage: 140, scrap: 120 },

    // Paid to the shared pot when a wave is resolved, not per kill: the fortress
    // is funded by surviving, so nobody can farm the crew's budget alone.
    waveClearScrap: 18,
    waveClearGrowth: 6, // added per wave number

    // Over a full 5-wave siege that budgets roughly 260 salvage and 280 scrap,
    // which is about three personal stacks OR two fortress upgrades plus change.
    // Not enough for both: that is the decision.

    // Calling a wave early with Q pays this much more for the whole wave. Q has
    // existed since the pacing rework with nothing to be greedy FOR, so the risk
    // was pure downside and no one would ever press it. The cost of pressing it is
    // losing the 12 s preparation window; this is what you are buying with it.
    earlyCallBonus: 0.5,

    // Buying is a BETWEEN-WAVES act. Allowing it mid-fight would let players spend
    // their way out of trouble and would drain the tension the whole siege is
    // built on. It also gives the preparation window a second job -- until now it
    // only existed for placing emitters.
    keys: ["Digit1", "Digit2", "Digit3", "Digit4", "Digit5", "Digit6"],

    // Personal items come first so the keys read top to bottom in one group, then
    // the fortress refits. Order is presentation only -- everything that looks an
    // item up does it by id, never by index, precisely so this list can be
    // regrouped without breaking anything.
    catalogue: [
      // ---- personal, unbounded, paid for in salvage ----
      //
      // The main answer to the difficulty curve: enemy strength is quadratic
      // (count x time-scaled health) while base damage is flat, so this is the
      // term that has to grow.
      //
      // Two shapes here, deliberately. Damage and health stack ADDITIVELY, which
      // stays legible -- three stacks is plainly "+75%". Fire rate and damage
      // resistance stack HYPERBOLICALLY, because both break at 100%: infinite
      // fire rate is a divide-by-zero and total immunity removes the ground's
      // cost, which is half the pillar. Risk of Rain's rule, and it exists for
      // exactly this reason.
      {
        id: "rifle", name: "RIFLE CALIBRATION", detail: "+25% weapon damage",
        pool: "salvage", cost: 45, growth: 1.55, max: Infinity,
      },
      {
        id: "vitals", name: "VITALS", detail: "+25 max health, healed",
        pool: "salvage", cost: 40, growth: 1.5, max: Infinity,
      },
      {
        id: "trigger", name: "TRIGGER GROUP", detail: "faster fire, diminishing",
        pool: "salvage", cost: 50, growth: 1.5, max: Infinity,
      },
      {
        id: "weave", name: "KINETIC WEAVE", detail: "take less damage, diminishing",
        pool: "salvage", cost: 55, growth: 1.5, max: Infinity,
      },

      // ---- fortress, bounded, paid for in scrap ----
      //
      // These are incremental improvements to systems that already exist, which
      // is what separates them from modules: a module is a new capability bolted
      // to a hardpoint, and there are only three of those.
      {
        id: "plating", name: "HULL PLATING", detail: "fortress takes 15% less damage",
        pool: "scrap", cost: 60, growth: 1.6, max: 4,
      },
      {
        id: "rig", name: "REPAIR RIG", detail: "+30% repair speed",
        pool: "scrap", cost: 55, growth: 1.6, max: 3,
      },
    ],

    // Hyperbolic stacking curves. `cap` is the asymptote the effect approaches
    // but never reaches, `k` how fast it gets there.
    //
    // Fire rate tops out at +120%, so the rifle can roughly double in rate over a
    // long run without ever reaching the frame rate. Damage taken approaches 0 but
    // cannot arrive: at ten stacks you still take 22% of every hit, so standing
    // under the hull is never free, which is what keeps the dismount a decision
    // rather than a formality.
    hyper: {
      trigger: { cap: 1.2, k: 0.35 },
      weave: { k: 0.35 },
    },
  },

  // ---------------------------------------------------------------------------
  // Audio. Entirely synthesised at runtime -- there are no sound files.
  //
  // Not a purity exercise: a stompy fortress is half a sound design problem, its
  // absence was distorting every feel judgement being made, and a synth voice per
  // event is the shortest path from "silent" to "you can hear the thing you are
  // standing on". Footfalls in particular were doing nothing for a mechanic whose
  // entire subject is a walking building.
  //
  // Everything is one-shot noise or a short oscillator through a filter, so the
  // whole mixer costs a few hundred bytes of code and no download.
  audio: {
    master: 0.55,
    // Duck everything while the reactor is failing, so the alarm cuts through
    // without the alarm itself having to be louder than the guns.
    duckUnderAlarm: 0.7,
    footVolume: 0.9,
    rifleVolume: 0.35,
    gunVolume: 0.5,
    hitVolume: 0.3,
    deathVolume: 0.28,
    zapVolume: 0.3,
    hornVolume: 0.5,
    // The fortress's own noise floor: a low diesel idle that rises with drive.
    droneVolume: 0.22,
  },

  // ---------------------------------------------------------------------------
  // Renderer and post-processing. All of it optional at runtime: if a device
  // cannot allocate the float targets the composer needs, main.js falls back to
  // rendering the scene directly and the game plays identically.
  render: {
    // 0.62, down from 0.95, and the whole brightness chain came down with it.
    //
    // A playtest reported being flash-banged, which was four mistakes compounding
    // rather than one number being wrong. The sun was at 3.1 (three.js has used
    // physically-correct light units since r155, where 3.1 on a directional light
    // is glaring), the environment map was at 0.85 on a bright desert sky, the sky
    // was drawn as the raw HDRI with no dimming, and every textured metal surface
    // had its metalness FORCED to 1.0 so it mirrored that sky. Then bloom at a
    // 0.85 threshold smeared the result across everything else.
    //
    // Tunable live with - and = , because "too bright" is a monitor-and-eyes
    // judgement that no amount of measurement settles.
    exposure: 0.62,
    minExposure: 0.25,
    maxExposure: 1.6,
    exposureStep: 0.06,

    // Bloom is what makes the reactor, the hardpoints, the tracers and the emitter
    // arcs read as light sources rather than as bright paint. The threshold is
    // above 1.0 on purpose now: only things brighter than white bloom, which means
    // genuinely emissive surfaces and nothing else. At 0.85 the sky and every lit
    // metal panel qualified.
    bloom: { strength: 0.32, radius: 0.55, threshold: 1.05 },

    // Ground haze. Cheap, and it does what a depth-of-field pass would do for the
    // silhouette of a 26 m fortress: separates it from the horizon.
    hazeColor: 0xd8bf99,
    hazeStrength: 0.55,
    vignette: 0.42,
    grain: 0.035,
    // Chromatic aberration only at the very edge of frame, so it reads as a lens
    // rather than as a broken monitor.
    aberration: 0.0016,

    // ------------------------------------------------------------------ cost
    //
    // Measured, not guessed. The first build ran ~1410 draw calls a frame against
    // 55,698 triangles, which is the signature of a CPU-bound scene: the triangle
    // count is trivial and the call count is not. 646 of those calls were world
    // scatter -- one mesh per rock, per rock chunk, per ruin, per broken cap, per
    // rebar bundle -- and 558 of them cast shadows, so they were drawn twice.
    //
    // Nothing about that is a browser limit. WebGL draws on the GPU and the whole
    // simulation costs 0.40 ms a frame; it was our own scene graph.
    //
    // Batching the scatter into merged meshes is the fix. This is the budget the
    // harness now asserts, so it cannot creep back.
    maxDrawCalls: 220,

    // Device pixel ratio ceiling. 2 on a high-DPI display is four times the pixels
    // for a picture nobody can tell apart at this art fidelity, and every
    // full-screen post pass pays for all of them.
    maxPixelRatio: 1.5,

    // Adaptive resolution. The renderer measures the raw frame interval and walks
    // the scale between these bounds, in steps, on a slow cadence so it never
    // oscillates visibly.
    //
    // The thresholds are RATIOS of the display's own refresh interval, not absolute
    // milliseconds, and that is the whole point of them. They used to be a fixed
    // 15.5 ms target with an 11.0 ms release: on a vsynced 60 Hz monitor a perfectly
    // healthy frame is 16.7 ms, so every healthy 60 Hz machine read as "too slow"
    // for ever. The scale walked down to 0.6 in four seconds, antialiasing switched
    // itself off on the way, and it could never come back up because 11.0 ms needs
    // 90 fps that vsync will not hand out. The result was a permanently soft image
    // and four render-target reallocations, on hardware with nothing wrong with it.
    adaptive: {
      // Scale down past 1.25x the refresh interval -- a frame that misses vsync
      // outright is 2x, so this catches the miss without reacting to jitter.
      downFactor: 1.25,
      // And back up while comfortably inside it. Above 1.0 because a frame that
      // exactly hits refresh is a frame that is keeping up.
      upFactor: 1.10,
      // There is no browser API for the refresh rate, so it is inferred from the
      // fastest frame actually observed. Until one arrives, assume 60 Hz -- which is
      // also the safe guess, since a machine that never produces a plausible sample
      // is a machine that is not keeping up with 60 Hz either.
      refreshFallbackMs: 16.7,
      // Only intervals in this band are believed to be vsync. Without an upper
      // bound a machine stuck at half rate would decide its monitor was 30 Hz and
      // then happily conclude it was keeping up -- the scaler would stop reacting
      // to load at all, which is the failure this whole block exists to avoid.
      refreshSampleMin: 4.0,
      refreshSampleMax: 20.5,
      // Do not chase a frame time faster than this even on a 240 Hz panel. Without
      // it, high-refresh hardware spends its resolution budget pursuing a rate
      // nobody asked for.
      refreshFloorMs: 8.3,
      // One alt-tab is CLAMPED into the average rather than thrown away. Discarding
      // outliers would also discard a genuine 5 fps frame, and then the worst load
      // in the game would be the load the scaler ignored.
      spikeClampMs: 100,
      minScale: 0.6,
      maxScale: 1.0,
      step: 0.1,
      interval: 1.0,      // seconds between adjustments
      samples: 30,        // frames averaged before believing a reading
    },

    // Shadows. Tighter bounds are both sharper AND cheaper: the same map resolution
    // spread over a smaller area. +/-80 m was covering desert nobody looks at.
    shadow: { size: 2048, extent: 46, far: 220 },
    // Screen shake. The fortress's own footfalls are the reason this exists: a
    // 26 m walker whose steps do not touch the camera reads as a static room.
    shake: {
      step: 0.055,       // per footfall, scaled by how close the foot is
      hurt: 0.22,
      stomp: 0.4,
      titan: 0.5,
      decay: 7.0,
    },
    // Distant terrain silhouettes sit outside the patrol ring, so they can be as
    // tall as they like without ever touching the collision the play area uses.
    horizonRadius: 620,
  },

  debug: {
    speedStep: 0.5,
    minSpeed: 0,
    maxSpeed: 14,

    // Live enemy-speed multiplier, on , and .
    //
    // This one is a knob rather than a decided number on purpose. Speed is the
    // single difficulty value that measurement cannot settle: an oracle defender
    // that teleports and never misses was completely indifferent to it (227 s vs
    // 226 s survival at a 16% cut), which means everything speed buys goes to a
    // human's travel and reaction time. Only hands on the controls can judge it.
    enemySpeedScale: 1,
    enemyScaleStep: 0.1,
    minEnemyScale: 0.5,
    maxEnemyScale: 1.5,
  },
};

/** Swap the release-feel preset in place. Returns the new preset's name. */
export function applyReleasePreset(index) {
  const list = CFG.releasePresets;
  const i = ((index % list.length) + list.length) % list.length;
  const p = list[i];

  CFG.releasePreset = i;
  CFG.grapple.arriveMomentum = p.arriveMomentum;
  CFG.grapple.arriveLift = p.arriveLift;
  CFG.grapple.cutMomentum = p.cutMomentum;
  CFG.grapple.cutLift = p.cutLift;

  return p.name;
}

export const releasePresetName = () => CFG.releasePresets[CFG.releasePreset].name;

/**
 * Enemy type names, in the order the numeric type ids use.
 *
 * Exported so nothing has to keep its own copy of the roster. Every place that
 * used to branch `type === CHEWER ? chewerCfg : climberCfg` is now a lookup
 * through this, which is what makes adding a type a config change rather than a
 * hunt through six modules for ternaries.
 */
export const ENEMY_TYPE_KEYS = [
  "chewer", "climber", "bulwark", "burrower", "sapper", "titan",
];

/** Config object for a numeric enemy type id. */
export const enemyCfg = (type) => CFG.enemies[ENEMY_TYPE_KEYS[type]];

/**
 * Damage actually dealt to an enemy, after its armour.
 *
 * Flat soak with a floor rather than a percentage, because flat soak is what
 * makes a weapon feel like the wrong tool instead of merely weak: the rifle's 25
 * against 20 armour is a fifth of its output, while the gun's 45 keeps more than
 * half. A percentage would scale both identically and the bulwark would just be
 * a health bar.
 */
export function afterArmour(raw, armour) {
  if (armour <= 0) return raw;
  return Math.max(raw - armour, raw * CFG.enemies.minDamageFraction);
}

/** Hyperbolic stack curve: approaches `cap` as stacks rise, never reaches it. */
export const hyperGain = (stacks, cap, k) => cap * (1 - 1 / (1 + k * stacks));

// Captured once, so the multiplier always applies to the AUTHORED speeds instead
// of compounding on whatever the last adjustment produced.
const BASE_ENEMY_SPEED = Object.fromEntries(
  ENEMY_TYPE_KEYS.map((k) => [k, CFG.enemies[k].speed]),
);

/**
 * Scale enemy movement speed live, for judging it in play.
 *
 * `outrun` reports when the scaled speed has fallen to or below the hull's own
 * speed. It is a warning, not a wall: measured, enemies still reach a fortress
 * walking at full speed well below this line, because waves arrive head-on and
 * the hull walks a circle that trailing enemies can cut inside. What is genuinely
 * lost is the stern chase -- anything the fortress gets past stops mattering.
 * Reported rather than clamped away, because knowing where that edge sits is the
 * informative part.
 */
export function applyEnemySpeedScale(scale) {
  const d = CFG.debug;
  const clamped = Math.max(d.minEnemyScale, Math.min(d.maxEnemyScale, scale));
  d.enemySpeedScale = Math.round(clamped * 100) / 100;

  for (const key of ENEMY_TYPE_KEYS) {
    CFG.enemies[key].speed = BASE_ENEMY_SPEED[key] * d.enemySpeedScale;
  }

  return {
    scale: d.enemySpeedScale,
    chewer: CFG.enemies.chewer.speed,
    climber: CFG.enemies.climber.speed,
    // Measured over CHEWERS AND CLIMBERS ONLY, not the whole roster.
    //
    // Bulwarks and titans are authored slower than the hull on purpose -- being
    // outrun is their design, and it is what makes dealing with them during the
    // approach worth anything. Folding them in would make this warning fire
    // permanently and it would stop being read, which is the usual way a warning
    // dies. The invariant it guards is about the two types that have to keep up.
    outrun: Math.min(CFG.enemies.chewer.speed, CFG.enemies.climber.speed) <= CFG.trampler.speed,
  };
}
