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
    }

    this.#buildDetail(rand, hullMat, mastMat, trimMat);
    this.#buildHardpoints();
    this.#buildSockets();
    this.#buildLegs(legMat);
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
  // are not grappleable: they move independently of the local transform that
  // grapple anchors are stored in, so anchoring to them would drift.
  #buildLegs(mat) {
    this.legs = [];
    const reach = CFG.trampler.deckHeight - HULL_DEPTH; // hull bottom to ground
    let i = 0;

    for (const side of [-1, 1]) {
      for (const z of [-8.5, 0, 8.5]) {
        const pivot = new THREE.Group();
        pivot.position.set(side * (HALF_W - 0.6), -HULL_DEPTH + 0.4, z);
        this.group.add(pivot);

        const thighGeo = new THREE.BoxGeometry(2.6, 0.9, 0.9);
        tileBoxUVs(thighGeo, 2.6, 0.9, 0.9, 1.1);
        const thigh = new THREE.Mesh(thighGeo, mat);
        thigh.position.set(side * 1.3, -0.5, 0);
        thigh.rotation.z = side * -0.45;
        thigh.castShadow = true;
        pivot.add(thigh);

        const shinGeo = new THREE.BoxGeometry(0.7, reach, 0.7);
        tileBoxUVs(shinGeo, 0.7, reach, 0.7, 1.1);
        const shin = new THREE.Mesh(shinGeo, mat);
        shin.position.set(side * 2.5, -0.9 - reach / 2, 0);
        shin.castShadow = true;
        pivot.add(shin);

        const footGeo = new THREE.BoxGeometry(1.8, 0.5, 2.4);
        tileBoxUVs(footGeo, 1.8, 0.5, 2.4, 1.1);
        const foot = new THREE.Mesh(footGeo, mat);
        foot.position.set(side * 2.5, -0.9 - reach, 0);
        foot.castShadow = true;
        pivot.add(foot);

        // Hydraulic ram across the knee. Reads as "this thing is driven", and it
        // gives the gait something to visibly work against.
        const ram = new THREE.Mesh(
          new THREE.CylinderGeometry(0.14, 0.14, 1.5, 8),
          Look.std("mast", { color: 0x9aa0aa, roughness: 0.4, metalness: 0.8 }),
        );
        ram.position.set(side * 1.9, -0.75, 0.55);
        ram.rotation.x = 0.35;
        ram.castShadow = false;
        pivot.add(ram);

        // Alternating tripod: every other leg swings in phase.
        pivot.userData.phase = (i % 2 === 0) ? 0 : Math.PI;
        pivot.userData.baseY = pivot.position.y;
        pivot.userData.side = side;
        pivot.userData.z = z;
        pivot.userData.parts = [thigh, shin, foot];
        pivot.userData.ram = ram;
        // Foot centre in hull-local space, which is what the stomp is measured
        // from. x is +/-9.9 -- OUTBOARD of the 8 m hull half width, and that is
        // what makes stomping safe to add: it cannot reach the chewers latched at
        // +/-7.0, so the fortress can never clear its own attackers.
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

  #animateLegs() {
    const cycle = this.time * CFG.trampler.gaitSpeed * Math.PI * 2;
    for (let i = 0; i < this.legs.length; i++) {
      const leg = this.legs[i];

      if (this.legHp[i] <= 0) {
        // Dead leg: stops striding and sags outward. The limp is the damage
        // readout -- you should be able to see which leg went without a HUD.
        leg.rotation.x = -0.42;
        leg.rotation.z = leg.userData.side * 0.30;
        leg.position.y = leg.userData.baseY - 0.55;
        leg.userData.lifted = false;
        continue;
      }

      const p = cycle + leg.userData.phase;
      const raise = Math.max(0, Math.cos(p));
      leg.rotation.x = Math.sin(p) * 0.26;
      leg.rotation.z = 0;
      leg.position.y = leg.userData.baseY + raise * 0.30;
      leg.userData.ram.scale.y = 1 - raise * 0.22;

      // A footfall is the transition from lifted to planted. Detected as an edge
      // rather than sampled as a state, because a state test fires every frame the
      // foot is down -- which would make the "stomp" a permanent damage aura and
      // hand the fortress an automated defence it must not have.
      const lifted = raise > 0.12;
      if (leg.userData.lifted && !lifted) {
        this.footfalls.push({ leg: i, local: leg.userData.footLocal });
        this.stepCount++;
      }
      leg.userData.lifted = lifted;
    }
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
  resolveStomps(horde, player) {
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

      // The player gets crushed, and this is the whole point of the feature: the
      // under-hull arena was dark but harmless, and a 26 m walker whose feet pass
      // through you is not a place that feels dangerous. Only on foot -- riding the
      // deck or manning a gun puts you above the machinery.
      if (player && player.base === null && !player.station) {
        const dx = player.position.x - _footWorld.x;
        const dz = player.position.z - _footWorld.z;
        const dy = player.position.y - _footWorld.y;
        if (dx * dx + dz * dz < s.radius * s.radius && Math.abs(dy) < 2.6) {
          player.hurt(s.playerDamage);
          this.playerStomped = true;
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
    const broken = this.legHp[index] <= 0;
    const mat = broken
      ? (this.brokenLegMat ??= new THREE.MeshStandardMaterial({
          color: 0x24262a, roughness: 0.9, metalness: 0.1,
        }))
      : this.legMat;
    for (const part of this.legs[index].userData.parts) part.material = mat;
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
