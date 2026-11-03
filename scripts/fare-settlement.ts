// Same-pattern tickets belong to useful operating service, not cumulative owner history.
// All infrastructure/stock is normally paid from supported, repayable starting loans.
import assert from 'node:assert/strict';
import { flat, newTown, district, cityLine, runDays, M } from './linegrow-fixtures';
import { Train } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { outerEnd, planTerminusYard, buildTerminusYard } from '../src/game/ai-grow';
import { openingRailCall } from '../src/game/ai';
import { marginalTrainInvestment, marginalSharedConsist, sharedCapacityPlan, touchSharedCapacity } from '../src/game/ai-capacity';
import { planEdge, commitProposal } from '../src/game/construction';
import { planNativeStationOnTrack, commitNativeStationOnTrack } from '../src/game/station-on-track';
import { buildSideDepot } from '../src/game/depot-sites';
import { atomicTerminalCell } from '../src/game/rail-capacity-cells';
import { capacityRouteBetween } from '../src/game/rail-capacity-routes';
import { outAndBack } from '../src/game/lines';
import { addPattern, setVehiclePattern } from '../src/game/patterns';
import { checkReservations, checkNaN } from './lib';

let checks = 0;
function check(value: unknown, message: string): asserts value { assert(value, message); checks++; }
const save = (g: ReturnType<typeof flat>['g']) => JSON.stringify(serialize(g));
const cold = (g: ReturnType<typeof flat>['g']) => deserialize(JSON.parse(save(g)));
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
const { g } = flat(2), town = newTown(g, 'Common corridor', 220, 256);
district(g, town, 150, 270, 256, 64, 0);
const built = cityLine(g, 2, [158, 183, 208, 233, 258], 256, 'west', 'tail', 0);
const yard = planTerminusYard(g, 1, built.sts.at(-1)!, outerEnd(built.sts.at(-1)!, built.sts.at(-2)!), null, () => true);
check(yard, 'other operator has a lawful owned yard site');
const depot = buildTerminusYard(g, 1, yard, () => true);
check(depot >= 0, 'other operator pays the real yard quote');
const line = g.lines.create('rail', 1); line.stops = [...built.line.stops];
g.lines.delete(built.line.id); g.lines.invite(line.id, 2); g.lines.rebuild();
const stock: Train[] = [];
for (const dep of [depot, depot, built.depot, built.depot]) {
  const t = g.vehicles.buyTrain(dep, [M('lrv_b')], line.id);
  check(t instanceof Train, 'normally paid matching stock exists before economic counterfactuals');
  t.stopIndex = openingRailCall(g, t); check(t.stopIndex >= 0, 'actual paid consist has a directed full-fit opening route'); stock.push(t);
}
for (const st of built.sts) {
  const fc = g.stations.forecourt(st)!, hit = g.world.net.nearestEdge(fc.x, fc.z, 3, 'road')!;
  const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(hit.edge, hit.s, p);
  for (const dx of [-.8, 0, .8]) for (const dz of [1.1, 1.9, 2.7]) {
    const b = g.world.addBuilding({ townId: town.id, x: p.x + dx, z: p.z + dz, angle: 0,
      w: .6, d: .6, type: 4, floors: 8, pop: 75, seed: 10000 + town.buildings.size, y: 4, built: 0 });
    town.buildings.add(b.id); town.pop += b.pop;
  }
}
g.stations.recomputeCatchment(); g.demand.rebuild(); runDays(g, 450);
check(stock.every(t => t.delivered > 0) && line.incomeLast > 0, 'both actual operators call, deliver and settle native passenger fares');
check(!checkReservations(g).length && !checkNaN(g), 'paid operating fixture has lawful finite native state');
touchSharedCapacity(g, line);
const source = save(g), cars = stock[0].madeUp;
const quote = marginalTrainInvestment(g, line, 1, cars);
const swapped = cold(g), sl = swapped.lines.get(line.id)!;
const histories = stock.map(t => t.delivered);
for (const [i, t] of stock.entries()) swapped.vehicles.get(t.id)!.delivered = histories[(i + 2) % stock.length];
const swappedSave = save(swapped), swappedQuote = marginalTrainInvestment(swapped, sl, 1, cars);
check(JSON.stringify(quote) === JSON.stringify(swappedQuote), 'history-only owner reassignment cannot change same-service private or pooled ticket value');
check(save(g) === source && save(swapped) === swappedSave, 'both history-arm quotes preserve the complete saved world');
const paidHistory = cold(g); for (const a of paidHistory.access) a.paidLastMonth = 0;
check(JSON.stringify(marginalTrainInvestment(paidHistory, paidHistory.lines.get(line.id)!, 1, cars)) === JSON.stringify(quote),
  'past access payments cannot buy a ticket entitlement');
const loaded = cold(g);
check(JSON.stringify(marginalTrainInvestment(loaded, loaded.lines.get(line.id)!, 1, cars)) === JSON.stringify(quote)
  && save(loaded) === source, 'cold native quote is identical and pure');
check(JSON.stringify(marginalTrainInvestment(g, line, 1, cars)) === JSON.stringify(quote) && save(g) === source,
  'warm native quote is identical and pure');

// Compare two already-paid departures, keeping all other paid stock off the service in both arms.
// Station title remains owner 2 and line title owner 1, so neither arm becomes an isolated queue quote.
function assigned(ids: number[]) {
  const a = cold(g), l = a.lines.get(line.id)!;
  for (const t of stock) if (!ids.includes(t.id)) a.vehicles.get(t.id)!.setLine(null);
  touchSharedCapacity(a, l); return { g: a, l };
}
const split = assigned([stock[0].id, stock[2].id]), sole = assigned([stock[2].id, stock[3].id]);
const splitRevenue = sharedCapacityPlan(split.g, split.l).revenue, soleRevenue = sharedCapacityPlan(sole.g, sole.l).revenue;
check(splitRevenue > 0 && near(splitRevenue, soleRevenue), 'same aggregate service conserves one fare pool across owner reassignment and sole ownership');
const noHistory = cold(sole.g); for (const t of noHistory.vehicles.trains()) t.delivered = 0;
check(near(sharedCapacityPlan(noHistory, noHistory.lines.get(line.id)!).revenue, soleRevenue),
  'sole active operator retains the fare pool even with zero delivered history');
const empty = assigned([]);
check(sharedCapacityPlan(empty.g, empty.l).revenue === 0, 'zero useful departures receive zero fares');
const entrant = marginalTrainInvestment(sole.g, sole.l, 1, cars), entrantCold = cold(sole.g);
check(Number.isFinite(entrant.investor) && Number.isFinite(entrant.pooled)
  && JSON.stringify(entrant) === JSON.stringify(marginalTrainInvestment(entrantCold, entrantCold.lines.get(line.id)!, 1, cars)),
  'zero-count entrant is priced on the same rule before and after with exact cold results');

// Current tariffs remain real private costs/income, separate from the common gross fare pool.
const free = cold(g); free.setAccessMultiplier(2, 0);
const charged = cold(g); charged.setAccessMultiplier(2, 1);
const fq = marginalTrainInvestment(free, free.lines.get(line.id)!, 1, cars);
const cq = marginalTrainInvestment(charged, charged.lines.get(line.id)!, 1, cars);
check(near(sharedCapacityPlan(free, free.lines.get(line.id)!).revenue, sharedCapacityPlan(charged, charged.lines.get(line.id)!).revenue),
  'changing the present access tariff does not change the common gross fare pool');
check(cq.investor < fq.investor && near(cq.pooled, fq.pooled), 'actual access charges reduce private surplus and conserve the participating pool');

// Native operating receipts, calls and cold continuation retain their ordinary settlement path.
const operating = cold(g), replay = cold(g), fares = new Map<number, number>(), calls = new Map<number, number>();
const income = operating.onIncome, stop = operating.recordStop;
operating.onIncome = function(amount, v, st) { const r = income.call(this, amount, v, st);
  if (v.lineId === line.id) fares.set(v.owner, (fares.get(v.owner) ?? 0) + amount); return r; };
operating.recordStop = function(v, st) { const r = stop.call(this, v, st);
  if (v.lineId === line.id) calls.set(v.owner, (calls.get(v.owner) ?? 0) + 1); return r; };
let exact = true;
for (let i = 0; i < 60 * operating.ticksPerDay; i++) { operating.stepTick(); replay.stepTick();
  if (i < 128 || operating.tick % operating.ticksPerDay === 0) exact &&= save(operating) === save(replay); }
check(exact && !checkReservations(operating).length && !checkNaN(operating), '128 exact cold ticks and 60 native days preserve full ledgers, physics and safety');
check([1, 2].every(id => (fares.get(id) ?? 0) > 0 && (calls.get(id) ?? 0) > 0), 'both operators actually receive period fares through their own arriving vehicles');

// Explicitly exercise conservative non-complete cases; their native full-stock guards remain active.
const partial = cold(g), pl = partial.lines.get(line.id)!, pattern = addPattern(partial, pl.id, 'express', pl.stops.map((_, i) => i % 2 === 0));
check(pattern !== null, 'native express pattern can be configured');
setVehiclePattern(partial, stock[0].id, pattern!.id);
const pq = marginalTrainInvestment(partial, pl, 1, cars, pattern!.id);
check(Number.isFinite(pq.investor) && Number.isFinite(pq.pooled), 'partial-pattern quotes retain the conservative model');
const different = marginalTrainInvestment(g, line, 1, [...cars, M('lrv_b')]);
check(Number.isFinite(different.investor) && Number.isFinite(different.pooled), 'different exact proposed stock uses an explicitly conservative quote');
check(JSON.stringify(different) !== JSON.stringify(marginalTrainInvestment(swapped, sl, 1, [...cars, M('lrv_b')])),
  'a different proposed signature cannot pool either side of the departure counterfactual');
const consist = marginalSharedConsist(g, line, stock[0], [...cars, M('lrv_b')]);
check(Number.isFinite(consist) && consist !== marginalSharedConsist(swapped, sl, swapped.vehicles.get(stock[0].id) as Train, [...cars, M('lrv_b')]),
  'a changed consist keeps the same literal settlement model on both sides of replacement');

// A real third owner's retained platform is an alternative only for one operator. Both operators
// take exactly the same common running route, so equal hops/use alone must not qualify their fares.
const restricted = flat(3).g, net = restricted.world.net;
for (const [z, owner] of [[257.25, 1], [256, 3]]) {
  const p = planEdge(restricted, { kind: 'free', x: 100, z, y: 4 }, { kind: 'free', x: 400, z, y: 4 },
    { kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'level', owner });
  check(p.ok && !commitProposal(restricted, p), 'actual respective owners pay both native parallel running rails');
}
const towns = [newTown(restricted, 'West', 150, 256), newTown(restricted, 'East', 330, 256)];
for (const [i, t] of towns.entries()) district(restricted, t, i ? 290 : 110, i ? 370 : 190, 256, 64, 0);
const stations = [150, 330].map(x => {
  const hit = net.nearestEdge(x, 257.25, .1, 'rail')!;
  const p = planNativeStationOnTrack(restricted, hit.edge.id, hit.s, { length: 10, tracks: 2, mode: 'mainline' }, 1);
  check(p.ok, 'actual native facility can retain both differently owned platform tracks');
  const built = commitNativeStationOnTrack(restricted, p);
  check(!built.error, 'facility payer retains the third owner running rail');
  return restricted.stations.get(built.station)!;
});
restricted.blockCompany(3, 2);
const rl = restricted.lines.create('rail', 1); rl.stops = outAndBack(stations.map(st => st.id));
restricted.lines.invite(rl.id, 2); restricted.lines.rebuild();
const longStock = [M('diesel_b'), M('coach_ic'), M('coach_ic')];
for (const [i, owner] of [[0, 1], [1, 2]]) {
  const hit = net.nearestEdge(i ? 370 : 110, 257.25, .1, 'rail')!;
  const depot = buildSideDepot(restricted, hit.edge.id, hit.s, owner, { side: 1 });
  check(depot >= 0 && restricted.vehicles.buyTrain(depot, longStock, rl.id) instanceof Train,
    'each actual operator pays its accessible native depot and complete stock');
}
for (const [i, st] of stations.entries()) {
  const fc = restricted.stations.forecourt(st)!, hit = net.nearestEdge(fc.x, fc.z, 3, 'road')!;
  const p = { x: 0, y: 0, z: 0 }; net.pointAt(hit.edge, hit.s, p);
  for (const dx of [-.8, 0, .8]) for (const dz of [1.1, 1.9, 2.7]) {
    const town = towns[i], b = restricted.world.addBuilding({ townId: town.id, x: p.x + dx, z: p.z + dz,
      angle: 0, w: .6, d: .6, type: 4, floors: 8, pop: 200, seed: 10000 + town.buildings.size, y: 4, built: 0 });
    town.buildings.add(b.id); town.pop += b.pop;
  }
}
restricted.stations.recomputeCatchment(); restricted.demand.rebuild();
const cells = [1, 2].map(owner => atomicTerminalCell(restricted, rl.stops, owner, longStock));
check(cells[0]?.slots.length === 4 && cells[1]?.slots.length === 2 && cells[0].key === cells[1].key,
  'third-owner permission creates real unequal usable receiving classes');
check([0, 1].every(i => JSON.stringify(capacityRouteBetween(restricted, rl.stops[i], rl.stops[1 - i], 1))
  === JSON.stringify(capacityRouteBetween(restricted, rl.stops[i], rl.stops[1 - i], 2))),
  'restricted operators still have identical native selected directed running hops');
touchSharedCapacity(restricted, rl);
check(rl.capacity!.demand!.revenue > 0, 'real walking demand prices the restricted-platform control');
const restrictedQuote = marginalTrainInvestment(restricted, rl, 1, longStock), altered = cold(restricted);
altered.vehicles.get(rl.vehicles[0])!.delivered = 1000;
check(JSON.stringify(marginalTrainInvestment(altered, altered.lines.get(rl.id)!, 1, longStock)) !== JSON.stringify(restrictedQuote),
  'unequal receiving classes keep the literal history-weighted fallback rather than enter the new fare pool');

console.log('native same-pattern fare settlement', { checks, quote, entrant, gross: splitRevenue,
  actualPeriodFares: [...fares], actualPeriodCalls: [...calls], privateFeeChange: cq.investor - fq.investor });
console.log('ALL CHECKS PASSED');
