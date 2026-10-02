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
  private dynAcc = 0; private dynN = 0; private dynSum = 0; private dynCpu = 0;
  private dynHold = 0; private dynProbeFail = 0; private lastScaleUp = 0;
  private appliedPR = 0;
  // shadows
  private shadowKey = new Float64Array(9);
  private shadowKeyFar = new Float64Array(9);
  private sunFar: THREE.DirectionalLight;
  private sb = new Float64Array(6);
  private shadowTimer = 0;
  private shadowFrame = 0;
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
    this.sunFar.shadow.camera.matrixAutoUpdate = true;
    this.scene.add(this.sunFar, this.sunFar.target);
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x5a5440, 0.9);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.Fog(0xc9d8e8, 200, 900);
    this.scene.add(this.worldGroup);

    this.vehicles = new VehiclesView(this.mats);
    this.labels = new Labels(container);
    const extra = (this.mats as unknown as { extra?: THREE.Material[] }).extra ?? [];
    for (const m of [this.mats.matte, this.mats.metal, this.mats.facade, this.mats.tree, this.mats.body, ...extra]) applyClouds(m);

    this.controls = new CameraController(this.camera, this.renderer.domElement, null, (x, y) => this.pickGround(x, y));
    window.addEventListener('resize', () => this.resize());
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
  }

  // ------------------------------------------------------------------ resolution / settings

  /** Device pixel ratio cap from the settings. */
  private maxPR() { return Math.max(0.5, Math.min(window.devicePixelRatio || 1, this.settings.pixelRatio || 1.5)); }

  private targetPR() {
    const r = this.settings.resolution;
    const k = r === 'auto' ? this.resScale : typeof r === 'number' ? r : 1;
    // quantised so small corrections don't reallocate render targets
    return Math.max(0.35, Math.round(this.maxPR() * k * 16) / 16);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
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
    if (this.settings.resolution !== 'auto') this.resScale = 1;
    this.resize();
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
    if (this.settings.ao) this.aoSuspended = false;
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
    this.sunFar.position.copy(this.sun.position);
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
    if (k[0] === S && k[1] === cx && k[2] === cy && k[3] === zc && k[4] === far && k[5] === L.x && k[6] === L.y && k[7] === L.z && k[8] === sh.mapSize.x) return false;
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
    const t0 = performance.now();
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
    const dbh = this.renderer.getDrawingBufferSize(this.tmpV2).y;
    const pointScale = dbh / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
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
    const dirtyT = g.world.dirtyTerrain.size, dirtyO = g.world.dirtyObj.size;
    this.terrain.update(cam, pointScale);
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
    this.vehicles.update(g, dt, this.light, pointScale, cam);
    // shadow map: re-render only when something can have changed
    const sm = this.renderer.shadowMap;
    sm.needsUpdate = false;
    if (this.settings.shadows && this.sun.intensity > 0.01) {
      const moved = this.updateShadow(dist);
      const camMoved = !this.lastCamM.equals(cam.matrixWorld);
      this.lastCamM.copy(cam.matrixWorld);
      this.shadowTimer -= dt;
      this.shadowFrame++;
      // received shadows fade out with view distance before the footprint ends and towards the edge of a
      // clamped box (no hard line or square); zoomed far out they fade away and the shadow pass is skipped
      shadowFadeUniforms.uShadowDist.value.set(this.shadowReach * 0.72, this.shadowReach * 0.95);
      shadowFadeUniforms.uShadowEdge.value = Math.max(0, Math.min(1, (this.shadowNeed / SHADOW_MAX - 1) * 4));
      const fade = 1 - THREE.MathUtils.smoothstep(dist, 420, 820);
      this.shadowFade += (fade - this.shadowFade) * Math.min(1, dt * 4);
      if (Math.abs(this.shadowFade - fade) < 0.005) this.shadowFade = fade;
      this.sun.shadow.intensity = this.shadowFade;
      this.sunFar.shadow.intensity = this.shadowFade;
      // static view: moving vehicles need fresh shadows, at 30 Hz once they are small on screen
      const tick = !g.paused && (this.sun.shadow.camera.right < 40 || (this.shadowFrame & 1) === 0);
      const want = moved || camMoved || dirtyT || dirtyO || tick || this.shadowTimer <= 0;
      if (this.shadowFade < 0.01) { if (want) this.shadowStale = true; }
      else if (want || this.shadowStale) { sm.needsUpdate = true; this.shadowTimer = 0.5; this.shadowStale = false; }
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
    this.autoResolution(dt);
    if (this.settings.debug) this.updateDebug(dt);
    void focus;
  }

  /**
   * Dynamic resolution: hold ~60 fps by scaling the drawing buffer. Uses GPU timer queries when the
   * browser exposes them, otherwise the frame interval (only when the CPU is not the bottleneck).
   */
  private autoResolution(dt: number) {
    if (this.settings.resolution !== 'auto') return;
    this.dynAcc += dt; this.dynN++;
    this.dynSum += this.gpu && this.gpu.samples > 10 ? this.gpu.ms : this.frameMs;
    this.dynCpu += this.cpuMs + this.simMs;
    this.dynHold -= dt;
    if (this.dynAcc < 0.75) return;
    const avg = this.dynSum / this.dynN, cpu = this.dynCpu / this.dynN;
    this.dynAcc = 0; this.dynN = 0; this.dynSum = 0; this.dynCpu = 0;
    if (this.dynHold > 0 || document.hidden) return;
    const gpuTimed = !!this.gpu && this.gpu.samples > 10;
    let k = this.resScale;
    if (gpuTimed) {
      if (avg > 13) k *= Math.max(0.8, Math.sqrt(11 / avg));
      else if (avg < 8.5) k *= Math.min(1.12, Math.sqrt(10.5 / avg));
    } else {
      const gpuBound = cpu < avg * 0.6;
      if (avg > 18.5 && gpuBound) k *= 0.88;
      else if (avg < 17.4 && this.time - this.lastScaleUp > 4 + this.dynProbeFail * 6) { k *= 1.08; this.lastScaleUp = this.time; }
      else if (avg > 18.5 && this.time - this.lastScaleUp < 2) this.dynProbeFail = Math.min(5, this.dynProbeFail + 1);
    }
    k = Math.max(0.5, Math.min(1, k));
    // still too slow at the lowest resolution: drop ambient occlusion; bring it back with headroom
    if (k <= 0.5 && (gpuTimed ? avg > 13 : avg > 18.5)) this.aoSuspended = true;
    if (k >= 1 && (gpuTimed ? avg < 7 : avg < 16.9) && this.aoSuspended && this.settings.ao) { this.aoSuspended = false; this.dynHold = 3; }
    if (Math.abs(k - this.resScale) > 0.01) {
      this.resScale = k;
      if (this.targetPR() !== this.appliedPR) { this.resize(); this.dynHold = 1.5; }
    }
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
