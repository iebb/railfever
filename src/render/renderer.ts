// Scene setup, lighting, sky and frame orchestration.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import type { Game } from '../game/game';
import { TerrainView } from './terrain';
import { ObjectsView } from './objects';
import { VehiclesView } from './vehicles-view';
import { Overlay } from './overlay';
import { Labels } from './labels';
import { Materials } from './materials';
import { CameraController } from './camera';
import { HSTEP } from '../game/constants';
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

    this.camera = new THREE.PerspectiveCamera(38, container.clientWidth / container.clientHeight, 0.1, 1500);

    this.sky = new Sky();
    this.sky.scale.setScalar(1200);
    const su = this.sky.material.uniforms;
    su.turbidity.value = 4.5;
    su.rayleigh.value = 1.3;
    su.mieCoefficient.value = 0.004;
    su.mieDirectionalG.value = 0.82;
    this.scene.add(this.sky);
    this.envSky = new Sky();
    this.envSky.scale.setScalar(100);
    Object.assign(this.envSky.material.uniforms.turbidity, { value: 4.5 });
    this.envSky.material.uniforms.rayleigh.value = 1.3;
    this.envSky.material.uniforms.mieCoefficient.value = 0.004;
    this.envSky.material.uniforms.mieDirectionalG.value = 0.82;
    this.envScene.add(this.envSky);
    this.pmrem = new THREE.PMREMGenerator(this.renderer);

    this.sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.00025;
    this.sun.shadow.normalBias = 0.025;
    this.scene.add(this.sun, this.sun.target);
    this.hemi = new THREE.HemisphereLight(0xbdd7ff, 0x5a5440, 0.9);
    this.scene.add(this.hemi);
    this.scene.fog = new THREE.Fog(0xc9d8e8, 80, 400);
    this.scene.add(this.worldGroup);

    this.vehicles = new VehiclesView(this.mats);
    this.labels = new Labels(container);
    for (const m of [this.mats.matte, this.mats.metal, this.mats.facade, this.mats.tree, this.mats.body]) applyClouds(m);

    this.controls = new CameraController(this.camera, this.renderer.domElement, null as any, (x, y) => this.pickGround(x, y));
    window.addEventListener('resize', () => this.resize());
  }

  setGame(game: Game) {
    this.game = game;
    this.worldGroup.clear();
    if (this.terrain) {
      this.terrain.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); });
      this.objects.group.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry && !(o instanceof THREE.InstancedMesh)) m.geometry.dispose(); });
    }
    this.terrain = new TerrainView(game.world);
    applyClouds(this.terrain.material);
    this.objects = new ObjectsView(game.world, this.mats);
    this.objects.buildAll();
    this.overlay = new Overlay(game.world);
    this.vehicles = new VehiclesView(this.mats);
    this.worldGroup.add(this.terrain.group, this.objects.group, this.vehicles.group, this.overlay.group);
    this.labels.clear();
    this.controls.setWorld(game.world);
    // snow line relative to the highest terrain
    let maxH = 0;
    for (let i = 0; i < game.world.hgt.length; i++) maxH = Math.max(maxH, game.world.hgt[i]);
    this.terrain.uniforms.uSnow.value = Math.max(6.5, maxH * HSTEP * 0.72);
  }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) { this.composer.setPixelRatio(this.renderer.getPixelRatio()); this.composer.setSize(w, h); }
  }

  private setupComposer() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const pr = this.renderer.getPixelRatio();
    const rt = new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 });
    const composer = new EffectComposer(this.renderer, rt);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const gtao = new GTAOPass(this.scene, this.camera, w, h);
    // compute AO at reduced resolution for speed
    const origSetSize = gtao.setSize.bind(gtao);
    gtao.setSize = (sw: number, sh: number) => origSetSize(Math.max(1, Math.round(sw * 0.6)), Math.max(1, Math.round(sh * 0.6)));
    gtao.updateGtaoMaterial({ radius: 0.32, distanceExponent: 1.5, thickness: 1.2, scale: 1.0, samples: 12, distanceFallOff: 1.0 });
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
      (this.sun.shadow as any).map = null;
    }
    this.labels.visible = this.settings.labels;
    if (this.settings.ao && !this.composer) this.setupComposer();
  }

  /** Ray-march the heightfield to find the ground point under the cursor. */
  pickGround(clientX: number, clientY: number): THREE.Vector3 | null {
    if (!this.game) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const o = this.raycaster.ray.origin, d = this.raycaster.ray.direction;
    const w = this.game.world;
    const s = w.size;
    let t = 0;
    const maxT = 1200;
    let prevT = 0;
    let step = 0.15;
    for (let i = 0; i < 6000 && t < maxT; i++) {
      const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
      const inside = x >= 0 && z >= 0 && x <= s && z <= s;
      const gh = inside ? Math.max(w.heightAt(x, z), -0.0) : -1.6;
      if (y <= gh) {
        // refine
        let a = prevT, b = t;
        for (let k = 0; k < 12; k++) {
          const m = (a + b) / 2;
          const mx = o.x + d.x * m, my = o.y + d.y * m, mz = o.z + d.z * m;
          const mh = mx >= 0 && mz >= 0 && mx <= s && mz <= s ? Math.max(w.heightAt(mx, mz), 0) : -1.6;
          if (my <= mh) b = m; else a = m;
        }
        const p = new THREE.Vector3(o.x + d.x * b, o.y + d.y * b, o.z + d.z * b);
        if (p.x < 0 || p.z < 0 || p.x >= s || p.z >= s) return null;
        return p;
      }
      prevT = t;
      step = Math.max(0.05, Math.min(1.0, (y - gh) * 0.5));
      t += step;
    }
    return null;
  }

  pickVehicle(clientX: number, clientY: number): number | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
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
    const su = this.sky.material.uniforms;
    su.sunPosition.value.copy(this.sunDir);
    const warm = 1 - THREE.MathUtils.smoothstep(elev, 0.05, 0.5);
    this.sun.color.setRGB(1, 0.94 - warm * 0.25, 0.86 - warm * 0.45);
    this.sun.intensity = 3.1 * day;
    this.hemi.intensity = 0.42 + 0.58 * day;
    this.hemi.color.setRGB(0.45 + 0.3 * day, 0.6 + 0.25 * day, 1.0);
    this.hemi.groundColor.setRGB(0.25 + 0.1 * day, 0.24 + 0.09 * day, 0.2 + 0.05 * day);
    this.renderer.toneMappingExposure = 0.88 + 0.25 * this.night;
    const fog = this.scene.fog as THREE.Fog;
    const horizon = new THREE.Color().setRGB(0.72 * day + 0.04, 0.8 * day + 0.06, 0.9 * day + 0.12);
    horizon.lerp(new THREE.Color(0.95, 0.65, 0.45), warm * day * 0.35);
    fog.color.copy(horizon);
    this.scene.environmentIntensity = 0.25 + 0.45 * day;
    cloudUniforms.uCloudStrength.value = this.settings.clouds ? 0.5 * day : 0;
    // environment map from the sky (regenerated when the sun moves)
    if (this.sunDir.distanceTo(this.lastEnvSun) > 0.03) {
      this.lastEnvSun.copy(this.sunDir);
      this.envSky.material.uniforms.sunPosition.value.copy(this.sunDir);
      const rt = this.pmrem.fromScene(this.envScene as any, 0, 0.1, 200);
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

  frame(dt: number) {
    this.time += dt;
    this.fpsAcc += dt; this.fpsN++;
    if (this.fpsAcc > 0.5) { this.fps = this.fpsN / this.fpsAcc; this.fpsAcc = 0; this.fpsN = 0; }
    const g = this.game;
    this.controls.update(dt);
    this.terrain.update();
    this.objects.update(6);
    this.updateLighting();
    this.mats.update(this.time, this.night);
    cloudUniforms.uCloudOffset.value.x += dt * 0.012 * Math.max(1, this.game.speed * (this.game.paused ? 0 : 1));
    cloudUniforms.uCloudOffset.value.y += dt * 0.007 * Math.max(1, this.game.speed * (this.game.paused ? 0 : 1));
    this.terrain.uniforms.uTime.value = this.time;
    this.terrain.waterMat.uniforms.uTime.value = this.time;
    this.objects.updateSignals(g.vehicles);
    const dbh = this.renderer.getDrawingBufferSize(this.tmpV2).y;
    this.vehicles.update(g, dt, this.light, dbh / (2 * Math.tan((this.camera.fov * Math.PI) / 360)));
    // shadow camera follows the focus
    const focus = this.controls.focus;
    const dist = this.controls.smoothDistance;
    const S = Math.max(10, Math.min(90, dist * 1.25));
    const cam = this.sun.shadow.camera;
    if (cam.right !== S) {
      cam.left = -S; cam.right = S; cam.top = S; cam.bottom = -S;
      cam.near = 1; cam.far = 400;
      cam.updateProjectionMatrix();
    }
    // snap to texel grid to avoid shimmering
    const texel = (2 * S) / this.sun.shadow.mapSize.x;
    const fx = Math.round(focus.x / texel) * texel, fz = Math.round(focus.z / texel) * texel;
    this.sun.target.position.set(fx, focus.y, fz);
    this.sun.position.set(fx + this.sunDir.x * 150, focus.y + this.sunDir.y * 150, fz + this.sunDir.z * 150);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = 60 + dist * 1.5;
    fog.far = 260 + dist * 4;
    this.camera.far = Math.max(600, fog.far * 1.3);
    this.camera.near = Math.max(0.05, dist * 0.004);
    this.camera.updateProjectionMatrix();
    if (this.settings.ao) {
      if (!this.composer) this.setupComposer();
      this.composer!.render(dt);
    } else this.renderer.render(this.scene, this.camera);
    this.labels.update(g, this.camera, this.container.clientWidth, this.container.clientHeight, dist);
  }
}
