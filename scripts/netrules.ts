// Network rules: lifting a running line onto a viaduct in place (with its station, ramps, crossings grade-
// separated), crossovers right outside every station (=====x==[station]==x=====) with through trains running
// freely and mid-line crossovers tidied away, and bus stops shared between lines and companies.
// npx esbuild scripts/netrules.ts --bundle --platform=node --format=esm --outfile=$S/netrules.mjs && node $S/netrules.mjs
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { mergeStops } from '../src/game/stations';
import type { Station } from '../src/game/stations';
import { finishDoubleTrack, planRelevel, commitRelevel, normaliseCrossovers, planConnection, commitConnection } from '../src/game/trackops';
import { autoSignalLine, autoSignalNetwork } from '../src/game/signals';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { TRACK_TYPES } from '../src/game/constants';
import { roadOpts, roadDepotNear } from './lib';
import { flatGame, station, endNode, newTrack, loco, depotFor, runTrains, check, fmt, build, free, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
const PI2 = Math.PI / 2;
const road = (g: Game, x0: number, z0: number, x1: number, z1: number, owner = 0) => build(g, free(g, x0, z0), free(g, x1, z1), roadOpts(owner, 'road'), 'road');
const lineOf = (g: Game, stops: Station[], owner = 0, kind: 'rail' | 'road' = 'rail') => {
  const l = g.lines.create(kind, owner);
  const ids = stops.map((s) => s.id);
  l.stops = [...ids, ...ids.slice(1, -1).reverse()];
  g.lines.rebuild();
  return l;
};
/** A double track between consecutive stations (track-0 ends; the build takes both tracks). */
function doubleLine(g: Game, sts: Station[]): number[] {
  const net = g.world.net, e0 = net.nextEdge;
  for (let i = 0; i + 1 < sts.length; i++) build(g, nodeSnap(g, endNode(g, sts[i], 0, true), 'rail'), nodeSnap(g, endNode(g, sts[i + 1], 0, false), 'rail'), railOpts(0, 2), `double ${i}`);
  return newTrack(g, e0);
}
/** Crossover legs: plain edges joining two switches, not running along the axis (z changes). */
const legs = (g: Game) => [...g.world.net.edges.values()].filter((e) => {
  if (e.kind !== 'rail' || e.station >= 0 || e.depot >= 0) return false;
  const a = g.world.net.nodes.get(e.a)!, b = g.world.net.nodes.get(e.b)!;
  return a.edges.length >= 3 && b.edges.length >= 3 && Math.abs(a.z - b.z) > 0.3;
});

// ------------------------------------------------------------------ 1. lifting a running line onto a viaduct
{
  console.log('lifting a line in place');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 10, 117, 246, 117);
  const A = station(g, 30, 123, PI2, 10, 2)!, M = station(g, 128, 123, PI2, 10, 2)!, B = station(g, 226, 123, PI2, 10, 2)!;
  const tr = doubleLine(g, [A, M, B]);
  const f = finishDoubleTrack(g, tr, 0);
  check(!f.error, `double track, directional (${f.crossovers} crossovers)`);
  // a street across the line beside the middle station: a level crossing for now
  road(g, 100, 105, 100, 140);
  const lc = [...net.crossings.values()].filter((c) => c.kind === 'level').length;
  check(lc >= 2, `level crossings on the street (${lc})`);
  const dep = depotFor(g, A, B);
  const l = lineOf(g, [A, M, B]);
  const trains = [0, 1, 2].map(() => g.vehicles.buyTrain(dep, loco(), l.id) as Train);
  autoSignalLine(g, l.id, 0);
  const r0 = runTrains(g, trains, 90);
  // the middle of the line (the station, its crossovers and the street crossing) goes up
  const p = { x: 0, y: 0, z: 0 };
  const stretch = [...net.edges.values()].filter((e) => { if (e.kind !== 'rail' || e.owner !== 0 || e.depot >= 0) return false; net.pointAt(e, e.len / 2, p); return p.x > 52 && p.x < 204; }).map((e) => e.id);
  const pl = planRelevel(g, stretch, 'elevated', 0);
  console.log(`  plan: ${pl.ok ? 'ok' : pl.error}, cost ${fmt(pl.cost / 1e6, 2)}M, ${pl.edges.length} edges, stations ${pl.stations.length}, crossings ${pl.crossings.length}, ramps ${pl.ramps.map((x) => fmt(x * 10, 0) + ' m').join(', ')}`);
  check(pl.ok && pl.stations.length === 1 && pl.crossings.length >= 2 && pl.ramps.length >= 2, 'planned: the station with it, the street crossings grade-separated, ramps at both ends');
  let err: string | null = 'busy', waited = 0;
  for (; waited < 600 && err === 'busy'; waited++) { err = commitRelevel(g, pl); if (err === 'busy') g.update(0.25); }
  console.log(`  lifted after ${fmt(waited / 8, 1)} days: ${err ?? 'ok'}`);
  check(!err, 'lifted (when no train was on the stretch)');
  check(M.rail!.level === 'elevated' && M.rail!.piers.length > 0 && M.rail!.edges.every((id) => net.edges.get(id)!.sections.some((s) => s.type === 'bridge')), 'the station is elevated in place (viaduct deck and piers), same tracks');
  check(![...net.crossings.values()].some((c) => stretch.includes(c.e1) || stretch.includes(c.e2)), 'the street passes under: no level crossings left on the stretch');
  const mid = stretch.map((id) => net.edges.get(id)!).filter((e) => { net.pointAt(e, e.len / 2, p); return Math.abs(p.x - 128) < 30; });
  check(mid.every((e) => e.sections.some((s) => s.type === 'bridge')), 'the middle of the stretch on viaduct');
  let steep = 0;
  for (const id of stretch) { const e = net.edges.get(id); if (!e) continue; for (let i = 1; i < e.prof.length; i++) steep = Math.max(steep, Math.abs(e.prof[i] - e.prof[i - 1])); }
  check(steep <= TRACK_TYPES.standard.maxGrade * 1.05 + 0.01, `ramps within the grade (${fmt(steep * 100, 1)}%)`);
  const r1 = runTrains(g, trains, 240);
  const counts = trains.map((t) => r1.arrivals.get(t.id)?.length ?? 0);
  const atM = trains.reduce((n, t) => n + (r1.arrivals.get(t.id) ?? []).filter((x) => x === M.id).length, 0);
  console.log(`  before: ${trains.map((t) => r0.arrivals.get(t.id)?.length ?? 0).join('/')} in 90 days; after: ${counts.join('/')} in 240 days (${atM} at the elevated station), worst wait ${r1.worst.days} days (${r1.worst.kind})`);
  check(counts.every((c) => c >= 3) && atM >= 3 && r1.worst.days < 35, 'the line keeps running over the viaduct');
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const sig = (x: Game) => JSON.stringify([x.stations.get(M.id)!.rail!.level, x.stations.get(M.id)!.rail!.y, stretch.map((id) => x.world.net.edges.get(id)?.sections)]);
  check(sig(g2) === sig(g), 'save round trip of the lifted line');
}

// ------------------------------------------------------------------ 2. crossovers right outside every station
{
  console.log('crossovers at the stations');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 10, 117, 246, 117);
  const A = station(g, 26, 123, PI2, 10, 2)!, X = station(g, 96, 123, PI2, 10, 2)!, Y = station(g, 160, 123, PI2, 10, 2)!, B = station(g, 230, 123, PI2, 10, 2)!;
  const tr = doubleLine(g, [A, X, Y, B]);
  const f = finishDoubleTrack(g, tr, 0);
  const ends = [A, X, Y, B].flatMap((s) => [s.rail!.x - s.rail!.length / 2, s.rail!.x + s.rail!.length / 2]);
  const lx = legs(g).map((e) => (net.nodes.get(e.a)!.x + net.nodes.get(e.b)!.x) / 2);
  const far = lx.filter((x) => !ends.some((u) => Math.abs(u - x) < 26));
  console.log(`  ${f.crossovers} crossovers (${lx.map((x) => fmt(x, 0)).join(', ')}), ${f.signals} signals ${f.error ?? ''}`);
  check(!f.error && f.crossovers === 12 && far.length === 0, '=====x==[station]==x=====: a pair right outside both ends of X and Y and before A and B, none between');
  // no one-way signal inside a crossover zone, a path signal before each zone
  const zoneNodes = new Set(legs(g).flatMap((e) => [e.a, e.b]));
  const inZone = [...net.nodes.values()].filter((n) => n.signal >= 2 && !n.signalPass && [...zoneNodes].some((z) => { const m = net.nodes.get(z)!; return Math.abs(m.x - n.x) < 0.8 && Math.abs(m.z - n.z) < 0.8; }));
  check(inZone.length === 0, 'no one-way signal within a crossover');
  // a mid-line crossover (built by hand) is tidied away
  const na = net.nearestEdge(124, 122.51, 0.4, 'rail'), nb = net.nearestEdge(134, 123.49, 0.4, 'rail');
  const pc = na && nb ? planConnection(g, na.edge.id, na.s, nb.edge.id, nb.s, 0, { search: 4 }) : null;
  if (pc && !pc.ok) console.log(`  mid-line connection: ${pc.error}`);
  const cc = pc && pc.ok ? commitConnection(g, pc, { signals: false }) : { error: pc?.error ?? 'no track found', edges: [], signals: 0 };
  check(!cc.error, `a crossover in the middle of the line, by hand (${cc.error ?? 'ok'})`);
  const before = legs(g).length;
  const nf = normaliseCrossovers(g, [...net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0 && e.depot < 0).map((e) => e.id), 0);
  const lx2 = legs(g).map((e) => (net.nodes.get(e.a)!.x + net.nodes.get(e.b)!.x) / 2);
  console.log(`  normalised: ${nf.removed ?? 0} removed, ${nf.crossovers} laid, legs ${before} -> ${lx2.length} ${nf.error ?? ''}`);
  check((nf.removed ?? 0) >= 1 && !lx2.some((x) => !ends.some((u) => Math.abs(u - x) < 26)) && lx2.length >= 12, 'normalised: the mid-line crossover is gone, the station ones stay');
  // locals stop everywhere, expresses run A - B through X and Y: both keep moving
  const dA = depotFor(g, A, B);
  const local = lineOf(g, [A, X, Y, B]);
  const exp = g.lines.create('rail', 0); exp.stops = [A.id, B.id]; g.lines.rebuild();
  const trains = [...[0, 1].map(() => g.vehicles.buyTrain(dA, loco(), local.id) as Train), ...[0, 1].map(() => g.vehicles.buyTrain(dA, loco(), exp.id) as Train)];
  autoSignalNetwork(g, 0);
  const r = runTrains(g, trains, 360);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  1 year: locals ${counts.slice(0, 2).join('/')}, expresses ${counts.slice(2).join('/')}, worst wait ${r.worst.days} days (${r.worst.kind})`);
  check(counts.every((c) => c >= 4) && r.worst.days < 30, 'locals and through trains keep running');
}

// ------------------------------------------------------------------ 3. shared bus stops
{
  console.log('shared bus stops');
  const g = Game.create({ size: 192, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000, aiCompanies: 1, aiConfigs: [{ risk: 0.5 }] });
  g.aiEnabled = false;
  const w = g.world;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
  w.heightsVersion++;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  g.company(0).economy.money = 1e8; g.company(1).economy.money = 1e8;
  g.setAccessPolicy(0, 'open'); g.setAccessPolicy(1, 'open');
  road(g, 20, 96, 172, 96);
  const S = g.stations;
  const n0 = S.nextId;
  check(!S.commitBusStop(60, 96, 0), 'company 0 builds a stop');
  const stop = S.get(n0)!;
  const share = S.planBusStop(64, 96.2, 1, { share: true });
  check(share.ok && share.reuse === stop.id && share.cost === 0, `company 1 shares it instead of building one next to it (${share.reuse})`);
  const count0 = S.all().length;
  check(!S.commitBusStop(64, 96.2, 1, { share: true }) && S.all().length === count0, 'nothing new built');
  const n1 = S.nextId;
  check(!S.commitBusStop(140, 96, 1), 'company 1 builds its own stop at the other end');
  const t1 = S.get(n1)!;
  // both companies' bus lines call at the shared stop
  const own = g.lines.create('road', 0); own.stops = [stop.id, t1.id]; g.lines.rebuild();
  const theirs = g.lines.create('road', 1); theirs.stops = [t1.id, stop.id]; g.lines.rebuild();
  const d0 = roadDepotNear(g, 100, 99, 0), d1 = roadDepotNear(g, 120, 99, 1);
  const bus = MODEL_BY_ID.get('bus_d') ?? MODEL_BY_ID.get('bus_c')!;
  const b0 = g.vehicles.buyRoad(d0, bus, own.id), b1 = g.vehicles.buyRoad(d1, bus, theirs.id);
  check(typeof b0 === 'object' && typeof b1 === 'object', `a bus each (${typeof b0 === 'string' ? b0 : ''}${typeof b1 === 'string' ? b1 : ''})`);
  const m1 = g.company(1).economy.money;
  for (let d = 0; d < 75; d++) for (let k = 0; k < 8; k++) g.update(0.25);
  const ag = g.agreement(1, 0);
  console.log(`  after 75 days: agreement ${!!ag}, company 1 paid ${fmt(ag?.paidTotal ?? 0, 0)} for the shared stop`);
  check(!!ag && (ag.paidTotal ?? 0) > 0, 'company 1 pays its share of the stop\'s upkeep (by use, like track access)');
  void m1;
  // two adjacent stops of one company become one station with one stop
  const pA = S.nextId; S.commitBusStop(90, 96, 0);
  const pB = S.nextId; S.commitBusStop(96, 96, 0);
  const sa = S.get(pA)!, sb = S.get(pB)!;
  check(!!sa && !!sb && sa !== sb, 'two separate stops 60 m apart');
  const before = g.stationMaintenance(sa) + g.stationMaintenance(sb);
  const ms = mergeStops(g, pA, pB);
  console.log(`  merged: ${ms.error ?? 'ok'}, ${ms.removedStops} stop removed, upkeep ${fmt(before / 1e3, 1)}k -> ${fmt(g.stationMaintenance(sa) / 1e3, 1)}k`);
  check(!ms.error && !S.get(pB) && sa.stops.length === 1 && g.stationMaintenance(sa) < before, 'merged into one station with one stop: less upkeep');
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();
