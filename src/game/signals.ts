// Signals: set, change or remove the signal at a point of a track, and lay out one-way block signals along a
// stretch of track at a regular spacing (stopping at switches, stations, depots and other companies' track).
// Signals sit on rail nodes joining exactly two tracks (node.signal: 0 none, 1 two-way, 2 / 3 one-way for trains
// leaving the node on side +1 / -1); a signal between nodes splits the edge there. See also toggleSignal (build-ops).
import type { Game } from './game';
import type { NEdge, NNode } from './network';
import { findRailRoute, railNext, RouteResult } from './train';

export type SignalKind = 'none' | 'twoway' | 'oneway';
/** Price of a new signal (as toggleSignal); changing or removing one is free. */
export const SIGNAL_COST = 9000;
/** Default spacing of block signals (units, 1 = 10 m). */
export const SIGNAL_SPACING = 50;
/** Positions this close to an edge end use the node there. */
const NODE_SNAP = 0.6;

/** One planned signal of a stretch: where, for which direction, and the node already there (or -1). */
export interface SignalSpot {
  edge: number; s: number; x: number; z: number;
  /** one-way for trains travelling in the edge's +s direction */
  forward: boolean;
  /** distance from the start of the stretch */
  at: number;
  /** existing node at the spot (-1: the edge is split there) and its current signal */
  node: number; signal: number;
}

export interface SignalLayout {
  spots: SignalSpot[];
  /** length of the walked stretch */
  length: number;
  /** why the stretch ends: the requested length, a switch, a station, a depot, foreign track, a dead end or a loop */
  stop: 'length' | 'switch' | 'station' | 'depot' | 'foreign' | 'end' | 'loop';
  /** price of the new signals */
  cost: number;
}

export interface SignalRunOpts {
  /** start at this arc length of the first edge (default: its start in the walking direction) */
  s0?: number;
  /** 'oneway' (default) or 'twoway' */
  kind?: 'oneway' | 'twoway';
  /** signal kind of the placed signals (default: a signal already at a spot keeps its kind, new ones are 'path') */
  signalKind?: 'block' | 'path';
  /** one-way signals passable from behind (default: as the signal already there, new ones not) */
  pass?: boolean;
}

/** Side (+1/-1) on which a train travelling along `e` in direction `dir` leaves `node` (an end of e). */
function leaveSide(e: NEdge, dir: number, nodeId: number): number {
  const start = dir > 0 ? e.a : e.b;
  if (nodeId === start) return dir > 0 ? e.sa : e.sb;  // leaves along e itself
  return -(dir > 0 ? e.sb : e.sa);                     // arrives along e, leaves on the opposite side
}

/** The signal of a node as kind and, for one-way signals, the side trains may leave on. */
export function signalInfo(n: NNode): { kind: SignalKind; side: number } {
  if (!n.signal) return { kind: 'none', side: 0 };
  if (n.signal === 1) return { kind: 'twoway', side: 0 };
  return { kind: 'oneway', side: n.signal === 2 ? 1 : -1 };
}

/** May trains travelling along `e` in direction `dir` pass the signal at `node` (an end of e)? */
export function signalAllows(g: Game, e: NEdge, dir: number, nodeId: number): boolean {
  const n = g.world.net.nodes.get(nodeId);
  return !n || g.world.net.signalFor(n, leaveSide(e, dir, nodeId)) >= 0;
}

/**
 * Set the signal at arc length `s` of rail edge `edgeId`: 'twoway', 'oneway' (for trains travelling in the edge's
 * +s direction when `forward`, else against it) or 'none' (remove). Within 0.6 of an edge end the node there is
 * used (it must join exactly two tracks); elsewhere the edge is split. New signals cost SIGNAL_COST.
 * Null = OK, else the reason.
 */
export interface SignalOpts {
  /** 'path' (default: junctions, station exits) or 'block' (open line) */
  signalKind?: 'block' | 'path';
  /** one-way signal passable by trains in the other direction (instead of making the track one-way) */
  pass?: boolean;
}

export function setSignal(g: Game, edgeId: number, s: number, kind: SignalKind, forward: boolean, owner: number, so: SignalOpts = {}): string | null {
  const net = g.world.net;
  const e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail') return 'No track here';
  if (e.owner !== owner) return 'Not your track';
  const dir = forward ? 1 : -1;
  let node: NNode | null = null;
  if (s < NODE_SNAP || s > e.len - NODE_SNAP) {
    node = net.nodes.get(s < NODE_SNAP ? e.a : e.b) ?? null;
    if (!node) return 'No track here';
    if (node.edges.length !== 2) return 'Signals need plain track (not at a switch or a track end)';
    const other = net.edges.get(node.edges[0] === e.id ? node.edges[1] : node.edges[0]);
    if (!other || other.owner !== owner) return 'Not your track';
    if ((e.station >= 0 || e.depot >= 0) && (other.station >= 0 || other.depot >= 0)) return 'Cannot place signals in stations or depots';
  } else {
    if (e.station >= 0 || e.depot >= 0) return 'Cannot place signals in stations or depots';
    if (kind === 'none') return null;
    if (g.vehicles.isEdgeBusy(e.id)) return 'Train in the way';
    if (!g.company(owner).economy.canAfford(SIGNAL_COST)) return 'Not enough money';
    const r = net.splitEdge(e.id, s);
    if (!r) return 'Cannot place here';
    node = r.node;
    // the split node: trains in +s direction leave along the second half
    const value = kind === 'twoway' ? 1 : (forward ? r.e2.sa : r.e1.sb) > 0 ? 2 : 3;
    return applySignal(g, node, value, owner, so);
  }
  const value = kind === 'none' ? 0 : kind === 'twoway' ? 1 : leaveSide(e, dir, node.id) > 0 ? 2 : 3;
  return applySignal(g, node, value, owner, so);
}

function applySignal(g: Game, node: NNode, value: number, owner: number, so: SignalOpts = {}): string | null {
  const net = g.world.net;
  const sk = value ? so.signalKind ?? 'path' : undefined, pass = value >= 2 ? !!so.pass : undefined;
  if (node.signal === value && (node.signalKind ?? 'path') === (sk ?? 'path') && !!node.signalPass === !!pass) return null;
  if (value && !node.signal && !g.company(owner).economy.spend(SIGNAL_COST, 'construction')) return 'Not enough money';
  if (sk && sk !== 'path') node.signalKind = sk; else delete node.signalKind;
  if (pass) node.signalPass = true; else delete node.signalPass;
  node.signal = value;
  net.version++;
  g.world.markObjArea(node.x - 2, node.z - 2, node.x + 2, node.z + 2);
  g.onNetworkChanged();
  return null;
}

/**
 * Walk along the track from edge `edgeId` in direction `dir` (+1 = the edge's +s direction) for up to `maxLength`
 * units and plan a signal every `spacing` units (the first at the start), stopping at switches, stations, depots,
 * other companies' track and dead ends. Nothing is built (preview for the signal tool).
 */
export function signalsAlong(g: Game, edgeId: number, dir: number, spacing: number, owner: number, maxLength = Infinity, o: SignalRunOpts = {}): SignalLayout {
  const net = g.world.net;
  const out: SignalLayout = { spots: [], length: 0, stop: 'end', cost: 0 };
  let e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail') return out;
  spacing = Math.max(4, spacing);
  let d = dir > 0 ? 1 : -1;
  let s = Math.max(0, Math.min(e.len, o.s0 ?? (d > 0 ? 0 : e.len)));
  if (e.owner !== owner) { out.stop = 'foreign'; return out; }
  if (e.station >= 0) { out.stop = 'station'; return out; }
  if (e.depot >= 0) { out.stop = 'depot'; return out; }
  const raw: { edge: NEdge; s: number; forward: boolean; at: number }[] = [];
  const visited = new Set<number>();
  let travelled = 0, next = 0;
  for (let guard = 0; guard < 5000; guard++) {
    visited.add(e.id);
    const rem = d > 0 ? e.len - s : s;
    while (next <= travelled + rem + 1e-6 && next <= maxLength + 1e-6) {
      raw.push({ edge: e, s: s + d * (next - travelled), forward: d > 0, at: next });
      next += spacing;
    }
    travelled += rem;
    if (travelled >= maxLength) { out.stop = 'length'; travelled = Math.min(travelled, maxLength); break; }
    const nodeId = d > 0 ? e.b : e.a;
    const node = net.nodes.get(nodeId)!;
    const conts = net.nextRail(e, d);
    if (!conts.length) { out.stop = 'end'; break; }
    if (conts.length > 1 || node.edges.length > 2) { out.stop = 'switch'; break; }
    const c = conts[0];
    if (c.edge.station >= 0) { out.stop = 'station'; break; }
    if (c.edge.depot >= 0) { out.stop = 'depot'; break; }
    if (c.edge.owner !== owner) { out.stop = 'foreign'; break; }
    if (visited.has(c.edge.id)) { out.stop = 'loop'; break; }
    e = c.edge; d = c.dir; s = d > 0 ? 0 : e.len;
  }
  out.length = travelled;
  const p = { x: 0, y: 0, z: 0 };
  for (const r of raw) {
    // not on the node of a switch or dead end that ends the stretch, nor on a switch / dead end at its start
    if ((out.stop === 'switch' || out.stop === 'end') && travelled - r.at < 1.0) continue;
    let nodeId = -1;
    if (r.s < 1.0 || r.s > r.edge.len - 1.0) {
      const end = r.s < 1.0 ? r.edge.a : r.edge.b;
      const n = net.nodes.get(end);
      const near = r.s < NODE_SNAP || r.s > r.edge.len - NODE_SNAP || !!n?.signal;
      if (near) {
        if (!n || n.edges.length !== 2) continue;
        nodeId = end;
      }
    }
    const sp = nodeId >= 0 ? (nodeId === r.edge.a ? 0 : r.edge.len) : r.s;
    net.pointAt(r.edge, sp, p);
    const signal = nodeId >= 0 ? net.nodes.get(nodeId)!.signal : 0;
    if (out.spots.some((q) => q.node >= 0 && q.node === nodeId)) continue;
    out.spots.push({ edge: r.edge.id, s: sp, x: p.x, z: p.z, forward: r.forward, at: r.at, node: nodeId, signal });
  }
  out.cost = out.spots.filter((q) => !q.signal).length * SIGNAL_COST;
  return out;
}

/**
 * Place one-way block signals (or two-way ones) every `spacing` units along a stretch of track, as planned by
 * signalsAlong. Signals already at the spots are turned to the new direction. Returns how many were placed and
 * what they cost; `error` when some could not be placed (e.g. not enough money, a train in the way).
 */
export function autoSignals(g: Game, edgeId: number, dir: number, spacing: number, owner: number, maxLength = Infinity, o: SignalRunOpts = {}): { placed: number; cost: number; error?: string; stop: SignalLayout['stop'] } {
  const lay = signalsAlong(g, edgeId, dir, spacing, owner, maxLength, o);
  const res: { placed: number; cost: number; error?: string; stop: SignalLayout['stop'] } = { placed: 0, cost: 0, stop: lay.stop };
  if (!lay.spots.length) { res.error = 'No room for signals here'; return res; }
  if (!g.company(owner).economy.canAfford(lay.cost)) { res.error = 'Not enough money'; return res; }
  const net = g.world.net;
  // spots on edges split by earlier spots: follow the splits
  const remap = new Map<number, { e1: number; e2: number; s: number }>();
  const onSplit = (old: NEdge, e1: NEdge, e2: NEdge, s: number) => { remap.set(old.id, { e1: e1.id, e2: e2.id, s }); };
  net.onSplit.push(onSplit);
  try {
    for (const sp of lay.spots) {
      let id = sp.edge, s = sp.s;
      for (let guard = 0; guard < 64; guard++) { const r = remap.get(id); if (!r) break; if (s < r.s) id = r.e1; else { id = r.e2; s -= r.s; } }
      const e = net.edges.get(id);
      if (!e) continue;
      const before = g.company(owner).economy.money;
      const n0 = sp.node >= 0 ? net.nodes.get(sp.node) : undefined;
      const so: SignalOpts = { signalKind: o.signalKind ?? n0?.signalKind ?? 'path', pass: o.pass ?? !!n0?.signalPass };
      const err = setSignal(g, id, Math.max(0, Math.min(e.len, s)), o.kind ?? 'oneway', sp.forward, owner, so);
      if (err) { res.error = err; if (err === 'Not enough money') break; continue; }
      res.placed++;
      res.cost += Math.max(0, before - g.company(owner).economy.money);
    }
  } finally {
    net.onSplit = net.onSplit.filter((f) => f !== onSplit);
  }
  return res;
}

/** Remove the signals along a stretch of own track (as walked by signalsAlong, every node passed). */
export function clearSignalsAlong(g: Game, edgeId: number, dir: number, owner: number, maxLength = Infinity, o: SignalRunOpts = {}): { removed: number } {
  const net = g.world.net;
  let e = net.edges.get(edgeId);
  let removed = 0;
  if (!e || e.kind !== 'rail' || e.owner !== owner) return { removed };
  let d = dir > 0 ? 1 : -1;
  const s0 = Math.max(0, Math.min(e.len, o.s0 ?? (d > 0 ? 0 : e.len)));
  let travelled = -(d > 0 ? s0 : e.len - s0);
  const visited = new Set<number>();
  for (let guard = 0; guard < 5000; guard++) {
    visited.add(e.id);
    travelled += e.len;
    if (travelled > maxLength + 1e-6) break;
    const node = net.nodes.get(d > 0 ? e.b : e.a)!;
    if (node.signal && node.edges.length === 2) { node.signal = 0; removed++; g.world.markObjArea(node.x - 2, node.z - 2, node.x + 2, node.z + 2); }
    const conts = net.nextRail(e, d);
    if (conts.length !== 1 || node.edges.length > 2) break;
    const c = conts[0];
    if (c.edge.owner !== owner || c.edge.station >= 0 || c.edge.depot >= 0 || visited.has(c.edge.id)) break;
    e = c.edge; d = c.dir;
  }
  if (removed) { net.version++; g.onNetworkChanged(); }
  return { removed };
}

// ------------------------------------------------------------------ automatic signalling
//
// Rules (with this game's path reservation: a train reserves its whole path up to the next signal facing it):
// - directional double track (track already one-way): one-way block signals every `spacing`, and a path signal
//   shortly before a junction / station entry at its end;
// - every platform and through track end: a starter signal facing the departure, passable from behind (so
//   arriving trains are never stopped at the platform edge);
// - passing loops on single track: an exit signal at both ends of each loop track, facing out of the loop and
//   passable from behind, so trains wait inside the loop for the single section ahead and the next loop;
// - depots: an exit signal facing out of the depot;
// - no signals inside single-track sections or in front of their junctions / station throats: a train must take
//   a single section and a free track at its far end in one reservation, else opposing trains deadlock;
// - never one-way-blocking signals on two-way track (all new non-block signals are passable from behind), so no
//   line loses a route; idempotent: signals already in place (within 2 units) are kept or turned to the rule.

/** A planned (or kept) signal of the automatic signalling. */
export interface AutoSignal {
  x: number; z: number;
  /** where: edge and arc length (an end node when s is 0 or the edge length) */
  edge: number; s: number;
  /** existing node there (-1: the edge is split) */
  node: number;
  /** for trains travelling in the edge's +s direction */
  forward: boolean;
  kind: 'block' | 'path';
  pass: boolean;
  role: 'block' | 'approach' | 'starter' | 'loop' | 'depot';
  action: 'add' | 'change' | 'keep';
}

export interface AutoSignalResult {
  signals: AutoSignal[];
  /** price of the new signals */
  cost: number;
  warnings: string[];
  placed: number; changed: number;
}

export interface AutoSignalOpts {
  /** block signal spacing on directional double track (default SIGNAL_SPACING) */
  spacing?: number;
  /** plan only (nothing changes) */
  preview?: boolean;
}

/** Track a line uses: the best route between consecutive stops (from every platform, both ways) and the stops' station tracks. */
function lineTrack(g: Game, lineId: number): Set<number> {
  const net = g.world.net;
  const E = new Set<number>();
  const l = g.lines.get(lineId);
  if (!l || l.kind !== 'rail') return E;
  const stops = l.stops.map((id) => g.stations.get(id)).filter((st): st is NonNullable<typeof st> => !!st && !!st.rail);
  for (const st of stops) for (const id of [...st.rail!.edges, ...st.rail!.throughEdges]) E.add(id);
  for (let i = 0; i < stops.length && stops.length > 1; i++) {
    const a = stops[i], b = stops[(i + 1) % stops.length];
    if (a === b) continue;
    let best: RouteResult | null = null;
    for (const pid of a.rail!.edges) {
      const pe = net.edges.get(pid);
      if (!pe) continue;
      for (const d of [1, -1]) {
        const r = findRailRoute(g, railNext(g, pe, d, l.owner), b.id, l.owner, -1, 40000);
        if (r && (!best || r.cost < best.cost)) best = r;
      }
    }
    for (const c of best?.conts ?? []) E.add(c.edge.id);
  }
  // alternatives between nodes of the routes: passing loops, second tracks, crossovers, throat tracks and turnout
  // ladders (through further switches), up to 400 units
  const routeNodes = new Set<number>();
  for (const id of E) { const e = net.edges.get(id); if (e) { routeNodes.add(e.a); routeNodes.add(e.b); } }
  for (const nid of [...routeNodes]) {
    const n = net.nodes.get(nid);
    if (!n || n.edges.length < 3) continue;
    for (const eid of n.edges) {
      if (E.has(eid)) continue;
      const stack: { edge: number; from: number; len: number; path: number[] }[] = [{ edge: eid, from: nid, len: 0, path: [] }];
      for (let guard = 0; stack.length && guard < 300; guard++) {
        const c = stack.pop()!;
        const e = net.edges.get(c.edge);
        if (!e || e.kind !== 'rail' || e.depot >= 0 || c.path.includes(e.id)) continue;
        const path = [...c.path, e.id], len = c.len + e.len;
        const at = e.a === c.from ? e.b : e.a;
        if (routeNodes.has(at)) { for (const id of path) E.add(id); continue; }
        const m = net.nodes.get(at);
        if (!m || len > 400) continue;
        for (const x of m.edges) if (x !== e.id && !E.has(x)) stack.push({ edge: x, from: at, len, path });
      }
    }
  }
  return E;
}

interface Chain { steps: { edge: NEdge; dir: number }[]; cum: number[]; len: number; start: number; end: number }

/** Maximal runs of plain track (no station / depot track) through two-edge nodes within E. */
function chainsOf(g: Game, E: Set<number>, special: (e: NEdge) => boolean): Chain[] {
  const net = g.world.net;
  const seen = new Set<number>();
  const out: Chain[] = [];
  const ext = (e: NEdge, d: number): { edge: NEdge; dir: number }[] => {
    const r: { edge: NEdge; dir: number }[] = [];
    let cur = e, cd = d;
    for (let guard = 0; guard < 5000; guard++) {
      const nid = cd > 0 ? cur.b : cur.a;
      const n = net.nodes.get(nid);
      if (!n || n.edges.length !== 2) break;
      const o = net.edges.get(n.edges[0] === cur.id ? n.edges[1] : n.edges[0]);
      if (!o || !E.has(o.id) || special(o) || seen.has(o.id)) break;
      seen.add(o.id);
      const od = o.a === nid ? 1 : -1;
      r.push({ edge: o, dir: od });
      cur = o; cd = od;
    }
    return r;
  };
  for (const id of [...E].sort((a, b) => a - b)) {
    const e = net.edges.get(id);
    if (!e || e.kind !== 'rail' || special(e) || seen.has(id)) continue;
    seen.add(id);
    const back = ext(e, -1), fwd = ext(e, 1);
    const steps = [...back.reverse().map((x) => ({ edge: x.edge, dir: -x.dir })), { edge: e, dir: 1 }, ...fwd];
    const cum = [0];
    for (const st of steps) cum.push(cum[cum.length - 1] + st.edge.len);
    const first = steps[0], last = steps[steps.length - 1];
    out.push({ steps, cum, len: cum[cum.length - 1], start: first.dir > 0 ? first.edge.a : first.edge.b, end: last.dir > 0 ? last.edge.b : last.edge.a });
  }
  return out;
}

/** Edge, arc length and travel flag at chain distance u, travelling along the chain (dir +1) or against it. */
function chainAt(c: Chain, u: number, dir: number): { edge: NEdge; s: number; forward: boolean } {
  let i = 0;
  while (i < c.steps.length - 1 && c.cum[i + 1] <= u) i++;
  const st = c.steps[i], d = Math.max(0, Math.min(st.edge.len, u - c.cum[i]));
  return { edge: st.edge, s: st.dir > 0 ? d : st.edge.len - d, forward: st.dir * dir > 0 };
}

/** Plan the signals for a set of track (see the rules above). */
function planAutoSignals(g: Game, E: Set<number>, owner: number, spacing: number): AutoSignalResult {
  const net = g.world.net;
  const res: AutoSignalResult = { signals: [], cost: 0, warnings: [], placed: 0, changed: 0 };
  const through = new Set<number>();
  const stations = new Set<number>();
  for (const id of E) { const e = net.edges.get(id); if (e && e.station >= 0) stations.add(e.station); }
  for (const st of g.stations.all()) if (st.rail) for (const id of st.rail.throughEdges) { through.add(id); if (E.has(id)) stations.add(st.id); }
  const special = (e: NEdge) => e.station >= 0 || e.depot >= 0 || through.has(e.id);
  const deg = (nid: number) => net.nodes.get(nid)?.edges.length ?? 0;
  const p = { x: 0, y: 0, z: 0 };
  const want = (edge: NEdge, s: number, forward: boolean, kind: 'block' | 'path', pass: boolean, role: AutoSignal['role']) => {
    if (edge.owner !== owner) { res.warnings.push(`Track of ${g.company(edge.owner).name} near ${Math.round(edge.bez.x0)},${Math.round(edge.bez.z0)} is left as it is`); return; }
    const atEnd = s < 0.6 || s > edge.len - 0.6;
    let node = atEnd ? (s < 0.6 ? edge.a : edge.b) : -1;
    if (node >= 0) s = node === edge.a ? 0 : edge.len;
    net.pointAt(edge, s, p);
    // an existing signal close by (2 units along the track) is reused
    if (node < 0) for (const nid of [edge.a, edge.b]) {
      const n = net.nodes.get(nid)!;
      if (n.signal && n.edges.length === 2 && Math.hypot(n.x - p.x, n.z - p.z) < 2) { node = nid; s = nid === edge.a ? 0 : edge.len; net.pointAt(edge, s, p); break; }
    }
    if (node >= 0 && deg(node) !== 2) return;
    if (res.signals.some((q) => (node >= 0 && q.node === node) || (q.edge === edge.id && Math.abs(q.s - s) < 0.5))) return;
    const n = node >= 0 ? net.nodes.get(node)! : null;
    let action: AutoSignal['action'] = 'add';
    if (n && n.signal) {
      // compare with what the rule wants (direction, kind, passable)
      const dirOk = n.signal >= 2 && net.signalFor(n, leaveSide(edge, forward ? 1 : -1, node)) > 0;
      action = dirOk && (n.signalKind ?? 'path') === kind && !!n.signalPass === pass ? 'keep' : 'change';
    }
    res.signals.push({ x: p.x, z: p.z, edge: edge.id, s, node, forward, kind, pass, role, action });
  };
  // ---- station starters (platform and through tracks), facing the departure, passable from behind; a track
  // made directional (a one-way signal at an end that trains may not pass from behind) keeps its signals
  const oneWay = (nid: number) => { const n = net.nodes.get(nid); return !!n && n.signal >= 2 && !n.signalPass; };
  for (const sid of [...stations].sort((a, b) => a - b)) {
    const st = g.stations.get(sid);
    if (!st || !st.rail) continue;
    for (const t of g.stations.trackEnds(st, true)) for (const nid of [t.front, t.back]) {
      const n = net.nodes.get(nid);
      if (!n || n.edges.length !== 2 || oneWay(t.front) || oneWay(t.back)) continue;
      const own = n.edges.map((id) => net.edges.get(id)!).find((e) => e.station === st.id || through.has(e.id));
      const other = n.edges.map((id) => net.edges.get(id)!).find((e) => e !== own);
      if (!own || !other || !E.has(other.id) || other.depot >= 0) continue;
      want(own, nid === own.b ? own.len : 0, nid === own.b, 'path', true, 'starter');
    }
  }
  // ---- depot exits
  for (const dp of g.depots.all()) {
    if (dp.kind !== 'rail' || dp.owner !== owner) continue;
    const stub = net.edges.get(dp.edge), n = net.nodes.get(dp.node);
    if (!stub || !n || n.edges.length !== 2 || oneWay(n.id) || !n.edges.some((id) => E.has(id) && id !== stub.id)) continue;
    const other = net.edges.get(n.edges[0] === stub.id ? n.edges[1] : n.edges[0])!;
    if (other.station >= 0) continue;
    want(stub, n.id === stub.b ? stub.len : 0, n.id === stub.b, 'path', true, 'depot');
  }
  // ---- plain track
  const chains = chainsOf(g, E, special);
  const pairKey = (c: Chain) => Math.min(c.start, c.end) + ':' + Math.max(c.start, c.end);
  const twins = new Map<string, number>();
  for (const c of chains) twins.set(pairKey(c), (twins.get(pairKey(c)) ?? 0) + 1);
  for (const c of chains) {
    // direction of existing one-way (non-passable) signals inside the chain and at its ends (e.g. the starters of
    // a directional line's stations)
    let fw = 0, bw = 0;
    for (let i = 0; i + 1 < c.steps.length; i++) {
      const st = c.steps[i], nid = st.dir > 0 ? st.edge.b : st.edge.a, n = net.nodes.get(nid)!;
      if (n.signal < 2 || n.signalPass) continue;
      if (signalAllows(g, st.edge, st.dir, nid)) fw++; else bw++;
    }
    {
      const s0 = c.steps[0], s1 = c.steps[c.steps.length - 1];
      const n0 = net.nodes.get(c.start), n1 = net.nodes.get(c.end);
      if (n0 && n0.signal >= 2 && !n0.signalPass && n0.edges.length === 2) { if (net.signalFor(n0, leaveSide(s0.edge, s0.dir, c.start)) > 0) fw++; else bw++; }
      if (n1 && n1.signal >= 2 && !n1.signalPass && n1.edges.length === 2 && c.end !== c.start) { if (signalAllows(g, s1.edge, s1.dir, c.end)) fw++; else bw++; }
    }
    if (fw && bw) { res.warnings.push('Track with one-way signals facing both ways left as it is'); continue; }
    if (fw || bw) {
      // directional: block signals every `spacing`, a path signal before a junction / station at its end
      const D = fw ? 1 : -1;
      const at = (u: number) => (D > 0 ? u : c.len - u);  // distance from the chain start in travel direction
      const endNode = D > 0 ? c.end : c.start;
      const junction = deg(endNode) > 2 || net.nodes.get(endNode)!.edges.some((id) => special(net.edges.get(id)!));
      if (junction && c.len > 6) {
        const q = chainAt(c, at(c.len - 2.5), D);
        want(q.edge, q.s, q.forward, 'path', false, 'approach');
      }
      // the existing signals of the line become block signals; gaps longer than the spacing are filled
      const have: number[] = [0];
      for (let i = 0; i + 1 < c.steps.length; i++) {
        const st = c.steps[i], nid = st.dir > 0 ? st.edge.b : st.edge.a, n = net.nodes.get(nid)!;
        if (!n.signal) continue;
        const u = at(c.cum[i + 1]);
        have.push(u);
        if (!(junction && Math.abs(u - (c.len - 2.5)) < 2)) want(st.edge, st.dir > 0 ? st.edge.len : 0, st.dir * D > 0, 'block', false, 'block');
      }
      have.push(junction ? c.len - 2.5 : c.len - 2);
      have.sort((a, b) => a - b);
      for (let k = 0; k + 1 < have.length; k++) {
        const a = have[k], b = have[k + 1];
        if (b - a <= spacing * 1.25) continue;
        const n = Math.round((b - a) / spacing);
        for (let j = 1; j < n; j++) {
          const u = a + ((b - a) * j) / n;
          if (u < 2 || u > c.len - 2) continue;
          const q = chainAt(c, at(u), D);
          want(q.edge, q.s, q.forward, 'block', false, 'block');
        }
      }
      continue;
    }
    // two-way plain track: exit signals at both ends of passing-loop tracks
    if ((twins.get(pairKey(c)) ?? 0) >= 2 && c.start !== c.end && deg(c.start) > 2 && deg(c.end) > 2 && c.len >= 6) {
      const q0 = chainAt(c, 1.8, -1), q1 = chainAt(c, c.len - 1.8, 1);
      want(q0.edge, q0.s, q0.forward, 'path', true, 'loop');
      want(q1.edge, q1.s, q1.forward, 'path', true, 'loop');
    }
  }
  for (const q of res.signals) {
    if (q.action === 'add') { res.cost += SIGNAL_COST; res.placed++; }
    else if (q.action === 'change') res.changed++;
  }
  res.warnings = [...new Set(res.warnings)];
  return res;
}

/** Place the planned signals (edges split by earlier ones are followed). */
function applyAutoSignals(g: Game, plan: AutoSignalResult, owner: number): AutoSignalResult {
  const net = g.world.net;
  if (!g.company(owner).economy.canAfford(plan.cost)) return { ...plan, warnings: [...plan.warnings, 'Not enough money'], placed: 0, changed: 0 };
  const remap = new Map<number, { e1: number; e2: number; s: number }>();
  const onSplit = (old: NEdge, e1: NEdge, e2: NEdge, s: number) => { remap.set(old.id, { e1: e1.id, e2: e2.id, s }); };
  net.onSplit.push(onSplit);
  let placed = 0, changed = 0;
  const warnings = [...plan.warnings];
  try {
    for (const q of plan.signals) {
      if (q.action === 'keep') continue;
      let id = q.edge, s = q.s;
      if (q.node >= 0) {
        // at a node: the edge there that the signal was planned on (or its piece)
        const n = net.nodes.get(q.node);
        const e0 = n?.edges.map((x) => net.edges.get(x)!).find((e) => e.id === q.edge || (remap.has(q.edge) && (e.id === remap.get(q.edge)!.e1 || e.id === remap.get(q.edge)!.e2)));
        if (!n || !e0) { warnings.push('A planned signal spot changed'); continue; }
        id = e0.id; s = e0.a === q.node ? 0 : e0.len;
      } else for (let guard = 0; guard < 64; guard++) { const r = remap.get(id); if (!r) break; if (s < r.s) id = r.e1; else { id = r.e2; s -= r.s; } }
      const err = setSignal(g, id, s, 'oneway', q.forward, owner, { signalKind: q.kind, pass: q.pass });
      if (err) { warnings.push(err); continue; }
      if (q.action === 'add') placed++; else changed++;
    }
  } finally {
    net.onSplit = net.onSplit.filter((f) => f !== onSplit);
  }
  return { ...plan, placed, changed, warnings: [...new Set(warnings)] };
}

/**
 * Signal a line (its id) or a set of track (edge ids) by the rules above. With `preview` nothing changes: the
 * result lists every signal the rules want (added, changed or kept) and what the new ones cost.
 */
export function autoSignalLine(g: Game, line: number | number[], owner: number, opts: AutoSignalOpts = {}): AutoSignalResult {
  const E = Array.isArray(line) ? new Set(line) : lineTrack(g, line);
  const plan = planAutoSignals(g, E, owner, Math.max(10, opts.spacing ?? SIGNAL_SPACING));
  return opts.preview ? plan : applyAutoSignals(g, plan, owner);
}

/** Signal all of a company's railway (its track, stations and depots) by the same rules. */
export function autoSignalNetwork(g: Game, owner: number, opts: AutoSignalOpts = {}): AutoSignalResult {
  const E = new Set<number>();
  for (const e of g.world.net.edges.values()) if (e.kind === 'rail' && e.owner === owner) E.add(e.id);
  const plan = planAutoSignals(g, E, owner, Math.max(10, opts.spacing ?? SIGNAL_SPACING));
  return opts.preview ? plan : applyAutoSignals(g, plan, owner);
}
