import * as THREE from "three";
import { CFG } from "./config.js";
import { Look, greeble, operativeGeometry } from "./look.js";
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
// station, mid-grapple, mid-mantle, or actively repairing -- which is also a
// legibility win, because those are exactly the states where the player has lost
// normal weapon control and should be able to see that.

const HOME = new THREE.Vector3(0.23, -0.21, -0.44);

export class ViewModel {
  constructor(camera, scene = null) {
    this.camera = camera;
    this.scene = scene;
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
    this.body = scene ? this.#buildDownedBody(scene) : null;
  }

  /**
   * One model per carried weapon, all parented to the same swaying group, with
   * exactly one visible.
   *
   * THIS IS THE WHOLE READOUT for which weapon is in hand, and that is deliberate:
   * the alternative was another always-on HUD box, and invariant 27 exists because
   * those accumulate to nine. It is also the better answer on its own terms -- the
   * two shipped games nearest this one teach a weapon by its silhouette rather than
   * by a label, and a shape you recognise beats a word you have to read while
   * something is chewing on your legs.
   *
   * Keyed off the same `CFG.combat.loadout.carried` list the simulation resolves its
   * profiles from, so the model and the numbers cannot get out of step. A weapon
   * added to that list with no builder here throws AT LOAD rather than silently
   * showing the rifle while firing a shotgun -- the same trick as the exported
   * `isSubmerged` predicate, for the same reason.
   */
  #build() {
    const rand = makeRandom(0x21f1e);
    const metal = Look.std("mast", { color: 0x5a5f68, roughness: 0.5, metalness: 0.7 });
    const grip = Look.std("trim", { color: 0x6b4a33, roughness: 0.8, metalness: 0.1 });
    const skin = Look.std("trim", { color: 0x8a6a4e, roughness: 0.9, metalness: 0 });
    // Shared between models on purpose: only one is ever visible, so one material
    // instance is one fewer thing to keep in step, and it keeps the lamp a single
    // write in update() rather than an array lookup.
    this.lampMat = new THREE.MeshStandardMaterial({
      color: 0x14323d, emissive: 0x49d8ff, emissiveIntensity: 1.4, roughness: 0.4,
    });

    const builders = {
      weapon: (into) => this.#buildRifle(into, { rand, metal, grip, skin }),
      scatter: (into) => this.#buildSweeper(into, { rand, metal, grip, skin }),
    };

    this.models = CFG.combat.loadout.carried.map((key) => {
      const build = builders[key];
      if (!build) {
        throw new Error(
          `viewmodel: no model for carried weapon "${key}" -- `
          + "add a builder in viewmodel.js or the player holds the wrong gun",
        );
      }
      const g = new THREE.Group();
      g.frustumCulled = false;
      build(g);
      this.group.add(g);
      return g;
    });
    for (let i = 1; i < this.models.length; i++) this.models[i].visible = false;
  }

  /** Local third-person body seen from the fixed incapacitated camera. */
  #buildDownedBody(scene) {
    const c = CFG.net;
    const parts = operativeGeometry(c.avatarRadius, c.avatarHeight);
    const body = new THREE.Group();
    const rig = new THREE.Group();
    body.add(rig);

    const coat = Look.std("crew", {
      color: c.bodyColor, roughness: 0.85, metalness: 0.05,
    });
    const gear = Look.std("crew_gear", {
      color: c.gearColor, roughness: 0.55, metalness: 0.35,
    });
    const signalColour = c.seatColors[0];
    const signal = Look.std("crew_signal", {
      color: signalColour,
      emissive: signalColour,
      emissiveIntensity: c.seatEmissive,
      roughness: 0.4,
      metalness: 0,
    });
    const add = (geometry, material) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      rig.add(mesh);
      return mesh;
    };

    add(parts.canvas, coat);
    add(parts.gear, gear);
    add(parts.signal, signal);
    const left = add(parts.leg, coat);
    const right = add(parts.leg, coat);
    left.position.set(-parts.hip.x, parts.hip.y, 0);
    right.position.set(parts.hip.x, parts.hip.y, 0);
    rig.rotation.z = Math.PI / 2;
    body.visible = false;
    scene.add(body);
    return { group: body, rig };
  }

  /** Shared mesh helper: no shadows, never culled, two hand-spans from the lens. */
  #part(into, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = false;
    m.receiveShadow = false;
    into.add(m);
    return m;
  }

  #buildRifle(into, { rand, metal, grip, skin }) {
    const hot = this.lampMat;
    const add = (...a) => this.#part(into, ...a);

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
    add(new THREE.BoxGeometry(0.012, 0.012, 0.05), hot, 0.042, 0.03, 0.02);

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
    add(new THREE.BoxGeometry(0.06, 0.055, 0.1), skin, -0.03, -0.045, -0.26, 0, 0, 0.3);
    add(new THREE.BoxGeometry(0.05, 0.05, 0.08), skin, 0.005, -0.075, 0.05, 0, 0, -0.2);
  }

  /**
   * The trench sweeper: short, fat-bored, break-action, mostly wood.
   *
   * Read as a SILHOUETTE rather than as detail, because that is the whole job. Three
   * things carry it at a glance and each one is the rifle's opposite: the barrel is
   * half the length and three times the bore, the furniture is wood where the rifle
   * is metal, and there are no iron sights at all -- which is the honest thing to
   * draw for a weapon whose selling point is that you do not have to aim it. The
   * measured aim slack is half a metre wider than the rifle's at 5 m, so a gun with
   * no sights is a truthful picture rather than a stylistic one.
   */
  #buildSweeper(into, { rand, metal, grip, skin }) {
    const hot = this.lampMat;
    const add = (...a) => this.#part(into, ...a);

    // Receiver: deeper and blockier than the rifle's, and further back, so the whole
    // weapon reads as sitting closer to the chest.
    add(new THREE.BoxGeometry(0.095, 0.115, 0.26), metal, 0, -0.005, 0.02);

    // Twin barrels, short and wide. Side by side rather than stacked, because the
    // horizontal pair is what makes the shape unmistakable from the corner of an eye.
    for (const dx of [-0.026, 0.026]) {
      add(new THREE.CylinderGeometry(0.024, 0.024, 0.30, 10), metal,
        dx, 0.022, -0.24, Math.PI / 2);
      // Flared choke, so the muzzle the tracers leave from is visibly a bore rather
      // than a pinhole.
      add(new THREE.CylinderGeometry(0.033, 0.026, 0.045, 10), metal,
        dx, 0.022, -0.40, Math.PI / 2);
    }
    // Barrel band tying the pair together.
    add(new THREE.BoxGeometry(0.085, 0.022, 0.03), metal, 0, 0.022, -0.30);

    // Wooden furniture: pistol grip, a stubby stock, and a broad forend the left
    // hand actually sits on.
    add(new THREE.BoxGeometry(0.058, 0.14, 0.07), grip, 0, -0.10, 0.09, 0.26);
    add(new THREE.BoxGeometry(0.062, 0.088, 0.13), grip, 0, -0.03, 0.21, -0.04);
    add(new THREE.BoxGeometry(0.085, 0.055, 0.16), grip, 0, -0.03, -0.20, 0, 0, 0);

    // Break-action hinge and lever, which is what says "two shells, then a pause"
    // without a single line of UI.
    add(new THREE.CylinderGeometry(0.014, 0.014, 0.10, 8), metal, 0, 0.0, -0.085, 0, 0, Math.PI / 2);
    add(new THREE.BoxGeometry(0.016, 0.05, 0.018), metal, 0.045, 0.035, 0.05, 0, 0, -0.3);

    // Two shells in a side saddle. Brass and a lot of it is the cheapest possible
    // signal that this thing is loaded by hand.
    for (const dz of [0.0, 0.055]) {
      add(new THREE.CylinderGeometry(0.011, 0.011, 0.05, 8), grip, -0.056, -0.02, dz, 0, 0, Math.PI / 2);
    }

    // Same charge lamp as the rifle, in the same place relative to the hand, so the
    // one piece of state the viewmodel reports does not move when the weapon does.
    add(new THREE.BoxGeometry(0.014, 0.014, 0.05), hot, 0.05, 0.03, 0.03);

    // Greebling on the receiver flank, coarser than the rifle's: fewer, bigger bolts
    // on a heavier action.
    const g = greeble(rand, 9, { x: 0.001, y: 0.035, z: 0.11 }, {
      minSize: 0.016, maxSize: 0.06, thickness: 0.015, axis: "x",
    });
    add(g, metal, 0.049, 0.0, 0.02);

    // Left hand forward on the wide forend, right hand at the grip.
    add(new THREE.BoxGeometry(0.07, 0.06, 0.11), skin, -0.035, -0.055, -0.20, 0, 0, 0.34);
    add(new THREE.BoxGeometry(0.05, 0.05, 0.08), skin, 0.005, -0.085, 0.08, 0, 0, -0.22);
  }

  /**
   * @param ctx the same bag the HUD and the particle system read. This module is
   *        a pure reader too -- it never writes to the simulation.
   */
  update(dt, ctx) {
    const { player, trampler, weapon, grapple, input } = ctx;

    if (this.body) {
      const downed = !!player.downed;
      this.body.group.visible = downed;
      if (downed) {
        const based = player.base === trampler;
        const parent = based ? trampler.group : this.scene;
        if (this.body.group.parent !== parent) parent.add(this.body.group);
        this.body.group.position.copy(player.position);
        if (based) trampler.worldToLocal(this.body.group.position);
        this.body.group.rotation.y = player.viewYaw - (based ? trampler.yaw : 0);
        this.body.rig.rotation.z = Math.PI / 2;
      }
    }

    // Hidden whenever something else owns the hands. Manning a gun, being reeled
    // by the winch, mid-climb, active recovery, incapacitation, and admitted repair
    // are all states where the player is not in normal weapon control.
    const hide = !!player.station
      || grapple.active
      || player.mantle.active
      || player.downed
      || player.recovering
      || !!player.repairing;
    if (this.group.visible === hide) this.group.visible = !hide;
    // Existing driven states are brief and retain their original frozen pose. Repair can last
    // for seconds, so keep its hidden model ticking: recoil and sway must settle rather than
    // reappearing exactly where they were when the welder came out.
    if (hide && !player.repairing && !player.recovering) return;

    // Show only the weapon actually in hand.
    //
    // Driven off `weapon.slot` every frame rather than off a swap event, for the same
    // reason recoil is driven off the shot counter: a state read cannot get out of
    // step with the simulation, and an event can be missed on the frame a run resets.
    for (let i = 0; i < this.models.length; i++) {
      const active = i === weapon.slot;
      if (this.models[i].visible !== active) this.models[i].visible = active;
    }

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

    // The lamp is the overheat readout on the weapon itself -- there is no heat on a
    // carried weapon, so it reports fire readiness instead, which is the one thing the
    // crosshair used to lie about. Written to the shared material rather than to one
    // model's lamp, so it is correct whichever weapon is up, and it now also covers
    // the swap: the light goes out for the third of a second a swap costs.
    this.lampMat.emissiveIntensity = weapon.cooldown > 0 ? 0.25 : 1.4;
  }
}
