// An occupied station must not starve a depot forever or let an emerging train foul unreserved track.
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { observeRailCapacity, marginalSharedTrain, usesSharedRail } from '../src/game/ai-capacity';
import { checkReservations } from './lib';
import { flatGame, station, endNode, nodeSnap, build, railOpts, loco, depotFor, check, done } from './stationlib';

function need(v: unknown, label: string): asserts v { if (!v) throw new Error('fixture setup: ' + label); }
for (const reverse of [false, true]) for (const long of [false, true]) {
  const g = flatGame(256), net = g.world.net; g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  const a = station(g, 40, 128, Math.PI / 2, 24, 1)!, b = station(g, 210, 128, Math.PI / 2, 24, 1)!;
  need(a && b && build(g, nodeSnap(g, endNode(g, a, 0, true), 'rail'),
    nodeSnap(g, endNode(g, b, 0, false), 'rail'), railOpts(), 'depot mouth line'), 'connected stations');
  const home = reverse ? b : a, other = reverse ? a : b, depot = depotFor(g, home, other), dp = g.depots.get(depot)!;
  need(dp, 'depot');
  const line = g.lines.create('rail', 0); line.stops = [home.id, other.id]; line.evenSpacing = false; g.lines.rebuild();
  const blocker = g.vehicles.buyTrain(depot, loco(), line.id); need(blocker instanceof Train, 'blocking train');
  for (let i = 0; i < 10000 && blocker.state !== 'loading'; i++) g.stepTick();
  need(blocker.state === 'loading' && blocker.atStation === home.id, 'native arrival at home platform');
  blocker.state = 'stopped';
  const cars = long ? loco() : [MODEL_BY_ID.get('diesel_b')!], stub = net.edges.get(dp.edge)!;
  const first = g.vehicles.buyTrain(depot, cars, line.id), second = g.vehicles.buyTrain(depot, cars, line.id);
  need(first instanceof Train && second instanceof Train, 'queued trains');
  need(long ? first.length > stub.len : first.length < stub.len, 'both sides of stub-length boundary');
  const label = `${reverse ? 'westbound' : 'eastbound'} ${long ? 'long consist' : 'short consist'}`;
  // A legacy facing block guard still protects every branch, including the occupied platform.
  const inner = net.nodes.get(stub.a)!;
  inner.signal = 1; inner.signalKind = 'block'; net.version++; g.networkVersion++;
  for (let i = 0; i < 200; i++) g.stepTick();
  check(!first.onMap && !second.onMap && !g.vehicles.getRes(dp.edge), `${label}: a facing full-block guard also forbids acquiring the depot stub`);
  inner.signal = 0; net.version++; g.networkVersion++;
  line.incomeLast = 12_000_000; line.passLast = 500;
  const priceBefore = marginalSharedTrain(g, line, 0, cars);
  let safe = true, single = true, held = true;
  for (let i = 0; i < 200 * 40; i++) {
    g.stepTick();
    if (g.tick % g.ticksPerDay === 0) observeRailCapacity(g);
    if (first.onMap) {
      const head = first.segs[first.headSeg];
      safe &&= head.e < 0 || head.e === dp.edge && first.headPos <= head.len + 1e-6;
      safe &&= first.occupiedEdges().every(id => id === dp.edge);
      held &&= first.segs.flatMap(s => s.res).every(r => g.vehicles.getRes(r) === first.id);
    }
    single &&= !second.onMap;
  }
  check(first.onMap && first.state === 'waiting' && first.stuckTime > 120,
    `${label}: the depot train physically queues at its mouth while the real station occupant remains`);
  check(safe && single && held && g.vehicles.getRes(dp.edge) === first.id,
    `${label}: only one train emerges, retaining its stub resources and whole body behind the reserved boundary`);
  check(!usesSharedRail(g, line) && line.capacity!.day === g.day && line.capacity!.delay > 0
    && marginalSharedTrain(g, line, 0, cars) < priceBefore,
    `${label}: actual private queues reduce the saved marginal price of another departure`);
  const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
  let exact = data === JSON.stringify(serialize(loaded));
  for (let i = 0; i < 200; i++) { g.stepTick(); loaded.stepTick(); }
  exact &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded));
  check(exact, `${label}: an emerging train, virtual tail and blocked onward route replay exactly`);
  g.vehicles.sell(blocker.id);
  const called = new Set<number>();
  for (let i = 0; i < 180 * 40 && called.size < 2; i++) {
    g.stepTick();
    for (const t of [first, second]) if (t.state === 'loading' && t.atStation === home.id) called.add(t.id);
  }
  check(called.size === 2, `${label}: both queued trains make a real station call when the guarded path becomes free`);
  check(checkReservations(g).length === 0, `${label}: mouth queuing and release preserve reservation ownership`);
}
done();
