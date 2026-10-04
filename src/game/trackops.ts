// Track operations: doubling a single track (a parallel track with turnouts, or straight into free platforms),
// making a double track directional (one-way block signals for right-hand running, and crossover pairs before
// stations and depots so every platform is reachable from both tracks), and moving a depot.
import type { Game } from './game';
import { RAIL, TRACK_TYPES, PSTEP, LINE_LEVEL } from './constants';
import { bezFromTangents, bezMinRadius, bezPoint, endTangent, arcTable, tAtS, segIntersect, angleBetween } from './geom';
import { applyEarthworks, repairFormations, DRY_MIN, TUNNEL_LINING } from './terraform';
import type { NEdge, Section } from './network';
import { planEdge, commitProposal, fitCurve, Snap, Proposal, BuildOptions, structureFactor } from './construction';
import { setSignal, SIGNAL_SPACING, autoSignalLine } from './signals';
import type { DepotPlan } from './build-ops';
import { stationLayout, defaultPlatformLength, railModeOf, railPartMode, entrancesGo, refitWarnings, entranceLandings, landingRect, entranceKind } from './stations';
import type { StationPlan, StationLevel, ThroughMode, PlatformStyle } from './stations';

/** A track as travelled: edges in order, each in direction +1 (a -> b) or -1. */
export interface Step { edge: number; dir: number }

interface Sample { u: number; x: number; z: number; y: number; tx: number; tz: number; edge: number; s: number }

const railOpts = (owner: number, extra: Partial<BuildOptions> = {}): BuildOptions => ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra });
/** Track type of a chain of track (its first edge's; standard if unknown). */
const lineType = (g: Game, steps: Step[]): string => (steps.length ? g.world.net.edges.get(steps[0].edge)?.type : undefined) ?? 'standard';

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
function connectS(g: Game, owner: number, a: SPt, b: SPt, tracks: Set<number>, dry: boolean, type?: string, infrastructureOwner = owner, junctions = false): { error: string | null; cost: number } {
  const net = g.world.net, w = g.world;
  for (const q of [a, b]) {
    const es = q.edge !== undefined ? [net.edges.get(q.edge)] : q.node !== undefined ? net.nodes.get(q.node)?.edges.map((id) => net.edges.get(id)) ?? [] : [];
    for (const e of es) if (e?.kind === 'rail') { const err = g.trackUpgradeError(owner, e.owner); if (err) return { error: err, cost: 0 }; }
  }
  const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
  if (L < 2) return { error: 'too short', cost: 0 };
  // the wire state of what it connects (plain track first)
  const typeAt = (q: SPt): string | undefined => {
    if (q.edge !== undefined) return net.edges.get(q.edge)?.type;
    const n = q.node !== undefined ? net.nodes.get(q.node) : undefined;
    const es = (n?.edges ?? []).map((id) => net.edges.get(id)!).filter(Boolean);
    return (es.find((e) => TRACK_TYPES[e.type]?.electrified) ?? es.find((e) => e.station < 0 && e.depot < 0) ?? es[0])?.type;
  };
  const ttype = [type, typeAt(a), typeAt(b)].some((t) => t && TRACK_TYPES[t]?.electrified) ? 'electric' : type ?? typeAt(b) ?? typeAt(a) ?? 'standard';
  const tt = TRACK_TYPES[ttype] ?? TRACK_TYPES.standard;
  const sa = a.tx * dx + a.tz * dz >= 0 ? 1 : -1, sb = b.tx * dx + b.tz * dz >= 0 ? 1 : -1;
  const bez = bezFromTangents(a.x, a.z, a.tx * sa, a.tz * sa, b.x, b.z, b.tx * sb, b.tz * sb, L * 0.38, L * 0.38);
  if (bezMinRadius(bez, 32) < tt.minRadius) return { error: 'curve too tight', cost: 0 };
  if (Math.abs(b.y - a.y) > tt.maxGrade * L + 0.02) return { error: 'too steep', cost: 0 };
  const tab = arcTable(bez);
  const sAtU = (u: number) => {
    let lo = 0, hi = tab.t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab.t[m] <= u) lo = m; else hi = m; }
    return tab.s[lo] + (tab.s[hi] - tab.s[lo]) * (u - tab.t[lo]) / Math.max(1e-9, tab.t[hi] - tab.t[lo]);
  };
  const p = { x: 0, z: 0 }, p2 = { x: 0, z: 0 }, dq = { x: 0, y: 0, z: 0 }, pq = { x: 0, y: 0, z: 0 };
  // A second approach crossing a single-lead turnout is a diamond, never a disconnected visual overlap.
  const diamonds: { edge: number; s: number; u: number; x: number; z: number }[] = [];
  if (junctions) for (let i = 0; i < 64; i++) {
    bezPoint(bez, i / 64, p); bezPoint(bez, (i + 1) / 64, p2);
    for (const e of net.edgesNear(Math.min(p.x, p2.x) - 0.5, Math.min(p.z, p2.z) - 0.5, Math.max(p.x, p2.x) + 0.5, Math.max(p.z, p2.z) + 0.5)) {
      if (e.id === a.edge || e.id === b.edge || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || (a.node !== undefined && (e.a === a.node || e.b === a.node)) || (b.node !== undefined && (e.a === b.node || e.b === b.node))) continue;
      const geo = net.geo(e);
      for (let j = 0; j + 1 < geo.n; j++) {
        const r = segIntersect(p.x, p.z, p2.x, p2.z, geo.pts[j * 3], geo.pts[j * 3 + 2], geo.pts[j * 3 + 3], geo.pts[j * 3 + 5]);
        if (!r || diamonds.some((c) => c.edge === e.id)) continue;
        const s = geo.cum[j] + (geo.cum[j + 1] - geo.cum[j]) * r[1], u = (i + r[0]) / 64;
        const ang = angleBetween(p2.x - p.x, p2.z - p.z, geo.pts[j * 3 + 3] - geo.pts[j * 3], geo.pts[j * 3 + 5] - geo.pts[j * 3 + 2]);
        if (Math.min(ang, Math.PI - ang) < 0.025 || net.sectionAt(e, s) !== 'ground' || Math.abs(net.heightAtS(e, s) - (a.y + (b.y - a.y) * u)) >= RAIL.clearance) continue;
        const err = g.trackUpgradeError(owner, e.owner); if (err) return { error: err, cost: 0 };
        diamonds.push({ edge: e.id, s, u, x: p.x + (p2.x - p.x) * r[0], z: p.z + (p2.z - p.z) * r[0] });
      }
    }
  }
  // Formations can dip between equal-height platforms. Fit the new lead to the actual rail height at every
  // diamond as well as its two endpoints; a straight height interpolation would leave an unsafe near crossing.
  const heights = [{ s: 0, y: a.y }, ...diamonds.map((c) => ({ s: sAtU(c.u), y: net.heightAtS(net.edges.get(c.edge)!, c.s) })).sort((x, y) => x.s - y.s), { s: tab.len, y: b.y }];
  for (let i = 1; i < heights.length; i++) if (Math.abs(heights[i].y - heights[i - 1].y) > tt.maxGrade * (heights[i].s - heights[i - 1].s) + 0.002) return { error: 'junction approach too steep', cost: 0 };
  const heightAt = (s: number) => {
    let i = 1;
    while (i + 1 < heights.length && heights[i].s < s) i++;
    const q = heights[i - 1], r = heights[i];
    return q.y + (r.y - q.y) * Math.max(0, Math.min(1, (s - q.s) / Math.max(1e-9, r.s - q.s)));
  };
  for (let i = 2; i <= 14; i++) {
    bezPoint(bez, i / 16, p);
    bezPoint(bez, (i + 0.5) / 16, p2);
    const tl = Math.hypot(p2.x - p.x, p2.z - p.z) || 1, ctx = (p2.x - p.x) / tl, ctz = (p2.z - p.z) / tl;
    for (const e of net.edgesNear(p.x - 1, p.z - 1, p.x + 1, p.z + 1)) {
      if (tracks.has(e.id) || e.id === a.edge || e.id === b.edge) continue;
      if (a.node !== undefined && (e.a === a.node || e.b === a.node)) continue;
      if (b.node !== undefined && (e.a === b.node || e.b === b.node)) continue;
      if (diamonds.some((c) => c.edge === e.id)) continue;
      const ne = net.nearestEdge(p.x, p.z, net.halfWidth(e) + 0.36, undefined, (q) => q.id === e.id);
      if (!ne) continue;
      // a track running alongside may be as close as the usual track spacing
      if (e.kind === 'rail') {
        net.pointAt(e, ne.s, pq, dq);
        const dl = Math.hypot(dq.x, dq.z) || 1;
        if (Math.abs((dq.x * ctx + dq.z * ctz) / dl) > 0.97 && Math.hypot(pq.x - p.x, pq.z - p.z) >= RAIL.spacing - 0.06) continue;
      }
      if (Math.abs(net.heightAtS(e, ne.s) - heightAt(sAtU(i / 16))) < RAIL.clearance) return { error: e.kind === 'rail' ? 'other track in the way' : 'road in the way', cost: 0 };
    }
  }
  for (const c of net.crossings.values()) if ((tracks.has(c.e1) || tracks.has(c.e2)) && Math.hypot(c.x - (a.x + b.x) / 2, c.z - (a.z + b.z) / 2) < L / 2 + 1.5) {
    // Companion junction leads may pass beside a previously registered rail diamond. The actual new
    // intersections above retain their own reservation resources; road crossings and denied titles still block.
    if (junctions && c.kind === 'diamond' && [c.e1, c.e2].every(id => {
      const e = net.edges.get(id); return e?.kind === 'rail' && !g.trackUpgradeError(owner, e.owner);
    })) continue;
    return { error: 'level crossing in the way', cost: 0 };
  }
  // Nodes carry no section flag: inspect their incident parent rails too (station insertion lays node-to-node
  // fans). Determine the sections and their price before a dry run returns, so preview and commit agree.
  const secOf = (q: SPt): 'ground' | Section['type'] => {
    if (q.edge !== undefined) { const e = net.edges.get(q.edge); return e ? net.sectionAt(e, q.s ?? 0) : 'ground'; }
    const n = q.node !== undefined ? net.nodes.get(q.node) : undefined;
    const es = (n?.edges ?? []).map((id) => net.edges.get(id)!).filter((e) => e?.kind === 'rail');
    const at = (e: NEdge) => net.sectionAt(e, e.a === n!.id ? 0 : e.len);
    const e = es.find((e) => tracks.has(e.id) && at(e) !== 'ground') ?? es.find((e) => tracks.has(e.id)) ?? es[0];
    return e ? at(e) : 'ground';
  };
  const secA = secOf(a), secB = secOf(b);
  const inherited = secA === secB ? secA : secA === 'ground' ? secB : secB === 'ground' ? secA : 'ground';
  const K = Math.max(1, Math.ceil(tab.len / 0.25));
  const sections: Section[] = [];
  let price = 2 * TURNOUT_COST + diamonds.length * 15000;
  for (let i = 0; i < K; i++) {
    const s0 = tab.len * i / K, s1 = tab.len * (i + 1) / K, s = (s0 + s1) / 2;
    bezPoint(bez, tAtS(tab, s), p);
    const y = heightAt(s), terrain = w.heightAt(p.x, p.z), depth = terrain - y;
    // Even a legacy ground parent cannot make a deep connecting piece an open cutting. Low land requires a
    // bridge or a covered tunnel; a shallow formation below the water line cannot be built at this height.
    const sec = inherited !== 'ground' ? inherited : depth >= TUNNEL_LINING.rail + TUNNEL_LINING.cover ? 'tunnel' : y - terrain > 1.4 || terrain < DRY_MIN ? 'bridge' : 'ground';
    if (sec !== 'tunnel' && y - 0.1 < DRY_MIN - 0.005) return { error: 'Below water line: raise or tunnel', cost: 0 };
    if (sec === 'bridge' && depth > 0.2) return { error: 'Hill blocks bridge: use tunnel', cost: 0 };
    price += (s1 - s0) * tt.costPerUnit * (sec === 'ground' ? 1 : structureFactor('rail', sec, Math.abs(depth)));
    if (sec === 'ground') continue;
    const last = sections[sections.length - 1];
    if (last && last.type === sec && Math.abs(last.s1 - s0) < 0.001) last.s1 = s1;
    else sections.push({ s0, s1, type: sec });
  }
  if (diamonds.some((c) => sections.some((s) => s.s0 <= sAtU(c.u) && s.s1 >= sAtU(c.u)))) return { error: 'junction needs a ground approach', cost: 0 };
  const cost = Math.round(price);
  if (dry) return { error: null, cost };
  for (const q of [a, b]) if (q.edge !== undefined && g.vehicles.isEdgeBusy(q.edge)) return { error: 'train in the way', cost };
  const eco = g.company(owner).economy;
  if (!eco.canAfford(cost)) return { error: 'Not enough money', cost };
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
  const curve = { ...bez, x0: A.x, z0: A.z, x3: B.x, z3: B.z }, len = arcTable(curve).len;
  const m = Math.max(2, Math.ceil(len / PSTEP) + 1);
  const prof = new Float32Array(m);
  for (let i = 0; i < m; i++) prof[i] = heightAt(Math.min(i * PSTEP, len) * tab.len / len);
  prof[0] = A.y; prof[m - 1] = B.y;
  const e = net.addEdge('rail', na, nb, curve, prof, sections.map((s) => ({ ...s, s0: s.s0 * len / tab.len, s1: s.s1 * len / tab.len })), ttype, infrastructureOwner);
  for (const c of diamonds) {
    const tab = net.table(e);
    let lo = 0, hi = tab.t.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tab.t[m] <= c.u) lo = m; else hi = m; }
    const s = tab.s[lo] + (tab.s[hi] - tab.s[lo]) * (c.u - tab.t[lo]) / Math.max(1e-9, tab.t[hi] - tab.t[lo]);
    const crossing = { id: net.nextCrossing++, kind: 'diamond' as const, e1: e.id, s1: s, e2: c.edge, s2: c.s, x: c.x, z: c.z };
    net.crossings.set(crossing.id, crossing);
    g.vehicles.onCrossingAdded(crossing);
  }
  applyEarthworks(w, [e]);
  for (let i = 0; i <= 8; i++) {
    const s = e.len * i / 8;
    if (net.sectionAt(e, s) !== 'ground') continue;
    bezPoint(curve, tAtS(net.table(e), s), p); w.removeTreesNear(p.x, p.z, 0.8);
  }
  eco.spend(cost, 'construction');
  g.onNetworkChanged();
  return { error: null, cost };
}

// ------------------------------------------------------------------ doubling a single track

export interface DoubleEnd {
  /** 'turnout': leaves/joins the old rail at u; 'platform': reaches the companion platform; 'track': joins the second junction lead */
  kind: 'turnout' | 'platform' | 'track';
  u: number;
  node: number;
  snap?: Snap;
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
  /** Complete approaches/junctions; existing parallel sections are reused rather than tripled. */
  complete?: boolean;
  reuse?: (Snap | null)[];
  skipped?: number[];
  joined?: boolean[];
  junctionWindows?: BuildOptions['junctionWindows'];
  flying?: boolean;
}

export interface DoubleOptions {
  /** Local second-track detours, smoothly joining the original formation at either side of the obstacle. */
  detours?: { at: number; reach: number; extra: number }[];
  /** Longer spans give the profile solver room for ramps over conflicting junction moves. */
  flying?: boolean;
}

/** Order the given edges into one continuous track (in the direction from the first listed edge to the last). */
function chainOf(g: Game, edgeIds: number[], owner: number): { steps: Step[]; error?: string } {
  const net = g.world.net;
  const ids = [...new Set(edgeIds)].filter((id) => net.edges.has(id));
  if (!ids.length) return { steps: [], error: 'No track selected' };
  for (const id of ids) {
    const e = net.edges.get(id)!;
    if (e.kind !== 'rail') return { steps: [], error: 'Only railway track can be doubled' };
    const access = g.trackUpgradeError(owner, e.owner);
    if (access) return { steps: [], error: access };
    if (e.station >= 0 || e.depot >= 0) return { steps: [], error: 'Cannot double platform or depot tracks' };
  }
  const set = new Set(ids);
  const steps = walkTrack(g, net.edges.get(ids[0])!, set);
  if (steps.length !== ids.length) return { steps: [], error: 'Track not continuous' };
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
 * shared-formation discount applies). Complete upgrades reach the companion platforms and second junction
 * leads, crossing other leads at registered diamonds. Partial upgrades close with turnouts for temporary loops.
 * Nothing is built; errors locate the pieces that cannot fit. Existing parallel pieces are reused.
 */
export function planDoubleTrack(g: Game, edgeIds: number[], side: 1 | -1, owner: number, complete = true, options: DoubleOptions = {}): DoublePlan {
  const net = g.world.net;
  const plan: DoublePlan = { ok: true, errors: [], warnings: [], cost: 0, owner, side, steps: [], length: 0, points: [], start: { kind: 'turnout', u: 0, node: -1 }, end: { kind: 'turnout', u: 0, node: -1 }, proposals: [] };
  const fail = (m: string) => { plan.ok = false; if (!plan.errors.includes(m)) plan.errors.push(m); return plan; };
  const ch = chainOf(g, edgeIds, owner);
  if (ch.error) return fail(ch.error);
  plan.steps = ch.steps;
  plan.complete = complete;
  plan.flying = options.flying;
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
  for (let i = 0; !complete && i + 1 < ch.steps.length; i++) {
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
      else return fail(`Branch on this side at ${m10(q.u)} m`);
    }
  }
  const offset = (u: number) => {
    const q = sampleAt(S, u), nv = nrm(q);
    let extra = 0;
    for (const d of options.detours ?? []) {
      const t = Math.abs(u - d.at) / d.reach;
      if (t < 1) extra = Math.max(extra, d.extra * (1 + Math.cos(Math.PI * t)) / 2);
    }
    return { x: q.x + nv.x * (sp + extra), z: q.z + nv.z * (sp + extra) };
  };
  const offAt = (u: number) => {
    const q = sampleAt(S, u), p = offset(u);
    if (!options.detours?.length) return { ...q, ...p, u };
    const a = offset(Math.max(0, u - 0.05)), b = offset(Math.min(U, u + 0.05)), len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { u, ...p, y: q.y, tx: (b.x - a.x) / len, tz: (b.z - a.z) / len };
  };
  const onMain = (u: number): SPt => { const q = sampleAt(S, u); return { x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s }; };
  const isSwitchNear = (u: number) => { const q = sampleAt(S, u); return [...net.nodeGrid.query(q.x - 1.5, q.z - 1.5, q.x + 1.5, q.z + 1.5)].some((id) => { const n = net.nodes.get(id); return !!n && n.kind === 'rail' && n.edges.length > 2 && Math.hypot(n.x - q.x, n.z - q.z) < 1.5; }); };
  // Complete upgrades reach companion platforms or the second junction lead; temporary loops end in turnouts.
  const endOf = (atStart: boolean): { end: DoubleEnd; inner: number; err?: string } | null => {
    const limit = atStart ? uMin : U - uMax;
    if (limit === 0 && complete) {
      const nid = atStart ? startNode(g, ch.steps[0]) : endNode(g, ch.steps[ch.steps.length - 1]);
      const n = net.nodes.get(nid)!;
      const q = atStart ? S[0] : S[S.length - 1];
      const nv = nrm(q);
      const stEdge = n.edges.map((id) => net.edges.get(id)!).find((e) => e && e.station >= 0);
      if (stEdge) {
        const st = g.stations.get(stEdge.station);
        let best = -1, bl = Infinity, score = Infinity;
        for (const t of st ? g.stations.trackEnds(st) : []) for (const cand of [t.front, t.back]) {
          const m = net.nodes.get(cand);
          if (!m || cand === nid || (!complete && m.edges.length !== 1) || g.trackUpgradeError(owner, st!.owner)) continue;
          const dx = m.x - n.x, dz = m.z - n.z, lat = dx * nv.x + dz * nv.z, along = dx * q.tx + dz * q.tz;
          const rank = Math.abs(lat) + (lat < 0 ? 2 : 0);
          if (Math.abs(along) < 0.3 && Math.abs(lat) > 0.3 && Math.abs(lat) < 1.7 && (complete || lat > 0) && rank < score) { bl = lat; score = rank; best = cand; }
        }
        if (best >= 0) {
          const len = Math.max(7, Math.min(14, Math.sqrt(60 * Math.abs(bl - sp)) + 4));
          let why = 'no room';
          // Earlier loop entrances can occupy the shortest approach. Reach farther along their straight
          // second rail, retaining those turnouts and fitting the station lead around them.
          for (const extra of complete ? [0, 4, 8, 16, 24] : [0]) {
            if (len + extra >= U / 2) break;
            const inner = atStart ? len + extra : U - len - extra;
            const m = net.nodes.get(best)!, o = offAt(inner);
            const existing = complete && net.nearestEdge(o.x, o.z, 0.06, 'rail', (e) => !chainSet.has(e.id) && e.station < 0 && e.depot < 0 && !g.trackUpgradeError(owner, e.owner));
            if (existing && m.edges.length > 1) return { end: { kind: 'platform', u: atStart ? 0 : U, node: best }, inner };
            const target: SPt = existing ? { ...o, edge: existing.edge.id, s: existing.s } : o;
            const allowed = new Set([...chainSet, ...(existing ? [...besideTracks(g, [existing.edge], 20)].filter((id) => !g.trackUpgradeError(owner, net.edges.get(id)!.owner)) : [])]);
            const r = connectS(g, owner, { x: m.x, z: m.z, y: m.y, tx: q.tx, tz: q.tz, node: best }, target, allowed, true, undefined, st!.owner, complete);
            if (!r.error) return { end: { kind: 'platform', u: atStart ? 0 : U, node: best }, inner };
            why = r.error;
          }
          if (complete) return { end: { kind: 'platform', u: atStart ? 0 : U, node: best }, inner: NaN, err: why };
        }
        if (complete) return { end: { kind: 'turnout', u: 0, node: -1 }, inner: NaN, err: 'A second station platform is needed' };
      }
      if (complete && !stEdge && n.edges.length >= 3) {
        const target = offAt(atStart ? 0 : U);
        const twin = net.nearestEdge(target.x, target.z, 0.12, 'rail', (e) => !chainSet.has(e.id) && e.station < 0 && e.depot < 0 && !g.trackUpgradeError(owner, e.owner));
        if (twin && Math.abs(net.heightAtS(twin.edge, twin.s) - q.y) < 0.06) {
          const inner = atStart ? 8 : U - 8;
          const o = offAt(inner), t: SPt = { ...target, edge: twin.edge.id, s: twin.s };
          // A connector's curve contains none of the original trunk's split approaches. They are the same
          // authorised junction formation, so its companion lead may run close before it diverges.
          const approaches = n.edges.map(id => net.edges.get(id)!).filter(e => e?.kind === 'rail');
          const allowed = new Set([...chainSet, twin.edge.id, ...[...besideTracks(g, [...approaches, twin.edge], 24)].filter(id => {
            const e = net.edges.get(id); return e?.kind === 'rail' && !g.trackUpgradeError(owner, e.owner);
          })]);
          const r = connectS(g, owner, t, o, allowed, true, undefined, net.edges.get(q.edge)!.owner, true);
          if (!r.error) return { end: { kind: 'track', u: atStart ? 0 : U, node: -1, snap: { kind: 'edge', x: target.x, z: target.z, y: q.y, edge: twin.edge.id, s: twin.s } }, inner };
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
  if (!a || isNaN(a.inner)) return fail(`No room for start turnout: ${a?.err ?? ''}`);
  if (!b || isNaN(b.inner)) return fail(`No room for end turnout: ${b?.err ?? ''}`);
  plan.start = a.end; plan.end = b.end;
  const uS = a.inner, uE = b.inner;
  if (uE - uS < 3) return fail('Too short to double');
  // where the new track crosses other roads and tracks: no segment ends there
  const cross: number[] = [];
  plan.junctionWindows = [];
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
        if (t >= 0 && t <= 1 && v >= 0 && v <= 1) {
          cross.push(p.u + (q.u - p.u) * t);
          if (complete && e.kind === 'rail' && !g.trackUpgradeError(owner, e.owner)) {
            const angle = angleBetween(rx, rz, sx, sz);
            plan.junctionWindows!.push({ edge: e.id, x: ax + rx * t, z: az + rz * t, r: 1 + RAIL.spacing / Math.max(0.025, Math.sin(angle)) });
          }
        }
      }
    }
  }
  // (segment ends keep 4.5 units from crossings, so the track can meet a level crossing's height)
  const CR = options.flying ? Math.max(4.5, RAIL.clearance / (TRACK_TYPES[lineType(g, ch.steps)]?.maxGrade ?? 0.035) + 3) : 4.5;
  const blocked = (u: number) => cross.find((c) => Math.abs(c - u) < CR);
  const us: number[] = [uS];
  for (let guard = 0; guard < 2000; guard++) {
    const u = us[us.length - 1];
    if (u >= uE - 1e-6) break;
    const seg = options.flying ? 120 : SEG;
    let nx = u + seg >= uE - 3 ? uE : u + seg;
    const c = nx < uE ? blocked(nx) : undefined;
    if (c !== undefined) nx = c - CR - u >= 2 ? c - CR : Math.min(uE, c + CR);
    if (nx >= uE - 1.5) nx = uE;
    us.push(nx);
  }
  // Include the ends of already-parallel loop track so a later attempt extends it all the way to the platforms.
  if (complete) for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || chainSet.has(e.id) || e.station >= 0 || e.depot >= 0 || g.trackUpgradeError(owner, e.owner)) continue;
    for (const nid of [e.a, e.b]) {
      const n = net.nodes.get(nid)!, near = nearestSample(S, n.x, n.z), q = S[near.i];
      const u = q.u + (n.x - q.x) * q.tx + (n.z - q.z) * q.tz, o = offAt(u);
      if (u > uS + 0.5 && u < uE - 0.5 && Math.hypot(n.x - o.x, n.z - o.z) < 0.06) us.push(u);
    }
  }
  us.sort((a, b) => a - b);
  for (let i = us.length - 1; i > 0; i--) if (us[i] - us[i - 1] < 0.15) us.splice(i, 1);
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
    if (!options.detours?.length && dev > 0.03 && queue[0] - A.u > 1.5) { queue.unshift((A.u + queue[0]) / 2); continue; }
    pts.push(B);
    queue.shift();
  }
  plan.points = pts;
  const twinAt = (p: (typeof pts)[number]) => net.nearestEdge(p.x, p.z, 0.06, 'rail', (e) => !chainSet.has(e.id) && e.station < 0 && e.depot < 0 && !g.trackUpgradeError(owner, e.owner) && Math.abs(net.heightAtS(e, net.table(e).len / 2) - p.y) < 0.1);
  plan.reuse = pts.map((p) => {
    const e = complete ? twinAt(p) : null;
    if (!e) return null;
    const n = net.nearestNode(p.x, p.z, 0.08, 'rail', (n) => n.edges.includes(e.edge.id));
    return n ? nodeSnapOf(g, n.id) : { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: e.edge.id, s: e.s };
  });
  plan.skipped = [];
  // Plan every segment with exact node directions, without consuming IDs or changing the network version.
  net.withTemporaryNodes('rail', pts.map((p) => ({ x: p.x, y: p.y, z: p.z, dx: -p.tx, dz: -p.tz })), owner, (tmp) => {
    for (let k = 0; k + 1 < pts.length; k++) {
      const mid = offAt((pts[k].u + pts[k + 1].u) / 2);
      const prop = planEdge(g, plan.reuse![k] ?? nodeSnapOf(g, tmp[k].id), plan.reuse![k + 1] ?? nodeSnapOf(g, tmp[k + 1].id), railOpts(owner, { type: lineType(g, plan.steps), infrastructureOwner: net.edges.get(sampleAt(S, mid.u).edge)!.owner, junctionUpgrade: complete, junctionWindows: plan.junctionWindows, crossing: options.flying ? 'over' : 'auto' }));
      if (complete && plan.reuse![k] && plan.reuse![k + 1] && twinAt(mid)) { plan.skipped!.push(k); prop.ok = true; prop.errors = []; prop.cost = 0; prop.tracks = []; }
      plan.proposals.push(prop);
      if (!prop.ok) fail(`New track (${m10(pts[k].u)}-${m10(pts[k + 1].u)} m of ${m10(U)} m): ${prop.errors[0] ?? 'cannot build'}`);
    }
  });
  const linked = (snap: Snap | null, target: DoubleEnd) => {
    if (!snap || target.kind !== 'platform') return false;
    const seen = new Set<number>(), queue: { node: number; len: number }[] = snap.kind === 'node' ? [{ node: snap.node!, len: 0 }] : [net.edges.get(snap.edge!)!.a, net.edges.get(snap.edge!)!.b].map((node) => ({ node, len: 0 }));
    while (queue.length) {
      const q = queue.shift()!;
      if (q.node === target.node) return true;
      if (seen.has(q.node) || q.len > 25) continue;
      seen.add(q.node);
      for (const id of net.nodes.get(q.node)?.edges ?? []) {
        const e = net.edges.get(id)!;
        if (chainSet.has(id) || e.station >= 0 || e.depot >= 0 || e.kind !== 'rail') continue;
        queue.push({ node: e.a === q.node ? e.b : e.a, len: q.len + e.len });
      }
    }
    return false;
  };
  plan.joined = [linked(plan.reuse[0], plan.start), linked(plan.reuse[pts.length - 1], plan.end)];
  const conn = (e: DoubleEnd, inner: number) => {
    if (plan.joined![e === plan.start ? 0 : 1]) return 0;
    const q = plan.reuse![e === plan.start ? 0 : pts.length - 1];
    const o: SPt = { ...offAt(inner), ...(q?.kind === 'node' ? { node: q.node } : q?.kind === 'edge' ? { edge: q.edge, s: q.s } : {}) };
    const reused = q?.kind === 'edge' ? [net.edges.get(q.edge!)!] : q?.kind === 'node' ? net.nodes.get(q.node!)!.edges.map((id) => net.edges.get(id)!) : [];
    const allowed = new Set([...chainSet, ...[...besideTracks(g, reused, 20)].filter((id) => !g.trackUpgradeError(owner, net.edges.get(id)!.owner))]);
    if (e.kind === 'track') return connectS(g, owner, { ...o, x: e.snap!.x, z: e.snap!.z, y: e.snap!.y, edge: e.snap!.edge, s: e.snap!.s }, o, new Set([...chainSet, e.snap!.edge!]), true, undefined, net.edges.get(sampleAt(S, e.u).edge)!.owner, true).cost;
    if (e.kind === 'platform') { const m = net.nodes.get(e.node)!; return connectS(g, owner, { x: m.x, z: m.z, y: m.y, tx: o.tx, tz: o.tz, node: e.node }, o, allowed, true, undefined, m.owner, complete).cost; }
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
 * fails. Then, unless `finish` is false, the pair is made directional with finishDoubleTrack. `consent`: whether a
 * piece as it will be built (crossings, demolitions; after any fallback crossing mode) may be built at all.
 */
export function commitDoubleTrack(g: Game, plan: DoublePlan, finish = true, opts: FinishOpts = {}, consent?: (p: Proposal) => boolean): DoubleResult {
  const net = g.world.net;
  const owner = plan.owner;
  const res: DoubleResult = { error: null, cost: 0, edges: [], signals: 0, crossovers: 0 };
  if (!plan.ok) { res.error = plan.errors[0] ?? 'Cannot build'; return res; }
  const eco = g.company(owner).economy;
  if (!eco.canAfford(plan.cost)) { res.error = 'Not enough money'; return res; }
  for (const s of plan.steps) {
    const e = net.edges.get(s.edge);
    if (!e) { res.error = 'The track changed, plan again'; return res; }
    const access = g.trackUpgradeError(owner, e.owner);
    if (access) { res.error = access; return res; }
  }
  // Reused companion rail and endpoint leads can have different owners from the main formation.
  // Check them before any split: rollback deliberately preserves splits of pre-existing track.
  for (const q of [...(plan.reuse ?? []), ...[plan.start, plan.end].map((e) => e.kind === 'platform' ? { kind: 'node' as const, node: e.node } : e.snap)]) {
    if (!q) continue;
    const ids = q.kind === 'node' ? net.nodes.get(q.node!)?.edges : q.edge !== undefined && net.edges.has(q.edge) ? [q.edge] : undefined;
    if (!ids?.length) { res.error = 'The track changed, plan again'; return res; }
    for (const id of ids) {
      const e = net.edges.get(id);
      if (e?.kind !== 'rail') continue;
      const access = g.trackUpgradeError(owner, e.owner);
      if (access) { res.error = access; return res; }
    }
  }
  for (const e of [plan.start, plan.end]) if (e.kind === 'platform' && (!net.nodes.has(e.node) || (!plan.complete && net.nodes.get(e.node)?.edges.length !== 1))) { res.error = 'The track changed, plan again'; return res; }
  const money0 = eco.money, e0 = net.nextEdge, c0 = net.nextCrossing;
  const main = plan.steps.map((s) => ({ ...s }));
  const untrack = trackSplits(g, [main]);
  const retained = new Set(net.edges.keys());
  const retainSplit = (old: NEdge, a: NEdge, b: NEdge) => { if (retained.delete(old.id)) { retained.add(a.id); retained.add(b.id); } };
  net.onSplit.push(retainSplit);
  const created = () => { const out: number[] = []; for (let id = e0; id < net.nextEdge; id++) if (net.edges.has(id) && !retained.has(id)) out.push(id); return out; };
  const rollback = (why: string) => {
    for (const id of created()) net.removeEdge(id);
    refund(g, owner, money0);
    g.onNetworkChanged();
    res.error = why;
    return res;
  };
  try {
    const pts = plan.points;
    const original = sampleSteps(g, main);
    const nodes = pts.map((p, k) => {
      const reuse = plan.reuse?.[k];
      if (reuse) {
        const n = net.nearestNode(p.x, p.z, 0.08, 'rail', (n) => n.edges.some((id) => retained.has(id)) && n.edges.every((id) => !g.trackUpgradeError(owner, net.edges.get(id)!.owner)));
        if (n) return n.id;
        const e = net.nearestEdge(p.x, p.z, 0.08, 'rail', (e) => retained.has(e.id) && !main.some((s) => s.edge === e.id) && !g.trackUpgradeError(owner, e.owner));
        if (e) return net.splitEdge(e.edge.id, e.s)?.node.id ?? -1;
        return -1;
      }
      const sample = sampleAt(original, p.u);
      return net.addNode('rail', p.x, p.y, p.z, -p.tx, -p.tz, net.edges.get(sample.edge)!.owner).id;
    });
    if (nodes.includes(-1)) return rollback('Existing second track changed, plan again');
    const first = net.nodes.get(nodes[0])!;
    const dropNodes = () => { for (const id of nodes) { const n = net.nodes.get(id); if (n && !n.edges.length) net.removeNode(id); } };
    for (let k = 0; k + 1 < pts.length; k++) {
      if (plan.skipped?.includes(k)) continue;
      let ok = false;
      for (const extra of (plan.flying ? [{ crossing: 'over' as const }] : [{}, { crossing: 'level' as const }, { crossing: 'over' as const }, { crossing: 'under' as const }])) {
        const sample = sampleAt(original, (pts[k].u + pts[k + 1].u) / 2);
        const prop = planEdge(g, nodeSnapOf(g, nodes[k]), nodeSnapOf(g, nodes[k + 1]), railOpts(owner, { type: lineType(g, main), infrastructureOwner: net.edges.get(sample.edge)!.owner, junctionUpgrade: plan.complete, junctionWindows: plan.junctionWindows, ...extra }));
        if (!prop.ok || (consent && !consent(prop)) || commitProposal(g, prop)) continue;
        ok = true;
        break;
      }
      if (!ok) { const r = rollback(`Build failed at ${Math.round(pts[k].u * 10)} m: ground or network changed`); dropNodes(); return r; }
    }
    const cur = nodes[nodes.length - 1];
    const tracks = () => new Set<number>([...main.map((s) => s.edge), ...created(), ...nodes.flatMap((id) => net.nodes.get(id)?.edges.filter((id) => !g.trackUpgradeError(owner, net.edges.get(id)!.owner)) ?? [])]);
    const nodePt = (id: number, t: { tx: number; tz: number }): SPt => { const n = net.nodes.get(id)!; return { x: n.x, z: n.z, y: n.y, tx: t.tx, tz: t.tz, node: id }; };
    const mainPt = (u: number): SPt => { const q = sampleAt(sampleSteps(g, main), u); return { x: q.x, z: q.z, y: q.y, tx: q.tx, tz: q.tz, edge: q.edge, s: q.s }; };
    const last = pts[pts.length - 1];
    const targetPt = (end: DoubleEnd, t: { tx: number; tz: number }): SPt => {
      if (end.kind === 'platform') return nodePt(end.node, t);
      if (end.kind === 'track') {
        const q = end.snap!, n = net.nearestNode(q.x, q.z, 0.08, 'rail');
        if (n) return nodePt(n.id, t);
        const e = net.nearestEdge(q.x, q.z, 0.08, 'rail')!;
        return { ...t, x: q.x, z: q.z, y: q.y, edge: e.edge.id, s: e.s };
      }
      return mainPt(end.u);
    };
    const allowed = () => new Set([...tracks(), ...[plan.start, plan.end].flatMap((q, i) => {
      const junction = q.kind === 'track' ? net.nodes.get(i === 0 ? startNode(g, main[0]) : endNode(g, main[main.length - 1]))?.edges ?? [] : [];
      const approaches = [...junction, ...(q.snap?.edge !== undefined ? [q.snap.edge] : [])].map(id => net.edges.get(id)!).filter(e => e?.kind === 'rail');
      return [...(q.snap?.edge !== undefined ? [q.snap.edge] : []), ...[...besideTracks(g, approaches, 24)].filter(id => {
        const e = net.edges.get(id); return e?.kind === 'rail' && !g.trackUpgradeError(owner, e.owner);
      })];
    })]);
    const r1 = plan.joined?.[1] ? { error: null } : connectS(g, owner, nodePt(cur, last), targetPt(plan.end, last), allowed(), false, undefined, net.nodes.get(cur)!.owner, plan.complete);
    if (r1.error) { const r = rollback(`End connection: ${r1.error}`); dropNodes(); return r; }
    const r2 = plan.joined?.[0] ? { error: null } : connectS(g, owner, targetPt(plan.start, pts[0]), nodePt(first.id, pts[0]), allowed(), false, undefined, first.owner, plan.complete);
    if (r2.error) { const r = rollback(`Start connection: ${r2.error}`); dropNodes(); return r; }
  } finally {
    untrack();
    net.onSplit = net.onSplit.filter((f) => f !== retainSplit);
  }
  res.edges = created();
  res.cost = Math.round(money0 - eco.money);
  g.onNetworkChanged();
  if (finish) {
    const onNewLine = (id: number) => {
      const e = net.edges.get(id); if (!e || e.station >= 0 || e.depot >= 0 || main.some((s) => s.edge === id)) return false;
      const p = { x: 0, y: 0, z: 0 }; net.pointAt(e, e.len / 2, p);
      for (let i = 0; i + 1 < plan.points.length; i++) {
        const a = plan.points[i], b = plan.points[i + 1], dx = b.x - a.x, dz = b.z - a.z;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        if (Math.hypot(p.x - a.x - dx * t, p.z - a.z - dz * t) < 0.08) return true;
      }
      return false;
    };
    const reused = plan.reuse?.flatMap((q) => q ? net.nearestNode(q.x, q.z, 0.08, 'rail')?.edges.filter((id) => retained.has(id) && onNewLine(id)) ?? [] : []) ?? [];
    net.onSplit.push(retainSplit);
    const trackMain = trackSplits(g, [main]);
    let f: FinishResult;
    try { f = finishDoubleTrack(g, [...main.map((s) => s.edge), ...reused, ...res.edges], owner, { ...opts, ...(plan.complete === false ? { mergeEnds: true } : {}) }); }
    finally { trackMain(); net.onSplit = net.onSplit.filter((fn) => fn !== retainSplit); }
    res.signals = f.signals; res.crossovers = f.crossovers;
    if (f.error) res.finishError = f.error;
    res.cost += f.cost;
    res.edges = created();
  }
  if (net.nextCrossing > c0) {
    net.onSplit.push(retainSplit);
    try { res.signals += autoSignalLine(g, [...main.map((s) => s.edge), ...res.edges], owner).placed; }
    finally { net.onSplit = net.onSplit.filter((fn) => fn !== retainSplit); }
    res.edges = created();
    res.cost = Math.round(money0 - eco.money);
  }
  return res;
}

// ------------------------------------------------------------------ directional double track

export interface FinishOpts {
  /** Temporary loops close on the single main at both ends; station crossovers belong to the later full upgrade. */
  mergeEnds?: boolean;
  /** trains keep to the right-hand track (default true) */
  rightHand?: boolean;
  /** block signal spacing (default SIGNAL_SPACING = 50 units = 500 m) */
  signalSpacing?: number;
  /** add crossovers before stations and depots at the ends (default true) */
  crossovers?: boolean;
  /** where crossovers go: before a station / depot beyond an end ('stations', default), or at every end where the tracks do not merge ('always': pairing two lines' tracks) */
  crossoversAt?: 'stations' | 'always';
  /** take out crossovers on plain line between stations first (not by a depot branch) */
  normalise?: boolean;
  /** at a station end of the stretch, the first units are its throat (a turnout ladder): the crossovers go beyond */
  throatLength?: number;
  /** Inline stations with turnback services must have crossovers on both sides before making track one-way. */
  turnbackStations?: number[];
  /** diagnostics */
  log?: (s: string) => void;
}

export interface FinishResult { signals: number; crossovers: number; cost: number; error?: string; /** crossovers taken out (normalise) */ removed?: number }

/** What lies just beyond an end of a double stretch: the tracks merging, a station or a depot, or open line. */
function beyond(g: Game, nodes: number[], outward: { x: number; z: number }, reach = 30): 'merge' | 'station' | 'depot' | 'open' {
  const net = g.world.net;
  const through = new Set<number>();
  for (const st of g.stations.all()) if (st.rail) for (const id of st.rail.throughEdges) through.add(id);
  const seen = new Map<number, number>();
  let kind: 'merge' | 'station' | 'depot' | 'open' = 'open';
  const queue: { n: number; d: number; from: number; root: number }[] = nodes.map((n, i) => ({ n, d: 0, from: -1, root: i }));
  const roots = new Map<number, Set<number>>();
  let merged = false;
  while (queue.length) {
    const q = queue.shift()!;
    const set = roots.get(q.n) ?? new Set<number>();
    set.add(q.root);
    roots.set(q.n, set);
    if (set.size > 1) merged = true;
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
      if (e.station >= 0 || through.has(e.id)) { kind = 'station'; continue; }
      if (e.depot >= 0) { if (kind === 'open') kind = 'depot'; continue; }
      if (q.d + e.len <= reach) queue.push({ n: o, d: q.d + e.len, from: eid, root: q.root });
    }
  }
  // A turnout ladder also connects the two approaches; it must not hide the station that needs crossovers.
  return kind === 'station' || kind === 'depot' ? kind : merged ? 'merge' : kind;
}

/**
 * Make a double track directional: each track gets one running direction (right-hand running by default) with
 * one-way block signals about every 500 m, and where a station or depot lies just beyond an end of the double
 * stretch, a pair of crossovers (one each way) is laid shortly before it so trains on either track reach every
 * platform / the depot and can leave on the right track. `edgeIds`: the edges of a two-track build (or of a
 * doubled line with its new track). Own stations whose platform (or through) tracks continue the given track on
 * both sides lie inline: the stretch runs through them (a metro line of side-platform stations: one call for the
 * whole line, crossovers only before its termini). When crossovers cannot be laid there, no one-way signals are
 * set (the tracks stay usable both ways) and `error` says why.
 */
export function finishDoubleTrack(g: Game, edgeIds: number[], owner: number, opts: FinishOpts = {}): FinishResult {
  const net = g.world.net;
  const res: FinishResult = { signals: 0, crossovers: 0, cost: 0 };
  const eco = g.company(owner).economy, money0 = eco.money;
  for (const id of edgeIds) { const e = net.edges.get(id); const err = e?.kind === 'rail' && g.trackUpgradeError(owner, e.owner); if (err) { res.error = err; return res; } }
  const set = new Set(edgeIds.filter((id) => { const e = net.edges.get(id); return !!e && e.kind === 'rail' && !g.trackUpgradeError(owner, e.owner) && e.station < 0 && e.depot < 0; }));
  if (set.size < 2) { res.error = 'Not a double track'; return res; }
  // inline stations: platform / through tracks with given track on both sides (no crossovers or signals on them)
  const inline = new Set<number>();
  for (const st of g.stations.all()) {
    if (!st.rail || g.trackUpgradeError(owner, st.owner)) continue;
    for (const id of [...st.rail.edges, ...st.rail.throughEdges]) {
      const e = net.edges.get(id);
      const cont = (nid: number) => { const n = net.nodes.get(nid); return !!n && n.edges.length === 2 && n.edges.some((x) => x !== id && set.has(x)); };
      if (e && cont(e.a) && cont(e.b)) inline.add(id);
    }
  }
  const walkSet = inline.size ? new Set([...set, ...inline]) : set;
  // the two tracks: the longest edge's track, and the longest edge running parallel beside it
  const byLen = [...set].map((id) => net.edges.get(id)!).sort((a, b) => b.len - a.len);
  const A = walkTrack(g, byLen[0], walkSet);
  const inA = new Set(A.map((s) => s.edge));
  let SA = sampleSteps(g, A);
  let B: Step[] | null = null;
  for (const e of byLen) {
    if (inA.has(e.id)) continue;
    const geo = net.geo(e), m = Math.floor(geo.n / 2);
    const near = nearestSample(SA, geo.pts[m * 3], geo.pts[m * 3 + 2]);
    const q = SA[near.i], dot = Math.abs(geo.tan[m * 2] * q.tx + geo.tan[m * 2 + 1] * q.tz);
    if (near.d > 0.3 && near.d < 1.7 && dot > 0.95) { B = walkTrack(g, e, walkSet, inA); break; }
  }
  if (!B) { res.error = 'No parallel second track'; return res; }
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
      return { atStart, kind: opts.mergeEnds ? 'merge' as const : beyond(g, [nodeOut(A, qa.u, atStart), nodeOut(B, qb.u, atStart)], out) };
    });
    // ---- crossovers right outside every station on the stretch: =====x==[station]==x===== (a pair, one each
    // way: trains on either track reach every platform, turn back or overtake there), before stations and depots
    // beyond its ends ('always', pairing two lines' tracks: at every end where the tracks part), at both ends of
    // inline stations where there is room; none on plain line between stations
    // crossover length: by the lateral distance and the common curve limit
    const minR = (TRACK_TYPES[lineType(g, A)] ?? TRACK_TYPES.standard).minRadius;
    const D = Math.max(5, Math.min(12, Math.sqrt(60 * lat * Math.min(1, minR / 12)) + 2));
    /** crossover zones in A's distance (atStart: at the start / end of the stretch; null: beside an inline station) */
    const zones: { atStart: boolean | null; z0: number; z1: number }[] = [];
    const overlapsZone = (a: number, b: number) => zones.some((z) => Math.min(a, b) < z.z1 + 1 && Math.max(a, b) > z.z0 - 1);
    /** A crossover from track X at u1 (A's distance) to track Y at u1 + sgn*D; null if built, else the reason. */
    const diagonal = (fromA: boolean, u1: number, sgn: number): string | null => {
      const uA = fromA ? u1 : u1 + sgn * D, uB = fromA ? u1 + sgn * D : u1;
      if (uA < lo + 0.5 || uA > hi - 0.5 || uB < lo + 0.5 || uB > hi - 0.5) return 'outside the double track';
      if (inline.size) for (let v = Math.min(uA, uB) - 0.6; v <= Math.max(uA, uB) + 0.6; v += 0.4) if (inline.has(sampleAt(SA, v).edge) || inline.has(posOnB(v).edge)) return 'station in the way';
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
      const err = (fromA ? connectS(g, owner, toPt(pa), toPt(pb), tracks, false, undefined, net.edges.get(pa.edge)!.owner) : connectS(g, owner, toPt(pb), toPt(pa), tracks, false, undefined, net.edges.get(pb.edge)!.owner)).error;
      if (err) opts.log?.(`  crossover ${fromA ? 'A->B' : 'B->A'} at ${u1.toFixed(1)}: ${err}`);
      return err;
    };
    // crossovers already there: legs joining the two tracks (their ends in A's distance)
    const legs = (): { id: number; u0: number; u1: number }[] => {
      const inL = new Set([...lists[0], ...lists[1]].map((x) => x.edge));
      const nA = new Set(lists[0].flatMap((x) => [startNode(g, x), endNode(g, x)])), nB = new Set(lists[1].flatMap((x) => [startNode(g, x), endNode(g, x)]));
      const out: { id: number; u0: number; u1: number }[] = [];
      for (const nid of nA) {
        const n = net.nodes.get(nid);
        if (!n || n.edges.length < 3) continue;
        for (const id of n.edges) {
          if (inL.has(id) || out.some((o) => o.id === id)) continue;
          const e = net.edges.get(id)!, other = e.a === nid ? e.b : e.a;
          if (e.kind !== 'rail' || !nB.has(other)) continue;
          const on = net.nodes.get(other)!;
          const ua = SA[nearestSample(SA, n.x, n.z).i].u, ub = SA[nearestSample(SA, on.x, on.z).i].u;
          out.push({ id, u0: Math.min(ua, ub), u1: Math.max(ua, ub) });
        }
      }
      return out;
    };
    /** Where crossovers belong: windows outside each station end on the stretch (and at the ends asked for). */
    const windows: { edge0: number; sgn: number; must: boolean; atStart: boolean | null; label: string }[] = [];
    for (const end of ends) {
      const want = opts.crossoversAt === 'always' ? end.kind !== 'merge' : end.kind === 'station' || end.kind === 'depot';
      const th = end.kind === 'station' ? opts.throatLength ?? 0 : 0;
      if ((opts.crossovers ?? true) && want) windows.push({ edge0: end.atStart ? lo + th : hi - th, sgn: end.atStart ? -1 : 1, must: true, atStart: end.atStart, label: `before ${end.kind} at ${end.atStart ? 'start' : 'end'} of double track` });
    }
    if ((opts.crossovers ?? true) && inline.size) {
      const span = new Map<number, [number, number]>();
      for (const q of SA) {
        const e = net.edges.get(q.edge);
        if (!e || !inline.has(e.id)) continue;
        const sid = e.station >= 0 ? e.station : g.stations.throughStationOf(e.id);
        const v = span.get(sid);
        span.set(sid, v ? [Math.min(v[0], q.u), Math.max(v[1], q.u)] : [q.u, q.u]);
      }
      for (const [sid, [s0, s1]] of span) {
        const must = opts.turnbackStations?.includes(sid) ?? false;
        // Existing throat upgrades keep their inline windows; AI pairing supplies the turnback option.
        const th = opts.turnbackStations ? opts.throatLength ?? 0 : 0;
        if (s0 > lo + 3) windows.push({ edge0: s0 - th, sgn: 1, must, atStart: null, label: 'before a station' });
        if (s1 < hi - 3) windows.push({ edge0: s1 + th, sgn: -1, must, atStart: null, label: 'after a station' });
      }
    }
    // a pair right outside a station end takes about 2D + 3 units; anything beyond 2D + 8 out is on plain line
    const winOf = (w: (typeof windows)[number]) => { const far = w.edge0 - w.sgn * (2 * D + 8); return [Math.min(w.edge0, far), Math.max(w.edge0, far)] as [number, number]; };
    // tidying an existing double track: crossovers on plain line (not in a window, not by a depot branch) go
    if (opts.normalise) {
      const nearDepot = (u: number) => [lists[0], lists[1]].some((L) => L.some((st) => [startNode(g, st), endNode(g, st)].some((nid) => {
        const n = net.nodes.get(nid);
        if (!n || n.edges.length < 3) return false;
        if (!n.edges.some((id) => { const e = net.edges.get(id)!; if (e.depot >= 0) return true; const o = net.nodes.get(e.a === nid ? e.b : e.a); return !!o && o.edges.some((x) => net.edges.get(x)?.depot! >= 0); })) return false;
        return Math.abs(SA[nearestSample(SA, n.x, n.z).i].u - u) < 20;
      })));
      for (const l of legs()) {
        const inWin = windows.some((w) => { const [a, b] = winOf(w); return l.u0 >= a - 1 && l.u1 <= b + 1; });
        if (inWin || nearDepot((l.u0 + l.u1) / 2) || g.vehicles.isEdgeBusy(l.id) || g.trackUpgradeError(owner, net.edges.get(l.id)!.owner)) continue;
        net.removeEdge(l.id);
        res.removed = (res.removed ?? 0) + 1;
      }
      SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
    }
    const have = legs();
    for (const w of windows.sort((p, q) => Number(q.must) - Number(p.must))) {
      const [a, b] = winOf(w);
      const there = have.filter((l) => l.u0 >= a - 1 && l.u1 <= b + 1);
      if (there.length >= 2) { zones.push({ atStart: w.atStart, z0: Math.min(...there.map((l) => l.u0)), z1: Math.max(...there.map((l) => l.u1)) }); continue; }
      // scan outwards from the station end: "\" (A -> B) first, then "/" (B -> A) further out, both heading towards it
      const { edge0, sgn } = w;
      const m0 = eco.money, e0 = net.nextEdge;
      let first = NaN, second = NaN;
      for (let k = 1.5; k <= 40 && isNaN(first); k += 0.75) {
        const u1 = edge0 - sgn * (k + D);               // the diagonal spans u1 .. u1 + sgn*D, ending k before the end
        if (overlapsZone(u1, u1 + sgn * D)) break;
        const err = diagonal(true, u1, sgn);
        if (!err) first = u1;
        else if (err === 'station in the way') break;
      }
      if (!isNaN(first)) {
        SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
        for (let k = 1.3; k <= 40 && isNaN(second); k += 0.75) {
          const u1 = first - sgn * (k + D);
          if (overlapsZone(u1, u1 + sgn * D)) break;
          const err = diagonal(false, u1, sgn);
          if (!err) second = u1;
          else if (err === 'station in the way') break;
        }
      }
      SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
      if (isNaN(first) || isNaN(second)) {
        for (let id = e0; id < net.nextEdge; id++) if (net.edges.has(id) && !lists.some((L) => L.some((x) => x.edge === id))) net.removeEdge(id);
        refund(g, owner, m0);
        SA = sampleSteps(g, lists[0]); SB = sampleSteps(g, lists[1]);
        if (w.must) res.error = `No crossover room ${w.label}: tracks stay two-way`;
        continue;
      }
      res.crossovers += 2;
      const us = [first, first + sgn * D, second, second + sgn * D];
      zones.push({ atStart: w.atStart, z0: Math.min(...us), z1: Math.max(...us) });
    }
    if (res.error) { res.cost = Math.round(money0 - eco.money); return res; }
    // no one-way signal inside a crossover zone (a crossing move must not meet one), nor one trains may not pass
    // between a zone and the station or depot it serves (trains turn there); starters at platforms stay
    const zs0 = zones.find((z) => z.atStart === true), ze0 = zones.find((z) => z.atStart === false);
    const kindAt = (atStart: boolean) => ends.find((e) => e.atStart === atStart)?.kind;
    const throat = (u: number) => (!!zs0 && (kindAt(true) === 'station' || kindAt(true) === 'depot') && u < zs0.z0) || (!!ze0 && (kindAt(false) === 'station' || kindAt(false) === 'depot') && u > ze0.z1);
    for (const [ti, L] of lists.entries()) for (const st of L) for (const nid of [startNode(g, st), endNode(g, st)]) {
      const n = net.nodes.get(nid);
      if (!n || !n.signal || n.edges.length !== 2 || n.edges.some((id) => net.edges.get(id)!.station >= 0)) continue;
      if (n.edges.some((id) => g.trackUpgradeError(owner, net.edges.get(id)!.owner))) continue;
      const u = SA[nearestSample(SA, n.x, n.z).i].u;
      // Finishing a loop on the other side can reverse the original track's running direction. Its old
      // plain-line signals must not oppose the new ones and trap trains leaving the station crossovers.
      const e = net.edges.get(st.edge)!, dir = st.dir * ((ti === 0 ? !bForward : bForward) ? 1 : -1);
      const side = net.sideAt(e, nid) * ((dir > 0 ? e.a : e.b) === nid ? 1 : -1);
      const opposed = n.signal >= 2 && !n.signalPass && net.signalFor(n, side) < 0;
      if (!opposed && !zones.some((z) => u > z.z0 - 0.8 && u < z.z1 + 0.8) && !(throat(u) && n.signal >= 2 && !n.signalPass)) continue;
      n.signal = 0; delete n.signalKind; delete n.signalPass;
      g.world.markObjArea(n.x - 2, n.z - 2, n.x + 2, n.z + 2);
      net.version++;
    }
    // ---- one-way block signals between the crossover zones (never between a zone and its station), a path
    // signal right before each zone (a crossing move holds only its own path; through trains keep running)
    const spacing = Math.max(10, opts.signalSpacing ?? SIGNAL_SPACING);
    for (const [ti, fwdA] of [[0, !bForward], [1, bForward]] as [number, boolean][]) {
      const L = lists[ti];
      let S = sampleSteps(g, L);
      const own = (u: number) => { const q = sampleAt(SA, u); return S[nearestSample(S, q.x, q.z).i].u; };
      const zs = zones.find((z) => z.atStart === true), ze = zones.find((z) => z.atStart === false);
      const lim0 = zs ? own(zs.z1) + 1.0 : own(lo) + 1.5, lim1 = ze ? own(ze.z0) - 1.0 : own(hi) - 1.5;
      if (lim1 - lim0 < 2) continue;
      const inner = zones.filter((z) => z.atStart === null).map((z) => { const p = own(z.z0), q = own(z.z1); return [Math.min(p, q), Math.max(p, q)] as [number, number]; });
      const sw: number[] = [];
      for (const st of L) for (const nid of [startNode(g, st), endNode(g, st)]) {
        const n = net.nodes.get(nid);
        if (n && n.edges.length > 2) sw.push(S[nearestSample(S, n.x, n.z).i].u);
      }
      const okAt = (u: number) => u >= lim0 && u <= lim1 && !inner.some(([p, q]) => u > p - 1.0 && u < q + 1.0) && !sw.some((v) => Math.abs(v - u) < 1.5) && !(inline.size && inline.has(sampleAt(S, u).edge));
      const free = (u: number, step: number) => { for (let k = 0; k < 60; k++, u += step) if (okAt(u)) return u; return NaN; };
      const sg = fwdA ? 1 : -1, from = fwdA ? lim0 : lim1, to = fwdA ? lim1 : lim0;
      const want: { u: number; kind: 'block' | 'path' }[] = [];
      let u = free(from, sg * 0.5);
      while (isFinite(u) && (to - u) * sg >= 0 && want.length < 400) {
        want.push({ u, kind: 'block' });
        const nx = u + sg * spacing;
        if ((to - nx) * sg < 2) break;
        u = free(nx, sg * 0.5);
      }
      // path signals before the zones ahead (inner ones, and the one at the far end)
      const homes: number[] = [];
      for (const [p, q] of inner) { const entry = sg > 0 ? p : q; if ((entry - from) * sg > 2) { const h = free(entry - sg * 1.0, -sg * 0.5); if (isFinite(h)) homes.push(h); } }
      const home = free(to, -sg * 0.5);
      if (isFinite(home)) homes.push(home);
      for (const h of homes) {
        for (let i = want.length - 1; i >= 0; i--) if (Math.abs(want[i].u - h) < 4) want.splice(i, 1);
        want.push({ u: h, kind: 'path' });
      }
      want.sort((p, q) => (p.u - q.u) * sg);
      for (const wq of want) {
        const q = sampleAt(S, wq.u);
        const step = L.find((x) => x.edge === q.edge);
        if (!step) continue;
        if (!setSignal(g, q.edge, q.s, 'oneway', step.dir * sg > 0, owner, { signalKind: wq.kind })) res.signals++;
        S = sampleSteps(g, L);
        if (ti === 0) SA = S;
      }
      // inline stations: a starter at each platform's departure end (one-way path signal), so the line stays
      // directional through the stations and trains wait at the platform for the way ahead
      for (const step of [...L]) {
        if (!inline.has(step.edge)) continue;
        const e = net.edges.get(step.edge);
        if (!e) continue;
        const forward = step.dir * sg > 0, n = net.nodes.get(forward ? e.b : e.a);
        if (!n || n.edges.length !== 2) continue;
        if (!setSignal(g, e.id, forward ? e.len : 0, 'oneway', forward, owner, { signalKind: 'path' })) res.signals++;
      }
    }
    // where paired tracks part (two lines' tracks): an entry signal on each just outside the crossovers, facing
    // into the double track and passable from behind, so trains wait there for the crossovers instead of holding
    // the single track behind them for the whole way
    if (opts.crossoversAt === 'always') for (const end of ends) {
      if (end.kind === 'merge' || !zones.some((z) => z.atStart === end.atStart)) continue;
      for (let ti = 0; ti < 2; ti++) {
        const L = lists[ti], S = sampleSteps(g, L);
        const uEnd = ti === 0 ? (end.atStart ? lo : hi) : posOnB(end.atStart ? lo : hi).u;
        const u = uEnd + (end.atStart ? -2.5 : 2.5);
        if (u < S[0].u + 0.8 || u > S[S.length - 1].u - 0.8) continue;
        const q = sampleAt(S, u);
        const step = L.find((x) => x.edge === q.edge), e = net.edges.get(q.edge);
        if (!step || !e || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) continue;
        const sw = [e.a, e.b].some((nid) => { const n = net.nodes.get(nid)!; return n.edges.length > 2 && Math.hypot(n.x - q.x, n.z - q.z) < 1.5; });
        if (sw) continue;
        const inward = end.atStart ? 1 : -1;
        if (!setSignal(g, q.edge, q.s, 'oneway', step.dir * inward > 0, owner, { signalKind: 'path', pass: true })) res.signals++;
      }
    }
  } finally {
    untrack();
  }
  res.cost = Math.round(money0 - eco.money);
  return res;
}

// ------------------------------------------------------------------ station throats and stations on existing lines

/** The point `d` units out from `node` along the track leaving it on edge `e` (through plain nodes), or null. */
function pointOut(g: Game, node: number, e: NEdge, d: number, via?: number[], pass = false): SPt | null {
  const net = g.world.net;
  let cur = e, at = node, acc = 0;
  const p = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
  for (let guard = 0; guard < 40; guard++) {
    const fromA = cur.a === at;
    via?.push(cur.id);
    if (acc + cur.len >= d + 0.4) {
      const s = fromA ? d - acc : cur.len - (d - acc);
      net.pointAt(cur, s, p, t);
      const l = Math.hypot(t.x, t.z) || 1;
      return { x: p.x, z: p.z, y: p.y, tx: t.x / l, tz: t.z / l, edge: cur.id, s };
    }
    acc += cur.len;
    at = fromA ? cur.b : cur.a;
    const n = net.nodes.get(at);
    if (!n || n.edges.length < 2 || (n.edges.length > 2 && !pass)) return null;
    // through a switch (pass): straight on
    const dir = fromA ? 1 : -1;
    const conts = net.nextRail(cur, dir).filter((c) => c.edge.station < 0 && c.edge.depot < 0);
    if (!conts.length) return null;
    const geo = net.geo(cur), i = dir > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * dir, tz = geo.tan[i * 2 + 1] * dir;
    let best = conts[0], bd = -Infinity;
    for (const c of conts) { const ld = net.leaveDir(c.edge, c.node.id), dot = ld.x * tx + ld.z * tz; if (dot > bd) { bd = dot; best = c; } }
    cur = best.edge;
  }
  return null;
}

/**
 * Turnouts for station tracks (platform or through) left unconnected at an end where other tracks of the station
 * are connected: each joins the approach of the nearest connected track 8-18 units out (metro / light rail from 4),
 * an S-curve, tracks further out chaining onto those just connected. `owner` pays; the station retains its
 * turnouts. The builder may be the station's owner or another company with access, and only joins usable track.
 * Returns how many were connected, and why others could not be.
 */
export function connectStationThroat(g: Game, stationId: number, owner: number, opts: { avoid?: Partial<Record<'front' | 'back', [number, number]>> } = {}): { connected: number; failed: string[] } {
  const net = g.world.net;
  const st = g.stations.get(stationId);
  const res = { connected: 0, failed: [] as string[] };
  if (!st || !st.rail) return res;
  const access = g.trackUpgradeError(owner, st.owner);
  if (access) { res.failed.push(access); return res; }
  const r = st.rail;
  const outs = railPartMode(r) === 'mainline' ? [8, 10, 12, 15, 18, 22, 26, 30, 34] : [4, 5, 6, 8, 10, 12, 15, 18, 22, 26];
  for (const end of ['front', 'back'] as const) {
    const sg = end === 'front' ? 1 : -1, ax = Math.sin(r.angle) * sg, az = Math.cos(r.angle) * sg;
    const own = new Set([...r.edges, ...r.throughEdges]);
    const approach = (nid: number) => net.nodes.get(nid)?.edges.filter((id) => !own.has(id)) ?? [];
    const ends = g.stations.trackEnds(st, true);
    const conn = ends.map((t) => approach(t[end]).length > 0);
    if (!conn.some(Boolean) || conn.every(Boolean)) continue;
    for (let pass = 0; pass < ends.length; pass++) {
      let changed = false;
      for (let j = 0; j < ends.length; j++) {
        if (conn[j] || !((j > 0 && conn[j - 1]) || (j + 1 < ends.length && conn[j + 1]))) continue;
        const k = j > 0 && conn[j - 1] ? j - 1 : j + 1;
        const nk = ends[k][end], appr = approach(nk);
        const nj = net.nodes.get(ends[j][end])!;
        let why = appr.length === 1 ? 'no room' : 'a switch right at the platform end';
        if (appr.length === 1) {
          const e = net.edges.get(appr[0])!;
          if (!g.canUse(owner, e.owner)) why = `track of ${g.company(e.owner).name}: needs track access`;
          else for (const d of outs) {
            // not between the switches of crossovers there (a train leaving the new track could not cross over)
            const band = opts.avoid?.[end];
            if (band && d > band[0] - 1.5 && d < band[1] + 1.5) { why = 'crossovers in the way'; continue; }
            const via: number[] = [];
            const q = pointOut(g, nk, e, d, via, true);
            if (!q) break;
            // not right at a switch already there (an earlier rung of the ladder)
            const nearSwitch = via.some((id) => { const ve = net.edges.get(id)!; return [ve.a, ve.b].some((nid) => { const n = net.nodes.get(nid)!; return n.edges.length > 2 && Math.hypot(n.x - q.x, n.z - q.z) < 1.5; }); });
            if (nearSwitch) { why = 'a switch in the way'; continue; }
            const qe = q.edge !== undefined ? net.edges.get(q.edge) : undefined;
            if (qe && !g.canUse(owner, qe.owner)) { why = `track of ${g.company(qe.owner).name}: needs track access`; break; }
            // the neighbour's approach as far as the turnout runs beside the new curve
            const tracks = new Set<number>([...own, ...via, ...ends.flatMap((t) => [...approach(t.front), ...approach(t.back)])]);
            const c = connectS(g, owner, { x: nj.x, z: nj.z, y: nj.y, tx: ax, tz: az, node: nj.id }, q, tracks, false, undefined, st.owner);
            if (!c.error) { conn[j] = true; changed = true; res.connected++; break; }
            why = c.error;
          }
        }
        if (!conn[j]) res.failed.push(`${end} end of track ${j + 1}: ${why}`);
      }
      if (!changed) break;
      res.failed = res.failed.filter((f) => !f.startsWith(end));
    }
    for (let j = 0; j < ends.length; j++) if (!conn[j]) res.failed.push(`${end} end of track ${j + 1}: not connected`);
  }
  res.failed = [...new Set(res.failed)];
  return res;
}

/** The plain track straight on from `node` along edge `e` (through switches the straightest way) for about `reach` units. */
function straightOn(g: Game, node: number, e: NEdge, reach: number): number[] {
  const net = g.world.net;
  const out: number[] = [];
  let cur = e, at = node, acc = 0;
  for (let guard = 0; guard < 400 && acc < reach; guard++) {
    if (cur.station >= 0 || cur.depot >= 0 || out.includes(cur.id)) break;
    out.push(cur.id);
    acc += cur.len;
    const d = cur.a === at ? 1 : -1;
    at = d > 0 ? cur.b : cur.a;
    const conts = net.nextRail(cur, d);
    if (!conts.length) break;
    const geo = net.geo(cur), i = d > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * d, tz = geo.tan[i * 2 + 1] * d;
    let best = conts[0], bd = -Infinity;
    for (const c of conts) { const ld = net.leaveDir(c.edge, c.node.id), dot = ld.x * tx + ld.z * tz; if (dot > bd) { bd = dot; best = c; } }
    cur = best.edge;
  }
  return out;
}

/**
 * Connect new station tracks at the ends where the others are connected (after an upgrade): a turnout ladder onto
 * the neighbouring tracks' approaches (connectStationThroat). Where crossovers lie too close to the platforms for
 * the ladder, they are taken out, the ladder is laid, and the line's two tracks there get their crossovers again
 * beyond it (finishDoubleTrack). Returns how many tracks were connected, why others were not, and the crossovers
 * laid again.
 */
export function growThroat(g: Game, stationId: number, owner: number): { connected: number; failed: string[]; crossovers: number } {
  const net = g.world.net;
  const st = g.stations.get(stationId);
  if (!st || !st.rail) return { connected: 0, failed: [], crossovers: 0 };
  const r = st.rail;
  const own = new Set([...r.edges, ...r.throughEdges]);
  const dist = (heads: number[], nid: number) => { const n = net.nodes.get(nid)!; let d = Infinity; for (const h of heads) { const m = net.nodes.get(h); if (m) d = Math.min(d, Math.hypot(n.x - m.x, n.z - m.z)); } return d; };
  let crossovers = 0;
  const removed: { a: number; b: number; bez: NEdge['bez']; prof: Float32Array; sections: NEdge['sections']; type: string }[] = [];
  const moved: ('front' | 'back')[] = [];
  const heads = new Map<'front' | 'back', number[]>();
  // crossovers right outside the platforms where new tracks need their ladder: taken out (they are laid again
  // right outside the ladder); the line track around is cut into short pieces first where no train is on it, so
  // the new turnouts and crossovers find free track even while trains wait nearby
  for (const end of ['front', 'back'] as const) {
    const ends = g.stations.trackEnds(st, true);
    const missing = ends.filter((t) => !(net.nodes.get(t[end])?.edges.some((id) => !own.has(id)))).length;
    const z = throatCrossovers(g, stationId, end, owner, ladderReach(missing));
    if (!z || !z.heads.length || missing === 0 || missing === ends.length) continue;
    heads.set(end, z.heads);
    if (!z.legs.length || z.legs.some((id) => g.vehicles.isEdgeBusy(id))) continue;
    const wide = throatCrossovers(g, stationId, end, owner, 70)!;
    for (const id of wide.line) fragment(g, id, 3);
    for (const id of z.legs) {
      const e = net.edges.get(id)!;
      removed.push({ a: e.a, b: e.b, bez: { ...e.bez }, prof: e.prof.slice(), sections: e.sections.map((x) => ({ ...x })), type: e.type });
      net.removeEdge(id);
    }
    moved.push(end);
  }
  if (removed.length) g.onNetworkChanged();
  const res = connectStationThroat(g, stationId, owner);
  for (const end of moved) {
    const hs = heads.get(end)!;
    // the line tracks straight on from the old platform ends, and the ladder's outermost turnout on them
    const set = new Set<number>();
    for (const h of hs) {
      const n = net.nodes.get(h);
      const appr = n?.edges.filter((id) => !own.has(id)) ?? [];
      if (n && appr.length === 1) for (const id of straightOn(g, n.id, net.edges.get(appr[0])!, 120)) set.add(id);
    }
    let ladder = 0;
    for (const id of set) {
      const e = net.edges.get(id)!;
      for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid)!, d = dist(hs, nid);
        if (d < 60 && n.edges.length >= 3 && n.edges.some((x) => !own.has(x) && !set.has(x))) ladder = Math.max(ladder, d);
      }
    }
    const f = pairBeyond(g, stationId, end, owner, ladder) ? null : finishDoubleTrack(g, [...set], owner, { throatLength: ladder + 1.5 });
    crossovers += f?.crossovers ?? 0;
    if (f && f.crossovers < 2) {
      // no room for them now: the old crossovers come back (trains keep reaching every platform but the new ones)
      for (const l of removed) if (net.nodes.has(l.a) && net.nodes.has(l.b)) net.addEdge('rail', l.a, l.b, l.bez, l.prof, l.sections, l.type, owner);
    }
  }
  g.onNetworkChanged();
  return { connected: res.connected, failed: res.failed, crossovers };
}

/**
 * Ready a station end for a turnout ladder to `added` more tracks: the line track there is cut into short
 * pieces where no train is on it, and the answer is whether the pieces the ladder (and crossovers that have to
 * move out for it) will use are free of trains now.
 */
export function throatFree(g: Game, stationId: number, end: 'front' | 'back', owner: number, added: number): boolean {
  const reach = ladderReach(added);
  const z = throatCrossovers(g, stationId, end, owner, reach + 45);
  if (!z || !z.heads.length) return true;
  for (const id of z.line) fragment(g, id, 3);
  const near = throatCrossovers(g, stationId, end, owner, reach)!;
  // crossovers in the ladder's way move out beyond it: then the line there must be free of trains as well
  const wide = near.legs.length ? throatCrossovers(g, stationId, end, owner, reach + 45)! : near;
  return ![...near.line, ...near.legs, ...wide.line].some((id) => g.vehicles.isEdgeBusy(id));
}

/** The line tracks straight on from platform end nodes (their approach edges on), about `reach` units out. */
function lineTracks(g: Game, stationId: number, heads: number[], reach: number): Set<number> {
  const net = g.world.net, r = g.stations.get(stationId)?.rail;
  const own = new Set(r ? [...r.edges, ...r.throughEdges] : []);
  const set = new Set<number>();
  for (const h of heads) {
    const n = net.nodes.get(h);
    const appr = n?.edges.filter((id) => !own.has(id)) ?? [];
    if (n && appr.length === 1) for (const id of straightOn(g, n.id, net.edges.get(appr[0])!, reach)) set.add(id);
  }
  return set;
}

/** Is there a crossover pair (two legs) between `reach` and `reach + 40` units out from a station end? */
function pairBeyond(g: Game, stationId: number, end: 'front' | 'back', owner: number, reach: number): boolean {
  const net = g.world.net;
  const z = throatCrossovers(g, stationId, end, owner, reach + 40);
  if (!z) return false;
  const hn = z.heads.map((h) => net.nodes.get(h)!);
  const d = (nid: number) => { const n = net.nodes.get(nid)!; return Math.min(...hn.map((h) => Math.hypot(h.x - n.x, h.z - n.z))); };
  return z.legs.filter((id) => { const e = net.edges.get(id)!; return Math.min(d(e.a), d(e.b)) > reach; }).length >= 2;
}

/** Reservation holder of track held for works (no train). */
export const WORKS_HOLD = 2_000_000_000;

/**
 * Works at a busy station throat: the line tracks leading in (one-way towards the station) are held at the
 * outer end of the works area, so no further train enters while those inside leave (a possession). Returns the
 * held pieces (release them with releaseHold). Two-way track is not held (a train inside may need it to leave).
 */
export function holdThroat(g: Game, stationId: number, end: 'front' | 'back', owner: number, added: number): number[] {
  const net = g.world.net, V = g.vehicles;
  const st = g.stations.get(stationId), r = st?.rail;
  if (!st || !r) return [];
  const own = new Set([...r.edges, ...r.throughEdges]);
  const reach = ladderReach(added) + 45;
  const held: number[] = [];
  for (const t of g.stations.trackEnds(st, true)) {
    const n0 = net.nodes.get(t[end]);
    const appr = n0?.edges.filter((id) => !own.has(id)) ?? [];
    if (!n0 || appr.length !== 1) continue;
    const line = straightOn(g, n0.id, net.edges.get(appr[0])!, reach + 12);
    // into the station along this track: allowed by its one-way signals (and some there)?
    let inbound = false, outbound = false;
    let at = n0.id;
    for (let i = 0; i + 1 < line.length; i++) {
      const e = net.edges.get(line[i])!, nx = net.edges.get(line[i + 1])!;
      at = e.a === at ? e.b : e.a;
      const n = net.nodes.get(at)!;
      if (n.signal < 2 || n.signalPass || n.edges.length !== 2) continue;
      if (net.signalFor(n, net.sideAt(e, at)) >= 0) inbound = true; else outbound = true;
      void nx;
    }
    if (!inbound || outbound) continue;
    // the outermost free piece about `reach` out
    let acc = 0;
    for (const id of line) {
      const e = net.edges.get(id)!;
      acc += e.len;
      if (acc < reach) continue;
      if (V.getRes(id) === 0 && !V.isEdgeBusy(id)) { V.setRes(id, WORKS_HOLD); held.push(id); break; }
    }
  }
  return held;
}

/** Release track held for works. */
export function releaseHold(g: Game, edges: number[]) { for (const id of edges) g.vehicles.releaseRes(id, WORKS_HOLD); }

/** Cut an edge (no train on it) into pieces of about `len` units. */
export function fragment(g: Game, edgeId: number, len: number) {
  const net = g.world.net;
  let e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || e.len < len * 2 || g.vehicles.isEdgeBusy(e.id)) return;
  const n = Math.floor(e.len / len);
  for (let k = n - 1; k >= 1 && e; k--) {
    const r = net.splitEdge(e.id, (e.len * k) / (k + 1));
    if (!r) break;
    e = r.e1;
  }
}

/**
 * The throat beyond a connected end of a station, `reach` units out along the line tracks straight on from the
 * platforms: crossover legs there, the platform end nodes the line tracks start from, and the line track edges.
 */
export function throatCrossovers(g: Game, stationId: number, end: 'front' | 'back', owner: number, reach = 40): { legs: number[]; heads: number[]; line: number[] } | null {
  const net = g.world.net;
  const st = g.stations.get(stationId), r = st?.rail;
  if (!st || !r) return null;
  const own = new Set([...r.edges, ...r.throughEdges]);
  const heads: { node: number; edge: number }[] = [];
  for (const t of g.stations.trackEnds(st, true)) {
    const n = net.nodes.get(t[end]);
    const appr = n?.edges.filter((id) => !own.has(id)) ?? [];
    if (n && appr.length === 1) heads.push({ node: n.id, edge: appr[0] });
  }
  if (!heads.length) return null;
  const onLine = new Set(heads.flatMap((h) => straightOn(g, h.node, net.edges.get(h.edge)!, reach)));
  // (a crossover with one switch within reach counts: its other switch may lie a little further out)
  const farLine = new Set(heads.flatMap((h) => straightOn(g, h.node, net.edges.get(h.edge)!, reach + 14)));
  const lineNodes = new Set([...farLine].flatMap((id) => { const e = net.edges.get(id)!; return [e.a, e.b]; }));
  const legs = new Set<number>();
  const hn = heads.map((h) => net.nodes.get(h.node)!);
  for (const nid of lineNodes) {
    const n = net.nodes.get(nid)!;
    if (n.edges.length < 3 || !hn.some((h) => Math.hypot(h.x - n.x, h.z - n.z) <= reach)) continue;
    for (const x of n.edges) {
      if (farLine.has(x) || own.has(x)) continue;
      const xe = net.edges.get(x)!;
      if (xe.owner === owner && xe.station < 0 && xe.depot < 0 && lineNodes.has(xe.a === nid ? xe.b : xe.a)) legs.add(x);
    }
  }
  return { legs: [...legs], heads: heads.map((h) => h.node), line: [...onLine] };
}

/** How far out a turnout ladder for `n` more tracks reaches along the line tracks. */
export const ladderReach = (n: number) => 4 + 7 * Math.max(1, n);

export interface OnTrackOpts {
  /** platform length (default: by station style, see defaultPlatformLength) */
  length?: number;
  /** platform tracks (default: 1 on single track, 2 on double track) */
  tracks?: number;
  /** through tracks without platforms (0-2) */
  through?: number;
  throughMode?: ThroughMode;
  /** default: from the line there (ground, a bridge: elevated, a tunnel: underground) */
  level?: StationLevel;
  /** Station style (default mainline), independent of the line's wire state. */
  mode?: import('./stations').RailMode;
  /** default: side platforms for metro / light-rail stations without through tracks, else islands */
  platformStyle?: PlatformStyle;
  /** platform screen doors (default: metro lines) */
  psd?: boolean;
  /** building style (STATION_STYLES id; default as planRail: 'none' below / above the street, else 'classic') */
  style?: string;
}

export interface OnTrackPlan {
  ok: boolean;
  error?: string;
  warnings: string[];
  cost: number;
  owner: number;
  /** the station (at the line's height, axis along the line) */
  station: StationPlan | null;
  /** the line's tracks through the site (1 or 2), in chain order, with their cut points (chain distances) */
  mains: { steps: Step[]; cut: [number, number]; lat: number }[];
  /** fans: per entry the line track (index into mains) and the station track it feeds (lateral order, platform and through tracks) */
  feeds: number[];
  feedTrack: number[];
  /** throat connections (previews): from the cut points to the station track ends */
  throat: { x0: number; z0: number; x1: number; z1: number }[];
}

/** Plain own track around an edge (both ways, up to `reach` each way): steps in the edge's +s direction and where it starts. */
function plainAround(g: Game, e0: NEdge, owner: number, reach: number): { steps: Step[]; u0: number } {
  const net = g.world.net;
  const walk = (dir: number): Step[] => {
    const out: Step[] = [];
    let cur = e0, d = dir, acc = 0;
    const seen = new Set<number>([e0.id]);
    while (acc < reach) {
      const nid = d > 0 ? cur.b : cur.a;
      const n = net.nodes.get(nid);
      if (!n || n.edges.length !== 2) break;
      const nx = net.nextRail(cur, d);
      if (nx.length !== 1) break;
      const c = nx[0];
      if (c.edge.owner !== owner || c.edge.station >= 0 || c.edge.depot >= 0 || seen.has(c.edge.id)) break;
      seen.add(c.edge.id);
      out.push({ edge: c.edge.id, dir: c.dir });
      acc += c.edge.len;
      cur = c.edge; d = c.dir;
    }
    return out;
  };
  const back = walk(-1), fwd = walk(1);
  const steps = [...back.reverse().map((s) => ({ edge: s.edge, dir: -s.dir })), { edge: e0.id, dir: 1 }, ...fwd];
  let u0 = 0;
  for (const s of steps) { if (s.edge === e0.id) break; u0 += net.edges.get(s.edge)!.len; }
  return { steps, u0 };
}

/**
 * Plan inserting a through station into an existing single or double track at arc length `s` of edge `edgeId`:
 * the platform (and through) tracks lie on the line's axis at its height, the line is cut on both sides and its
 * tracks fan into the station tracks with smooth turnouts (on double track each line track feeds the station
 * tracks on its side, so one-way running continues). The track must be straight and level for the platforms.
 */
export function planStationOnTrack(g: Game, edgeId: number, s: number, o: OnTrackOpts, owner: number): OnTrackPlan {
  const net = g.world.net;
  const plan: OnTrackPlan = { ok: true, warnings: [], cost: 0, owner, station: null, mains: [], feeds: [], feedTrack: [], throat: [] };
  const fail = (m: string) => { plan.ok = false; plan.error = m; return plan; };
  const e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail') return fail('No track here');
  if (e.owner !== owner) return fail('Not your track');
  if (e.station >= 0 || e.depot >= 0) return fail('Already a station or depot track');
  const L = Math.max(4, Math.min(40, o.length ?? defaultPlatformLength(o.mode ?? e.type)));
  const reach = L / 2 + 30;
  const A = plainAround(g, e, owner, reach);
  const SA = sampleSteps(g, A.steps);
  const uc = A.u0 + Math.max(0, Math.min(e.len, s));
  const q = sampleAt(SA, uc);
  // a second track alongside: double track
  let B: { steps: Step[]; S: Sample[]; lat: number } | null = null;
  for (const c of net.edgesNear(q.x - 1.5, q.z - 1.5, q.x + 1.5, q.z + 1.5)) {
    if (c.kind !== 'rail' || A.steps.some((st) => st.edge === c.id) || c.owner !== owner || c.station >= 0 || c.depot >= 0) continue;
    const ne = net.nearestEdge(q.x, q.z, 1.4, 'rail', (x) => x.id === c.id);
    if (!ne || ne.d < 0.3) continue;
    const pt = { x: 0, y: 0, z: 0 }, dr = { x: 0, y: 0, z: 0 };
    net.pointAt(c, ne.s, pt, dr);
    const dl = Math.hypot(dr.x, dr.z) || 1;
    if (Math.abs((dr.x * q.tx + dr.z * q.tz) / dl) < 0.98 || Math.abs(pt.y - q.y) > 0.3) continue;
    const pb = plainAround(g, c, owner, reach + 2);
    let steps = pb.steps;
    let S = sampleSteps(g, steps);
    const m = S[nearestSample(S, pt.x, pt.z).i];
    if (m.tx * q.tx + m.tz * q.tz < 0) { steps = steps.reverse().map((x) => ({ edge: x.edge, dir: -x.dir })); S = sampleSteps(g, steps); }
    B = { steps, S, lat: 0 };
    break;
  }
  // the station frame: forward along the line, right = (fz, -fx); centred between the tracks
  const fx = q.tx, fz = q.tz, rx = fz, rz = -fx;
  let cx = q.x, cz = q.z;
  if (B) { const m = sampleAt(B.S, B.S[nearestSample(B.S, q.x, q.z).i].u); cx = (q.x + m.x) / 2; cz = (q.z + m.z) / 2; }
  const latOf = (x: number, z: number) => (x - cx) * rx + (z - cz) * rz;
  const yc = q.y;
  const mainsS: Sample[][] = B ? [SA, B.S] : [SA];
  const lats = mainsS.map((S) => { const m = S[nearestSample(S, cx, cz).i]; return latOf(m.x, m.z); });
  // straight and level under the platforms
  for (const S of mainsS) {
    const c = S[nearestSample(S, cx, cz).i];
    for (let d = -L / 2 - 0.5; d <= L / 2 + 0.5; d += 0.5) {
      const p = sampleAt(S, c.u + d);
      if (Math.abs(p.u - (c.u + d)) > 0.01) return fail(`Needs ${Math.round((L + 1) * 10)} m of plain track`);
      const lat = latOf(p.x, p.z) - latOf(c.x, c.z);
      if (Math.abs(lat) > 0.15) return fail(`Curve: platforms need ${Math.round(L * 10)} m straight track`);
      if (Math.abs(p.y - yc) > 0.15) return fail('Grade: platforms need level track');
    }
  }
  const lv: StationLevel = o.level ?? (net.sectionAt(e, s) === 'tunnel' ? 'underground' : net.sectionAt(e, s) === 'bridge' ? 'elevated' : 'ground');
  const P = Math.max(1, Math.min(8, o.tracks ?? (B ? 2 : 1))), T = Math.max(0, Math.min(2, o.through ?? 0));
  const style: PlatformStyle = o.platformStyle ?? ((o.mode ?? railModeOf(e.type)) !== 'mainline' && !T ? 'side' : 'island');
  const lay = stationLayout(P, T, o.throughMode ?? 'middle', style);
  const all = [...lay.trackOffsets, ...lay.throughOffsets].sort((a, b) => a - b);
  // feeds: each station track from the nearest line track; every line track feeds at least one
  plan.feeds = all.map((off) => (lats.length > 1 && Math.abs(off - lats[1]) < Math.abs(off - lats[0]) ? 1 : 0));
  plan.feedTrack = all.map((_, j) => j);
  for (let m = 0; m < lats.length; m++) if (!plan.feeds.includes(m)) {
    let bj = 0;
    for (let j = 0; j < all.length; j++) if (Math.abs(all[j] - lats[m]) < Math.abs(all[bj] - lats[m])) bj = j;
    plan.feeds.push(m);
    plan.feedTrack.push(bj);
  }
  // throats: long enough for the widest fan
  let throat = 6;
  plan.feeds.forEach((m, j) => { throat = Math.max(throat, Math.min(18, Math.sqrt(60 * Math.abs(all[plan.feedTrack[j]] - lats[m])) + 3)); });
  const ignore = new Set<number>();
  for (let m = 0; m < mainsS.length; m++) {
    const S = mainsS[m], c = S[nearestSample(S, cx, cz).i];
    const cut: [number, number] = [c.u - L / 2 - throat, c.u + L / 2 + throat];
    if (cut[0] < 0.5 || cut[1] > S[S.length - 1].u - 0.5) return fail(`Station and throats need ${Math.round((L + 2 * throat) * 10)} m plain track on both sides`);
    const steps = m === 0 ? A.steps : B!.steps;
    plan.mains.push({ steps, cut, lat: lats[m] });
    for (const q2 of S) if (q2.u > cut[0] - 1 && q2.u < cut[1] + 1) ignore.add(q2.edge);
  }
  // the station itself, at the line's height
  const st = g.stations.planRail(cx, cz, Math.atan2(fx, fz), L, P, owner, { level: lv, fixedY: yc, through: T, throughMode: o.throughMode ?? 'middle', ignoreEdges: ignore, trackType: e.type, mode: o.mode, platformStyle: style, psd: o.psd, style: o.style, blockedEnds: [1, -1] });
  plan.station = st;
  if (!st.ok) return fail(st.error ?? 'Cannot build the station here');
  plan.warnings.push(...st.warnings);
  // the fans, checked now
  let cost = st.cost;
  const allowed = new Set<number>(ignore);
  for (let j = 0; j < plan.feeds.length; j++) {
    const m = plan.feeds[j], S = mainsS[m], off = all[plan.feedTrack[j]];
    for (const end of [0, 1]) {
      const cu = sampleAt(S, plan.mains[m].cut[end]);
      const sx = cx + fx * (end ? L / 2 : -L / 2) + rx * off, sz = cz + fz * (end ? L / 2 : -L / 2) + rz * off;
      const sp: SPt = { x: sx, z: sz, y: yc, tx: fx, tz: fz };
      const cp: SPt = { x: cu.x, z: cu.z, y: cu.y, tx: cu.tx, tz: cu.tz, edge: cu.edge, s: cu.s };
      const r = end ? connectS(g, owner, sp, cp, allowed, true) : connectS(g, owner, cp, sp, allowed, true);
      if (r.error) return fail(`Cannot connect station to line: ${r.error}`);
      cost += r.cost;
      plan.throat.push({ x0: cu.x, z0: cu.z, x1: sx, z1: sz });
    }
  }
  // the old track between the cuts is taken up
  for (const mn of plan.mains) cost += (mn.cut[1] - mn.cut[0]) * 400;
  plan.cost = Math.round(cost);
  if (!g.company(owner).economy.canAfford(plan.cost)) plan.warnings.push('Not enough money');
  return plan;
}

/**
 * Insert a planned station into its line: the line tracks are cut at the throats (only when no train stands on
 * that stretch: 'busy'), the station is built and the fans laid. Trains and lines keep using the line (through the
 * platform or through tracks); lines may then add the stop. Returns the new station's id, or the reason.
 */
export function commitStationOnTrack(g: Game, plan: OnTrackPlan): { error: string | null; station: number } {
  const net = g.world.net;
  const owner = plan.owner;
  if (!plan.ok || !plan.station) return { error: plan.error ?? 'Cannot build', station: -1 };
  for (const mn of plan.mains) for (const st of mn.steps) if (!net.edges.has(st.edge)) return { error: 'The track changed, plan again', station: -1 };
  const eco = g.company(owner).economy;
  if (!eco.canAfford(plan.cost)) return { error: 'Not enough money', station: -1 };
  // the stretches between the cuts must be free of trains
  const mains = plan.mains.map((m) => ({ ...m, steps: m.steps.map((x) => ({ ...x })) }));
  for (const mn of mains) {
    const S = sampleSteps(g, mn.steps);
    for (const q of S) if (q.u > mn.cut[0] - 0.5 && q.u < mn.cut[1] + 0.5 && g.vehicles.isEdgeBusy(q.edge)) return { error: 'busy', station: -1 };
  }
  const untrack = trackSplits(g, mains.map((m) => m.steps));
  const cuts: [number, number][] = [];
  try {
    for (const mn of mains) {
      const ids: number[] = [];
      for (const end of [1, 0]) {
        const S = sampleSteps(g, mn.steps), q = sampleAt(S, mn.cut[end]);
        const e = net.edges.get(q.edge)!;
        let node: number;
        if (q.s < 0.3 || q.s > e.len - 0.3) node = q.s < 0.3 ? e.a : e.b;
        else { const r = net.splitEdge(e.id, q.s); if (!r) return { error: 'Cannot cut the track', station: -1 }; node = r.node.id; }
        ids[end] = node;
      }
      // take up the old track between the cut nodes
      // The cuts may snap to an edge end: use the cut nodes, rather than approximate sample distances,
      // so an outside approach is never taken up with the platforms.
      const inside: number[] = [];
      let between = false;
      for (const step of mn.steps) {
        if (startNode(g, step) === ids[0]) between = true;
        if (between) inside.push(step.edge);
        if (between && endNode(g, step) === ids[1]) break;
      }
      let len = 0;
      for (const id of inside) { const e = net.edges.get(id); if (e) { len += e.len; net.removeEdge(id); } }
      eco.spend(len * 400, 'construction', true);
      cuts.push([ids[0], ids[1]]);
    }
  } finally {
    untrack();
  }
  const sid = g.stations.nextId;
  const err = g.stations.commitRail(plan.station, owner);
  if (err) return { error: err, station: -1 };
  const st = g.stations.get(plan.station.join ? plan.station.join.id : sid)!;
  const ends = g.stations.trackEnds(st, true);
  const allowed = new Set<number>([...st.rail!.edges, ...st.rail!.throughEdges]);
  for (const c of cuts) for (const nid of c) for (const id of net.nodes.get(nid)?.edges ?? []) allowed.add(id);
  const f = { x: Math.sin(st.rail!.angle), z: Math.cos(st.rail!.angle) };
  let firstErr: string | null = null;
  const e0 = net.nextEdge;
  for (let j = 0; j < plan.feeds.length; j++) {
    const m = plan.feeds[j], t = ends[plan.feedTrack[j]];
    if (!t) { firstErr = firstErr ?? 'Station track missing'; continue; }
    for (const end of [0, 1]) {
      const cn = net.nodes.get(cuts[m][end])!, sn = net.nodes.get(end ? t.front : t.back)!;
      const cutPt: SPt = { x: cn.x, z: cn.z, y: cn.y, tx: cn.dx || f.x, tz: cn.dz || f.z, node: cn.id };
      const stPt: SPt = { x: sn.x, z: sn.z, y: sn.y, tx: f.x, tz: f.z, node: sn.id };
      for (let id = e0; id < net.nextEdge; id++) allowed.add(id);
      const r = end ? connectS(g, owner, stPt, cutPt, allowed, false) : connectS(g, owner, cutPt, stPt, allowed, false);
      if (r.error && !firstErr) firstErr = `Throat: ${r.error}`;
    }
  }
  g.onNetworkChanged();
  g.lines.rebuild();
  return { error: firstErr, station: st.id };
}

// ------------------------------------------------------------------ lifting / sinking existing track

export interface RelevelOpts {
  /** elevated: deck height above the ground (default LINE_LEVEL.height.def) */
  height?: number;
  /** underground: depth below the ground (default LINE_LEVEL.depth.def) */
  depth?: number;
}

export interface RelevelPlan {
  ok: boolean; error?: string; warnings: string[];
  owner: number; level: StationLevel; cost: number;
  /** new heights (profile samples, as NEdge.prof) and structure sections of every edge of the stretch */
  edges: { id: number; prof: Float32Array; sections: Section[] }[];
  /** new node heights (the stretch's outer ends keep theirs: the ramps start there) */
  nodes: { id: number; y: number }[];
  /** stations on the stretch, rebuilt at the new level in place (tracks kept): their plans (and the price of new
   * access streets to added entrances of a ground station staying on the ground, paid as they are built) */
  stations: { id: number; plan: StationPlan; streets?: number }[];
  /** level crossings / diamonds on the stretch that become under- or overpasses */
  crossings: number[];
  /** ramp length at each outer end of the stretch (units) */
  ramps: number[];
}

/**
 * Plan lifting a stretch of existing track onto a viaduct ('elevated'), sinking it into a tunnel ('underground')
 * or bringing it back to the ground, in place: the same tracks (connections, lines and signals stay) get new
 * heights and structures, ramps at the stretch's outer ends (within the track type's grade) and stations on it
 * go to the new level with them (entrances or piers as built new). Level crossings and diamonds on it become
 * under- / overpasses. Cost: the new structures minus a third of the old ones. Nothing is built.
 */
export function planRelevel(g: Game, edgeIds: number[], level: StationLevel, owner: number, opts: RelevelOpts = {}): RelevelPlan {
  const net = g.world.net, w = g.world;
  const plan: RelevelPlan = { ok: false, warnings: [], owner, level, cost: 0, edges: [], nodes: [], stations: [], crossings: [], ramps: [] };
  const fail = (m: string) => { plan.ok = false; plan.error = m; return plan; };
  const set = new Set<number>();
  for (const id of edgeIds) {
    const e = net.edges.get(id);
    if (!e || e.kind !== 'rail') continue;
    if (e.owner !== owner) return fail('Not your track');
    if (e.depot >= 0) return fail('Depot tracks stay on the ground');
    set.add(id);
  }
  if (!set.size) return fail('No track picked');
  // stations on the stretch: platform / through tracks with picked track on both sides (or picked themselves)
  const stations = new Set<number>();
  for (const st of g.stations.all()) {
    if (!st.rail || st.owner !== owner) continue;
    const ids = [...st.rail.edges, ...st.rail.throughEdges];
    const inline = ids.some((id) => set.has(id)) || ids.some((id) => {
      const e = net.edges.get(id);
      const cont = (nid: number) => { const n = net.nodes.get(nid); return !!n && n.edges.some((x) => x !== id && set.has(x)); };
      return !!e && cont(e.a) && cont(e.b);
    });
    if (!inline) continue;
    stations.add(st.id);
    for (const id of ids) set.add(id);
  }
  const tt = TRACK_TYPES[lineType(g, [{ edge: [...set][0], dir: 1 }])] ?? TRACK_TYPES.standard;
  const grade = tt.maxGrade * 0.92;
  const off = level === 'elevated' ? Math.max(LINE_LEVEL.height.min, Math.min(LINE_LEVEL.height.max, opts.height ?? LINE_LEVEL.height.def))
    : level === 'underground' ? -Math.max(LINE_LEVEL.depth.min, Math.min(LINE_LEVEL.depth.max, opts.depth ?? LINE_LEVEL.depth.def)) : 0;
  // the stations' new platform level (as built new there, its own structures ignored)
  const stY = new Map<number, number>();
  for (const sid of stations) {
    const st = g.stations.get(sid)!, r = st.rail!;
    // (a ground station staying on the ground keeps its added entrances where they still fit: the building avoids them)
    const ground = level === 'ground' && (r.level ?? 'ground') === 'ground';
    const avoid = ground ? r.entrances.flatMap((e) => entranceLandings(e).map((p) => landingRect(entranceKind('ground', e), p))) : undefined;
    const sp = g.stations.planRail(r.x, r.z, r.angle, r.length, r.tracks, owner, {
      level, ignoreStation: sid, ignoreEdges: set, through: r.through ?? 0, throughMode: r.throughMode, trackType: r.trackType, mode: railPartMode(r),
      platformStyle: r.platformStyle, psd: r.psd, style: level === 'ground' ? r.style : 'none', height: opts.height, depth: opts.depth, avoid,
    });
    if (!sp.ok) return fail(`${st.name}: ${sp.error ?? 'cannot be rebuilt at that level'}`);
    // its added entrances: beside the platforms where they fit and a street reaches them (ground), else they go
    const fit = ground ? g.stations.previewRefit(st, sp) : null;
    const gone = ground ? null : entrancesGo(r.level ?? 'ground', r.entrances, 'station rebuilt at new level');
    for (const w of [...refitWarnings(fit), ...(gone ? [gone] : [])]) plan.warnings.push(`${st.name}: ${w[0].toLowerCase()}${w.slice(1)}`);
    plan.stations.push({ id: sid, plan: sp, ...(fit?.streets ? { streets: fit.streets } : {}) });
    stY.set(sid, sp.y);
    plan.cost += Math.max(0, sp.cost - (r.cost ?? 0) * 0.3) + (fit?.streets ?? 0);
  }
  // the stretch's nodes: outer ends (track continues beyond, or nothing: a dead end) and inner ones
  const nodesOf = new Map<number, number[]>();
  for (const id of set) { const e = net.edges.get(id)!; for (const nid of [e.a, e.b]) { const a = nodesOf.get(nid) ?? []; a.push(id); nodesOf.set(nid, a); } }
  const anchor = new Map<number, number>();   // fixed node heights
  for (const [nid, es] of nodesOf) {
    const n = net.nodes.get(nid)!;
    if (n.edges.length > es.length) anchor.set(nid, n.y);   // joins track outside the stretch: the ramp starts here
  }
  // station platforms: flat at their new level
  for (const sid of stations) for (const id of [...g.stations.get(sid)!.rail!.edges, ...g.stations.get(sid)!.rail!.throughEdges]) {
    const e = net.edges.get(id);
    if (e) { anchor.set(e.a, stY.get(sid)!); anchor.set(e.b, stY.get(sid)!); }
  }
  // chains through the stretch (longest first): each gets the wanted height by the terrain, held to the grade
  // from its fixed ends (outer ends, stations, chains done before)
  const done = new Set<number>();
  const newY = new Map<number, number>();
  const p = { x: 0, y: 0, z: 0 };
  const byLen = [...set].map((id) => net.edges.get(id)!).sort((a, b) => b.len - a.len);
  for (const seed of byLen) {
    if (done.has(seed.id)) continue;
    const chain = walkTrack(g, seed, set, done);
    for (const s of chain) done.add(s.edge);
    // samples along the chain
    const pts: { e: NEdge; s: number; d: number; t: number; node?: number }[] = [];
    let acc = 0;
    for (const st of chain) {
      const e = net.edges.get(st.edge)!;
      const m = Math.max(2, Math.ceil(e.len / PSTEP) + 1);
      for (let i = 0; i < m; i++) {
        if (pts.length && i === 0) continue;
        const sl = Math.min(i * PSTEP, e.len), s = st.dir > 0 ? sl : e.len - sl;
        net.pointAt(e, s, p);
        const node = i === 0 ? (st.dir > 0 ? e.a : e.b) : i === m - 1 ? (st.dir > 0 ? e.b : e.a) : undefined;
        pts.push({ e, s, d: acc + sl, t: w.heightAt(p.x, p.z) + off, node });
      }
      acc += e.len;
    }
    if (pts[0].node === undefined) pts[0].node = (chain[0].dir > 0 ? net.edges.get(chain[0].edge)!.a : net.edges.get(chain[0].edge)!.b);
    // stations' platforms flat; fixed nodes
    const y = pts.map((q) => q.t);
    const fixed = pts.map((q) => {
      const sid = q.e.station >= 0 ? q.e.station : g.stations.throughStationOf(q.e.id);
      if (sid >= 0 && stY.has(sid)) return stY.get(sid)!;
      if (q.node !== undefined) { if (newY.has(q.node)) return newY.get(q.node)!; if (anchor.has(q.node)) return anchor.get(q.node)!; }
      return NaN;
    });
    for (let i = 0; i < y.length; i++) if (isFinite(fixed[i])) y[i] = fixed[i];
    // grade envelope from the fixed points, both ways
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 1; i < y.length; i++) { const dd = pts[i].d - pts[i - 1].d; if (!isFinite(fixed[i])) y[i] = Math.max(y[i - 1] - grade * dd, Math.min(y[i - 1] + grade * dd, y[i])); }
      for (let i = y.length - 2; i >= 0; i--) { const dd = pts[i + 1].d - pts[i].d; if (!isFinite(fixed[i])) y[i] = Math.max(y[i + 1] - grade * dd, Math.min(y[i + 1] + grade * dd, y[i])); }
    }
    for (let i = 1; i < y.length; i++) if (Math.abs(y[i] - y[i - 1]) > grade * (pts[i].d - pts[i - 1].d) * 1.15 + 0.02) return fail('Ramps too steep: choose longer stretch');
    pts.forEach((q, i) => { if (q.node !== undefined) newY.set(q.node, y[i]); });
    // ramp lengths at the outer ends: where the track reaches the wanted height
    for (const [i0, dir] of [[0, 1], [y.length - 1, -1]] as [number, number][]) {
      if (pts[i0].node === undefined || !anchor.has(pts[i0].node!) || isFinite(fixed[i0]) === false) continue;
      let k = i0;
      while (k >= 0 && k < y.length && Math.abs(y[k] - pts[k].t) > 0.05 && !(pts[k].e.station >= 0)) k += dir;
      plan.ramps.push(Math.abs(pts[Math.max(0, Math.min(y.length - 1, k))].d - pts[i0].d));
    }
    // per edge: profile and structure sections
    let k = 0;
    for (const st of chain) {
      const e = net.edges.get(st.edge)!;
      const m = Math.max(2, Math.ceil(e.len / PSTEP) + 1);
      const prof = new Float32Array(m), ter = new Float32Array(m);
      for (let i = 0; i < m; i++) {
        const q = pts[k + (i === 0 ? 0 : i)];
        const j = st.dir > 0 ? i : m - 1 - i;
        prof[j] = y[k + i];
        ter[j] = q.t - off;
      }
      k += m - 1;
      const sections: Section[] = [];
      const kind = level === 'elevated' ? 'bridge' : level === 'underground' ? 'tunnel' : null;
      if (kind) {
        let s0 = -1;
        for (let i = 0; i < m; i++) {
          const over = kind === 'bridge' ? prof[i] - ter[i] >= 0.55 : ter[i] - prof[i] >= 0.9;
          const s = Math.min(i * PSTEP, e.len);
          if (over && s0 < 0) s0 = s;
          if ((!over || i === m - 1) && s0 >= 0) { const s1 = over ? e.len : s; if (s1 - s0 > 0.5) sections.push({ s0, s1, type: kind }); s0 = -1; }
        }
        if (e.station >= 0 || g.stations.throughStationOf(e.id) >= 0) { sections.length = 0; sections.push({ s0: 0, s1: e.len, type: kind }); }
      }
      plan.edges.push({ id: e.id, prof, sections });
      // structures cost: the new ones minus a third of the old
      if (e.station < 0 && g.stations.throughStationOf(e.id) < 0) {
        for (const sc of sections) plan.cost += (sc.s1 - sc.s0) * tt.costPerUnit * structureFactor('rail', sc.type, sc.type === 'bridge' ? Math.max(0.6, prof[Math.min(m - 1, Math.round(((sc.s0 + sc.s1) / 2) / PSTEP))] - ter[Math.min(m - 1, Math.round(((sc.s0 + sc.s1) / 2) / PSTEP))]) : Math.max(1, ter[Math.min(m - 1, Math.round(((sc.s0 + sc.s1) / 2) / PSTEP))] - prof[Math.min(m - 1, Math.round(((sc.s0 + sc.s1) / 2) / PSTEP))]));
        for (const sc of e.sections) plan.cost -= (sc.s1 - sc.s0) * tt.costPerUnit * structureFactor('rail', sc.type, 1.2) * 0.3;
        if (!kind) plan.cost += e.len * 600;   // earthworks back on the ground
      }
    }
  }
  plan.nodes = [...newY].map(([id, y]) => ({ id, y }));
  // crossings on the stretch: grade-separated now (a road or track at the same height is in the way)
  for (const [cid, c] of net.crossings) {
    if (!set.has(c.e1) && !set.has(c.e2)) continue;
    const mine = set.has(c.e1) ? c.e1 : c.e2, s = set.has(c.e1) ? c.s1 : c.s2;
    const other = net.edges.get(mine === c.e1 ? c.e2 : c.e1), os = mine === c.e1 ? c.s2 : c.s1;
    const pe = plan.edges.find((x) => x.id === mine);
    if (!pe || !other) continue;
    const e = net.edges.get(mine)!;
    const yNew = profAtS(pe.prof, e.len, s), yOther = net.heightAtS(other, os);
    if (Math.abs(yNew - yOther) < RAIL.clearance + 0.3) return fail(`${other.kind === 'road' ? 'A road' : 'Another track'} crosses at same height near ${Math.round(c.x)},${Math.round(c.z)}: choose longer stretch`);
    plan.crossings.push(cid);
  }
  plan.cost = Math.max(0, Math.round(plan.cost));
  plan.ok = true;
  if (!g.company(owner).economy.canAfford(plan.cost)) plan.warnings.push('Not enough money');
  return plan;
}

/** Height on a profile array at arc length s (as Network.heightAtS). */
function profAtS(prof: Float32Array, len: number, s: number): number {
  const f = Math.max(0, Math.min(len, s)) / PSTEP, i = Math.floor(f), j = Math.min(prof.length - 1, i + 1);
  return prof[Math.min(i, prof.length - 1)] + (prof[j] - prof[Math.min(i, prof.length - 1)]) * (f - i);
}

/**
 * Lift / sink the track as planned (planRelevel): new heights and structures in place, the stations at the new
 * level, crossings on the stretch grade-separated. Trains on the stretch go up or down with it (their routes and
 * reservations stay); with `waitForTrains` it answers 'busy' while one is there. Null = OK.
 */
export function commitRelevel(g: Game, plan: RelevelPlan, opts: { waitForTrains?: boolean } = {}): string | null {
  const net = g.world.net, w = g.world;
  if (!plan.ok) return plan.error ?? 'Cannot rebuild';
  for (const x of plan.edges) if (!net.edges.has(x.id)) return 'The track changed, plan again';
  if (opts.waitForTrains && plan.edges.some((x) => g.vehicles.isEdgeBusy(x.id))) return 'busy';
  const eco = g.company(plan.owner).economy;
  if (!eco.canAfford(plan.cost)) return 'Not enough money';
  // (new access streets to stations' added entrances are paid as they are built)
  eco.spend(plan.cost - plan.stations.reduce((c, s) => c + (s.streets ?? 0), 0), 'construction');
  for (const n of plan.nodes) { const node = net.nodes.get(n.id); if (node) node.y = n.y; }
  const ground: NEdge[] = [];
  for (const x of plan.edges) {
    const e = net.edges.get(x.id)!;
    e.prof = x.prof; e.sections = x.sections.map((s) => ({ ...s }));
    net.touchEdge(e);
    if (!x.sections.length) ground.push(e);
  }
  for (const cid of plan.crossings) net.crossings.delete(cid);
  for (const s of plan.stations) g.stations.relevelInPlace(s.id, s.plan);
  if (ground.length) applyEarthworks(w, ground);
  {
    // the ground along the stretch: formations of the track and roads there again
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (const x of plan.edges) { const e = net.edges.get(x.id); if (!e) continue; for (const nid of [e.a, e.b]) { const n = net.nodes.get(nid)!; x0 = Math.min(x0, n.x); z0 = Math.min(z0, n.z); x1 = Math.max(x1, n.x); z1 = Math.max(z1, n.z); } }
    if (isFinite(x0)) repairFormations(w, x0 - 4, z0 - 4, x1 + 4, z1 + 4);
  }
  net.version++;
  g.onNetworkChanged();
  g.lines.rebuild();
  return null;
}

// ------------------------------------------------------------------ tidying crossovers

/**
 * Crossovers of an existing double track (its edges, both tracks) laid out as for a new one: those on plain line
 * between stations (not by a depot branch) are taken out when no train is on them, and missing pairs right
 * outside the stations are laid (=====x==[station]==x=====), with the signals around them. Returns how many
 * crossovers went and came, and the signals placed.
 */
export function normaliseCrossovers(g: Game, edgeIds: number[], owner: number, opts: FinishOpts = {}): FinishResult {
  return finishDoubleTrack(g, edgeIds, owner, { ...opts, normalise: true });
}

// ------------------------------------------------------------------ connecting two tracks

export interface ConnectionOpts {
  /** slide the turnouts up to this far along their tracks to find a curve that fits (default 0: exactly there) */
  search?: number;
  /** wanted through movement: trains run along track A in this direction (+1: edgeA's +s) into the connection */
  dirA?: 1 | -1;
  /** ... and continue along track B in this direction (+1: edgeB's +s) */
  dirB?: 1 | -1;
  /** crossings on the way (construction's crossing mode, default 'auto') */
  crossing?: BuildOptions['crossing'];
  /** A connector of directional rails may cross its companion lead at a protected shallow diamond. */
  junctionUpgrade?: boolean;
  /** track type of the connecting curve (default: track A's) */
  type?: string;
  /** signal the junctions by the rules when track there is signalled (default true) */
  signals?: boolean;
}

export interface ConnectionPlan {
  ok: boolean; error?: string; warnings: string[];
  owner: number; cost: number;
  /** the connecting curve (construction proposal: preview, cost, demolitions, crossings) */
  proposal: Proposal | null;
  /** where the turnouts go: on track A, then on track B */
  turnouts: { edge: number; s: number; x: number; z: number }[];
  /** travel directions through the connection: along A (edgeA's +s = 1) into it, along B out of it */
  dirA: 1 | -1; dirB: 1 | -1;
  length: number; minRadius: number;
  /** between two parallel tracks: a crossover (an S-curve from track A to track B) instead of a proposal */
  crossover?: { a: SPt; b: SPt };
}

/**
 * Plan a connecting curve from a point on one track (edgeA at arc length sA) to a point on another (edgeB, sB),
 * with turnouts split into both: the curve leaves A towards B and joins B tangentially, within the curve and
 * grade limits of its track type (construction checks crossings, bridges and demolitions as for any track).
 * `dirA` / `dirB` ask for a through movement (trains along A in that direction continue along B in that one);
 * `search` slides the turnouts along their tracks to find a curve that fits. Another company's track needs
 * access (as when building). Nothing is built.
 */
export function planConnection(g: Game, edgeA: number, sA: number, edgeB: number, sB: number, owner: number, opts: ConnectionOpts = {}): ConnectionPlan {
  const net = g.world.net;
  const plan: ConnectionPlan = { ok: false, warnings: [], owner, cost: 0, proposal: null, turnouts: [], dirA: 1, dirB: 1, length: 0, minRadius: 0 };
  const ea = net.edges.get(edgeA), eb = net.edges.get(edgeB);
  if (!ea || !eb || ea.kind !== 'rail' || eb.kind !== 'rail') { plan.error = 'Pick two railway tracks'; return plan; }
  for (const e of [ea, eb]) { const access = g.trackUpgradeError(owner, e.owner); if (access) { plan.error = access; return plan; } }
  if (ea.station >= 0 || eb.station >= 0 || ea.depot >= 0 || eb.depot >= 0) { plan.error = 'Turnouts need track outside platforms and depots'; return plan; }
  if (ea.id === eb.id) { plan.error = 'Pick two different tracks'; return plan; }
  const type = opts.type ?? ea.type;
  const span = Math.max(0, opts.search ?? 0);
  const offs: number[] = [0];
  for (let d = 2; d <= span + 1e-6; d += 2) offs.push(d, -d);
  const p = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
  let best: { prop: Proposal; a: number; b: number; da: 1 | -1; db: 1 | -1; score: number; xo?: { a: SPt; b: SPt; cost: number } } | null = null;
  let firstErr = '';
  for (const oa of offs) for (const ob of offs) {
    const s1 = Math.max(1, Math.min(ea.len - 1, sA + oa)), s2 = Math.max(1, Math.min(eb.len - 1, sB + ob));
    if (ea.len < 2.5 || eb.len < 2.5) { firstErr = 'Track too short for turnout'; break; }
    net.pointAt(ea, s1, p, t);
    const ax = p.x, az = p.z, atx = t.x, atz = t.z;
    net.pointAt(eb, s2, p, t);
    const bx = p.x, bz = p.z, btx = t.x, btz = t.z;
    // construction leaves A towards B and arrives on B in the direction of the chord
    const cx = bx - ax, cz = bz - az;
    const da: 1 | -1 = cx * atx + cz * atz >= 0 ? 1 : -1, db: 1 | -1 = cx * btx + cz * btz >= 0 ? 1 : -1;
    if ((opts.dirA && opts.dirA !== da) || (opts.dirB && opts.dirB !== db)) { firstErr = firstErr || 'No curve allows through running here'; continue; }
    // two tracks side by side: a crossover between them
    const tal = Math.hypot(atx, atz) || 1, tbl = Math.hypot(btx, btz) || 1;
    const par = Math.abs((atx * btx + atz * btz) / (tal * tbl)) > 0.97 && Math.abs((cx * -atz + cz * atx) / tal) < 2.2;
    if (par) {
      const a: SPt = { x: ax, z: az, y: net.heightAtS(ea, s1), tx: atx / tal, tz: atz / tal, edge: ea.id, s: s1 };
      const b: SPt = { x: bx, z: bz, y: net.heightAtS(eb, s2), tx: btx / tbl, tz: btz / tbl, edge: eb.id, s: s2 };
      const c = connectS(g, owner, a, b, besideTracks(g, [ea, eb], 20), true, type, ea.owner);
      if (c.error) { firstErr = firstErr || c.error; continue; }
      const score = c.cost + (Math.abs(oa) + Math.abs(ob)) * 2000;
      if (!best || score < best.score) best = { prop: null as unknown as Proposal, a: s1, b: s2, da, db, score, xo: { a, b, cost: c.cost } };
      continue;
    }
    const prop = planEdge(g, { kind: 'edge', x: ax, z: az, y: net.heightAtS(ea, s1), edge: ea.id, s: s1 }, { kind: 'edge', x: bx, z: bz, y: net.heightAtS(eb, s2), edge: eb.id, s: s2 }, railOpts(owner, { type, crossing: opts.crossing ?? 'auto', junctionUpgrade: opts.junctionUpgrade }));
    if (!prop.ok) { firstErr = firstErr || prop.errors[0] || 'Cannot build the connection'; continue; }
    const score = prop.cost - Math.min(prop.stats.minRadius, 200) * 500 + (Math.abs(oa) + Math.abs(ob)) * 2000;
    if (!best || score < best.score) best = { prop, a: s1, b: s2, da, db, score };
  }
  if (!best) { plan.error = firstErr || 'Cannot connect the tracks here'; return plan; }
  net.pointAt(ea, best.a, p);
  plan.turnouts.push({ edge: ea.id, s: best.a, x: p.x, z: p.z });
  net.pointAt(eb, best.b, p);
  plan.turnouts.push({ edge: eb.id, s: best.b, x: p.x, z: p.z });
  plan.ok = true;
  plan.dirA = best.da; plan.dirB = best.db;
  if (best.xo) {
    plan.crossover = { a: best.xo.a, b: best.xo.b };
    plan.cost = Math.round(best.xo.cost);
    plan.length = Math.hypot(best.xo.b.x - best.xo.a.x, best.xo.b.z - best.xo.a.z);
    plan.minRadius = (TRACK_TYPES[type] ?? TRACK_TYPES.standard).minRadius;
  } else {
    plan.proposal = best.prop;
    plan.cost = Math.round(best.prop.cost);
    plan.length = best.prop.stats.len;
    plan.minRadius = best.prop.stats.minRadius;
    plan.warnings.push(...best.prop.warnings);
  }
  if (!g.company(owner).economy.canAfford(plan.cost)) plan.warnings.push('Not enough money');
  return plan;
}

/**
 * Build a planned connection (turnouts split into both tracks), then signal it by the rules where the track
 * around is signalled (path signals before the new junctions). Returns the new edges, or the reason.
 */
export function commitConnection(g: Game, plan: ConnectionPlan, opts: { signals?: boolean } = {}): { error: string | null; edges: number[]; signals: number } {
  const net = g.world.net;
  if (!plan.ok || (!plan.proposal && !plan.crossover)) return { error: plan.error ?? 'Cannot build', edges: [], signals: 0 };
  for (const t of plan.turnouts) if (!net.edges.has(t.edge)) return { error: 'The track changed, plan again', edges: [], signals: 0 };
  const e0 = net.nextEdge;
  for (const t of plan.turnouts) { const access = g.trackUpgradeError(plan.owner, net.edges.get(t.edge)!.owner); if (access) return { error: access, edges: [], signals: 0 }; }
  const infrastructureOwner = plan.crossover ? net.edges.get(plan.crossover.a.edge!)!.owner : plan.owner;
  const retained = new Set(net.edges.keys());
  const retainSplit = (old: NEdge, a: NEdge, b: NEdge) => { if (retained.delete(old.id)) { retained.add(a.id); retained.add(b.id); } };
  net.onSplit.push(retainSplit);
  let err: string | null;
  try { err = plan.crossover ? connectS(g, plan.owner, plan.crossover.a, plan.crossover.b, besideTracks(g, plan.turnouts.map((t) => net.edges.get(t.edge)!), 20), false, undefined, infrastructureOwner).error : commitProposal(g, plan.proposal!); }
  finally { net.onSplit = net.onSplit.filter((f) => f !== retainSplit); }
  if (err) return { error: err, edges: [], signals: 0 };
  const edges: number[] = [];
  for (let id = e0; id < net.nextEdge; id++) if (net.edges.get(id)?.owner === infrastructureOwner && net.edges.get(id)?.kind === 'rail' && !retained.has(id)) edges.push(id);
  let signals = 0;
  if (opts.signals ?? true) signals = signalAround(g, plan.turnouts.map((t) => ({ x: t.x, z: t.z })), plan.owner);
  g.onNetworkChanged();
  return { error: null, edges, signals };
}

/** The edges of tracks (straight on both ways from the given edges, `reach` units): a crossover between them may run beside them. */
function besideTracks(g: Game, edges: NEdge[], reach: number): Set<number> {
  const out = new Set<number>();
  for (const e of edges) {
    out.add(e.id);
    for (const nid of [e.a, e.b]) for (const id of straightOn(g, nid, e, e.len + reach)) out.add(id);
  }
  return out;
}

/** Signal usable track around some points by the automatic rules, when it is signalled there already. */
function signalAround(g: Game, pts: { x: number; z: number }[], owner: number, R = 45): number {
  const net = g.world.net;
  let any = false;
  for (const q of pts) for (const id of net.nodeGrid.query(q.x - R, q.z - R, q.x + R, q.z + R)) if (net.nodes.get(id)?.signal) { any = true; break; }
  if (!any) return 0;
  const E = new Set<number>();
  for (const q of pts) for (const e of net.edgesNear(q.x - R * 1.5, q.z - R * 1.5, q.x + R * 1.5, q.z + R * 1.5)) if (e.kind === 'rail' && !g.trackUpgradeError(owner, e.owner)) E.add(e.id);
  for (const st of g.stations.all()) if (st.rail && !g.trackUpgradeError(owner, st.owner) && [...st.rail.edges, ...st.rail.throughEdges].some((id) => E.has(id))) for (const id of [...st.rail.edges, ...st.rail.throughEdges]) E.add(id);
  return autoSignalLine(g, [...E], owner).placed;
}

// ------------------------------------------------------------------ pairing two single tracks

/**
 * Two single tracks laid side by side (0.3-1.7 units apart, e.g. two lines' tracks) become one directional
 * double track: crossovers (one each way) at both ends of the stretch where they run side by side, unless the
 * tracks merge there, so each line's trains reach both tracks, and one-way signals as finishDoubleTrack. Both
 * tracks must be the owner's or accessible. Crossover legs stay with the track they leave; the user pays.
 */
export function pairAsDoubleTrack(g: Game, edgesA: number[], edgesB: number[], owner: number, opts: FinishOpts = {}): FinishResult {
  const net = g.world.net;
  const bad = (error: string): FinishResult => ({ signals: 0, crossovers: 0, cost: 0, error });
  const ok = (ids: number[]) => ids.length > 0 && ids.every((id) => { const e = net.edges.get(id); return !!e && e.kind === 'rail' && e.station < 0 && e.depot < 0; });
  if (!ok(edgesA) || !ok(edgesB)) return bad('Pick two plain railway tracks');
  for (const id of [...edgesA, ...edgesB]) { const e = net.edges.get(id)!; const access = g.trackUpgradeError(owner, e.owner); if (access) return bad(access); }
  if (edgesA.some((id) => edgesB.includes(id))) return bad('The two tracks share track');
  return finishDoubleTrack(g, [...edgesA, ...edgesB], owner, { ...opts, crossoversAt: 'always' });
}

// ------------------------------------------------------------------ merging stations

export interface MergeCheck {
  ok: boolean;
  /** 'rebuild': one station (rail parts united / stops joined); 'complex': linked stations shown as one */
  kind: 'rebuild' | 'complex' | null;
  reason: string;
}

/**
 * Can two stations become one? 'rebuild' when they can be one station (parallel adjacent rail parts united, a
 * stop-only station joined: Stations.canMerge / railMergeable), else 'complex' when they are within walking range
 * (linked for transfers and shown as one station), else not (the reason).
 */
export function canMerge(g: Game, aId: number, bId: number): MergeCheck {
  const S = g.stations;
  const a = S.get(aId), b = S.get(bId);
  if (!a || !b || a === b) return { ok: false, kind: null, reason: a === b ? 'The same station' : 'No such station' };
  const m = S.canMerge(aId, bId);
  if (!m) return { ok: true, kind: 'rebuild', reason: a.rail && b.rail ? 'Side by side: one station, all platforms' : 'Close together: one station' };
  if (a.links.includes(b.id)) return { ok: true, kind: 'complex', reason: `Already linked (${m})` };
  const l = S.canLink(aId, bId);
  if (!l) return { ok: true, kind: 'complex', reason: `${m}; linked for transfers instead` };
  return { ok: false, kind: null, reason: l };
}

/** Merge two stations as canMerge says: one station (`a` stays) or a transfer complex. */
export function mergeStations(g: Game, aId: number, bId: number): { error: string | null; kind: 'rebuild' | 'complex' | null; station: number } {
  const c = canMerge(g, aId, bId);
  if (!c.ok) return { error: c.reason, kind: null, station: -1 };
  if (c.kind === 'rebuild') { const err = g.stations.merge(aId, bId); return { error: err, kind: 'rebuild', station: err ? -1 : aId }; }
  const b = g.stations.get(bId)!;
  const err = g.stations.get(aId)!.links.includes(b.id) ? null : g.stations.link(aId, bId);
  return { error: err, kind: 'complex', station: err ? -1 : aId };
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
