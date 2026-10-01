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
  private ranges: [number, number][] = [];
  private p0 = -1;
  paint(on: boolean) {
    if (on && this.p0 < 0) this.p0 = this.gb.vertexCount;
    if (!on && this.p0 >= 0) { this.ranges.push([this.p0, this.gb.vertexCount]); this.p0 = -1; }
    return this;
  }
  build(): { body: THREE.BufferGeometry; glass: THREE.BufferGeometry } {
    this.paint(false);
    const body = this.gb.build();
    const a = new Float32Array(this.gb.vertexCount);
    for (const [s, e] of this.ranges) a.fill(1, s, e);
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

export function getCarModel(style: number): ModelGeo {
  const key = 'car:' + style;
  let m = cache.get(key);
  if (!m) { m = car(style); cache.set(key, m); }
  return m;
}
