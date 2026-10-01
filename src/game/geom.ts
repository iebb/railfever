// Curves for track pieces, road lanes and structures. Used by both renderer and vehicles.
import { World, Structure } from './world';
import {
  DX, DZ, OPP, EDGE_MID_X, EDGE_MID_Z, PIECE_EDGES, PIECE_COUNT, HSTEP, LANE_OFFSET,
} from './constants';

export interface PathCurve {
  /** xyz samples */
  pts: Float32Array;
  /** cumulative length at each sample */
  cum: Float32Array;
  len: number;
  minRadius: number;
  /** true if heights are explicit (bridges/tunnels) rather than terrain-following */
  elevated: boolean;
}

export interface Vec3Like { x: number; y: number; z: number }

/** Evaluate position (and optionally unit direction) at arc length s. */
export function curvePoint(c: PathCurve, s: number, out: Vec3Like, dir?: Vec3Like) {
  const n = c.cum.length;
  if (s <= 0) s = 0;
  if (s >= c.len) s = c.len;
  // binary search
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (c.cum[mid] <= s) lo = mid; else hi = mid;
  }
  const seg = c.cum[hi] - c.cum[lo];
  const f = seg > 1e-9 ? (s - c.cum[lo]) / seg : 0;
  const p = c.pts;
  const ax = p[lo * 3], ay = p[lo * 3 + 1], az = p[lo * 3 + 2];
  const bx = p[hi * 3], by = p[hi * 3 + 1], bz = p[hi * 3 + 2];
  out.x = ax + (bx - ax) * f;
  out.y = ay + (by - ay) * f;
  out.z = az + (bz - az) * f;
  if (dir) {
    const l = Math.hypot(bx - ax, by - ay, bz - az) || 1;
    dir.x = (bx - ax) / l; dir.y = (by - ay) / l; dir.z = (bz - az) / l;
  }
}

function finalize(pts: number[], elevated: boolean): PathCurve {
  const n = pts.length / 3;
  const cum = new Float32Array(n);
  let len = 0;
  for (let i = 1; i < n; i++) {
    len += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
    cum[i] = len;
  }
  // minimum turning radius (horizontal)
  let minR = Infinity;
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i * 3] - pts[i * 3 - 3], az = pts[i * 3 + 2] - pts[i * 3 - 1];
    const bx = pts[i * 3 + 3] - pts[i * 3], bz = pts[i * 3 + 5] - pts[i * 3 + 2];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const cross = (ax * bz - az * bx) / (la * lb);
    const dot = (ax * bx + az * bz) / (la * lb);
    const ang = Math.abs(Math.atan2(cross, dot));
    if (ang > 1e-4) minR = Math.min(minR, ((la + lb) / 2) / ang);
  }
  return { pts: new Float32Array(pts), cum, len, minRadius: minR, elevated };
}

export function polylineCurve(pts: number[], elevated = true): PathCurve {
  return finalize(pts, elevated);
}

// ------------------------------------------------------------------ rail pieces

/** Outward direction of a piece through exit edge b (diagonal for curves). */
function pieceOutDir(p: number, b: number): [number, number] {
  const [e1, e2] = PIECE_EDGES[p];
  const a = e1 === b ? e2 : e1;
  const x = DX[b] + DX[OPP[a]], z = DZ[b] + DZ[OPP[a]];
  const l = Math.hypot(x, z);
  return [x / l, z / l];
}

function singlePieceAt(w: World, t: number, e: number): number {
  const m = w.rail[t];
  let found = -1;
  for (let p = 0; p < PIECE_COUNT; p++) {
    if (!(m & (1 << p))) continue;
    const [e1, e2] = PIECE_EDGES[p];
    if (e1 === e || e2 === e) { if (found >= 0) return -2; found = p; }
  }
  return found;
}

/** Outward tangent of rail at edge e of tile t. */
export function railEdgeTangent(w: World, t: number, e: number): [number, number] {
  const perp: [number, number] = [DX[e], DZ[e]];
  const p = singlePieceAt(w, t, e);
  if (p < 0 || p < 2) return perp; // none, multiple, or straight
  if (w.headAt(t, e) >= 0) return perp;
  const n = w.neighbour(t, e);
  if (n < 0) return perp;
  const q = singlePieceAt(w, n, OPP[e]);
  if (q < 2) return perp;
  const a = pieceOutDir(p, e);
  const b = pieceOutDir(q, OPP[e]);
  if (Math.abs(a[0] + b[0]) < 1e-6 && Math.abs(a[1] + b[1]) < 1e-6) return a;
  return perp;
}

function bezierPts(
  x0: number, z0: number, tx0: number, tz0: number,
  x3: number, z3: number, tx3: number, tz3: number,
  yA: number, yB: number, n: number, ox: number, oz: number,
): number[] {
  const chord = Math.hypot(x3 - x0, z3 - z0);
  const parallel = Math.abs(tx0 * tz3 - tz0 * tx3) < 1e-6;
  const k = parallel ? chord / 3 : chord * 0.3905;
  const x1 = x0 + tx0 * k, z1 = z0 + tz0 * k;
  const x2 = x3 - tx3 * k, z2 = z3 - tz3 * k;
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n, v = 1 - u;
    const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
    pts.push(ox + b0 * x0 + b1 * x1 + b2 * x2 + b3 * x3, yA + (yB - yA) * u, oz + b0 * z0 + b1 * z1 + b2 * z2 + b3 * z3);
  }
  return pts;
}

/** Curve for rail piece p on tile t, oriented from PIECE_EDGES[p][0] to [1]. */
function buildRailPieceCurve(w: World, t: number, p: number): PathCurve {
  const x = w.tx(t), z = w.tz(t);
  const [a, b] = PIECE_EDGES[p];
  const ta = railEdgeTangent(w, t, a);
  const tb = railEdgeTangent(w, t, b);
  const la = w.edgeLevel(x, z, a), lb = w.edgeLevel(x, z, b);
  const ya = (isNaN(la) ? w.tileMax(x, z) : la) * HSTEP;
  const yb = (isNaN(lb) ? w.tileMax(x, z) : lb) * HSTEP;
  const pts = bezierPts(
    EDGE_MID_X[a], EDGE_MID_Z[a], -ta[0], -ta[1],
    EDGE_MID_X[b], EDGE_MID_Z[b], tb[0], tb[1],
    ya, yb, p < 2 ? 4 : 12, x, z,
  );
  return finalize(pts, false);
}

const railCache = new Map<number, { v: number; c: PathCurve }>();
export function railPieceCurve(w: World, t: number, p: number): PathCurve {
  const key = t * 8 + p;
  const v = w.tileVersion[t] + w.heightsVersion * 0; // tileVersion bumps on height change too
  const e = railCache.get(key);
  if (e && e.v === v) return e.c;
  const c = buildRailPieceCurve(w, t, p);
  railCache.set(key, { v, c });
  return c;
}

// ------------------------------------------------------------------ structures

/** Straight curve from head A's exit edge to head B's entry edge (A->B). */
export function structureCurve(w: World, s: Structure, laneOffset = 0): PathCurve {
  const d = s.dir;
  const x0 = s.ax + EDGE_MID_X[d], z0 = s.az + EDGE_MID_Z[d];
  const x1 = s.bx + EDGE_MID_X[OPP[d]], z1 = s.bz + EDGE_MID_Z[OPP[d]];
  const y = s.h * HSTEP;
  // right of travel direction
  const rx = -DZ[d], rz = DX[d];
  const n = Math.max(2, s.span + 1);
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    pts.push(x0 + (x1 - x0) * u + rx * laneOffset, y, z0 + (z1 - z0) * u + rz * laneOffset);
  }
  return finalize(pts, true);
}
const structCache = new Map<number, PathCurve>();
export function structureCurveCached(w: World, s: Structure, lane: number): PathCurve {
  const key = s.id * 4 + lane;
  let c = structCache.get(key);
  if (!c) {
    c = structureCurve(w, s, lane === 0 ? 0 : lane === 1 ? LANE_OFFSET : -LANE_OFFSET);
    structCache.set(key, c);
  }
  return c;
}
export function clearStructureCache(id: number) {
  for (let k = 0; k < 4; k++) structCache.delete(id * 4 + k);
}

// ------------------------------------------------------------------ road lanes

/** Centreline sample points of a road connection between edges a and b on tile (x,z). */
function roadCenter(x: number, z: number, a: number, b: number, n: number): number[] {
  return bezierPts(
    EDGE_MID_X[a], EDGE_MID_Z[a], -DX[a], -DZ[a],
    EDGE_MID_X[b], EDGE_MID_Z[b], DX[b], DZ[b],
    0, 0, n, x, z,
  );
}

function buildLane(w: World, t: number, a: number, b: number): PathCurve {
  const x = w.tx(t), z = w.tz(t);
  const L = LANE_OFFSET;
  const pts: number[] = [];
  if (a === b) {
    // U-turn: enter via a, loop around and exit via a
    const hx = DX[OPP[a]], hz = DZ[OPP[a]];
    const rx = -hz, rz = hx;
    const mx = x + EDGE_MID_X[a], mz = z + EDGE_MID_Z[a];
    const deadEnd = (w.road[t] & ~(1 << a)) === 0;
    const depth = deadEnd ? 0.32 : 0.22;
    const ox = mx + hx * depth, oz = mz + hz * depth;
    pts.push(mx + rx * L, 0, mz + rz * L);
    const N = 10;
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI;
      pts.push(ox + rx * L * Math.cos(th) + hx * L * Math.sin(th), 0, oz + rz * L * Math.cos(th) + hz * L * Math.sin(th));
    }
    pts.push(mx - rx * L, 0, mz - rz * L);
  } else {
    const straight = b === OPP[a];
    const c = roadCenter(x, z, a, b, straight ? 2 : 10);
    const n = c.length / 3;
    for (let i = 0; i < n; i++) {
      const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
      let tx = c[i1 * 3] - c[i0 * 3], tz = c[i1 * 3 + 2] - c[i0 * 3 + 2];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      pts.push(c[i * 3] - tz * L, 0, c[i * 3 + 2] + tx * L);
    }
  }
  // heights follow the (planar) road tile
  for (let i = 0; i < pts.length; i += 3) pts[i + 1] = w.heightAt(pts[i], pts[i + 2]);
  return finalize(pts, false);
}

const laneCache = new Map<number, { v: number; c: PathCurve }>();
export function roadLaneCurve(w: World, t: number, a: number, b: number): PathCurve {
  const key = t * 16 + a * 4 + b;
  const v = w.tileVersion[t];
  const e = laneCache.get(key);
  if (e && e.v === v) return e.c;
  const c = buildLane(w, t, a, b);
  laneCache.set(key, { v, c });
  return c;
}

export function clearGeomCaches() {
  railCache.clear(); laneCache.clear(); structCache.clear();
}
