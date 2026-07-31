import * as THREE from "three";
import { CFG } from "./config.js";
import { box, boxToMesh, clamp, makeRandom } from "./util.js";
import { Look, greeble, tileBoxUVs } from "./look.js";

// The walking fortress.
//
// Two deliberate constraints, both load-bearing for the whole project:
//
//  1. The deck TRANSLATES and YAWS only -- never pitches or rolls. That single
//     restriction removes most of the pain of standing on a moving object,
//     because the deck stays axis-aligned in its own local space. Leg motion is
//     faked on top. Optional vertical bob exists purely so we can find out
//     whether it ruins comfort (toggle with B).
//
//  2. Colliders live in LOCAL space. Because the hull only yaws, local-space
//     collision is exact, not an approximation, and the player controller can
//     reuse the same AABB code it uses for terrain.
//
// Local origin sits at the centre of the deck surface, so local y=0 is the
// floor you walk on and negative y is inside the hull.

const HALF_W = 8;
const HALF_L = 13;
const HULL_DEPTH = 3;
const RAIL_H = 1.1;
const RAIL_T = 0.5;
const GAP = 3; // boarding gap half-length on each flank

const _footWorld = new THREE.Vector3();

export class Trampler {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);

    this.colliders = [];   // local space
    this.grappleables = [];
    this.hardpoints = [];
    // Solid deck furniture that boarders have to walk around. A subset of
    // `colliders`: the hull slab and the deck skin are floors, not obstacles, and
    // including them would push every boarder off the ship.
    this.deckObstacles = [];

    // Spatial damage. Six independent legs plus the reactor, rather than one
    // hull health bar, so a leak in the defence has a specific consequence you
    // can see and feel instead of a number going down.
    this.legHp = new Array(CFG.trampler.legCount).fill(CFG.trampler.legHp);
    this.reactorHp = CFG.trampler.reactorHp;
    this.destroyed = false;

    // Incoming damage multiplier, owned by the economy's hull plating. 1 is
    // unarmoured. Applied to legs and the reactor alike, in damageLeg and
    // damageReactor, so no attacker can bypass it by using a different path.
    this.damageScale = 1;

    // Instance multipliers owned by fortress MODULES. Same discipline as the
    // economy's: never written into CFG, always restorable to these defaults, so
    // a run's build cannot leak into the next attempt or into a later test.
    this.driveScale = 1;
    this.turnScale = 1;
    this.reactorScale = 1;
    this.slotBonus = 0;

    // Deck extents, so other systems can ask whether something is still aboard.
    this.halfW = HALF_W;
    this.halfL = HALF_L;

    this.yaw = 0;
    this.yawRate = 0;
    this.yawDelta = 0;
    this.linVel = new THREE.Vector3();
    this.walking = true;
    this.turning = true;
    this.time = 0;

    // Footfalls raised this frame, consumed by resolveStomps(). Kept as data
    // rather than resolved inline because the fortress has no business holding
    // references to the horde or the player -- and because a test can read them.
    this.footfalls = [];
    this.stepCount = 0;
    this.lastStompHits = 0;

    this.matrix = new THREE.Matrix4();
    this.matrixInverse = new THREE.Matrix4();
    this.prevMatrixInverse = new THREE.Matrix4();
    this.prevPos = new THREE.Vector3();

    this.#build();

    // Start somewhere on the patrol ring, facing along it.
    const r = CFG.world.patrolRadius;
    this.group.position.set(r, CFG.trampler.deckHeight, 0);
    this.yaw = Math.PI; // forward is -Z locally, so this heads toward +Z
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);
    this.matrix.copy(this.group.matrixWorld);
    this.matrixInverse.copy(this.matrix).invert();
    this.prevMatrixInverse.copy(this.matrixInverse);
    this.prevPos.copy(this.group.position);
  }

  // ---------------------------------------------------------------- geometry

  #build() {
    // Seeded, so the greebling is identical on every load. A fortress that
    // reshuffles its own detail between runs makes screenshots useless for
    // comparing anything.
    const rand = makeRandom(0xf0e7a1);

    const hullMat = Look.std("hull", { color: 0x6a6e77, roughness: 0.72, metalness: 0.45 });
    const deckMat = Look.std("deck", { color: 0x8c8377, roughness: 0.88, metalness: 0.2 });
    const trimMat = Look.std("trim", { color: 0xb0705a, roughness: 0.7, metalness: 0.25 });
    const mastMat = Look.std("mast", { color: 0x7a7f88, roughness: 0.68, metalness: 0.4 });
    const crateMat = Look.std("crate", { color: 0xa8845c, roughness: 0.8, metalness: 0.1 });
    const legMat = Look.std("leg", { color: 0x5c6066, roughness: 0.62, metalness: 0.55 });
    const reactorMat = new THREE.MeshStandardMaterial({
      color: 0x2a3f2c, emissive: 0x63e06a, emissiveIntensity: 0.9, roughness: 0.5,
    });
    this.reactorMat = reactorMat;
    this.legMat = legMat;
    this.hullMat = hullMat;

    // Tile size per part, in metres. Big structural plate reads coarse, deck
    // grating and crates read fine.
    const structural = [
      // hull block: you walk on its top face, and shelter underneath it
      [box(-HALF_W, -HULL_DEPTH, -HALF_L, HALF_W, 0, HALF_L, "hull"), hullMat, 3.0],

      // deck skin, purely so the walkable surface reads differently from hull
      [box(-HALF_W + 0.4, -0.06, -HALF_L + 0.4, HALF_W - 0.4, 0.02, HALF_L - 0.4, "deck"), deckMat, 2.0],

      // railings, with a deliberate boarding gap amidships on both flanks
      [box(-HALF_W, 0, -HALF_L, -HALF_W + RAIL_T, RAIL_H, -GAP, "rail"), trimMat, 1.4],
      [box(-HALF_W, 0, GAP, -HALF_W + RAIL_T, RAIL_H, HALF_L, "rail"), trimMat, 1.4],
      [box(HALF_W - RAIL_T, 0, -HALF_L, HALF_W, RAIL_H, -GAP, "rail"), trimMat, 1.4],
      [box(HALF_W - RAIL_T, 0, GAP, HALF_W, RAIL_H, HALF_L, "rail"), trimMat, 1.4],
      [box(-HALF_W, 0, -HALF_L, HALF_W, RAIL_H, -HALF_L + RAIL_T, "rail"), trimMat, 1.4],
      [box(-HALF_W, 0, HALF_L - RAIL_T, HALF_W, RAIL_H, HALF_L, "rail"), trimMat, 1.4],

      // bow bridge, reachable by a step so it is walkable as well as grappleable
      [box(-4.5, 0, -11.5, 4.5, 1.0, -6.5, "bridge"), hullMat, 2.0],
      [box(-2.4, 0, -6.5, 2.4, 0.5, -5.7, "step"), hullMat, 1.2],

      // Raised gun sponson on the bow. Height is not decoration: a gun mounted
      // at deck level cannot depress at all without its own deck blocking the
      // shot -- at 12 degrees the ray meets the hull's top face 5 m out, well
      // inside the 8 m half-width. Lifting the mount clears the deck edge.
      [box(-2.6, 1.0, -11.4, 2.6, 2.0, -7.6, "sponson"), mastMat, 1.6],

      // stern engine block
      [box(-5, 0, 8.5, 5, 2.6, 12, "engine"), mastMat, 1.8],

      // the reactor: what boarders come for, and what losing ends the run
      [box(-2.5, 0, 3, 2.5, 2.4, 7, "reactor"), reactorMat, 2.0],

      // central mast with an overhanging crow's nest -- the nest cannot be
      // walked to, so it is a pure grapple destination
      [box(-1.3, 0, -1.3, 1.3, 9, 1.3, "mast"), mastMat, 1.6],
      [box(-3.2, 8.6, -3.2, 3.2, 9.0, 3.2, "nest"), mastMat, 1.6],

      // The refit terminal: where buying happens.
      //
      // A PLACE rather than a moment, and that is the whole point of it. The shop
      // used to be a timing rule the player could not see -- it appeared on its own
      // during a rest that legally permits eight live enemies, so it arrived while
      // they were still shooting, and a playtester reported exactly that. Making it
      // somewhere you walk to is the same move as the gun's depression clamp: the
      // hull's 3 m slab already enforced "you cannot shoot beneath yourself", so the
      // magic number came out and the rule became spatial and legible.
      //
      // It also gives shopping a real cost, of exactly the kind the pillar is made
      // of: this is on the DECK, so buying something means not being under the hull.
      // Invariant 23's "you cannot spend your way out of trouble" then falls out of
      // geometry instead of a phase check -- you physically cannot buy while fighting
      // chewers, because the terminal is not down there.
      //
      // ON THE BOW BRIDGE, outboard to starboard. This is the fourth position tried and
      // every rejection taught something, so all four are recorded — a deck this small
      // has almost no free space, and "somewhere on the deck" turned out to be a much
      // harder constraint than it sounds.
      //
      //   (-5.6, 2.1) port amidships. 2.37 m from the deck spawn, INSIDE the 3 m
      //   interaction radius, so the panel was up the instant the player appeared. That
      //   is the push behaviour the console exists to remove.
      //
      //   (5.6, 2.1) starboard amidships. `#buildClimbPoints` puts boarding route exits
      //   at local (+/-6.8, z) for z in {-9, -3, 3, 9}, and this was **1.5 m from the
      //   starboard z=3 exit** — boarders arrive on top of the shopper — with the
      //   reactor's near corner 3.2 m away. The comment defending it claimed "6.3 m from
      //   the reactor, deliberately marginal", which measured to the reactor's CENTRE
      //   rather than to anywhere a boarder stands, and never looked at the climb routes.
      //
      //   (0, -4.1) centreline forward of the mast. Clears every climb exit by 6.9 m and
      //   the reactor by 7.4 m, and broke two movement tests instantly. Test 2's own
      //   comment says why: "local z = -4 is the one lane clear of the mast, the crates,
      //   the bow step and the engine block". The deck's clear lane is load-bearing for
      //   the movement puzzle, and a collider across it is not a placement, it is a wall.
      //
      // The bridge is the answer, and it is the obvious one in hindsight: it is a raised
      // platform that already exists, so nothing new obstructs the deck floor at all.
      // Hugging the outboard edge leaves a 1.0 m walkway inboard of it, so the route up
      // the centreline step and on to the bow gun's sponson is untouched.
      //
      //   10.8 m to the reactor's nearest corner — the only proximity that matters, since
      //     that is where boarders STOP. A climber transiting a route is inside 6 m for a
      //     second or two, which is legible and harmless; a boarder parked on the reactor
      //     is what would lock the shop, and this is nowhere near it.
      //   11.5 m from the deck spawn.
      //   2.7 m clear of test 2's z = -4 lane.
      //   4.3 m from the bow gun's seat, so you cannot be at both — close enough that the
      //     bow is one coherent station, far enough that it is still a choice.
      //
      // Being on the bridge is also the most legible spot on the ship. It is raised and
      // faces the deck, so the one thing you now need in order to buy anything is visible
      // from most of the hull rather than tucked behind the mast.
      [box(3.6, 1.0, -8.6, 4.5, 2.1, -6.7, "terminal"), mastMat, 1.0],

      // deck clutter for cover and short parkour
      [box(-6.0, 0, 5.0, -3.0, 1.5, 8.0, "crate"), crateMat, 1.1],
      [box(3.0, 0, 4.0, 5.6, 1.2, 7.0, "crate"), crateMat, 1.1],
      [box(2.0, 0, -3.5, 4.4, 2.0, -1.0, "crate"), crateMat, 1.1],
    ];

    // Floors, not obstacles. Everything else on this list is something a boarder
    // has to walk around.
    const walkable = new Set(["hull", "deck", "step", "bridge"]);

    for (const [b, mat, tile] of structural) {
      this.colliders.push(b);
      const mesh = boxToMesh(b, mat, tile);
      mesh.userData.tag = b.tag; // lets other systems treat parts differently
      this.group.add(mesh);
      if (b.tag !== "deck") this.grappleables.push(mesh);
      if (!walkable.has(b.tag)) this.deckObstacles.push(b);

      if (b.tag === "reactor") {
        this.reactorMesh = mesh;
        this.reactorBox = b;
        this.reactorLocal = new THREE.Vector3(0, 1.2, 5); // centre, for AI targeting
      }

      if (b.tag === "terminal") {
        this.terminalBox = b;
        // Hull-local, like everything else anchored to the fortress, so it tracks a
        // walking, turning deck with no special-case code. Stored at the console's
        // FACE height rather than its centre, because the range check compares against
        // the operative's own position and half a metre of vertical offset is half a
        // metre of range spent on nothing.
        this.terminalLocal = new THREE.Vector3(4.05, 2.1, -7.65);
        this.terminalMesh = mesh;
      }
    }

    this.#buildDetail(rand, hullMat, mastMat, trimMat);
    this.#buildHardpoints();
    this.#buildSockets();
    this.#buildLegs(legMat);
  }

  /**
   * Give the refit terminal the silhouette of a destination rather than a crate.
   *
   * The structural box below remains the only collider, deck obstacle and grapple
   * target. This shell is visual only: the arch rises out of the existing footprint,
   * and emissive geometry communicates state without spending another light slot.
   */
  #buildTerminalKiosk() {
    // A deep, broad-shouldered service arch, open at the bottom so the original
    // structural box still reads as the counter. The depth gives it a canopy from
    // oblique angles instead of leaving a thin facade pasted onto the corrugation.
    const arch = new THREE.Shape();
    arch.moveTo(-1.45, 0);
    arch.lineTo(-1.45, 1.36);
    arch.lineTo(-1.15, 1.72);
    arch.lineTo(-0.62, 1.94);
    arch.lineTo(0.62, 1.94);
    arch.lineTo(1.15, 1.72);
    arch.lineTo(1.45, 1.36);
    arch.lineTo(1.45, 0);
    arch.lineTo(0.98, 0);
    arch.lineTo(0.98, 1.26);
    arch.lineTo(0.78, 1.50);
    arch.lineTo(-0.78, 1.50);
    arch.lineTo(-0.98, 1.26);
    arch.lineTo(-0.98, 0);
    arch.closePath();

    const frameGeo = new THREE.ExtrudeGeometry(arch, {
      depth: 0.50,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelSize: 0.045,
      bevelThickness: 0.045,
    });
    // Shapes extrude along Z. Rotate that depth into local X; using the back cap
    // as the inboard face preserves left-to-right lettering on the deck side.
    frameGeo.rotateY(-Math.PI / 2);
    frameGeo.translate(4.02, 2.04, -7.65);
    // The ship's own mast role, so the kiosk is fortress hardware rather than
    // something dropped on the deck: same tint, same vendored panel texture as the
    // sponson, the engine block and the mast. `Look.std` caches by role AND params,
    // so asking for a double-sided variant yields its own instance that still gets
    // dressed with the mast texture, instead of turning face culling off for half
    // the superstructure.
    this.terminalFrameMat = Look.std("mast", {
      color: 0x7a7f88, roughness: 0.68, metalness: 0.4, side: THREE.DoubleSide,
    });
    const frame = new THREE.Mesh(frameGeo, this.terminalFrameMat);
    frame.name = "terminal_kiosk_frame";
    frame.castShadow = false;
    frame.receiveShadow = true;
    this.group.add(frame);
    this.terminalFrameMesh = frame;

    const rectangle = (x0, y0, x1, y1) => {
      const shape = new THREE.Shape();
      shape.moveTo(x0, y0);
      shape.lineTo(x1, y0);
      shape.lineTo(x1, y1);
      shape.lineTo(x0, y1);
      shape.closePath();
      return shape;
    };

    // Keep every luminous part in one mesh: a service window up close, narrow rails
    // that stay visible around the grapple ring, and the marquee plus beacon that
    // identify the destination from across the deck.
    //
    // Deliberately a set of narrow lit ELEMENTS rather than one large glowing slab.
    // The first version lit the whole face and the whole arch, which read as a neon
    // sign bolted to a dieselpunk ship — the area was doing the shouting, so dimming
    // alone would not have fixed it.
    const signalShapes = [
      rectangle(-0.58, 0.38, 0.58, 0.94),
      rectangle(-0.95, 0.10, 0.95, 0.15),
      rectangle(-1.25, 0.18, -1.16, 1.38),
      rectangle(1.16, 0.18, 1.25, 1.38),
    ];

    // A tiny block alphabet is more legible here than another abstract icon, and
    // unlike a canvas texture it keeps this simulation module headless-safe.
    const glyphs = [
      ["110", "101", "110", "101", "101"], // R
      ["111", "100", "110", "100", "111"], // E
      ["111", "100", "110", "100", "100"], // F
      ["111", "010", "010", "010", "111"], // I
      ["111", "010", "010", "010", "010"], // T
    ];
    const cell = 0.044;
    const letterGap = 0.046;
    const letterWidth = cell * 3;
    const labelWidth = glyphs.length * letterWidth + (glyphs.length - 1) * letterGap;
    const labelX = -labelWidth / 2;
    const labelY = 1.57;
    for (let letter = 0; letter < glyphs.length; letter++) {
      for (let row = 0; row < 5; row++) {
        for (let column = 0; column < 3; column++) {
          if (glyphs[letter][row][column] !== "1") continue;
          const x = labelX + letter * (letterWidth + letterGap) + column * cell;
          const y = labelY + (4 - row) * cell;
          signalShapes.push(rectangle(x + 0.005, y + 0.005, x + cell - 0.005, y + cell - 0.005));
        }
      }
    }

    const beacon = new THREE.Shape();
    beacon.moveTo(-0.20, 1.97);
    beacon.lineTo(0.20, 1.97);
    beacon.lineTo(0.28, 2.09);
    beacon.lineTo(0.19, 2.24);
    beacon.lineTo(-0.19, 2.24);
    beacon.lineTo(-0.28, 2.09);
    beacon.closePath();
    signalShapes.push(beacon);

    const signalGeo = new THREE.ExtrudeGeometry(signalShapes, {
      depth: 0.055,
      steps: 1,
      bevelEnabled: true,
      bevelSegments: 1,
      bevelSize: 0.012,
      bevelThickness: 0.012,
    });
    signalGeo.rotateY(-Math.PI / 2);
    signalGeo.translate(3.50, 2.04, -7.65);

    // Lit hardware, not a light box. The numbers follow the deck's hazard striping,
    // which is this project's one existing example of a signal that reads without
    // blowing out: a DARK emissive colour at modest intensity. The first pass used a
    // saturated colour at 2.1-3.0, which is above `CFG.render.bloom.threshold` of
    // 1.05, so the sign bloomed and lit the bow like a flare — invariant 33's
    // "only genuinely emissive things bloom", broken by the newest thing added.
    this.terminalSignalMat = new THREE.MeshStandardMaterial({
      color: 0x5c3226,
      emissive: 0x37130a,
      emissiveIntensity: 0.7,
      roughness: 0.52,
      metalness: 0.22,
      side: THREE.DoubleSide,
    });
    const signal = new THREE.Mesh(signalGeo, this.terminalSignalMat);
    signal.name = "terminal_status_signal";
    signal.castShadow = false;
    signal.receiveShadow = false;
    this.group.add(signal);
    this.terminalSignalMesh = signal;

    this.terminalAvailable = null;
    this.setTerminalAvailable(false);
  }

  /** Presentation-only availability signal; the economy remains the authority. */
  setTerminalAvailable(available) {
    const next = !!available;
    if (!this.terminalSignalMat || this.terminalAvailable === next) return;
    this.terminalAvailable = next;

    // Hue carries the state and brightness only nudges it, so the two readings stay
    // distinguishable at distance without either of them shouting. Both sit under the
    // bloom threshold, so neither state throws light across the bow. No material
    // recompilation is needed for a colour or intensity change.
    this.terminalSignalMat.color.setHex(next ? 0x2f4a30 : 0x5c3226);
    this.terminalSignalMat.emissive.setHex(next ? 0x123a17 : 0x37130a);
    this.terminalSignalMat.emissiveIntensity = next ? 0.85 : 0.7;
  }

  /**
   * Non-colliding detail, and the single biggest reason the fortress reads as
   * enormous rather than as a grey box.
   *
   * None of this has a collider, on purpose. Every collider on the deck is part
   * of the movement puzzle -- what you can mantle, what blocks a shot, what a
   * boarder walks around -- and quietly adding thirty more of them would change
   * the mantle graph, which invariant 3 (the crow's nest stays grapple-only)
   * depends on. Detail that is only ever looked at must never be solid.
   */
  #buildDetail(rand, hullMat, mastMat, trimMat) {
    this.#buildTerminalKiosk();

    const add = (geo, mat, x, y, z, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast;
      m.receiveShadow = true;
      this.group.add(m);
      return m;
    };

    // Bolt strips and pipework over the hull flanks. Greebling: the model-maker's
    // trick of gluing kit parts to a smooth shape so the eye reads scale into it.
    for (const side of [-1, 1]) {
      const g = greeble(rand, 42, { x: 0.05, y: 1.1, z: HALF_L - 1.5 }, {
        minSize: 0.18, maxSize: 0.9, thickness: 0.22, axis: "x",
      });
      add(g, hullMat, side * (HALF_W + 0.06), -1.4, 0);
    }
    add(greeble(rand, 34, { x: HALF_W - 1.5, y: 0.04, z: 1.2 }, {
      minSize: 0.2, maxSize: 0.8, thickness: 0.16,
    }), mastMat, 0, 0.04, -HALF_L + 3.0, false);

    // Exhaust stacks on the engine block. The fortress needs a plume: a walking
    // industrial building with no smoke reads as a prop.
    this.stacks = [];
    for (const x of [-3.2, -1.1, 1.1, 3.2]) {
      const h = 2.2 + rand() * 1.4;
      const stack = add(
        new THREE.CylinderGeometry(0.34, 0.42, h, 10),
        trimMat, x, 2.6 + h / 2, 10.2,
      );
      const cap = add(new THREE.TorusGeometry(0.36, 0.09, 6, 10), mastMat, x, 2.6 + h, 10.2);
      cap.rotation.x = Math.PI / 2;
      // Where smoke leaves, read by the particle system.
      this.stacks.push(new THREE.Vector3(x, 2.6 + h + 0.2, 10.2));
    }

    // Cooling fans, which spin. Motion on a static silhouette is what says
    // "machine that is running" rather than "machine".
    this.fans = [];
    for (const side of [-1, 1]) {
      const hub = add(new THREE.CylinderGeometry(0.9, 0.9, 0.16, 12), mastMat,
        side * 4.6, 1.5, 11.9);
      hub.rotation.x = Math.PI / 2;
      const blades = [];
      for (let i = 0; i < 5; i++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 0.32), trimMat);
        b.rotation.z = (i / 5) * Math.PI * 2;
        b.castShadow = false;
        blades.push(b);
      }
      const rotor = new THREE.Group();
      for (const b of blades) rotor.add(b);
      rotor.position.set(side * 4.6, 1.5, 12.05);
      this.group.add(rotor);
      this.fans.push(rotor);
    }

    // Hazard striping on the deck edges, where you are about to walk off a
    // 7.5 m drop. Signal, not decoration -- and it is the only warning at the
    // boarding gaps, which have no railing by design.
    const hazard = new THREE.MeshStandardMaterial({
      color: 0xffb347, roughness: 0.6, metalness: 0.1,
      emissive: 0x2a1600, emissiveIntensity: 0.6,
    });
    for (const side of [-1, 1]) {
      const strip = new THREE.BoxGeometry(0.5, 0.05, GAP * 2);
      tileBoxUVs(strip, 0.5, 0.05, GAP * 2, 0.6);
      add(strip, hazard, side * (HALF_W - 0.28), 0.03, 0, false);
    }

    // The refit terminal's screen, and the reason it is emissive rather than lit:
    // lights are a budget of four and a PointLight at intensity zero costs a standard
    // material exactly as much as one at full brightness. Glow that does not need to
    // illuminate anything is emissive plus bloom, which is free.
    //
    // It has to be findable in the dark specifically because it is now the only way to
    // buy anything. A console the player cannot locate is worse than the timing rule it
    // replaced -- at least a panel that appears on its own is impossible to miss.
    const screenMat = new THREE.MeshStandardMaterial({
      color: 0x0d2a33, roughness: 0.35, metalness: 0.1,
      emissive: 0x49d8ff, emissiveIntensity: 1.4,
    });
    // Set into the console's top face at 20 degrees, tilted INBOARD so the display faces
    // the walkway you approach along rather than the railing. Rotated about Z rather than
    // X because the cabinet runs fore-and-aft along the bridge's outboard edge.
    const screen = add(new THREE.BoxGeometry(0.5, 1.6, 0.06), screenMat, 3.98, 2.02, -7.65, false);
    screen.rotation.x = Math.PI / 2;
    screen.rotation.y = -0.35;
    this.terminalScreen = screen;
    // A hooded surround, so the glow reads as coming out of something.
    add(new THREE.BoxGeometry(0.5, 0.08, 1.8), mastMat, 3.84, 2.24, -7.65, false);

    // Slung cables from the mast head to bow and stern. Catenary, because a
    // straight line between two towers looks like a mistake.
    const cableMat = new THREE.MeshStandardMaterial({ color: 0x2a2b30, roughness: 0.9 });
    for (const [from, to, sag] of [
      [new THREE.Vector3(0, 8.4, -1.0), new THREE.Vector3(0, 2.1, -11.0), 1.1],
      [new THREE.Vector3(0, 8.4, 1.0), new THREE.Vector3(0, 2.7, 11.4), 1.4],
      [new THREE.Vector3(-1.2, 8.2, 0), new THREE.Vector3(-HALF_W + 0.4, 1.1, -6.0), 0.8],
      [new THREE.Vector3(1.2, 8.2, 0), new THREE.Vector3(HALF_W - 0.4, 1.1, 6.0), 0.8],
    ]) {
      const pts = [];
      for (let i = 0; i <= 10; i++) {
        const t = i / 10;
        const p = from.clone().lerp(to, t);
        p.y -= Math.sin(t * Math.PI) * sag;
        pts.push(p);
      }
      const curve = new THREE.CatmullRomCurve3(pts);
      const cable = new THREE.Mesh(new THREE.TubeGeometry(curve, 12, 0.045, 5, false), cableMat);
      cable.castShadow = false;
      this.group.add(cable);
    }

    // The reactor's own light, and the only point light in the game. A glowing box
    // that does not light anything around it reads as painted; this is what makes
    // the core feel like a power source and doubles as the failure readout when it
    // dims.
    //
    // 14 rather than 26. Point-light intensity is in candela and falls off with the
    // square of distance, so 26 at a metre was washing out the deck plating around
    // the core -- part of the same over-bright chain as the sun and the sky. The
    // bloom pass supplies the glow; the light only has to supply the falloff.
    this.reactorLight = new THREE.PointLight(0x63e06a, 14, 20, 2);
    this.reactorLight.position.set(0, 1.6, 5);
    this.group.add(this.reactorLight);

    // Under-hull work lights, dark until the FLOODLIGHTS module is fitted. The
    // arena beneath the fortress is meant to be gloomy -- that is half of why it
    // is unpleasant -- so these start off and are something you choose to buy.
    //
    // Built but NOT ADDED TO THE SCENE. A light at intensity zero still occupies a
    // shader slot and still costs per-pixel work in every standard material, so
    // three of them sitting dark were being paid for by every surface in the game.
    // `setFloodlights()` attaches and detaches them instead, which is also what
    // makes fitting the module a single recompile rather than a permanent tax.
    this.floodlights = [];
    for (const z of [-7, 0, 7]) {
      const light = new THREE.SpotLight(0xfff0c8, 0, 18, 0.95, 0.5, 1.6);
      light.position.set(0, -HULL_DEPTH - 0.2, z);
      light.target.position.set(0, -CFG.trampler.deckHeight, z);
      this.floodlights.push(light);
    }
    this.floodlightsOn = false;
  }

  /**
   * Attach or detach the under-hull work lights.
   *
   * Adding and removing rather than dimming, because three.js counts lights by
   * presence: a SpotLight at intensity 0 costs exactly as much per pixel as one at
   * full brightness.
   */
  setFloodlights(on, intensity = 90) {
    if (on === this.floodlightsOn) return;
    this.floodlightsOn = on;
    for (const light of this.floodlights) {
      light.intensity = on ? intensity : 0;
      if (on) {
        this.group.add(light);
        this.group.add(light.target);
      } else {
        this.group.remove(light);
        this.group.remove(light.target);
      }
    }
  }

  // Authored attach points. One of the real design questions this prototype
  // exists to settle: free-surface grapple everywhere, or only these?
  #buildHardpoints() {
    const geo = new THREE.SphereGeometry(0.42, 14, 10);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x1b3b46,
      emissive: 0x49d8ff,
      emissiveIntensity: 1.5,
      roughness: 0.4,
    });

    const spots = [];
    for (const z of [-9.5, -3.5, 3.5, 9.5]) {
      spots.push([-HALF_W - 0.15, -1.5, z], [HALF_W + 0.15, -1.5, z]);
    }
    // Two boarding beacons at the railing gaps, set well INBOARD of the hull
    // edge. An anchor flush with the edge drops you alongside the hull with
    // nothing under your feet; pulling to a point over the deck actually
    // boards you.
    spots.push([-(HALF_W - 2.2), RAIL_H + 0.6, 0], [HALF_W - 2.2, RAIL_H + 0.6, 0]);
    // One under the nest, so the high perch is reachable.
    spots.push([0, 8.3, 3.6]);

    for (const [x, y, z] of spots) {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.userData.hardpoint = true;
      this.group.add(m);
      this.grappleables.push(m);
      this.hardpoints.push(m);
    }
  }

  /**
   * Module hardpoints. Three of them, on the hull's OUTER flanks below the deck.
   *
   * Two reasons they are outboard rather than on the deck. Design: the bounded
   * build layer is supposed to give a run a readable silhouette, and a silhouette
   * is a thing you see from outside -- from the sand, which is where half the game
   * happens. Engineering: anything solid on the deck joins the mantle graph, and
   * a new 1.4 m ledge is exactly the sort of thing that quietly turns three
   * chained climbs into a route to the crow's nest, which invariant 3 forbids. So
   * module geometry carries no collider at all.
   */
  #buildSockets() {
    this.sockets = [];
    const spots = [
      [-(HALF_W + 0.5), -1.5, -6.5],
      [HALF_W + 0.5, -1.5, 0],
      [-(HALF_W + 0.5), -1.5, 6.5],
    ];

    const emptyMat = new THREE.MeshStandardMaterial({
      color: 0x3a3d44, roughness: 0.85, metalness: 0.3,
    });

    for (let i = 0; i < CFG.fortress.sockets; i++) {
      const [x, y, z] = spots[i % spots.length];
      const group = new THREE.Group();
      group.position.set(x, y, z);
      this.group.add(group);

      // An empty cradle, so the player can see there is somewhere to put things.
      const cradle = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 2.6), emptyMat);
      cradle.castShadow = true;
      group.add(cradle);

      const fitted = new THREE.Group();
      fitted.visible = false;
      group.add(fitted);

      this.sockets.push({ group, cradle, fitted, moduleId: null, side: Math.sign(x) });
    }
  }

  /**
   * Bolt a module's geometry into a socket. Purely cosmetic -- the effects live in
   * src/modules.js -- but it is the cosmetic half that makes the bounded build
   * layer legible from the ground.
   */
  fitSocketMesh(index, moduleId) {
    const socket = this.sockets[index];
    if (!socket) return;

    socket.moduleId = moduleId;
    socket.fitted.clear();
    socket.fitted.visible = true;
    socket.cradle.visible = false;

    const metal = Look.std("mast", { color: 0x7a7f88, roughness: 0.68, metalness: 0.4 });
    const hot = (color) => new THREE.MeshStandardMaterial({
      color: 0x1b2b33, emissive: color, emissiveIntensity: 1.3, roughness: 0.4,
    });
    const out = socket.side;

    const add = (geo, mat, x, y, z) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = true;
      socket.fitted.add(m);
      return m;
    };

    add(new THREE.BoxGeometry(0.7, 1.6, 2.7), metal, 0, 0, 0);

    switch (moduleId) {
      case "floodlights":
        for (const z of [-0.8, 0, 0.8]) {
          add(new THREE.CylinderGeometry(0.26, 0.3, 0.2, 10), hot(0xfff0c8), out * 0.4, -0.5, z)
            .rotation.z = out * 1.3;
        }
        break;
      case "emitterRack":
        for (const z of [-0.85, 0, 0.85]) {
          add(new THREE.SphereGeometry(0.2, 10, 8), hot(0x49d8ff), out * 0.42, 0.4, z);
          add(new THREE.CylinderGeometry(0.07, 0.07, 0.7, 6), metal, out * 0.42, -0.15, z);
        }
        break;
      case "ammoHoist":
        add(new THREE.BoxGeometry(0.5, 0.9, 1.9), metal, out * 0.5, 0.3, 0);
        for (const z of [-0.6, 0, 0.6]) {
          add(new THREE.CylinderGeometry(0.16, 0.16, 0.5, 8), hot(0xffb347), out * 0.5, -0.5, z)
            .rotation.z = Math.PI / 2;
        }
        break;
      case "baffles":
        for (let i = 0; i < 5; i++) {
          add(new THREE.BoxGeometry(0.9, 0.1, 2.4), metal, out * 0.5, -0.6 + i * 0.32, 0)
            .rotation.z = out * -0.5;
        }
        break;
      case "actuators":
        add(new THREE.CylinderGeometry(0.3, 0.3, 2.2, 10), metal, out * 0.3, -0.2, 0)
          .rotation.x = Math.PI / 2;
        add(new THREE.TorusGeometry(0.34, 0.1, 6, 12), hot(0xff7a3a), out * 0.3, -0.2, 1.1)
          .rotation.y = Math.PI / 2;
        break;
      case "casing":
        add(new THREE.BoxGeometry(0.55, 1.9, 3.0), metal, out * 0.35, 0.1, 0);
        add(new THREE.BoxGeometry(0.2, 0.5, 2.0), hot(0x63e06a), out * 0.62, 0.1, 0);
        break;
      default:
        break;
    }
  }

  /** Strip every socket back to empty. Part of a run reset. */
  clearSocketMeshes() {
    for (const s of this.sockets ?? []) {
      s.moduleId = null;
      s.fitted.clear();
      s.fitted.visible = false;
      s.cradle.visible = true;
    }
  }

  // Cosmetic legs on an alternating tripod gait. They carry no collision and
  // are not grappleable: the visible mechanism moves around the fixed gameplay
  // foot point, so anchoring a grapple to any part of it would drift.
  //
  // Every repeated part is instanced. The previous four independent meshes per
  // leg made a simple silhouette expensive; this version can afford a hip yoke,
  // paired load arms, two joints, a foot sole and a working hydraulic ram in
  // fewer calls than the old straight thigh/shin assembly.
  #buildLegs(mat) {
    this.legs = [];

    const jointMat = Look.std("mast", {
      color: 0x777d86, roughness: 0.52, metalness: 0.55,
    });
    const mechanismMat = Look.std("hull", {
      color: 0x30343a, roughness: 0.82, metalness: 0.35,
    });
    const rodMat = Look.std("mast", {
      color: 0xaeb4bc, roughness: 0.36, metalness: 0.55,
    });

    const instanced = (name, geometry, material, count, castShadow) => {
      const mesh = new THREE.InstancedMesh(geometry, material, count);
      mesh.name = `trampler_leg_${name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = castShadow;
      mesh.receiveShadow = true;
      // The instances move outside the source geometry's local bounds. Eight
      // always-visible banks are cheaper and safer than rebuilding all eight
      // bounding spheres on every gait frame.
      mesh.frustumCulled = false;
      this.group.add(mesh);
      return mesh;
    };

    const hipGeo = new THREE.BoxGeometry(1.7, 1.35, 2.2);
    tileBoxUVs(hipGeo, 1.7, 1.35, 2.2, 1.1);
    const upperGeo = new THREE.BoxGeometry(0.62, 3.4, 0.48);
    tileBoxUVs(upperGeo, 0.62, 3.4, 0.48, 1.1);
    const lowerGeo = new THREE.BoxGeometry(0.72, 2.5, 0.62);
    tileBoxUVs(lowerGeo, 0.72, 2.5, 0.62, 1.1);
    const footGeo = new THREE.BoxGeometry(2.2, 0.55, 2.9);
    tileBoxUVs(footGeo, 2.2, 0.55, 2.9, 1.1);
    const soleGeo = new THREE.BoxGeometry(2.32, 0.16, 3.02);
    tileBoxUVs(soleGeo, 2.32, 0.16, 3.02, 1.1);

    this.legVisuals = {
      hip: instanced("hips", hipGeo, mat, CFG.trampler.legCount, true),
      // Two parallel arms per leg make the load path read as a yoke rather than
      // as one thin stick passing through a knee.
      upper: instanced("upper_arms", upperGeo, mat, CFG.trampler.legCount * 2, true),
      lower: instanced("lower_arms", lowerGeo, mat, CFG.trampler.legCount * 2, true),
      // Hip, knee and ankle pins share one bank.
      joint: instanced(
        "joint_pins",
        new THREE.CylinderGeometry(0.5, 0.5, 1.25, 10),
        jointMat,
        CFG.trampler.legCount * 3,
        false,
      ),
      foot: instanced("feet", footGeo, mat, CFG.trampler.legCount, true),
      sole: instanced("soles", soleGeo, mechanismMat, CFG.trampler.legCount, false),
      ram: instanced(
        "ram_barrels",
        new THREE.CylinderGeometry(0.19, 0.19, 2, 8),
        mechanismMat,
        CFG.trampler.legCount,
        false,
      ),
      rod: instanced(
        "ram_rods",
        new THREE.CylinderGeometry(0.10, 0.10, 2, 8),
        rodMat,
        CFG.trampler.legCount,
        false,
      ),
    };

    this.legVisualList = Object.values(this.legVisuals);

    // How many consecutive instances in each bank belong to one leg. This is
    // what lets one broken leg darken without giving up instancing.
    this.legColorBanks = [
      [this.legVisuals.hip, 1],
      [this.legVisuals.upper, 2],
      [this.legVisuals.lower, 2],
      [this.legVisuals.joint, 3],
      [this.legVisuals.foot, 1],
      [this.legVisuals.sole, 1],
      [this.legVisuals.ram, 1],
      [this.legVisuals.rod, 1],
    ];

    // Reused by the six-leg update. No vectors, matrices or quaternions are
    // allocated in the frame loop.
    this.legScratch = {
      hip: new THREE.Vector3(),
      knee: new THREE.Vector3(),
      ankle: new THREE.Vector3(),
      foot: new THREE.Vector3(),
      a: new THREE.Vector3(),
      b: new THREE.Vector3(),
      ramTop: new THREE.Vector3(),
      ramBottom: new THREE.Vector3(),
      ramSplit: new THREE.Vector3(),
      mid: new THREE.Vector3(),
      direction: new THREE.Vector3(),
      up: new THREE.Vector3(0, 1, 0),
      scale: new THREE.Vector3(1, 1, 1),
      matrix: new THREE.Matrix4(),
      quaternion: new THREE.Quaternion(),
      partQuaternion: new THREE.Quaternion(),
      jointQuaternion: new THREE.Quaternion().setFromAxisAngle(
        new THREE.Vector3(1, 0, 0), Math.PI / 2,
      ),
      euler: new THREE.Euler(),
      color: new THREE.Color(),
    };

    let i = 0;
    for (const side of [-1, 1]) {
      for (const z of [-8.5, 0, 8.5]) {
        // Kept as the public leg record even though the visible pieces are in
        // shared instance banks. Tests and repair labels read side, z and the
        // fixed stomp point from this object; none of those contracts move.
        const pivot = new THREE.Group();
        pivot.position.set(side * (HALF_W - 0.6), -HULL_DEPTH + 0.4, z);
        this.group.add(pivot);

        // Alternating tripod: every other leg swings in phase.
        pivot.userData.phase = (i % 2 === 0) ? 0 : Math.PI;
        pivot.userData.baseY = pivot.position.y;
        pivot.userData.side = side;
        pivot.userData.z = z;
        // Foot centre in hull-local space, which is what the STOMP is measured
        // from. The cosmetic foot moves through a stride but lands exactly here.
        // x remains +/-9.9 -- outboard of the hull and unreachable from a chewer
        // latched at +/-7.0, preserving invariant 2c.
        pivot.userData.footLocal = new THREE.Vector3(
          side * (HALF_W - 0.6 + 2.5),
          -CFG.trampler.deckHeight + 0.3,
          z,
        );
        pivot.userData.lifted = false;
        this.legs.push(pivot);
        i++;
      }
    }

    for (let leg = 0; leg < this.legs.length; leg++) this.#legMaterial(leg);
    this.#animateLegs();
    this.#buildClimbPoints();
  }

  // Authored boarding routes for enemies. Climbers do not path up a navmesh --
  // they ride a fixed local-space line from the hull's flank to the deck edge,
  // which means the route tracks the walking hull for free and costs nothing.
  #buildClimbPoints() {
    this.climbRoutes = [];
    const groundY = -CFG.trampler.deckHeight + CFG.enemies.climber.height / 2;
    const deckY = CFG.enemies.climber.height / 2;

    for (const side of [-1, 1]) {
      for (const z of [-9, -3, 3, 9]) {
        this.climbRoutes.push({
          start: new THREE.Vector3(side * (HALF_W + 0.7), groundY, z),
          end: new THREE.Vector3(side * (HALF_W - 1.2), deckY, z),
        });
      }
    }
  }

  // ------------------------------------------------------------------ update

  update(dt) {
    // Last frame's inverse is what turns a world point into the local frame the
    // player was standing in before we move. Capture it before anything changes.
    this.prevMatrixInverse.copy(this.matrixInverse);
    this.prevPos.copy(this.group.position);
    const prevYaw = this.yaw;
    this.footfalls.length = 0;

    const factor = this.speedFactor();
    const speed = this.walking ? CFG.trampler.speed * this.driveScale * factor : 0;

    // Gait freezes completely when immobilised -- a fortress that has lost its
    // tripod should look dead, not idling.
    this.time += factor <= 0
      ? 0
      : dt * (0.25 + (speed / Math.max(CFG.trampler.speed, 0.001)) * 0.75);

    // Turning needs legs too. Without this an immobilised fortress pivots on the
    // spot, which looks wrong and quietly changes the fight: a rotating hull
    // sweeps the leg attack points, so chewers never settle.
    if (this.turning && factor > 0) {
      // Steer toward a carrot point further along the patrol ring.
      const p = this.group.position;
      const r = CFG.world.patrolRadius;
      const ang = Math.atan2(p.z, p.x) + 0.35;
      const dx = Math.cos(ang) * r - p.x;
      const dz = Math.sin(ang) * r - p.z;

      // Local forward is -Z, so a heading of (dx, dz) means yaw = atan2(-dx, -dz).
      const targetYaw = Math.atan2(-dx, -dz);

      let diff = targetYaw - this.yaw;
      while (diff > Math.PI) diff -= Math.PI * 2;
      while (diff < -Math.PI) diff += Math.PI * 2;
      const maxStep = CFG.trampler.turnRate * this.turnScale * dt;
      this.yaw += Math.max(-maxStep, Math.min(maxStep, diff));
    }

    // Forward is -Z in local space, matching three.js convention.
    const fwd = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this.group.position.addScaledVector(fwd, speed * dt);
    this.group.rotation.y = this.yaw;

    this.group.position.y = CFG.trampler.deckHeight + (CFG.trampler.bob
      ? Math.sin(this.time * CFG.trampler.bobSpeed * Math.PI * 2) * CFG.trampler.bobAmount
      : 0);

    this.#animateLegs();
    this.#animateMachinery(dt);

    this.group.updateMatrixWorld(true);
    this.matrix.copy(this.group.matrixWorld);
    this.matrixInverse.copy(this.matrix).invert();

    if (dt > 0) {
      this.linVel.subVectors(this.group.position, this.prevPos).divideScalar(dt);
      this.yawRate = (this.yaw - prevYaw) / dt;
    }
    this.yawDelta = this.yaw - prevYaw;
  }

  #setLegPart(mesh, index, position, quaternion, scale) {
    this.legScratch.matrix.compose(position, quaternion, scale);
    mesh.setMatrixAt(index, this.legScratch.matrix);
  }

  /** Place a Y-axis-aligned part between two hull-local points. */
  #setLegSegment(mesh, index, from, to, baseLength) {
    const s = this.legScratch;
    s.direction.subVectors(to, from);
    const length = Math.max(0.001, s.direction.length());
    s.direction.multiplyScalar(1 / length);
    s.mid.addVectors(from, to).multiplyScalar(0.5);
    s.quaternion.setFromUnitVectors(s.up, s.direction);
    s.scale.set(1, length / baseLength, 1);
    this.#setLegPart(mesh, index, s.mid, s.quaternion, s.scale);
  }

  #animateLegs() {
    const cycle = this.time * CFG.trampler.gaitSpeed * Math.PI * 2;
    const factor = this.speedFactor();
    const speed = this.walking ? CFG.trampler.speed * this.driveScale * factor : 0;
    // Match update()'s gait clock exactly. During stance the foot travels aft in
    // hull space by the distance the hull travels forward, making it look planted
    // without moving the gameplay transform or the fixed stomp point.
    const timeScale = factor <= 0
      ? 0
      : 0.25 + (speed / Math.max(CFG.trampler.speed, 0.001)) * 0.75;
    const gaitHz = CFG.trampler.gaitSpeed * timeScale;
    const stanceTravel = speed > 0 && gaitHz > 0 ? speed / (2 * gaitHz) : 0;
    const s = this.legScratch;
    const v = this.legVisuals;

    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];
      const u = leg.userData;
      const side = u.side;
      const broken = this.legHp[i] <= 0;
      let lifted = false;
      let footPitch = 0;
      let strideZ = 0;
      let lift = 0;
      let loadFlex = 0;

      if (broken) {
        // A dead mechanism folds outward and drags behind the chassis. Its fixed
        // gameplay foot remains where invariant 2c measures it; this is the
        // cosmetic limp that identifies the failed leg from across the arena.
        strideZ = 0.85;
        footPitch = -0.14;
        u.lifted = false;
      } else {
        const p = cycle + u.phase;
        const wrapped = ((p - Math.PI / 2) % (Math.PI * 2) + Math.PI * 2)
          % (Math.PI * 2);
        const stance = wrapped < Math.PI;

        if (stance) {
          const t = wrapped / Math.PI;
          // Linear in stance is deliberate: constant local travel cancels the
          // hull's nearly constant forward travel and keeps the sole planted.
          strideZ = stanceTravel * t;
          loadFlex = Math.sin(t * Math.PI) * 0.10;
        } else {
          const t = (wrapped - Math.PI) / Math.PI;
          const eased = t * t * (3 - 2 * t);
          strideZ = stanceTravel * (1 - eased);
          lift = Math.sin(t * Math.PI) * 0.58;
          footPitch = Math.sin(t * Math.PI) * 0.12;
          lifted = true;
        }
      }

      s.hip.set(
        side * (HALF_W - 0.35),
        -HULL_DEPTH + 0.35,
        u.z,
      );
      s.foot.set(
        broken ? side * (HALF_W + 2.75) : u.footLocal.x,
        u.footLocal.y + 0.13 + lift,
        u.z + strideZ,
      );
      s.knee.set(
        side * (broken ? HALF_W + 2.9 : HALF_W + 2.35 + lift * 0.10),
        broken ? -5.05 : -4.35 - loadFlex + lift * 0.18,
        u.z + strideZ * (broken ? 0.5 : 0.46),
      );
      s.ankle.set(
        s.foot.x,
        s.foot.y + 0.44,
        s.foot.z - 0.05,
      );

      // A broad hip casting visually carries the hull into the paired upper arms.
      s.a.set(side * (HALF_W - 0.05), -HULL_DEPTH + 0.42, u.z);
      s.partQuaternion.identity();
      s.scale.set(1, 1, 1);
      this.#setLegPart(v.hip, i, s.a, s.partQuaternion, s.scale);

      for (let beam = 0; beam < 2; beam++) {
        const offset = beam === 0 ? -0.34 : 0.34;
        s.a.copy(s.hip);
        s.b.copy(s.knee);
        s.a.z += offset;
        s.b.z += offset;
        this.#setLegSegment(v.upper, i * 2 + beam, s.a, s.b, 3.4);

        const lowerOffset = beam === 0 ? -0.25 : 0.25;
        s.a.copy(s.knee);
        s.b.copy(s.ankle);
        s.a.z += lowerOffset;
        s.b.z += lowerOffset;
        this.#setLegSegment(v.lower, i * 2 + beam, s.a, s.b, 2.5);
      }

      // Three transverse pins make the articulation readable even in silhouette.
      s.scale.set(1.15, 1.42, 1.15);
      this.#setLegPart(v.joint, i * 3, s.hip, s.jointQuaternion, s.scale);
      s.scale.set(1.05, 1.35, 1.05);
      this.#setLegPart(v.joint, i * 3 + 1, s.knee, s.jointQuaternion, s.scale);
      s.scale.set(0.72, 1.08, 0.72);
      this.#setLegPart(v.joint, i * 3 + 2, s.ankle, s.jointQuaternion, s.scale);

      // The foot and dark contact sole remain separate value masses. On a live
      // leg they pitch only during swing; a broken one also rolls outward.
      s.euler.set(footPitch, 0, broken ? side * 0.18 : 0);
      s.partQuaternion.setFromEuler(s.euler);
      s.scale.set(1, 1, 1);
      this.#setLegPart(v.foot, i, s.foot, s.partQuaternion, s.scale);
      s.a.copy(s.foot);
      s.a.y -= 0.355;
      this.#setLegPart(v.sole, i, s.a, s.partQuaternion, s.scale);

      // A telescoping ram crosses the knee. Barrel and polished rod overlap a
      // little so flexing the joint changes their visible extension rather than
      // stretching one decorative cylinder.
      s.ramTop.lerpVectors(s.hip, s.knee, 0.20);
      s.ramTop.z += 0.62;
      s.ramBottom.lerpVectors(s.knee, s.ankle, 0.62);
      s.ramBottom.z += 0.62;
      s.ramSplit.lerpVectors(s.ramTop, s.ramBottom, 0.62);
      this.#setLegSegment(v.ram, i, s.ramTop, s.ramSplit, 2);
      s.a.lerpVectors(s.ramTop, s.ramBottom, 0.52);
      this.#setLegSegment(v.rod, i, s.a, s.ramBottom, 2);

      // A footfall is the transition from swing to stance. The visual sole lands
      // exactly at u.footLocal on this edge, so dust, stomp gameplay and the model
      // agree without moving any simulation coordinate.
      if (!broken && u.lifted && !lifted) {
        this.footfalls.push({ leg: i, local: u.footLocal });
        this.stepCount++;
      }
      u.lifted = lifted;
    }

    for (const mesh of this.legVisualList) mesh.instanceMatrix.needsUpdate = true;
  }

  #animateMachinery(dt) {
    const drive = this.speedFactor();
    for (const fan of this.fans ?? []) fan.rotation.z += dt * (2 + drive * 14);
    if (this.reactorLight) {
      const frac = this.reactorHp / this.maxReactorHp;
      // Flicker harder as it fails. The light is the stakes.
      const flicker = frac < 0.4 ? 0.6 + 0.4 * Math.sin(this.time * 40) : 1;
      this.reactorLight.intensity = 14 * (0.25 + frac * 0.75) * flicker;
      this.reactorLight.color.setHSL(0.33 * frac, 0.85, 0.5);
    }
  }

  /**
   * Apply this frame's footfalls to the world.
   *
   * Called by the game loop and by the harness immediately after update(), rather
   * than being done inside update() off stored references. The fortress does not
   * get to know about the horde or the player: keeping the coupling explicit is
   * what lets a test drive a stomp and assert on it directly, and it keeps the
   * frame order visible at the call site instead of buried three methods deep.
   *
   * The feet hurt the PLAYER and shove bodies. They deal no damage to enemies at
   * all -- see the stomp block in config.js for the measurement that settled it.
   * The short version: a foot that damaged enemies, even non-lethally, was enough
   * to let the fortress and three emitters hold the under-hull area unattended,
   * and an automated defence that holds a position is the one thing invariant 2b
   * forbids outright.
   */
  /**
   * @param crew a Crew, not a Player. The third and last of the crew-wide sites: a
   *        foot coming down crushes whoever is underneath it, and wired to one
   *        operative the other three could stand under a descending leg untouched.
   */
  resolveStomps(horde, crew) {
    this.lastStompHits = 0;
    this.playerStomped = false;
    if (this.footfalls.length === 0) return 0;

    const s = CFG.trampler.stomp;
    for (const fall of this.footfalls) {
      this.localToWorld(_footWorld.copy(fall.local));

      if (horde) {
        this.lastStompHits += horde.shoveFrom(
          _footWorld.x, _footWorld.z, s.radius, s.shoveSpeed,
        );
      }

      // An operative gets crushed, and this is the whole point of the feature: the
      // under-hull arena was dark but harmless, and a 26 m walker whose feet pass
      // through you is not a place that feels dangerous. Only on foot -- riding the
      // deck or manning a gun puts you above the machinery.
      //
      // Every member, with no break: unlike a chewer's swing there is no cooldown
      // being consumed here, so a foot landing on two people crushing both is simply
      // what a foot does. It also cannot inflate anything the invariants measured --
      // invariant 2c is that the feet deal no damage to ENEMIES, and this touches only
      // the crew.
      if (crew) {
        for (const p of crew) {
          if (!p || p.base !== null || p.station) continue;
          const dx = p.position.x - _footWorld.x;
          const dz = p.position.z - _footWorld.z;
          const dy = p.position.y - _footWorld.y;
          if (dx * dx + dz * dz < s.radius * s.radius && Math.abs(dy) < 2.6) {
            p.hurt(s.playerDamage);
            // Read by main.js to shake the camera, so it means "somebody was
            // stomped". Once each client predicts its own operative it will have to
            // mean "the LOCAL one was", or everybody's view shakes when one person is
            // crushed. Noted rather than fixed: there is no local operative yet.
            this.playerStomped = true;
          }
        }
      }
    }
    return this.lastStompHits;
  }

  // ------------------------------------------------------------------ damage

  brokenLegs() {
    let n = 0;
    for (const hp of this.legHp) if (hp <= 0) n++;
    return n;
  }

  workingLegs() {
    return this.legHp.length - this.brokenLegs();
  }

  /** True when too few legs remain to hold a tripod: a hard stop, not a limp. */
  get immobilised() {
    return this.workingLegs() < CFG.trampler.legsForWalking;
  }

  /** Reactor capacity, including the casing module. */
  get maxReactorHp() {
    return CFG.trampler.reactorHp * this.reactorScale;
  }

  /**
   * How many boarders can be in contact with the reactor at once. Never below
   * one: a reactor nothing can reach is a reactor that cannot be lost, and losing
   * it is the run.
   */
  get reactorSlotCount() {
    return Math.max(1, CFG.trampler.reactorSlots + this.slotBonus);
  }

  /**
   * Speed as a fraction of full. Degrades leg by leg, then drops to a hard zero
   * once a walking tripod is no longer possible.
   */
  speedFactor() {
    const need = CFG.trampler.legsForWalking;
    const working = this.workingLegs();
    if (working < need) return 0;
    return clamp((working - (need - 1)) / (this.legHp.length - (need - 1)), 0, 1);
  }

  /** Human-readable leg name, so a repair prompt can say which one. */
  legLabel(index) {
    const u = this.legs[index].userData;
    const side = u.side < 0 ? "PORT" : "STBD";
    const fore = u.z < -1 ? "FORE" : u.z > 1 ? "AFT" : "MID";
    return `${side} ${fore}`;
  }

  #legMaterial(index) {
    // Instance colour multiplies each bank's own material, so the failed leg can
    // go cold and dark without splitting eight shared banks back into one mesh
    // per part. Geometry and roughness stay coherent; the sag carries the state.
    const broken = this.legHp[index] <= 0;
    const tint = this.legScratch.color.setHex(broken ? 0x34373a : 0xffffff);
    for (const [mesh, perLeg] of this.legColorBanks) {
      const first = index * perLeg;
      for (let slot = 0; slot < perLeg; slot++) mesh.setColorAt(first + slot, tint);
      mesh.instanceColor.needsUpdate = true;
    }
  }

  damageLeg(index, amount) {
    if (this.legHp[index] <= 0) return false;
    this.legHp[index] = Math.max(0, this.legHp[index] - amount * this.damageScale);

    if (this.legHp[index] <= 0) {
      this.#legMaterial(index);
      return true; // just broke
    }
    return false;
  }

  /** Returns true if this repair brought a dead leg back into service. */
  repairLeg(index, amount) {
    const max = CFG.trampler.legHp;
    if (this.legHp[index] >= max) return false;

    const wasBroken = this.legHp[index] <= 0;
    this.legHp[index] = Math.min(max, this.legHp[index] + amount);

    if (wasBroken && this.legHp[index] > 0) {
      this.#legMaterial(index);
      return true;
    }
    return false;
  }

  #refreshReactorLook() {
    // Dim and redden as it fails, so the stakes are legible from across the deck.
    const frac = this.reactorHp / this.maxReactorHp;
    this.reactorMat.emissiveIntensity = 0.15 + frac * 0.85;
    this.reactorMat.emissive.setHSL(0.33 * frac, 0.85, 0.5);
  }

  damageReactor(amount) {
    if (this.destroyed) return;
    this.reactorHp = Math.max(0, this.reactorHp - amount * this.damageScale);
    this.#refreshReactorLook();
    if (this.reactorHp <= 0) this.destroyed = true;
  }

  repairReactor(amount) {
    if (this.destroyed || this.reactorHp >= this.maxReactorHp) return false;
    this.reactorHp = Math.min(this.maxReactorHp, this.reactorHp + amount);
    this.#refreshReactorLook();
    return true;
  }

  repairAll() {
    this.legHp.fill(CFG.trampler.legHp);
    this.reactorHp = this.maxReactorHp;
    this.destroyed = false;
    this.#refreshReactorLook();
    for (let i = 0; i < this.legs.length; i++) this.#legMaterial(i);
  }

  /**
   * Put the fortress back at its starting point on the patrol ring.
   *
   * Restarting an encounter has to rewind this too, not just the damage. Enemy
   * spawn bearings are computed from the hull's heading, so a restart that left
   * the fortress mid-patrol produced a measurably different fight from the same
   * seed -- which defeats the reason the seeds exist, namely being able to
   * compare two attempts at the same wave.
   */
  resetPose() {
    const r = CFG.world.patrolRadius;
    this.group.position.set(r, CFG.trampler.deckHeight, 0);
    this.yaw = Math.PI;
    this.yawRate = 0;
    this.yawDelta = 0;
    this.group.rotation.y = this.yaw;
    this.group.updateMatrixWorld(true);
  }

  /**
   * Where an attacker plants itself to attack a leg: well INBOARD of the hull
   * edge, underneath the slab. The hull blocks line of sight straight down, so
   * this position cannot be shot from the deck. That is the point.
   *
   * `offset` is per enemy type, and defaults to the chewer's -- which is also the
   * REPAIR point, so the default must never move: at 5.9 it sat four metres
   * inboard of the visible foot and walking up to a damaged leg offered no prompt
   * at all. The titan passes a larger value because it is too tall to fit under
   * the hull and has to work from outside it.
   */
  legAttackLocal(index, out = new THREE.Vector3(), offset = CFG.enemies.chewer.inboardOffset) {
    const leg = this.legs[index];
    return out.set(
      leg.userData.side * offset,
      -CFG.trampler.deckHeight + CFG.enemies.chewer.height / 2,
      leg.userData.z,
    );
  }

  legAttackWorld(index, out = new THREE.Vector3(), offset = CFG.enemies.chewer.inboardOffset) {
    return this.localToWorld(this.legAttackLocal(index, out, offset));
  }

  /** World position of a leg's foot, for stomp effects and audio. */
  footWorld(index, out = new THREE.Vector3()) {
    return this.localToWorld(out.copy(this.legs[index].userData.footLocal));
  }

  reactorWorld(out = new THREE.Vector3()) {
    return this.localToWorld(out.copy(this.reactorLocal));
  }

  /** World position of the refit terminal, for the "are you standing at it" check. */
  terminalWorld(out = new THREE.Vector3()) {
    return this.localToWorld(out.copy(this.terminalLocal));
  }

  /**
   * Nearest point on the reactor's SURFACE to a world position.
   *
   * Attackers have to close on this rather than on the centre. The reactor is a
   * 5 x 2.4 x 4 box, so anything that stops within 2.4 m of its centre is
   * standing inside it -- and an enemy inside the reactor cannot be shot,
   * because the reactor's own mesh occludes every bullet aimed at it.
   */
  reactorSurfaceWorld(worldPos, out = new THREE.Vector3()) {
    const b = this.reactorBox;
    out.copy(worldPos);
    this.worldToLocal(out);
    out.set(
      clamp(out.x, b.min.x, b.max.x),
      clamp(out.y, b.min.y, b.max.y),
      clamp(out.z, b.min.z, b.max.z),
    );
    return this.localToWorld(out);
  }

  // ------------------------------------------------------------- transforms

  localToWorld(v) {
    return v.applyMatrix4(this.matrix);
  }

  worldToLocal(v) {
    return v.applyMatrix4(this.matrixInverse);
  }

  /**
   * Is this world point inside the hull's footprint -- that is, in the shadow the
   * deck cannot shoot into?
   *
   * One place, because this is the rule the pillar rests on. Emitter placement asks
   * it, and conditional items that pay out "while you are under the hull" ask it,
   * and those two answers drifting apart would mean a player standing somewhere the
   * game considers under the hull for one purpose and not the other. Does not copy:
   * pass a scratch vector you own.
   */
  coversPoint(v) {
    this.worldToLocal(v);
    return Math.abs(v.x) <= this.halfW && Math.abs(v.z) <= this.halfL;
  }

  /** World point -> the local frame as it was before this frame's movement. */
  worldToPrevLocal(v) {
    return v.applyMatrix4(this.prevMatrixInverse);
  }

  /**
   * Velocity of the hull at a given world point: linear plus the tangential
   * component from yaw rotation. This is what makes stepping off a moving,
   * turning fortress carry the momentum you expect instead of yanking you.
   */
  velocityAt(worldPoint, out = new THREE.Vector3()) {
    const rx = worldPoint.x - this.group.position.x;
    const rz = worldPoint.z - this.group.position.z;
    // omega = (0, yawRate, 0); omega x r = (yawRate*rz, 0, -yawRate*rx)
    out.set(
      this.linVel.x + this.yawRate * rz,
      this.linVel.y,
      this.linVel.z - this.yawRate * rx,
    );
    return out;
  }

  /**
   * Open deck amidships, port side. Must stay clear of every collider: the
   * previous spot at (0, 1.2, 6) ended up INSIDE the reactor once that was
   * added, so every respawn silently shoved the player aft to squeeze out of it.
   */
  deckSpawn(out = new THREE.Vector3()) {
    return this.localToWorld(out.set(-4.5, 1.2, 0));
  }

  /** A spot on the ground ahead of the hull, so it walks toward you. */
  groundAhead(distance = 34, out = new THREE.Vector3()) {
    this.localToWorld(out.set(0, 0, -HALF_L - distance));
    out.y = 1.2;
    return out;
  }
}
