import { lineTable as startupTable, patternOf as startupPattern } from '../src/game/patterns';
import type { Vehicle as StartupVehicle } from '../src/game/vehicle';
// AI rail networks after some years (v2.4, UPDATE 9f/9g/9i/9k/9l): stations per town (one station where lines meet),
// platform tracks where traffic needs them (stations grown), connected networks per company, no unconnected
// single tracks side by side, no dead-end stubs (none on a bridge), no mid-line crossovers, no subset / superset
// lines, routes decommissioned, stations inserted / interchanges, AI money, frame cost of the network work
// (ai-network.ts).
// npx esbuild scripts/ainet.ts --bundle --platform=node --format=esm --outfile=$S/ainet.mjs && node $S/ainet.mjs [seeds] [years] [size] [ais] [--off]
//   ais: AI companies (default 3; 'v23' = the v2.3 test world: 5 at 512, 7 above); --off: without ai-network
// Initialise pattern/routing helpers before Game's vehicle classes (which also consume patterns).
import '../src/game/patterns';
import { Game } from '../src/game/game';
import type { NEdge } from '../src/game/network';
import { railModeOf, planStationUpgrade, commitStationUpgrade, CATCHMENT_RADIUS } from '../src/game/stations';
import { networkProfile, networkOptions, NETWORK_WORK_UNITS, networkDaily, saveNetwork, loadNetwork, midLineCrossovers, subsetLinePairs, networkPlanner, runNetworkTask, routeBetween, roadRouteBetween } from '../src/game/ai-network';
import type { AIController } from '../src/game/ai';
import type { Station } from '../src/game/stations';
import type { Town } from '../src/game/towns';
import { emptyRecord } from '../src/game/economy';
import { TRIPS_PER_MONTH } from '../src/game/demand';
import { serialize, deserialize } from '../src/game/save';
import { planConnection, commitConnection, finishDoubleTrack, WORKS_HOLD } from '../src/game/trackops';
import { depotReaches } from '../src/game/train';
import { nodeSnap } from '../src/game/routing';
import { planEdge, commitProposal } from '../src/game/construction';
import { MODELS } from '../src/game/vehicle-types';
import { RoadVehicle, makeLaneSeg } from '../src/game/roadvehicle';
import { outAndBack } from '../src/game/lines';
import { canJoinLines, patternHeadways } from '../src/game/patterns';
import { closestOnPolyline } from '../src/game/geom';
import { aiWorld, sidingEdges } from './networks';
import { fails, check, fmt, checkReservations, build, free, railOpts, roadOpts, edgeSnapAt, nodeNear, busStopSites, addBusStop, roadDepotNear, depotBehind } from './lib';
import { station, endNode, newTrack, loco, depotFor, runTrains } from './stationlib';

export interface AINetMetrics {
  /** towns with own main-line stations, towns with 2+ of one company's, the closest such pair (units) */
  railTowns: number; multiTowns: number; multiList: string[];
  /** main-line stations (2+ companies' within 30 units and not linked: separate stations) */
  stations: number; railParts: number; separate: number;
  /** platform tracks: histogram, stations with more than 2, through tracks, still asking for more room */
  platforms: Map<number, number>; big: number; through: number; needRoom: number;
  /** connected pieces of own track per company (more lines than pieces: a network) */
  pieces: string;
  /** single tracks side by side (0.6–3 units apart, 15+ units) not connected to each other; all side by side */
  unconnectedPar: number; parallel: number;
  /** dead ends of own track (not at a station / depot) and those on a bridge */
  stubs: number; stubsOnBridge: number;
}

export function aiNetMetrics(g: Game): AINetMetrics {
  const net = g.world.net;
  // track pieces: union-find over nodes (rail edges, any owner) and over own edges per company
  const parent = new Map<number, number>();
  const find = (x: number): number => { let r = x; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; let y = x; while (y !== r) { const n = parent.get(y)!; parent.set(y, r); y = n; } return r; };
  const unite = (a: number, b: number) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
  for (const e of net.edges.values()) if (e.kind === 'rail') unite(e.a, e.b);
  const own = new Map<number, Map<number, number>>();
  const ownFind = (o: number) => { let m = own.get(o); if (!m) own.set(o, m = new Map()); return m; };
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.owner <= 0) continue;
    const m = ownFind(e.owner);
    const f = (x: number): number => { let r = x; while (m.has(r) && m.get(r) !== r) r = m.get(r)!; return r; };
    if (!m.has(e.a)) m.set(e.a, e.a);
    if (!m.has(e.b)) m.set(e.b, e.b);
    const ra = f(e.a), rb = f(e.b);
    if (ra !== rb) m.set(ra, rb);
  }
  const pieces: string[] = [];
  for (const ai of g.ais) {
    const m = own.get(ai.companyId);
    if (!m) continue;
    const f = (x: number): number => { let r = x; while (m.has(r) && m.get(r) !== r) r = m.get(r)!; return r; };
    const roots = new Set([...m.keys()].map(f));
    const lines = g.lines.all().filter((l) => l.kind === 'rail' && l.owner === ai.companyId).length;
    pieces.push(`${g.company(ai.companyId).code ?? ai.companyId}: ${roots.size} pieces / ${lines} lines`);
  }
  // stations
  const main = [...g.stations.map.values()].filter((st) => st.rail && st.owner > 0 && railModeOf(st.rail.trackType) === 'mainline');
  const complex = (st: Station) => Math.min(...g.stations.complex(st.id));
  const stations = new Set(main.map(complex)).size;
  const platforms = new Map<number, number>();
  let big = 0, through = 0, needRoom = 0;
  for (const st of main) {
    const r = st.rail!;
    platforms.set(r.tracks, (platforms.get(r.tracks) ?? 0) + 1);
    if (r.tracks > 2) big++;
    if ((r.through ?? 0) > 0) through++;
    const cap = g.stations.capacity(st.id);
    if (cap?.recommended && cap.recommended.tracks > r.tracks) needRoom++;
  }
  const byTown = new Map<string, typeof main>();
  for (const st of main) { if (st.townId < 0) continue; const k = `${st.owner}:${st.townId}`; let a = byTown.get(k); if (!a) byTown.set(k, a = []); a.push(st); }
  const railTowns = new Set(main.filter((s) => s.townId >= 0).map((s) => s.townId)).size;
  const multiList: string[] = [];
  for (const [k, sts] of byTown) {
    if (new Set(sts.map(complex)).size < 2) continue;
    let gap = Infinity;
    for (let i = 0; i < sts.length; i++) for (let j = i + 1; j < sts.length; j++) gap = Math.min(gap, Math.hypot(sts[i].x - sts[j].x, sts[i].z - sts[j].z));
    const T = g.towns.list[Number(k.split(':')[1])];
    multiList.push(`${g.company(sts[0].owner).code}@${T?.name}: ${sts.length} (${Math.round(gap)} u${sts.some((s) => s.links.length) ? ', linked' : ''})`);
  }
  let separate = 0;
  for (let i = 0; i < main.length; i++) for (let j = i + 1; j < main.length; j++) {
    const a = main[i], b = main[j];
    if (Math.hypot(a.x - b.x, a.z - b.z) > 30 || a.links.includes(b.id)) continue;
    separate++;
  }
  // single tracks side by side
  const sidings = sidingEdges(g);
  const segs: { e: NEdge; x: number; z: number; tx: number; tz: number }[] = [];
  const C = 8, cells = new Map<number, number[]>(), key = (x: number, z: number) => Math.floor(x / C) * 65536 + Math.floor(z / C);
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || sidings.has(e.id)) continue;
    const geo = net.geo(e);
    for (let i = 0; i < geo.n; i += 2) {
      const k = key(geo.pts[i * 3], geo.pts[i * 3 + 2]);
      let a = cells.get(k); if (!a) cells.set(k, a = []);
      a.push(segs.length);
      segs.push({ e, x: geo.pts[i * 3], z: geo.pts[i * 3 + 2], tx: geo.tan[i * 2], tz: geo.tan[i * 2 + 1] });
    }
  }
  const pairLen = new Map<string, { len: number; conn: boolean }>();
  for (const s of segs) {
    if (s.e.owner <= 0) continue;
    for (let cx = Math.floor((s.x - 3) / C); cx <= Math.floor((s.x + 3) / C); cx++) for (let cz = Math.floor((s.z - 3) / C); cz <= Math.floor((s.z + 3) / C); cz++) {
      for (const i of cells.get(cx * 65536 + cz) ?? []) {
        const q = segs[i];
        if (q.e === s.e || Math.abs(q.tx * s.tx + q.tz * s.tz) < 0.97) continue;
        const dx = q.x - s.x, dz = q.z - s.z, along = Math.abs(dx * s.tx + dz * s.tz), off = Math.abs(dx * s.tz - dz * s.tx);
        if (along > 1 || off < 0.6 || off > 3) continue;
        const k = s.e.id < q.e.id ? `${s.e.id}-${q.e.id}` : `${q.e.id}-${s.e.id}`;
        let p = pairLen.get(k);
        if (!p) pairLen.set(k, p = { len: 0, conn: find(s.e.a) === find(q.e.a) });
        p.len += 0.5;
      }
    }
  }
  let unconnectedPar = 0, parallel = 0;
  for (const p of pairLen.values()) { if (p.len < 15 * 0.5) continue; parallel += p.len; if (!p.conn) unconnectedPar += p.len; }
  // dead ends
  let stubs = 0, stubsOnBridge = 0;
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.owner <= 0 || e.station >= 0 || e.depot >= 0) continue;
    for (const [nid, s] of [[e.a, 0], [e.b, e.len]] as [number, number][]) {
      if (net.nodes.get(nid)?.edges.length !== 1) continue;
      stubs++;
      if (net.sectionAt(e, s) === 'bridge') stubsOnBridge++;
    }
  }
  return { railTowns, multiTowns: multiList.length, multiList, stations, railParts: main.length, separate, platforms, big, through, needRoom, pieces: pieces.join(', '), unconnectedPar, parallel, stubs, stubsOnBridge };
}

export const fmtNet = (m: AINetMetrics) => `rail towns ${m.railTowns}, towns with 2+ stations of one company ${m.multiTowns}${m.multiList.length ? ' [' + m.multiList.join('; ') + ']' : ''}, separate stations within 30 u ${m.separate}; `
  + `${m.stations} station complexes (${m.railParts} rail parts), platform tracks ${[...m.platforms].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join(' ')}, >2 platforms ${m.big}, with through tracks ${m.through}, still short of platforms ${m.needRoom}; `
  + `pieces ${m.pieces}; side by side ${fmt(m.parallel, 0)} u (unconnected ${fmt(m.unconnectedPar, 0)} u); dead ends ${m.stubs} (on a bridge ${m.stubsOnBridge})`;

/** A world with `nai` rail-minded AI companies (as aiWorld's), run for `years`. */
export function netWorld(seed: number, years: number, size = 512, nai = 3, step?: (g: Game) => void): Game {
  const cfg = process.env.NET_BALANCED ? {} : { focus: { rail: 2.5, road: 0.8, tram: 0.5 } };
  const towns = size > 512 ? Math.min(48, Math.round(4.5 * (size / 384) ** 2)) : Math.round(size / 42);
  const g = Game.create({ size, seed, towns, hilliness: 'hilly', water: 'medium', startYear: 1985, aiConfigs: new Array(nai).fill(cfg) });
  g.aiAcquisitions = false;
  while (g.day < years * 360) { g.update(0.25); step?.(g); }
  return g;
}

const NET_KEYS = ['netDecommissioned', 'netRetired', 'netInserted', 'netInterchanges', 'netLinesMerged', 'netRestyled', 'netConsolidated', 'netStopsMerged', 'netThrough', 'netRelevelled', 'netCrossovers', 'netGraded', 'netDemolished', 'netJoined', 'netRoads'] as const;

/** Station upgrades can legitimately reserve track for works rather than for a train. */
function netReservations(g: Game): string[] {
  const holds = (g.stations as unknown as { holds?: Map<number, { edges: number[]; until: number }> }).holds;
  const held = new Set<number>();
  for (const [sid, h] of holds ?? []) if (g.stations.get(sid)?.rail && h.until > g.day) for (const id of h.edges) held.add(id);
  return checkReservations(g).filter((e) => {
    const m = /^reservation (\d+) by missing train (\d+)$/.exec(e);
    if (!m || Number(m[2]) !== WORKS_HOLD) return true;
    const id = Number(m[1]);
    return !held.has(id) || !g.world.net.edges.has(id) || g.vehicles.isEdgeBusy(id);
  });
}

// ------------------------------------------------------------------------------------------- scenarios
// Small built situations, each task run once on its own (node ainet.mjs scenarios).

/** A flat game with one AI company (no projects of its own; the network tasks run when the test says). */
function aiFlat(size = 256, towns = 0, seed = 5): { g: Game; ai: AIController; me: number } {
  const g = Game.create({ size, seed, towns, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  if (!towns) {
    const w = g.world;
    for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
    for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
    for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  }
  g.aiAcquisitions = false;
  const ai = g.ais[0], me = ai.companyId;
  g.company(me).economy.money = 200_000_000;
  ai.state.cooldown = 1e9;
  return { g, ai, me };
}
const stat = (ai: AIController, k: string) => (ai.stats as unknown as Record<string, number>)[k] ?? 0;
const routes = (g: Game, a: Station, b: Station, me: number) => !!routeBetween(g, a.id, b.id, me) && !!routeBetween(g, b.id, a.id, me);
/** A line of the company with a train (from a depot behind its last station). */
function lineWithTrain(g: Game, me: number, stops: Station[], home = stops[stops.length - 1]): number {
  const l = g.lines.create('rail', me);
  l.stops = stops.map((s) => s.id);
  g.lines.rebuild();
  const toward = stops.find((s) => s !== home)!;
  let dep = depotFor(g, home, toward, me);
  if (dep < 0) dep = depotBehind(g, home, toward, me);
  if (dep < 0) dep = [...g.depots.map.values()].find((d) => d.kind === 'rail' && d.owner === me && stops.some((st) => depotReaches(g, d, st.id)))?.id ?? -1;
  if (dep >= 0) {
    const train = g.vehicles.buyTrain(dep, loco(), l.id);
    check(typeof train !== 'string', 'rail fixture: train bought' + (typeof train === 'string' ? ': ' + train : ''));
  } else check(false, 'rail fixture: reachable depot');
  return l.id;
}

/** Synthetic towns keep these fixtures independent of terrain and generated street layouts. */
function fixtureTown(g: Game, x: number, z: number, pop = 6000, radius = 60): Town {
  const t: Town = { id: g.towns.list.length, name: 'Test town', x, z, angle: 0, pop, radius, buildings: new Set(),
    nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  return t;
}

function fixtureResidents(g: Game, t: Town, x: number, z: number, pop: number): void {
  const b = g.world.addBuilding({ townId: t.id, x, z, angle: 0, w: 1.2, d: 1.1, type: 1, floors: 2, pop, seed: t.buildings.size, y: 3, built: 0 });
  t.buildings.add(b.id);
}

/** Small, calibrated OD flows: useful transfers below the old trip gates, without overriding the defaults. */
function fixtureFlows(g: Game, stations: Station[], produced = 3): void {
  const n = stations.length;
  g.demand.regions = stations.map((st, id) => {
    const t = fixtureTown(g, st.x, st.z, produced / TRIPS_PER_MONTH, 10);
    st.townId = t.id;
    return { id, town: t.id, kind: 'town' as const, x: st.x, z: st.z, r: 10, pop: t.pop, jobs: 0, produced, attracted: produced };
  });
  g.demand.od = Float32Array.from({ length: n * n }, (_, i) => Math.floor(i / n) === i % n ? 0 : 1 / (n - 1));
  g.demand.ld = new Float32Array(n * n);
}

/** Lay a straight own track from a node to another (pieces of ~10 units, each over / under / level as it fits). */
function straightTrack(g: Game, from: number, to: number, me: number): boolean {
  const net = g.world.net;
  let cur = from;
  for (let guard = 0; guard < 80; guard++) {
    const a = net.nodes.get(cur)!, b = net.nodes.get(to)!;
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const ux = (b.x - a.x) / d, uz = (b.z - a.z) / d;
    const modes = ['auto', 'level', 'over', 'under'] as const;
    if (d < 16) {
      for (const crossing of modes) { const p = planEdge(g, nodeSnap(g, cur, 'rail'), nodeSnap(g, to, 'rail'), railOpts(me, 1, { crossing })); if (p.ok && !commitProposal(g, p)) return true; }
      return false;
    }
    let ok = false;
    for (const step of [10, 7, 13, 5, 15]) {
      const x = a.x + ux * step, z = a.z + uz * step;
      for (const crossing of modes) {
        const p = planEdge(g, nodeSnap(g, cur, 'rail'), free(g, x, z), railOpts(me, 1, { crossing }));
        if (!p.ok || commitProposal(g, p)) continue;
        const n = nodeNear(g, 'rail', x, z, 0.2);
        if (n) { cur = n.id; ok = true; }
        break;
      }
      if (ok) break;
    }
    if (!ok) return false;
  }
  return false;
}

/** Two stop streets joined only by a U-shaped detour, with a real AI-owned bus fleet. */
function roadFixture(detourZ = 210, produced = 100, count = 4) {
  const { g, ai, me } = aiFlat();
  const net = g.world.net, opts = roadOpts(-1, 'road', { town: true, straight: true });
  build(g, free(g, 30, 70), free(g, 70, 70), opts, 'A street');
  build(g, nodeSnap(g, nodeNear(g, 'road', 70, 70)!.id, 'road'), free(g, 70, detourZ), opts, 'detour south');
  build(g, nodeSnap(g, nodeNear(g, 'road', 70, detourZ)!.id, 'road'), free(g, 190, detourZ), opts, 'detour across');
  build(g, nodeSnap(g, nodeNear(g, 'road', 190, detourZ)!.id, 'road'), free(g, 190, 70), opts, 'detour north');
  build(g, nodeSnap(g, nodeNear(g, 'road', 190, 70)!.id, 'road'), free(g, 230, 70), opts, 'B street');
  const A = g.stations.get(addBusStop(g, 50, 70, me))!, B = g.stations.get(addBusStop(g, 210, 70, me))!;
  fixtureFlows(g, [A, B], produced);
  const l = g.lines.create('road', me); l.stops = [A.id, B.id]; g.lines.rebuild();
  const depot = roadDepotNear(g, 40, 70, me);
  check(depot >= 0, 'roads: fixture depot joins the stop street');
  for (let i = 0; i < count; i++) check(typeof g.vehicles.buyRoad(depot, MODELS.find((m) => m.id === 'bus_b')!, l.id) !== 'string', 'roads: fixture buys its buses');
  // One bus already driving from A: rebuilding must update its cached long route immediately.
  const v = g.vehicles.get(l.vehicles[0]) as RoadVehicle, e = net.edges.get(A.stops[0].edge)!;
  v.seg = makeLaneSeg(g, e, 1);
  const p = closestOnPolyline(A.stops[0].x, A.stops[0].z, v.seg.curve.pts, 3, v.seg.curve.cum.length);
  v.pos = v.seg.curve.cum[p.i] + (v.seg.curve.cum[Math.min(p.i + 1, v.seg.curve.cum.length - 1)] - v.seg.curve.cum[p.i]) * p.f;
  v.stopIndex = 1; v.state = 'running'; v.onLineChanged();
  g.company(me).economy.money = 2_500_000;
  return { g, ai, me, A, B, l, v };
}

function roadChecks() {
  console.log('roads: a profitable detour gets a shortcut, and the buses actually re-route');
  {
    const { g, ai, me, A, B, l, v } = roadFixture();
    const before = roadRouteBetween(g, A.id, B.id, me)!.length, buildings = g.world.buildings.size;
    const old = [...v.ahead.map((s) => s.e), ...v.route.map((c) => c.edge)];
    runNetworkTask(ai, 'roads');
    const after = roadRouteBetween(g, A.id, B.id, me)!.length, cash = g.company(me).economy.money;
    const links = [...g.world.net.edges.values()].filter((e) => e.owner === me && e.kind === 'road' && e.depot < 0);
    console.log(`  driven ${fmt(before)} -> ${fmt(after)} u (${fmt(100 * (1 - after / before))}% shorter), shortcuts ${stat(ai, 'netRoads')}, cash ${fmt(cash / 1e6, 2)}M; ${ai.log.slice(-1)}`);
    check(stat(ai, 'netRoads') === 1 && after <= before * 0.6, 'roads: driven route drops by at least 40%');
    check(links.some((e) => [...v.ahead.map((s) => s.e), ...v.route.map((c) => c.edge)].includes(e.id)) && old.join(',') !== [...v.ahead.map((s) => s.e), ...v.route.map((c) => c.edge)].join(','), 'roads: the driving bus uses the shortcut in its new plan');
    check(g.world.buildings.size === buildings && cash >= 300_000 && !g.company(me).defunct && g.company(me).economy.loan <= g.company(me).economy.maxLoan, 'roads: nothing demolished and the company stays solvent');
    check(!!roadRouteBetween(g, B.id, A.id, me) && l.vehicles.every((id) => g.vehicles.get(id)?.state !== 'noroute'), 'roads: the return direction and every bus still route');
    runNetworkTask(ai, 'roads');
    check(stat(ai, 'netRoads') === 1, 'roads: at most one shortcut per company per period');
    startFleet(g, l.vehicles.map((id) => g.vehicles.get(id)!));
    const visited = new Set<number>(), shortcutIds = new Set(links.map((e) => e.id));
    let droveShortcut = false;
    for (let i = 0; i < 1200; i++) {
      g.update(0.25); visited.add(v.opLastSt);
      droveShortcut ||= !!v.seg && shortcutIds.has(v.seg.e);
    }
    check(droveShortcut && visited.has(A.id) && visited.has(B.id) && g.company(me).economy.money >= 300_000,
      'roads: the bus physically drives the shortcut in both directions and keeps its service solvent');
  }
  for (const [name, detour, flow, fleet] of [['small detour', 95, 100, 4], ['long payback', 210, 0, 1], ['zero demand, large fleet', 210, 0, 24]] as const) {
    const { g, ai, me, A, B } = roadFixture(detour, flow, fleet);
    const ids = g.world.net.nextEdge, nodes = g.world.net.nextNode, money = g.company(me).economy.money;
    const before = roadRouteBetween(g, A.id, B.id, me)!.length;
    runNetworkTask(ai, 'roads');
    check(stat(ai, 'netRoads') === 0 && g.world.net.nextEdge === ids && g.world.net.nextNode === nodes && g.company(me).economy.money === money, `roads: ${name} does not build or mutate the network / cash in preview`);
    check(roadRouteBetween(g, A.id, B.id, me)!.length === before, `roads: ${name} leaves the driven route unchanged`);
    if (name === 'long payback') {
      const care = JSON.stringify(saveNetwork(g).companies[0][1].care);
      runNetworkTask(ai, 'roads');
      check(JSON.stringify(saveNetwork(g).companies[0][1].care) === care, 'roads: an uneconomic candidate is remembered');
    }
  }
  {
    const { g, ai, me } = roadFixture();
    const town = fixtureTown(g, 130, 70);
    for (let x = 124; x <= 136; x += 2) for (let z = 64; z <= 76; z += 2) fixtureResidents(g, town, x, z, 20);
    const ids = g.world.net.nextEdge, n = g.world.buildings.size;
    runNetworkTask(ai, 'roads');
    const clear = [...g.world.net.edges.values()].filter((e) => e.id >= ids && e.owner === me && e.depot < 0).every((e) => {
      const geo = g.world.net.geo(e);
      for (let i = 0; i < geo.n; i++) if (Math.hypot(geo.pts[i * 3] - town.x, geo.pts[i * 3 + 2] - town.z) < 10) return false;
      return true;
    });
    check(clear && g.world.buildings.size === n, 'roads: alternatives skirt a dense centre without demolition');
  }
  {
    const { g, ai, me } = roadFixture(), e = g.company(me).economy;
    e.money = 400_000; e.loan = e.maxLoan * Math.min(0.97, ai.loanAppetite + 0.2);
    const ids = g.world.net.nextEdge;
    runNetworkTask(ai, 'roads');
    check(!stat(ai, 'netRoads') && g.world.net.nextEdge === ids && e.money === 400_000,
      'roads: exhausted credit and the cash reserve prevent construction');
  }
  {
    const { g, ai } = roadFixture(), net = g.world.net;
    build(g, free(g, 128, 45), free(g, 128, 100), railOpts(0, 'standard', 1, { straight: true }), 'player track across a shortcut');
    const player = () => JSON.stringify({
      edges: [...net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === 0),
      nodes: [...net.nodes.values()].filter((n) => n.kind === 'rail' && n.owner === 0),
      crossings: [...net.crossings.values()].filter((c) => net.edges.get(c.e1)?.owner === 0),
    });
    const before = player();
    runNetworkTask(ai, 'roads');
    check(player() === before, 'roads: shortcuts preserve player track, nodes and crossings');
  }
  {
    // Rebuild the fixture's derived demand first; its injected forecast is not part of the save format.
    const g = deserialize(JSON.parse(JSON.stringify(serialize(roadFixture().g)))), ai = g.ais[0];
    runNetworkTask(ai, 'roads', 2);
    const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
    check(networkPlanner(ai)?.task === 'roads' && networkPlanner(loaded.ais[0])?.task === 'roads'
      && !!saveNetwork(g).companies[0][1].job?.items?.[0].road?.best
      && JSON.stringify(serialize(loaded)) === data, 'roads: a partially searched candidate cursor round-trips mid-job');
    networkOptions.enabled = true;
    for (const w of [g, loaded]) while (networkPlanner(w.ais[0])?.task) networkDaily(w.ais[0]);
    networkOptions.enabled = false;
    check(stat(ai, 'netRoads') === 1 && JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)),
      'roads: resuming the saved cursor builds exactly the same shortcut and world');
  }
  const snapshots: string[] = [], units: number[] = [], realPerformance = globalThis.performance;
  try {
    for (const increment of [0.001, 100]) {
      const { g, ai } = roadFixture();
      runNetworkTask(ai, 'lines');
      const state = saveNetwork(g);
      state.companies[0][1].next = state.companies[0][1].next.map(([task]) => [task, task === 'roads' ? 0 : 1e9]);
      loadNetwork(g, state);
      let ticks = 0;
      Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => ticks++ * increment } });
      networkOptions.enabled = true;
      const start = networkProfile.steps;
      for (let day = 0; day <= 60; day++) { g.day = day; networkDaily(ai); }
      snapshots.push(JSON.stringify(serialize(g))); units.push(networkProfile.steps - start);
      check(stat(ai, 'netRoads') === 1, 'roads: the periodic scheduler finishes a budgeted shortcut');
    }
  } finally {
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: realPerformance });
    networkOptions.enabled = false;
  }
  check(units[0] === units[1] && snapshots[0] === snapshots[1] && networkProfile.maxSteps <= NETWORK_WORK_UNITS,
    'roads: fast and slow clocks produce the same shortcut, cash and deadlines within four work units per day');
}

function joinChecks() {
  console.log('join: two end-to-end services run through on one line');
  for (const shared of [false, true]) {
    const { g, ai, me } = aiFlat();
    const other = shared ? g.addAICompany({ accessPolicy: 'open' }).id : me;
    if (shared) { g.ais[1].state.cooldown = 1e9; g.company(other).economy.money = 10_000_000; }
    const A = station(g, 35, 128, Math.PI / 2, 10, 2, shared ? other : me)!, H = station(g, 128, 128, Math.PI / 2, 10, 2, me)!, B = station(g, 221, 128, Math.PI / 2, 10, 2, other)!;
    let first = g.world.net.nextEdge;
    build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, H, 0, false), 'rail'), railOpts(me, 2), 'A-H');
    finishDoubleTrack(g, newTrack(g, first, me), me);
    first = g.world.net.nextEdge;
    build(g, nodeSnap(g, endNode(g, H, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(other, 2), 'H-B');
    finishDoubleTrack(g, newTrack(g, first, other), other);
    const a = lineWithTrain(g, me, [A, H]), b = lineWithTrain(g, other, [H, B]);
    if (shared) {
      g.lines.invite(a, other); g.lines.invite(b, me);
      for (const [owner, line] of [[other, a], [me, b]]) {
        const depot = [...g.depots.map.values()].find((d) => d.kind === 'rail' && d.owner === owner)!;
        check(typeof g.vehicles.buyTrain(depot.id, loco(), line) !== 'string', 'join: balanced joint fixture adds stock on each half');
      }
    }
    check(canJoinLines(g, a, b).ok, 'join: stock and the whole corridor are compatible');
    runNetworkTask(ai, 'join');
    check(!stat(ai, 'netJoined'), 'join: no through demand leaves services alone');
    fixtureFlows(g, [A, H, B], 8); g.day += 181;
    if (shared) {
      g.ais[1].config.accessPolicy = 'ask'; g.refreshAccess();
      runNetworkTask(ai, 'join');
      check(!stat(ai, 'netJoined') && g.lines.map.size === 2, 'join: closed access prevents a joint service');
      g.ais[1].config.accessPolicy = 'open'; g.refreshAccess(); g.day += 181;
    }
    for (const id of new Set([me, other])) g.company(id).economy.money = 3_000_000;
    const cash = g.company(me).economy.money;
    runNetworkTask(ai, 'join');
    const l = [...g.lines.map.values()][0];
    check(stat(ai, 'netJoined') === 1 && g.lines.map.size === 1 && l.stops.join(',') === outAndBack([A.id, H.id, B.id]).join(','), 'join: one end-to-end line replaces the two halves');
    check(l.vehicles.length === (shared ? 4 : 2) && l.vehicles.filter((id) => g.vehicles.get(id)?.owner === me).every((id) => l.patterns?.find((p) => p.id === g.vehicles.get(id)?.pattern)?.stops.every(Boolean)), 'join: only our trains use the all-through pattern');
    if (shared) check(l.vehicles.filter((id) => g.vehicles.get(id)?.owner === other).every((id) => !l.patterns?.find((p) => p.id === g.vehicles.get(id)?.pattern)?.stops.every(Boolean)), 'join: the partner keeps its short-turn patterns');
    if (shared) check(l.operators?.includes(other) && g.lines.ownsStationOn(l, me) && g.lines.ownsStationOn(l, other), 'join: the partner remains an operator and both own a station');
    startFleet(g, l.vehicles.map((id) => g.vehicles.get(id)!));
    // the cash test covers the same operating window as before staged dispatch existed
    const started = g.company(me).economy.money;
    const visited = new Map(l.vehicles.map((id) => [id, new Set<number>()]));
    const until = g.day + (shared ? 360 : 200);
    while (g.day < until) {
      g.stepTick();
      for (const id of l.vehicles) visited.get(id)!.add(g.vehicles.get(id)!.opLastSt);
    }
    console.log(`  ${shared ? 'two companies' : 'own lines'}: joined ${stat(ai, 'netJoined')}, far stops visited ${[...visited.values()].map((s) => [s.has(A.id), s.has(B.id)].join('/')).join(', ')}, cash ${fmt(g.company(me).economy.money / 1e6, 2)}M`);
    check([...visited].filter(([id]) => g.vehicles.get(id)?.owner === me).every(([, s]) => s.has(A.id) && s.has(B.id)), 'join: each of our trains physically serves both far stops');
    check(routes(g, A, B, me) && g.company(me).economy.money > started - cash * 0.2
      && [...new Set([me, other])].every((id) => { const c = g.company(id); return c.economy.money > 1_000_000 && c.economy.loan <= c.economy.maxLoan && !c.defunct; }),
      'join: through trains route both ways and both companies keep healthy cash reserves');
    check(netReservations(g).length === 0, 'join: reservations remain consistent');
  }
}

function stationPairChecks() {
  console.log('pair: connected parallel single tracks through a station become directional');
  for (const shared of [false, true]) {
    const { g, ai, me } = aiFlat(), net = g.world.net;
    const other = shared ? g.addAICompany({ accessPolicy: 'open' }).id : me;
    if (shared) { g.ais[1].state.cooldown = 1e9; g.company(other).economy.money = 10_000_000; }
    const A = station(g, 30, 128, Math.PI / 2, 10, 2, me)!, H = station(g, 128, 128, Math.PI / 2, 10, 2, me)!, B = station(g, 226, 128, Math.PI / 2, 10, 2, me)!;
    for (const [x, y] of [[A, H], [H, B]]) for (const t of [0, 1])
      build(g, nodeSnap(g, endNode(g, x, t, true), 'rail'), nodeSnap(g, endNode(g, y, t, false), 'rail'), railOpts(t ? other : me), 'parallel single track');
    // A connection beside H is exactly the previous task's reason to skip this corridor.
    const es = [...net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0 && e.len > 70 && net.nodes.get(e.a)!.x > 128);
    const p = planConnection(g, es[0].id, 8, es[1].id, 17, me, { search: 2 });
    check(p.ok && !commitConnection(g, p).error, 'pair station: fixture tracks meet near the station');
    const lid = lineWithTrain(g, me, [A, H, B, H], A);
    const foreignLength = [...net.edges.values()].filter((e) => e.owner === other && other !== me).reduce((s, e) => s + e.len, 0);
    if (shared) {
      g.ais[1].config.accessPolicy = 'ask'; g.refreshAccess();
      runNetworkTask(ai, 'pair');
      check(stat(ai, 'paired') === 0, 'pair station: both owners must agree under open access');
      g.ais[1].config.accessPolicy = 'open'; g.refreshAccess();
    }
    runNetworkTask(ai, 'pair');
    console.log(`  paired ${stat(ai, 'paired')}; ${ai.log.slice(-2).join(' | ')}`);
    check(stat(ai, 'paired') === 1, 'pair station: nearby connectivity does not suppress pairing');
    if (shared) check(Math.abs([...net.edges.values()].filter((e) => e.owner === other).reduce((s, e) => s + e.len, 0) - foreignLength) < 0.1
      && [A, H, B].every((s) => s.owner === me), 'pair station: joint works retain ownership, including split track pieces');
    const links = [...net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0 && e.depot < 0 && e.len < 16
      && Math.abs(net.nodes.get(e.a)!.z - net.nodes.get(e.b)!.z) > 0.25);
    for (const side of [-1, 1]) check(links.filter((e) => {
      const x = (net.nodes.get(e.a)!.x + net.nodes.get(e.b)!.x) / 2;
      return (x - H.x) * side > H.rail!.length / 2 && (x - H.x) * side < H.rail!.length / 2 + 32;
    }).length >= 2, 'pair station: a crossover pair right outside each station end');
    const forward = routeBetween(g, A.id, B.id, me)!, reverse = routeBetween(g, B.id, A.id, me)!;
    check(!!forward && !!reverse && forward.filter((id) => reverse.includes(id)).reduce((s, id) => s + net.edges.get(id)!.len, 0) < 30, 'pair station: long approaches use one track per direction');
    const train = g.vehicles.get(g.lines.get(lid)!.vehicles[0])!;
    const visited = new Set<number>();
    for (let i = 0; i < 1000; i++) { g.update(0.25); visited.add(train.opLastSt); }
    check(visited.has(A.id) && visited.has(H.id) && visited.has(B.id) && train.state !== 'noroute', `pair station: its train keeps serving the whole line (${shared ? 'shared' : 'own'}: ${[...visited]}, ${train.state}, ${train.status})`);
    check(netReservations(g).length === 0, 'pair station: reservations remain consistent');
  }
}

/** Review probes s1/s2/s3/s4/s5 and the unequal bus-stock fixture, exercised through saved cursors. */
function reviewChecks() {
  const finishJob = (ai: AIController) => {
    networkOptions.enabled = true;
    try { for (let n = 0; n < 100 && networkPlanner(ai)?.task; n++) networkDaily(ai); }
    finally { networkOptions.enabled = false; }
    check(!networkPlanner(ai)?.task, 'review: bounded candidate job completes');
  };
  const pairFixture = (playerStrand = false) => {
    const { g, ai, me } = aiFlat(), net = g.world.net;
    g.economy.money = 50_000_000; g.setAccessPolicy(0, 'open'); g.refreshAccess();
    const A = station(g, 30, 128, Math.PI / 2, 10, 2, me)!, H = station(g, 75, 128, Math.PI / 2, 10, 2, me)!, B = station(g, 226, 128, Math.PI / 2, 10, 2, me)!;
    for (const [x, y] of [[A, H], [H, B]]) for (const t of [0, 1])
      build(g, nodeSnap(g, endNode(g, x, t, true), 'rail'), nodeSnap(g, endNode(g, y, t, false), 'rail'), railOpts(playerStrand && t ? 0 : me), 'review parallel singles');
    const through = lineWithTrain(g, me, [A, H, B, H], A);
    return { g, ai, me, net, A, H, B, through };
  };
  console.log('review pair: trains turn at an interior station, including short-turn patterns');
  for (const canonical of [false, true]) {
    const { g, ai, me, A, H, B, through } = pairFixture();
    const short = lineWithTrain(g, me, [A, H], A);
    const trains = [...g.lines.get(through)!.vehicles, ...g.lines.get(short)!.vehicles].map((id) => g.vehicles.get(id) as Train);
    if (canonical) runNetworkTask(ai, 'lines');
    runNetworkTask(ai, 'pair');
    const r = runTrains(g, trains, 360);
    check(trains.every((t) => { const stops = r.arrivals.get(t.id) ?? []; return stops.length >= 4 && stops.includes(A.id) && stops.includes(H.id); })
      && (r.arrivals.get(trains[0].id) ?? []).includes(B.id) && r.worst.days < 90,
      `review pair: ${canonical ? 'short-turn pattern' : 'separate A-H line'} and through train keep running`);
    check(netReservations(g).length === 0, 'review pair: turnback reservations remain consistent');
  }
  {
    const { g, ai, me, net, A, H, B } = pairFixture();
    const short = lineWithTrain(g, me, [A, H], A);
    runNetworkTask(ai, 'pair', 1);
    check(!!networkPlanner(ai)?.task, 'review pair: saveable candidate cursor is suspended before commit');
    for (const id of [...g.lines.get(short)!.vehicles]) g.vehicles.sell(id);
    g.lines.delete(short);
    const edge = [...net.edges.values()].find((e) => e.station < 0 && e.depot < 0 && e.len > 100)!;
    net.splitEdge(edge.id, edge.len / 2);
    const added = g.lines.create('rail', me); added.stops = [A.id, H.id]; g.lines.rebuild();
    finishJob(ai);
    check(routes(g, A, H, me) && routes(g, H, B, me) && !ai.log.some((l) => /network work .*failed/.test(l)), 'review pair: deleted lines, split tracks and newly added turnbacks are re-read before commit');
  }
  for (const playerNodes of [false, true]) {
    const { g, ai, net, A, H, B } = pairFixture(!playerNodes);
    if (playerNodes) for (const n of net.nodes.values()) if (n.kind === 'rail') n.owner = 0;
    // Player depot near B has room; its short working still turns at H.
    A.owner = 0;
    const playerLine = g.lines.create('rail', 0); playerLine.stops = [A.id, H.id]; g.lines.rebuild();
    const playerDepot = depotBehind(g, B, H, 0);
    check(playerDepot >= 0 && typeof g.vehicles.buyTrain(playerDepot, loco(), playerLine.id) !== 'string', 'review pair: player turnback train bought');
    const player = () => JSON.stringify({ nodes: [...net.nodes.values()].filter((n) => n.owner === 0), edges: [...net.edges.values()].filter((e) => e.owner === 0) });
    const before = player(), first = net.nextEdge;
    runNetworkTask(ai, 'pair'); runNetworkTask(ai, 'crossovers'); runNetworkTask(ai, 'relevel');
    check(player() === before && net.nextEdge === first && !stat(ai, 'paired'), 'review pair: open access never authorises alterations to player track or signals');
  }
  {
    const { g, ai, me } = aiFlat(), net = g.world.net;
    const A = station(g, 50, 128, Math.PI / 2, 10, 2, me)!, B = station(g, 95, 128, Math.PI / 2, 10, 2, me)!;
    for (const t of [0, 1]) build(g, nodeSnap(g, endNode(g, A, t, true), 'rail'), nodeSnap(g, endNode(g, B, t, false), 'rail'), railOpts(me), 'review short parallel singles');
    lineWithTrain(g, me, [A, B]);
    const first = net.nextEdge, money = g.company(me).economy.money;
    const signals = [...net.nodes.values()].filter((n) => n.signal).map((n) => [n.id, n.signal, n.signalKind, n.signalPass]);
    runNetworkTask(ai, 'pair');
    check(!stat(ai, 'paired') && ai.log.some((l) => /could not pair.*tracks stay two-way/.test(l)) && net.nextEdge > first,
      'review pair: partial crossover work followed by an error is a failure');
    check(g.company(me).economy.money === money && JSON.stringify(signals) === JSON.stringify([...net.nodes.values()].filter((n) => n.signal).map((n) => [n.id, n.signal, n.signalKind, n.signalPass]))
      && [...net.edges.values()].filter((e) => e.id >= first && e.depot < 0).every((e) => Math.abs(net.nodes.get(e.a)!.z - net.nodes.get(e.b)!.z) < 0.1),
      'review pair: failed work restores signals, removes new crossovers and refunds construction without removal fees');
  }
  console.log('review join: owners control partners and vehicles keep their section frequency');
  for (const player of [true, false]) for (const policy of ['closed', 'invite', 'open'] as const) {
    if (!player && policy === 'open') continue;
    const { g, ai, me } = aiFlat(), owner = player ? 0 : g.addAICompany({ accessPolicy: 'open' }).id;
    if (!player) g.ais[1].state.cooldown = 1e9;
    g.company(owner).economy.money = 50_000_000; g.setAccessPolicy(0, 'open'); g.refreshAccess();
    build(g, free(g, 20, 70), free(g, 236, 70), roadOpts(-1, 'road', { town: true, straight: true }), 'review street');
    const [A, H, B] = [30, 90, 230].map((x, i) => g.stations.get(addBusStop(g, x, 70, i === 0 ? me : owner))!);
    const depot = roadDepotNear(g, 25, 70, owner), ownDepot = roadDepotNear(g, 225, 70, me);
    const a = g.lines.create('road', owner), b = g.lines.create('road', owner);
    a.stops = [A.id, H.id]; b.stops = [H.id, B.id]; g.lines.invite(a.id, me); g.lines.setPartnerPolicy(b.id, policy); g.lines.rebuild();
    check(typeof g.vehicles.buyRoad(ownDepot, MODELS.find((m) => m.id === 'bus_b')!, a.id) !== 'string', 'review join: invited AI operates first line');
    check(typeof g.vehicles.buyRoad(depot, MODELS.find((m) => m.id === 'bus_b')!, b.id) !== 'string', 'review join: owner operates second line');
    fixtureFlows(g, [A, H, B], 8);
    const before = JSON.stringify(serialize(g).lines);
    runNetworkTask(ai, 'join');
    check(!stat(ai, 'netJoined') && JSON.stringify(serialize(g).lines) === before, `review join: ${player ? 'player lines' : 'other owner'} partners ${policy} retained`);
  }
  {
    const { g, ai, me } = aiFlat();
    build(g, free(g, 20, 70), free(g, 236, 70), roadOpts(-1, 'road', { town: true, straight: true }), 'review stock street');
    const [A, H, B] = [30, 70, 230].map((x) => g.stations.get(addBusStop(g, x, 70, me))!);
    const depot = roadDepotNear(g, 25, 70, me);
    const a = g.lines.create('road', me), b = g.lines.create('road', me);
    a.stops = [A.id, H.id]; b.stops = [H.id, B.id]; g.lines.rebuild();
    for (const [l, n] of [[a, 6], [b, 1]] as const) for (let i = 0; i < n; i++)
      check(typeof g.vehicles.buyRoad(depot, MODELS.find((m) => m.id === 'bus_b')!, l.id) !== 'string', 'review join: unequal fleet buys buses');
    fixtureFlows(g, [A, H, B], 8);
    const before = patternHeadways(g, a)[0].headway;
    runNetworkTask(ai, 'join');
    check(!stat(ai, 'netJoined') && g.lines.map.size === 2 && patternHeadways(g, a)[0].headway === before, 'review join: six busy-section buses keep their original headway');
    g.day += 181;
    runNetworkTask(ai, 'join', 1);
    b.stops = [A.id, H.id, B.id]; g.lines.rebuild();
    finishJob(ai);
    check(g.lines.map.size === 2 && !ai.log.some((l) => /network work .*failed/.test(l)), 'review join: a candidate changing to a loop is safely skipped');
  }
}

export function scenarios() {
  networkOptions.enabled = false;
  roadChecks(); joinChecks(); stationPairChecks(); reviewChecks();
  // 1. pairing: two lines leave a station on its two platform tracks, side by side for 60 units, then part
  {
    console.log('pair: two single tracks side by side become one double track');
    const { g, ai, me } = aiFlat();
    const net = g.world.net;
    const S = station(g, 50, 128, Math.PI / 2, 10, 2, me)!, T1 = station(g, 215, 86, Math.PI / 2, 10, 1, me)!, T2 = station(g, 215, 170, Math.PI / 2, 10, 1, me)!;
    const n0 = net.nodes.get(endNode(g, S, 0, true))!, n1 = net.nodes.get(endNode(g, S, 1, true))!;
    build(g, nodeSnap(g, n0.id, 'rail'), free(g, n0.x + 60, n0.z), railOpts(me), 'track 0');
    build(g, nodeSnap(g, n1.id, 'rail'), free(g, n1.x + 60, n1.z), railOpts(me), 'track 1');
    const m0 = nodeNear(g, 'rail', n0.x + 60, n0.z)!, m1 = nodeNear(g, 'rail', n1.x + 60, n1.z)!;
    const south = n0.z > n1.z;
    build(g, nodeSnap(g, (south ? m0 : m1).id, 'rail'), nodeSnap(g, endNode(g, T2, 0, false), 'rail'), railOpts(me), 'to T2');
    build(g, nodeSnap(g, (south ? m1 : m0).id, 'rail'), nodeSnap(g, endNode(g, T1, 0, false), 'rail'), railOpts(me), 'to T1');
    lineWithTrain(g, me, [S, T1]); lineWithTrain(g, me, [S, T2]);
    const m = aiNetMetrics(g);
    console.log(`  before: side by side ${fmt(m.parallel, 0)} u, unconnected ${fmt(m.unconnectedPar, 0)} u`);
    runNetworkTask(ai, 'pair');
    const m2 = aiNetMetrics(g);
    console.log(`  after: paired ${stat(ai, 'paired')}, unconnected ${fmt(m2.unconnectedPar, 0)} u; ${ai.log.slice(-2).join(' | ')}`);
    check(stat(ai, 'paired') === 1 && m2.unconnectedPar < 15, 'pair: the two single tracks are one double track now');
    check(routes(g, S, T1, me) && routes(g, S, T2, me), 'pair: both lines still find their way both ways');
  }
  // 2. a terminus whose free end faces another line's track: a junction, the line runs through
  {
    console.log('connect: terminus joined to the line beside it');
    for (const [doubled, depotAtTerminus] of [[false, false], [true, false], [false, true]]) {
      const { g, ai, me } = aiFlat(), kind = depotAtTerminus ? 'depot lead' : doubled ? 'double' : 'single';
      const tracks = doubled ? 2 : 1;
      const V = station(g, 60, 40, 0, 10, tracks, me)!, W = station(g, 60, 216, 0, 10, tracks, me)!;
      const e0 = g.world.net.nextEdge;
      build(g, nodeSnap(g, endNode(g, V, 0, true), 'rail'), nodeSnap(g, endNode(g, W, 0, false), 'rail'), railOpts(me, tracks), 'line V-W');
      if (doubled) finishDoubleTrack(g, newTrack(g, e0, me), me);
      const T = station(g, 108, 140, Math.PI / 2, 10, 1, me)!, U = station(g, 215, 140, Math.PI / 2, 10, 1, me)!;
      build(g, nodeSnap(g, endNode(g, T, 0, true), 'rail'), nodeSnap(g, endNode(g, U, 0, false), 'rail'), railOpts(me), 'line T-U');
      const la = lineWithTrain(g, me, depotAtTerminus ? [U, T] : [T, U]);
      const home = g.vehicles.get(g.lines.get(la)!.vehicles[0]) as unknown as { depotId: number };
      lineWithTrain(g, me, [V, W]);
      runNetworkTask(ai, 'connect');
      check(stat(ai, 'netThrough') === 0, `connect (${kind}): no construction without demand`);
      fixtureFlows(g, [T, U, V, W]);
      g.day += 181;
      runNetworkTask(ai, 'connect');
      const l = g.lines.get(la)!;
      const dest = l.stops.find((s) => s === V.id || s === W.id);
      console.log(`  ${kind}: ${l.name}: ${l.stops.map((s) => g.stations.get(s)?.name).join(' - ')}; ${ai.log.slice(-1).join('')}`);
      if (depotAtTerminus) {
        check(stat(ai, 'netThrough') === 0 && routes(g, T, U, me), 'connect: a depot physically blocking the only buffer end defers construction');
      } else {
        check(stat(ai, 'netThrough') === 1 && dest !== undefined, `connect (${kind}): the terminus line runs through to the other line`);
        check(dest !== undefined && routes(g, T, g.stations.get(dest)!, me), `connect (${kind}): trains find the way through the junction both ways`);
      }
      check(midLineCrossovers(g, me).length === 0, `connect (${kind}): crossovers belong only at the stations and junction`);
      if (depotAtTerminus) check(!!home && !!g.depots.get(home.depotId) && depotReaches(g, g.depots.get(home.depotId)!, U.id), 'connect: the depot behind the old terminus still serves the line');
    }
  }
  // 3. interchange where two lines cross in open country
  {
    console.log('interchange: two lines crossing in open country');
    const { g, ai, me } = aiFlat();
    const A1 = station(g, 30, 110, Math.PI / 2, 10, 1, me)!, A2 = station(g, 226, 110, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, A1, 0, true), 'rail'), nodeSnap(g, endNode(g, A2, 0, false), 'rail'), railOpts(me), 'line A');
    const B1 = station(g, 140, 20, 0, 10, 1, me)!, B2 = station(g, 140, 226, 0, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, B1, 0, true), 'rail'), nodeSnap(g, endNode(g, B2, 0, false), 'rail'), railOpts(me), 'line B');
    const la = lineWithTrain(g, me, [A1, A2]), lb = lineWithTrain(g, me, [B1, B2]);
    runNetworkTask(ai, 'interchange');
    check(stat(ai, 'netInterchanges') === 0, 'interchange: no construction without demand');
    fixtureFlows(g, [A1, A2, B1, B2]);
    runNetworkTask(ai, 'interchange');
    const LA = g.lines.get(la)!, LB = g.lines.get(lb)!;
    console.log(`  ${LA.name}: ${LA.stops.map((s) => g.stations.get(s)?.name).join(' - ')}; ${LB.name}: ${LB.stops.map((s) => g.stations.get(s)?.name).join(' - ')}; ${ai.log.slice(-1).join('')}`);
    const newA = LA.stops.find((s) => s !== A1.id && s !== A2.id), newB = LB.stops.find((s) => s !== B1.id && s !== B2.id);
    check(stat(ai, 'netInterchanges') === 1 && newA !== undefined, 'interchange: a station on the line where they cross');
    check(newA !== undefined && newB !== undefined && (newA === newB || g.stations.complex(newA).includes(newB)), 'interchange: both lines stop there (one complex)');
    check(routes(g, A1, A2, me) && routes(g, B1, B2, me), 'interchange: both lines still run end to end');
  }
  // 4. stub tidy
  {
    console.log('tidy: a dead-end stub off the line');
    const { g, ai, me } = aiFlat();
    const A = station(g, 40, 128, Math.PI / 2, 10, 1, me)!, B = station(g, 214, 128, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'line');
    lineWithTrain(g, me, [A, B]);
    build(g, edgeSnapAt(g, 'rail', 120, 128), free(g, 150, 150), railOpts(me), 'stub');
    const before = aiNetMetrics(g).stubs;
    runNetworkTask(ai, 'tidy');
    const after = aiNetMetrics(g).stubs;
    console.log(`  dead ends ${before} -> ${after}, taken up ${stat(ai, 'stubs')} u`);
    check(before === 1 && after === 0 && routes(g, A, B, me), 'tidy: stub taken up, the line intact');
  }
  // 5. one line per route: a subset line becomes a service pattern
  {
    console.log('lines: a subset line merged');
    const { g, ai, me } = aiFlat();
    const A = station(g, 30, 128, Math.PI / 2, 10, 1, me)!, B = station(g, 128, 128, Math.PI / 2, 10, 2, me)!, C = station(g, 226, 128, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'A-B');
    build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(me), 'B-C');
    lineWithTrain(g, me, [A, B, C, B]); lineWithTrain(g, me, [A, B]);
    const before = subsetLinePairs(g).length;
    runNetworkTask(ai, 'lines');
    console.log(`  subset pairs ${before} -> ${subsetLinePairs(g).length}, lines ${g.lines.map.size}`);
    check(before === 1 && subsetLinePairs(g).length === 0 && g.lines.map.size === 1, 'lines: one line with a pattern instead of a subset line');
  }
  // 6. a hub of three lines grows to 3+ platform tracks
  {
    console.log('capacity: a hub of three lines');
    const { g, ai, me } = aiFlat();
    const H = station(g, 100, 128, Math.PI / 2, 10, 2, me)!, A = station(g, 214, 128, Math.PI / 2, 10, 2, me)!;
    build(g, nodeSnap(g, endNode(g, H, 0, true), 'rail'), nodeSnap(g, endNode(g, A, 0, false), 'rail'), railOpts(me), 'H-A');
    for (let i = 0; i < 3; i++) lineWithTrain(g, me, [H, A]);
    runNetworkTask(ai, 'capacity');
    console.log(`  ${H.name}: ${g.stations.get(H.id)?.rail?.tracks} platform tracks; ${ai.log.slice(-1).join('')}`);
    check((g.stations.get(H.id)?.rail?.tracks ?? 0) >= 3, 'capacity: the hub has 3+ platform tracks');
  }
  // 7. a crossover on plain line between stations: moved to the stations
  {
    console.log('crossovers: one on plain line between stations');
    const { g, ai, me } = aiFlat();
    const net = g.world.net;
    const A = station(g, 40, 128, Math.PI / 2, 10, 2, me)!, B = station(g, 214, 128, Math.PI / 2, 10, 2, me)!;
    const e0 = net.nextEdge;
    build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me, 2), '2-track line');
    finishDoubleTrack(g, newTrack(g, e0, me), me);
    lineWithTrain(g, me, [A, B]);
    const tr = newTrack(g, e0, me).map((id) => net.edges.get(id)!).filter((e) => e.len > 30);
    const mid = { x: 127, z: 128 };
    const near = (e: typeof tr[0]) => { const ne = net.nearestEdge(mid.x, mid.z, 2, 'rail', (q) => q.id === e.id); return ne; };
    const [t0, t1] = tr.map((e) => ({ e, ne: near(e) })).filter((q) => q.ne).sort((a, b) => a.ne!.d - b.ne!.d);
    if (t0 && t1) {
      const pc = planConnection(g, t0.e.id, t0.ne!.s, t1.e.id, t1.ne!.s + 8, me, { search: 6 });
      if (pc.ok) commitConnection(g, pc);
      else console.log('  crossover plan: ' + pc.error);
    }
    const before = midLineCrossovers(g, me).length;
    runNetworkTask(ai, 'crossovers');
    const after = midLineCrossovers(g, me).length;
    console.log(`  mid-line crossovers ${before} -> ${after}; ${ai.log.slice(-1).join('')}`);
    check(before >= 1 && after === 0, 'crossovers: none left on plain line');
    check(routes(g, A, B, me), 'crossovers: the line still runs');
  }
  // 8. a loss-making route closed, its stations taken up after the grace period
  {
    console.log('decommission: two years of losses');
    const { g, ai, me } = aiFlat();
    const A = station(g, 40, 128, Math.PI / 2, 10, 1, me)!, B = station(g, 214, 128, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'line');
    const lid = lineWithTrain(g, me, [A, B]);
    const l = g.lines.get(lid)!;
    g.day += 210;
    for (const vid of l.vehicles) { const v = g.vehicles.get(vid)!; v.boughtDay = g.day - 1000; }
    l.incomeLast = 100_000; l.costLast = 900_000; l.incomeYear = 50_000; l.costYear = 600_000;
    runNetworkTask(ai, 'decommission');
    check(!g.lines.get(lid) && stat(ai, 'netDecommissioned') === 1 && !g.vehicles.trains().some((t) => t.owner === me), 'decommission: the line closed, its train sold');
    g.day += 400;
    runNetworkTask(ai, 'decommission');
    runNetworkTask(ai, 'decommission');
    const left = [...g.stations.map.values()].filter((s) => s.owner === me).length, track = [...g.world.net.edges.values()].filter((e) => e.owner === me && e.kind === 'rail').length;
    console.log(`  after the grace period: ${left} stations, ${track} track edges of ours, retired ${stat(ai, 'netRetired')}`);
    check(left === 0 && track === 0, 'decommission: unused stations and track taken up');
  }
  // 9. a district grown up beside a line between its stations: a station inserted there
  for (const fragmented of [false, true]) {
    console.log(`insert: a station where the line passes a new district${fragmented ? ' (track split for signals)' : ''}`);
    const { g, ai, me } = aiFlat();
    const P = station(g, 40, 128, Math.PI / 2, 10, 1, me)!, Q = station(g, 216, 128, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, P, 0, true), 'rail'), nodeSnap(g, endNode(g, Q, 0, false), 'rail'), railOpts(me), 'line');
    if (fragmented) {
      const net = g.world.net;
      let e = [...net.edges.values()].find((e) => e.kind === 'rail' && e.station < 0 && e.depot < 0 && e.len > 30)!;
      while (e.len > 3.1) e = net.splitEdge(e.id, 3)!.e2;
      g.onNetworkChanged();
    }
    const lid = lineWithTrain(g, me, [P, Q]);
    // a small new district south of the line (192 residents: below the previous population gate)
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) g.world.addBuilding({ townId: -1, x: 116 + i * 2.5, z: 136 + j * 1.8, angle: 0, w: 1.2, d: 1.1, type: 1, floors: 2, pop: 3, seed: i * 8 + j, y: 3, built: 0 });
    runNetworkTask(ai, 'insert');
    const l = g.lines.get(lid)!;
    console.log(`  ${l.name}: ${l.stops.map((s) => g.stations.get(s)?.name).join(' - ')}; ${ai.log.slice(-1).join('')}`);
    check(stat(ai, 'netInserted') === 1 && l.stops.length > 2, 'insert: a station on the line by the new district');
    check(routes(g, P, Q, me), 'insert: the line still runs end to end');
    const inserted = l.stops.map((id) => g.stations.get(id)).find((s) => s?.id !== P.id && s?.id !== Q.id);
    check(!!inserted?.rail && l.vehicles.every((id) => (g.vehicles.get(id) as unknown as { length: number }).length <= inserted.rail!.length), 'insert: the smaller station fits every train');
    // not twice: the district is covered now
    g.day += 181;
    runNetworkTask(ai, 'insert');
    check(stat(ai, 'netInserted') === 1, 'insert: no second station for the same district');
  }
  // 10. bus stops of ours next to each other: one station
  {
    console.log('stops: two bus stops of ours a few metres apart');
    const { g, ai, me } = aiFlat(384, 10, 7);
    const T0 = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
    const sites = busStopSites(g, T0, me, 4, 7.5), far = busStopSites(g, T0, me, 15, 30);
    if (sites.length === 2 && far.length === 2) {
      const ids = [addBusStop(g, sites[0][0], sites[0][1], me), addBusStop(g, sites[1][0], sites[1][1], me), addBusStop(g, far[1][0], far[1][1], me)];
      const l = g.lines.create('road', me);
      l.stops = ids.filter((x) => x >= 0);
      g.lines.rebuild();
      const before = [...g.stations.map.values()].filter((s) => s.owner === me).length;
      runNetworkTask(ai, 'stops');
      const after = [...g.stations.map.values()].filter((s) => s.owner === me).length;
      console.log(`  stop stations ${before} -> ${after}; line ${l.stops.length} stops`);
      check(after === before - 1 && l.stops.length === 2, 'stops: the two adjacent stops are one station');
    } else check(false, 'stops: fixture has two adjacent and two distant stop sites');
  }
  // 11. two own termini in one town: the second line moves into the first station
  {
    console.log('consolidate: two termini within 40 units in one town');
    const { g, ai, me } = aiFlat();
    const T = fixtureTown(g, 118, 124);
    const A = station(g, 108, 110, Math.PI / 2, 10, 1, me, { style: 'none' })!;
    const B = station(g, 128, 138, Math.PI / 2, 10, 1, me, { style: 'none' })!;
    const P = station(g, 226, 110, Math.PI / 2, 10, 1, me)!, Q = station(g, 226, 138, Math.PI / 2, 10, 1, me)!;
    A.townId = B.townId = T.id; P.townId = Q.townId = -1;
    check(straightTrack(g, endNode(g, A, 0, true), endNode(g, P, 0, false), me), 'consolidate: segmented A-P approach built');
    check(straightTrack(g, endNode(g, B, 0, true), endNode(g, Q, 0, false), me), 'consolidate: segmented B-Q approach built');
    const la = lineWithTrain(g, me, [A, P]), lb = lineWithTrain(g, me, [B, Q]);
    runNetworkTask(ai, 'consolidate');
    const left = [A, B].filter((s) => g.stations.get(s.id));
    console.log(`  town termini 2 -> ${left.length}; ${ai.log.slice(-2).join(' | ')}`);
    check(stat(ai, 'netConsolidated') === 1 && left.length === 1, 'consolidate: one town station remains');
    const H = left[0];
    check(!!H && g.lines.get(la)?.stops.includes(H.id) && g.lines.get(lb)?.stops.includes(H.id)
      && routes(g, H, P, me) && routes(g, H, Q, me), 'consolidate: both lines use it and still run both ways');
    runNetworkTask(ai, 'consolidate');
    check(stat(ai, 'netConsolidated') === 1, 'consolidate: no repeat merge');
  }
  // 12. a town-centre railway splitting the town is lifted, only when profitable
  {
    console.log('relevel: a town on both sides of a ground station');
    const { g, ai, me } = aiFlat();
    const T = fixtureTown(g, 128, 128);
    const A = station(g, 30, 128, Math.PI / 2, 10, 1, me)!, H = station(g, 128, 128, Math.PI / 2, 10, 1, me, { style: 'none' })!, B = station(g, 226, 128, Math.PI / 2, 10, 1, me)!;
    H.townId = T.id; A.townId = B.townId = -1;
    build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, H, 0, false), 'rail'), railOpts(me), 'A-H');
    build(g, nodeSnap(g, endNode(g, H, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'H-B');
    const lid = lineWithTrain(g, me, [A, H, B]); // depot beyond B, clear of the town-centre ramps
    g.lines.get(lid)!.stops = [A.id, H.id, B.id, H.id];
    g.lines.rebuild();
    fixtureResidents(g, T, 128, 112, 2400); fixtureResidents(g, T, 128, 144, 2400);
    const eco = g.company(me).economy, v = emptyRecord();
    v.income = -1_000_000; eco.yearTotals.push({ year: g.year - 1, v });
    runNetworkTask(ai, 'relevel');
    check(H.rail?.level === 'ground' && stat(ai, 'netRelevelled') === 0, 'relevel: losses defer the expensive viaduct');
    v.income = 5_000_000;
    runNetworkTask(ai, 'relevel');
    console.log(`  ${H.name}: ${H.rail?.level}; ${ai.log.slice(-1).join('')}`);
    check(H.rail?.level === 'elevated' && stat(ai, 'netRelevelled') === 1, 'relevel: profitable company lifts the station');
    check(routes(g, A, B, me), 'relevel: trains still find both directions across the town');
    runNetworkTask(ai, 'relevel');
    check(stat(ai, 'netRelevelled') === 1, 'relevel: the elevated station is left alone');
  }
  // 13. a building is justified by extra catchment, never just by the company's cash or town population
  {
    console.log('building-by-value: newly covered residents pay for the building');
    const { g, ai, me } = aiFlat();
    const T = fixtureTown(g, 128, 128);
    const H = station(g, 128, 128, Math.PI / 2, 10, 1, me, { style: 'none' })!, B = station(g, 226, 128, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, H, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'H-B');
    const lid = lineWithTrain(g, me, [H, B]);
    fixtureResidents(g, T, 128, 150, 4000); // already within the halt's catchment
    const extraZ = H.z + CATCHMENT_RADIUS.rail * 1.08;
    fixtureResidents(g, T, 128, extraZ, 1); // extra catchment too small to pay back
    runNetworkTask(ai, 'capacity');
    check(H.rail?.style === 'none' && stat(ai, 'netRestyled') === 0, 'building: a rich company keeps a halt when extra catchment does not pay');
    const radius = g.stations.catchmentRadius(H);
    g.day += 361;
    fixtureResidents(g, T, 132, extraZ, 30);
    H.catchPop = 4000; H.pickupLast = 24;
    g.lines.get(lid)!.passLast = 24; g.lines.get(lid)!.incomeLast = 1_440_000;
    const money = g.company(me).economy.money;
    runNetworkTask(ai, 'capacity');
    console.log(`  ${H.name}: ${H.rail?.style}; ${ai.log.slice(-1).join('')}`);
    check(H.rail?.style !== 'none' && stat(ai, 'netRestyled') === 1 && g.stations.catchmentRadius(H) > radius
      && g.company(me).economy.money < money, 'building: the valuable extra catchment earns a paid-for building');
    runNetworkTask(ai, 'capacity');
    check(stat(ai, 'netRestyled') === 1, 'building: cooldown prevents repeated spending');
  }
  networkOptions.enabled = true;
}

/** The persisted planner fields are exact; retirement deadlines survive real JSON saves. */
function stateChecks() {
  const { g, ai, me } = aiFlat();
  const A = station(g, 40, 128, Math.PI / 2, 10, 1, me, { style: 'none' })!;
  runNetworkTask(ai, 'capacity'); runNetworkTask(ai, 'decommission');
  g.day = 120;
  const upgrade = planStationUpgrade(g, A.id, { tracks: 2 });
  check(upgrade.ok && !commitStationUpgrade(g, upgrade), 'save: station upgrade fixture commits');
  runNetworkTask(ai, 'capacity');
  networkOptions.enabled = true;
  networkDaily(ai);
  const timers = saveNetwork(g);
  timers.companies[0][1].demand = { day: 119, nt: 2, P: [0, 1 / 3, Math.PI, 0] };
  loadNetwork(g, timers);
  const state = saveNetwork(g), data = JSON.parse(JSON.stringify(serialize(g))), loaded = deserialize(data);
  check(state.companies[0][1].next.length === 14 && state.companies[0][1].care.length > 0 && state.companies[0][1].sizes.length > 0
    && state.companies[0][1].retire.length > 0, 'save: schedules, cooldowns, station changes and removal grace are populated');
  check(state.companies[0][1].sizes[0][1].day === 120, 'save: station growth cooldown retains the day of the actual change');
  check(JSON.stringify(state) === JSON.stringify(saveNetwork(loaded)), 'save: planner fields round-trip exactly through JSON');
  check(JSON.stringify(state) === JSON.stringify(saveNetwork(g)), 'save: serializing does not mutate the planner');
  for (const w of [g, loaded]) {
    w.day = 359; runNetworkTask(w.ais[0], 'decommission');
    check(!!w.stations.get(A.id), 'save: unused station kept before its original grace deadline');
    w.day = 360; runNetworkTask(w.ais[0], 'decommission');
    check(!w.stations.get(A.id), 'save: unused station removed at its original grace deadline');
  }
  check(JSON.stringify(saveNetwork(g)) === JSON.stringify(saveNetwork(loaded)), 'save: timer changes after loading stay identical');
  data.aiNetwork = undefined;
  const old = deserialize(data);
  check(saveNetwork(old).companies.length === 0, 'save: old save without planner data loads lazily');
  networkDaily(old.ais[0]);
  check(saveNetwork(old).companies[0][1].next.every(([, day]) => day > old.day), 'save: old save gets company-staggered initial deadlines');
  // The same inputs under radically different clocks perform exactly the same counted work.
  const snapshots: string[] = [], units: number[] = [], realPerformance = globalThis.performance;
  try {
    for (const increment of [0.001, 100]) {
      const w = deserialize(data);
      loadNetwork(w, state);
      const start = networkProfile.steps;
      let ticks = 0;
      Object.defineProperty(globalThis, 'performance', { configurable: true, value: { now: () => ticks++ * increment } });
      for (let day = 121; day <= 200; day++) { w.day = day; networkDaily(w.ais[0]); }
      snapshots.push(JSON.stringify(serialize(w))); units.push(networkProfile.steps - start);
    }
  } finally { Object.defineProperty(globalThis, 'performance', { configurable: true, value: realPerformance }); }
  check(units[0] > 0 && units[0] === units[1] && snapshots[0] === snapshots[1], 'determinism: fast and slow clocks produce identical work, saved worlds and deadlines');
  check(networkProfile.maxSteps <= NETWORK_WORK_UNITS, 'determinism: every daily call respects the fixed work allowance');
  const care = saveNetwork(g);
  care.companies[0][1].care.push(['expired-test', g.day - 1], ['active-test', g.day + 1]);
  loadNetwork(g, care); networkDaily(ai);
  check(!saveNetwork(g).companies[0][1].care.some(([k]) => k === 'expired-test')
    && saveNetwork(g).companies[0][1].care.some(([k]) => k === 'active-test'), 'cooldowns: only expired entries are pruned');
  {
    const { g, ai } = aiFlat();
    const metadata = (a: AIController) => (a as unknown as { lines: Map<number, Record<string, unknown>> }).lines;
    metadata(ai).set(17, { kind: 'rail', towns: [], depot: -1, maxVehicles: 4, opened: 0, congestion: undefined, congestionDay: 10 });
    const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
    check(JSON.stringify(serialize(loaded)) === data, 'save: unset controller metadata fields round-trip without changing serialized values');
    metadata(ai).get(17)!.congestion = 2; metadata(loaded.ais[0]).get(17)!.congestion = 2;
    check(JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)), 'save: later congestion updates retain identical controller field order');
  }
  {
    const { g } = aiFlat(), opts = roadOpts(-1, 'road', { town: true, straight: true });
    build(g, free(g, 50, 100), free(g, 150, 100), opts, 'saved occupied lane');
    g.flushNetworkChanges();
    const e = g.world.net.edges.get(nodeNear(g, 'road', 50, 100)!.edges[0])!;
    const v = new RoadVehicle(g, 90000, null, -1, true, 7);
    v.placeAt(makeLaneSeg(g, e, 1), e.len - 1); g.vehicles.ambient.push(v);
    build(g, nodeSnap(g, e.b, 'road'), free(g, 150, 150), opts, 'new road junction');
    g.flushNetworkChanges();
    check(v.seg!.len > makeLaneSeg(g, e, 1).len, 'save: occupied lane retains its shape after a junction changes');
    const before = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(before));
    check(!!saveNetwork(g).roadShapes?.length && JSON.stringify(serialize(loaded)) === before,
      'save: exceptional lane shapes round-trip exactly without mutating the original');
    let same = true;
    for (let tick = 0; tick < 80; tick++) {
      g.stepTick(); loaded.stepTick();
      same &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded));
    }
    check(same, 'save: traffic traverses an old occupied lane identically after loading');
  }
}

const isMain = process.argv[1]?.includes('ainet');
if (isMain && ['scenarios', 'state'].includes(process.argv[2])) {
  if (process.argv[2] === 'state') stateChecks(); else scenarios();
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
} else if (isMain) {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const off = process.argv.includes('--off');
  networkOptions.enabled = !off;
  const seeds = (args[0] ?? '5,11,23').split(',').map(Number), years = Number(args[1] ?? 6), size = Number(args[2] ?? 512);
  const nai = args[3] === 'v23' ? 0 : Number(args[3] ?? 3);
  console.log(`ai-network ${off ? 'OFF' : 'on'}: seeds ${seeds.join(',')}, ${years} years, map ${size}, ${nai || 'v2.3 test world'} AIs`);
  for (const seed of seeds) {
    const t0 = performance.now();
    Object.assign(networkProfile, { calls: 0, steps: 0, maxSteps: 0, ms: 0, max: 0, slow: 0, tasks: {}, decisions: {} });
    let errors = 0, minMoney = Infinity, overLoan = false, insolvent = false, bankrupt = false, lastDay = -1;
    const companyMinMoney = new Map<number, number>();
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { errors++; warn('WARN', ...a); };
    const g = nai ? netWorld(seed, years, size, nai, (gg) => {
      if (lastDay === gg.day) return;
      lastDay = gg.day;
      for (const ai of gg.ais) {
        const e = gg.company(ai.companyId).economy;
        minMoney = Math.min(minMoney, e.money);
        companyMinMoney.set(ai.companyId, Math.min(companyMinMoney.get(ai.companyId) ?? Infinity, e.money));
        overLoan ||= e.loan > e.maxLoan;
        insolvent ||= e.money + Math.max(0, e.maxLoan - e.loan) < 0;
      }
      bankrupt ||= gg.companies.some((c) => c.ai && c.defunct);
      if (process.argv.includes('--progress') && gg.day % 360 === 0) console.log(`  seed ${seed}: year ${gg.day / 360}/${years}`);
    }) : aiWorld(seed, years, size);
    console.warn = warn;
    const m = aiNetMetrics(g);
    const st = g.ais.map((ai) => ai.stats as unknown as Record<string, number>);
    const sum = (k: string) => st.reduce((a, x) => a + (x[k] ?? 0), 0);
    const companies = g.ais.map((ai) => {
      const s = ai.stats as unknown as Record<string, number>, e = g.company(ai.companyId).economy;
      return { company: ai.companyId, code: g.company(ai.companyId).code, grown: s.grown ?? 0, paired: s.paired ?? 0,
        through: s.netThrough ?? 0, inserted: s.netInserted ?? 0, interchanges: s.netInterchanges ?? 0,
        shortcuts: s.netRoads ?? 0, roadUnitsSaved: s.netRoadUnitsSaved ?? 0, joined: s.netJoined ?? 0,
        restyled: s.netRestyled ?? 0, decommissioned: s.netDecommissioned ?? 0, stopsMerged: s.netStopsMerged ?? 0,
        cash: e.money, loan: e.loan, maxLoan: e.maxLoan, minMoney: companyMinMoney.get(ai.companyId) ?? e.money };
    });
    const mid = midLineCrossovers(g).filter((c) => c.owner > 0);
    const subs = subsetLinePairs(g);
    const { calls, ms } = networkProfile;
    console.log(`seed ${seed}, ${years} years (${fmt((performance.now() - t0) / 1000, 0)} s): ${fmtNet(m)}`);
    console.log(`  stations per rail town ${fmt(m.stations / Math.max(1, m.railTowns), 2)}; mid-line crossovers ${mid.length}; subset/superset line pairs ${subs.length}`);
    console.log(`  AI: stations grown ${sum('grown')}, merged ${sum('merged')}, joined at a town's station ${sum('joinedStations')}, single tracks paired ${sum('paired')}, junctions ${sum('connections')}, stub track taken up ${fmt(sum('stubs'), 0)} u, lines ${sum('lines')}, rail stations ${sum('railStations')}`);
    console.log(`  network: ${NET_KEYS.map((k) => `${k.slice(3)} ${sum(k)}`).join(', ')}`);
    console.log(`  actions per company: ${companies.map((c) => `${c.code}: grown ${c.grown}, shortcuts ${c.shortcuts}, joined ${c.joined}, paired ${c.paired}, through ${c.through}, inserted ${c.inserted}, interchanges ${c.interchanges}, buildings ${c.restyled}, closed ${c.decommissioned}, stops merged ${c.stopsMerged}`).join('; ')}`);
    console.log(`  opportunities: ${Object.entries(networkProfile.decisions).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
    console.log(`  money: ${g.ais.map((ai) => { const e = g.company(ai.companyId).economy; return `${g.company(ai.companyId).code} ${fmt(e.money / 1e6, 1)}M (loan ${fmt(e.loan / 1e6, 1)}/${fmt(e.maxLoan / 1e6, 0)}M)`; }).join(', ')}${isFinite(minMoney) ? `; lowest cash ${fmt(minMoney / 1e6, 1)}M` : ''}`);
    console.log(`  network work: ${calls} calls, ${networkProfile.steps} units (max ${networkProfile.maxSteps}/${NETWORK_WORK_UNITS} per call), avg ${fmt(ms / Math.max(1, calls), 3)} ms, max ${fmt(networkProfile.max, 1)} ms, ${networkProfile.slow} over 15 ms; per company max ${g.ais.map((ai) => fmt(networkPlanner(ai)?.prof.max ?? 0, 1)).join('/')} ms; steps by task ${Object.entries(networkProfile.tasks).map(([k, v]) => `${k} ${v.steps}x max ${fmt(v.max, 1)}`).join(', ')}`);
    if (process.argv.includes('--json')) console.log('METRICS ' + JSON.stringify({ seed, off, stations: m.stations, railParts: m.railParts, railTowns: m.railTowns,
      stationsPerTown: m.stations / Math.max(1, m.railTowns), multiTowns: m.multiTowns, midCrossovers: mid.length, subsets: subs.length,
      grown: sum('grown'), paired: sum('paired'), connections: sum('connections'), through: sum('netThrough'), inserted: sum('netInserted'), interchanges: sum('netInterchanges'),
      shortcuts: sum('netRoads'), roadUnitsSaved: sum('netRoadUnitsSaved'), joined: sum('netJoined'),
      consolidated: sum('netConsolidated'), restyled: sum('netRestyled'), relevelled: sum('netRelevelled'), decommissioned: sum('netDecommissioned'),
      stopsMerged: sum('netStopsMerged'), minMoney, overLoan, insolvent, bankrupt, errors, companies, opportunities: networkProfile.decisions,
      money: g.ais.map((ai) => { const e = g.company(ai.companyId).economy; return { company: ai.companyId, cash: e.money, loan: e.loan, maxLoan: e.maxLoan }; }),
      calls, units: networkProfile.steps, maxUnits: networkProfile.maxSteps, avgMs: ms / Math.max(1, calls), maxMs: networkProfile.max }));
    for (const ai of g.ais) {
      const notes = ai.log.filter((x) => /rebuilt|merged|joined|paired|shortcut|junction|stub|station|closed|took up|interchange|combined|moved|lifted|crossovers|runs through|catchment/.test(x)).slice(-5);
      if (notes.length) console.log(`  ${g.company(ai.companyId).code}: ${notes.join(' | ')}`);
    }
    if (process.argv.includes('--diagnostics')) for (const ai of g.ais) {
      const info = (ai as unknown as { lines: Map<number, { opened: number }> }).lines;
      console.log('DIAGNOSTICS ' + JSON.stringify({ seed, company: ai.companyId, available: ai.available(),
        lines: g.lines.all().filter((l) => l.owner === ai.companyId || l.operators?.includes(ai.companyId)).map((l) => ({ id: l.id, kind: l.kind, owner: l.owner,
          stops: [...new Set(l.stops)].length, vehicles: l.vehicles.length, age: g.day - (info.get(l.id)?.opened ?? g.day), last: l.incomeLast - l.costLast,
          current: l.incomeYear - l.costYear, stations: [...new Set(l.stops)].map((id) => { const s = g.stations.get(id)!; return { name: s.name, pop: s.catchPop, pickup: s.pickupLast,
            rail: s.rail ? { length: s.rail.length, tracks: s.rail.tracks, style: s.rail.style, occupancy: s.occ, recommended: g.stations.capacity(id)?.recommended } : null }; }) })) }));
    }
    check(m.unconnectedPar < 15, `seed ${seed}: no unconnected single tracks side by side (${fmt(m.unconnectedPar, 0)} u)`);
    check(m.stubsOnBridge === 0, `seed ${seed}: no dead end on a bridge (${m.stubsOnBridge})`);
    check(m.multiTowns <= Math.max(1, Math.round(m.railTowns * 0.15)), `seed ${seed}: one station per town mostly (${m.multiTowns} of ${m.railTowns} towns with 2+)`);
    check(mid.length === 0, `seed ${seed}: no crossovers on plain line between stations (${mid.length})`);
    check(subs.length === 0, `seed ${seed}: no subset / superset lines (${subs.length})`);
    check(errors === 0, `seed ${seed}: no AI errors (${errors})`);
    // Wall time under contention is reported, never used as a simulation rule or a correctness assertion.
    check(networkProfile.maxSteps <= NETWORK_WORK_UNITS, `seed ${seed}: network work stays within the deterministic allowance`);
    check(!overLoan && !insolvent && !bankrupt && g.companies.every((c) => !c.ai || !c.defunct), `seed ${seed}: no bankrupt company or loan beyond its limit`);
    const errs = netReservations(g);
    check(errs.length === 0, `seed ${seed}: reservations consistent ${errs.slice(0, 2).join('; ')}`);
  }
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}

/** Finish staged dispatch before measuring a full operating period; bound and check the startup too. */
function startFleet(g: Game, vs: StartupVehicle[], maxWaitDays = Infinity) {
  const cycles = vs.map((v) => {
    const l = v.line;
    return l ? startupTable(g, l).pats.find((p) => p.pid === (startupPattern(l, v.pattern)?.id ?? 0))?.cycle ?? 0 : 0;
  });
  const budget = 2 * Math.max(...cycles);
  const deadline = g.tick + Math.ceil(budget / g.tickSeconds), waiting = new Map<number, number>();
  let worstWait = 0, blockedHold = false;
  while (g.tick < deadline && vs.some((v) => v.opLastSt < 0)) {
    g.stepTick();
    for (const v of vs) {
      if (v.state === 'waiting' || v.state === 'noroute') {
        const start = waiting.get(v.id) ?? g.day; waiting.set(v.id, start);
        worstWait = Math.max(worstWait, g.day - start);
      } else waiting.delete(v.id);
      blockedHold ||= v.status === 'Holding for even spacing' && g.vehicles.spacingBlocked(v);
    }
  }
  check(vs.every((v) => v.opLastSt >= 0), 'the whole fleet starts serving within two estimated cycles');
  check(worstWait < maxWaitDays && !blockedHold, 'startup preserves path-wait and platform safety limits');
}
