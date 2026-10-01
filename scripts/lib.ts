// Shared helpers for the headless simulation tests (bundle with esbuild, run with node).
import { Game } from '../src/game/game';
import { findSnap, planEdge, commitProposal, BuildOptions, Snap, Proposal } from '../src/game/construction';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import { Train, CROSS_BASE } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import {
  findStationSite, stationEnds, CorridorSearch, alignCorridor, chainProfile, buildChain, nodeSnap, OPoint, SiteOpts, buildRailDepot, buildDepotOnLine, buildRoadDepot,
} from '../src/game/ai';

export const fails: string[] = [];
export function check(cond: any, msg: string) { if (!cond) { fails.push(msg); console.log('  FAIL: ' + msg); } }
export const fmt = (x: number, d = 1) => x.toFixed(d);

export function railOpts(owner = 0, tracks = 1, extra: Partial<BuildOptions> = {}): BuildOptions {
  return { kind: 'rail', type: 'standard', tracks, heightOffset: 0, crossing: 'auto', owner, ...extra };
}
export function roadOpts(owner = 0, type = 'road', extra: Partial<BuildOptions> = {}): BuildOptions {
  return { kind: 'road', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra };
}
export const free = (g: Game, x: number, z: number): Snap => ({ kind: 'free', x, z, y: g.world.heightAt(x, z) });

/** planEdge + commitProposal; returns the proposal or null (logs the reason). */
export function build(g: Game, a: Snap, b: Snap, o: BuildOptions, label = ''): Proposal | null {
  const p = planEdge(g, a, b, o);
  if (!p.ok) { console.log(`  build ${label} failed: ${p.errors.join(', ')}`); return null; }
  const err = commitProposal(g, p);
  if (err) { console.log(`  commit ${label} failed: ${err}`); return null; }
  return p;
}

/** Edge snap on the edge nearest to (x,z). */
export function edgeSnapAt(g: Game, kind: 'rail' | 'road', x: number, z: number): Snap {
  return findSnap(g, kind, x, z, 0.6);
}

export function nodeNear(g: Game, kind: 'rail' | 'road', x: number, z: number, r = 0.1) {
  return g.world.net.nearestNode(x, z, r, kind, (n) => n.edges.length > 0);
}

/**
 * Connect two rail stations (2 tracks, axes facing each other) with a routed main line:
 * straight lead-out from A's track 0, A* corridor, railway alignment into B's track 0, and switches
 * from track 1 into the leads.
 */
export function connectStations(g: Game, A: Station, B: Station, owner = 0, tracks = 1, log = console.log): { ok: boolean; len: number; bridges: number; tunnels: number; minR: number } {
  const ra = A.rail!, rb = B.rail!;
  const ea = stationEnds(g, A), eb = stationEnds(g, B);
  const net = g.world.net;
  const fail = { ok: false, len: 0, bridges: 0, tunnels: 0, minR: 0 };
  const facing = (st: Station, other: Station) => { const r = st.rail!; return Math.sin(r.angle) * (other.x - st.x) + Math.cos(r.angle) * (other.z - st.z) > 0; };
  const endA = (i: number) => (facing(A, B) ? ea[i].front : ea[i].back), endB = (i: number) => (facing(B, A) ? eb[i].front : eb[i].back);
  const fa = facing(A, B) ? 1 : -1, fb = facing(B, A) ? 1 : -1;
  const fA = { x: Math.sin(ra.angle) * fa, z: Math.cos(ra.angle) * fa }, fB = { x: Math.sin(rb.angle) * fb, z: Math.cos(rb.angle) * fb };
  const a0 = net.nodes.get(endA(0))!, b0 = net.nodes.get(endB(0))!;
  const LEAD = 20;
  const from: OPoint = { x: a0.x + fA.x * LEAD, z: a0.z + fA.z * LEAD, tx: fA.x, tz: fA.z };
  const to: OPoint = { x: b0.x + fB.x * LEAD, z: b0.z + fB.z * LEAD, tx: -fB.x, tz: -fB.z };
  const t0 = performance.now();
  const cs = new CorridorSearch(g, from, to, { kind: 'rail', owner });
  const path = cs.run();
  if (!path) { log(`  corridor: none (expanded ${cs.expanded})`); return fail; }
  const al = alignCorridor(path, from, to);
  const way = [...al.way, { x: b0.x, z: b0.z, tx: -fB.x, tz: -fB.z }];
  const prof = chainProfile(g, [{ x: a0.x, z: a0.z, tx: fA.x, tz: fA.z }, ...way], tracks, ra.y, rb.y, 'rail');
  log(`  corridor: ${path.length} pts, expanded ${cs.expanded}, ${fmt(performance.now() - t0)} ms; ${way.length} waypoints, min radius ${fmt(al.minR)}${prof ? '' : ', PROFILE INFEASIBLE'}`);
  const res = buildChain(g, a0.id, way, railOpts(owner, tracks), b0.id, prof, (s) => log('   ' + s));
  log(`  chain: ok=${res.ok} ${res.error ?? ''} edges=${res.edges} len=${fmt(res.built)} bridges=${res.bridges} tunnels=${res.tunnels} cost=${Math.round(res.cost)}`);
  if (!res.ok) return { ...fail, len: res.built };
  // switches: track 1 joins the leads 14 units out
  const s1 = edgeSnapAt(g, 'rail', a0.x + fA.x * 14, a0.z + fA.z * 14);
  build(g, nodeSnap(g, endA(1), 'rail'), s1, railOpts(owner), 'throat A');
  const s2 = edgeSnapAt(g, 'rail', b0.x + fB.x * 14, b0.z + fB.z * 14);
  build(g, nodeSnap(g, endB(1), 'rail'), s2, railOpts(owner), 'throat B');
  return { ok: true, len: res.built, bridges: res.bridges, tunnels: res.tunnels, minR: al.minR };
}

/** Rail depot for a station: stub behind a free back end, else a siding off the line towards `toward`. */
export function depotBehind(g: Game, st: Station, toward: Station, owner = 0): number {
  const dir = { x: toward.x - st.x, z: toward.z - st.z };
  let id = buildRailDepot(g, st, owner, dir);
  if (id >= 0) return id;
  const l = Math.hypot(dir.x, dir.z) || 1;
  for (const d of [30, 40, 50, 60]) {
    const x = st.x + (dir.x / l) * (st.rail!.length / 2 + d), z = st.z + (dir.z / l) * (st.rail!.length / 2 + d);
    const ne = g.world.net.nearestEdge(x, z, 12, 'rail', (e) => e.owner === owner && e.station < 0 && e.depot < 0 && e.len > 8);
    if (!ne) continue;
    id = buildDepotOnLine(g, ne.edge.id, Math.min(ne.edge.len - 3, Math.max(3, ne.s)), owner);
    if (id >= 0) return id;
  }
  return -1;
}

/** Find two bus stop sites on streets of a town, `minD`..`maxD` apart. */
export function busStopSites(g: Game, town: Town, owner: number, minD = 10, maxD = 30): [number, number][] {
  const cands: [number, number][] = [];
  for (const e of g.towns.streets(town, 0)) {
    if (e.len < 4) continue;
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    if (g.stations.planBusStop(p.x, p.z, owner).ok) cands.push([p.x, p.z]);
  }
  cands.sort((a, b) => Math.hypot(a[0] - town.x, a[1] - town.z) - Math.hypot(b[0] - town.x, b[1] - town.z));
  for (const a of cands) for (const b of cands) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d >= minD && d <= maxD) return [a, b];
  }
  return [];
}

/** Road depot next to a street near (x,z). Returns depot id or -1. */
export function roadDepotNear(g: Game, x: number, z: number, owner: number): number {
  return buildRoadDepot(g, x, z, owner);
}

export function checkReservations(g: Game): string[] {
  const errs: string[] = [];
  const V = g.vehicles as any;
  const res: Map<number, number> = V.res;
  for (const [r, id] of res) {
    const t = g.vehicles.get(id);
    if (!(t instanceof Train)) { errs.push(`reservation ${r} by missing train ${id}`); continue; }
    if (!t.segs.some((s) => s.res.includes(r))) errs.push(`reservation ${r} by ${t.name} not on its path`);
    if (r < CROSS_BASE && !g.world.net.edges.has(r)) errs.push(`reservation of removed edge ${r}`);
  }
  return errs;
}

export function checkNaN(g: Game): string | null {
  const p = { x: 0, y: 0, z: 0 };
  for (const v of g.vehicles.map.values()) { v.worldPos(p); if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return `${v.name} at NaN`; }
  for (const a of g.vehicles.ambient) { a.worldPos(p); if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return `ambient ${a.id} at NaN`; }
  return null;
}

export function pickTownPair(g: Game, minD: number, maxD: number, exclude: Set<number> = new Set()): [Town, Town] | null {
  let best: [Town, Town] | null = null, bs = -1;
  for (const a of g.towns.list) for (const b of g.towns.list) {
    if (a.id >= b.id || exclude.has(a.id) || exclude.has(b.id)) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < minD || d > maxD) continue;
    const s = a.pop * b.pop;
    if (s > bs) { bs = s; best = a.pop >= b.pop ? [a, b] : [b, a]; }
  }
  return best;
}

export function placeStation(g: Game, town: Town, toward: { x: number; z: number }, owner = 0, tracks = 2, length = 16, extra: Partial<SiteOpts> = {}): Station | null {
  const plan = findStationSite(g, town, toward, { tracks, length, owner, ...extra });
  if (!plan) return null;
  const before = g.stations.nextId;
  const err = g.stations.commitRail(plan, owner);
  if (err) { console.log('  commitRail failed:', err); return null; }
  return g.stations.get(before) ?? null;
}

export { Train, RoadVehicle };
