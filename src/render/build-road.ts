// Road tile geometry.
import { World } from '../game/world';
import { GeoBuilder } from './geo';
import { DX, DZ, OPP, ROAD_TOP, HSTEP } from '../game/constants';

const HW = 0.25;     // half asphalt width
const SW = 0.075;    // sidewalk width
const ASPHALT_TOWN = 0x45474b;
const ASPHALT_PLAYER = 0x505257;
const SIDEWALK = 0xb7b2a8;
const MARK = 0xe9e7df;

/** Upward-facing quad on the terrain; points are tile-local (0..1) and get world offsets. */
export function flat4(gb: GeoBuilder, w: World, ox: number, oz: number, p: number[], yoff: number, yFixed?: number) {
  const y = (i: number) => (yFixed !== undefined ? yFixed : w.heightAt(ox + p[i * 2], oz + p[i * 2 + 1])) + yoff;
  const x0 = ox + p[0], z0 = oz + p[1], x1 = ox + p[2], z1 = oz + p[3], x2 = ox + p[4], z2 = oz + p[5], x3 = ox + p[6], z3 = oz + p[7];
  const y0 = y(0), y1 = y(1), y2 = y(2), y3 = y(3);
  // decide winding so that the normal points up
  const nx = (x1 - x0) * (z3 - z0) - (z1 - z0) * (x3 - x0);
  if (nx < 0) gb.quad(x0, y0, z0, x1, y1, z1, x2, y2, z2, x3, y3, z3);
  else gb.quad(x3, y3, z3, x2, y2, z2, x1, y1, z1, x0, y0, z0);
}

function rect(gb: GeoBuilder, w: World, ox: number, oz: number, xa: number, za: number, xb: number, zb: number, yoff: number, yFixed?: number) {
  flat4(gb, w, ox, oz, [xa, za, xb, za, xb, zb, xa, zb], yoff, yFixed);
}

/** Annulus sector around tile-local corner (cx,cz) from angle a0 to a1. */
function arc(gb: GeoBuilder, w: World, ox: number, oz: number, cx: number, cz: number, r0: number, r1: number, a0: number, a1: number, yoff: number, seg = 8, dash = false) {
  for (let i = 0; i < seg; i++) {
    if (dash && i % 2 === 1) continue;
    const t0 = a0 + ((a1 - a0) * i) / seg, t1 = a0 + ((a1 - a0) * (i + 1)) / seg;
    const c0 = Math.cos(t0), s0 = Math.sin(t0), c1 = Math.cos(t1), s1 = Math.sin(t1);
    flat4(gb, w, ox, oz, [cx + c0 * r0, cz + s0 * r0, cx + c1 * r0, cz + s1 * r0, cx + c1 * r1, cz + s1 * r1, cx + c0 * r1, cz + s0 * r1], yoff);
  }
}

/** Rectangle along an axis in tile-local coordinates: lateral range [l0,l1] around centre 0.5, longitudinal [s0,s1]. */
function axisRect(gb: GeoBuilder, w: World, ox: number, oz: number, ns: boolean, l0: number, l1: number, s0: number, s1: number, yoff: number) {
  if (ns) rect(gb, w, ox, oz, 0.5 + l0, s0, 0.5 + l1, s1, yoff);
  else rect(gb, w, ox, oz, s0, 0.5 + l0, s1, 0.5 + l1, yoff);
}

/** Rect for an arm towards edge d: lateral [l0,l1], from distance r0 to r1 from the tile centre. */
function armRect(gb: GeoBuilder, w: World, ox: number, oz: number, d: number, l0: number, l1: number, r0: number, r1: number, yoff: number) {
  const fx = DX[d], fz = DZ[d];
  const rx = -fz, rz = fx;
  const P = (l: number, r: number) => [0.5 + fx * r + rx * l, 0.5 + fz * r + rz * l];
  const a = P(l0, r0), b = P(l1, r0), c = P(l1, r1), e = P(l0, r1);
  flat4(gb, w, ox, oz, [a[0], a[1], b[0], b[1], c[0], c[1], e[0], e[1]], yoff);
}

export function buildRoadTile(w: World, x: number, z: number, gb: GeoBuilder, metal: GeoBuilder, lights?: number[], yFixed?: number) {
  const t = w.idx(x, z);
  const m = w.road[t];
  if (!m) return;
  const town = w.roadOwner[t] === 1;
  const asphalt = town ? ASPHALT_TOWN : ASPHALT_PLAYER;
  const y0 = ROAD_TOP;
  const ys = ROAD_TOP + 0.014;
  const ym = ROAD_TOP + 0.003;
  const isStop = w.station[t] >= 0 && w.stationKind[t] === 2;
  const crossing = w.rail[t] !== 0;
  const sidewalks = town || isStop;
  const bits = [0, 1, 2, 3].filter((d) => m & (1 << d));
  const n = bits.length;
  const straight = m === 0b0101 || m === 0b1010;
  const curve = n === 2 && !straight;
  if (straight) {
    const ns = m === 0b0101;
    gb.color(asphalt);
    axisRect(gb, w, x, z, ns, -HW, HW, 0, 1, y0);
    if (sidewalks) {
      gb.color(SIDEWALK);
      axisRect(gb, w, x, z, ns, -HW - SW, -HW, 0, 1, ys);
      axisRect(gb, w, x, z, ns, HW, HW + SW, 0, 1, ys);
    } else if (!crossing) {
      gb.color(0x8b8577);
      axisRect(gb, w, x, z, ns, -HW - 0.035, -HW, 0, 1, y0 - 0.008);
      axisRect(gb, w, x, z, ns, HW, HW + 0.035, 0, 1, y0 - 0.008);
    }
    if (!crossing) {
      gb.color(MARK);
      if (!isStop) for (const s of [0.06, 0.39, 0.72]) axisRect(gb, w, x, z, ns, -0.011, 0.011, s, s + 0.2, ym);
      if (!sidewalks) {
        axisRect(gb, w, x, z, ns, -HW + 0.02, -HW + 0.035, 0, 1, ym);
        axisRect(gb, w, x, z, ns, HW - 0.035, HW - 0.02, 0, 1, ym);
      }
    }
    if (isStop) buildBusStop(w, x, z, ns, gb, metal, sidewalks);
    if (crossing) buildCrossingDetails(w, x, z, ns, gb, metal);
    if (town && lights && !isStop && !crossing && (x + z) % 2 === 0) {
      const side = (x * 7 + z * 3) % 2 ? 1 : -1;
      const off = side * (HW + SW * 0.6);
      const px = ns ? x + 0.5 + off : x + 0.5, pz = ns ? z + 0.5 : z + 0.5 + off;
      const y = w.heightAt(px, pz) + ROAD_TOP;
      metal.color(0x3b4045);
      metal.cylinder(px, y, pz, 0.006, 0.21, 5);
      const hx = px - (ns ? side * 0.05 : 0), hz = pz - (ns ? 0 : side * 0.05);
      metal.box((px + hx) / 2, y + 0.205, (pz + hz) / 2, ns ? 0.06 : 0.012, 0.01, ns ? 0.012 : 0.06);
      gb.color(0xfff3c4);
      gb.box(hx, y + 0.19, hz, 0.022, 0.012, 0.022);
      lights.push(hx, y + 0.18, hz);
    }
    return;
  }
  if (curve) {
    const hasE = bits.includes(1), hasS = bits.includes(2);
    const cx = hasE ? 1 : 0, cz = hasS ? 1 : 0;
    // angles of the two edge midpoints as seen from the corner
    const ang = (d: number) => Math.atan2(0.5 + DZ[d] * 0.5 - cz, 0.5 + DX[d] * 0.5 - cx);
    let a0 = ang(bits[0]), a1 = ang(bits[1]);
    if (a1 - a0 > Math.PI) a0 += Math.PI * 2;
    if (a0 - a1 > Math.PI) a1 += Math.PI * 2;
    gb.color(asphalt);
    arc(gb, w, x, z, cx, cz, 0.5 - HW, 0.5 + HW, a0, a1, y0, 10);
    if (sidewalks) {
      gb.color(SIDEWALK);
      arc(gb, w, x, z, cx, cz, 0.5 - HW - SW, 0.5 - HW, a0, a1, ys, 6);
      arc(gb, w, x, z, cx, cz, 0.5 + HW, 0.5 + HW + SW, a0, a1, ys, 10);
    }
    gb.color(MARK);
    arc(gb, w, x, z, cx, cz, 0.489, 0.511, a0, a1, ym, 8, true);
    return;
  }
  // junctions and dead ends: centre square, arms
  gb.color(asphalt);
  rect(gb, w, x, z, 0.5 - HW, 0.5 - HW, 0.5 + HW, 0.5 + HW, y0, yFixed);
  for (const d of bits) armRect(gb, w, x, z, d, -HW, HW, HW, 0.5, y0);
  if (sidewalks) {
    gb.color(SIDEWALK);
    for (let d = 0; d < 4; d++) {
      if (m & (1 << d)) {
        armRect(gb, w, x, z, d, -HW - SW, -HW, HW, 0.5, ys);
        armRect(gb, w, x, z, d, HW, HW + SW, HW, 0.5, ys);
      } else {
        armRect(gb, w, x, z, d, -HW - SW, HW + SW, HW, HW + SW, ys);
      }
    }
    // corner fill pieces
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const ax = 0.5 + sx * HW, az = 0.5 + sz * HW;
      rect(gb, w, x, z, Math.min(ax, ax + sx * SW), Math.min(az, az + sz * SW), Math.max(ax, ax + sx * SW), Math.max(az, az + sz * SW), ys);
    }
  }
  // stop lines on junction arms
  if (n >= 3) {
    gb.color(MARK);
    for (const d of bits) armRect(gb, w, x, z, d, 0.02, HW - 0.02, HW + 0.02, HW + 0.045, ym);
  }
}

function buildBusStop(w: World, x: number, z: number, ns: boolean, gb: GeoBuilder, metal: GeoBuilder, sidewalks: boolean) {
  // yellow bay markings
  gb.color(0xe8c33a);
  const ym = ROAD_TOP + 0.004;
  for (const side of [-1, 1]) {
    const l0 = side < 0 ? -HW + 0.02 : HW - 0.035, l1 = l0 + 0.015;
    axisRect(gb, w, x, z, ns, l0, l1, 0.15, 0.85, ym);
  }
  axisRect(gb, w, x, z, ns, -0.04, 0.04, 0.47, 0.53, ym);
  // shelters on both sides
  const cx = x + 0.5, cz = z + 0.5;
  for (const side of [-1, 1]) {
    const off = side * (HW + SW * 0.5 + (sidewalks ? 0 : 0.05));
    const px = ns ? cx + off : cx, pz = ns ? cz : cz + off;
    const y = w.heightAt(px, pz) + ROAD_TOP + 0.014;
    const fx = ns ? side : 0, fz = ns ? 0 : side;
    // back wall + roof + posts
    gb.color(0x3c5d7a);
    const bx = px + fx * 0.025, bz = pz + fz * 0.025;
    gb.box(bx, y, bz, 0.28, 0.12, 0.012, fx, fz);
    gb.color(0xd9d5cc);
    gb.box(px, y + 0.12, pz, 0.3, 0.012, 0.08, fx, fz);
    gb.color(0x2c2c2c);
    gb.box(px - (ns ? 0 : 0.13) - fx * 0.0, y, pz - (ns ? 0.13 : 0), 0.01, 0.12, 0.01, fx, fz);
    gb.box(px + (ns ? 0 : 0.13), y, pz + (ns ? 0.13 : 0), 0.01, 0.12, 0.01, fx, fz);
    // sign pole
    metal.color(0x9aa0a6);
    const sx = ns ? px : px + 0.2, sz = ns ? pz + 0.2 : pz;
    metal.cylinder(sx, y, sz, 0.006, 0.17, 5);
    gb.color(0xe8c33a);
    gb.box(sx, y + 0.15, sz, 0.05, 0.05, 0.008, ns ? 0 : 1, ns ? 1 : 0);
  }
}

function buildCrossingDetails(w: World, x: number, z: number, ns: boolean, gb: GeoBuilder, metal: GeoBuilder) {
  // barrier posts with raised booms at diagonal corners, warning crosses
  const corners = ns ? [[0.5 - HW - 0.06, 0.12, 1], [0.5 + HW + 0.06, 0.88, -1]] : [[0.12, 0.5 + HW + 0.06, 1], [0.88, 0.5 - HW - 0.06, -1]];
  for (const [lx, lz] of corners) {
    const px = x + lx, pz = z + lz;
    const y = w.heightAt(px, pz) + ROAD_TOP;
    gb.color(0xf2f2f2);
    gb.box(px, y, pz, 0.035, 0.07, 0.035);
    metal.color(0xc8c8c8);
    metal.cylinder(px, y, pz, 0.007, 0.22, 5);
    gb.color(0xd23a2a);
    gb.box(px, y + 0.07, pz, 0.012, 0.42, 0.012);
    gb.color(0xffffff);
    gb.box(px, y + 0.19, pz, 0.08, 0.012, 0.005, ns ? 1 : 0, ns ? 0 : 1);
  }
  void OPP; void HSTEP;
}
