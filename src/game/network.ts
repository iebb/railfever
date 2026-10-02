// Free-form transport network: nodes and cubic-Bezier edges with height profiles.
import type { World } from './world';
import { NetKind, PSTEP, ROAD_TYPES, LANE_OFFSET } from './constants';
import {
  Bez, arcTable, tAtS, bezPoint, bezDeriv, bezSplit, startTangent, endTangent, bezMinRadius, closestOnPolyline, Vec3Like,
} from './geom';
import { SpatialGrid } from './spatial';

export interface NNode {
  id: number;
  kind: NetKind;
  x: number; y: number; z: number;
  /** rail: track direction through the node (unit). road: unused */
  dx: number; dz: number;
  edges: number[];
  /** rail signal: 0 none, 1 two-way, 2 one-way (+dir), 3 one-way (-dir) */
  signal: number;
  owner: number;
}

export interface Section { s0: number; s1: number; type: 'bridge' | 'tunnel' }

export interface NEdge {
  id: number;
  kind: NetKind;
  a: number; b: number;
  /** rail: side of the node direction the edge leaves on (+1/-1) */
  sa: number; sb: number;
  bez: Bez;
  len: number;
  /** heights at s = min(i*PSTEP, len) */
  prof: Float32Array;
  sections: Section[];
  type: string;
  owner: number;
  station: number;
  depot: number;
  /** road edges only: embedded tram tracks (with overhead wire) */
  tram?: boolean;
  /** company owning the tram tracks (-1 / undefined = none) */
  tramOwner?: number;
  version: number;
}

export interface Crossing { id: number; kind: 'level' | 'diamond'; e1: number; s1: number; e2: number; s2: number; x: number; z: number }

/** Sampled 3D curve. pts: x,y,z triples; cum: arc length at each sample. */
export interface Curve3 { pts: Float32Array; cum: Float32Array; len: number; minRadius: number }

export interface EdgeGeo extends Curve3 { n: number; tan: Float32Array }

export function curvePoint(c: Curve3, s: number, out: Vec3Like, dir?: Vec3Like) {
  const n = c.cum.length;
  if (s <= 0) s = 0;
  if (s >= c.len) s = c.len;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c.cum[m] <= s) lo = m; else hi = m; }
  const seg = c.cum[hi] - c.cum[lo];
  const f = seg > 1e-9 ? (s - c.cum[lo]) / seg : 0;
  const p = c.pts;
  const ax = p[lo * 3], ay = p[lo * 3 + 1], az = p[lo * 3 + 2];
  const bx = p[hi * 3], by = p[hi * 3 + 1], bz = p[hi * 3 + 2];
  out.x = ax + (bx - ax) * f; out.y = ay + (by - ay) * f; out.z = az + (bz - az) * f;
  if (dir) {
    const l = Math.hypot(bx - ax, by - ay, bz - az) || 1;
    dir.x = (bx - ax) / l; dir.y = (by - ay) / l; dir.z = (bz - az) / l;
  }
}

export function makeCurve(pts: number[] | Float32Array): Curve3 {
  const n = pts.length / 3;
  const cum = new Float32Array(n);
  let len = 0;
  for (let i = 1; i < n; i++) {
    len += Math.hypot(pts[i * 3] - pts[i * 3 - 3], pts[i * 3 + 1] - pts[i * 3 - 2], pts[i * 3 + 2] - pts[i * 3 - 1]);
    cum[i] = len;
  }
  let minR = Infinity;
  for (let i = 1; i < n - 1; i++) {
    const ax = pts[i * 3] - pts[i * 3 - 3], az = pts[i * 3 + 2] - pts[i * 3 - 1];
    const bx = pts[i * 3 + 3] - pts[i * 3], bz = pts[i * 3 + 5] - pts[i * 3 + 2];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ang = Math.abs(Math.atan2((ax * bz - az * bx) / (la * lb), (ax * bx + az * bz) / (la * lb)));
    if (ang > 1e-4) minR = Math.min(minR, ((la + lb) / 2) / ang);
  }
  return { pts: pts instanceof Float32Array ? pts : new Float32Array(pts), cum, len, minRadius: minR };
}

/** Resample a height profile over [s0,s1] of an edge into a new profile array. */
export function resampleProfile(prof: Float32Array, len: number, s0: number, s1: number): Float32Array {
  const L = s1 - s0;
  const m = Math.max(2, Math.ceil(L / PSTEP) + 1);
  const out = new Float32Array(m);
  for (let i = 0; i < m; i++) out[i] = profAt(prof, len, s0 + Math.min(i * PSTEP, L));
  return out;
}

export function profAt(prof: Float32Array, len: number, s: number): number {
  const m = prof.length;
  if (s <= 0) return prof[0];
  if (s >= len) return prof[m - 1];
  const i = Math.floor(s / PSTEP);
  if (i >= m - 1) return prof[m - 1];
  const s0 = i * PSTEP, s1 = Math.min((i + 1) * PSTEP, len);
  const f = (s - s0) / Math.max(1e-9, s1 - s0);
  return prof[i] + (prof[i + 1] - prof[i]) * f;
}

export class Network {
  nodes = new Map<number, NNode>();
  edges = new Map<number, NEdge>();
  crossings = new Map<number, Crossing>();
  nextNode = 1;
  nextEdge = 1;
  nextCrossing = 1;
  grid = new SpatialGrid(8);
  nodeGrid = new SpatialGrid(8);
  version = 0;
  /** edges and nodes touched since vehicles last processed a network change (see Vehicles.onNetworkChanged) */
  dirtyEdges = new Set<number>();
  dirtyNodes = new Set<number>();
  private geoCache = new Map<number, { v: number; g: EdgeGeo }>();
  private tables = new Map<number, { v: number; t: ReturnType<typeof arcTable> }>();
  private laneCache = new Map<string, { v: number; c: Curve3 }>();
  /** listeners for structural changes (stations, vehicles, renderer) */
  onSplit: ((old: NEdge, e1: NEdge, e2: NEdge, s: number) => void)[] = [];
  onRemove: ((e: NEdge) => void)[] = [];

  constructor(public world: World) {}

  // ---------------------------------------------------------------- nodes
  addNode(kind: NetKind, x: number, y: number, z: number, dx = 0, dz = 0, owner = 0): NNode {
    const n: NNode = { id: this.nextNode++, kind, x, y, z, dx, dz, edges: [], signal: 0, owner };
    this.nodes.set(n.id, n);
    this.nodeGrid.insert(n.id, x, z, x, z);
    return n;
  }

  removeNode(id: number) {
    const n = this.nodes.get(id);
    if (!n) return;
    for (const e of [...n.edges]) this.removeEdge(e);
    this.nodes.delete(id);
    this.nodeGrid.remove(id);
    this.version++;
  }

  /** Direction an edge leaves a node (unit). */
  leaveDir(e: NEdge, nodeId: number): { x: number; z: number } {
    if (e.a === nodeId) return startTangent(e.bez);
    const t = endTangent(e.bez);
    return { x: -t.x, z: -t.z };
  }

  /** Side (+1/-1) of an edge at one of its nodes (rail). */
  sideAt(e: NEdge, nodeId: number): number { return e.a === nodeId ? e.sa : e.sb; }
  other(e: NEdge, nodeId: number): number { return e.a === nodeId ? e.b : e.a; }

  // ---------------------------------------------------------------- edges
  addEdge(kind: NetKind, a: number, b: number, bez: Bez, prof: Float32Array, sections: Section[], type: string, owner: number, extra: Partial<NEdge> = {}): NEdge {
    const na = this.nodes.get(a)!, nb = this.nodes.get(b)!;
    const tab = arcTable(bez);
    let sa = 1, sb = -1;
    if (kind === 'rail') {
      const t0 = startTangent(bez), t3 = endTangent(bez);
      if (na.dx === 0 && na.dz === 0) { na.dx = t0.x; na.dz = t0.z; }
      if (nb.dx === 0 && nb.dz === 0) { nb.dx = t3.x; nb.dz = t3.z; }
      sa = t0.x * na.dx + t0.z * na.dz >= 0 ? 1 : -1;
      sb = -t3.x * nb.dx - t3.z * nb.dz >= 0 ? 1 : -1;
    }
    const e: NEdge = {
      id: this.nextEdge++, kind, a, b, sa, sb, bez, len: tab.len, prof, sections, type, owner,
      station: -1, depot: -1, version: 0, ...extra,
    };
    this.edges.set(e.id, e);
    this.tables.set(e.id, { v: 0, t: tab });
    na.edges.push(e.id);
    nb.edges.push(e.id);
    this.indexEdge(e);
    this.version++;
    this.markEdge(e);
    return e;
  }

  private indexEdge(e: NEdge) {
    const g = this.geo(e);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < g.n; i++) {
      const x = g.pts[i * 3], z = g.pts[i * 3 + 2];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    this.grid.insert(e.id, x0 - 1, z0 - 1, x1 + 1, z1 + 1);
  }

  markEdge(e: NEdge) {
    this.dirtyEdges.add(e.id); this.dirtyNodes.add(e.a); this.dirtyNodes.add(e.b);
    const b = this.grid.box(e.id);
    if (b) this.world.markObjArea(b[0] - 2, b[1] - 2, b[2] + 2, b[3] + 2);
    // junction geometry of the end nodes depends on this edge
    for (const nid of [e.a, e.b]) {
      const n = this.nodes.get(nid);
      if (n) this.world.markObjArea(n.x - 3, n.z - 3, n.x + 3, n.z + 3);
    }
  }

  /** Call after changing an edge's profile or sections. */
  touchEdge(e: NEdge) {
    e.version++;
    this.version++;
    this.geoCache.delete(e.id);
    this.markEdge(e);
  }

  removeEdge(id: number) {
    const e = this.edges.get(id);
    if (!e) return;
    for (const l of this.onRemove) l(e);
    this.markEdge(e);
    this.edges.delete(id);
    this.grid.remove(id);
    this.geoCache.delete(id);
    this.tables.delete(id);
    for (const nid of [e.a, e.b]) {
      const n = this.nodes.get(nid);
      if (!n) continue;
      n.edges = n.edges.filter((x) => x !== id);
      if (!n.edges.length) { this.nodes.delete(nid); this.nodeGrid.remove(nid); }
      else if (n.edges.length !== 2 && n.signal) n.signal = 0;
    }
    for (const [cid, c] of this.crossings) if (c.e1 === id || c.e2 === id) this.crossings.delete(cid);
    this.version++;
  }

  table(e: NEdge) {
    let c = this.tables.get(e.id);
    if (!c) { c = { v: 0, t: arcTable(e.bez) }; this.tables.set(e.id, c); }
    return c.t;
  }

  heightAtS(e: NEdge, s: number) { return profAt(e.prof, e.len, s); }

  geo(e: NEdge): EdgeGeo {
    const c = this.geoCache.get(e.id);
    if (c && c.v === e.version) return c.g;
    const tab = this.table(e);
    const len = tab.len;
    const step = Math.max(0.25, len / 1500);
    const n = Math.max(2, Math.ceil(len / step) + 1);
    const pts = new Float32Array(n * 3), s = new Float32Array(n), tan = new Float32Array(n * 2);
    const p = { x: 0, z: 0 }, d = { x: 0, z: 0 };
    for (let i = 0; i < n; i++) {
      const si = Math.min(i * step, len);
      const t = tAtS(tab, si);
      bezPoint(e.bez, t, p);
      bezDeriv(e.bez, t, d);
      const l = Math.hypot(d.x, d.z) || 1;
      pts[i * 3] = p.x; pts[i * 3 + 1] = profAt(e.prof, len, si); pts[i * 3 + 2] = p.z;
      s[i] = si;
      tan[i * 2] = d.x / l; tan[i * 2 + 1] = d.z / l;
    }
    const g: EdgeGeo = { n, pts, cum: s, tan, len, minRadius: bezMinRadius(e.bez) };
    this.geoCache.set(e.id, { v: e.version, g });
    return g;
  }

  /** Position (and tangent) at arc length s. */
  pointAt(e: NEdge, s: number, out: Vec3Like, dir?: Vec3Like) {
    curvePoint(this.geo(e), s, out, dir);
  }

  sectionAt(e: NEdge, s: number): 'ground' | 'bridge' | 'tunnel' {
    for (const sec of e.sections) if (s >= sec.s0 && s <= sec.s1) return sec.type;
    return 'ground';
  }

  // ---------------------------------------------------------------- split
  /** Split an edge at arc length s; returns the new node and the two halves. */
  splitEdge(id: number, s: number): { node: NNode; e1: NEdge; e2: NEdge } | null {
    const e = this.edges.get(id);
    if (!e || s <= 0.05 || s >= e.len - 0.05) return null;
    const tab = this.table(e);
    const t = tAtS(tab, s);
    const [b1, b2] = bezSplit(e.bez, t);
    const p = bezPoint(e.bez, t), d = bezDeriv(e.bez, t);
    const dl = Math.hypot(d.x, d.z) || 1;
    const y = this.heightAtS(e, s);
    const node = this.addNode(e.kind, p.x, y, p.z, e.kind === 'rail' ? d.x / dl : 0, e.kind === 'rail' ? d.z / dl : 0, e.owner);
    const prof1 = resampleProfile(e.prof, e.len, 0, s), prof2 = resampleProfile(e.prof, e.len, s, e.len);
    const sec1: Section[] = [], sec2: Section[] = [];
    for (const sec of e.sections) {
      if (sec.s0 < s) sec1.push({ s0: sec.s0, s1: Math.min(sec.s1, s), type: sec.type });
      if (sec.s1 > s) sec2.push({ s0: Math.max(0, sec.s0 - s), s1: sec.s1 - s, type: sec.type });
    }
    const extra: Partial<NEdge> = { station: e.station, depot: e.depot };
    if (e.tram) { extra.tram = true; extra.tramOwner = e.tramOwner; }
    // detach the old edge without triggering removal side effects on nodes
    const na = this.nodes.get(e.a)!, nb = this.nodes.get(e.b)!;
    const crossings = [...this.crossings.values()].filter((c) => c.e1 === id || c.e2 === id);
    this.markEdge(e);
    this.edges.delete(id);
    this.grid.remove(id);
    this.geoCache.delete(id);
    this.tables.delete(id);
    na.edges = na.edges.filter((x) => x !== id);
    nb.edges = nb.edges.filter((x) => x !== id);
    const e1 = this.addEdge(e.kind, e.a, node.id, b1, prof1, sec1, e.type, e.owner, extra);
    const e2 = this.addEdge(e.kind, node.id, e.b, b2, prof2, sec2, e.type, e.owner, extra);
    // preserve the original sides at the outer nodes
    e1.sa = e.sa; e2.sb = e.sb;
    for (const c of crossings) {
      if (c.e1 === id) { if (c.s1 < s) { c.e1 = e1.id; } else { c.e1 = e2.id; c.s1 -= s; } }
      if (c.e2 === id) { if (c.s2 < s) { c.e2 = e1.id; } else { c.e2 = e2.id; c.s2 -= s; } }
    }
    for (const l of this.onSplit) l(e, e1, e2, s);
    this.version++;
    return { node, e1, e2 };
  }

  /** Merge node `from` into node `into` (same position); used for at-grade junctions. */
  mergeNodes(into: number, from: number) {
    const A = this.nodes.get(into)!, B = this.nodes.get(from)!;
    for (const eid of B.edges) {
      const e = this.edges.get(eid)!;
      if (e.a === from) e.a = into;
      if (e.b === from) e.b = into;
      A.edges.push(eid);
    }
    // snap all edge endpoints exactly onto the merged node
    for (const eid of A.edges) {
      const e = this.edges.get(eid)!;
      if (e.a === into) { const dx = A.x - e.bez.x0, dz = A.z - e.bez.z0; e.bez.x0 += dx; e.bez.z0 += dz; e.bez.x1 += dx; e.bez.z1 += dz; }
      if (e.b === into) { const dx = A.x - e.bez.x3, dz = A.z - e.bez.z3; e.bez.x3 += dx; e.bez.z3 += dz; e.bez.x2 += dx; e.bez.z2 += dz; }
      this.tables.delete(eid);
      e.len = this.table(e).len;
      this.touchEdge(e);
    }
    B.edges = [];
    this.nodes.delete(from);
    this.nodeGrid.remove(from);
    this.version++;
  }

  // ---------------------------------------------------------------- queries
  nearestNode(x: number, z: number, r: number, kind: NetKind, pred?: (n: NNode) => boolean): NNode | null {
    let best: NNode | null = null, bd = r;
    for (const id of this.nodeGrid.query(x - r, z - r, x + r, z + r)) {
      const n = this.nodes.get(id);
      if (!n || n.kind !== kind) continue;
      if (pred && !pred(n)) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  nearestEdge(x: number, z: number, r: number, kind?: NetKind, pred?: (e: NEdge) => boolean): { edge: NEdge; s: number; d: number } | null {
    let best: { edge: NEdge; s: number; d: number } | null = null;
    for (const id of this.grid.query(x - r, z - r, x + r, z + r)) {
      const e = this.edges.get(id);
      if (!e || (kind && e.kind !== kind)) continue;
      if (pred && !pred(e)) continue;
      const g = this.geo(e);
      const c = closestOnPolyline(x, z, g.pts, 3, g.n);
      if (c.d > r || (best && c.d >= best.d)) continue;
      const s = g.cum[c.i] + (g.cum[Math.min(g.n - 1, c.i + 1)] - g.cum[c.i]) * c.f;
      best = { edge: e, s, d: c.d };
    }
    return best;
  }

  edgesNear(x0: number, z0: number, x1: number, z1: number): NEdge[] {
    return this.grid.query(x0, z0, x1, z1).map((id) => this.edges.get(id)!).filter(Boolean);
  }

  /** Half width of an edge's formation (for clearance checks and rendering). */
  halfWidth(e: NEdge): number {
    if (e.kind === 'rail') return 0.32;
    const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
    return rt.half + rt.sidewalk;
  }

  /** Road junction radius at a node (0 for continuous joints). */
  junctionRadius(nodeId: number): number {
    const n = this.nodes.get(nodeId);
    if (!n || n.kind !== 'road') return 0;
    const deg = n.edges.length;
    if (deg <= 1) return 0;
    let maxHw = 0;
    for (const eid of n.edges) { const e = this.edges.get(eid); if (e) maxHw = Math.max(maxHw, this.halfWidth(e)); }
    if (deg === 2) {
      const e1 = this.edges.get(n.edges[0])!, e2 = this.edges.get(n.edges[1])!;
      const d1 = this.leaveDir(e1, nodeId), d2 = this.leaveDir(e2, nodeId);
      const dot = d1.x * d2.x + d1.z * d2.z;
      if (dot < -0.92) return 0;
      return maxHw * 1.05;
    }
    return maxHw * 1.2;
  }

  /** Lane curve for a road edge travelled in direction dir, trimmed at junctions. */
  lane(e: NEdge, dir: number): Curve3 {
    const ra = this.junctionRadius(e.a), rb = this.junctionRadius(e.b);
    const key = e.id + ':' + dir + ':' + ra.toFixed(3) + ':' + rb.toFixed(3);
    const c = this.laneCache.get(key);
    if (c && c.v === e.version) return c.c;
    const g = this.geo(e);
    const s0 = Math.min(ra, e.len * 0.45), s1 = Math.max(e.len - rb, e.len * 0.55);
    const off = dir > 0 ? LANE_OFFSET : -LANE_OFFSET;
    const pts: number[] = [];
    const add = (i: number, si: number) => {
      const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
      curvePoint(g, si, p, d);
      const l = Math.hypot(d.x, d.z) || 1;
      pts.push(p.x - (d.z / l) * off, p.y, p.z + (d.x / l) * off);
      void i;
    };
    add(0, s0);
    for (let i = 0; i < g.n; i++) if (g.cum[i] > s0 + 0.05 && g.cum[i] < s1 - 0.05) add(i, g.cum[i]);
    add(0, s1);
    if (dir < 0) {
      const r: number[] = [];
      for (let i = pts.length / 3 - 1; i >= 0; i--) r.push(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]);
      pts.length = 0; pts.push(...r);
    }
    const curve = makeCurve(pts);
    this.laneCache.set(key, { v: e.version, c: curve });
    if (this.laneCache.size > 20000) this.laneCache.clear();
    return curve;
  }

  /** Travel continuations at the node reached when traversing e in direction dir. */
  nextRail(e: NEdge, dir: number): { edge: NEdge; dir: number; node: NNode }[] {
    const nodeId = dir > 0 ? e.b : e.a;
    const node = this.nodes.get(nodeId)!;
    const arriveSide = dir > 0 ? e.sb : e.sa;
    const out: { edge: NEdge; dir: number; node: NNode }[] = [];
    for (const fid of node.edges) {
      if (fid === e.id) continue;
      const f = this.edges.get(fid)!;
      const side = f.a === nodeId ? f.sa : f.sb;
      if (side !== -arriveSide) continue;
      out.push({ edge: f, dir: f.a === nodeId ? 1 : -1, node });
    }
    return out;
  }

  /** Signal state for a train leaving `node` along an edge on side `side`: 0 none, 1 facing, -1 blocked. */
  signalFor(node: NNode, side: number): number {
    const s = node.signal;
    if (!s) return 0;
    if (s === 1) return 1;
    if (s === 2) return side > 0 ? 1 : -1;
    return side < 0 ? 1 : -1;
  }

  clearCaches() { this.geoCache.clear(); this.laneCache.clear(); }
}
