import * as THREE from "three";
import { CFG, ENEMY_TYPE_KEYS, enemyCfg, afterArmour } from "./config.js";
import { makeRandom, clamp, lerp, smoothstep } from "./util.js";
import { Look, enemyGeometry, animateHorde } from "./look.js";

// Pooled horde on InstancedMesh with a spatial hash for separation.
//
// Built this way from the start on purpose. Retrofitting crowd tech onto a
// one-Object3D-per-enemy codebase is a rewrite, and the whole point of the
// Risk of Rain power curve is that late waves put a screen full of things in
// front of you to delete.
//
// SEVEN types now, and they exist to attack the pillar from seven different angles:
//
//   Chewers plant themselves INBOARD of the legs, underneath the hull slab.
//   The deck blocks line of sight straight down, so they cannot be shot from
//   up top. They are the reason to dismount.
//
//   Climbers board via authored routes and go for the reactor. They are the
//   reason not to stay down there.
//
//   Bulwarks are armoured past the point where a rifle is a sensible answer, so
//   they have to be killed at range. They are the reason the deck gun still
//   matters after the first ten seconds of a wave.
//
//   Burrowers travel underground and surface beneath the hull, so the under-hull
//   area refills with things that never crossed a firing line. They are the
//   reason camping a gun is not a strategy.
//
//   Sappers deal no contact damage at all. They plant a charge worth exactly one
//   leg and light a fuse. They are the reason to go down there RIGHT NOW.
//
//   Spikers brace outside the hull and fire at exposed operatives, preferring a
//   manned station. They are the reason the deck gun is powerful rather than safe.
//
//   The titan is 5.2 m tall against 4.5 m of hull clearance, so it cannot get
//   underneath and has to work from outboard, in the open, where both guns can
//   see it. It is the one fight that inverts the pillar.
//
// Type ids are indices into ENEMY_TYPE_KEYS, and every per-type number comes from
// `enemyCfg(type)`. There are no `type === CHEWER ? a : b` ternaries left: that
// pattern is how a new type silently inherits the wrong numbers.

export const CHEWER = 0;
export const CLIMBER = 1;
export const BULWARK = 2;
export const BURROWER = 3;
export const SAPPER = 4;
export const TITAN = 5;
export const SPIKER = 6;

const S = {
  HUNT_LEG: 0,
  TO_CLIMB: 1,
  CLIMBING: 2,
  ON_DECK: 3,
  // Underground: driven toward the leg, untouchable, and not counted as pressure
  // because there is nothing the crew can do about it yet.
  BURROWED: 4,
  TO_FIRE_RING: 5,
  CHARGING: 6,
  // The state still owns the stationary release beat and cooldown boundary. Shot
  // presentation is carried separately by a persistent release event, so neither a
  // catch-up batch nor snapshot interpolation can consume the visual before rendering.
  FIRING: 7,
};

export { S as ENEMY_STATE };

/**
 * Is this body underground, and therefore untouchable by ANYTHING?
 *
 * Exported as a predicate rather than left to each caller to write out, because the
 * obvious spelling of the test — `e.burrowed` — is wrong and fails silently. There is
 * no per-enemy `burrowed` flag; `horde.burrowed` is a COUNT, and `e.burrowed` is
 * therefore always `undefined`, which is falsy, which means "not underground". Three
 * separate call sites guessed that field name and every one of them read as a working
 * exclusion while excluding nothing.
 *
 * Two of those were real bugs that shipped: fragmentation splash and the arc chain both
 * skipped their burrowed check and could damage a submerged enemy, which is invariant
 * 8's "the one type that cannot be shot cannot stay that way" read backwards — it cannot
 * be shot, but a proc could reach it. Nothing tested it because the shot path has its
 * own guard and the tests followed the shot.
 *
 * Same argument as the event bus using named methods over a string-keyed map: a
 * misspelled channel fails silently in both directions, so make the mistake a
 * `TypeError`. A typo'd import is a load error; a typo'd property is a wrong answer.
 */
export const isSubmerged = (e) => e.state === S.BURROWED;

/**
 * Did `operative` cause this damage? The ONLY question anything may ask of a source.
 *
 * Exported for the same reason `isSubmerged` is: the obvious hand-written spellings are
 * both wrong, and both wrong silently.
 *
 *   `source === "player"`   was right with one operative and names a KIND, not a person,
 *                           so with a crew it fires every operative's procs off every
 *                           other operative's kills.
 *   `source !== null`       satisfies invariant 2b -- automation is excluded -- and has
 *                           exactly the same bug, which is why it is the tempting one.
 *
 * Both questions collapse into one identity test, and that is not a coincidence to be
 * relied on quietly: "this operative caused it" excludes automation as a side effect,
 * because no subsystem is ever equal to a Player. The `!!operative` guard is what stops
 * that collapsing the other way -- with no operative to compare against, an unattributed
 * source must not match an absent one.
 */
export const causedBy = (source, operative) => !!operative && source === operative;

const _v = new THREE.Vector3();
const _local = new THREE.Vector3();
// Their own, rather than borrowed from the two above. `_v` holds the reactor target
// during the state switch and is reused for the deck-edge probe after integration, so
// a module-level vector shared between two things that both run in one frame is a bug
// waiting for someone to reorder them.
const _flowProbe = new THREE.Vector3();
const _flowDir = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3(1, 1, 1);
const _flash = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
// Hoisted out of the instance-writing loop. Allocating this per enemy per frame
// is 400 Vector3s a frame at a full pool, and test 17 pins the whole simulation
// step at well under a millisecond -- garbage is exactly how that budget goes.
const _yAxis = new THREE.Vector3(0, 1, 0);
// Combat history stores carried bodies in hull-local space, exactly like snapshots. One
// scratch conversion per body avoids allocating vectors in the 60 Hz recording/query loops.
const _combatLocal = new THREE.Vector3();
// Ranged-shot scratch. Separate from `_v`/`_local`: target acquisition raycasts once
// per operative and the instance writer also needs the last resolved segment, so sharing
// either of the state-machine vectors would make the result depend on call order.
const _shotStart = new THREE.Vector3();
const _shotEnd = new THREE.Vector3();
const _shotDir = new THREE.Vector3();
const _shotMid = new THREE.Vector3();
const _shotQ = new THREE.Quaternion();
const _shotScale = new THREE.Vector3();
const _shotMatrix = new THREE.Matrix4();

const COMBAT_PRESENT = 1;
const COMBAT_CARRIED = 2;
const COMBAT_SUBMERGED = 4;
const GENERATION_MAX = 0xffff;

/** Allocate one fixed-capacity pose frame. Called only while constructing the Horde. */
function combatFrame(size) {
  return {
    tick: -1,
    generation: new Uint16Array(size),
    flags: new Uint8Array(size),
    x: new Float32Array(size),
    y: new Float32Array(size),
    z: new Float32Array(size),
    yaw: new Float32Array(size),
  };
}

// Wounded-tint resolution and its darkest step. Four bands is enough to answer the
// only question a crowd raises -- "which of these is nearly dead" -- and few enough
// that each step is unmistakable rather than a shade you have to compare. Kept here
// rather than in CFG because these are the shape of the visual effect, not a
// feel-relevant number anybody would tune in play, and CFG earns its weight from
// numbers that get argued about.
const TINT_BANDS = 4;
const TINT_FLOOR = 0.42;

// How far the deck routing field will look for a way back on when a body is standing
// somewhere the grid calls solid. Three cells is 1.2 m at the current resolution, which
// covers the only way this happens in practice -- resting against a face, so at most one
// cell deep. Kept here rather than in CFG because it is the shape of the mechanism, not
// a number anyone would tune for feel.
const FLOW_RESCUE_RINGS = 3;

/**
 * Does the 2D segment a->b touch `box` expanded by `r`? Slab test, x/z only.
 *
 * Scalars in, boolean out, no allocation: this runs per boarder per frame and test 17
 * pins the whole simulation step under a millisecond.
 */
function segmentHitsBox(ax, az, bx, bz, box, r) {
  const minX = box.min.x - r;
  const maxX = box.max.x + r;
  const minZ = box.min.z - r;
  const maxZ = box.max.z + r;

  let t0 = 0;
  let t1 = 1;

  const dx = bx - ax;
  if (Math.abs(dx) < 1e-9) {
    if (ax <= minX || ax >= maxX) return false;
  } else {
    let n = (minX - ax) / dx;
    let f = (maxX - ax) / dx;
    if (n > f) { const sw = n; n = f; f = sw; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }

  const dz = bz - az;
  if (Math.abs(dz) < 1e-9) {
    if (az <= minZ || az >= maxZ) return false;
  } else {
    let n = (minZ - az) / dz;
    let f = (maxZ - az) / dz;
    if (n > f) { const sw = n; n = f; f = sw; }
    if (n > t0) t0 = n;
    if (f < t1) t1 = f;
    if (t0 > t1) return false;
  }

  return true;
}

/** Uniform spatial hash. Only used for neighbour separation, so hash
 *  collisions are harmless -- a false neighbour is a negligible extra nudge. */
class Grid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }

  key(x, z) {
    const cx = Math.floor(x / this.cell);
    const cz = Math.floor(z / this.cell);
    return (cx * 92837111) ^ (cz * 689287499);
  }

  clear() {
    this.map.clear();
  }

  insert(i, x, z) {
    const k = this.key(x, z);
    const a = this.map.get(k);
    if (a) a.push(i);
    else this.map.set(k, [i]);
  }
}

export class Horde {
  constructor(scene, trampler, seed = CFG.enemies.seed) {
    this.trampler = trampler;
    this.seed = seed;

    // Spawn bearings and leg choices were on Math.random, which made the whole
    // simulation unreproducible. That is fine for a game and fatal for the test
    // harness: test 48 measures how long emitters delay an immobilisation, and
    // with random spawn arcs the same code produced 15.2s and 19.3s on
    // consecutive runs, so the assertion guarding invariant 2b was a coin flip.
    // Seeded per Horde, so every sim starts from the same stream.
    this.random = makeRandom(seed);

    this.liveCount = 0;
    this.underHull = 0;
    this.aboard = 0;
    this.burrowed = 0;
    this.cursor = 0;
    this.grid = new Grid(CFG.enemies.separation * 2);

    // Spiker sight and shot clipping uses the fortress half of the same bullet-solid
    // policy as Weapon. Railings stop bodies, not rounds; the hull slab and furniture
    // remain real cover. Kept here rather than adding World to the Horde signature.
    this.spikerRay = new THREE.Raycaster();
    this.spikerRay.near = 0.03;
    this.spikerHits = [];
    this.spikerOccluders = trampler.grappleables
      .filter((m) => m.userData.tag !== "rail");

    // A release is consequence AND presentation, but the two have different clocks.
    // Damage resolves immediately in #fireSpiker; this reset-scoped sequence and bounded
    // journal preserve the exact world-space segment until a rendered frame or snapshot can
    // consume it. Keeping it out of the enemy state is what lets FIRING retain its existing
    // movement/cooldown meaning without asking a 140 ms flag to survive 250 ms of catch-up.
    this.spikerShotSeq = 0;
    this.spikerShotJournal = [];

    // Presentation owns a separate queue. Network events are queued from newest authority
    // and drawn only after delayed body transforms have been applied; solo events are read
    // from the journal at that same once-per-render boundary.
    this.spikerShotPending = [];
    this.spikerShotActive = [];
    this.spikerShotSeenSeq = 0;
    // Null names the local journal. A numeric resetId names an authority generation and
    // causes the first snapshot of that generation to establish a baseline without replay.
    this.spikerShotResetId = null;

    // How boarders get to the reactor past the deck's furniture. Built once, here,
    // because the deck is static in HULL space -- which is the same property that lets
    // everything else aboard be stored in hull-local coordinates. Lives in the Horde
    // rather than the Trampler because it is keyed by enemy body size, and the fortress
    // deliberately holds no knowledge of the horde.
    this.deckFlow = this.#buildDeckFlow();

    // Counters, for audio and the HUD. Polling a counter keeps the simulation
    // unaware that a mixer or a particle system exists. `deathCount` includes unpaid
    // removals such as a detonating sapper; `killCount` remains paid kills only.
    this.killCount = 0;
    this.deathCount = 0;

    // The event bus, for the one thing a counter cannot carry: which enemy died.
    // Assigned by the owner rather than required, so a Horde can be built purely
    // to measure the scene graph.
    this.events = null;

    // Instance multipliers, owned by the run and by fortress modules. Never
    // written into CFG: a run's modifiers leaking into global config would
    // poison every later test in the same process, and make two attempts at the
    // same seeded wave incomparable.
    this.speedScale = 1;   // road modifier
    this.climbScale = 1;   // boarding baffles module
    this.revealScale = 1;  // floodlights module, cuts burrow time

    // The soonest fuse currently burning, for the HUD. A sapper is a timer, and a
    // timer nobody can see is just a random leg failure.
    this.fuseWarning = 0;
    this.fusesLit = 0;

    this.pool = new Array(CFG.enemies.max);
    for (let i = 0; i < CFG.enemies.max; i++) {
      this.pool[i] = {
        alive: false, generation: 0, type: CHEWER, hp: 0, maxHp: 1,
        // Which wounded-tint band was last written for this body. -1 means "not
        // written yet", which forces one upload on the frame it appears rather than
        // inheriting whatever the previous occupant of this pool slot looked like.
        tintBand: -1,
        // Where this body is in its walk cycle, so forty of them do not march in
        // step. Presentation only.
        //
        // FROM THE POOL INDEX, and that is the whole point rather than laziness.
        // Drawing it from CFG.enemies.seed would advance that stream, and invariant
        // 21 is that two runs of the same seed are the same fight -- a phase offset
        // nobody can perceive is not worth spending a draw on. It is the same rule
        // that put cone spread on a hashed index instead of a stream.
        //
        // The GOLDEN ANGLE rather than a plain fraction, because adjacent pool slots
        // are handed out together: spawning ten in a row off `i * 0.1` would give ten
        // bodies almost the same phase, which is the marching this exists to avoid.
        // A low-discrepancy step scatters neighbours by construction.
        //
        // Note it is stable per SLOT, not per body, so a recycled slot inherits the
        // phase. That is correct -- the value is arbitrary and only has to be steady
        // for one life and varied across the crowd. It could not come from the
        // instance index, which is compacted every frame as bodies die and would make
        // the cycle jump.
        gaitPhase: (i * 2.39996323) % (Math.PI * 2),
        x: 0, y: 0, z: 0, vx: 0, vz: 0,
        state: S.HUNT_LEG, legIndex: 0, routeIndex: 0, climbT: 0, atkCd: 0,
        onHull: false, yaw: 0, flash: 0,
        // Latched onto a leg and being carried by the hull. Chewers cannot
        // out-run an outboard attack point on a turning fortress, so they hold on
        // instead of chasing.
        latched: false,
        // Where a climb actually began, in hull space. Lerping from the route's
        // start instead snapped the enemy up to 1.6 m the instant it latched on.
        climbFrom: new THREE.Vector3(),
        // Seconds left underground, and seconds left on a planted charge.
        burrowT: 0,
        fuseT: 0,
        // Ranged lifecycle. The target reference exists only on authority; the frozen
        // endpoint and segment are plain scalars so pool reuse stays allocation-free.
        fireAngle: 0,
        fireDir: 1,
        chargeT: 0,
        shotT: 0,
        shotLocked: false,
        shotTarget: null,
        shotLeg: -1,
        lockX: 0,
        lockY: 0,
        lockZ: 0,
        shotDx: 0,
        shotDy: 0,
        shotDz: -1,
        shotRange: 0,
        // Decaying knock-aside velocity from a foot coming down. Stored as
        // velocity rather than applied as a displacement, because anything that
        // moves a body instantly reads as a teleport -- see invariant 20.
        shoveVx: 0,
        shoveVz: 0,
        // Holds one of the reactor's limited engagement slots.
        reactorSlot: false,
        // Which face of a piece of deck furniture this body is pressed against, set
        // by the push-out and consumed by the next steer. -1 is "nothing in the way".
        // 0 means the push was along x so the slide runs on z, 1 the other way round.
      };
    }

    // Presentation raycasts must describe the generation that is visibly interpolated,
    // not whichever body currently occupies the authority-backed pool slot. One fixed proxy
    // per slot gives Weapon and the HUD a stable, allocation-free target with only the fields
    // they read; clients arbitrate shots before consequence, so these are never damaged.
    this.renderTargets = Array.from({ length: this.pool.length }, () => ({
      alive: false,
      generation: 0,
      type: CHEWER,
      hp: 0,
      maxHp: 1,
      yaw: 0,
    }));

    // One fixed ring for the authority and one fixed render frame for a client. At 60 Hz the
    // 250 ms policy is fifteen historical poses; two spare frames make inclusive clamping
    // unambiguous. Typed arrays keep recording allocation-free at a full 420-body pool.
    this.combatRewindTicks = Math.ceil(
      (CFG.combat.weapon.rewindMs / 1000) * CFG.loop.stepHz,
    );
    this.combatHistory = Array.from(
      { length: this.combatRewindTicks + 2 },
      () => combatFrame(this.pool.length),
    );
    this.combatCursor = 0;
    this.combatNewestTick = -1;
    this.renderCombatFrame = combatFrame(this.pool.length);
    // Null is the solo path and preserves the original current-pose query exactly. A server
    // sets this per operative from input.clientTick; Net sets it to the visible render tick.
    this.combatTick = null;

    this.#buildMeshes(scene);
  }

  #buildMeshes(scene) {
    // Palette per type. Colour is doing real work here: it is the only cue
    // available at 70 m through dust, and it has to survive being tinted white by
    // a hit flash.
    const skins = {
      chewer: { color: 0x8f3540, emissive: 0x2a0608 },
      climber: { color: 0xb07d1e, emissive: 0x3a1e00 },
      bulwark: { color: 0x5c6068, emissive: 0x120c04, metalness: 0.55, roughness: 0.5 },
      burrower: { color: 0x6d5a45, emissive: 0x1a1005 },
      sapper: { color: 0x2f6a5c, emissive: 0x00301f },
      titan: { color: 0x4a2b34, emissive: 0x3a0a04, metalness: 0.35, roughness: 0.55 },
      spiker: { color: 0x704b78, emissive: 0x32113d, roughness: 0.68 },
    };

    this.meshes = ENEMY_TYPE_KEYS.map((key) => {
      const cfg = CFG.enemies[key];
      const skin = skins[key];
      const gait = CFG.enemies.gait;
      const mesh = new THREE.InstancedMesh(
        enemyGeometry(key, cfg),
        // The walk cycle is patched onto the material rather than the mesh, because
        // it lives in the vertex shader and there is one material per type. Cadence
        // is divided by bulk so mass sets stride rate -- a titan does not pedal like
        // a chewer.
        animateHorde(
          Look.std(`enemy_${key}`, {
            color: skin.color,
            emissive: skin.emissive,
            emissiveIntensity: 0.35 * cfg.glow,
            roughness: skin.roughness ?? 0.72,
            metalness: skin.metalness ?? 0.08,
          }),
          {
            rate: gait.rate / Math.pow(cfg.bulk, gait.bulkDrag),
            swing: gait.swing,
            bob: gait.bob,
            sway: gait.sway,
          },
        ),
        CFG.enemies.max,
      );
      mesh.name = `horde_${key}`;
      return mesh;
    });

    for (const m of this.meshes) {
      m.frustumCulled = false; // instances roam far outside the source bounds
      m.castShadow = true;
      m.count = 0;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

      // Allocate the per-instance colour buffer up front so hit flashes never
      // have to create it mid-frame.
      for (let i = 0; i < CFG.enemies.max; i++) m.setColorAt(i, _white);
      m.instanceColor.setUsage(THREE.DynamicDrawUsage);

      // Per-instance gait: (phase, amplitude). Allocated up front for the same
      // reason as the colour buffer, and uploaded on the same terms as the matrix --
      // amplitude tracks speed, so it genuinely does change every frame and there is
      // no dirty-tracking to be had. Two floats against the matrix's sixteen.
      const anim = new THREE.InstancedBufferAttribute(
        new Float32Array(CFG.enemies.max * 2), 2,
      );
      anim.setUsage(THREE.DynamicDrawUsage);
      m.geometry.setAttribute("aAnim", anim);

      scene.add(m);
    }
    // The raw Float32Arrays, indexed by type, so the write loop does not walk
    // mesh.geometry.attributes.aAnim.array for every one of 400 bodies a frame.
    this.animArrays = this.meshes.map((m) => m.geometry.attributes.aAnim.array);
    this.wasFlashing = false;
    this.gaitT = 0;

    // Spoil heaps over burrowing enemies.
    //
    // A threat with no tell is not difficulty, it is a surprise, and the roadmap
    // note about enemies "materialising out of nowhere" was a playtester's
    // reaction to exactly that. The mound says something is coming and roughly
    // where, while the enemy itself stays out of reach -- which is legible, since
    // a mound of sand is obviously not a thing you can shoot.
    this.mounds = new THREE.InstancedMesh(
      new THREE.ConeGeometry(1.05, 0.5, 9),
      Look.std("mound", { color: 0xa08a63, roughness: 1.0, metalness: 0 }),
      64,
    );
    this.mounds.frustumCulled = false;
    this.mounds.count = 0;
    this.mounds.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mounds.receiveShadow = true;
    scene.add(this.mounds);

    // Persistent Spiker release segments are drawn from a once-per-render event queue.
    // One instanced mesh covers every simultaneous streak without an Object3D per shot;
    // the queue carries exact world-space endpoints on both authority and snapshot clients.
    this.spikeShots = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(1, 1, 1, 6),
      new THREE.MeshBasicMaterial({ color: 0xffb45a }),
      CFG.enemies.max,
    );
    this.spikeShots.name = "horde_spiker_shots";
    this.spikeShots.frustumCulled = false;
    this.spikeShots.count = 0;
    this.spikeShots.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    scene.add(this.spikeShots);
  }

  // ------------------------------------------------------------------- spawn

  #free() {
    const pool = this.pool;
    for (let n = 0; n < pool.length; n++) {
      const i = (this.cursor + n) % pool.length;
      if (!pool[i].alive) {
        this.cursor = (i + 1) % pool.length;
        return pool[i];
      }
    }
    return null;
  }

  #pickLeg() {
    const hp = this.trampler.legHp;
    const open = [];
    for (let i = 0; i < hp.length; i++) if (hp[i] > 0) open.push(i);
    if (open.length === 0) return (this.random() * hp.length) | 0;
    return open[(this.random() * open.length) | 0];
  }

  /**
   * @param arcOffset radians from the hull's heading. When the director supplies
   *        one, the wave arrives in a tight cone around that bearing so it can be
   *        telegraphed and defended against. Omitted, it scatters across the
   *        whole forward arc.
   *
   * The signature is fixed at three parameters on purpose: the harness wraps this
   * method to measure spawn distances, and a wrapper written as `(type, scale)`
   * silently drops anything added after it. New per-type behaviour goes in the
   * type's config, never in a fourth argument.
   */
  spawn(type, hpScale = 1, arcOffset = null) {
    const e = this.#free();
    if (!e) return null;

    const t = this.trampler;
    const cfg = enemyCfg(type);

    // Spawn in the hull's forward arc so the wave walks into the fortress.
    // Spawning behind it means chasing a moving target at a 1.5 m/s closing
    // speed, and the wave simply never lands.
    const fwd = Math.atan2(-Math.cos(t.yaw), -Math.sin(t.yaw));
    const aimed = arcOffset !== null;
    const spread = aimed ? CFG.waves.waveSpread : CFG.waves.forwardArc;
    const ang = fwd + (aimed ? arcOffset : 0) + (this.random() * 2 - 1) * spread;
    const r = CFG.waves.spawnRadius * (0.85 + this.random() * 0.3);

    // Zero means "no body" in history and on the wire. Wrapping a 16-bit generation is
    // harmless within a 250 ms history window and saves two bytes on every live enemy in
    // every 20 Hz snapshot; the same slot cannot spawn 65,535 times in fifteen ticks.
    e.generation = (e.generation % GENERATION_MAX) + 1;
    e.alive = true;
    e.type = type;
    e.maxHp = cfg.hp * hpScale;
    e.hp = e.maxHp;
    // Force one tint write on the frame it appears. A pooled slot keeps its last
    // occupant's band, so a fresh full-health enemy re-using the slot of something
    // that died at 20% would otherwise be drawn dark until it took a hit.
    e.tintBand = -1;
    e.x = t.group.position.x + Math.cos(ang) * r;
    e.z = t.group.position.z + Math.sin(ang) * r;
    e.y = cfg.height / 2;
    e.vx = 0;
    e.vz = 0;
    e.atkCd = 0;
    e.climbT = 0;
    e.onHull = false;
    e.latched = false; // pooled objects are reused, so every field must be reset
    e.yaw = 0;
    e.flash = 0;
    e.fuseT = 0;
    e.burrowT = 0;
    e.reactorSlot = false;
    e.shoveVx = 0;
    e.shoveVz = 0;
    e.chargeT = 0;
    e.shotT = 0;
    e.shotLocked = false;
    e.shotTarget = null;
    e.shotLeg = -1;
    e.lockX = 0;
    e.lockY = 0;
    e.lockZ = 0;
    e.shotDx = 0;
    e.shotDy = 0;
    e.shotDz = -1;
    e.shotRange = 0;

    if (cfg.fireRadius > 0) {
      // The goal is held in hull-local polar coordinates and rebuilt every frame.
      // The enemy itself remains in world space: it has to run to keep its firing
      // position as the fortress walks, rather than being carried by its target.
      _local.set(e.x, e.y, e.z);
      t.worldToLocal(_local);
      e.fireAngle = clamp(
        Math.atan2(_local.x, -_local.z),
        -cfg.fireArc,
        cfg.fireArc,
      );
      e.fireDir = e.fireAngle >= 0 ? -1 : 1;
      e.state = S.TO_FIRE_RING;
      e.legIndex = 0;
    } else if (cfg.goal === "reactor") {
      e.state = S.TO_CLIMB;
      e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
    } else if (cfg.burrowTime > 0) {
      // Straight underground from the spawn ring. There is no surface approach to
      // intercept, which is the entire point of the type.
      e.state = S.BURROWED;
      e.burrowT = cfg.burrowTime * this.revealScale;
      e.legIndex = this.#pickLeg();
      e.y = -cfg.height;
    } else {
      e.state = S.HUNT_LEG;
      e.legIndex = this.#pickLeg();
    }

    this.liveCount++;
    return e;
  }

  clear() {
    for (const e of this.pool) {
      e.alive = false;
      e.reactorSlot = false;
    }
    // All four counters, not just the live count. The other three are recomputed in
    // update(), so leaving them stale means anything polling them between a clear and
    // the next frame reads the cleared fight's numbers -- the HUD showing "0 (5 under,
    // 2 aboard)" for a frame after a restart, and, since the buy window now asks
    // whether anything is under the hull, a shop that stays shut on the frame a run
    // begins.
    this.liveCount = 0;
    this.underHull = 0;
    this.aboard = 0;
    this.burrowed = 0;
    this.fuseWarning = 0;
    this.fusesLit = 0;

    this.spikerShotSeq = 0;
    this.spikerShotJournal.length = 0;
    this.spikerShotPending.length = 0;
    this.spikerShotActive.length = 0;
    this.spikerShotSeenSeq = 0;
    this.spikerShotResetId = null;
    this.spikeShots.count = 0;
    this.spikeShots.instanceMatrix.needsUpdate = true;

    // Re-seed, so a restarted encounter is the SAME fight. Seeding exists to make
    // two attempts comparable; carrying the stream across a reset would hand the
    // player a different wave pattern and quietly defeat the whole point.
    this.random = makeRandom(this.seed);
    this.clearRenderCombatFrame();
  }

  /**
   * Queue discrete release events from the newest authority snapshot.
   *
   * The first snapshot of a connection or reset establishes a sequence baseline instead of
   * replaying whatever recent history it carries. Later snapshots repeat the bounded journal
   * deliberately, so the sequence cursor makes ingestion exactly-once across packet overlap.
   */
  ingestSpikerShots(events = [], resetId = 0) {
    const generation = Number.isFinite(resetId) ? resetId : 0;
    let highest = 0;
    for (const event of events) {
      const seq = Math.trunc(event?.seq ?? 0);
      if (Number.isSafeInteger(seq) && seq > highest) highest = seq;
    }

    if (this.spikerShotResetId !== generation) {
      this.spikerShotResetId = generation;
      this.spikerShotSeenSeq = highest;
      this.spikerShotPending.length = 0;
      this.spikerShotActive.length = 0;
      this.spikeShots.count = 0;
      this.spikeShots.instanceMatrix.needsUpdate = true;
      return 0;
    }

    let queued = 0;
    // Authority appends in sequence order. Advance the cursor even if a malformed event is
    // unusable, so one bad record cannot be retried by every overlapping snapshot forever.
    for (const event of events) {
      const seq = Math.trunc(event?.seq ?? 0);
      if (!Number.isSafeInteger(seq) || seq <= this.spikerShotSeenSeq) continue;
      if (this.#queueSpikerShot(event)) queued++;
      this.spikerShotSeenSeq = seq;
    }
    return queued;
  }

  /**
   * Advance and draw release events once per browser frame.
   *
   * Existing streaks age first and newly queued ones are activated second. Therefore a fresh
   * release is drawn for at least one frame even when this frame's dt exceeds shotFlash — the
   * exact case produced by a 250 ms solo catch-up or delayed multiplayer presentation.
   */
  presentSpikerShots(dt = 0) {
    const elapsed = Number.isFinite(dt) ? Math.max(0, dt) : 0;
    let write = 0;
    for (const event of this.spikerShotActive) {
      event.life -= elapsed;
      if (event.life > 0) this.spikerShotActive[write++] = event;
    }
    this.spikerShotActive.length = write;

    // A null namespace is the solo/authority-render path. Snapshot clients switch to a
    // numeric resetId in ingestSpikerShots and consume only the network queue thereafter.
    if (this.spikerShotResetId === null) {
      for (const event of this.spikerShotJournal) {
        if (event.seq <= this.spikerShotSeenSeq) continue;
        if (this.#queueSpikerShot(event)) this.spikerShotSeenSeq = event.seq;
      }
    }

    const lifetime = enemyCfg(SPIKER).shotFlash;
    for (const event of this.spikerShotPending) {
      if (this.spikerShotActive.length >= CFG.enemies.max) {
        this.spikerShotActive.shift();
      }
      this.spikerShotActive.push({ ...event, life: lifetime });
    }
    this.spikerShotPending.length = 0;

    let shotCount = 0;
    for (const event of this.spikerShotActive) {
      if (shotCount >= CFG.enemies.max) break;
      _shotStart.set(event.startX, event.startY, event.startZ);
      _shotEnd.set(event.endX, event.endY, event.endZ);
      _shotDir.subVectors(_shotEnd, _shotStart);
      const length = _shotDir.length();
      if (!Number.isFinite(length) || length < 1e-4) continue;
      _shotDir.multiplyScalar(1 / length);
      _shotMid.addVectors(_shotStart, _shotEnd).multiplyScalar(0.5);
      _shotQ.setFromUnitVectors(_yAxis, _shotDir);
      _shotScale.set(0.045, length, 0.045);
      _shotMatrix.compose(_shotMid, _shotQ, _shotScale);
      this.spikeShots.setMatrixAt(shotCount++, _shotMatrix);
    }
    this.spikeShots.count = shotCount;
    this.spikeShots.instanceMatrix.needsUpdate = true;
    return shotCount;
  }

  #queueSpikerShot(event) {
    const seq = Math.trunc(event?.seq ?? 0);
    if (!Number.isSafeInteger(seq) || seq <= 0) return false;
    const startX = event.startX;
    const startY = event.startY;
    const startZ = event.startZ;
    const endX = event.endX;
    const endY = event.endY;
    const endZ = event.endZ;
    if (
      !Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(startZ)
      || !Number.isFinite(endX) || !Number.isFinite(endY) || !Number.isFinite(endZ)
    ) return false;

    if (this.spikerShotPending.length >= CFG.enemies.max) {
      this.spikerShotPending.shift();
    }
    this.spikerShotPending.push({ seq, startX, startY, startZ, endX, endY, endZ });
    return true;
  }

  /** Speed of a type right now, including the road modifier. */
  speedOf(cfg) {
    return cfg.speed * this.speedScale;
  }

  /**
   * Live Spikers whose ranged attack can still resolve after the ordinary survivor
   * allowance would end a wave. This is a hard field-state question, not pressure:
   * a tracked shot remains dangerous even when the body is outside threatRange.
   */
  get rangedThreats() {
    let count = 0;
    for (const e of this.pool) {
      if (!e.alive || e.type !== SPIKER) continue;
      if (
        e.state === S.TO_FIRE_RING
        || e.state === S.CHARGING
        || e.state === S.FIRING
      ) count++;
    }
    return count;
  }

  // ------------------------------------------------------------------ update

  /**
   * Refresh snapshot-driven bodies without running enemy simulation.
   *
   * Authoritative clients deliberately skip update(): running AI, collision, contact damage
   * or the spatial hash locally would immediately disagree with the server. They still need
   * the visual clock, hit-flash decay and instance buffers once per rendered frame, otherwise
   * every received transform remains invisible until some unrelated local update occurs.
   */
  updateSnapshotVisuals(dt = 0) {
    this.gaitT = (this.gaitT + dt) % 3600;
    for (const m of this.meshes) {
      if (m.material.userData.gait) m.material.userData.gait.uGaitTime.value = this.gaitT;
    }
    for (const e of this.pool) {
      if (e.alive && e.flash > 0) e.flash = Math.max(0, e.flash - dt);
    }
    this.#writeInstances();
  }

  /**
   * @param crew a Crew, not a Player. Contact damage is one of exactly three places
   *        the simulation asks about the crew as a group: anything adjacent hurts
   *        whoever is adjacent, and with a single operative the other three would have
   *        been untouchable by anything they walked into.
   */
  update(dt, crew) {
    const t = this.trampler;
    const en = CFG.enemies;

    // The gait clock. Write-only presentation state: nothing in the simulation reads
    // it, nothing branches on it, and it is never printed, so it cannot show up in a
    // determinism diff. Wrapped at a large multiple of a full turn so a long session
    // does not push it into the range where float precision coarsens sin().
    this.gaitT = (this.gaitT + dt) % 3600;
    for (const m of this.meshes) {
      // Present whether or not a shader was ever compiled -- animateHorde installs it
      // on the material, and the harness compiles nothing.
      if (m.material.userData.gait) m.material.userData.gait.uGaitTime.value = this.gaitT;
    }
    const pool = this.pool;
    const grid = this.grid;

    grid.clear();
    for (let i = 0; i < pool.length; i++) {
      // Anything underground is left out of the neighbour hash entirely. It is not
      // in the same space as the things on the surface, and leaving it in meant a
      // burrower nudged bodies it was several metres below -- an invisible force
      // shoving the crowd around, which is exactly the kind of thing a playtester
      // reports as "something pushed me" and nobody can reproduce.
      if (pool[i].alive && pool[i].state !== S.BURROWED) {
        grid.insert(i, pool[i].x, pool[i].z);
      }
    }

    // Counted for the HUD: how many are in the hull's shadow, where no gun can
    // reach them. Tells the player what they are about to drop into.
    this.underHull = 0;
    this.aboard = 0;
    this.burrowed = 0;
    this.fuseWarning = 0;
    this.fusesLit = 0;

    // Reactor engagement slots, recomputed from scratch every frame rather than
    // maintained as a running total. A counter that is incremented and
    // decremented across deaths, state changes and pool reuse drifts, and a
    // drifted slot count fails silently -- either the reactor becomes immortal or
    // the cap stops applying. Recounting is a few hundred boolean reads.
    let reactorClaims = 0;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.alive && e.reactorSlot) reactorClaims++;
      else e.reactorSlot = false;
    }
    const reactorLimit = t.reactorSlotCount;

    const sep = en.separation;
    const sep2 = sep * sep;
    const cell = grid.cell;

    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.alive) continue;

      const cfg = enemyCfg(e.type);
      const speed = this.speedOf(cfg);
      e.atkCd = Math.max(0, e.atkCd - dt);
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);

      // Knock-aside decays toward nothing, so a shove is a stumble rather than a
      // permanent change of course.
      if (e.shoveVx !== 0 || e.shoveVz !== 0) {
        const keep = Math.exp(-CFG.trampler.stomp.shoveDecay * dt);
        e.shoveVx *= keep;
        e.shoveVz *= keep;
        if (Math.abs(e.shoveVx) < 0.01) e.shoveVx = 0;
        if (Math.abs(e.shoveVz) < 0.01) e.shoveVz = 0;
      }

      // Anything attached to the fortress rides it exactly the way the player
      // does -- same prev-frame-local to current-frame-world transform. That is
      // boarders standing on the deck, and chewers latched onto a leg.
      if (e.onHull || e.latched) {
        _v.set(e.x, e.y, e.z);
        t.worldToPrevLocal(_v);
        t.localToWorld(_v);
        e.x = _v.x;
        e.y = _v.y;
        e.z = _v.z;
      }

      let driven = false;

      switch (e.state) {
        case S.TO_FIRE_RING: {
          this.#spikerRingWorld(e, cfg, _v);
          const d = this.#steer(e, speed, _v);

          // The ring is a preferred firing position, not a promise to ignore
          // somebody who has already breached it. Requiring the exact ring let an
          // operative stand beside a Spiker while it ran away for 2.4 s, then wait
          // through the whole charge — nearly four seconds before the first answer.
          //
          // Breach is a separate question from shot selection. A visible gunner is
          // still the preferred TARGET, but cannot hide a closer exposed operative
          // from this gate merely by occupying a station farther away.
          let breached = false;
          if (d >= cfg.reach && e.atkCd <= 0) {
            const radius2 = cfg.fireRadius * cfg.fireRadius;
            for (const operative of crew) {
              if (!operative || operative.downed) continue;
              const dx = operative.position.x - e.x;
              const dy = operative.position.y - e.y;
              const dz = operative.position.z - e.z;
              if (dx * dx + dy * dy + dz * dz >= radius2) continue;
              if (!this.#spikerCanSee(e, cfg, operative)) continue;
              breached = true;
              break;
            }
          }

          if ((d < cfg.reach || breached) && e.atkCd <= 0) {
            e.state = S.CHARGING;
            e.chargeT = cfg.chargeTime;
            e.shotLocked = false;
            e.shotLeg = -1;
            e.shotRange = 0;
            e.vx = 0;
            e.vz = 0;
          }
          break;
        }

        case S.CHARGING: {
          // Braced means BRACED: no neighbour push and no gait while the pressure
          // sac brightens. Aim tracks until the final lock window, then freezes.
          e.vx = 0;
          e.vz = 0;
          driven = true;
          e.chargeT = Math.max(0, e.chargeT - dt);

          if (!e.shotLocked) {
            const hasAim = this.#trackSpiker(e, cfg, crew);
            if (hasAim && e.chargeT <= cfg.lockTime) {
              // Freeze a PREDICTION, not the target's current world point. Walking
              // moves an operative 2.45 m during the 0.35 s lock against a 0.8 m-wide
              // body, and a gunner pinned in hull space is still carried about 1.6 m
              // through world space. Without this lead, holding any movement key — or
              // merely sitting on the moving fortress — is an automatic dodge.
              //
              // This is deliberately constant-velocity and authority-only, not
              // homing. Changing direction, stopping, jumping, or reaching fortress
              // cover after the lock still defeats the committed shot.
              if (e.shotLeg < 0 && e.shotTarget) {
                e.shotTarget.worldVelocity(_shotDir);
                e.lockX += _shotDir.x * e.chargeT;
                e.lockY += _shotDir.y * e.chargeT;
                e.lockZ += _shotDir.z * e.chargeT;
                const dx = e.lockX - e.x;
                const dz = e.lockZ - e.z;
                if (dx * dx + dz * dz > 1e-8) e.yaw = Math.atan2(-dx, -dz);
              }
              e.shotLocked = true;
            }
          }

          if (e.chargeT <= 0) {
            if (!e.shotLocked) e.shotLocked = this.#trackSpiker(e, cfg, crew);
            if (e.shotLocked && this.#fireSpiker(e, cfg, crew)) {
              e.state = S.FIRING;
              e.shotT = cfg.shotFlash;
            } else if (t.brokenLegs() >= t.legHp.length) {
              // With no exposed operative and no working leg, the ranged job has no
              // target. Escalate to the same boarding path as every leg attacker rather
              // than cycling harmlessly on the ring for the rest of the run.
              e.state = S.TO_CLIMB;
              e.latched = false;
              e.climbT = 0;
              e.fuseT = 0;
              e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
              e.chargeT = 0;
              e.shotT = 0;
              e.shotLocked = false;
              e.shotTarget = null;
              e.shotLeg = -1;
              e.shotRange = 0;
            } else {
              e.state = S.TO_FIRE_RING;
              e.atkCd = 1 / cfg.attackRate;
            }
          }
          break;
        }

        case S.FIRING: {
          // This state owns the existing stationary release beat and cooldown boundary.
          // The exact streak is a persistent event now, so presentation no longer extends
          // or shortens this timer and combat cadence remains unchanged.
          e.vx = 0;
          e.vz = 0;
          driven = true;
          e.shotT = Math.max(0, e.shotT - dt);
          if (e.shotT <= 0) {
            let next = e.fireAngle + e.fireDir * cfg.repositionArc;
            if (next > cfg.fireArc || next < -cfg.fireArc) {
              e.fireDir *= -1;
              next = clamp(next, -cfg.fireArc, cfg.fireArc);
            }
            e.fireAngle = next;
            e.atkCd = 1 / cfg.attackRate;
            e.state = S.TO_FIRE_RING;
          }
          break;
        }

        case S.BURROWED: {
          // Driven straight at the leg's attack point, below the sand. Not
          // hittable, not counted as pressure, and on a hard clock -- when the
          // clock runs out it surfaces wherever it has got to, which means the
          // state can never be a hiding place.
          e.burrowT -= dt;
          t.legAttackWorld(e.legIndex, _v, cfg.inboardOffset);
          const d = this.#steer(e, speed, _v);
          e.y = -cfg.height;
          this.burrowed++;

          if (e.burrowT <= 0 || d < cfg.reach) {
            e.state = S.HUNT_LEG;
            e.y = cfg.height / 2;
          }
          break;
        }

        case S.HUNT_LEG: {
          // With every leg already down there is nothing left to chew, and they
          // would otherwise huddle under the hull doing nothing at all -- the
          // fortress crippled but the threat gone. So they escalate and board.
          if (t.brokenLegs() >= t.legHp.length) {
            e.state = S.TO_CLIMB;
            e.latched = false;
            e.climbT = 0;
            e.fuseT = 0;
            e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
            break;
          }

          if (t.legHp[e.legIndex] <= 0) {
            e.legIndex = this.#pickLeg();
            e.latched = false;
            e.fuseT = 0;
          }
          t.legAttackWorld(e.legIndex, _v, cfg.inboardOffset);

          // Once in reach an attacker LATCHES to the hull and is carried by it,
          // rather than re-chasing a point every frame.
          //
          // Chasing was never actually winnable. A leg's attack point is outboard,
          // so the hull's yaw adds tangential speed on top of its 4.5 m/s: measured
          // at 4.71 m/s mean and 6.33 m/s peak on the legs outside the turn. That is
          // faster than any chewer has ever been able to run, so damage output
          // fluctuated with the hull's turn phase, and below ~4.71 m/s it stopped
          // entirely -- chewers trailed the fortress forever and dealt zero damage,
          // which quietly removes the whole reason to fight beneath the hull.
          //
          // Latching decouples the two jobs: speed decides how fast they ARRIVE,
          // the latch decides whether they can HOLD ON. That is what makes enemy
          // speed a free tuning knob instead of a number secretly coupled to the
          // hull's turn rate and leg geometry.
          const d = Math.hypot(e.x - _v.x, e.z - _v.z);

          // Neighbour separation can shove a latched attacker off its spot. Well
          // outside reach, let go and walk back in.
          if (e.latched && d > cfg.reach * 1.6) {
            e.latched = false;
            // Losing your grip loses the charge with it. A fuse that survived
            // being pushed off the leg would make the sapper unstoppable by
            // anything except killing it, which removes the crowd as an answer.
            e.fuseT = 0;
          }

          if (e.latched) {
            // Enemies have no collision against the fortress, so holding still is
            // what stops them walking straight through it.
            e.vx = 0;
            e.vz = 0;
          } else {
            this.#steer(e, speed, _v);
            if (d < cfg.reach) {
              e.latched = true;
              e.vx = 0;
              e.vz = 0;
              if (cfg.fuse > 0) e.fuseT = cfg.fuse;
            }
          }

          if (e.latched && cfg.fuse > 0) {
            // A charge, not a bite. Survive the fuse and it takes the leg off in
            // one hit; interrupt it and nothing happens at all.
            e.fuseT -= dt;
            this.fusesLit++;
            if (this.fuseWarning === 0 || e.fuseT < this.fuseWarning) {
              this.fuseWarning = Math.max(0, e.fuseT);
            }
            if (e.fuseT <= 0) {
              t.damageLeg(e.legIndex, cfg.fuseDamage);
              this.detonations = (this.detonations ?? 0) + 1;
              this.#kill(e, false);
            }
          } else if (e.latched && e.atkCd <= 0 && cfg.damage > 0) {
            t.damageLeg(e.legIndex, cfg.damage);
            e.atkCd = 1 / cfg.attackRate;
          }
          break;
        }

        case S.TO_CLIMB: {
          const route = t.climbRoutes[e.routeIndex];
          t.localToWorld(_v.copy(route.start));
          const d = this.#steer(e, speed, _v);
          if (d < 1.7) {
            // Begin the climb from where the enemy actually is, not from the
            // route's anchor, or it visibly pops sideways as it latches on.
            e.climbFrom.set(e.x, e.y, e.z);
            t.worldToLocal(e.climbFrom);
            e.state = S.CLIMBING;
            e.climbT = 0;
          }
          break;
        }

        case S.CLIMBING: {
          // Position is driven along a hull-local path, so the route tracks the
          // walking, turning hull for free.
          const route = t.climbRoutes[e.routeIndex];
          e.climbT = Math.min(1, e.climbT + dt / (cfg.climbTime * this.climbScale));

          // The rise is linear; the INBOARD move is held back until the body has crested
          // the deck. A single lerp from a start that is outboard AND below to an end
          // that is inboard AND above has no choice but to cut the corner, and the corner
          // is the 3 m hull slab: measured at 0.88 s of a 2.20 s climb spent inside solid
          // armour, identically on all eight routes, on every boarding. It now rides up
          // the flank and hauls itself over the edge, which is both correct and what
          // climbing is supposed to look like.
          //
          // The knee is where the body's centre reaches the deck surface (local y = 0),
          // derived from `climbFrom` rather than written as a fraction, because a climb
          // starts from wherever the body actually was -- a fixed fraction would put the
          // corner at a different height for every approach.
          //
          // x and z share the schedule because both are horizontal. z is usually a no-op,
          // since a route's start and end have the same z, but `climbFrom` is the body's
          // real position and can differ.
          // The rise is EASED rather than linear, and that is about the lateral, not the
          // rise. Holding the inboard move back leaves only the fraction of the climb
          // above the knee to cover it, and with a linear rise that is 12% of 2.2 s for
          // 1.9 m -- which measured as a 0.326 m frame-to-frame step against invariant
          // 20's 0.35 m ceiling. Passing, but it had eaten nearly all the slack that
          // ceiling exists to leave, so the guard would no longer catch a real teleport.
          // Getting to deck level sooner buys the vault room to be gentle, and reads
          // correctly too: a body hauls itself up the flank and then swings over.
          const rise = 1 - (1 - e.climbT) * (1 - e.climbT);
          const span = route.end.y - e.climbFrom.y;
          const knee = span > 1e-6 ? clamp(-e.climbFrom.y / span, 0, 1) : 0;
          // Linear, not smoothstepped: smoothstep peaks at 1.5x its own average, and the
          // peak is exactly the number invariant 20 measures.
          const lateral = rise <= knee
            ? 0
            : clamp((rise - knee) / Math.max(1e-6, 1 - knee), 0, 1);
          _local.set(
            lerp(e.climbFrom.x, route.end.x, lateral),
            lerp(e.climbFrom.y, route.end.y, rise),
            lerp(e.climbFrom.z, route.end.z, lateral),
          );
          t.localToWorld(_local);
          e.x = _local.x;
          e.y = _local.y;
          e.z = _local.z;
          e.vx = 0;
          e.vz = 0;
          driven = true;
          if (e.climbT >= 1) {
            e.state = S.ON_DECK;
            e.onHull = true;
          }
          break;
        }

        case S.ON_DECK: {
          // Close on the reactor's SURFACE, not its centre. Stopping 2.4 m from
          // the centre of a 5 x 2.4 x 4 box means standing inside it, and an
          // attacker inside the reactor is unkillable: its own mesh eats every
          // bullet aimed at them.
          _v.set(e.x, e.y, e.z);
          t.reactorSurfaceWorld(_v, _v);
          const d = this.#steer(e, speed, _v);

          // Straight at it while the line is clear, and route only when it is not.
          // Deliberately this way round rather than always following the field: the
          // direct steer is smooth and exact, while a grid gives eight directions, and
          // most of the deck most of the time has nothing in the way. It also keeps the
          // cost where it belongs -- the geometry test only runs for boarders that are
          // actually obstructed.
          if (d >= cfg.reactorReach && !this.#lineToReactorClear(e, cfg)) {
            _flowProbe.set(e.x, e.y, e.z);
            t.worldToLocal(_flowProbe);
            if (this.#flowDir(_flowProbe.x, _flowProbe.z, cfg, _flowDir)) {
              // The field is in hull space; the hull only yaws, so this is a plain 2D
              // rotation and it is exact.
              const c = Math.cos(t.yaw);
              const s = Math.sin(t.yaw);
              e.vx = (_flowDir.x * c + _flowDir.z * s) * speed;
              e.vz = (-_flowDir.x * s + _flowDir.z * c) * speed;
            }
          }

          if (d < cfg.reactorReach) {
            e.vx = 0;
            e.vz = 0;

            // Only a limited number can be in contact at once. Beyond that they
            // stand around the core waiting, which is still dangerous -- they are
            // between you and the thing you came up to save -- but the reactor's
            // incoming damage stops scaling with wave size.
            //
            // Without this, wave 4 put eight boarders on a 420 hp reactor for 120
            // dps and killed it in 3.5 seconds, which is less than the time to
            // notice, grapple up, turn and engage. That is a reaction-time wall,
            // not a decision.
            if (!e.reactorSlot && reactorClaims < reactorLimit) {
              e.reactorSlot = true;
              reactorClaims++;
            }

            if (e.reactorSlot && e.atkCd <= 0) {
              t.damageReactor(cfg.damage);
              e.atkCd = 1 / cfg.attackRate;
            }
          } else if (e.reactorSlot) {
            // Shoved out of contact: give the slot back so a waiting boarder can
            // take it, rather than holding it from three metres away.
            e.reactorSlot = false;
            reactorClaims--;
          }
          break;
        }
      }

      if (!driven) {
        // Separation against neighbours in the 9 surrounding hash cells. Skipped
        // while underground, for the same reason burrowers are kept out of the
        // hash: they are not sharing a space with the surface crowd, in either
        // direction.
        let px = 0;
        let pz = 0;
        const separates = e.state !== S.BURROWED;
        for (let dx = -1; separates && dx <= 1; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.map.get(grid.key(e.x + dx * cell, e.z + dz * cell));
            if (!bucket) continue;
            for (let b = 0; b < bucket.length; b++) {
              const j = bucket[b];
              if (j === i) continue;
              const o = pool[j];
              const ox = e.x - o.x;
              const oz = e.z - o.z;
              const d2 = ox * ox + oz * oz;
              if (d2 > sep2 || d2 < 1e-6) continue;
              const d = Math.sqrt(d2);
              const push = (sep - d) / sep;
              px += (ox / d) * push;
              pz += (oz / d) * push;
            }
          }
        }

        e.x += (e.vx + px * speed * 0.9 + e.shoveVx) * dt;
        e.z += (e.vz + pz * speed * 0.9 + e.shoveVz) * dt;
        if (!e.onHull) e.y = e.state === S.BURROWED ? -cfg.height : cfg.height / 2;
        if (e.vx !== 0 || e.vz !== 0) e.yaw = Math.atan2(-e.vx, -e.vz);

        // Boarders have no collision against deck scenery, so a crowd's
        // separation push can shove one past the deck edge. Left alone it would
        // then hover at deck height over open sand, carried along by the hull.
        // Anything off the footprint falls off and has to climb again.
        if (e.onHull) {
          _v.set(e.x, e.y, e.z);
          t.worldToLocal(_v);
          if (Math.abs(_v.x) > t.halfW || Math.abs(_v.z) > t.halfL) {
            e.onHull = false;
            e.state = S.TO_CLIMB;
            e.climbT = 0;
            if (e.reactorSlot) {
              e.reactorSlot = false;
              reactorClaims--;
            }
            e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
          } else {
            // Deck scenery. Boarders used to walk through crates, the mast and
            // the engine block, which reads as them being ghosts and also let
            // them take a straight line to the reactor that the player cannot.
            //
            // Resolved in HULL-LOCAL space and on the horizontal only: the
            // fortress never pitches or rolls, so the deck's boxes are axis
            // aligned here and a 2D push-out is exact. Vertical is left alone
            // because these things do not jump -- they walk around.
            if (this.#avoidDeckScenery(_v, cfg)) {
              t.localToWorld(_v);
              e.x = _v.x;
              e.z = _v.z;
            }
          }
        }
      }

      if (e.onHull) {
        this.aboard++;
      } else if (e.state !== S.BURROWED) {
        _local.set(e.x, e.y, e.z);
        t.worldToLocal(_local);
        if (Math.abs(_local.x) < t.halfW && Math.abs(_local.z) < t.halfL && _local.y < -1) {
          this.underHull++;
        }
      }

      // Anything adjacent hurts whoever is adjacent, on deck or on the sand -- except
      // something that is currently underground, which cannot touch anybody.
      //
      // ONE OPERATIVE PER ATTACK COOLDOWN, and that is a deliberate choice rather than
      // a detail of the loop. `atkCd` gates the swing, not the victim, so breaking
      // after the first hit keeps a chewer's damage output exactly what it has always
      // been -- 9.9 hp/s, the number every measurement in the invariants was taken
      // against. Letting one swing hit everybody in reach would silently multiply
      // enemy damage by crew size, which is the wave-size curve being changed by
      // accident (invariant 19e) and would make every recorded survival time wrong.
      //
      // Whether an attack SHOULD splash across a bunched-up crew is a real design
      // question and belongs to the crew-scaling work, where it can be measured. It is
      // not a question this change is allowed to answer.
      const contactDamage = cfg.damage * cfg.contactScale;
      if (e.state !== S.BURROWED && contactDamage > 0 && e.atkCd <= 0) {
        const reach = en.playerReach + cfg.radius - 0.5;
        const reach2 = reach * reach;
        for (const p of crew) {
          if (!p || p.downed) continue;
          const dx = p.position.x - e.x;
          const dy = p.position.y - e.y;
          const dz = p.position.z - e.z;
          if (dx * dx + dy * dy + dz * dz >= reach2) continue;
          p.hurt(contactDamage);
          e.atkCd = 1 / cfg.attackRate;
          break;
        }
      }
    }

    this.#writeInstances();
  }

  /**
   * Let a boarder SLIDE along the face it is pressed against, instead of pressing
   * into it forever.
   *
   * This is the other half of `#avoidDeckScenery`, and shipping only that half was
   * the bug. Making deck furniture solid stopped boarders walking through crates;
   * nothing gave them a way past one. `#steer` aims straight at the reactor, the
   * push-out shoves the body back out of whatever it walked into, and the pair
   * produce a wall-slide ONLY on an oblique approach -- because that slide is just
   * the leftover tangential part of a velocity nobody ever corrected. Dead-on, there
   * is no leftover, so the body presses into the face at full speed for the rest of
   * the run.
   *
   * Measured before this existed, one boarder at a time on a stationary hull:
   *
   *   - 1 of 8 boarding-route exits never reached the reactor, and 4 of 16 once the
   *     start was nudged 0.6 m to stand in for a crowd's separation push -- which is
   *     worth up to `speed * 0.9` sideways, so it happens constantly.
   *   - The starboard crate's whole outboard face was a permanent trap: local z
   *     identical to two decimal places across 20 s. Exactly zero slide, not slow.
   *   - Five pin points across four separate pieces of furniture, every one of them
   *     a perpendicular press: the mast's aft face, both amidships crates, and the
   *     forward crate.
   *
   * It failed silently and worse than it looks. A pinned boarder still counts in
   * `aboard`, so it is a permanent contribution to director pressure (invariant 19)
   * that never resolves, and it is neither a threat you have to answer nor one that
   * goes away.
   *
   * WHY A FLOW FIELD AND NOT A STEERING RULE. Four reactive rules were written and
   * measured before this, and each one fixed the case it was aimed at and broke
   * another: project the velocity onto the face (19/24 route starts arriving, up from
   * 19), reject a blocked direction, widen the degeneracy band (21/24), commit to a
   * sense of rotation and circumnavigate (20/24). The last one is the instructive
   * failure. A boarder leaving the port-aft route meets the ENGINE BLOCK first and
   * correctly commits to going forward around it, then meets the STARBOARD CRATE,
   * where that same committed sense points away from the reactor. Commit per obstacle
   * instead and the pocket deadlock comes straight back, because the pocket is two
   * boxes taking turns.
   *
   * The reason is structural, not a bad constant. The deck's obstacle envelopes form
   * CONCAVE UNIONS -- the port crate and the engine block overlap once expanded by a
   * body radius, and so do the mast and the forward crate -- and escaping a concave
   * union requires reasoning about the union. A rule that can only see the face it is
   * touching cannot do that, and no fifth variant would have either.
   *
   * So: one breadth-first search per body radius, once, at construction, over a coarse
   * grid of the deck in HULL-LOCAL space. Boarders read a direction out of an array.
   * Three properties make this the right answer rather than merely a working one:
   *
   *   - It is DERIVED FROM THE COLLIDERS, not authored beside them. A hand-placed
   *     waypoint graph is a second description of the deck that drifts from the first
   *     the moment somebody moves a crate, and this whole bug is what silent drift
   *     costs. Move the furniture and the field moves with it.
   *   - The search is GLOBAL, so pockets are not a special case to be handled. There
   *     is nothing left to get wrong about them.
   *   - It is cheaper than any of the four rules it replaces: no per-frame geometry
   *     queries at all, just an array read.
   *
   * Deterministic, which invariant 21 requires: fixed grid, fixed iteration order, no
   * randomness anywhere in the build.
   */
  #buildDeckFlow() {
    const t = this.trampler;
    const cell = CFG.enemies.deckFlowCell;
    const cols = Math.ceil((t.halfW * 2) / cell);
    const rows = Math.ceil((t.halfL * 2) / cell);
    const fields = new Map();

    // Deck height in hull space, which is where a boarder's centre sits. Local y = 0 is
    // the DECK SURFACE, not the ground, so a body standing on it is at half its height.
    for (const key of ENEMY_TYPE_KEYS) {
      const cfg = CFG.enemies[key];
      const rKey = Math.round(cfg.radius * 100);
      if (fields.has(rKey)) continue;
      fields.set(rKey, this.#solveDeckFlow(cols, rows, cell, cfg));
    }

    return { cell, cols, rows, fields };
  }

  /** One BFS: mark what a body of this size cannot occupy, then flood from the reactor. */
  #solveDeckFlow(cols, rows, cell, cfg) {
    const t = this.trampler;
    const y = cfg.height / 2;
    const r = cfg.radius;
    const rb = t.reactorBox;

    const blocked = new Uint8Array(cols * rows);
    const dist = new Int32Array(cols * rows).fill(-1);
    const dirX = new Float32Array(cols * rows);
    const dirZ = new Float32Array(cols * rows);

    // Cell CENTRES. Note the parenthesising on the row: `(i / cols) | 0 + 0.5` parses
    // as `(i / cols) | 0.5`, which is an integer truncation and silently throws the
    // half-cell offset away, sampling every row on its boundary instead of its middle.
    const cx = (i) => -t.halfW + ((i % cols) + 0.5) * cell;
    const cz = (i) => -t.halfL + (((i / cols) | 0) + 0.5) * cell;

    const queue = new Int32Array(cols * rows);
    let head = 0;
    let tail = 0;

    for (let i = 0; i < blocked.length; i++) {
      const x = cx(i);
      const z = cz(i);
      const half = cell * 0.5;
      // The WHOLE cell has to be clear, not just its centre. A cell that merely contains
      // a clear point will happily tell a body standing in the obstructed part of it to
      // walk into the wall -- measured exactly that way before this was conservative.
      if (this.#cellBlocked(x - half, x + half, z - half, z + half, y, cfg)) {
        blocked[i] = 1;
        continue;
      }
      // Goal cells: close enough to the reactor's SURFACE to attack it. Measured to the
      // surface and not the centre, for invariant 9's reason -- an attacker that closed
      // on the centre would be standing inside the box that shields it.
      const dx = x - clamp(x, rb.min.x, rb.max.x);
      const dz = z - clamp(z, rb.min.z, rb.max.z);
      if (Math.hypot(dx, dz) <= cfg.reactorReach) {
        dist[i] = 0;
        queue[tail++] = i;
      }
    }

    // Four-connected flood. The eight-way direction comes out of the gradient below, so
    // the flood itself stays simple and cannot cut a corner it has no room for.
    while (head < tail) {
      const i = queue[head++];
      const col = i % cols;
      const row = (i / cols) | 0;
      for (let k = 0; k < 4; k++) {
        const nc = col + (k === 0 ? 1 : k === 1 ? -1 : 0);
        const nr = row + (k === 2 ? 1 : k === 3 ? -1 : 0);
        if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
        const j = nr * cols + nc;
        if (blocked[j] || dist[j] >= 0) continue;
        dist[j] = dist[i] + 1;
        queue[tail++] = j;
      }
    }

    // Gradient: head for the reachable neighbour closest to the reactor, diagonals
    // included so the motion does not read as a body walking on a chessboard. A
    // diagonal is only allowed when both of its orthogonals are open, or a boarder
    // would clip the corner of a crate it cannot fit past.
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] <= 0) continue;
      const col = i % cols;
      const row = (i / cols) | 0;
      let bestD = dist[i];
      let bx = 0;
      let bz = 0;
      for (let dz2 = -1; dz2 <= 1; dz2++) {
        for (let dx2 = -1; dx2 <= 1; dx2++) {
          if (dx2 === 0 && dz2 === 0) continue;
          const nc = col + dx2;
          const nr = row + dz2;
          if (nc < 0 || nc >= cols || nr < 0 || nr >= rows) continue;
          const j = nr * cols + nc;
          if (dist[j] < 0) continue;
          if (dx2 !== 0 && dz2 !== 0) {
            if (blocked[row * cols + nc] || blocked[nr * cols + col]) continue;
          }
          if (dist[j] < bestD) {
            bestD = dist[j];
            bx = dx2;
            bz = dz2;
          }
        }
      }
      const len = Math.hypot(bx, bz);
      if (len > 0) {
        dirX[i] = bx / len;
        dirZ[i] = bz / len;
      }
    }

    return { dist, dirX, dirZ };
  }

  /**
   * Hull-local direction a boarder of this type should walk to reach the reactor, or
   * null if the field has nothing to say -- off the grid, inside geometry, or in a
   * genuinely walled-off cell. Callers fall back to steering straight at the target,
   * which is exactly the old behaviour and no worse.
   */
  #flowDir(localX, localZ, cfg, out) {
    const f = this.deckFlow;
    const field = f.fields.get(Math.round(cfg.radius * 100));
    if (!field) return null;

    const t = this.trampler;
    const col = Math.floor((localX + t.halfW) / f.cell);
    const row = Math.floor((localZ + t.halfL) / f.cell);
    const onGrid = col >= 0 && col < f.cols && row >= 0 && row < f.rows;

    if (onGrid) {
      const i = row * f.cols + col;
      if (field.dist[i] === 0) return null; // already in range of the reactor
      if (field.dist[i] > 0 && (field.dirX[i] !== 0 || field.dirZ[i] !== 0)) {
        out.set(field.dirX[i], 0, field.dirZ[i]);
        return out;
      }
    }

    // Standing in a cell the field calls solid, which happens ROUTINELY rather than as
    // an edge case: the push-out leaves a body resting exactly ON an expanded face, and
    // the cell containing that point is by definition blocked. Measured as the last
    // remaining stall -- three boarders parked on the engine block's starboard face at
    // local (5.55, 8.15) while the grid insisted nothing could be standing there.
    //
    // So walk out to the nearest cell that does have a route and head for its centre.
    // Nearest ring first, then lowest distance within that ring, which is deterministic
    // and gets the body back onto the field in one short step.
    let bestI = -1;
    let bestD = Infinity;
    for (let ring = 1; ring <= FLOW_RESCUE_RINGS && bestI < 0; ring++) {
      for (let dz = -ring; dz <= ring; dz++) {
        for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          const nc = col + dx;
          const nr = row + dz;
          if (nc < 0 || nc >= f.cols || nr < 0 || nr >= f.rows) continue;
          const j = nr * f.cols + nc;
          if (field.dist[j] < 0) continue;
          if (field.dist[j] < bestD) {
            bestD = field.dist[j];
            bestI = j;
          }
        }
      }
    }
    if (bestI < 0) return null;

    const tx = -t.halfW + ((bestI % f.cols) + 0.5) * f.cell;
    const tz = -t.halfL + (((bestI / f.cols) | 0) + 0.5) * f.cell;
    const dx = tx - localX;
    const dz = tz - localZ;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6) return null;
    out.set(dx / len, 0, dz / len);
    return out;
  }

  /**
   * Is the straight line from this body to the reactor's surface clear of deck
   * furniture? Slab test on x/z in hull space, exact because the hull only yaws.
   *
   * The reactor is skipped: it is the destination, so the segment always ends inside
   * its own expanded box.
   */
  #lineToReactorClear(e, cfg) {
    const t = this.trampler;
    const r = cfg.radius;

    _flowProbe.set(e.x, e.y, e.z);
    t.worldToLocal(_flowProbe);
    const ax = _flowProbe.x;
    const ay = _flowProbe.y;
    const az = _flowProbe.z;

    const rb = t.reactorBox;
    const bx = clamp(ax, rb.min.x, rb.max.x);
    const bz = clamp(az, rb.min.z, rb.max.z);

    for (const b of t.deckObstacles) {
      if (b === rb) continue;
      if (ay + cfg.height * 0.5 < b.min.y || ay - cfg.height * 0.4 > b.max.y) continue;
      if (segmentHitsBox(ax, az, bx, bz, b, r)) return false;
    }
    return true;
  }

  /**
   * Does a hull-local cell square overlap any deck obstacle, for a body of this size?
   *
   * The REACTOR is included here, unlike in the occlusion tests. Its own volume is not
   * standable, so leaving it out would let the field route a path straight through the
   * thing boarders are supposed to stop at the surface of -- invariant 9 from the other
   * side. Goal cells are the free cells within reach of that surface, chosen separately.
   */
  #cellBlocked(x0, x1, z0, z1, y, cfg) {
    const r = cfg.radius;
    for (const b of this.trampler.deckObstacles) {
      if (y + cfg.height * 0.5 < b.min.y || y - cfg.height * 0.4 > b.max.y) continue;
      if (x1 <= b.min.x - r || x0 >= b.max.x + r) continue;
      if (z1 <= b.min.z - r || z0 >= b.max.z + r) continue;
      return true;
    }
    return false;
  }

  /**
   * Push a boarder out of the deck's solid scenery, in hull-local space.
   *
   * Returns true if it moved. Cheapest-axis resolution on x/z only, matching what
   * the player controller does, minus the vertical case.
   *
   * Collision only. WHERE a boarder goes is the flow field's business -- keeping the
   * two apart is the lesson of the four steering rules that were tried here first, all
   * of which tried to make the push-out double as navigation.
   */
  #avoidDeckScenery(local, cfg) {
    const r = cfg.radius;
    let moved = false;

    for (const b of this.trampler.deckObstacles) {
      // Only things whose bulk is actually in the way at this body's height.
      if (local.y + cfg.height * 0.5 < b.min.y || local.y - cfg.height * 0.4 > b.max.y) continue;

      const minX = b.min.x - r;
      const maxX = b.max.x + r;
      const minZ = b.min.z - r;
      const maxZ = b.max.z + r;
      if (local.x <= minX || local.x >= maxX) continue;
      if (local.z <= minZ || local.z >= maxZ) continue;

      const pushXp = maxX - local.x;
      const pushXn = local.x - minX;
      const pushZp = maxZ - local.z;
      const pushZn = local.z - minZ;
      const best = Math.min(pushXp, pushXn, pushZp, pushZn);

      if (best === pushXp) local.x += pushXp;
      else if (best === pushXn) local.x -= pushXn;
      else if (best === pushZp) local.z += pushZp;
      else local.z -= pushZn;
      moved = true;
    }

    return moved;
  }

  #spikerRingWorld(e, cfg, out) {
    _local.set(
      Math.sin(e.fireAngle) * cfg.fireRadius,
      -CFG.trampler.deckHeight + cfg.height / 2,
      -Math.cos(e.fireAngle) * cfg.fireRadius,
    );
    this.trampler.localToWorld(out.copy(_local));
    // Ground is world y=0. The hull bobs, but a firing position on the sand does not.
    out.y = cfg.height / 2;
    return out;
  }

  #spikerMuzzle(e, cfg, out) {
    const forward = cfg.radius * 0.85;
    return out.set(
      e.x - Math.sin(e.yaw) * forward,
      e.y + cfg.height * 0.22,
      e.z - Math.cos(e.yaw) * forward,
    );
  }

  #spikerSolidDistance(origin, dir, maxDist) {
    this.spikerRay.set(origin, dir);
    this.spikerRay.far = maxDist;
    this.spikerHits.length = 0;
    this.spikerRay.intersectObjects(this.spikerOccluders, false, this.spikerHits);
    return this.spikerHits.length > 0 ? this.spikerHits[0].distance : Infinity;
  }

  #spikerCanSee(e, cfg, operative) {
    this.#spikerMuzzle(e, cfg, _shotStart);
    operative.eyePosition(_shotEnd);
    _shotDir.subVectors(_shotEnd, _shotStart);
    const dist = _shotDir.length();
    if (dist < 1e-4 || dist > cfg.fireRange) return false;
    _shotDir.multiplyScalar(1 / dist);
    return this.#spikerSolidDistance(_shotStart, _shotDir, dist) >= dist - 0.08;
  }

  #spikerTarget(e, cfg, crew) {
    let station = null;
    let stationD2 = Infinity;
    let nearest = null;
    let nearestD2 = Infinity;
    let retained = null;

    for (const operative of crew) {
      if (!operative || operative.downed || !this.#spikerCanSee(e, cfg, operative)) continue;
      const dx = operative.position.x - e.x;
      const dy = operative.position.y - e.y;
      const dz = operative.position.z - e.z;
      const d2 = dx * dx + dy * dy + dz * dz;

      if (operative.station && d2 < stationD2) {
        station = operative;
        stationD2 = d2;
      }
      if (operative === e.shotTarget) retained = operative;
      if (d2 < nearestD2) {
        nearest = operative;
        nearestD2 = d2;
      }
    }

    // A station is the role, a retained visible target stops arbitrary target flicker,
    // and strict distance comparisons leave exact ties in deterministic crew order.
    return station ?? retained ?? nearest;
  }

  #nearestWorkingLeg(e) {
    let best = -1;
    let bestD2 = Infinity;
    for (let i = 0; i < this.trampler.legHp.length; i++) {
      if (this.trampler.legHp[i] <= 0) continue;
      this.trampler.footWorld(i, _shotEnd);
      const dx = _shotEnd.x - e.x;
      const dz = _shotEnd.z - e.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < bestD2) {
        best = i;
        bestD2 = d2;
      }
    }
    return best;
  }

  #trackSpiker(e, cfg, crew) {
    const operative = this.#spikerTarget(e, cfg, crew);
    if (operative) {
      e.shotTarget = operative;
      e.shotLeg = -1;
      operative.eyePosition(_shotEnd);
    } else {
      const leg = this.#nearestWorkingLeg(e);
      if (leg < 0) return false;
      e.shotLeg = leg;
      this.trampler.footWorld(leg, _shotEnd);
    }

    e.lockX = _shotEnd.x;
    e.lockY = _shotEnd.y;
    e.lockZ = _shotEnd.z;
    const dx = e.lockX - e.x;
    const dz = e.lockZ - e.z;
    if (dx * dx + dz * dz > 1e-8) e.yaw = Math.atan2(-dx, -dz);
    return true;
  }

  #fireSpiker(e, cfg, crew) {
    this.#spikerMuzzle(e, cfg, _shotStart);

    if (e.shotLeg >= 0) {
      // The tell commits to one leg. If somebody breaks that leg during the lock,
      // abort this release; choosing another here would damage a target that never
      // received a charge cue. The normal state transition returns to the ring and a
      // later charge may acquire a different working leg.
      if (this.trampler.legHp[e.shotLeg] <= 0) return false;
      // A leg is the target geometry itself. Refresh it at release so the visible
      // segment and the damage agree after the walking hull moved during the lock.
      this.trampler.footWorld(e.shotLeg, _shotEnd);
    } else {
      _shotEnd.set(e.lockX, e.lockY, e.lockZ);
    }

    _shotDir.subVectors(_shotEnd, _shotStart);
    const dist = _shotDir.length();
    if (dist < 1e-4) return false;
    _shotDir.multiplyScalar(1 / dist);
    const maxDist = Math.min(dist, cfg.fireRange);
    const solidDist = this.#spikerSolidDistance(_shotStart, _shotDir, maxDist);
    let resolvedDist = Math.min(maxDist, solidDist);

    if (e.shotLeg >= 0) {
      // The target is the fixed foot point, not an arbitrary body centre. Damage only
      // when that point is inside range and no fortress surface stops the ray first;
      // the visible streak and the consequence therefore end at the same place.
      const reachedLeg = dist <= cfg.fireRange && solidDist >= dist - 0.08;
      if (reachedLeg) {
        this.trampler.damageLeg(e.shotLeg, cfg.damage * cfg.legDamageScale);
      }
    } else {
      let hit = null;
      let hitDist = resolvedDist;

      // A teammate can intercept a locked shot. The body test is the same AABB rule
      // contact damage and movement use, and the nearest unobstructed operative wins.
      for (const operative of crew) {
        if (!operative || operative.downed) continue;
        const t = rayBox(
          _shotStart,
          _shotDir,
          operative.position.x,
          operative.position.y,
          operative.position.z,
          operative.half.x,
          operative.half.y,
          operative.half.z,
        );
        if (t < 0 || t > maxDist || t >= hitDist) continue;
        hit = operative;
        hitDist = t;
      }

      if (hit) hit.hurt(cfg.damage);
      resolvedDist = hit ? hitDist : resolvedDist;
    }

    e.shotDx = _shotDir.x;
    e.shotDy = _shotDir.y;
    e.shotDz = _shotDir.z;
    e.shotRange = Number.isFinite(resolvedDist) ? resolvedDist : maxDist;

    // Publish only after the final stop distance is known, so the event explains the exact
    // consequence that just resolved. This is presentation state only: no attack timing,
    // target selection, damage, or seeded stream reads it back.
    const seq = ++this.spikerShotSeq;
    this.spikerShotJournal.push({
      seq,
      startX: _shotStart.x,
      startY: _shotStart.y,
      startZ: _shotStart.z,
      endX: _shotStart.x + _shotDir.x * e.shotRange,
      endY: _shotStart.y + _shotDir.y * e.shotRange,
      endZ: _shotStart.z + _shotDir.z * e.shotRange,
    });
    if (this.spikerShotJournal.length > CFG.enemies.max) {
      this.spikerShotJournal.shift();
    }
    return true;
  }

  #steer(e, speed, target) {
    const dx = target.x - e.x;
    const dz = target.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      e.vx = (dx / d) * speed;
      e.vz = (dz / d) * speed;
    } else {
      e.vx = 0;
      e.vz = 0;
    }
    return Math.hypot(dx, target.y - e.y, dz);
  }

  #writeInstances() {
    const counts = new Array(this.meshes.length).fill(0);
    let anyFlash = false;
    let moundCount = 0;

    for (const e of this.pool) {
      if (!e.alive) continue;

      // Underground: draw a spoil heap on the surface instead of the body. The
      // body is genuinely not there to be shot, and showing it half-sunk would
      // promise a hit that the raycast refuses.
      if (e.state === S.BURROWED) {
        if (moundCount < this.mounds.count + 64) {
          _m.makeRotationY(e.yaw);
          _m.setPosition(e.x, 0.12, e.z);
          this.mounds.setMatrixAt(moundCount++, _m);
        }
        continue;
      }

      const mesh = this.meshes[e.type];
      const cfg = enemyCfg(e.type);
      const i = counts[e.type]++;

      _q.setFromAxisAngle(_yAxis, e.yaw);
      _m.compose(_v.set(e.x, e.y, e.z), _q, _scl);
      mesh.setMatrixAt(i, _m);

      // Per-instance gait: phase, then amplitude from how fast this body is actually
      // travelling.
      //
      // AMPLITUDE FROM SPEED is what keeps this out of the trap the net.js walk cycle
      // was written around and that the test suite has been caught by three times:
      // sampling an oscillating state at one instant. A fixed-amplitude cycle would
      // have every parked body pedalling on the spot, and "parked" is not an edge case
      // here -- it is a chewer latched to a leg, which is the whole under-hull fight.
      //
      // Latched is zeroed OUTRIGHT rather than left to the speed term, because a
      // latched body is carried by the hull and its velocity is the hull's, not its
      // own. It would read as sprinting while standing still on a moving leg.
      //
      // Normalised against speedOf() rather than cfg.speed so a road that makes the
      // horde faster does not peg every amplitude at full and flatten the cue.
      // sqrt of the sum rather than Math.hypot, and the attribute array cached at
      // build time rather than walked per body. Both match what the rest of this file
      // already does in its hot loops -- hypot pays for overflow handling that a
      // velocity in metres per second does not need.
      const anim = this.animArrays[e.type];
      const ref = this.speedOf(cfg);
      anim[i * 2] = e.gaitPhase;
      anim[i * 2 + 1] = e.latched
        ? 0
        : clamp(Math.sqrt(e.vx * e.vx + e.vz * e.vz) / Math.max(ref, 1e-6), 0, 1);

      // Per-instance tint, so a hit is unmistakable. Without it there is no way
      // to tell a shot that connected from one that was swallowed by geometry.
      if (e.flash > 0) {
        anyFlash = true;
        _flash.setScalar(1 + 4 * (e.flash / CFG.combat.weapon.hitFlash));
        mesh.setColorAt(i, _flash);
      } else if (e.fuseT > 0) {
        // A lit fuse pulses. This is the only warning the player gets that a leg
        // is about to come off, so it has to be visible across the arena.
        anyFlash = true;
        const beat = 0.6 + 1.9 * (0.5 + 0.5 * Math.sin(e.fuseT * 14));
        _flash.setRGB(beat, beat * 0.45, beat * 0.3);
        mesh.setColorAt(i, _flash);
      } else if (e.state === S.CHARGING || e.state === S.FIRING) {
        // The whole silhouette warms as the pressure sac fills. The sac geometry makes
        // the source readable; the instance tint keeps the tell visible at gun range.
        anyFlash = true;
        const progress = cfg.chargeTime > 0
          ? 1 - clamp(e.chargeT / cfg.chargeTime, 0, 1)
          : 1;
        const beat = 0.75 + progress * 1.25
          + 0.25 * (0.5 + 0.5 * Math.sin(this.gaitT * 18));
        _flash.setRGB(beat, beat * 0.42, beat * 0.16);
        mesh.setColorAt(i, _flash);
      } else if (mesh.instanceColor) {
        // Wounded things read darker. This is the crowd half of enemy health
        // feedback and it is deliberately NOT a bar.
        //
        // Why it matters: until this existed the only damage feedback in the game
        // was a one-frame white flash, so against a bulwark carrying 740 hp at the
        // ramp it actually spawns on, a player emptying a magazine had no way to
        // tell "wrong tool" from "broken game". That is the exact failure invariant
        // 8 was written to prevent, and it was happening.
        //
        // Why not floating bars: the two games nearest this one both ship without
        // them and invest in in-world feedback instead. Forty-five bars over a
        // crowd is also forty-five things to draw, and this is free -- the
        // per-instance colour buffer already exists for the flash.
        //
        // QUANTISED into bands rather than a smooth fade, for two reasons. It reads
        // as a state you can name instead of a gradient you have to compare against
        // a neighbour, which is the same argument the segmented HUD gauges won. And
        // it makes the "did anything change" test below cheap and exact, so an
        // untouched crowd costs no buffer upload at all.
        const band = e.hp > 0
          ? Math.ceil((e.hp / Math.max(e.maxHp, 1e-6)) * TINT_BANDS)
          : 0;
        if (band !== e.tintBand) {
          e.tintBand = band;
          anyFlash = true;
        }
        if (band >= TINT_BANDS) {
          mesh.setColorAt(i, _white);
        } else {
          // Floor short of black: the silhouette is the only cue available at 70 m
          // through dust, and a nearly-dead enemy that has gone invisible is a
          // worse problem than the one this solves.
          const k = TINT_FLOOR + (1 - TINT_FLOOR) * (band / TINT_BANDS);
          _flash.setScalar(k);
          mesh.setColorAt(i, _flash);
        }
      }
    }

    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      mesh.count = counts[i];
      mesh.instanceMatrix.needsUpdate = true;
      // Unconditional, unlike the colour buffer. Amplitude follows speed, so it
      // really does change on almost every frame for almost every body, and a
      // dirty check would cost a comparison per instance to save nothing.
      mesh.geometry.attributes.aAnim.needsUpdate = true;
      if (mesh.instanceColor && (anyFlash || this.wasFlashing)) {
        mesh.instanceColor.needsUpdate = true;
      }
    }

    this.mounds.count = Math.min(moundCount, 64);
    this.mounds.instanceMatrix.needsUpdate = true;

    this.wasFlashing = anyFlash;
  }

  // ------------------------------------------------------------------ combat

  /**
   * Record the end-of-authority-tick target poses into a bounded, allocation-free ring.
   * Carried bodies use hull-local coordinates because that is what snapshots render against
   * the CURRENT hull; rewinding their old world position would put them behind a moving deck.
   */
  recordCombatFrame(tick) {
    if (!Number.isFinite(tick)) return false;
    const frame = this.combatHistory[this.combatCursor];
    frame.tick = Math.round(tick);
    frame.flags.fill(0);

    for (let i = 0; i < this.pool.length; i++) {
      const e = this.pool[i];
      if (!e.alive) continue;
      const carried = e.onHull || e.latched;
      frame.generation[i] = e.generation;
      frame.flags[i] = COMBAT_PRESENT
        | (carried ? COMBAT_CARRIED : 0)
        | (isSubmerged(e) ? COMBAT_SUBMERGED : 0);

      _combatLocal.set(e.x, e.y, e.z);
      if (carried) this.trampler.worldToLocal(_combatLocal);
      frame.x[i] = _combatLocal.x;
      frame.y[i] = _combatLocal.y;
      frame.z[i] = _combatLocal.z;
      frame.yaw[i] = e.yaw;
    }

    this.combatNewestTick = frame.tick;
    this.combatCursor = (this.combatCursor + 1) % this.combatHistory.length;
    return true;
  }

  /**
   * Load the exact blended entity frame the browser will draw after prediction. This is
   * separate from the authority ring: a render tick may be fractional, and interpolation
   * has already produced the positions the player's crosshair is visibly touching.
   */
  setRenderCombatFrame(tick, entities = []) {
    const frame = this.renderCombatFrame;
    const targets = this.renderTargets;
    frame.tick = Number.isFinite(tick) ? tick : -1;
    frame.flags.fill(0);
    for (let i = 0; i < targets.length; i++) targets[i].alive = false;

    for (const w of entities) {
      const i = w.id;
      if (!Number.isInteger(i) || i < 0 || i >= this.pool.length) continue;
      // Inline the wire decode in this full-pool render path. unpackEnemyBits returns an
      // object, which made interpolation allocate once per visible body per rendered frame.
      const bitsA = w.bitsA ?? 0;
      const bitsB = w.bitsB ?? 0;
      const type = bitsA & 0x07;
      const state = (bitsA >> 3) & 0x07;
      const carried = (bitsA & 64) !== 0;
      const hpFraction = (bitsB & 0x7f) / 0x7f;
      const generation = w.generation ?? 0;
      frame.generation[i] = generation;
      frame.flags[i] = COMBAT_PRESENT
        | (carried ? COMBAT_CARRIED : 0)
        | (state === S.BURROWED ? COMBAT_SUBMERGED : 0);
      frame.x[i] = w.x;
      frame.y[i] = w.y;
      frame.z[i] = w.z;
      frame.yaw[i] = w.yaw;

      const target = targets[i];
      const maxHp = enemyCfg(type).hp;
      target.generation = generation;
      target.type = type;
      target.hp = hpFraction * maxHp;
      target.maxHp = maxHp;
      target.yaw = w.yaw;
      target.alive = true;
    }
    return frame;
  }

  clearRenderCombatFrame() {
    this.renderCombatFrame.tick = -1;
    this.renderCombatFrame.flags.fill(0);
    for (let i = 0; i < this.renderTargets.length; i++) {
      this.renderTargets[i].alive = false;
    }
    this.combatTick = null;
  }

  /** Nearest retained authority frame after clamping an untrusted requested tick. */
  #combatFrameAt(tick) {
    if (!Number.isFinite(tick)) return null;
    const render = this.renderCombatFrame;
    if (render.tick >= 0 && Math.abs(render.tick - tick) < 1e-4) return render;
    if (this.combatNewestTick < 0) return null;

    const wanted = clamp(
      Math.round(tick),
      this.combatNewestTick - this.combatRewindTicks,
      this.combatNewestTick,
    );
    let best = null;
    let bestDelta = Infinity;
    for (const frame of this.combatHistory) {
      if (frame.tick < 0) continue;
      const delta = Math.abs(frame.tick - wanted);
      if (delta >= bestDelta) continue;
      best = frame;
      bestDelta = delta;
    }
    return best;
  }

  /**
   * Nearest enemy along a ray, as a box matching what is drawn. Callers must pass
   * a maxDist already clipped by world geometry, otherwise you could shoot
   * chewers through the hull -- which would defeat the entire point of putting
   * them underneath it.
   *
   * When `combatTick` is set, positions come from the rendered/historical frame while the
   * returned object is the CURRENT pooled body. Generation and alive checks join those two
   * facts: an old pose can damage the same still-living enemy, never a new occupant that
   * recycled its slot and never something already dead on authority.
   */
  raycast(origin, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    let bestYaw = 0;
    const pad = CFG.combat.weapon.hitPad;
    const frame = this.#combatFrameAt(this.combatTick);
    const renderFrame = frame === this.renderCombatFrame;

    for (let i = 0; i < this.pool.length; i++) {
      // A presentation frame owns its identity as well as its pose. The authority pool may
      // already have killed or recycled this slot while interpolation still visibly draws the
      // older generation, so returning that current body would make the visible target locally
      // unhittable or report the replacement's type and armour.
      const e = renderFrame ? this.renderTargets[i] : this.pool[i];
      let x;
      let y;
      let z;
      let yaw;

      if (frame) {
        const flags = frame.flags[i];
        if ((flags & COMBAT_PRESENT) === 0 || (flags & COMBAT_SUBMERGED) !== 0) continue;
        // Historical authority shots still deal consequence to the real pooled body, and may
        // do so only while the recorded generation remains its current living occupant.
        if (!renderFrame && (!e.alive || e.generation !== frame.generation[i])) continue;
        x = frame.x[i];
        y = frame.y[i];
        z = frame.z[i];
        yaw = frame.yaw[i];
        if ((flags & COMBAT_CARRIED) !== 0) {
          _combatLocal.set(x, y, z);
          this.trampler.localToWorld(_combatLocal);
          x = _combatLocal.x;
          y = _combatLocal.y;
          z = _combatLocal.z;
        }
      } else {
        if (!e.alive || isSubmerged(e)) continue;
        x = e.x;
        y = e.y;
        z = e.z;
        yaw = e.yaw;
      }

      const cfg = enemyCfg(e.type);
      const h = cfg.radius * 1.2 * cfg.bulk + pad;
      const hy = cfg.height / 2 + pad;

      const t = rayBox(origin, dir, x, y, z, h, hy, h);
      if (t < 0 || t >= bestT) continue;

      bestT = t;
      best = e;
      bestYaw = yaw;
    }

    return best ? { enemy: best, distance: bestT, yaw: bestYaw } : null;
  }

  /**
   * Apply damage. Returns true if the hit killed it.
   *
   * Armour is applied HERE rather than at each weapon, for the same reason the
   * geometry occlusion rule lives in one place: every damage source in the game
   * funnels through this method, so a newly added weapon cannot accidentally
   * ignore armour and quietly make the bulwark pointless.
   */
  /**
   * `source` is WHOEVER caused it, and it exists to protect invariant 2b.
   *
   * It used to be a STRING -- "player" for anything the crew aimed, "emitter" for
   * automation -- and every proc gated on `source === "player"`. That was the same
   * question while there was one operative and a different one the moment there were
   * two: it says what KIND of thing caused the kill and not WHICH person, so with a
   * crew, one operative's kills would fire another operative's procs and their splash
   * would heal somebody else. A string cannot name a person.
   *
   * So a source is now the causer itself: an operative for anything the crew aimed, or
   * the subsystem for automation -- the Emitters instance for a shock emitter. Ask the
   * question through `causedBy`, never by hand, because the two rules collapse into one
   * identity test and writing it out invites writing it wrong. `by !== null` would
   * satisfy invariant 2b and silently let a teammate's kill proc yours.
   *
   * Income is paid for every kill regardless of source; only procs are gated.
   *
   * Still optional, so the ~200 bare `damage(e, amount)` calls in the harness are
   * unaffected and simply proc nothing, which is the correct behaviour for a test that
   * is measuring something else.
   */
  damage(e, amount, source = null, pierce = 0) {
    if (!e.alive) return false;
    const cfg = enemyCfg(e.type);
    e.hp -= afterArmour(amount, cfg.armour, pierce);
    e.flash = CFG.combat.weapon.hitFlash;
    if (e.hp > 0) return false;
    this.#kill(e, true, source);
    return true;
  }

  /**
   * Remove an enemy. `paid` decides whether the economy hears about it: a sapper
   * that completes its charge is not a kill anybody earned.
   */
  #kill(e, paid, source = null) {
    e.alive = false;
    e.reactorSlot = false;
    e.latched = false;
    e.fuseT = 0;
    e.chargeT = 0;
    e.shotT = 0;
    e.shotLocked = false;
    e.shotTarget = null;
    e.shotLeg = -1;
    e.shotRange = 0;
    this.liveCount--;
    // Where and what died, for the particle system and the mixer. Recorded even
    // for an unpaid removal, because a sapper's charge going off is exactly the
    // moment that most wants a bang.
    this.lastKill = { x: e.x, y: e.y, z: e.z, type: e.type, paid };
    this.deathCount++;
    if (!paid) return;
    this.killCount++;
    // Single choke point for every kill in the game, whatever fired the shot --
    // rifle, either deck gun, a shock emitter, a foot. The economy and every
    // on-kill item hook here, so a new damage source cannot silently pay nothing
    // and cannot silently fail to trigger a build.
    //
    // `source` rides along so item procs can refuse to fire for automated kills.
    // The economy ignores it: income is earned however something died.
    //
    // Optional, because tools/scene-cost.mjs builds a Horde purely to count draw
    // calls and has no business owning an event bus.
    this.events?.emitKill(e, source);
  }

  /**
   * Shove bodies out of a sphere. Used by the legs coming down.
   *
   * NO DAMAGE, and that is a load-bearing decision rather than an omission. See
   * the stomp block in config.js: a foot that dealt even non-lethal damage was
   * measured holding fourteen chewers off the legs alongside three emitters, with
   * no player present, which is invariant 2b failing silently.
   *
   * Latched attackers are skipped as well. Geometry already puts them 0.9 m out of
   * reach, but a shove that could break an enemy off a leg would delay leg damage
   * for free, which is the same automation problem with the damage taken out.
   *
   * Returns how many bodies moved, so the caller can decide whether it was worth a
   * sound and a cloud of dust.
   */
  shoveFrom(x, z, radius, strength) {
    const r2 = radius * radius;
    let moved = 0;

    for (const e of this.pool) {
      if (!e.alive || e.state === S.BURROWED || e.latched || e.onHull) continue;
      const dx = e.x - x;
      const dz = e.z - z;
      const d2 = dx * dx + dz * dz;
      if (d2 > r2) continue;

      const cfg = enemyCfg(e.type);
      const d = Math.sqrt(d2);
      // Straight up under the foot: pick a deterministic direction rather than
      // dividing by zero. Using the seeded stream keeps the sim reproducible.
      const nx = d > 1e-4 ? dx / d : Math.cos(this.random() * Math.PI * 2);
      const nz = d > 1e-4 ? dz / d : Math.sin(this.random() * Math.PI * 2);
      const push = strength * cfg.shoveScale * (1 - d / radius);

      // Added to a decaying velocity, never written straight into position. The
      // integrator then moves it a fraction of a metre per frame, which is what
      // keeps invariant 20 -- enemies must never teleport -- true.
      e.shoveVx += nx * push;
      e.shoveVz += nz * push;
      moved++;
    }

    return moved;
  }

  /** Live enemies of a type. Used by the HUD to call out a boss or a sapper. */
  countType(type) {
    let n = 0;
    for (const e of this.pool) if (e.alive && e.type === type) n++;
    return n;
  }
}

/**
 * Ray against an axis-aligned box, returning the entry distance, 0 if the ray
 * starts inside, or -1 for a miss.
 *
 * Starting inside counts as a hit on purpose. The old sphere test required the
 * centre to project forward along the ray, so an enemy pressed right up against
 * the player -- exactly when you most want to shoot it -- was unhittable.
 */
function rayBox(o, d, cx, cy, cz, hx, hy, hz) {
  let tmin = 0;
  let tmax = Infinity;

  const ox = o.x - cx;
  const oy = o.y - cy;
  const oz = o.z - cz;

  // x slab
  if (Math.abs(d.x) < 1e-8) {
    if (Math.abs(ox) > hx) return -1;
  } else {
    const inv = 1 / d.x;
    let t1 = (-hx - ox) * inv;
    let t2 = (hx - ox) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  // y slab
  if (Math.abs(d.y) < 1e-8) {
    if (Math.abs(oy) > hy) return -1;
  } else {
    const inv = 1 / d.y;
    let t1 = (-hy - oy) * inv;
    let t2 = (hy - oy) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  // z slab
  if (Math.abs(d.z) < 1e-8) {
    if (Math.abs(oz) > hz) return -1;
  } else {
    const inv = 1 / d.z;
    let t1 = (-hz - oz) * inv;
    let t2 = (hz - oz) * inv;
    if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  return tmax < 0 ? -1 : tmin;
}
