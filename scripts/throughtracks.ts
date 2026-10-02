// Through stations: layouts with through tracks, an express train passing a station on its through track while
// local trains stop, inserting a station into a running double-track line, an A-B-C line with B inserted as a
// passing-loop through station, adding through tracks to a station, and the save round trip.
// npx esbuild scripts/throughtracks.ts --bundle --platform=node --format=esm --outfile=$S/throughtracks.mjs && node $S/throughtracks.mjs
import { serialize, deserialize } from '../src/game/save';
import { stationLayout, planStationUpgrade, commitStationUpgrade } from '../src/game/stations';
import type { Station } from '../src/game/stations';
import { finishDoubleTrack, planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { Train } from '../src/game/train';
import type { Game } from '../src/game/game';
import { flatGame, station, endNode, newTrack, loco, depotFor, runTrains, check, fmt, build, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
const lineOf = (g: Game, stops: Station[]) => { const l = g.lines.create('rail', 0); l.stops = stops.map((s) => s.id); return l; };
/** Insert a station into the line at (x, z), retrying while trains are in the way. */
function insert(g: Game, x: number, z: number, o: Parameters<typeof planStationOnTrack>[3]) {
  for (let i = 0; i < 8 * 90; i++) {
    const ne = g.world.net.nearestEdge(x, z, 0.6, 'rail', (e) => e.station < 0);
    if (!ne) return { error: 'no track', station: -1, plan: null };
    const plan = planStationOnTrack(g, ne.edge.id, ne.s, o, 0);
    if (!plan.ok) return { error: plan.error ?? '', station: -1, plan };
    const r = commitStationOnTrack(g, plan);
    if (r.error !== 'busy') return { ...r, plan };
    g.update(0.25);
  }
  return { error: 'busy for 90 days', station: -1, plan: null };
}

// ------------------------------------------------------------------ 1. layouts
{
  console.log('layouts');
  const l22 = stationLayout(2, 2), l11 = stationLayout(1, 1), l42 = stationLayout(4, 2), lo = stationLayout(2, 2, 'outer');
  const show = (l: ReturnType<typeof stationLayout>) => `platform tracks ${l.trackOffsets.map((v) => fmt(v, 2)).join('/')}, through ${l.throughOffsets.map((v) => fmt(v, 2)).join('/')}, platforms ${l.platforms.map((p) => fmt(p.off, 2)).join('/')}, width ${fmt(l.width, 2)}`;
  console.log('  2+2 middle: ' + show(l22));
  console.log('  1+1 middle: ' + show(l11));
  console.log('  4+2 middle: ' + show(l42));
  console.log('  2+2 outer:  ' + show(lo));
  const inner = (l: ReturnType<typeof stationLayout>) => Math.max(...l.throughOffsets.map(Math.abs)) < Math.min(...l.trackOffsets.map(Math.abs));
  check(l22.trackOffsets.length === 2 && l22.throughOffsets.length === 2 && l22.platforms.length === 2 && inner(l22), '2 platform tracks with side platforms around 2 middle through tracks');
  check(l42.trackOffsets.length === 4 && l42.platforms.length === 2 && inner(l42), '4 platform tracks (2 islands) around 2 through tracks');
  check(lo.platforms.length === 1 && Math.min(...lo.throughOffsets.map(Math.abs)) > Math.max(...lo.trackOffsets.map(Math.abs)), "'outer': an island with through tracks outside");
  check(stationLayout(2).throughOffsets.length === 0 && Math.abs(stationLayout(2).width - stationLayout(2, 0, 'outer').width) < 1e-9, 'no through tracks: the island layout as before');
}

// ------------------------------------------------------------------ 2. a station inserted into a running double-track line; express vs local
let saveGame: Game | null = null;
{
  console.log('station inserted into a double-track line, express and local trains');
  const g = flatGame(256);
  const net = g.world.net;
  const A = station(g, 30, 128, Math.PI / 2, 8, 2)!, B = station(g, 226, 128, Math.PI / 2, 8, 2)!;
  const e0 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), 'double line');
  const f = finishDoubleTrack(g, newTrack(g, e0), 0);
  check(!f.error && f.crossovers === 4, `directional double track (${f.signals} signals) ${f.error ?? ''}`);
  const dep = depotFor(g, A, B);
  const local = lineOf(g, [A, B]), express = lineOf(g, [A, B]);
  const loc = [0, 1].map(() => g.vehicles.buyTrain(dep, loco(), local.id) as Train);
  const exp = g.vehicles.buyTrain(dep, loco(), express.id) as Train;
  runTrains(g, [...loc, exp], 90);
  const ins = insert(g, 128, 128, { length: 8, tracks: 2, through: 2 });
  console.log(`  insert: ${ins.error ?? 'ok'}, cost ${fmt((ins.plan?.cost ?? 0) / 1e3, 0)}k, feeds ${ins.plan?.feeds.join(',')}`);
  const X = g.stations.get(ins.station)!;
  check(!ins.error && X && X.rail!.through === 2 && X.rail!.throughEdges.length === 2 && X.rail!.edges.length === 2, 'through station inserted while the trains run (2 platform + 2 through tracks)');
  check(X.rail!.throughEdges.every((id) => net.edges.get(id)!.station === -1) && X.rail!.edges.every((id) => net.edges.get(id)!.station === X.id), 'through tracks are ordinary track, platform tracks are station track');
  local.stops = [A.id, X.id, B.id];
  for (const t of loc) t.onLineChanged();
  g.lines.rebuild();
  let passThrough = 0, passPlatform = 0, passWhileLocalStops = 0, inX = false;
  const arr = new Map<number, number[]>();
  const last = new Map<number, string>();
  let worst = 0;
  const since = new Map<number, number>();
  for (let i = 0; i < 8 * 360; i++) {
    g.update(0.25);
    // passages of the express through X: on a through or a platform track (its head entering X's tracks)
    const hs = exp.segs[exp.headSeg], he = hs ? net.edges.get(hs.e) : undefined;
    const onThrough = !!hs && X.rail!.throughEdges.includes(hs.e), onPlat = !!he && he.station === X.id;
    if ((onThrough || onPlat) && !inX) {
      if (onThrough) passThrough++; else passPlatform++;
      if (onThrough && loc.some((t) => t.state === 'loading' && t.atStation === X.id)) passWhileLocalStops++;
    }
    inX = onThrough || onPlat;
    for (const t of [...loc, exp]) {
      if (t.state === 'loading' && last.get(t.id) !== 'loading') {
        const a = arr.get(t.id) ?? []; a.push(t.atStation); arr.set(t.id, a);
        // locals dwell at X for a while (as with many passengers), so the express catches up with them there
        if (t !== exp && t.atStation === X.id) t.loadTimer = Math.max(t.loadTimer, 30);
      }
      last.set(t.id, t.state);
      if (t.state === 'waiting' || t.state === 'noroute') { if (!since.has(t.id)) since.set(t.id, g.day); worst = Math.max(worst, g.day - since.get(t.id)!); } else since.delete(t.id);
    }
  }
  const atX = loc.map((t) => (arr.get(t.id) ?? []).filter((s) => s === X.id).length);
  console.log(`  1 year: local stops at ${X.name} ${atX.join('/')}; express: ${(arr.get(exp.id) ?? []).length} stops, passed ${X.name} ${passThrough}x on a through track (${passWhileLocalStops}x while a local stood at the platform), ${passPlatform}x on a platform track; worst wait ${worst} days`);
  check(atX.every((n) => n >= 2), 'the local trains stop at the new station');
  check(passThrough >= 3 && passThrough >= 2 * passPlatform && passWhileLocalStops >= 1 && (arr.get(exp.id) ?? []).length >= 4, 'the express passes on the through tracks (also while a local stops) and keeps running');
  check(worst < 25 && [...loc, exp].every((t) => (arr.get(t.id) ?? []).length >= 4), 'no train stuck after the insertion');
  saveGame = g;
}

// ------------------------------------------------------------------ 3. A-B-C: B inserted into a single-track line as a passing loop
{
  console.log('A-B-C line');
  const g = flatGame(256);
  const net = g.world.net;
  const A = station(g, 30, 100, Math.PI / 2, 8, 1)!, C = station(g, 226, 100, Math.PI / 2, 8, 1)!;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(0), 'single line');
  const ins = insert(g, 128, 100, { length: 8, tracks: 2 });
  const B = g.stations.get(ins.station)!;
  console.log(`  insert B: ${ins.error ?? 'ok'}, ${B?.rail?.tracks} platform tracks`);
  check(!ins.error && B && B.rail!.tracks === 2, 'B inserted as a passing loop');
  const dA = depotFor(g, A, C), dC = depotFor(g, C, A);
  const l = lineOf(g, [A, B, C]);
  const t1 = g.vehicles.buyTrain(dA, loco(), l.id) as Train, t2 = g.vehicles.buyTrain(dC, loco(), l.id) as Train;
  t2.stopIndex = 2;
  const r = runTrains(g, [t1, t2], 360);
  const a1 = r.arrivals.get(t1.id) ?? [], a2 = r.arrivals.get(t2.id) ?? [];
  const at = (a: number[], s: Station) => a.filter((x) => x === s.id).length;
  console.log(`  1 year: train 1 at A/B/C ${at(a1, A)}/${at(a1, B)}/${at(a1, C)}, train 2 ${at(a2, A)}/${at(a2, B)}/${at(a2, C)}; worst wait ${r.worst.days} days (${r.worst.kind})`);
  check([A, B, C].every((s) => at(a1, s) >= 1 && at(a2, s) >= 1), 'both trains serve A, B and C');
  check(r.worst.days < 30, 'they pass each other at B (no deadlock)');
  void net;
}

// ------------------------------------------------------------------ 4. adding through tracks to a connected station
{
  console.log('adding through tracks');
  const g = flatGame(256);
  const A = station(g, 40, 128, Math.PI / 2, 8, 2)!, X = station(g, 128, 128, Math.PI / 2, 8, 2)!, B = station(g, 216, 128, Math.PI / 2, 8, 2)!;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, X, 0, false), 'rail'), railOpts(0, 2), 'A-X');
  build(g, nodeSnap(g, endNode(g, X, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), 'X-B');
  const up = planStationUpgrade(g, X.id, { through: 2 });
  console.log(`  plan: ok ${up.ok} ${up.error ?? ''}, keep ${up.keep.join(',')}, cost ${fmt(up.cost / 1e3, 0)}k`);
  const err = up.ok ? commitStationUpgrade(g, up) : up.error;
  const thr = X.rail!.throughEdges.map((id) => g.world.net.edges.get(id)!);
  const ends = g.stations.trackEnds(X, true).filter((t) => t.through);
  const linked = ends.every((t) => [t.front, t.back].every((n) => (g.world.net.nodes.get(n)?.edges.length ?? 0) >= 2));
  check(!err && thr.length === 2 && linked, `2 through tracks added outside the platforms and connected to the line (${err ?? 'ok'})`);
}

// ------------------------------------------------------------------ 5. save round trip
if (saveGame) {
  console.log('save round trip');
  const g = saveGame;
  const pick = (x: Game) => JSON.stringify(x.stations.all().map((s) => s.rail && { tracks: s.rail.tracks, through: s.rail.through, to: s.rail.throughOffsets, te: s.rail.throughEdges, w: s.rail.width, mode: s.rail.throughMode, edges: s.rail.edges }));
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  check(pick(g) === pick(g2), 'through tracks restored exactly');
  for (let i = 0; i < 8 * 30; i++) { g.update(0.25); g2.update(0.25); }
  const sig = (x: Game) => x.vehicles.trains().map((t) => `${t.state}:${fmt(t.headPos, 3)}`).join('|');
  check(sig(g) === sig(g2), 'both copies run alike');
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();
