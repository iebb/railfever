// A native reservation cycle gives the longest waiter right of way in both recovery schedulers.
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { Train, deadlockCycles, resolveDeadlocks } from '../src/game/train';
import { outAndBack } from '../src/game/lines';
import { serialize, deserialize } from '../src/game/save';
import { setSignal } from '../src/game/signals';
import { connectStationThroat } from '../src/game/trackops';
import { station, endNode, depotFor, loco, build, nodeSnap, railOpts, check, done } from './stationlib';
import { checkReservations } from './lib';

function need(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
const saved = (g: Game) => JSON.stringify(serialize(g));
const g = Game.create({ size: 256, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
g.world.h.fill(3); g.world.heightsVersion++;
for (const t of g.world.trees) if (t) g.world.removeTreesNear(t.x, t.z, 0.1);
for (const c of g.companies) c.economy.money = 1e9;
const A = station(g, 40, 128, Math.PI / 2, 12, 2, 0)!, B = station(g, 145, 128, Math.PI / 2, 12, 1, 0)!, C = station(g, 205, 128, Math.PI / 2, 12, 2, 1)!;
need(A && B && C, 'native station construction');
need(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0)), 'native A-B track');
need(build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(1)), 'native B-C track');
for (const front of [false, true]) {
  const n = g.world.net.nodes.get(endNode(g, B, 0, front))!, e = n.edges.map(id => g.world.net.edges.get(id)!).find(e => e.station < 0)!;
  need(!setSignal(g, e.id, front ? (e.a === n.id ? 2 : e.len - 2) : (e.a === n.id ? 0 : e.len), 'twoway', true, e.owner), 'native junction signal');
}
for (const st of [A, C]) need(connectStationThroat(g, st.id, st.owner).connected === 1, 'native passing platform');
const dA = depotFor(g, A, B, 0), dC = depotFor(g, C, B, 1), line = g.lines.create('rail', 0);
need(dA >= 0 && dC >= 0, 'native depots');
line.stops = outAndBack([A.id, B.id, C.id]); line.evenSpacing = false;
g.lines.setPartnerPolicy(line.id, 'open'); need(g.lines.join(line.id, 1) === null, 'native shared operation'); g.lines.rebuild();
const a = g.vehicles.buyTrain(dA, loco(), line.id), b = g.vehicles.buyTrain(dC, loco(), line.id);
need(a instanceof Train && b instanceof Train, 'native paid trains'); a.stopIndex = 1; b.stopIndex = 3;
let cycle: Train[] | undefined;
for (let i = 0; i < 200 * TICKS_PER_DAY; i++) {
  g.stepTick();
  cycle = deadlockCycles(g, 0).find(c => c.includes(a) && c.includes(b));
  if (cycle && cycle.every(t => t.speed <= 0.01)) break;
}
need(cycle?.length === 2 && cycle.every(t => t.speed <= 0.01), 'native stopped reservation cycle');
const [younger, older] = [...cycle].sort((x, y) => x.stuckTime - y.stuckTime || x.id - y.id);
need(younger.stuckTime < older.stuckTime && !g.deadlockScan, 'unequal native waiting ages before automatic recovery');
const snapshot = saved(g), sync = deserialize(JSON.parse(snapshot)), sliced = deserialize(JSON.parse(snapshot));
check(resolveDeadlocks(sync, 0), 'synchronous recovery reserves a real safe retreat');
check(sync.vehicles.trains().find(t => t.backoff)?.id === younger.id, 'the shorter waiter yields to the longest-blocked service');
const priority = sync.vehicles.get(older.id) as Train;
check(priority.stuckTime === older.stuckTime && priority.stopIndex === older.stopIndex && priority.routeTarget === older.routeTarget,
  'the oldest waiter retains its saved waiting age and service target');

resolveDeadlocks(sliced, 0, 1);
need(sliced.deadlockScan, 'bounded native scan has a saved continuation');
const loaded = deserialize(serialize(sliced));
let exact = saved(sliced) === saved(loaded), moved = false;
for (let i = 0; i < 10000 && !moved; i++) {
  moved = resolveDeadlocks(sliced, 0, 1);
  const resumed = resolveDeadlocks(loaded, 0, 1);
  exact &&= moved === resumed && saved(sliced) === saved(loaded);
}
check(moved && sliced.vehicles.trains().find(t => t.backoff)?.id === younger.id, 'sliced recovery selects the same native yielding train');
check(exact, 'saving inside the bounded wait-graph scan preserves every recovery decision');
check(saved(sync) === saved(sliced), 'synchronous and sliced recovery reserve exactly the same route and state');
check(saved(g) === snapshot, 'independent recovery decisions preserve the original native cycle');
for (let i = 0; i < 128; i++) { sync.stepTick(); sliced.stepTick(); loaded.stepTick(); }
check(saved(sync) === saved(sliced) && saved(sliced) === saved(loaded), 'both schedulers and a saved scan replay the physical retreat exactly');
check([sync, sliced, loaded].every(h => !checkReservations(h).length), 'all retreat continuations retain lawful exclusive reservations');
done();
