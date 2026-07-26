import * as THREE from "three";
import { CFG, ENEMY_TYPE_KEYS, enemyCfg, afterArmour } from "./config.js";
import { makeRandom } from "./util.js";
import { Look, enemyGeometry } from "./look.js";

// Pooled horde on InstancedMesh with a spatial hash for separation.
//
// Built this way from the start on purpose. Retrofitting crowd tech onto a
// one-Object3D-per-enemy codebase is a rewrite, and the whole point of the
// Risk of Rain power curve is that late waves put a screen full of things in
// front of you to delete.
//
// SIX types now, and they exist to attack the pillar from six different angles:
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

const S = {
  HUNT_LEG: 0,
  TO_CLIMB: 1,
  CLIMBING: 2,
  ON_DECK: 3,
  // Underground: driven toward the leg, untouchable, and not counted as pressure
  // because there is nothing the crew can do about it yet.
  BURROWED: 4,
};

export { S as ENEMY_STATE };

const _v = new THREE.Vector3();
const _local = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _scl = new THREE.Vector3(1, 1, 1);
const _flash = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);
// Hoisted out of the instance-writing loop. Allocating this per enemy per frame
// is 400 Vector3s a frame at a full pool, and test 17 pins the whole simulation
// step at well under a millisecond -- garbage is exactly how that budget goes.
const _yAxis = new THREE.Vector3(0, 1, 0);

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

    // Counters, for audio and the HUD. Polling a counter keeps the simulation
    // unaware that a mixer or a particle system exists.
    this.killCount = 0;

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
        alive: false, type: CHEWER, hp: 0, maxHp: 1,
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
        // Decaying knock-aside velocity from a foot coming down. Stored as
        // velocity rather than applied as a displacement, because anything that
        // moves a body instantly reads as a teleport -- see invariant 20.
        shoveVx: 0,
        shoveVz: 0,
        // Holds one of the reactor's limited engagement slots.
        reactorSlot: false,
      };
    }

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
    };

    this.meshes = ENEMY_TYPE_KEYS.map((key) => {
      const cfg = CFG.enemies[key];
      const skin = skins[key];
      const mesh = new THREE.InstancedMesh(
        enemyGeometry(key, cfg),
        Look.std(`enemy_${key}`, {
          color: skin.color,
          emissive: skin.emissive,
          emissiveIntensity: 0.35 * cfg.glow,
          roughness: skin.roughness ?? 0.72,
          metalness: skin.metalness ?? 0.08,
        }),
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

      scene.add(m);
    }
    this.wasFlashing = false;

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

    e.alive = true;
    e.type = type;
    e.maxHp = cfg.hp * hpScale;
    e.hp = e.maxHp;
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
    e.fuseT = 0;
    e.burrowT = 0;
    e.reactorSlot = false;
    e.shoveVx = 0;
    e.shoveVz = 0;

    if (cfg.goal === "reactor") {
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
    this.liveCount = 0;

    // Re-seed, so a restarted encounter is the SAME fight. Seeding exists to make
    // two attempts comparable; carrying the stream across a reset would hand the
    // player a different wave pattern and quietly defeat the whole point.
    this.random = makeRandom(this.seed);
  }

  /** Speed of a type right now, including the road modifier. */
  speedOf(cfg) {
    return cfg.speed * this.speedScale;
  }

  // ------------------------------------------------------------------ update

  update(dt, player) {
    const t = this.trampler;
    const en = CFG.enemies;
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
          // Position is driven along a hull-local line, so the route tracks the
          // walking, turning hull for free.
          const route = t.climbRoutes[e.routeIndex];
          e.climbT = Math.min(1, e.climbT + dt / (cfg.climbTime * this.climbScale));
          _local.lerpVectors(e.climbFrom, route.end, e.climbT);
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

      // Anything adjacent hurts the player, on deck or on the sand -- except
      // something that is currently underground, which cannot touch anybody.
      if (e.state !== S.BURROWED && cfg.damage > 0) {
        const dx = player.position.x - e.x;
        const dy = player.position.y - e.y;
        const dz = player.position.z - e.z;
        const reach = en.playerReach + cfg.radius - 0.5;
        if (dx * dx + dy * dy + dz * dz < reach * reach && e.atkCd <= 0) {
          player.hurt(cfg.damage);
          e.atkCd = 1 / cfg.attackRate;
        }
      }
    }

    this.#writeInstances();
  }

  /**
   * Push a boarder out of the deck's solid scenery, in hull-local space.
   *
   * Returns true if it moved. Cheapest-axis resolution on x/z only, matching what
   * the player controller does, minus the vertical case.
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
      const i = counts[e.type]++;

      _q.setFromAxisAngle(_yAxis, e.yaw);
      _m.compose(_v.set(e.x, e.y, e.z), _q, _scl);
      mesh.setMatrixAt(i, _m);

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
      } else if (mesh.instanceColor) {
        mesh.setColorAt(i, _white);
      }
    }

    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i];
      mesh.count = counts[i];
      mesh.instanceMatrix.needsUpdate = true;
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
   * Nearest enemy along a ray, as a box matching what is drawn. Callers must pass
   * a maxDist already clipped by world geometry, otherwise you could shoot
   * chewers through the hull -- which would defeat the entire point of putting
   * them underneath it.
   */
  raycast(origin, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    const pad = CFG.combat.weapon.hitPad;

    for (const e of this.pool) {
      if (!e.alive) continue;
      // Underground, and therefore not a target. Finite by construction: see the
      // burrowTime comment in config. Nothing can hide here permanently.
      if (e.state === S.BURROWED) continue;

      const cfg = enemyCfg(e.type);
      const h = cfg.radius * 1.2 * cfg.bulk + pad;
      const hy = cfg.height / 2 + pad;

      const t = rayBox(origin, dir, e.x, e.y, e.z, h, hy, h);
      if (t < 0 || t >= bestT) continue;

      bestT = t;
      best = e;
    }

    return best ? { enemy: best, distance: bestT } : null;
  }

  /**
   * Apply damage. Returns true if the hit killed it.
   *
   * Armour is applied HERE rather than at each weapon, for the same reason the
   * geometry occlusion rule lives in one place: every damage source in the game
   * funnels through this method, so a newly added weapon cannot accidentally
   * ignore armour and quietly make the bulwark pointless.
   */
  damage(e, amount) {
    if (!e.alive) return false;
    const cfg = enemyCfg(e.type);
    e.hp -= afterArmour(amount, cfg.armour);
    e.flash = CFG.combat.weapon.hitFlash;
    if (e.hp > 0) return false;
    this.#kill(e, true);
    return true;
  }

  /**
   * Remove an enemy. `paid` decides whether the economy hears about it: a sapper
   * that completes its charge is not a kill anybody earned.
   */
  #kill(e, paid) {
    e.alive = false;
    e.reactorSlot = false;
    e.latched = false;
    e.fuseT = 0;
    this.liveCount--;
    // Where and what died, for the particle system and the mixer. Recorded even
    // for an unpaid removal, because a sapper's charge going off is exactly the
    // moment that most wants a bang.
    this.lastKill = { x: e.x, y: e.y, z: e.z, type: e.type, paid };
    if (!paid) return;
    this.killCount++;
    // Single choke point for every kill in the game, whatever fired the shot --
    // rifle, either deck gun, a shock emitter, a foot. The economy hooks here so
    // a new damage source cannot silently pay nothing.
    this.onKill?.(e);
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
