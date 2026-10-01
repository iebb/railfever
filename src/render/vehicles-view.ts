// Renders trains, buses and ambient town traffic (instanced per model, distance LOD, frustum culled),
// steam and diesel exhaust, and head/tail lights at night.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Train } from '../game/train';
import type { RoadVehicle, RSeg } from '../game/roadvehicle';
import type { VehicleModel } from '../game/vehicle-types';
import { Materials } from './materials';
import { getModel, getCarModel, bogieModel, ModelGeo } from './vehicle-models';
import { applyClouds } from './clouds';
import { srgbToLinear } from './geo';
import { RAIL } from '../game/constants';

/** Rail head above the edge profile (same as build-rail's RAIL_TOP_Y); road vehicles sit on the profile. */
export const RAIL_Y = RAIL.railTop - RAIL.bedHeight;
export const ROAD_Y = 0.002;
/** Gap between train cars (matches train.ts). */
export const CAR_GAP = 0.1;
/** A vehicle uses its detailed model when its length covers at least this many pixels. */
const HI_PX = 46;

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

/**
 * Pose of every car of a train (out[i] for car i): each car rests on two bogie points on the track, so it
 * follows curves and grades. Cars that cannot be placed are marked hidden. Returns the number of cars.
 */
export function trainCarPoses(t: Train, out: CarPose[]): number {
  let off = 0;
  const n = t.cars.length;
  // cars can only be hidden in tunnels or inside a depot
  let canHide = false;
  for (const s of t.segs) if (s.e < 0 || s.tunnels.length) { canHide = true; break; }
  for (let i = 0; i < n; i++) {
    const L = t.cars[i].length;
    const p = out[i] ?? (out[i] = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, a: { x: 0, y: 0, z: 0 }, da: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, db: { x: 0, y: 0, z: 0 }, ea: -1, eb: -1, hidden: false });
    const ra = t.pointBehind(off + 0.18 * L, p.a, p.da);
    const rb = t.pointBehind(off + 0.82 * L, p.b, p.db);
    let hidden = false;
    if (canHide) {
      const rf = t.pointBehind(off, tE);
      if (rf && t.hiddenAt(rf.seg, rf.sp)) { const rr = t.pointBehind(off + L, tE); hidden = !!rr && t.hiddenAt(rr.seg, rr.sp); }
    }
    off += L + CAR_GAP;
    if (!ra || !rb) { p.hidden = true; continue; }
    p.ea = ra.seg.e; p.eb = rb.seg.e;
    p.hidden = hidden;
    let fx = p.a.x - p.b.x, fy = p.a.y - p.b.y, fz = p.a.z - p.b.z;
    let l = Math.hypot(fx, fy, fz);
    if (l < 1e-6) { fx = p.da.x; fy = p.da.y; fz = p.da.z; l = Math.hypot(fx, fy, fz) || 1; }
    const sg = t.reversed ? -1 : 1;
    p.fx = (fx / l) * sg; p.fy = (fy / l) * sg; p.fz = (fz / l) * sg;
    p.x = (p.a.x + p.b.x) / 2; p.y = (p.a.y + p.b.y) / 2 + RAIL_Y; p.z = (p.a.z + p.b.z) / 2;
  }
  return n;
}

/** Segment and position d units behind the front of a road vehicle. */
function roadBehind(v: RoadVehicle, d: number, out: { seg: RSeg | null; pos: number }): boolean {
  if (!v.seg) return false;
  let s = v.seg, p = v.pos, k = 0;
  while (d > p && k < v.trail.length) { d -= p; s = v.trail[k++]; p = s.len; }
  out.seg = s; out.pos = Math.max(0, p - d);
  return true;
}

class Batch {
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh | null;
  ids: number[] = [];
  n = 0;
  constructor(public geo: THREE.BufferGeometry, public glassGeo: THREE.BufferGeometry | null, private mat: THREE.Material, private glassMat: THREE.Material, private parent: THREE.Group, public cap = 32, public tinted = false, private shadow = true) {
    this.body = this.make(geo, mat, shadow);
    this.glass = glassGeo ? this.make(glassGeo, glassMat, false) : null;
  }
  private make(g: THREE.BufferGeometry, m: THREE.Material, shadow: boolean) {
    const im = new THREE.InstancedMesh(g, m, this.cap);
    im.count = 0;
    im.frustumCulled = false; // culled per instance on the CPU
    im.castShadow = shadow;
    im.receiveShadow = true;
    im.matrixAutoUpdate = false;
    if (this.tinted) im.setColorAt(0, new THREE.Color(1, 1, 1));
    this.parent.add(im);
    return im;
  }
  private grow() {
    const old = [this.body, this.glass];
    this.cap *= 2;
    const nb = this.make(this.geo, this.mat, this.shadow);
    nb.instanceMatrix.array.set(this.body.instanceMatrix.array);
    if (this.tinted && this.body.instanceColor && nb.instanceColor) nb.instanceColor.array.set(this.body.instanceColor.array);
    const ng = this.glass ? this.make(this.glassGeo!, this.glassMat, false) : null;
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
  get col3() { return this.body.instanceColor!.array as Float32Array; }
  finish(): number {
    const n = this.n;
    this.body.count = n;
    this.body.visible = n > 0;
    if (n) {
      this.body.instanceMatrix.clearUpdateRanges();
      this.body.instanceMatrix.addUpdateRange(0, n * 16);
      this.body.instanceMatrix.needsUpdate = true;
      if (this.tinted && this.body.instanceColor) {
        this.body.instanceColor.clearUpdateRanges();
        this.body.instanceColor.addUpdateRange(0, n * 3);
        this.body.instanceColor.needsUpdate = true;
      }
    }
    this.body.boundingSphere = null;
    if (this.glass) {
      this.glass.count = n;
      this.glass.visible = n > 0;
      if (n) {
        (this.glass.instanceMatrix.array as Float32Array).set((this.body.instanceMatrix.array as Float32Array).subarray(0, n * 16));
        this.glass.instanceMatrix.clearUpdateRanges();
        this.glass.instanceMatrix.addUpdateRange(0, n * 16);
        this.glass.instanceMatrix.needsUpdate = true;
      }
      this.glass.boundingSphere = null;
    }
    this.n = 0;
    return n;
  }
  dispose() {
    for (const o of [this.body, this.glass]) if (o) { this.parent.remove(o); o.dispose(); }
  }
}

interface BatchPair { hi: Batch; lo: Batch; ambient: boolean }

const SMOKE_ATTRS = ['position', 'aSize', 'aAlpha', 'aTone'];

/** Steam puffs (white, large, slow) and diesel exhaust (dark, small, quick). */
class Smoke {
  max = 4000;
  pos: Float32Array; vel: Float32Array; life: Float32Array; maxLife: Float32Array; grow: Float32Array; shade: Float32Array;
  size: Float32Array; alpha: Float32Array; tone: Float32Array;
  geo: THREE.BufferGeometry;
  points: THREE.Points;
  mat: THREE.ShaderMaterial;
  count = 0;
  constructor() {
    const M = this.max;
    this.pos = new Float32Array(M * 3); this.vel = new Float32Array(M * 3);
    this.life = new Float32Array(M); this.maxLife = new Float32Array(M); this.grow = new Float32Array(M); this.shade = new Float32Array(M);
    this.size = new Float32Array(M); this.alpha = new Float32Array(M); this.tone = new Float32Array(M);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aTone', new THREE.BufferAttribute(this.tone, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 800 }, uLight: { value: 1 } },
      transparent: true, depthWrite: false, fog: false,
      vertexShader: `attribute float aSize; attribute float aAlpha; attribute float aTone; varying float vA; varying float vT; uniform float uScale;
        void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mv;
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.01), 1.0, 500.0); vA = aAlpha; vT = aTone; }`,
      fragmentShader: `uniform float uLight; varying float vA; varying float vT;
        void main(){ vec2 c = gl_PointCoord - 0.5; float r = length(c) * 2.0; float a = 1.0 - smoothstep(0.15, 1.0, r);
          if (a * vA <= 0.004) discard;
          float lit = 0.92 - 0.25 * (c.y + 0.5);
          gl_FragColor = vec4(vec3(vT * lit) * (0.2 + 0.8 * uLight), a * vA); }`,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 5;
  }
  emit(x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, s0: number, grow: number, shade: number) {
    if (this.count >= this.max) return;
    const i = this.count++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx + (Math.random() - 0.5) * 0.05;
    this.vel[i * 3 + 1] = vy * (0.8 + Math.random() * 0.4);
    this.vel[i * 3 + 2] = vz + (Math.random() - 0.5) * 0.05;
    this.life[i] = 0; this.maxLife[i] = life * (0.8 + Math.random() * 0.4);
    this.size[i] = s0; this.grow[i] = grow; this.shade[i] = shade; this.alpha[i] = 0; this.tone[i] = shade;
  }
  update(dt: number) {
    let j = 0;
    for (let i = 0; i < this.count; i++) {
      const L = this.maxLife[i], l = this.life[i] + dt;
      if (l > L) continue;
      if (j !== i) {
        this.maxLife[j] = L; this.grow[j] = this.grow[i]; this.shade[j] = this.shade[i];
      }
      this.life[j] = l;
      for (let k = 0; k < 3; k++) this.pos[j * 3 + k] = this.pos[i * 3 + k] + this.vel[i * 3 + k] * dt;
      this.vel[j * 3] = this.vel[i * 3] * (1 - dt * 1.2) + 0.04 * dt;
      this.vel[j * 3 + 1] = this.vel[i * 3 + 1] * (1 - dt * 0.5);
      this.vel[j * 3 + 2] = this.vel[i * 3 + 2] * (1 - dt * 1.2) + 0.025 * dt;
      const f = l / L;
      this.size[j] = this.size[i] + this.grow[j] * dt;
      this.alpha[j] = Math.min(1, f * 6) * (1 - f) * (1 - f * 0.3);
      this.tone[j] = this.shade[j] + (0.75 - this.shade[j]) * f * 0.6;
      j++;
    }
    this.count = j;
    this.geo.setDrawRange(0, this.count);
    this.points.visible = this.count > 0;
    for (const n of SMOKE_ATTRS) (this.geo.getAttribute(n) as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Head/tail light glows (additive points; a minimum on-screen size keeps them visible from afar). */
class Lights {
  max = 8000;
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
          // pull the sprite towards the camera so it is not swallowed by the lamp housing
          gl_Position.z -= 0.0005 * gl_Position.w;
          gl_PointSize = clamp(0.07 * uScale / max(-mv.z, 0.01), 2.5, 40.0); vC = color; }`,
      fragmentShader: `uniform float uNight; varying vec3 vC;
        void main(){ float r = length(gl_PointCoord - 0.5) * 2.0; float core = 1.0 - smoothstep(0.0, 0.35, r); float halo = pow(max(1.0 - r, 0.0), 2.5);
          gl_FragColor = vec4((vC * halo * 0.9 + vec3(core) * 0.6) * uNight * 1.5, 1.0); }`,
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
  /** instances drawn in the last update */
  instances = 0;
  private batches = new Map<ModelGeo, BatchPair>();
  private bogies: Record<'b2' | 'b3', Batch>;
  smoke = new Smoke();
  lights = new Lights();
  private emitAcc = new Map<number, number>();
  private lastSpeed = new Map<number, number>();
  private poses: CarPose[] = [];
  private models = new WeakMap<VehicleModel, ModelGeo>();
  private frustum = new THREE.Frustum();
  private pm = new THREE.Matrix4();
  private sphere = new THREE.Sphere();
  private camPos = new THREE.Vector3();
  private cull = false;
  private pxScale = 1200;
  private rb1 = { seg: null as RSeg | null, pos: 0 };
  private rb2 = { seg: null as RSeg | null, pos: 0 };
  private tick = 0;
  private rpose = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1 };

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
    this.bogies = {
      b2: new Batch(bogieModel('b2'), null, this.paintMat, mats.glass, this.group, 128),
      b3: new Batch(bogieModel('b3'), null, this.paintMat, mats.glass, this.group, 32),
    };
    this.group.add(this.smoke.points, this.lights.points);
  }

  private model(m: VehicleModel): ModelGeo {
    let g = this.models.get(m);
    if (!g) { g = getModel(m.style, m.color, m.length); this.models.set(m, g); }
    return g;
  }

  private pair(m: ModelGeo, ambient = false): BatchPair {
    let p = this.batches.get(m);
    if (!p) {
      p = {
        hi: new Batch(m.body, m.glass, this.paintMat, this.mats.glass, this.group, ambient ? 64 : 16, ambient),
        lo: new Batch(m.lo.body, m.lo.glass, this.paintMat, this.mats.glass, this.group, ambient ? 128 : 16, ambient, !ambient),
        ambient,
      };
      this.batches.set(m, p);
    }
    return p;
  }

  /** Visible (with a margin for shadows) and detailed enough for the high LOD? 0 culled, 1 lo, 2 hi. */
  private lod(x: number, y: number, z: number, len: number): number {
    if (!this.cull) return 2;
    this.sphere.center.set(x, y, z);
    this.sphere.radius = len / 2 + 1.2;
    if (!this.frustum.intersectsSphere(this.sphere)) return 0;
    const d = Math.hypot(x - this.camPos.x, y - this.camPos.y, z - this.camPos.z);
    return len * this.pxScale > HI_PX * d ? 2 : 1;
  }

  update(game: Game, dt: number, light: number, pointScale = 1200, camera?: THREE.Camera) {
    const night = this.mats.uniforms.uNight.value;
    this.pxScale = pointScale;
    this.cull = !!camera;
    if (camera) {
      this.camPos.setFromMatrixPosition(camera.matrixWorld);
      this.pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.pm);
    }
    this.tick++;
    for (const v of game.vehicles.map.values()) {
      if (v.kind === 'train') this.updateTrain(v as Train, dt, night);
      else this.updateRoad(v as RoadVehicle, night);
    }
    for (const v of game.vehicles.ambient) this.updateRoad(v, night);
    let n = 0;
    for (const p of this.batches.values()) { n += p.hi.finish(); n += p.lo.finish(); }
    n += this.bogies.b2.finish() + this.bogies.b3.finish();
    this.instances = n;
    this.lights.mat.uniforms.uScale.value = pointScale;
    this.lights.finish(night);
    this.smoke.update(dt);
    this.smoke.mat.uniforms.uLight.value = light;
    this.smoke.mat.uniforms.uScale.value = pointScale;
    if ((this.tick & 255) === 0) {
      for (const id of this.emitAcc.keys()) if (!game.vehicles.get(id)) this.emitAcc.delete(id);
      for (const id of this.lastSpeed.keys()) if (!game.vehicles.get(id)) this.lastSpeed.delete(id);
    }
  }

  private updateTrain(t: Train, dt: number, night: number) {
    if (!t.onMap) return;
    const n = trainCarPoses(t, this.poses);
    const prev = this.lastSpeed.get(t.id) ?? t.speed;
    this.lastSpeed.set(t.id, t.speed);
    const accel = dt > 0 ? (t.speed - prev) / dt : 0;
    const active = t.state === 'running' || t.state === 'waiting' || t.state === 'loading';
    for (let i = 0; i < n; i++) {
      const p = this.poses[i];
      if (p.hidden) continue;
      const cm = t.cars[i];
      const m = this.model(cm);
      const lod = this.lod(p.x, p.y, p.z, cm.length);
      if (!lod) continue;
      const bp = this.pair(m);
      const b = lod === 2 ? bp.hi : bp.lo;
      const o = b.push(t.id);
      writeBasis(b.mat16, o, p.x, p.y, p.z, p.fx, p.fy, p.fz);
      if (lod === 2) for (const bz of m.bogies) {
        const front = (bz > 0) !== t.reversed;
        const q = front ? p.a : p.b, d = front ? p.da : p.db;
        const bb = this.bogies[m.bogieKind];
        writeBasis(bb.mat16, bb.push(t.id), q.x, q.y + RAIL_Y, q.z, d.x, d.y, d.z);
      }
      if (active && m.chimney) this.emitSteam(t.id, b.mat16, o, m.chimney, t.speed, p, dt, t.reversed);
      if (active && m.exhaust) this.emitExhaust(t.id, b.mat16, o, m.exhaust, t.speed, accel, dt);
    }
    if (night > 0.02 && n > 0) {
      // white lamps on the leading face, red on the trailing face (cars keep their orientation when reversing)
      const h = this.poses[0], hm = this.model(t.cars[0]);
      if (!h.hidden) this.lamps(h, t.reversed ? hm.rear : hm.front, 1, 0.93, 0.78);
      const r = this.poses[n - 1], rm = this.model(t.cars[n - 1]);
      if (!r.hidden) this.lamps(r, t.reversed ? rm.front : rm.rear, 1, 0.06, 0.03);
    }
  }

  /** Lamps given in model space of a posed car. */
  private lamps(p: { x: number; y: number; z: number; fx: number; fy: number; fz: number }, pts: [number, number, number][], r: number, g: number, b: number) {
    let xx = p.fz, xz = -p.fx;
    const l = Math.hypot(xx, xz) || 1; xx /= l; xz /= l;
    const yx = p.fy * xz, yy = p.fz * xx - p.fx * xz, yz = -p.fy * xx;
    for (const q of pts) {
      const lx = q[0], ly = q[1], lz = q[2];
      this.lights.add(p.x + xx * lx + yx * ly + p.fx * lz, p.y + yy * ly + p.fy * lz, p.z + xz * lx + yz * ly + p.fz * lz, r, g, b);
    }
  }

  private emitSteam(id: number, e: Float32Array, o: number, ch: THREE.Vector3, speed: number, p: CarPose, dt: number, reversed: boolean) {
    const acc = (this.emitAcc.get(id) ?? 0) + dt * (4 + speed * 30);
    let k = Math.floor(acc);
    this.emitAcc.set(id, acc - k);
    if (k <= 0) return;
    const x = e[o] * ch.x + e[o + 4] * ch.y + e[o + 8] * ch.z + e[o + 12];
    const y = e[o + 1] * ch.x + e[o + 5] * ch.y + e[o + 9] * ch.z + e[o + 13];
    const z = e[o + 2] * ch.x + e[o + 6] * ch.y + e[o + 10] * ch.z + e[o + 14];
    const s = reversed ? 1 : -1; // smoke trails behind the direction of travel
    while (k-- > 0) this.smoke.emit(x, y, z, p.fx * speed * 0.35 * s, 0.4, p.fz * speed * 0.35 * s, 3.2, 0.1, 0.4, 0.86);
  }

  private emitExhaust(id: number, e: Float32Array, o: number, pts: THREE.Vector3[], speed: number, accel: number, dt: number) {
    // idle haze, thicker when the engine works hard
    const load = Math.max(0, Math.min(1, accel * 25 + (speed > 0.5 ? 0.25 : 0)));
    const acc = (this.emitAcc.get(-id) ?? 0) + dt * (1.5 + load * 14);
    let k = Math.floor(acc);
    this.emitAcc.set(-id, acc - k);
    if (k <= 0) return;
    while (k-- > 0) {
      const ch = pts[k % pts.length];
      const x = e[o] * ch.x + e[o + 4] * ch.y + e[o + 8] * ch.z + e[o + 12];
      const y = e[o + 1] * ch.x + e[o + 5] * ch.y + e[o + 9] * ch.z + e[o + 13];
      const z = e[o + 2] * ch.x + e[o + 6] * ch.y + e[o + 10] * ch.z + e[o + 14];
      this.smoke.emit(x, y, z, 0, 0.5 + load * 0.4, 0, 1.4 + load * 0.6, 0.04, 0.22 + load * 0.15, 0.26 + (1 - load) * 0.25);
    }
  }

  private updateRoad(v: RoadVehicle, night: number) {
    if (!v.seg) return;
    const L = v.length;
    const f = this.rb1, r = this.rb2;
    if (!roadBehind(v, 0, f) || !roadBehind(v, L, r)) return;
    if (v.hiddenAt(f.seg!, f.pos) && v.hiddenAt(r.seg!, r.pos)) return;
    v.pointBehind(0, tA);
    v.pointBehind(L, tB);
    let fx = tA.x - tB.x, fy = tA.y - tB.y, fz = tA.z - tB.z;
    const l = Math.hypot(fx, fy, fz);
    if (l < 1e-6) return;
    fx /= l; fy /= l; fz /= l;
    const px = (tA.x + tB.x) / 2, py = (tA.y + tB.y) / 2 + ROAD_Y, pz = (tA.z + tB.z) / 2;
    const lod = this.lod(px, py, pz, L);
    if (!lod) return;
    const m = v.model ? this.model(v.model) : getCarModel(Math.max(0, Math.min(3, v.style | 0)));
    const bp = this.pair(m, !v.model);
    const b = lod === 2 ? bp.hi : bp.lo;
    const o = b.push(v.ambient ? -1 : v.id);
    writeBasis(b.mat16, o, px, py, pz, fx, fy, fz);
    if (b.tinted) {
      // plausible paint: desaturated, mid brightness (linear colour for the shader)
      const t = v.tint & 0xffffff;
      let cr = ((t >> 16) & 255) / 255, cg = ((t >> 8) & 255) / 255, cb = (t & 255) / 255;
      const lum = 0.3 * cr + 0.59 * cg + 0.11 * cb;
      cr = 0.1 + (lum + (cr - lum) * 0.7) * 0.78; cg = 0.1 + (lum + (cg - lum) * 0.7) * 0.78; cb = 0.1 + (lum + (cb - lum) * 0.7) * 0.78;
      const c = b.col3, ci = (o / 16) * 3;
      c[ci] = srgbToLinear(cr); c[ci + 1] = srgbToLinear(cg); c[ci + 2] = srgbToLinear(cb);
    }
    if (night > 0.02) {
      const pose = this.rpose;
      pose.x = px; pose.y = py; pose.z = pz; pose.fx = fx; pose.fy = fy; pose.fz = fz;
      this.lamps(pose, m.front, 1, 0.94, 0.8);
      this.lamps(pose, m.rear, 0.9, 0.05, 0.03);
    }
  }

  /** Vehicle id under the ray (ambient traffic is not pickable). */
  pick(ray: THREE.Raycaster): number | null {
    let best: number | null = null, bd = Infinity;
    const hits: THREE.Intersection[] = [];
    const test = (b: Batch) => {
      if (b.body.count === 0) return;
      hits.length = 0;
      b.body.raycast(ray, hits);
      for (const h of hits) {
        if (h.instanceId == null || h.distance >= bd) continue;
        const id = b.ids[h.instanceId];
        if (id != null && id >= 0) { bd = h.distance; best = id; }
      }
    };
    for (const p of this.batches.values()) { if (p.ambient) continue; test(p.hi); test(p.lo); }
    test(this.bogies.b2); test(this.bogies.b3);
    return best;
  }

  dispose() {
    for (const p of this.batches.values()) { p.hi.dispose(); p.lo.dispose(); }
    this.batches.clear();
    this.bogies.b2.dispose(); this.bogies.b3.dispose();
    this.smoke.geo.dispose();
    this.lights.geo.dispose();
  }
}
