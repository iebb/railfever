// AI rail networks (v2.3): near-parallel AI track (should be rare), lines through several towns, track and
// stations shared between lines and companies (open access), loop lines, signalling, save round trip.
// npx esbuild scripts/networks.ts --bundle --platform=node --format=esm --outfile=$S/networks.mjs && node $S/networks.mjs [seeds] [years]
//   node $S/networks.mjs metrics 5,11,23 4   (metrics only: also runs against older versions for comparison)
import { Game, PLAYER } from '../src/game/game';
import type { NEdge } from '../src/game/network';
import { findRailRoute, railNext, Train } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { planDoubleTrack, commitDoubleTrack } from '../src/game/trackops';
import * as Signals from '../src/game/signals';
import { stationEnds, nodeSnap, buildRailDepot, buildDepotOnLine } from '../src/game/routing';
import type { Station } from '../src/game/stations';
import { fails, check, fmt, build, free, railOpts, edgeSnapAt, checkReservations, busStopSites, addBusStop, roadDepotNear } from './lib';

export interface NetMetrics {
  aiRailKm: number; parallelKm: number; parallelShare: number;
  /** town pairs connected by railways of 2+ companies each on its own track (duplicate corridors) */
  duplicatePairs: number;
  aiRailLines: number; multiTownLines: number; maxStations: number;
  reusedKm: number; foreignKm: number; sharedStations: number;
}

/** Track leading to depots (sidings up to the first junction): not a line, left out of the parallel count. */
export function sidingEdges(g: Game): Set<number> {
  const net = g.world.net, out = new Set<number>();
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.depot < 0) continue;
    // walk from the depot stub towards the line while the track does not branch
    let cur = e, from = net.nodes.get(e.a)?.edges.length === 1 ? e.a : e.b;
    for (let k = 0; k < 8; k++) {
      out.add(cur.id);
      const nid = cur.a === from ? cur.b : cur.a, n = net.nodes.get(nid);
      if (!n || n.edges.length !== 2) break;
      const nx = net.edges.get(n.edges[0] === cur.id ? n.edges[1] : n.edges[0]);
      if (!nx || nx.kind !== 'rail' || nx.station >= 0) break;
      from = nid; cur = nx;
    }
  }
  return out;
}

/** Rail of AI companies running alongside other rail (3–30 units off, heading within 25°), lines through 3+ towns, reuse. */
export function networkMetrics(g: Game): NetMetrics {
  const net = g.world.net;
  const sidings = sidingEdges(g);
  const X: number[] = [], Z: number[] = [], TX: number[] = [], TZ: number[] = [], E: number[] = [];
  const cells = new Map<number, number[]>();
  const C = 16, key = (x: number, z: number) => Math.floor(x / C) * 65536 + Math.floor(z / C);
  const samples = (e: NEdge, step: number, f: (x: number, z: number, tx: number, tz: number) => void) => {
    const geo = net.geo(e);
    let last = -Infinity;
    for (let i = 0; i < geo.n; i++) {
      if (geo.cum[i] - last < step && i < geo.n - 1) continue;
      last = geo.cum[i];
      f(geo.pts[i * 3], geo.pts[i * 3 + 2], geo.tan[i * 2], geo.tan[i * 2 + 1]);
    }
  };
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.depot >= 0 || sidings.has(e.id)) continue;
    samples(e, 3, (x, z, tx, tz) => { const i = X.length; X.push(x); Z.push(z); TX.push(tx); TZ.push(tz); E.push(e.id); const k = key(x, z); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i); });
  }
  const parallel = (e: NEdge, x: number, z: number, tx: number, tz: number) => {
    for (let cx = Math.floor((x - 30) / C); cx <= Math.floor((x + 30) / C); cx++) for (let cz = Math.floor((z - 30) / C); cz <= Math.floor((z + 30) / C); cz++) {
      for (const i of cells.get(cx * 65536 + cz) ?? []) {
        if (E[i] === e.id) continue;
        const dx = X[i] - x, dz = Z[i] - z, along = dx * tx + dz * tz, off = Math.abs(dx * tz - dz * tx);
        if (off < 3 || off > 30 || Math.abs(along) > 12) continue;
        if (Math.abs(TX[i] * tx + TZ[i] * tz) >= 0.906) return true;
      }
    }
    return false;
  };
  let ai = 0, par = 0;
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.owner <= 0 || e.depot >= 0 || e.station >= 0 || sidings.has(e.id)) continue;
    // runs of 15+ units alongside other rail count (not the odd turnout or siding nearby)
    let run = 0;
    samples(e, 3, (x, z, tx, tz) => { ai += 3; if (parallel(e, x, z, tx, tz)) run += 3; else { if (run >= 15) par += run; run = 0; } });
    if (run >= 15) par += run;
  }
  // lines: stations, and the track their trains use (routed between consecutive stops)
  let lines = 0, multi = 0, maxSt = 0;
  const use = new Map<number, Set<number>>();
  /** town pair -> owners whose own track connects it */
  const ownTrack = new Map<string, Set<number>>();
  const stationLines = new Map<number, Set<number>>();
  for (const l of g.lines.map.values()) {
    if (l.kind !== 'rail' || l.stops.length < 2) continue;
    for (const s of new Set(l.stops)) { let a = stationLines.get(s); if (!a) stationLines.set(s, a = new Set()); a.add(l.owner); }
    if (l.owner <= 0) continue;
    lines++;
    const sts = new Set(l.stops);
    maxSt = Math.max(maxSt, sts.size);
    if (sts.size >= 3) multi++;
    for (let i = 0; i < l.stops.length; i++) {
      const a = g.stations.get(l.stops[i]), b = g.stations.get(l.stops[(i + 1) % l.stops.length]);
      if (!a?.rail || !b?.rail || a === b) continue;
      let best: NEdge[] | null = null;
      for (const eid of a.rail.edges) {
        const e = net.edges.get(eid);
        if (!e) continue;
        for (const d of [1, -1]) {
          const r = findRailRoute(g, railNext(g, e, d, l.owner), b.id, l.owner, -1, 20000);
          if (r && (!best || r.conts.length < best.length)) best = r.conts.map((c) => c.edge);
        }
      }
      for (const e of best ?? []) { let s = use.get(e.id); if (!s) use.set(e.id, s = new Set()); s.add(l.id * 16 + l.owner); }
      // a stretch on its owner's own track between two towns
      const tot = (best ?? []).reduce((x, e) => x + e.len, 0), own = (best ?? []).filter((e) => e.owner === l.owner).reduce((x, e) => x + e.len, 0);
      if (best && tot > 0 && own / tot > 0.7 && a.townId >= 0 && b.townId >= 0 && a.townId !== b.townId) {
        const k = Math.min(a.townId, b.townId) + '-' + Math.max(a.townId, b.townId);
        let o = ownTrack.get(k); if (!o) ownTrack.set(k, o = new Set()); o.add(l.owner);
      }
    }
  }
  let reused = 0, foreign = 0;
  for (const [eid, s] of use) {
    const e = net.edges.get(eid);
    if (!e || e.station >= 0) continue;
    const owners = new Set([...s].map((k) => k % 16));
    const isForeign = [...owners].some((o) => o !== e.owner);
    if (isForeign) foreign += e.len;
    if (isForeign || s.size >= 2) reused += e.len;
  }
  let shared = 0;
  for (const owners of stationLines.values()) if (owners.size >= 2) shared++;
  let dup = 0;
  for (const o of ownTrack.values()) if (o.size >= 2) dup++;
  return {
    aiRailKm: ai / 100, parallelKm: par / 100, parallelShare: ai ? par / ai : 0, duplicatePairs: dup,
    aiRailLines: lines, multiTownLines: multi, maxStations: maxSt,
    reusedKm: reused / 100, foreignKm: foreign / 100, sharedStations: shared,
  };
}

/** A game with rail-minded AI companies (five, seven on big maps; balanced ones with NET_BALANCED=1) run for `years`. */
export function aiWorld(seed: number, years: number, size = 512): Game {
  const cfg = process.env.NET_BALANCED ? {} : { focus: { rail: 2.5, road: 0.8, tram: 0.5 } };
  const towns = size > 512 ? Math.min(48, Math.round(4.5 * (size / 384) ** 2)) : Math.round(size / 42);
  const g = Game.create({ size, seed, towns, hilliness: 'hilly', water: 'medium', startYear: 1985, aiConfigs: new Array(size > 512 ? 7 : 5).fill(cfg) });
  g.aiAcquisitions = false;
  while (g.day < years * 360) g.update(0.25);
  return g;
}

const fmtM = (m: NetMetrics) => `AI rail ${m.aiRailKm.toFixed(1)} km, near-parallel ${m.parallelKm.toFixed(1)} km (${(m.parallelShare * 100).toFixed(0)}%), duplicate corridors ${m.duplicatePairs}, lines ${m.aiRailLines} (3+ stations ${m.multiTownLines}, max ${m.maxStations}), reused track ${m.reusedKm.toFixed(1)} km (foreign ${m.foreignKm.toFixed(1)}), stations shared by companies ${m.sharedStations}`;

/** Which lines run alongside which (for diagnosis): line name pairs with the parallel length (km). */
export function parallelPairs(g: Game): string[] {
  const net = g.world.net;
  const lineOf = new Map<number, Set<string>>();
  for (const l of g.lines.map.values()) {
    if (l.kind !== 'rail' || l.stops.length < 2) continue;
    for (let i = 0; i < l.stops.length; i++) {
      const a = g.stations.get(l.stops[i]), b = g.stations.get(l.stops[(i + 1) % l.stops.length]);
      if (!a?.rail || !b?.rail || a === b) continue;
      for (const eid of a.rail.edges) {
        const e = net.edges.get(eid);
        if (!e) continue;
        for (const d of [1, -1]) {
          const r = findRailRoute(g, railNext(g, e, d, l.owner), b.id, l.owner, -1, 20000);
          for (const c of r?.conts ?? []) { let s2 = lineOf.get(c.edge.id); if (!s2) lineOf.set(c.edge.id, s2 = new Set()); s2.add(`${l.name}(${l.owner})`); }
        }
      }
    }
  }
  const pts: { x: number; z: number; tx: number; tz: number; e: number }[] = [];
  const sidings = sidingEdges(g);
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail' || e.depot >= 0 || sidings.has(e.id)) continue;
    const geo = net.geo(e);
    let last = -Infinity;
    for (let i = 0; i < geo.n; i++) { if (geo.cum[i] - last < 3 && i < geo.n - 1) continue; last = geo.cum[i]; pts.push({ x: geo.pts[i * 3], z: geo.pts[i * 3 + 2], tx: geo.tan[i * 2], tz: geo.tan[i * 2 + 1], e: e.id }); }
  }
  const tally = new Map<string, number>();
  for (const p of pts) {
    const e = net.edges.get(p.e)!;
    if (e.owner <= 0 || e.station >= 0) continue;
    for (const q of pts) {
      if (q.e === p.e) continue;
      const dx = q.x - p.x, dz = q.z - p.z;
      if (Math.abs(dx) > 30 || Math.abs(dz) > 30) continue;
      const along = dx * p.tx + dz * p.tz, off = Math.abs(dx * p.tz - dz * p.tx);
      if (off < 3 || off > 30 || Math.abs(along) > 12 || Math.abs(q.tx * p.tx + q.tz * p.tz) < 0.906) continue;
      const qe = net.edges.get(q.e)!;
      const desc = (x: NEdge) => `(no line: e${x.id} owner ${x.owner} len ${x.len.toFixed(0)} deg ${net.nodes.get(x.a)?.edges.length}/${net.nodes.get(x.b)?.edges.length} off ${off.toFixed(1)})`;
      const k = `${[...(lineOf.get(p.e) ?? new Set([desc(e)]))].join('+')} ~ ${[...(lineOf.get(q.e) ?? new Set([qe.station >= 0 ? '(station)' : desc(qe)]))].join('+')}`;
      tally.set(k, (tally.get(k) ?? 0) + 0.03);
      break;
    }
  }
  return [...tally].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v.toFixed(2)} km: ${k}`);
}

const isMain = process.argv[1]?.includes('networks');
if (isMain && process.argv[2] === 'pairs') {
  const g = aiWorld(Number(process.argv[3] ?? 5), Number(process.argv[4] ?? 5), Number(process.argv[5] ?? 512));
  console.log(fmtM(networkMetrics(g)));
  for (const s2 of parallelPairs(g).slice(0, 15)) console.log('  ' + s2);
  for (const ai of g.ais) console.log(`AI ${ai.companyId}: ` + ai.log.filter((x) => /railway|extended|share|trains on/.test(x)).slice(-10).join(' | '));
}
if (isMain && process.argv[2] === 'metrics') {
  const seeds = (process.argv[3] ?? '5,11,23').split(',').map(Number), years = Number(process.argv[4] ?? 4), size = Number(process.argv[5] ?? 512);
  for (const seed of seeds) {
    const t0 = performance.now();
    const g = aiWorld(seed, years, size);
    console.log(`seed ${seed}, ${years} years (${((performance.now() - t0) / 1000).toFixed(0)} s): ${fmtM(networkMetrics(g))}`);
  }
}
export { fmtM };

// ------------------------------------------------------------------------------------------- the test
/** A flat test map (no towns) with level ground. */
function flatGame(size = 384, ais = 0): Game {
  const g = Game.create({ size, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: ais });
  g.aiEnabled = false;
  g.world.h.fill(2);
  g.world.heightsVersion++;
  g.economy.money = 1e9;
  return g;
}
const stationAt = (g: Game, x: number, z: number, angle: number, tracks: number, len = 12, owner = PLAYER): Station | null => {
  const id = g.stations.nextId;
  const plan = g.stations.planRail(x, z, angle, len, tracks, owner);
  if (!plan.ok || g.stations.commitRail(plan, owner)) return null;
  return g.stations.get(id) ?? null;
};
/** The second platform track joins the line 14 units out from the first one's end (`dir`: +x or -x). */
function stationLoops(g: Game, main: number, other: number, dir: number, owner: number) {
  const n0 = g.world.net.nodes.get(main)!;
  const sn = edgeSnapAt(g, 'rail', n0.x + dir * 14, n0.z);
  if (sn.kind !== 'edge' || !build(g, nodeSnap(g, other, 'rail'), sn, railOpts(owner), 'station loop')) console.log('  (station loop not built)');
}
const runDays = (g: Game, n: number, each?: () => void) => { const d0 = g.day; while (g.day < d0 + n) { g.update(0.25); each?.(); } };
const loco = () => MODEL_BY_ID.get('diesel_b')!, coach = () => MODEL_BY_ID.get('coach_ic')!;

if (isMain && process.argv[2] !== 'metrics' && process.argv[2] !== 'pairs') {
  const seeds = (process.argv[2] ?? '5,11').split(',').map(Number), years = Number(process.argv[3] ?? 4);
  // ---- 1. AI networks: little track alongside other rail, few duplicate corridors, reuse, lines through towns
  let multi = 0, reused = 0;
  for (const seed of seeds) {
    const t0 = performance.now();
    const g = aiWorld(seed, years);
    const m = networkMetrics(g);
    console.log(`seed ${seed}, ${years} years (${fmt((performance.now() - t0) / 1000, 0)} s): ${fmtM(m)}`);
    const st = g.ais.map((ai) => ai.stats);
    console.log(`  AI stats: multi-town max ${Math.max(...st.map((x) => x.multiTown))}, rings ${st.reduce((x, y) => x + y.rings, 0)}, transfers ${st.reduce((x, y) => x + y.transfers, 0)}, shared lines ${st.reduce((x, y) => x + y.shared, 0)}, signals ${st.reduce((x, y) => x + y.signals, 0)}, second track ${fmt(st.reduce((x, y) => x + y.trackDouble, 0) / 100, 1)} km`);
    check(m.parallelShare < 0.08, `seed ${seed}: little AI track alongside other rail (${fmt(m.parallelShare * 100, 0)}%)`);
    check(m.duplicatePairs <= 1, `seed ${seed}: at most one town pair with two railways on separate track (${m.duplicatePairs})`);
    multi += m.multiTownLines; reused += m.reusedKm;
    const errs = checkReservations(g);
    check(errs.length === 0, `seed ${seed}: reservations consistent ${errs.slice(0, 2).join('; ')}`);
  }
  check(multi >= 1, `AI lines through 3+ stations (${multi})`);
  check(reused > 0, `AI lines on shared or other companies' track (${fmt(reused, 1)} km)`);

  // ---- 2. open access: a new company runs trains on an AI railway without asking
  {
    const g = flatGame(384, 2);
    const owner = 1, Z = 190;
    const A = stationAt(g, 60, Z, Math.PI / 2, 2, 12, owner)!, B = stationAt(g, 300, Z, Math.PI / 2, 2, 12, owner)!;
    const ea = stationEnds(g, A), eb = stationEnds(g, B);
    check(!!build(g, nodeSnap(g, ea[0].front, 'rail'), nodeSnap(g, eb[0].back, 'rail'), railOpts(owner), 'AI line'), 'AI railway built');
    // the second platforms join the line a little way out (trains pass at the stations)
    stationLoops(g, ea[0].front, ea[1].front, 1, owner);
    stationLoops(g, eb[0].back, eb[1].back, -1, owner);
    const dO = buildRailDepot(g, A, owner, { x: 1, z: 0 });
    const ol = g.lines.create('rail', owner);
    ol.stops = [A.id, B.id];
    g.vehicles.buyTrain(dO, [loco(), coach()], ol.id);
    const nc = g.addAICompany({}, 'Newcomer Rail');
    g.company(nc.id).economy.money = 1e8;
    const ai = g.aiOf(nc.id)!;
    check(g.canUse(nc.id, owner) && !g.hasAccess(nc.id, owner), 'open access: the newcomer may use the AI network without an agreement');
    check(ai.startShare(owner, A.id, B.id), 'the newcomer starts trains on the AI railway');
    g.aiEnabled = true;
    let visits = 0, prev = '';
    const tr = () => g.vehicles.all().find((v) => v.owner === nc.id && v instanceof Train) as Train | undefined;
    for (let k = 0; k < 12; k++) {
      runDays(g, 20, () => { const t = tr(); if (t && t.state === 'loading' && prev !== 'loading') visits++; prev = t?.state ?? ''; });
      if (process.env.NET_DEBUG) {
        const t = tr(), o = g.vehicles.all().find((v) => v.owner === owner) as Train | undefined;
        const pend = (x?: Train) => x?.pending.map((q) => `${q.e}${g.vehicles.getRes(q.e) ? '@' + g.vehicles.getRes(q.e) : ''}`).join(',');
        console.log(`    day ${g.day}: newcomer#${t?.id} ${t?.state} ${t?.status} segs ${t?.segs.map((x) => x.e).join(',')} pend ${pend(t)} | owner#${o?.id} ${o?.state} segs ${o?.segs.map((x) => x.e).join(',')} pend ${pend(o)}`);
        if (k === 11) for (const e of g.world.net.edges.values()) if (e.kind === 'rail') console.log(`      e${e.id} ${e.a}-${e.b} len ${e.len.toFixed(0)} st ${e.station} dep ${e.depot} owner ${e.owner} res ${g.vehicles.getRes(e.id)}`);
      }
    }
    const ag = g.agreement(nc.id, owner);
    console.log(`  open access: newcomer ${ai.log.slice(-2).join(' | ')}; train ${tr()?.status}; agreement ${!!ag}, paid ${fmt(ag?.paidTotal ?? 0, 0)}; requests ${g.requestsBy(nc.id).length}`);
    check(!g.requestsBy(nc.id).length && !g.accessRequests.length, 'no access request was needed');
    check(!!tr() && visits >= 2 && !!ag && (ag?.paidTotal ?? 0) > 0, 'the newcomer\'s train serves the AI stations and pays its share (agreement made on first use)');
  }

  // ---- 3. loop lines: a ring railway (two stations, a loop at each end) and a circular bus line
  {
    const g = flatGame(384);
    const Z0 = 160, Z1 = 220;
    const S1 = stationAt(g, 190, Z0, Math.PI / 2, 1)!, S2 = stationAt(g, 190, Z1, Math.PI / 2, 1)!;
    const e1 = stationEnds(g, S1)[0], e2 = stationEnds(g, S2)[0];
    // east: S1's front (east end) round to S2's front; west likewise (a racetrack)
    const ringOk = !!build(g, nodeSnap(g, e1.front, 'rail'), nodeSnap(g, e2.front, 'rail'), railOpts(PLAYER), 'ring east') && !!build(g, nodeSnap(g, e1.back, 'rail'), nodeSnap(g, e2.back, 'rail'), railOpts(PLAYER), 'ring west');
    check(ringOk, 'ring railway built');
    // a depot on a siding off one of the curves
    let dep = -1;
    for (const e of [...g.world.net.edges.values()].filter((x) => x.kind === 'rail' && x.station < 0)) for (const f of [0.5, 0.3, 0.7]) if (dep < 0) dep = buildDepotOnLine(g, e.id, e.len * f, PLAYER);
    const lp = g.lines.create('rail', PLAYER);
    lp.stops = [S1.id, S2.id];
    g.lines.setLoop(lp.id, true);
    check(g.lines.isLoop(lp) && !g.lines.isLoop({ ...lp, loop: undefined, stops: [1, 2] }), 'loop flag (explicit; two stops out and back by default)');
    const t = dep >= 0 ? g.vehicles.buyTrain(dep, [loco(), coach()], lp.id) as Train : null;
    if (t) {
      let rev = 0, visits: number[] = [];
      const r0 = t.reversed;
      let lastRev = t.reversed;
      runDays(g, 320, () => { if (t.reversed !== lastRev) { rev++; lastRev = t.reversed; } if (t.state === 'loading' && visits[visits.length - 1] !== t.atStation) visits.push(t.atStation); });
      const alternate = visits.every((v, i) => i === 0 || v !== visits[i - 1]);
      console.log(`  rail loop: ${visits.length} stops (${visits.slice(0, 8).join(',')}), reversals ${rev} (first one from the depot allowed), ${t.status}; ${r0}`);
      check(visits.length >= 4 && alternate && rev <= 1, 'a train on a loop line keeps circulating one way (no turning back at the stations)');
    } else console.log('  (no depot for the ring: rail loop skipped)');
  }
  {
    const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'flat', water: 'low', startYear: 1990 });
    g.economy.money = 1e8;
    const T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
    const sites = busStopSites(g, T, PLAYER, 14, 34);
    const ring: number[] = [];
    // four stops round the centre
    const net = g.world.net, q = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2, px = T.x + Math.cos(a) * 16, pz = T.z + Math.sin(a) * 16;
      const ne = net.nearestEdge(px, pz, 10, 'road', (e) => e.depot < 0 && e.len > 4);
      if (!ne) continue;
      net.pointAt(ne.edge, ne.edge.len / 2, q);
      const sid = addBusStop(g, q.x, q.z, PLAYER);
      if (sid >= 0 && !ring.includes(sid)) ring.push(sid);
    }
    void sites;
    if (ring.length >= 3) {
      const bd = roadDepotNear(g, T.x, T.z, PLAYER);
      const bl = g.lines.create('road', PLAYER);
      bl.stops = ring;
      check(g.lines.isLoop(bl), 'a bus line with 3+ different stops runs as a loop');
      const bus = bd >= 0 ? g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, bl.id) : 'no depot';
      if (typeof bus !== 'string') {
        const seq: number[] = [];
        runDays(g, 200, () => { const st = (bus as unknown as { stopIndex: number }).stopIndex; if (seq[seq.length - 1] !== st) seq.push(st); });
        const forward = seq.every((v, i) => i === 0 || v === (seq[i - 1] + 1) % ring.length);
        console.log(`  bus loop: ${ring.length} stops, stop order ${seq.slice(0, 10).join(',')}…, ${bus.status}`);
        check(seq.length >= ring.length + 1 && forward, 'the bus goes round its loop in order');
      } else console.log('  (no bus depot: bus loop skipped)');
    } else console.log(`  (only ${ring.length} bus stops: bus loop skipped)`);
  }

  // ---- 4. signals: a single track with two passing loops and four trains: no deadlock over two years
  {
    const g = flatGame(512);
    const Z = 256;
    const A = stationAt(g, 50, Z, Math.PI / 2, 2, 12)!, B = stationAt(g, 450, Z, Math.PI / 2, 2, 12)!;
    const ea = stationEnds(g, A), eb = stationEnds(g, B);
    // the single track in 50-unit pieces (room for passing loops on some of them)
    let prevNode = ea[0].front, ok = true;
    for (let x = 100; x <= 400 && ok; x += 50) {
      ok = !!build(g, nodeSnap(g, prevNode, 'rail'), free(g, x, Z), railOpts(PLAYER), 'single track');
      const n = [...g.world.net.nodes.values()].find((m) => Math.abs(m.x - x) < 0.05 && Math.abs(m.z - Z) < 0.05);
      if (n) prevNode = n.id; else ok = false;
    }
    ok = ok && !!build(g, nodeSnap(g, prevNode, 'rail'), nodeSnap(g, eb[0].back, 'rail'), railOpts(PLAYER), 'single track end');
    check(ok, 'single track built');
    // the second platforms join the line a little way out (station loops)
    stationLoops(g, ea[0].front, ea[1].front, 1, PLAYER);
    stationLoops(g, eb[0].back, eb[1].back, -1, PLAYER);
    // two passing loops on the open line (trackops: a second track with signals at its ends)
    let loops = 0;
    for (const [x0, x1] of [[150, 250], [250, 350]]) {
      const ids = [...g.world.net.edges.values()].filter((e) => { if (e.kind !== 'rail' || e.station >= 0) return false; const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len / 2, p); return p.x > x0 && p.x < x1 && Math.abs(p.z - Z) < 1; }).map((e) => e.id);
      for (const side of [1, -1] as const) { const pl = planDoubleTrack(g, ids, side, PLAYER); if (pl.ok && !commitDoubleTrack(g, pl).error) { loops++; break; } }
    }
    const auto = (Signals as unknown as { autoSignalLine?: (g: Game, line: number | number[], owner: number, opts?: object) => unknown }).autoSignalLine;
    const dep = buildRailDepot(g, A, PLAYER, { x: 1, z: 0 });
    const line = g.lines.create('rail', PLAYER);
    line.stops = [A.id, B.id];
    if (auto) auto(g, line.id, PLAYER);
    const sigs = [...g.world.net.nodes.values()].filter((n) => n.signal).length;
    const trains = [0, 1, 2, 3].map(() => g.vehicles.buyTrain(dep, [loco(), coach()], line.id)).filter((t): t is Train => t instanceof Train);
    const lastVisit = new Map<number, number>(), visits = new Map<number, number>(), late = new Map<number, number>();
    let maxGap = 0;
    const prev = new Map<number, string>(), d0 = g.day;
    runDays(g, 720, () => {
      for (const t of trains) {
        if (t.state === 'loading' && prev.get(t.id) !== 'loading') {
          visits.set(t.id, (visits.get(t.id) ?? 0) + 1); lastVisit.set(t.id, g.day);
          if (g.day - d0 >= 360) late.set(t.id, (late.get(t.id) ?? 0) + 1);
        }
        prev.set(t.id, t.state);
        maxGap = Math.max(maxGap, g.day - (lastVisit.get(t.id) ?? d0));
      }
    });
    const errs = checkReservations(g);
    console.log(`  signalled single track: ${loops} passing loops, ${sigs} signals${auto ? ' (autoSignalLine)' : ''}, ${trains.length} trains: visits ${trains.map((t) => visits.get(t.id) ?? 0).join('/')}, longest wait between stops ${maxGap} days; ${trains.map((t) => t.status).join(' | ')}`);
    check(loops === 2 && trains.length === 4, 'two passing loops and four trains');
    check(trains.every((t) => (late.get(t.id) ?? 0) >= 2) && maxGap < 200 && errs.length === 0, `no deadlock over two years (every train still serving the stations in the second year: ${trains.map((t) => late.get(t.id) ?? 0).join('/')})`);
  }

  // ---- 5. save round trip; a v2.2 save gets open access
  {
    const g = aiWorld(5, 1);
    while (g.ais.some((a) => a.busy)) g.update(0.25);
    const d = serialize(g);
    const json = JSON.stringify(d);
    const h = deserialize(JSON.parse(json));
    check(JSON.stringify(serialize(h)) === json, 'save round trip exact');
    const old = JSON.parse(json);
    delete old.accessVersion;
    if (old.accessPolicies) old.accessPolicies[PLAYER] = 'ask';
    for (const a of old.ais ?? []) if (a?.config) a.config.accessPolicy = 'auto-approve';
    const o = deserialize(old);
    check(o.accessPolicy(PLAYER) === 'open' && o.ais.every((a) => a.config.accessPolicy === 'open'), 'a v2.2 save: the old default policies become open access');
  }
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}
