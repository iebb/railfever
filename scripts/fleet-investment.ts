// Standalone native fleet investment: no buildable extension is required, and a saved bid buys only lawful stock.
import assert from 'node:assert/strict';
import { presholm, flat, newTown, district, cityLine, runDays, M } from './linegrow-fixtures';
import { serialize, deserialize } from '../src/game/save';
import { marginalSharedTrain, marginalTrainInvestment } from '../src/game/ai-capacity';
import { openingRailCall } from '../src/game/ai';
import { outerEnd, planTerminusYard, buildTerminusYard, copyGrowCursor } from '../src/game/ai-grow';
import { networkItem, runNetworkTask, stepNetworkTask, networkDaily } from '../src/game/ai-network';
import { Train } from '../src/game/train';
import { toggleSignal } from '../src/game/build-ops';
import { addPattern, setVehiclePattern } from '../src/game/patterns';
import type { Game } from '../src/game/game';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import { checkReservations } from './lib';

let checks = 0;
function check(ok: unknown, label: string): asserts ok { assert(ok, label); checks++; }
const saved = (g: Game) => JSON.stringify(serialize(g));
const cold = (g: Game) => deserialize(JSON.parse(saved(g)));
const ledger = (g: Game, owner = 1) => JSON.stringify({ economy: g.company(owner).economy,
  vehicleId: g.vehicles.nextId, vehicles: [...g.vehicles.map.keys()], edges: [...g.world.net.edges.keys()],
  stations: [...g.stations.map.keys()], depots: g.depots.all().map(d => d.id) });

/** Actual road-front apartment entrances, rather than geometric population outside walking access. */
function residents(g: Game, town: Town, stations: Station[], pop: number) {
  for (const id of [...town.buildings]) g.world.removeBuilding(id);
  town.buildings.clear(); town.pop = 0;
  for (const st of stations) {
    const fc = g.stations.forecourt(st)!;
    const near = g.world.net.nearestEdge(fc.x, fc.z, 3, 'road')!;
    const point = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(near.edge, near.s, point);
    for (const dx of [-.8, 0, .8]) for (const dz of [1.1, 1.9, 2.7]) {
      const b = g.world.addBuilding({ townId: town.id, x: point.x + dx, z: point.z + dz, angle: 0,
        w: .6, d: .6, type: 4, floors: 8, pop, seed: 10000 + town.buildings.size, y: 4, built: 0 });
      town.buildings.add(b.id); town.pop += pop;
    }
  }
  g.demand.rebuild();
}
function fixture(pop = 120) {
  const f = presholm('west', 'tail', 1, 0);
  residents(f.g, f.t, f.sts, pop); runDays(f.g, 450);
  return f;
}
function survey(g: Game) {
  const ai = g.ais[0]; check(runNetworkTask(ai, 'extend', 0), 'native network task starts');
  stepNetworkTask(ai, 'extend'); stepNetworkTask(ai, 'extend');
  return networkItem(ai)?.grow;
}
function pending(g: Game) {
  const cursor = survey(g);
  check(cursor?.opts?.length === 1 && cursor.opts[0].kind === 'fleet', 'fully served city has only a standalone fleet alternative');
  stepNetworkTask(g.ais[0], 'extend');
  check(cursor.best?.fleet && cursor.at === cursor.opts.length + 1, 'native cursor saves the winning bid before purchase');
  return cursor;
}

const f = fixture(), { g, ai, line } = f, old = g.vehicles.get(line.vehicles[0]) as Train;
check(f.sts.every(s => s.catchPop > 0) && line.incomeLast > 0 && old.delivered > 0,
  'native walking, boarding, delivery and paid fare establish the real demand');
const quote = marginalTrainInvestment(g, line, ai.companyId, old.madeUp, old.pattern);
check(quote.investor > 0 && quote.pooled === marginalSharedTrain(g, line, ai.companyId, old.madeUp, old.pattern),
  'investor quote preserves the canonical pooled marginal surplus');
// Native rail quotes first record a saved monthly demand observation. Repeated and cold-cache reads use that same observation.
const quoted = saved(g), loaded = cold(g), loadedLine = loaded.lines.get(line.id)!;
check(JSON.stringify(marginalTrainInvestment(loaded, loadedLine, ai.companyId, old.madeUp, old.pattern)) === JSON.stringify(quote),
  'cold native quote exactly matches the saved monthly quote');
check(saved(loaded) === quoted, 'cold quote does not change an existing saved observation');
marginalTrainInvestment(g, line, ai.companyId, old.madeUp, old.pattern);
check(saved(g) === quoted, 'warm quote is a pure read');
pending(g);
const pendingSave = saved(g), twin = cold(g), n = g.vehicles.map.size, cash = g.company(ai.companyId).economy.money;
check(saved(twin) === pendingSave, 'pending standalone cursor round-trips exactly');
const blocked = cold(g), poor = cold(g);
networkDaily(ai); networkDaily(twin.ais[0]);
check(saved(g) === saved(twin), 'warm and cold pending bids purchase exactly the same train');
check(g.vehicles.map.size === n + 1 && line.stops.join() === loadedLine.stops.join(), 'one paid departure is added without new stations');
const added = [...g.vehicles.map.values()].find(v => v.id >= n + 1) as Train;
check(added instanceof Train && added.stopIndex === openingRailCall(g, added), 'paid train uses its actual reachable served opening call');
check(cash - g.company(ai.companyId).economy.money === old.madeUp.reduce((p, c) => p + c.cost, 0), 'native purchase charges the entire consist price');
check((ai as any).lines.get(line.id).maxVehicles >= line.vehicles.length, 'managed ceiling admits the actual economically purchased fleet');
let exact = true;
for (let i = 0; i < 128; i++) { g.stepTick(); twin.stepTick(); exact &&= saved(g) === saved(twin); }
runDays(g, 60); runDays(twin, 60); exact &&= saved(g) === saved(twin);
check(exact && added.onMap && added.delivered > 0 && added.state !== 'noroute', 'paid stock delivers with exact 128-tick replay and identical 60-day continuation');
check(!checkReservations(g).length, 'the larger native fleet keeps consistent reservations');

// No geometry changes are needed for a standalone bid: an occupied native depot queues the paid stock safely.
const queued = deserialize(JSON.parse(pendingSave)), qline = queued.lines.get(line.id)!;
const leaving = queued.vehicles.buyTrain(f.depot, old.madeUp, line.id);
check(leaving instanceof Train, 'a separately paid departure creates real depot traffic');
const stubId = queued.depots.get(f.depot)!.edge;
for (let i = 0; i < 80 && !queued.vehicles.isEdgeBusy(stubId); i++) queued.stepTick();
check(queued.vehicles.isEdgeBusy(stubId), 'native departure really occupies the unchanged depot track');
const queuedCold = cold(queued), next = queued.vehicles.nextId, edges = [...queued.world.net.edges.keys()].join(),
  stations = [...queued.stations.map.keys()].join(), depots = queued.depots.all().map(d => d.id).join();
networkDaily(queued.ais[0]); networkDaily(queuedCold.ais[0]);
const waiting = queued.vehicles.get(next) as Train;
check(waiting instanceof Train && !waiting.onMap && waiting.delivered === 0, 'profitable native purchase waits in the depot instead of entering occupied track');
check(edges === [...queued.world.net.edges.keys()].join() && stations === [...queued.stations.map.keys()].join()
  && depots === queued.depots.all().map(d => d.id).join(), 'standalone queued purchase preserves every infrastructure asset');
check(saved(queued) === saved(queuedCold), 'busy-depot purchase is identical with cold derived caches');
runDays(queued, 360); runDays(queuedCold, 360);
check(waiting.onMap && waiting.delivered > 0 && waiting.state !== 'noroute' && !checkReservations(queued).length,
  'native admission releases queued stock to actual calls and deliveries without inconsistent reservations');
check(saved(queued) === saved(queuedCold), 'busy-depot admission and one native operating year have exact saved continuation');

// A legitimate infrastructure edit between quote and commit must not borrow or purchase orphan stock.
const depot = blocked.depots.get(f.depot)!, stub = blocked.world.net.edges.get(depot.edge)!;
const links = new Set([stub.a, stub.b].flatMap(id => blocked.world.net.nodes.get(id)!.edges).filter(id => id !== stub.id));
check(links.size > 0 && [...links].every(id => !blocked.vehicles.isEdgeBusy(id)), 'depot approach can be removed without demolishing a train');
for (const id of links) blocked.world.net.removeEdge(id);
blocked.onNetworkChanged();
const cut = ledger(blocked); networkDaily(blocked.ais[0]);
check(ledger(blocked) === cut, 'unreachable depot revalidation is atomic before debt and purchase');

const eco = poor.company(ai.companyId).economy, price = old.madeUp.reduce((p, c) => p + c.cost, 0);
eco.loan = eco.maxLoan; eco.money = price * 1.1 + 1_500_000;
check(poor.ais[0].available() >= price * 1.1 + 300_000 && poor.ais[0].available() * .3 < price * 1.1,
  'cash fixture has the full-project reserve but cannot afford the native single-fleet budget');
const poorBefore = ledger(poor); networkDaily(poor.ais[0]);
check(ledger(poor) === poorBefore, 'pending bid respects the same 30% affordability guard as actual purchase');

const quiet = fixture(0), qv = quiet.g.vehicles.get(quiet.line.vehicles[0]) as Train;
check(quiet.line.incomeLast === 0 && marginalTrainInvestment(quiet.g, quiet.line, quiet.me, qv.madeUp).investor < 0,
  'quiet native service prices an additional departure as a loss');
const quietBefore = ledger(quiet.g); runNetworkTask(quiet.ai, 'extend');
check(ledger(quiet.g) === quietBefore, 'quiet demand cannot cause a standalone purchase');

/** Both payer and recipient really operate the same paid-access city line. Fees cancel in the pool, not in the payer's cash. */
function sharedFixture(pop: number) {
  const { g, ai } = flat(2), t = newTown(g, 'Shared', 220, 256);
  district(g, t, 150, 270, 256, 64, 0);
  const f = cityLine(g, 2, [158, 183, 208, 233, 258], 256, 'west', 'tail', 0);
  const yard = planTerminusYard(g, 1, f.sts.at(-1)!, outerEnd(f.sts.at(-1)!, f.sts.at(-2)!), null, () => true)!;
  check(!!yard, 'shared operator has a lawful separately priced depot site');
  const depot = buildTerminusYard(g, 1, yard, () => true); check(depot >= 0, 'shared operator really builds its owned depot');
  const l = g.lines.create('rail', 1); l.stops = [...f.line.stops]; g.lines.delete(f.line.id); g.lines.invite(l.id, 2); g.lines.rebuild();
  for (let i = 0; i < 3; i++) check(g.vehicles.buyTrain(f.depot, [M('lrv_b')], l.id) instanceof Train, 'recipient buys native operating stock');
  const v = g.vehicles.buyTrain(depot, [M('lrv_b')], l.id); check(v instanceof Train, 'payer buys native operating stock');
  v.stopIndex = openingRailCall(g, v); check(v.stopIndex >= 0, 'payer owned depot has a real full-consist onward opening route');
  residents(g, t, f.sts, pop); runDays(g, 450); (ai as any).adoptLines();
  return { g, ai, line: l, v };
}
const shared = sharedFixture(50);
shared.g.setAccessMultiplier(2, 0);
const free = marginalTrainInvestment(shared.g, shared.line, 1, shared.v.madeUp);
shared.g.setAccessMultiplier(2, 2);
const paid = marginalTrainInvestment(shared.g, shared.line, 1, shared.v.madeUp);
check(shared.v.delivered > 0 && shared.line.vehicles.every(id => (shared.g.vehicles.get(id) as Train).delivered > 0),
  'both operators really deliver native passengers on the shared line');
check(free.investor > 0 && paid.investor < 0 && paid.pooled > 0 && paid.pooled === free.pooled,
  'maximum lawful access price makes payer unprofitable despite positive unchanged pooled surplus');
const sharedBefore = ledger(shared.g); runNetworkTask(shared.ai, 'extend');
check(ledger(shared.g) === sharedBefore, 'internal recipient income cannot fund a loss-making payer purchase');
const routed = deserialize(JSON.parse(quoted)), routeLine = routed.lines.get(line.id)!;
// A two-way corridor permits the inner-city short-turn on a real intermediate platform.
for (const node of [...routed.world.net.nodes.values()]) if (node.kind === 'rail' && node.signal) {
  const owner = routed.world.net.edges.get(node.edges[0])!.owner;
  while (node.signal) check(!toggleSignal(routed, node.x, node.z, owner), 'native signal edit creates the two-way short-turn corridor');
}
const full = addPattern(routed, routeLine.id, 'short', routeLine.stops.map((_, i) => i !== 0 && i !== routeLine.stops.length - 1), 'Inner city')!;
check(full.id !== 0, 'native service uses a non-default pattern id');
for (const id of routeLine.vehicles) check(!setVehiclePattern(routed, id, full.id), 'native stock uses the explicit pattern');
const rc = pending(routed);
check(rc.opts![rc.best!.opt].pattern === full.id, 'saved standalone bid retains its actual non-default pattern');
const patternLive = cold(routed), patternCold = cold(routed), pn = patternLive.vehicles.nextId;
networkDaily(patternLive.ais[0]); networkDaily(patternCold.ais[0]);
const pv = patternLive.vehicles.get(pn) as Train;
check(pv instanceof Train && pv.pattern === full.id && pv.stopIndex > 0 && pv.stopIndex === openingRailCall(patternLive, pv),
  'opposite-end depot purchase starts at its real later served occurrence');
check(saved(patternLive) === saved(patternCold), 'non-default later-call purchase has exact saved continuation');
runDays(patternLive, 60);
check(pv.onMap && pv.delivered > 0 && pv.state !== 'noroute', 'paid later-entry stock actually operates and delivers');
const laterBlocked = cold(routed), shortStation = laterBlocked.stations.get(routeLine.stops[2])!;
for (const id of [...shortStation.rail!.edges]) {
  const edge = laterBlocked.world.net.edges.get(id)!;
  const split = laterBlocked.world.net.splitEdge(id, edge.len - 2)!;
  laterBlocked.world.net.removeEdge(split.e1.id);
}
laterBlocked.onNetworkChanged();
const shortened = ledger(laterBlocked); networkDaily(laterBlocked.ais[0]);
check(ledger(laterBlocked) === shortened, 'loss of a later full-consist platform route rejects the saved purchase atomically');
const revoked = sharedFixture(120); pending(revoked.g);
revoked.g.blockCompany(2, 1);
const revokedBefore = ledger(revoked.g), revokedCold = cold(revoked.g);
networkDaily(revoked.ai); networkDaily(revokedCold.ais[0]);
check(ledger(revoked.g) === revokedBefore && saved(revoked.g) === saved(revokedCold),
  'native access revocation rejects a saved winning bid atomically and identically after load');

const legacy = { at: 2, opts: [{ kind: 'ext' as const, end: 1, pop: 123 }], best: { opt: 0, score: 456, fleet: true } };
check(JSON.stringify(copyGrowCursor(legacy)) === JSON.stringify(legacy), 'legacy extension fleet bids retain their option indices and shape');
console.log(`fleet-investment: ${checks} native assertions passed`);
console.log('ALL CHECKS PASSED');
