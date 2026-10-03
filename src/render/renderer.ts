// Scene setup, lighting, sky, shadows, post-processing, dynamic resolution and frame orchestration (1 unit = 10 m).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import type { Game } from '../game/game';
import { TerrainView, raycastTerrain } from './terrain';
import { ObjectsView } from './objects';
import { VehiclesView } from './vehicles-view';
import { Overlay } from './overlay';
import { Labels } from './labels';
import { Materials } from './materials';
import { CameraController } from './camera';
import { applyClouds, cloudUniforms, shadowFadeUniforms } from './clouds';

export type ResolutionMode = 'auto' | 1 | 0.75 | 0.5;

export interface GraphicsSettings {
  shadows: boolean;
  /** shadow map 2048 (high) or 1024 (low) */
  shadowQuality: 'low' | 'high';
  dayNight: boolean;
  labels: boolean;
  /** device pixel ratio cap (the resolution scale applies on top of it) */
  pixelRatio: number;
  /** render resolution: 'auto' adapts to hold ~60 fps, otherwise a fixed fraction of the capped DPR */
  resolution: ResolutionMode;
  ao: boolean;
  clouds: boolean;
  /** performance overlay (also toggled with F3) */
  debug: boolean;
}

const SETTINGS_VERSION = 2;
/**
 * Resolution steps of the automatic mode (fractions of the capped device pixel ratio): a few clearly separated
 * levels (each ~1.4x the pixels of the next), changed with hysteresis, so the image does not keep pumping.
 */
const AUTO_STEPS = [1, 0.85, 0.72, 0.6, 0.5];
/**
 * Seconds of headroom before the automatic resolution tries a step up to a level; four times longer for every time
 * the resolution had to leave that level again (a failed try, or a later slowdown), up to UP_WAIT_MAX, until a step
 * up to it or a finer level has held for UP_HELD seconds.
 */
const UP_WAIT = 6;
const UP_WAIT_MAX = 900;
const UP_HELD = 600;
/** Seconds without descents after a descent that did not help; doubled each time, up to DOWN_BLOCK_MAX. */
const DOWN_BLOCK = 60;
const DOWN_BLOCK_MAX = 900;
/**
 * Safety net of the automatic resolution, whatever its logic decides (every change counts, undos included): at least
 * RES_GAP seconds between changes, at most RES_PER_MIN changes in any minute, and RES_COOL seconds of calm after a
 * change that undid the one before it - no oscillation can be faster than this.
 */
const RES_GAP = 8;
const RES_PER_MIN = 4;
const RES_COOL = 30;
/** Display period the automatic resolution aims at (ms): 60 fps. */
const VSYNC = 1000 / 60;
/** Refresh interval (s) of the far shadow cascade for moving vehicles (doubled while the resolution is cut). */
const FAR_SHADOW_EVERY = 0.1;
/** Largest half-extent of the shadow box (units); wider views keep shadows around the focus and fade them out. */
const SHADOW_MAX = 170;
const WARM = new THREE.Color(0.95, 0.65, 0.45);
const NIGHT_FOG = new THREE.Color(0.035, 0.05, 0.09);

/**
 * Post-processing chain: the scene renders into one multisampled half-float target (its resolved depth feeds
 * GTAO), AO is blended into a second target, the grade pass tone-maps (ACES), encodes sRGB and applies a
 * subtle grade into an 8-bit target, and SMAA (FXAA when the GPU is short of time) anti-aliases to the screen.
 */
interface Post {
  scene: THREE.WebGLRenderTarget;
  ao: THREE.WebGLRenderTarget;
  ldr: THREE.WebGLRenderTarget;
  gtao: GTAOPass;
  smaa: SMAAPass;
  fxaa: FXAAPass;
  grade: THREE.ShaderMaterial;
  quad: FullScreenQuad;
  w: number; h: number; samples: number;
}

const GRADE_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
const GRADE_FRAG = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uExposure;
uniform float uCurve;
uniform float uSaturation;
uniform vec3 uLift;
uniform vec3 uGain;
uniform float uVignette;
varying vec2 vUv;
// three.js ACES filmic fit
vec3 rfRRT(vec3 v) { vec3 a = v * (v + 0.0245786) - 0.000090537; vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081; return a / b; }
vec3 rfAces(vec3 c) {
  const mat3 IN = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 OUT = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  c *= uExposure / 0.6;
  return clamp(OUT * rfRRT(IN * c), 0.0, 1.0);
}
vec3 rfSrgb(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
float rfHash(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
void main() {
  vec3 c = rfSrgb(rfAces(texture2D(tDiffuse, vUv).rgb));
  // grade in display space: cool shadows / warm highlights, gentle S-curve, a touch of saturation
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c += uLift * (1.0 - l) * (1.0 - l);
  c *= mix(vec3(1.0), uGain, l);
  c = mix(c, c * c * (3.0 - 2.0 * c), uCurve);
  l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(l), c, uSaturation);
  vec2 d = vUv - 0.5;
  c *= 1.0 - uVignette * dot(d, d) * 2.0;
  // dither the 8-bit target (no banding in skies and fog)
  c += (rfHash(gl_FragCoord.xy) - 0.5) / 255.0;
  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

/** GPU frame timing via EXT_disjoint_timer_query_webgl2 (null when unsupported). */
class GpuTimer {
  private gl: WebGL2RenderingContext;
  private ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };
  private free: WebGLQuery[] = [];
  private pending: WebGLQuery[] = [];
  private active: WebGLQuery | null = null;
  /** smoothed GPU milliseconds per frame */
  ms = 0;
  samples = 0;
  static create(r: THREE.WebGLRenderer): GpuTimer | null {
    const gl = r.getContext();
    if (!(gl instanceof WebGL2RenderingContext)) return null;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    return ext ? new GpuTimer(gl, ext) : null;
  }
  private constructor(gl: WebGL2RenderingContext, ext: { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }) { this.gl = gl; this.ext = ext; }
  begin() {
    if (this.active || this.pending.length > 4) return;
    const q = this.free.pop() ?? this.gl.createQuery();
    if (!q) return;
    this.gl.beginQuery(this.ext.TIME_ELAPSED_EXT, q);
    this.active = q;
  }
  end() {
    if (!this.active) return;
    this.gl.endQuery(this.ext.TIME_ELAPSED_EXT);
    this.pending.push(this.active);
    this.active = null;
  }
  poll() {
    const gl = this.gl;
    while (this.pending.length) {
      const q = this.pending[0];
      if (!gl.getQueryParameter(q, gl.QUERY_RESULT_AVAILABLE)) break;
      const disjoint = gl.getParameter(this.ext.GPU_DISJOINT_EXT);
      const ns = gl.getQueryParameter(q, gl.QUERY_RESULT) as number;
      this.pending.shift();
      this.free.push(q);
      if (disjoint) continue;
      const ms = ns / 1e6;
      this.ms = this.samples ? this.ms * 0.9 + ms * 0.1 : ms;
      this.samples++;
    }
  }
}

export class Renderer {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera: THREE.PerspectiveCamera;
  controls: CameraController;
  mats = new Materials();
  sky: Sky;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  terrain!: TerrainView;
  objects!: ObjectsView;
  vehicles: VehiclesView;
  overlay!: Overlay;
  labels: Labels;
  game!: Game;
  settings: GraphicsSettings = {
    shadows: true, shadowQuality: 'high', dayNight: false, labels: true,
    pixelRatio: Math.min(window.devicePixelRatio || 1, 1.5), resolution: 'auto', ao: true, clouds: true, debug: false,
  };
  /** simulation milliseconds of the last frame (set by the main loop, shown in the debug overlay) */
  simMs = 0;
  /** main-thread milliseconds of the last whole frame (simulation, rendering, UI; set by the main loop) */
  loopMs = 0;
  /** current dynamic resolution scale (fraction of the capped device pixel ratio) */
  resScale = 1;
  fps = 60;
  sunDir = new THREE.Vector3();
  /** direction of the active directional light (sun by day, moon at night) */
  lightDir = new THREE.Vector3();
  night = 0;
  light = 1;
  private post: Post | null = null;
  private gtaoRadius = 0;
  /** AO temporarily dropped by the automatic quality control */
  private aoSuspended = false;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envSky: Sky;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -1, 0);
  private worldGroup = new THREE.Group();
  private time = 0;
  private raycaster = new THREE.Raycaster();
  private tmpV2 = new THREE.Vector2();
  private horizon = new THREE.Color();
  private heightRange: [number, number] = [0, 0];
  private heightVer = -1;
  private fpsAcc = 0; private fpsN = 0;
  // frame timing / dynamic resolution
  private gpu: GpuTimer | null;
  private lastFrameT = 0;
  private frameMs = 16.7;
  private cpuMs = 0;
  /**
   * Main-thread time after a frame before a task posted at its end runs (UI updates, the browser's own style /
   * layout / paint of the page, queued tasks): busy main-thread time the frame interval includes but the GPU does
   * not cause (a GPU-bound frame leaves the main thread idle). Sampled with one outstanding MessageChannel probe
   * (every 4th frame, automatic resolution only); partial evidence: tasks after the probe are only seen when the
   * browser reports them as long tasks (longMs).
   */
  private postMs = 0;
  private probe: MessageChannel | null = null;
  private probeT = -1;
  private probeN = 0;
  /** milliseconds of other long main-thread tasks (not the ones that ran our frames) in the current window */
  private longMs = 0;
  /** recent loop start times: a long task containing one of them ran our frame (measured as loop time already) */
  private frameStarts = new Float64Array(64);
  private frameStartN = 0;
  private dynAcc = 0; private dynN = 0; private dynSum = 0; private dynCpu = 0;
  /** GPU timer samples at the start of the window (fresh samples per window decide whether the timer is used) */
  private gpuS0 = 0;
  /** GPU timer distrusted until (render time), after its readings repeatedly failed to explain slow frames */
  private gpuDistrustUntil = 0; private gpuDistrust = 30; private gpuOdd = 0;
  /**
   * GPU timer vindicated until (render time): while it was set aside, steps down did not help either, so its
   * reading (the GPU is not the limit) was right - e.g. a display or a power saver capping the frame rate - and slow
   * frames it does not explain are not held against it for a while (longer each time)
   */
  private gpuVindicatedUntil = 0; private gpuVindicate = 60;
  /** performance-relevant settings the automatic resolution's state was learned under */
  private perfKey = '';
  /** frame intervals of the current measurement window (frame-interval mode uses their median: one long frame,
   *  e.g. a garbage collection or a save, is not a reason to lower the resolution) */
  private dynIv: number[] = [];
  /** index into AUTO_STEPS (automatic mode) */
  private resStep = 0;
  /** render times (this.time) of the last step change and the last step down */
  private lastChange = -1e9; private lastDown = -1e9;
  /** seconds of headroom seen for the next step up, and needed before taking it (see UP_WAIT) */
  private upHeadroom = 0; private upWait = UP_WAIT;
  /** per level: how often the resolution had to leave it again since it or a finer level last held */
  private levelDrops = AUTO_STEPS.map(() => 0);
  /** the level reached and held, and since when (it and coarser levels are forgiven after UP_HELD seconds) */
  private heldLevel = -1; private heldSince = 0;
  /** a trial step up: the step it came from, windows left to watch it, the frame interval before it */
  private upTrial: { from: number; left: number; before: number } | null = null;
  /**
   * The last step down, checked against fresh measurements (a step down that does not help is undone: the cost is
   * not in the pixels): the frame interval before it, the GPU time before it and the time predicted for the new
   * step (when the GPU timer was used), and the step to return to. Judged by the GPU time while the timer stays in
   * use, by the frame interval otherwise (so a change of timing source does not lose the check).
   */
  private downCheck: { ivBefore: number; gpuBefore: number; predicted: number; origin: number } | null = null;
  private downBlockUntil = 0; private downBackoff = DOWN_BLOCK;
  /**
   * an undone descent, confirmed by the first window back at the old step against the measurement from before the
   * descent: only clearly slower than that means the load rose meanwhile (and descents may resume)
   */
  private verify: { gpu: boolean; before: number } | null = null;
  /** render times of the recent resolution changes, and no change before `resCalmUntil` (see RES_GAP) */
  private resChanges: number[] = []; private resCalmUntil = 0;
  /** frame-interval mode: consecutive slow windows (a descent starts on the second: no reaction to a burst) */
  private slowRun = 0;
  /** whether the last evaluated window used the GPU timer */
  private lastTimed = false;
  /** ambient occlusion suspension: seconds too slow at the lowest step, headroom at full resolution, back-off */
  private slowAtFloor = 0; private aoHeadroom = 0; private aoWait = 10; private aoResumedAt = -1e9;
  /** capped device pixel ratio the controller's evidence was measured under */
  private effectiveDPR = this.maxPR();
  private appliedPR = 0;
  /**
   * The drawing buffer (canvas) and the post targets must follow the size / resolution. Resizing a canvas clears it,
   * so this is applied at the start of a frame, before anything is drawn: a canvas resized after the frame was
   * drawn is presented cleared (a black frame).
   */
  private sizeDirty = true;
  /** drawing-buffer pixels per world unit at unit distance at the configured resolution (LOD choices) */
  private lodScale = 1200;
  // shadows
  private shadowKey = new Float64Array(9);
  private shadowKeyFar = new Float64Array(9);
  private sunFar: THREE.DirectionalLight;
  private sb = new Float64Array(6);
  private shadowTimer = 0;
  private shadowFrame = 0;
  /** seconds since the far shadow cascade was last rendered */
  private farAge = 0;
  /** half-extent the view footprint would need (beyond SHADOW_MAX the box is clamped) */
  private shadowNeed = 0;
  /** distance fade of all shadows (1 = full), and whether the skipped shadow map is out of date */
  private shadowFade = 1;
  private shadowStale = false;
  /** distance from the camera the shadow footprint reaches */
  private shadowReach = 360;
  private lastCamM = new THREE.Matrix4();
  private v1 = new THREE.Vector3(); private v2 = new THREE.Vector3(); private v3 = new THREE.Vector3();
  private lx = new THREE.Vector3(); private ly = new THREE.Vector3();
  private focusV = new THREE.Vector3();
  private moonDir = new THREE.Vector3();
  // debug overlay
  private dbgEl: HTMLDivElement | null = null;
  private dbgTimer = 0;
  private stats = { calls: 0, tris: 0 };

  constructor(public container: HTMLElement) {
    // anti-aliasing happens in the post chain (multisampled scene target + SMAA / FXAA)
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.info.autoReset = false;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'gl';
    this.gpu = GpuTimer.create(this.renderer);
    if (typeof MessageChannel !== 'undefined') {
      this.probe = new MessageChannel();
      this.probe.port1.onmessage = () => {
        this.postMs = this.postMs * 0.8 + Math.min(250, performance.now() - this.probeT) * 0.2;
        this.probeT = -1;
      };
    }
    // long tasks that did not run one of our frames (timers, input, saves, other scripts): main-thread time the probe
    // can miss (Chromium only; elsewhere the descent checks of the automatic resolution have to do)
    try {
      if (typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
        new PerformanceObserver((list) => {
          if (this.settings.resolution !== 'auto') return;
          for (const e of list.getEntries()) {
            const a = e.startTime, b = a + e.duration;
            let ours = false;
            for (let k = 0; k < this.frameStarts.length && !ours; k++) ours = this.frameStarts[k] >= a && this.frameStarts[k] <= b;
            if (!ours) this.longMs += e.duration;
          }
        }).observe({ type: 'longtask' });
      }
    } catch { /* not supported */ }

    this.camera = new THREE.PerspectiveCamera(38, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.05, 3000);

    this.sky = new Sky();
    this.sky.scale.setScalar(40000);
    this.sky.frustumCulled = false;
    // drawn after the opaque world (at the far plane): early depth rejection skips covered sky pixels
    this.sky.renderOrder = 10;
    const su = this.sky.material.uniforms;
    su.turbidity.value = 4.5;
    su.rayleigh.value = 1.3;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);
    this.envSky = new Sky();
    this.envSky.scale.setScalar(100);
    const eu = this.envSky.material.uniforms;
    eu.turbidity.value = 4.5;
    eu.rayleigh.value = 1.3;
    eu.mieCoefficient.value = 0.004;
    eu.mieDirectionalG.value = 0.82;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0001;
    this.sun.shadow.normalBias = 0.02;
    this.sun.shadow.camera.matrixAutoUpdate = true;
    this.scene.add(this.sun, this.sun.target);
    // far shadow cascade: casts only (no light of its own); added after the sun so it is shadow light 1
    this.sunFar = new THREE.DirectionalLight(0xffffff, 0);
    this.sunFar.castShadow = true;
    this.sunFar.shadow.mapSize.set(2048, 2048);
    this.sunFar.shadow.autoUpdate = false;
    this.sunFar.shadow.camera.matrixAutoUpdate = true;
    this.scene.add(this.sunFar, this.sunFar.target);
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x5a5440, 0.9);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.Fog(0xc9d8e8, 200, 900);
    this.scene.add(this.worldGroup);

    this.vehicles = new VehiclesView(this.mats);
    this.labels = new Labels(container);
    this.labels.wheelTarget = this.renderer.domElement;
    const extra = (this.mats as unknown as { extra?: THREE.Material[] }).extra ?? [];
    for (const m of [this.mats.matte, this.mats.metal, this.mats.facade, this.mats.tree, this.mats.body, ...extra]) applyClouds(m);

    this.controls = new CameraController(this.camera, this.renderer.domElement, null, (x, y) => this.pickGround(x, y));
    window.addEventListener('resize', () => {
      // the buffers follow at the start of the next frame; the projection right away (picking in between)
      this.sizeDirty = true;
      this.camera.aspect = Math.max(1, this.container.clientWidth) / Math.max(1, this.container.clientHeight);
      this.camera.updateProjectionMatrix();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'F3') return;
      e.preventDefault();
      this.settings.debug = !this.settings.debug;
      this.applySettings();
    });
  }

  setGame(game: Game) {
    this.game = game;
    this.worldGroup.clear();
    if (this.terrain) this.terrain.dispose();
    if (this.objects) this.objects.dispose();
    this.vehicles.dispose();
    this.terrain = new TerrainView(game.world);
    applyClouds(this.terrain.material);
    this.objects = new ObjectsView(game, this.mats);
    this.objects.buildAll();
    this.overlay = new Overlay(game);
    this.vehicles = new VehiclesView(this.mats);
    this.worldGroup.add(this.terrain.group, this.objects.group, this.vehicles.group, this.overlay.group);
    this.labels.clear();
    this.controls.setWorld(game.world);
    // snow only where believable: on mountainous maps, the highest summits (top ~1.5 % of the land, and
    // above 72 % of the peak height); never on hilly or flat maps
    this.heightVer = -1;
    const [, maxH] = this.terrainRange();
    this.terrain.uniforms.uSnow.value = game.options.hilliness === 'mountainous' ? Math.max(this.landPercentile(0.985), maxH * 0.72) : 1e5;
    this.shadowKey.fill(NaN);
    this.shadowKeyFar.fill(NaN);
  }

  // ------------------------------------------------------------------ resolution / settings

  /** Device pixel ratio cap from the settings. */
  private maxPR() { return Math.max(0.5, Math.min(window.devicePixelRatio || 1, this.settings.pixelRatio || 1.5)); }

  private targetPR(auto = this.resScale) {
    const r = this.settings.resolution;
    const k = r === 'auto' ? auto : typeof r === 'number' ? r : 1;
    // quantised so small corrections don't reallocate render targets
    return Math.max(0.35, Math.round(this.maxPR() * k * 16) / 16);
  }

  resize() {
    this.sizeDirty = false;
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    // level-of-detail choices (terrain, vehicles) use the pixels of the configured resolution, not those of the
    // automatic scale: a dynamic-resolution step must never switch LODs
    this.lodScale = Math.floor(h * this.targetPR(1)) / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const pr = this.targetPR();
    if (pr !== this.appliedPR) { this.appliedPR = pr; this.renderer.setPixelRatio(pr); }
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.post) this.sizePost();
  }

  /** MSAA samples of the scene target: 4 at normal pixel densities, 2 on dense (high-DPI) buffers. */
  private msaaSamples(): number {
    const g = this.renderer.getContext();
    const max = g instanceof WebGL2RenderingContext ? (g.getParameter(g.MAX_SAMPLES) as number) : 0;
    return Math.min(max, this.renderer.getPixelRatio() > 1.6 ? 2 : 4);
  }

  private setupPost(): Post {
    const size = this.renderer.getDrawingBufferSize(this.tmpV2), W = Math.max(1, size.x), H = Math.max(1, size.y);
    const samples = this.msaaSamples();
    const scene = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples, depthTexture: new THREE.DepthTexture(W, H) });
    const ao = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
    const ldr = new THREE.WebGLRenderTarget(W, H, { type: THREE.UnsignedByteType, depthBuffer: false });
    const gtao = new GTAOPass(this.scene, this.camera, W, H);
    // AO from the main pass depth (normals reconstructed from depth): no second geometry pass, half resolution
    gtao.setGBuffer(scene.depthTexture!);
    (gtao as unknown as { normalRenderTarget: THREE.WebGLRenderTarget }).normalRenderTarget.setSize(1, 1);
    gtao.setSize = (sw: number, sh: number) => {
      const w2 = Math.max(1, Math.round(sw * 0.5)), h2 = Math.max(1, Math.round(sh * 0.5));
      gtao.width = w2; gtao.height = h2;
      gtao.gtaoRenderTarget.setSize(w2, h2);
      gtao.pdRenderTarget.setSize(w2, h2);
      gtao.gtaoMaterial.uniforms.resolution.value.set(w2, h2);
      gtao.pdMaterial.uniforms.resolution.value.set(w2, h2);
    };
    // contact shadows only: small radius, gentle intensity, fast fall-off (no dark patches on hillsides)
    gtao.updateGtaoMaterial({ radius: 0.2, distanceExponent: 2.0, thickness: 0.6, scale: 1.0, samples: 8, distanceFallOff: 0.6 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 4, rings: 2, samples: 8 });
    gtao.blendIntensity = 0.55;
    gtao.setSize(W, H);
    const smaa = new SMAAPass();
    smaa.setSize(W, H);
    smaa.renderToScreen = true;
    const fxaa = new FXAAPass();
    fxaa.setSize(W, H);
    fxaa.renderToScreen = true;
    const grade = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null },
        uExposure: { value: 1 },
        uCurve: { value: 0.16 },
        uSaturation: { value: 1.06 },
        uLift: { value: new THREE.Vector3(-0.004, 0.002, 0.014) },
        uGain: { value: new THREE.Vector3(1.025, 1.0, 0.965) },
        uVignette: { value: 0.12 },
      },
      vertexShader: GRADE_VERT, fragmentShader: GRADE_FRAG, depthTest: false, depthWrite: false, toneMapped: false,
    });
    this.post = { scene, ao, ldr, gtao, smaa, fxaa, grade, quad: new FullScreenQuad(grade), w: W, h: H, samples };
    return this.post;
  }

  /** Follow the drawing-buffer size (and the MSAA sample count it calls for). */
  private sizePost() {
    const P = this.post!;
    const size = this.renderer.getDrawingBufferSize(this.tmpV2), W = Math.max(1, size.x), H = Math.max(1, size.y);
    const samples = this.msaaSamples();
    if (samples !== P.samples) {
      P.scene.dispose();
      P.scene = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, samples, depthTexture: new THREE.DepthTexture(W, H) });
      P.samples = samples;
      P.gtao.setGBuffer(P.scene.depthTexture!);
    }
    if (W === P.w && H === P.h) return;
    P.w = W; P.h = H;
    P.scene.setSize(W, H);
    P.ao.setSize(W, H);
    P.ldr.setSize(W, H);
    P.gtao.setSize(W, H);
    P.smaa.setSize(W, H);
    P.fxaa.setSize(W, H);
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem('railfever.settings');
      if (raw) {
        const s = JSON.parse(raw) as Partial<GraphicsSettings> & { v?: number };
        // settings from older versions: keep the preferences, take the new performance defaults
        if (s.v !== SETTINGS_VERSION) { delete s.pixelRatio; delete s.ao; delete s.shadowQuality; delete s.resolution; }
        delete s.v;
        Object.assign(this.settings, s);
      }
    } catch { /* ignore */ }
    this.applySettings();
  }

  applySettings() {
    try { localStorage.setItem('railfever.settings', JSON.stringify({ ...this.settings, v: SETTINGS_VERSION })); } catch { /* ignore */ }
    // what the automatic resolution measured and learned no longer holds when the mode or the cost changes
    const st = this.settings, key = `${st.resolution}|${st.pixelRatio}|${st.shadows}|${st.shadowQuality}|${st.ao}`;
    if (key !== this.perfKey) { this.perfKey = key; this.resetAuto(); }
    // applied at the start of the next frame (see sizeDirty)
    this.sizeDirty = true;
    this.sun.castShadow = this.settings.shadows;
    // high quality: two cascades (sharp near the camera); low: one 1024 map
    const cascades = this.settings.shadows && this.settings.shadowQuality !== 'low';
    this.sunFar.castShadow = cascades;
    this.sunFar.visible = cascades;
    const s = this.settings.shadowQuality === 'low' ? 1024 : 2048;
    for (const l of [this.sun, this.sunFar]) {
      if (l.shadow.mapSize.x === s) continue;
      l.shadow.mapSize.set(s, s);
      l.shadow.map?.dispose();
      (l.shadow as unknown as { map: unknown }).map = null;
    }
    this.shadowKey.fill(NaN);
    this.shadowKeyFar.fill(NaN);
    this.labels.visible = this.settings.labels;
    this.updateDebugEl();
  }

  /** Height below which a fraction q of the land (above water) lies (histogram over the heightfield). */
  private landPercentile(q: number): number {
    const h = this.game.world.h;
    let mx = 0;
    for (let i = 0; i < h.length; i += 3) if (h[i] > mx) mx = h[i];
    const B = 1024, hist = new Uint32Array(B), k = (B - 1) / Math.max(1e-3, mx);
    let n = 0;
    for (let i = 0; i < h.length; i += 3) { const y = h[i]; if (y <= 0) continue; hist[Math.min(B - 1, Math.floor(y * k))]++; n++; }
    let acc = 0;
    for (let b = 0; b < B; b++) { acc += hist[b]; if (acc >= q * n) return (b + 1) / k; }
    return mx;
  }

  /** Lowest/highest terrain height (cached per heights version). */
  private terrainRange(): [number, number] {
    const w = this.game.world;
    if (this.heightVer !== w.heightsVersion) {
      this.heightVer = w.heightsVersion;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < w.h.length; i++) { const v = w.h[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      this.heightRange = [mn, mx];
    }
    return this.heightRange;
  }

  // ------------------------------------------------------------------ picking

  private setRay(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = this.tmpV2.set(((clientX - rect.left) / Math.max(1, rect.width)) * 2 - 1, -((clientY - rect.top) / Math.max(1, rect.height)) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(ndc, this.camera);
  }

  /** Exact intersection of the view ray with the terrain / water surface (null outside the map). */
  pickGround(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.game) return null;
    this.setRay(clientX, clientY);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const out = new THREE.Vector3();
    return raycastTerrain(this.game.world, o, d, this.terrainRange()[1], out) ? out : null;
  }

  /** Intersection of the view ray with the horizontal plane y (works beyond the map edge). */
  pickPlane(clientX: number, clientY: number, y = 0): THREE.Vector3 | null {
    this.setRay(clientX, clientY);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    if (Math.abs(d.y) < 1e-9) return null;
    const t = (y - o.y) / d.y;
    return t > 0 ? new THREE.Vector3(o.x + d.x * t, y, o.z + d.z * t) : null;
  }

  pickVehicle(clientX: number, clientY: number): number | null {
    if (!this.game) return null;
    this.setRay(clientX, clientY);
    return this.vehicles.pick(this.raycaster);
  }

  // ------------------------------------------------------------------ lighting

  private updateLighting() {
    const g = this.game;
    const t = this.settings.dayNight ? g.visualTime : 0.37;
    // sun elevation: noon at t=0.5, sunrise 0.25, sunset 0.75
    const elev = Math.sin((t - 0.25) * Math.PI * 2) * 1.05;
    const az = (t - 0.5) * Math.PI * 1.6 + 2.4;
    const sunEl = Math.max(elev, -0.35);
    this.sunDir.set(Math.cos(sunEl) * Math.sin(az), Math.sin(sunEl), Math.cos(sunEl) * Math.cos(az)).normalize();
    const day = THREE.MathUtils.smoothstep(elev, -0.06, 0.2);
    this.night = 1 - THREE.MathUtils.smoothstep(elev, -0.2, 0.05);
    this.light = 0.2 + 0.8 * day;
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const warm = 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.5);
    // moon opposite the sun: takes over the directional light (and its shadows) once the sun has set;
    // both intensities are zero at the switch so there is no visible jump
    const moon = 1 - THREE.MathUtils.smoothstep(elev, -0.3, -0.06);
    if (elev > -0.06) {
      this.lightDir.copy(this.sunDir);
      // warm key light (warmer still at low sun)
      this.sun.color.setRGB(1, 0.93 - warm * 0.25, 0.82 - warm * 0.42);
      this.sun.intensity = 3.25 * day;
    } else {
      this.moonDir.set(-this.sunDir.x * 0.6, Math.max(0.25, -this.sunDir.y), -this.sunDir.z * 0.6 + 0.3).normalize();
      this.lightDir.copy(this.moonDir);
      this.sun.color.setRGB(0.62, 0.72, 1.0);
      this.sun.intensity = 0.9 * moon;
    }
    // sky light: neutral by day (less blue on shaded slopes), moonlit blue at night; the night stays
    // readable (moonlit grass ~0.3, rock ~0.27, asphalt ~0.1 in sRGB) while windows and lamps stand out
    // cool sky fill from above, warm bounce from the ground
    this.hemi.intensity = 0.9 + 0.05 * day;
    this.hemi.color.setRGB(0.27 + 0.43 * day, 0.37 + 0.45 * day, 0.72 + 0.28 * day);
    this.hemi.groundColor.setRGB(0.1 + 0.32 * day, 0.1 + 0.27 * day, 0.13 + 0.15 * day);
    this.renderer.toneMappingExposure = 0.92 + 0.52 * this.night;
    const fog = this.scene.fog as THREE.Fog;
    const horizon = this.horizon.setRGB(0.72 * day + 0.04, 0.8 * day + 0.06, 0.9 * day + 0.12);
    horizon.lerp(WARM, warm * day * 0.35).lerp(NIGHT_FOG, this.night * 0.6);
    fog.color.copy(horizon);
    this.scene.environmentIntensity = 0.12 + 0.55 * day;
    cloudUniforms.uCloudStrength.value = this.settings.clouds ? 0.5 * day : 0;
    // environment map from the sky (regenerated when the sun moves)
    if (this.sunDir.distanceTo(this.lastEnvSun) > 0.03) {
      this.lastEnvSun.copy(this.sunDir);
      this.envSky.material.uniforms.sunPosition.value.copy(this.sunDir);
      const rt = this.pmrem.fromScene(this.envScene as unknown as THREE.Scene, 0, 0.1, 200);
      if (this.envRT) this.envRT.dispose();
      this.envRT = rt;
      this.scene.environment = rt.texture;
    }
    const wm = this.terrain.waterMat.uniforms;
    wm.uSunDir.value.copy(this.lightDir);
    wm.uSunColor.value.copy(this.sun.color).multiplyScalar(elev > -0.06 ? day : moon * 0.5);
    wm.uSkyColor.value.setRGB(0.25 * day + 0.02, 0.45 * day + 0.03, 0.8 * day + 0.07);
    wm.uHorizon.value.copy(horizon);
    wm.uLight.value = this.light;
  }

  /**
   * Shadow cascades fitted to the visible ground in light space: on high quality a near cascade (the view up
   * to a distance-scaled split: sharp shadows close to the camera) and a far cascade (the whole footprint up
   * to the shadow distance), blended by view distance in the shared lights chunk; on low quality one map.
   * Extents are quantised and centres snapped to whole texels (no shimmer); biases scale with the texel size.
   * Returns false when nothing changed (the shadow maps can be reused).
   */
  private updateShadow(dist: number): boolean {
    const maxD = Math.max(30, Math.min(360, dist * 2.2 + 20));
    this.shadowReach = maxD;
    const L = this.lightDir;
    const lx = this.lx.set(0, 1, 0).cross(L);
    if (lx.lengthSq() < 1e-8) lx.set(1, 0, 0);
    lx.normalize();
    this.ly.crossVectors(L, lx);
    if (!this.sunFar.castShadow) {
      shadowFadeUniforms.uCascade.value.set(1e5, 2e5);
      this.terrain.exactShadowCamera = null;
      return this.fitShadow(this.sun, this.shadowKey, maxD, true);
    }
    const split = Math.max(10, Math.min(110, dist * 0.9 + 6));
    shadowFadeUniforms.uCascade.value.set(split * 0.78, split * 0.98);
    // the near cascade gets exact (full resolution) terrain casters
    this.terrain.exactShadowCamera = this.sun.shadow.camera;
    const a = this.fitShadow(this.sun, this.shadowKey, split, false);
    const b = this.fitShadow(this.sunFar, this.shadowKeyFar, maxD, true);
    if (b) this.sunFar.shadow.needsUpdate = true;
    return a || b;
  }

  /** Fit one shadow camera to the view frustum up to `reach` (ground slab clipped), see updateShadow. */
  private fitShadow(light: THREE.DirectionalLight, key: Float64Array, reach: number, outer: boolean): boolean {
    const sh = light.shadow, cam = this.camera, L = this.lightDir, lx = this.lx, ly = this.ly;
    const gY = this.focusV.y - 2;
    const b = this.sb;
    b[0] = b[2] = b[4] = Infinity; b[1] = b[3] = b[5] = -Infinity;
    const o = cam.position;
    // corner, edge-centre and centre rays (the inner cascade is bounded by a sphere: include its cap)
    const rays = outer ? 4 : 9;
    for (let i = 0; i < rays; i++) {
      const sx = i < 4 ? (i & 1 ? 1 : -1) : i === 4 ? 0 : i === 5 ? 1 : i === 6 ? -1 : 0;
      const sy = i < 4 ? (i & 2 ? 1 : -1) : i === 4 ? 0 : i < 7 ? 0 : i === 7 ? 1 : -1;
      const d = this.v1.set(sx, sy, 0.5).unproject(cam).sub(o).normalize();
      let t = reach;
      if (d.y < -1e-4) t = Math.min(reach, Math.max(0, (gY - o.y) / d.y));
      this.addLS(this.v2.copy(o).addScaledVector(d, Math.min(t, cam.near * 2)));
      this.addLS(this.v2.copy(o).addScaledVector(d, t));
    }
    if (outer) this.addLS(this.focusV);
    let half = Math.max(b[1] - b[0], b[3] - b[2]) / 2 + 1.5;
    let mx = (b[0] + b[1]) / 2, my = (b[2] + b[3]) / 2;
    if (outer) this.shadowNeed = half;
    // very wide views: shadows only around the focus (keeps texels useful and the caster count down)
    if (half > SHADOW_MAX) { half = SHADOW_MAX; mx = this.focusV.dot(lx); my = this.focusV.dot(ly); }
    // quantise the extent (~9% steps) and snap the centre to texels
    const S = Math.pow(2, Math.ceil(Math.log2(Math.max(4, half)) * 8) / 8);
    const texel = (2 * S) / sh.mapSize.x;
    const cx = Math.round(mx / texel) * texel, cy = Math.round(my / texel) * texel;
    // depth: reach far towards the light for mountains and tall buildings casting into view
    const zc = Math.round((b[5] + 150) / 4) * 4, far = Math.ceil((zc - b[4] + 4) / 4) * 4;
    const k = key;
    // The far map tolerates two texels of motion and ~0.1 degrees of sun drift. Compare against the
    // last fitted view so small changes accumulate, and keep its light transform until it is refreshed.
    const farCascade = light === this.sunFar;
    const tolerance = farCascade ? texel * 2 : 0;
    const sameSun = farCascade ? Math.hypot(k[5] - L.x, k[6] - L.y, k[7] - L.z) < 0.002 : k[5] === L.x && k[6] === L.y && k[7] === L.z;
    if (k[0] === S && Math.abs(k[1] - cx) <= tolerance && Math.abs(k[2] - cy) <= tolerance && k[3] === zc && k[4] === far && sameSun && k[8] === sh.mapSize.x) return false;
    k[0] = S; k[1] = cx; k[2] = cy; k[3] = zc; k[4] = far; k[5] = L.x; k[6] = L.y; k[7] = L.z; k[8] = sh.mapSize.x;
    const sc = sh.camera;
    sc.left = -S; sc.right = S; sc.top = S; sc.bottom = -S;
    sc.near = 1; sc.far = far;
    sc.updateProjectionMatrix();
    const center = this.v3.copy(lx).multiplyScalar(cx).addScaledVector(ly, cy).addScaledVector(L, zc - 150);
    light.target.position.copy(center);
    light.position.copy(center).addScaledVector(L, 150);
    light.target.updateMatrixWorld();
    light.updateMatrixWorld();
    // receiver offset along the normal ~1.6 texels; small depth bias in normalised depth units
    sh.normalBias = texel * 1.6;
    sh.bias = -(texel * 0.6) / (far - 1);
    return true;
  }

  /** Grow the light-space bounds (x, y across the light, z towards it) by a point. */
  private addLS(p: THREE.Vector3) {
    const b = this.sb;
    const a = p.dot(this.lx), c = p.dot(this.ly), z = p.dot(this.lightDir);
    if (a < b[0]) b[0] = a; if (a > b[1]) b[1] = a; if (c < b[2]) b[2] = c; if (c > b[3]) b[3] = c; if (z < b[4]) b[4] = z; if (z > b[5]) b[5] = z;
  }

  // ------------------------------------------------------------------ frame

  frame(dt: number) {
    if (!this.game) return;
    // a change in capped DPR invalidates evidence before the new drawing-buffer density is applied
    if (this.maxPR() !== this.effectiveDPR) { this.resetAuto(); this.sizeDirty = true; }
    // (also a pixel ratio that changed without a resize event: window moved to another display, browser zoom)
    if (this.sizeDirty || this.targetPR() !== this.appliedPR) this.resize();
    const t0 = performance.now();
    this.frameStarts[this.frameStartN++ & 63] = t0 - this.simMs;
    const interval = this.lastFrameT ? t0 - this.lastFrameT : 16.7;
    this.lastFrameT = t0;
    if (interval > 0 && interval < 250) this.frameMs = this.frameMs * 0.9 + interval * 0.1;
    this.time += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }
    const g = this.game;
    const info = this.renderer.info;
    info.reset();
    this.gpu?.poll();
    this.controls.update(dt);
    // point sprites are sized in drawing-buffer pixels; LOD choices use the resolution-independent scale
    const dbh = this.renderer.getDrawingBufferSize(this.tmpV2).y;
    const pointScale = dbh / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    const lodScale = this.lodScale;
    const focus = this.controls.focusInto(this.focusV);
    const dist = this.controls.smoothDistance;
    const cam = this.camera;
    // fog and clip planes scale with the zoom (depth precision from 15 m close-ups to the whole map)
    const fog = this.scene.fog as THREE.Fog;
    fog.near = 40 + dist * 1.6;
    fog.far = 300 + dist * 4.5;
    const above = Math.max(0.05, cam.position.y - Math.max(g.world.heightAt(cam.position.x, cam.position.z), 0));
    cam.near = Math.max(0.01, Math.min(dist * 0.012, above * 0.5, 8));
    cam.far = fog.far * 1.05;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    const dirtyO = g.world.dirtyObj.size;
    const dirtyT = this.terrain.update(cam, lodScale);
    this.objects.update(6);
    this.updateLighting();
    this.mats.update(this.time, this.night);
    this.objects.animate(dt, this.night, cam);
    const sp = Math.max(1, g.speed * (g.paused ? 0 : 1));
    cloudUniforms.uCloudOffset.value.x += dt * 0.0105 * sp;
    cloudUniforms.uCloudOffset.value.y += dt * 0.006 * sp;
    this.terrain.uniforms.uTime.value = this.time;
    this.terrain.waterMat.uniforms.uTime.value = this.time;
    this.overlay.update(dt, cam);
    this.vehicles.update(g, dt, this.light, pointScale, cam, lodScale);
    // shadow map: re-render only when something can have changed
    const sm = this.renderer.shadowMap;
    sm.needsUpdate = false;
    if (this.settings.shadows && this.sun.intensity > 0.01) {
      const moved = this.updateShadow(dist);
      if (this.sunFar.castShadow && (dirtyT || dirtyO)) this.sunFar.shadow.needsUpdate = true;
      const camMoved = !this.lastCamM.equals(cam.matrixWorld);
      this.lastCamM.copy(cam.matrixWorld);
      this.shadowTimer -= dt;
      this.shadowFrame++;
      this.farAge += dt;
      // received shadows fade out with view distance before the footprint ends and towards the edge of a
      // clamped box (no hard line or square); zoomed far out they fade away and the shadow pass is skipped
      shadowFadeUniforms.uShadowDist.value.set(this.shadowReach * 0.72, this.shadowReach * 0.95);
      shadowFadeUniforms.uShadowEdge.value = Math.max(0, Math.min(1, (this.shadowNeed / SHADOW_MAX - 1) * 4));
      const fade = 1 - THREE.MathUtils.smoothstep(dist, 420, 820);
      this.shadowFade += (fade - this.shadowFade) * Math.min(1, dt * 4);
      if (Math.abs(this.shadowFade - fade) < 0.005) this.shadowFade = fade;
      this.sun.shadow.intensity = this.shadowFade;
      this.sunFar.shadow.intensity = this.shadowFade;
      // static view: moving vehicles need fresh shadows, at least 30 Hz once they are small on screen: every other
      // frame at 60 fps, every frame once every other frame would fall below 30 Hz (frames over 17.5 ms)
      const outerShadow = this.sunFar.castShadow ? this.sunFar.shadow : this.sun.shadow;
      const tick = !g.paused && (outerShadow.camera.right < 40 || (this.shadowFrame & 1) === 0 || this.frameMs > 17.5);
      // vehicles moving in the far cascade: its map is the expensive one, refreshed for them at 10 Hz (5 Hz while the
      // automatic resolution is cutting pixels) instead of only when the view or the world changes
      if (this.sunFar.castShadow && !g.paused && this.vehicles.instances > 0 && this.farAge >= FAR_SHADOW_EVERY * (this.resStep > 0 ? 2 : 1)) this.sunFar.shadow.needsUpdate = true;
      const want = moved || camMoved || dirtyT || dirtyO || tick || this.shadowTimer <= 0 || (this.sunFar.castShadow && this.sunFar.shadow.needsUpdate);
      if (this.shadowFade < 0.01) { if (want) this.shadowStale = true; }
      else if (want || this.shadowStale) {
        if (this.shadowStale && this.sunFar.castShadow) this.sunFar.shadow.needsUpdate = true;
        if (this.sunFar.shadow.needsUpdate) this.farAge = 0;
        sm.needsUpdate = true; this.shadowTimer = 0.5; this.shadowStale = false;
      }
    }
    // (castShadow stays constant: toggling it would switch every material's shader variant)
    this.sky.position.copy(cam.position);
    const useAO = this.settings.ao && !this.aoSuspended;
    this.gpu?.begin();
    const P = this.post ?? this.setupPost();
    const rr = this.renderer;
    rr.setRenderTarget(P.scene);
    rr.render(this.scene, cam);
    let src = P.scene;
    if (useAO) {
      // contact shadows only: the radius grows a little with distance but stays small (no dark blotches)
      const rad = Math.round(Math.max(0.08, Math.min(0.3, 0.06 + dist * 0.0018)) * 50) / 50;
      if (rad !== this.gtaoRadius) { this.gtaoRadius = rad; P.gtao.updateGtaoMaterial({ radius: rad }); }
      P.gtao.render(rr, P.ao, P.scene, dt, false);
      src = P.ao;
    }
    const gu = P.grade.uniforms;
    gu.tDiffuse.value = src.texture;
    gu.uExposure.value = rr.toneMappingExposure;
    rr.setRenderTarget(P.ldr);
    P.quad.render(rr);
    // SMAA; the cheaper FXAA while dynamic resolution is cutting pixels or on low quality
    if (this.resScale < 0.8 || this.settings.shadowQuality === 'low') P.fxaa.render(rr, P.ao, P.ldr, dt, false);
    else P.smaa.render(rr, P.ao, P.ldr, dt, false);
    rr.setRenderTarget(null);
    this.gpu?.end();
    this.stats.calls = info.render.calls;
    this.stats.tris = info.render.triangles;
    this.labels.update(g, cam, this.container.clientWidth, this.container.clientHeight, dist);
    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - t0) * 0.1;
    if (this.probe && this.probeT < 0 && this.settings.resolution === 'auto' && !document.hidden && !g.paused && (++this.probeN & 3) === 0) {
      this.probeT = performance.now();
      this.probe.port2.postMessage(0);
    }
    this.autoResolution(dt, interval);
    if (this.settings.debug) this.updateDebug(dt);
    void focus;
  }

  /**
   * Dynamic resolution: hold ~60 fps by stepping the drawing buffer through AUTO_STEPS, judged per window of ~1 s.
   * A step down goes straight to the step predicted to fit: from the GPU time while a GPU timer delivers fresh
   * samples that explain the frame times, otherwise from the frame interval (the step that would save one display
   * period if the cost is in the pixels; only while the main thread is not the bottleneck). Every step down is
   * checked against fresh measurements and undone when it did not help (further descents wait, longer each time);
   * every step up is watched against the frame interval before it and undone when it slowed the frames (the next
   * try waits longer). Whatever this decides, changes are rate-limited (RES_GAP, RES_PER_MIN, RES_COOL) and an
   * ambiguous case keeps the current step. A new size is applied at the start of the next frame (sizeDirty).
   * Known limits: timed CPU recovery can hold 72% instead of 85%; nonlinear GPU cost can falsely vindicate a timer.
   */
  private autoResolution(dt: number, interval: number) {
    if (this.settings.resolution !== 'auto') return;
    this.dynAcc += dt; this.dynN++;
    this.dynSum += this.gpu ? this.gpu.ms : 0;
    this.dynCpu += Math.max(this.cpuMs + this.simMs + this.postMs, this.loopMs);
    if (this.dynIv.length < 512) this.dynIv.push(interval);
    if (this.dynAcc < 1) return;
    const iv = this.dynIv.sort((a, b) => a - b), med = iv[iv.length >> 1], p80 = iv[Math.floor(iv.length * 0.8)];
    const n = this.dynN, win = this.dynAcc, gpuMs = this.dynSum / n, cpu = (this.dynCpu + this.longMs) / n;
    const fresh = this.gpu ? this.gpu.samples - this.gpuS0 : 0;
    this.dynAcc = 0; this.dynN = 0; this.dynSum = 0; this.dynCpu = 0; this.longMs = 0; iv.length = 0;
    this.gpuS0 = this.gpu ? this.gpu.samples : 0;
    // a window that saw a change (targets reallocated, smoothed timings catching up) is not representative
    if (document.hidden || this.time - this.lastChange < 1.5) return;
    const t = this.time, i = this.resStep, last = AUTO_STEPS.length - 1;
    // a level that held long enough also proves the coarser levels can be trusted again
    if (this.heldLevel === i && t - this.heldSince >= UP_HELD) { this.levelDrops.fill(0, i); this.heldLevel = -1; }
    // the GPU timer is used while it delivers fresh samples and its readings explain slow frames; a timer that
    // under-reports (frames miss 60 fps while neither its time nor the main thread accounts for it) is set aside
    let timed = !!this.gpu && fresh >= Math.max(3, n >> 2) && t >= this.gpuDistrustUntil;
    if (timed && t >= this.gpuVindicatedUntil) {
      this.gpuOdd = med > 18.5 && gpuMs < med * 0.6 && cpu < med * 0.6 ? this.gpuOdd + 1 : 0;
      if (this.gpuOdd >= 2) {
        this.gpuOdd = 0; timed = false;
        this.gpuDistrustUntil = t + this.gpuDistrust;
        this.gpuDistrust = Math.min(480, this.gpuDistrust * 2);
      }
    }
    if (timed !== this.lastTimed) { this.lastTimed = timed; this.slowRun = 0; }
    // the interval the main thread alone would allow (display periods): the GPU only limits the frames beyond it
    const cpuFloor = Math.max(1, Math.ceil((cpu * 1.05) / VSYNC)) * VSYNC, cpuBound = cpuFloor > VSYNC * 1.5;
    // an undone descent is confirmed by the first window back at the old step: clearly slower there than before the
    // descent means the load rose meanwhile (the check was spoiled), so descents may resume at once
    const vf = this.verify;
    this.verify = null;
    if (vf && (!vf.gpu || timed) && (vf.gpu ? gpuMs : med) > vf.before * 1.15) { this.downBlockUntil = 0; this.downBackoff = Math.max(DOWN_BLOCK, this.downBackoff / 2); }
    // nothing changes until the safety net allows it; pending checks and trials wait for that (with fresh evidence)
    const free = t >= this.resCalmUntil && t - (this.resChanges[this.resChanges.length - 1] ?? -1e9) >= RES_GAP &&
      this.resChanges.filter((c) => t - c < 60).length < RES_PER_MIN;
    // reserve room for the trial and its undo at the first allowed time, within the same minute cap
    const trialFree = free && this.resChanges.filter((c) => t + RES_GAP - c < 60).length < RES_PER_MIN - 1;
    // a trial step up is watched for two windows: if it slows the frames (beyond the interval before it, at least
    // below 60 fps) it goes back down and the next try waits longer; a GPU timer that predicted room for it is
    // wrong and set aside for a while
    const tr = this.upTrial;
    if (tr) {
      if (med > Math.max(18.5, tr.before * 1.1)) {
        if (!free) return;
        this.upTrial = null;
        if (timed) { this.gpuDistrustUntil = t + this.gpuDistrust; this.gpuDistrust = Math.min(480, this.gpuDistrust * 2); }
        this.stepTo(tr.from, true);
        return;
      }
      if (--tr.left <= 0) { this.upTrial = null; this.heldLevel = i; this.heldSince = t; }
    }
    // the pending check of the last step down: by the GPU time while the timer stays in use, else by the interval
    const dc = this.downCheck;
    if (dc) {
      const byGpu = timed && dc.gpuBefore > 0;
      const helped = byGpu ? gpuMs <= dc.gpuBefore - 0.4 * (dc.gpuBefore - dc.predicted) : med <= dc.ivBefore * 0.85 || p80 < 17.4;
      if (helped) { this.downCheck = null; this.downBackoff = DOWN_BLOCK; }
      else {
        if (!free) return;
        this.downCheck = null;
        this.undoDescent(dc.origin, byGpu, byGpu ? dc.gpuBefore : dc.ivBefore, timed);
        return;
      }
    }
    // GPU time scales a little less than the pixel count (geometry, fixed passes)
    const at = (j: number) => gpuMs * Math.pow(AUTO_STEPS[j] / AUTO_STEPS[i], 1.7);
    let slow: boolean, up: boolean;
    if (timed) {
      // the GPU budget: 13 ms for 60 fps; with a main-thread bottleneck, up to the interval the main thread allows
      const budget = cpuBound ? Math.max(13, cpuFloor * 0.95) : 13, fit = cpuBound ? Math.max(11, cpuFloor * 0.8) : 11;
      slow = gpuMs > budget;
      if (slow && i < last && t >= this.downBlockUntil) {
        if (!trialFree) return;
        let j = i + 1;
        while (j < last && at(j) > fit) j++;
        this.downCheck = { ivBefore: med, gpuBefore: gpuMs, predicted: at(j), origin: i };
        this.stepTo(j);
        return;
      }
      up = i > 0 && at(i - 1) < (cpuBound ? Math.max(10.5, cpuFloor * 0.8) : 10.5);
    } else {
      const gpuBound = cpu < med * 0.6;
      slow = med > 18.5 && gpuBound;
      this.slowRun = slow ? this.slowRun + 1 : 0;
      if (this.slowRun >= 2 && i < last && t >= this.downBlockUntil) {
        if (!trialFree) return;
        // the step that would save one display period if the cost is in the pixels (vsync quantises the interval:
        // a smaller step could show no gain at all and pass for "not the GPU")
        const f = Math.max(0.3, (med - VSYNC) / med);
        let j = i + 1;
        while (j < last && Math.pow(AUTO_STEPS[j] / AUTO_STEPS[i], 1.7) > f) j++;
        this.downCheck = { ivBefore: med, gpuBefore: 0, predicted: 0, origin: i };
        this.stepTo(j);
        return;
      }
      // room for a trial step up: (nearly) every frame makes the display rate, or the frames are held up elsewhere
      // (main thread, or steps down were just shown not to help) - then a step up costs nothing, judged against the
      // interval before it
      up = i > 0 && (p80 < 17.4 || !gpuBound || t < this.downBlockUntil);
    }
    this.upWait = i > 0 ? Math.min(UP_WAIT_MAX, UP_WAIT * 4 ** this.levelDrops[i - 1]) : UP_WAIT;
    if (!up) this.upHeadroom = 0;
    else if ((this.upHeadroom += win) >= this.upWait && t - this.lastDown >= 8) {
      if (!trialFree) return;
      this.upTrial = { from: i, left: 2, before: med };
      this.stepTo(i - 1);
      return;
    }
    // still too slow at the lowest step: drop ambient occlusion; bring it back after sustained headroom at the
    // full resolution (waiting longer each time it had to be dropped again soon after)
    this.slowAtFloor = slow && i === last ? this.slowAtFloor + win : 0;
    if (this.slowAtFloor >= 2 && this.settings.ao && !this.aoSuspended) {
      this.aoSuspended = true; this.slowAtFloor = 0; this.lastChange = t;
      if (t - this.aoResumedAt < 30) this.aoWait = Math.min(120, this.aoWait * 2);
    }
    if (this.aoSuspended && i === 0 && (timed ? gpuMs < 7 : med < 16.9)) {
      if ((this.aoHeadroom += win) >= this.aoWait) { this.aoSuspended = false; this.aoHeadroom = 0; this.aoResumedAt = t; this.lastChange = t; }
    } else this.aoHeadroom = 0;
  }

  /**
   * A descent that did not help (`gpu`: judged by the GPU time; `before`: the measurement from before it): back to
   * where it started, and no further descent for a while (longer each time) unless the next window shows the load
   * rose. A GPU timer that was set aside (it saw no GPU limit) turned out right: it is used again, for a while.
   */
  private undoDescent(origin: number, gpu: boolean, before: number, timed: boolean) {
    const t = this.time;
    this.downBlockUntil = t + this.downBackoff;
    this.downBackoff = Math.min(DOWN_BLOCK_MAX, this.downBackoff * 2);
    this.verify = { gpu, before };
    if (!timed && this.gpu && t < this.gpuDistrustUntil) {
      this.gpuDistrustUntil = 0; this.gpuDistrust = 30;
      this.gpuVindicatedUntil = t + this.gpuVindicate;
      this.gpuVindicate = Math.min(960, this.gpuVindicate * 2);
    }
    this.stepTo(origin, true);
  }

  /**
   * Change the automatic resolution step. `undo`: reverting the change before (a step down that did not help, a step
   * up that slowed the frames) - not counted as a step up, and followed by RES_COOL seconds without changes.
   */
  private stepTo(j: number, undo = false) {
    j = Math.max(0, Math.min(AUTO_STEPS.length - 1, j));
    const i = this.resStep, t = this.time;
    if (j === i) return;
    if (j > i) {
      // leaving a level downwards: the next step up to it waits longer
      this.levelDrops[i] = Math.min(this.levelDrops[i] + 1, 16);
      this.lastDown = t;
    }
    if (j !== this.heldLevel) this.heldLevel = -1;
    this.resStep = j;
    this.resScale = AUTO_STEPS[j];
    this.lastChange = t;
    this.upHeadroom = 0;
    this.resChanges.push(t);
    if (this.resChanges.length > RES_PER_MIN) this.resChanges.shift();
    if (undo) { this.resCalmUntil = t + RES_COOL; this.heldLevel = j; this.heldSince = t; }
    if (this.targetPR() !== this.appliedPR) this.sizeDirty = true;
  }

  /**
   * Forget the automatic resolution's measurements, trials, checks and back-offs and start again at full resolution
   * (the resolution mode or a setting that changes the cost per pixel changed: nothing learned still holds).
   */
  private resetAuto() {
    this.dynAcc = 0; this.dynN = 0; this.dynSum = 0; this.dynCpu = 0; this.dynIv.length = 0; this.longMs = 0;
    this.gpuS0 = this.gpu ? this.gpu.samples : 0;
    this.effectiveDPR = this.maxPR(); this.aoSuspended = false;
    this.upTrial = null; this.downCheck = null; this.verify = null; this.slowRun = 0; this.upHeadroom = 0; this.slowAtFloor = 0; this.aoHeadroom = 0;
    this.upWait = UP_WAIT; this.levelDrops.fill(0); this.heldLevel = -1; this.downBlockUntil = 0; this.downBackoff = DOWN_BLOCK; this.aoWait = 10;
    this.gpuOdd = 0; this.gpuDistrustUntil = 0; this.gpuDistrust = 30; this.gpuVindicatedUntil = 0; this.gpuVindicate = 60;
    this.lastDown = -1e9; this.resChanges.length = 0; this.resCalmUntil = 0;
    this.lastChange = this.time;
    this.resStep = 0; this.resScale = 1;
  }

  // ------------------------------------------------------------------ debug overlay

  private updateDebugEl() {
    if (this.settings.debug && !this.dbgEl) {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute;left:8px;bottom:8px;z-index:50;pointer-events:none;padding:6px 9px;border-radius:6px;' +
        'background:rgba(10,14,20,0.78);color:#dfe8f0;font:11px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre;';
      this.container.appendChild(el);
      this.dbgEl = el;
      this.dbgTimer = 0;
    } else if (!this.settings.debug && this.dbgEl) { this.dbgEl.remove(); this.dbgEl = null; }
  }

  private updateDebug(dt: number) {
    if (!this.dbgEl) this.updateDebugEl();
    this.dbgTimer -= dt;
    if (this.dbgTimer > 0 || !this.dbgEl) return;
    this.dbgTimer = 0.33;
    const info = this.renderer.info;
    const sh = this.sun.shadow.camera;
    const k = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));
    const res = this.settings.resolution === 'auto' ? `auto ${Math.round(this.resScale * 100)}%` : `${Math.round(Number(this.settings.resolution) * 100)}%`;
    this.dbgEl.textContent =
      `fps ${this.fps.toFixed(0)}   frame ${this.frameMs.toFixed(1)} ms\n` +
      `cpu ${this.cpuMs.toFixed(1)} ms   sim ${this.simMs.toFixed(1)} ms   gpu ${this.gpu && this.gpu.samples ? this.gpu.ms.toFixed(1) + ' ms' : 'n/a'}\n` +
      `draw calls ${this.stats.calls}   tris ${k(this.stats.tris)}\n` +
      `geometries ${info.memory.geometries}   textures ${info.memory.textures}   programs ${info.programs?.length ?? 0}\n` +
      `pixel ratio ${this.renderer.getPixelRatio().toFixed(2)} (${res})   AO ${this.settings.ao ? (this.aoSuspended ? 'auto-off' : 'on') : 'off'}   AA ${this.resScale < 0.8 || this.settings.shadowQuality === 'low' ? 'FXAA' : 'SMAA'} + MSAA ${this.post ? this.post.samples : 0}x   shadows ${this.sunFar.castShadow ? '2 cascades' : this.sun.castShadow ? '1 map' : 'off'}\n` +
      `terrain tris ${k(this.terrain.triangles())}   vehicles ${this.vehicles.instances}\n` +
      `shadow ${this.settings.shadows ? `${this.sun.shadow.mapSize.x}² ±${sh.right.toFixed(0)}` : 'off'}   cam dist ${this.controls.smoothDistance.toFixed(1)}`;
  }
}
