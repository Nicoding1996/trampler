// Every feel-relevant number lives here so it can be dialled in one place.
// Units are metres and seconds. Gravity is deliberately far above 9.81 --
// realistic gravity feels floaty in an FPS.

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
  },

  world: {
    fogColor: 0xc7b299,
    fogNear: 70,
    fogFar: 460,
    groundColor: 0xb99f78,
    patrolRadius: 165,
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

    // Chewers attack the legs from INBOARD, under the hull slab. That is not
    // decoration: the deck physically blocks line of sight to anything directly
    // beneath it, so they cannot be answered from up top. This is the forcing
    // function that makes players dismount at all.
    chewer: {
      hp: 50, speed: 6.2, damage: 9, attackRate: 1.1,
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
    },

    // Climbers board via authored attach points and go for the reactor, which
    // is the opposite pressure: staying on the ground too long costs you.
    climber: {
      // Must outpace the hull by a clear margin or boarders never arrive at all.
      hp: 80, speed: 6.0, damage: 15, attackRate: 1.0,
      radius: 0.55, height: 1.9, reach: 2.4,
      climbTime: 2.2,

      // Measured to the reactor's SURFACE, not its centre. Reach 2.4 from the
      // centre of a 5 x 2.4 x 4 box puts boarders inside it, where the reactor's
      // own mesh absorbs every bullet aimed at them -- they became unkillable.
      reactorReach: 1.2,
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

    // You cannot weld while something is chewing on you. Measured: a freshly
    // repaired leg has 120 hp and four chewers do about 40 hp/s, so it survives
    // roughly three seconds if you leave them alive -- repairing without clearing
    // first is a guaranteed losing trade, and nothing was telling the player
    // that. Blocking it turns a hidden trap into an explicit rule: clear, then
    // patch.
    threatRange: 6.0,

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
    firstDelay: 14,
    between: 28,
    baseCount: 10,
    perWave: 5,
    climberShare: 0.3,
    spawnRadius: 74,
    spawnRate: 9,     // enemies per second released into a wave
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

    // Spawn inside the hull's forward arc. Enemies behind a walking fortress
    // spend the whole wave jogging after it and never arrive.
    forwardArc: 1.25, // radians either side of the hull's heading
  },

  debug: {
    speedStep: 0.5,
    minSpeed: 0,
    maxSpeed: 14,
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
