// Signals: set, change or remove the signal at a point of a track, and lay out one-way block signals along a
// stretch of track at a regular spacing (stopping at switches, stations, depots and other companies' track).
// Signals sit on rail nodes joining exactly two tracks (node.signal: 0 none, 1 two-way, 2 / 3 one-way for trains
// leaving the node on side +1 / -1); a signal between nodes splits the edge there. See also toggleSignal (build-ops).
import type { Game } from './game';
import type { NEdge, NNode } from './network';

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
export function setSignal(g: Game, edgeId: number, s: number, kind: SignalKind, forward: boolean, owner: number): string | null {
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
    return applySignal(g, node, value, owner);
  }
  const value = kind === 'none' ? 0 : kind === 'twoway' ? 1 : leaveSide(e, dir, node.id) > 0 ? 2 : 3;
  return applySignal(g, node, value, owner);
}

function applySignal(g: Game, node: NNode, value: number, owner: number): string | null {
  const net = g.world.net;
  if (node.signal === value) return null;
  if (value && !node.signal && !g.company(owner).economy.spend(SIGNAL_COST, 'construction')) return 'Not enough money';
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
      const err = setSignal(g, id, Math.max(0, Math.min(e.len, s)), o.kind ?? 'oneway', sp.forward, owner);
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
