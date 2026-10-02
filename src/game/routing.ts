// Route building on the free-form network, shared by world generation (intercity roads) and the AI:
// coarse terrain A* corridors, railway-style alignments, crossing-aware height profiles, chained
// construction with planEdge/commitProposal, station sites and depots.
import type { Game } from './game';
import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import type { NNode, NEdge } from './network';
import { NetKind, RAIL, TRACK_TYPES, ROAD_TYPES, WATER_Y, STATION_RADIUS } from './constants';
import { planEdge, commitProposal, findSnap, freeSide, BuildOptions, Snap, Proposal } from './construction';
import { recomputeLocks } from './terraform';
import { distToRect } from './world';
import { Heap } from './train';
import { segIntersect, angleBetween } from './geom';


// ============================================================================ geometry helpers

/** Oriented point: position and unit tangent (direction of travel). */
export interface OPoint { x: number; z: number; tx: number; tz: number }
export interface P2 { x: number; z: number }

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
export function solveHeights(desired: number[], step: number | number[], lo0: number[], hi0: number[], grade: number): number[] | null {
  const n = desired.length;
  const lo = lo0.slice(), hi = hi0.slice();
  // gs(i): allowed height change between samples i-1 and i
  const gs = (i: number) => grade * (typeof step === 'number' ? step : step[i]);
  for (let i = 1; i < n; i++) { hi[i] = Math.min(hi[i], hi[i - 1] + gs(i)); lo[i] = Math.max(lo[i], lo[i - 1] - gs(i)); }
  for (let i = n - 2; i >= 0; i--) { hi[i] = Math.min(hi[i], hi[i + 1] + gs(i + 1)); lo[i] = Math.max(lo[i], lo[i + 1] - gs(i + 1)); }
  for (let i = 0; i < n; i++) if (lo[i] > hi[i] + 1e-4) return null;
  const f = new Array(n), b = new Array(n);
  f[0] = Math.min(hi[0], Math.max(lo[0], desired[0]));
  for (let i = 1; i < n; i++) f[i] = Math.min(hi[i], Math.max(lo[i], Math.min(f[i - 1] + gs(i), Math.max(f[i - 1] - gs(i), desired[i]))));
  b[n - 1] = Math.min(hi[n - 1], Math.max(lo[n - 1], desired[n - 1]));
  for (let i = n - 2; i >= 0; i--) b[i] = Math.min(hi[i], Math.max(lo[i], Math.min(b[i + 1] + gs(i + 1), Math.max(b[i + 1] - gs(i + 1), desired[i]))));
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

export interface ChainResult { ok: boolean; error?: string; cost: number; endNode: number; edges: number; bridges: number; tunnels: number; built: number; notes?: string[] }

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
  const step = ss.map((v, i) => (i ? v - ss[i - 1] : 0));
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
export function nodeAt(g: Game, kind: NetKind, x: number, z: number): NNode | null {
  return g.world.net.nearestNode(x, z, 0.08, kind, (n) => n.edges.length > 0);
}

/** One planEdge/commit step with fallbacks for crossings and heights. */
function buildSegment(g: Game, start: Snap, end: Snap, opts: BuildOptions, endY: number | null, res: ChainResult, log?: (s: string) => void): Proposal | null {
  const tries: Partial<BuildOptions>[] = [{}, { crossing: 'level' }, { crossing: 'over' }, { crossing: 'under' }];
  let last: Proposal | null = null;
  const cl = Math.hypot(end.x - start.x, end.z - start.z) || 1;
  let firstErr = '';
  for (const useH of endY !== null ? [true, false] : [false]) {
    if (!useH && endY !== null && last) firstErr = last.errors.join(', ') + ` (crossings ${last.crossings.map((c) => c.mode).join('/')})`;
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
      if (firstErr) (res.notes ??= []).push(`end height relaxed: ${firstErr}`);
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
    const p = buildSegment(g, st, en, opts, endY, res, allowSplit && !goal ? undefined : log);
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
  const yEnd = prof ? prof.y[prof.y.length - 1] : 0;
  for (let i = 0; i < way.length; i++) {
    const n = net.nodes.get(cur);
    if (!n) { res.error = 'Lost the chain'; return res; }
    const wp = way[i];
    const isGoal = i === way.length - 1 && goalNode !== null;
    const c = groupCentre(g, cur, opts.kind, opts.tracks);
    const t0 = nodeTangent(g, cur, wp);
    const a: OPoint = { x: c.x, z: c.z, tx: t0.tx, tz: t0.tz };
    // the last segment ended off the planned heights: re-plan the rest of the profile from here
    if (prof && i > 0 && Math.abs(n.y - profileAt(prof, c.x, c.z)) > 0.12) {
      const ex = new Set<number>(n.edges);
      if (goalNode !== null) for (const id of nodeSnap(g, goalNode, opts.kind).group ?? [goalNode]) for (const e of net.nodes.get(id)?.edges ?? []) ex.add(e);
      for (const id of nodeSnap(g, cur, opts.kind).group ?? [cur]) for (const e of net.nodes.get(id)?.edges ?? []) ex.add(e);
      const np = chainProfile(g, [a, ...way.slice(i)], opts.tracks, n.y, yEnd, opts.kind, ex);
      if (!np) { res.error = 'Too steep: the route left its planned heights'; log?.(`re-plan of heights failed at waypoint ${i}`); return res; }
      prof = np;
    }
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
export function depotAtEnd(g: Game, nodeId: number, owner: number): number {
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
export function depotFits(g: Game, x: number, z: number, fx: number, fz: number, owner: number, maxPop = 0): boolean {
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
export function buildRoadDepot(g: Game, x: number, z: number, owner: number, maxR = 26, pred?: (e: NEdge) => boolean): number {
  const net = g.world.net;
  for (const maxPop of [0, 30]) {
    for (let r = 2.5; r < maxR; r += 1.5) {
      for (let k = 0; k < 12; k++) {
        const a = ((k + (r % 2) * 0.5) / 12) * Math.PI * 2;
        const px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r;
        const ne = net.nearestEdge(px, pz, 3.6, 'road', (e) => e.depot < 0 && e.station < 0);
        if (ne && pred && !pred(ne.edge)) continue;
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
