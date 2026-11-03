// Native paid stock holds one physical obstruction regardless of degree-two edge fragmentation.
import { serialize, deserialize } from '../src/game/save';
import { Train, findRailRoute, railNext, consistRule } from '../src/game/train';
import { setSignal } from '../src/game/signals';
import { checkReservations } from './lib';
import { flatGame, station, endNode, build, free, nodeSnap, railOpts, depotFor, loco, check, done } from './stationlib';

function need(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
const g = flatGame(256); g.aiEnabled = false; g.vehicles.ambientEnabled = false;
const A = station(g, 35, 128, Math.PI / 2, 10, 1)!, B = station(g, 220, 128, Math.PI / 2, 10, 1)!;
need(A && B, 'native terminal platforms');
const works = build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
  nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'single corridor');
need(works.ok, 'native funded running track');
const depot = depotFor(g, A, B), line = g.lines.create('rail', 0);
line.stops = [A.id, B.id]; g.lines.rebuild();
const money = g.economy.money, train = g.vehicles.buyTrain(depot, loco(), line.id);
need(train instanceof Train, 'native train purchase');
check(g.economy.money < money && line.vehicles.includes(train.id), 'the obstruction is genuinely bought routed stock');
for (let k = 0; k < 20_000 && !(train.routeTarget === B.id && train.segs.some(s => g.world.net.edges.get(s.e)?.station === B.id)); k++) g.stepTick();
need(train.routeTarget === B.id && train.segs.some(s => g.world.net.edges.get(s.e)?.station === B.id), 'native onward running reservation');
const rule = consistRule(train.cars);
const quote = (game: typeof g, reverse: boolean, ignore = false, length = train.length) => {
  const from = game.stations.get(reverse ? B.id : A.id)!, target = game.stations.get(reverse ? A.id : B.id)!;
  const group = game.stations.railTrackGroups(from)[0], step = reverse ? group.steps[0] : group.steps.at(-1)!;
  return findRailRoute(game, railNext(game, game.world.net.edges.get(step.edge)!, reverse ? -step.dir : step.dir, 0),
    target.id, 0, -1, 60000, false, rule, ignore, { length, onward: from.id, preferred: game.stations.railTrackGroups(target)[0].id });
};
const snapshot = JSON.stringify(serialize(g));
const original = [false, true].map(reverse => {
  const occupied = quote(g, reverse), topology = quote(g, reverse, true);
  need(occupied && topology, 'native full-fit bidirectional routes');
  check(Math.abs(occupied.cost - topology.cost - 40) < 1e-8,
    `${reverse ? 'reverse' : 'forward'} quote counts one contiguous native reservation once`);
  return occupied.cost;
});
check(!quote(g, false, false, 20) && !quote(g, true, false, 20), 'occupation pricing preserves full-consist platform fit in both directions');
let reads = 0; const getRes = g.vehicles.getRes.bind(g.vehicles);
g.vehicles.getRes = id => { reads++; return getRes(id); };
quote(g, false, true); quote(g, true, true);
g.vehicles.getRes = getRes;
check(reads === 0, 'topology-only forecasts never inspect current reservations');
check(JSON.stringify(serialize(g)) === snapshot, 'native route quotes leave all saved decisions unchanged');
const cold = deserialize(JSON.parse(snapshot));
check([false, true].every((reverse, i) => quote(cold, reverse)?.cost === original[i]), 'cold and warm native obstruction prices match exactly');

const edge = train.segs.find(s => { const e = g.world.net.edges.get(s.e); return e && e.station < 0 && e.depot < 0 && e.len > 30; });
need(edge, 'long actually held running edge');
const first = g.world.net.splitEdge(edge.e, g.world.net.edges.get(edge.e)!.len * .4);
need(first, 'native first split');
need(g.world.net.splitEdge(first.e2.id, first.e2.len * .5), 'native second split');
g.flushNetworkChanges();
check(!checkReservations(g).length, 'native splits transfer every held body/path reservation consistently');
for (const [i, reverse] of [false, true].entries()) {
  const quoted = quote(g, reverse); need(quoted, 'split full-fit native route');
  check(Math.abs(quoted.cost - original[i]) < 1e-8,
    `${reverse ? 'reverse' : 'forward'} physical route price is invariant under two real degree-two splits`);
}
const splitSave = JSON.stringify(serialize(g)), replay = deserialize(JSON.parse(splitSave));
check([false, true].every(reverse => quote(g, reverse)?.cost === quote(replay, reverse)?.cost), 'split native route prices rebuild exactly after saving');

// A subdivision alone adds no receiving space. A lawful control signal or turnout creates a distinct path
// choice, even while the same paid train happens to hold both sides of it.
for (const control of ['path', 'block', 'turnout'] as const) {
  const h = deserialize(JSON.parse(splitSave)), net = h.world.net;
  const node = net.nodes.get(first.node.id)!, approach = net.edges.get(first.e1.id)!;
  if (control === 'turnout') {
    need(build(h, nodeSnap(h, node.id, 'rail'), free(h, node.x + 40, node.z + 35), railOpts(0), 'native held-track turnout'), 'native turnout construction');
  } else {
    need(setSignal(h, approach.id, approach.len, 'twoway', true, 0, { signalKind: control }) === null, 'native paid signal construction');
  }
  h.flushNetworkChanges();
  for (const [i, reverse] of [false, true].entries()) {
    const route = quote(h, reverse); need(route, 'controlled full-fit native route');
    check(Math.abs(route.cost - original[i] - 40) < 1e-8,
      `${control}: ${reverse ? 'reverse' : 'forward'} pricing counts the separately controlled held path`);
  }
  const controlledSave = JSON.stringify(serialize(h)), coldControl = deserialize(JSON.parse(controlledSave));
  check([false, true].every(reverse => quote(h, reverse)?.cost === quote(coldControl, reverse)?.cost)
    && JSON.stringify(serialize(h)) === controlledSave, `${control}: controlled quotes are pure and identical after saving`);
  for (let i = 0; i < 128; i++) { h.stepTick(); coldControl.stepTick(); }
  check(JSON.stringify(serialize(h)) === JSON.stringify(serialize(coldControl)) && !checkReservations(h).length,
    `${control}: paid native stock continues with exact replay and lawful reservations`);
}

let exact = true, safe = true;
const calls = new Set<number>();
const until = g.day + 180;
while (g.day < until) {
  g.stepTick(); replay.stepTick(); calls.add(train.opLastSt);
  if (g.tick % g.ticksPerDay === 0) {
    exact &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(replay));
    safe &&= !checkReservations(g).length && !checkReservations(replay).length;
  }
}
check(calls.has(A.id) && calls.has(B.id), 'paid native stock actually operates both directions after held track is split');
check(exact && JSON.stringify(serialize(g)) === JSON.stringify(serialize(replay)), 'split paid service replays the complete native 180-day continuation exactly');
check(safe, 'both live and saved continuations preserve all reservation ownership');
done();
