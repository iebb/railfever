// Shared helpers for the static world builders: chunk membership, edge sampling, profile sweeps.
import type { Game } from '../game/game';
import type { Network, NEdge, NNode, EdgeGeo } from '../game/network';
import { OBJ_CHUNK } from '../game/world';
import type { WB } from './build-mesh';
import type { FacadeBuilder } from './build-buildings';
import type { TreeInstance } from './trees';
import type { RailPart } from '../game/stations';
import { railWidth } from '../game/stations';

/**
 * One object chunk being built: bounds plus the builders/collectors objects add into.
 * `w`: world material, ground pieces (cast = 0) and tall structures (cast = 1);
 * `d`: small detail (rails, masts, lamps, furniture) hidden at a distance, never casting;
 * `fac`: facade-atlas walls.
 */
export interface ChunkCtx {
  game: Game;
  ci: number;
  /** chunks per side */
  n: number;
  x0: number; z0: number; x1: number; z1: number;
  w: WB;
  d: WB;
  fac: FacadeBuilder;
  /** night light glow points (x,y,z triples) */
  lights: number[];
  /** signal lamps whose colour follows the reservation of `edge` */
  sigLamps: SignalLamp[];
  /** level crossing barriers */
  booms: Boom[];
  /** level crossing warning lights */
  xLights: XLight[];
  trees: TreeInstance[];
  /** platform edges of underground / elevated stations (their tunnels / viaducts are the station's) */
  stationEdges?: Map<number, StationLevel>;
}

/** Level of a rail station: on the ground, on a viaduct, or underground. */
export type StationLevel = 'ground' | 'elevated' | 'underground';
/** Station entrance on the surface (underground: pavilion with stairs; elevated: stair / lift tower). */
export interface StationEntrance { x: number; z: number; angle: number }
/** RailPart with the (optional) level fields of underground / elevated stations. */
export type RailPartX = RailPart & {
  level?: StationLevel; underground?: boolean; depth?: number; height?: number;
  entrances?: StationEntrance[];
  /** pier footprints chosen by the game (elevated), if any */
  piers?: { x: number; z: number }[];
};

export function stationLevelOf(r: RailPart): StationLevel {
  const x = r as RailPartX;
  return x.level ?? (x.underground ? 'underground' : 'ground');
}

/** Ground station building (beside the tracks, entrance facing away) and the forecourt in front of it. */
export interface StationFrame {
  bx: number; bz: number;
  /** entrance direction (away from the tracks) */
  ex: number; ez: number;
  /** building length (along the tracks) and depth */
  BL: number; BD: number;
  /** forecourt centre and size (across the entrance, outwards) */
  cx: number; cz: number; cw: number; cd: number;
}

export function stationFrame(r: RailPart): StationFrame {
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
  const b = r.building;
  const bfx = Math.sin(b.angle), bfz = Math.cos(b.angle), brx = bfz, brz = -bfx;
  const extAlong = Math.abs(brx * fx + brz * fz) * b.w + Math.abs(bfx * fx + bfz * fz) * b.d;
  const extAcross = Math.abs(brx * rx + brz * rz) * b.w + Math.abs(bfx * rx + bfz * rz) * b.d;
  const BL = Math.max(extAlong, extAcross), BD = Math.max(0.7, Math.min(extAlong, extAcross));
  const side = ((b.x - r.x) * rx + (b.z - r.z) * rz) >= 0 ? 1 : -1;
  const width = railWidth(r);
  const along = (b.x - r.x) * fx + (b.z - r.z) * fz;
  const off = side * (width / 2 + BD / 2 + 0.15);
  const bx = r.x + rx * off + fx * along, bz = r.z + rz * off + fz * along;
  const ex = rx * side, ez = rz * side;
  const cd = 0.7;
  return { bx, bz, ex, ez, BL, BD, cx: bx + ex * (BD / 2 + cd / 2), cz: bz + ez * (BD / 2 + cd / 2), cw: BL + 0.4, cd };
}

/** Is (x,z) on (or within `margin` of) the forecourt of a ground station? (access streets end there) */
export function onStationForecourt(game: Game, x: number, z: number, margin: number): boolean {
  for (const st of game.stations.map.values()) {
    const r = st.rail;
    if (!r || stationLevelOf(r) !== 'ground') continue;
    if (Math.abs(r.x - x) > r.length + 6 || Math.abs(r.z - z) > r.length + 6) continue;
    const f = stationFrame(r);
    const dx = x - f.cx, dz = z - f.cz;
    const a = dx * f.ez - dz * f.ex, b = dx * f.ex + dz * f.ez; // across, outwards
    if (Math.abs(a) <= f.cw / 2 + margin && Math.abs(b) <= f.cd / 2 + margin) return true;
  }
  return false;
}

/** Platform edges of the game's underground and elevated stations. */
export function stationEdgeLevels(game: Game): Map<number, StationLevel> {
  const out = new Map<number, StationLevel>();
  for (const st of game.stations.map.values()) {
    if (!st.rail) continue;
    const lv = stationLevelOf(st.rail);
    if (lv !== 'ground') for (const id of [...st.rail.edges, ...(st.rail.throughEdges ?? [])]) out.set(id, lv);
  }
  return out;
}

export interface SignalLamp { x: number; y: number; z: number; edge: number }
/** Barrier boom: pivot, direction across the road when lowered (unit xz), length. */
export interface Boom { crossing: number; x: number; y: number; z: number; dx: number; dz: number; len: number }
export interface XLight { crossing: number; x: number; y: number; z: number; phase: number }

export function chunkIndexOf(x: number, z: number, n: number): number {
  let cx = Math.floor(x / OBJ_CHUNK), cz = Math.floor(z / OBJ_CHUNK);
  cx = cx < 0 ? 0 : cx >= n ? n - 1 : cx;
  cz = cz < 0 ? 0 : cz >= n ? n - 1 : cz;
  return cz * n + cx;
}

export function inChunk(ctx: ChunkCtx, x: number, z: number) { return chunkIndexOf(x, z, ctx.n) === ctx.ci; }

// ------------------------------------------------------------------------------ edge samples

/** A sample along an edge: arc length, position and unit horizontal tangent; lateral `lx,lz` (right, possibly mitred). */
export interface Smp { s: number; x: number; y: number; z: number; tx: number; tz: number; lx: number; lz: number }

const simpCache = new WeakMap<EdgeGeo, number[]>();

/** Indices of geo samples needed to represent the curve within a small tolerance (cached per geo). */
export function simplifiedIndices(g: EdgeGeo): number[] {
  const c = simpCache.get(g);
  if (c) return c;
  const out = [0];
  const p = g.pts, t = g.tan;
  let last = 0;
  for (let i = 1; i < g.n - 1; i++) {
    const ds = g.cum[i + 1] - g.cum[last];
    const dot = t[last * 2] * t[(i + 1) * 2] + t[last * 2 + 1] * t[(i + 1) * 2 + 1];
    // grade change between the last kept segment and the next one
    const g0 = (p[i * 3 + 1] - p[last * 3 + 1]) / Math.max(1e-6, g.cum[i] - g.cum[last]);
    const g1 = (p[(i + 1) * 3 + 1] - p[i * 3 + 1]) / Math.max(1e-6, g.cum[i + 1] - g.cum[i]);
    if (ds > 2.5 || dot < 0.99985 || Math.abs(g1 - g0) * Math.min(ds, 2) > 0.002) { out.push(i); last = i; }
  }
  out.push(g.n - 1);
  simpCache.set(g, out);
  return out;
}

/** Sample at arc length s (interpolated between geo samples). */
export function sampleAt(g: EdgeGeo, s: number, out?: Smp): Smp {
  const n = g.n;
  if (s < 0) s = 0;
  if (s > g.len) s = g.len;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (g.cum[m] <= s) lo = m; else hi = m; }
  const seg = g.cum[hi] - g.cum[lo];
  const f = seg > 1e-9 ? (s - g.cum[lo]) / seg : 0;
  const p = g.pts, t = g.tan;
  let tx = t[lo * 2] + (t[hi * 2] - t[lo * 2]) * f, tz = t[lo * 2 + 1] + (t[hi * 2 + 1] - t[lo * 2 + 1]) * f;
  const tl = Math.hypot(tx, tz) || 1;
  tx /= tl; tz /= tl;
  const o = out ?? { s: 0, x: 0, y: 0, z: 0, tx: 0, tz: 0, lx: 0, lz: 0 };
  o.s = s;
  o.x = p[lo * 3] + (p[hi * 3] - p[lo * 3]) * f;
  o.y = p[lo * 3 + 1] + (p[hi * 3 + 1] - p[lo * 3 + 1]) * f;
  o.z = p[lo * 3 + 2] + (p[hi * 3 + 2] - p[lo * 3 + 2]) * f;
  o.tx = tx; o.tz = tz; o.lx = -tz; o.lz = tx;
  return o;
}

function smpOf(g: EdgeGeo, i: number): Smp {
  const tx = g.tan[i * 2], tz = g.tan[i * 2 + 1];
  return { s: g.cum[i], x: g.pts[i * 3], y: g.pts[i * 3 + 1], z: g.pts[i * 3 + 2], tx, tz, lx: -tz, lz: tx };
}

/** Lateral (mitre) vector at an edge end so that strips of two edges meeting at a degree-2 node join seamlessly. */
export function mitre(net: Network, e: NEdge, nodeId: number): { x: number; z: number } | null {
  const node = net.nodes.get(nodeId);
  if (!node || node.edges.length !== 2) return null;
  const fid = node.edges[0] === e.id ? node.edges[1] : node.edges[0];
  const f = net.edges.get(fid);
  if (!f || f.kind !== e.kind || fid === e.id) return null;
  const d1 = net.leaveDir(e, nodeId), d2 = net.leaveDir(f, nodeId);
  let mx = d1.x - d2.x, mz = d1.z - d2.z;
  const ml = Math.hypot(mx, mz);
  if (ml < 1e-6) return null;
  mx /= ml; mz /= ml;
  const c = mx * d1.x + mz * d1.z;
  if (c < 0.5) return null; // too sharp: no mitre
  const k = 1 / c;
  return e.a === nodeId ? { x: -mz * k, z: mx * k } : { x: mz * k, z: -mx * k };
}

/**
 * Runs of samples of edge `e` between arc lengths [sa, sb] whose segments have their midpoint inside the chunk.
 * End laterals can be overridden (mitre joints) when the run starts at s = 0 or ends at s = len.
 */
export function edgeRuns(ctx: ChunkCtx, e: NEdge, sa: number, sb: number, mitreA?: { x: number; z: number } | null, mitreB?: { x: number; z: number } | null): Smp[][] {
  const net = ctx.game.world.net;
  const g = net.geo(e);
  if (sb - sa < 1e-4) return [];
  const idx = simplifiedIndices(g);
  const list: Smp[] = [];
  const first = sampleAt(g, sa), last = sampleAt(g, sb);
  // a mitred end moves offset points along the track: keep inner samples clear of it (no folded strips)
  const shift = (m: { x: number; z: number }, p: Smp) => Math.abs((m.x - p.lx) * p.tx + (m.z - p.lz) * p.tz);
  const exA = 0.02 + (mitreA && sa <= 1e-6 ? 1.2 * shift(mitreA, first) : 0);
  const exB = 0.02 + (mitreB && sb >= e.len - 1e-6 ? 1.2 * shift(mitreB, last) : 0);
  list.push(first);
  for (const i of idx) { const s = g.cum[i]; if (s > sa + exA && s < sb - exB) list.push(smpOf(g, i)); }
  list.push(last);
  if (mitreA && sa <= 1e-6) { list[0].lx = mitreA.x; list[0].lz = mitreA.z; }
  if (mitreB && sb >= e.len - 1e-6) { const l = list[list.length - 1]; l.lx = mitreB.x; l.lz = mitreB.z; }
  const runs: Smp[][] = [];
  let cur: Smp[] | null = null;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i], b = list[i + 1];
    const mine = chunkIndexOf((a.x + b.x) / 2, (a.z + b.z) / 2, ctx.n) === ctx.ci;
    if (mine) {
      if (!cur) { cur = [a]; runs.push(cur); }
      cur.push(b);
    } else cur = null;
  }
  return runs;
}

/** Split runs at section boundaries: returns pieces with their section type. */
export function splitBySections(net: Network, e: NEdge, s0: number, s1: number): { s0: number; s1: number; type: 'ground' | 'bridge' | 'tunnel' }[] {
  const cuts = [s0, s1];
  for (const sec of e.sections) { if (sec.s0 > s0 && sec.s0 < s1) cuts.push(sec.s0); if (sec.s1 > s0 && sec.s1 < s1) cuts.push(sec.s1); }
  cuts.sort((a, b) => a - b);
  const out: { s0: number; s1: number; type: 'ground' | 'bridge' | 'tunnel' }[] = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    if (cuts[i + 1] - cuts[i] < 1e-4) continue;
    const m = (cuts[i] + cuts[i + 1]) / 2;
    const type = net.sectionAt(e, m);
    const last = out[out.length - 1];
    if (last && last.type === type && Math.abs(last.s1 - cuts[i]) < 1e-6) last.s1 = cuts[i + 1];
    else out.push({ s0: cuts[i], s1: cuts[i + 1], type });
  }
  return out;
}

// ------------------------------------------------------------------------------ sweeps

/** Cross-section point: lateral offset l (right +), height h above the curve, texture u. */
export type PP = [number, number, number?];

/**
 * Sweep a cross-section profile (ordered left to right over the top so faces point up/outwards)
 * along a run of samples. Flat-shaded across the profile, smooth along the run.
 * uv: u from the profile point, v = s / vScale (when the builder has uvs).
 */
export function sweep(gb: WB, run: Smp[], prof: PP[], vScale = 1, yOff = 0) {
  const n = run.length;
  if (n < 2 || prof.length < 2) return;
  for (let k = 0; k < prof.length - 1; k++) {
    const [la, ha, ua = 0] = prof[k];
    const [lb, hb, ub = 1] = prof[k + 1];
    const dl = lb - la, dh = hb - ha;
    const el = Math.sqrt(dl * dl + dh * dh) || 1;
    // face normal = dl*up - dh*right (see derivation in build notes)
    const nu = dl / el, nr = -dh / el;
    const base = gb.vertexCount;
    for (let i = 0; i < n; i++) {
      const p = run[i];
      const v = p.s / vScale;
      const nx = p.lx * nr, nz = p.lz * nr;
      const nl = Math.sqrt(nx * nx + nu * nu + nz * nz) || 1;
      gb.vertex(p.x + p.lx * la, p.y + ha + yOff, p.z + p.lz * la, nx / nl, nu / nl, nz / nl, ua, v);
      gb.vertex(p.x + p.lx * lb, p.y + hb + yOff, p.z + p.lz * lb, nx / nl, nu / nl, nz / nl, ub, v);
    }
    // vertices per sample: (a, b); quad between sample i and i+1: A=a_i, B=b_i, C=b_{i+1}, D=a_{i+1}
    for (let i = 0; i < n - 1; i++) {
      const a = base + i * 2;
      gb.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
    }
  }
}

/** Upward-facing triangle (winding fixed so the normal points up), planar uvs at scale sc. */
export function upTri(gb: WB, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, sc = 1) {
  gb.ptri(ax, ay, az, bx, by, bz, cx, cy, cz, sc);
}

/** Vertical quad wall between bottom points a and b facing (nx,nz) (winding fixed), world uvs. */
export function wallQuad(gb: WB, ax: number, az: number, bx: number, bz: number, y0a: number, y1a: number, y0b: number, y1b: number, nx: number, nz: number, sc = 1) {
  const l = Math.hypot(nx, nz) || 1;
  gb.twall(ax, az, bx, bz, y0a, y1a, y0b, y1b, nx / l, nz / l, sc);
}

/** Node helpers. */
export function otherEdges(net: Network, node: NNode, except: number): NEdge[] {
  const out: NEdge[] = [];
  for (const id of node.edges) if (id !== except) { const e = net.edges.get(id); if (e) out.push(e); }
  return out;
}

export function hexToInt(c: string): number {
  const v = parseInt(c.replace('#', ''), 16);
  return isNaN(v) ? 0x888888 : v;
}
