// Free-form construction planner for tracks and roads.
import type { Game } from './game';
import { NetKind, RAIL, ROAD_TYPES, TRACK_TYPES, PSTEP, WATER_Y } from './constants';
import {
  Bez, bezFromTangents, bezLine, bezOffset, bezMinRadius, arcTable, tAtS, bezPoint, bezDeriv, segIntersect, angleBetween, V2,
} from './geom';
import { NEdge, NNode, Section, profAt } from './network';
import { applyEarthworks, recomputeLocks } from './terraform';
import { distToRect } from './world';

export interface Snap {
  kind: 'free' | 'node' | 'edge';
  x: number; z: number; y: number;
  node?: number;
  edge?: number;
  s?: number;
  /** parallel group of nodes (ordered left to right of the group direction) */
  group?: number[];
}

export interface BuildOptions {
  kind: NetKind;
  type: string;
  tracks: number;
  heightOffset: number;
  crossing: 'auto' | 'over' | 'under' | 'level';
  owner: number;
  /** towns build for free and never demolish */
  town?: boolean;
}

export interface CrossingPlan {
  track: number;
  sNew: number;   // along the new track
  edge: number;
  sOld: number;
  x: number; z: number;
  mode: 'level' | 'diamond' | 'junction' | 'over' | 'under';
  angle: number;
}

export interface TrackPlan {
  bez: Bez;
  len: number;
  prof: Float32Array;
  sections: Section[];
  start: Snap;
  end: Snap;
}

export interface Proposal {
  ok: boolean;
  errors: string[];
  warnings: string[];
  opts: BuildOptions;
  tracks: TrackPlan[];
  crossings: CrossingPlan[];
  demolish: number[];
  trees: number;
  cost: number;
  stats: { len: number; maxGrade: number; minRadius: number; bridges: number; tunnels: number; speed: number };
}

const BRIDGE_H = 1.1;   // >11 m above ground -> bridge
const TUNNEL_D = 1.9;   // >19 m below ground -> tunnel
const WATER_DECK = 0.9;

function maxGradeOf(o: BuildOptions) {
  return o.kind === 'rail' ? (TRACK_TYPES[o.type] ?? TRACK_TYPES.standard).maxGrade : (ROAD_TYPES[o.type] ?? ROAD_TYPES.road).maxGrade;
}
function minRadiusOf(o: BuildOptions) {
  return o.kind === 'rail' ? (TRACK_TYPES[o.type] ?? TRACK_TYPES.standard).minRadius : (ROAD_TYPES[o.type] ?? ROAD_TYPES.road).minRadius;
}
function halfWidthOf(o: BuildOptions) {
  if (o.kind === 'rail') return 0.32;
  const rt = ROAD_TYPES[o.type] ?? ROAD_TYPES.road;
  return rt.half + rt.sidewalk;
}

/** Speed limit (km/h) for a curve radius in world units. */
export function curveSpeed(radius: number): number {
  if (!isFinite(radius)) return 999;
  return 4.3 * Math.sqrt(radius * 10);
}

// ------------------------------------------------------------------------------------ snapping

/** Parallel siblings of a rail end node: other free ends side by side with the same direction
 *  (standard spacing on plain track, wider spacing at station throats). */
export function nodeGroup(g: Game, nodeId: number): number[] {
  const net = g.world.net;
  const n = net.nodes.get(nodeId);
  if (!n || n.kind !== 'rail') return [nodeId];
  const free = freeSide(g, n);
  if (free === 0) return [nodeId];
  const rx = -n.dz, rz = n.dx;
  const members: { id: number; off: number }[] = [{ id: n.id, off: 0 }];
  for (const id of net.nodeGrid.query(n.x - 6, n.z - 6, n.x + 6, n.z + 6)) {
    if (id === n.id) continue;
    const m = net.nodes.get(id)!;
    if (m.kind !== 'rail' || Math.abs(m.dx * n.dx + m.dz * n.dz) < 0.995) continue;
    const dx = m.x - n.x, dz = m.z - n.z;
    const along = dx * n.dx + dz * n.dz, lat = dx * rx + dz * rz;
    if (Math.abs(along) > 0.2 || Math.abs(lat) < 0.3) continue;
    // the sibling's free side must point the same way
    const fs = freeSide(g, m) * Math.sign(m.dx * n.dx + m.dz * n.dz);
    if (fs !== free) continue;
    members.push({ id, off: lat });
  }
  members.sort((a, b) => a.off - b.off);
  const idx = members.findIndex((m) => m.id === n.id);
  const gapOk = (a: number, b: number) => { const d = members[b].off - members[a].off; return d > RAIL.spacing - 0.08 && d < 1.3; };
  let lo = idx, hi = idx;
  while (lo > 0 && gapOk(lo - 1, lo)) lo--;
  while (hi < members.length - 1 && gapOk(hi, hi + 1)) hi++;
  const out = members.slice(lo, hi + 1).map((m) => m.id);
  // order left->right relative to the direction the new track will leave in
  if (free < 0) out.reverse();
  return out;
}

/** N contiguous members of a group around one of its nodes. */
function groupWindow(group: number[], nodeId: number, N: number): number[] {
  if (group.length <= N) return group;
  const idx = Math.max(0, group.indexOf(nodeId));
  const lo = Math.max(0, Math.min(group.length - N, idx - Math.floor((N - 1) / 2)));
  return group.slice(lo, lo + N);
}

/** Free side of a rail node: +1/-1 if all edges are on the other side, 0 if both sides used. */
export function freeSide(g: Game, n: NNode): number {
  const net = g.world.net;
  let plus = false, minus = false;
  for (const eid of n.edges) {
    const e = net.edges.get(eid)!;
    if (net.sideAt(e, n.id) > 0) plus = true; else minus = true;
  }
  if (plus && minus) return 0;
  if (plus) return -1;
  if (minus) return 1;
  return 1;
}

export function findSnap(g: Game, kind: NetKind, x: number, z: number, radius = 1.2): Snap {
  const w = g.world;
  const net = w.net;
  const node = net.nearestNode(x, z, radius, kind, (n) => n.edges.length > 0);
  if (node) return { kind: 'node', x: node.x, z: node.z, y: node.y, node: node.id, group: kind === 'rail' ? nodeGroup(g, node.id) : [node.id] };
  const ne = net.nearestEdge(x, z, radius * 0.8, kind, (e) => e.depot < 0);
  if (ne) {
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, p);
    // snap to an existing node if very close to an edge end
    if (ne.s < 0.6) { const n = net.nodes.get(ne.edge.a)!; return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [n.id] }; }
    if (ne.s > ne.edge.len - 0.6) { const n = net.nodes.get(ne.edge.b)!; return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [n.id] }; }
    return { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: ne.edge.id, s: ne.s };
  }
  return { kind: 'free', x, z, y: w.heightAt(x, z) };
}

// ------------------------------------------------------------------------------------ geometry

interface Frame { x: number; z: number; tx: number; tz: number; fixed: boolean; y: number | null }

/** Start frame: position and outgoing tangent. */
function startFrame(g: Game, sn: Snap, toward: V2, kind: NetKind): Frame {
  const net = g.world.net;
  const cx = toward.x - sn.x, cz = toward.z - sn.z;
  const cl = Math.hypot(cx, cz) || 1;
  if (sn.kind === 'node') {
    const n = net.nodes.get(sn.node!)!;
    if (kind === 'rail') {
      let side = freeSide(g, n);
      if (side === 0 || n.edges.length === 0) side = cx * n.dx + cz * n.dz >= 0 ? 1 : -1;
      return { x: n.x, z: n.z, tx: n.dx * side, tz: n.dz * side, fixed: true, y: n.y };
    }
    if (n.edges.length === 1) {
      const e = net.edges.get(n.edges[0])!;
      const d = net.leaveDir(e, n.id);
      return { x: n.x, z: n.z, tx: -d.x, tz: -d.z, fixed: true, y: n.y };
    }
    return { x: n.x, z: n.z, tx: cx / cl, tz: cz / cl, fixed: false, y: n.y };
  }
  if (sn.kind === 'edge') {
    const e = net.edges.get(sn.edge!)!;
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(e, sn.s!, p, d);
    const l = Math.hypot(d.x, d.z) || 1;
    if (kind === 'rail') {
      const sg = cx * d.x + cz * d.z >= 0 ? 1 : -1;
      return { x: p.x, z: p.z, tx: (d.x / l) * sg, tz: (d.z / l) * sg, fixed: true, y: p.y };
    }
    return { x: p.x, z: p.z, tx: cx / cl, tz: cz / cl, fixed: false, y: p.y };
  }
  return { x: sn.x, z: sn.z, tx: cx / cl, tz: cz / cl, fixed: false, y: null };
}

/** End frame: position and arriving tangent (direction of travel at the end). */
function endFrame(g: Game, sn: Snap, from: V2, kind: NetKind): Frame {
  const net = g.world.net;
  const cx = sn.x - from.x, cz = sn.z - from.z;
  const cl = Math.hypot(cx, cz) || 1;
  if (sn.kind === 'node') {
    const n = net.nodes.get(sn.node!)!;
    if (kind === 'rail') {
      const free = freeSide(g, n);
      // the new edge attaches on the free side, so we arrive travelling against it
      let tx = -free * n.dx, tz = -free * n.dz;
      if (free === 0) { const sg = cx * n.dx + cz * n.dz >= 0 ? 1 : -1; tx = n.dx * sg; tz = n.dz * sg; }
      return { x: n.x, z: n.z, tx, tz, fixed: true, y: n.y };
    }
    if (n.edges.length === 1) {
      const e = net.edges.get(n.edges[0])!;
      const d = net.leaveDir(e, n.id);
      return { x: n.x, z: n.z, tx: d.x, tz: d.z, fixed: true, y: n.y };
    }
    return { x: n.x, z: n.z, tx: cx / cl, tz: cz / cl, fixed: false, y: n.y };
  }
  if (sn.kind === 'edge') {
    const e = net.edges.get(sn.edge!)!;
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(e, sn.s!, p, d);
    const l = Math.hypot(d.x, d.z) || 1;
    if (kind === 'rail') {
      const sg = cx * d.x + cz * d.z >= 0 ? 1 : -1;
      return { x: p.x, z: p.z, tx: (d.x / l) * sg, tz: (d.z / l) * sg, fixed: true, y: p.y };
    }
    return { x: p.x, z: p.z, tx: cx / cl, tz: cz / cl, fixed: false, y: p.y };
  }
  return { x: sn.x, z: sn.z, tx: cx / cl, tz: cz / cl, fixed: false, y: null };
}

/** Bezier connecting two frames (circular-arc-like when only one tangent is fixed). */
export function fitCurve(a: Frame, b: Frame): Bez {
  const cx = b.x - a.x, cz = b.z - a.z;
  const chord = Math.hypot(cx, cz) || 1e-6;
  const ux = cx / chord, uz = cz / chord;
  let ta = { x: a.tx, z: a.tz }, tb = { x: b.tx, z: b.tz };
  if (a.fixed && !b.fixed) {
    const dp = ta.x * ux + ta.z * uz;
    tb = { x: 2 * dp * ux - ta.x, z: 2 * dp * uz - ta.z };
  } else if (!a.fixed && b.fixed) {
    const dp = tb.x * ux + tb.z * uz;
    ta = { x: 2 * dp * ux - tb.x, z: 2 * dp * uz - tb.z };
  } else if (!a.fixed && !b.fixed) {
    return bezLine(a.x, a.z, b.x, b.z);
  }
  const phi = angleBetween(ta.x, ta.z, tb.x, tb.z);
  const c = Math.cos(phi / 4);
  let k = chord / (3 * c * c);
  // S-curves and sharp reversals need longer handles
  if (ta.x * ux + ta.z * uz < 0.2 || tb.x * ux + tb.z * uz < 0.2) k = chord * 0.45;
  return bezFromTangents(a.x, a.z, ta.x, ta.z, b.x, b.z, tb.x, tb.z, k, k);
}

// ------------------------------------------------------------------------------------ profile

interface Constraint { i: number; kind: 'eq' | 'ge' | 'le'; v: number }

/** Grade-limited height profile through constraints, following the desired heights. */
function solveProfile(desired: number[], ds: number[], cons: Constraint[], g: number): { y: number[]; ok: boolean; bad: number } {
  const n = desired.length;
  const lo = new Array(n).fill(-1e9), hi = new Array(n).fill(1e9);
  for (const c of cons) {
    if (c.kind !== 'le') lo[c.i] = Math.max(lo[c.i], c.v);
    if (c.kind !== 'ge') hi[c.i] = Math.min(hi[c.i], c.v);
  }
  // Lipschitz envelopes
  for (let i = 1; i < n; i++) { hi[i] = Math.min(hi[i], hi[i - 1] + g * ds[i]); lo[i] = Math.max(lo[i], lo[i - 1] - g * ds[i]); }
  for (let i = n - 2; i >= 0; i--) { hi[i] = Math.min(hi[i], hi[i + 1] + g * ds[i + 1]); lo[i] = Math.max(lo[i], lo[i + 1] - g * ds[i + 1]); }
  let ok = true, bad = -1;
  for (let i = 0; i < n; i++) if (lo[i] > hi[i] + 1e-4) { ok = false; bad = i; break; }
  if (!ok) return { y: desired.slice(), ok, bad };
  const fwd = new Array(n), bwd = new Array(n);
  fwd[0] = Math.min(hi[0], Math.max(lo[0], desired[0]));
  for (let i = 1; i < n; i++) {
    let v = Math.min(fwd[i - 1] + g * ds[i], Math.max(fwd[i - 1] - g * ds[i], desired[i]));
    fwd[i] = Math.min(hi[i], Math.max(lo[i], v));
  }
  bwd[n - 1] = Math.min(hi[n - 1], Math.max(lo[n - 1], desired[n - 1]));
  for (let i = n - 2; i >= 0; i--) {
    let v = Math.min(bwd[i + 1] + g * ds[i + 1], Math.max(bwd[i + 1] - g * ds[i + 1], desired[i]));
    bwd[i] = Math.min(hi[i], Math.max(lo[i], v));
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) y[i] = (fwd[i] + bwd[i]) / 2;
  return { y, ok: true, bad: -1 };
}

// ------------------------------------------------------------------------------------ planning

export function planEdge(g: Game, start: Snap, end: Snap, opts: BuildOptions): Proposal {
  const w = g.world;
  const net = w.net;
  const prop: Proposal = {
    ok: true, errors: [], warnings: [], opts, tracks: [], crossings: [], demolish: [], trees: 0, cost: 0,
    stats: { len: 0, maxGrade: 0, minRadius: Infinity, bridges: 0, tunnels: 0, speed: 999 },
  };
  const fail = (m: string) => { prop.ok = false; if (!prop.errors.includes(m)) prop.errors.push(m); };
  const kind = opts.kind;
  // number of parallel tracks: a snapped group dictates it
  let N = kind === 'rail' ? Math.max(1, Math.min(4, opts.tracks)) : 1;
  if (start.kind === 'edge' || end.kind === 'edge') N = 1;
  const sgFull = start.kind === 'node' && kind === 'rail' ? start.group ?? [start.node!] : null;
  if (sgFull) N = Math.min(N, sgFull.length);
  const sg = sgFull ? groupWindow(sgFull, start.node!, N) : null;
  const egFull = end.kind === 'node' && kind === 'rail' ? [...(end.group ?? [end.node!])].reverse() : null;
  const eg = egFull ? groupWindow(egFull, end.node!, N) : null;
  if (N > 1 && end.kind !== 'free' && !(eg && eg.length === N)) fail(`Connect ${N} parallel tracks to ${N} track ends`);
  // group centres
  const centre = (sn: Snap, grp: number[] | null): Snap => {
    if (!grp || grp.length <= 1 || N === 1) return sn;
    let x = 0, z = 0, y = 0;
    for (const id of grp) { const n = net.nodes.get(id)!; x += n.x; z += n.z; y += n.y; }
    return { ...sn, x: x / grp.length, z: z / grp.length, y: y / grp.length };
  };
  const cs = centre(start, sg), ce = centre(end, eg && eg.length === N ? eg : null);
  if (Math.hypot(ce.x - cs.x, ce.z - cs.z) < 1.0) { fail('Too short'); return prop; }
  if (start.kind === 'node' && end.kind === 'node' && start.node === end.node) { fail('Too short'); return prop; }
  const fa = startFrame(g, cs.kind === 'node' && sg ? { ...start } : cs, ce, kind);
  if (sg && sg.length > 1) { fa.x = cs.x; fa.z = cs.z; }
  const fb = endFrame(g, ce.kind === 'node' && eg && eg.length === N && N > 1 ? { ...end } : ce, { x: fa.x, z: fa.z }, kind);
  if (eg && eg.length === N && N > 1) { fb.x = ce.x; fb.z = ce.z; }
  // the end must be ahead of the start tangent
  const chx = fb.x - fa.x, chz = fb.z - fa.z, chl = Math.hypot(chx, chz);
  if (fa.fixed && (fa.tx * chx + fa.tz * chz) / chl < -0.2) fail('Target is behind the track direction');
  if (fb.fixed && (fb.tx * chx + fb.tz * chz) / chl < -0.2) fail('Cannot join from this direction');
  const centreBez = fitCurve(fa, fb);
  const minR = bezMinRadius(centreBez, 48);
  prop.stats.minRadius = minR;
  prop.stats.speed = kind === 'rail' ? Math.min((TRACK_TYPES[opts.type] ?? TRACK_TYPES.standard).speed, curveSpeed(minR)) : (ROAD_TYPES[opts.type] ?? ROAD_TYPES.road).speed;
  if (minR < minRadiusOf(opts)) fail(kind === 'rail' ? `Curve too tight (radius ${Math.round(minR * 10)} m, min ${minRadiusOf(opts) * 10} m)` : 'Curve too tight');

  // per-track curves: standard spacing, or the spacing of a snapped group (e.g. a station throat)
  // when the segment is too short to converge within the minimum radius
  const ctab = arcTable(centreBez);
  const L = ctab.len;
  prop.stats.len = L * N;
  const std: number[] = [];
  for (let i = 0; i < N; i++) std.push((i - (N - 1) / 2) * RAIL.spacing);
  const groupOffs = (grp: number[] | null, cx: number, cz: number, tx: number, tz: number): number[] | null => {
    if (!grp || grp.length !== N || N < 2) return null;
    return grp.map((id) => { const n = net.nodes.get(id)!; return (n.x - cx) * -tz + (n.z - cz) * tx; });
  };
  const candidates = [std];
  const so = groupOffs(sg, fa.x, fa.z, fa.tx, fa.tz), eo = groupOffs(eg, fb.x, fb.z, fb.tx, fb.tz);
  if (so) candidates.push(so);
  if (eo) candidates.push(eo);
  const makeTracks = (offs: number[]): TrackPlan[] => {
    const out: TrackPlan[] = [];
    for (let i = 0; i < N; i++) {
      const bez = N === 1 ? centreBez : bezOffset(centreBez, offs[i]);
      // snap the ends exactly onto group nodes
      if (sg && sg.length === N && N > 1) { const n = net.nodes.get(sg[i])!; bez.x1 += n.x - bez.x0; bez.z1 += n.z - bez.z0; bez.x0 = n.x; bez.z0 = n.z; }
      if (eg && eg.length === N && N > 1) { const n = net.nodes.get(eg[i])!; bez.x2 += n.x - bez.x3; bez.z2 += n.z - bez.z3; bez.x3 = n.x; bez.z3 = n.z; }
      const st: Snap = sg && sg.length === N && N > 1 ? { kind: 'node', x: bez.x0, z: bez.z0, y: 0, node: sg[i] } : N === 1 ? start : { kind: 'free', x: bez.x0, z: bez.z0, y: 0 };
      const en: Snap = eg && eg.length === N && N > 1 ? { kind: 'node', x: bez.x3, z: bez.z3, y: 0, node: eg[i] } : N === 1 ? end : { kind: 'free', x: bez.x3, z: bez.z3, y: 0 };
      out.push({ bez, len: arcTable(bez).len, prof: new Float32Array(0), sections: [], start: st, end: en });
    }
    return out;
  };
  let offsets = std, bestR = -1;
  for (const offs of candidates) {
    const tr = makeTracks(offs);
    let r = minR;
    if (N > 1) for (const tp of tr) r = Math.min(r, bezMinRadius(tp.bez, 48));
    if (r > bestR) { prop.tracks = tr; offsets = offs; bestR = r; }
    if (r >= minRadiusOf(opts)) break;
  }
  if (N > 1 && bestR < minR) {
    prop.stats.minRadius = bestR;
    prop.stats.speed = Math.min(prop.stats.speed, curveSpeed(bestR));
    if (bestR < minRadiusOf(opts) && minR >= minRadiusOf(opts)) fail(`Curve too tight (radius ${Math.round(bestR * 10)} m, min ${minRadiusOf(opts) * 10} m)`);
  }
  const spread = N > 1 ? Math.max(Math.abs(offsets[0]), Math.abs(offsets[N - 1])) : 0;

  // ---- sample centreline
  const M = Math.max(2, Math.ceil(L / PSTEP) + 1);
  const sArr: number[] = [], xs: number[] = [], zs: number[] = [], terr: number[] = [];
  const p = { x: 0, z: 0 };
  for (let i = 0; i < M; i++) {
    const s = Math.min(i * PSTEP, L);
    bezPoint(centreBez, tAtS(ctab, s), p);
    sArr.push(s); xs.push(p.x); zs.push(p.z);
    // use the highest terrain across the formation
    let t = w.heightAt(p.x, p.z);
    if (N > 1) for (const o of [offsets[0], offsets[N - 1]]) {
      const d = bezDeriv(centreBez, tAtS(ctab, s));
      const l = Math.hypot(d.x, d.z) || 1;
      t = Math.max(t, w.heightAt(p.x - (d.z / l) * o, p.z + (d.x / l) * o));
    }
    terr.push(t);
    if (!w.inside(p.x, p.z, 1)) fail('Outside the map');
  }
  const ds = sArr.map((s, i) => (i ? s - sArr[i - 1] : 0));
  const grade = maxGradeOf(opts);
  // desired heights: smoothed terrain, kept above water
  const win = kind === 'rail' ? 6 : 2;
  const desired: number[] = [];
  for (let i = 0; i < M; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(M - 1, i + win); j++) { sum += Math.max(terr[j], WATER_Y + 0.15); cnt++; }
    desired.push(sum / cnt);
  }
  const cons: Constraint[] = [];
  // the height offset applies to the end being placed; a free start sits on the ground
  const startY = fa.y ?? terr[0];
  const endY = fb.y ?? (end.kind === 'free' ? terr[M - 1] + opts.heightOffset : null);
  if (fa.y !== null) cons.push({ i: 0, kind: 'eq', v: fa.y });
  else desired[0] = startY;
  if (fb.y !== null) cons.push({ i: M - 1, kind: 'eq', v: fb.y });
  else { desired[M - 1] = endY!; if (opts.heightOffset) cons.push({ i: M - 1, kind: 'eq', v: endY! }); }
  for (let i = 0; i < M; i++) if (terr[i] < WATER_Y + 0.05) cons.push({ i, kind: 'ge', v: WATER_Y + WATER_DECK });

  let sol = solveProfile(desired, ds, cons, grade);
  if (!sol.ok) { fail('Too steep: make the route longer or change the height'); }

  // ---- crossings with existing edges
  const exclude = new Set<number>();
  const nearEnds: { x: number; z: number }[] = [];
  for (const tp of prop.tracks) for (const sn of [tp.start, tp.end]) {
    if (sn.kind === 'node') { const n = net.nodes.get(sn.node!); if (n) { for (const e of n.edges) exclude.add(e); nearEnds.push({ x: n.x, z: n.z }); } }
    if (sn.kind === 'edge') { exclude.add(sn.edge!); nearEnds.push({ x: sn.x, z: sn.z }); }
  }
  const hwNew = halfWidthOf(opts) + spread;
  const crossings: CrossingPlan[] = [];
  prop.tracks.forEach((tp, ti) => {
    const tab = arcTable(tp.bez);
    const K = Math.max(2, Math.ceil(tab.len / 0.5) + 1);
    const pts: number[] = [];
    for (let i = 0; i < K; i++) { bezPoint(tp.bez, tAtS(tab, Math.min(i * 0.5, tab.len)), p); pts.push(p.x, p.z); }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < K; i++) { x0 = Math.min(x0, pts[i * 2]); x1 = Math.max(x1, pts[i * 2]); z0 = Math.min(z0, pts[i * 2 + 1]); z1 = Math.max(z1, pts[i * 2 + 1]); }
    for (const e of net.edgesNear(x0, z0, x1, z1)) {
      if (exclude.has(e.id)) continue;
      const ge = net.geo(e);
      for (let i = 0; i < K - 1; i++) {
        const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
        for (let j = 0; j < ge.n - 1; j++) {
          const r = segIntersect(ax, az, bx, bz, ge.pts[j * 3], ge.pts[j * 3 + 2], ge.pts[j * 3 + 3], ge.pts[j * 3 + 5]);
          if (!r) continue;
          const sNew = Math.min(i * 0.5, tab.len) + 0.5 * r[0];
          const sOld = ge.cum[j] + (ge.cum[j + 1] - ge.cum[j]) * r[1];
          const ang = angleBetween(bx - ax, bz - az, ge.pts[j * 3 + 3] - ge.pts[j * 3], ge.pts[j * 3 + 5] - ge.pts[j * 3 + 2]);
          crossings.push({ track: ti, sNew, edge: e.id, sOld, x: ax + (bx - ax) * r[0], z: az + (bz - az) * r[0], mode: 'over', angle: Math.min(ang, Math.PI - ang) });
        }
      }
    }
  });
  // decide crossing modes and add profile constraints
  const centreS = (ti: number, s: number) => (s / prop.tracks[ti].len) * L;
  const idxOf = (s: number) => Math.max(0, Math.min(M - 1, Math.round(s / PSTEP)));
  for (const c of crossings) {
    const e = net.edges.get(c.edge)!;
    const yo = net.heightAtS(e, c.sOld);
    const ci = idxOf(centreS(c.track, c.sNew));
    const yn = sol.y[ci];
    const secOld = net.sectionAt(e, c.sOld);
    let mode: CrossingPlan['mode'];
    const levelOk = c.angle > 0.4 && secOld === 'ground' && e.depot < 0 && e.station < 0;
    const levelMode: CrossingPlan['mode'] = kind === 'rail' ? (e.kind === 'rail' ? 'diamond' : 'level') : e.kind === 'rail' ? 'level' : 'junction';
    if (opts.crossing === 'level' && levelOk) mode = levelMode;
    else if (opts.crossing === 'over') mode = 'over';
    else if (opts.crossing === 'under') mode = 'under';
    else if (Math.abs(yn - yo) < 0.35 && levelOk && !(opts.town && kind === 'road' && e.kind === 'rail')) mode = levelMode;
    else mode = yn >= yo ? 'over' : 'under';
    if (secOld === 'tunnel') mode = yn >= yo ? 'over' : 'under';
    c.mode = mode;
    if (mode === 'over') cons.push({ i: ci, kind: 'ge', v: yo + RAIL.clearance });
    else if (mode === 'under') cons.push({ i: ci, kind: 'le', v: yo - RAIL.clearance });
    else cons.push({ i: ci, kind: 'eq', v: yo });
  }
  if (crossings.length) {
    sol = solveProfile(desired, ds, cons, grade);
    if (!sol.ok) fail('Cannot cross at these heights (too steep)');
  }
  prop.crossings = crossings;
  const y = sol.y;

  // ---- grade statistics
  for (let i = 1; i < M; i++) if (ds[i] > 0.01) prop.stats.maxGrade = Math.max(prop.stats.maxGrade, Math.abs(y[i] - y[i - 1]) / ds[i]);

  // ---- sections
  const type: number[] = []; // 0 ground 1 bridge 2 tunnel
  const forcedBridge = new Array(M).fill(false);
  for (const c of crossings) {
    if (c.mode !== 'over') continue;
    const e = net.edges.get(c.edge)!;
    if (net.sectionAt(e, c.sOld) === 'tunnel') continue;
    const wdt = (net.halfWidth(e) + 0.7) / Math.max(0.35, Math.sin(c.angle)) + 0.3;
    const sc = centreS(c.track, c.sNew);
    for (let i = idxOf(sc - wdt); i <= idxOf(sc + wdt); i++) forcedBridge[i] = true;
  }
  for (let i = 0; i < M; i++) {
    const d = y[i] - terr[i];
    if (forcedBridge[i] || terr[i] < WATER_Y + 0.05 || d > BRIDGE_H) type.push(1);
    else if (d < -TUNNEL_D) type.push(2);
    else type.push(0);
  }
  // clean-up: fill short ground gaps between bridges, drop very short structures
  const runs = () => {
    const r: { t: number; a: number; b: number }[] = [];
    let a = 0;
    for (let i = 1; i <= M; i++) if (i === M || type[i] !== type[a]) { r.push({ t: type[a], a, b: i - 1 }); a = i; }
    return r;
  };
  for (const r of runs()) if (r.t === 0 && r.a > 0 && r.b < M - 1 && (r.b - r.a + 1) * PSTEP < 4 && type[r.a - 1] === 1 && type[r.b + 1] === 1) for (let i = r.a; i <= r.b; i++) type[i] = 1;
  for (const r of runs()) {
    const len = (r.b - r.a + 1) * PSTEP;
    if (r.t === 2 && len < 4) for (let i = r.a; i <= r.b; i++) type[i] = 0;
    if (r.t === 1 && len < 1.5) {
      let keep = false;
      for (let i = r.a; i <= r.b; i++) if (forcedBridge[i] || terr[i] < WATER_Y + 0.05) keep = true;
      if (!keep) for (let i = r.a; i <= r.b; i++) type[i] = 0;
    }
  }
  const centreSections: Section[] = [];
  for (const r of runs()) {
    if (r.t === 0) continue;
    const s0 = Math.max(0, sArr[r.a] - PSTEP / 2), s1 = Math.min(L, sArr[r.b] + PSTEP / 2);
    centreSections.push({ s0, s1, type: r.t === 1 ? 'bridge' : 'tunnel' });
    if (r.t === 1) prop.stats.bridges++; else prop.stats.tunnels++;
  }
  // bridges starting at a snapped node must not cut into station/depot edges
  // per-track profiles and sections
  for (const tp of prop.tracks) {
    const m = Math.max(2, Math.ceil(tp.len / PSTEP) + 1);
    const prof = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const sc = (Math.min(i * PSTEP, tp.len) / tp.len) * L;
      prof[i] = profAt(Float32Array.from(y), L, sc);
    }
    tp.prof = prof;
    tp.sections = centreSections.map((sec) => ({ s0: (sec.s0 / L) * tp.len, s1: (sec.s1 / L) * tp.len, type: sec.type }));
  }

  // ---- obstacles along the corridor
  const demolish = new Set<number>();
  let trees = 0;
  const hw = halfWidthOf(opts);
  const crossWin = (ti: number, s: number) => crossings.some((c) => c.track === ti && Math.abs(c.sNew - s) < 2.5);
  prop.tracks.forEach((tp, ti) => {
    const tab = arcTable(tp.bez);
    const K = Math.max(2, Math.ceil(tab.len / 0.5) + 1);
    for (let i = 0; i < K; i++) {
      const s = Math.min(i * 0.5, tab.len);
      bezPoint(tp.bez, tAtS(tab, s), p);
      const yy = profAt(tp.prof, tp.len, s);
      let sec: Section['type'] | 'ground' = 'ground';
      for (const q of tp.sections) if (s >= q.s0 && s <= q.s1) sec = q.type;
      if (sec === 'tunnel') continue;
      const nearEnd = nearEnds.some((ne) => Math.hypot(ne.x - p.x, ne.z - p.z) < 1.2);
      // buildings
      for (const b of w.buildingsNear(p.x, p.z, hw + 3)) {
        if (demolish.has(b.id)) continue;
        if (distToRect(p.x, p.z, b.x, b.z, b.angle, b.w / 2, b.d / 2) > hw + 0.1) continue;
        if (sec === 'bridge' && yy - (b.y + b.floors * 0.3 + 0.4) > 0.3) continue;
        if (opts.town) { fail('Buildings in the way'); continue; }
        demolish.add(b.id);
      }
      // stations and depots
      for (const st of g.stations.footprintsNear(p.x, p.z, hw + 0.2)) {
        if (nearEnd) continue;
        void st;
        fail('Station in the way');
      }
      for (const dp of g.depots.near(p.x, p.z, hw + 0.6)) { if (!nearEnd) { void dp; fail('Depot in the way'); } }
      // parallel conflicts with other edges
      if (!nearEnd && !crossWin(ti, s)) {
        for (const e of net.edgesNear(p.x - hw - 1, p.z - hw - 1, p.x + hw + 1, p.z + hw + 1)) {
          if (exclude.has(e.id)) continue;
          const ge = net.geo(e);
          let best = Infinity, bi = 0;
          for (let j = 0; j < ge.n; j++) { const d = Math.hypot(ge.pts[j * 3] - p.x, ge.pts[j * 3 + 2] - p.z); if (d < best) { best = d; bi = j; } }
          const need = e.kind === 'rail' && kind === 'rail' ? RAIL.spacing - 0.06 : hw + net.halfWidth(e) - 0.08;
          if (best < need) {
            const dy = Math.abs(ge.pts[bi * 3 + 1] - yy);
            if (dy < RAIL.clearance) { fail(e.kind === 'rail' ? 'Too close to existing track' : 'Too close to existing road'); }
          }
        }
      }
      if (sec === 'ground' && i % 2 === 0) trees += w.countTreesNear(p.x, p.z, hw + 0.4);
    }
  });
  prop.demolish = [...demolish];
  prop.trees = trees;

  // ---- cost
  let cost = 0;
  if (!opts.town) {
    const per = kind === 'rail' ? (TRACK_TYPES[opts.type] ?? TRACK_TYPES.standard).costPerUnit : (ROAD_TYPES[opts.type] ?? ROAD_TYPES.road).costPerUnit;
    for (const tp of prop.tracks) {
      let bl = 0, tl = 0;
      for (const s of tp.sections) { if (s.type === 'bridge') bl += s.s1 - s.s0; else tl += s.s1 - s.s0; }
      cost += per * (tp.len - bl - tl) + per * 6 * bl + per * 9 * tl;
    }
    // earthworks estimate
    let vol = 0;
    for (let i = 0; i < M; i++) if (type[i] === 0) vol += Math.abs(y[i] - terr[i]) * PSTEP * (hw * 2 + 1.5 + Math.abs(y[i] - terr[i]) * 2);
    cost += vol * 900;
    for (const id of prop.demolish) { const b = w.buildings.get(id); if (b) cost += 6000 + b.pop * 2500; }
    cost += prop.trees * 250;
    for (const c of crossings) if (c.mode === 'level' || c.mode === 'diamond') cost += 15000;
  }
  prop.cost = Math.round(cost);
  if (!opts.town && !g.company(opts.owner).economy.canAfford(prop.cost)) prop.warnings.push('Not enough money');
  return prop;
}

// ------------------------------------------------------------------------------------ commit

/** Resolve a snap to a node, splitting edges or creating nodes as needed. */
function resolveNode(g: Game, sn: Snap, kind: NetKind, x: number, z: number, y: number, tx: number, tz: number, owner: number): NNode | null {
  const net = g.world.net;
  if (sn.kind === 'node') return net.nodes.get(sn.node!) ?? null;
  if (sn.kind === 'edge') {
    const e = net.edges.get(sn.edge!);
    if (!e) return null;
    const r = net.splitEdge(e.id, sn.s!);
    return r ? r.node : null;
  }
  return net.addNode(kind, x, y, z, kind === 'rail' ? tx : 0, kind === 'rail' ? tz : 0, owner);
}

export function commitProposal(g: Game, prop: Proposal): string | null {
  if (!prop.ok) return prop.errors[0] ?? 'Cannot build';
  const w = g.world;
  const net = w.net;
  const opts = prop.opts;
  const co = opts.town ? null : g.company(opts.owner);
  if (co && !co.economy.canAfford(prop.cost)) return 'Not enough money';
  // vehicles on edges we must split?
  for (const tp of prop.tracks) for (const sn of [tp.start, tp.end]) if (sn.kind === 'edge' && g.vehicles.isEdgeBusy(sn.edge!)) return 'Vehicle in the way';
  for (const c of prop.crossings) if ((c.mode === 'junction' || c.mode === 'under') && g.vehicles.isEdgeBusy(c.edge)) return 'Vehicle in the way';
  if (co) co.economy.spend(prop.cost, 'construction');
  // demolition
  for (const id of prop.demolish) g.towns.demolishBuilding(id);
  const created: NEdge[] = [];
  // edges that will be split later need their ids tracked through splits
  const remap = new Map<number, { e1: number; e2: number; s: number }>();
  const onSplit = (old: NEdge, e1: NEdge, e2: NEdge, s: number) => { remap.set(old.id, { e1: e1.id, e2: e2.id, s }); };
  net.onSplit.push(onSplit);
  const locate = (edgeId: number, s: number): { id: number; s: number } => {
    let id = edgeId;
    for (let guard = 0; guard < 20; guard++) {
      const r = remap.get(id);
      if (!r) break;
      if (s < r.s) id = r.e1; else { id = r.e2; s -= r.s; }
    }
    return { id, s };
  };
  try {
    for (const tp of prop.tracks) {
      const st = tp.start.kind === 'edge' ? { ...tp.start, ...(() => { const l = locate(tp.start.edge!, tp.start.s!); return { edge: l.id, s: l.s }; })() } : tp.start;
      const ta = { x: tp.bez.x1 - tp.bez.x0, z: tp.bez.z1 - tp.bez.z0 };
      const tla = Math.hypot(ta.x, ta.z) || 1;
      const na = resolveNode(g, st, opts.kind, tp.bez.x0, tp.bez.z0, tp.prof[0], ta.x / tla, ta.z / tla, opts.owner);
      const en = tp.end.kind === 'edge' ? { ...tp.end, ...(() => { const l = locate(tp.end.edge!, tp.end.s!); return { edge: l.id, s: l.s }; })() } : tp.end;
      const tb = { x: tp.bez.x3 - tp.bez.x2, z: tp.bez.z3 - tp.bez.z2 };
      const tlb = Math.hypot(tb.x, tb.z) || 1;
      const nb = resolveNode(g, en, opts.kind, tp.bez.x3, tp.bez.z3, tp.prof[tp.prof.length - 1], tb.x / tlb, tb.z / tlb, opts.owner);
      if (!na || !nb) return 'Network changed, try again';
      const bez = { ...tp.bez, x0: na.x, z0: na.z, x3: nb.x, z3: nb.z };
      const prof = tp.prof.slice();
      prof[0] = na.y; prof[prof.length - 1] = nb.y;
      created.push(net.addEdge(opts.kind, na.id, nb.id, bez, prof, tp.sections, opts.type, opts.owner));
    }
    // crossings
    for (const c of prop.crossings) {
      const ne = created[c.track];
      const old = locate(c.edge, c.sOld);
      const oe = net.edges.get(old.id);
      if (!oe || !ne) continue;
      if (c.mode === 'under') {
        if (net.sectionAt(oe, old.s) !== 'ground') continue;
        const hw = net.halfWidth(ne) + (prop.tracks.length - 1) * RAIL.spacing * 0.5;
        const wdt = (hw + 0.8) / Math.max(0.35, Math.sin(c.angle)) + 0.3;
        oe.sections.push({ s0: Math.max(0, old.s - wdt), s1: Math.min(oe.len, old.s + wdt), type: 'bridge' });
        oe.sections.sort((a, b) => a.s0 - b.s0);
        net.touchEdge(oe);
        recomputeLocks(w, c.x - wdt - 1, c.z - wdt - 1, c.x + wdt + 1, c.z + wdt + 1);
      } else if (c.mode === 'level' || c.mode === 'diamond') {
        const rail = ne.kind === 'rail' ? ne : oe, road = ne.kind === 'rail' ? oe : ne;
        const sRail = rail === ne ? c.sNew : old.s, sRoad = road === ne ? c.sNew : old.s;
        net.crossings.set(net.nextCrossing, { id: net.nextCrossing++, kind: c.mode, e1: rail.id, s1: sRail, e2: road.id, s2: sRoad, x: c.x, z: c.z });
        net.markEdge(ne);
      } else if (c.mode === 'junction') {
        const sNew = locate(ne.id, c.sNew);
        const r1 = net.splitEdge(old.id, old.s);
        const r2 = net.splitEdge(sNew.id, sNew.s);
        if (r1 && r2) {
          r2.node.x = r1.node.x; r2.node.z = r1.node.z;
          net.mergeNodes(r1.node.id, r2.node.id);
        }
      }
    }
  } finally {
    net.onSplit = net.onSplit.filter((f) => f !== onSplit);
  }
  // final edges (after junction splits) for earthworks and tree clearing
  const finalEdges: NEdge[] = [];
  for (const e of created) {
    const ids = [e.id];
    const out: number[] = [];
    while (ids.length) { const id = ids.pop()!; const r = remap.get(id); if (r) ids.push(r.e1, r.e2); else out.push(id); }
    for (const id of out) { const fe = net.edges.get(id); if (fe) finalEdges.push(fe); }
  }
  // clear trees on the formation
  for (const e of finalEdges) {
    const geo = net.geo(e);
    const hw = net.halfWidth(e) + 0.5;
    for (let i = 0; i < geo.n; i += 2) if (net.sectionAt(e, geo.cum[i]) === 'ground') w.removeTreesNear(geo.pts[i * 3], geo.pts[i * 3 + 2], hw);
  }
  applyEarthworks(w, finalEdges);
  g.onNetworkChanged();
  return null;
}
