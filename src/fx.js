import * as THREE from "three";
import { CFG, ENEMY_TYPE_KEYS } from "./config.js";
import { makeRandom } from "./util.js";

// Particles and light flashes.
//
// Imported by main.js only, and it READS the simulation rather than being called
// by it. Every effect here is triggered by polling a counter or an array the sim
// already maintains for its own reasons -- trampler.footfalls, weapon.shots,
// horde.lastKill. That keeps the simulation ignorant of the fact that a particle
// system exists, which is why the whole sim still runs headless.
//
// One pooled Points object does all of it. Six separate systems would be six draw
// calls and six buffer uploads a frame for what is arithmetically the same job:
// integrate a position, fade an alpha, shrink a size.

const MAX = 1400;

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _buffer = new THREE.Vector2();

/**
 * Soft round sprite, drawn once into a canvas.
 *
 * Browser-only, and that is fine: this whole module is. A square particle is the
 * single most recognisable sign of a prototype, and a radial falloff costs one
 * 64x64 texture to fix.
 */
function sprite() {
  const size = 64;
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const g = c.getContext("2d");
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.35, "rgba(255,255,255,0.55)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

const ParticleShader = {
  vertexShader: /* glsl */`
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    uniform float uMaxSize;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vAlpha = aAlpha;
      vColor = aColor;
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      // Perspective sizing, so a puff of dust forty metres away is small rather
      // than the same pixel size as one at your feet.
      //
      // CAPPED, because that expression is unbounded as the depth goes to zero and
      // the near field is exactly where this system emits: the muzzle flash spawns
      // about a metre from the lens. Uncapped, one flash sprite was 1460-3290 px
      // across against a 1080-tall buffer, and five go off per shot -- a playtest
      // reported that firing blanked the screen. uMaxSize is a fraction of the
      // buffer the renderer is actually drawing into, so the bound holds after a
      // resize and at every adaptive render scale.
      gl_PointSize = min(aSize * (320.0 / max(-mv.z, 0.1)), uMaxSize);
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D uMap;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
      vec4 t = texture2D(uMap, gl_PointCoord);
      if (t.a < 0.01) discard;
      gl_FragColor = vec4(vColor, t.a * vAlpha);
    }
  `,
};

export class Fx {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    // Seeded like everything else. Particles do not affect the simulation, but a
    // reproducible build is easier to compare screenshots of.
    this.random = makeRandom(0xfacade);

    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.grow = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.gravity = new Float32Array(MAX);
    this.alpha = new Float32Array(MAX);
    this.color = new Float32Array(MAX * 3);
    this.cursor = 0;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(this.size, 1));
    geo.setAttribute("aAlpha", new THREE.BufferAttribute(this.alpha, 1));
    geo.setAttribute("aColor", new THREE.BufferAttribute(this.color, 3));
    geo.setDrawRange(0, MAX);
    // The pool roams the whole map, so a bounding sphere computed from frame one
    // would cull everything the moment the fortress walked away from it.
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.points = new THREE.Points(geo, new THREE.ShaderMaterial({
      // uMaxSize is refreshed every frame from the renderer's drawing buffer.
      // Seeded high enough to be inert rather than at 0, so a frame drawn before
      // the first update still shows particles.
      uniforms: { uMap: { value: sprite() }, uMaxSize: { value: 1e4 } },
      vertexShader: ParticleShader.vertexShader,
      fragmentShader: ParticleShader.fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.NormalBlending,
    }));
    this.points.frustumCulled = false;
    scene.add(this.points);

    this.geo = geo;

    // Muzzle flash. A light rather than a sprite: a flash that does not light the
    // fortress around it looks painted on, and the deck guns fire from inside a
    // sponson where the bounce is the whole effect.
    this.muzzleLight = new THREE.PointLight(0xffd9a0, 0, 14, 2);
    this.muzzleLight.visible = false;
    scene.add(this.muzzleLight);
    this.muzzleTimer = 0;

    // Counters we watch, captured so the first frame does not fire everything at
    // once.
    this.lastShots = 0;
    // Deaths are tracked by object identity (`lastKillRef`), not by a counter,
    // because an unpaid removal never touches horde.killCount. Footfalls are read
    // straight off the array the fortress publishes, so neither needs a counter.
    this.lastKillRef = null;
    this.smokeAccum = 0;
    this.moteAccum = 0;
  }

  #spawn(x, y, z, opts) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % MAX;

    const {
      vx = 0, vy = 0, vz = 0, life = 1, size = 1, grow = 0,
      drag = 1.5, gravity = 0, color = 0xffffff, alpha = 1,
    } = opts;

    this.pos[i * 3] = x;
    this.pos[i * 3 + 1] = y;
    this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx;
    this.vel[i * 3 + 1] = vy;
    this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    this.grow[i] = grow;
    this.drag[i] = drag;
    this.gravity[i] = gravity;
    this.alpha[i] = alpha;

    const c = _colorOf(color);
    this.color[i * 3] = c.r;
    this.color[i * 3 + 1] = c.g;
    this.color[i * 3 + 2] = c.b;
    return i;
  }

  /** Uniform random in [-1, 1]. */
  #r() {
    return this.random() * 2 - 1;
  }

  // ------------------------------------------------------------------ emitters

  /** A foot coming down. The single most important effect in the build. */
  footDust(x, y, z, strength = 1) {
    const n = 10 + ((this.random() * 8) | 0);
    for (let i = 0; i < n; i++) {
      this.#spawn(x + this.#r() * 1.1, y + 0.1, z + this.#r() * 1.1, {
        vx: this.#r() * 2.6 * strength,
        vy: 0.5 + this.random() * 2.2 * strength,
        vz: this.#r() * 2.6 * strength,
        life: 1.1 + this.random() * 1.1,
        size: 3.2 + this.random() * 3.0,
        grow: 3.4,
        drag: 1.9,
        gravity: -0.7,
        color: 0xc3a87d,
        alpha: 0.5,
      });
    }
  }

  /** Exhaust. Continuous, and it is what makes the fortress read as running. */
  stackSmoke(x, y, z, drive) {
    this.#spawn(x + this.#r() * 0.18, y, z + this.#r() * 0.18, {
      vx: this.#r() * 0.5,
      vy: 2.2 + this.random() * 1.6 + drive * 1.5,
      vz: this.#r() * 0.5 - 1.2,
      life: 3.0 + this.random() * 2.4,
      size: 2.6 + this.random() * 2.0,
      grow: 5.5,
      drag: 0.35,
      gravity: 0.25,
      color: 0x3a3630,
      alpha: 0.38,
    });
  }

  /** Something died. Colour comes from the type, so a kill is legible at range. */
  deathBurst(x, y, z, type) {
    const key = ENEMY_TYPE_KEYS[type] ?? "chewer";
    const heavy = key === "titan" || key === "bulwark";
    const tint = key === "sapper" ? 0x9be8c0 : key === "titan" ? 0xff9a5a : 0xd8543f;
    const n = heavy ? 28 : 9;

    for (let i = 0; i < n; i++) {
      this.#spawn(x, y, z, {
        vx: this.#r() * (heavy ? 7 : 3.4),
        vy: this.random() * (heavy ? 6 : 3.2),
        vz: this.#r() * (heavy ? 7 : 3.4),
        life: 0.4 + this.random() * 0.6,
        size: 1.4 + this.random() * 2.2,
        grow: 1.4,
        drag: 3.2,
        gravity: -9,
        color: tint,
        alpha: 0.95,
      });
    }

    // A dust ring for anything big, so a boss dying is an event rather than a
    // slightly larger puff.
    if (heavy) {
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2;
        this.#spawn(x, 0.2, z, {
          vx: Math.cos(a) * 8,
          vy: 0.7,
          vz: Math.sin(a) * 8,
          life: 1.4,
          size: 5,
          grow: 6,
          drag: 2.4,
          color: 0xc3a87d,
          alpha: 0.5,
        });
      }
    }
  }

  /** A shot leaving the rifle or a deck gun. */
  muzzle(worldPos, dir) {
    this.muzzleLight.position.copy(worldPos);
    this.muzzleLight.intensity = 40;
    this.muzzleLight.visible = true;
    this.muzzleTimer = 0.05;

    for (let i = 0; i < 5; i++) {
      this.#spawn(worldPos.x, worldPos.y, worldPos.z, {
        vx: dir.x * (4 + this.random() * 9) + this.#r() * 1.6,
        vy: dir.y * (4 + this.random() * 9) + this.#r() * 1.6,
        vz: dir.z * (4 + this.random() * 9) + this.#r() * 1.6,
        life: 0.07 + this.random() * 0.07,
        size: 1.6 + this.random() * 2.0,
        grow: 2,
        drag: 8,
        color: 0xffd08a,
        alpha: 1,
      });
    }
  }

  /** A burrower breaking the surface. Its only warning is visual. */
  surfaceBurst(x, z) {
    for (let i = 0; i < 16; i++) {
      this.#spawn(x + this.#r() * 0.7, 0.15, z + this.#r() * 0.7, {
        vx: this.#r() * 3.4,
        vy: 1.6 + this.random() * 3.4,
        vz: this.#r() * 3.4,
        life: 0.8 + this.random() * 0.7,
        size: 2.4 + this.random() * 2.4,
        grow: 3,
        drag: 2.2,
        gravity: -6,
        color: 0xb59a72,
        alpha: 0.7,
      });
    }
  }

  /**
   * Ambient dust in the air near the camera.
   *
   * Cheap and unreasonably effective: a few motes drifting through the near field
   * are what tell the eye there is atmosphere between it and the fortress, and
   * they give slow camera movement something to parallax against.
   */
  #motes(dt) {
    this.moteAccum += dt * 26;
    while (this.moteAccum >= 1) {
      this.moteAccum -= 1;
      const c = this.camera.position;
      this.#spawn(
        c.x + this.#r() * 16,
        c.y + this.#r() * 7,
        c.z + this.#r() * 16,
        {
          vx: 0.6 + this.#r() * 0.5,
          vy: this.#r() * 0.25,
          vz: this.#r() * 0.5,
          life: 3.5,
          size: 0.5 + this.random() * 0.8,
          grow: 0,
          drag: 0.2,
          color: 0xffe6c0,
          alpha: 0.25,
        },
      );
    }
  }

  // -------------------------------------------------------------------- update

  /**
   * Integrate the pool, then read the simulation for anything new.
   *
   * `ctx` is the same bag main.js hands the HUD. Nothing in it is modified here --
   * this is strictly a reader, which is what keeps the sim testable without a
   * renderer.
   */
  update(dt, ctx) {
    const { trampler, weapon, horde, guns, player, renderer } = ctx;

    // ---- size cap
    //
    // Read every frame rather than latched at construction, because the adaptive
    // resolution scaler moves the drawing buffer between 0.6 and 1.0 of the canvas
    // and a cap in pixels means nothing without knowing which buffer it is in.
    const bufferHeight = renderer?.getDrawingBufferSize(_buffer).y ?? 0;
    if (bufferHeight > 0) {
      this.points.material.uniforms.uMaxSize.value =
        bufferHeight * CFG.fx.maxScreenFraction;
    }

    // ---- integrate
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        // Parked far below the world rather than hidden with a flag: one branch
        // fewer in the hot loop, and alpha 0 already makes it invisible.
        if (this.alpha[i] !== 0) {
          this.alpha[i] = 0;
          this.pos[i * 3 + 1] = -9999;
        }
        continue;
      }

      this.life[i] -= dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);

      const keep = Math.exp(-this.drag[i] * dt);
      this.vel[i * 3] *= keep;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * keep + this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= keep;

      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;

      // Dust does not go through the floor. One comparison, and without it every
      // ground puff sinks and vanishes early.
      if (this.pos[i * 3 + 1] < 0.05 && this.gravity[i] < 0) {
        this.pos[i * 3 + 1] = 0.05;
        this.vel[i * 3 + 1] *= -0.15;
      }

      this.size[i] += this.grow[i] * dt;
      // Fade in fast, out slow. A particle that appears at full alpha pops.
      this.alpha[i] = Math.min(1, t * 3) * t;
    }

    // ---- footfalls: read the array the fortress already publishes
    if (trampler.footfalls.length > 0) {
      for (const fall of trampler.footfalls) {
        trampler.localToWorld(_v.copy(fall.local));
        this.footDust(_v.x, 0.05, _v.z, trampler.speedFactor() * 0.7 + 0.4);
      }
    }

    // ---- exhaust
    const drive = trampler.speedFactor();
    this.smokeAccum += dt * (7 + drive * 16);
    while (this.smokeAccum >= 1) {
      this.smokeAccum -= 1;
      const stacks = trampler.stacks ?? [];
      if (stacks.length === 0) break;
      const s = stacks[(this.random() * stacks.length) | 0];
      trampler.localToWorld(_v.copy(s));
      this.stackSmoke(_v.x, _v.y, _v.z, drive);
    }

    // ---- gunfire, detected from the shot counter
    if (weapon.shots !== this.lastShots) {
      this.lastShots = weapon.shots;
      const manned = guns.find((g) => g.mounted);
      if (manned) {
        manned.muzzleWorld(_v);
        _fwd.set(0, 0, -1).applyEuler(new THREE.Euler(manned.pitch, trampler.yaw + manned.yawLocal, 0, "YXZ"));
        this.muzzle(_v, _fwd);
      } else {
        player.handPosition(_v);
        player.lookDirection(_fwd);
        // Thrown forward to the rifle's muzzle brake. handPosition is the winch's
        // rope origin and sits 0.35 m from the lens, well behind the barrel, so a
        // flash spawned there appears inside the receiver -- and being that much
        // nearer the eye made it three times the screen size it should be.
        _v.addScaledVector(_fwd, CFG.fx.muzzleStandoff);
        this.muzzle(_v, _fwd);
      }
    }

    this.muzzleTimer -= dt;
    if (this.muzzleTimer <= 0 && this.muzzleLight.visible) {
      this.muzzleLight.visible = false;
      this.muzzleLight.intensity = 0;
    }

    // ---- deaths
    //
    // Compared on OBJECT IDENTITY rather than on the kill counter. A sapper that
    // completes its charge is removed without paying anybody, so it never touches
    // killCount -- and that is precisely the death that most wants a bang.
    if (horde.lastKill && this.lastKillRef !== horde.lastKill) {
      this.lastKillRef = horde.lastKill;
      const k = horde.lastKill;
      this.deathBurst(k.x, k.y, k.z, k.type);
    }

    this.#motes(dt);

    // ---- upload
    const g = this.geo;
    g.attributes.position.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aAlpha.needsUpdate = true;
    g.attributes.aColor.needsUpdate = true;
  }
}

const _c = new THREE.Color();
function _colorOf(hex) {
  _c.setHex(hex);
  // Particle colours are authored as sRGB hex but consumed by a raw shader that
  // writes straight into a linear buffer, so they have to be converted by hand.
  // Skipping this is why hand-written particle shaders always look washed out.
  _c.convertSRGBToLinear();
  return _c;
}
