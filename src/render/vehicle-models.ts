// Procedural vehicle models at real scale (1 unit = 10 m), with low-detail LODs.
// Local frame: +z forward (nose), y up, x lateral; origin at rail top / road surface, centre of the vehicle.
import * as THREE from 'three';
import { GeoBuilder } from './geo';

export interface LampSet { white: [number, number, number][]; red: [number, number, number][] }

export interface ModelGeo {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  /** low-detail version for distant views */
  lo: { body: THREE.BufferGeometry; glass: THREE.BufferGeometry };
  length: number;
  /** chimney top (steam) for smoke emission */
  chimney?: THREE.Vector3;
  /** diesel exhaust outlets */
  exhaust?: THREE.Vector3[];
  /** lamps on the front (+z) and rear (-z) faces */
  front: [number, number, number][];
  rear: [number, number, number][];
  /** z offsets of separately drawn bogies (empty when the running gear is part of the body) */
  bogies: number[];
  bogieKind: 'b2' | 'b3';
}

/** Rail car body width, bogie pivot as a fraction of the car length (matches the renderer's placement). */
export const RAIL_W = 0.29;
export const BOGIE_F = 0.32;
type P2 = [number, number];

/** Builder that tracks which vertices take the per-instance paint colour (aPaint = 1). */
class MB {
  gb = new GeoBuilder();
  gl = new GeoBuilder();
  private ranges: [number, number, number][] = [];
  private p0 = -1;
  private pv = 1;
  /** Following vertices take the main paint (instance colour). */
  paint(on: boolean) { return this.mark(on, 1); }
  /** Following vertices take the accent colour (aPaint = 2, e.g. the operator's colour). */
  accent(on: boolean) { return this.mark(on, 2); }
  private mark(on: boolean, v: number) {
    if (this.p0 >= 0) { this.ranges.push([this.p0, this.gb.vertexCount, this.pv]); this.p0 = -1; }
    if (on) { this.p0 = this.gb.vertexCount; this.pv = v; }
    return this;
  }
  build(): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
    this.mark(false, 0);
    const body = this.gb.build();
    const a = new Float32Array(this.gb.vertexCount);
    for (const [s, e, v] of this.ranges) a.fill(v, s, e);
    body.setAttribute('aPaint', new THREE.BufferAttribute(a, 1));
    if (this.gl.empty) this.gl.color(0xffffff).quad(0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0);
    return { body, glass: this.gl.build() };
  }
}

// ------------------------------------------------------------------------------------ primitives

/**
 * Prism: convex profile (x lateral, y up; CCW seen from +z) extruded from z0 to z1, with end caps.
 * Edges meeting at less than `crease` radians are shaded smooth.
 */
function prism(gb: GeoBuilder, z0: number, z1: number, pts: P2[], crease = 0.6, caps = true) {
  const n = pts.length;
  const en: P2[] = [];
  for (let i = 0; i < n; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % n];
    const l = Math.hypot(bx - ax, by - ay) || 1;
    en.push([(by - ay) / l, -(bx - ax) / l]);
  }
  // normal of edge e at its start or end vertex: smooth with the neighbouring edge below the crease angle
  const vn = (e: number, atStart: boolean): P2 => {
    const a = en[e], b = en[atStart ? (e - 1 + n) % n : (e + 1) % n];
    if (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) > crease) return a;
    const x = a[0] + b[0], y = a[1] + b[1], l = Math.hypot(x, y) || 1;
    return [x / l, y / l];
  };
  for (let e = 0; e < n; e++) {
    const [ax, ay] = pts[e], [bx, by] = pts[(e + 1) % n];
    const na = vn(e, true), nb = vn(e, false);
    const base = gb.vertexCount;
    gb.vertex(ax, ay, z0, na[0], na[1], 0);
    gb.vertex(bx, by, z0, nb[0], nb[1], 0);
    gb.vertex(bx, by, z1, nb[0], nb[1], 0);
    gb.vertex(ax, ay, z1, na[0], na[1], 0);
    gb.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  if (!caps) return;
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  for (const [z, s] of [[z1, 1], [z0, -1]] as const) {
    const c = gb.vertex(cx, cy, z, 0, 0, s);
    const ring = pts.map(([x, y]) => gb.vertex(x, y, z, 0, 0, s));
    for (let i = 0; i < n; i++) {
      if (s > 0) gb.idx.push(c, ring[i], ring[(i + 1) % n]);
      else gb.idx.push(c, ring[(i + 1) % n], ring[i]);
    }
  }
}

/** Rounded-top cross-section: straight sides from y0 to the eave yE, arc up to yT (halfW at the eave). */
function roofProfile(halfW: number, y0: number, yE: number, yT: number, flat = 0.45): P2[] {
  const r: P2[] = [[-halfW, y0], [halfW, y0], [halfW, yE]];
  const k = [0.25, 0.55, 0.8];
  const rise = yT - yE;
  for (const f of k) r.push([halfW * (1 - f * (1 - flat)), yE + rise * Math.sin((f * Math.PI) / 2)]);
  r.push([halfW * flat, yT], [-halfW * flat, yT]);
  for (let i = k.length - 1; i >= 0; i--) r.push([-halfW * (1 - k[i] * (1 - flat)), yE + rise * Math.sin((k[i] * Math.PI) / 2)]);
  r.push([-halfW, yE]);
  return r;
}

/** Disc facing +z (s = 1) or -z (s = -1). */
function disc(gb: GeoBuilder, x: number, y: number, z: number, r: number, s: number, seg = 12) {
  const c = gb.vertex(x, y, z, 0, 0, s);
  const ring: number[] = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push(gb.vertex(x + Math.cos(a) * r, y + Math.sin(a) * r, z, 0, 0, s)); }
  for (let i = 0; i < seg; i++) {
    if (s > 0) gb.idx.push(c, ring[i], ring[(i + 1) % seg]);
    else gb.idx.push(c, ring[(i + 1) % seg], ring[i]);
  }
}

/** Disc facing +x (s = 1) or -x (s = -1). */
function discX(gb: GeoBuilder, x: number, y: number, z: number, r: number, s: number, seg = 12) {
  const c = gb.vertex(x, y, z, s, 0, 0);
  const ring: number[] = [];
  for (let i = 0; i < seg; i++) { const a = (i / seg) * Math.PI * 2; ring.push(gb.vertex(x, y + Math.sin(a) * r, z + Math.cos(a) * r, s, 0, 0)); }
  for (let i = 0; i < seg; i++) {
    if (s > 0) gb.idx.push(c, ring[(i + 1) % seg], ring[i]);
    else gb.idx.push(c, ring[i], ring[(i + 1) % seg]);
  }
}

/** Wheel pair on an axle at z (radius r, centre at height r) with outer faces and hubs. */
function axle(gb: GeoBuilder, z: number, r: number, half = 0.072, width = 0.016, color = 0x1d1d1d, seg = 12, hub = 0x6a6a6a) {
  for (const sx of [-1, 1]) {
    const xi = sx * (half - width / 2), xo = sx * (half + width / 2);
    gb.color(color);
    gb.tube(xi, r, z, xo, r, z, r, seg);
    discX(gb, xo, r, z, r * 0.98, sx, seg);
    gb.color(hub);
    gb.tube(xo, r, z, xo + sx * 0.008, r, z, r * 0.3, 6);
    discX(gb, xo + sx * 0.008, r, z, r * 0.3, sx, 6);
  }
  gb.color(0x2a2a2a);
  gb.tube(-half, r, z, half, r, z, 0.01, 5);
}

/** Pair of side buffers at the end z (dir = +1 front, -1 rear). */
function buffers(gb: GeoBuilder, z: number, dir: number, y = 0.105) {
  gb.color(0x1c1c1c);
  for (const x of [-0.0875, 0.0875]) {
    gb.tube(x, y, z, x, y, z + dir * 0.05, 0.016, 8);
    gb.color(0x3a3a3a);
    gb.tube(x, y, z + dir * 0.05, x, y, z + dir * 0.058, 0.026, 10);
    disc(gb, x, y, z + dir * 0.058, 0.026, dir, 10);
    gb.color(0x1c1c1c);
  }
  gb.box(0, y - 0.012, z + dir * 0.03, 0.03, 0.024, 0.06);
}

/** Side window strip along both sides (glass). */
function windowBand(gl: GeoBuilder, z0: number, z1: number, y0: number, y1: number, halfW: number, segs: number, gap = 0.02) {
  gl.color(0xffffff);
  const len = (z1 - z0 - gap * (segs - 1)) / segs;
  for (let i = 0; i < segs; i++) {
    const a = z0 + i * (len + gap), b = a + len;
    gl.quad(halfW, y0, b, halfW, y0, a, halfW, y1, a, halfW, y1, b);
    gl.quad(-halfW, y0, a, -halfW, y0, b, -halfW, y1, b, -halfW, y1, a);
  }
}

/** Window on an end face at z (facing +z, or -z when back). */
function endWindow(gl: GeoBuilder, z: number, y0: number, y1: number, hw: number, back = false, cx = 0) {
  gl.color(0xffffff);
  if (back) gl.quad(cx + hw, y0, z, cx - hw, y0, z, cx - hw, y1, z, cx + hw, y1, z);
  else gl.quad(cx - hw, y0, z, cx + hw, y0, z, cx + hw, y1, z, cx - hw, y1, z);
}

/** Box tapered towards +z: cross-section (w0,h0) at z0 (bottom y0) to (w1,h1) at z1 (bottom y1). */
function taper(gb: GeoBuilder, z0: number, z1: number, y0: number, w0: number, h0: number, w1: number, h1: number, y1 = y0) {
  const a = [[-w0 / 2, y0, z0], [w0 / 2, y0, z0], [w0 / 2, y0 + h0, z0], [-w0 / 2, y0 + h0, z0]];
  const b = [[-w1 / 2, y1, z1], [w1 / 2, y1, z1], [w1 / 2, y1 + h1, z1], [-w1 / 2, y1 + h1, z1]];
  const Q = (p: number[], q: number[], r: number[], s: number[]) => gb.quad(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], s[0], s[1], s[2]);
  Q(b[0], b[1], b[2], b[3]);
  Q(a[3], b[3], b[2], a[2]);
  Q(a[1], a[2], b[2], b[1]);
  Q(b[0], b[3], a[3], a[0]);
}

/** Single-arm pantograph raised to the contact wire (local y ~0.55 above the rail head). */
function pantograph(gb: GeoBuilder, z: number, roofY: number) {
  gb.color(0x2f2f2f);
  gb.box(0, roofY, z, 0.12, 0.012, 0.16);
  for (const x of [-0.05, 0.05]) { gb.color(0x9a9a9a); gb.cylinder(x, roofY + 0.012, z - 0.06, 0.008, 0.014, 6); gb.cylinder(x, roofY + 0.012, z + 0.06, 0.008, 0.014, 6); }
  gb.color(0x3c3c3c);
  const y0 = roofY + 0.03, yk = roofY + 0.085, yh = 0.548;
  gb.tube(0, y0, z - 0.05, 0, yk, z + 0.08, 0.006, 5);
  gb.tube(0, yk, z + 0.08, 0, yh, z - 0.02, 0.004, 5);
  gb.color(0x555555);
  gb.box(0, yh, z - 0.02, 0.18, 0.008, 0.016);
  gb.box(0.09, yh - 0.01, z - 0.02, 0.012, 0.012, 0.012);
  gb.box(-0.09, yh - 0.01, z - 0.02, 0.012, 0.012, 0.012);
}

/** Bogie (drawn as separate instances so it follows the track on curves). */
export function bogieModel(kind: 'b2' | 'b3' = 'b2'): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  const axles = kind === 'b3' ? [-0.2, 0, 0.2] : [-0.125, 0.125];
  const len = kind === 'b3' ? 0.52 : 0.36;
  gb.color(0x2b2b2b);
  gb.box(0, 0.04, 0, 0.12, 0.035, len - 0.06);
  gb.color(0x333333);
  for (const sx of [-1, 1]) {
    gb.box(sx * 0.098, 0.03, 0, 0.014, 0.05, len);
    gb.color(0x252525);
    for (const z of axles) gb.box(sx * 0.1, 0.03, z, 0.026, 0.034, 0.05);
    gb.color(0x4a4a4a);
    for (let k = 0; k < axles.length - 1; k++) gb.cylinder(sx * 0.098, 0.065, (axles[k] + axles[k + 1]) / 2, 0.012, 0.03, 6);
    gb.color(0x333333);
  }
  for (const z of axles) axle(gb, z, 0.046, 0.072, 0.016, 0x1d1d1d, 12, 0x555555);
  return gb.build();
}

/** Low-detail body: box with roof, optional nose taper, window band. */
function loBody(color: number, roof: number, L: number, W: number, y0: number, yE: number, yT: number, win: [number, number] | null, nose = 0, under = 0x262626): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
  const m = new MB(), gb = m.gb;
  const hl = L / 2 - 0.02;
  gb.color(under);
  gb.box(0, Math.max(0.0, y0 - 0.06), 0, W * 0.75, 0.06, hl * 2 - 0.2);
  gb.color(color);
  gb.box(0, y0, -nose / 2, W, yE - y0, hl * 2 - nose);
  if (nose > 0) taper(gb, hl - nose, hl, y0, W, yE - y0, W * 0.5, (yE - y0) * 0.45, y0 + 0.01);
  gb.color(roof);
  gb.box(0, yE, -nose / 2, W * 0.86, yT - yE, hl * 2 - nose - 0.02);
  if (win) windowBand(m.gl, -hl + 0.08, hl - 0.08 - nose, win[0], win[1], W / 2 + 0.002, 1, 0);
  return m.build();
}

// ------------------------------------------------------------------------------------ rail vehicles

function coach(style: string, color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02, W = RAIL_W, hw = W / 2;
  const wood = style === 'coach_wood', steel = style === 'coach_steel', ic = style === 'coach_ic', hs = style === 'coach_hs';
  const roofCol = wood ? 0x3d3a37 : steel ? 0x55595d : ic ? 0xa9aeb3 : 0xd5d9dd;
  const y0 = hs ? 0.08 : 0.115, yE = wood ? 0.36 : 0.372, yT = wood ? 0.395 : 0.425;
  // body shell
  gb.color(color);
  prism(gb, -hl, hl, [[-hw, y0], [hw, y0], [hw, yE], [-hw, yE]], 0.2);
  // roof
  gb.color(roofCol);
  prism(gb, -hl + 0.01, hl - 0.01, roofProfile(hw - 0.003, yE - 0.001, yE + 0.004, yT, wood ? 0.6 : 0.45), 0.7);
  if (wood) {
    // clerestory with small windows
    gb.color(0x34312e);
    gb.box(0, yT - 0.005, 0, 0.13, 0.035, hl * 2 - 0.3);
    gl.color(0xffffff);
    for (const sx of [-1, 1]) for (let z = -hl + 0.2; z < hl - 0.2; z += 0.1) gl.quad(sx * 0.0655, yT + 0.008, z + (sx > 0 ? 0.06 : 0), sx * 0.0655, yT + 0.008, z + (sx > 0 ? 0 : 0.06), sx * 0.0655, yT + 0.024, z + (sx > 0 ? 0 : 0.06), sx * 0.0655, yT + 0.024, z + (sx > 0 ? 0.06 : 0));
    // panelling: dark beading and a lining stripe
    gb.color(0x5a2a16);
    for (let z = -hl + 0.12; z < hl - 0.05; z += 0.12) { gb.box(hw + 0.001, y0 + 0.01, z, 0.003, yE - y0 - 0.02, 0.01); gb.box(-hw - 0.001, y0 + 0.01, z, 0.003, yE - y0 - 0.02, 0.01); }
    gb.color(0xd9b98c);
    gb.box(0, 0.335, 0, W + 0.006, 0.01, hl * 2 - 0.03);
    // footboards and truss rods
    gb.color(0x2a2a2a);
    gb.box(hw + 0.012, 0.1, 0, 0.025, 0.01, hl * 2 - 0.4);
    gb.box(-hw - 0.012, 0.1, 0, 0.025, 0.01, hl * 2 - 0.4);
    gb.color(0x1f1f1f);
    gb.tube(0.07, 0.1, -hl + 0.3, 0.07, 0.04, -0.2, 0.006, 4); gb.tube(0.07, 0.04, -0.2, 0.07, 0.04, 0.2, 0.006, 4); gb.tube(0.07, 0.04, 0.2, 0.07, 0.1, hl - 0.3, 0.006, 4);
    gb.tube(-0.07, 0.1, -hl + 0.3, -0.07, 0.04, -0.2, 0.006, 4); gb.tube(-0.07, 0.04, -0.2, -0.07, 0.04, 0.2, 0.006, 4); gb.tube(-0.07, 0.04, 0.2, -0.07, 0.1, hl - 0.3, 0.006, 4);
  }
  if (steel) {
    gb.color(0xd8c690);
    gb.box(0, 0.218, 0, W + 0.005, 0.012, hl * 2 - 0.02);
    gb.box(0, 0.338, 0, W + 0.005, 0.012, hl * 2 - 0.02);
  }
  if (ic) {
    gb.color(0xc0392b);
    gb.box(0, 0.2, 0, W + 0.005, 0.024, hl * 2 - 0.02);
    gb.color(0x8e2a20);
    gb.box(0, 0.19, 0, W + 0.005, 0.005, hl * 2 - 0.02);
    // air conditioning on the roof
    gb.color(0x8f9499);
    gb.box(0, yT - 0.006, hl * 0.55, 0.15, 0.022, 0.32);
    gb.box(0, yT - 0.006, -hl * 0.55, 0.15, 0.022, 0.32);
  }
  if (hs) {
    gb.color(0x1f5fa8);
    gb.box(0, 0.205, 0, W + 0.005, 0.03, hl * 2 - 0.02);
    gb.color(0x163f75);
    gb.box(0, 0.11, 0, W + 0.005, 0.012, hl * 2 - 0.02);
    gb.color(0xbfc4c9);
    gb.box(0, yT - 0.006, 0, 0.1, 0.012, hl * 2 - 0.6);
  }
  // underframe equipment, gangways, buffers
  gb.color(0x262626);
  if (!hs) gb.box(0, 0.075, 0, W - 0.08, 0.04, hl * 2 - 0.62);
  gb.color(0x303030);
  for (const z of [-0.18, 0.12]) gb.box(0, hs ? 0.05 : 0.055, z * L, 0.18, 0.05, 0.2);
  gb.color(0x1b1b1b);
  if (!wood) { gb.box(0, 0.13, hl + 0.012, 0.15, 0.25, 0.025); gb.box(0, 0.13, -hl - 0.012, 0.15, 0.25, 0.025); }
  if (!hs) { buffers(gb, hl, 1); buffers(gb, -hl, -1); }
  // doors near the ends (darker, with door windows)
  gb.color(color, 0.78);
  const dz = hl - (wood ? 0.07 : 0.12);
  for (const z of [dz, -dz]) for (const sx of [-1, 1]) gb.box(sx * (hw + 0.001), y0 + 0.01, z, 0.003, yE - y0 - 0.03, 0.08);
  gl.color(0xffffff);
  for (const z of [dz, -dz]) for (const sx of [-1, 1]) {
    const x = sx * (hw + 0.004), a = z - 0.025, b = z + 0.025, ya = 0.26, yb = 0.33;
    if (sx > 0) gl.quad(x, ya, b, x, ya, a, x, yb, a, x, yb, b); else gl.quad(x, ya, a, x, ya, b, x, yb, b, x, yb, a);
  }
  // passenger windows
  const wy0 = hs ? 0.235 : 0.24, wy1 = hs ? 0.335 : 0.33;
  const pitch = wood ? 0.085 : ic || hs ? 0.2 : 0.14;
  const span = hl * 2 - (wood ? 0.3 : 0.44);
  const segs = Math.max(3, Math.round(span / pitch));
  windowBand(gl, -span / 2, span / 2, wy0, wy1, hw + 0.002, segs, wood ? 0.025 : ic || hs ? 0.03 : 0.035);
  // end windows
  endWindow(gl, hl + 0.001, 0.26, 0.33, 0.03, false, 0.09); endWindow(gl, hl + 0.001, 0.26, 0.33, 0.03, false, -0.09);
  endWindow(gl, -hl - 0.001, 0.26, 0.33, 0.03, true, 0.09); endWindow(gl, -hl - 0.001, 0.26, 0.33, 0.03, true, -0.09);
  const g = m.build();
  const lamps: [number, number, number][] = [[0.1, 0.16, 0], [-0.1, 0.16, 0]];
  return {
    ...g, length: L, lo: loBody(color, roofCol, L, W, y0, yE, yT, [wy0, wy1]),
    front: lamps.map(([x, y]) => [x, y, hl + 0.01]), rear: lamps.map(([x, y]) => [x, y, -hl - 0.01]),
    bogies: [L * BOGIE_F, -L * BOGIE_F], bogieKind: 'b2',
  };
}

function steam(color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02;
  const big = L >= 2.2; // 4-6-2 pacific vs 2-6-0 mogul
  const black = 0x161616, red = 0xa8241c, brass = 0xc9a24a;
  const tenderL = big ? 0.72 : 0.6;
  const tz1 = -hl + tenderL;           // tender front
  const cabZ0 = tz1 + 0.03, cabZ1 = cabZ0 + 0.28;
  const bz0 = cabZ1, bz1 = hl - 0.07;  // boiler from the cab to the smokebox front
  const by = big ? 0.29 : 0.27, br = big ? 0.115 : 0.1;
  // frame and running boards
  gb.color(black);
  gb.box(0, 0.075, (cabZ0 + hl) / 2, 0.22, 0.06, hl - cabZ0);
  gb.color(red);
  gb.box(0, 0.06, hl - 0.03, RAIL_W, 0.08, 0.04);
  buffers(gb, hl, 1, 0.1);
  gb.color(black);
  gb.box(0.135, 0.165, (bz0 + bz1) / 2, 0.05, 0.008, bz1 - bz0);
  gb.box(-0.135, 0.165, (bz0 + bz1) / 2, 0.05, 0.008, bz1 - bz0);
  gb.color(red);
  gb.box(0.159, 0.135, (bz0 + bz1) / 2, 0.004, 0.03, bz1 - bz0);
  gb.box(-0.159, 0.135, (bz0 + bz1) / 2, 0.004, 0.03, bz1 - bz0);
  // boiler with bands, firebox, smokebox and door
  gb.color(color);
  gb.tube(0, by, bz0, 0, by, bz1 - 0.14, br, 16);
  gb.color(0x8f7a3a);
  for (let z = bz0 + 0.1; z < bz1 - 0.16; z += 0.16) gb.tube(0, by, z, 0, by, z + 0.008, br + 0.003, 16);
  gb.color(black);
  gb.tube(0, by, bz1 - 0.14, 0, by, bz1, br + 0.008, 16);
  disc(gb, 0, by, bz1, br + 0.008, 1, 16);
  gb.color(0x222222);
  gb.tube(0, by, bz1, 0, by, bz1 + 0.012, br * 0.8, 14);
  disc(gb, 0, by, bz1 + 0.012, br * 0.8, 1, 14);
  gb.color(color);
  gb.box(0, 0.15, bz0 + 0.12, 0.2, by - 0.15, 0.24);
  // chimney, domes, safety valves, whistle
  gb.color(black);
  gb.cylinder(0, by + br - 0.01, bz1 - 0.07, 0.034, big ? 0.07 : 0.1, 12, 0.03);
  gb.cylinder(0, by + br + (big ? 0.06 : 0.09), bz1 - 0.07, 0.042, 0.015, 12, 0.042);
  gb.color(color);
  gb.cylinder(0, by + br - 0.01, (bz0 + bz1) / 2 + 0.05, 0.045, 0.045, 12, 0.032);
  gb.cylinder(0, by + br - 0.01, (bz0 + bz1) / 2 - 0.12, 0.035, 0.035, 10, 0.025);
  gb.color(brass);
  gb.cylinder(0, by + br + 0.03, (bz0 + bz1) / 2 + 0.05, 0.032, 0.012, 12, 0.02);
  gb.cylinder(0, by + br - 0.01, bz0 + 0.06, 0.012, 0.04, 6);
  // cylinders and valve chests
  gb.color(0x2a2a2a);
  for (const sx of [-1, 1]) {
    gb.tube(sx * 0.115, 0.1, bz1 - 0.3, sx * 0.115, 0.1, bz1 - 0.1, 0.045, 10);
    gb.box(sx * 0.115, 0.14, bz1 - 0.2, 0.05, 0.04, 0.18);
  }
  // cab
  gb.color(color);
  prism(gb, cabZ0, cabZ1, [[-0.145, 0.13], [0.145, 0.13], [0.145, 0.4], [-0.145, 0.4]], 0.2);
  gb.color(0x222222);
  prism(gb, cabZ0 - 0.03, cabZ1 + 0.02, roofProfile(0.155, 0.4, 0.402, 0.43, 0.5), 0.7);
  endWindow(gl, cabZ1 + 0.001, 0.31, 0.37, 0.035, false, 0.085);
  endWindow(gl, cabZ1 + 0.001, 0.31, 0.37, 0.035, false, -0.085);
  windowBand(gl, cabZ0 + 0.05, cabZ1 - 0.06, 0.29, 0.37, 0.147, 1);
  // tender with coal
  gb.color(color, 0.92);
  prism(gb, -hl, tz1, [[-0.14, 0.12], [0.14, 0.12], [0.14, 0.35], [0.15, 0.37], [-0.15, 0.37], [-0.14, 0.35]], 0.3);
  gb.color(0x111111);
  prism(gb, -hl + 0.06, tz1 - 0.03, [[-0.13, 0.36], [0.13, 0.36], [0.06, 0.42], [-0.06, 0.42]], 0.3);
  gb.color(black);
  gb.box(0, 0.075, (-hl + tz1) / 2, 0.22, 0.05, tenderL - 0.04);
  buffers(gb, -hl, -1, 0.1);
  // wheels: drivers with rods, leading truck, trailing axle, tender axles
  const dr = big ? 0.095 : 0.085;
  const drivers = big ? [bz0 + 0.12, bz0 + 0.34, bz0 + 0.56] : [bz0 + 0.08, bz0 + 0.28, bz0 + 0.48];
  for (const z of drivers) axle(gb, z, dr, 0.075, 0.02, red, 16, 0xb8b8b8);
  gb.color(0xa8a8a8);
  for (const sx of [-1, 1]) {
    gb.box(sx * 0.091, dr - 0.008, (drivers[0] + drivers[2]) / 2, 0.006, 0.016, drivers[2] - drivers[0] + 0.03);
    gb.tube(sx * 0.093, dr + 0.03, drivers[1], sx * 0.093, 0.1, bz1 - 0.25, 0.007, 5);
  }
  const lead = big ? [bz1 - 0.2, bz1 - 0.06] : [bz1 - 0.12];
  for (const z of lead) axle(gb, z, 0.045, 0.072, 0.016, 0x1d1d1d, 10);
  if (big) axle(gb, cabZ0 + 0.08, 0.052, 0.072, 0.016, 0x1d1d1d, 10);
  const ta = big ? [-hl + 0.1, -hl + 0.27, -hl + 0.44, -hl + 0.6] : [-hl + 0.11, -hl + 0.3, -hl + 0.49];
  for (const z of ta) axle(gb, z, 0.045, 0.072, 0.016, 0x1d1d1d, 10);
  // headlamp
  gb.color(0xfff1c4);
  gb.cylinder(0, by + br + 0.01, bz1 + 0.01, 0.018, 0.025, 8);
  const g = m.build();
  return {
    ...g, length: L, chimney: new THREE.Vector3(0, by + br + (big ? 0.075 : 0.105), bz1 - 0.07),
    lo: loBody(color, 0x1a1a1a, L, 0.27, 0.12, 0.37, 0.41, [0.29, 0.37], 0, black),
    front: [[0, by + br + 0.02, hl + 0.01], [0.09, 0.12, hl + 0.01], [-0.09, 0.12, hl + 0.01]],
    rear: [[0.09, 0.15, -hl - 0.01], [-0.09, 0.15, -hl - 0.01]], bogies: [], bogieKind: 'b2',
  };
}

function diesel(color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02, W = RAIL_W, hw = W / 2;
  const six = L >= 2.0;
  const cab0 = hl - 0.42, cab1 = hl - 0.14; // cab behind a short nose
  // frame, walkways, handrails, stripe
  gb.color(0x232323);
  gb.box(0, 0.1, 0, W, 0.04, hl * 2);
  gb.color(0xe8c547);
  gb.box(0, 0.105, 0, W + 0.004, 0.018, hl * 2 - 0.02);
  gb.color(0x9a9a9a);
  for (const sx of [-1, 1]) {
    gb.box(sx * (hw - 0.008), 0.235, (cab0 - hl) / 2, 0.006, 0.006, cab0 + hl - 0.06);
    for (let z = -hl + 0.05; z < cab0; z += 0.25) gb.box(sx * (hw - 0.008), 0.14, z, 0.005, 0.1, 0.005);
  }
  // long hood with louvres and fans
  gb.color(color);
  prism(gb, -hl + 0.04, cab0, roofProfile(0.105, 0.14, 0.355, 0.375, 0.6), 0.7);
  gb.color(color, 0.7);
  for (let z = -hl + 0.12; z < cab0 - 0.1; z += 0.16) { gb.box(0.106, 0.2, z, 0.003, 0.1, 0.09); gb.box(-0.106, 0.2, z, 0.003, 0.1, 0.09); }
  gb.color(0x2a2a2a);
  for (const z of [-hl + 0.22, -hl + 0.42]) { gb.cylinder(0, 0.372, z, 0.055, 0.008, 12); }
  gb.color(0x333333);
  const ex: THREE.Vector3[] = [];
  for (const z of six ? [cab0 - 0.28, cab0 - 0.42] : [cab0 - 0.3]) { gb.box(0, 0.37, z, 0.05, 0.03, 0.035); ex.push(new THREE.Vector3(0, 0.405, z)); }
  // cab
  gb.color(color);
  prism(gb, cab0, cab1, [[-(hw - 0.01), 0.14], [hw - 0.01, 0.14], [hw - 0.01, 0.39], [-(hw - 0.01), 0.39]], 0.2);
  gb.color(0x3a3a3a);
  prism(gb, cab0 - 0.01, cab1 + 0.01, roofProfile(hw - 0.005, 0.39, 0.392, 0.418, 0.55), 0.7);
  endWindow(gl, cab1 + 0.002, 0.3, 0.375, 0.05, false, 0.065); endWindow(gl, cab1 + 0.002, 0.3, 0.375, 0.05, false, -0.065);
  endWindow(gl, cab0 - 0.002, 0.3, 0.375, 0.04, true, 0.07); endWindow(gl, cab0 - 0.002, 0.3, 0.375, 0.04, true, -0.07);
  windowBand(gl, cab0 + 0.04, cab1 - 0.04, 0.29, 0.375, hw - 0.008, 2, 0.03);
  // short nose with number boards and lamps
  gb.color(color);
  prism(gb, cab1, hl - 0.02, roofProfile(0.1, 0.14, 0.29, 0.305, 0.6), 0.7);
  gb.color(0x111111);
  gb.box(0, 0.305, hl - 0.06, 0.08, 0.02, 0.04);
  gb.color(0xfff1c4);
  gb.box(0.05, 0.24, hl - 0.019, 0.025, 0.025, 0.005); gb.box(-0.05, 0.24, hl - 0.019, 0.025, 0.025, 0.005);
  gb.box(0.05, 0.24, -hl + 0.039, 0.025, 0.025, 0.005); gb.box(-0.05, 0.24, -hl + 0.039, 0.025, 0.025, 0.005);
  // fuel tank, buffers
  gb.color(0x1e1e1e);
  prism(gb, -0.3 * L, 0.18 * L, [[-0.11, 0.035], [0.11, 0.035], [0.12, 0.06], [0.11, 0.08], [-0.11, 0.08], [-0.12, 0.06]], 0.8);
  buffers(gb, hl, 1, 0.1); buffers(gb, -hl, -1, 0.1);
  const g = m.build();
  return {
    ...g, length: L, exhaust: ex, lo: loBody(color, 0x3a3a3a, L, W * 0.9, 0.12, 0.37, 0.41, [0.3, 0.37]),
    front: [[0.05, 0.25, hl + 0.005], [-0.05, 0.25, hl + 0.005]], rear: [[0.05, 0.25, -hl + 0.03], [-0.05, 0.25, -hl + 0.03]],
    bogies: [L * BOGIE_F, -L * BOGIE_F], bogieKind: six ? 'b3' : 'b2',
  };
}

function streamliner(color: number, stripe: number, L: number, long: number, electric: boolean): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02, W = RAIL_W, hw = W / 2, y0 = electric ? 0.07 : 0.1, yE = 0.37, yT = 0.418;
  const zn = hl - long;
  // body with rounded roof
  gb.color(color);
  prism(gb, -hl, zn, [[-hw, y0], [hw, y0], [hw, yE], [-hw, yE]], 0.2);
  gb.color(color, 0.97);
  prism(gb, -hl, zn, roofProfile(hw - 0.001, yE - 0.001, yE + 0.003, yT, 0.5), 0.7);
  // nose: lofted sections from the full profile down to a rounded tip
  const sec = (t: number): P2[] => {
    const e = t * t;
    const w = hw * (1 - 0.62 * Math.pow(t, 1.6)), top = yT - (yT - (y0 + 0.08)) * Math.pow(t, electric ? 1.25 : 1.7), bot = y0 + 0.015 * t;
    const mid = bot + (top - bot) * (0.6 - 0.15 * e);
    return [[-w, bot], [w, bot], [w, mid], [w * 0.75, top - (top - mid) * 0.15], [-w * 0.75, top - (top - mid) * 0.15], [-w, mid]];
  };
  const steps = electric ? 6 : 4;
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const a = sec(t0), b = sec(t1);
    const za = zn + long * t0, zb = zn + long * t1;
    for (let k = 0; k < a.length; k++) {
      const k2 = (k + 1) % a.length;
      gb.quad(a[k][0], a[k][1], za, a[k2][0], a[k2][1], za, b[k2][0], b[k2][1], zb, b[k][0], b[k][1], zb);
    }
  }
  const tip = sec(1);
  { const c = gb.vertex(0, (tip[0][1] + tip[3][1]) / 2, hl, 0, 0, 1); const ring = tip.map(([x, y]) => gb.vertex(x, y, hl, 0, 0, 1)); for (let i = 0; i < ring.length; i++) gb.idx.push(c, ring[i], ring[(i + 1) % ring.length]); }
  // livery stripe, skirts, roof equipment
  gb.color(stripe);
  gb.box(0, 0.2, (zn - hl) / 2, W + 0.005, 0.035, zn + hl - 0.01);
  gb.color(0x2a2a2a);
  gb.box(0, electric ? 0.045 : 0.075, 0, W - 0.03, 0.04, hl * 2 - 0.3);
  gb.color(0xb8bcc0);
  if (electric) { pantograph(gb, -hl * 0.45, yT - 0.004); gb.box(0, yT - 0.006, 0.1, 0.1, 0.02, 0.4); }
  else {
    gb.box(0, yT - 0.006, -0.25, 0.16, 0.02, 0.5);
    gb.color(0x333333);
    gb.box(0, yT + 0.012, -0.32, 0.12, 0.004, 0.3);
  }
  buffers(gb, -hl, -1, 0.11);
  // windscreen on the nose slope, side windows, cab door
  gl.color(0xffffff);
  const t0 = 0.08, t1 = electric ? 0.36 : 0.42;
  const s0 = sec(t0), s1 = sec(t1);
  const z0 = zn + long * t0, z1 = zn + long * t1;
  const lift = 0.004;
  gl.quad(s0[4][0], s0[4][1] + lift, z0, s1[4][0], s1[4][1] + lift, z1, s1[3][0], s1[3][1] + lift, z1, s0[3][0], s0[3][1] + lift, z0);
  gl.quad(s0[3][0], s0[3][1] + lift, z0, s1[3][0], s1[3][1] + lift, z1, s1[2][0] + lift, s1[2][1], z1, s0[2][0] + lift, s0[2][1], z0);
  gl.quad(s1[5][0] - lift, s1[5][1], z1, s1[4][0], s1[4][1] + lift, z1, s0[4][0], s0[4][1] + lift, z0, s0[5][0] - lift, s0[5][1], z0);
  windowBand(gl, -hl + 0.15, zn - 0.25, 0.25, 0.33, hw + 0.002, Math.max(2, Math.round((zn + hl - 0.4) / 0.2)), 0.03);
  windowBand(gl, zn - 0.18, zn - 0.03, 0.27, 0.34, hw + 0.002, 1);
  gb.color(color, 0.85);
  gb.box(hw + 0.001, y0 + 0.02, zn - 0.25, 0.003, yE - y0 - 0.05, 0.06);
  gb.box(-hw - 0.001, y0 + 0.02, zn - 0.25, 0.003, yE - y0 - 0.05, 0.06);
  // lamps low on the nose
  const ly = y0 + 0.05, lz = hl - long * 0.06;
  gb.color(0xfff1c4);
  gb.box(0.055, ly - 0.01, lz, 0.03, 0.02, 0.01); gb.box(-0.055, ly - 0.01, lz, 0.03, 0.02, 0.01);
  const g = m.build();
  return {
    ...g, length: L, exhaust: electric ? undefined : [new THREE.Vector3(0, yT + 0.02, -0.2)],
    lo: loBody(color, color, L, W, y0, yE, yT, [0.25, 0.33], long, 0x2a2a2a),
    front: [[0.055, ly, lz + 0.02], [-0.055, ly, lz + 0.02]], rear: [[0.09, 0.16, -hl - 0.01], [-0.09, 0.16, -hl - 0.01]],
    bogies: [L * BOGIE_F, -L * BOGIE_F], bogieKind: 'b2',
  };
}

// ------------------------------------------------------------------------------------ road vehicles

function bus(style: string, color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.005;
  const old = style === 'bus_old', artic = style === 'bus_artic', modern = style === 'bus_modern';
  const W = old ? 0.235 : 0.25, hw = W / 2;
  const y0 = modern ? 0.03 : 0.045, yE = old ? 0.27 : 0.29, yT = old ? 0.3 : 0.31;
  const roofCol = modern ? 0x2c3e50 : old ? 0xf3e3b5 : 0xeeeeee;
  const bonnet = old ? 0.16 : 0;
  // body with rounded roof edges (and a bonnet on the old omnibus)
  gb.color(color);
  prism(gb, -hl, hl - bonnet, [[-hw, y0], [hw, y0], [hw, yE], [-hw, yE]], 0.2);
  gb.color(roofCol);
  prism(gb, -hl + 0.005, hl - bonnet - 0.005, roofProfile(hw - 0.001, yE - 0.001, yE + 0.002, yT, 0.7), 0.7);
  if (old) {
    gb.color(color, 0.9);
    prism(gb, hl - bonnet, hl, [[-0.09, 0.05], [0.09, 0.05], [0.09, 0.17], [0.06, 0.2], [-0.06, 0.2], [-0.09, 0.17]], 0.5);
    gb.color(0x999999);
    gb.box(0, 0.06, hl - 0.003, 0.14, 0.11, 0.006);
    gb.color(0xf3e3b5);
    gb.box(0, y0 + 0.095, -bonnet / 2, W + 0.004, 0.014, hl * 2 - bonnet - 0.01);
    gb.color(0x161616);
    for (const z of [hl - 0.12, -hl + 0.2]) { gb.box(hw - 0.005, 0.085, z, 0.03, 0.012, 0.13); gb.box(-hw + 0.005, 0.085, z, 0.03, 0.012, 0.13); }
  }
  if (artic) { gb.color(0x1c1c1c); prism(gb, -0.03, 0.03, [[-hw - 0.003, y0 + 0.02], [hw + 0.003, y0 + 0.02], [hw + 0.003, yE - 0.01], [-hw - 0.003, yE - 0.01]], 0.2); }
  if (modern) {
    gb.color(0xe8f0f2);
    gb.box(0, y0 + 0.01, 0, W + 0.004, 0.05, hl * 2 - 0.02);
    gb.color(0x95a5a6);
    gb.box(0, yT - 0.005, -hl * 0.3, 0.17, 0.035, 0.3);
  }
  if (style === 'bus') { gb.color(0xf2f2f2); gb.box(0, 0.13, 0, W + 0.004, 0.016, hl * 2 - 0.01); }
  // bumpers, wheel arches, mirrors
  gb.color(0x1e1e1e);
  gb.box(0, y0 - 0.005, hl - 0.005, W - 0.01, 0.035, 0.02);
  gb.box(0, y0 - 0.005, -hl + 0.005, W - 0.01, 0.035, 0.02);
  const wz = artic ? [hl - 0.22, 0.12, -hl + 0.24] : [hl - bonnet - (old ? 0.02 : 0.22), -hl + 0.27];
  for (const z of wz) { gb.box(hw + 0.001, y0, z, 0.004, 0.06, 0.13); gb.box(-hw - 0.001, y0, z, 0.004, 0.06, 0.13); }
  gb.color(0x222222);
  if (!old) { gb.box(hw + 0.02, 0.22, hl - 0.02, 0.008, 0.035, 0.012); gb.box(-hw - 0.02, 0.22, hl - 0.02, 0.008, 0.035, 0.012); }
  // destination display
  gb.color(0x111111);
  if (!old) gb.box(0, yE - 0.035, hl + 0.002, W * 0.6, 0.025, 0.004);
  gb.color(0xffb84d);
  if (!old) gb.box(0, yE - 0.03, hl + 0.004, W * 0.5, 0.014, 0.002);
  // windows with pillars, doors
  const wy0 = modern ? y0 + 0.07 : y0 + 0.11, wy1 = yE - 0.025;
  const span = hl * 2 - bonnet - 0.32;
  windowBand(gl, -hl + 0.06, -hl + 0.06 + span, wy0, wy1, hw + 0.002, Math.max(3, Math.round(span / (old ? 0.09 : 0.14))), old ? 0.018 : 0.022);
  gl.color(0xffffff);
  // front door(s) on the kerb side (+x), glazed to the floor
  const dz = hl - bonnet - 0.12;
  gl.quad(hw + 0.003, y0 + 0.02, dz + 0.06, hw + 0.003, y0 + 0.02, dz - 0.06, hw + 0.003, wy1, dz - 0.06, hw + 0.003, wy1, dz + 0.06);
  if (!old) { const mz = artic ? -0.2 : -0.1; gl.quad(hw + 0.003, y0 + 0.02, mz + 0.06, hw + 0.003, y0 + 0.02, mz - 0.06, hw + 0.003, wy1, mz - 0.06, hw + 0.003, wy1, mz + 0.06); }
  endWindow(gl, hl - bonnet + 0.002, old ? 0.16 : y0 + 0.08, wy1 + 0.01, hw - 0.015);
  endWindow(gl, -hl - 0.002, wy0 + 0.02, wy1, hw - 0.025, true);
  // lamps
  gb.color(0xfff6c8);
  const fy = old ? 0.13 : y0 + 0.035;
  gb.box(0.085, fy - 0.01, hl + 0.001, 0.035, 0.022, 0.006); gb.box(-0.085, fy - 0.01, hl + 0.001, 0.035, 0.022, 0.006);
  gb.color(0xc0392b);
  gb.box(0.095, y0 + 0.04, -hl - 0.001, 0.025, 0.035, 0.006); gb.box(-0.095, y0 + 0.04, -hl - 0.001, 0.025, 0.035, 0.006);
  for (const z of wz) axle(gb, z, 0.05, hw - 0.022, 0.032, 0x161616, 12, 0x8a8a8a);
  const g = m.build();
  return {
    ...g, length: L, lo: loBody(color, roofCol, L, W, y0, yE, yT, [wy0, wy1]),
    front: [[0.085, fy, hl + 0.01], [-0.085, fy, hl + 0.01]], rear: [[0.095, y0 + 0.058, -hl - 0.01], [-0.095, y0 + 0.058, -hl - 0.01]],
    bogies: [], bogieKind: 'b2',
  };
}

// ------------------------------------------------------------------------------------ long-distance coaches

/** Coach eras: rounded 1930s-50s, boxy 1960s-80s, sleek modern (1990s on). */
export type CoachEra = 'round' | 'boxy' | 'modern';

/** Long-distance road coach: a bus model whose style starts with 'coach' (rail coaches are wagons). */
export function isRoadCoach(m: { kind: string; style: string }): boolean {
  return m.kind === 'coach' || (m.kind === 'bus' && m.style.startsWith('coach'));
}

/** Era variant from an explicit style suffix ('coach_round' / '_boxy' / '_modern'), else from the intro year. */
export function coachEra(style: string, intro = 1990): CoachEra {
  if (/round|vintage|classic|old/.test(style)) return 'round';
  if (/box|retro/.test(style)) return 'boxy';
  if (/modern|sleek|new/.test(style)) return 'modern';
  return intro < 1958 ? 'round' : intro < 1988 ? 'boxy' : 'modern';
}

const smooth01 = (x: number) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

/** Quad on the side plane at |x| (facing outwards on side sx) from z0 to z1, bottom/top heights at each end. */
function sideQuad(g: GeoBuilder, sx: number, x: number, z0: number, z1: number, b0: number, t0: number, b1: number, t1: number) {
  if (sx > 0) g.quad(x, b1, z1, x, b0, z0, x, t0, z0, x, t1, z1);
  else g.quad(-x, b0, z0, -x, b1, z1, -x, t1, z1, -x, t0, z0);
}

/**
 * Quad on a raked windscreen plane that rises from (yB at zF) back to (yE at zB), between heights ya..yb and
 * xa..xb, pushed `off` outwards along the plane normal.
 */
function onSlope(g: GeoBuilder, xa: number, xb: number, ya: number, yb: number, yB: number, yE: number, zB: number, zF: number, off: number) {
  const k = (zF - zB) / (yE - yB);
  const za = zF - (ya - yB) * k, zb = zF - (yb - yB) * k;
  const l = Math.hypot(zF - zB, yE - yB), ny = ((zF - zB) / l) * off, nz = ((yE - yB) / l) * off;
  g.quad(xa, ya + ny, za + nz, xb, ya + ny, za + nz, xb, yb + ny, zb + nz, xa, yb + ny, zb + nz);
}

/** Closed raked front: lower front (y0..yB) from zB to zF, the windscreen plane and its side triangles. */
function rakedFront(gb: GeoBuilder, hw: number, y0: number, yB: number, yE: number, zB: number, zF: number) {
  gb.box(0, y0, (zB + zF) / 2, hw * 2, yB - y0, zF - zB);
  gb.triangle(hw, yB, zF, hw, yB, zB, hw, yE, zB);
  gb.triangle(-hw, yB, zB, -hw, yB, zF, -hw, yE, zB);
}

/** Luggage bay doors between z0 and z1 on both sides: dark shut lines and handles. */
function bays(gb: GeoBuilder, hw: number, z0: number, z1: number, yb: number, yt: number) {
  if (z1 - z0 < 0.12) return;
  const n = Math.max(1, Math.round((z1 - z0) / 0.2)), d = (z1 - z0) / n, x = hw + 0.0015, zc = (z0 + z1) / 2;
  gb.color(0x1a1c1e);
  for (const sx of [-1, 1]) {
    gb.box(sx * x, yt - 0.003, zc, 0.003, 0.003, z1 - z0);
    gb.box(sx * x, yb, zc, 0.003, 0.003, z1 - z0);
    for (let i = 0; i <= n; i++) gb.box(sx * x, yb, z0 + i * d, 0.003, yt - yb, 0.003);
  }
  gb.color(0xb8bcc0);
  for (const sx of [-1, 1]) for (let i = 0; i < n; i++) gb.box(sx * (hw + 0.002), yt - 0.026, z0 + (i + 0.5) * d, 0.003, 0.006, 0.03);
}

/** Dark rounded wheel-arch openings on both sides (the wheels' outer faces sit just in front of them). */
function arches(gb: GeoBuilder, hw: number, zs: number[], r: number, y0: number) {
  gb.color(0x121314);
  const R = r + 0.014, yb = Math.min(y0, r) - 0.002, x = hw + 0.0012, n = 8;
  for (const z of zs) {
    // fan: bottom corners and a half circle round the axle
    const pts: P2[] = [[z + R, yb]];
    for (let i = 0; i <= n; i++) { const a = (i / n) * Math.PI; pts.push([z + R * Math.cos(a), r + R * Math.sin(a)]); }
    pts.push([z - R, yb]);
    let cz = 0, cy = 0;
    for (const [pz, py] of pts) { cz += pz; cy += py; }
    cz /= pts.length; cy /= pts.length;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [az, ay] = pts[i], [bz, by] = pts[i + 1];
      gb.triangle(x, cy, cz, x, by, bz, x, ay, az);
      gb.triangle(-x, cy, cz, -x, ay, az, -x, by, bz);
    }
  }
}

/** Front axle (single tyres) and rear axles (twin drive tyres, single tag axle), outer faces flush with the body. */
function coachWheels(gb: GeoBuilder, hw: number, front: number, rear: number[], r: number, hub: number) {
  arches(gb, hw, [front, ...rear], r, 0.045);
  axle(gb, front, r, hw + 0.004 - 0.016, 0.032, 0x151515, 12, hub);
  axle(gb, rear[0], r, hw + 0.004 - 0.024, 0.048, 0x151515, 12, hub);
  if (rear.length > 1) axle(gb, rear[1], r * 0.96, hw + 0.004 - 0.016, 0.032, 0x151515, 12, hub);
}

/** Glazed kerb-side (+x) entrance door centred at dz. */
function coachDoor(gb: GeoBuilder, gl: GeoBuilder, hw: number, dz: number, w: number, y0: number, y1: number) {
  gb.color(0x16191c);
  gb.box(hw + 0.002, y0 + 0.012, dz, 0.004, y1 - y0, w + 0.012);
  gl.color(0xffffff);
  const x = hw + 0.0045, a = dz - w / 2, b = dz + w / 2;
  gl.quad(x, y0 + 0.02, b, x, y0 + 0.02, a, x, y1 - 0.004, a, x, y1 - 0.004, b);
}

/**
 * Low-detail coach: painted body, operator-colour bands [y0, y1, z0?, z1?] (full length by default), roof,
 * one window strip, windscreen, wheel blocks.
 */
function coachLo(L: number, W: number, y0: number, yE: number, yT: number, win: [number, number], screen: [number, number], acc: number[][], axles: number[], roof: number) {
  const m = new MB(), gb = m.gb, hl = L / 2 - 0.005, hw = W / 2;
  m.paint(true); gb.color(0xffffff);
  gb.box(0, y0, 0, W, yE - y0, hl * 2);
  m.accent(true); gb.color(0xffffff);
  for (const [a, b, z0 = -hl - 0.001, z1 = hl + 0.001] of acc) gb.box(0, a, (z0 + z1) / 2, W + 0.004, b - a, z1 - z0);
  m.paint(false);
  gb.color(roof);
  gb.box(0, yE, 0, W * 0.86, yT - yE, hl * 2 - 0.04);
  gb.color(0x151515);
  for (const z of axles) gb.box(0, 0, z, W - 0.01, y0 + 0.01, 0.1);
  windowBand(m.gl, -hl + 0.1, hl - 0.08, win[0], win[1], hw + 0.002, 1, 0);
  endWindow(m.gl, hl + 0.002, screen[0], screen[1], hw - 0.02);
  return m.build();
}

/** 1930s-50s: rounded nose and tail, two-tone (operator colour below the chrome belt), roof lights, roof rack. */
function coachRound(L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.005, W = 0.245, hw = W / 2;
  const y0 = 0.045, belt = 0.152, wy0 = 0.168, wy1 = 0.258, yE = 0.272, yT = 0.312, flat = 0.4;
  const zf = hl - 0.12, zr = -hl + 0.1;
  const r = 0.048, axF = hl - 0.2, axR = -hl + 0.27;
  const lower: P2[] = [[-hw, y0], [hw, y0], [hw, belt], [-hw, belt]];
  const upper = roofProfile(hw, belt, yE, yT, flat);
  for (const [p, acc] of [[lower, true], [upper, false]] as [P2[], boolean][]) {
    if (acc) m.accent(true); else m.paint(true);
    gb.color(0xffffff);
    prism(gb, zr, zf, p, acc ? 0.2 : 0.7, false);
    const n1 = scaleP(p, 0.975, y0, 0.985), n2 = scaleP(p, 0.86, y0, 0.92);
    loft(gb, p, zf, n1, zf + 0.07, 0);
    loft(gb, n1, zf + 0.07, n2, hl, 1);
    const t1 = scaleP(p, 0.97, y0, 0.985), t2 = scaleP(p, 0.87, y0, 0.93);
    loft(gb, t1, zr - 0.055, p, zr, 0);
    loft(gb, t2, -hl, t1, zr - 0.055, -1);
  }
  m.paint(false);
  // chrome belt moulding
  gb.color(0xd5d5d0);
  gb.box(0, belt - 0.004, (zr + zf) / 2, W + 0.006, 0.008, zf - zr);
  // side windows and panoramic roof lights on the shoulders
  const z0w = zr + 0.03, z1w = zf - 0.02;
  const nWin = Math.max(4, Math.round((z1w - z0w) / 0.115)), seg = (z1w - z0w - 0.02 * (nWin - 1)) / nWin;
  windowBand(gl, z0w, z1w, wy0, wy1, hw + 0.002, nWin, 0.02);
  const rise = yT - yE;
  const sh = (f: number): P2 => [hw * (1 - f * (1 - flat)), yE + rise * Math.sin((f * Math.PI) / 2)];
  const [ax, ay] = sh(0.25), [bx, by] = sh(0.55);
  const sl = Math.hypot(bx - ax, by - ay), ox = ((by - ay) / sl) * 0.0015, oy = (-(bx - ax) / sl) * 0.0015;
  gl.color(0xffffff);
  for (let i = 0; i < nWin; i++) {
    const a = z0w + i * (seg + 0.02), b = a + seg;
    gl.quad(ax + ox, ay + oy, b, ax + ox, ay + oy, a, bx + ox, by + oy, a, bx + ox, by + oy, b);
    gl.quad(-ax - ox, ay + oy, a, -ax - ox, ay + oy, b, -bx - ox, by + oy, b, -bx - ox, by + oy, a);
  }
  coachDoor(gb, gl, hw, axF - 0.15, 0.085, y0, wy1);
  bays(gb, hw, axR + 0.075, axF - 0.21, y0 + 0.01, belt - 0.012);
  // nose: split windscreen, destination blind, chrome grille, round lamps, bumper
  endWindow(gl, hl + 0.0015, 0.165, 0.245, 0.044, false, 0.05);
  endWindow(gl, hl + 0.0015, 0.165, 0.245, 0.044, false, -0.05);
  gb.color(0x161616);
  gb.box(0, 0.25, hl + 0.0005, 0.1, 0.016, 0.003);
  gb.color(0xf2efe2);
  gb.box(0, 0.2535, hl + 0.0015, 0.08, 0.009, 0.002);
  gb.color(0xcfd0cc);
  for (let i = -3; i <= 3; i++) gb.box(i * 0.01, 0.06, hl + 0.001, 0.003, 0.05, 0.004);
  for (const sx of [-1, 1]) {
    gb.color(0xcfd0cc); disc(gb, sx * 0.072, 0.098, hl + 0.002, 0.019, 1, 10);
    gb.color(0xfff1c4); disc(gb, sx * 0.072, 0.098, hl + 0.003, 0.014, 1, 10);
  }
  gb.color(0xcfd0cc);
  gb.box(0, y0 - 0.01, hl + 0.004, W * 0.84, 0.02, 0.014);
  gb.box(0, y0 - 0.01, -hl - 0.004, W * 0.84, 0.02, 0.014);
  // tail: small rear window, round lamps
  endWindow(gl, -hl - 0.0015, 0.19, 0.24, 0.055, true);
  gb.color(0xb02a20);
  for (const sx of [-1, 1]) disc(gb, sx * 0.075, 0.085, -hl - 0.002, 0.012, -1, 8);
  // roof rack with luggage over the rear half
  const rz = -hl * 0.35, rlen = L * 0.32;
  gb.color(0x3b3b3b);
  for (const sx of [-1, 1]) gb.box(sx * hw * 0.5, yT - 0.004, rz, 0.005, 0.014, rlen);
  for (let i = 0; i < 4; i++) gb.box(0, yT + 0.006, rz - rlen / 2 + (i + 0.5) * (rlen / 4), hw, 0.004, 0.005);
  gb.color(0x6e5236); gb.box(0.015, yT + 0.006, rz + rlen * 0.18, 0.08, 0.026, 0.1);
  gb.color(0x58653f); gb.box(-0.02, yT + 0.006, rz - rlen * 0.2, 0.085, 0.02, 0.09);
  coachWheels(gb, hw, axF, [axR], r, 0xd0d0d0);
  const g = m.build();
  return {
    ...g, length: L, lo: coachLo(L, W, y0, yE, yT, [wy0, wy1], [0.165, 0.245], [[y0, belt]], [axF, axR], 0xd8d4c8),
    front: [[0.072, 0.098, hl + 0.01], [-0.072, 0.098, hl + 0.01]], rear: [[0.075, 0.085, -hl - 0.01], [-0.075, 0.085, -hl - 0.01]],
    bogies: [], bogieKind: 'b2',
  };
}

/** 1960s-80s: flat sides, slightly raked windscreen, operator-colour stripes, luggage bays, tag axle when long. */
function coachBoxy(L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.005, W = 0.25, hw = W / 2;
  const y0 = 0.05, yB = 0.17, wy0 = 0.188, wy1 = 0.312, yE = 0.33, yT = 0.348;
  const rake = 0.04, zB = hl - rake;
  const r = 0.052, axF = hl - 0.27, axR = L >= 1.3 ? [-hl + 0.43, -hl + 0.29] : [-hl + 0.33];
  m.paint(true); gb.color(0xffffff);
  prism(gb, -hl, zB, roofProfile(hw, y0, yE, yT, 0.82), 0.5);
  rakedFront(gb, hw, y0, yB, yE, zB, hl);
  // operator colour: bold band under the windows, pinstripe and skirt, wrapping round both ends
  m.accent(true); gb.color(0xffffff);
  gb.box(0, 0.15, 0, W + 0.004, 0.02, hl * 2 + 0.002);
  gb.box(0, 0.137, 0, W + 0.004, 0.006, hl * 2 + 0.002);
  gb.box(0, y0, 0, W + 0.004, 0.028, hl * 2 + 0.002);
  m.paint(false);
  // windscreen (black surround), destination display
  gb.color(0x1c1f22);
  onSlope(gb, -hw, hw, yB, yE, yB, yE, zB, hl, 0);
  gl.color(0xffffff);
  onSlope(gl, -hw + 0.012, hw - 0.012, yB + 0.008, yE - 0.03, yB, yE, zB, hl, 0.0015);
  gb.color(0x0d0d0d); onSlope(gb, -hw * 0.62, hw * 0.62, yE - 0.026, yE - 0.006, yB, yE, zB, hl, 0.002);
  gb.color(0xffb84d); onSlope(gb, -hw * 0.5, hw * 0.5, yE - 0.021, yE - 0.011, yB, yE, zB, hl, 0.0028);
  // tinted side windows in a black surround
  const zw0 = -hl + 0.07, zw1 = zB - 0.008;
  gb.color(0x16191c);
  gb.box(0, wy0 - 0.006, (zw0 + zw1) / 2, W + 0.002, wy1 - wy0 + 0.012, zw1 - zw0);
  windowBand(gl, zw0 + 0.004, zw1 - 0.004, wy0, wy1, hw + 0.002, Math.max(4, Math.round((zw1 - zw0) / 0.15)), 0.012);
  coachDoor(gb, gl, hw, hl - 0.125, 0.094, y0, wy1);
  bays(gb, hw, axR[0] + 0.075, axF - 0.075, y0 + 0.008, 0.166);
  // front: grille band, twin square lamps, bumper, mirrors on arms
  gb.color(0x1b1b1b); gb.box(0, 0.085, hl + 0.0005, W * 0.5, 0.03, 0.003);
  gb.color(0xfff6c8);
  for (const sx of [-1, 1]) { gb.box(sx * 0.074, 0.09, hl + 0.001, 0.026, 0.02, 0.004); gb.box(sx * 0.102, 0.09, hl + 0.001, 0.024, 0.02, 0.004); }
  gb.color(0x2a2a2a);
  gb.box(0, y0 - 0.008, hl + 0.006, W - 0.006, 0.032, 0.014);
  gb.box(0, y0 - 0.008, -hl - 0.006, W - 0.006, 0.032, 0.014);
  gb.color(0x1e1e1e);
  for (const sx of [-1, 1]) {
    gb.tube(sx * (hw - 0.004), 0.255, hl - 0.03, sx * (hw + 0.03), 0.262, hl + 0.012, 0.004, 4);
    gb.box(sx * (hw + 0.032), 0.205, hl + 0.014, 0.012, 0.06, 0.008);
  }
  // rear: engine grille, high rear window, tall lamp clusters
  gb.color(0x2b2e31); gb.box(0, y0 + 0.035, -hl - 0.0015, W - 0.05, 0.075, 0.003);
  endWindow(gl, -hl - 0.002, 0.235, 0.312, hw - 0.03, true);
  gb.color(0xb02a20);
  for (const sx of [-1, 1]) gb.box(sx * (hw - 0.016), 0.07, -hl - 0.002, 0.02, 0.07, 0.004);
  // roof: air-conditioning pod, hatch
  gb.color(0xd5d8db); gb.box(0, yT - 0.006, -hl * 0.2, W * 0.56, 0.026, L * 0.3);
  gb.color(0xbfc3c6); gb.box(0, yT - 0.003, hl * 0.45, 0.07, 0.008, 0.08);
  coachWheels(gb, hw, axF, axR, r, 0x9a9da0);
  const g = m.build();
  return {
    ...g, length: L, lo: coachLo(L, W, y0, yE, yT, [wy0, wy1], [yB + 0.01, yE - 0.03], [[0.15, 0.17], [y0, y0 + 0.028]], [axF, ...axR], 0xd5d8db),
    front: [[0.088, 0.1, hl + 0.01], [-0.088, 0.1, hl + 0.01]], rear: [[hw - 0.016, 0.105, -hl - 0.01], [-hw + 0.016, 0.105, -hl - 0.01]],
    bogies: [], bogieKind: 'b2',
  };
}

/** 1990s on: tall high-floor body, steeply raked panoramic windscreen, flush double glazing, swoosh livery. */
function coachModern(L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.005, W = 0.255, hw = W / 2;
  const y0 = 0.045, yB = 0.125, wy0 = 0.192, wy1 = 0.336, yE = 0.35, yT = 0.376;
  const rake = 0.13, zB = hl - rake;
  const r = 0.054, axF = hl - 0.29, axR = L >= 1.3 ? [-hl + 0.42, -hl + 0.28] : [-hl + 0.32];
  const prof = roofProfile(hw, y0, yE, yT, 0.62);
  m.paint(true); gb.color(0xffffff);
  prism(gb, -hl + 0.02, zB, prof, 0.5);
  loft(gb, scaleP(prof, 0.95, y0, 0.965), -hl, prof, -hl + 0.02, -1);
  rakedFront(gb, hw, y0, yB, yE, zB, hl);
  // operator-colour swoosh: a broad block at the rear sweeping forward into a thin line under the windows
  m.accent(true); gb.color(0xffffff);
  const zw0 = -hl + 0.2, zw1 = zB - 0.004;
  const zs = -hl + 0.02, ze = axF - 0.1, tw = (zw0 - zs) / (ze - zs);
  const top = (t: number) => t <= tw - 0.1 ? 0.344 : t <= tw ? 0.344 - 0.166 * smooth01((t - tw + 0.1) / 0.1) : 0.178 - 0.014 * ((t - tw) / (1 - tw));
  const bot = (t: number) => 0.05 + 0.105 * Math.pow(t, 1.7);
  const ts = [0, tw - 0.1, tw - 0.075, tw - 0.05, tw - 0.025, tw];
  for (let i = 1; i <= 8; i++) ts.push(tw + ((1 - tw) * i) / 8);
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = Math.max(0, ts[i]), b = ts[i + 1];
    if (b <= a) continue;
    const za = zs + a * (ze - zs), zb = zs + b * (ze - zs);
    for (const sx of [-1, 1]) sideQuad(gb, sx, hw + 0.001, za, zb, bot(a), top(a), bot(b), top(b));
  }
  // continue the rear block over the chamfered rear corners
  const ch = (y: number) => y0 + (y - y0) * 0.965;
  for (const sx of [-1, 1]) {
    const xa = sx * (hw * 0.95 + 0.001), xb = sx * (hw + 0.001), za = -hl, zb = -hl + 0.02;
    if (sx > 0) gb.quad(xb, 0.05, zb, xa, ch(0.05), za, xa, ch(0.344), za, xb, 0.344, zb);
    else gb.quad(xa, ch(0.05), za, xb, 0.05, zb, xb, 0.344, zb, xa, ch(0.344), za);
  }
  gb.box(0, 0.106, hl + 0.0005, W - 0.012, 0.014, 0.003);
  gb.box(0, y0, -hl - 0.0005, W * 0.9, 0.11, 0.003);
  m.paint(false);
  // panoramic windscreen in a black surround, glazed A-pillars, LED destination display
  gb.color(0x14181b);
  onSlope(gb, -hw, hw, yB, yE, yB, yE, zB, hl, 0);
  gl.color(0xffffff);
  onSlope(gl, -hw + 0.008, hw - 0.008, yB + 0.006, yE - 0.004, yB, yE, zB, hl, 0.0015);
  gl.triangle(hw + 0.002, yB + 0.015, hl - 0.03, hw + 0.002, yB + 0.015, zB + 0.006, hw + 0.002, yE - 0.035, zB + 0.006);
  gl.triangle(-hw - 0.002, yB + 0.015, zB + 0.006, -hw - 0.002, yB + 0.015, hl - 0.03, -hw - 0.002, yE - 0.035, zB + 0.006);
  gb.color(0x0d0d0d); onSlope(gb, -hw * 0.6, hw * 0.6, yE - 0.03, yE - 0.008, yB, yE, zB, hl, 0.0022);
  gb.color(0xffb84d); onSlope(gb, -hw * 0.48, hw * 0.48, yE - 0.024, yE - 0.014, yB, yE, zB, hl, 0.003);
  // flush double glazing: one black band, panes split by thin joints
  gb.color(0x14181b);
  gb.box(0, wy0 - 0.007, (zw0 + zw1) / 2, W + 0.002, wy1 - wy0 + 0.014, zw1 - zw0);
  windowBand(gl, zw0 + 0.005, zw1 - 0.003, wy0, wy1, hw + 0.002, Math.max(4, Math.round((zw1 - zw0) / 0.19)), 0.006);
  coachDoor(gb, gl, hw, hl - 0.177, 0.082, y0, wy1);
  bays(gb, hw, axR[0] + 0.078, axF - 0.078, y0 + 0.008, 0.172);
  // front: grille, LED headlamps and daytime strips, bumper, "rabbit ear" mirrors
  gb.color(0x1b1f22); gb.box(0, 0.06, hl + 0.0008, 0.12, 0.03, 0.003);
  gb.color(0xfff6c8);
  for (const sx of [-1, 1]) gb.box(sx * 0.088, 0.078, hl + 0.001, 0.055, 0.016, 0.004);
  gb.color(0xeef6ff);
  for (const sx of [-1, 1]) gb.box(sx * 0.09, 0.098, hl + 0.001, 0.05, 0.004, 0.004);
  gb.color(0x2a2d30);
  gb.box(0, y0 - 0.006, hl + 0.004, W - 0.004, 0.02, 0.01);
  gb.box(0, y0 - 0.006, -hl - 0.004, W * 0.92, 0.02, 0.01);
  gb.color(0x1e2124);
  for (const sx of [-1, 1]) {
    const xa = sx * (hw - 0.012), xb = sx * (hw + 0.022);
    gb.tube(xa, yE - 0.004, zB + 0.004, xb, yE - 0.024, hl + 0.03, 0.0045, 4);
    gb.tube(xb, yE - 0.024, hl + 0.03, xb, 0.27, hl + 0.05, 0.004, 4);
    gb.box(xb, 0.225, hl + 0.05, 0.016, 0.052, 0.01);
  }
  // rear: window, engine grille, vertical lamp strips
  gb.color(0x14181b); gb.box(0, 0.235, -hl - 0.001, W * 0.8, 0.1, 0.003);
  endWindow(gl, -hl - 0.0035, 0.245, 0.325, hw * 0.72, true);
  gb.color(0x2b2e31); gb.box(0, y0 + 0.02, -hl - 0.0025, W * 0.55, 0.06, 0.003);
  gb.color(0xb02a20);
  for (const sx of [-1, 1]) gb.box(sx * (hw - 0.02), 0.07, -hl - 0.002, 0.016, 0.11, 0.004);
  // roof: low air-conditioning fairing
  gb.color(0xe4e7ea); gb.box(0, yT - 0.008, -hl * 0.05, W * 0.6, 0.024, L * 0.45);
  coachWheels(gb, hw, axF, axR, r, 0xb8bcc0);
  const g = m.build();
  return {
    ...g, length: L, lo: coachLo(L, W, y0, yE, yT, [wy0, wy1], [yB + 0.01, yE - 0.02], [[y0, 0.344, -hl - 0.001, zw0 - 0.04], [0.09, 0.172, zw0 - 0.04, zw0 + 0.25], [0.14, 0.17, zw0 + 0.25, ze]], [axF, ...axR], 0xe4e7ea),
    front: [[0.088, 0.086, hl + 0.01], [-0.088, 0.086, hl + 0.01]], rear: [[hw - 0.02, 0.125, -hl - 0.012], [-hw + 0.02, 0.125, -hl - 0.012]],
    bogies: [], bogieKind: 'b2',
  };
}

/** Ambient town traffic: 0 sedan, 1 hatchback, 2 van, 3 truck. Paint parts take the instance colour. */
function car(style: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const L = style === 3 ? 0.7 : style === 1 ? 0.4 : 0.45;
  const hl = L / 2;
  const W = style === 3 ? 0.24 : 0.18, hw = W / 2;
  const wr = style === 3 ? 0.045 : 0.032;
  let front: [number, number, number][], rear: [number, number, number][];
  let lo: { body: THREE.BufferGeometry; glass: THREE.BufferGeometry };
  if (style === 3) {
    m.paint(true);
    gb.color(0xffffff);
    prism(gb, hl - 0.18, hl - 0.005, [[-hw, 0.04], [hw, 0.04], [hw, 0.24], [hw - 0.02, 0.27], [-hw + 0.02, 0.27], [-hw, 0.24]], 0.5);
    m.paint(false);
    gb.color(0xe4e4e0);
    prism(gb, -hl, hl - 0.2, [[-hw - 0.005, 0.06], [hw + 0.005, 0.06], [hw + 0.005, 0.31], [-hw - 0.005, 0.31]], 0.2);
    gb.color(0x222222);
    gb.box(0, 0.02, 0, W - 0.04, 0.04, L - 0.02);
    gb.box(0, 0.035, hl - 0.003, W - 0.02, 0.03, 0.01);
    endWindow(gl, hl - 0.003, 0.15, 0.25, hw - 0.02);
    windowBand(gl, hl - 0.14, hl - 0.04, 0.16, 0.24, hw + 0.002, 1);
    front = [[0.08, 0.08, hl + 0.005], [-0.08, 0.08, hl + 0.005]];
    rear = [[0.1, 0.08, -hl - 0.005], [-0.1, 0.08, -hl - 0.005]];
    const lb = new MB();
    lb.paint(true); lb.gb.color(0xffffff); lb.gb.box(0, 0.03, hl - 0.1, W, 0.24, 0.18); lb.paint(false);
    lb.gb.color(0xe4e4e0); lb.gb.box(0, 0.05, -0.1, W + 0.01, 0.26, 0.48);
    lo = lb.build();
  } else if (style === 2) {
    m.paint(true);
    gb.color(0xffffff);
    prism(gb, -hl, hl - 0.07, [[-hw, 0.03], [hw, 0.03], [hw, 0.175], [hw - 0.012, 0.19], [-hw + 0.012, 0.19], [-hw, 0.175]], 0.5);
    taper(gb, hl - 0.07, hl, 0.03, W, 0.15, W - 0.012, 0.075);
    m.paint(false);
    gb.color(0x222222);
    gb.box(0, 0.025, hl - 0.004, W - 0.01, 0.025, 0.01);
    gb.box(0, 0.025, -hl + 0.004, W - 0.01, 0.025, 0.01);
    gl.color(0xffffff);
    gl.quad(-hw + 0.01, 0.12, hl - 0.06, hw - 0.01, 0.12, hl - 0.06, hw - 0.01, 0.17, hl - 0.075, -hw + 0.01, 0.17, hl - 0.075);
    windowBand(gl, hl - 0.17, hl - 0.075, 0.115, 0.17, hw + 0.002, 1);
    front = [[0.06, 0.07, hl + 0.004], [-0.06, 0.07, hl + 0.004]];
    rear = [[0.075, 0.09, -hl - 0.004], [-0.075, 0.09, -hl - 0.004]];
    const lb = new MB();
    lb.paint(true); lb.gb.color(0xffffff); lb.gb.box(0, 0.03, 0, W, 0.16, L); lb.paint(false);
    lo = lb.build();
  } else {
    const cz = style === 1 ? -0.04 : -0.01;
    const cl = style === 1 ? 0.22 : 0.2;
    m.paint(true);
    gb.color(0xffffff);
    // lower body with a sloping bonnet and boot
    prism(gb, -hl + 0.03, hl - 0.03, [[-hw, 0.028], [hw, 0.028], [hw, 0.085], [hw - 0.01, 0.095], [-hw + 0.01, 0.095], [-hw, 0.085]], 0.5);
    taper(gb, hl - 0.03, hl, 0.028, W, 0.062, W - 0.02, 0.045);
    if (style === 0) taper(gb, -hl + 0.03, -hl, 0.028, W, 0.067, W - 0.02, 0.05);
    else taper(gb, -hl + 0.03, -hl, 0.028, W, 0.067, W - 0.01, 0.06);
    // cabin
    taper(gb, cz - cl / 2, cz + cl / 2, 0.093, W - 0.012, 0.052, W - 0.03, 0.047);
    if (style === 1) taper(gb, cz - cl / 2 - 0.035, cz - cl / 2, 0.093, W - 0.014, 0.02, W - 0.012, 0.052);
    m.paint(false);
    gb.color(0x1f1f1f);
    gb.box(0, 0.024, hl - 0.002, W - 0.01, 0.022, 0.008);
    gb.box(0, 0.024, -hl + 0.002, W - 0.01, 0.022, 0.008);
    windowBand(gl, cz - cl / 2 + 0.015, cz + cl / 2 - 0.015, 0.1, 0.138, (W - 0.012) / 2 + 0.002, 2, 0.012);
    gl.color(0xffffff);
    gl.quad(-hw + 0.012, 0.096, cz + cl / 2 + 0.004, hw - 0.012, 0.096, cz + cl / 2 + 0.004, hw - 0.022, 0.142, cz + cl / 2 - 0.002, -hw + 0.022, 0.142, cz + cl / 2 - 0.002);
    gl.quad(hw - 0.016, 0.1, cz - cl / 2 - 0.003, -hw + 0.016, 0.1, cz - cl / 2 - 0.003, -hw + 0.024, 0.14, cz - cl / 2 + 0.002, hw - 0.024, 0.14, cz - cl / 2 + 0.002);
    front = [[0.06, 0.068, hl + 0.003], [-0.06, 0.068, hl + 0.003]];
    rear = [[0.065, 0.075, -hl - 0.003], [-0.065, 0.075, -hl - 0.003]];
    const lb = new MB();
    lb.paint(true); lb.gb.color(0xffffff); lb.gb.box(0, 0.028, 0, W, 0.065, L - 0.02); lb.gb.box(0, 0.093, cz, W - 0.02, 0.05, cl); lb.paint(false);
    lo = lb.build();
  }
  const ax = style === 3 ? [hl - 0.12, -hl + 0.16, -hl + 0.28] : [hl - 0.085, -hl + 0.085];
  for (const z of ax) axle(gb, z, wr, hw - 0.012, 0.022, 0x151515, 10, 0x9a9a9a);
  gb.color(0xfff6c8);
  for (const [x, y, z] of front) gb.box(x, y - 0.008, z - 0.004, 0.03, 0.016, 0.004);
  gb.color(0xb02a20);
  for (const [x, y, z] of rear) gb.box(x, y - 0.008, z + 0.001, 0.03, 0.016, 0.004);
  const g = m.build();
  return { ...g, length: L, lo, front, rear, bogies: [], bogieKind: 'b2' };
}

// ------------------------------------------------------------------------------------ trams

/** Section roles: single car, cab end (+z is the cab), cab with pantograph, middle module (with pantograph). */
export type TramRole = 'single' | 'cab' | 'cabp' | 'mid' | 'midp';

interface TramSpec { W: number; y0: number; yE: number; yT: number; roof: number }
const TRAM: Record<string, TramSpec> = {
  tram_early: { W: 0.22, y0: 0.085, yE: 0.29, yT: 0.315, roof: 0x4a4440 },
  tram_pcc: { W: 0.25, y0: 0.07, yE: 0.27, yT: 0.305, roof: 0xc5c8cc },
  tram_artic: { W: 0.235, y0: 0.07, yE: 0.285, yT: 0.31, roof: 0xb4b8bc },
  tram_modern: { W: 0.265, y0: 0.03, yE: 0.3, yT: 0.33, roof: 0xd9dcdf },
};
/** Gap between articulated sections (filled by bellows). */
export const TRAM_GAP = 0.04;

/** Number of body sections: the model's `sections`, else a default for the style and length. */
export function tramSections(style: string, length: number, sections?: number): number {
  if (sections && sections >= 1) return Math.min(7, Math.round(sections));
  if (style === 'tram_modern') return length >= 3.2 ? 5 : 3;
  if (style === 'tram_artic') return length >= 2.6 ? 3 : 2;
  return 1;
}

/** Roles front to back: cabs at both ends, the pantograph on the leading cab (older) or the centre module (modern). */
export function tramRoles(style: string, n: number): TramRole[] {
  if (n <= 1) return ['single'];
  const r: TramRole[] = [];
  for (let i = 0; i < n; i++) r.push(i === 0 || i === n - 1 ? 'cab' : 'mid');
  if (style === 'tram_modern') { const c = Math.floor(n / 2); r[c] = r[c] === 'cab' ? 'cabp' : 'midp'; } else r[0] = 'cabp';
  return r;
}

/** Side-wall quads between two profiles at z0 < z1 (same vertex count), with a cap at the end facing `cap`. */
function loft(gb: GeoBuilder, a: P2[], z0: number, b: P2[], z1: number, cap: 1 | -1 | 0) {
  const n = a.length;
  for (let k = 0; k < n; k++) {
    const k2 = (k + 1) % n;
    gb.quad(a[k][0], a[k][1], z0, a[k2][0], a[k2][1], z0, b[k2][0], b[k2][1], z1, b[k][0], b[k][1], z1);
  }
  if (!cap) return;
  const pr = cap > 0 ? b : a, z = cap > 0 ? z1 : z0;
  let cx = 0, cy = 0;
  for (const [x, y] of pr) { cx += x; cy += y; }
  const c = gb.vertex(cx / n, cy / n, z, 0, 0, cap);
  const ring = pr.map(([x, y]) => gb.vertex(x, y, z, 0, 0, cap));
  for (let i = 0; i < n; i++) {
    if (cap > 0) gb.idx.push(c, ring[i], ring[(i + 1) % n]);
    else gb.idx.push(c, ring[(i + 1) % n], ring[i]);
  }
}

/** Profile scaled about the floor line: width factor sx, height factor sy. */
const scaleP = (p: P2[], sx: number, y0: number, sy: number): P2[] => p.map(([x, y]) => [x * sx, y0 + (y - y0) * sy]);

/** Trolley pole (early cars, PCC): base on the roof, trailing back up to the contact wire. */
function trolleyPole(gb: GeoBuilder, z: number, roofY: number, reach: number) {
  gb.color(0x2b2b2b);
  gb.box(0, roofY, z, 0.06, 0.018, 0.09);
  gb.tube(0, roofY + 0.02, z, 0, 0.546, z - reach, 0.006, 5);
  gb.color(0x555555);
  gb.box(0, 0.54, z - reach, 0.03, 0.012, 0.035);
}

/** Bellows half at a joint end (z = end of the body, dir = +1 / -1 outward). */
function bellows(gb: GeoBuilder, zEnd: number, dir: number, W: number, y0: number, yE: number) {
  gb.color(0x1d1d1d);
  gb.box(0, y0 + 0.01, zEnd + dir * (TRAM_GAP / 4), W - 0.04, yE - y0 - 0.02, TRAM_GAP / 2 + 0.01);
}

function tramWheels(gb: GeoBuilder, zs: number[], r: number) {
  gb.color(0x232323);
  for (const z of zs) gb.box(0, 0.012, z, 0.17, 0.035, 0.24);
  for (const z of zs) { axle(gb, z - 0.07, r, 0.072, 0.014, 0x1d1d1d, 10); axle(gb, z + 0.07, r, 0.072, 0.014, 0x1d1d1d, 10); }
}

function tramSection(style: string, role: TramRole, len: number): ModelGeo {
  const sp = TRAM[style] ?? TRAM.tram_artic;
  const { W, y0, yE, yT } = sp;
  const hw = W / 2, hl = len / 2 - 0.004;
  const m = new MB(), gb = m.gb, gl = m.gl;
  const cabF = role !== 'mid' && role !== 'midp';            // cab at +z
  const cabR = role === 'single';                             // cab at -z too
  const panto = role === 'cabp' || role === 'midp';
  let front: [number, number, number][] = [], rear: [number, number, number][] = [];
  if (style === 'tram_early') {
    const pl = Math.min(0.24, len * 0.16);
    const s0 = -hl + (cabR ? pl : 0), s1 = hl - (cabF ? pl : 0);
    // saloon body, rocker panel in the operator colour, cream letterboard
    m.paint(true); gb.color(0xffffff);
    prism(gb, s0, s1, [[-hw, y0], [hw, y0], [hw, yE], [-hw, yE]], 0.2);
    m.accent(true); gb.color(0xffffff);
    gb.box(0, y0, (s0 + s1) / 2, W + 0.005, 0.045, s1 - s0 - 0.01);
    m.paint(false);
    gb.color(0xe9dcb8);
    gb.box(0, 0.265, (s0 + s1) / 2, W + 0.004, 0.02, s1 - s0 - 0.01);
    // roof over saloon and platforms, clerestory with small windows
    gb.color(sp.roof);
    prism(gb, -hl, hl, roofProfile(hw + 0.006, yE, yE + 0.003, yT, 0.55), 0.7);
    gb.color(0x3a3530);
    gb.box(0, yT - 0.004, (s0 + s1) / 2, 0.09, 0.028, Math.max(0.1, s1 - s0 - 0.06));
    gl.color(0xffffff);
    for (const sx of [-1, 1]) for (let z = s0 + 0.05; z < s1 - 0.08; z += 0.09) {
      const x = sx * 0.0455, a = z, b = z + 0.05, ya = yT + 0.002, yb = yT + 0.018;
      if (sx > 0) gl.quad(x, ya, b, x, ya, a, x, yb, a, x, yb, b); else gl.quad(x, ya, a, x, ya, b, x, yb, b, x, yb, a);
    }
    windowBand(gl, s0 + 0.04, s1 - 0.04, 0.165, 0.255, hw + 0.002, Math.max(3, Math.round((s1 - s0 - 0.08) / 0.12)), 0.022);
    // open platforms: floor, dash with lamp, corner posts and steps
    for (const [on, dir] of [[cabF, 1], [cabR, -1]] as const) {
      if (!on) continue;
      const zc = dir * (hl - pl / 2);
      gb.color(0x2e2a26);
      gb.box(0, y0 - 0.012, zc, W - 0.01, 0.012, pl);
      m.paint(true); gb.color(0xffffff);
      gb.box(0, y0, dir * (hl - 0.012), W - 0.02, 0.115, 0.024);
      m.paint(false);
      gb.color(0x1f1f1f);
      for (const sx of [-1, 1]) {
        gb.box(sx * (hw - 0.006), y0, dir * (hl - 0.01), 0.008, yE - y0, 0.008);
        gb.box(sx * (hw - 0.006), y0, dir * (hl - pl + 0.01), 0.008, yE - y0, 0.008);
        gb.box(sx * (hw + 0.008), y0 - 0.05, zc, 0.03, 0.012, pl * 0.7);
      }
      gb.color(0xfff1c4);
      gb.cylinder(0, y0 + 0.115, dir * (hl - 0.01), 0.014, 0.022, 8);
    }
    tramWheels(gb, [0], 0.04);
    if (role === 'single' || panto) trolleyPole(gb, 0.12, yT + 0.008, 0.48);
    front = [[0, y0 + 0.125, hl + 0.006]];
    rear = cabR ? [[0, y0 + 0.125, -hl - 0.006]] : [];
  } else if (style === 'tram_pcc') {
    const prof = roofProfile(hw, y0, yE, yT, 0.35);
    const zf = cabF ? hl - 0.17 : hl, zr = cabR ? -hl + 0.13 : -hl;
    m.paint(true); gb.color(0xffffff);
    prism(gb, zr, zf, prof, 0.7);
    if (cabF) loft(gb, prof, zf, scaleP(prof, 0.8, y0, 0.86), hl, 1); else bellows(gb, hl, 1, W, y0, yE);
    if (cabR) loft(gb, scaleP(prof, 0.86, y0, 0.9), -hl, prof, zr, -1); else bellows(gb, -hl, -1, W, y0, yE);
    m.accent(true); gb.color(0xffffff);
    gb.box(0, y0, (zr + zf) / 2, W + 0.004, 0.035, zf - zr - 0.01);
    gb.box(0, 0.148, (zr + zf) / 2, W + 0.004, 0.012, zf - zr - 0.01);
    m.paint(false);
    gb.color(0xd8d8d8);
    gb.box(0, 0.258, (zr + zf) / 2, W + 0.004, 0.006, zf - zr - 0.02);
    windowBand(gl, zr + 0.06, zf - 0.04, 0.165, 0.25, hw + 0.002, Math.max(3, Math.round((zf - zr - 0.1) / 0.13)), 0.025);
    if (cabF) {
      // three-pane windscreen on the nose
      const ys = 0.16, ye = 0.245, w0 = hw * 0.92, w1 = hw * 0.78;
      gl.color(0xffffff);
      gl.quad(-w1 * 0.45, ys, hl - 0.004, w1 * 0.45, ys, hl - 0.004, w1 * 0.45, ye, hl - 0.012, -w1 * 0.45, ye, hl - 0.012);
      gl.quad(w1 * 0.5, ys, hl - 0.01, w0, ys, zf + 0.02, w0, ye, zf + 0.02, w1 * 0.5, ye, hl - 0.016);
      gl.quad(-w0, ys, zf + 0.02, -w1 * 0.5, ys, hl - 0.01, -w1 * 0.5, ye, hl - 0.016, -w0, ye, zf + 0.02);
      gb.color(0xfff1c4);
      gb.cylinder(0, y0 + 0.045, hl - 0.004, 0.018, 0.01, 8);
      front = [[0, y0 + 0.055, hl + 0.006]];
    }
    if (cabR) { endWindow(gl, -hl - 0.001, 0.17, 0.245, hw * 0.55, true); rear = [[0.07, y0 + 0.07, -hl - 0.006], [-0.07, y0 + 0.07, -hl - 0.006]]; }
    tramWheels(gb, [len * 0.3, -len * 0.3], 0.033);
    if (role === 'single' || panto) trolleyPole(gb, -len * 0.12, yT + 0.004, 0.46);
  } else {
    // articulated (angular, 1960s-80s) and modern low-floor modules
    const modern = style === 'tram_modern';
    const prof: P2[] = [[-hw, y0], [hw, y0], [hw, yE], [-hw, yE]];
    const nose = cabF ? (modern ? 0.2 : 0.07) : 0;
    const zb1 = hl - nose;
    m.paint(true); gb.color(0xffffff);
    prism(gb, -hl, zb1, prof, 0.2);
    if (cabF) {
      if (modern) loft(gb, prof, zb1, [[-hw * 0.82, y0], [hw * 0.82, y0], [hw * 0.8, yE - 0.03], [-hw * 0.8, yE - 0.03]], hl, 1);
      else loft(gb, prof, zb1, [[-hw + 0.01, y0], [hw - 0.01, y0], [hw - 0.012, yE - 0.012], [-hw + 0.012, yE - 0.012]], hl, 1);
    } else bellows(gb, hl, 1, W, y0, yE);
    bellows(gb, -hl, -1, W, y0, yE);
    // operator colour: skirt band and a band under the windows (modern: cab mask)
    m.accent(true); gb.color(0xffffff);
    gb.box(0, y0, (zb1 - hl) / 2, W + 0.004, modern ? 0.035 : 0.03, zb1 + hl - 0.01);
    if (!modern) gb.box(0, 0.138, (zb1 - hl) / 2, W + 0.004, 0.026, zb1 + hl - 0.01);
    if (modern && cabF) gb.box(0, y0 + 0.01, hl - nose / 2 - 0.01, W * 0.86, 0.075, nose * 0.9);
    m.paint(false);
    // roof and equipment
    gb.color(sp.roof);
    prism(gb, -hl + 0.005, zb1, roofProfile(hw - 0.002, yE - 0.001, yE + 0.003, yT, modern ? 0.72 : 0.78), 0.7);
    gb.color(0x9ea3a8);
    if (modern && !cabF) gb.box(0, yT - 0.004, 0, W * 0.62, 0.03, Math.max(0.12, len * 0.55));
    if (modern && cabF) gb.box(0, yT - 0.004, -hl * 0.3, W * 0.55, 0.022, len * 0.35);
    if (panto) pantograph(gb, role === 'cabp' ? -hl * 0.2 : 0, yT + 0.004);
    // windows and doors
    const wy0 = modern ? 0.085 : 0.168, wy1 = modern ? 0.28 : 0.27;
    const zw0 = -hl + 0.05, zw1 = zb1 - (cabF ? 0.05 : 0.05);
    windowBand(gl, zw0, zw1, wy0, wy1, hw + 0.002, Math.max(2, Math.round((zw1 - zw0) / (modern ? 0.17 : 0.13))), modern ? 0.014 : 0.022);
    const dz = cabF ? -hl * 0.35 : 0;
    gb.color(0x2a2a2a);
    for (const sx of [-1, 1]) gb.box(sx * (hw + 0.001), y0 + 0.005, dz, 0.004, wy1 - y0, 0.13);
    gl.color(0xffffff);
    for (const sx of [-1, 1]) {
      const x = sx * (hw + 0.004), a = dz - 0.06, b = dz + 0.06, ya = y0 + 0.02, yb = wy1;
      if (sx > 0) gl.quad(x, ya, b, x, ya, a, x, yb, a, x, yb, b); else gl.quad(x, ya, a, x, ya, b, x, yb, b, x, yb, a);
    }
    if (cabF) {
      gl.color(0xffffff);
      if (modern) {
        // wraparound windscreen on the nose
        const zs = zb1 + 0.01, ze = hl - 0.004, ya = 0.12, yb = yE - 0.035;
        gl.quad(-hw * 0.8, ya, ze, hw * 0.8, ya, ze, hw * 0.79, yb, ze, -hw * 0.79, yb, ze);
        gl.quad(hw * 0.81 + 0.003, ya, ze - 0.01, hw + 0.003, ya, zs, hw + 0.003, yb + 0.02, zs, hw * 0.8 + 0.003, yb, ze - 0.01);
        gl.quad(-hw - 0.003, ya, zs, -hw * 0.81 - 0.003, ya, ze - 0.01, -hw * 0.8 - 0.003, yb, ze - 0.01, -hw - 0.003, yb + 0.02, zs);
      } else endWindow(gl, hl + 0.002, 0.168, 0.265, hw - 0.03);
      gb.color(0x111111);
      gb.box(0, yE - (modern ? 0.03 : 0.022), hl - (modern ? 0.02 : 0.003), W * 0.5, 0.02, 0.006);
      gb.color(0xffb84d);
      gb.box(0, yE - (modern ? 0.026 : 0.018), hl - (modern ? 0.017 : 0.0), W * 0.4, 0.011, 0.003);
      gb.color(0xfff1c4);
      const ly = modern ? 0.07 : y0 + 0.05;
      gb.box(0.075, ly - 0.01, hl - 0.002, 0.03, 0.018, 0.006); gb.box(-0.075, ly - 0.01, hl - 0.002, 0.03, 0.018, 0.006);
      front = [[0.075, ly, hl + 0.006], [-0.075, ly, hl + 0.006]];
      rear = [[0.08, ly + 0.01, hl + 0.006], [-0.08, ly + 0.01, hl + 0.006]];
    }
    if (!modern) tramWheels(gb, cabF ? [hl - 0.28, -hl + 0.12] : [0], 0.035);
    else { gb.color(0x1e1e1e); gb.box(0, 0.006, 0, W - 0.05, y0, Math.max(0.1, len - 0.2)); }
  }
  const g = m.build();
  // low detail: painted box, roof, operator band, one window strip
  const lb = new MB();
  lb.paint(true); lb.gb.color(0xffffff); lb.gb.box(0, y0, 0, W, yE - y0, hl * 2);
  lb.accent(true); lb.gb.color(0xffffff); lb.gb.box(0, y0, 0, W + 0.004, 0.035, hl * 2 - 0.01);
  lb.paint(false); lb.gb.color(sp.roof); lb.gb.box(0, yE, 0, W * 0.9, yT - yE, hl * 2 - 0.02);
  windowBand(lb.gl, -hl + 0.05, hl - 0.05, style === 'tram_modern' ? 0.09 : 0.17, 0.27, hw + 0.002, 1, 0);
  return { ...g, lo: lb.build(), length: len, front, rear, bogies: [], bogieKind: 'b2' };
}

/** Geometry of one tram section (cached per style, role and length). */
export function getTramSection(style: string, role: TramRole, len: number): ModelGeo {
  const key = 'tram:' + style + ':' + role + ':' + len.toFixed(3);
  let m = cache.get(key);
  if (!m) { m = tramSection(style, role, len); cache.set(key, m); }
  return m;
}

// ------------------------------------------------------------------------------------ multiple units

/** Cars of a multiple unit: cab end at +z ('cab'), middle car, or a single car with cabs at both ends. */
export type EmuRole = 'cab' | 'mid' | 'single';
/** Gap between the cars of one unit (close-coupled, with gangway bellows). */
export const EMU_GAP = 0.05;

type CabKind = 'flat3' | 'mask' | 'wrap' | 'round' | 'wedge' | 'duck' | 'long' | 'xlong';
interface EmuSpec {
  W: number; y0: number; yE: number; yT: number; flat: number;
  doors: number; doorW: number;
  /** unpainted stainless body: ribbed lower sides, livery only in the bands */
  stainless: boolean;
  /** operator-colour bands [y0, y1] along the body */
  bands: [number, number][];
  cab: CabKind;
  /** nose length (units) of the cab car */
  nose: number;
  roof: number;
  equip: 'vent' | 'ac' | 'smooth';
  win: [number, number];
  /** window pitch; continuous (flush) glazing when 0 */
  pitch: number;
  skirt: boolean;
  hsr: boolean;
}
const hs = (cab: CabKind, nose: number, bands: [number, number][]): EmuSpec => ({
  W: 0.3, y0: 0.075, yE: 0.36, yT: 0.405, flat: 0.5, doors: 1, doorW: 0.075, stainless: false, bands, cab, nose,
  roof: 0xe9e9e6, equip: 'smooth', win: [0.245, 0.315], pitch: 0.13, skirt: true, hsr: true,
});
const EMU: Record<string, EmuSpec> = {
  metro_steel: { W: 0.28, y0: 0.1, yE: 0.355, yT: 0.39, flat: 0.75, doors: 4, doorW: 0.13, stainless: false, bands: [[0.2, 0.222]], cab: 'flat3', nose: 0, roof: 0x6b6f73, equip: 'vent', win: [0.235, 0.33], pitch: 0.12, skirt: false, hsr: false },
  metro_stainless: { W: 0.28, y0: 0.1, yE: 0.36, yT: 0.395, flat: 0.8, doors: 4, doorW: 0.13, stainless: true, bands: [[0.2, 0.226]], cab: 'mask', nose: 0, roof: 0x8d9296, equip: 'ac', win: [0.235, 0.335], pitch: 0.14, skirt: false, hsr: false },
  metro_modern: { W: 0.285, y0: 0.095, yE: 0.365, yT: 0.4, flat: 0.8, doors: 4, doorW: 0.14, stainless: true, bands: [[0.338, 0.356], [0.116, 0.132]], cab: 'wrap', nose: 0.07, roof: 0xa9aeb3, equip: 'ac', win: [0.225, 0.33], pitch: 0, skirt: true, hsr: false },
  emu_60s: { W: 0.285, y0: 0.11, yE: 0.36, yT: 0.405, flat: 0.6, doors: 4, doorW: 0.12, stainless: false, bands: [[0.205, 0.218]], cab: 'flat3', nose: 0, roof: 0x5d6064, equip: 'vent', win: [0.24, 0.33], pitch: 0.12, skirt: false, hsr: false },
  emu_80s: { W: 0.29, y0: 0.105, yE: 0.365, yT: 0.405, flat: 0.75, doors: 4, doorW: 0.12, stainless: true, bands: [[0.198, 0.226]], cab: 'mask', nose: 0, roof: 0x8d9296, equip: 'ac', win: [0.235, 0.335], pitch: 0.15, skirt: false, hsr: false },
  emu_modern: { W: 0.295, y0: 0.1, yE: 0.37, yT: 0.405, flat: 0.8, doors: 4, doorW: 0.13, stainless: true, bands: [[0.342, 0.36], [0.2, 0.222]], cab: 'wrap', nose: 0.09, roof: 0xa9aeb3, equip: 'ac', win: [0.225, 0.335], pitch: 0, skirt: true, hsr: false },
  hsr_0: hs('round', 0.36, [[0.205, 0.238], [0.09, 0.104]]),
  hsr_1: hs('wedge', 0.5, [[0.205, 0.232], [0.18, 0.19]]),
  hsr_2: hs('duck', 0.66, [[0.2, 0.225], [0.17, 0.178]]),
  hsr_3: hs('long', 0.8, [[0.212, 0.232]]),
  hsr_4: hs('xlong', 1.0, [[0.19, 0.215]]),
};

/** Multiple-unit styles drawn as articulated light rail (tram sections on rails). */
export function lrvStyle(style: string): string | null {
  return style === 'lrv' ? 'tram_artic' : style === 'lrv_modern' ? 'tram_modern' : null;
}

/**
 * Nose cross-section at t (0 = full body, 1 = tip) for the high-speed styles: width scale, height scale
 * (about the floor) and floor lift.
 */
function noseShape(cab: CabKind, t: number): [number, number, number] {
  const s = (a: number, b: number, x: number) => { const k = Math.min(1, Math.max(0, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  switch (cab) {
    case 'round': { const c = Math.sqrt(Math.max(0, 1 - Math.pow(t, 2.2))); return [0.38 + 0.62 * c, 0.42 + 0.58 * c, 0.035 * t]; }
    case 'wedge': return [1 - 0.42 * t * t, 1 - 0.68 * t, 0.012 * t];
    case 'duck': return [1 - 0.22 * t * t, 1 - 0.3 * s(0, 0.3, t) - 0.48 * s(0.38, 0.75, t), 0];
    case 'long': return [1 - 0.55 * Math.pow(t, 1.5), 1 - 0.78 * Math.pow(t, 1.15) + 0.05 * Math.sin(Math.PI * Math.min(1, t * 1.8)), 0];
    default: return [1 - 0.62 * Math.pow(t, 1.35), 1 - 0.84 * Math.pow(t, 1.05) + 0.04 * Math.sin(Math.PI * Math.min(1, t * 2.2)), 0];
  }
}

/** One car of a multiple unit (cached per style, role, length and pantograph). */
function emuCar(style: string, role: EmuRole, len: number, panto: boolean): ModelGeo {
  const sp = EMU[style] ?? EMU.emu_80s;
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = len / 2 - 0.006, W = sp.W, hw = W / 2;
  const { y0, yE, yT } = sp;
  const cabF = role !== 'mid', cabR = role === 'single';
  const noseL = Math.min(sp.nose, len * 0.58);
  const zf = cabF && noseL > 0 ? hl - noseL : hl, zr = cabR && noseL > 0 ? -hl + noseL : -hl;
  const prof = roofProfile(hw, y0, yE, yT, sp.flat);
  // ---- body shell (painted: model colour; stainless: bare metal, the model colour goes on bands and the cab)
  if (sp.stainless) { m.paint(false); gb.color(0xc6cace); } else { m.paint(true); gb.color(0xffffff); }
  prism(gb, zr, zf, prof, 0.6, false);
  let front: [number, number, number][] = [], rear: [number, number, number][] = [];
  const ends: [boolean, number][] = [[cabF, 1], [cabR, -1]];
  for (const [isCab, dir] of ends) {
    const zEnd = dir > 0 ? zf : zr, zTip = dir * hl;
    if (isCab && noseL > 0 && sp.hsr) {
      // lofted nose: sections from the body to a small cap at the tip
      const N = 12;
      let prev = prof, zp = zEnd;
      for (let k = 1; k <= N; k++) {
        const t = k / N, [sx, sy, lift] = noseShape(sp.cab, Math.min(t, 0.985));
        const sec: P2[] = prof.map(([x, y]) => [x * sx, y0 + lift + (y - y0) * sy]);
        const z = zEnd + dir * noseL * t;
        if (dir > 0) loft(gb, prev, zp, sec, z, k === N ? 1 : 0); else loft(gb, sec, z, prev, zp, k === N ? -1 : 0);
        prev = sec; zp = z;
      }
    } else if (isCab && noseL > 0) {
      // short raked cab: slightly narrower and lower at the face
      const sec = scaleP(prof, 0.93, y0, 0.965);
      if (dir > 0) loft(gb, prof, zEnd, sec, zTip, 1); else loft(gb, sec, zTip, prof, zEnd, -1);
    } else {
      // flat end (gangway or flat cab)
      const ring = prof;
      let cx = 0, cy = 0;
      for (const [x, y] of ring) { cx += x; cy += y; }
      const c = gb.vertex(cx / ring.length, cy / ring.length, zEnd, 0, 0, dir);
      const ids = ring.map(([x, y]) => gb.vertex(x, y, zEnd, 0, 0, dir));
      for (let i = 0; i < ring.length; i++) {
        if (dir > 0) gb.idx.push(c, ids[i], ids[(i + 1) % ring.length]);
        else gb.idx.push(c, ids[(i + 1) % ring.length], ids[i]);
      }
    }
  }
  // ---- livery bands: the first in the operator's colour, further ones in the model colour
  const bz0 = zr + 0.005, bz1 = zf - 0.005;
  sp.bands.forEach(([a, b], i) => {
    if (i === 0) m.accent(true); else m.paint(true);
    gb.color(0xffffff);
    gb.box(0, a, (bz0 + bz1) / 2, W + 0.004, b - a, bz1 - bz0);
  });
  m.paint(false);
  // stainless: fine ribs along the lower body
  if (sp.stainless) {
    gb.color(0xb9bdc2);
    for (let y = y0 + 0.02; y < (sp.bands[0]?.[0] ?? 0.19) - 0.008; y += 0.018) gb.box(0, y, (bz0 + bz1) / 2, W + 0.002, 0.004, bz1 - bz0 - 0.02);
  }
  // ---- doors and windows
  const doorZ: number[] = [];
  const d0 = zr + 0.16, d1 = zf - 0.16;
  if (sp.doors === 1) { if (cabF) doorZ.push(zf - 0.12); if (!cabF || cabR) doorZ.push(zr + 0.12); }
  else for (let i = 0; i < sp.doors; i++) doorZ.push(d0 + ((d1 - d0) * (i + 0.5)) / sp.doors);
  gb.color(0x1b1d20);
  for (const z of doorZ) for (const sx of [-1, 1]) gb.box(sx * (hw + 0.0015), y0 + 0.012, z, 0.003, sp.win[1] - y0 + 0.004, sp.doorW + 0.008);
  gl.color(0xffffff);
  for (const z of doorZ) for (const sx of [-1, 1]) {
    // two door leaves, glazed above waist height
    for (const k of [-1, 1]) {
      const a = z + (k < 0 ? -sp.doorW / 2 + 0.004 : 0.004), b = z + (k < 0 ? -0.004 : sp.doorW / 2 - 0.004);
      const x = sx * (hw + 0.0035), ya = sp.win[0] - 0.01, yb = sp.win[1] - 0.004;
      if (sx > 0) gl.quad(x, ya, b, x, ya, a, x, yb, a, x, yb, b); else gl.quad(x, ya, a, x, ya, b, x, yb, b, x, yb, a);
    }
  }
  // window runs between the doors (flush glazing on a black band, or separate windows)
  const runs: [number, number][] = [];
  const edges = [zr + (cabR || sp.doors === 1 ? 0.07 : 0.04), ...doorZ.flatMap((z) => [z - sp.doorW / 2 - 0.025, z + sp.doorW / 2 + 0.025]).sort((a, b) => a - b), zf - (cabF ? (noseL > 0 ? 0.04 : 0.1) : 0.04)];
  for (let i = 0; i + 1 < edges.length; i += 2) if (edges[i + 1] - edges[i] > 0.05) runs.push([edges[i], edges[i + 1]]);
  const [wy0, wy1] = sp.win;
  if (sp.pitch === 0) {
    gb.color(0x14181b);
    for (const [a, b] of runs) gb.box(0, wy0 - 0.006, (a + b) / 2, W + 0.002, wy1 - wy0 + 0.012, b - a);
  }
  for (const [a, b] of runs) windowBand(gl, a, b, wy0, wy1, hw + 0.002, sp.pitch === 0 ? Math.max(1, Math.round((b - a) / 0.3)) : Math.max(1, Math.round((b - a) / sp.pitch)), sp.pitch === 0 ? 0.006 : 0.018);
  // ---- cab faces (non-HSR): windscreen, display, lamps; HSR: cockpit glass on the nose
  for (const [isCab, dir] of ends) {
    if (!isCab) {
      // gangway bellows to the next car
      gb.color(0x1d1d1d);
      gb.box(0, y0 + 0.02, dir * (hl + EMU_GAP / 4), 0.16, yE - y0 - 0.05, EMU_GAP / 2 + 0.008);
      continue;
    }
    const zFace = dir * hl;
    const lamps: [number, number, number][] = [];
    if (sp.hsr) {
      // cockpit windows on the upper nose, lamps low on the nose sides
      const N = 12, a = sp.cab === 'round' ? 0.38 : 0.2, b = sp.cab === 'round' ? 0.6 : 0.42;
      gl.color(0xffffff);
      const sec = (t: number) => { const [sx, sy, lift] = noseShape(sp.cab, t); return prof.map(([x, y]) => [x * sx * 1.012, y0 + lift + (y - y0) * sy + 0.002] as P2); };
      const zAt = (t: number) => (dir > 0 ? zf : zr) + dir * noseL * t;
      for (let k = 0; k < 3; k++) {
        const t0 = a + ((b - a) * k) / 3, t1 = a + ((b - a) * (k + 1)) / 3;
        const s0 = sec(t0), s1 = sec(t1), z0 = zAt(t0), z1 = zAt(t1);
        // upper arc facets (roofProfile: indices 3 .. n-3 run over the crown)
        for (let i = 3; i < s0.length - 3; i++) {
          const p = s0[i], q = s0[i + 1], r2 = s1[i + 1], u = s1[i];
          if (dir > 0) gl.quad(p[0], p[1], z0, q[0], q[1], z0, r2[0], r2[1], z1, u[0], u[1], z1);
          else gl.quad(q[0], q[1], z0, p[0], p[1], z0, u[0], u[1], z1, r2[0], r2[1], z1);
        }
      }
      void N;
      const [sx, sy, lift] = noseShape(sp.cab, 0.78);
      const ly = y0 + lift + 0.04 * sy + 0.03;
      lamps.push([hw * sx * 0.55, ly, zAt(0.78)], [-hw * sx * 0.55, ly, zAt(0.78)]);
      gb.color(0xfff6d8);
      for (const [lx, lyy, lz] of lamps) gb.box(lx, lyy - 0.008, lz, 0.03, 0.016, 0.03);
    } else {
      const s = sp.cab === 'wrap' ? 0.93 : 1, fy = sp.cab === 'wrap' ? 0.965 : 1;
      const fw = hw * s, ys = (y: number) => y0 + (y - y0) * fy;
      const zz = zFace + dir * 0.0015;
      const quadF = (x0: number, x1: number, ya: number, yb: number, g: GeoBuilder) => {
        if (dir > 0) g.quad(x0, ya, zz, x1, ya, zz, x1, yb, zz, x0, yb, zz); else g.quad(x1, ya, zz, x0, ya, zz, x0, yb, zz, x1, yb, zz);
      };
      if (sp.cab === 'mask' || sp.cab === 'wrap') { gb.color(0x111417); quadF(-fw + 0.012, fw - 0.012, ys(wy0 - 0.03), ys(yE - 0.006), gb); }
      if (sp.stainless) { m.paint(true); gb.color(0xffffff); quadF(-fw + 0.008, fw - 0.008, ys(y0 + 0.012), ys(wy0 - 0.034), gb); m.paint(false); }
      gl.color(0xffffff);
      if (sp.cab === 'flat3') {
        // three-window front: driver, gangway door, second man
        quadF(-fw + 0.015, -0.045, ys(wy0), ys(wy1), gl); quadF(-0.03, 0.03, ys(wy0 - 0.02), ys(wy1), gl); quadF(0.045, fw - 0.015, ys(wy0), ys(wy1), gl);
        gb.color(0x1b1b1b); quadF(-0.032, 0.032, ys(y0 + 0.03), ys(wy1 + 0.004), gb);
      } else quadF(-fw + 0.02, fw - 0.02, ys(wy0 - 0.015), ys(wy1 + 0.005), gl);
      // destination display
      gb.color(0x0d0d0d); quadF(-0.06, 0.06, ys(yE - 0.03), ys(yE - 0.008), gb);
      gb.color(0xffb84d); quadF(-0.045, 0.045, ys(yE - 0.025), ys(yE - 0.013), gb);
      // lamps, coupler, skirt
      const ly = ys(y0 + 0.045);
      lamps.push([fw - 0.035, ly, zFace + dir * 0.004], [-fw + 0.035, ly, zFace + dir * 0.004]);
      gb.color(0xfff6d8);
      for (const [lx] of lamps) gb.box(lx, ly - 0.01, zFace + dir * 0.0025, 0.032, 0.02, 0.003);
      gb.color(0x222426);
      gb.box(0, 0.07, zFace + dir * 0.014, 0.07, 0.03, 0.028);
      if (sp.skirt) gb.box(0, 0.015, zFace - dir * 0.015, W * 0.86, 0.06, 0.03);
    }
    if (dir > 0) front = lamps; else rear = lamps;
  }
  if (role === 'cab') rear = [[0.08, y0 + 0.05, -hl - 0.01], [-0.08, y0 + 0.05, -hl - 0.01]];
  // ---- roof equipment and pantograph
  const rz0 = zr + 0.08, rz1 = zf - 0.08;
  if (sp.equip === 'vent') {
    gb.color(0x4e5155);
    for (let z = rz0 + 0.05; z < rz1 - 0.05; z += 0.16) gb.box(0, yT - 0.004, z, 0.06, 0.016, 0.07);
  } else if (sp.equip === 'ac') {
    gb.color(0xc3c7cb);
    for (const z of [rz0 + (rz1 - rz0) * 0.22, rz0 + (rz1 - rz0) * 0.78]) gb.box(0, yT - 0.006, z, 0.17, 0.026, 0.24);
  } else {
    gb.color(0xd0d3d6);
    gb.box(0, yT - 0.003, (rz0 + rz1) / 2, 0.08, 0.008, Math.max(0.1, rz1 - rz0 - 0.2));
  }
  if (panto) {
    const pz = role === 'cab' ? zr + 0.25 : zf - 0.25;
    gb.color(0x3c3f42);
    gb.box(0, yT - 0.006, pz, 0.2, 0.012, 0.22);
    pantograph(gb, pz, yT + 0.004);
    if (sp.hsr) { gb.color(0xd8dbde); gb.box(0, yT - 0.004, pz, 0.24, 0.03, 0.34); }
  }
  // ---- underframe and skirts
  gb.color(0x232527);
  gb.box(0, y0 - 0.045, (zr + zf) / 2, W * 0.72, 0.05, Math.max(0.1, (zf - zr) - 0.62));
  if (sp.skirt) {
    m.paint(true); gb.color(0xffffff);
    for (const sx of [-1, 1]) gb.box(sx * (hw - 0.012), y0 - 0.055, (zr + zf) / 2, 0.012, 0.06, Math.max(0.1, zf - zr - 0.1));
    m.paint(false);
  }
  const g = m.build();
  // low detail: painted box (tapered nose), bands, roof, window strip, windscreen
  const lb = new MB(), lg = lb.gb;
  lb.paint(true); lg.color(0xffffff);
  lg.box(0, y0, (zr + zf) / 2, W, yE - y0, zf - zr);
  if (cabF && noseL > 0) { const [sx, sy] = noseShape(sp.cab, 0.85); taper(lg, zf, hl, y0, W, yE - y0, W * sx, (yE - y0) * sy); }
  if (cabR && noseL > 0) { const [sx, sy] = noseShape(sp.cab, 0.85); taper(lg, -hl, zr, y0, W * sx, (yE - y0) * sy, W, yE - y0); }
  lb.accent(true); lg.color(0xffffff);
  for (const [a, b] of sp.bands) lg.box(0, a, (zr + zf) / 2, W + 0.004, b - a, zf - zr);
  lb.paint(false);
  lg.color(sp.roof);
  lg.box(0, yE, (zr + zf) / 2, W * 0.86, yT - yE, zf - zr - 0.02);
  if (panto) { lg.color(0x3c3f42); lg.box(0, yT, role === 'cab' ? zr + 0.25 : zf - 0.25, 0.16, 0.12, 0.03); }
  windowBand(lb.gl, zr + 0.06, zf - 0.06, wy0, wy1, hw + 0.002, 1, 0);
  if (cabF && noseL <= 0) endWindow(lb.gl, hl + 0.002, wy0, wy1, hw - 0.025);
  return { ...g, lo: lb.build(), length: len, front, rear, bogies: [len * BOGIE_F, -len * BOGIE_F], bogieKind: 'b2' };
}

/** Geometry of one car of a multiple unit (cached). */
export function getEmuCar(style: string, role: EmuRole, len: number, panto: boolean): ModelGeo {
  const key = 'emu:' + style + ':' + role + ':' + len.toFixed(3) + (panto ? ':p' : '');
  let m = cache.get(key);
  if (!m) { m = emuCar(style, role, len, panto); cache.set(key, m); }
  return m;
}

/** Is this a multiple-unit style with its own car models? */
export function isEmuStyle(style: string): boolean { return style in EMU; }

const cache = new Map<string, ModelGeo>();

export function getModel(style: string, color: number, length: number): ModelGeo {
  const key = style + ':' + color + ':' + length;
  let m = cache.get(key);
  if (m) return m;
  switch (style) {
    case 'steam': m = steam(color, length); break;
    case 'diesel': m = diesel(color, length); break;
    case 'hst': m = streamliner(color, 0x1d3f8a, length, 0.45, false); break;
    case 'bullet': m = streamliner(color, 0x1f5fa8, length, 0.85, true); break;
    case 'coach_wood': case 'coach_steel': case 'coach_ic': case 'coach_hs': m = coach(style, color, length); break;
    default: m = bus(style, color, length); break;
  }
  cache.set(key, m);
  return m;
}

/** Long-distance coach geometry per era and length (livery: instance colour + operator accent). */
export function getRoadCoach(era: CoachEra, length: number): ModelGeo {
  const key = 'rcoach:' + era + ':' + length.toFixed(3);
  let m = cache.get(key);
  if (!m) { m = era === 'round' ? coachRound(length) : era === 'boxy' ? coachBoxy(length) : coachModern(length); cache.set(key, m); }
  return m;
}

export function getCarModel(style: number): ModelGeo {
  const key = 'car:' + style;
  let m = cache.get(key);
  if (!m) { m = car(style); cache.set(key, m); }
  return m;
}
