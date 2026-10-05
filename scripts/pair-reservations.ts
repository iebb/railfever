// Directional pairing must wait for native held paths, then complete once those paths clear.
import { flatGame, station, endNode, nodeSnap, build, free, railOpts, loco, depotFor, check, fails } from './stationlib';
import { nodeNear, checkReservations } from './lib';
import { setSignal } from '../src/game/signals';
import { Train, findRailRoute, railNext, CROSS_BASE } from '../src/game/train';
import { pairAsDoubleTrack, planConnection, commitConnection, fragment, holdThroat, releaseHold, WORKS_HOLD } from '../src/game/trackops';
import { runNetworkTask, routeBetween, saveNetwork } from '../src/game/ai-network';
import { serialize, deserialize } from '../src/game/save';

function fixture(dispatch = true) {
  const g = flatGame(384), me = g.addAICompany({ startMoney: 100_000_000 }).id, ai = g.aiOf(me)!, net = g.world.net;
  g.aiEnabled = false; g.aiAcquisitions = false;
  const S = station(g, 30, 192, Math.PI / 2, 10, 2, me)!, T1 = station(g, 350, 120, Math.PI / 2, 10, 1, me)!, T2 = station(g, 350, 264, Math.PI / 2, 10, 1, me)!;
  const n0 = net.nodes.get(endNode(g, S, 0, true))!, n1 = net.nodes.get(endNode(g, S, 1, true))!;
  for (const n of [n0, n1]) build(g, nodeSnap(g, n.id, 'rail'), free(g, 235, n.z), railOpts(me), 'parallel strand');
  const m0 = nodeNear(g, 'rail', 235, n0.z)!, m1 = nodeNear(g, 'rail', 235, n1.z)!;
  const south = n0.z > n1.z, incoming = south ? T2 : T1;
  for (const [n, t] of [[south ? m0 : m1, T2], [south ? m1 : m0, T1]] as const)
    build(g, nodeSnap(g, n.id, 'rail'), nodeSnap(g, endNode(g, t, 0, false), 'rail'), railOpts(0), 'outer branch');
  // Open player track carries the outer services; ordinary access does not authorise AI joint works there.
  check(g.canUse(me, 0), 'outer native tracks grant ordinary access');
  const e = net.nearestEdge(145, n0.z, 1, 'rail', e => e.station < 0 && e.depot < 0) !;
  check(setSignal(g, e.edge.id, e.s, 'twoway', true, me, { signalKind: 'block' }) === null,
    'native block limits the incoming reservation before its destination');
  const l = g.lines.create('rail', me); l.stops = [S.id, incoming.id]; g.lines.rebuild();
  const depot = depotFor(g, incoming, S, me), train = g.vehicles.buyTrain(depot, loco(), l.id);
  check(train instanceof Train, 'native incoming consist is bought');
  if (!(train instanceof Train)) throw new Error(String(train));
  const core = () => [...net.edges.values()].filter(e => e.kind === 'rail' && e.station < 0 && e.depot < 0
    && net.nodes.get(e.a)!.x >= 34 && net.nodes.get(e.b)!.x >= 34 && net.nodes.get(e.a)!.x <= 235.01 && net.nodes.get(e.b)!.x <= 235.01);
  if (dispatch) {
  for (let tick = 0; tick < 1000; tick++) {
    g.stepTick();
    const held = train.segs.some(s => core().some(e => e.id === s.e));
    const outside = train.occupiedEdges().every(id => { const e = net.edges.get(id)!; return Math.min(net.nodes.get(e.a)!.x, net.nodes.get(e.b)!.x) > 320; });
    if (train.onMap && train.speed > 0.01 && held && outside) break;
  }
  check(train.onMap && train.speed > 0.01 && train.segs.some(s => core().some(e => e.id === s.e))
    && train.occupiedEdges().every(id => { const e = net.edges.get(id)!; return Math.min(net.nodes.get(e.a)!.x, net.nodes.get(e.b)!.x) > 320; }),
    'moving native body is outside the paired rails while its continuation is reserved inside');
  }
  return { g, ai, me, net, S, T1, T2, train, l, core };
}
const f = fixture(), saved = JSON.stringify(serialize(f.g));
const continuation = (g: typeof f.g) => {
  const t = g.vehicles.get(f.train.id) as Train, last = t.segs[t.segs.length - 1], e = g.world.net.edges.get(last.e)!;
  return findRailRoute(g, railNext(g, e, last.dir, t.owner, false, t.rule), f.S.id, t.owner, t.id,
    60000, false, t.rule, false, { length: t.length, onward: t.line!.stops[1] });
};
check(!!continuation(f.g), 'incoming held frontier has a lawful full-fit continuation before pairing');
const preimage = deserialize(JSON.parse(saved));
const edges = f.core(), A = edges.filter(e => Math.abs(preimage.world.net.nodes.get(e.a)!.z - 192) < 0.7 && preimage.world.net.nodes.get(e.a)!.z > 192).map(e => e.id),
  B = edges.filter(e => preimage.world.net.nodes.get(e.a)!.z < 192).map(e => e.id);
const raw = pairAsDoubleTrack(preimage, A, B, f.me);
console.log(`preimage raw pair: ${JSON.stringify(raw)}; continuation ${!!continuation(preimage)}`);
check(!raw.error && !continuation(preimage), 'preimage directional conversion loses the already held incoming continuation');
const geometry = () => {
  const state = serialize(f.g);
  return JSON.stringify({ net: state.net, stations: state.stations, vehicles: state.vehicles,
    reservations: [...f.net.edges.keys(), ...[...f.net.crossings.keys()].map(id => CROSS_BASE + id)].map(id => [id, f.g.vehicles.getRes(id)]),
    cash: f.ai.eco.money, loan: f.ai.eco.loan, books: f.ai.eco.current });
};
const before = geometry();
const networkBefore = saveNetwork(f.g);
runNetworkTask(f.ai, 'pair');
check(geometry() === before && !(f.ai.stats as unknown as { paired?: number }).paired && !!continuation(f.g),
  'protected pairing defers without geometry, spending or held-route changes');
const deferred = saveNetwork(f.g).companies.find(([id]) => id === f.me)?.[1];
check(!networkBefore.companies.some(([id]) => id === f.me) && deferred?.job === null
  && deferred.care.some(([key, until]) => key.startsWith('pair') && until === f.g.day + 20),
  'deferral retains the existing saved care/retry state separately from physical state');

// An adjacent platform is part of the native work set even when neither plain strand is occupied.
const platform = deserialize(JSON.parse(saved)), platformTrain = platform.vehicles.get(f.train.id) as Train;
for (let tick = 0; tick < 200 * platform.ticksPerDay; tick++) {
  platform.stepTick();
  if (platformTrain.state === 'loading' && platformTrain.segs.every(s => platform.world.net.edges.get(s.e)?.station === f.S.id)) break;
}
const platformBefore = JSON.stringify({ state: serialize(platform), slots: [...platform.world.net.edges.keys()].map(id => [id, platform.vehicles.getRes(id)]) });
check(platformTrain.state === 'loading' && platformTrain.segs.every(s => platform.world.net.edges.get(s.e)?.station === f.S.id),
  'native arrival leaves only the adjacent platform held');
runNetworkTask(platform.aiOf(f.me)!, 'pair');
const platformAfter = serialize(platform), originalPlatform = JSON.parse(platformBefore).state;
check(JSON.stringify(platformAfter.net) === JSON.stringify(originalPlatform.net)
  && JSON.stringify(platformAfter.vehicles) === JSON.stringify(originalPlatform.vehicles)
  && JSON.stringify(platformAfter.companies) === JSON.stringify(originalPlatform.companies)
  && !((platform.aiOf(f.me)!.stats as unknown as { paired?: number }).paired),
  'an adjacent held platform defers direction changes without moving or spending');

// Create a genuine station-throat possession through the native works API, with no train holder.
const w = fixture(false), primary = w.net.nearestEdge(100, 192.49, 1, 'rail', e => e.owner === w.me && e.station < 0)!;
fragment(w.g, primary.edge.id, 10);
const signal = w.net.nearestEdge(70, 192.49, 1, 'rail', e => e.owner === w.me && e.station < 0)!;
check(setSignal(w.g, signal.edge.id, signal.s, 'oneway', false, w.me, { signalKind: 'block' }) === null,
  'native incoming signal prepares the station throat possession');
const a = w.net.nearestEdge(185, 192.49, 1, 'rail', e => e.owner === w.me && e.station < 0)!,
  b = w.net.nearestEdge(160, 191.51, 1, 'rail', e => e.owner === w.me && e.station < 0)!;
const conn = planConnection(w.g, a.edge.id, a.s, b.edge.id, b.s, w.me, { search: 2, dirA: -1, dirB: -1 });
check(conn.ok && !commitConnection(w.g, conn, { signals: false }).error, 'native crossover keeps both service directions available during the possession');
check(!!routeBetween(w.g, w.S.id, w.l.stops[1], w.me) && !!routeBetween(w.g, w.l.stops[1], w.S.id, w.me),
  'possession fixture has lawful routes before the guarded pairing');
const held = holdThroat(w.g, w.S.id, 'front', w.me, 1);
check(held.length > 0 && held.every(id => w.g.vehicles.getRes(id) === WORKS_HOLD)
  && w.g.vehicles.get(WORKS_HOLD) === undefined, 'native works hold exists without a vehicle holder');
const worksBefore = JSON.stringify({ net: serialize(w.g).net, vehicles: serialize(w.g).vehicles,
  cash: w.ai.eco.money, loan: w.ai.eco.loan, slots: [...w.net.edges.keys()].map(id => [id, w.g.vehicles.getRes(id)]) });
runNetworkTask(w.ai, 'pair');
check(JSON.stringify({ net: serialize(w.g).net, vehicles: serialize(w.g).vehicles,
  cash: w.ai.eco.money, loan: w.ai.eco.loan, slots: [...w.net.edges.keys()].map(id => [id, w.g.vehicles.getRes(id)]) }) === worksBefore
  && !(w.ai.stats as unknown as { paired?: number }).paired, 'native WORKS_HOLD defers pairing without touching its protected slots');
releaseHold(w.g, held);
check(held.every(id => w.g.vehicles.getRes(id) === 0), 'the native works API releases its own completed possession');
let paired = false, noRoute = 0, pairedDay = -1;
for (let tick = 0; tick < 200 * f.g.ticksPerDay; tick++) {
  if (f.train.routeTarget === f.S.id) f.g.stations.addWaiting(f.S, f.l.id, f.l.stops[1], f.l.stops[1], Math.max(0, 12 - f.S.waitingTotal));
  f.g.stepTick(); noRoute += Number(f.train.state === 'noroute');
  if (!paired && f.g.tick % f.g.ticksPerDay === 0) runNetworkTask(f.ai, 'pair');
  const nowPaired = !!(f.ai.stats as unknown as { paired?: number }).paired;
  if (nowPaired && !paired) pairedDay = f.g.day;
  paired = nowPaired;
}
console.log(`protected pair completed ${paired} day ${pairedDay}, observed through ${f.g.day}, delivered ${f.train.delivered}, state ${f.train.state}, ${f.train.status}`);
check(paired && noRoute === 0, 'pairing completes after native movement clears the protected holds');
check(!!routeBetween(f.g, f.S.id, f.l.stops[1], f.me) && !!routeBetween(f.g, f.l.stops[1], f.S.id, f.me),
  'completed directional pair keeps both service routes');
const replay = deserialize(JSON.parse(JSON.stringify(serialize(f.g))));
let same = true;
for (let tick = 0; tick < 640; tick++) { f.g.stepTick(); replay.stepTick(); if (JSON.stringify(serialize(f.g)) !== JSON.stringify(serialize(replay))) { same = false; break; } }
check(same, 'native saved continuation replays exactly for 640 fixed ticks');
check(f.train.delivered > 0 && checkReservations(f.g).length === 0 && checkReservations(replay).length === 0,
  'native passengers are delivered and all held resources remain consistent');
console.log(fails.length ? `${fails.length} CHECKS FAILED` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
