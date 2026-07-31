import * as THREE from "three";
import { CFG, enemyCfg, armourAt } from "./config.js";
import { hashUnit, makeRandom } from "./util.js";

// Hitscan rifle. Deliberately plain -- it exists so there is something to do
// about the horde, not because gunplay is the question under test.
//
// The one part that matters: every shot is clipped by world geometry BEFORE
// enemies are considered. Without that you could shoot chewers straight through
// the hull, and the whole reason they hide underneath it would evaporate.

const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _end = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _beamDir = new THREE.Vector3();
const UP_Y = new THREE.Vector3(0, 1, 0);

const TRACERS = 12;
const IMPACTS = 16;

export class Weapon {
  /**
   * Throw unless this weapon belongs to `operative`.
   *
   * A WIRING GUARD, and it exists because the mistake it catches is silent and severe.
   * Every personal item recomputes absolutely from its stack count -- `rifle` writes
   * `weapon.damageScale`, `trigger` writes `fireRateScale`, `sabot` writes `armourPierce`
   * -- which is correct with one owner and destructive with two. Measured: two operatives
   * sharing one Weapon, crew 1 buys four rifle calibrations for a damageScale of 2.00, crew
   * 2 recomputes their own unrelated kit, and it drops to 1.00. Four stacks gone, stack
   * counts intact, nothing thrown. Exactly the shape of the fortress collision.
   *
   * `Items.update` makes it worse by being a second writer: it clears and rebuilds
   * `damageBonus` from current conditions every frame, so two Items over one Weapon would
   * fight over the field every frame and one operative's position would buff the other.
   *
   * The fortress case was fixed by SHARING the counts, because fortress refits genuinely
   * are the crew's. Personal kit is the opposite -- it must not be shared, so there is
   * nothing to unify and the only defence is refusing the arrangement. Same reasoning as
   * exporting `isSubmerged` and `causedBy`: turn a wrong answer into a load failure.
   */
  assertOperative(operative) {
    if (this.player && operative && this.player !== operative) {
      throw new Error(
        "Weapon belongs to a different operative: personal upgrades recompute absolutely "
        + "from stack counts, so two operatives over one Weapon silently wipe each "
        + "other's kit. Give each operative their own Weapon.",
      );
    }
  }

  constructor(scene, player, horde, world, trampler) {
    this.player = player;
    this.horde = horde;

    this.cooldown = 0;
    this.shots = 0;
    // One observer event per trigger pull. `shots` remains per pellet for existing local
    // readers; this counter lets a nine-pellet blast collapse to its latest authoritative
    // tracer without demanding nine remote flashes.
    this.shotCues = 0;
    this.hits = 0;
    this.kills = 0;

    // The newest tracer exactly as the authoritative weapon drew it, in world space.
    // Preallocated because every pellet writes these vectors. Snapshots copy the numbers so
    // observers can draw the cue without replaying the ray, damage, hit bus or recoil.
    this.lastShotStart = new THREE.Vector3();
    this.lastShotEnd = new THREE.Vector3();

    // NETWORK ARBITRATION, off by default so solo is byte-identical.
    //
    // `arbitrated` makes a shot presentation-only: it still traces, still clips on geometry, still
    // flashes and still counts, but deals no damage and publishes nothing on the bus. Set by the
    // client once the server is authoritative. See the long note in `shootFrom`.
    this.arbitrated = false;

    // The input sequence a shot belongs to, for deterministic cone spread. 0 means "no agreed
    // index", and the seeded stream is used instead — which is the solo path and is unchanged.
    // `shotsThisKey` distinguishes two shots that land on the same sequence.
    this.spreadKey = 0;
    this.shotsThisKey = 0;
    this.blockedByHull = 0; // diagnostic: shots that hit the fortress instead
    this.hitFlash = 0;      // drives the crosshair hitmarker

    // What a shot fired RIGHT NOW would connect with, or null. Rescanned every
    // frame and polled by the HUD, following the same rule as every other reader:
    // the simulation publishes state and has no idea a HUD exists.
    //
    // This lives on the weapon rather than in hud.js for the reason the number-key
    // router does: a rule that matters belongs in a module, because the harness
    // cannot import main.js and cannot see the DOM. It is also the honest place for
    // it -- the question the readout answers is "would this shot land", which is
    // the weapon's own question, and it therefore goes through the same occlusion
    // clip that keeps chewers safe under the hull. A target you cannot shoot is
    // correctly reported as no target at all.
    this.aimTarget = null;
    this.aimDist = 0;
    // How much armour a shot RIGHT NOW would actually meet, which is not the same as
    // the type's armour once a plate is directional. Published so the readout can say
    // "your rifle works from here", which is the only way the flank rule ever gets
    // taught -- a player who never happens to walk behind a bulwark would otherwise
    // never learn it exists.
    this.aimArmour = 0;

    this.raycaster = new THREE.Raycaster();

    // Multipliers owned by the economy. 1 means no upgrades. Instance fields
    // rather than CFG edits, so a run's build cannot leak into global config or
    // into the next attempt at the same seeded wave.
    this.damageScale = 1;
    this.fireRateScale = 1;
    // Additive, conditional, and rewritten from current conditions every frame by
    // the item runtime. Zero when nothing applies.
    this.damageBonus = 0;
    // Flat armour ignored per shot, from SABOT ROUNDS. Zero by default, so the
    // bulwark keeps making the rifle the wrong tool until a run decides otherwise.
    this.armourPierce = 0;

    // What is in your hands. Resolved from config once, so a swap is an index move
    // rather than a lookup, and stored as a PROFILE rather than as a weapon type --
    // every read below goes through `this.profile.x`, so there is no branch anywhere
    // on which weapon is out. That matters for the same reason `enemyCfg(type)`
    // exists instead of ternaries: a third weapon must not be able to inherit the
    // rifle's numbers by being forgotten in one branch.
    this.profiles = CFG.combat.loadout.carried.map((k) => CFG.combat[k]);
    this.slot = 0;
    this.profile = this.profiles[0];
    // Polled by the presentation layer the same way `shots` and `footfalls` are, so
    // the simulation still has no idea a HUD or a viewmodel exists.
    this.swaps = 0;

    // Assigned by whoever owns the bus, not taken as a constructor argument, so
    // tools/scene-cost.mjs can build a Weapon to count draw calls without one.
    this.events = null;

    // Cone spread is seeded, like every other stochastic part of the sim. At
    // 0.007 rad it scatters a shot by ~0.2 m at 30 m, which was enough to make a
    // measured tracer length differ between otherwise identical runs.
    //
    // THIS STREAM CANNOT SURVIVE CLIENT PREDICTION, AND IT IS THE ONLY ONE THAT CANNOT.
    //
    // A STREAM IS ORDER-DEPENDENT. Its next value depends on how many draws came before
    // it, so a client and a server holding separate `makeRandom(sameSeed)` agree only
    // while they make identical draws in identical order. They will not: the shot below
    // draws two values PER PELLET, a client mispredicts a shot the server refused for
    // heat or for a station change, and from that moment the two streams are permanently
    // one draw apart. Not drift -- two different sequences. The client's tracer then
    // points somewhere the authoritative round did not go, forever.
    //
    // So when the client starts firing locally for feedback, spread stops being drawn
    // from here and becomes a HASH OF AN AGREED INDEX: the input sequence number, the
    // shot's index within that sequence, and the pellet's index within the shot. All
    // three are values both sides already have -- the server knows which input sequence
    // it processed -- and a hash of them is order-INdependent, so a mispredicted shot
    // costs nothing because the next agreed index is unchanged.
    //
    // THE GENERAL RULE, worth stating because it decides where every future stochastic
    // value goes: anything the CLIENT must agree with the server about is keyed on an
    // agreed index; anything the server decides alone keeps its stream, because the
    // client is told the outcome rather than reproducing it. Spawn bearings, wave
    // composition, road offers, shop stock and item procs are all the second kind and
    // are untouched. Surveyed, and cone spread is the only value of the first kind in
    // the project -- player.js, grapple.js, deckgun.js, repair.js and emitters.js hold
    // no seeded stream at all, and `items.js`'s proc stream never advances on a client
    // because a client deals no damage.
    //
    // Invariant 21 is preserved either way: a hash of a sequence number is still
    // reproducible, and still has no `Math.random` in it.
    this.random = makeRandom(CFG.combat.weapon.seed);

    // Railings are collision geometry for BODIES, not for bullets. They are
    // solid boxes only so the player cannot walk through them; a real railing is
    // mostly air. Leaving them in the occluder set meant the deck gun shot its
    // own gunwale on almost every depressed angle.
    //
    // This does not weaken the rule that matters: chewers under the hull are
    // shielded by the 3 m hull slab, not by the railings.
    this.occluders = [
      ...world.grappleables,
      ...trampler.grappleables.filter((m) => m.userData.tag !== "rail"),
    ];

    // Unit-length cylinder along +Y, scaled per shot. Radius 1 so the tracer's
    // thickness can be set purely by scale.
    this.tracers = [];
    const beam = new THREE.CylinderGeometry(1, 1, 1, 6);
    const beamMat = new THREE.MeshBasicMaterial({
      color: CFG.combat.weapon.tracerColor,
      transparent: true,
      opacity: CFG.combat.weapon.tracerOpacity,
      depthWrite: false,
    });
    for (let i = 0; i < TRACERS; i++) {
      const m = new THREE.Mesh(beam, beamMat);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.tracers.push({ mesh: m, life: 0 });
    }

    // Impact markers. At range these, not the beam, are what tell you where the
    // shot landed -- and the colour tells you whether you hit flesh or fortress.
    this.impacts = [];
    const puff = new THREE.SphereGeometry(1, 12, 8);
    this.impactMat = {
      solid: new THREE.MeshBasicMaterial({
        color: 0xd8c9a8, transparent: true, opacity: 0.38, depthWrite: false,
      }),
      flesh: new THREE.MeshBasicMaterial({
        color: 0xff8a5c, transparent: true, opacity: 0.95, depthWrite: false,
      }),
    };
    for (let i = 0; i < IMPACTS; i++) {
      const m = new THREE.Mesh(puff, this.impactMat.solid);
      m.visible = false;
      m.frustumCulled = false;
      scene.add(m);
      this.impacts.push({ mesh: m, life: 0 });
    }
  }

  /** The name of whatever is in your hands, for the swap toast. */
  get weaponName() {
    return this.profile.name;
  }

  /**
   * Whichever profile actually owns the trigger this frame.
   *
   * Manning a station hands the trigger to that station's gun, and the aim readout
   * has to agree with what a shot would do (invariant 8a) -- so it must scan at the
   * range of the thing that would fire, not at the range of the thing slung on your
   * back. Without this, selecting the 40 m sweeper and then sitting in a 300 m mount
   * would have made the readout go blank on everything the gun can actually reach.
   */
  get triggerProfile() {
    return this.player.station ? CFG.deckGun : this.profile;
  }

  /**
   * Cycle to the next carried weapon.
   *
   * The cost is folded into the existing fire cooldown rather than given its own
   * timer, which has a consequence worth keeping: a slow weapon's recovery cannot be
   * escaped by switching out of it.
   */
  swap() {
    this.slot = (this.slot + 1) % this.profiles.length;
    this.profile = this.profiles[this.slot];
    this.cooldown = Math.max(this.cooldown, CFG.combat.loadout.swapTime);
    this.swaps++;
    return this.profile;
  }

  /**
   * Rescan what the crosshair is on.
   *
   * Traced from the eye along the look direction, which is what the crosshair
   * actually points at whether or not a station owns the trigger. A manned gun
   * fires from its own mount with its own traverse clamp, so the readout answers
   * "what are you looking at" rather than "what can that mount reach" -- naming the
   * thing under the reticle is the useful answer, and the gun's own arc is already
   * legible from the fact that it refuses to depress.
   *
   * Clipped on geometry first, like every shot, so something standing behind the
   * hull reads as nothing rather than as a target.
   */
  scanTarget() {
    const range = this.triggerProfile.range;
    this.player.eyePosition(_origin);
    this.player.lookDirection(_dir);

    // Note the order, which is the REVERSE of shootFrom's and is the whole reason
    // this is affordable to run every frame.
    //
    // A shot has to clip on geometry first, because the clip decides where the
    // tracer ends and whether the round hit the fortress. This does not: if the
    // horde is not on the ray at all then no clip can produce a target, so the
    // expensive half is skipped entirely whenever the crosshair is on empty desert
    // — which is most of the time. Doing it the other way round cost 0.21 ms a
    // frame at a full pool, against a whole-simulation budget of one millisecond,
    // for a readout under the crosshair.
    //
    // `intersectObjects` is the expensive call, not the pool walk: the world's
    // static scenery is merged into a few large meshes, and three.js tests those
    // triangle by triangle.
    const hit = this.horde.raycast(_origin, _dir, range);
    if (!hit) {
      this.aimTarget = null;
      this.aimDist = 0;
      this.aimArmour = 0;
      return null;
    }

    // Something is on the ray. Now find out whether the fortress is in the way,
    // because naming a chewer you cannot shoot through the hull would be worse than
    // naming nothing at all — the readout has to agree with what a shot would do.
    this.raycaster.set(_origin, _dir);
    this.raycaster.far = hit.distance;
    const solid = this.raycaster.intersectObjects(this.occluders, false);
    const blocked = solid.length > 0 && solid[0].distance < hit.distance;

    this.aimTarget = blocked ? null : hit.enemy;
    this.aimDist = blocked ? 0 : hit.distance;
    // The pierce a purchase bought is folded in here too, so the readout answers "will
    // my armour problem actually bite from this angle with this build", rather than
    // reciting a number off the type.
    this.aimArmour = blocked
      ? 0
      : Math.max(0, armourAt(
        enemyCfg(hit.enemy.type), hit.yaw ?? hit.enemy.yaw, _dir.x, _dir.z,
      ) - this.armourPierce);
    return this.aimTarget;
  }

  update(dt, input) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    this.hitFlash = Math.max(0, this.hitFlash - dt);
    // Before the station early-return below, so the readout keeps working while a
    // deck gun owns the trigger. Being told what you are aiming at matters MORE
    // from a mount, because that is where the armoured things are answered from.
    this.scanTarget();

    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const p of this.impacts) {
      if (p.life <= 0) continue;
      p.life -= dt;
      if (p.life <= 0) p.mesh.visible = false;
    }

    // Manning a station hands the trigger over to that station's weapon.
    if (this.player.station) return;

    // After the early return on purpose, so a swap only happens when the weapon is
    // actually in your hands. The viewmodel is hidden while manning a gun, so a
    // silent swap you cannot see is worse than a keypress that does nothing.
    if (input.pressed(CFG.combat.loadout.swapKey)) this.swap();

    if (input.locked && input.mouseDown(0) && this.cooldown <= 0) {
      this.fire();
      this.cooldown = 1 / (this.profile.fireRate * this.fireRateScale);
    }
  }

  /**
   * One trigger pull of the carried weapon.
   *
   * Multiple pellets are N calls into the SAME hitscan path rather than a second
   * shot function, which is what keeps invariant 1 free: each pellet gets its own
   * occlusion clip, its own armour resolution and its own facing check, so a wide
   * cone fired from the deck cannot reach beneath the hull any more than one ray
   * could.
   *
   * The look direction is re-read PER PELLET, and that is load-bearing rather than
   * tidy: `shootFrom` applies its cone by mutating the direction it is handed, so
   * reusing one vector would compound the spread and walk the pattern off target
   * instead of scattering it around the crosshair.
   *
   * @returns the first pellet that connected, so a single-pellet weapon behaves
   *          exactly as it did when this was one line.
   */
  fire() {
    const p = this.profile;
    let first = null;
    for (let i = 0; i < p.pellets; i++) {
      this.player.eyePosition(_origin);
      this.player.lookDirection(_dir);
      // The pellet index is handed down so the spread can be keyed on it. Without it every
      // pellet of one blast would take the same key and land in a single point.
      const hit = this.shootFrom(_origin, _dir, p, null, this.player, i);
      if (hit && !first) first = hit;
    }
    // Counts shots taken against the CURRENT key, so two shots in one tick get different
    // spread. Reset by whoever sets the key.
    this.shotsThisKey++;
    return first;
  }

  /**
   * Shared hitscan. Both the rifle and the deck gun come through here, so the
   * geometry-occlusion rule -- the thing that keeps chewers safe beneath the
   * hull -- exists in exactly one place and cannot drift between weapons.
   *
   * `profile` supplies damage, spread and range. `muzzle` is where the tracer is
   * drawn from; null means the player's hand.
   *
   * `by` is WHO fired, and it defaults to this weapon's own operative because that is
   * true for the rifle. A manned deck gun passes its OCCUPANT instead: the gun routes
   * through here precisely so the occlusion and armour rules cannot drift between
   * weapons, and with a crew the person in the seat is not necessarily the person this
   * Weapon belongs to. Invariant 2b-i counts a manned gun as the crew because somebody
   * is sitting in it -- so the attribution has to be that somebody, by name.
   */
  shootFrom(origin, dir, profile, muzzle = null, by = this.player, pellet = 0) {
    const w = CFG.combat.weapon;
    this.shots++;
    if (pellet === 0) this.shotCues++;

    // Cone spread, built from a basis around the aim direction.
    // Cone spread, built from a basis around the aim direction.
    //
    // KEYED ON AN AGREED INDEX WHEN THERE IS ONE, drawn from the stream otherwise. `spreadKey`
    // is the input sequence the shot belongs to, set by whoever is driving this weapon over a
    // network; solo it stays 0 and the seeded stream behaves exactly as it always has, which is
    // what keeps every existing measurement in these files valid.
    //
    // Two indices on top of the sequence, and both are needed. `pellet` separates the rounds of
    // one shotgun blast, which otherwise all take the same key and land in one point. `shotIndex`
    // separates two shots that fall in the same tick — possible at a high enough fire rate, and
    // an aliasing bug that would present as a burst suddenly becoming pinpoint accurate.
    if (profile.spread > 0) {
      _right.crossVectors(dir, UP_Y).normalize();
      _up.crossVectors(_right, dir).normalize();
      const keyed = this.spreadKey > 0;
      const u1 = keyed
        ? hashUnit(this.spreadKey, this.shotsThisKey, pellet, 1)
        : this.random();
      const u2 = keyed
        ? hashUnit(this.spreadKey, this.shotsThisKey, pellet, 2)
        : this.random();
      const a = u1 * Math.PI * 2;
      const r = Math.sqrt(u2) * profile.spread;
      dir.addScaledVector(_right, Math.cos(a) * r).addScaledVector(_up, Math.sin(a) * r).normalize();
    }

    // Clip on world and fortress geometry first.
    this.raycaster.set(origin, dir);
    this.raycaster.far = profile.range;
    const solid = this.raycaster.intersectObjects(this.occluders, false);
    const limit = solid.length > 0 ? solid[0].distance : profile.range;

    const hit = this.horde.raycast(origin, dir, limit);

    let dist = limit;
    if (hit) {
      dist = hit.distance;
      this.hits++;
      this.hitFlash = w.hitFlash;
      // damageScale is where personal upgrades land. Applied here rather than by
      // editing CFG, so a run's upgrades cannot leak into global config -- and it
      // covers the rifle and both deck guns, since every shot routes through here.
      // damageBonus is the CONDITIONAL half, recomputed from scratch every frame by
      // the item runtime: "while beneath the hull", "for three seconds after
      // boarding", "while the reactor is failing". It is kept separate from
      // damageScale rather than folded into it because damageScale is derived
      // absolutely from stack counts, and a timed effect writing into it would
      // either be lost on the next recompute or accumulate forever.
      const dealt = profile.damage * (this.damageScale + this.damageBonus);
      // Attributed to `by` -- this operative for the rifle, the seat's occupant for a
      // manned gun. Both route through here, and a manned gun is the crew aiming; only
      // automation is excluded, and it is excluded by never being a Player.
      //
      // TWO pierce terms, added together, and expressing the flank as a pierce is what
      // keeps armour resolved in exactly one place (Horde.damage) rather than growing a
      // second armour path here.
      //
      // armourPierce is SABOT ROUNDS -- a thing you bought.
      // The second is a thing you DID: a shot arriving inside a type's rear cone goes
      // around the plate instead of through it, so the bypass is worth exactly the
      // plate you walked around. Composes with sabot for free, and stays zero for
      // every type whose armour is omnidirectional.
      const cfg = enemyCfg(hit.enemy.type);
      const flank = cfg.armour - armourAt(cfg, hit.yaw ?? hit.enemy.yaw, dir.x, dir.z);

      // ARBITRATED: THE CLIENT FIRES FOR FEEDBACK AND DEALS NOTHING.
      //
      // Everything above this point is presentation — the ray, the geometry clip, the enemy the
      // beam ends on, the hit flash. Everything below is consequence, and consequence belongs to
      // the authority. A client that ran it would damage its own copy of a body the server still
      // has alive, watch the next snapshot resurrect it 50 ms later, and be paid salvage for a
      // kill nobody made. That flicker is the most visible thing a half-shared game does.
      //
      // The bus is skipped for the same reason and it matters more than the damage: `Items`
      // subscribes to onHit AND onKill, so a local shot would fire procs — splash, arc chain,
      // executioner — for hits the server never registered. Invariant 2b-i's whole argument is
      // about procs happening where they should not.
      //
      // `hitFlash` and `hits` are deliberately still set. They are the only "that connected"
      // signal in the game (invariant 8a), and withholding them until a round trip completes
      // would make every shot feel 120 ms late. The honest cost is that a client can briefly see
      // a hitmarker for a shot the server disagreed about — which is the standard trade, and far
      // cheaper than the alternative.
      if (!this.arbitrated) {
        if (this.horde.damage(hit.enemy, dealt, by, this.armourPierce + flank)) {
          this.kills++;
        }
        // After the damage, so an on-hit item sees the enemy in the state the shot
        // left it in -- including dead, which is what lets "on hit" and "on kill"
        // items stack on the same shot rather than racing each other.
        this.events?.emitHit(hit.enemy, dealt, by);
      }
    } else if (solid.length > 0) {
      this.blockedByHull++;
    }

    // Traced from the eye but DRAWN from a muzzle, so the beam crosses the view
    // instead of hiding along its axis.
    _end.copy(origin).addScaledVector(dir, dist);
    this.#tracer(_end, muzzle);
    this.#impact(_end, dist, !!hit);

    return hit;
  }

  /**
   * Distance to whatever a ray is looking at, geometry or enemy. Used by weapons
   * whose muzzle is offset from the operator's eye and therefore have to
   * converge on the crosshair rather than fire parallel to it.
   */
  aimDistance(origin, dir, maxRange) {
    this.raycaster.set(origin, dir);
    this.raycaster.far = maxRange;
    const solid = this.raycaster.intersectObjects(this.occluders, false);
    const limit = solid.length > 0 ? solid[0].distance : maxRange;
    const hit = this.horde.raycast(origin, dir, limit);
    return hit ? hit.distance : limit;
  }

  #tracer(endPoint, muzzle) {
    const w = CFG.combat.weapon;
    const t = this.tracers.find((x) => x.life <= 0) ?? this.tracers[0];

    if (muzzle) _muzzle.copy(muzzle);
    else this.player.handPosition(_muzzle);

    // Published after choosing the real muzzle, so a carried shot and a deck-gun shot expose
    // the same endpoints their local tracer used. This is presentation state only.
    this.lastShotStart.copy(_muzzle);
    this.lastShotEnd.copy(endPoint);

    _beamDir.subVectors(endPoint, _muzzle);
    const len = _beamDir.length();
    if (len < 1e-4) return;
    _beamDir.divideScalar(len);

    _mid.addVectors(_muzzle, endPoint).multiplyScalar(0.5);

    // Widen with distance or the far end drops below a pixel.
    const r = w.tracerRadius + len * w.tracerWiden;

    t.mesh.position.copy(_mid);
    t.mesh.scale.set(r, len, r);
    t.mesh.quaternion.setFromUnitVectors(UP_Y, _beamDir);
    t.mesh.visible = true;
    t.life = w.tracerLife;
  }

  #impact(point, dist, onEnemy) {
    const w = CFG.combat.weapon;
    const p = this.impacts.find((x) => x.life <= 0) ?? this.impacts[0];

    const scale = w.impactSize * (1 + dist * w.impactGrow)
      * (onEnemy ? 1 : w.impactSolidScale);

    p.mesh.position.copy(point);
    p.mesh.scale.setScalar(scale);
    p.mesh.material = onEnemy ? this.impactMat.flesh : this.impactMat.solid;
    p.mesh.visible = true;
    p.life = w.impactLife;
  }
}
