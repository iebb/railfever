// Tram test: tram tracks laid along streets through the biggest town (roadPath + addTramTracks), stops on
// them, a tram depot and trams of the era on a tram line (out and back). Checks: trams serve every stop,
// carry passengers, never leave usable tram tracks, buses can share the stops, track removal and
// bulldozing respect trams and owners, save/load round trip stays exact, and the AI TramPlanner builds
// a working tram line (and cleans up an abandoned one).
// npx esbuild scripts/tram.ts --bundle --platform=node --format=esm --outfile=$S/tram.mjs && node $S/tram.mjs [seed]
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID, availableModels } from '../src/game/vehicle-types';
import { addTramTracks, removeTramTracks, roadPath, bulldoze, tramUsable, depotSize } from '../src/game/build-ops';
import { TramPlanner, pickTram, pathPoints, tramStopSites, tramDepotGen } from '../src/game/ai-tram';
import { runGen } from '../src/game/routing';
import { RoadVehicle, roadDepotReaches } from '../src/game/roadvehicle';
import { TRAM } from '../src/game/constants';
import { fails, check, fmt, addBusStop, roadDepotNear, checkReservations, checkNaN } from './lib';

const seed = Number(process.argv[2] ?? 7);
const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1990 });
g.economy.money = 50_000_000;
const net = g.world.net;
const T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
console.log(`tram town ${T.name}: pop ${T.pop}, radius ${fmt(T.radius, 0)}; trams in ${g.year}: ${availableModels(g.year, 'tram').map((m) => m.id).join(', ')}`);

// ---- 1. tracks along a street path through the centre
let edges: number[] | null = null;
for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) {
  const ux = Math.cos(a + (T.grid?.angle ?? 0)), uz = Math.sin(a + (T.grid?.angle ?? 0));
  const end = (sg: number) => { for (let f = 1; f > 0.4; f -= 0.1) { const ne = net.nearestEdge(T.x + ux * sg * 28 * f, T.z + uz * sg * 28 * f, 6, 'road', (e) => e.type === 'street' && e.depot < 0); if (ne) { const q = { x: 0, y: 0, z: 0 }; net.pointAt(ne.edge, ne.s, q); return q; } } return null; };
  const A = end(-1), B = end(1);
  if (!A || !B) continue;
  edges = roadPath(g, A.x, A.z, B.x, B.z);
  if (edges && edges.length >= 3) break;
}
check(edges && edges.length >= 3, 'street path through the centre');
if (!edges) process.exit(1);
const dry = addTramTracks(g, edges, 0, true);
const money0 = g.economy.money;
const tr = addTramTracks(g, edges, 0);
let len = 0;
for (const id of edges) len += net.edges.get(id)!.len;
console.log(`tracks: ${edges.length} edges, ${fmt(len, 0)} u, cost ${fmt(tr.cost / 1e3, 0)}k (dry run ${fmt(dry.cost / 1e3, 0)}k), error ${tr.error}`);
check(tr.changed === edges.length && Math.abs(tr.cost - dry.cost) < 1 && Math.abs(money0 - g.economy.money - tr.cost) < 1, 'tracks laid for the planned cost');
check(Math.abs(tr.cost - len * TRAM.costPerUnit) < 2, 'tram track cost per unit');
check(edges.every((id) => { const e = net.edges.get(id)!; return e.tram === true && e.tramOwner === 0; }), 'edges carry tracks owned by the player');
check(addTramTracks(g, edges, 0).changed === 0, 'tracks are not laid twice');

// ---- 2. stops, a tram depot, trams on a tram line
const pts = pathPoints(g, edges);
const sites = tramStopSites(g, pts, 0);
const stations: number[] = [];
for (const s of sites) { const id = addBusStop(g, s.x, s.z, 0); if (id > 0 && !stations.includes(id)) stations.push(id); }
console.log(`stops: ${stations.length} stations along ${pts.length - 1} u`);
check(stations.length >= 3, 'three or more tram stops');
check(stations.every((id) => g.stations.tramStops(g.stations.get(id)!, 0).length > 0), 'every station has a stop on the tram tracks');
const dep = runGen(tramDepotGen(g, pts, stations, 0));
const dp = g.depots.get(dep);
check(dp && dp.kind === 'tram', 'tram depot built');
if (dp) {
  const stub = net.edges.get(dp.edge)!;
  console.log(`depot ${dep} at ${fmt(dp.x)},${fmt(dp.z)} (size ${JSON.stringify(depotSize('tram'))}); stub tram ${stub.tram}`);
  check(stub.tram && stub.tramOwner === 0 && stub.kind === 'road', 'depot stub carries tram tracks');
  check(roadDepotReaches(g, dp, stations[0]), 'the depot reaches the line');
}
const line = g.lines.create('tram', 0);
line.stops = [...stations, ...stations.slice(1, -1).reverse()];
const model = pickTram(g.year, T.pop)!;
const trams: RoadVehicle[] = [];
for (let i = 0; i < 3; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (v instanceof RoadVehicle) trams.push(v); }
console.log(`line ${line.name}: ${line.stops.length} stops, ${trams.length} x ${model.name} (${model.length} u, ${model.sections} sections)`);
check(trams.length === 3 && trams.every((t) => t.isTram), 'trams bought');
check(typeof g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_c')!, line.id) === 'string', 'no buses from a tram depot');
const busDepot = dp ? roadDepotNear(g, dp.x, dp.z, 0) : -1;
check(typeof g.vehicles.buyRoad(busDepot, model, null) === 'string', 'no trams from a bus depot');
// a bus line sharing the tram stops
let bus: RoadVehicle | null = null;
if (busDepot > 0) {
  const bl = g.lines.create('road', 0);
  bl.stops = [stations[0], stations[stations.length - 1]];
  const b = g.vehicles.buyRoad(busDepot, MODEL_BY_ID.get('bus_c')!, bl.id);
  if (b instanceof RoadVehicle) bus = b;
}

// ---- 3. run: trams stay on usable tracks and serve every stop
const visits = new Map<number, number>();
const last = new Map<number, string>();
let offTrack = 0, ticks = 0, busVisits = 0, lastBus = '';
const run = (days: number) => {
  const d0 = g.day;
  while (g.day < d0 + days) {
    g.update(0.25);
    ticks++;
    for (const t of trams) {
      if (t.seg) {
        const e = net.edges.get(t.seg.e);
        const prev = t.seg.kind === 'conn' ? net.edges.get(t.seg.from) : e;
        if (!e || !tramUsable(g, e, 0) || !prev || !tramUsable(g, prev, 0)) offTrack++;
      }
      if (t.state === 'loading' && last.get(t.id) !== 'loading') { const st = t.targetStation(); if (st) visits.set(st.id, (visits.get(st.id) ?? 0) + 1); }
      last.set(t.id, t.state);
    }
    if (bus) { if (bus.state === 'loading' && lastBus !== 'loading') busVisits++; lastBus = bus.state; }
  }
};
run(240);
console.log(`after 240 days: visits ${stations.map((s) => visits.get(s) ?? 0).join('/')}, delivered ${trams.map((t) => t.delivered).join('/')}, states ${trams.map((t) => t.state).join('/')}, bus stops ${busVisits}`);
check(offTrack === 0, `trams kept to tram tracks (${offTrack} ticks off)`);
check(stations.every((s) => (visits.get(s) ?? 0) >= 2), 'trams served every stop');
check(trams.reduce((a, t) => a + t.delivered, 0) > 0, 'trams carried passengers');
check(!bus || busVisits >= 2, `a bus shares the tram stops (${busVisits} stops)`);

// ---- 4. track removal and bulldozing respect trams and owners
const onTrack = trams.find((t) => t.seg && t.seg.kind === 'lane' && t.state === 'running');
if (onTrack) {
  const r = removeTramTracks(g, [onTrack.seg!.e], 0, true);
  check(r.error === 'Tram in the way' && r.changed === 0, 'no removal under a tram');
}
// (the depot link may have split path edges: use the current ones)
const myTrack = () => [...net.edges.values()].filter((e) => e.tram && e.tramOwner === 0 && e.depot < 0 && e.len > 2);
const e0 = myTrack()[Math.floor(myTrack().length / 2)];
const p0 = { x: 0, y: 0, z: 0 };
net.pointAt(e0, e0.len / 2, p0);
const bz = bulldoze(g, p0.x, p0.z, p0.x, p0.z, 1, true);
check(bz.error !== null && bz.changed === 0, `another company cannot bulldoze the tram road (${bz.error})`);
check(removeTramTracks(g, [e0.id], 1, true).error === 'Tram tracks of another company', 'another company cannot take up the tracks');
// splitting a tram edge (a junction) keeps the tracks on both halves
{
  const target = myTrack()[0];
  const r = net.splitEdge(target.id, target.len / 2);
  check(r && r.e1.tram && r.e2.tram && r.e1.tramOwner === 0 && r.e2.tramOwner === 0, 'split edges keep their tram tracks');
  g.onNetworkChanged();
}
run(60);
check(offTrack === 0, 'still on tracks after the split');

// ---- 5. save / load round trip
const json = JSON.stringify(serialize(g));
const g2 = deserialize(JSON.parse(json));
const json2 = JSON.stringify(serialize(g2));
check(json === json2, `re-serialized save identical (${json.length} chars)`);
const sig = (x: Game) => JSON.stringify({ m: Math.round(x.economy.money), d: x.vehicles.all().map((v) => v.delivered), p: x.vehicles.roads().filter((v) => v.isTram).map((v) => { const q = { x: 0, y: 0, z: 0 }; v.worldPos(q); return fmt(q.x, 3) + ',' + fmt(q.z, 3); }) });
const trEdges = (x: Game) => [...x.world.net.edges.values()].filter((e) => e.tram).length;
check(trEdges(g) === trEdges(g2) && g2.depots.get(dep)?.kind === 'tram' && g2.lines.get(line.id)?.kind === 'tram', 'tram edges, depot and line restored');
for (let i = 0; i < 4 * 90; i++) { g.update(0.25); g2.update(0.25); }
check(sig(g) === sig(g2), 'loaded game runs exactly alike');
check(checkReservations(g2).length === 0 && !checkNaN(g2), 'loaded game consistent');

// ---- 6. the AI tram planner
{
  const h = Game.create({ size: 384, seed: seed + 4, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1965, aiCompanies: 1 });
  h.aiEnabled = false;
  const co = h.ais[0].companyId;
  h.company(co).economy.money = 20_000_000;
  const P = new TramPlanner(h, co);
  check(P.available(), 'AI: tram project available');
  const t0 = performance.now();
  let res: string = P.start() ? 'running' : 'not started';
  let units = 0, maxMs = 0;
  while (res === 'running' && units < 2000) { const t = performance.now(); res = P.step(1); units++; maxMs = Math.max(maxMs, performance.now() - t); }
  const ms = performance.now() - t0;
  const tl = h.lines.all().find((l) => l.owner === co && l.kind === 'tram');
  console.log(`AI: ${res} (${P.status}) in ${units} units, ${fmt(ms, 0)} ms (max unit ${fmt(maxMs, 1)} ms); line ${tl?.name} stops ${tl?.stops.length}, trams ${tl?.vehicles.length}, track ${[...h.world.net.edges.values()].filter((e) => e.tram && e.tramOwner === co).length} edges`);
  check(res === 'done' && tl && tl.vehicles.length >= 2, 'AI built a tram line with trams');
  check(maxMs < 25, `AI work units stay small (${fmt(maxMs, 1)} ms)`);
  const d0 = h.day;
  while (h.day < d0 + 200) h.update(0.25);
  const delivered = (tl?.vehicles ?? []).reduce((a, id) => a + (h.vehicles.get(id)?.delivered ?? 0), 0);
  console.log(`AI trams after 200 days: delivered ${delivered}, states ${(tl?.vehicles ?? []).map((id) => h.vehicles.get(id)?.state).join('/')}`);
  check(delivered > 0, 'AI trams carry passengers');
  // an abandoned project is cleaned up completely
  const before = { tram: [...h.world.net.edges.values()].filter((e) => e.tram && e.tramOwner === co).length, st: h.stations.all().filter((s) => s.owner === co).length, dp: h.depots.all().filter((d) => d.owner === co).length, lines: h.lines.all().filter((l) => l.owner === co).length };
  const Q = new TramPlanner(h, co);
  TramPlanner.minPop = 800;
  if (Q.start()) {
    // stop half-way: tracks and a couple of stops built, no line yet
    for (let i = 0; i < 200 && Q.step(1) === 'running'; i++) if ((Q.project?.stations.length ?? 0) + (Q.project?.stops.length ?? 0) >= 2) break;
    console.log(`interrupted project: ${JSON.stringify(Q.record())}`);
    Q.cleanup();
    const after = { tram: [...h.world.net.edges.values()].filter((e) => e.tram && e.tramOwner === co).length, st: h.stations.all().filter((s) => s.owner === co).length, dp: h.depots.all().filter((d) => d.owner === co).length, lines: h.lines.all().filter((l) => l.owner === co).length };
    console.log(`cleanup: before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`);
    check(JSON.stringify(before) === JSON.stringify(after), 'abandoned AI tram project removed');
  }
  TramPlanner.minPop = 2500;
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
