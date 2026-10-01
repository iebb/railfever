// Procedural vehicle models at real scale (1 unit = 10 m).
// Local frame: +z forward (nose), y up, x lateral; origin at rail top / road surface, centre of the vehicle.
import * as THREE from 'three';
import { GeoBuilder } from './geo';

export interface ModelGeo {
  body: THREE.BufferGeometry;
  glass: THREE.BufferGeometry;
  length: number;
  /** chimney top (steam) for smoke emission */
  chimney?: THREE.Vector3;
  /** head and tail light positions (local) */
  front: [number, number, number][];
  rear: [number, number, number][];
  /** z offsets of separately drawn bogies (empty when the running gear is part of the body) */
  bogies: number[];
}

/** Rail car body width, bogie pivot as a fraction of the car length (matches the renderer's placement). */
export const RAIL_W = 0.29;
export const BOGIE_F = 0.32;

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

/** Wheel pair on an axle at z (radius r, centre height r). */
function axle(gb: GeoBuilder, z: number, r: number, half = 0.072, width = 0.016, color = 0x1d1d1d, seg = 10) {
  gb.color(color);
  gb.tube(-half - width / 2, r, z, -half + width / 2, r, z, r, seg);
  gb.tube(half - width / 2, r, z, half + width / 2, r, z, r, seg);
}

/** Side window strip along both sides. */
function windowBand(gl: GeoBuilder, z0: number, z1: number, y0: number, y1: number, halfW: number, segs: number, gap = 0.02) {
  gl.color(0xffffff);
  const len = (z1 - z0 - gap * (segs - 1)) / segs;
  for (let i = 0; i < segs; i++) {
    const a = z0 + i * (len + gap), b = a + len;
    gl.quad(halfW, y0, b, halfW, y0, a, halfW, y1, a, halfW, y1, b);
    gl.quad(-halfW, y0, a, -halfW, y0, b, -halfW, y1, b, -halfW, y1, a);
  }
}

function endWindow(gl: GeoBuilder, z: number, y0: number, y1: number, hw: number, back = false) {
  gl.color(0xffffff);
  if (back) gl.quad(hw, y0, z, -hw, y0, z, -hw, y1, z, hw, y1, z);
  else gl.quad(-hw, y0, z, hw, y0, z, hw, y1, z, -hw, y1, z);
}

/** Bogie (drawn as separate instances so it follows the track on curves). */
export function bogieModel(): THREE.BufferGeometry {
  const gb = new GeoBuilder();
  gb.color(0x2b2b2b);
  gb.box(0, 0.03, 0, 0.2, 0.045, 0.34);
  gb.color(0x3a3a3a);
  gb.box(0.105, 0.025, 0, 0.012, 0.05, 0.3);
  gb.box(-0.105, 0.025, 0, 0.012, 0.05, 0.3);
  axle(gb, -0.125, 0.046);
  axle(gb, 0.125, 0.046);
  gb.color(0x555555);
  gb.tube(-0.08, 0.046, -0.125, 0.08, 0.046, -0.125, 0.012, 6);
  gb.tube(-0.08, 0.046, 0.125, 0.08, 0.046, 0.125, 0.012, 6);
  return gb.build();
}

function coach(style: string, color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02, W = RAIL_W;
  const roofCol = style === 'coach_wood' ? 0x3d3a37 : style === 'coach_steel' ? 0x5b5f63 : 0xaeb3b8;
  gb.color(color);
  gb.box(0, 0.115, 0, W, 0.26, hl * 2);
  gb.color(roofCol);
  gb.box(0, 0.375, 0, W - 0.03, 0.03, hl * 2 - 0.02);
  gb.box(0, 0.405, 0, W - 0.11, 0.016, hl * 2 - 0.06);
  if (style === 'coach_ic') { gb.color(0xc0392b); gb.box(0, 0.19, 0, W + 0.004, 0.025, hl * 2 - 0.02); }
  if (style === 'coach_hs') { gb.color(0x1f5fa8); gb.box(0, 0.2, 0, W + 0.004, 0.03, hl * 2 - 0.02); }
  if (style === 'coach_steel') { gb.color(0xd8c690); gb.box(0, 0.335, 0, W + 0.004, 0.018, hl * 2 - 0.02); }
  if (style === 'coach_wood') { gb.color(0xd9b98c); gb.box(0, 0.335, 0, W + 0.004, 0.014, hl * 2 - 0.02); }
  // underframe and gangways
  gb.color(0x262626);
  gb.box(0, 0.085, 0, W - 0.07, 0.035, hl * 2 - 0.5);
  gb.color(0x1f1f1f);
  gb.box(0, 0.14, hl, 0.16, 0.22, 0.04);
  gb.box(0, 0.14, -hl, 0.16, 0.22, 0.04);
  // doors near the ends
  gb.color(color, 0.72);
  for (const z of [hl - 0.11, -hl + 0.11]) { gb.box(W / 2 + 0.001, 0.13, z, 0.003, 0.22, 0.08); gb.box(-W / 2 - 0.001, 0.13, z, 0.003, 0.22, 0.08); }
  const segs = Math.max(3, Math.round((hl * 2 - 0.5) / 0.15));
  windowBand(gl, -hl + 0.2, hl - 0.2, 0.225, 0.325, W / 2 + 0.002, segs, 0.03);
  const g = m.build();
  return { ...g, length: L, front: [], rear: [[0.09, 0.15, -hl - 0.005], [-0.09, 0.15, -hl - 0.005]], bogies: [L * BOGIE_F, -L * BOGIE_F] };
}

function steam(color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02;
  gb.color(0x1b1b1b);
  gb.box(0, 0.085, 0, 0.24, 0.055, hl * 2);
  gb.color(0xa8241c);
  gb.box(0, 0.075, hl - 0.02, RAIL_W, 0.07, 0.04);
  const bz0 = -hl + 0.62, bz1 = hl - 0.05;
  gb.color(color);
  gb.tube(0, 0.27, bz0, 0, 0.27, bz1 - 0.1, 0.105, 14);
  gb.color(0x151515);
  gb.tube(0, 0.27, bz1 - 0.12, 0, 0.27, bz1 + 0.005, 0.112, 14);
  gb.cylinder(0, 0.35, bz1 - 0.07, 0.035, 0.12, 10, 0.042);
  gb.color(0xc9a24a);
  gb.cylinder(0, 0.36, (bz0 + bz1) / 2, 0.04, 0.06, 10, 0.028);
  gb.color(color, 0.9);
  gb.box(0, 0.15, (bz0 + bz1) / 2, 0.27, 0.06, bz1 - bz0 - 0.1);
  // cab
  gb.color(color);
  gb.box(0, 0.12, bz0 - 0.13, RAIL_W - 0.01, 0.3, 0.26);
  gb.color(0x222222);
  gb.box(0, 0.42, bz0 - 0.13, RAIL_W + 0.01, 0.018, 0.3);
  endWindow(gl, bz0 + 0.002, 0.33, 0.39, 0.1);
  windowBand(gl, bz0 - 0.24, bz0 - 0.03, 0.3, 0.38, (RAIL_W - 0.01) / 2 + 0.002, 1);
  // tender
  gb.color(color, 0.85);
  gb.box(0, 0.11, -hl + 0.2, 0.27, 0.26, 0.38);
  gb.color(0x111111);
  gb.box(0, 0.37, -hl + 0.22, 0.23, 0.02, 0.3);
  // driving wheels, rods, leading and tender wheels
  for (const z of [bz0 + 0.12, bz0 + 0.31, bz0 + 0.5]) axle(gb, z, 0.085, 0.075, 0.018, 0xa8241c, 14);
  gb.color(0x9a9a9a);
  gb.box(0.087, 0.075, bz0 + 0.31, 0.008, 0.016, 0.44);
  gb.box(-0.087, 0.075, bz0 + 0.31, 0.008, 0.016, 0.44);
  gb.color(0x3a3a3a);
  gb.box(0.1, 0.11, bz1 - 0.12, 0.05, 0.07, 0.16);
  gb.box(-0.1, 0.11, bz1 - 0.12, 0.05, 0.07, 0.16);
  axle(gb, bz1 - 0.12, 0.045);
  axle(gb, -hl + 0.09, 0.045);
  axle(gb, -hl + 0.31, 0.045);
  gb.color(0xfff1c4);
  gb.cylinder(0, 0.38, bz1 + 0.01, 0.022, 0.03, 8);
  const g = m.build();
  return {
    ...g, length: L, chimney: new THREE.Vector3(0, 0.48, bz1 - 0.07),
    front: [[0, 0.395, hl + 0.01]], rear: [[0.09, 0.15, -hl - 0.005], [-0.09, 0.15, -hl - 0.005]], bogies: [],
  };
}

function diesel(color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02, W = RAIL_W;
  gb.color(0x262626);
  gb.box(0, 0.1, 0, W, 0.04, hl * 2);
  gb.color(color);
  gb.box(0, 0.14, -0.12, 0.2, 0.24, hl * 2 - 0.62);
  gb.box(0, 0.14, hl - 0.25, W - 0.02, 0.27, 0.3);
  gb.box(0, 0.14, hl - 0.055, 0.2, 0.16, 0.11);
  gb.color(0x3a3a3a);
  gb.box(0, 0.41, hl - 0.25, W, 0.016, 0.33);
  gb.color(0xe8c547);
  gb.box(0, 0.125, 0, W + 0.004, 0.02, hl * 2 - 0.02);
  gb.color(0x444444);
  gb.box(0, 0.38, -0.3, 0.07, 0.03, 0.16);
  gb.box(0, 0.38, 0.05, 0.12, 0.012, 0.3);
  endWindow(gl, hl - 0.098, 0.31, 0.38, 0.11);
  endWindow(gl, hl - 0.402, 0.31, 0.38, 0.11, true);
  windowBand(gl, hl - 0.36, hl - 0.14, 0.3, 0.38, (W - 0.02) / 2 + 0.002, 1);
  gb.color(0xfff1c4);
  gb.box(0.07, 0.24, hl + 0.001, 0.03, 0.025, 0.006);
  gb.box(-0.07, 0.24, hl + 0.001, 0.03, 0.025, 0.006);
  const g = m.build();
  return {
    ...g, length: L, front: [[0.07, 0.25, hl + 0.01], [-0.07, 0.25, hl + 0.01]],
    rear: [[0.08, 0.16, -hl - 0.005], [-0.08, 0.16, -hl - 0.005]], bogies: [L * BOGIE_F, -L * BOGIE_F],
  };
}

function streamliner(color: number, stripe: number, L: number, long: number, pantograph: boolean): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.02, W = RAIL_W, H = 0.29, y0 = 0.115;
  const zn = hl - long;
  gb.color(color);
  gb.box(0, y0, (zn - hl) / 2, W, H, zn + hl);
  taper(gb, zn, hl, y0, W, H, 0.13, 0.09, y0 + 0.02);
  gb.color(stripe);
  gb.box(0, 0.2, (zn - hl) / 2, W + 0.004, 0.035, zn + hl - 0.01);
  gb.color(0x2a2a2a);
  gb.box(0, 0.085, 0, W - 0.06, 0.035, hl * 2 - 0.5);
  gb.color(0xd0d0d0);
  gb.box(0, y0 + H, -0.15, 0.1, 0.02, 0.3);
  if (pantograph) {
    gb.color(0x3c3c3c);
    gb.box(0, y0 + H + 0.02, -0.15, 0.025, 0.012, 0.22);
    gb.box(0, y0 + H + 0.06, -0.08, 0.012, 0.012, 0.16);
    gb.box(0, y0 + H + 0.1, -0.04, 0.2, 0.01, 0.02);
  }
  // windscreen on the nose slope
  gl.color(0xffffff);
  const topY = (t: number) => y0 + H + (y0 + 0.02 + 0.09 - (y0 + H)) * t + 0.003;
  const wd = (t: number) => (W + (0.13 - W) * t) * 0.42;
  const zt = (t: number) => zn + long * t;
  const t0 = 0.05, t1 = 0.4;
  gl.quad(-wd(t0), topY(t0), zt(t0), -wd(t1), topY(t1), zt(t1), wd(t1), topY(t1), zt(t1), wd(t0), topY(t0), zt(t0));
  windowBand(gl, -hl + 0.15, zn - 0.05, 0.25, 0.33, W / 2 + 0.002, Math.max(2, Math.round((zn + hl - 0.2) / 0.14)), 0.025);
  gb.color(0xfff1c4);
  gb.box(0.05, y0 + 0.04, hl - 0.01, 0.03, 0.02, 0.012);
  gb.box(-0.05, y0 + 0.04, hl - 0.01, 0.03, 0.02, 0.012);
  const g = m.build();
  return {
    ...g, length: L, front: [[0.05, y0 + 0.05, hl + 0.01], [-0.05, y0 + 0.05, hl + 0.01]],
    rear: [[0.08, 0.16, -hl - 0.005], [-0.08, 0.16, -hl - 0.005]], bogies: [L * BOGIE_F, -L * BOGIE_F],
  };
}

function bus(style: string, color: number, L: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const hl = L / 2 - 0.005;
  const W = 0.25, H = style === 'bus_old' ? 0.25 : 0.27, y0 = 0.035;
  gb.color(color);
  gb.box(0, y0, 0, W, H, hl * 2);
  gb.color(style === 'bus_modern' ? 0x2c3e50 : 0xeeeeee);
  gb.box(0, y0 + H, 0, W - 0.02, 0.014, hl * 2 - 0.04);
  if (style === 'bus_old') { gb.color(0xf3e3b5); gb.box(0, y0 + 0.1, 0, W + 0.004, 0.016, hl * 2 - 0.01); }
  if (style === 'bus_artic') { gb.color(0x222222); gb.box(0, y0 + 0.02, 0, W + 0.004, H - 0.02, 0.06); }
  if (style === 'bus_modern') { gb.color(0xe8f0f2); gb.box(0, y0 + 0.02, 0, W + 0.003, 0.05, hl * 2 - 0.02); }
  gb.color(0x1e1e1e);
  gb.box(0, y0 - 0.005, 0, W - 0.01, 0.03, hl * 2 - 0.01);
  const segs = Math.max(3, Math.round((hl * 2 - 0.3) / 0.13));
  windowBand(gl, -hl + 0.06, hl - 0.2, y0 + 0.11, y0 + H - 0.03, W / 2 + 0.002, segs, 0.02);
  endWindow(gl, hl + 0.002, y0 + 0.09, y0 + H - 0.02, W / 2 - 0.015);
  endWindow(gl, -hl - 0.002, y0 + 0.12, y0 + H - 0.03, W / 2 - 0.02, true);
  gb.color(0xfff6c8);
  gb.box(0.085, y0 + 0.03, hl + 0.001, 0.035, 0.02, 0.006);
  gb.box(-0.085, y0 + 0.03, hl + 0.001, 0.035, 0.02, 0.006);
  gb.color(0xc0392b);
  gb.box(0.09, y0 + 0.04, -hl - 0.001, 0.025, 0.03, 0.006);
  gb.box(-0.09, y0 + 0.04, -hl - 0.001, 0.025, 0.03, 0.006);
  const wz = style === 'bus_artic' ? [hl - 0.22, 0.08, -hl + 0.22] : [hl - 0.22, -hl + 0.27];
  for (const z of wz) axle(gb, z, 0.05, W / 2 - 0.02, 0.03, 0x161616, 10);
  const g = m.build();
  return {
    ...g, length: L, front: [[0.085, y0 + 0.04, hl + 0.01], [-0.085, y0 + 0.04, hl + 0.01]],
    rear: [[0.09, y0 + 0.055, -hl - 0.01], [-0.09, y0 + 0.055, -hl - 0.01]], bogies: [],
  };
}

/** Ambient town traffic: 0 sedan, 1 hatchback, 2 van, 3 truck. Paint parts take the instance colour. */
function car(style: number): ModelGeo {
  const m = new MB(), gb = m.gb, gl = m.gl;
  const L = style === 3 ? 0.7 : style === 1 ? 0.4 : 0.45;
  const hl = L / 2;
  const W = style === 3 ? 0.24 : 0.18;
  const wr = style === 3 ? 0.045 : 0.032;
  let front: [number, number, number][], rear: [number, number, number][];
  if (style === 3) {
    m.paint(true);
    gb.color(0xffffff);
    gb.box(0, 0.035, hl - 0.1, W, 0.24, 0.18);
    m.paint(false);
    gb.color(0xe4e4e0);
    gb.box(0, 0.06, -0.1, W + 0.01, 0.25, 0.48);
    gb.color(0x222222);
    gb.box(0, 0.02, 0, W - 0.04, 0.04, L - 0.02);
    endWindow(gl, hl - 0.005 + 0.002, 0.15, 0.25, W / 2 - 0.02);
    windowBand(gl, hl - 0.15, hl - 0.04, 0.16, 0.25, W / 2 + 0.002, 1);
    front = [[0.08, 0.08, hl + 0.005], [-0.08, 0.08, hl + 0.005]];
    rear = [[0.09, 0.08, -hl - 0.005], [-0.09, 0.08, -hl - 0.005]];
  } else if (style === 2) {
    m.paint(true);
    gb.color(0xffffff);
    gb.box(0, 0.025, -0.03, W, 0.17, L - 0.06);
    taper(gb, hl - 0.06, hl, 0.025, W, 0.17, W - 0.01, 0.08);
    m.paint(false);
    gl.color(0xffffff);
    gl.quad(-W / 2 + 0.01, 0.12, hl - 0.06, W / 2 - 0.01, 0.12, hl - 0.06, W / 2 - 0.01, 0.185, hl - 0.075, -W / 2 + 0.01, 0.185, hl - 0.075);
    windowBand(gl, hl - 0.16, hl - 0.07, 0.12, 0.18, W / 2 + 0.002, 1);
    front = [[0.06, 0.07, hl + 0.004], [-0.06, 0.07, hl + 0.004]];
    rear = [[0.07, 0.09, -hl - 0.004], [-0.07, 0.09, -hl - 0.004]];
  } else {
    const cz = style === 1 ? -0.05 : -0.01;
    const cl = style === 1 ? 0.22 : 0.2;
    m.paint(true);
    gb.color(0xffffff);
    gb.box(0, 0.025, 0, W, 0.065, L - 0.01);
    taper(gb, cz - cl / 2, cz + cl / 2, 0.09, W - 0.01, 0.055, W - 0.03, 0.05);
    if (style === 1) taper(gb, cz - cl / 2 - 0.03, cz - cl / 2, 0.09, W - 0.012, 0.03, W - 0.01, 0.055);
    m.paint(false);
    windowBand(gl, cz - cl / 2 + 0.015, cz + cl / 2 - 0.015, 0.095, 0.138, (W - 0.01) / 2 + 0.002, 2, 0.012);
    gl.color(0xffffff);
    gl.quad(-W / 2 + 0.012, 0.092, cz + cl / 2 + 0.003, W / 2 - 0.012, 0.092, cz + cl / 2 + 0.003, W / 2 - 0.02, 0.142, cz + cl / 2 - 0.002, -W / 2 + 0.02, 0.142, cz + cl / 2 - 0.002);
    front = [[0.06, 0.07, hl + 0.003], [-0.06, 0.07, hl + 0.003]];
    rear = [[0.065, 0.075, -hl - 0.003], [-0.065, 0.075, -hl - 0.003]];
  }
  const ax = style === 3 ? [hl - 0.12, -hl + 0.16, -hl + 0.28] : [hl - 0.09, -hl + 0.09];
  for (const z of ax) axle(gb, z, wr, W / 2 - 0.012, 0.022, 0x151515, 8);
  gb.color(0xfff6c8);
  for (const [x, y, z] of front) gb.box(x, y - 0.008, z - 0.004, 0.03, 0.016, 0.004);
  gb.color(0xb02a20);
  for (const [x, y, z] of rear) gb.box(x, y - 0.008, z + 0.001, 0.03, 0.016, 0.004);
  const g = m.build();
  return { ...g, length: L, front, rear, bogies: [] };
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
    case 'bullet': m = streamliner(color, 0x1f5fa8, length, 0.8, true); break;
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
