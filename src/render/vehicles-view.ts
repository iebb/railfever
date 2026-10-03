// Renders trains, buses and ambient town traffic (instanced per model, distance LOD, frustum culled),
// steam and diesel exhaust, and head/tail lights at night.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Train } from '../game/train';
import type { RoadVehicle, RSeg } from '../game/roadvehicle';
import { laneTrim } from '../game/roadvehicle';
import { ROAD_DRAPE } from './terrain';
import type { VehicleModel } from '../game/vehicle-types';
import { Materials } from './materials';
import { getModel, getCarModel, bogieModel, ModelGeo, getTramSection, tramSections, tramRoles, TramRole, TRAM_GAP, isRoadCoach, coachEra, getRoadCoach, getEmuCar, EMU_GAP, EmuRole, lrvStyle } from './vehicle-models';
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
/** Below this many pixels a vehicle is not drawn at all (whole-map views of big maps). */
const MIN_PX = 1.2;

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
 * One rendered car of a train. Multiple units (EMU / metro / high-speed / light rail) are bought as whole units
 * (one VehicleModel of `unitCars` cars); they render as their individual cars, close-coupled, cab cars facing
 * out of the unit (end 1: towards the head, -1: towards the tail).
 */
export interface CarSlot {
  m: VehicleModel;
  len: number;
  /** gap to the next car */
  gap: number;
  /** multiple-unit car: geometry by style / role, oriented by `end` (not by the train's reversal) */
  emu: boolean;
  /** geometry (filled in by the view) */
  geo?: ModelGeo;
  end: number;
  role: EmuRole | TramRole;
  panto: boolean;
  /** light rail: tram-section style on rails */
  lrv: string | null;
}

/** Cars as rendered (units expanded); `out` is reused. */
export function trainSlots(cars: VehicleModel[], out: CarSlot[] = []): CarSlot[] {
  out.length = 0;
  for (const c of cars) {
    if (c.kind !== 'emu') { out.push({ m: c, len: c.length, gap: CAR_GAP, emu: false, end: 0, role: 'mid', panto: false, lrv: null }); continue; }
    const lrv = lrvStyle(c.style);
    const n = Math.max(1, Math.round(c.unitCars ?? c.sections ?? 1)), gap = lrv ? TRAM_GAP : EMU_GAP;
    const len = (c.length - gap * (n - 1)) / n;
    const hsr = c.style.startsWith('hsr');
    for (let k = 0; k < n; k++) {
      const end = n === 1 ? 0 : k === 0 ? 1 : k === n - 1 ? -1 : 0;
      // pantographs: metro / commuter units on the motor cars (every other middle car, not the cab ends: 4 cars
      // -> 1, 6 cars -> 2), two middle cars of a high-speed set, one per light-rail vehicle
      const mid = k > 0 && k < n - 1;
      const panto = lrv ? k === (n === 2 ? 0 : Math.floor(n / 2)) : hsr ? (k === 1 || k === n - 2) && mid : n <= 2 ? k === 0 : mid && k % 2 === 1;
      let role: EmuRole | TramRole;
      if (lrv) role = n === 1 ? 'single' : end !== 0 ? (panto ? 'cabp' : 'cab') : (panto ? 'midp' : 'mid');
      else role = n === 1 ? 'single' : end !== 0 ? 'cab' : 'mid';
      out.push({ m: c, len, gap: k < n - 1 ? gap : CAR_GAP, emu: true, end, role, panto, lrv });
    }
  }
  return out;
}

/**
 * Pose of every rendered car from two bogie points on the track (18 % / 82 % of the car), hidden where the
 * train is hidden (tunnels, depots). Without `slots` one car per vehicle model (locomotive-hauled trains).
 */
export function trainCarPoses(t: Train, out: CarPose[], slots?: CarSlot[], game?: Game): number {
  let off = 0;
  const point = (d: number, p: V3, dir?: V3) => {
    if (game) return game.vehicles.renderPointBehind(t, d, p, dir);
    const q = t.pointBehind(d, p, dir);
    return q ? { seg: q.seg, pos: q.sp } : null;
  };
  const n = slots ? slots.length : t.cars.length;
  // cars can only be hidden in tunnels or inside a depot
  let canHide = false;
  for (const s of t.segs) if (s.e < 0 || s.tunnels.length) { canHide = true; break; }
  for (let i = 0; i < n; i++) {
    const sl = slots ? slots[i] : null;
    const L = sl ? sl.len : t.cars[i].length, gap = sl ? sl.gap : CAR_GAP;
    const p = out[i] ?? (out[i] = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1, a: { x: 0, y: 0, z: 0 }, da: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 }, db: { x: 0, y: 0, z: 0 }, ea: -1, eb: -1, hidden: false });
    const ra = point(off + 0.18 * L, p.a, p.da);
    const rb = point(off + 0.82 * L, p.b, p.db);
    let hidden = false;
    if (canHide) {
      const rf = point(off, tE);
      if (rf && t.hiddenAt(rf.seg, rf.pos)) { const rr = point(off + L, tE); hidden = !!rr && t.hiddenAt(rr.seg, rr.pos); }
    }
    off += L + gap;
    if (!ra || !rb) { p.hidden = true; continue; }
    p.ea = ra.seg.e; p.eb = rb.seg.e;
    p.hidden = hidden;
    let fx = p.a.x - p.b.x, fy = p.a.y - p.b.y, fz = p.a.z - p.b.z;
    let l = Math.hypot(fx, fy, fz);
    if (l < 1e-6) { fx = p.da.x; fy = p.da.y; fz = p.da.z; l = Math.hypot(fx, fy, fz) || 1; }
    // locomotive-hauled cars keep their orientation when the train reverses; multiple-unit cabs face out
    const sg = sl && sl.emu ? (sl.end < 0 ? -1 : 1) : t.reversed ? -1 : 1;
    p.fx = (fx / l) * sg; p.fy = (fy / l) * sg; p.fz = (fz / l) * sg;
    p.x = (p.a.x + p.b.x) / 2; p.y = (p.a.y + p.b.y) / 2 + RAIL_Y; p.z = (p.a.z + p.b.z) / 2;
  }
  return n;
}

/** Linear colour of vehicle glass (as the shared glass material). */
const GLASS_LIN = [srgbToLinear(0x1b / 255), srgbToLinear(0x27 / 255), srgbToLinear(0x30 / 255)];

/** Body and glass in one geometry (glass marked aPaint 3, untinted): one draw per vehicle batch. */
function withGlass(body: THREE.BufferGeometry, glass: THREE.BufferGeometry | null): THREE.BufferGeometry {
  if (!glass) return body;
  const bp = body.getAttribute('position'), gp = glass.getAttribute('position');
  const nb = bp.count, n = nb + gp.count;
  const pos = new Float32Array(n * 3), nrm = new Float32Array(n * 3), col = new Float32Array(n * 3), paint = new Float32Array(n);
  pos.set(bp.array as Float32Array, 0); pos.set(gp.array as Float32Array, nb * 3);
  nrm.set(body.getAttribute('normal').array as Float32Array, 0); nrm.set(glass.getAttribute('normal').array as Float32Array, nb * 3);
  const bc = body.getAttribute('color');
  if (bc) col.set(bc.array as Float32Array, 0); else col.fill(1, 0, nb * 3);
  for (let i = nb; i < n; i++) { col[i * 3] = GLASS_LIN[0]; col[i * 3 + 1] = GLASS_LIN[1]; col[i * 3 + 2] = GLASS_LIN[2]; }
  const bpaint = body.getAttribute('aPaint');
  if (bpaint) paint.set(bpaint.array as Float32Array, 0);
  paint.fill(3, nb);
  const bi = body.index!.array, gi = glass.index!.array;
  const idx = n > 65535 ? new Uint32Array(bi.length + gi.length) : new Uint16Array(bi.length + gi.length);
  idx.set(bi, 0);
  for (let i = 0; i < gi.length; i++) idx[bi.length + i] = gi[i] + nb;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPaint', new THREE.BufferAttribute(paint, 1));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

class Batch {
  body: THREE.InstancedMesh;
  glass: THREE.InstancedMesh | null;
  ids: number[] = [];
  n = 0;
  /** per-instance accent colour (aPaint = 2), e.g. the operator's colour on trams */
  accentAttr: THREE.InstancedBufferAttribute | null = null;
  constructor(public geo: THREE.BufferGeometry, public glassGeo: THREE.BufferGeometry | null, private mat: THREE.Material, private glassMat: THREE.Material, private parent: THREE.Group, public cap = 32, public tinted = false, private shadow = true, public accent = false, private ownsGeo = false) {
    this.body = this.make(geo, mat, shadow);
    this.glass = glassGeo ? this.make(glassGeo, glassMat, false) : null;
    if (accent) this.setAccent(null);
  }
  private setAccent(old: Float32Array | null) {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(this.cap * 3).fill(1), 3);
    a.setUsage(THREE.DynamicDrawUsage);
    if (old) a.array.set(old.subarray(0, Math.min(old.length, a.array.length)));
    this.geo.setAttribute('aAccent', a);
    this.accentAttr = a;
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
    if (this.accent) this.setAccent(this.accentAttr ? (this.accentAttr.array as Float32Array) : null);
  }
  /** Reserve the next instance slot; returns the matrix offset. */
  push(id: number): number {
    if (this.n >= this.cap) this.grow();
    this.ids[this.n] = id;
    return this.n++ * 16;
  }
  get mat16() { return this.body.instanceMatrix.array as Float32Array; }
  get col3() { return this.body.instanceColor!.array as Float32Array; }
  get acc3() { return this.accentAttr!.array as Float32Array; }
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
      if (this.accentAttr) {
        this.accentAttr.clearUpdateRanges();
        this.accentAttr.addUpdateRange(0, n * 3);
        this.accentAttr.needsUpdate = true;
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
    // Merged body/glass geometry belongs to this batch; cached models and bogies are shared.
    if (this.ownsGeo) this.geo.dispose();
  }
}

interface BatchPair { hi: Batch; lo: Batch; ambient: boolean }
interface TramInfo { n: number; sec: number; roles: TramRole[]; style: string }

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
  /** Stable lane / connector ids, invalidated by network edits and pruned when no longer used. */
  private profileRanges = new Map<string, { ranges: Float32Array; used: number }>();
  private profileVersion = -1;
  private layouts = new WeakMap<Train, { cars: VehicleModel[]; slots: CarSlot[] }>();
  private tick = 0;
  private rpose = { x: 0, y: 0, z: 0, fx: 0, fy: 0, fz: 1 };
  private game: Game | null = null;
  private tramInfo = new WeakMap<VehicleModel, TramInfo>();
  private colors = new Map<number | string, Float32Array>();
  private tmpMain = new Float32Array(3);

  constructor(private mats: Materials) {
    this.paintMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.3 });
    this.paintMat.onBeforeCompile = (sh) => {
      sh.uniforms.uRfNight = this.mats.uniforms.uNight;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPaint;\nattribute vec3 aAccent;\nvarying float vRfGlass;')
        .replace('#include <color_vertex>', `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec3( 1.0 );
#endif
#ifdef USE_COLOR
  vColor *= color;
#endif
#ifdef USE_INSTANCING_COLOR
  // aPaint 1: main livery (instance colour), 2: accent (per-instance aAccent), 3: glass (untinted)
  vec3 rfTint = aPaint > 1.5 ? aAccent : instanceColor.xyz;
  vColor.xyz *= mix(vec3(1.0), rfTint, aPaint > 2.5 ? 0.0 : min(aPaint, 1.0));
#endif
vRfGlass = step(2.5, aPaint);`);
      // glass is part of the body draw: smooth, metallic-looking, lit from inside at night
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uRfNight;\nvarying float vRfGlass;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.12, vRfGlass);')
        .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.6, vRfGlass);')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.85, 0.55) * uRfNight * 0.35 * vRfGlass;');
    };
    this.paintMat.customProgramCacheKey = () => 'rf-vehicle-paint-3';
    applyClouds(this.paintMat);
    this.bogies = {
      b2: new Batch(bogieModel('b2'), null, this.paintMat, mats.glass, this.group, 128),
      b3: new Batch(bogieModel('b3'), null, this.paintMat, mats.glass, this.group, 32),
    };
    this.group.add(this.smoke.points, this.lights.points);
  }

  private model(m: VehicleModel): ModelGeo {
    let g = this.models.get(m);
    if (!g) {
      g = isRoadCoach(m) ? getRoadCoach(coachEra(m.style, m.intro), m.length) : getModel(m.style, m.color, m.length);
      this.models.set(m, g);
    }
    return g;
  }

  private pair(m: ModelGeo, ambient = false, livery = false): BatchPair {
    let p = this.batches.get(m);
    if (!p) {
      const tint = ambient || livery;
      const hi = withGlass(m.body, m.glass), lo = withGlass(m.lo.body, m.lo.glass);
      p = {
        hi: new Batch(hi, null, this.paintMat, this.mats.glass, this.group, ambient ? 64 : 16, tint, true, livery, hi !== m.body),
        lo: new Batch(lo, null, this.paintMat, this.mats.glass, this.group, ambient ? 128 : 16, tint, !ambient, livery, lo !== m.lo.body),
        ambient,
      };
      this.batches.set(m, p);
    }
    return p;
  }

  /**
   * Visible (with a margin for shadows) and detailed enough for the high LOD? 0 culled (outside the view or
   * under ~1 px), 1 lo, 2 hi.
   */
  private lod(x: number, y: number, z: number, len: number): number {
    if (!this.cull) return 2;
    this.sphere.center.set(x, y, z);
    this.sphere.radius = len / 2 + 1.2;
    if (!this.frustum.intersectsSphere(this.sphere)) return 0;
    const d = Math.hypot(x - this.camPos.x, y - this.camPos.y, z - this.camPos.z);
    const px = len * this.pxScale;
    return px > HI_PX * d ? 2 : px > MIN_PX * d ? 1 : 0;
  }

  update(game: Game, dt: number, light: number, pointScale = 1200, camera?: THREE.Camera) {
    const night = this.mats.uniforms.uNight.value;
    if (this.game !== game || this.profileVersion !== game.world.net.version) {
      this.profileRanges.clear();
      this.profileVersion = game.world.net.version;
    }
    this.game = game;
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
      for (const [key, entry] of this.profileRanges) if (this.tick - entry.used >= 256) this.profileRanges.delete(key);
    }
  }

  private updateTrain(t: Train, dt: number, night: number) {
    if (!t.onMap) return;
    if (this.cull) {
      const len = t.length;
      if (!this.game!.vehicles.renderPointBehind(t, len / 2, tE) || !this.lod(tE.x, tE.y, tE.z, len)) { this.lastSpeed.set(t.id, t.speed); return; }
    }
    const slots = this.trainLayout(t);
    const n = trainCarPoses(t, this.poses, slots, this.game!);
    const prev = this.lastSpeed.get(t.id) ?? t.speed;
    this.lastSpeed.set(t.id, t.speed);
    const accel = dt > 0 ? (t.speed - prev) / dt : 0;
    const active = t.state === 'running' || t.state === 'waiting' || t.state === 'loading';
    for (let i = 0; i < n; i++) {
      const p = this.poses[i];
      if (p.hidden) continue;
      const sl = slots[i], cm = sl.m;
      const m = this.slotGeo(sl);
      const lod = this.lod(p.x, p.y, p.z, sl.len);
      if (!lod) continue;
      const bp = this.pair(m, false, sl.emu);
      const b = lod === 2 ? bp.hi : bp.lo;
      const o = b.push(t.id);
      writeBasis(b.mat16, o, p.x, p.y, p.z, p.fx, p.fy, p.fz);
      if (sl.emu) this.unitLivery(b, o, cm, t.owner);
      if (lod === 2) for (const bz of m.bogies) {
        const front = (bz > 0) !== (sl.emu ? sl.end < 0 : t.reversed);
        const q = front ? p.a : p.b, d = front ? p.da : p.db;
        const bb = this.bogies[m.bogieKind];
        writeBasis(bb.mat16, bb.push(t.id), q.x, q.y + RAIL_Y, q.z, d.x, d.y, d.z);
      }
      if (active && m.chimney) this.emitSteam(t.id, b.mat16, o, m.chimney, t.speed, p, dt, t.reversed);
      if (active && m.exhaust) this.emitExhaust(t.id, b.mat16, o, m.exhaust, t.speed, accel, dt);
    }
    if (night > 0.02 && n > 0) {
      // white lamps on the leading face, red on the trailing face (hauled cars keep their orientation when the
      // train reverses; multiple-unit cab cars face out of the unit)
      const hs = slots[0], h = this.poses[0], hm = this.slotGeo(hs);
      if (!h.hidden) this.lamps(h, hs.emu ? hm.front : t.reversed ? hm.rear : hm.front, 1, 0.93, 0.78);
      const rs = slots[n - 1], r = this.poses[n - 1], rm = this.slotGeo(rs);
      if (!r.hidden) this.lamps(r, rs.emu ? (rs.end < 0 ? rm.front : rm.rear) : t.reversed ? rm.front : rm.rear, 1, 0.06, 0.03);
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
    const vehicles = this.game!.vehicles;
    if (this.cull) {
      const len = v.length;
      vehicles.renderPointBehind(v, len / 2, tE);
      if (!this.lod(tE.x, tE.y, tE.z, len)) return;
    }
    if (v.model && v.model.kind === 'tram') { this.updateTram(v, v.model, night); return; }
    const L = v.length;
    const f = vehicles.renderPointBehind(v, 0, tA), r = vehicles.renderPointBehind(v, L, tB);
    if (!f || !r) return;
    if (v.hiddenAt(f.seg, f.pos) && v.hiddenAt(r.seg, r.pos)) return;
    tA.y = this.surfaceY(f.seg, f.pos, tA.x, tA.z, tA.y);
    tB.y = this.surfaceY(r.seg, r.pos, tB.x, tB.z, tB.y);
    let fx = tA.x - tB.x, fy = tA.y - tB.y, fz = tA.z - tB.z;
    const l = Math.hypot(fx, fy, fz);
    if (l < 1e-6) return;
    fx /= l; fy /= l; fz /= l;
    const px = (tA.x + tB.x) / 2, py = (tA.y + tB.y) / 2 + ROAD_Y, pz = (tA.z + tB.z) / 2;
    const lod = this.lod(px, py, pz, L);
    if (!lod) return;
    const m = v.model ? this.model(v.model) : getCarModel(Math.max(0, Math.min(3, v.style | 0)));
    const coach = !!v.model && isRoadCoach(v.model);
    const bp = this.pair(m, !v.model, coach);
    const b = lod === 2 ? bp.hi : bp.lo;
    const o = b.push(v.ambient ? -1 : v.id);
    writeBasis(b.mat16, o, px, py, pz, fx, fy, fz);
    if (coach) this.coachLivery(b, o, v.model!, v.owner);
    else if (b.tinted) {
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

  /** Rendered cars of a train (units expanded), rebuilt when its vehicles or their order change. */
  private trainLayout(t: Train): CarSlot[] {
    let e = this.layouts.get(t);
    if (e && e.cars.length === t.cars.length) {
      let same = true;
      for (let i = 0; i < t.cars.length; i++) if (e.cars[i] !== t.cars[i]) { same = false; break; }
      if (same) return e.slots;
    }
    e = { cars: t.cars.slice(), slots: trainSlots(t.cars) };
    this.layouts.set(t, e);
    return e.slots;
  }

  private slotGeo(sl: CarSlot): ModelGeo {
    if (!sl.geo) {
      sl.geo = !sl.emu ? this.model(sl.m)
        : sl.lrv ? getTramSection(sl.lrv, sl.role as TramRole, sl.len)
        : getEmuCar(sl.m.style, sl.role as EmuRole, sl.len, sl.panto);
    }
    return sl.geo;
  }

  /** Multiple units: body in the model colour, bands / accents in the operator's colour. */
  private unitLivery(b: Batch, o: number, m: VehicleModel, owner: number) {
    const main = this.lin(m.color), acc = this.lin(this.game ? this.game.company(owner).color : '#e8a33d');
    const ci = (o / 16) * 3, c = b.col3, a = b.acc3;
    c[ci] = main[0]; c[ci + 1] = main[1]; c[ci + 2] = main[2];
    a[ci] = acc[0]; a[ci + 1] = acc[1]; a[ci + 2] = acc[2];
  }

  /**
   * Coach livery in the operator's colour: stripes / swoosh / lower panels take the operator colour, the body
   * a light neutral tinted by the model colour (so models still differ). When the operator colour is itself
   * that light, the body turns charcoal to keep the contrast.
   */
  private coachLivery(b: Batch, o: number, m: VehicleModel, owner: number) {
    const mc = this.lin(m.color), cream = this.lin(0xf3efe6), main = this.tmpMain;
    for (let i = 0; i < 3; i++) main[i] = mc[i] * 0.28 + cream[i] * 0.72;
    const acc = this.lin(this.game ? this.game.company(owner).color : '#e8a33d');
    // perceived lightness (CIE L*) of body and livery too close: charcoal body
    const Ls = (c: Float32Array) => 116 * Math.cbrt(0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) - 16;
    if (Math.abs(Ls(main) - Ls(acc)) < 20) main.set(this.lin(0x2e3438));
    const ci = (o / 16) * 3, c = b.col3, a = b.acc3;
    c[ci] = main[0]; c[ci + 1] = main[1]; c[ci + 2] = main[2];
    a[ci] = acc[0]; a[ci + 1] = acc[1]; a[ci + 2] = acc[2];
  }

  /**
   * Height of the road surface under a wheel: on ground sections roads are draped on the terrain (exact
   * surface + ROAD_DRAPE), on bridge / tunnel sections they keep the edge profile; around section ends, level
   * crossings and structures at the edge ends the drape blends into the profile over 1 unit (smoothstep) -
   * the same rule as the static road drape (build-road blendPoints), so wheels sit on the drawn surface.
   */
  private surfaceY(seg: RSeg, pos: number, x: number, z: number, profileY: number): number {
    const g = this.game;
    if (!g || !g.world) return profileY;
    const r = this.rangesOf(seg);
    let k = 0;
    for (let i = 0; i < r.length; i += 2) {
      const d = pos < r[i] ? r[i] - pos : pos > r[i + 1] ? pos - r[i + 1] : 0;
      if (d < 1) { const t = 1 - d, w = t * t * (3 - 2 * t); if (w > k) k = w; }
    }
    if (k >= 1) return profileY;
    const drape = g.world.heightAt(x, z) + ROAD_DRAPE;
    return k <= 0 ? drape : drape + (profileY - drape) * k;
  }

  /** Lane-position ranges on the profile (structures; single points for crossings / structure ends). */
  private rangesOf(seg: RSeg): Float32Array {
    const key = seg.kind === 'lane' ? `lane:${seg.e}:${seg.dir}` : `conn:${seg.node}:${seg.from}:${seg.fromDir}:${seg.e}:${seg.dir}`;
    const entry = this.profileRanges.get(key);
    if (entry) { entry.used = this.tick; return entry.ranges; }
    const g = this.game!, net = g.world.net, out: number[] = [];
    if (seg.kind === 'lane') {
      const e = net.edges.get(seg.e);
      if (e) {
        // lane position <-> edge arc length as for the lane's tunnel ranges (roadvehicle.makeLaneSeg)
        const [s0, s1] = laneTrim(g, e);
        const map = (s: number) => (seg.dir > 0 ? s - s0 : s1 - s);
        const range = (a: number, b: number) => { const p = map(a), q = map(b); out.push(Math.min(p, q), Math.max(p, q)); };
        for (const sec of e.sections) range(sec.s0, sec.s1);
        for (const c of net.crossings.values()) if (c.kind === 'level' && c.e2 === e.id) range(c.s2, c.s2);
        for (const [nid, sAt] of [[e.a, 0], [e.b, e.len]] as [number, number][]) {
          const node = net.nodes.get(nid);
          if (!node) continue;
          for (const id of node.edges) {
            const f = id === e.id ? null : net.edges.get(id);
            if (f && net.sectionAt(f, f.a === nid ? 0.01 : f.len - 0.01) !== 'ground') { range(sAt, sAt); break; }
          }
        }
      }
    } else {
      // junction connector: on the profile when an edge it joins is off the ground at the junction
      const off = (eid: number, atStart: boolean) => { const e = net.edges.get(eid); return !!e && net.sectionAt(e, atStart ? 0.01 : e.len - 0.01) !== 'ground'; };
      if (off(seg.e, seg.dir > 0) || off(seg.from, seg.fromDir < 0)) out.push(-1e9, 1e9);
    }
    const r = new Float32Array(out);
    this.profileRanges.set(key, { ranges: r, used: this.tick });
    return r;
  }

  /** Sections, their length and roles for a tram model (cached). */
  private tram(m: VehicleModel): TramInfo {
    let t = this.tramInfo.get(m);
    if (!t) {
      const n = tramSections(m.style, m.length, (m as VehicleModel & { sections?: number }).sections);
      t = { n, sec: Math.max(0.2, (m.length - TRAM_GAP * (n - 1)) / n), roles: tramRoles(m.style, n), style: m.style };
      this.tramInfo.set(m, t);
    }
    return t;
  }

  /** Linear RGB of a colour (number or '#rrggbb'), cached. */
  private lin(c: number | string): Float32Array {
    let v = this.colors.get(c);
    if (!v) {
      const h = typeof c === 'number' ? c : parseInt(String(c).replace('#', ''), 16) || 0xcccccc;
      v = new Float32Array([srgbToLinear(((h >> 16) & 255) / 255), srgbToLinear(((h >> 8) & 255) / 255), srgbToLinear((h & 255) / 255)]);
      this.colors.set(c, v);
    }
    return v;
  }

  /**
   * Articulated tram: every section rests on its own two points along the lane path (so the sections
   * follow curves through junctions); the rear cab faces backwards; livery in the model colour with the
   * operator's colour as accent.
   */
  private updateTram(v: RoadVehicle, m: VehicleModel, night: number) {
    const t = this.tram(m);
    const vehicles = this.game!.vehicles;
    const main = this.lin(m.color);
    const acc = this.lin(this.game ? this.game.company(v.owner).color : '#e8a33d');
    let off = 0;
    for (let i = 0; i < t.n; i++, off += t.sec + TRAM_GAP) {
      const f = vehicles.renderPointBehind(v, off, tE), r = vehicles.renderPointBehind(v, off + t.sec, tE);
      if (!f || !r || (v.hiddenAt(f.seg, f.pos) && v.hiddenAt(r.seg, r.pos))) continue;
      const front = vehicles.renderPointBehind(v, off + t.sec * 0.15, tA);
      const rear = vehicles.renderPointBehind(v, off + t.sec * 0.85, tB);
      if (!front || !rear) continue;
      tA.y = this.surfaceY(front.seg, front.pos, tA.x, tA.z, tA.y);
      tB.y = this.surfaceY(rear.seg, rear.pos, tB.x, tB.z, tB.y);
      let fx = tA.x - tB.x, fy = tA.y - tB.y, fz = tA.z - tB.z;
      const l = Math.hypot(fx, fy, fz);
      if (l < 1e-6) continue;
      fx /= l; fy /= l; fz /= l;
      const flip = t.n > 1 && i === t.n - 1;
      if (flip) { fx = -fx; fy = -fy; fz = -fz; }
      const px = (tA.x + tB.x) / 2, py = (tA.y + tB.y) / 2 + ROAD_Y, pz = (tA.z + tB.z) / 2;
      const lod = this.lod(px, py, pz, t.sec);
      if (!lod) continue;
      const geo = getTramSection(t.style, t.roles[i], t.sec);
      const bp = this.pair(geo, false, true);
      const b = lod === 2 ? bp.hi : bp.lo;
      const o = b.push(v.id);
      writeBasis(b.mat16, o, px, py, pz, fx, fy, fz);
      const ci = (o / 16) * 3, c = b.col3, a = b.acc3;
      c[ci] = main[0]; c[ci + 1] = main[1]; c[ci + 2] = main[2];
      a[ci] = acc[0]; a[ci + 1] = acc[1]; a[ci + 2] = acc[2];
      if (night > 0.02) {
        const pose = this.rpose;
        pose.x = px; pose.y = py; pose.z = pz; pose.fx = fx; pose.fy = fy; pose.fz = fz;
        if (i === 0) this.lamps(pose, geo.front, 1, 0.94, 0.8);
        if (i === t.n - 1) this.lamps(pose, t.n === 1 ? geo.rear : geo.front, 0.9, 0.05, 0.03);
      }
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
    this.paintMat.dispose();
    this.smoke.mat.dispose();
    this.lights.mat.dispose();
    this.profileRanges.clear();
  }
}
