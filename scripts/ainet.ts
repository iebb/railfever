// AI rail networks after some years (v2.4, UPDATE 9f/9g/9i/9k/9l): stations per town (one station where lines meet),
// platform tracks where traffic needs them (stations grown), connected networks per company, no unconnected
// single tracks side by side, no dead-end stubs (none on a bridge), no mid-line crossovers, no subset / superset
// lines, routes decommissioned, stations inserted / interchanges, AI money, frame cost of the network work
// (ai-network.ts).
// npx esbuild scripts/ainet.ts --bundle --platform=node --format=esm --outfile=$S/ainet.mjs && node $S/ainet.mjs [seeds] [years] [size] [ais] [--off]
//   ais: AI companies (default 3; 'v23' = the v2.3 test world: 5 at 512, 7 above); --off: without ai-network
import { Game } from '../src/game/game';
import type { NEdge } from '../src/game/network';
import { railModeOf } from '../src/game/stations';
import { networkProfile, networkOptions, midLineCrossovers, subsetLinePairs, networkPlanner, runNetworkTask, routeBetween } from '../src/game/ai-network';
import type { AIController } from '../src/game/ai';
import type { Station } from '../src/game/stations';
import { planConnection, commitConnection, finishDoubleTrack } from '../src/game/trackops';
import { nodeSnap } from '../src/game/routing';
import { planEdge, commitProposal } from '../src/game/construction';
import { aiWorld, sidingEdges } from './networks';
import { fails, check, fmt, checkReservations, build, free, railOpts, edgeSnapAt, nodeNear, busStopSites, addBusStop, roadDepotNear } from './lib';
import { station, endNode, newTrack, loco, depotFor } from './stationlib';

export interface AINetMetrics {
  /** towns with own main-line stations, towns with 2+ of one company's, the closest such pair (units) */
  railTowns: number; multiTowns: number; multiList: string[];
  /** main-line stations (2+ companies' within 30 units and not linked: separate stations) */
  stations: number; separate: number;
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
    if (sts.length < 2) continue;
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
  return { railTowns, multiTowns: multiList.length, multiList, stations: main.length, separate, platforms, big, through, needRoom, pieces: pieces.join(', '), unconnectedPar, parallel, stubs, stubsOnBridge };
}

export const fmtNet = (m: AINetMetrics) => `rail towns ${m.railTowns}, towns with 2+ stations of one company ${m.multiTowns}${m.multiList.length ? ' [' + m.multiList.join('; ') + ']' : ''}, separate stations within 30 u ${m.separate}; `
  + `${m.stations} stations, platform tracks ${[...m.platforms].sort((a, b) => a[0] - b[0]).map(([t, n]) => `${t}:${n}`).join(' ')}, >2 platforms ${m.big}, with through tracks ${m.through}, still short of platforms ${m.needRoom}; `
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

const NET_KEYS = ['netDecommissioned', 'netRetired', 'netInserted', 'netInterchanges', 'netLinesMerged', 'netRestyled', 'netConsolidated', 'netStopsMerged', 'netThrough', 'netRelevelled', 'netCrossovers', 'netGraded', 'netDemolished', 'netJoined'] as const;

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
function lineWithTrain(g: Game, me: number, stops: Station[]): number {
  const l = g.lines.create('rail', me);
  l.stops = stops.map((s) => s.id);
  g.lines.rebuild();
  const dep = depotFor(g, stops[stops.length - 1], stops[0], me);
  if (dep >= 0) g.vehicles.buyTrain(dep, loco(), l.id);
  return l.id;
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

export function scenarios() {
  networkOptions.enabled = false;
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
    const { g, ai, me } = aiFlat();
    const V = station(g, 60, 40, 0, 10, 1, me)!, W = station(g, 60, 216, 0, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, V, 0, true), 'rail'), nodeSnap(g, endNode(g, W, 0, false), 'rail'), railOpts(me), 'line V-W');
    const T = station(g, 108, 140, Math.PI / 2, 10, 1, me)!, U = station(g, 215, 140, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, T, 0, true), 'rail'), nodeSnap(g, endNode(g, U, 0, false), 'rail'), railOpts(me), 'line T-U');
    const la = lineWithTrain(g, me, [T, U]);
    lineWithTrain(g, me, [V, W]);
    networkOptions.throughTrips = 0;
    runNetworkTask(ai, 'connect');
    networkOptions.throughTrips = 25;
    const l = g.lines.get(la)!;
    const dest = l.stops.find((s) => s === V.id || s === W.id);
    console.log(`  ${l.name}: ${l.stops.map((s) => g.stations.get(s)?.name).join(' - ')}; ${ai.log.slice(-1).join('')}`);
    check(stat(ai, 'netThrough') === 1 && dest !== undefined, 'connect: the terminus line runs through to the other line');
    check(dest !== undefined && routes(g, T, g.stations.get(dest)!, me), 'connect: trains find the way through the junction both ways');
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
    networkOptions.interchangeTrips = 0;
    runNetworkTask(ai, 'interchange');
    networkOptions.interchangeTrips = 45;
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
  {
    console.log('insert: a station where the line passes a new district');
    const { g, ai, me } = aiFlat();
    const P = station(g, 40, 128, Math.PI / 2, 10, 1, me)!, Q = station(g, 216, 128, Math.PI / 2, 10, 1, me)!;
    build(g, nodeSnap(g, endNode(g, P, 0, true), 'rail'), nodeSnap(g, endNode(g, Q, 0, false), 'rail'), railOpts(me), 'line');
    const lid = lineWithTrain(g, me, [P, Q]);
    // a new district south of the line, halfway between the stations (64 houses, ~1600 residents)
    for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) g.world.addBuilding({ townId: -1, x: 116 + i * 3.2, z: 136 + j * 3.2, angle: 0, w: 1.2, d: 1.1, type: 1, floors: 2, pop: 25, seed: i * 8 + j, y: 3, built: 0 });
    runNetworkTask(ai, 'insert');
    const l = g.lines.get(lid)!;
    console.log(`  ${l.name}: ${l.stops.map((s) => g.stations.get(s)?.name).join(' - ')}; ${ai.log.slice(-1).join('')}`);
    check(stat(ai, 'netInserted') === 1 && l.stops.length > 2, 'insert: a station on the line by the new district');
    check(routes(g, P, Q, me), 'insert: the line still runs end to end');
    // not twice: the district is covered now
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
    } else console.log('  (no stop sites: skipped)');
  }
  networkOptions.enabled = true;
}

const isMain = process.argv[1]?.includes('ainet');
if (isMain && process.argv[2] === 'scenarios') {
  scenarios();
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
    const p0 = { ...networkProfile };
    let errors = 0, minMoney = Infinity;
    const warn = console.warn;
    console.warn = (...a: unknown[]) => { errors++; warn('WARN', ...a); };
    const g = nai ? netWorld(seed, years, size, nai, (gg) => { if (gg.day % 30 === 0) for (const ai of gg.ais) minMoney = Math.min(minMoney, gg.company(ai.companyId).economy.money); }) : aiWorld(seed, years, size);
    console.warn = warn;
    const m = aiNetMetrics(g);
    const st = g.ais.map((ai) => ai.stats as unknown as Record<string, number>);
    const sum = (k: string) => st.reduce((a, x) => a + (x[k] ?? 0), 0);
    const mid = midLineCrossovers(g).filter((c) => c.owner > 0);
    const subs = subsetLinePairs(g);
    const calls = networkProfile.calls - p0.calls, ms = networkProfile.ms - p0.ms;
    console.log(`seed ${seed}, ${years} years (${fmt((performance.now() - t0) / 1000, 0)} s): ${fmtNet(m)}`);
    console.log(`  stations per rail town ${fmt(m.stations / Math.max(1, m.railTowns), 2)}; mid-line crossovers ${mid.length}; subset/superset line pairs ${subs.length}`);
    console.log(`  AI: stations grown ${sum('grown')}, merged ${sum('merged')}, joined at a town's station ${sum('joinedStations')}, single tracks paired ${sum('paired')}, junctions ${sum('connections')}, stub track taken up ${fmt(sum('stubs'), 0)} u, lines ${sum('lines')}, rail stations ${sum('railStations')}`);
    console.log(`  network: ${NET_KEYS.map((k) => `${k.slice(3)} ${sum(k)}`).join(', ')}`);
    console.log(`  money: ${g.ais.map((ai) => { const e = g.company(ai.companyId).economy; return `${g.company(ai.companyId).code} ${fmt(e.money / 1e6, 1)}M (loan ${fmt(e.loan / 1e6, 1)}/${fmt(e.maxLoan / 1e6, 0)}M)`; }).join(', ')}${isFinite(minMoney) ? `; lowest cash ${fmt(minMoney / 1e6, 1)}M` : ''}`);
    console.log(`  network work: ${calls} calls, avg ${fmt(ms / Math.max(1, calls), 3)} ms, max ${fmt(networkProfile.max, 1)} ms, ${networkProfile.slow} over 15 ms; per company max ${g.ais.map((ai) => fmt(networkPlanner(ai)?.prof.max ?? 0, 1)).join('/')} ms; steps by task ${Object.entries(networkProfile.tasks).map(([k, v]) => `${k} ${v.steps}x max ${fmt(v.max, 1)}`).join(', ')}`);
    for (const ai of g.ais) {
      const notes = ai.log.filter((x) => /rebuilt|merged|joined|paired|junction|stub|station|closed|took up|interchange|combined|moved|lifted|crossovers|runs through|catchment/.test(x)).slice(-5);
      if (notes.length) console.log(`  ${g.company(ai.companyId).code}: ${notes.join(' | ')}`);
    }
    check(m.unconnectedPar < 15, `seed ${seed}: no unconnected single tracks side by side (${fmt(m.unconnectedPar, 0)} u)`);
    check(m.stubsOnBridge === 0, `seed ${seed}: no dead end on a bridge (${m.stubsOnBridge})`);
    check(m.multiTowns <= Math.max(1, Math.round(m.railTowns * 0.15)), `seed ${seed}: one station per town mostly (${m.multiTowns} of ${m.railTowns} towns with 2+)`);
    check(mid.length === 0, `seed ${seed}: no crossovers on plain line between stations (${mid.length})`);
    check(subs.length === 0, `seed ${seed}: no subset / superset lines (${subs.length})`);
    check(errors === 0, `seed ${seed}: no AI errors (${errors})`);
    check(!off ? networkProfile.max < 30 : true, `seed ${seed}: network work stays sliced (max ${fmt(networkProfile.max, 1)} ms)`);
    check(g.ais.every((ai) => { const e = g.company(ai.companyId).economy; return e.money > -2_000_000 || e.loan < e.maxLoan * 0.98; }), `seed ${seed}: AI money healthy`);
    const errs = checkReservations(g);
    check(errs.length === 0, `seed ${seed}: reservations consistent ${errs.slice(0, 2).join('; ')}`);
  }
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}
