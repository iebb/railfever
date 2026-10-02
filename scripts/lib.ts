// Shared helpers for the headless simulation tests (bundle with esbuild, run with node).
import { Game } from '../src/game/game';
import { findSnap, planEdge, commitProposal, BuildOptions, Snap, Proposal } from '../src/game/construction';
import { toggleSignal } from '../src/game/build-ops';
import { finishDoubleTrack } from '../src/game/trackops';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import { Train, CROSS_BASE, findRailRoute, railNext } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import {
  findStationSite, stationEnds, buildChain, nodeSnap, OPoint, SiteOpts, buildRailDepot, buildDepotNearLine, buildRoadDepot, findRailPair,
  routeGen, runGen, removeEdges,
} from '../src/game/routing';

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
  const avoid = [
    { x0: a0.x - fA.x * 4, z0: a0.z - fA.z * 4, x1: from.x - fA.x * 4, z1: from.z - fA.z * 4, r: 4 },
    { x0: b0.x - fB.x * 4, z0: b0.z - fB.z * 4, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
  ];
  const exclude = new Set<number>([...a0.edges, ...b0.edges]);
  const plan = runGen(routeGen(g, from, to, { kind: 'rail', owner, tracks, y0: ra.y, y1: rb.y, pre: [{ x: a0.x, z: a0.z, tx: fA.x, tz: fA.z }], post: [{ x: b0.x, z: b0.z, tx: -fB.x, tz: -fB.z }], avoid, exclude }));
  if (typeof plan === 'string') { log(`  route: ${plan}`); return fail; }
  const { way, prof } = plan;
  const dist = Math.hypot(A.x - B.x, A.z - B.z);
  if (prof.s[prof.s.length - 1] > dist * 1.6 + 30) { log(`  route: detour too long (${fmt(prof.s[prof.s.length - 1])} for ${fmt(dist)})`); return fail; }
  log(`  corridor: expanded ${plan.expanded}, ${fmt(performance.now() - t0)} ms; ${way.length} waypoints, min radius ${fmt(plan.minR)}, crossings ${prof.crossings.map((c) => c.mode).join('/') || 'none'}`);
  const al = { minR: plan.minR };
  const res = buildChain(g, a0.id, way, railOpts(owner, tracks), b0.id, prof, (s) => log('   ' + s));
  log(`  chain: ok=${res.ok} ${res.error ?? ''} edges=${res.edges} len=${fmt(res.built)} bridges=${res.bridges} tunnels=${res.tunnels} cost=${Math.round(res.cost)}`);
  for (const n of res.notes ?? []) log('   ' + n);
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
  const id = buildRailDepot(g, st, owner, dir);
  if (id >= 0) return id;
  // a siding off the company's line nearest the station
  const ids = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === owner).map((e) => e.id);
  return buildDepotNearLine(g, ids, st.x, st.z, owner);
}

/** Find two bus stop sites on streets of a town, `minD`..`maxD` apart. */
export function busStopSites(g: Game, town: Town, owner: number, minD = 10, maxD = 30): [number, number][] {
  const cands: [number, number][] = [];
  for (const e of g.towns.streets(town, 0)) {
    if (e.len < 4) continue;
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    const bp = g.stations.planBusStop(p.x, p.z, owner);
    if (bp.ok && !bp.join) cands.push([p.x, p.z]);
  }
  cands.sort((a, b) => Math.hypot(a[0] - town.x, a[1] - town.z) - Math.hypot(b[0] - town.x, b[1] - town.z));
  for (const a of cands) for (const b of cands) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d >= minD && d <= maxD) return [a, b];
  }
  return [];
}

/** Road depot next to a street near (x,z). Returns depot id or -1. */
export function roadDepotNear(g: Game, x: number, z: number, owner: number, onEdges?: number[]): number {
  return buildRoadDepot(g, x, z, owner, 26, onEdges ? (e) => onEdges.includes(e.id) : undefined);
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
  return townPairs(g, minD, maxD, exclude)[0] ?? null;
}

/** Candidate town pairs within a distance range, best (population product) first. */
export function townPairs(g: Game, minD: number, maxD: number, exclude: Set<number> = new Set()): [Town, Town][] {
  const out: { p: [Town, Town]; s: number }[] = [];
  for (const a of g.towns.list) for (const b of g.towns.list) {
    if (a.id >= b.id || exclude.has(a.id) || exclude.has(b.id)) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < minD || d > maxD) continue;
    out.push({ p: a.pop >= b.pop ? [a, b] : [b, a], s: a.pop * b.pop });
  }
  return out.sort((x, y) => y.s - x.s).map((x) => x.p);
}

/** Place a pair of 2-track stations for a rail link (feasible heights, good catchment, free leads). */
export function placeStationPair(g: Game, minD: number, maxD: number, owner = 0, exclude: Set<number> = new Set(), length = 16, skipPairs: Set<string> = new Set()): { A: Station; B: Station; TA: Town; TB: Town } | null {
  for (const [TA, TB] of townPairs(g, minD, maxD, exclude)) {
    if (skipPairs.has(TA.id + ':' + TB.id)) continue;
    const pr = findRailPair(g, TA, TB, { tracks: 2, length, owner, front: 22 });
    if (!pr) continue;
    const ia = g.stations.nextId;
    if (g.stations.commitRail(pr.a, owner)) continue;
    const A = g.stations.get(ia)!;
    // the second plan may conflict now; re-plan it at the same spot
    const pb = g.stations.planRail(pr.b.x, pr.b.z, pr.b.angle, length, 2, owner);
    const ib = g.stations.nextId;
    if (!pb.ok || g.stations.commitRail(pb, owner)) { g.stations.removeStation(A.id); continue; }
    return { A, B: g.stations.get(ib)!, TA, TB };
  }
  return null;
}

/** A connected rail link: station pairs are tried until one connects (failed attempts are removed again). */
export function placeAndConnect(g: Game, minD: number, maxD: number, owner = 0, exclude: Set<number> = new Set(), tracks = 1, log: (s: string) => void = console.log):
  { A: Station; B: Station; TA: Town; TB: Town; con: ReturnType<typeof connectStations> } | null {
  const skip = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const pr = placeStationPair(g, minD, maxD, owner, exclude, 16, skip);
    if (!pr) return null;
    const e0 = g.world.net.nextEdge;
    const con = connectStations(g, pr.A, pr.B, owner, tracks, log);
    if (con.ok) return { ...pr, con };
    log(`  ${pr.TA.name} - ${pr.TB.name} did not connect, trying another pair`);
    skip.add(pr.TA.id + ':' + pr.TB.id);
    removeEdges(g, newRailEdges(g, e0, owner), owner);
    g.stations.removeStation(pr.A.id); g.stations.removeStation(pr.B.id);
  }
  return null;
}

export function placeStation(g: Game, town: Town, toward: { x: number; z: number }, owner = 0, tracks = 2, length = 16, extra: Partial<SiteOpts> = {}): Station | null {
  const plan = findStationSite(g, town, toward, { tracks, length, owner, ...extra });
  if (!plan) return null;
  const before = g.stations.nextId;
  const err = g.stations.commitRail(plan, owner);
  if (err) { console.log('  commitRail failed:', err); return null; }
  return g.stations.get(before) ?? null;
}

/** Build a bus stop and return the id of the station it belongs to (it may join a nearby station). */
export function addBusStop(g: Game, x: number, z: number, owner: number): number {
  const err = g.stations.commitBusStop(x, z, owner);
  if (err) return -1;
  let best = -1, bd = Infinity;
  for (const st of g.stations.map.values()) for (const p of st.stops) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = st.id; } }
  return best;
}

export { Train, RoadVehicle };

/** Rail edges (owned by `owner`, not station/depot) created since edge id `from`. */
export function newRailEdges(g: Game, from: number, owner = 0): number[] {
  const out: number[] = [];
  for (const [id, e] of g.world.net.edges) if (id >= from && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0) out.push(id);
  return out;
}

/**
 * Double-track line between two 2-track stations (each main track runs into one platform track), with a
 * crossover near each terminus and one-way signals: the "out" track carries A->B trains, "in" B->A.
 */
export function connectDouble(g: Game, A: Station, B: Station, owner = 0, log = console.log): { ok: boolean; signals: number; crossovers: number; len: number } {
  const net = g.world.net;
  const fail = { ok: false, signals: 0, crossovers: 0, len: 0 };
  const ra = A.rail!, rb = B.rail!;
  const facing = (st: Station, o: Station) => Math.sin(st.rail!.angle) * (o.x - st.x) + Math.cos(st.rail!.angle) * (o.z - st.z) > 0;
  const ea = stationEnds(g, A), eb = stationEnds(g, B);
  const fa = facing(A, B) ? 1 : -1, fb = facing(B, A) ? 1 : -1;
  const fA = { x: Math.sin(ra.angle) * fa, z: Math.cos(ra.angle) * fa }, fB = { x: Math.sin(rb.angle) * fb, z: Math.cos(rb.angle) * fb };
  const frontsA = ea.map((e) => (fa > 0 ? e.front : e.back)), frontsB = eb.map((e) => (fb > 0 ? e.front : e.back));
  const cA = { x: ra.x + fA.x * ra.length / 2, z: ra.z + fA.z * ra.length / 2 }, cB = { x: rb.x + fB.x * rb.length / 2, z: rb.z + fB.z * rb.length / 2 };
  const LEAD = 22;
  const from: OPoint = { x: cA.x + fA.x * LEAD, z: cA.z + fA.z * LEAD, tx: fA.x, tz: fA.z };
  const to: OPoint = { x: cB.x + fB.x * LEAD, z: cB.z + fB.z * LEAD, tx: -fB.x, tz: -fB.z };
  const avoid = [
    { x0: cA.x - fA.x * ra.length, z0: cA.z - fA.z * ra.length, x1: from.x - fA.x * 4, z1: from.z - fA.z * 4, r: 4 },
    { x0: cB.x - fB.x * rb.length, z0: cB.z - fB.z * rb.length, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
  ];
  const exclude = new Set<number>([...ra.edges, ...rb.edges]);
  const plan = runGen(routeGen(g, from, to, { kind: 'rail', owner, tracks: 2, y0: ra.y, y1: rb.y, pre: [{ x: cA.x, z: cA.z, tx: fA.x, tz: fA.z }], post: [{ x: cB.x, z: cB.z, tx: -fB.x, tz: -fB.z }], avoid, exclude }));
  if (typeof plan === 'string') { log(`  double: ${plan}`); return fail; }
  const { way, prof } = plan;
  const dist = Math.hypot(A.x - B.x, A.z - B.z);
  if (prof.s[prof.s.length - 1] > dist * 1.6 + 30) { log(`  double: detour too long (${fmt(prof.s[prof.s.length - 1])} for ${fmt(dist)})`); return fail; }
  const e0 = net.nextEdge;
  const res = buildChain(g, frontsA[0], way, railOpts(owner, 2), frontsB[0], prof, (s) => log('   ' + s));
  log(`  double chain: ok=${res.ok} ${res.error ?? ''} edges=${res.edges} len=${fmt(res.built)} bridges=${res.bridges} tunnels=${res.tunnels}`);
  if (!res.ok) return fail;
  // directional running: crossover pairs before both stations and one-way block signals (trackops.ts)
  const f = finishDoubleTrack(g, newRailEdges(g, e0, owner), owner);
  if (f.error) log(`  double: ${f.error}`);
  const crossovers = f.crossovers / 2, signals = f.signals;
  g.onNetworkChanged();
  // every platform must reach the other station (else the caller tries another pair)
  let routes = true;
  for (const [st, o] of [[A, B], [B, A]] as [Station, Station][]) for (const eid of st.rail!.edges) {
    const e = net.edges.get(eid)!;
    const ok = [1, -1].some((dir) => !!findRailRoute(g, railNext(g, e, dir, owner), o.id, owner, -1));
    if (!ok) { log(`  double: no route from ${st.name} platform ${eid} to ${o.name}`); routes = false; }
  }
  return { ok: routes, signals, crossovers, len: res.built };
}
