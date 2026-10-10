// AI rail depots beside the line: on a short side siding branching off the running track, between stations or off a
// station's throat on its line side, never on the way on beyond a terminus (onward.ts) nor as the stub that ends a
// line. A siding off track on the ground is short and level (routing.ts buildDepotOnLine); off a viaduct it ramps down
// to a depot on the ground beside the line; off a tunnel it stays underground and ends in a cavern beside the line.
// Trains leave the depot onto the running track in its direction of travel (directional double track: the running
// direction its one-way signals allow). Also: moving a depot that stands beyond a terminus out to such a siding.
import type { Game } from './game';
import type { NEdge } from './network';
import type { Station, StationPlan } from './stations';
import type { Train } from './train';
import { planEdge, commitProposal, findSnap, type BuildOptions, type Proposal } from './construction';
import { depotSize, UNDERGROUND_DEPOT } from './build-ops';
import { trackBasePerUnit } from './opcosts';
import { RAIL } from './constants';
import { rectsOverlap } from './towns';
import { buildDepotOnLine, planDepotOnLine, depotAtEnd, depotFits, nodeSnap, removeEdges, sidingType } from './routing';
import { recomputeLocks } from './terraform';
import { endTangent, arcTable, tAtS, bezPoint } from './geom';
import { profAt } from './network';
import { distToRect } from './world';
import { subwayOpts } from './subway';
import { findRailRoute, depotServes } from './train';
import { onwardEnds, inOnward, rectPoints, ONWARD_PAD, type OnwardEnd, type P2 } from './onward';

/** What a siding may cost on top of the depot's site checks (AI callers pass their consent and money rules). */
export interface SideDepotOpts {
  /** direction along the edge (+1: towards its end b) in which trains leave the depot onto it; both when absent */
  dir?: 1 | -1;
  /** side of the edge the depot stands on (+1: left of its +s direction); both when absent */
  side?: 1 | -1;
  /** points a future second track will take (the depot keeps clear of them) */
  reserved?: readonly P2[];
  /** ways on beyond prospective termini (not yet built) that stay free as well */
  ends?: readonly OnwardEnd[];
  /** the siding's track type (default: the edge's siding type) */
  type?: string;
  /** a proposal the caller accepts (track access, demolition) */
  consent?: (p: Proposal) => boolean;
  /** residents a building the depot stands on may have (two at most; default 30: houses, not blocks of flats) */
  maxPop?: number;
}

/** Siding shapes (units along the line from the junction, units aside at the depot's exit): level, ramp, cavern. */
const GROUND_SHAPES = [[18, 2.2], [18, 1.7], [11, 2.2], [18, 3.2], [22, 4]];
const RAMP_SHAPES = [[24, 6], [24, 10], [26, 12], [22, 18], [30, 9], [28, 14], [26, 24], [36, 14], [32, 24], [26, 36], [44, 9],
  // (turning away across the line's flank where its stations stand close: between the close stops of a light rail)
  [6, 18], [8, 24], [10, 30], [12, 26]];
const CAVERN_SHAPES = [[10, 3], [12, 4], [14, 5], [18, 4], [22, 6]];

const sidingOpts = (e: NEdge, owner: number, type?: string): BuildOptions =>
  ({ kind: 'rail', type: type ?? sidingType(e.type), tracks: 1, heightOffset: 0, crossing: 'auto', owner });

/** Points every unit along a planned proposal's tracks. */
function proposalPoints(p: Proposal): P2[] {
  const out: P2[] = [];
  for (const t of p.tracks) {
    const tab = arcTable(t.bez);
    for (let s = 0; s <= t.len; s += 1) out.push(bezPoint(t.bez, tAtS(tab, Math.min(s, t.len))));
  }
  return out;
}

/** Points (with heights) every half unit along a planned proposal's tracks. */
function proposalSamples(p: Proposal): { x: number; y: number; z: number }[] {
  const out: { x: number; y: number; z: number }[] = [];
  for (const t of p.tracks) {
    const tab = arcTable(t.bez);
    for (let s = 0; s <= t.len + 0.25; s += 0.5) { const a = Math.min(s, t.len), q = bezPoint(t.bez, tAtS(tab, a)); out.push({ x: q.x, y: profAt(t.prof, t.len, a), z: q.z }); }
  }
  return out;
}

/**
 * Is a point of new track clear of planned stations (their platforms and tracks at their height, buildings, piers,
 * street-level entrances: as construction keeps track `hw` + 0.2 off a built station's structures, with a margin)?
 */
function clearOfPlannedStations(g: Game, q: { x: number; y: number; z: number }, plans: readonly PlannedStop[]): boolean {
  for (const p of plans) {
    const dx = q.x - p.x, dz = q.z - p.z, ax = Math.sin(p.angle), az = Math.cos(p.angle);
    if (Math.abs(q.y - p.y) < RAIL.clearance + 0.3 && Math.abs(dx * ax + dz * az) < p.length / 2 + 0.3 && Math.abs(dx * az - dz * ax) < p.layout.width / 2 + 0.6) return false;
    // (an underground station's box, at its depth)
    const f = p.footprint;
    if (p.level === 'underground' && Math.abs(q.y - p.y) < RAIL.clearance + 1.2 && distToRect(q.x, q.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 0.8) return false;
    const ground = g.world.heightAt(p.x, p.z), b = p.building;
    if (b.w > 0 && b.d > 0 && q.y > ground - 0.4 && q.y < ground + 2.6 && distToRect(q.x, q.z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.8) return false;
    for (const pier of p.piers) if (Math.hypot(q.x - pier.x, q.z - pier.z) < 0.9 && q.y < p.y + 0.3) return false;
    if (p.level !== 'underground') for (const e of p.entrances) if (Math.hypot(q.x - e.x, q.z - e.z) < 1.3 && q.y < g.world.heightAt(e.x, e.z) + 2.6) return false;
  }
  return true;
}

/** Are the siding's points and the depot's footprint clear of every way on (and of a future second track)? */
function sideClear(g: Game, pts: P2[], depot: { x: number; z: number; angle: number }, opts: SideDepotOpts, skip = 0): boolean {
  const sz = depotSize('rail');
  const ends = [...onwardEnds(g, depot.x, depot.z, 40), ...(opts.ends ?? [])];
  const foot = rectPoints(depot.x, depot.z, depot.angle, sz.w, sz.d);
  if (ends.length && [...pts.slice(skip), ...foot].some((q) => inOnward(q, ends))) return false;
  if (opts.reserved?.some((q) => distToRect(q.x, q.z, depot.x, depot.z, depot.angle, sz.w / 2, sz.d / 2) <= 1.17)) return false;
  return true;
}

/** A siding planned beside the line (planSideDepot): its price, track length and base upkeep (the depot's too). */
export interface SideQuote { edge: number; s: number; dir: 1 | -1; side: 1 | -1; cost: number; length: number; upkeep: number; under: boolean }

/** Native base upkeep of planned track (its structures too). */
function trackUpkeep(p: Proposal): number {
  return p.tracks.reduce((sum, q) => sum + trackBasePerUnit(p.opts.type) * (q.len
    + q.sections.reduce((a, sec) => a + (sec.s1 - sec.s0) * (sec.type === 'tunnel' ? 4 : 3), 0)), 0);
}

/**
 * A ramp off a viaduct (down to a depot on the ground beside the line) or a stub off a tunnel (a cavern beside the line)
 * planned off edge `e` at `s`: trains leave in direction `dir` along the edge, the depot on side `side`. Pure; null
 * where nothing fits.
 */
function planStructureDepot(g: Game, e: NEdge, s: number, owner: number, dir: 1 | -1, side: 1 | -1, opts: SideDepotOpts):
  { pr: Proposal; x: number; z: number; cost: number } | null {
  const net = g.world.net, under = net.sectionAt(e, s) === 'tunnel';
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  net.pointAt(e, s, p, d);
  const l = Math.hypot(d.x, d.z) || 1, tx = d.x / l, tz = d.z / l;
  // the depot lies behind the junction (trains leave it towards `dir`), to `side`
  const bx = -tx * dir, bz = -tz * dir, nx = -tz * side, nz = tx * side;
  const y0 = net.heightAtS(e, s), depth = Math.max(1.2, g.world.heightAt(p.x, p.z) - y0);
  const base = sidingOpts(e, owner, opts.type);
  const o: BuildOptions = under ? { ...subwayOpts(base.type, 1, owner, depth) } : base;
  // (a ramp needs its length to come down; a cavern stub only to clear the running tunnels)
  const shape = under ? CAVERN_SHAPES : RAMP_SHAPES;
  const start = findSnap(g, 'rail', p.x, p.z, 0.3);
  if (start.kind !== 'edge' || start.edge !== e.id) return null;
  for (const [along, lat] of shape) {
    const x = p.x + bx * along + nx * lat, z = p.z + bz * along + nz * lat;
    if (!g.world.inside(x, z, 8)) continue;
    const pr = planEdge(g, start, { kind: 'free', x, z, y: under ? 0 : g.world.heightAt(x, z) }, o);
    if (!pr.ok || pr.tracks.length !== 1 || (opts.consent && !opts.consent(pr))) continue;
    const t = pr.tracks[0], tan = endTangent(t.bez), y = t.prof[t.prof.length - 1];
    // the siding turns away from the line to `side` (never across it)
    const mid = bezPoint(t.bez, 0.5);
    if ((mid.x - p.x) * nx + (mid.z - p.z) * nz < 0.3) continue;
    const dx = x + tan.x * 2.15, dz = z + tan.z * 2.15, angle = Math.atan2(-tan.x, -tan.z);
    if (!sideClear(g, proposalPoints(pr), { x: dx, z: dz, angle }, opts, 6)) continue;
    let depot = 0;
    if (under) {
      const dp = g.depots.plan('rail', dx, dz, angle, owner, { level: 'underground', y, snap: false });
      if (!dp.ok) continue;
      depot = dp.cost;
    } else {
      if (!depotFits(g, x, z, -tan.x, -tan.z, owner, opts.maxPop ?? 30, y, 2.6)) continue;
      const dp = g.depots.plan('rail', dx, dz, angle, owner, { snap: false, y });
      if (!dp.ok) continue;
      depot = dp.cost;
    }
    return { pr, x, z, cost: pr.cost + depot };
  }
  return null;
}

/** Build a planned ramp or cavern depot (planStructureDepot): the depot id, or -1 with nothing left behind. */
function structureDepot(g: Game, e: NEdge, s: number, owner: number, dir: 1 | -1, side: 1 | -1, opts: SideDepotOpts): number {
  const net = g.world.net, plan = planStructureDepot(g, e, s, owner, dir, side, opts);
  if (!plan || !g.company(owner).economy.canAfford(plan.cost) || commitProposal(g, plan.pr)) return -1;
  const end = net.nearestNode(plan.x, plan.z, 0.1, 'rail', (q) => q.edges.length === 1);
  const id = end ? depotAtEnd(g, end.id, owner) : -1;
  if (id >= 0) return id;
  if (end) removeEdges(g, spurFrom(g, end.id, owner), owner);
  return -1;
}

/**
 * A depot on a side siding off rail edge `edgeId` at `s`, planned (planDepotOnLine off ground track, a ramp or a cavern
 * off a viaduct or tunnel), never on the way on beyond a terminus. Pure; the first that fits, or null.
 */
export function planSideDepot(g: Game, edgeId: number, s: number, owner: number, opts: SideDepotOpts = {}): SideQuote | null {
  const net = g.world.net, e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) return null;
  const sec = net.sectionAt(e, s);
  const dirs: (1 | -1)[] = opts.dir ? [opts.dir] : [1, -1], sides: (1 | -1)[] = opts.side ? [opts.side] : [1, -1];
  for (const dir of dirs) for (const side of sides) {
    if (sec === 'ground') {
      const q = planDepotOnLine(g, edgeId, s, owner, { dir, side: (side * -dir) as 1 | -1, reserved: opts.reserved }, opts.ends, opts.maxPop);
      if (q) return { edge: edgeId, s, dir, side, cost: q.cost, length: q.length, upkeep: trackUpkeep(q.p1) * q.length / Math.max(1, q.p1.stats.len) + 12000, under: false };
    } else {
      const q = planStructureDepot(g, e, s, owner, dir, side, opts);
      if (q) return { edge: edgeId, s, dir, side, cost: q.cost, length: q.pr.stats.len, upkeep: trackUpkeep(q.pr) + (sec === 'tunnel' ? UNDERGROUND_DEPOT.upkeep : 12000), under: sec === 'tunnel' };
    }
  }
  return null;
}

/**
 * Build a depot on a side siding off rail edge `edgeId` at arc length `s`: short and level off ground track
 * (buildDepotOnLine), a ramp down off a viaduct, a cavern off a tunnel. Never on the way on beyond a terminus. The
 * depot id, or -1 (nothing left behind).
 */
export function buildSideDepot(g: Game, edgeId: number, s: number, owner: number, opts: SideDepotOpts = {}): number {
  const net = g.world.net, e = net.edges.get(edgeId);
  if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) return -1;
  const sec = net.sectionAt(e, s);
  const dirs: (1 | -1)[] = opts.dir ? [opts.dir] : [1, -1], sides: (1 | -1)[] = opts.side ? [opts.side] : [1, -1];
  for (const dir of dirs) for (const side of sides) {
    let id = -1;
    if (sec === 'ground') {
      // buildDepotOnLine: trains leave towards entry.dir; its side is taken along the depot's direction (-dir)
      id = buildDepotOnLine(g, edgeId, s, owner, { dir, side: (side * -dir) as 1 | -1, reserved: opts.reserved }, opts.ends, opts.maxPop);
    } else id = structureDepot(g, e, s, owner, dir, side, opts);
    if (id >= 0) return id;
    if (!net.edges.has(edgeId)) return -1;
  }
  return -1;
}

/**
 * The direction (+1 / -1 along the edge) trains may run on it towards a station of `stations` (one-way signals of a
 * directional double track allow one), or 0 when both or neither.
 */
export function runningDir(g: Game, e: NEdge, owner: number, stations: readonly number[]): 0 | 1 | -1 {
  const ok = (dir: 1 | -1) => stations.some((sid) => !!findRailRoute(g, [{ edge: e, dir }], sid, owner, -1, 20000));
  const f = ok(1), b = ok(-1);
  return f === b ? 0 : f ? 1 : -1;
}

/** The lateral side (+1: left of +s) away from a parallel track beside edge `e` at `s` (0: single track). */
export function outerSide(g: Game, e: NEdge, s: number): 0 | 1 | -1 {
  const net = g.world.net, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  net.pointAt(e, s, p, d);
  const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
  const twin = net.nearestEdge(p.x + nx * 0.45, p.z + nz * 0.45, 0.3, 'rail', (q) => q.id !== e.id)
    ? 1 : net.nearestEdge(p.x - nx * 0.45, p.z - nz * 0.45, 0.3, 'rail', (q) => q.id !== e.id) ? -1 : 0;
  return twin === 0 ? 0 : (-twin as 1 | -1);
}

/** Candidate siding points on a line's plain track (own edges at least 8 long), nearest to (x, z) first, within `maxDist`. */
export function sidingSpots(g: Game, edges: Iterable<number>, x: number, z: number, owner: number, maxDist = Infinity, minDist = 0,
  sections: readonly ('ground' | 'bridge' | 'tunnel')[] = ['ground']): { id: number; s: number; d: number }[] {
  const net = g.world.net, p = { x: 0, y: 0, z: 0 }, out: { id: number; s: number; d: number }[] = [];
  for (const id of edges) {
    const e = net.edges.get(id);
    if (!e || e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || e.depot >= 0 || e.len < 8 || g.stations.throughStationOf(id) >= 0) continue;
    for (let s = 3; s <= e.len - 3; s += 5) {
      if (!sections.includes(net.sectionAt(e, s))) continue;
      net.pointAt(e, s, p);
      const dd = Math.hypot(p.x - x, p.z - z);
      if (dd <= maxDist && dd >= minDist) out.push({ id, s, d: dd });
    }
  }
  return out.sort((a, b) => a.d - b.d || a.id - b.id || a.s - b.s);
}

/**
 * A depot beside a directional (or single-track) line: on a siding off its plain track, trains leaving it in the
 * running direction of the track it joins, on that track's outer side. Level sidings off ground track first (the
 * cheapest, anywhere on the line), then ramps off viaducts and caverns off tunnels; each pass nearest to (x, z) first,
 * `tries` sites at most. Busy track (a train on it) is passed over. The depot id or -1.
 */
export function buildDepotBeside(g: Game, edges: Iterable<number>, x: number, z: number, owner: number, stations: readonly number[],
  o: BesideOpts = {}): number {
  const net = g.world.net, sections = o.sections ?? ['ground'];
  let list = [...edges];
  const passes = sections.includes('ground') && sections.length > 1 ? [['ground'], sections.filter((q) => q !== 'ground')] : [sections];
  for (const pass of passes) {
    const tried = new Set<string>();
    let tries = 0, spots = sidingSpots(g, list, x, z, owner, o.maxDist, o.minDist, pass as ('ground' | 'bridge' | 'tunnel')[]);
    for (let i = 0; i < spots.length && tries < (o.tries ?? 12); i++) {
      const c = spots[i], e = net.edges.get(c.id);
      if (!e || g.vehicles.isEdgeBusy(c.id)) continue;
      const at = { x: 0, y: 0, z: 0 };
      net.pointAt(e, c.s, at);
      tried.add(`${Math.round(at.x * 4)},${Math.round(at.z * 4)}`);
      const dir = runningDir(g, e, owner, stations), side = outerSide(g, e, c.s), e0 = net.nextEdge;
      const id = buildSideDepot(g, c.id, c.s, owner, { dir: dir || undefined, side: side || undefined, consent: o.consent, type: o.type, maxPop: o.maxPop });
      if (id >= 0) {
        const dp = g.depots.get(id)!;
        // (trains leave a siding one way: they serve the line from whichever of its stations they reach first)
        if (stations.length < 2 || stations.some((sid, k) => k + 1 < stations.length && depotServes(g, dp, sid, stations[k + 1]) >= 0)) return id;
        takeUpDepot(g, id, owner);
      }
      tries++;
      // (a turnout laid and taken up again splits the track: the spots on what is left, not those already tried)
      if (!net.edges.has(c.id)) {
        list = list.flatMap((id2) => (net.edges.has(id2) ? [id2] : [])).concat(newEdgesSince(g, e0, owner));
        spots = sidingSpots(g, list, x, z, owner, o.maxDist, o.minDist, pass as ('ground' | 'bridge' | 'tunnel')[]).filter((q) => {
          const pt = { x: 0, y: 0, z: 0 }; net.pointAt(net.edges.get(q.id)!, q.s, pt); return !tried.has(`${Math.round(pt.x * 4)},${Math.round(pt.z * 4)}`);
        });
        i = -1;
      }
    }
  }
  return -1;
}

/** Own plain rail edges with ids from `since` (the halves of an edge split by works taken up again). */
function newEdgesSince(g: Game, since: number, owner: number): number[] {
  const out: number[] = [];
  for (let id = since; id < g.world.net.nextEdge; id++) { const e = g.world.net.edges.get(id); if (e && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0) out.push(id); }
  return out;
}

/** Where buildDepotBeside / quoteDepotBeside search (see there). */
export interface BesideOpts {
  maxDist?: number; minDist?: number; tries?: number; sections?: readonly ('ground' | 'bridge' | 'tunnel')[];
  consent?: (p: Proposal) => boolean; type?: string; maxPop?: number;
}

/**
 * The price of the depot buildDepotBeside would build (the same spots and order, without the final service check):
 * pure, the first siding that fits, or null.
 */
export function quoteDepotBeside(g: Game, edges: Iterable<number>, x: number, z: number, owner: number, stations: readonly number[],
  o: BesideOpts = {}): SideQuote | null {
  const net = g.world.net, list = [...edges], sections = o.sections ?? ['ground'];
  const passes = sections.includes('ground') && sections.length > 1 ? [['ground'], sections.filter((q) => q !== 'ground')] : [sections];
  for (const pass of passes) {
    let tries = 0;
    for (const c of sidingSpots(g, list, x, z, owner, o.maxDist, o.minDist, pass as ('ground' | 'bridge' | 'tunnel')[])) {
      const e = net.edges.get(c.id);
      if (!e || g.vehicles.isEdgeBusy(c.id)) continue;
      const dir = runningDir(g, e, owner, stations), side = outerSide(g, e, c.s);
      const q = planSideDepot(g, c.id, c.s, owner, { dir: dir || undefined, side: side || undefined, consent: o.consent, type: o.type, maxPop: o.maxPop });
      if (q) return q;
      if (++tries >= (o.tries ?? 12)) break;
    }
  }
  return null;
}

/** Own plain track from a free end (or a depot's exit once the depot is gone) back to the first junction. */
function spurFrom(g: Game, nodeId: number, owner: number): number[] {
  const net = g.world.net, spur: number[] = [];
  let node = nodeId, prev = -1;
  for (let i = 0; i < 16; i++) {
    const n = net.nodes.get(node);
    const next = (n?.edges ?? []).filter((id) => id !== prev);
    if (!n || next.length !== 1) break;
    const e = net.edges.get(next[0]);
    if (!e || e.owner !== owner || e.station >= 0 || e.depot >= 0) break;
    spur.push(e.id); prev = e.id; node = e.a === node ? e.b : e.a;
    if ((net.nodes.get(node)?.edges.length ?? 0) !== 2) break;
  }
  return spur;
}

/** Take a depot of ours down again with its siding up to the junction (nothing else). */
export function takeUpDepot(g: Game, depotId: number, owner: number): void {
  const d = g.depots.get(depotId);
  if (!d || d.owner !== owner || g.depots.remove(depotId)) return;
  removeEdges(g, spurFrom(g, d.node, owner), owner);
}

/** Track locks around a place recomputed after track there was taken up. */
function recomputeArea(g: Game, x: number, z: number, r: number) { recomputeLocks(g.world, x - r, z - r, x + r, z + r); }

// ============================================================================ depots beyond a terminus, moved aside

/** A depot that stands on the way on beyond a terminus: own plain track from the platform ends to depots only. */
export interface EndDepot { station: number; end: 'front' | 'back'; lead: number[]; depots: number[] }

/**
 * Own depots beyond an end of a station's platforms: the end leads (over own plain track, no other station, at most 400
 * units) to depots of ours only (a depot lead or stub, a terminal yard, a tail's ramp). Null otherwise.
 */
export function endDepots(g: Game, st: Station, end: 'front' | 'back', owner: number): EndDepot | null {
  const net = g.world.net, r = st.rail;
  if (!r || r.throughEdges.length) return null;
  const heads = g.stations.trackEnds(st).map((t) => t[end]).filter((id) => net.nodes.has(id));
  const seen = new Set<number>(r.edges), nodes = new Set<number>(heads), stack = [...heads], lead: number[] = [], depots: number[] = [];
  let length = 0;
  while (stack.length) {
    const n = net.nodes.get(stack.pop()!);
    if (!n) return null;
    for (const id of n.edges) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || g.stations.throughStationOf(e.id) >= 0) return null;
      if (e.depot >= 0) {
        const dp = g.depots.get(e.depot);
        if (!dp || dp.owner !== owner) return null;
        if (!depots.includes(dp.id)) depots.push(dp.id);
        continue;
      }
      lead.push(e.id);
      length += e.len;
      if (length > 400) return null;
      const o = e.a === n.id ? e.b : e.a;
      if (!nodes.has(o)) { nodes.add(o); stack.push(o); }
    }
  }
  return depots.length ? { station: st.id, end, lead, depots } : null;
}

/** Is a vehicle on its way out of a depot (on its track, or entering the line from it)? */
export function depotBusy(g: Game, depotId: number): boolean {
  const d = g.depots.get(depotId);
  if (!d) return true;
  if (g.vehicles.isEdgeBusy(d.edge)) return true;
  for (const v of g.vehicles.map.values()) {
    const segs = (v as unknown as { segs?: { depot?: number; e: number }[] }).segs;
    if (segs && segs.some((s) => s.depot === d.id || s.e === d.edge)) return true;
  }
  return false;
}

/**
 * The vehicles at home in depot `from` move to depot `to` (those inside move with it, those out on the line return
 * there later; trackops relocateDepot's rule), the companies' lines buy at `to`, and `from` is taken down. 'busy' while
 * a vehicle is on its way out of `from`; null when done.
 */
export function moveDepotHome(g: Game, from: number, to: number): string | null {
  const old = g.depots.get(from), nd = g.depots.get(to);
  if (!old || !nd || old.kind !== nd.kind) return 'No such depot';
  if (depotBusy(g, from)) return 'busy';
  for (const v of g.vehicles.map.values()) {
    const vd = v as unknown as { depotId?: number };
    if (vd.depotId !== old.id) continue;
    vd.depotId = nd.id;
    v.homeX = nd.x; v.homeZ = nd.z;
  }
  for (const ai of g.ais) for (const info of (ai as unknown as { lines?: Map<number, { depot: number }> }).lines?.values() ?? []) if (info.depot === from) info.depot = to;
  const err = g.depots.remove(old.id);
  if (!err) g.company(old.owner).economy.spend(15000, 'construction', true);
  return err;
}

/**
 * Move the depots beyond a terminus out to a siding beside the line (`edges`: its plain track, `stations`: its stops in
 * order), the trains inside them with them (moveDepotHome), and take up the old lead: the terminus is a free end again.
 * Within one call: the new depot must serve every homed train's line first, else it is taken down again and the old
 * depots stay. 'busy' while a train is on the lead or leaving a depot there; the new depot's id, or why not.
 */
export function moveEndDepot(g: Game, ed: EndDepot, owner: number, edges: Iterable<number>, stations: readonly number[],
  consent?: (p: Proposal) => boolean): number | string {
  const net = g.world.net, st = g.stations.get(ed.station);
  if (!st?.rail) return 'station gone';
  if (ed.lead.some((id) => g.vehicles.isEdgeBusy(id)) || ed.depots.some((id) => depotBusy(g, id))) return 'busy';
  // near the terminus first, on the line side (the lead leads only to the depots and goes)
  const lead = new Set(ed.lead);
  const home = buildDepotBeside(g, [...edges].filter((id) => !lead.has(id)), st.x, st.z, owner, stations,
    { consent, sections: ['ground', 'bridge', 'tunnel'], tries: 16 });
  if (home < 0) return 'no siding';
  const dp = g.depots.get(home)!;
  // every train at home there must run its line from the new depot
  const homed = [...g.vehicles.map.values()].filter((v): v is Train => v.kind === 'train' && ed.depots.includes((v as Train).depotId));
  const serves = homed.every((v) => {
    const path = v.line ? [...new Set(v.line.stops)] : stations;
    return path.length < 2 || path.some((sid, i) => i + 1 < path.length && depotServes(g, { ...dp, owner: v.owner }, sid, path[i + 1], v.cars) >= 0);
  });
  if (!serves) { takeUpDepot(g, home, owner); return 'new depot cannot serve the line'; }
  for (const id of ed.depots) {
    const err = moveDepotHome(g, id, home);
    if (err) return 'old depot: ' + err;
  }
  let len = 0;
  for (const id of ed.lead) { const e = net.edges.get(id); if (e && !g.vehicles.isEdgeBusy(id)) { len += e.len; net.removeEdge(id); } }
  if (len) g.company(owner).economy.spend(len * 400, 'construction', true);
  recomputeArea(g, st.x, st.z, 120);
  g.onNetworkChanged();
  return home;
}

// ============================================================================ planned city lines

/** What the side-depot planner reads of a planned station (a StationPlan, or a built station as one: stopOfStation). */
export type PlannedStop = Pick<StationPlan, 'x' | 'z' | 'y' | 'angle' | 'length' | 'level' | 'depth' | 'footprint' | 'building' | 'entrances' | 'piers'>
  & { layout: Pick<StationPlan['layout'], 'trackOffsets' | 'width'>; access?: Proposal | null };

/** A built (straight) station as a planned stop: its platforms; its own structures are the world's (construction checks them). */
export function stopOfStation(st: Station): PlannedStop {
  const r = st.rail!;
  return { x: r.x, z: r.z, y: r.y, angle: r.angle, length: r.length, level: r.level ?? 'ground', depth: r.depth ?? 0,
    footprint: { x: r.x, z: r.z, angle: r.angle, w: r.width, d: r.length }, building: { x: r.x, z: r.z, angle: r.angle, w: 0, d: 0 },
    entrances: [], piers: [], layout: { trackOffsets: r.trackOffsets, width: r.width } };
}

/** A depot planned beside a city line not yet built (planProspectiveSideDepot): where its siding leaves the line, its price. */
export interface SideYard {
  /** the planned link (from station `index` to the next) the siding leaves, its track, the junction's distance from station `index` */
  index: number; track: number; d: number;
  /** +1: the depot lies on towards the next station (trains leave back towards station `index`); -1: back towards it */
  w: 1 | -1;
  /** the junction and the depot's exit */
  jx: number; jz: number; x: number; z: number;
  cost: number; length: number; under: boolean;
  /** native base upkeep of the siding (its structures too) and the depot */
  upkeep: number;
}

/** The way on beyond a planned terminus (its platforms' end facing away from `next`). */
export function plannedOnwardEnd(p: PlannedStop, next: P2): OnwardEnd {
  const ax = Math.sin(p.angle), az = Math.cos(p.angle), sg = ax * (p.x - next.x) + az * (p.z - next.z) >= 0 ? 1 : -1;
  return { station: -1, x: p.x + ax * sg * p.length / 2, z: p.z + az * sg * p.length / 2, ux: ax * sg, uz: az * sg, half: p.layout.width / 2 + ONWARD_PAD };
}

/** Distance from point q to segment ab. */
function segDist(q: P2, a: P2, b: P2): number {
  const vx = b.x - a.x, vz = b.z - a.z, L = vx * vx + vz * vz || 1;
  const t = Math.max(0, Math.min(1, ((q.x - a.x) * vx + (q.z - a.z) * vz) / L));
  return Math.hypot(q.x - a.x - vx * t, q.z - a.z - vz * t);
}

/** The planned tracks between consecutive planned stations: straight from platform end to platform end, per track. */
function plannedLinks(plans: readonly PlannedStop[]): [P2, P2][] {
  const out: [P2, P2][] = [];
  const end = (p: PlannedStop, to: P2, off: number): P2 => {
    const ax = Math.sin(p.angle), az = Math.cos(p.angle), sg = ax * (to.x - p.x) + az * (to.z - p.z) >= 0 ? 1 : -1;
    return { x: p.x + ax * sg * p.length / 2 + az * off, z: p.z + az * sg * p.length / 2 - ax * off };
  };
  for (let i = 0; i + 1 < plans.length; i++) {
    const a = plans[i], b = plans[i + 1];
    const oa = a.layout.trackOffsets, ob = b.layout.trackOffsets;
    for (let k = 0; k < Math.min(oa.length, ob.length); k++) out.push([end(a, b, oa[k]), end(b, a, ob[k])]);
  }
  return out;
}

/** How far out from a planned station a side yard's junction is planned (the link still straight along its axis). */
const NEAR_STATION = 30;

/**
 * Junction distances worth trying on planned link `i` (from station i's platform end towards station i + 1): clear of
 * the crossovers laid `throat` units before a terminus (`termini`: whether the first and the last planned stations
 * are the line's ends) and of the platform ends; the middle of a short link (built a little along where its switches
 * fall: buildPlannedSideDepot).
 */
export function sideYardDistances(plans: readonly PlannedStop[], i: number, throat: number, termini = { first: true, last: true }): number[] {
  const A = plans[i], B = plans[i + 1];
  if (!A || !B) return [];
  const link = Math.hypot(B.x - A.x, B.z - A.z) - (A.length + B.length) / 2;
  const lo = i === 0 && termini.first ? throat : 6, hi = link - (i + 2 === plans.length && termini.last ? throat : 6);
  const out: number[] = [];
  const add = (d: number) => { if (!out.some((q) => Math.abs(q - d) < 3)) out.push(Math.round(d * 10) / 10); };
  // (within reach of the station, where the planned track still runs along its axis: a long link may curve)
  if (hi >= lo) for (const d of [lo + 2, (lo + hi) / 2, hi - 2]) { if (d >= lo && d <= hi && d <= NEAR_STATION) add(d); }
  else if (link >= 10 && link / 2 <= NEAR_STATION) add(link / 2);
  return out;
}

/**
 * Which way (`w`, as planProspectiveSideDepot) a depot beside track `track` of planned link `index` lies so that trains
 * leave it in that track's running direction once the double track is directional (trackops finishDoubleTrack:
 * right-hand running, the track on the right of a direction of travel carrying it).
 */
export function runningSideOf(plans: readonly PlannedStop[], index: number, track: number): 1 | -1 {
  const T = plans[index], N = plans[index + 1], off = T?.layout.trackOffsets[track] ?? 0;
  if (!T || !N) return 1;
  const sg = Math.sin(T.angle) * (N.x - T.x) + Math.cos(T.angle) * (N.z - T.z) >= 0 ? 1 : -1;
  // (the station's offsets count to the right of its axis as (cos a, -sin a); trackops' right of travel u is (-uz, ux))
  return off * sg < 0 ? -1 : 1;
}

/**
 * A depot planned beside a city line whose stations are planned (none built): a siding off track `track` of the link
 * from station `index` to the next, `d` units out from its platforms, the depot on towards the next station (`w` 1) or
 * back (-1), on that track's outer side: short and level on the ground, a ramp down off a viaduct, a cavern off a
 * tunnel (`level`). Clear of the planned stations and tracks, of the ways on beyond both termini (`termini`: the ways on
 * that stay free, when not the planned line's ends) and of everything built (`ignore`: track and depots to plan as if
 * gone). Pure; null where nothing fits.
 */
export function planProspectiveSideDepot(g: Game, owner: number, plans: readonly PlannedStop[], index: number, track: number, d: number, w: 1 | -1,
  level: 'ground' | 'elevated' | 'underground', type: string, consent?: (p: Proposal) => boolean, ignore?: BuildOptions['ignore'],
  termini?: readonly OnwardEnd[], maxPop = 30): SideYard | null {
  const net = g.world.net, T = plans[index], N = plans[index + 1];
  if (!T || !N || plans.length < 2) return null;
  const ax = Math.sin(T.angle), az = Math.cos(T.angle), sg = ax * (N.x - T.x) + az * (N.z - T.z) >= 0 ? 1 : -1;
  const ux = ax * sg, uz = az * sg, off = T.layout.trackOffsets[track];
  if (off === undefined) return null;
  // (right of the axis: (cos a, -sin a); the outer side of this track is the side of its offset)
  const ns = off >= 0 ? 1 : -1, nx = az * ns, nz = -ax * ns;
  const jx = T.x + ux * (T.length / 2 + d) + az * off, jz = T.z + uz * (T.length / 2 + d) - ax * off;
  const link = Math.max(1, Math.hypot(N.x - T.x, N.z - T.z) - (T.length + N.length) / 2);
  const jy = T.y + (N.y - T.y) * Math.min(1, d / link);
  const bx = ux * w, bz = uz * w, under = level === 'underground';
  const o: BuildOptions = { ...(under ? subwayOpts(type, 1, owner, T.depth || 2.2) : { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner } as BuildOptions),
    ...(ignore ? { ignore } : {}) };
  const shapes = level === 'ground' ? GROUND_SHAPES : under ? CAVERN_SHAPES : RAMP_SHAPES;
  const ends = termini ?? [plannedOnwardEnd(plans[0], plans[1]), plannedOnwardEnd(plans[plans.length - 1], plans[plans.length - 2])];
  const links = plannedLinks(plans), sz = depotSize('rail'), streets = plans.flatMap((q) => (q.access ? proposalPoints(q.access) : []));
  return net.withTemporaryNodes('rail', [{ x: jx, y: jy, z: jz, dx: bx, dz: bz }], owner, (nodes) => {
    for (const [along, lat] of shapes) {
      const x = jx + bx * along + nx * lat, z = jz + bz * along + nz * lat;
      if (!g.world.inside(x, z, 8)) continue;
      const pr = planEdge(g, { kind: 'node', x: jx, y: jy, z: jz, node: nodes[0].id }, { kind: 'free', x, z, y: under ? 0 : g.world.heightAt(x, z) }, o);
      if (!pr.ok || pr.tracks.length !== 1 || (consent && !consent(pr))) continue;
      const t = pr.tracks[0], tan = endTangent(t.bez), y = t.prof[t.prof.length - 1];
      const samples = proposalSamples(pr), far = samples.filter((q) => Math.hypot(q.x - jx, q.z - jz) > 7);
      // the siding keeps off the planned tracks beyond the turnout's switch zone (construction.ts), and out of the
      // planned stations
      // (tunnels keep a bore's width apart)
      const apart = under ? 1.2 : RAIL.spacing - 0.06;
      if (samples.some((q) => Math.hypot(q.x - jx, q.z - jz) > 14 && links.some(([a, b]) => segDist(q, a, b) < apart))) continue;
      if (far.some((q) => !clearOfPlannedStations(g, q, plans))) continue;
      const dx = x + tan.x * 2.15, dz = z + tan.z * 2.15, angle = Math.atan2(-tan.x, -tan.z);
      const foot = rectPoints(dx, dz, angle, sz.w + 0.6, sz.d + 0.6);
      const way = [...ends, ...onwardEnds(g, dx, dz, 40)];
      if ([...far, ...foot].some((q) => inOnward(q, way))) continue;
      const rect = { x: dx, z: dz, angle, w: sz.w, d: sz.d };
      // (nor on a planned station's access street)
      if (streets.some((q) => distToRect(q.x, q.z, dx, dz, angle, sz.w / 2, sz.d / 2) < 0.9)) continue;
      if (plans.some((p) => rectsOverlap(rect, p.footprint, 0.02) || (!under && p.building.w > 0 && rectsOverlap(rect, p.building, 0.02))
        || (!under && p.entrances.some((e) => distToRect(e.x, e.z, dx, dz, angle, sz.w / 2, sz.d / 2) < 2))
        || rectsOverlap(rect, { x: p.x, z: p.z, angle: p.angle, w: p.layout.width + 0.6, d: p.length + 0.6 }, 0.1))) continue;
      if (links.some(([a, b]) => { for (let k = 0; k <= 20; k++) { const q = { x: a.x + (b.x - a.x) * k / 20, z: a.z + (b.z - a.z) * k / 20 };
        if (distToRect(q.x, q.z, dx, dz, angle, sz.w / 2, sz.d / 2) < 0.45) return true; } return false; })) continue;
      let depot = 0;
      if (under) {
        const dp = g.depots.plan('rail', dx, dz, angle, owner, { level: 'underground', y, snap: false });
        if (!dp.ok) continue;
        depot = dp.cost;
      } else {
        if (!depotFits(g, x, z, -tan.x, -tan.z, owner, maxPop, y, 2.6)) continue;
        const dp = g.depots.plan('rail', dx, dz, angle, owner, { snap: false, y });
        if (!dp.ok) continue;
        depot = dp.cost;
      }
      const upkeep = pr.tracks.reduce((sum, q) => sum + trackBasePerUnit(pr.opts.type) * (q.len
        + q.sections.reduce((a, sec) => a + (sec.s1 - sec.s0) * (sec.type === 'tunnel' ? 4 : 3), 0)), 0) + (under ? UNDERGROUND_DEPOT.upkeep : 12000);
      return { index, track, d, w, jx, jz, x, z, cost: Math.round(pr.cost + depot), length: pr.stats.len, under, upkeep };
    }
    return null;
  });
}

/**
 * Build a depot planned beside a city line (planProspectiveSideDepot) once its track is laid: the same siding from the
 * running track at the planned junction to the planned depot exit, at the line's `level`, and the depot at its end; it
 * must serve the line (`stations` in order) from there. The depot id, or -1 with nothing left behind but the turnout's
 * split of the track (the site was lost since the plan was priced).
 */
export function buildPlannedSideDepot(g: Game, y: SideYard, level: 'ground' | 'elevated' | 'underground', owner: number, stations: readonly number[],
  type: string, maxPop = 30): number {
  const net = g.world.net;
  const plain = (e: NEdge) => e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0 && g.stations.throughStationOf(e.id) < 0;
  const ne = net.nearestEdge(y.jx, y.jz, 0.4, 'rail', plain);
  if (!ne) return -1;
  // The junction as planned, or a little along the same track where the crossovers and signals laid since leave a
  // switch too near it (the turnout stands on plain track, clear of other switches).
  const spots: { e: NEdge; s: number; d: number }[] = [];
  const seen = new Set<number>([ne.edge.id]), chain: { e: NEdge; from: number; off: number }[] = [{ e: ne.edge, from: -1, off: 0 }];
  for (let i = 0; i < chain.length && chain.length < 12; i++) {
    const { e } = chain[i];
    for (const nid of [e.a, e.b]) {
      const n = net.nodes.get(nid);
      if (!n || n.edges.length !== 2) continue;
      const o = net.edges.get(n.edges[0] === e.id ? n.edges[1] : n.edges[0]);
      if (o && !seen.has(o.id) && plain(o)) { seen.add(o.id); chain.push({ e: o, from: nid, off: 0 }); }
    }
  }
  // (this track's own switches: the crossovers' turnouts on it; the other track's lie beyond its far side)
  const switches = [...new Set(chain.flatMap(({ e }) => [e.a, e.b]))].map((id) => net.nodes.get(id)).filter((n) => !!n && n.edges.length >= 3);
  const p = { x: 0, y: 0, z: 0 };
  for (const { e } of chain) for (let s = 0.6; s <= e.len - 0.6; s += 0.5) {
    net.pointAt(e, s, p);
    const d = Math.hypot(p.x - y.jx, p.z - y.jz);
    if (d <= 8 && !switches.some((n) => Math.hypot(n!.x - p.x, n!.z - p.z) < 3)) spots.push({ e, s, d });
  }
  spots.sort((q, r) => q.d - r.d || q.e.id - r.e.id || q.s - r.s);
  const under = level === 'underground';
  for (const c of spots.slice(0, 6)) {
    net.pointAt(c.e, c.s, p);
    const start = findSnap(g, 'rail', p.x, p.z, 0.3);
    if (start.kind !== 'edge' || start.edge !== c.e.id) continue;
    // (the planned siding's shape kept: its exit moves with its junction)
    const x = y.x + p.x - y.jx, z = y.z + p.z - y.jz;
    const o: BuildOptions = under ? subwayOpts(type, 1, owner, Math.max(1.2, g.world.heightAt(p.x, p.z) - p.y))
      : { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner };
    const pr = planEdge(g, start, { kind: 'free', x, z, y: under ? 0 : g.world.heightAt(x, z) }, o);
    if (!pr.ok || pr.tracks.length !== 1) continue;
    const t = pr.tracks[0], tan = endTangent(t.bez), ey = t.prof[t.prof.length - 1];
    if (!under && !depotFits(g, x, z, -tan.x, -tan.z, owner, maxPop, ey, 2.6)) continue;
    if (under && !g.depots.plan('rail', x + tan.x * 2.15, z + tan.z * 2.15, Math.atan2(-tan.x, -tan.z), owner, { level: 'underground', y: ey, snap: false }).ok) continue;
    if (!g.company(owner).economy.canAfford(pr.cost) || commitProposal(g, pr)) return -1;
    const end = net.nearestNode(x, z, 0.1, 'rail', (q) => q.edges.length === 1);
    const id = end ? depotAtEnd(g, end.id, owner) : -1;
    if (id < 0) { if (end) removeEdges(g, spurFrom(g, end.id, owner), owner); return -1; }
    const dp = g.depots.get(id)!;
    if (stations.length < 2 || stations.some((sid, k) => k + 1 < stations.length && depotServes(g, dp, sid, stations[k + 1]) >= 0)) return id;
    takeUpDepot(g, id, owner);
    return -1;
  }
  return -1;
}

/**
 * A straight level track `len` units on from free platform end `head` along the way on (ux, uz), at the platforms'
 * level (in tunnel under the strict subway cover for an underground station): the plain track end a line runs on from.
 * Planned only; its end is a free end.
 */
export function planPlainTail(g: Game, head: number, ux: number, uz: number, len: number, owner: number, type: string,
  level: string, depth: number): Proposal {
  const net = g.world.net, n = net.nodes.get(head)!, fx = n.x + ux * len, fz = n.z + uz * len;
  if (level !== 'underground') return planEdge(g, nodeSnap(g, head, 'rail'), { kind: 'free', x: fx, z: fz, y: n.y },
    { kind: 'rail', type, tracks: 1, heightOffset: n.y - g.world.heightAt(fx, fz) || 1e-3, crossing: 'auto', owner });
  return net.withTemporaryNodes('rail', [{ x: fx, y: n.y, z: fz, dx: -ux, dz: -uz }], owner, (nodes) => {
    const p = planEdge(g, nodeSnap(g, head, 'rail'), { kind: 'node', x: fx, y: n.y, z: fz, node: nodes[0].id }, subwayOpts(type, 1, owner, depth));
    for (const t of p.tracks) t.end = { kind: 'free', x: fx, y: n.y, z: fz };
    return p;
  });
}
