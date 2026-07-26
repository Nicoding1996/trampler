import * as THREE from "three";
import { CFG } from "./config.js";
import { box, makeRandom } from "./util.js";
import { Look, tileBoxUVs, mergeGeometries } from "./look.js";

// The arena: a dry lake bed ringed by dunes and mesas.
//
// The play area is DELIBERATELY FLAT, and that is a collision decision before it
// is an art one. Ground collision is a single box with its top face at y=0, and
// `probeGround` reads box tops -- so displacing the visible ground into dunes
// inside the play area would put the art and the collision in different places
// and the player would sink into or float above every slope. A pan is flat for a
// reason.
//
// Relief therefore lives OUTSIDE the patrol ring, where nothing walks, and
// carries no colliders at all. Dunes and mesas are a horizon, not terrain.
//
// The original build used two GridHelpers for motion reference, on the grounds
// that you cannot tell whether discomfort comes from the mechanic or from a
// featureless void. That reasoning was right and the grid was the cheapest
// answer at the time; it is not the best one. Parallax now comes from a few
// hundred pieces of scattered debris, which does the same job, reads as a place
// rather than as a diagram, and gives the eye something at every distance from
// half a metre to six hundred.

export class World {
  constructor(scene) {
    this.scene = scene;
    this.colliders = [];
    this.grappleables = [];

    // Fog is the far-field boundary AND a road modifier -- the Dust Bowl tightens
    // it. Kept as instance state so the run can scale it without editing config.
    this.fogNear = CFG.world.fogNear;
    this.fogFar = CFG.world.fogFar;

    scene.background = new THREE.Color(CFG.world.fogColor);
    scene.fog = new THREE.Fog(CFG.world.fogColor, this.fogNear, this.fogFar);
    this.fog = scene.fog;

    this.#lights();
    this.#ground();
    this.#scatter();
    this.#horizon();
  }

  /**
   * Four lights, and that number is a budget rather than an accident.
   *
   * Every light in a `MeshStandardMaterial` scene costs per-pixel work in every
   * shader, and changing how many exist forces every material to recompile --
   * which is a visible hitch, not just a cost. The first build had sixteen: nine
   * emitter point lights, three spotlights sitting at intensity zero (a light at
   * zero intensity still occupies a shader slot), a reactor lamp and these.
   */
  #lights() {
    // Hemisphere fill: warm sky above, bounced sand below. Even with an HDRI
    // environment this stays, because the environment is applied to PBR specular
    // and diffuse irradiance while this is what keeps shadowed undersides -- the
    // whole under-hull arena -- from going to black.
    this.scene.add(new THREE.HemisphereLight(
      0xbcd4ff, 0xc39a63, CFG.world.hemiIntensity,
    ));

    // Low, warm, and long-shadowed. A high sun flattens everything and makes a
    // 26 m fortress cast a puddle; a low one throws its legs across the sand for
    // forty metres, which is most of what sells the scale.
    const s = CFG.render.shadow;
    const sun = new THREE.DirectionalLight(0xffd9a0, CFG.world.sunIntensity);
    sun.castShadow = true;
    sun.shadow.mapSize.set(s.size, s.size);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = s.far;
    // Tighter is both sharper AND cheaper: the same texel budget spread over a
    // smaller area. The old +/-80 m covered a lot of desert nobody looks at, and
    // paid for it in shadow resolution across the thing everybody looks at.
    sun.shadow.camera.left = -s.extent;
    sun.shadow.camera.right = s.extent;
    sun.shadow.camera.top = s.extent;
    sun.shadow.camera.bottom = -s.extent;
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.045;
    this.scene.add(sun);
    this.scene.add(sun.target);
    this.sun = sun;
    // Matched to CFG.world.skyRotation so the HDRI's bright quarter and our own
    // shadows agree about where the sun is. When they disagree everyone can see
    // it is wrong and almost nobody can say why.
    this.sunOffset = new THREE.Vector3(96, 46, 62);

    // A second, dimmer light from the opposite side with no shadow. Pure cheat,
    // and the cheapest way to keep the fortress's shadowed flank readable while
    // the player is fighting under it.
    const bounce = new THREE.DirectionalLight(0x88a0c8, CFG.world.bounceIntensity);
    bounce.position.set(-60, 30, -50);
    this.scene.add(bounce);
  }

  #ground() {
    const mat = Look.std("sand", {
      color: CFG.world.groundColor,
      roughness: 0.98,
      metalness: 0,
    });

    // Segmented so vertex lighting from the hemisphere light has somewhere to
    // land, and large enough that the horizon is fog rather than an edge.
    const geo = new THREE.PlaneGeometry(2400, 2400, 24, 24);
    // The plane's UVs span 0..1 over 2400 m, which at one tile per 7 m needs a
    // repeat of ~343. Done on the geometry rather than the texture so the shared
    // sand material can be reused at other scales without fighting over it.
    const uv = geo.attributes.uv;
    const repeat = 2400 / 7;
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, uv.getX(i) * repeat, uv.getY(i) * repeat);
    }

    const plane = new THREE.Mesh(geo, mat);
    plane.rotation.x = -Math.PI / 2;
    plane.receiveShadow = true;
    this.scene.add(plane);

    // One thick collider under everything rather than an infinite plane check.
    this.colliders.push(box(-800, -60, -800, 800, 0, 800, "ground"));
  }

  /**
   * Rocks and ruins, BATCHED.
   *
   * This used to be one mesh per rock, per rock chunk, per ruin, per broken cap
   * and per rebar bundle: 646 draw calls, 558 of them shadow casters, so ~1200 of
   * the frame's ~1410 calls came from scenery nobody interacts with. The triangle
   * count was trivial the whole time -- 45,000 -- which is the signature of a
   * CPU-bound scene rather than a GPU-bound one, and the fix for that is batching,
   * not simplifying.
   *
   * Everything static and sharing a material is merged into one geometry, built
   * with each part's own tiled UVs so batching costs nothing visually. Four draw
   * calls now do what 646 did.
   *
   * The COLLIDERS are unaffected: they were never meshes. And the individual
   * boulder and ruin meshes did have one job besides being looked at -- they were
   * grapple and bullet-occluder targets -- so a merged mesh replaces them in those
   * lists, which is strictly more correct than 200 separate raycast candidates.
   */
  #scatter() {
    // Seed lives in config with the others, so every stochastic part of the
    // build is listed in one place. Changing it reshuffles the rocks and ruins.
    const rand = makeRandom(CFG.world.seed);
    const rockMat = Look.std("rock", { color: 0x9c8161, roughness: 0.95, metalness: 0 });
    const ruinMat = Look.std("ruin", { color: 0x8b8378, roughness: 0.9, metalness: 0 });
    const rebarMat = Look.std("trim", { color: 0x6a4a35, roughness: 0.8, metalness: 0.4 });

    const patrol = CFG.world.patrolRadius;

    // Merge buckets, one per material.
    const rockParts = [];
    const chunkParts = [];
    const ruinParts = [];
    const rebarParts = [];

    /** A collider-matching box, as geometry rather than a mesh. */
    const boxPart = (b, tile) => {
      const size = new THREE.Vector3().subVectors(b.max, b.min);
      const g = new THREE.BoxGeometry(size.x, size.y, size.z);
      tileBoxUVs(g, size.x, size.y, size.z, tile);
      return g;
    };

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

      const part = boxPart(b, 2.4);
      part.translate((b.min.x + b.max.x) / 2, h / 2, (b.min.z + b.max.z) / 2);
      rockParts.push(part);

      // Loose chunks piled on top, with no collider of their own. Silhouette for
      // free: the boulder still stops you exactly where its box says it does, and
      // the extra geometry sits above the top face where it cannot be walked into.
      const chunks = 1 + ((rand() * 3) | 0);
      for (let c = 0; c < chunks; c++) {
        const cs = 0.4 + rand() * Math.min(w, d) * 0.5;
        const g = new THREE.DodecahedronGeometry(cs, 0);
        g.rotateX(rand() * 3);
        g.rotateY(rand() * 3);
        g.translate(
          x + (rand() * 2 - 1) * w * 0.3,
          h + cs * 0.35,
          z + (rand() * 2 - 1) * d * 0.3,
        );
        chunkParts.push(g);
      }
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

      const shaft = boxPart(b, 3.2);
      shaft.translate(x, h / 2, z);
      ruinParts.push(shaft);

      // A broken crown and exposed rebar, again above the collider's top face.
      // Ruins read as ruins because of what is missing from them.
      const cap = new THREE.BoxGeometry(
        w * (0.4 + rand() * 0.4), 0.6 + rand(), d * (0.4 + rand() * 0.4),
      );
      cap.rotateY(rand() * 0.6);
      cap.translate(x + (rand() * 2 - 1) * w * 0.2, h + 0.3, z + (rand() * 2 - 1) * d * 0.2);
      ruinParts.push(cap);

      const bars = 2 + ((rand() * 4) | 0);
      for (let i = 0; i < bars; i++) {
        const len = 0.6 + rand() * 1.6;
        const g = new THREE.CylinderGeometry(0.05, 0.05, len, 4);
        g.rotateX((rand() * 2 - 1) * 0.3);
        g.translate(
          x + (rand() * 2 - 1) * w * 0.35,
          h + len / 2,
          z + (rand() * 2 - 1) * d * 0.35,
        );
        rebarParts.push(g);
      }

      placed++;
    }

    // One mesh per material. `receiveShadow` is worth keeping; `castShadow` is not
    // -- see the note on the batch below.
    const batch = (parts, mat, cast) => {
      if (parts.length === 0) return null;
      const mesh = new THREE.Mesh(mergeGeometries(parts), mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      this.scene.add(mesh);
      return mesh;
    };

    // Rocks and ruins still cast, because a low sun throwing a ruin's shadow forty
    // metres across the pan is most of what sells the scale. The loose chunks and
    // the rebar do not: they are centimetres of detail whose shadows are invisible
    // at any distance the player sees them from, and a shadow pass is the whole
    // scene drawn a second time.
    const rocks = batch(rockParts, rockMat, true);
    batch(chunkParts, rockMat, false);
    const ruins = batch(ruinParts, ruinMat, true);
    batch(rebarParts, rebarMat, false);

    // Grapple and bullet-occluder targets. Two candidates instead of two hundred,
    // which also makes every raycast in the game cheaper -- the winch casts one
    // ray per frame against this list just to draw its aim marker.
    for (const mesh of [rocks, ruins]) {
      if (mesh) this.grappleables.push(mesh);
    }

    this.#debris(rand, rockMat);
  }

  /**
   * Small stones and scrap across the pan, drawn as one instanced mesh.
   *
   * This is what replaced the motion-reference grid. It has no collision, and it
   * does not need any: nothing here is over 25 cm, which is under the step height
   * the collision solver already walks over without noticing.
   */
  #debris(rand, mat) {
    const geo = new THREE.DodecahedronGeometry(0.14, 0);
    const mesh = new THREE.InstancedMesh(geo, mat, CFG.world.debrisCount);
    mesh.receiveShadow = true;
    mesh.castShadow = false;

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const e = new THREE.Euler();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();

    for (let i = 0; i < CFG.world.debrisCount; i++) {
      const a = rand() * Math.PI * 2;
      const r = 12 + rand() * 300;
      const scale = 0.4 + rand() * 2.2;
      p.set(Math.cos(a) * r, 0.02 + scale * 0.05, Math.sin(a) * r);
      e.set(rand() * 3, rand() * 3, rand() * 3);
      q.setFromEuler(e);
      s.set(scale, scale * (0.4 + rand() * 0.4), scale);
      m.compose(p, q, s);
      mesh.setMatrixAt(i, m);
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.scene.add(mesh);
  }

  /**
   * Dunes and mesas, all beyond the patrol ring, all without colliders.
   *
   * Two jobs. They give the eye something to measure the fortress against, and
   * they stop the horizon being a single fog-coloured line -- which is what made
   * the original build read as a void with a grid painted on it.
   *
   * PLACED BY EXTENT, NOT BY CENTRE, and that distinction is the whole reason this
   * method has a long comment. The first version put dune CENTRES outside
   * patrolRadius + 90 and thought that was clearance. A dune is up to 170 m across,
   * so one centred at 255 m reached inward to 85 m -- a hill sitting inside the
   * 165 m patrol ring, with no collider, hiding the enemies behind it, and no way
   * past it except walking through it. A playtest found it immediately.
   *
   * Every part now reserves its own half-width before being positioned, and the
   * worst case is recorded in `horizonClearance` so test 87 can assert it rather
   * than trusting this comment.
   */
  #horizon() {
    const rand = makeRandom(CFG.world.seed ^ 0x5eed);
    const sandMat = Look.std("sand", {
      color: 0xc2a87f, roughness: 1.0, metalness: 0,
    });
    const mesaMat = Look.std("rock", { color: 0x8e7355, roughness: 0.95, metalness: 0 });

    const patrol = CFG.world.patrolRadius;
    const inner = patrol + CFG.world.horizonClearance;
    const outer = CFG.render.horizonRadius;

    // Narrowest gap between the play area and any horizon geometry, measured from
    // each part's real extent. Reported so it can be asserted and so the
    // diagnostics panel can show it.
    this.horizonClearance = Infinity;

    /**
     * Pick a distance that keeps a part of the given half-width entirely outside
     * the ring. Returns the centre distance.
     */
    const placeBeyond = (radius) => {
      const min = inner + radius;
      const span = Math.max(0, outer - min - radius);
      const r = min + rand() * span;
      this.horizonClearance = Math.min(this.horizonClearance, r - radius - patrol);
      return r;
    };

    // Dunes: squashed spheres, merged into one geometry. A hundred and thirty
    // separate meshes on the horizon is a hundred and thirty draw calls for
    // something nobody ever walks on.
    const duneParts = [];
    for (let i = 0; i < CFG.world.duneCount; i++) {
      const a = rand() * Math.PI * 2;
      const w = 40 + rand() * 130;
      const h = 6 + rand() * 26;
      const squash = 0.5 + rand() * 0.6;
      // The hemisphere is scaled non-uniformly and then spun, so its worst-case
      // horizontal reach is the larger of the two axes.
      const r = placeBeyond(Math.max(w, w * squash));

      const g = new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
      g.scale(w, h, w * squash);
      g.rotateY(rand() * Math.PI);
      g.translate(Math.cos(a) * r, -1, Math.sin(a) * r);
      duneParts.push(g);
    }
    const dunes = new THREE.Mesh(mergeGeometries(duneParts), sandMat);
    // Neither casts nor receives. They are hundreds of metres away, outside the
    // shadow camera entirely, and including them would only widen its bounds.
    dunes.castShadow = false;
    dunes.receiveShadow = false;
    this.scene.add(dunes);

    // Mesas: flat-topped, hard-edged, and much taller than anything in the play
    // area, so the fortress has something to be dwarfed by occasionally.
    const mesaParts = [];
    for (let i = 0; i < CFG.world.mesaCount; i++) {
      const a = rand() * Math.PI * 2;
      const w = 50 + rand() * 120;
      const d = 50 + rand() * 120;
      const h = 40 + rand() * 110;
      // A rotated box reaches its diagonal, and the talus skirt is wider still.
      const r = placeBeyond(Math.max(Math.hypot(w, d) / 2, w * 0.75));

      const g = new THREE.BoxGeometry(w, h, d);
      tileBoxUVs(g, w, h, d, 26);
      g.rotateY(rand() * 0.6);
      g.translate(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r);
      mesaParts.push(g);

      // A talus slope at the base, so the mesa does not look pasted on.
      const skirt = new THREE.ConeGeometry(w * 0.75, h * 0.28, 7);
      skirt.translate(Math.cos(a) * r, h * 0.14 - 6, Math.sin(a) * r);
      mesaParts.push(skirt);
    }
    const mesas = new THREE.Mesh(mergeGeometries(mesaParts), mesaMat);
    mesas.castShadow = false;
    mesas.receiveShadow = false;
    this.scene.add(mesas);
  }

  /**
   * Tighten or open the fog. Used by the run's Dust Bowl road, which trades
   * visibility for scrap.
   *
   * Instance state, not a CFG edit: a road modifier written into config would
   * survive a restart and quietly make the next attempt a different fight.
   */
  setFogScale(scale) {
    this.fogNear = CFG.world.fogNear * scale;
    this.fogFar = CFG.world.fogFar * scale;
    this.fog.near = this.fogNear;
    this.fog.far = this.fogFar;
  }

  /** Keep the shadow map centred on the action instead of the whole desert. */
  updateSun(focus) {
    this.sun.target.position.copy(focus);
    this.sun.position.copy(focus).add(this.sunOffset);
  }
}
