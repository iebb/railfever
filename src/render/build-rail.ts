// Rail, station, depot, bridge and tunnel geometry.
import { World, Structure } from '../game/world';
import { GeoBuilder } from './geo';
import { DX, DZ, OPP, PIECE_EDGES, PIECE_COUNT, HSTEP, EDGE_MID_X, EDGE_MID_Z, ROAD_TOP } from '../game/constants';
import { railPieceCurve, curvePoint, PathCurve } from '../game/geom';
import { hash2 } from '../game/rng';
import { FC } from './textures';
import { FacadeBuilder, gableRoof } from './build-buildings';
import { buildRoadTile } from './build-road';

const BALLAST: [number, number][] = [[-0.215, -0.01], [0.215, -0.01], [0.15, 0.05], [-0.15, 0.05]];
const railProfile = (off: number): [number, number][] => [[off - 0.011, 0.058], [off + 0.011, 0.058], [off + 0.008, 0.086], [off - 0.008, 0.086]];

export interface SignalLamp { x: number; y: number; z: number; t: number }

function trackAlong(pts: ArrayLike<number>, len: number, matte: GeoBuilder, metal: GeoBuilder, opts: { ballast: boolean; sleepers: boolean; seed: number; yOff?: number }) {
  const yo = opts.yOff ?? 0;
  let p = pts;
  if (yo) { const q = Array.from(pts); for (let i = 1; i < q.length; i += 3) q[i] += yo; p = q; }
  if (opts.ballast) {
    const v = 0.92 + hash2(opts.seed, 7) * 0.12;
    matte.colorRGB(0.56 * v, 0.53 * v, 0.48 * v);
    matte.extrude(p, BALLAST);
  }
  if (opts.sleepers) {
    matte.color(0x4e3e2e);
    // walk along polyline placing sleepers
    const n = p.length / 3;
    const cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + Math.hypot(p[i * 3] - p[i * 3 - 3], p[i * 3 + 2] - p[i * 3 - 1]));
    const total = cum[n - 1];
    const count = Math.max(1, Math.round(total / 0.095));
    let seg = 0;
    for (let k = 0; k < count; k++) {
      const s = ((k + 0.5) / count) * total;
      while (seg < n - 2 && cum[seg + 1] < s) seg++;
      const f = (s - cum[seg]) / Math.max(1e-6, cum[seg + 1] - cum[seg]);
      const x = p[seg * 3] + (p[seg * 3 + 3] - p[seg * 3]) * f;
      const y = p[seg * 3 + 1] + (p[seg * 3 + 4] - p[seg * 3 + 1]) * f;
      const z = p[seg * 3 + 2] + (p[seg * 3 + 5] - p[seg * 3 + 2]) * f;
      let tx = p[seg * 3 + 3] - p[seg * 3], tz = p[seg * 3 + 5] - p[seg * 3 + 2];
      const l = Math.hypot(tx, tz) || 1; tx /= l; tz /= l;
      matte.box(x, y + 0.036, z, 0.27, 0.022, 0.038, tx, tz);
    }
  }
  metal.color(0x8c8780);
  metal.extrude(p, railProfile(-0.072));
  metal.extrude(p, railProfile(0.072));
  void len;
}

function curvePts(c: PathCurve): Float32Array { return c.pts; }

export function buildRailTile(w: World, x: number, z: number, matte: GeoBuilder, metal: GeoBuilder, fac: FacadeBuilder, lamps: SignalLamp[]) {
  const t = w.idx(x, z);
  const m = w.rail[t];
  if (!m) return;
  const crossing = w.road[t] !== 0;
  const station = w.station[t] >= 0 && w.stationKind[t] === 1;
  for (let p = 0; p < PIECE_COUNT; p++) {
    if (!(m & (1 << p))) continue;
    const c = railPieceCurve(w, t, p);
    let pts: ArrayLike<number> = curvePts(c);
    if (crossing) {
      const q = Array.from(pts); for (let i = 1; i < q.length; i += 3) q[i] += ROAD_TOP - 0.058 + 0.004; pts = q;
      trackAlong(pts, c.len, matte, metal, { ballast: false, sleepers: false, seed: t });
    } else {
      // offset ballast slightly per piece to avoid z-fighting at junctions
      const q = Array.from(pts); for (let i = 1; i < q.length; i += 3) q[i] += p * 0.0015; pts = q;
      trackAlong(pts, c.len, matte, metal, { ballast: true, sleepers: true, seed: t * 6 + p });
    }
    // buffer stops at dead ends
    for (const e of PIECE_EDGES[p]) {
      if (w.headAt(t, e) >= 0) continue;
      const n = w.neighbour(t, e);
      let connected = false;
      if (n >= 0) {
        if (w.railEdges(n) & (1 << OPP[e])) connected = true;
        const dp = w.depot[n] >= 0 ? w.depots.get(w.depot[n]) : null;
        if (dp && dp.kind === 'rail' && dp.dir === OPP[e]) connected = true;
      }
      if (!connected) {
        const ex = x + EDGE_MID_X[e] - DX[e] * 0.07, ez = z + EDGE_MID_Z[e] - DZ[e] * 0.07;
        const y = (isNaN(w.edgeLevel(x, z, e)) ? w.tileMax(x, z) : w.edgeLevel(x, z, e)) * HSTEP + 0.05;
        matte.color(0xb83a2c);
        matte.box(ex, y, ez, 0.22, 0.07, 0.05, DX[e], DZ[e]);
        matte.color(0xf0f0f0);
        matte.box(ex, y + 0.07, ez, 0.22, 0.012, 0.052, DX[e], DZ[e]);
      }
    }
  }
  if (station) buildPlatform(w, x, z, m & 1 ? 0 : 1, matte, metal, fac);
  const sig = w.signal[t];
  if (sig) {
    let p = 0;
    while (!(m & (1 << p))) p++;
    const c = railPieceCurve(w, t, p);
    const [e0, e1] = PIECE_EDGES[p];
    const dirs: [number, boolean][] = [];
    if (sig === 1 || sig === 2) dirs.push([e0, true]);
    if (sig === 1 || sig === 3) dirs.push([e1, false]);
    for (const [entry, fwd] of dirs) buildSignal(c, fwd, false, matte, metal, lamps, t);
    if (sig === 2) buildSignal(c, false, true, matte, metal, lamps, t);
    if (sig === 3) buildSignal(c, true, true, matte, metal, lamps, t);
    void e0; void e1;
  }
}

const tmp = { x: 0, y: 0, z: 0 };
const tmpD = { x: 0, y: 0, z: 0 };
function buildSignal(c: PathCurve, fwd: boolean, noEntry: boolean, matte: GeoBuilder, metal: GeoBuilder, lamps: SignalLamp[], t: number) {
  const s = fwd ? 0.14 : c.len - 0.14;
  curvePoint(c, s, tmp, tmpD);
  let dx = tmpD.x, dz = tmpD.z;
  if (!fwd) { dx = -dx; dz = -dz; }
  const rx = -dz, rz = dx;
  const px = tmp.x + rx * 0.2, pz = tmp.z + rz * 0.2;
  const y = tmp.y;
  metal.color(0x5a5f63);
  metal.cylinder(px, y, pz, 0.008, noEntry ? 0.2 : 0.34, 5);
  if (noEntry) {
    matte.color(0xd33a2c);
    matte.box(px, y + 0.17, pz, 0.07, 0.07, 0.01, -dx, -dz);
    matte.color(0xffffff);
    matte.box(px, y + 0.199, pz - 0.0, 0.05, 0.012, 0.012, -dx, -dz);
    return;
  }
  matte.color(0x1d1f21);
  matte.box(px, y + 0.27, pz, 0.04, 0.085, 0.03, -dx, -dz);
  lamps.push({ x: px - dx * 0.017, y: y + 0.31, z: pz - dz * 0.017, t });
}

function buildPlatform(w: World, x: number, z: number, axis: number, matte: GeoBuilder, metal: GeoBuilder, fac: FacadeBuilder) {
  const y = w.tileMax(x, z) * HSTEP;
  const ns = axis === 0;
  const R = (l0: number, l1: number, s0: number, s1: number): [number, number, number, number] =>
    ns ? [x + l0, z + s0, x + l1, z + s1] : [x + s0, z + l0, x + s1, z + l1];
  const t = w.idx(x, z);
  const stId = w.station[t];
  const sameNeighbour = (d: number) => {
    const n = w.neighbour(t, d);
    return n >= 0 && w.station[n] === stId && w.stationKind[n] === 1;
  };
  const sideA = ns ? 3 : 0, sideB = ns ? 1 : 2; // lateral neighbours
  const along0 = ns ? 0 : 3, along1 = ns ? 2 : 1;
  // station hall on the outer platform of the middle tile
  const count = (d: number) => { let n = 0, c = t; for (;;) { const m = w.neighbour(c, d); if (m < 0 || w.station[m] !== stId || w.stationKind[m] !== 1) return n; n++; c = m; } };
  const n0 = count(along0), n1 = count(along1);
  const hall = !sameNeighbour(sideA) && n0 === Math.floor((n0 + n1) / 2) && n0 + n1 >= 1;
  if (hall) {
    const lc = 0.13;
    const [hx, hz] = ns ? [x + lc, z + 0.5] : [x + 0.5, z + lc];
    const fx = ns ? -1 : 0, fz = ns ? 0 : -1; // facade faces away from the tracks
    const W = 0.86, D = 0.22, H = 0.27;
    fac.boxWalls(hx, y + 0.1, hz, W, D, H, fx, fz, FC.STATION, FC.STATION, 0xffffff, t, { sideGround: -1 });
    gableRoof(matte, hx, y + 0.1 + H - 0.005, hz, W + 0.06, D + 0.08, 0.1, fx, fz, 0x7a3a2c, false);
    matte.color(0x2d4f7c);
    matte.box(hx + fx * (D / 2 + 0.006), y + 0.1 + H - 0.07, hz + fz * (D / 2 + 0.006), 0.3, 0.05, 0.01, fx, fz);
    metal.color(0xd8c37a);
    metal.cylinder(hx, y + 0.1 + H + 0.1, hz, 0.012, 0.06, 6);
  }
  for (const [l0, l1, side] of [[0, 0.27, sideA], [0.73, 1, sideB]] as [number, number, number][]) {
    const [ax, az, bx, bz] = R(l0, l1, 0, 1);
    matte.color(0xc9c5bd);
    matte.aabb(Math.min(ax, bx), y, Math.min(az, bz), Math.max(ax, bx), y + 0.1, Math.max(az, bz));
    // yellow safety line along the track edge
    const edgeL = side === sideA ? l1 - 0.025 : l0 + 0.005;
    const [cx0, cz0, cx1, cz1] = R(edgeL, edgeL + 0.02, 0, 1);
    matte.color(0xe9c43c);
    matte.aabb(Math.min(cx0, cx1), y + 0.1, Math.min(cz0, cz1), Math.max(cx0, cx1), y + 0.102, Math.max(cz0, cz1));
    // canopy over the platform centre (skipped on the end tiles of the platform)
    const endTile = !sameNeighbour(along0) || !sameNeighbour(along1);
    if (!endTile && !(hall && side === sideA)) {
      const lc = (l0 + l1) / 2 + (side === sideA ? -0.03 : 0.03);
      const [px, pz] = ns ? [x + lc, z + 0.5] : [x + 0.5, z + lc];
      metal.color(0x4f5a62);
      metal.cylinder(px, y + 0.1, pz, 0.01, 0.27, 6);
      const [rx0, rz0, rx1, rz1] = R(l0 + (side === sideA && !sameNeighbour(side) ? 0.02 : 0), l1 - 0.015, 0, 1);
      matte.color(0x9aa3a8);
      matte.aabb(Math.min(rx0, rx1), y + 0.37, Math.min(rz0, rz1), Math.max(rx0, rx1), y + 0.385, Math.max(rz0, rz1));
      const [ex0, ez0, ex1, ez1] = R(side === sideA ? l1 - 0.03 : l0, side === sideA ? l1 - 0.015 : l0 + 0.015, 0, 1);
      matte.color(0x5d6a72);
      matte.aabb(Math.min(ex0, ex1), y + 0.35, Math.min(ez0, ez1), Math.max(ex0, ex1), y + 0.37, Math.max(ez0, ez1));
    }
    // benches every other tile
    if ((x + z) % 2 === 0) {
      matte.color(0x7b5a3a);
      const [bx2, bz2] = ns ? [x + (l0 + l1) / 2 + (side === sideA ? -0.03 : 0.03), z + 0.25] : [x + 0.25, z + (l0 + l1) / 2 + (side === sideA ? -0.03 : 0.03)];
      matte.box(bx2, y + 0.1, bz2, ns ? 0.04 : 0.14, 0.035, ns ? 0.14 : 0.04);
    }
    // lamp
    metal.color(0x3d4246);
    const [lx, lz] = ns ? [x + (l0 + l1) / 2, z + 0.85] : [x + 0.85, z + (l0 + l1) / 2];
    metal.cylinder(lx, y + 0.1, lz, 0.006, 0.26, 5);
  }
  void fac;
}

/** Rail and road depots. */
export function buildDepot(w: World, x: number, z: number, matte: GeoBuilder, metal: GeoBuilder, fac: FacadeBuilder) {
  const t = w.idx(x, z);
  const dp = w.depots.get(w.depot[t]);
  if (!dp) return;
  const y = w.tileMax(x, z) * HSTEP;
  const d = dp.dir;
  const fx = DX[d], fz = DZ[d];
  const cx = x + 0.5 - fx * 0.06, cz = z + 0.5 - fz * 0.06;
  if (dp.kind === 'rail') {
    // track from inside to the edge
    const pts = [x + 0.5 - fx * 0.4, y, z + 0.5 - fz * 0.4, x + EDGE_MID_X[d], y, z + EDGE_MID_Z[d]];
    trackAlong(pts, 1, matte, metal, { ballast: true, sleepers: true, seed: t });
    const W = 0.64, D = 0.7, H = 0.36;
    fac.boxWalls(cx, y, cz, W, D, H, fx, fz, FC.BRICK_PLAIN, FC.BRICK_PLAIN, 0xffffff, t, { frontCell: -1 });
    // front wall with big opening
    const rx = fz, rz = -fx;
    const fxp = cx + fx * D / 2, fzp = cz + fz * D / 2;
    matte.color(0x8f5640);
    matte.box(fxp + rx * (W / 2 - 0.08), y, fzp + rz * (W / 2 - 0.08), 0.16, H, 0.03, fx, fz);
    matte.box(fxp - rx * (W / 2 - 0.08), y, fzp - rz * (W / 2 - 0.08), 0.16, H, 0.03, fx, fz);
    matte.box(fxp, y + 0.27, fzp, W, H - 0.27, 0.03, fx, fz);
    matte.color(0x141414);
    matte.box(fxp - fx * 0.02, y, fzp - fz * 0.02, W - 0.3, 0.27, 0.01, fx, fz);
    gableRoof(matte, cx, y + H, cz, W + 0.06, D + 0.06, 0.16, fx, fz, 0x4a4f55, true);
  } else {
    const W = 0.72, D = 0.62, H = 0.26;
    fac.boxWalls(cx, y, cz, W, D, H, fx, fz, FC.BRICK_PLAIN, FC.BRICK_PLAIN, 0xffffff, t, { frontCell: FC.GARAGE });
    matte.color(0x6d6a64);
    matte.box(cx, y + H, cz, W + 0.02, 0.03, D + 0.02, fx, fz);
    // apron
    matte.color(0x4a4c50);
    const ax = x + 0.5 + fx * 0.38, az = z + 0.5 + fz * 0.38;
    matte.box(ax, y + 0.002, az, 0.5, 0.025, 0.24, fx, fz);
  }
}

/** Bridge deck over a span tile, or nothing for tunnels. */
export function buildSpan(w: World, x: number, z: number, s: Structure, matte: GeoBuilder, metal: GeoBuilder) {
  if (s.kind !== 'bridge') return;
  const d = s.dir;
  const y = s.h * HSTEP;
  const ns = d === 0 || d === 2;
  const rail = s.transport === 'rail';
  const half = rail ? 0.27 : 0.36;
  const x0 = ns ? x + 0.5 - half : x, x1 = ns ? x + 0.5 + half : x + 1;
  const z0 = ns ? z : z + 0.5 - half, z1 = ns ? z + 1 : z + 0.5 + half;
  // deck
  matte.color(0xa29e95);
  matte.aabb(x0, y - 0.09, z0, x1, y - 0.005, z1);
  // edge beams and railings
  const gx = ns ? 0 : 1, gz = ns ? 1 : 0;
  matte.color(0x8e8a82);
  for (const side of [-1, 1]) {
    const ox = ns ? side * (half - 0.02) : 0, oz = ns ? 0 : side * (half - 0.02);
    matte.box(x + 0.5 + ox, y - 0.09, z + 0.5 + oz, 0.04, 0.1, 1.0, gx, gz);
  }
  metal.color(rail ? 0x4f5d68 : 0x9aa0a4);
  for (const side of [-1, 1]) {
    const ox = ns ? side * (half - 0.012) : 0, oz = ns ? 0 : side * (half - 0.012);
    const cx = x + 0.5 + ox, cz = z + 0.5 + oz;
    metal.box(cx, y + 0.055, cz, 0.012, 0.012, 1.0, gx, gz);
    for (const k of [-0.375, -0.125, 0.125, 0.375]) metal.box(cx + gx * k, y + 0.01, cz + gz * k, 0.01, 0.05, 0.01, gx, gz);
  }
  // steel arch for rail bridges
  if (rail) {
    const st = w.idx(x, z);
    const k = (d === 1 || d === 3) ? (x - s.ax) * (d === 1 ? 1 : -1) : (z - s.az) * (d === 2 ? 1 : -1);
    const span = s.span;
    const archH = Math.min(0.5, 0.12 + span * 0.04);
    const f = (u: number) => archH * 4 * u * (1 - u);
    for (const side of [-1, 1]) {
      const ox = ns ? side * (half - 0.012) : 0, oz = ns ? 0 : side * (half - 0.012);
      const u0 = (k - 1) / span, u1 = k / span;
      const ax = x + 0.5 + ox - gx * 0.5, az = z + 0.5 + oz - gz * 0.5;
      const bx = ax + gx, bz = az + gz;
      const flip = d === 3 || d === 0;
      const ua = flip ? u1 : u0, ub = flip ? u0 : u1;
      metal.tube(ax, y + 0.06 + f(ua), az, bx, y + 0.06 + f(ub), bz, 0.012, 5);
      // hangers
      metal.tube(ax + gx * 0.5, y + 0.06, az + gz * 0.5, ax + gx * 0.5, y + 0.06 + f((ua + ub) / 2), az + gz * 0.5, 0.004, 4);
    }
    void st;
  }
  // surface
  const sx = x + 0.5 - DX[d] * 0.5, sz = z + 0.5 - DZ[d] * 0.5, ex = x + 0.5 + DX[d] * 0.5, ez = z + 0.5 + DZ[d] * 0.5;
  if (rail) {
    trackAlong([sx, y, sz, ex, y, ez], 1, matte, metal, { ballast: true, sleepers: true, seed: w.idx(x, z), yOff: -0.005 });
  } else {
    matte.color(0x4c4e52);
    const hw = 0.25;
    matte.aabb(ns ? x + 0.5 - hw : x, y - 0.005, ns ? z : z + 0.5 - hw, ns ? x + 0.5 + hw : x + 1, y + ROAD_TOP - 0.005, ns ? z + 1 : z + 0.5 + hw);
    matte.color(0xe9e7df);
    for (const s0 of [0.1, 0.6]) {
      const a = s0, b = s0 + 0.25;
      matte.aabb(ns ? x + 0.49 : x + a, y + ROAD_TOP - 0.004, ns ? z + a : z + 0.49, ns ? x + 0.51 : x + b, y + ROAD_TOP - 0.002, ns ? z + b : z + 0.51);
    }
  }
  // pillar down to the ground
  const ground = Math.min(w.tileMin(x, z) * HSTEP, 0) - 0.05;
  const gy = Math.max(w.tileMin(x, z) * HSTEP - 0.3, ground - 0.4);
  if (y - 0.09 - gy > 0.05) {
    matte.color(0x96928a);
    const px = x + 0.5, pz = z + 0.5;
    matte.box(px, gy, pz, ns ? half * 1.3 : 0.12, y - 0.09 - gy, ns ? 0.12 : half * 1.3);
  }
}

/** Tunnel portal at a head tile facing direction d (towards the tunnel). */
export function buildPortal(w: World, x: number, z: number, d: number, s: Structure, matte: GeoBuilder) {
  const y = s.h * HSTEP;
  const ex = x + EDGE_MID_X[d], ez = z + EDGE_MID_Z[d];
  const fx = -DX[d], fz = -DZ[d]; // portal front faces back towards the head tile
  const rx = fz, rz = -fx;
  const ow = s.transport === 'rail' ? 0.4 : 0.56, oh = 0.38;
  const W = ow + 0.36, H = 0.6;
  matte.color(0x8d877b);
  const side = (W - ow) / 2;
  matte.box(ex + rx * (ow / 2 + side / 2), y - 0.05, ez + rz * (ow / 2 + side / 2), side, H + 0.05, 0.12, fx, fz);
  matte.box(ex - rx * (ow / 2 + side / 2), y - 0.05, ez - rz * (ow / 2 + side / 2), side, H + 0.05, 0.12, fx, fz);
  matte.box(ex, y + oh, ez, ow, H - oh, 0.12, fx, fz);
  matte.color(0x6d675d);
  matte.box(ex + fx * 0.01, y + H, ez + fz * 0.01, W + 0.04, 0.04, 0.15, fx, fz);
  // dark interior
  matte.color(0x080808);
  matte.box(ex - fx * 0.05, y - 0.02, ez - fz * 0.05, ow, oh + 0.02, 0.02, fx, fz);
}

/** Road surface on bridge heads / generic road on a tile (re-export). */
export { buildRoadTile };
