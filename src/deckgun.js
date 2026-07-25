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
 * Route the station key to whichever mount makes sense: dismount if manned,
 * otherwise man the nearest one in reach. Shared by the game loop and the test
 * harness so the dispatch rule exists once.
 */
export function handleStationInput(guns, input, player) {
  for (const g of guns) g.updateCanMount(player);
  if (!input.pressed(CFG.deckGun.key)) return;

  const manned = guns.find((g) => g.mounted);
  if (manned) {
    manned.dismount(player);
    return;
  }

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

    this.mounted = false;
    this.canMount = false;
    this.yawLocal = mount.facing;
    this.pitch = 0;
    this.heat = 0;
    this.overheated = false;
    this.cooldown = 0;
    this.shots = 0;

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

  updateCanMount(player) {
    this.canMount = !this.mounted && this.distanceTo(player) <= CFG.deckGun.mountRange;
    return this.canMount;
  }

  mount(player) {
    this.mounted = true;
    player.station = this;
    player.grapple?.cancel();
    player.cancelMantle();
    player.base = this.trampler;
    player.velocity.set(0, 0, 0);
  }

  dismount(player) {
    this.mounted = false;
    if (player.station === this) player.station = null;
    player.base = this.trampler;
    player.velocity.set(0, 0, 0);
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

  update(dt, input, player, weapon) {
    const g = CFG.deckGun;

    this.heat = Math.max(0, this.heat - g.coolRate * dt);
    if (this.overheated && this.heat <= g.resumeHeat) this.overheated = false;
    this.cooldown = Math.max(0, this.cooldown - dt);

    this.pad.visible = !this.mounted;

    if (!this.mounted) return;

    if (input.locked && input.mouseDown(0) && !this.overheated && this.cooldown <= 0) {
      this.#fire(player, weapon);
      this.cooldown = 1 / g.fireRate;
      this.heat += g.heatPerShot;
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
    return weapon.shootFrom(_muzzle, _dir, CFG.deckGun, _muzzle);
  }
}
