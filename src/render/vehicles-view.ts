// Renders trains, buses and ambient town traffic (instanced per model), steam smoke and night lights.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Train } from '../game/train';
import type { RoadVehicle, RSeg } from '../game/roadvehicle';
import { Materials } from './materials';
import { getModel, getCarModel, bogieModel, ModelGeo } from './vehicle-models';
import { applyClouds } from './clouds';
import { RAIL } from '../game/constants';

/** Rail head above the edge profile (same as build-rail's RAIL_TOP_Y); road vehicles sit on the profile. */
export const RAIL_Y = RAIL.railTop - RAIL.bedHeight;
export const ROAD_Y = 0.002;
/** Gap between train cars (matches train.ts). */
export const CAR_GAP = 0.1;

export interface V3 { x: number; y: number; z: number }

/** Column-major 4x4 transform with +z along unit vector f (x stays horizontal) at position p. */
export function writeBasis(out: Float32Array | number[], o: number, px: number, py: number, pz: number, fx: number, fy: number, fz: number) {
  let xx = fz, xz = -fx;
  const xl = Math.hypot(xx, xz);
  if (xl < 1e-6) { xx = 1; xz = 0; } else { xx /= xl; xz /= xl; }
  // y = f × x
  const yx = fy * xz, yy = fz * xx - fx * xz, yz = -fy * xx;
  out[o] = xx; out[o + 1] = 0; out[o + 2] = xz; out[o + 3] = 0;
  out[o + 4] = yx; out[o + 5] = yy; out[o + 6] = yz; out[o + 7] = 0;
  out[o + 8] = fx; out[o + 9] = fy; out[o + 10] = fz; out[o + 11] = 0;
  out[o + 12] = px; out[o + 13] = py; out[o + 14] = pz; out[o + 15] = 1;
}

export interface CarPose {
  /** body centre (on the rail head) and unit nose direction */
  x: number; y: number; z: number; fx: number; fy: number; fz: number;
  /** bogie pivots (front/rear in travel direction) and their track tangents */
  a: V3; da: V3; b: V3; db: V3;
  /** edge ids under the bogies (-1: virtual track inside a depot) */
  ea: number; eb: number;
  hidden: boolean;
}

const tA = { x: 0, y: 0, z: 0 }, tB = { x: 0, y: 0, z: 0 }, tE = { x: 0, y: 0, z: 0 };

/** Pose of every car of a train: each car rests on two bogie points on the track (follows curves and grades). */
export function trainCarPoses(t: Train, out: CarPose[]): number {
  let off = 0, n = 0;
  for (let i = 0; i < t.cars.length; i++) {
    const L = t.cars[i].length;
    const p = out[n] ?? (out[n] = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, a: { x: 0, y: 0, z: 0 }, da: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, db: { x: 0, y: 0, z: 0 }, ea: -1, eb: -1, hidden: false });
    const ra = t.pointBehind(off + 0.18 * L, p.a, p.da);
    const rb = t.pointBehind(off + 0.82 * L, p.b, p.db);
    const rf = t.pointBehind(off, tE);
    const rr = t.pointBehind(off + L, tE);
    off += L + CAR_GAP;
    if (!ra || !rb) continue;
    p.ea = ra.seg.e; p.eb = rb.seg.e;
    p.hidden = !!rf && !!rr && t.hiddenAt(rf.seg, rf.sp) && t.hiddenAt(rr.seg, rr.sp);
    let fx = p.a.x - p.b.x, fy = p.a.y - p.b.y, fz = p.a.z - p.b.z;
    let l = Math.hypot(fx, fy, fz);
    if (l < 1e-6) { fx = p.da.x; fy = p.da.y; fz = p.da.z; l = Math.hypot(fx, fy, fz) || 1; }
    const sg = t.reversed ? -1 : 1;
    p.fx = (fx / l) * sg; p.fy = (fy / l) * sg; p.fz = (fz / l) * sg;
    p.x = (p.a.x + p.b.x) / 2; p.y = (p.a.y + p.b.y) / 2 + RAIL_Y; p.z = (p.a.z + p.b.z) / 2;
    n++;
  }
  return n;
}

/** Segment and position d units behind the front of a road vehicle. */
function roadBehind(v: RoadVehicle, d: number): { seg: RSeg; pos: number } | null {
  if (!v.seg) return null;
  let s = v.seg, p = v.pos, k = 0;
  while (d > p && k < v.trail.length) { d -= p; s = v.trail[k++]; p = s.len; }
  return { seg: s, pos: Math.max(0, p - d) };
}

class Batch {
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh | null;
  ids: number[] = [];
  n = 0;
  constructor(public geo: THREE.BufferGeometry, public glassGeo: THREE.BufferGeometry | null, private mat: THREE.Material, private glassMat: THREE.Material, private parent: THREE.Group, public cap = 32, public tinted = false) {
    this.body = this.make(geo, mat, true);
    this.glass = glassGeo ? this.make(glassGeo, glassMat, false) : null;
  }
  private make(g: THREE.BufferGeometry, m: THREE.Material, shadow: boolean) {
    const im = new THREE.InstancedMesh(g, m, this.cap);
    im.count = 0;
    im.frustumCulled = false;
    im.castShadow = shadow;
    im.receiveShadow = true;
    if (this.tinted) im.setColorAt(0, new THREE.Color(1, 1, 1));
    this.parent.add(im);
    return im;
  }
  private grow() {
    const old = [this.body, this.glass];
    this.cap *= 2;
    const nb = this.make(this.geo, this.mat, true);
    nb.instanceMatrix.array.set(this.body.instanceMatrix.array);
    if (this.tinted && this.body.instanceColor && nb.instanceColor) nb.instanceColor.array.set(this.body.instanceColor.array);
    const ng = this.glass ? this.make(this.glassGeo!, this.glassMat, false) : null;
    if (ng && this.glass) ng.instanceMatrix.array.set(this.glass.instanceMatrix.array);
    for (const o of old) if (o) { this.parent.remove(o); o.dispose(); }
    this.body = nb; this.glass = ng;
  }
  /** Reserve the next instance slot; returns the matrix offset. */
  push(id: number): number {
    if (this.n >= this.cap) this.grow();
    this.ids[this.n] = id;
    return this.n++ * 16;
  }
  get mat16() { return this.body.instanceMatrix.array as Float32Array; }
  finish() {
    const n = this.n;
    this.body.count = n;
    this.body.instanceMatrix.needsUpdate = true;
    this.body.boundingSphere = null;
    if (this.tinted && this.body.instanceColor) this.body.instanceColor.needsUpdate = true;
    if (this.glass) {
      this.glass.count = n;
      (this.glass.instanceMatrix.array as Float32Array).set((this.body.instanceMatrix.array as Float32Array).subarray(0, n * 16));
      this.glass.instanceMatrix.needsUpdate = true;
      this.glass.boundingSphere = null;
    }
    this.n = 0;
  }
  dispose() {
    for (const o of [this.body, this.glass]) if (o) { this.parent.remove(o); o.dispose(); }
  }
}

class Smoke {
  max = 3000;
  pos: Float32Array; vel: Float32Array; life: Float32Array; size: Float32Array; alpha: Float32Array;
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
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
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uLight: { value: 1 } },
      transparent: true, depthWrite: false,
      vertexShader: `attribute float aSize; attribute float aAlpha; varying float vA; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.01), 1.0, 600.0); vA = aAlpha; }`,
      fragmentShader: `uniform float uLight; varying float vA;
        void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0; float a = smoothstep(1.0, 0.2, r);
          if (a <= 0.003) discard;
          gl_FragColor = vec4(vec3(0.8, 0.8, 0.82) * (0.25 + 0.75 * uLight), a * vA * 0.75); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  emit(x: number, y: number, z: number, vx: number, vz: number) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * 0.06;
    this.vel[i * 3 + 1] = 0.35 + Math.random() * 0.15;
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 0.06;
    this.life[i] = 0;
    this.size[i] = 0.1;
    this.alpha[i] = 0;
  }
  update(dt: number) {
    let j = 0;
    const LIFE = 3.2;
    for (let i = 0; i < this.count; i++) {
      const l = this.life[i] + dt;
      if (l > LIFE) continue;
      this.life[j] = l;
      for (let k = 0; k < 3; k++) this.pos[j * 3 + k] = this.pos[i * 3 + k] + this.vel[i * 3 + k] * dt;
      this.vel[j * 3] = this.vel[i * 3] * (1 - dt * 1.2) + 0.04 * dt;
      this.vel[j * 3 + 1] = this.vel[i * 3 + 1] * (1 - dt * 0.5);
      this.vel[j * 3 + 2] = this.vel[i * 3 + 2] * (1 - dt * 1.2) + 0.025 * dt;
      this.size[j] = 0.12 + l * 0.38;
      this.alpha[j] = Math.min(1, l * 4) * (1 - l / LIFE);
      j++;
    }
    this.count = j;
    this.geo.setDrawRange(0, this.count);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aSize') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('aAlpha') as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Head/tail light glows (additive points, a minimum on-screen size keeps them visible from afar). */
class Lights {
  max = 6000;
  pos = new Float32Array(this.max * 3);
  col = new Float32Array(this.max * 3);
  n = 0;
  geo = new THREE.BufferGeometry();
  mat: THREE.ShaderMaterial;
  points: THREE.Points;
  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uNight: { value: 0 } },
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
      vertexShader: `attribute vec3 color; varying vec3 vC; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(0.09 * uScale / max(-mv.z, 0.01), 3.0, 48.0); vC = color; }`,
      fragmentShader: `uniform float uNight; varying vec3 vC;
        void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float a = pow(max(1.0 - r, 0.0), 2.2);
          gl_FragColor = vec4(vC * a * uNight * 1.6, 1.0); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 6;
  }
  add(x: number, y: number, z: number, r: number, g: number, b: number) {
    if (this.n >= this.max) return;
    const i = this.n++ * 3;
    this.pos[i] = x; this.pos[i + 1] = y; this.pos[i + 2] = z;
    this.col[i] = r; this.col[i + 1] = g; this.col[i + 2] = b;
  }
  finish(night: number) {
    this.points.visible = night > 0.02 && this.n > 0;
    this.mat.uniforms.uNight.value = night;
    this.geo.setDrawRange(0, this.n);
    (this.geo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    (this.geo.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    this.n = 0;
  }
}

export class VehiclesView {
  group = new THREE.Group();
  /** body material: vertex colours, ambient cars tint their paint (aPaint) with the instance colour */
  paintMat: THREE.MeshStandardMaterial;
  private batches = new Map<string, Batch>();
  private bogies: Batch;
  smoke = new Smoke();
  lights = new Lights();
  private emitAcc = new Map<number, number>();
  private poses: CarPose[] = [];
  private col = new THREE.Color();

  constructor(private mats: Materials) {
    this.paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.3 });
    this.paintMat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPaint;')
        .replace('#include <color_vertex>', `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.xyz *= mix(vec3(1.0), instanceColor.xyz, aPaint);
#endif`);
    };
    this.paintMat.customProgramCacheKey = () => 'rf-vehicle-paint';
    applyClouds(this.paintMat);
    this.bogies = new Batch(bogieModel(), null, this.paintMat, mats.glass, this.group, 128);
    this.group.add(this.smoke.points, this.lights.points);
  }

  private batch(key: string, m: ModelGeo, tinted = false): Batch {
    let b = this.batches.get(key);
    if (!b) { b = new Batch(m.body, m.glass, this.paintMat, this.mats.glass, this.group, 32, tinted); this.batches.set(key, b); }
    return b;
  }

  update(game: Game, dt: number, light: number, pointScale = 1200) {
    const night = this.mats.uniforms.uNight.value;
    for (const t of game.vehicles.trains()) this.updateTrain(t, dt, night);
    for (const v of game.vehicles.roads()) this.updateRoad(v, night);
    for (const v of game.vehicles.ambient) this.updateRoad(v, night);
    for (const b of this.batches.values()) b.finish();
    this.bogies.finish();
    this.lights.mat.uniforms.uScale.value = pointScale;
    this.lights.finish(night);
    this.smoke.update(dt);
    this.smoke.mat.uniforms.uLight.value = light;
    this.smoke.mat.uniforms.uScale.value = pointScale;
    for (const id of this.emitAcc.keys()) if (!game.vehicles.get(id)) this.emitAcc.delete(id);
  }

  private updateTrain(t: Train, dt: number, night: number) {
    if (!t.onMap) return;
    const n = trainCarPoses(t, this.poses);
    let lastVisible = -1;
    for (let i = 0; i < n; i++) {
      const p = this.poses[i];
      if (p.hidden) continue;
      const cm = t.cars[i];
      const m = getModel(cm.style, cm.color, cm.length);
      const b = this.batch('m:' + cm.style + ':' + cm.color + ':' + cm.length, m);
      const o = b.push(t.id);
      writeBasis(b.mat16, o, p.x, p.y, p.z, p.fx, p.fy, p.fz);
      for (const bz of m.bogies) {
        const front = (bz > 0) !== t.reversed;
        const q = front ? p.a : p.b, d = front ? p.da : p.db;
        const ob = this.bogies.push(t.id);
        writeBasis(this.bogies.mat16, ob, q.x, q.y + RAIL_Y, q.z, d.x, d.y, d.z);
      }
      if (m.chimney && (t.state === 'running' || t.state === 'waiting' || t.state === 'loading')) this.emitSmoke(t.id, b, o, m.chimney, t.speed, p, dt, t.reversed);
      if (i === 0 && night > 0.02) {
        // head lights at the leading end (travel direction)
        const s = t.reversed ? -1 : 1;
        this.carLight(p, m.length / 2 * s + 0.01 * s, 0.24, 0.085, 1, 0.95, 0.8);
      }
      lastVisible = i;
    }
    if (night > 0.02 && lastVisible === n - 1 && n > 0) {
      const p = this.poses[n - 1];
      const s = t.reversed ? -1 : 1;
      this.carLight(p, -(t.cars[n - 1].length / 2) * s - 0.01 * s, 0.16, 0.09, 1, 0.08, 0.05);
    }
  }

  /** Two lights at local z (along the nose direction), height y, lateral ±x. */
  private carLight(p: CarPose, z: number, y: number, x: number, r: number, g: number, b: number) {
    let rx = p.fz, rz = -p.fx;
    const l = Math.hypot(rx, rz) || 1; rx /= l; rz /= l;
    for (const sx of [-x, x]) this.lights.add(p.x + p.fx * z + rx * sx, p.y + y + p.fy * z, p.z + p.fz * z + rz * sx, r, g, b);
  }

  private emitSmoke(id: number, b: Batch, o: number, chimney: THREE.Vector3, speed: number, p: CarPose, dt: number, reversed: boolean) {
    const acc = (this.emitAcc.get(id) ?? 0) + dt * (5 + speed * 40);
    let k = Math.floor(acc);
    this.emitAcc.set(id, acc - k);
    if (k <= 0) return;
    const e = b.mat16;
    const cx = chimney.x, cy = chimney.y, cz = chimney.z;
    const x = e[o] * cx + e[o + 4] * cy + e[o + 8] * cz + e[o + 12];
    const y = e[o + 1] * cx + e[o + 5] * cy + e[o + 9] * cz + e[o + 13];
    const z = e[o + 2] * cx + e[o + 6] * cy + e[o + 10] * cz + e[o + 14];
    const s = reversed ? 1 : -1; // smoke trails behind the direction of travel
    while (k-- > 0) this.smoke.emit(x, y, z, p.fx * speed * 0.35 * s, p.fz * speed * 0.35 * s);
  }

  private updateRoad(v: RoadVehicle, night: number) {
    if (!v.seg) return;
    const L = v.length;
    const f = roadBehind(v, 0), r = roadBehind(v, L);
    if (!f || !r) return;
    if (v.hiddenAt(f.seg, f.pos) && v.hiddenAt(r.seg, r.pos)) return;
    v.pointBehind(0, tA);
    v.pointBehind(L, tB);
    let fx = tA.x - tB.x, fy = tA.y - tB.y, fz = tA.z - tB.z;
    const l = Math.hypot(fx, fy, fz);
    if (l < 1e-6) return;
    fx /= l; fy /= l; fz /= l;
    const px = (tA.x + tB.x) / 2, py = (tA.y + tB.y) / 2 + ROAD_Y, pz = (tA.z + tB.z) / 2;
    let m: ModelGeo, b: Batch;
    if (v.model) {
      m = getModel(v.model.style, v.model.color, v.model.length);
      b = this.batch('m:' + v.model.style + ':' + v.model.color + ':' + v.model.length, m);
    } else {
      const st = Math.max(0, Math.min(3, v.style | 0));
      m = getCarModel(st);
      b = this.batch('car:' + st, m, true);
    }
    const o = b.push(v.ambient ? -1 : v.id);
    writeBasis(b.mat16, o, px, py, pz, fx, fy, fz);
    if (b.tinted && b.body.instanceColor) {
      this.col.setHex(v.tint & 0xffffff);
      // keep paint colours plausible: desaturate and limit brightness a little
      const hsl = { h: 0, s: 0, l: 0 };
      this.col.getHSL(hsl);
      this.col.setHSL(hsl.h, hsl.s * 0.75, 0.2 + hsl.l * 0.6);
      b.body.setColorAt(o / 16, this.col);
    }
    if (night > 0.02) {
      for (const [lx, ly, lz] of m.front) this.lights.add(px + fz * lx + fx * lz, py + ly + fy * lz, pz - fx * lx + fz * lz, 1, 0.95, 0.8);
      for (const [lx, ly, lz] of m.rear) this.lights.add(px + fz * lx + fx * lz, py + ly + fy * lz, pz - fx * lx + fz * lz, 0.9, 0.06, 0.04);
    }
  }

  /** Vehicle id under the ray (ambient traffic is not pickable). */
  pick(ray: THREE.Raycaster): number | null {
    const targets: THREE.Object3D[] = [];
    const owner = new Map<THREE.Object3D, Batch>();
    for (const [key, b] of this.batches) {
      if (key.startsWith('car:') || b.body.count === 0) continue;
      targets.push(b.body);
      owner.set(b.body, b);
    }
    if (this.bogies.body.count) { targets.push(this.bogies.body); owner.set(this.bogies.body, this.bogies); }
    const hits = ray.intersectObjects(targets, false);
    for (const h of hits) {
      const b = owner.get(h.object);
      if (!b || h.instanceId == null) continue;
      const id = b.ids[h.instanceId];
      if (id != null && id >= 0) return id;
    }
    return null;
  }

  dispose() {
    for (const b of this.batches.values()) b.dispose();
    this.batches.clear();
    this.bogies.dispose();
    this.smoke.geo.dispose();
    this.lights.geo.dispose();
  }
}

