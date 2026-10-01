// Renders vehicles and smoke.
import * as THREE from 'three';
import type { Game } from '../game/game';
import { Train } from '../game/train';
import { RoadVehicle } from '../game/roadvehicle';
import { Materials } from './materials';
import { getModel, getCarModel, ModelGeo } from './vehicle-models';
import { createSmokeTexture } from './textures';
import { ROAD_TOP } from '../game/constants';

const RAIL_Y = 0.084;
const GAP = 0.04;

interface CarObj { group: THREE.Group; model: ModelGeo }
interface VObj { sig: string; cars: CarObj[] }

const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
const tmpA = { x: 0, y: 0, z: 0 }, tmpB = { x: 0, y: 0, z: 0 }, tmpC = { x: 0, y: 0, z: 0 };

class Smoke {
  max = 1500;
  pos: Float32Array; vel: Float32Array; life: Float32Array; size: Float32Array; alpha: Float32Array;
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  count = 0;
  constructor() {
    this.pos = new Float32Array(this.max * 3);
    this.vel = new Float32Array(this.max * 3);
    this.life = new Float32Array(this.max);
    this.size = new Float32Array(this.max);
    this.alpha = new Float32Array(this.max);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uTex: { value: createSmokeTexture() }, uScale: { value: 600 * Math.min(window.devicePixelRatio, 2) }, uLight: { value: 1 } },
      transparent: true, depthWrite: false,
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv; gl_PointSize = aSize * uScale / -mv.z; vA = aAlpha; }`,
      fragmentShader: `uniform sampler2D uTex; uniform float uLight; varying float vA;
        void main(){ vec4 t = texture2D(uTex, gl_PointCoord); gl_FragColor = vec4(vec3(0.82, 0.82, 0.84) * uLight, t.a * vA); }`,
    });
    this.points = new THREE.Points(this.geo, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  emit(x: number, y: number, z: number, vx: number, vz: number) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * 0.05;
    this.vel[i * 3 + 1] = 0.28 + Math.random() * 0.12;
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 0.05;
    this.life[i] = 0;
  }
  update(dt: number) {
    let j = 0;
    for (let i = 0; i < this.count; i++) {
      const l = this.life[i] + dt;
      if (l > 2.6) continue;
      this.life[j] = l;
      for (let k = 0; k < 3; k++) this.pos[j * 3 + k] = this.pos[i * 3 + k] + this.vel[i * 3 + k] * dt;
      this.vel[j * 3] = this.vel[i * 3] * (1 - dt * 1.5) + 0.03 * dt;
      this.vel[j * 3 + 1] = this.vel[i * 3 + 1] * (1 - dt * 0.6);
      this.vel[j * 3 + 2] = this.vel[i * 3 + 2] * (1 - dt * 1.5) + 0.02 * dt;
      this.size[j] = 0.1 + l * 0.26;
      this.alpha[j] = Math.min(1, l * 5) * (1 - l / 2.6) * 0.7;
      j++;
    }
    this.count = j;
    this.geo.setDrawRange(0, this.count);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }
}

export class VehiclesView {
  group = new THREE.Group();
  private objs = new Map<number, VObj>();
  private ambBody: THREE.InstancedMesh[] = [];
  private ambGlass: THREE.InstancedMesh[] = [];
  smoke = new Smoke();
  private emitAcc = new Map<number, number>();
  private hlPos = new Float32Array(1200 * 3);
  private hlCount = 0;
  private headlights: THREE.Points;

  constructor(private mats: Materials) {
    for (let s = 0; s < 3; s++) {
      const m = getCarModel(s);
      const b = new THREE.InstancedMesh(m.body, mats.body, 400);
      const g = new THREE.InstancedMesh(m.glass, mats.glass, 400);
      b.count = 0; g.count = 0;
      b.castShadow = true;
      b.frustumCulled = false; g.frustumCulled = false;
      this.ambBody.push(b); this.ambGlass.push(g);
      this.group.add(b, g);
    }
    this.group.add(this.smoke.points);
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(this.hlPos, 3).setUsage(THREE.DynamicDrawUsage));
    this.headlights = new THREE.Points(hg, mats.headlight);
    this.headlights.frustumCulled = false;
    this.headlights.renderOrder = 6;
    this.group.add(this.headlights);
  }

  private addHeadlight(a: THREE.Vector3, b: THREE.Vector3, ahead: number, y: number) {
    if (this.hlCount >= 1200) return;
    const dx = a.x - b.x, dz = a.z - b.z;
    const l = Math.hypot(dx, dz) || 1;
    const i = this.hlCount++ * 3;
    this.hlPos[i] = a.x + (dx / l) * ahead; this.hlPos[i + 1] = a.y + y; this.hlPos[i + 2] = a.z + (dz / l) * ahead;
  }

  private makeCar(model: ModelGeo, vid: number): CarObj {
    const g = new THREE.Group();
    const b = new THREE.Mesh(model.body, this.mats.body);
    const gl = new THREE.Mesh(model.glass, this.mats.glass);
    b.castShadow = true;
    b.userData.vehicleId = vid; gl.userData.vehicleId = vid;
    g.add(b, gl);
    this.group.add(g);
    return { group: g, model };
  }

  private ensure(v: Train | RoadVehicle): VObj {
    const sig = v instanceof Train ? v.cars.map((c) => c.id).join(',') : (v.model ? v.model.id : 'amb');
    let o = this.objs.get(v.id);
    if (o && o.sig === sig) return o;
    if (o) for (const c of o.cars) this.group.remove(c.group);
    const cars: CarObj[] = [];
    if (v instanceof Train) for (const c of v.cars) cars.push(this.makeCar(getModel(c.style, c.color, c.length), v.id));
    else if (v.model) cars.push(this.makeCar(getModel(v.model.style, v.model.color, v.model.length), v.id));
    o = { sig, cars };
    this.objs.set(v.id, o);
    return o;
  }

  update(game: Game, dt: number, light: number, pointScale = 1200) {
    const seen = new Set<number>();
    this.hlCount = 0;
    const night = this.mats.headlight.visible;
    for (const v of game.vehicles.map.values()) {
      seen.add(v.id);
      if (v instanceof Train) this.updateTrain(v, dt);
      else if (v instanceof RoadVehicle) this.updateRoad(v);
    }
    for (const [id, o] of this.objs) {
      if (!seen.has(id)) { for (const c of o.cars) this.group.remove(c.group); this.objs.delete(id); }
    }
    this.updateAmbient(game, night);
    if (night) {
      this.headlights.geometry.setDrawRange(0, this.hlCount);
      (this.headlights.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    this.headlights.visible = night;
    this.smoke.update(dt);
    (this.smoke.points.material as THREE.ShaderMaterial).uniforms.uLight.value = light;
    (this.smoke.points.material as THREE.ShaderMaterial).uniforms.uScale.value = pointScale;
  }

  private updateTrain(t: Train, dt: number) {
    const o = this.ensure(t);
    if (!t.onMap) { for (const c of o.cars) c.group.visible = false; return; }
    let off = 0;
    for (let i = 0; i < t.cars.length; i++) {
      const car = o.cars[i];
      const L = t.cars[i].length;
      const mid = t.pointBehind(off + L / 2, tmpC);
      t.pointBehind(off + L * 0.18, tmpA);
      t.pointBehind(off + L * 0.82, tmpB);
      off += L + GAP;
      let hidden = false;
      if (mid) {
        const s = mid.seg;
        if (s.hidden === 1 && mid.sp < s.len - 0.32) hidden = true;
        if (s.hidden === 2 && mid.sp > 0.22 && mid.sp < s.len - 0.22) hidden = true;
      }
      car.group.visible = !hidden;
      if (hidden) continue;
      vA.set(tmpA.x, tmpA.y + RAIL_Y, tmpA.z);
      vB.set(tmpB.x, tmpB.y + RAIL_Y, tmpB.z);
      car.group.position.copy(vA).add(vB).multiplyScalar(0.5);
      car.group.lookAt(t.reversed ? vB : vA);
      if (i === 0 && this.mats.headlight.visible) { if (t.reversed) this.addHeadlight(vB, vA, 0.08, 0.1); else this.addHeadlight(vA, vB, 0.08, 0.1); }
      if (car.model.chimney && (t.state === 'running' || t.state === 'waiting' || t.state === 'loading')) {
        const acc = (this.emitAcc.get(t.id) ?? 0) + dt * (6 + t.speed * 12);
        let n = Math.floor(acc);
        this.emitAcc.set(t.id, acc - n);
        if (n > 0) {
          car.group.updateMatrixWorld();
          vC.copy(car.model.chimney).applyMatrix4(car.group.matrixWorld);
          const dx = (vA.x - vB.x), dz = (vA.z - vB.z);
          const l = Math.hypot(dx, dz) || 1;
          while (n-- > 0) this.smoke.emit(vC.x, vC.y, vC.z, (-dx / l) * t.speed * 0.3 * (t.reversed ? -1 : 1), (-dz / l) * t.speed * 0.3 * (t.reversed ? -1 : 1));
        }
      }
    }
  }

  private updateRoad(v: RoadVehicle) {
    const o = this.ensure(v);
    const car = o.cars[0];
    if (!car) return;
    if (!v.seg) { car.group.visible = false; return; }
    const L = v.length;
    const s = v.pointBehind(L * 0.12, tmpA);
    v.pointBehind(L * 0.88, tmpB);
    let hidden = false;
    if (s && s.hidden === 1 && v.pos < s.len * 0.45 && s === v.seg) hidden = true;
    if (s && s.hidden === 2 && v.pos > 0.2 && v.pos < s.len - 0.2) hidden = true;
    car.group.visible = !hidden;
    if (hidden) return;
    vA.set(tmpA.x, tmpA.y + ROAD_TOP, tmpA.z);
    vB.set(tmpB.x, tmpB.y + ROAD_TOP, tmpB.z);
    car.group.position.copy(vA).add(vB).multiplyScalar(0.5);
    car.group.lookAt(vA);
    if (this.mats.headlight.visible) this.addHeadlight(vA, vB, L * 0.12, 0.05);
  }

  private dummy = new THREE.Object3D();
  private col = new THREE.Color();
  private updateAmbient(game: Game, night: boolean) {
    const counts = [0, 0, 0];
    const d = this.dummy;
    for (const v of game.vehicles.ambient) {
      if (!v.seg) continue;
      const st = v.carStyle;
      const i = counts[st];
      if (i >= 400) continue;
      const L = v.length;
      const s = v.pointBehind(L * 0.15, tmpA);
      v.pointBehind(L * 0.85, tmpB);
      if (s && s.hidden === 2 && v.pos > 0.2 && v.pos < s.len - 0.2) continue;
      vA.set(tmpA.x, tmpA.y + ROAD_TOP, tmpA.z);
      vB.set(tmpB.x, tmpB.y + ROAD_TOP, tmpB.z);
      d.position.copy(vA).add(vB).multiplyScalar(0.5);
      d.lookAt(vA);
      d.updateMatrix();
      if (night) this.addHeadlight(vA, vB, L * 0.15, 0.045);
      this.ambBody[st].setMatrixAt(i, d.matrix);
      this.ambGlass[st].setMatrixAt(i, d.matrix);
      this.col.setHex(v.color);
      this.ambBody[st].setColorAt(i, this.col);
      counts[st]++;
    }
    for (let s = 0; s < 3; s++) {
      this.ambBody[s].count = counts[s];
      this.ambGlass[s].count = counts[s];
      this.ambBody[s].instanceMatrix.needsUpdate = true;
      this.ambGlass[s].instanceMatrix.needsUpdate = true;
      if (this.ambBody[s].instanceColor) this.ambBody[s].instanceColor!.needsUpdate = true;
    }
  }

  pick(ray: THREE.Raycaster): number | null {
    const targets: THREE.Object3D[] = [];
    for (const o of this.objs.values()) for (const c of o.cars) if (c.group.visible) targets.push(c.group);
    const hits = ray.intersectObjects(targets, true);
    for (const h of hits) if (h.object.userData.vehicleId != null) return h.object.userData.vehicleId as number;
    return null;
  }
}
