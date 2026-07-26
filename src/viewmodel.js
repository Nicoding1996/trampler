import * as THREE from "three";
import { CFG } from "./config.js";
import { Look, greeble } from "./look.js";
import { damp, makeRandom } from "./util.js";

// The thing in your hands.
//
// Worth the file. Before this, the rifle existed only as a tracer that appeared
// from an offset in mid-air, which is why the muzzle-offset work in weapon.js had
// to be done twice -- there was no visual anchor to check it against. A viewmodel
// also carries three feel channels that nothing else can: recoil says the gun
// fired, sway says you turned, and lowering it says you are sprinting.
//
// Parented to the camera, so it inherits the look transform for free. That does
// mean main.js has to add the camera to the scene: children of a camera are only
// traversed if the camera itself is in the graph.
//
// It is hidden whenever something else owns the player's hands -- manning a
// station, mid-grapple, mid-mantle -- which is also a legibility win, because
// those are exactly the states where the player has lost normal control and
// should be able to see that.

const HOME = new THREE.Vector3(0.23, -0.21, -0.44);

export class ViewModel {
  constructor(camera) {
    this.camera = camera;
    this.group = new THREE.Group();
    this.group.position.copy(HOME);
    // Never culled and never shadow-casting: it is two hand-spans from the lens,
    // so a shadow would be a black smear across the whole frame.
    this.group.frustumCulled = false;
    camera.add(this.group);

    this.recoil = 0;
    this.bobPhase = 0;
    this.sway = new THREE.Vector2();
    this.lastShots = 0;
    this.lowered = 0;

    this.#build();
  }

  #build() {
    const rand = makeRandom(0x21f1e);
    const metal = Look.std("mast", { color: 0x5a5f68, roughness: 0.5, metalness: 0.7 });
    const grip = Look.std("trim", { color: 0x6b4a33, roughness: 0.8, metalness: 0.1 });
    const hot = new THREE.MeshStandardMaterial({
      color: 0x14323d, emissive: 0x49d8ff, emissiveIntensity: 1.4, roughness: 0.4,
    });

    const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      m.castShadow = false;
      m.receiveShadow = false;
      this.group.add(m);
      return m;
    };

    // Receiver, barrel, shroud.
    add(new THREE.BoxGeometry(0.075, 0.09, 0.34), metal, 0, 0, 0);
    add(new THREE.CylinderGeometry(0.018, 0.018, 0.42, 8), metal, 0, 0.012, -0.34, Math.PI / 2);
    add(new THREE.CylinderGeometry(0.032, 0.032, 0.18, 8), metal, 0, 0.012, -0.28, Math.PI / 2);
    // Muzzle brake, so the tracer has something to leave from.
    add(new THREE.CylinderGeometry(0.03, 0.026, 0.05, 8), metal, 0, 0.012, -0.53, Math.PI / 2);

    // Grip and stock.
    add(new THREE.BoxGeometry(0.05, 0.13, 0.06), grip, 0, -0.09, 0.06, 0.22);
    add(new THREE.BoxGeometry(0.055, 0.075, 0.16), grip, 0, -0.02, 0.2, -0.05);
    add(new THREE.BoxGeometry(0.045, 0.05, 0.11), grip, 0, -0.045, -0.19, -0.1);

    // Magazine and a charge indicator, because a gun with a light on it reads as
    // dieselpunk hardware rather than as a grey block.
    add(new THREE.BoxGeometry(0.05, 0.12, 0.05), metal, 0, -0.095, -0.03);
    this.lamp = add(new THREE.BoxGeometry(0.012, 0.012, 0.05), hot, 0.042, 0.03, 0.02);

    // Iron sights, aligned with the camera's forward axis so they frame the
    // crosshair instead of sitting beside it.
    add(new THREE.BoxGeometry(0.006, 0.028, 0.006), metal, 0, 0.062, -0.42);
    add(new THREE.BoxGeometry(0.03, 0.006, 0.006), metal, 0, 0.06, 0.02);
    add(new THREE.BoxGeometry(0.006, 0.022, 0.006), metal, -0.014, 0.07, 0.02);
    add(new THREE.BoxGeometry(0.006, 0.022, 0.006), metal, 0.014, 0.07, 0.02);

    // Greebled detail on the receiver's flank. Same trick as the fortress, at a
    // hundredth of the scale: bolt strips give the eye something to read size from.
    const g = greeble(rand, 14, { x: 0.001, y: 0.03, z: 0.14 }, {
      minSize: 0.012, maxSize: 0.05, thickness: 0.012, axis: "x",
    });
    add(g, metal, 0.039, 0.005, 0.0);

    // Left hand on the shroud. Two boxes is enough at this distance, and a rifle
    // held by nobody reads as a floating prop.
    const skin = Look.std("trim", { color: 0x8a6a4e, roughness: 0.9, metalness: 0 });
    add(new THREE.BoxGeometry(0.06, 0.055, 0.1), skin, -0.03, -0.045, -0.26, 0, 0, 0.3);
    add(new THREE.BoxGeometry(0.05, 0.05, 0.08), skin, 0.005, -0.075, 0.05, 0, 0, -0.2);
  }

  /**
   * @param ctx the same bag the HUD and the particle system read. This module is
   *        a pure reader too -- it never writes to the simulation.
   */
  update(dt, ctx) {
    const { player, weapon, grapple, input } = ctx;

    // Hidden whenever something else owns the hands. Manning a gun, being reeled
    // by the winch, and mid-climb are all states where the player is not in normal
    // control, and seeing the rifle vanish is a clearer signal of that than any
    // HUD row.
    const hide = !!player.station || grapple.active || player.mantle.active;
    if (this.group.visible === hide) this.group.visible = !hide;
    if (hide) return;

    // Recoil, from the shot counter rather than from the input, so it fires on the
    // frame the gun actually went off -- including for shots the fire-rate limiter
    // swallowed.
    if (weapon.shots !== this.lastShots) {
      this.lastShots = weapon.shots;
      this.recoil = Math.min(1, this.recoil + 0.75);
    }
    this.recoil = damp(this.recoil, 0, 13, dt);

    // Sway lags the view. Reading the mouse delta directly is what makes turning
    // feel like it has weight -- without it the gun is welded to the camera and
    // the whole frame moves as one rigid object.
    const sensitivity = CFG.player.lookSensitivity;
    this.sway.x = damp(this.sway.x, -(input?.mouse.dx ?? 0) * sensitivity * 2.2, 9, dt);
    this.sway.y = damp(this.sway.y, (input?.mouse.dy ?? 0) * sensitivity * 2.2, 9, dt);
    this.sway.x = THREE.MathUtils.clamp(this.sway.x, -0.09, 0.09);
    this.sway.y = THREE.MathUtils.clamp(this.sway.y, -0.07, 0.07);

    // Walk bob, driven by actual speed relative to whatever you are standing on --
    // so riding the deck at 4.5 m/s while standing still does NOT bob. Using world
    // speed here would make the gun bounce while the player was motionless, which
    // is the same frame-of-reference mistake the movement code exists to avoid.
    const rel = Math.hypot(player.velocity.x, player.velocity.z);
    const moving = player.grounded ? Math.min(1, rel / CFG.player.walkSpeed) : 0;
    this.bobPhase += dt * (7 + moving * 7);
    const bobX = Math.sin(this.bobPhase) * 0.011 * moving;
    const bobY = Math.abs(Math.cos(this.bobPhase)) * 0.013 * moving;

    // Sprinting lowers it. Reads as running rather than as advancing.
    const sprinting = !!input?.down("ShiftLeft") || !!input?.down("ShiftRight");
    this.lowered = damp(this.lowered, sprinting && moving > 0.6 ? 1 : 0, 8, dt);

    this.group.position.set(
      HOME.x + this.sway.x + bobX,
      HOME.y + this.sway.y - bobY - this.lowered * 0.09,
      HOME.z + this.recoil * 0.055,
    );
    this.group.rotation.set(
      this.recoil * 0.22 - this.lowered * 0.42,
      this.sway.x * 1.6,
      this.sway.y * 1.1 + this.lowered * 0.22,
    );

    // The lamp is the overheat readout on the rifle itself -- there is no heat on
    // the rifle, so it reports fire readiness instead, which is the one thing the
    // crosshair used to lie about.
    this.lamp.material.emissiveIntensity = weapon.cooldown > 0 ? 0.25 : 1.4;
  }
}
