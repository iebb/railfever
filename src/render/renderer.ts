// Scene setup, lighting, sky, shadows, post-processing and frame orchestration (1 unit = 10 m).
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Game } from '../game/game';
import { TerrainView, raycastTerrain } from './terrain';
import { ObjectsView } from './objects';
import { VehiclesView } from './vehicles-view';
import { Overlay } from './overlay';
import { Labels } from './labels';
import { Materials } from './materials';
import { CameraController } from './camera';
import { applyClouds, cloudUniforms } from './clouds';

export interface GraphicsSettings {
  shadows: boolean;
  shadowQuality: 'low' | 'high';
  dayNight: boolean;
  labels: boolean;
  pixelRatio: number;
  ao: boolean;
  clouds: boolean;
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
  settings: GraphicsSettings = { shadows: true, shadowQuality: 'high', dayNight: false, labels: true, pixelRatio: Math.min(window.devicePixelRatio, 2), ao: true, clouds: true };
  private composer: EffectComposer | null = null;
  private gtao: GTAOPass | null = null;
  private gtaoRadius = 0;
  private pmrem: THREE.PMREMGenerator;
  private envScene = new THREE.Scene();
  private envSky: Sky;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private lastEnvSun = new THREE.Vector3(0, -1, 0);
  private worldGroup = new THREE.Group();
  private time = 0;
  sunDir = new THREE.Vector3();
  night = 0;
  light = 1;
  private raycaster = new THREE.Raycaster();
  private tmpV2 = new THREE.Vector2();
  private horizon = new THREE.Color();
  private heightRange: [number, number] = [0, 0];
  private heightVer = -1;
  private shadowS = 0;
  fps = 60;
  private fpsAcc = 0; private fpsN = 0;

  constructor(public container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.renderer.setSize(container.clientWidth, container.clientHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.className = 'gl';

    this.camera = new THREE.PerspectiveCamera(38, Math.max(1, container.clientWidth) / Math.max(1, container.clientHeight), 0.05, 3000);

    this.sky = new Sky();
    this.sky.scale.setScalar(40000);
    this.sky.frustumCulled = false;
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
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.sun, this.sun.target);
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
    // snow line relative to the highest terrain
    this.heightVer = -1;
    const [, maxH] = this.terrainRange();
    this.terrain.uniforms.uSnow.value = Math.max(16, maxH * 0.72);
  }

  resize() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }
  }

  private setupComposer() {
    const w = Math.max(1, this.container.clientWidth), h = Math.max(1, this.container.clientHeight);
    const pr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const gtao = new GTAOPass(this.scene, this.camera, w, h);
    // compute AO at reduced resolution for speed
    const origSetSize = gtao.setSize.bind(gtao);
    gtao.setSize = (sw: number, sh: number) => origSetSize(Math.max(1, Math.round(sw * 0.6)), Math.max(1, Math.round(sh * 0.6)));
    gtao.updateGtaoMaterial({ radius: 0.4, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
    gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    gtao.blendIntensity = 0.85;
    composer.addPass(gtao);
    composer.addPass(new OutputPass());
    composer.setPixelRatio(pr);
    composer.setSize(w, h);
    this.composer = composer;
    this.gtao = gtao;
  }

  loadSettings() {
    try {
      const raw = localStorage.getItem('railfever.settings');
      if (raw) Object.assign(this.settings, JSON.parse(raw));
    } catch { /* ignore */ }
    this.applySettings();
  }

  applySettings() {
    try { localStorage.setItem('railfever.settings', JSON.stringify(this.settings)); } catch { /* ignore */ }
    this.renderer.setPixelRatio(this.settings.pixelRatio);
    this.resize();
    this.sun.castShadow = this.settings.shadows;
    const s = this.settings.shadowQuality === 'high' ? 4096 : 2048;
    if (this.sun.shadow.mapSize.x !== s) {
      this.sun.shadow.mapSize.set(s, s);
      this.sun.shadow.map?.dispose();
      (this.sun.shadow as unknown as { map: unknown }).map = null;
      this.shadowS = 0;
    }
    this.labels.visible = this.settings.labels;
    if (this.settings.ao && !this.composer) this.setupComposer();
  }

  /** Lowest/highest terrain height (cached per heights version). */
  private terrainRange(): [number, number] {
    const w = this.game.world;
    if (this.heightVer !== w.heightsVersion || !this.terrain) {
      this.heightVer = w.heightsVersion;
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < w.h.length; i++) { const v = w.h[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      this.heightRange = [mn, mx];
    }
    return this.heightRange;
  }

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

  private updateLighting() {
    const g = this.game;
    const t = this.settings.dayNight ? g.visualTime : 0.37;
    // sun elevation: noon at t=0.5, sunrise 0.25, sunset 0.75
    const elev = Math.sin((t - 0.25) * Math.PI * 2) * 1.05;
    const az = (t - 0.5) * Math.PI * 1.6 + 2.4;
    const sunEl = Math.max(elev, -0.35);
    this.sunDir.set(Math.cos(sunEl) * Math.sin(az), Math.sin(sunEl), Math.cos(sunEl) * Math.cos(az)).normalize();
    const day = THREE.MathUtils.smoothstep(elev, -0.12, 0.18);
    this.night = 1 - THREE.MathUtils.smoothstep(elev, -0.2, 0.05);
    this.light = 0.18 + 0.82 * day;
    this.sky.material.uniforms.sunPosition.value.copy(this.sunDir);
    const warm = 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.5);
    this.sun.color.setRGB(1, 0.94 - warm * 0.25, 0.86 - warm * 0.45);
    this.sun.intensity = 3.1 * day;
    this.hemi.intensity = 0.42 + 0.58 * day;
    this.hemi.color.setRGB(0.45 + 0.3 * day, 0.6 + 0.25 * day, 1.0);
    this.hemi.groundColor.setRGB(0.25 + 0.1 * day, 0.24 + 0.09 * day, 0.2 + 0.05 * day);
    this.renderer.toneMappingExposure = 0.88 + 0.25 * this.night;
    const fog = this.scene.fog as THREE.Fog;
    const horizon = this.horizon.setRGB(0.72 * day + 0.04, 0.8 * day + 0.06, 0.9 * day + 0.12);
    horizon.lerp(new THREE.Color(0.95, 0.65, 0.45), warm * day * 0.35);
    fog.color.copy(horizon);
    this.scene.environmentIntensity = 0.25 + 0.45 * day;
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
    wm.uSunDir.value.copy(this.sunDir);
    wm.uSunColor.value.copy(this.sun.color).multiplyScalar(day);
    wm.uSkyColor.value.setRGB(0.25 * day + 0.02, 0.45 * day + 0.03, 0.8 * day + 0.08);
    wm.uHorizon.value.copy(horizon);
    wm.uLight.value = this.light;
  }

  /** Shadow frustum around the focus, sized by the zoom, snapped to shadow-map texels in light space. */
  private updateShadow(focus: THREE.Vector3, dist: number) {
    const sh = this.sun.shadow;
    // quantised extent avoids re-rasterising the shadow grid on every zoom step
    const want = Math.max(6, Math.min(450, dist * 1.15));
    const S = 6 * Math.pow(1.25, Math.ceil(Math.log(want / 6) / Math.log(1.25)));
    const D = S + 200;
    const cam = sh.camera;
    if (S !== this.shadowS) {
      this.shadowS = S;
      cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
      cam.near = 1; cam.far = D * 2;
      cam.updateProjectionMatrix();
    }
    const texel = (2 * S) / sh.mapSize.x;
    sh.normalBias = texel * 1.6;
    sh.bias = -0.00004 - texel * 0.00002;
    // light-space basis (same as the shadow camera's lookAt with up = +y)
    const z = this.sunDir;
    const x = new THREE.Vector3(0, 1, 0).cross(z);
    if (x.lengthSq() < 1e-8) x.set(1, 0, 0);
    x.normalize();
    const y = new THREE.Vector3().crossVectors(z, x);
    const fx = Math.round(focus.dot(x) / texel) * texel, fy = Math.round(focus.dot(y) / texel) * texel, fz = focus.dot(z);
    const p = x.multiplyScalar(fx).add(y.multiplyScalar(fy)).add(z.clone().multiplyScalar(fz));
    this.sun.target.position.copy(p);
    this.sun.position.copy(p).addScaledVector(z, D);
    this.sun.target.updateMatrixWorld();
  }

  frame(dt: number) {
    if (!this.game) return;
    this.time += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }
    const g = this.game;
    this.controls.update(dt);
    this.terrain.update();
    this.objects.update(6);
    this.updateLighting();
    this.mats.update(this.time, this.night);
    this.objects.animate(dt, this.night);
    const sp = Math.max(1, g.speed * (g.paused ? 0 : 1));
    cloudUniforms.uCloudOffset.value.x += dt * 0.0105 * sp;
    cloudUniforms.uCloudOffset.value.y += dt * 0.006 * sp;
    this.terrain.uniforms.uTime.value = this.time;
    this.terrain.waterMat.uniforms.uTime.value = this.time;
    this.overlay.update(dt, this.camera);
    const dbh = this.renderer.getDrawingBufferSize(this.tmpV2).y;
    const pointScale = dbh / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
    this.vehicles.update(g, dt, this.light, pointScale);
    const focus = this.controls.focus;
    const dist = this.controls.smoothDistance;
    if (this.settings.shadows) this.updateShadow(focus, dist);
    // fog and clip planes scale with the zoom (depth precision from 15 m close-ups to the whole map)
    const fog = this.scene.fog as THREE.Fog;
    fog.near = 40 + dist * 1.6;
    fog.far = 300 + dist * 4.5;
    const cam = this.camera;
    const above = Math.max(0.05, cam.position.y - Math.max(g.world.heightAt(cam.position.x, cam.position.z), 0));
    cam.near = Math.max(0.01, Math.min(dist * 0.012, above * 0.5, 8));
    cam.far = fog.far * 1.05;
    cam.updateProjectionMatrix();
    this.sky.position.copy(cam.position);
    if (this.settings.ao) {
      if (!this.composer) this.setupComposer();
      const r = Math.round(Math.max(0.12, Math.min(3, 0.1 + dist * 0.012)) * 50) / 50;
      if (this.gtao && r !== this.gtaoRadius) { this.gtaoRadius = r; this.gtao.updateGtaoMaterial({ radius: r }); }
      this.composer!.render(dt);
    } else this.renderer.render(this.scene, cam);
    this.labels.update(g, cam, this.container.clientWidth, this.container.clientHeight, dist);
  }
}
