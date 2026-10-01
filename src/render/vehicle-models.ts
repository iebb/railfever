// Procedural vehicle models. Local frame: +z forward, y up, origin at rail/road surface centre.
import * as THREE from 'three';
import { GeoBuilder } from './geo';

export interface ModelGeo { body: THREE.BufferGeometry; glass: THREE.BufferGeometry; length: number; chimney?: THREE.Vector3 }

/** Box tapered towards +z (nose). wTop/hTop give the nose cross-section. */
function nose(gb: GeoBuilder, z0: number, z1: number, y0: number, w0: number, h0: number, w1: number, h1: number, y1 = y0) {
  const a = [[-w0 / 2, y0, z0], [w0 / 2, y0, z0], [w0 / 2, y0 + h0, z0], [-w0 / 2, y0 + h0, z0]];
  const b = [[-w1 / 2, y1, z1], [w1 / 2, y1, z1], [w1 / 2, y1 + h1, z1], [-w1 / 2, y1 + h1, z1]];
  const Q = (p: number[], q: number[], r: number[], s: number[]) => gb.quad(p[0], p[1], p[2], q[0], q[1], q[2], r[0], r[1], r[2], s[0], s[1], s[2]);
  Q(b[0], b[1], b[2], b[3]); // front
  Q(a[3], b[3], b[2], a[2]); // top
  Q(a[1], a[2], b[2], b[1]); // right (+x)
  Q(b[0], b[3], a[3], a[0]); // left
  Q(a[0], a[1], b[1], b[0]); // bottom
}

function wheelsX(gb: GeoBuilder, z: number, r: number, gauge = 0.075, color = 0x222222) {
  gb.color(color);
  gb.tube(-gauge - 0.012, r, z, -gauge + 0.012, r, z, r, 10);
  gb.tube(gauge - 0.012, r, z, gauge + 0.012, r, z, r, 10);
}

function bogie(gb: GeoBuilder, z: number) {
  gb.color(0x2a2a2a);
  gb.box(0, 0.015, z, 0.17, 0.05, 0.16);
  wheelsX(gb, z - 0.045, 0.03, 0.08);
  wheelsX(gb, z + 0.045, 0.03, 0.08);
}

/** Side window strip (glass) along both sides. */
function windowBand(gl: GeoBuilder, z0: number, z1: number, y0: number, y1: number, halfW: number, segs: number, gap = 0.012) {
  gl.color(0xffffff);
  const len = (z1 - z0 - gap * (segs - 1)) / segs;
  for (let i = 0; i < segs; i++) {
    const a = z0 + i * (len + gap), b = a + len;
    // right side (+x) facing +x
    gl.quad(halfW, y0, b, halfW, y0, a, halfW, y1, a, halfW, y1, b);
    // left side (-x)
    gl.quad(-halfW, y0, a, -halfW, y0, b, -halfW, y1, b, -halfW, y1, a);
  }
}

function frontWindow(gl: GeoBuilder, z: number, y0: number, y1: number, hw: number) {
  gl.color(0xffffff);
  gl.quad(-hw, y0, z, hw, y0, z, hw, y1, z, -hw, y1, z);
}

function coach(style: string, color: number, L: number): ModelGeo {
  const gb = new GeoBuilder(), gl = new GeoBuilder();
  const hl = L / 2 - 0.015;
  const W = 0.19;
  const roofCol = style === 'coach_wood' ? 0x3a3a3a : style === 'coach_steel' ? 0x5b5f63 : 0xb8bcc0;
  gb.color(color);
  gb.box(0, 0.06, 0, W, 0.17, hl * 2);
  // roof
  gb.color(roofCol);
  gb.box(0, 0.23, 0, W - 0.02, 0.025, hl * 2 - 0.02);
  gb.box(0, 0.255, 0, W - 0.07, 0.012, hl * 2 - 0.04);
  // livery stripe
  if (style === 'coach_ic') { gb.color(0xc0392b); gb.box(0, 0.08, 0, W + 0.004, 0.02, hl * 2 - 0.01); }
  if (style === 'coach_hs') { gb.color(0x1f5fa8); gb.box(0, 0.09, 0, W + 0.004, 0.025, hl * 2 - 0.01); }
  if (style === 'coach_steel') { gb.color(0xd8c690); gb.box(0, 0.205, 0, W + 0.004, 0.012, hl * 2 - 0.01); }
  // underframe & bogies
  gb.color(0x2b2b2b);
  gb.box(0, 0.045, 0, W - 0.03, 0.02, hl * 2 - 0.06);
  bogie(gb, hl - 0.1);
  bogie(gb, -hl + 0.1);
  // windows
  const segs = Math.round((hl * 2 - 0.12) / 0.075);
  windowBand(gl, -hl + 0.07, hl - 0.07, 0.135, 0.205, W / 2 + 0.002, segs);
  // doors
  gb.color(color, 0.7);
  for (const z of [hl - 0.04, -hl + 0.04]) { gb.box(W / 2 + 0.001, 0.07, z, 0.002, 0.15, 0.04); gb.box(-W / 2 - 0.001, 0.07, z, 0.002, 0.15, 0.04); }
  return { body: gb.build(), glass: gl.build(), length: L };
}

function steam(color: number, L: number): ModelGeo {
  const gb = new GeoBuilder(), gl = new GeoBuilder();
  const hl = L / 2 - 0.015;
  // frame
  gb.color(0x1c1c1c);
  gb.box(0, 0.04, 0, 0.17, 0.035, hl * 2);
  gb.color(0xa8241c);
  gb.box(0, 0.035, hl - 0.01, 0.2, 0.05, 0.02); // buffer beam
  // boiler
  gb.color(color);
  const bz0 = -hl + 0.26, bz1 = hl - 0.03;
  gb.tube(0, 0.145, bz0, 0, 0.145, bz1, 0.068, 12);
  gb.color(0x1a1a1a);
  gb.tube(0, 0.145, bz1 - 0.06, 0, 0.145, bz1 + 0.005, 0.07, 12); // smokebox
  // chimney & dome
  gb.color(0x151515);
  gb.cylinder(0, 0.2, bz1 - 0.04, 0.022, 0.08, 8, 0.028);
  gb.color(0xc9a24a);
  gb.cylinder(0, 0.205, (bz0 + bz1) / 2, 0.025, 0.04, 8, 0.015);
  // cab
  gb.color(color);
  gb.box(0, 0.06, bz0 - 0.07, 0.19, 0.19, 0.14);
  gb.color(0x222222);
  gb.box(0, 0.25, bz0 - 0.07, 0.21, 0.015, 0.17);
  gl.color(0xffffff);
  frontWindow(gl, bz0 + 0.001, 0.17, 0.22, 0.06);
  windowBand(gl, bz0 - 0.12, bz0 - 0.03, 0.16, 0.22, 0.096, 1);
  // tender at the rear
  gb.color(color, 0.85);
  gb.box(0, 0.06, -hl + 0.06, 0.18, 0.15, 0.12);
  gb.color(0x111111);
  gb.box(0, 0.21, -hl + 0.06, 0.15, 0.02, 0.1);
  // wheels: drivers
  gb.color(0xa8241c);
  for (const z of [bz0 + 0.05, bz0 + 0.13, bz0 + 0.21]) {
    gb.tube(-0.09, 0.05, z, -0.075, 0.05, z, 0.05, 12);
    gb.tube(0.075, 0.05, z, 0.09, 0.05, z, 0.05, 12);
  }
  gb.color(0x999999);
  gb.box(0.092, 0.045, bz0 + 0.13, 0.006, 0.012, 0.18);
  gb.box(-0.092, 0.045, bz0 + 0.13, 0.006, 0.012, 0.18);
  wheelsX(gb, -hl + 0.06, 0.03);
  wheelsX(gb, bz1 - 0.04, 0.03);
  return { body: gb.build(), glass: gl.build(), length: L, chimney: new THREE.Vector3(0, 0.29, bz1 - 0.04) };
}

function diesel(color: number, L: number): ModelGeo {
  const gb = new GeoBuilder(), gl = new GeoBuilder();
  const hl = L / 2 - 0.015;
  gb.color(0x262626);
  gb.box(0, 0.045, 0, 0.19, 0.03, hl * 2);
  // long hood
  gb.color(color);
  gb.box(0, 0.075, -0.05, 0.16, 0.16, hl * 2 - 0.2);
  gb.color(0xe8c547);
  gb.box(0, 0.08, -0.05, 0.164, 0.02, hl * 2 - 0.2);
  // cab near the front
  gb.color(color);
  gb.box(0, 0.075, hl - 0.11, 0.2, 0.2, 0.14);
  gb.color(0x3a3a3a);
  gb.box(0, 0.275, hl - 0.11, 0.2, 0.015, 0.15);
  // short nose
  gb.color(color);
  gb.box(0, 0.075, hl - 0.02, 0.15, 0.12, 0.05);
  frontWindow(gl, hl - 0.039, 0.2, 0.255, 0.085);
  windowBand(gl, hl - 0.16, hl - 0.06, 0.2, 0.255, 0.101, 1);
  gb.color(0x555555);
  gb.box(0, 0.235, -0.15, 0.07, 0.02, 0.12); // exhaust
  bogie(gb, hl - 0.12);
  bogie(gb, -hl + 0.12);
  return { body: gb.build(), glass: gl.build(), length: L };
}

function streamliner(color: number, stripe: number, L: number, long: number): ModelGeo {
  const gb = new GeoBuilder(), gl = new GeoBuilder();
  const hl = L / 2 - 0.015;
  const W = 0.19, H = 0.19;
  const zn = hl - long;
  gb.color(color);
  gb.box(0, 0.06, (zn - hl) / 2 + 0.0, W, H, zn + hl);
  nose(gb, zn, hl, 0.06, W, H, 0.09, 0.06, 0.07);
  gb.color(stripe);
  gb.box(0, 0.09, (zn - hl) / 2, W + 0.004, 0.03, zn + hl - 0.01);
  gb.color(0x2c2c2c);
  gb.box(0, 0.045, 0, W - 0.03, 0.02, hl * 2 - 0.06);
  // windscreen lying on the nose slope
  gl.color(0xffffff);
  const topY = (t: number) => 0.06 + H + (0.13 - (0.06 + H)) * t + 0.003;
  const wd = (t: number) => (W + (0.09 - W) * t) * 0.42;
  const zt = (t: number) => zn + long * t;
  const t0 = 0.04, t1 = 0.42;
  gl.quad(-wd(t0), topY(t0), zt(t0), -wd(t1), topY(t1), zt(t1), wd(t1), topY(t1), zt(t1), wd(t0), topY(t0), zt(t0));
  windowBand(gl, -hl + 0.06, zn - 0.02, 0.15, 0.2, W / 2 + 0.002, Math.max(1, Math.round((zn + hl - 0.08) / 0.08)));
  gb.color(0xdddddd);
  gb.box(0, 0.06 + H, -0.1, 0.06, 0.015, 0.14); // roof equipment
  bogie(gb, hl - 0.16);
  bogie(gb, -hl + 0.1);
  return { body: gb.build(), glass: gl.build(), length: L };
}

function bus(style: string, color: number, L: number): ModelGeo {
  const gb = new GeoBuilder(), gl = new GeoBuilder();
  const hl = L / 2;
  const W = 0.15, H = style === 'bus_old' ? 0.15 : 0.16;
  const y0 = 0.03;
  gb.color(color);
  gb.box(0, y0, 0, W, H, hl * 2 - 0.01);
  gb.color(style === 'bus_modern' ? 0x2c3e50 : 0xf0f0f0);
  gb.box(0, y0 + H, 0, W - 0.01, 0.012, hl * 2 - 0.03);
  if (style === 'bus_old') { gb.color(0xf3e3b5); gb.box(0, y0 + 0.07, 0, W + 0.003, 0.012, hl * 2 - 0.012); }
  if (style === 'bus_artic') { gb.color(0x222222); gb.box(0, y0 + 0.01, 0, W + 0.004, H - 0.01, 0.04); }
  if (style === 'bus_modern') { gb.color(0xe8f0f2); gb.box(0, y0 + 0.015, 0, W + 0.003, 0.03, hl * 2 - 0.02); }
  // windows
  const segs = Math.max(2, Math.round((hl * 2 - 0.12) / 0.07));
  windowBand(gl, -hl + 0.04, hl - 0.09, y0 + 0.075, y0 + H - 0.02, W / 2 + 0.002, segs, 0.01);
  frontWindow(gl, hl - 0.004, y0 + 0.06, y0 + H - 0.015, W / 2 - 0.01);
  gl.quad(W / 2 - 0.01, y0 + 0.07, -hl + 0.004, -W / 2 + 0.01, y0 + 0.07, -hl + 0.004, -W / 2 + 0.01, y0 + H - 0.02, -hl + 0.004, W / 2 - 0.01, y0 + H - 0.02, -hl + 0.004);
  // headlights
  gb.color(0xfff6c8);
  gb.box(0.05, y0 + 0.02, hl - 0.002, 0.025, 0.015, 0.006);
  gb.box(-0.05, y0 + 0.02, hl - 0.002, 0.025, 0.015, 0.006);
  // wheels
  for (const z of style === 'bus_artic' ? [hl - 0.08, 0.05, -hl + 0.08] : [hl - 0.09, -hl + 0.1]) {
    gb.color(0x1a1a1a);
    gb.tube(-W / 2 - 0.004, 0.03, z, -W / 2 + 0.02, 0.03, z, 0.03, 10);
    gb.tube(W / 2 - 0.02, 0.03, z, W / 2 + 0.004, 0.03, z, 0.03, 10);
  }
  return { body: gb.build(), glass: gl.build(), length: L };
}

function car(style: number): ModelGeo {
  const gb = new GeoBuilder(), gl = new GeoBuilder();
  const L = style === 2 ? 0.34 : 0.27, W = 0.12;
  const hl = L / 2;
  gb.color(0xffffff);
  gb.box(0, 0.02, 0, W, 0.05, L);
  if (style === 2) {
    gb.box(0, 0.07, -0.03, W - 0.004, 0.08, L - 0.08);
    gl.color(0xffffff);
    gl.quad(-W / 2 + 0.01, 0.08, hl - 0.07, W / 2 - 0.01, 0.08, hl - 0.07, W / 2 - 0.01, 0.14, hl - 0.075, -W / 2 + 0.01, 0.14, hl - 0.075);
  } else {
    const cz = style === 1 ? -0.02 : 0;
    const cl = style === 1 ? 0.17 : 0.14;
    nose(gb, cz - cl / 2, cz + cl / 2, 0.07, W - 0.012, 0.045, W - 0.02, 0.04);
    gl.color(0xffffff);
    windowBand(gl, cz - cl / 2 + 0.01, cz + cl / 2 - 0.01, 0.075, 0.105, (W - 0.012) / 2 + 0.002, 2, 0.01);
    gl.quad(-W / 2 + 0.012, 0.072, cz + cl / 2 + 0.002, W / 2 - 0.012, 0.072, cz + cl / 2 + 0.002, W / 2 - 0.014, 0.108, cz + cl / 2 - 0.004, -W / 2 + 0.014, 0.108, cz + cl / 2 - 0.004);
  }
  for (const z of [hl - 0.06, -hl + 0.06]) {
    gb.color(0x151515);
    gb.tube(-W / 2 - 0.003, 0.022, z, -W / 2 + 0.015, 0.022, z, 0.022, 8);
    gb.tube(W / 2 - 0.015, 0.022, z, W / 2 + 0.003, 0.022, z, 0.022, 8);
  }
  gb.color(0xfff6c8);
  gb.box(0.035, 0.045, hl - 0.002, 0.02, 0.01, 0.005);
  gb.box(-0.035, 0.045, hl - 0.002, 0.02, 0.01, 0.005);
  gb.color(0xc0392b);
  gb.box(0.035, 0.045, -hl + 0.002, 0.02, 0.01, 0.005);
  gb.box(-0.035, 0.045, -hl + 0.002, 0.02, 0.01, 0.005);
  return { body: gb.build(), glass: gl.build(), length: L };
}

const cache = new Map<string, ModelGeo>();

export function getModel(style: string, color: number, length: number): ModelGeo {
  const key = style + ':' + color + ':' + length;
  let m = cache.get(key);
  if (m) return m;
  switch (style) {
    case 'steam': m = steam(color, length); break;
    case 'diesel': m = diesel(color, length); break;
    case 'hst': m = streamliner(color, 0x1d3f8a, length, 0.2); break;
    case 'bullet': m = streamliner(color, 0x1f5fa8, length, 0.32); break;
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
