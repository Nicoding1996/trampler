import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { SMAAPass } from "three/addons/postprocessing/SMAAPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { CFG } from "./config.js";
import { clamp, damp } from "./util.js";

// Renderer and post-processing.
//
// Imported by main.js only. Nothing in the simulation touches this file, which is
// what lets the headless harness construct the real World and the real Trampler
// without a GL context existing.
//
// Every pass here is optional. If a device cannot allocate the half-float targets
// the composer wants, `Post.enabled` goes false and the frame is drawn straight to
// the canvas -- same game, flatter picture. A graphical nicety must never be able
// to be the reason the thing does not start.

/**
 * Ground haze, vignette, grain and a touch of lens aberration, in one pass.
 *
 * One shader rather than four passes because each extra pass is another
 * full-screen read and write of a half-float target, and these four are all
 * cheap per-pixel maths that can share a single texture fetch.
 *
 * Runs BEFORE OutputPass, so it is working in linear light. That matters for the
 * haze in particular: mixing toward a colour after tone mapping produces a milky
 * grey, while mixing before it reads as air.
 */
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uVignette: { value: CFG.render.vignette },
    uGrain: { value: CFG.render.grain },
    uAberration: { value: CFG.render.aberration },
    uHaze: { value: CFG.render.hazeStrength },
    uHazeColor: { value: new THREE.Color(CFG.render.hazeColor) },
    uHurt: { value: 0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uAberration;
    uniform float uHaze;
    uniform vec3 uHazeColor;
    uniform float uHurt;
    varying vec2 vUv;

    // Cheap hash noise. Good enough for film grain, and it costs one fract.
    float hash(vec2 p) {
      return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
    }

    void main() {
      vec2 uv = vUv;
      vec2 centred = uv - 0.5;
      float r2 = dot(centred, centred);

      // Chromatic aberration, scaled by r2 so it is absent in the middle of frame
      // and only visible at the corners. Uniform aberration reads as a broken
      // monitor; radial reads as a lens.
      vec2 off = centred * uAberration * r2 * 40.0;
      vec4 col;
      col.r = texture2D(tDiffuse, uv + off).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - off).b;
      col.a = 1.0;

      // Screen-space dust haze, strongest low in frame where the ground is. This
      // is standing in for depth of field: it separates a 26 m silhouette from the
      // horizon for a fraction of the cost.
      float low = smoothstep(0.62, 0.0, uv.y);
      col.rgb = mix(col.rgb, uHazeColor * 0.35, low * uHaze * 0.22);

      // Vignette.
      col.rgb *= 1.0 - uVignette * smoothstep(0.15, 0.75, r2);

      // Blood-in-the-eyes tint, driven from health. Subtle, and only at the edges,
      // so it never fights the crosshair.
      col.rgb = mix(col.rgb, vec3(0.45, 0.03, 0.03), uHurt * smoothstep(0.05, 0.6, r2));

      // Grain, animated. Static grain reads as a dirty screen.
      float n = hash(uv * vec2(1024.0, 768.0) + fract(uTime) * 91.7) - 0.5;
      col.rgb += n * uGrain;

      gl_FragColor = col;
    }
  `,
};

export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // SMAA in the composer does this better and cheaper here
    powerPreference: "high-performance",
    stencil: false,
  });
  // Capped at 1.5 rather than 2. On a high-DPI display, 2 is four times the pixels
  // of 1 and every full-screen post pass pays for all of them -- for a difference
  // nobody can see at this art fidelity.
  renderer.setPixelRatio(Math.min(devicePixelRatio, CFG.render.maxPixelRatio));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  // PCF rather than PCFSoft: soft is four times the samples for a slightly nicer
  // penumbra, and the shadow here is a 26 m machine against sand, not a portrait.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CFG.render.exposure;
  return renderer;
}

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = false;
    this.time = 0;

    // Adaptive resolution state. Scaling the render target is the single most
    // effective quality dial available: every one of the full-screen passes below
    // costs proportionally to pixel count, so dropping to 0.7 is roughly half the
    // post-processing work for a picture that is softer rather than broken.
    this.basePixelRatio = Math.min(devicePixelRatio, CFG.render.maxPixelRatio);
    this.scale = CFG.render.adaptive.maxScale;
    this.frameAccum = 0;
    this.frameCount = 0;
    this.sinceAdjust = 0;
    this.lastMs = 0;
    this.adaptive = true;

    try {
      const composer = new EffectComposer(renderer);
      composer.addPass(new RenderPass(scene, camera));

      const b = CFG.render.bloom;
      this.bloom = new UnrealBloomPass(
        new THREE.Vector2(innerWidth, innerHeight), b.strength, b.radius, b.threshold,
      );
      composer.addPass(this.bloom);

      this.grade = new ShaderPass(GradeShader);
      composer.addPass(this.grade);

      // SMAA before the output pass: edge detection wants the image, not the
      // tone-mapped result, and running it last would soften the grain into mush.
      //
      // It is also the most expendable pass here -- three extra full-screen draws
      // for edge quality -- so it is the first thing the quality tier turns off.
      this.smaa = new SMAAPass(
        innerWidth * renderer.getPixelRatio(),
        innerHeight * renderer.getPixelRatio(),
      );
      composer.addPass(this.smaa);

      // Applies the renderer's tone mapping and converts to the output colour
      // space. Everything before this point is linear.
      composer.addPass(new OutputPass());

      this.composer = composer;
      this.enabled = true;
    } catch (err) {
      console.warn(`[post] disabled: ${err.message}`);
      this.composer = null;
      this.enabled = false;
    }
  }

  setSize(w, h) {
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h);
    // The composer resizes every pass it owns, including the bloom's own render
    // targets, so there is nothing further to do here.
    this.composer?.setSize(w, h);
  }

  /** N toggles it, so the pipeline's contribution can be judged rather than assumed. */
  toggle() {
    if (!this.composer) return false;
    this.enabled = !this.enabled;
    return this.enabled;
  }

  /** Exposure, live. "Too bright" is a monitor-and-eyes call, so it gets a key. */
  adjustExposure(delta) {
    const r = CFG.render;
    const next = Math.max(r.minExposure, Math.min(r.maxExposure, this.exposure + delta));
    this.renderer.toneMappingExposure = next;
    return next;
  }

  get exposure() {
    return this.renderer.toneMappingExposure;
  }

  /**
   * Walk the render scale toward whatever holds the target frame time.
   *
   * Deliberately slow and hysteretic: it averages a second of frames before
   * believing anything, moves one step at a time, and has a wide dead band between
   * "too slow" and "fast enough to scale back up". A resolution scaler that reacts
   * quickly oscillates, and visible oscillation is worse than a steady lower
   * resolution.
   */
  #adapt(dt) {
    const a = CFG.render.adaptive;
    this.sinceAdjust += dt;
    this.frameAccum += dt * 1000;
    this.frameCount++;

    if (this.sinceAdjust < a.interval || this.frameCount < a.samples) return;

    this.lastMs = this.frameAccum / this.frameCount;
    this.frameAccum = 0;
    this.frameCount = 0;
    this.sinceAdjust = 0;
    if (!this.adaptive) return;

    const before = this.scale;
    if (this.lastMs > a.targetMs) {
      this.scale = Math.max(a.minScale, this.scale - a.step);
    } else if (this.lastMs < a.relaxMs) {
      this.scale = Math.min(a.maxScale, this.scale + a.step);
    }
    if (this.scale === before) return;

    // Below full resolution, SMAA is refining edges that the upscale is about to
    // blur anyway. Turning it off is free quality at the point where quality is
    // already being spent.
    if (this.smaa) this.smaa.enabled = this.scale >= 0.95;

    const ratio = this.basePixelRatio * this.scale;
    this.renderer.setPixelRatio(ratio);
    this.composer?.setPixelRatio(ratio);
  }

  /** Human-readable state, for the diagnostics panel. */
  get status() {
    if (!this.composer) return "post unavailable";
    if (!this.enabled) return "post off";
    return `x${this.scale.toFixed(2)}${this.smaa?.enabled ? " +smaa" : ""}`
      + ` · ${this.lastMs.toFixed(1)} ms`;
  }

  render(dt, hurt = 0) {
    this.time += dt;
    this.#adapt(dt);
    if (this.enabled && this.composer) {
      this.grade.uniforms.uTime.value = this.time;
      this.grade.uniforms.uHurt.value = hurt;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

/**
 * Camera shake, and the reason it exists is the fortress's own feet.
 *
 * A 26 m walker whose steps do not touch the camera reads as a static room with a
 * moving skybox. Shake is the only channel that says "you are standing on
 * machinery" while the player is looking at the horizon.
 *
 * Applied AFTER the player controller has written the camera transform, because
 * the controller sets position and rotation outright every frame -- anything
 * added before it is discarded.
 */
export class Shake {
  constructor() {
    this.amount = 0;
    this.time = 0;
    this.offset = new THREE.Vector3();
  }

  /** Add an impulse. Bigger events do not simply overwrite smaller ones. */
  add(amount) {
    this.amount = Math.min(1.2, this.amount + amount);
  }

  /**
   * Decay the accumulated impulse and write the offset onto the camera.
   *
   * Distance attenuation is the caller's job, through `addAt` -- a leg forty
   * metres astern should not shake the view as hard as the one you are standing
   * next to, but only the caller knows where the event was.
   */
  update(dt, camera) {
    this.time += dt;
    this.amount = damp(this.amount, 0, CFG.render.shake.decay, dt);
    if (this.amount < 0.0005) {
      this.amount = 0;
      return;
    }

    const a = this.amount;
    const t = this.time;
    // Three incommensurable frequencies, so it never settles into a visible
    // rhythm the way a single sine does.
    this.offset.set(
      Math.sin(t * 47.3) * 0.06 * a + Math.sin(t * 13.1) * 0.02 * a,
      Math.sin(t * 39.7) * 0.05 * a + Math.sin(t * 71.3) * 0.015 * a,
      Math.sin(t * 29.9) * 0.03 * a,
    );
    camera.position.add(this.offset);
    camera.rotation.z += Math.sin(t * 33.7) * 0.012 * a;
  }

  /** Distance-attenuated impulse from a world-space event. */
  addAt(worldPos, camera, base, falloff = 26) {
    const d = camera.position.distanceTo(worldPos);
    this.add(base * clamp(1 - d / falloff, 0, 1));
  }
}
