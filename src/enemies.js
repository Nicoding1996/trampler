import * as THREE from "three";
import { CFG } from "./config.js";
import { makeRandom } from "./util.js";

// Pooled horde on InstancedMesh with a spatial hash for separation.
//
// Built this way from the start on purpose. Retrofitting crowd tech onto a
// one-Object3D-per-enemy codebase is a rewrite, and the whole point of the
// Risk of Rain power curve is that late waves put a screen full of things in
// front of you to delete.
//
// The two enemy types exist to create opposite pressures:
//
//   Chewers plant themselves INBOARD of the legs, underneath the hull slab.
//   The deck blocks line of sight straight down, so they cannot be shot from
//   up top. They are the reason to dismount.
//
//   Climbers board via authored routes and go for the reactor. They are the
//   reason not to stay down there.

export const CHEWER = 0;
export const CLIMBER = 1;

const S = {
  HUNT_LEG: 0,
  TO_CLIMB: 1,
  CLIMBING: 2,
  ON_DECK: 3,
};

const _v = new THREE.Vector3();
const _local = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _flash = new THREE.Color();
const _white = new THREE.Color(1, 1, 1);

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
    this.cursor = 0;
    this.grid = new Grid(CFG.enemies.separation * 2);

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
      };
    }

    this.#buildMeshes(scene);
  }

  #buildMeshes(scene) {
    const c = CFG.enemies.chewer;
    const l = CFG.enemies.climber;

    this.meshes = [
      new THREE.InstancedMesh(
        new THREE.BoxGeometry(c.radius * 2, c.height, c.radius * 2.4),
        new THREE.MeshStandardMaterial({ color: 0x82323f, roughness: 0.75 }),
        CFG.enemies.max,
      ),
      new THREE.InstancedMesh(
        new THREE.BoxGeometry(l.radius * 2, l.height, l.radius * 1.8),
        new THREE.MeshStandardMaterial({
          color: 0xa8761f, roughness: 0.6, emissive: 0x3a1e00, emissiveIntensity: 0.4,
        }),
        CFG.enemies.max,
      ),
    ];

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
   */
  spawn(type, hpScale = 1, arcOffset = null) {
    const e = this.#free();
    if (!e) return null;

    const t = this.trampler;
    const cfg = type === CHEWER ? CFG.enemies.chewer : CFG.enemies.climber;

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

    if (type === CHEWER) {
      e.state = S.HUNT_LEG;
      e.legIndex = this.#pickLeg();
    } else {
      e.state = S.TO_CLIMB;
      e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
    }

    this.liveCount++;
    return e;
  }

  clear() {
    for (const e of this.pool) e.alive = false;
    this.liveCount = 0;

    // Re-seed, so a restarted encounter is the SAME fight. Seeding exists to make
    // two attempts comparable; carrying the stream across a reset would hand the
    // player a different wave pattern and quietly defeat the whole point.
    this.random = makeRandom(this.seed);
  }

  // ------------------------------------------------------------------ update

  update(dt, player) {
    const t = this.trampler;
    const en = CFG.enemies;
    const pool = this.pool;
    const grid = this.grid;

    grid.clear();
    for (let i = 0; i < pool.length; i++) {
      if (pool[i].alive) grid.insert(i, pool[i].x, pool[i].z);
    }

    // Counted for the HUD: how many are in the hull's shadow, where no gun can
    // reach them. Tells the player what they are about to drop into.
    this.underHull = 0;
    this.aboard = 0;

    const sep = en.separation;
    const sep2 = sep * sep;
    const cell = grid.cell;

    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (!e.alive) continue;

      const cfg = e.type === CHEWER ? en.chewer : en.climber;
      e.atkCd = Math.max(0, e.atkCd - dt);
      if (e.flash > 0) e.flash = Math.max(0, e.flash - dt);

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
        case S.HUNT_LEG: {
          // With every leg already down there is nothing left to chew, and they
          // would otherwise huddle under the hull doing nothing at all -- the
          // fortress crippled but the threat gone. So they escalate and board.
          if (t.brokenLegs() >= t.legHp.length) {
            e.state = S.TO_CLIMB;
            e.latched = false;
            e.climbT = 0;
            e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
            break;
          }

          if (t.legHp[e.legIndex] <= 0) {
            e.legIndex = this.#pickLeg();
            e.latched = false;
          }
          t.legAttackWorld(e.legIndex, _v);

          // Once in reach a chewer LATCHES to the hull and is carried by it,
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

          // Neighbour separation can shove a latched chewer off its spot. Well
          // outside reach, let go and walk back in.
          if (e.latched && d > cfg.reach * 1.6) e.latched = false;

          if (e.latched) {
            // Enemies have no collision against the fortress, so holding still is
            // what stops them walking straight through it.
            e.vx = 0;
            e.vz = 0;
          } else {
            this.#steer(e, cfg, _v);
            if (d < cfg.reach) {
              e.latched = true;
              e.vx = 0;
              e.vz = 0;
            }
          }

          if (e.latched && e.atkCd <= 0) {
            t.damageLeg(e.legIndex, cfg.damage);
            e.atkCd = 1 / cfg.attackRate;
          }
          break;
        }

        case S.TO_CLIMB: {
          const route = t.climbRoutes[e.routeIndex];
          t.localToWorld(_v.copy(route.start));
          const d = this.#steer(e, cfg, _v);
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
          e.climbT = Math.min(1, e.climbT + dt / cfg.climbTime);
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
          const d = this.#steer(e, cfg, _v);
          if (d < cfg.reactorReach) {
            e.vx = 0;
            e.vz = 0;
            if (e.atkCd <= 0) {
              t.damageReactor(cfg.damage);
              e.atkCd = 1 / cfg.attackRate;
            }
          }
          break;
        }
      }

      if (!driven) {
        // Separation against neighbours in the 9 surrounding hash cells.
        let px = 0;
        let pz = 0;
        for (let dx = -1; dx <= 1; dx++) {
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

        e.x += (e.vx + px * cfg.speed * 0.9) * dt;
        e.z += (e.vz + pz * cfg.speed * 0.9) * dt;
        if (!e.onHull) e.y = cfg.height / 2;
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
            e.routeIndex = (this.random() * t.climbRoutes.length) | 0;
          }
        }
      }

      if (e.onHull) {
        this.aboard++;
      } else {
        _local.set(e.x, e.y, e.z);
        t.worldToLocal(_local);
        if (Math.abs(_local.x) < t.halfW && Math.abs(_local.z) < t.halfL && _local.y < -1) {
          this.underHull++;
        }
      }

      // Anything adjacent hurts the player, on deck or on the sand.
      const dx = player.position.x - e.x;
      const dy = player.position.y - e.y;
      const dz = player.position.z - e.z;
      const reach = en.playerReach;
      if (dx * dx + dy * dy + dz * dz < reach * reach && e.atkCd <= 0) {
        player.hurt(cfg.damage);
        e.atkCd = 1 / cfg.attackRate;
      }
    }

    this.#writeInstances();
  }

  #steer(e, cfg, target) {
    const dx = target.x - e.x;
    const dz = target.z - e.z;
    const d = Math.hypot(dx, dz);
    if (d > 1e-4) {
      e.vx = (dx / d) * cfg.speed;
      e.vz = (dz / d) * cfg.speed;
    } else {
      e.vx = 0;
      e.vz = 0;
    }
    return Math.hypot(dx, target.y - e.y, dz);
  }

  #writeInstances() {
    const counts = [0, 0];
    let anyFlash = false;

    for (const e of this.pool) {
      if (!e.alive) continue;
      const mesh = this.meshes[e.type];
      const i = counts[e.type]++;

      _m.makeRotationY(e.yaw);
      _m.setPosition(e.x, e.y, e.z);
      mesh.setMatrixAt(i, _m);

      // Per-instance tint, so a hit is unmistakable. Without it there is no way
      // to tell a shot that connected from one that was swallowed by geometry.
      if (e.flash > 0) {
        anyFlash = true;
        _flash.setScalar(1 + 4 * (e.flash / CFG.combat.weapon.hitFlash));
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

    this.wasFlashing = anyFlash;
  }

  // ------------------------------------------------------------------ combat

  /**
   * Nearest enemy along a ray, as a hit sphere. Callers must pass a maxDist
   * already clipped by world geometry, otherwise you could shoot chewers
   * through the hull -- which would defeat the entire point of putting them
   * underneath it.
   */
  raycast(origin, dir, maxDist) {
    let best = null;
    let bestT = maxDist;
    const pad = CFG.combat.weapon.hitPad;

    for (const e of this.pool) {
      if (!e.alive) continue;
      const cfg = e.type === CHEWER ? CFG.enemies.chewer : CFG.enemies.climber;
      const h = cfg.radius * 1.2 + pad;
      const hy = cfg.height / 2 + pad;

      const t = rayBox(origin, dir, e.x, e.y, e.z, h, hy, h);
      if (t < 0 || t >= bestT) continue;

      bestT = t;
      best = e;
    }

    return best ? { enemy: best, distance: bestT } : null;
  }

  /** Returns true if the hit killed it. */
  damage(e, amount) {
    if (!e.alive) return false;
    e.hp -= amount;
    e.flash = CFG.combat.weapon.hitFlash;
    if (e.hp > 0) return false;
    e.alive = false;
    this.liveCount--;
    return true;
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
