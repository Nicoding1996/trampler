import * as THREE from "three";
import { CFG } from "./config.js";
import { clamp } from "./util.js";

// A manned gun bolted to the bow bridge.
//
// This exists to fix a structural hole: before it, the deck was strictly worse
// than the sand. You could shoot everything from the ground, and from the deck
// you could shoot the wave but not the chewers, with no compensating advantage.
// So there was no decision to make, and the ride-or-dismount pillar had nothing
// to weigh.
//
// The gun makes the bow the strong position against an incoming wave -- and the
// depression limit means it can never answer what is under the hull. Two seats,
// each strictly better at one job, and you cannot occupy both.
//
// Aim is clamped in HULL-LOCAL space, so the traverse arc turns with the
// fortress instead of drifting off it.

const _p = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _muzzle = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _aim = new THREE.Vector3();

const wrapPi = (a) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

/**
 * Route the station key for ONE operative: step off their own mount if they are in
 * one, otherwise man the nearest free one in reach. Shared by the game loop and the
 * test harness so the dispatch rule exists once.
 *
 * The dismount branch reads THIS operative's station rather than searching for an
 * occupied gun. Those were the same expression while there was one operative and
 * different ones the moment there were two: `guns.find((g) => g.mounted)` found the
 * bow gun crew 1 was sitting in, and crew 2 pressing F anywhere on the deck released
 * it out from under them -- leaving crew 1 still pinned by `player.station` to a mount
 * now reporting itself empty, and a third operative free to take it. Two operatives
 * constrained to one seat, from a keypress made 7.1 m away -- measured, in test 107,
 * against a mount whose reach is 2.8 m.
 */
export function handleStationInput(guns, input, player) {
  for (const g of guns) g.updateCanMount(player);
  if (!input.pressed(CFG.deckGun.key)) return;

  if (player.station) {
    player.station.dismount(player);
    return;
  }

  // `canMount` already excludes an occupied mount, so this cannot take a seat
  // somebody else is in -- it falls through to the other gun, or to nothing.
  const nearest = guns
    .filter((g) => g.canMount)
    .sort((a, b) => a.distanceTo(player) - b.distanceTo(player))[0];
  nearest?.mount(player);
}

export class DeckGun {
  constructor(scene, trampler, mount) {
    this.trampler = trampler;

    this.name = mount.name;
    this.facing = mount.facing;
    this.traverse = mount.traverse;
    this.mountLocal = new THREE.Vector3(...mount.mountLocal);
    this.operatorLocal = new THREE.Vector3(...mount.operatorLocal);

    // THE operative in this mount, or null. `mounted` is derived from it rather than
    // tracked beside it, because a bare boolean answers "is somebody in here" without
    // saying who -- and that missing half was the bug, in three separate places: the
    // station key, the trigger, and the release. A field that names its occupant makes
    // all three unspellable.
    // A remote snapshot can reserve the mount without constructing another Player in this
    // client's simulation. The real authority never sets this: it always has the operator.
    this.remoteOperatorSeat = 0;
    this.operator = null;
    this.canMount = false;
    this.yawLocal = mount.facing;
    this.pitch = 0;
    this.heat = 0;
    this.overheated = false;
    this.cooldown = 0;
    this.shots = 0;

    // Owned by the AMMO HOIST module. Heat is what stops the gun being the answer
    // to everything, so this is the one module that makes the manned position
    // stronger -- automation is the floor, manned action is the ceiling.
    this.heatScale = 1;
    this.coolScale = 1;

    this.#build();
  }

  #build() {
    const metal = new THREE.MeshStandardMaterial({ color: 0x3f444d, roughness: 0.55, metalness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x8d5a3a, roughness: 0.7, metalness: 0.2 });

    // Traverse group: yaws. Pitch group inside it: elevates.
    this.traverseGroup = new THREE.Group();
    this.traverseGroup.position.copy(this.mountLocal);
    this.trampler.group.add(this.traverseGroup);

    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.55, 0.8, 12), metal);
    base.position.y = 0.4;
    base.castShadow = true;
    this.traverseGroup.add(base);

    // Pivot height is load-bearing, not cosmetic: it is what lets a depressed
    // shot clear the deck's own outer edge instead of hitting it.
    this.pitchGroup = new THREE.Group();
    this.pitchGroup.position.y = 0.8;
    this.traverseGroup.add(this.pitchGroup);

    const breech = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.55, 1.0), metal);
    breech.castShadow = true;
    this.pitchGroup.add(breech);

    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.26, 2.4), metal);
    barrel.position.z = -1.5;
    barrel.castShadow = true;
    this.pitchGroup.add(barrel);

    const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.4, 10), accent);
    drum.rotation.z = Math.PI / 2;
    drum.position.set(0.5, 0.1, 0.15);
    this.pitchGroup.add(drum);

    // Where tracers leave the gun.
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0, -2.6);
    this.pitchGroup.add(this.muzzle);

    // A lit plate on the operator's spot, so the station is findable.
    const pad = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 0.06, 14),
      new THREE.MeshStandardMaterial({
        color: 0x1b3b46, emissive: 0x49d8ff, emissiveIntensity: 0.9, roughness: 0.5,
      }),
    );
    pad.position.set(this.operatorLocal.x, this.operatorLocal.y - 0.9, this.operatorLocal.z);
    this.trampler.group.add(pad);
    this.pad = pad;
  }

  // ------------------------------------------------------------------ mounting

  mountWorld(out = new THREE.Vector3()) {
    return this.trampler.localToWorld(out.copy(this.mountLocal));
  }

  operatorWorld(out = new THREE.Vector3()) {
    return this.trampler.localToWorld(out.copy(this.operatorLocal));
  }

  distanceTo(player) {
    return player.position.distanceTo(this.mountWorld(_p));
  }

  /**
   * True when somebody is in this mount. Derived, never assigned -- assigning to it
   * throws, which is deliberate: two of the three sites that used to write it were
   * releasing a seat without saying whose.
   */
  get mounted() {
    return this.operator !== null || this.remoteOperatorSeat > 0;
  }

  updateCanMount(player) {
    this.canMount = !this.mounted && this.distanceTo(player) <= CFG.deckGun.mountRange;
    return this.canMount;
  }

  /** Take the seat. Refuses, rather than displacing, if somebody is already in it. */
  mount(player) {
    if (this.mounted) return false;
    this.operator = player;
    player.station = this;
    player.grapple?.cancel();
    player.cancelMantle();
    player.base = this.trampler;
    player.velocity.set(0, 0, 0);
    return true;
  }

  /**
   * Leave the seat. Only its occupant can, so a stray call cannot desync the mount
   * from the operative it is holding in place.
   */
  dismount(player) {
    if (this.operator !== player) return false;
    this.operator = null;
    player.station = null;
    player.base = this.trampler;
    player.velocity.set(0, 0, 0);
    return true;
  }

  /**
   * Clear the seat whoever is in it, and release them.
   *
   * For a restart, which must not have to know who was sitting where -- invariant 25
   * says a restart reverts everything, and a mount still holding a stale operator is
   * exactly the sort of state that survives a reset unnoticed.
   */
  evict() {
    return this.operator ? this.dismount(this.operator) : false;
  }

  /**
   * Called from the player each frame while manned: pins them to the mount and
   * clamps their aim into the gun's arc.
   *
   * The traverse limit is applied to yaw measured RELATIVE TO THE HULL, so the
   * arc rides the fortress through its turns rather than sliding off the front.
   */
  constrain(player) {
    const g = CFG.deckGun;
    const t = this.trampler;

    // Traverse is clamped around this mount's own facing, so a stern gun sweeps
    // the rear arc rather than being forced to point forward.
    const rel = clamp(wrapPi(player.yaw - t.yaw - this.facing), -this.traverse, this.traverse);
    player.yaw = t.yaw + this.facing + rel;
    player.pitch = clamp(player.pitch, g.minPitch, g.maxPitch);

    this.yawLocal = this.facing + rel;
    this.pitch = player.pitch;

    // Point the hardware immediately, so anything reading the muzzle this frame
    // gets the current aim rather than last frame's.
    this.traverseGroup.rotation.y = this.yawLocal;
    this.pitchGroup.rotation.x = this.pitch;

    this.operatorWorld(_p);
    player.position.copy(_p);
    player.base = t;
    player.velocity.set(0, 0, 0);
    player.grounded = true;
  }

  // -------------------------------------------------------------------- update

  update(dt, input, player, weapon, advanceShared = true) {
    const g = CFG.deckGun;

    // A DeckGun is shared by the crew. The ordinary browser path calls update once and uses
    // the default; the authoritative session calls it once per operative and advances this
    // shared clock only for the first. Otherwise four players cool one gun four times per tick.
    if (advanceShared) {
      this.heat = Math.max(0, this.heat - g.coolRate * this.coolScale * dt);
      if (this.overheated && this.heat <= g.resumeHeat) this.overheated = false;
      this.cooldown = Math.max(0, this.cooldown - dt);
      this.pad.visible = !this.mounted;
    }

    // Only the operative actually in the seat can pull its trigger. Gating on
    // `mounted` alone is the station key's bug wearing a different hat: it would let
    // any operative's mouse fire an occupied gun from anywhere on the ship, and the
    // heat it built would land on somebody else's weapon.
    if (this.operator !== player) return;

    if (input.locked && input.mouseDown(0) && !this.overheated && this.cooldown <= 0) {
      this.#fire(player, weapon);
      this.cooldown = 1 / g.fireRate;
      this.heat += g.heatPerShot * this.heatScale;
      if (this.heat >= 1) {
        this.heat = 1;
        this.overheated = true;
      }
    }
  }

  /** World position of the barrel tip, with transforms brought up to date. */
  muzzleWorld(out = new THREE.Vector3()) {
    this.trampler.group.updateMatrixWorld(true);
    return this.muzzle.getWorldPosition(out);
  }

  #fire(player, weapon) {
    this.shots++;

    player.eyePosition(_eye);
    player.lookDirection(_dir);

    // Converge on whatever the crosshair is actually on. The muzzle sits over
    // four metres forward of the operator's eye and more than a metre below it,
    // so firing along the raw look direction puts the round about a metre off
    // target at range -- enough to miss an enemy entirely.
    const aimDist = weapon.aimDistance(_eye, _dir, CFG.deckGun.range);
    _aim.copy(_eye).addScaledVector(_dir, aimDist);

    this.muzzleWorld(_muzzle);
    _dir.subVectors(_aim, _muzzle).normalize();

    // Routed through the rifle's hitscan so the geometry-occlusion rule -- the
    // thing keeping chewers safe beneath the hull -- lives in exactly one place.
    //
    // Attributed to the OPERATOR rather than to the weapon's own operative. Those are
    // the same person solo and different people with a crew, and the difference decides
    // whose procs fire and whose purse is paid for a kill made from this seat. `update`
    // guarantees only the occupant can reach here.
    return weapon.shootFrom(_muzzle, _dir, CFG.deckGun, _muzzle, player);
  }
}
