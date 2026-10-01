// AI competitors: companies that plan and build bus networks and intercity railways using the same
// construction API as the player (findSnap / planEdge / commitProposal, stations, depots, lines, vehicles).
import type { Game } from './game';
import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import type { NNode, NEdge } from './network';
import { NetKind, RAIL, TRACK_TYPES, ROAD_TYPES, WATER_Y, STATION_RADIUS } from './constants';
import { planEdge, commitProposal, findSnap, freeSide, BuildOptions, Snap, Proposal } from './construction';
import { recomputeLocks } from './terraform';
import { distToRect } from './world';
import { Heap, Train } from './train';
import { RoadVehicle } from './roadvehicle';
import { RNG } from './rng';
import { Economy } from './economy';
import { availableModels, VehicleModel } from './vehicle-types';
import { fare } from './vehicle';
import { segIntersect, angleBetween, endTangent } from './geom';

export const AI_NAMES = ['Northern Star Rail', 'Blue Valley Transit', 'Crimson Express', 'Evergreen Lines'];

// ============================================================================ geometry helpers

/** Oriented point: position and unit tangent (direction of travel). */
export interface OPoint { x: number; z: number; tx: number; tz: number }
interface P2 { x: number; z: number }

/** Junction of the equal-tangent biarc from (p0,t0) to (p1,t1); null if degenerate. */
export function biarcJunction(a: OPoint, b: OPoint): P2 | null {
  const vx = b.x - a.x, vz = b.z - a.z;
  const tx = a.tx + b.tx, tz = a.tz + b.tz;
  const vt = vx * tx + vz * tz, vv = vx * vx + vz * vz;
  const k = 2 * (1 - (a.tx * b.tx + a.tz * b.tz));
  let d: number;
  if (k < 1e-6) { if (vt <= 1e-9) return null; d = vv / (2 * vt); }
  else d = (-vt + Math.sqrt(vt * vt + k * vv)) / k;
  if (!(d > 0) || !isFinite(d)) return null;
  return { x: (a.x + d * a.tx + b.x - d * b.tx) / 2, z: (a.z + d * a.tz + b.z - d * b.tz) / 2 };
}

/** Rail/road formation height reference used by planEdge for a free end (max terrain across the tracks). */
function terrRef(g: Game, x: number, z: number, tx: number, tz: number, tracks: number): number {
  const w = g.world;
  let h = w.heightAt(x, z);
  if (tracks > 1) {
    const o = ((tracks - 1) / 2) * RAIL.spacing;
    h = Math.max(h, w.heightAt(x - tz * o, z + tx * o), w.heightAt(x + tz * o, z - tx * o));
  }
  return h;
}

/** Grade-limited profile through constraints (same scheme as the construction planner). */
export function solveHeights(desired: number[], step: number, lo0: number[], hi0: number[], grade: number): number[] | null {
  const n = desired.length;
  const lo = lo0.slice(), hi = hi0.slice();
  const gs = grade * step;
  for (let i = 1; i < n; i++) { hi[i] = Math.min(hi[i], hi[i - 1] + gs); lo[i] = Math.max(lo[i], lo[i - 1] - gs); }
  for (let i = n - 2; i >= 0; i--) { hi[i] = Math.min(hi[i], hi[i + 1] + gs); lo[i] = Math.max(lo[i], lo[i + 1] - gs); }
  for (let i = 0; i < n; i++) if (lo[i] > hi[i] + 1e-4) return null;
  const f = new Array(n), b = new Array(n);
  f[0] = Math.min(hi[0], Math.max(lo[0], desired[0]));
  for (let i = 1; i < n; i++) f[i] = Math.min(hi[i], Math.max(lo[i], Math.min(f[i - 1] + gs, Math.max(f[i - 1] - gs, desired[i]))));
  b[n - 1] = Math.min(hi[n - 1], Math.max(lo[n - 1], desired[n - 1]));
  for (let i = n - 2; i >= 0; i--) b[i] = Math.min(hi[i], Math.max(lo[i], Math.min(b[i + 1] + gs, Math.max(b[i + 1] - gs, desired[i]))));
  const y = new Array(n);
  for (let i = 0; i < n; i++) y[i] = (f[i] + b[i]) / 2;
  return y;
}

// ============================================================================ corridor search (coarse A*)

export interface CorridorOpts {
  kind: NetKind;
  owner: number;
  /** grid spacing in world units */
  cell?: number;
  /** max node expansions in total */
  maxExpand?: number;
  /** cost multiplier for crossing towns' buildings */
  buildingCost?: number;
  /** straight lead (world units) kept along the end tangents */
  lead?: number;
  /** segments the corridor must keep away from (e.g. the station leads), with clearance r */
  avoid?: { x0: number; z0: number; x1: number; z1: number; r: number }[];
}

const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const MIN_RUN = 2;

function nearestDir(tx: number, tz: number) {
  let bd = 0, bv = -2;
  DIRS.forEach(([dx, dz], i) => { const v = (dx * tx + dz * tz) / Math.hypot(dx, dz); if (v > bv) { bv = v; bd = i; } });
  return bd;
}

/**
 * Incremental heading-aware A* over a coarse terrain grid between two oriented points. A state is
 * (vertex, heading, straight run); turns are 45 degrees and need MIN_RUN straight cells in between,
 * which keeps the corridor drivable with large curve radii. Costs: distance, slope, water (bridges),
 * buildings, existing network; stations and depots are forbidden.
 */
export class CorridorSearch {
  readonly C: number;
  readonly n: number;
  private info: Uint8Array;   // per vertex: 1 known, 2 water, 4 building, 8 network, 16 forbidden
  private hgt: Float32Array;
  private gcost: Float32Array;
  private parent: Int32Array;
  private closed: Uint8Array;
  private heap = new Heap();
  private goal: number;
  private goalDirs: Set<number>;
  private forbid: { x: number; z: number; a: number; w: number; d: number }[] = [];
  private lead: number;
  private startV = -1;
  expanded = 0;
  state: 'running' | 'done' | 'failed' = 'running';
  path: P2[] | null = null;

  constructor(private g: Game, private from: OPoint, private to: OPoint, private opts: CorridorOpts) {
    const size = g.world.size;
    this.C = opts.cell ?? Math.max(4, Math.ceil(size / 96));
    this.n = Math.floor(size / this.C) + 1;
    const N = this.n * this.n;
    this.info = new Uint8Array(N);
    this.hgt = new Float32Array(N);
    this.gcost = new Float32Array(N * 32).fill(Infinity);
    this.parent = new Int32Array(N * 32).fill(-1);
    this.closed = new Uint8Array(N * 32);
    for (const st of g.stations.map.values()) for (const f of g.stations.footprints(st)) this.forbid.push({ x: f.x, z: f.z, a: f.angle, w: f.w / 2 + 1.5, d: f.d / 2 + 1.5 });
    for (const dp of g.depots.map.values()) this.forbid.push({ x: dp.x, z: dp.z, a: dp.angle, w: 2.5, d: 3.5 });
    this.lead = opts.lead ?? 10;
    const s0 = this.vertex(from.x + from.tx * this.lead, from.z + from.tz * this.lead);
    this.startV = s0;
    this.goal = this.vertex(to.x - to.tx * this.lead, to.z - to.tz * this.lead);
    // arrival headings within ~50 degrees of the goal tangent
    this.goalDirs = new Set();
    DIRS.forEach(([dx, dz], i) => { if ((dx * to.tx + dz * to.tz) / Math.hypot(dx, dz) > 0.64) this.goalDirs.add(i); });
    const h0 = nearestDir(from.tx, from.tz);
    const st = (s0 * 8 + h0) * 4 + 1;
    this.gcost[st] = 0;
    this.heap.push(st, this.heur(s0));
  }

  private vertex(x: number, z: number) {
    const i = Math.max(1, Math.min(this.n - 2, Math.round(x / this.C))), j = Math.max(1, Math.min(this.n - 2, Math.round(z / this.C)));
    return j * this.n + i;
  }
  private heur(v: number) {
    const gx = (v % this.n) * this.C, gz = Math.floor(v / this.n) * this.C;
    const tx = (this.goal % this.n) * this.C, tz = Math.floor(this.goal / this.n) * this.C;
    return Math.hypot(gx - tx, gz - tz);
  }

  private probe(v: number) {
    if (this.info[v]) return this.info[v];
    const w = this.g.world;
    const C = this.C;
    const cx = (v % this.n) * C, cz = Math.floor(v / this.n) * C;
    let f = 1, hs = 0, hn = 0, water = 0;
    const r = Math.ceil(C / 2);
    for (let z = cz - r; z <= cz + r; z++) for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || z < 0 || x > w.size || z > w.size) continue;
      const k = w.vi(x, z);
      const h = w.h[k];
      hs += h; hn++;
      if (h < WATER_Y + 0.05) water++;
      if (Math.abs(x - cx) <= 1 && Math.abs(z - cz) <= 1) {
        if (w.lock[k] & 2) f |= 4;
        if (w.lock[k] & 1) f |= 8;
      }
    }
    this.hgt[v] = hn ? hs / hn : 0;
    if (water * 2 > hn) f |= 2;
    if (!w.inside(cx, cz, 5)) f |= 16;
    for (const fb of this.forbid) if (distToRect(cx, cz, fb.x, fb.z, fb.a, fb.w, fb.d) <= 0) { f |= 16; break; }
    for (const a of this.opts.avoid ?? []) {
      const dx = a.x1 - a.x0, dz = a.z1 - a.z0, l2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((cx - a.x0) * dx + (cz - a.z0) * dz) / l2));
      if (Math.hypot(a.x0 + dx * t - cx, a.z0 + dz * t - cz) < a.r) { f |= 16; break; }
    }
    this.info[v] = f;
    return f;
  }

  /** Run up to `budget` expansions; returns the state. */
  step(budget: number): 'running' | 'done' | 'failed' {
    if (this.state !== 'running') return this.state;
    const n = this.n, C = this.C;
    const grade = this.opts.kind === 'rail' ? 0.03 : 0.07;
    const bcost = this.opts.buildingCost ?? 1;
    const maxExpand = this.opts.maxExpand ?? 250000;
    while (budget-- > 0) {
      if (!this.heap.size) { this.state = 'failed'; return this.state; }
      const s = this.heap.pop();
      if (this.closed[s]) continue;
      this.closed[s] = 1;
      const u = s >> 5, h = (s >> 2) & 7, run = s & 3;
      if (u === this.goal && this.goalDirs.has(h)) { this.finish(s); return this.state; }
      if (++this.expanded > maxExpand) { this.state = 'failed'; return this.state; }
      const ux = u % n, uz = Math.floor(u / n);
      this.probe(u);
      const hu = this.hgt[u];
      for (const dt of [0, 1, -1]) {
        if (dt && run < MIN_RUN) continue;
        const di = (h + dt + 8) & 7;
        const vx = ux + DIRS[di][0], vz = uz + DIRS[di][1];
        if (vx < 1 || vz < 1 || vx >= n - 1 || vz >= n - 1) continue;
        const v = vz * n + vx;
        const ns = (v * 8 + di) * 4 + (dt ? 0 : Math.min(3, run + 1));
        if (this.closed[ns]) continue;
        const f = this.probe(v);
        if (f & 16 && v !== this.goal && u !== this.startV) continue;
        const d = (di & 1 ? Math.SQRT2 : 1) * C;
        let c = d;
        const dh = Math.abs(this.hgt[v] - hu);
        c += dh * 2 + Math.max(0, dh - grade * d) * 14;
        if (f & 2) c += d * 4.5;
        if (f & 4) c += 22 * bcost;
        if (f & 8) c += 9;
        if (dt) c += C * 0.8;
        const nc = this.gcost[s] + c;
        if (nc >= this.gcost[ns]) continue;
        this.gcost[ns] = nc;
        this.parent[ns] = s;
        this.heap.push(ns, nc + this.heur(v));
      }
    }
    return this.state;
  }

  run(): P2[] | null { while (this.step(20000) === 'running'); return this.path; }

  private finish(s: number) {
    const verts: P2[] = [];
    let lastH = -1;
    // keep only the turn vertices of the grid path
    const chain: number[] = [];
    for (let q = s; q >= 0; q = this.parent[q]) chain.push(q);
    chain.reverse();
    for (let i = 0; i < chain.length; i++) {
      const v = chain[i] >> 5, h = (chain[i] >> 2) & 7;
      const nh = i + 1 < chain.length ? (chain[i + 1] >> 2) & 7 : -2;
      if (i === 0 || i === chain.length - 1 || nh !== h) verts.push({ x: (v % this.n) * this.C, z: Math.floor(v / this.n) * this.C });
      lastH = h;
    }
    void lastH;
    const L = this.lead;
    this.path = [
      { x: this.from.x, z: this.from.z }, { x: this.from.x + this.from.tx * L, z: this.from.z + this.from.tz * L },
      ...verts.slice(1, -1),
      { x: this.to.x - this.to.tx * L, z: this.to.z - this.to.tz * L }, { x: this.to.x, z: this.to.z },
    ];
    this.state = 'done';
  }
}

/** Resample a polyline at a fixed spacing. */
export function resample(pts: P2[], step: number): P2[] {
  const out: P2[] = [{ ...pts[0] }];
  let carry = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    let s = step - carry;
    while (s <= L) { out.push({ x: a.x + ((b.x - a.x) * s) / L, z: a.z + ((b.z - a.z) * s) / L }); s += step; }
    carry = L - (s - step);
  }
  const last = pts[pts.length - 1], pl = out[out.length - 1];
  if (Math.hypot(last.x - pl.x, last.z - pl.z) > step * 0.3) out.push({ ...last }); else out[out.length - 1] = { ...last };
  return out;
}

/** Ramer-Douglas-Peucker simplification. */
export function rdp(pts: P2[], tol: number): P2[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const ax = pts[a].x, az = pts[a].z, dx = pts[b].x - ax, dz = pts[b].z - az;
    const l = Math.hypot(dx, dz) || 1;
    let bi = -1, bd = tol;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((pts[i].x - ax) * dz - (pts[i].z - az) * dx) / l;
      if (d > bd) { bd = d; bi = i; }
    }
    if (bi >= 0) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Tangent lengths and radii of the corners of a polyline (first/last vertex are not corners). */
function cornerFit(V: P2[], rmax: number) {
  const n = V.length;
  const dir: P2[] = [], len: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const l = Math.hypot(V[i + 1].x - V[i].x, V[i + 1].z - V[i].z) || 1e-6;
    dir.push({ x: (V[i + 1].x - V[i].x) / l, z: (V[i + 1].z - V[i].z) / l });
    len.push(l);
  }
  const T = new Array(n).fill(0), ang = new Array(n).fill(0), sgn = new Array(n).fill(0), R = new Array(n).fill(Infinity);
  for (let i = 1; i < n - 1; i++) {
    const a = dir[i - 1], b = dir[i];
    const cr = a.x * b.z - a.z * b.x, dt = a.x * b.x + a.z * b.z;
    ang[i] = Math.atan2(Math.abs(cr), dt);
    sgn[i] = cr >= 0 ? 1 : -1;
  }
  // share each leg between its two corners in proportion to what they need
  const need = (i: number) => (i >= 1 && i <= n - 2 ? rmax * Math.tan(ang[i] / 2) : 0);
  for (let i = 1; i < n - 1; i++) {
    const tn = Math.tan(ang[i] / 2);
    if (tn < 1e-6) continue;
    const share = (leg: number, other: number) => { const a = need(i), b = need(other); return a + b <= len[leg] ? a : (len[leg] * a) / (a + b); };
    T[i] = Math.min(need(i), share(i - 1, i - 1), share(i, i + 1));
    R[i] = T[i] / tn;
  }
  return { dir, len, T, ang, sgn, R };
}

function minCornerR(V: P2[], rmax: number) { const f = cornerFit(V, rmax); let m = Infinity; for (let i = 1; i < V.length - 1; i++) m = Math.min(m, f.R[i]); return m; }

/** Intersection of ray p + u*d (u > 0) with line q + w*e; returns null if parallel or behind. */
function rayLine(p: P2, d: P2, q: P2, e: P2): { u: number; w: number } | null {
  const den = d.x * e.z - d.z * e.x;
  if (Math.abs(den) < 1e-6) return null;
  const qx = q.x - p.x, qz = q.z - p.z;
  const u = (qx * e.z - qz * e.x) / den, w = (qx * d.z - qz * d.x) / den;
  return { u, w };
}

/**
 * Railway-style alignment of a corridor: straight legs joined by circular arcs (as large as the legs
 * allow, up to rmax); tight neighbouring corners are merged. Returns oriented waypoints: consecutive
 * points lie on one straight or one arc.
 */
export function alignCorridor(path: P2[], from: OPoint, to: OPoint, rmax = 150, rgood = 45): { way: OPoint[]; minR: number } {
  let V: P2[] = rdp(path, 1.2).map((p) => ({ ...p }));
  if (V.length < 4) {
    const L = Math.hypot(to.x - from.x, to.z - from.z) * 0.3;
    V = [{ x: from.x, z: from.z }, { x: from.x + from.tx * L, z: from.z + from.tz * L }, { x: to.x - to.tx * L, z: to.z - to.tz * L }, { x: to.x, z: to.z }];
  }
  // the first and last legs must follow the end tangents
  const l0 = Math.max(2, Math.hypot(V[1].x - from.x, V[1].z - from.z));
  V[1] = { x: from.x + from.tx * l0, z: from.z + from.tz * l0 };
  const ll = Math.max(2, Math.hypot(V[V.length - 2].x - to.x, V[V.length - 2].z - to.z));
  V[V.length - 2] = { x: to.x - to.tx * ll, z: to.z - to.tz * ll };
  // merge tight corners
  for (let guard = 0; guard < 200 && V.length > 3; guard++) {
    const f = cornerFit(V, rmax);
    let wi = -1, wr = rgood;
    for (let i = 1; i < V.length - 1; i++) if (f.R[i] < wr) { wr = f.R[i]; wi = i; }
    if (wi < 0) break;
    let bestV: P2[] | null = null, bestR = wr;
    for (const j of [wi - 1, wi]) {
      if (j < 1 || j + 1 > V.length - 2) continue;
      // replace corners j, j+1 by the intersection of the outer legs
      const p = V[j - 1], d = f.dir[j - 1], q = V[j + 2], e = { x: -f.dir[j + 1].x, z: -f.dir[j + 1].z };
      const r = rayLine(p, d, q, e);
      if (!r || r.u <= 0.5 || r.w <= 0.5) continue;
      const P = { x: p.x + d.x * r.u, z: p.z + d.z * r.u };
      const W = [...V.slice(0, j), P, ...V.slice(j + 2)];
      const m = minCornerR(W, rmax);
      if (m > bestR) { bestR = m; bestV = W; }
    }
    if (!bestV) break;
    V = bestV;
  }
  const f = cornerFit(V, rmax);
  const out: OPoint[] = [from];
  let minR = Infinity;
  const pushPt = (x: number, z: number, tx: number, tz: number) => {
    const p = out[out.length - 1];
    if (Math.hypot(x - p.x, z - p.z) < 0.8) return;
    out.push({ x, z, tx, tz });
  };
  const straightTo = (x: number, z: number, tx: number, tz: number) => {
    const p = out[out.length - 1];
    const k = Math.floor(Math.hypot(x - p.x, z - p.z) / 24) + 1;
    for (let i = 1; i < k; i++) pushPt(p.x + ((x - p.x) * i) / k, p.z + ((z - p.z) * i) / k, tx, tz);
    pushPt(x, z, tx, tz);
  };
  for (let i = 1; i < V.length - 1; i++) {
    const a = f.dir[i - 1];
    if (f.T[i] <= 1e-6) continue;
    const R = f.R[i];
    minR = Math.min(minR, R);
    const sx = V[i].x - a.x * f.T[i], sz = V[i].z - a.z * f.T[i];
    straightTo(sx, sz, a.x, a.z);
    const nx = -a.z * f.sgn[i], nz = a.x * f.sgn[i];
    const cx = sx + nx * R, cz = sz + nz * R;
    const steps = Math.max(1, Math.ceil(f.ang[i] / 0.87));
    for (let k = 1; k <= steps; k++) {
      const th = ((f.ang[i] * k) / steps) * f.sgn[i];
      const c = Math.cos(th), s = Math.sin(th);
      const rx = sx - cx, rz = sz - cz;
      pushPt(cx + rx * c - rz * s, cz + rx * s + rz * c, a.x * c - a.z * s, a.x * s + a.z * c);
    }
  }
  straightTo(to.x, to.z, to.tx, to.tz);
  if (out[out.length - 1].x !== to.x || out[out.length - 1].z !== to.z) { out.pop(); out.push(to); }
  return { way: out, minR };
}

// ============================================================================ chained construction

export interface ChainResult { ok: boolean; error?: string; cost: number; endNode: number; edges: number; bridges: number; tunnels: number; built: number }

export interface ChainProfile {
  s: number[]; x: number[]; z: number[]; y: number[]; terr: number[];
  crossings: { x: number; z: number; mode: 'level' | 'over' | 'under'; edge: number }[];
}

/**
 * Sample a chain of oriented waypoints and compute a global grade-limited height profile that also
 * respects crossings with existing edges (level where possible, else over/under with clearance).
 */
export function chainProfile(g: Game, way: OPoint[], tracks: number, y0: number, y1: number, kind: NetKind, exclude: Set<number> = new Set()): ChainProfile | null {
  const xs: number[] = [], zs: number[] = [], ss: number[] = [], tr: number[] = [];
  let acc = 0;
  for (let i = 1; i < way.length; i++) {
    const a = way[i - 1], b = way[i];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const k = Math.max(1, Math.ceil(L));
    for (let j = i === 1 ? 0 : 1; j <= k; j++) {
      const f = j / k;
      // cubic Hermite between oriented points (approximates the biarc)
      const h00 = 2 * f ** 3 - 3 * f * f + 1, h10 = f ** 3 - 2 * f * f + f, h01 = -2 * f ** 3 + 3 * f * f, h11 = f ** 3 - f * f;
      const x = h00 * a.x + h10 * a.tx * L + h01 * b.x + h11 * b.tx * L;
      const z = h00 * a.z + h10 * a.tz * L + h01 * b.z + h11 * b.tz * L;
      if (xs.length) acc += Math.hypot(x - xs[xs.length - 1], z - zs[zs.length - 1]);
      xs.push(x); zs.push(z); ss.push(acc);
      tr.push(terrRef(g, x, z, a.tx, a.tz, tracks));
    }
  }
  const n = xs.length;
  const win = 10;
  const desired: number[] = [], lo: number[] = [], hi: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(n - 1, i + win); j++) { sum += Math.max(tr[j], WATER_Y + 0.15); cnt++; }
    desired.push(sum / cnt);
    lo.push(tr[i] < WATER_Y + 0.05 ? WATER_Y + 0.95 : -1e9);
    hi.push(1e9);
  }
  lo[0] = hi[0] = y0; lo[n - 1] = hi[n - 1] = y1;
  const step = n > 1 ? acc / (n - 1) : 1;
  const grade = (kind === 'rail' ? TRACK_TYPES.standard.maxGrade : ROAD_TYPES.road.maxGrade) * 0.85;
  let y = solveHeights(desired, step, lo, hi, grade);
  if (!y) return null;
  // crossings with existing edges
  const net = g.world.net;
  let bx0 = Infinity, bz0 = Infinity, bx1 = -Infinity, bz1 = -Infinity;
  for (let i = 0; i < n; i++) { bx0 = Math.min(bx0, xs[i]); bx1 = Math.max(bx1, xs[i]); bz0 = Math.min(bz0, zs[i]); bz1 = Math.max(bz1, zs[i]); }
  const cr: { i: number; x: number; z: number; yo: number; levelOk: boolean; tunnel: boolean; edge: number }[] = [];
  for (const e of net.edgesNear(bx0 - 1, bz0 - 1, bx1 + 1, bz1 + 1)) {
    if (exclude.has(e.id)) continue;
    const box = net.grid.box(e.id);
    if (!box) continue;
    const ge = net.geo(e);
    for (let i = 0; i < n - 1; i++) {
      const ax = xs[i], az = zs[i], bx = xs[i + 1], bz = zs[i + 1];
      if (Math.max(ax, bx) < box[0] || Math.min(ax, bx) > box[2] || Math.max(az, bz) < box[1] || Math.min(az, bz) > box[3]) continue;
      for (let j = 0; j < ge.n - 1; j++) {
        const r = segIntersect(ax, az, bx, bz, ge.pts[j * 3], ge.pts[j * 3 + 2], ge.pts[j * 3 + 3], ge.pts[j * 3 + 5]);
        if (!r) continue;
        const sOld = ge.cum[j] + (ge.cum[j + 1] - ge.cum[j]) * r[1];
        const ang = angleBetween(bx - ax, bz - az, ge.pts[j * 3 + 3] - ge.pts[j * 3], ge.pts[j * 3 + 5] - ge.pts[j * 3 + 2]);
        const sec = net.sectionAt(e, sOld);
        cr.push({
          i: r[0] < 0.5 ? i : i + 1, x: ax + (bx - ax) * r[0], z: az + (bz - az) * r[0], yo: net.heightAtS(e, sOld),
          levelOk: Math.min(ang, Math.PI - ang) > 0.45 && sec === 'ground' && e.depot < 0 && e.station < 0 && !(kind === 'rail' && e.kind === 'rail') && !(kind === 'road' && e.kind === 'road'),
          tunnel: sec === 'tunnel', edge: e.id,
        });
      }
    }
  }
  const crossings: ChainProfile['crossings'] = [];
  if (cr.length) {
    const clr = RAIL.clearance + 0.15;
    for (const c of cr) {
      const yn = y[c.i];
      const mode: 'level' | 'over' | 'under' = !c.tunnel && Math.abs(yn - c.yo) < 0.35 && c.levelOk ? 'level' : yn >= c.yo ? 'over' : 'under';
      crossings.push({ x: c.x, z: c.z, mode, edge: c.edge });
      // a window around the crossing, so segment ends close to it already have the clearance
      for (let k = Math.max(0, c.i - 3); k <= Math.min(n - 1, c.i + 3); k++) {
        if (mode === 'over') lo[k] = Math.max(lo[k], c.yo + clr);
        else if (mode === 'under') hi[k] = Math.min(hi[k], c.yo - clr);
        else if (k === c.i) { lo[k] = Math.max(lo[k], c.yo - 0.05); hi[k] = Math.min(hi[k], c.yo + 0.05); }
      }
    }
    y = solveHeights(desired, step, lo, hi, grade);
    if (!y) return null;
  }
  return { s: ss, x: xs, z: zs, y, terr: tr, crossings };
}

/**
 * Would the profiled route run alongside (too close to) existing edges anywhere except at its crossings?
 * Mirrors the planner's parallel-conflict rule so failures are found before anything is built.
 */
export function routeConflict(g: Game, prof: ChainProfile, kind: NetKind, tracks: number, exclude: Set<number> = new Set()): boolean {
  const net = g.world.net;
  const hw = (kind === 'rail' ? 0.32 : ROAD_TYPES.road.half) + (tracks - 1) * RAIL.spacing * 0.5;
  const n = prof.x.length;
  // the route must not come back close to itself
  for (let i = 0; i < n; i += 3) for (let j = i + 12; j < n; j += 3) {
    if (prof.s[j] - prof.s[i] < 12) continue;
    if (Math.hypot(prof.x[i] - prof.x[j], prof.z[i] - prof.z[j]) < hw * 2 + 1.5) return true;
  }
  for (let i = 0; i < n; i += 2) {
    const x = prof.x[i], z = prof.z[i];
    // the ends attach to stations/streets
    if (prof.s[i] < 2 || prof.s[n - 1] - prof.s[i] < 2) continue;
    for (const e of net.edgesNear(x - hw - 1.2, z - hw - 1.2, x + hw + 1.2, z + hw + 1.2)) {
      const box = net.grid.box(e.id);
      if (box && (x < box[0] - hw || x > box[2] + hw || z < box[1] - hw || z > box[3] + hw)) continue;
      if (exclude.has(e.id)) continue;
      if (prof.crossings.some((c) => c.edge === e.id && Math.hypot(c.x - x, c.z - z) < 3)) continue;
      const need = e.kind === 'rail' && kind === 'rail' ? RAIL.spacing - 0.02 : hw + net.halfWidth(e);
      const ge = net.geo(e);
      let best = Infinity, bi = 0;
      for (let j = 0; j < ge.n; j++) { const d = (ge.pts[j * 3] - x) ** 2 + (ge.pts[j * 3 + 2] - z) ** 2; if (d < best) { best = d; bi = j; } }
      if (Math.sqrt(best) < need && Math.abs(ge.pts[bi * 3 + 1] - prof.y[i]) < RAIL.clearance) return true;
    }
  }
  return false;
}

/** Rough construction cost of a profiled chain (track, structures, earthworks). */
export function estimateChainCost(prof: { y: number[]; terr: number[]; s: number[] }, tracks: number, kind: NetKind, type: string): { cost: number; bridge: number; tunnel: number } {
  const per = kind === 'rail' ? (TRACK_TYPES[type] ?? TRACK_TYPES.standard).costPerUnit : (ROAD_TYPES[type] ?? ROAD_TYPES.road).costPerUnit;
  let cost = 0, bridge = 0, tunnel = 0;
  const hw = kind === 'rail' ? 0.32 + (tracks - 1) * RAIL.spacing * 0.5 : 0.34;
  for (let i = 1; i < prof.y.length; i++) {
    const ds = prof.s[i] - prof.s[i - 1];
    const d = prof.y[i] - prof.terr[i];
    if (prof.terr[i] < WATER_Y + 0.05 || d > 1.1) { cost += per * 6 * ds * tracks; bridge += ds; }
    else if (d < -1.9) { cost += per * 9 * ds * tracks; tunnel += ds; }
    else cost += per * ds * tracks + Math.abs(d) * ds * (hw * 2 + 1.5 + Math.abs(d) * 2) * 900;
  }
  return { cost, bridge, tunnel };
}

function profileAt(prof: ChainProfile, x: number, z: number): number {
  let best = 0, bd = Infinity;
  for (let i = 0; i < prof.x.length; i++) { const d = (prof.x[i] - x) ** 2 + (prof.z[i] - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return prof.y[best];
}

/** Snap at an existing node (with its parallel group for rail). */
export function nodeSnap(g: Game, nodeId: number, kind: NetKind): Snap {
  const n = g.world.net.nodes.get(nodeId)!;
  const s = findSnap(g, kind, n.x, n.z, 0.05);
  if (s.kind === 'node' && s.node === nodeId) return s;
  return { kind: 'node', x: n.x, z: n.z, y: n.y, node: nodeId, group: [nodeId] };
}

/** Outgoing tangent for a new edge leaving an existing node towards a target. */
export function nodeTangent(g: Game, nodeId: number, toward?: P2): { tx: number; tz: number } {
  const net = g.world.net;
  const n = net.nodes.get(nodeId)!;
  if (n.kind === 'rail') {
    let side = freeSide(g, n);
    if ((side === 0 || !n.edges.length) && toward) side = (toward.x - n.x) * n.dx + (toward.z - n.z) * n.dz >= 0 ? 1 : -1;
    if (side === 0) side = 1;
    return { tx: n.dx * side, tz: n.dz * side };
  }
  if (n.edges.length === 1) { const d = net.leaveDir(net.edges.get(n.edges[0])!, n.id); return { tx: -d.x, tz: -d.z }; }
  const dx = (toward?.x ?? n.x + 1) - n.x, dz = (toward?.z ?? n.z) - n.z, l = Math.hypot(dx, dz) || 1;
  return { tx: dx / l, tz: dz / l };
}

/** Find the node created at (x,z) by the last commit (end of a chain segment). */
function nodeAt(g: Game, kind: NetKind, x: number, z: number): NNode | null {
  return g.world.net.nearestNode(x, z, 0.08, kind, (n) => n.edges.length > 0);
}

/** One planEdge/commit step with fallbacks for crossings and heights. */
function buildSegment(g: Game, start: Snap, end: Snap, opts: BuildOptions, endY: number | null, res: ChainResult, log?: (s: string) => void): Proposal | null {
  const tries: Partial<BuildOptions>[] = [{}, { crossing: 'level' }, { crossing: 'over' }, { crossing: 'under' }];
  let last: Proposal | null = null;
  const cl = Math.hypot(end.x - start.x, end.z - start.z) || 1;
  for (const useH of endY !== null ? [true, false] : [false]) {
    for (const t of tries) {
      const o: BuildOptions = { ...opts, ...t };
      if (useH && endY !== null && end.kind === 'free') {
        const tr = terrRef(g, end.x, end.z, (end.x - start.x) / cl, (end.z - start.z) / cl, start.group && start.group.length > 1 ? start.group.length : opts.tracks);
        o.heightOffset = endY - tr;
        if (Math.abs(o.heightOffset) < 1e-3) o.heightOffset = 1e-3;
      } else o.heightOffset = 0;
      const p = planEdge(g, start, end, o);
      last = p;
      if (!p.ok) continue;
      if (p.warnings.includes('Not enough money')) { res.error = 'Not enough money'; return null; }
      const err = commitProposal(g, p);
      if (err) { res.error = err; return null; }
      res.cost += p.cost;
      res.edges += p.tracks.length;
      res.bridges += p.stats.bridges;
      res.tunnels += p.stats.tunnels;
      res.built += p.stats.len;
      return p;
    }
  }
  res.error = last ? last.errors.join(', ') : 'Cannot build';
  if (last && log) {
    const net = g.world.net;
    const sn = start.kind === 'node' ? net.nodes.get(start.node!) : undefined;
    log(`segment failed: ${res.error} (start y ${sn?.y.toFixed(2)}, end y ${endY?.toFixed(2)}, crossings ${last.crossings.map((c) => { const e = net.edges.get(c.edge)!; return `${c.mode}@${c.sNew.toFixed(1)}/${last!.tracks[c.track].len.toFixed(1)} ${e.kind}${e.owner} #${e.id} y${net.heightAtS(e, c.sOld).toFixed(2)} ${net.sectionAt(e, c.sOld)}`; }).join(', ')})`);
  }
  return null;
}

/** Position of the parallel group (of `tracks` members) around a node: its centre. */
function groupCentre(g: Game, nodeId: number, kind: NetKind, tracks: number): P2 {
  const n = g.world.net.nodes.get(nodeId)!;
  if (kind !== 'rail' || tracks < 2) return { x: n.x, z: n.z };
  const grp = nodeSnap(g, nodeId, kind).group ?? [nodeId];
  if (grp.length < 2) return { x: n.x, z: n.z };
  const N = Math.min(tracks, grp.length);
  const idx = Math.max(0, grp.indexOf(nodeId));
  const lo = Math.max(0, Math.min(grp.length - N, idx - Math.floor((N - 1) / 2)));
  let x = 0, z = 0;
  for (const id of grp.slice(lo, lo + N)) { const m = g.world.net.nodes.get(id)!; x += m.x; z += m.z; }
  return { x: x / N, z: z / N };
}

/**
 * Build a chain of curved segments from an existing node through oriented waypoints. The last waypoint
 * may be an existing node (`goalNode`), otherwise the chain ends at a new free end. Uses biarcs so that
 * every planEdge segment is a circular arc with tangent continuity. Failing segments are split once.
 */
export function buildChain(g: Game, startNode: number, way: OPoint[], opts: BuildOptions, goalNode: number | null, prof: ChainProfile | null, log?: (s: string) => void): ChainResult {
  return runGen(chainGen(g, startNode, way, opts, goalNode, prof, log));
}

/** Incremental chain construction (yields after every segment). */
export function* chainGen(g: Game, startNode: number, way: OPoint[], opts: BuildOptions, goalNode: number | null, prof: ChainProfile | null, log?: (s: string) => void): Generator<void, ChainResult> {
  const net = g.world.net;
  const res: ChainResult = { ok: false, cost: 0, endNode: startNode, edges: 0, bridges: 0, tunnels: 0, built: 0 };
  let cur = startNode;
  /** Build one arc from the current node to q (free point or the goal node); updates `cur`. */
  const step = (q: P2, goal: boolean, allowSplit: boolean): boolean => {
    const st = nodeSnap(g, cur, opts.kind);
    const en: Snap = goal ? nodeSnap(g, goalNode!, opts.kind) : { kind: 'free', x: q.x, z: q.z, y: g.world.heightAt(q.x, q.z) };
    const endY = goal || !prof ? null : profileAt(prof, q.x, q.z);
    const before = res.error;
    const p = buildSegment(g, st, en, opts, endY, res, allowSplit ? undefined : log);
    if (p) {
      if (goal) { cur = goalNode!; return true; }
      // the new end node (one member of the group for multi-track)
      const tp = p.tracks[Math.floor((p.tracks.length - 1) / 2)];
      const nn = nodeAt(g, opts.kind, tp.bez.x3, tp.bez.z3);
      if (!nn) { res.error = 'End node missing'; return false; }
      cur = nn.id;
      return true;
    }
    if (!allowSplit || goal || res.error === 'Not enough money') return false;
    // split the arc at its middle and try both halves
    const c = groupCentre(g, cur, opts.kind, opts.tracks);
    const t = nodeTangent(g, cur, q);
    const L = Math.hypot(q.x - c.x, q.z - c.z);
    if (L < 4) return false;
    const ux = (q.x - c.x) / L, uz = (q.z - c.z) / L;
    const dp = t.tx * ux + t.tz * uz;
    const tq = { tx: 2 * dp * ux - t.tx, tz: 2 * dp * uz - t.tz };
    const m = biarcJunction({ x: c.x, z: c.z, ...t }, { x: q.x, z: q.z, ...tq });
    res.error = before;
    if (!m) return false;
    return step(m, false, false) && step(q, false, false);
  };
  for (let i = 0; i < way.length; i++) {
    const n = net.nodes.get(cur);
    if (!n) { res.error = 'Lost the chain'; return res; }
    const wp = way[i];
    const isGoal = i === way.length - 1 && goalNode !== null;
    const c = groupCentre(g, cur, opts.kind, opts.tracks);
    const t0 = nodeTangent(g, cur, wp);
    const a: OPoint = { x: c.x, z: c.z, tx: t0.tx, tz: t0.tz };
    const L = Math.hypot(wp.x - a.x, wp.z - a.z);
    if (L < 1.2 && !isGoal) continue;
    const ux = (wp.x - a.x) / L, uz = (wp.z - a.z) / L;
    const straight = a.tx * ux + a.tz * uz > 0.9995 && wp.tx * ux + wp.tz * uz > 0.9995;
    const pts: { p: P2; goal: boolean }[] = [];
    if (!straight) {
      const j = biarcJunction(a, wp);
      if (j && Math.hypot(j.x - a.x, j.z - a.z) > 1.2 && Math.hypot(wp.x - j.x, wp.z - j.z) > 1.2) pts.push({ p: j, goal: false });
    }
    pts.push({ p: wp, goal: isGoal });
    for (const q of pts) {
      if (!step(q.p, q.goal, true)) return res;
      yield;
    }
  }
  res.ok = true;
  res.endNode = cur;
  return res;
}

// ============================================================================ stations

/** Is the corridor along a direction free of other network edges, stations and water? */
export function corridorFree(g: Game, x: number, z: number, tx: number, tz: number, from: number, to: number, halfW: number): boolean {
  const w = g.world, net = w.net;
  for (let s = from; s <= to; s += 1) {
    for (const o of [-halfW, 0, halfW]) {
      const px = x + tx * s - tz * o, pz = z + tz * s + tx * o;
      if (!w.inside(px, pz, 4) || w.heightAt(px, pz) < WATER_Y + 0.2) return false;
      if (net.nearestEdge(px, pz, 0.75)) return false;
      if (g.stations.footprintsNear(px, pz, 0.6).length || g.depots.near(px, pz, 0.8).length) return false;
    }
  }
  return true;
}

export interface SiteOpts {
  tracks: number; length: number; owner: number; front?: number; back?: number; maxR?: number;
  /** preferred platform height (e.g. the other station's) and tolerated deviation */
  prefY?: number; tolY?: number;
}

/** Run a generator to completion (synchronous use of the incremental helpers). */
export function runGen<T>(gen: Generator<unknown, T>): T { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; }

/** Search a rail station site near a town whose axis points towards `toward` (front end free for a throat). */
export function findStationSite(g: Game, town: Town, toward: P2, o: SiteOpts): StationPlan | null {
  return runGen(stationSiteGen(g, town, toward, o));
}

/** Incremental station site search (yields every few dozen candidates). */
export function* stationSiteGen(g: Game, town: Town, toward: P2, o: SiteOpts): Generator<void, StationPlan | null> {
  const dirA = Math.atan2(toward.x - town.x, toward.z - town.z);
  const front = o.front ?? 16, back = o.back ?? 9;
  let best: StationPlan | null = null, bestScore = Infinity;
  const maxR = o.maxR ?? town.radius + 14;
  let n = 0;
  for (let r = 4; r <= maxR; r += 3) {
    for (const da of [0, 0.25, -0.25, 0.5, -0.5, 0.8, -0.8, 1.2, -1.2]) {
      const pa = dirA + da;
      const x = town.x + Math.sin(pa) * r, z = town.z + Math.cos(pa) * r;
      if (!g.world.inside(x, z, 8)) continue;
      for (const aa of [0, 0.15, -0.15, 0.35, -0.35]) {
        if (++n % 30 === 0) yield;
        const ang = dirA + aa;
        const plan = g.stations.planRail(x, z, ang, o.length, o.tracks, o.owner);
        if (!plan.ok || plan.join) continue;
        const fx = Math.sin(ang), fz = Math.cos(ang);
        const hw = plan.layout.width / 2;
        if (!corridorFree(g, x, z, fx, fz, o.length / 2 + 0.5, o.length / 2 + front, hw)) continue;
        const backFree = corridorFree(g, x, z, -fx, -fz, o.length / 2 + 0.5, o.length / 2 + back, 0.6);
        let pop = 0;
        for (const b of g.world.buildingsNear(x, z, 30)) if (Math.hypot(b.x - x, b.z - z) < 30) pop += b.pop;
        let score = plan.cost / 20000 + plan.demolish.length * 6 - pop / 25 + Math.abs(aa) * 20 + (backFree ? 0 : 40) + r * 0.3;
        if (o.prefY !== undefined) score += Math.max(0, Math.abs(plan.y - o.prefY) - (o.tolY ?? 1)) * 60;
        if (score < bestScore) { bestScore = score; best = plan; }
      }
    }
  }
  return best;
}

/** Population within a station's catchment if it were built at (x,z) with platform length L. */
export function sitePop(g: Game, x: number, z: number, L: number): number {
  const R = STATION_RADIUS + L / 2;
  let pop = 0;
  for (const b of g.world.buildingsNear(x, z, R)) if (Math.hypot(b.x - x, b.z - z) <= R) pop += b.pop;
  return pop;
}

/**
 * Station sites for a rail link between two towns: good catchment at both ends and platform heights that
 * a line of roughly `detour` x the distance can climb. Returns null if no such pair exists.
 */
export function findRailPair(g: Game, A: Town, B: Town, o: SiteOpts, detour = 1.15): { a: StationPlan; b: StationPlan } | null {
  return runGen(railPairGen(g, A, B, o, detour));
}

export function* railPairGen(g: Game, A: Town, B: Town, o: SiteOpts, detour = 1.15): Generator<void, { a: StationPlan; b: StationPlan } | null> {
  const grade = TRACK_TYPES.standard.maxGrade * 0.8;
  const pa = yield* stationSiteGen(g, A, B, o);
  if (!pa) return null;
  const feasible = (p: StationPlan, q: StationPlan) => Math.abs(p.y - q.y) <= grade * Math.hypot(p.x - q.x, p.z - q.z) * detour;
  const pb = yield* stationSiteGen(g, B, A, o);
  if (pb && feasible(pa, pb)) return { a: pa, b: pb };
  // try height-matched sites on either side, but keep a useful catchment
  const minPop = (t: Town) => Math.min(t.pop * 0.3, 400);
  const d = Math.hypot(A.x - B.x, A.z - B.z);
  const pb2 = yield* stationSiteGen(g, B, A, { ...o, prefY: pa.y, tolY: grade * d * 0.9 });
  if (pb2 && feasible(pa, pb2) && sitePop(g, pb2.x, pb2.z, o.length) >= minPop(B)) return { a: pa, b: pb2 };
  if (pb) {
    const pa2 = yield* stationSiteGen(g, A, B, { ...o, prefY: pb.y, tolY: grade * d * 0.9 });
    if (pa2 && feasible(pa2, pb) && sitePop(g, pa2.x, pa2.z, o.length) >= minPop(A)) return { a: pa2, b: pb };
  }
  return null;
}

/** Track end nodes of a station: per track (in trackOffsets order) the node at the front (+axis) and back end. */
export function stationEnds(g: Game, st: Station): { front: number; back: number }[] {
  const net = g.world.net;
  const out: { front: number; back: number }[] = [];
  if (!st.rail) return out;
  const fx = Math.sin(st.rail.angle), fz = Math.cos(st.rail.angle);
  for (const eid of st.rail.edges) {
    const e = net.edges.get(eid);
    if (!e) continue;
    const a = net.nodes.get(e.a)!, b = net.nodes.get(e.b)!;
    const ab = (b.x - a.x) * fx + (b.z - a.z) * fz;
    out.push(ab >= 0 ? { front: b.id, back: a.id } : { front: a.id, back: b.id });
  }
  // sort by lateral offset (left to right of the axis)
  const lat = (id: number) => { const n = net.nodes.get(id)!; return (n.x - st.rail!.x) * fz - (n.z - st.rail!.z) * fx; };
  out.sort((p, q) => lat(p.front) - lat(q.front));
  return out;
}

/** Commit a depot at the free rail end `nodeId` (the depot snaps to it). Returns the depot id or -1. */
function depotAtEnd(g: Game, nodeId: number, owner: number): number {
  const net = g.world.net;
  const n = net.nodes.get(nodeId);
  if (!n || n.edges.length !== 1) return -1;
  const ld = net.leaveDir(net.edges.get(n.edges[0])!, n.id);
  const plan = g.depots.plan('rail', n.x - ld.x * 2.15, n.z - ld.z * 2.15, Math.atan2(ld.x, ld.z), owner);
  if (!plan.ok || plan.snapNode !== nodeId) return -1;
  const id = g.depots.nextId;
  return g.depots.commit('rail', plan, owner) ? -1 : id;
}

/** Would a rail depot fit with its door at (x,z) facing (fx,fz), demolishing only houses up to `maxPop`? */
function depotFits(g: Game, x: number, z: number, fx: number, fz: number, owner: number, maxPop = 0): boolean {
  const cx = x - fx * 2.15, cz = z - fz * 2.15;
  if (g.world.net.nearestNode(cx, cz, 4.7, 'rail', (nn) => nn.edges.length === 1)) return false;
  const p = g.depots.plan('rail', cx, cz, Math.atan2(fx, fz), owner);
  const dem = p.demolish ?? [];
  return p.ok && dem.length <= (maxPop ? 2 : 0) && dem.every((id) => (g.world.buildings.get(id)?.pop ?? 0) <= maxPop);
}

/**
 * Build a rail depot for a station: on a short stub behind one of its free back ends, or on a branch off
 * the line leaving its front. Returns the depot id or -1.
 */
export function buildRailDepot(g: Game, st: Station, owner: number, frontDir?: P2): number {
  const net = g.world.net;
  if (!st.rail) return -1;
  const r = st.rail;
  const ends = stationEnds(g, st);
  const ax = Math.sin(r.angle), az = Math.cos(r.angle);
  // ends with exactly one edge (free) on either side of the station
  const cands: { node: number; bx: number; bz: number }[] = [];
  for (const e of ends) for (const [nid, sgn] of [[e.back, -1], [e.front, 1]] as [number, number][]) {
    const n = net.nodes.get(nid);
    if (!n || n.edges.length !== 1) continue;
    if (frontDir && sgn * (ax * frontDir.x + az * frontDir.z) > 0) continue; // keep the line's side free
    cands.push({ node: nid, bx: ax * sgn, bz: az * sgn });
  }
  const o = (extra: Partial<BuildOptions> = {}): BuildOptions => ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra });
  for (const maxPop of [0, 30]) for (const c of cands) {
    const n = net.nodes.get(c.node)!;
    if (n.edges.length !== 1) continue;
    for (const L of [5, 8, 11, 15, 20, 26]) {
      const sx = n.x + c.bx * L, sz = n.z + c.bz * L;
      if (!g.world.inside(sx, sz, 6) || !depotFits(g, sx, sz, -c.bx, -c.bz, owner, maxPop)) continue;
      const p = planEdge(g, nodeSnap(g, c.node, 'rail'), { kind: 'free', x: sx, z: sz, y: 0 }, o({ heightOffset: r.y - g.world.heightAt(sx, sz) || 1e-3 }));
      if (!p.ok || p.demolish.length > 3 || !g.company(owner).economy.canAfford(p.cost + 120000)) continue;
      if (commitProposal(g, p)) continue;
      const end = nodeAt(g, 'rail', sx, sz);
      const id = end ? depotAtEnd(g, end.id, owner) : -1;
      if (id >= 0) return id;
      if (end) removeEdges(g, [...end.edges], owner);
    }
  }
  return -1;
}

/** Depot on a short siding branching off a rail edge near (x,z) (e.g. a main line outside town). */
export function buildDepotOnLine(g: Game, edgeId: number, s: number, owner: number): number {
  const net = g.world.net;
  const e = net.edges.get(edgeId);
  if (!e || e.station >= 0 || e.depot >= 0) return -1;
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  for (const side of [1, -1]) for (const dirSign of [1, -1]) {
    net.pointAt(e, s, p, d);
    const l = Math.hypot(d.x, d.z) || 1;
    const tx = (d.x / l) * dirSign, tz = (d.z / l) * dirSign;
    // diverge over 12 units to 2.2 units off the line, then a 6-unit straight siding
    const ex = p.x + tx * 12 - tz * 2.2 * side, ez = p.z + tz * 12 + tx * 2.2 * side;
    const fx = p.x + tx * 18 - tz * 2.2 * side, fz = p.z + tz * 18 + tx * 2.2 * side;
    if (!depotFits(g, fx, fz, -tx, -tz, owner, 30)) continue;
    const start = findSnap(g, 'rail', p.x, p.z, 0.3);
    if (start.kind !== 'edge' || start.edge !== edgeId) continue;
    const o: BuildOptions = { kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner };
    const j = biarcJunction({ x: p.x, z: p.z, tx, tz }, { x: ex, z: ez, tx, tz });
    if (!j) continue;
    const p1 = planEdge(g, start, { kind: 'free', x: j.x, z: j.z, y: 0 }, o);
    if (!p1.ok || commitProposal(g, p1)) continue;
    const n1 = nodeAt(g, 'rail', j.x, j.z);
    if (!n1) continue;
    const p2 = planEdge(g, nodeSnap(g, n1.id, 'rail'), { kind: 'free', x: fx, z: fz, y: 0 }, o);
    if (p2.ok && !commitProposal(g, p2)) {
      const n2 = nodeAt(g, 'rail', fx, fz);
      const id = n2 ? depotAtEnd(g, n2.id, owner) : -1;
      if (id >= 0) return id;
      if (n2) removeEdges(g, [...n2.edges], owner);
    }
    removeEdges(g, [...n1.edges].filter((x) => x !== edgeId), owner);
    return -1;
  }
  return -1;
}

/** Road depot beside a street near (x,z), connected to it. Prefers sites that demolish nothing. */
export function buildRoadDepot(g: Game, x: number, z: number, owner: number, maxR = 26): number {
  const net = g.world.net;
  for (const maxPop of [0, 30]) {
    for (let r = 2.5; r < maxR; r += 1.5) {
      for (let k = 0; k < 12; k++) {
        const a = ((k + (r % 2) * 0.5) / 12) * Math.PI * 2;
        const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
        const ne = net.nearestEdge(px, pz, 3.6, 'road', (e) => e.depot < 0 && e.station < 0);
        if (!ne || ne.d < 2.1 || net.sectionAt(ne.edge, ne.s) !== 'ground') continue;
        const q = { x: 0, y: 0, z: 0 };
        net.pointAt(ne.edge, ne.s, q);
        const plan = g.depots.plan('road', px, pz, Math.atan2(q.x - px, q.z - pz), owner);
        if (!plan.ok || !g.company(owner).economy.canAfford(plan.cost + 40000)) continue;
        const dem = plan.demolish ?? [];
        if (dem.length > (maxPop ? 1 : 0) || dem.some((id) => (g.world.buildings.get(id)?.pop ?? 0) > maxPop)) continue;
        const id = g.depots.nextId;
        if (g.depots.commit('road', plan, owner)) continue;
        const dp = g.depots.get(id);
        const exit = dp ? net.nodes.get(dp.node) : undefined;
        if (dp && exit && exit.edges.length >= 2) return id;
        if (dp) g.depots.remove(id);
      }
    }
  }
  return -1;
}

/** Remove edges owned by `owner` (AI clean-up of failed projects), paying the removal cost. */
export function removeEdges(g: Game, ids: number[], owner: number) {
  const net = g.world.net;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, cost = 0, n = 0;
  for (const id of ids) {
    const e = net.edges.get(id);
    if (!e || e.owner !== owner || e.station >= 0 || e.depot >= 0 || g.vehicles.isEdgeBusy(id)) continue;
    const b = net.grid.box(id);
    if (b) { x0 = Math.min(x0, b[0]); z0 = Math.min(z0, b[1]); x1 = Math.max(x1, b[2]); z1 = Math.max(z1, b[3]); }
    cost += (e.kind === 'rail' ? 400 : 250) * e.len;
    net.removeEdge(id);
    n++;
  }
  if (!n) return;
  recomputeLocks(g.world, x0, z0, x1, z1);
  g.company(owner).economy.spend(cost, 'construction', true);
  g.onNetworkChanged();
}

// ============================================================================ controller

// ============================================================================ controller

/** Rail vehicles for the year: a cost-efficient locomotive (the fastest on long lines) and coaches filling the platform. */
export function pickTrain(year: number, platform: number, lineLen: number): VehicleModel[] | null {
  const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon');
  if (!locos.length || !wagons.length) return null;
  const value = (m: VehicleModel) => (Math.min(m.speed, lineLen > 220 ? 300 : 150) * (0.5 + m.power / 5000)) / (m.cost + m.running * 8);
  const loco = [...locos].sort((a, b) => value(b) - value(a))[0];
  const fit = wagons.filter((w) => w.speed >= Math.min(loco.speed, 150));
  const wag = (fit.length ? fit : wagons).sort((a, b) => b.capacity - a.capacity)[0];
  const n = Math.max(1, Math.min(5, Math.floor((platform - 0.8 - loco.length) / (wag.length + 0.1))));
  return [loco, ...Array<VehicleModel>(n).fill(wag)];
}

export function pickBus(year: number, townPop = 3000): VehicleModel | null {
  const buses = availableModels(year, 'bus');
  // small towns: smaller buses
  const value = (m: VehicleModel) => (Math.min(m.capacity, townPop / 40) * Math.min(m.speed, 60)) / (m.cost + m.running * 8);
  return buses.sort((a, b) => value(b) - value(a))[0] ?? null;
}

export interface AIStats {
  railStations: number; busStops: number; track: number; road: number; bridges: number; tunnels: number;
  lines: number; vehicles: number; failed: number; spent: number; sold: number;
}

interface Project {
  kind: 'rail' | 'bus' | 'road';
  towns: number[];
  stations: number[];
  edges: number[];
  depots: number[];
  line: number;
  started: number;
}

interface LineInfo { kind: 'rail' | 'bus'; towns: number[]; depot: number; maxVehicles: number; opened: number; lastSold?: number }

export interface AIState {
  phase: string;
  cooldown: number;
  projects: number;
  rng?: number;
  failed?: [string, number][];
  stats?: AIStats;
  lines?: [number, LineInfo][];
  project?: Project | null;
}

const LEAD = 20;
const PLATFORM = 18;

/**
 * An AI company. Plans one project at a time (bus network in a large town, an intercity railway, or a
 * country road) as an incremental job; `daily()` runs a fixed number of work units (each well under a few
 * milliseconds), `monthly()` manages loans and vehicles. Uses only the public construction API.
 */
export class AIController {
  state: AIState = { phase: 'idle', cooldown: 10, projects: 0 };
  stats: AIStats = { railStations: 0, busStops: 0, track: 0, road: 0, bridges: 0, tunnels: 0, lines: 0, vehicles: 0, failed: 0, spent: 0, sold: 0 };
  /** work units per game day */
  budget = 4;
  /** debugging: note work units slower than slowMs */
  static profile = false;
  static slowMs = 8;
  log: string[] = [];
  private rng: RNG;
  private failed = new Map<string, number>();
  private lines = new Map<number, LineInfo>();
  private project: Project | null = null;
  private job: Generator<void, void> | null = null;
  private errorLogged = false;

  constructor(public game: Game, public companyId: number) {
    this.rng = new RNG((game.options.seed * 977 + companyId * 7919) >>> 0);
    this.state.cooldown = 12 + companyId * 9;
    game.world.net.onSplit.push((old, e1, e2) => {
      const p = this.project;
      if (!p) return;
      const i = p.edges.indexOf(old.id);
      if (i >= 0) p.edges.splice(i, 1, e1.id, e2.id);
    });
  }

  private get eco(): Economy { return this.game.company(this.companyId).economy; }
  private get name() { return this.game.company(this.companyId).name; }

  /** Money that can be committed: cash plus unused credit, minus a safety reserve. */
  available(): number {
    const e = this.eco;
    return e.money + Math.max(0, e.maxLoan * 0.65 - e.loan) - 1_000_000 - this.game.maintenanceOf(this.companyId) * 0.5;
  }

  /** Is there room for a rail depot behind a planned station (stub or switch for multi-track)? */
  private depotSiteFor(plan: StationPlan, toward: P2, tracks: number): boolean {
    const g = this.game;
    const ax = Math.sin(plan.angle), az = Math.cos(plan.angle);
    const sgn = ax * (toward.x - plan.x) + az * (toward.z - plan.z) > 0 ? -1 : 1;
    const bx = ax * sgn, bz = az * sgn;
    const back = { x: plan.x + bx * plan.length / 2, z: plan.z + bz * plan.length / 2 };
    const lens = tracks > 1 ? [18, 22, 26] : [5, 8, 11, 15, 20];
    for (const L of lens) {
      const x = back.x + bx * L, z = back.z + bz * L;
      if (g.world.inside(x, z, 8) && depotFits(g, x, z, -bx, -bz, this.companyId, 30)) return true;
    }
    return false;
  }

  private note(s: string) {
    this.log.push(`${this.game.dateString()}: ${s}`);
    if (this.log.length > 40) this.log.shift();
  }

  private onError(e: unknown) {
    if (!this.errorLogged) { this.errorLogged = true; console.warn(`AI ${this.name}:`, e); }
    this.note('error: ' + String((e as Error)?.message ?? e));
    try { if (this.project) this.abandon(this.project); } catch { /* ignore */ }
    this.project = null;
    this.job = null;
    this.state.phase = 'idle';
    this.state.cooldown = 30;
  }

  /** Called once per game day while AI is enabled. */
  daily() {
    try {
      if (this.job) {
        for (let k = 0; k < this.budget && this.job; k++) {
          const t0 = AIController.profile ? performance.now() : 0;
          if (this.job.next().done) this.job = null;
          if (AIController.profile) { const dt = performance.now() - t0; if (dt > AIController.slowMs) this.note(`slow step ${dt.toFixed(1)} ms in "${this.state.phase}"`); }
        }
        if (!this.job) this.endProject();
        return;
      }
      if (this.state.cooldown > 0) { this.state.cooldown--; return; }
      this.chooseProject();
    } catch (e) { this.onError(e); }
  }

  /** Called once per game month while AI is enabled. */
  monthly() {
    try { this.manage(); } catch (e) { this.onError(e); }
  }

  /** Debug/test hook: start a specific project now (returns false if busy). */
  startProject(kind: 'rail' | 'bus' | 'road', towns: number[]): boolean {
    if (this.job) return false;
    const g = this.game, T = towns.map((id) => g.towns.list[id]);
    this.project = { kind, towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = kind === 'rail' ? this.railJob(T[0], T[1]) : kind === 'bus' ? this.busJob(T[0]) : this.roadJob(T[0], T[1]);
    this.state.projects++;
    return true;
  }

  /** Is a project in progress? */
  get busy() { return !!this.job; }

  // ---------------------------------------------------------------- choosing projects
  private pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
  private isFailed(key: string) { const d = this.failed.get(key); return d !== undefined && d > this.game.day; }
  private markFailed(key: string, days: number) { this.failed.set(key, this.game.day + days); this.stats.failed++; }

  private railServed(a: number, b: number): boolean {
    const g = this.game;
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.stops.length < 2) continue;
      const towns = new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1));
      if (towns.has(a) && towns.has(b)) return true;
    }
    return false;
  }

  private chooseProject() {
    const g = this.game;
    const avail = this.available();
    const own = [...this.lines.values()];
    const railLines = own.filter((l) => l.kind === 'rail').length, busLines = own.filter((l) => l.kind === 'bus').length;
    // don't overbuild: keep the debt serviceable
    const yearNet = this.eco.yearTotals.length ? Object.values(this.eco.yearTotals[this.eco.yearTotals.length - 1].v).reduce((a, b) => a + b, 0) : 0;
    if (this.eco.loan > this.eco.maxLoan * 0.85 || (own.length >= 3 && yearNet < -1_500_000)) { this.state.phase = 'consolidating'; this.state.cooldown = 90; return; }
    const opts: { score: number; kind: 'rail' | 'bus' | 'road'; towns: number[] }[] = [];
    // intercity railways
    if (avail > 4_000_000) {
      for (const A of g.towns.list) for (const B of g.towns.list) {
        if (A.id >= B.id) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 60 || d > 250 || A.pop < 250 || B.pop < 250) continue;
        if (this.isFailed(this.pairKey(A.id, B.id)) || own.some((l) => l.kind === 'rail' && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        let score = Math.sqrt(A.pop * B.pop) / (1 + Math.abs(d - 130) / 160);
        if (this.railServed(A.id, B.id)) score *= 0.3;
        if (own.filter((l) => l.kind === 'rail' && (l.towns.includes(A.id) || l.towns.includes(B.id))).length) score *= 0.6;
        opts.push({ score: score * (railLines === 0 ? 1.6 : 1), kind: 'rail', towns: [A.id, B.id] });
      }
    }
    // bus networks in larger towns
    if (avail > 900_000) {
      for (const T of g.towns.list) {
        if (T.pop < 1800 || this.isFailed('bus' + T.id) || own.some((l) => l.kind === 'bus' && l.towns.includes(T.id))) continue;
        opts.push({ score: T.pop / 2.5 * (busLines === 0 ? 1.3 : 1), kind: 'bus', towns: [T.id] });
      }
    }
    // occasionally a country road between neighbouring towns
    if (avail > 2_000_000 && this.rng.chance(0.15)) {
      for (const A of g.towns.list) for (const B of g.towns.list) {
        if (A.id >= B.id || this.isFailed('road' + this.pairKey(A.id, B.id))) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 50 || d > 130) continue;
        opts.push({ score: Math.sqrt(A.pop * B.pop) / 6, kind: 'road', towns: [A.id, B.id] });
      }
    }
    if (!opts.length) { this.state.phase = 'idle'; this.state.cooldown = 60; return; }
    opts.sort((a, b) => b.score - a.score);
    const top = opts.slice(0, 4);
    const pick = top[Math.floor(this.rng.next() * this.rng.next() * top.length)];
    const towns = pick.towns.map((id) => g.towns.list[id]);
    this.project = { kind: pick.kind, towns: pick.towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = pick.kind === 'rail' ? this.railJob(towns[0].pop >= towns[1].pop ? towns[0] : towns[1], towns[0].pop >= towns[1].pop ? towns[1] : towns[0])
      : pick.kind === 'bus' ? this.busJob(towns[0]) : this.roadJob(towns[0], towns[1]);
    this.state.projects++;
  }

  private endProject() {
    const p = this.project;
    this.project = null;
    this.state.phase = 'idle';
    this.state.cooldown = p && p.line >= 0 ? 50 + this.rng.int(60) : 20 + this.rng.int(20);
  }

  /** Remove what an unfinished project built. */
  private abandon(p: Project) {
    const g = this.game;
    if (p.line >= 0) {
      const l = g.lines.get(p.line);
      if (l) { for (const vid of [...l.vehicles]) g.vehicles.sell(vid); g.lines.delete(l.id); }
      this.lines.delete(p.line);
    }
    for (const d of p.depots) g.depots.remove(d);
    removeEdges(g, p.edges, this.companyId);
    for (const s of p.stations) { const st = g.stations.get(s); if (st && st.owner === this.companyId) g.stations.removeStation(s); }
    p.edges = []; p.stations = []; p.depots = [];
  }

  /** Record edges created since `fromId` (owned by this company) in the current project. */
  private track(fromId: number) {
    const p = this.project, net = this.game.world.net;
    if (!p) return;
    for (let id = fromId; id < net.nextEdge; id++) {
      const e = net.edges.get(id);
      if (e && e.owner === this.companyId && !p.edges.includes(id)) p.edges.push(id);
    }
  }

  private borrowFor(amount: number) {
    const e = this.eco;
    while (e.money < amount + 300_000 && e.borrow()) { /* borrow in steps */ }
    return e.money >= amount;
  }

  // ---------------------------------------------------------------- rail
  private *railJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = this.pairKey(A.id, B.id);
    this.state.phase = `planning railway ${A.name} - ${B.name}`;
    const fail = (why: string, days = 900) => { this.note(`railway ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    let tracks = this.available() > 13_000_000 ? 2 : 1;
    const pr = yield* railPairGen(g, A, B, { tracks, length: PLATFORM, owner, front: LEAD + 2 });
    if (!pr) return fail('no station sites');
    const fa = { x: Math.sin(pr.a.angle), z: Math.cos(pr.a.angle) }, fb = { x: Math.sin(pr.b.angle), z: Math.cos(pr.b.angle) };
    const frontA = { x: pr.a.x + fa.x * PLATFORM / 2, z: pr.a.z + fa.z * PLATFORM / 2 }, frontB = { x: pr.b.x + fb.x * PLATFORM / 2, z: pr.b.z + fb.z * PLATFORM / 2 };
    const from: OPoint = { x: frontA.x + fa.x * LEAD, z: frontA.z + fa.z * LEAD, tx: fa.x, tz: fa.z };
    const to: OPoint = { x: frontB.x + fb.x * LEAD, z: frontB.z + fb.z * LEAD, tx: -fb.x, tz: -fb.z };
    const avoid = [
      { x0: frontA.x - fa.x * PLATFORM, z0: frontA.z - fa.z * PLATFORM, x1: from.x - fa.x * 4, z1: from.z - fa.z * 4, r: 4 },
      { x0: frontB.x - fb.x * PLATFORM, z0: frontB.z - fb.z * PLATFORM, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
    ];
    const cs = new CorridorSearch(g, from, to, { kind: 'rail', owner, avoid });
    while (cs.step(3000) === 'running') yield;
    if (!cs.path) return fail('no corridor');
    const al = alignCorridor(cs.path, from, to);
    yield;
    if (al.minR < 14) return fail('curves too tight');
    const way = [...al.way, { x: frontB.x, z: frontB.z, tx: -fb.x, tz: -fb.z }];
    const start: OPoint = { x: frontA.x, z: frontA.z, tx: fa.x, tz: fa.z };
    let prof = chainProfile(g, [start, ...way], tracks, pr.a.y, pr.b.y, 'rail');
    if (!prof) return fail('too steep');
    yield;
    const len = prof.s[prof.s.length - 1];
    const dist = Math.hypot(pr.a.x - pr.b.x, pr.a.z - pr.b.z);
    if (len > dist * 1.55 + 25) return fail('detour too long');
    if (routeConflict(g, prof, 'rail', tracks)) return fail('route runs along other tracks or roads', 720);
    yield;
    const cars = pickTrain(g.year, PLATFORM, len);
    if (!cars) return fail('no trains available');
    const trainCost = cars.reduce((a, c) => a + c.cost, 0);
    let est = estimateChainCost(prof, tracks, 'rail', 'standard').cost * 1.15;
    let total = est + pr.a.cost + pr.b.cost + 300_000 + trainCost * tracks;
    if (tracks === 2 && total > this.available()) {
      // fall back to a single track
      tracks = 1;
      const pr1 = { a: g.stations.planRail(pr.a.x, pr.a.z, pr.a.angle, PLATFORM, 1, owner), b: g.stations.planRail(pr.b.x, pr.b.z, pr.b.angle, PLATFORM, 1, owner) };
      if (!pr1.a.ok || !pr1.b.ok) return fail('no single-track sites', 360);
      pr.a = pr1.a; pr.b = pr1.b;
      prof = chainProfile(g, [start, ...way], 1, pr.a.y, pr.b.y, 'rail');
      if (!prof) return fail('too steep');
      est = estimateChainCost(prof, 1, 'rail', 'standard').cost * 1.15;
      total = est + pr.a.cost + pr.b.cost + 300_000 + trainCost;
    }
    if (total > this.available()) return fail('too expensive', 360);
    yield;
    // the depot goes behind A (or B: then swap the ends)
    if (!this.depotSiteFor(pr.a, pr.b, tracks)) {
      if (!this.depotSiteFor(pr.b, pr.a, tracks)) return fail('no depot site', 720);
    }
    // rough yearly result: one full train per track (fare model in vehicle.ts)
    const days = len / 3.2 + 9;
    const tripsYear = 360 / days;
    const cap = cars.reduce((a, c) => a + c.capacity, 0);
    const income = tracks * tripsYear * cap * 0.8 * fare(dist, days - 6, 1);
    const running = tracks * cars.reduce((a, c) => a + c.running, 0);
    const maint = len * tracks * 300 + 75_000 + 12_000 + est * 0.01;
    if (income - running - maint < (total - trainCost * tracks) * 0.07 + total * 0.04) return fail('not profitable', 1500);
    // ---- build
    this.state.phase = `building railway ${A.name} - ${B.name}`;
    if (!this.borrowFor(total)) return fail('no money', 360);
    const spent0 = this.eco.money;
    for (const plan of [pr.a, pr.b]) {
      const re = g.stations.planRail(plan.x, plan.z, plan.angle, PLATFORM, tracks, owner);
      const id = g.stations.nextId;
      if (!re.ok || g.stations.commitRail(re, owner)) return fail('station site taken', 360);
      p.stations.push(id);
      this.track(net.nextEdge - tracks);
      yield;
    }
    const stA = g.stations.get(p.stations[0])!, stB = g.stations.get(p.stations[1])!;
    const endA = stationEnds(g, stA), endB = stationEnds(g, stB);
    const front = (st: Station, ends: { front: number; back: number }[], o: Station) => {
      const r = st.rail!, f = Math.sin(r.angle) * (o.x - st.x) + Math.cos(r.angle) * (o.z - st.z) > 0;
      return ends.map((e) => (f ? e.front : e.back));
    };
    const fAs = front(stA, endA, stB), fBs = front(stB, endB, stA);
    const exclude = new Set<number>([...stA.rail!.edges, ...stB.rail!.edges]);
    prof = chainProfile(g, [start, ...way], tracks, stA.rail!.y, stB.rail!.y, 'rail', exclude);
    if (!prof) return fail('too steep');
    yield;
    if (routeConflict(g, prof, 'rail', tracks, exclude)) return fail('route runs along other tracks or roads', 720);
    yield;
    const e0 = net.nextEdge;
    const chain = chainGen(g, fAs[0], way, { kind: 'rail', type: 'standard', tracks, heightOffset: 0, crossing: 'auto', owner }, fBs[0], prof);
    let r = chain.next();
    while (!r.done) { this.track(e0); yield; r = chain.next(); }
    this.track(e0);
    const res = r.value;
    if (!res.ok) return fail('construction failed: ' + (res.error ?? ''), 720);
    this.stats.track += res.built; this.stats.bridges += res.bridges; this.stats.tunnels += res.tunnels;
    yield;
    // ---- depot behind A
    const d0 = net.nextEdge;
    let dep = -1;
    for (const [st, o] of [[stA, stB], [stB, stA]] as [Station, Station][]) {
      if (dep >= 0) break;
      const dir = { x: o.x - st.x, z: o.z - st.z };
      dep = tracks > 1 ? this.depotSwitch(st, dir) : buildRailDepot(g, st, owner, dir);
    }
    if (dep < 0 && tracks === 1) {
      // a siding off the main line near A
      for (const d of [30, 45, 60]) {
        const l = Math.hypot(stB.x - stA.x, stB.z - stA.z) || 1;
        const x = stA.x + ((stB.x - stA.x) / l) * d, z = stA.z + ((stB.z - stA.z) / l) * d;
        const ne = net.nearestEdge(x, z, 15, 'rail', (e) => e.owner === owner && e.station < 0 && e.depot < 0 && e.len > 8);
        if (ne) dep = buildDepotOnLine(g, ne.edge.id, Math.min(ne.edge.len - 3, Math.max(3, ne.s)), owner);
        if (dep >= 0) break;
      }
    }
    this.track(d0);
    if (dep < 0) return fail('no depot site', 720);
    p.depots.push(dep);
    yield;
    // ---- line and trains
    const line = g.lines.create('rail', owner);
    line.stops = [stA.id, stB.id];
    p.line = line.id;
    let bought = 0;
    for (let i = 0; i < tracks; i++) {
      const t = g.vehicles.buyTrain(dep, cars, line.id);
      if (typeof t !== 'string') { bought++; this.stats.vehicles++; }
    }
    if (!bought) return fail('could not buy a train', 360);
    this.lines.set(line.id, { kind: 'rail', towns: [A.id, B.id], depot: dep, maxVehicles: tracks, opened: g.day });
    this.stats.lines++; this.stats.railStations += 2;
    this.stats.spent += Math.max(0, spent0 - this.eco.money) + total - est;
    this.project = { ...p, line: line.id };
    p.line = line.id;
    g.postNews(`${this.name} opens a railway between ${A.name} and ${B.name} (${(len / 100).toFixed(1)} km${tracks > 1 ? ', double track' : ''}).`, 'ai', (stA.x + stB.x) / 2, (stA.z + stB.z) / 2);
    this.note(`opened railway ${A.name}-${B.name}: ${Math.round(len)} u, ${tracks} track(s), ${res.bridges} bridges, ${res.tunnels} tunnels`);
    this.project = null;
  }

  /** Depot for a multi-track terminus: a switch behind the back ends feeding every platform track. */
  private depotSwitch(st: Station, frontDir: P2): number {
    const g = this.game, net = g.world.net, owner = this.companyId;
    const r = st.rail!;
    const ax = Math.sin(r.angle), az = Math.cos(r.angle);
    const sgn = ax * frontDir.x + az * frontDir.z > 0 ? -1 : 1; // direction of the back ends
    const bx = ax * sgn, bz = az * sgn;
    const ends = stationEnds(g, st).map((e) => (sgn > 0 ? e.front : e.back));
    const o = (h: number): BuildOptions => ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: h, crossing: 'auto', owner });
    const backC = { x: r.x + bx * r.length / 2, z: r.z + bz * r.length / 2 };
    for (const L of [12, 16, 20]) {
      const S = { x: backC.x + bx * L, z: backC.z + bz * L }, D = { x: S.x + bx * 6, z: S.z + bz * 6 };
      if (!g.world.inside(D.x, D.z, 8) || !depotFits(g, D.x, D.z, -bx, -bz, owner, 30)) continue;
      const n0 = net.nodes.get(ends[0]);
      if (!n0 || n0.edges.length !== 1) return buildRailDepot(g, st, owner, frontDir);
      const p1 = planEdge(g, nodeSnap(g, ends[0], 'rail'), { kind: 'free', x: S.x, z: S.z, y: 0 }, o(r.y - g.world.heightAt(S.x, S.z) || 1e-3));
      if (!p1.ok || commitProposal(g, p1)) continue;
      const sNode = nodeAt(g, 'rail', S.x, S.z);
      if (!sNode) return -1;
      const p2 = planEdge(g, nodeSnap(g, sNode.id, 'rail'), { kind: 'free', x: D.x, z: D.z, y: 0 }, o(r.y - g.world.heightAt(D.x, D.z) || 1e-3));
      if (!p2.ok || commitProposal(g, p2)) { removeEdges(g, [...sNode.edges], owner); continue; }
      for (let i = 1; i < ends.length; i++) {
        const p3 = planEdge(g, nodeSnap(g, ends[i], 'rail'), nodeSnap(g, sNode.id, 'rail'), o(0));
        if (p3.ok) commitProposal(g, p3);
      }
      const dNode = nodeAt(g, 'rail', D.x, D.z);
      const id = dNode ? depotAtEnd(g, dNode.id, owner) : -1;
      if (id >= 0) return id;
      return -1;
    }
    return buildRailDepot(g, st, owner, frontDir);
  }

  // ---------------------------------------------------------------- bus
  private *busJob(T: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    this.state.phase = `planning buses in ${T.name}`;
    const fail = (why: string) => { this.note(`buses in ${T.name} abandoned: ${why}`); this.markFailed('bus' + T.id, 1200); this.abandon(p); };
    const model = pickBus(g.year, T.pop);
    if (!model) return fail('no buses available');
    // stop candidates on streets: middle of street edges, away from other companies' stops
    const cands: { x: number; z: number; d: number }[] = [];
    for (const e of g.towns.streets(T, 0)) {
      if (e.len < 4) continue;
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const bp = g.stations.planBusStop(q.x, q.z, owner);
      if (!bp.ok || bp.join) continue;
      let clash = false;
      for (const st of g.stations.map.values()) if (st.owner !== owner && st.stops.some((s) => Math.hypot(s.x - q.x, s.z - q.z) < 8)) { clash = true; break; }
      if (!clash) cands.push({ x: q.x, z: q.z, d: Math.hypot(q.x - T.x, q.z - T.z) });
    }
    yield;
    if (cands.length < 2) return fail('no stop sites');
    cands.sort((a, b) => a.d - b.d);
    const stops = [cands[0]];
    const nStops = T.pop > 2500 ? 3 : 2;
    for (const c of cands) {
      if (stops.length >= nStops) break;
      if (stops.every((s) => { const d = Math.hypot(s.x - c.x, s.z - c.z); return d > 11 && d < 34; })) stops.push(c);
    }
    if (stops.length < 2) return fail('stops too close');
    const cost = stops.length * 30000 + 120_000 + model.cost * (stops.length + 1);
    if (!this.borrowFor(cost)) return fail('no money');
    this.state.phase = `building buses in ${T.name}`;
    const ids: number[] = [];
    for (const s of stops) {
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) continue;
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const d = Math.hypot(q.x - s.x, q.z - s.z); if (d < bd) { bd = d; sid = st.id; } }
      if (sid >= 0 && !ids.includes(sid)) ids.push(sid);
      if (g.stations.nextId > before) p.stations.push(before);
      this.stats.busStops++;
    }
    yield;
    if (ids.length < 2) return fail('stops not built');
    const d0 = net.nextEdge;
    const dep = buildRoadDepot(g, stops[0].x, stops[0].z, owner);
    this.track(d0);
    if (dep < 0) return fail('no depot site');
    p.depots.push(dep);
    yield;
    const line = g.lines.create('road', owner);
    line.stops = ids;
    p.line = line.id;
    const n = Math.min(4, ids.length + (T.pop > 3000 ? 1 : 0));
    for (let i = 0; i < n; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (typeof v !== 'string') this.stats.vehicles++; }
    this.lines.set(line.id, { kind: 'bus', towns: [T.id], depot: dep, maxVehicles: 7, opened: g.day });
    this.stats.lines++;
    g.postNews(`${this.name} starts a bus service in ${T.name}.`, 'ai', T.x, T.z);
    this.note(`opened bus line in ${T.name} (${ids.length} stops, ${n} buses)`);
    this.project = null;
  }

  // ---------------------------------------------------------------- road
  /** Are two towns connected by roads? (bounded search over the road graph) */
  private roadConnected(A: Town, B: Town): boolean {
    const net = this.game.world.net;
    const start = net.nearestNode(A.x, A.z, A.radius + 6, 'road', (n) => n.edges.length > 0);
    if (!start) return false;
    const seen = new Set<number>([start.id]);
    const queue = [start.id];
    while (queue.length && seen.size < 6000) {
      const id = queue.shift()!;
      const n = net.nodes.get(id)!;
      if (Math.hypot(n.x - B.x, n.z - B.z) < B.radius) return true;
      for (const eid of n.edges) {
        const e = net.edges.get(eid);
        if (!e || e.depot >= 0) continue;
        const o = e.a === id ? e.b : e.a;
        if (!seen.has(o)) { seen.add(o); queue.push(o); }
      }
    }
    return false;
  }

  /** Outermost street point of a town in direction u (within a corridor). */
  private townEdge(T: Town, ux: number, uz: number): { x: number; z: number; d: number } | null {
    const net = this.game.world.net;
    let best: { x: number; z: number; d: number } | null = null;
    for (const e of this.game.towns.streets(T, 4)) {
      const geo = net.geo(e);
      for (let i = 0; i < geo.n; i += 4) {
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
        const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
        if (lat > 14 || along < 0) continue;
        if (!best || along > best.d) best = { x, z, d: along };
      }
    }
    return best;
  }

  /**
   * Where a country road can leave a town towards direction u: a dead-end street facing that way
   * (extended straight), else a side exit from the outermost street. Returns the join proposal.
   */
  private townExit(T: Town, ux: number, uz: number): { prop: Proposal; x: number; z: number; tx: number; tz: number } | null {
    const g = this.game, net = g.world.net;
    const so: BuildOptions = { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.companyId };
    const cands: { sn: Snap; tx: number; tz: number; score: number }[] = [];
    for (const e of g.towns.streets(T, 4)) {
      for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid)!;
        if (n.edges.length !== 1) continue;
        const along = (n.x - T.x) * ux + (n.z - T.z) * uz, lat = Math.abs((n.x - T.x) * uz - (n.z - T.z) * ux);
        const d = net.leaveDir(e, nid);
        const tx = -d.x, tz = -d.z;
        const facing = tx * ux + tz * uz;
        if (along < -5 || lat > 30 || facing < 0.5) continue;
        cands.push({ sn: { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }, tx, tz, score: along - lat * 0.5 + facing * 20 });
      }
    }
    // side exits from the outermost streets
    const pts: { x: number; z: number; along: number }[] = [];
    for (const e of g.towns.streets(T, 4)) {
      const geo = net.geo(e);
      for (let i = 2; i < geo.n - 2; i += 6) {
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
        const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
        if (lat < 20 && along > 0) pts.push({ x, z, along });
      }
    }
    pts.sort((p, q) => q.along - p.along);
    for (const q of pts.slice(0, 6)) { const sn = findSnap(g, 'road', q.x, q.z, 0.4); if (sn.kind !== 'free') cands.push({ sn, tx: ux, tz: uz, score: q.along - 1000 }); }
    cands.sort((p, q) => q.score - p.score);
    for (const c of cands.slice(0, 10)) {
      const x = c.sn.x + c.tx * 8, z = c.sn.z + c.tz * 8;
      if (!g.world.inside(x, z, 6) || g.world.heightAt(x, z) < WATER_Y + 0.2) continue;
      const pj = planEdge(g, c.sn, { kind: 'free', x, z, y: 0 }, so);
      if (pj.ok && pj.demolish.length <= 2 && pj.stats.minRadius >= 3) {
        const end = endTangent(pj.tracks[0].bez);
        return { prop: pj, x, z, tx: end.x, tz: end.z };
      }
    }
    return null;
  }

  private *roadJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = 'road' + this.pairKey(A.id, B.id);
    this.state.phase = `planning road ${A.name} - ${B.name}`;
    const fail = (why: string, days = 3000) => { this.note(`road ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    if (this.roadConnected(A, B)) return fail('already connected', 1e9);
    yield;
    const d = Math.hypot(B.x - A.x, B.z - A.z);
    const ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
    const xa = this.townExit(A, ux, uz), xb = this.townExit(B, -ux, -uz);
    if (!xa || !xb) return fail('no way out of the towns');
    const from: OPoint = { x: xa.x, z: xa.z, tx: xa.tx, tz: xa.tz };
    const to: OPoint = { x: xb.x, z: xb.z, tx: -xb.tx, tz: -xb.tz };
    const gap = (to.x - from.x) * ux + (to.z - from.z) * uz;
    if (gap < 15) return fail('towns touch', 1e9);
    yield;
    const cs = new CorridorSearch(g, from, to, { kind: 'road', owner, buildingCost: 3, lead: 6 });
    while (cs.step(3000) === 'running') yield;
    if (!cs.path) return fail('no corridor');
    const al = alignCorridor(cs.path, from, to, 80, 12);
    if (al.minR < 5) return fail('curves too tight');
    let prof = chainProfile(g, al.way, 1, xa.prop.tracks[0].prof[xa.prop.tracks[0].prof.length - 1], xb.prop.tracks[0].prof[xb.prop.tracks[0].prof.length - 1], 'road');
    if (!prof) return fail('too steep');
    if (routeConflict(g, prof, 'road', 1)) return fail('route runs along other roads', 1500);
    if (prof.s[prof.s.length - 1] > gap * 2 + 20) return fail('detour too long');
    const est = estimateChainCost(prof, 1, 'road', 'road').cost * 1.2 + xa.prop.cost + xb.prop.cost + 50_000;
    if (est > this.available() * 0.4) return fail('too expensive', 720);
    if (!this.borrowFor(est)) return fail('no money', 360);
    this.state.phase = `building road ${A.name} - ${B.name}`;
    const o: BuildOptions = { kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing: 'auto', owner };
    const e0 = net.nextEdge;
    if (commitProposal(g, xa.prop) || commitProposal(g, xb.prop)) { this.track(e0); return fail('could not join the towns'); }
    this.track(e0);
    const nA = nodeAt(g, 'road', from.x, from.z), nB = nodeAt(g, 'road', to.x, to.z);
    if (!nA || !nB) return fail('could not join the towns');
    yield;
    prof = chainProfile(g, al.way, 1, nA.y, nB.y, 'road');
    if (!prof) return fail('too steep');
    const chain = chainGen(g, nA.id, al.way.slice(1), o, nB.id, prof);
    let r = chain.next();
    while (!r.done) { this.track(e0); yield; r = chain.next(); }
    this.track(e0);
    if (!r.value.ok) return fail('construction failed: ' + (r.value.error ?? ''));
    this.stats.road += r.value.built + 16;
    this.stats.bridges += r.value.bridges; this.stats.tunnels += r.value.tunnels;
    g.postNews(`${this.name} builds a road between ${A.name} and ${B.name}.`, 'ai', (A.x + B.x) / 2, (A.z + B.z) / 2);
    this.note(`built road ${A.name}-${B.name} (${Math.round(r.value.built + 16)} u)`);
    this.failed.set(key, 1e12); // done for good
    this.project = null;
  }

  // ---------------------------------------------------------------- management
  private manage() {
    const g = this.game, e = this.eco;
    // loans: keep a cash cushion, repay when rich
    if (e.money < 500_000) { while (e.money < 1_000_000 && e.borrow()) { /* */ } }
    else if (!this.job && e.money > 3_000_000 && e.loan > 0) { while (e.money > 2_000_000 && e.loan > 0 && e.repay()) { /* */ } }
    for (const [lid, info] of [...this.lines]) {
      const l = g.lines.get(lid);
      if (!l) { this.lines.delete(lid); continue; }
      const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
      // sell chronically unprofitable vehicles (keep one per line unless money is tight)
      for (const v of vs) {
        if (v.age < 2.5 || v.profitLast >= -0.25 * v.runningCost || v.profitYear > 0) continue;
        if (vs.length > 1 || e.money < 0) { g.vehicles.sell(v.id); this.stats.sold++; info.lastSold = g.day; this.note(`sold ${v.name}`); break; }
      }
      // more vehicles when passengers pile up on a line that pays
      const maxV = info.kind === 'bus' ? Math.min(info.maxVehicles, l.stops.length * 2) : info.maxVehicles;
      if (!vs.length || vs.length >= maxV || g.day - (info.lastSold ?? -1e9) < 180) continue;
      const young = g.day - info.opened < 360;
      if (!young && l.incomeLast < l.costLast * 1.2 + 10_000) continue;
      let waiting = 0;
      for (const sid of l.stops) { const st = g.stations.get(sid); if (st) for (const w of st.waiting.values()) if (w.line === lid) waiting += w.count; }
      const v0 = vs[0];
      if (waiting < v0.capacity * 2.5 || this.available() < v0.value * 1.5) continue;
      if (info.kind === 'rail' && v0 instanceof Train) {
        const t = g.vehicles.buyTrain(info.depot, [...v0.cars].sort((a, b) => (a.kind === 'loco' ? -1 : 0) - (b.kind === 'loco' ? -1 : 0)), lid);
        if (typeof t !== 'string') { this.stats.vehicles++; this.note(`added a train to ${l.name}`); }
      } else if (v0 instanceof RoadVehicle && v0.model) {
        const model = v0.model;
        if (!this.borrowFor(model.cost)) continue;
        const b = g.vehicles.buyRoad(info.depot, model, lid);
        if (typeof b !== 'string') { this.stats.vehicles++; this.note(`added a bus to ${l.name}`); }
      }
    }
  }

  // ---------------------------------------------------------------- save / load
  toJSON(): unknown {
    return {
      companyId: this.companyId,
      state: {
        ...this.state, rng: this.rng.state, failed: [...this.failed], stats: this.stats, lines: [...this.lines],
        project: this.project,
      },
    };
  }

  load(data: any) {
    const s = data?.state;
    if (!s) return;
    this.state = { phase: s.phase ?? 'idle', cooldown: s.cooldown ?? 10, projects: s.projects ?? 0 };
    if (typeof s.rng === 'number') this.rng.state = s.rng;
    if (Array.isArray(s.failed)) this.failed = new Map(s.failed);
    if (s.stats) this.stats = { ...this.stats, ...s.stats };
    if (Array.isArray(s.lines)) this.lines = new Map(s.lines);
    // an interrupted project is cleaned up (jobs are not persisted)
    if (s.project) {
      const p: Project = { kind: s.project.kind, towns: s.project.towns ?? [], stations: s.project.stations ?? [], edges: s.project.edges ?? [], depots: s.project.depots ?? [], line: s.project.line ?? -1, started: s.project.started ?? 0 };
      try { this.abandon(p); } catch { /* ignore */ }
      this.state.phase = 'idle';
      this.state.cooldown = 5;
    }
  }
}

// keep type imports referenced
export type { Town, Station, StationPlan, NEdge };
