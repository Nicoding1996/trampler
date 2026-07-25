import * as THREE from "three";
import { CFG } from "./config.js";
import { box, boxToMesh, makeRandom } from "./util.js";

// The ground is deliberately flat and gridded. For a moving-platform feel test
// you need strong motion parallax and unambiguous reference lines, otherwise
// you cannot tell whether discomfort comes from the mechanic or from a
// featureless void.

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];
    this.grappleables = [];

    scene.background = new THREE.Color(CFG.world.fogColor);
    scene.fog = new THREE.Fog(CFG.world.fogColor, CFG.world.fogNear, CFG.world.fogFar);

    this.#lights();
    this.#ground();
    this.#scatter();
  }

  #lights() {
    this.scene.add(new THREE.HemisphereLight(0xdfe7ff, 0x8c7350, 0.85));

    const sun = new THREE.DirectionalLight(0xffe7c4, 1.9);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 260;
    sun.shadow.camera.left = -70;
    sun.shadow.camera.right = 70;
    sun.shadow.camera.top = 70;
    sun.shadow.camera.bottom = -70;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.045;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    this.sunOffset = new THREE.Vector3(52, 96, 38);
  }

  #ground() {
    const mat = new THREE.MeshStandardMaterial({
      color: CFG.world.groundColor,
      roughness: 0.98,
      metalness: 0,
    });
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), mat);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    this.scene.add(plane);

    // Motion reference. Two grids: fine near-field, coarse far-field.
    const fine = new THREE.GridHelper(1600, 400, 0x8d7a5c, 0x9d8a6c);
    fine.position.y = 0.02;
    fine.material.transparent = true;
    fine.material.opacity = 0.30;
    this.scene.add(fine);

    const coarse = new THREE.GridHelper(1600, 40, 0x6f5f46, 0x6f5f46);
    coarse.position.y = 0.04;
    coarse.material.transparent = true;
    coarse.material.opacity = 0.45;
    this.scene.add(coarse);

    // One thick collider under everything rather than an infinite plane check.
    this.colliders.push(box(-800, -60, -800, 800, 0, 800, "ground"));
  }

  #scatter() {
    // Seed lives in config with the others, so every stochastic part of the
    // build is listed in one place. Changing it reshuffles the rocks and ruins.
    const rand = makeRandom(CFG.world.seed);
    const rockMat = new THREE.MeshStandardMaterial({ color: 0x8a7256, roughness: 0.95 });
    const pillarMat = new THREE.MeshStandardMaterial({ color: 0x6d6357, roughness: 0.9 });

    const patrol = CFG.world.patrolRadius;

    // Low cover the walker strides over. This is the "fight under your own
    // fortress" arena, so keep it below the hull clearance.
    let placed = 0;
    let guard = 0;
    while (placed < 150 && guard++ < 4000) {
      const a = rand() * Math.PI * 2;
      const r = 30 + rand() * 260;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;

      const w = 1.6 + rand() * 4.2;
      const d = 1.6 + rand() * 4.2;
      const h = 0.7 + rand() * 2.4;

      const b = box(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, "rock");
      this.colliders.push(b);
      const mesh = boxToMesh(b, rockMat);
      mesh.rotation.y = rand() * 0.4 - 0.2;
      this.scene.add(mesh);
      this.grappleables.push(mesh);
      placed++;
    }

    // Tall ruins: verticality for the grapple, chokepoints for later tower
    // defense work. Kept clear of the patrol ring so the hull never clips them.
    placed = 0;
    guard = 0;
    while (placed < 46 && guard++ < 4000) {
      const a = rand() * Math.PI * 2;
      const r = 40 + rand() * 250;
      if (Math.abs(r - patrol) < 26) continue;

      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      const w = 3 + rand() * 5;
      const d = 3 + rand() * 5;
      const h = 8 + rand() * 22;

      const b = box(x - w / 2, 0, z - d / 2, x + w / 2, h, z + d / 2, "pillar");
      this.colliders.push(b);
      const mesh = boxToMesh(b, pillarMat);
      this.scene.add(mesh);
      this.grappleables.push(mesh);
      placed++;
    }
  }

  /** Keep the shadow map centred on the action instead of the whole desert. */
  updateSun(focus) {
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(this.sunOffset);
  }
}
