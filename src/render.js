import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import { FXAAShader } from "three/addons/shaders/FXAAShader.js";
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
    antialias: false, // a post pass handles this without multisampling the scene
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
    // Fastest frame interval seen so far, which is the only evidence available of
    // what the display's refresh actually is. 0 means "not observed yet".
    this.refreshMs = 0;
    this.adaptive = true;
    this.width = innerWidth;
    this.height = innerHeight;

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

      // Applies the renderer's tone mapping and converts to the output colour
      // space. Everything before this point is linear.
      composer.addPass(new OutputPass());

      // FXAA goes AFTER the output pass, which is the one thing about it that is
      // not interchangeable with the SMAA pass it replaced. Its thresholds are
      // absolute luminance contrasts calibrated for tone-mapped sRGB in 0..1
      // (0.0312 and 0.063 in the shader), so fed linear HDR instead it treats
      // anything above white as a hard edge and cannot see one in shadow at all.
      // three.js says the same thing in its own FXAA example.
      //
      // One full-screen draw and no render targets of its own, against SMAA's
      // three draws and two full-resolution half-float targets.
      //
      // The cost of this position is that it slightly softens the grade pass's
      // grain. That is the cheaper of the two errors: miscalibrated antialiasing
      // is wrong everywhere, softened grain is wrong nowhere in particular.
      this.fxaa = new ShaderPass(FXAAShader);
      composer.addPass(this.fxaa);

      this.composer = composer;
      this.#syncFxaaResolution();
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
    // The composer resizes every render target it owns. FXAA has no target, so
    // its inverse drawing-buffer resolution is synchronised separately.
    this.composer?.setSize(w, h);
    this.#syncFxaaResolution();
  }

  #syncFxaaResolution() {
    if (!this.fxaa) return;
    const ratio = this.renderer.getPixelRatio();
    this.fxaa.uniforms.resolution.value.set(
      1 / (this.width * ratio),
      1 / (this.height * ratio),
    );
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
   * Walk the render scale toward whatever holds a full-rate frame.
   *
   * Deliberately slow and hysteretic: it averages a second of frames before
   * believing anything, moves one step at a time, and has a wide dead band between
   * "too slow" and "fast enough to scale back up". A resolution scaler that reacts
   * quickly oscillates, and visible oscillation is worse than a steady lower
   * resolution.
   *
   * Two things it must get right, and the previous version got both wrong.
   *
   * It is judged against the DISPLAY, not against a fixed millisecond figure. Under
   * vsync the frame interval is quantised to the refresh interval, so "16.7 ms" is
   * what success looks like on a 60 Hz panel and what failure looks like on a 144 Hz
   * one. A hardcoded target cannot mean both.
   *
   * And the sample is the RAW frame interval, not the simulation's clamped dt.
   * `main.js` clamps dt to 1/30 s so a stall cannot tunnel the player through the
   * hull -- entirely correct there, and fatal here, because it means every frame
   * slower than 30 fps reports as exactly 33.3 ms. The scaler could not tell 30 fps
   * from 5 fps, which is precisely the range it exists to react to.
   *
   * @param frameMs wall-clock milliseconds since the previous frame, unclamped.
   */
  #adapt(frameMs) {
    const a = CFG.render.adaptive;

    // Infer the refresh interval from the fastest frame that is plausibly one.
    // Nothing slower than `refreshSampleMax` may lower this estimate: a machine
    // pinned at half rate would otherwise decide its monitor was 30 Hz, conclude it
    // was keeping up perfectly, and stop responding to load at all.
    if (frameMs >= a.refreshSampleMin && frameMs <= a.refreshSampleMax) {
      this.refreshMs = this.refreshMs > 0 ? Math.min(this.refreshMs, frameMs) : frameMs;
    }

    this.sinceAdjust += frameMs / 1000;
    // Clamped into the average rather than dropped, so one alt-tab costs a couple
    // of milliseconds of a thirty-frame mean while a genuinely terrible frame still
    // counts as terrible.
    this.frameAccum += Math.min(frameMs, a.spikeClampMs);
    this.frameCount++;

    if (this.sinceAdjust < a.interval || this.frameCount < a.samples) return;

    this.lastMs = this.frameAccum / this.frameCount;
    this.frameAccum = 0;
    this.frameCount = 0;
    this.sinceAdjust = 0;
    if (!this.adaptive) return;

    const refresh = Math.max(this.refreshMs || a.refreshFallbackMs, a.refreshFloorMs);
    const before = this.scale;
    if (this.lastMs > refresh * a.downFactor) {
      this.scale = Math.max(a.minScale, this.scale - a.step);
    } else if (this.lastMs < refresh * a.upFactor) {
      this.scale = Math.min(a.maxScale, this.scale + a.step);
    }
    if (this.scale === before) return;

    // Below full resolution, antialiasing refines edges that the upscale is about
    // to blur anyway. Turning it off spends the quality cut on useful pixels.
    if (this.fxaa) this.fxaa.enabled = this.scale >= 0.95;

    const ratio = this.basePixelRatio * this.scale;
    this.renderer.setPixelRatio(ratio);
    this.composer?.setPixelRatio(ratio);
    this.#syncFxaaResolution();
  }

  /**
   * Human-readable state, for the diagnostics panel.
   *
   * The inferred refresh rate is in here because the scaler's decisions are
   * meaningless without it: "16.7 ms" is a pass on one monitor and a fail on
   * another, and a wrong guess is exactly how this went wrong before.
   */
  get status() {
    if (!this.composer) return "post unavailable";
    if (!this.enabled) return "post off";
    const hz = this.refreshMs > 0 ? `${Math.round(1000 / this.refreshMs)} Hz` : "Hz unknown";
    return `x${this.scale.toFixed(2)}${this.fxaa?.enabled ? " +fxaa" : ""}`
      + ` · ${this.lastMs.toFixed(1)} ms · ${hz}`;
  }

  /**
   * @param dt clamped simulation delta, for time-varying uniforms.
   * @param frameMs raw wall-clock frame interval, for the quality scaler. Defaults
   *        to dt so a two-argument call still behaves, but main.js passes it.
   */
  render(dt, hurt = 0, frameMs = dt * 1000) {
    this.time += dt;
    this.#adapt(frameMs);
    if (this.enabled && this.composer) {
      this.grade.uniforms.uTime.value = this.time;
      this.grade.uniforms.uHurt.value = hurt;
      this.composer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }
}

/** Shortest signed turn from one yaw to another. */
function angleDelta(from, to) {
  let d = (to - from) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return d;
}

/**
 * Render the local camera between fixed simulation poses.
 *
 * Player state remains wholly fixed-step. This keeps only the previous and current eye pose,
 * then draws between them at render cadence. Network reconciliation is rebased onto both
 * endpoints so authority bookkeeping is not mistaken for one tick of physical travel.
 *
 * Mouse input is already visible before its fixed step is due. When that step arrives,
 * `beforeStep` moves the old endpoint by the consumed delta so interpolation does not turn the
 * view backwards and apply the same input a second time. Mounted aim is excluded because only
 * the station knows its legal traverse arc.
 */
export class CameraPresentation {
  constructor(player, input, camera = player.camera) {
    this.player = player;
    this.input = input;
    this.camera = camera;

    this.previousPosition = player.eyePosition(new THREE.Vector3());
    this.currentPosition = this.previousPosition.clone();
    this.actualPosition = new THREE.Vector3();
    this.correction = new THREE.Vector3();
    this.previousYaw = player.yaw;
    this.currentYaw = player.yaw;
    this.previousPitch = player.pitch;
    this.currentPitch = player.pitch;
  }

  /** Shift both endpoints by any correction applied outside the fixed-step loop. */
  rebase() {
    this.player.eyePosition(this.actualPosition);
    this.correction.copy(this.actualPosition).sub(this.currentPosition);
    this.previousPosition.add(this.correction);
    this.currentPosition.copy(this.actualPosition);

    const yawCorrection = angleDelta(this.currentYaw, this.player.yaw);
    this.previousYaw += yawCorrection;
    this.currentYaw = this.player.yaw;
    this.previousPitch += this.player.pitch - this.currentPitch;
    this.currentPitch = this.player.pitch;
  }

  /** Preserve the old fixed pose immediately before the simulation advances. */
  beforeStep() {
    this.previousPosition.copy(this.currentPosition);
    this.previousYaw = this.currentYaw;
    this.previousPitch = this.currentPitch;

    if (!this.input.locked || this.player.station) return;
    this.previousYaw -= this.input.mouse.dx * CFG.player.lookSensitivity;
    this.previousPitch = clamp(
      this.previousPitch - this.input.mouse.dy * CFG.player.lookSensitivity,
      -CFG.player.pitchLimit,
      CFG.player.pitchLimit,
    );
  }

  /** Capture the new fixed pose after the simulation has advanced. */
  afterStep() {
    this.player.eyePosition(this.currentPosition);
    this.currentYaw = this.player.yaw;
    this.currentPitch = this.player.pitch;
  }

  /** Write the render pose, including any mouse delta not consumed by a fixed step yet. */
  apply(alpha) {
    const t = clamp(alpha, 0, 1);
    this.camera.position.lerpVectors(this.previousPosition, this.currentPosition, t);

    let yaw = this.previousYaw + angleDelta(this.previousYaw, this.currentYaw) * t;
    let pitch = this.previousPitch + (this.currentPitch - this.previousPitch) * t;
    if (this.input.locked && !this.player.station) {
      yaw -= this.input.mouse.dx * CFG.player.lookSensitivity;
      pitch -= this.input.mouse.dy * CFG.player.lookSensitivity;
    }
    pitch = clamp(pitch, -CFG.player.pitchLimit, CFG.player.pitchLimit);
    this.camera.rotation.set(pitch, yaw, 0, "YXZ");
  }
}

/**
 * Camera shake, and the reason it exists is the fortress's own feet.
 *
 * A 26 m walker whose steps do not touch the camera reads as a static room with a
 * moving skybox. Shake is the only channel that says "you are standing on
 * machinery" while the player is looking at the horizon.
 *
 * Applied AFTER CameraPresentation restores the base transform every rendered
 * frame. Shake is additive, so restoring only on fixed steps would accumulate
 * offsets across high-refresh frames that run no simulation step.
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
