// Signals and double track: setSignal semantics, autoSignals spacing, a directional double track between two
// 2-platform stations (crossovers + one-way block signals; 3 trains each way for 2 years), doubling a single
// track with a tunnel and a bridge (2 trains in opposite directions), bridges at a station throat (every platform
// reachable from both tracks), save round trip and moving a depot.
// npx esbuild scripts/double.ts --bundle --platform=node --format=esm --outfile=$S/double.mjs && node $S/double.mjs
import { serialize, deserialize } from '../src/game/save';
import { setSignal, autoSignals, signalsAlong, clearSignalsAlong } from '../src/game/signals';
import { planDoubleTrack, commitDoubleTrack, finishDoubleTrack, relocateDepot } from '../src/game/trackops';
import { Train, railNext } from '../src/game/train';
import type { Game } from '../src/game/game';
import type { Station } from '../src/game/stations';
import { checkReservations } from './lib';
import { flatGame, station, endNode, newTrack, loco, depotFor, runTrains, reach, check, fmt, build, free, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();

// ------------------------------------------------------------------ 1. setSignal semantics
{
  console.log('setSignal');
  const g = flatGame(192);
  const net = g.world.net;
  build(g, free(g, 30, 96), free(g, 150, 96), railOpts(0), 'straight');
  const e = [...net.edges.values()][0];
  check(!setSignal(g, e.id, 40, 'oneway', true, 0), 'one-way signal placed mid-edge');
  const n = [...net.nodes.values()].find((x) => x.signal)!;
  const [e1, e2] = n.edges.map((id) => net.edges.get(id)!).sort((p, q) => (p.a === n.id ? 1 : 0) - (q.a === n.id ? 1 : 0));
  // e1 ends at the signal node, e2 starts there (the halves of the original edge, travelled +s)
  const pass = (a: typeof e1, d: number, b: typeof e1) => railNext(g, a, d, 0).some((c) => c.edge.id === b.id);
  check(pass(e1, 1, e2) && !pass(e2, -1, e1), 'forward one-way: trains in +s pass, trains in -s do not');
  check(!setSignal(g, e2.id, 0.1, 'oneway', false, 0) && pass(e2, -1, e1) && !pass(e1, 1, e2), 'set on the node from the other edge, backward: reversed');
  check(!setSignal(g, e1.id, e1.len, 'twoway', true, 0) && pass(e1, 1, e2) && pass(e2, -1, e1), 'two-way: both pass');
  const m0 = g.economy.money;
  check(!setSignal(g, e1.id, e1.len - 0.2, 'none', true, 0) && n.signal === 0 && g.economy.money === m0, 'removed (free)');
  check(setSignal(g, e1.id, 0.2, 'oneway', true, 0) !== null, 'refused at a dead end');
}

// ------------------------------------------------------------------ 2. autoSignals spacing
{
  console.log('autoSignals');
  const g = flatGame(256);
  const net = g.world.net;
  build(g, free(g, 20, 128), free(g, 230, 128), railOpts(0), 'long straight');
  const e = [...net.edges.values()][0];
  const lay = signalsAlong(g, e.id, 1, 50, 0);
  console.log(`  preview: ${lay.spots.length} spots at ${lay.spots.map((s) => fmt(s.at, 0)).join(',')}, stop ${lay.stop}, cost ${lay.cost}`);
  check(lay.spots.length === 4 && lay.stop === 'end', 'preview: signals at 50, 100, 150, 200 (none on the dead ends)');
  const r = autoSignals(g, e.id, 1, 50, 0);
  check(r.placed === 4 && r.cost === 4 * 9000 && !r.error, `placed 4 for 36k (got ${r.placed}, ${r.cost}, ${r.error ?? ''})`);
  const sig = [...net.nodes.values()].filter((n) => n.signal).sort((a, b) => a.x - b.x);
  const gaps = sig.slice(1).map((n, i) => n.x - sig[i].x);
  check(gaps.every((d) => Math.abs(d - 50) < 0.6), `spacing 50 (${gaps.map((d) => fmt(d)).join(',')})`);
  check(sig.every((n) => n.signal === 2 || n.signal === 3), 'all one-way');
  // trains may run eastwards only
  const west = [...net.edges.values()].sort((a, b) => Math.min(net.nodes.get(a.a)!.x, net.nodes.get(a.b)!.x) - Math.min(net.nodes.get(b.a)!.x, net.nodes.get(b.b)!.x));
  const eastDir = (ed: typeof e) => (net.nodes.get(ed.b)!.x > net.nodes.get(ed.a)!.x ? 1 : -1);
  check(reach(g, west[0], eastDir(west[0])).size === west.length && reach(g, west[west.length - 1], -eastDir(west[west.length - 1])).size === 1, 'one-way eastwards along the whole line');
  const c = clearSignalsAlong(g, west[0].id, eastDir(west[0]), 0);
  check(c.removed === 4 && ![...net.nodes.values()].some((n) => n.signal), 'cleared');
  const r2 = autoSignals(g, west[1].id, eastDir(west[1]), 30, 0, 70, { s0: 5, kind: 'twoway' });
  check(r2.placed === 3 && r2.stop === 'length', `from s0 for 70 units every 30: 3 two-way (got ${r2.placed}, ${r2.stop})`);
}

// ------------------------------------------------------------------ helpers for the train tests
function line(g: Game, stops: Station[], dep: number, n: number): Train[] {
  const l = g.lines.create('rail', 0);
  l.stops = stops.map((s) => s.id);
  const out: Train[] = [];
  for (let i = 0; i < n; i++) { const t = g.vehicles.buyTrain(dep, loco(), l.id); if (typeof t !== 'string') out.push(t); }
  return out;
}
/**
 * Every platform of `st` is reachable from both line tracks (from mid-line, in the direction that leads to st),
 * and trains can leave every platform towards `other`.
 */
function platformsReachable(g: Game, st: Station, other: Station, lineEdges: number[]): boolean {
  const net = g.world.net;
  // mid-line edges: the two line edges nearest the middle between the stations
  const mx = (st.x + other.x) / 2, mz = (st.z + other.z) / 2;
  const mids = lineEdges.map((id) => net.edges.get(id)!).filter(Boolean).map((e) => { const p = { x: 0, y: 0, z: 0 }; net.pointAt(e, e.len / 2, p); return { e, d: Math.hypot(p.x - mx, p.z - mz) }; })
    .sort((a, b) => a.d - b.d).slice(0, 2).map((q) => q.e);
  let ok = true;
  for (const pid of st.rail!.edges) {
    const pe = net.edges.get(pid)!;
    const leaves = [1, -1].some((d) => [...reach(g, pe, d)].some((id) => net.edges.get(id)?.station === other.id));
    let arrive = true;
    for (const e of mids) for (const d of [1, -1]) {
      const r = reach(g, e, d);
      if ([...r].some((x) => net.edges.get(x)?.station === st.id) && !r.has(pid)) arrive = false;
    }
    if (!leaves || !arrive) { ok = false; console.log(`  platform ${pid} of ${st.name}: leaves ${leaves}, reachable from both tracks ${arrive}`); }
  }
  return ok;
}

// ------------------------------------------------------------------ 3. directional double track, 3 trains each way, 2 years
let saved: { g: Game; trains: Train[] } | null = null;
{
  console.log('finishDoubleTrack');
  const g = flatGame(256);
  const net = g.world.net;
  const A = station(g, 40, 128, Math.PI / 2, 10, 2)!, B = station(g, 214, 128, Math.PI / 2, 10, 2)!;
  const e0 = net.nextEdge;
  const p = build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), '2-track line');
  check(p && p.tracks.length === 2, '2-track line built between the stations');
  const ids = newTrack(g, e0);
  const f = finishDoubleTrack(g, ids, 0);
  console.log(`  finish: ${f.signals} signals, ${f.crossovers} crossovers, cost ${fmt(f.cost / 1e3, 0)}k ${f.error ?? ''}`);
  check(!f.error && f.crossovers === 4 && f.signals >= 6, 'crossovers before both stations, signals on both tracks');
  check(platformsReachable(g, A, B, newTrack(g, e0)) && platformsReachable(g, B, A, newTrack(g, e0)), 'every platform reachable from both tracks, and can leave');
  const dep = depotFor(g, A, B);
  check(dep >= 0, 'depot behind A');
  const trains = [...line(g, [A, B], dep, 3), ...line(g, [B, A], dep, 3)];
  const r = runTrains(g, trains, 720);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  2 years: arrivals ${counts.join('/')} (a leg takes ~48 days alone), left the depot on days ${r.left.join('/')}, worst spell ${r.worst.days} days (${r.worst.kind})`);
  check(counts.every((c) => c >= 7), 'every train keeps shuttling (>= 7 stops in 2 years)');
  check(r.left.every((d) => d >= 0 && d < 240), 'all trains got out of the depot');
  check(r.worst.days < 25, 'no train stuck (waiting at a signal or without route) for 25 days');
  check(checkReservations(g).length === 0, 'reservations consistent');
  saved = { g, trains };
}

// ------------------------------------------------------------------ 4. doubling a single track with a tunnel and a bridge
{
  console.log('planDoubleTrack / commitDoubleTrack');
  // flat at 3, a ridge (height 12) around x=95 (tunnel), a river around x=150 (bridge)
  const g = flatGame(256, 3, (x) => { let h = 3 + Math.max(0, 9 - Math.abs(x - 95) * 0.6); if (Math.abs(x - 150) < 8) h = Math.min(h, -1 + Math.abs(x - 150) * 0.45); return h; });
  const net = g.world.net;
  const A = station(g, 22, 128, Math.PI / 2, 10, 2)!, B = station(g, 232, 128, Math.PI / 2, 10, 2)!;
  const e0 = net.nextEdge;
  const aEnd = endNode(g, A, 0, true), bEnd = endNode(g, B, 0, false);
  const p1 = build(g, nodeSnap(g, aEnd, 'rail'), free(g, 128, net.nodes.get(aEnd)!.z), railOpts(0, 1, { heightOffset: 3 - g.world.heightAt(128, 128) + 1e-3 }), 'through the ridge');
  const n1 = g.world.net.nearestNode(128, net.nodes.get(aEnd)!.z, 0.3, 'rail');
  const p2 = n1 ? build(g, nodeSnap(g, n1.id, 'rail'), nodeSnap(g, bEnd, 'rail'), railOpts(0), 'over the river') : null;
  const single = newTrack(g, e0);
  const lenSingle = single.reduce((s, id) => s + net.edges.get(id)!.len, 0);
  console.log(`  single track ${fmt(lenSingle)} u: tunnels ${(p1?.stats.tunnels ?? 0) + (p2?.stats.tunnels ?? 0)}, bridges ${(p1?.stats.bridges ?? 0) + (p2?.stats.bridges ?? 0)}`);
  check(lenSingle > 190 && (p1?.stats.tunnels ?? 0) + (p2?.stats.tunnels ?? 0) >= 1 && (p1?.stats.bridges ?? 0) + (p2?.stats.bridges ?? 0) >= 1, '2 km single track with a tunnel and a bridge');
  // the second platform tracks lie on the side of +z (right of the eastward chain?): pick the side with the free platform end
  const t1 = net.nodes.get(endNode(g, A, 1, true))!, t0 = net.nodes.get(aEnd)!;
  const ordered = [...single].sort((a, b) => Math.min(net.nodes.get(net.edges.get(a)!.a)!.x, net.nodes.get(net.edges.get(a)!.b)!.x) - Math.min(net.nodes.get(net.edges.get(b)!.a)!.x, net.nodes.get(net.edges.get(b)!.b)!.x));
  const side: 1 | -1 = (t1.z - t0.z) * 1 > 0 ? 1 : -1; // chain runs +x: right of +x is +z
  const plan = planDoubleTrack(g, ordered, side, 0);
  console.log(`  plan: ok ${plan.ok} ${plan.errors.join('; ')}, cost ${fmt(plan.cost / 1e6, 2)}M, ends ${plan.start.kind}/${plan.end.kind}, ${plan.points.length} points`);
  check(plan.ok && plan.start.kind === 'platform' && plan.end.kind === 'platform', 'planned into the free platforms at both ends');
  const singleCost = (p1?.cost ?? 0) + (p2?.cost ?? 0);
  console.log(`  cost: second track ${fmt(plan.cost / 1e6, 2)}M vs first ${fmt(singleCost / 1e6, 2)}M`);
  check(plan.cost < singleCost * 0.85, 'the second track is cheaper than the first (shared formation and structures)');
  const res = commitDoubleTrack(g, plan);
  console.log(`  built: ${res.edges.length} edges, ${res.signals} signals, ${res.crossovers} crossovers, ${res.error ?? ''} ${res.finishError ?? ''}`);
  check(!res.error && !res.finishError && res.signals >= 6 && res.crossovers === 4, 'doubled and made directional');
  const lineEdges = newTrack(g, e0);
  const structs = lineEdges.filter((id) => net.edges.get(id)!.sections.length).length;
  check(structs >= 4, `parallel bridge / tunnel sections on the new track (${structs} edges with structures)`);
  check(platformsReachable(g, A, B, lineEdges) && platformsReachable(g, B, A, lineEdges), 'every platform reachable from both tracks');
  const dA = depotFor(g, A, B), dB = depotFor(g, B, A);
  check(dA >= 0 && dB >= 0, 'depots at both ends');
  const trains = [...line(g, [A, B], dA, 1), ...line(g, [B, A], dB, 1)];
  const r = runTrains(g, trains, 360);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  1 year: arrivals ${counts.join('/')}, worst spell ${r.worst.days} days (${r.worst.kind})`);
  check(counts.every((c) => c >= 6), 'both trains shuttle in opposite directions');
  check(r.worst.days < 20, 'no deadlock');
}

// ------------------------------------------------------------------ 5. bridges at the station throat
{
  console.log('double track over a valley right at the station throat');
  const g = flatGame(256, 4, (x) => (x > 60 && x < 100 ? 4 - Math.min(5, Math.min(x - 60, 100 - x) * 0.5) : 4));
  const net = g.world.net;
  const A = station(g, 48, 128, Math.PI / 2, 10, 2)!, B = station(g, 214, 128, Math.PI / 2, 10, 2)!;
  const e0 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), '2-track line');
  const ids = newTrack(g, e0);
  const bridges = ids.filter((id) => net.edges.get(id)!.sections.some((s) => s.type === 'bridge')).length;
  const f = finishDoubleTrack(g, ids, 0);
  console.log(`  ${bridges} bridged tracks; finish: ${f.signals} signals, ${f.crossovers} crossovers ${f.error ?? ''}`);
  check(bridges >= 2 && !f.error && f.crossovers === 4, 'crossovers found room despite the bridge at the throat');
  check(platformsReachable(g, A, B, newTrack(g, e0)) && platformsReachable(g, B, A, newTrack(g, e0)), 'every platform reachable from both tracks');
}

// ------------------------------------------------------------------ 6. save round trip, 7. moving a depot
if (saved) {
  console.log('save round trip and moving a depot');
  const { g, trains } = saved;
  const sigs = (x: Game) => [...x.world.net.nodes.values()].filter((n) => n.signal).map((n) => `${n.id}:${n.signal}`).sort().join(',');
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  check(sigs(g) === sigs(g2) && sigs(g).length > 0, 'signals restored exactly');
  for (let i = 0; i < 8 * 30; i++) { g.update(0.25); g2.update(0.25); }
  const st = (x: Game) => x.vehicles.trains().map((t) => `${t.state}:${fmt(t.headPos, 3)}`).join('|');
  check(st(g) === st(g2), 'both copies run alike for 30 days');
  // move the depot: build a new one at B, then relocate
  const A = g.stations.all().find((s) => s.rail && s.rail.x < 100)!, B = g.stations.all().find((s) => s.rail && s.rail.x > 100)!;
  const old = trains[0].depotId;
  const dp = g.depots.get(old)!;
  // the new depot: on a stub behind B (planned like buildRailDepot does, via a temporary build)
  const nBefore = g.depots.nextId;
  const tmp = depotFor(g, B, A);
  check(tmp >= nBefore, 'a second depot site at B');
  const site = g.depots.get(tmp)!;
  const plan = { ...g.depots.plan('rail', site.x, site.z, site.angle, 0) };
  g.depots.remove(tmp);
  const plan2 = g.depots.plan('rail', site.x, site.z, site.angle, 0);
  void plan;
  let err: string | null = 'busy';
  for (let i = 0; i < 8 * 60 && err === 'busy'; i++) { err = relocateDepot(g, old, plan2); if (err === 'busy') g.update(0.25); }
  const nd = trains[0].depotId;
  console.log(`  relocate: ${err ?? 'ok'}; depot ${old} -> ${nd} at ${fmt(g.depots.get(nd)?.x ?? 0)}`);
  check(!err && nd !== old && !g.depots.get(old) && trains.every((t) => t.depotId === nd), 'all trains have the new home depot, the old one is gone');
  void dp;
  const before = trains.map((t) => t.delivered + (t.state === 'loading' ? 1 : 0));
  const r = runTrains(g, trains, 120);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  120 days after: arrivals ${counts.join('/')}, worst spell ${r.worst.days} (${r.worst.kind})`);
  check(counts.every((c) => c >= 2) && r.worst.days < 25, 'the line keeps working after the move');
  void before;
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();
