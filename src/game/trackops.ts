// Track operations: doubling a single track (a parallel track with turnouts, or straight into free platforms),
// making a double track directional (one-way block signals for right-hand running, and crossover pairs before
// stations and depots so every platform is reachable from both tracks), and moving a depot.
import type { Game } from './game';
import { RAIL, TRACK_TYPES } from './constants';
import { bezFromTangents, bezMinRadius, bezPoint, endTangent } from './geom';
import { applyEarthworks } from './terraform';
import type { NEdge } from './network';
import { planEdge, commitProposal, fitCurve, Snap, Proposal, BuildOptions } from './construction';
import { setSignal, SIGNAL_SPACING } from './signals';
import type { DepotPlan } from './build-ops';

/** A track as travelled: edges in order, each in direction +1 (a -> b) or -1. */
export interface Step { edge: number; dir: number }

interface Sample { u: number; x: number; z: number; y: number; tx: number; tz: number; edge: number; s: number }

const railOpts = (owner: number, extra: Partial<BuildOptions> = {}): BuildOptions => ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra });

/** Length of a turnout from one track to a parallel one at the standard spacing. */
const TURNOUT = 8;
/** Longest segment of a new parallel track (keeps it at the old track's heights). */
const SEG = 8;

// ------------------------------------------------------------------ track helpers

/** Samples (about every 0.25-0.5 units) along a track: position, height, unit tangent in travel direction. */
function sampleSteps(g: Game, steps: Step[]): Sample[] {
  const net = g.world.net;
  const out: Sample[] = [];
  let u = 0;
  for (const st of steps) {
    const e = net.edges.get(st.edge);
    if (!e) continue;
    const geo = net.geo(e);
    for (let k = 0; k < geo.n; k++) {
      const i = st.dir > 0 ? k : geo.n - 1 - k;
      if (out.length && k === 0) continue;
      const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
      if (out.length) { const p = out[out.length - 1]; u += Math.hypot(x - p.x, z - p.z); }
      out.push({ u, x, z, y: geo.pts[i * 3 + 1], tx: geo.tan[i * 2] * st.dir, tz: geo.tan[i * 2 + 1] * st.dir, edge: e.id, s: geo.cum[i] });
    }
  }
  return out;
}

/** Interpolated sample at distance u along a sampled track. */
function sampleAt(S: Sample[], u: number): Sample {
  if (u <= S[0].u) return S[0];
  if (u >= S[S.length - 1].u) return S[S.length - 1];
  let lo = 0, hi = S.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (S[m].u <= u) lo = m; else hi = m; }
  const a = S[lo], b = S[hi], f = (u - a.u) / Math.max(1e-9, b.u - a.u);
  const tx = a.tx + (b.tx - a.tx) * f, tz = a.tz + (b.tz - a.tz) * f, tl = Math.hypot(tx, tz) || 1;
  const same = a.edge === b.edge;
  return { u, x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, y: a.y + (b.y - a.y) * f, tx: tx / tl, tz: tz / tl, edge: same || f < 0.5 ? a.edge : b.edge, s: same ? a.s + (b.s - a.s) * f : f < 0.5 ? a.s : b.s };
}

/** Nearest sample of a track to a point (index and distance). */
function nearestSample(S: Sample[], x: number, z: number): { i: number; d: number } {
  let bi = 0, bd = Infinity;
  for (let i = 0; i < S.length; i++) { const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  return { i: bi, d: Math.sqrt(bd) };
}

/** Continue a track from edge e (travelled in direction d) through edges of `set`, the straightest way. */
function extend(g: Game, e: NEdge, d: number, set: Set<number>, exclude: Set<number>, visited: Set<number>): Step[] {
  const net = g.world.net;
  const out: Step[] = [];
  let cur = e, cd = d;
  for (let guard = 0; guard < 10000; guard++) {
    const conts = net.nextRail(cur, cd).filter((c) => set.has(c.edge.id) && !exclude.has(c.edge.id) && !visited.has(c.edge.id));
    if (!conts.length) break;
    const geo = net.geo(cur), i = cd > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * cd, tz = geo.tan[i * 2 + 1] * cd;
    let best = conts[0], bd = -Infinity;
    for (const c of conts) {
      const ld = net.leaveDir(c.edge, c.node.id), dot = ld.x * tx + ld.z * tz;
      if (dot > bd) { bd = dot; best = c; }
    }
    out.push({ edge: best.edge.id, dir: best.dir });
    visited.add(best.edge.id);
    cur = best.edge; cd = best.dir;
  }
  return out;
}

/** The track through `seed` within `set` (both ways), in seed's +s direction. */
function walkTrack(g: Game, seed: NEdge, set: Set<number>, exclude: Set<number> = new Set()): Step[] {
  const visited = new Set<number>([seed.id]);
  const fwd = extend(g, seed, 1, set, exclude, visited);
  const bwd = extend(g, seed, -1, set, exclude, visited);
  return [...bwd.reverse().map((s) => ({ edge: s.edge, dir: -s.dir })), { edge: seed.id, dir: 1 }, ...fwd];
}

const startNode = (g: Game, s: Step) => { const e = g.world.net.edges.get(s.edge)!; return s.dir > 0 ? e.a : e.b; };
const endNode = (g: Game, s: Step) => { const e = g.world.net.edges.get(s.edge)!; return s.dir > 0 ? e.b : e.a; };

/** Keep step lists valid while edges are split (an edge is replaced by its halves in travel order). */
function trackSplits(g: Game, lists: Step[][]): () => void {
  const net = g.world.net;
  const f = (old: NEdge, e1: NEdge, e2: NEdge) => {
    for (const L of lists) {
      const i = L.findIndex((s) => s.edge === old.id);
      if (i < 0) continue;
      const d = L[i].dir;
      L.splice(i, 1, ...(d > 0 ? [{ edge: e1.id, dir: 1 }, { edge: e2.id, dir: 1 }] : [{ edge: e2.id, dir: -1 }, { edge: e1.id, dir: -1 }]));
    }
  };
  net.onSplit.push(f);
  return () => { net.onSplit = net.onSplit.filter((x) => x !== f); };
}

const edgeSnap = (S: Sample): Snap => ({ kind: 'edge', x: S.x, z: S.z, y: S.y, edge: S.edge, s: S.s });
const nodeSnapOf = (g: Game, id: number): Snap => { const n = g.world.net.nodes.get(id)!; return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [n.id] }; };

/** Money spent since `before`, and a refund helper for roll-backs. */
function refund(g: Game, owner: number, before: number) {
  const eco = g.company(owner).economy;
  const spent = before - eco.money;
  if (spent > 0) eco.spend(-spent, 'construction', true);
}

// ------------------------------------------------------------------ S-curves between parallel tracks

/** End of a connecting S-curve: a point on an edge (split there) or a node, with the track direction there. */
interface SPt { x: number; z: number; y: number; tx: number; tz: number; edge?: number; s?: number; node?: number }

/** Price of the two turnouts of a connection (plus its track). */
const TURNOUT_COST = 15000;

/**
 * An S-curve between two points on (nearly) parallel tracks (a turnout to a new track, a crossover leg): checks
 * it and, unless `dry`, lays it, splitting the tracks there. `tracks`: the edges it may touch (its two tracks).
 */
function connectS(g: Game, owner: number, a: SPt, b: SPt, tracks: Set<number>, dry: boolean): { error: string | null; cost: number } {
  const net = g.world.net, w = g.world;
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  if (L < 2) return { error: 'too short', cost: 0 };
  const sa = a.tx * dx + a.tz * dz >= 0 ? 1 : -1, sb = b.tx * dx + b.tz * dz >= 0 ? 1 : -1;
  const bez = bezFromTangents(a.x, a.z, a.tx * sa, a.tz * sa, b.x, b.z, b.tx * sb, b.tz * sb, L * 0.38, L * 0.38);
  if (bezMinRadius(bez, 32) < TRACK_TYPES.standard.minRadius) return { error: 'curve too tight', cost: 0 };
  if (Math.abs(b.y - a.y) > TRACK_TYPES.standard.maxGrade * L + 0.02) return { error: 'too steep', cost: 0 };
  const p = { x: 0, z: 0 };
  for (let i = 2; i <= 14; i++) {
    bezPoint(bez, i / 16, p);
    for (const e of net.edgesNear(p.x - 1, p.z - 1, p.x + 1, p.z + 1)) {
      if (tracks.has(e.id)) continue;
      if (a.node !== undefined && (e.a === a.node || e.b === a.node)) continue;
      if (b.node !== undefined && (e.a === b.node || e.b === b.node)) continue;
      const ne = net.nearestEdge(p.x, p.z, net.halfWidth(e) + 0.36, undefined, (q) => q.id === e.id);
      if (ne && Math.abs(net.heightAtS(e, ne.s) - (a.y + (b.y - a.y) * (i / 16))) < RAIL.clearance) return { error: e.kind === 'rail' ? 'other track in the way' : 'road in the way', cost: 0 };
    }
  }
  for (const c of net.crossings.values()) if ((tracks.has(c.e1) || tracks.has(c.e2)) && Math.hypot(c.x - (a.x + b.x) / 2, c.z - (a.z + b.z) / 2) < L / 2 + 1.5) return { error: 'level crossing in the way', cost: 0 };
  const cost = Math.round(L * TRACK_TYPES.standard.costPerUnit + 2 * TURNOUT_COST);
  if (dry) return { error: null, cost };
  for (const q of [a, b]) if (q.edge !== undefined && g.vehicles.isEdgeBusy(q.edge)) return { error: 'train in the way', cost };
  const eco = g.company(owner).economy;
  if (!eco.canAfford(cost)) return { error: 'Not enough money', cost };
  const secOf = (q: SPt) => { if (q.edge === undefined) return 'ground'; const e = net.edges.get(q.edge); return e ? net.sectionAt(e, q.s ?? 0) : 'ground'; };
  const sec = secOf(a) !== 'ground' ? secOf(a) : secOf(b);
  const nodeOf = (q: SPt): number | null => {
    if (q.node !== undefined) return net.nodes.has(q.node) ? q.node : null;
    const e = net.edges.get(q.edge!);
    if (!e) return null;
    if (q.s! < 0.3 || q.s! > e.len - 0.3) return q.s! < 0.3 ? e.a : e.b;
    const r = net.splitEdge(e.id, q.s!);
    return r ? r.node.id : null;
  };
  const na = nodeOf(a);
  const nb = na === null ? null : nodeOf(b);
  if (na === null || nb === null) return { error: 'cannot split the track', cost };
  const A = net.nodes.get(na)!, B = net.nodes.get(nb)!;
  const len = Math.hypot(B.x - A.x, B.z - A.z);
  const m = Math.max(2, Math.ceil(len) + 1);
  const prof = new Float32Array(m);
  for (let i = 0; i < m; i++) prof[i] = A.y + (B.y - A.y) * Math.min(1, i / (m - 1));
  const e = net.addEdge('rail', na, nb, { ...bez, x0: A.x, z0: A.z, x3: B.x, z3: B.z }, prof, sec === 'ground' ? [] : [{ s0: 0, s1: len + 1, type: sec }], 'standard', owner);
  if (sec === 'ground') { applyEarthworks(w, [e]); for (let i = 0; i <= 8; i++) { bezPoint(bez, i / 8, p); w.removeTreesNear(p.x, p.z, 0.8); } }
  eco.spend(cost, 'construction');
  g.onNetworkChanged();
  return { error: null, cost };
}

// ------------------------------------------------------------------ doubling a single track

export interface DoubleEnd {
  /** 'turnout': the new track leaves / joins the old one at chain distance u; 'platform': it runs into a free platform end */
  kind: 'turnout' | 'platform';
  u: number;
  node: number;
}

export interface DoublePlan {
  ok: boolean;
  errors: string[];
  warnings: string[];
  cost: number;
  owner: number;
  /** +1: the new track on the right of the chain direction, -1 on the left */
  side: 1 | -1;
  /** the existing track, in chain order */
  steps: Step[];
  length: number;
  /** the new track's segment ends between the end connections (chain distance, position, height, tangent) */
  points: { u: number; x: number; z: number; y: number; tx: number; tz: number }[];
  start: DoubleEnd;
  end: DoubleEnd;
  /** planned parallel segments (previews; the end connections are S-curves from start / end to the first / last point) */
  proposals: Proposal[];
}

/** Order the given edges into one continuous track (in the direction from the first listed edge to the last). */
function chainOf(g: Game, edgeIds: number[], owner: number): { steps: Step[]; error?: string } {
  const net = g.world.net;
  const ids = [...new Set(edgeIds)].filter((id) => net.edges.has(id));
  if (!ids.length) return { steps: [], error: 'No track selected' };
  for (const id of ids) {
    const e = net.edges.get(id)!;
    if (e.kind !== 'rail') return { steps: [], error: 'Only railway track can be doubled' };
    if (e.owner !== owner) return { steps: [], error: 'Not your track' };
    if (e.station >= 0 || e.depot >= 0) return { steps: [], error: 'Platform and depot tracks cannot be doubled' };
  }
  const set = new Set(ids);
  const steps = walkTrack(g, net.edges.get(ids[0])!, set);
  if (steps.length !== ids.length) return { steps: [], error: 'The selected track is not one continuous line' };
  if (ids.length > 1) {
    const iLast = steps.findIndex((s) => s.edge === ids[ids.length - 1]), iFirst = steps.findIndex((s) => s.edge === ids[0]);
    if (iLast < iFirst) return { steps: steps.reverse().map((s) => ({ edge: s.edge, dir: -s.dir })) };
  }
  return { steps };
}

/** Distance from a point to a sampled track (projected onto the nearest sample segments). */
function distToTrack(S: Sample[], x: number, z: number): number {
  const i = nearestSample(S, x, z).i;
  let d = Math.hypot(S[i].x - x, S[i].z - z);
  for (const j of [i - 1, i]) {
    if (j < 0 || j + 1 >= S.length) continue;
    const a = S[j], b = S[j + 1], vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz;
    if (l2 < 1e-12) continue;
    const t = Math.max(0, Math.min(1, ((x - a.x) * vx + (z - a.z) * vz) / l2));
    d = Math.min(d, Math.hypot(a.x + vx * t - x, a.z + vz * t - z));
  }
  return d;
}

/**
 * Plan a second track beside a chain of single-track edges, `RAIL.spacing` to the given side (+1 right of the
 * direction from the first listed edge to the last). Bridges and tunnels get parallel structures (the planner's
 * shared-formation discount applies); at each end the new track either runs into a free platform end of a station
 * there or joins the old track with a turnout (short of switches whose branches leave on that side). Nothing is
 * built; errors say where along the line a piece cannot be built (try the other side).
 */
export function planDoubleTrack(g: Game, edgeIds: number[], side: 1 | -1, owner: number): DoublePlan {
  const net = g.world.net;
  const plan: DoublePlan = { ok: true, errors: [], warnings: [], cost: 0, owner, side, steps: [], length: 0, points: [], start: { kind: 'turnout', u: 0, node: -1 }, end: { kind: 'turnout', u: 0, node: -1 }, proposals: [] };
  const fail = (m: string) => { plan.ok = false; if (!plan.errors.includes(m)) plan.errors.push(m); return plan; };
  const ch = chainOf(g, edgeIds, owner);
  if (ch.error) return fail(ch.error);
  plan.steps = ch.steps;
  const S = sampleSteps(g, ch.steps);
  const U = S[S.length - 1].u;
  plan.length = U;
  const sp = RAIL.spacing;
  const nrm = (q: { tx: number; tz: number }) => ({ x: -q.tz * side, z: q.tx * side });
  const m10 = (u: number) => Math.round(u * 10);
  const chainSet = new Set(ch.steps.map((s) => s.edge));
  // branches leaving on the new track's side (judged a few units along them, as turnouts join tangentially):
  // near an end the new track stops short of them, elsewhere they are in the way
  let uMin = 0, uMax = U;
  const pt = { x: 0, y: 0, z: 0 };
  for (let i = 0; i + 1 < ch.steps.length; i++) {
    const nid = endNode(g, ch.steps[i]);
    const n = net.nodes.get(nid)!;
    const q = S[nearestSample(S, n.x, n.z).i], nv = nrm(q);
    for (const eid of n.edges) {
      if (chainSet.has(eid)) continue;
      const e = net.edges.get(eid)!;
      const d = Math.min(e.len, 3);
      net.pointAt(e, e.a === nid ? d : e.len - d, pt);
      if ((pt.x - n.x) * nv.x + (pt.z - n.z) * nv.z <= 0.12) continue;
      if (q.u < U * 0.4) uMin = Math.max(uMin, q.u + 1.5);
      else if (q.u > U * 0.6) uMax = Math.min(uMax, q.u - 1.5);
      else return fail(`A branch leaves the line on that side (${m10(q.u)} m along)`);
    }
  }
  const offAt = (u: number) => { const q = sampleAt(S, u), nv = nrm(q); return { u, x: q.x + nv.x * sp, z: q.z + nv.z * sp, y: q.y, tx: q.tx, tz: q.tz }; };
  const onMain = (u: number): SPt => { const q = sampleAt(S, u); return { x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s }; };
  const isSwitchNear = (u: number) => { const q = sampleAt(S, u); return [...net.nodeGrid.query(q.x - 1.5, q.z - 1.5, q.x + 1.5, q.z + 1.5)].some((id) => { const n = net.nodes.get(id); return !!n && n.kind === 'rail' && n.edges.length > 2 && Math.hypot(n.x - q.x, n.z - q.z) < 1.5; }); };
  // the ends: into a free platform end beside the track's own, else a turnout
  const endOf = (atStart: boolean): { end: DoubleEnd; inner: number; err?: string } | null => {
    const limit = atStart ? uMin : U - uMax;
    if (limit === 0) {
      const nid = atStart ? startNode(g, ch.steps[0]) : endNode(g, ch.steps[ch.steps.length - 1]);
      const n = net.nodes.get(nid)!;
      const q = atStart ? S[0] : S[S.length - 1];
      const nv = nrm(q);
      const stEdge = n.edges.map((id) => net.edges.get(id)!).find((e) => e && e.station >= 0);
      if (stEdge) {
        const st = g.stations.get(stEdge.station);
        let best = -1, bl = Infinity;
        for (const t of st ? g.stations.trackEnds(st) : []) for (const cand of [t.front, t.back]) {
          const m = net.nodes.get(cand);
          if (!m || cand === nid || m.edges.length !== 1) continue;
          const dx = m.x - n.x, dz = m.z - n.z, lat = dx * nv.x + dz * nv.z, along = dx * q.tx + dz * q.tz;
          if (Math.abs(along) < 0.3 && lat > 0.3 && lat < 1.7 && lat < bl) { bl = lat; best = cand; }
        }
        if (best >= 0) {
          const len = Math.max(7, Math.min(14, Math.sqrt(60 * Math.abs(bl - sp)) + 4));
          const inner = atStart ? len : U - len;
          const m = net.nodes.get(best)!, o = offAt(inner);
          const r = connectS(g, owner, { x: m.x, z: m.z, y: m.y, tx: q.tx, tz: q.tz, node: best }, o, chainSet, true);
          if (!r.error) return { end: { kind: 'platform', u: atStart ? 0 : U, node: best }, inner };
        }
      }
    }
    let why = '';
    for (const T of [TURNOUT, TURNOUT + 3, TURNOUT + 7]) for (let d = Math.max(2, limit + 0.5); d <= limit + 26; d += 1) {
      const u = atStart ? d : U - d, u2 = atStart ? u + T : u - T;
      if (u2 < 0 || u2 > U || (atStart ? u2 > U / 2 : u2 < U / 2)) break;
      if (isSwitchNear(u)) continue;
      const r = connectS(g, owner, onMain(u), offAt(u2), chainSet, true);
      if (!r.error) return { end: { kind: 'turnout', u, node: -1 }, inner: u2 };
      why = r.error;
    }
    return { end: { kind: 'turnout', u: 0, node: -1 }, inner: NaN, err: why || 'no room' };
  };
  const a = endOf(true), b = endOf(false);
  if (!a || isNaN(a.inner)) return fail(`No room for the turnout at the start (${a?.err ?? ''})`);
  if (!b || isNaN(b.inner)) return fail(`No room for the turnout at the end (${b?.err ?? ''})`);
  plan.start = a.end; plan.end = b.end;
  const uS = a.inner, uE = b.inner;
  if (uE - uS < 3) return fail('Too short to double');
  // where the new track crosses other roads and tracks: no segment ends there
  const cross: number[] = [];
  for (let i = 0; i < S.length - 1; i += 2) {
    const p = S[i], q = S[Math.min(S.length - 1, i + 2)];
    const np = nrm(p), nq = nrm(q);
    const ax = p.x + np.x * sp, az = p.z + np.z * sp, bx = q.x + nq.x * sp, bz = q.z + nq.z * sp;
    for (const e of net.edgesNear(Math.min(ax, bx) - 0.5, Math.min(az, bz) - 0.5, Math.max(ax, bx) + 0.5, Math.max(az, bz) + 0.5)) {
      if (chainSet.has(e.id)) continue;
      const ge = net.geo(e);
      for (let j = 0; j < ge.n - 1; j++) {
        const cx = ge.pts[j * 3], cz = ge.pts[j * 3 + 2], dx = ge.pts[j * 3 + 3], dz = ge.pts[j * 3 + 5];
        const rx = bx - ax, rz = bz - az, sx = dx - cx, sz = dz - cz, den = rx * sz - rz * sx;
        if (Math.abs(den) < 1e-12) continue;
        const t = ((cx - ax) * sz - (cz - az) * sx) / den, v = ((cx - ax) * rz - (cz - az) * rx) / den;
        if (t >= 0 && t <= 1 && v >= 0 && v <= 1) cross.push(p.u + (q.u - p.u) * t);
      }
    }
  }
  // (segment ends keep 4.5 units from crossings, so the track can meet a level crossing's height)
  const CR = 4.5;
  const blocked = (u: number) => cross.find((c) => Math.abs(c - u) < CR);
  const us: number[] = [uS];
  for (let guard = 0; guard < 2000; guard++) {
    const u = us[us.length - 1];
    if (u >= uE - 1e-6) break;
    let nx = u + SEG >= uE - 3 ? uE : u + SEG;
    const c = nx < uE ? blocked(nx) : undefined;
    if (c !== undefined) nx = c - CR - u >= 2 ? c - CR : Math.min(uE, c + CR);
    if (nx >= uE - 1.5) nx = uE;
    us.push(nx);
  }
  // segment ends on the parallel line with its exact direction; every segment is laid node to node (the planner's
  // curve between the two directions), split where that curve would stray from the parallel line
  const pts = [offAt(us[0])];
  const queue = us.slice(1);
  const pb = { x: 0, z: 0 };
  for (let guard = 0; queue.length && guard < 4000; guard++) {
    const A = pts[pts.length - 1], B = offAt(queue[0]);
    const bez = fitCurve({ x: A.x, z: A.z, tx: A.tx, tz: A.tz, fixed: true, y: null }, { x: B.x, z: B.z, tx: B.tx, tz: B.tz, fixed: true, y: null });
    let dev = 0;
    for (let i = 1; i < 8; i++) { bezPoint(bez, i / 8, pb); dev = Math.max(dev, Math.abs(distToTrack(S, pb.x, pb.z) - sp)); }
    if (dev > 0.03 && queue[0] - A.u > 1.5) { queue.unshift((A.u + queue[0]) / 2); continue; }
    pts.push(B);
    queue.shift();
  }
  plan.points = pts;
  // plan every segment between temporary nodes (removed again)
  const tmp = pts.map((p) => net.addNode('rail', p.x, p.y, p.z, -p.tx, -p.tz, owner).id);
  try {
    for (let k = 0; k + 1 < pts.length; k++) {
      const prop = planEdge(g, nodeSnapOf(g, tmp[k]), nodeSnapOf(g, tmp[k + 1]), railOpts(owner));
      plan.proposals.push(prop);
      if (!prop.ok) fail(`New track (${m10(pts[k].u)}-${m10(pts[k + 1].u)} m of ${m10(U)} m): ${prop.errors[0] ?? 'cannot build'}`);
    }
  } finally {
    for (const id of tmp) net.removeNode(id);
  }
  const conn = (e: DoubleEnd, inner: number) => {
    const o = offAt(inner);
    if (e.kind === 'platform') { const m = net.nodes.get(e.node)!; return connectS(g, owner, { x: m.x, z: m.z, y: m.y, tx: o.tx, tz: o.tz, node: e.node }, o, chainSet, true).cost; }
    return connectS(g, owner, onMain(e.u), o, chainSet, true).cost;
  };
  plan.cost = Math.round(plan.proposals.reduce((s, p) => s + p.cost, 0) + conn(plan.start, uS) + conn(plan.end, uE));
  if (!g.company(owner).economy.canAfford(plan.cost)) plan.warnings.push('Not enough money');
  return plan;
}

export interface DoubleResult {
  /** null = built */
  error: string | null;
  cost: number;
  /** edges of the new track (incl. its connections) */
  edges: number[];
  /** finishDoubleTrack's result (when called) */
  signals: number; crossovers: number; finishError?: string;
}

/**
 * Build a planned second track (see planDoubleTrack); everything built is removed again (and refunded) if a piece
 * fails. Then, unless `finish` is false, the pair is made directional with finishDoubleTrack.
 */
export function commitDoubleTrack(g: Game, plan: DoublePlan, finish = true, opts: FinishOpts = {}): DoubleResult {
  const net = g.world.net;
  const owner = plan.owner;
  const res: DoubleResult = { error: null, cost: 0, edges: [], signals: 0, crossovers: 0 };
  if (!plan.ok) { res.error = plan.errors[0] ?? 'Cannot build'; return res; }
  const eco = g.company(owner).economy;
  if (!eco.canAfford(plan.cost)) { res.error = 'Not enough money'; return res; }
  for (const s of plan.steps) if (!net.edges.has(s.edge)) { res.error = 'The track changed, plan again'; return res; }
  for (const e of [plan.start, plan.end]) if (e.kind === 'platform' && net.nodes.get(e.node)?.edges.length !== 1) { res.error = 'The track changed, plan again'; return res; }
  const money0 = eco.money, e0 = net.nextEdge;
  const main = plan.steps.map((s) => ({ ...s }));
  const untrack = trackSplits(g, [main]);
  const created = () => { const out: number[] = []; for (let id = e0; id < net.nextEdge; id++) if (net.edges.has(id) && !main.some((s) => s.edge === id)) out.push(id); return out; };
  const rollback = (why: string) => {
    for (const id of created()) net.removeEdge(id);
    refund(g, owner, money0);
    g.onNetworkChanged();
    res.error = why;
    return res;
  };
  try {
    const pts = plan.points;
    const nodes = pts.map((p) => net.addNode('rail', p.x, p.y, p.z, -p.tx, -p.tz, owner).id);
    const first = net.nodes.get(nodes[0])!;
    const dropNodes = () => { for (const id of nodes) { const n = net.nodes.get(id); if (n && !n.edges.length) net.removeNode(id); } };
    for (let k = 0; k + 1 < pts.length; k++) {
      let ok = false;
      for (const extra of [{}, { crossing: 'level' as const }, { crossing: 'over' as const }, { crossing: 'under' as const }]) {
        const prop = planEdge(g, nodeSnapOf(g, nodes[k]), nodeSnapOf(g, nodes[k + 1]), railOpts(owner, extra));
        if (!prop.ok || commitProposal(g, prop)) continue;
        ok = true;
        break;
      }
      if (!ok) { const r = rollback(`New track could not be built at ${Math.round(pts[k].u * 10)} m (the ground or the network changed)`); dropNodes(); return r; }
    }
    const cur = nodes[nodes.length - 1];
    const tracks = () => new Set<number>([...main.map((s) => s.edge), ...created()]);
    const nodePt = (id: number, t: { tx: number; tz: number }): SPt => { const n = net.nodes.get(id)!; return { x: n.x, z: n.z, y: n.y, tx: t.tx, tz: t.tz, node: id }; };
    const mainPt = (u: number): SPt => { const q = sampleAt(sampleSteps(g, main), u); return { x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s }; };
    const last = pts[pts.length - 1];
    const r1 = plan.end.kind === 'platform' ? connectS(g, owner, nodePt(cur, last), nodePt(plan.end.node, last), tracks(), false) : connectS(g, owner, nodePt(cur, last), mainPt(plan.end.u), tracks(), false);
    if (r1.error) { const r = rollback(`End connection: ${r1.error}`); dropNodes(); return r; }
    const r2 = plan.start.kind === 'platform' ? connectS(g, owner, nodePt(plan.start.node, pts[0]), nodePt(first.id, pts[0]), tracks(), false) : connectS(g, owner, mainPt(plan.start.u), nodePt(first.id, pts[0]), tracks(), false);
    if (r2.error) { const r = rollback(`Start connection: ${r2.error}`); dropNodes(); return r; }
  } finally {
    untrack();
  }
  res.edges = created();
  res.cost = Math.round(money0 - eco.money);
  g.onNetworkChanged();
  if (finish) {
    const f = finishDoubleTrack(g, [...main.map((s) => s.edge), ...res.edges], owner, opts);
    res.signals = f.signals; res.crossovers = f.crossovers;
    if (f.error) res.finishError = f.error;
    res.cost += f.cost;
  }
  return res;
}

// ------------------------------------------------------------------ directional double track

export interface FinishOpts {
  /** trains keep to the right-hand track (default true) */
  rightHand?: boolean;
  /** block signal spacing (default SIGNAL_SPACING = 50 units = 500 m) */
  signalSpacing?: number;
  /** add crossovers before stations and depots at the ends (default true) */
  crossovers?: boolean;
  /** diagnostics */
  log?: (s: string) => void;
}

export interface FinishResult { signals: number; crossovers: number; cost: number; error?: string }

/** What lies just beyond an end of a double stretch: the tracks merging, a station or a depot, or open line. */
function beyond(g: Game, nodes: number[], outward: { x: number; z: number }, reach = 30): 'merge' | 'station' | 'depot' | 'open' {
  const net = g.world.net;
  const seen = new Map<number, number>();
  let kind: 'merge' | 'station' | 'depot' | 'open' = 'open';
  const queue: { n: number; d: number; from: number; root: number }[] = nodes.map((n, i) => ({ n, d: 0, from: -1, root: i }));
  const roots = new Map<number, Set<number>>();
  while (queue.length) {
    const q = queue.shift()!;
    const set = roots.get(q.n) ?? new Set<number>();
    set.add(q.root);
    roots.set(q.n, set);
    if (set.size > 1) return 'merge';
    if ((seen.get(q.n) ?? Infinity) <= q.d && q.from >= 0) continue;
    seen.set(q.n, q.d);
    const n = net.nodes.get(q.n);
    if (!n) continue;
    for (const eid of n.edges) {
      if (eid === q.from) continue;
      const e = net.edges.get(eid);
      if (!e || e.kind !== 'rail') continue;
      const o = e.a === q.n ? e.b : e.a, on = net.nodes.get(o)!;
      if (q.d === 0 && (on.x - n.x) * outward.x + (on.z - n.z) * outward.z < 0) continue;
      if (e.station >= 0) { kind = 'station'; continue; }
      if (e.depot >= 0) { if (kind === 'open') kind = 'depot'; continue; }
      if (q.d + e.len <= reach) queue.push({ n: o, d: q.d + e.len, from: eid, root: q.root });
    }
  }
  return kind;
}

/**
 * Make a double track directional: each track gets one running direction (right-hand running by default) with
 * one-way block signals about every 500 m, and where a station or depot lies just beyond an end of the double
 * stretch, a pair of crossovers (one each way) is laid shortly before it so trains on either track reach every
 * platform / the depot and can leave on the right track. `edgeIds`: the edges of a two-track build (or of a
 * doubled line with its new track). When crossovers cannot be laid there, no one-way signals are set (the tracks
 * stay usable both ways) and `error` says why.
 */
export function finishDoubleTrack(g: Game, edgeIds: number[], owner: number, opts: FinishOpts = {}): FinishResult {
  const net = g.world.net;
  const res: FinishResult = { signals: 0, crossovers: 0, cost: 0 };
  const eco = g.company(owner).economy, money0 = eco.money;
  const set = new Set(edgeIds.filter((id) => { const e = net.edges.get(id); return !!e && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0; }));
  if (set.size < 2) { res.error = 'Not a double track'; return res; }
  // the two tracks: the longest edge's track, and the longest edge running parallel beside it
  const byLen = [...set].map((id) => net.edges.get(id)!).sort((a, b) => b.len - a.len);
  const A = walkTrack(g, byLen[0], set);
  const inA = new Set(A.map((s) => s.edge));
  let SA = sampleSteps(g, A);
  let B: Step[] | null = null;
  for (const e of byLen) {
    if (inA.has(e.id)) continue;
    const geo = net.geo(e), m = Math.floor(geo.n / 2);
    const near = nearestSample(SA, geo.pts[m * 3], geo.pts[m * 3 + 2]);
    const q = SA[near.i], dot = Math.abs(geo.tan[m * 2] * q.tx + geo.tan[m * 2 + 1] * q.tz);
    if (near.d > 0.3 && near.d < 1.7 && dot > 0.95) { B = walkTrack(g, e, set, inA); break; }
  }
  if (!B) { res.error = 'Not a double track (no parallel second track)'; return res; }
  // orient B along A
  let SB = sampleSteps(g, B);
  {
    const m = SB[Math.floor(SB.length / 2)], q = SA[nearestSample(SA, m.x, m.z).i];
    if (m.tx * q.tx + m.tz * q.tz < 0) { B = B.reverse().map((s) => ({ edge: s.edge, dir: -s.dir })); SB = sampleSteps(g, B); }
  }
  // the double stretch: where B runs beside A (in A's distance)
  let lo = Infinity, hi = -Infinity, latSum = 0, latN = 0, sideSum = 0;
  for (const p of SB) {
    const near = nearestSample(SA, p.x, p.z), q = SA[near.i];
    if (near.d < 0.3 || near.d > 1.7 || Math.abs(p.tx * q.tx + p.tz * q.tz) < 0.97) continue;
    lo = Math.min(lo, q.u); hi = Math.max(hi, q.u);
    latSum += near.d; latN++;
    sideSum += (p.x - q.x) * -q.tz + (p.z - q.z) * q.tx;
  }
  if (!(hi - lo > 6)) { res.error = 'The tracks do not run side by side'; return res; }
  const lat = latSum / latN;
  // right-hand running: the track on the right of a direction carries that direction's trains
  const bRight = sideSum > 0;
  const rightHand = opts.rightHand ?? true;
  const bForward = rightHand ? bRight : !bRight;
  const lists = [A, B];
  const untrack = trackSplits(g, lists);
  try {
    const posOnB = (u: number) => {
      const q = sampleAt(SA, u), near = SB[nearestSample(SB, q.x, q.z).i];
      return sampleAt(SB, near.u + (q.x - near.x) * near.tx + (q.z - near.z) * near.tz);
    };
    /** The node where a track leaves the stretch at its start / end (the outer node of the step holding u). */
    const nodeOut = (L: Step[], u: number, atStart: boolean) => {
      let acc = 0;
      for (const st of L) {
        const e = net.edges.get(st.edge)!;
        if (acc + e.len >= u - 1e-6) return atStart ? startNode(g, st) : endNode(g, st);
        acc += e.len;
      }
      return endNode(g, L[L.length - 1]);
    };
    const ends = [true, false].map((atStart) => {
      const qa = sampleAt(SA, atStart ? lo : hi), qb = posOnB(atStart ? lo : hi);
      const out = atStart ? { x: -qa.tx, z: -qa.tz } : { x: qa.tx, z: qa.tz };
      return { atStart, kind: beyond(g, [nodeOut(A, qa.u, atStart), nodeOut(B, qb.u, atStart)], out) };
    });
    // ---- a pair of crossovers (one each way) before a station or depot at an end
    const D = Math.max(6, Math.min(12, Math.sqrt(60 * lat) + 2));
    const zones: { atStart: boolean; z0: number; z1: number }[] = [];
    /** A crossover from track X at u1 (A's distance) to track Y at u1 + sgn*D; null if built, else the reason. */
    const diagonal = (fromA: boolean, u1: number, sgn: number): string | null => {
      const uA = fromA ? u1 : u1 + sgn * D, uB = fromA ? u1 + sgn * D : u1;
      if (uA < lo + 0.5 || uA > hi - 0.5 || uB < lo + 0.5 || uB > hi - 0.5) return 'outside the double track';
      const pa = sampleAt(SA, uA), pb = posOnB(uB);
      // not right at a switch of either track
      for (const [L, q] of [[lists[0], pa], [lists[1], pb]] as [Step[], Sample][]) {
        for (const st of L) for (const nid of [startNode(g, st), endNode(g, st)]) {
          const n = net.nodes.get(nid);
          if (n && n.edges.length > 2 && Math.hypot(n.x - q.x, n.z - q.z) < 1.2) return 'switch too close';
        }
      }
      const tracks = new Set<number>([...lists[0].map((x) => x.edge), ...lists[1].map((x) => x.edge)]);
      const toPt = (q: Sample): SPt => ({ x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s });
      const err = (fromA ? connectS(g, owner, toPt(pa), toPt(pb), tracks, false) : connectS(g, owner, toPt(pb), toPt(pa), tracks, false)).error;
      if (err) opts.log?.(`  crossover ${fromA ? 'A->B' : 'B->A'} at ${u1.toFixed(1)}: ${err}`);
      return err;
    };
    for (const end of ends) {
      if (!(opts.crossovers ?? true) || (end.kind !== 'station' && end.kind !== 'depot')) continue;
      // scan inwards from the end: "\" (A -> B) first, then "/" (B -> A) further in, both heading towards the end
      const sgn = end.atStart ? -1 : 1;              // +1: towards the end at hi
      const edge0 = end.atStart ? lo : hi;
      const m0 = eco.money, e0 = net.nextEdge;
      let first = NaN, second = NaN;
      for (let k = 1.5; k <= 40 && isNaN(first); k += 0.75) {
        const u1 = edge0 - sgn * (k + D);               // the diagonal spans u1 .. u1 + sgn*D, ending k before the end
        if (!diagonal(true, u1, sgn)) first = u1;
      }
      if (!isNaN(first)) {
        SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
        for (let k = 1.0; k <= 40 && isNaN(second); k += 0.75) {
          const u1 = first - sgn * (k + D);
          if (zones.some((z) => Math.min(u1, u1 + sgn * D) < z.z1 + 1 && Math.max(u1, u1 + sgn * D) > z.z0 - 1)) break;
          if (!diagonal(false, u1, sgn)) second = u1;
        }
      }
      SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
      if (isNaN(first) || isNaN(second)) {
        for (let id = e0; id < net.nextEdge; id++) if (net.edges.has(id) && !lists.some((L) => L.some((x) => x.edge === id))) net.removeEdge(id);
        refund(g, owner, m0);
        SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
        res.error = `No room for crossovers before the ${end.kind} at the ${end.atStart ? 'start' : 'end'} of the double track: the tracks stay two-way`;
        continue;
      }
      res.crossovers += 2;
      const us = [first, first + sgn * D, second, second + sgn * D];
      zones.push({ atStart: end.atStart, z0: Math.min(...us), z1: Math.max(...us) });
    }
    if (res.error) { res.cost = Math.round(money0 - eco.money); return res; }
    // ---- one-way block signals, only between the crossover zones (never between a zone and the station)
    const spacing = Math.max(10, opts.signalSpacing ?? SIGNAL_SPACING);
    for (const [ti, fwdA] of [[0, !bForward], [1, bForward]] as [number, boolean][]) {
      const L = lists[ti];
      let S = sampleSteps(g, L);
      const own = (u: number) => { const q = sampleAt(SA, u); return S[nearestSample(S, q.x, q.z).i].u; };
      const zs = zones.find((z) => z.atStart), ze = zones.find((z) => !z.atStart);
      const lim0 = zs ? own(zs.z1) + 1.0 : own(lo) + 1.5, lim1 = ze ? own(ze.z0) - 1.0 : own(hi) - 1.5;
      if (lim1 - lim0 < 2) continue;
      const sw: number[] = [];
      for (const st of L) for (const nid of [startNode(g, st), endNode(g, st)]) {
        const n = net.nodes.get(nid);
        if (n && n.edges.length > 2) sw.push(S[nearestSample(S, n.x, n.z).i].u);
      }
      const okAt = (u: number) => u >= lim0 && u <= lim1 && !sw.some((v) => Math.abs(v - u) < 1.5);
      const free = (u: number, step: number) => { for (let k = 0; k < 60; k++, u += step) if (okAt(u)) return u; return NaN; };
      const sg = fwdA ? 1 : -1, from = fwdA ? lim0 : lim1, to = fwdA ? lim1 : lim0;
      const want: number[] = [];
      let u = free(from, sg * 0.5);
      while (isFinite(u) && (to - u) * sg >= 0 && want.length < 400) {
        want.push(u);
        const nx = u + sg * spacing;
        if ((to - nx) * sg < 2) break;
        u = free(nx, sg * 0.5);
      }
      const home = free(to, -sg * 0.5);
      if (isFinite(home) && (!want.length || Math.abs(home - want[want.length - 1]) > 4)) want.push(home);
      for (const w of want) {
        const q = sampleAt(S, w);
        const step = L.find((x) => x.edge === q.edge);
        if (!step) continue;
        if (!setSignal(g, q.edge, q.s, 'oneway', step.dir * sg > 0, owner)) res.signals++;
        S = sampleSteps(g, L);
        if (ti === 0) SA = S;
      }
    }
  } finally {
    untrack();
  }
  res.cost = Math.round(money0 - eco.money);
  return res;
}

// ------------------------------------------------------------------ depots

/**
 * Move a depot: build the new one (a plan from g.depots.plan of the same kind), give its vehicles the new home
 * (vehicles inside move with it; vehicles out on the line just return there later), then remove the old one.
 * 'busy' while a vehicle is on the old depot's track. Costs the new depot plus 15k demolition. Null = OK.
 */
export function relocateDepot(g: Game, depotId: number, plan: DepotPlan): string | null {
  const old = g.depots.get(depotId);
  if (!old) return 'No such depot';
  if (!plan.ok) return plan.error ?? 'Cannot build';
  if (g.vehicles.isEdgeBusy(old.edge)) return 'busy';
  for (const v of g.vehicles.map.values()) {
    const segs = (v as unknown as { segs?: { depot?: number; e: number }[] }).segs;
    if (segs && segs.some((s) => s.depot === old.id || s.e === old.edge)) return 'busy';
  }
  const eco = g.company(old.owner).economy;
  if (!eco.canAfford(plan.cost + 15000)) return 'Not enough money';
  const id = g.depots.nextId;
  const err = g.depots.commit(old.kind, plan, old.owner);
  if (err) return err;
  const nd = g.depots.get(id);
  if (!nd) return 'Depot not built';
  for (const v of g.vehicles.map.values()) {
    const vd = v as unknown as { depotId: number };
    if (vd.depotId !== old.id) continue;
    vd.depotId = id;
    v.homeX = nd.x; v.homeZ = nd.z;
  }
  const rm = g.depots.remove(old.id);
  if (rm) return rm;
  eco.spend(15000, 'construction', true);
  return null;
}
