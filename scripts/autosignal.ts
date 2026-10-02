// Automatic signalling: a single-track line with two passing loops between two 2-platform termini and 4 trains
// (2 game years, no deadlock), a double-track line with a through station (junctions) and 6 trains, idempotence
// and preview = commit.
// npx esbuild scripts/autosignal.ts --bundle --platform=node --format=esm --outfile=$S/autosignal.mjs && node $S/autosignal.mjs
import { autoSignalLine, autoSignalNetwork } from '../src/game/signals';
import { serialize, deserialize } from '../src/game/save';
import { planDoubleTrack, commitDoubleTrack, connectStationThroat, finishDoubleTrack, planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { Train } from '../src/game/train';
import type { Game } from '../src/game/game';
import type { Station } from '../src/game/stations';
import { flatGame, station, endNode, newTrack, loco, depotFor, runTrains, check, fmt, build, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
const lineOf = (g: Game, stops: Station[]) => { const l = g.lines.create('rail', 0); l.stops = stops.map((s) => s.id); return l; };
const sigs = (g: Game) => [...g.world.net.nodes.values()].filter((n) => n.signal).map((n) => `${fmt(n.x, 2)},${fmt(n.z, 2)}:${n.signal}${n.signalKind === 'block' ? 'b' : 'p'}${n.signalPass ? '+' : ''}`).sort();

// ------------------------------------------------------------------ 1. single track, 2 passing loops, 2 termini, 4 trains
{
  console.log('single track with passing loops');
  const g = flatGame(256);
  const net = g.world.net;
  const A = station(g, 20, 128, Math.PI / 2, 8, 2)!, B = station(g, 236, 128, Math.PI / 2, 8, 2)!;
  const e0 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'line');
  const line0 = newTrack(g, e0)[0];
  // the loops: split the line at 70/110 and 146/186, then double those stretches
  const zc = net.nodes.get(endNode(g, A, 0, true))!.z;
  for (const x of [70, 110, 146, 186]) { const ne = net.nearestEdge(x, zc, 0.5, 'rail')!; net.splitEdge(ne.edge.id, ne.s); }
  void line0;
  let loops = 0;
  for (const xm of [90, 166]) {
    const ne = net.nearestEdge(xm, zc, 0.5, 'rail')!;
    const plan = planDoubleTrack(g, [ne.edge.id], 1, 0);
    const r = commitDoubleTrack(g, plan, false);
    if (!r.error) loops++; else console.log('  loop: ' + r.error + ' ' + plan.errors.join('; '));
  }
  check(loops === 2, 'two passing loops');
  for (const st of [A, B]) { const c = connectStationThroat(g, st.id, 0); check(c.connected === 1, `${st.name}: second platform connected to the line (${c.failed.join('; ')})`); }
  const dA = depotFor(g, A, B), dB = depotFor(g, B, A);
  const l = lineOf(g, [A, B]);
  const trains = [dA, dA, dB, dB].map((d) => g.vehicles.buyTrain(d, loco(), l.id) as Train);
  trains[2].stopIndex = 1; trains[3].stopIndex = 1;
  const pre = autoSignalLine(g, l.id, 0, { preview: true });
  const roles = (r: typeof pre) => [...new Set(r.signals.map((q) => q.role))].map((k) => `${k} ${r.signals.filter((q) => q.role === k).length}`).join(', ');
  console.log(`  preview: ${pre.signals.length} signals (${roles(pre)}), cost ${fmt(pre.cost / 1e3, 0)}k ${pre.warnings.join('; ')}`);
  check(pre.signals.filter((q) => q.role === 'loop').length === 8 && pre.signals.filter((q) => q.role === 'starter').length >= 4, 'exit signals at both ends of both loop tracks of each loop, starters at the platforms');
  const before = sigs(g);
  check(before.length === 0, 'preview changed nothing');
  const done1 = autoSignalLine(g, l.id, 0);
  const after = sigs(g);
  const planned = pre.signals.map((q) => `${fmt(q.x, 2)},${fmt(q.z, 2)}`).sort();
  check(done1.placed === pre.placed && after.length === pre.signals.length && after.every((s) => planned.includes(s.split(':')[0])), `the signals placed are the preview's (${after.length})`);
  const again = autoSignalLine(g, l.id, 0, { preview: true });
  const re = autoSignalLine(g, l.id, 0);
  check(again.placed === 0 && again.changed === 0 && re.placed === 0 && re.changed === 0 && JSON.stringify(sigs(g)) === JSON.stringify(after), 'idempotent: running it again changes nothing');
  const r = runTrains(g, trains, 720);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  2 years, 4 trains: arrivals ${counts.join('/')}, worst wait ${r.worst.days} days (${r.worst.kind})`);
  check(counts.every((c) => c >= 8), 'all four trains keep running');
  check(r.worst.days < 40, 'no deadlock (trains wait in the loops)');
}

// ------------------------------------------------------------------ 2. double track with a through station and crossovers, 6 trains
{
  console.log('double track with junctions');
  const g = flatGame(256);
  const net = g.world.net;
  const A = station(g, 30, 128, Math.PI / 2, 8, 2)!, B = station(g, 226, 128, Math.PI / 2, 8, 2)!;
  const e0 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), 'double line');
  finishDoubleTrack(g, newTrack(g, e0), 0);
  const ne = net.nearestEdge(128, 128, 0.6, 'rail')!;
  const ins = commitStationOnTrack(g, planStationOnTrack(g, ne.edge.id, ne.s, { tracks: 2, through: 2 }, 0));
  const X = g.stations.get(ins.station)!;
  check(!ins.error && !!X, `through station inserted (${ins.error ?? 'ok'})`);
  const dep = depotFor(g, A, B);
  const local = lineOf(g, [A, X, B]), express = lineOf(g, [A, B]);
  const trains = [...[0, 1, 2, 3].map(() => g.vehicles.buyTrain(dep, loco(), local.id) as Train), ...[0, 1].map(() => g.vehicles.buyTrain(dep, loco(), express.id) as Train)];
  const pre = autoSignalNetwork(g, 0, { preview: true });
  const res = autoSignalNetwork(g, 0);
  console.log(`  network: ${pre.signals.length} signals planned (${pre.placed} new, ${pre.changed} changed), placed ${res.placed}, changed ${res.changed}; ${res.warnings.join('; ')}`);
  check(res.placed === pre.placed && res.changed === pre.changed, 'preview matches commit');
  const again = autoSignalNetwork(g, 0, { preview: true });
  check(again.placed === 0 && again.changed === 0, 'idempotent');
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  check(JSON.stringify(sigs(g2)) === JSON.stringify(sigs(g)) && sigs(g).some((x) => x.includes('b')) && sigs(g).some((x) => x.includes('+')), 'signal kinds (block / path, passable) restored from a save');
  const r = runTrains(g, trains, 720);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  2 years, 6 trains: arrivals ${counts.join('/')}, left the depot ${r.left.join('/')}, worst wait ${r.worst.days} days (${r.worst.kind})`);
  check(counts.every((c) => c >= 6) && r.worst.days < 30, 'all six trains keep running, no deadlock');
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();
