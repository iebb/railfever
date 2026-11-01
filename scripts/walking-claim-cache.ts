// Native walking allocations may be shared between frequency quotes; queues, routes and fares may not.
// Bundle as walking-claim-cache.mjs and run with Node.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { walkingCatchment } from '../src/game/catchment';
import { check, fails, placeAndConnect, depotBehind, checkReservations } from './lib';

const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'flat', water: 'low', startYear: 1990 });
g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.economy.money = 100_000_000;
const pair = placeAndConnect(g, 65, 140, 0, new Set(), 1, () => {});
check(pair, 'native paid railway supplies two physical walking catchments');
if (!pair) process.exit(1);
const { A, B } = pair, depot = depotBehind(g, A, B), line = g.lines.create('rail', 0);
line.stops = [A.id, B.id];
const cars = ['diesel_a', 'coach_steel', 'coach_steel'].map(id => MODEL_BY_ID.get(id)!);
const train = g.vehicles.buyTrain(depot, cars, line.id);
check(train instanceof Train, 'native accessible depot and purchased stock serve the real route');
if (!(train instanceof Train)) process.exit(1);
g.flushNetworkChanges(); g.lines.flushCatchment();
const d: any = g.demand, native = d.prepareWalkingClaims;
let reused = 0, computed = 0;
d.prepareWalkingClaims = function(...args: any[]) {
  const result = native.apply(this, args); result.reused ? reused++ : computed++; return result;
};
// The callback contains the original ordered overlap/claim/population pass. Bypassing retention executes
// that pass for every query, independently of the warm cache and its keys.
function literal<T>(query: () => T): T {
  const observed = d.prepareWalkingClaims;
  d.prepareWalkingClaims = (...args: any[]) => ({ value: args[args.length - 1](), reused: false });
  try { return query(); } finally { d.prepareWalkingClaims = observed; }
}
const quote = (points: any[] = [A, B], h = 120, speed = 100, owner = 0, pattern?: number,
  mode: 'rail' | 'bus' | 'tram' = 'rail', options: any = {}) =>
  d.forecastLine(points, 'mainline', speed, h, owner, line.id, pattern, mode, options);
function parity(label: string, query: () => any = () => quote()) {
  const before = JSON.stringify(serialize(g)), expected = literal(query), actual = query();
  check(JSON.stringify(actual) === JSON.stringify(expected), label + ': complete forecast equals literal ordered allocation');
  check(JSON.stringify(serialize(g)) === before, label + ': complete native save remains unchanged');
  return actual;
}
parity('cold'); const coldComputed = computed;
for (const h of [60, 90, 180, 240]) for (const options of [{}, { set: 'city' }, { set: 'intercity', cityLegs: true }])
  parity('native headway/set ' + h + '/' + JSON.stringify(options), () => quote([A, B], h, 80, 1, undefined, 'rail', options));
check(computed === coldComputed && reused >= 12, 'varied frequencies, owners, speeds and demand sets reuse only the walking preparation');
for (const mode of ['bus', 'tram'] as const) parity('native ' + mode + ' fare mode', () => quote([A, B], 75, 60, 0, undefined, mode));
parity('partial-pattern quote', () => quote([A, B], 100, 90, 0, 1));

const refreshAccess = g.stations.refreshAccess; let refreshReads = 0;
g.stations.refreshAccess = function(...args: Parameters<typeof refreshAccess>) { refreshReads++; return refreshAccess.apply(this, args); };
literal(() => quote()); const literalRefresh = refreshReads; refreshReads = 0; quote();
check(refreshReads > 0 && refreshReads === literalRefresh, 'warm reuse preserves every required native access-maintenance read');
g.stations.refreshAccess = refreshAccess;

// Caller outputs and later feeder additions do not own the retained population maps.
const changed = quote(); changed.legLoads.fill(-1); changed.revenue = -1; changed.sets.city.boardings = -1;
parity('caller output isolation');
for (const points of [[B, A], [A, A, B], [A, B, B], [A, B, A]]) parity('ordered duplicate/native path', () => quote(points));
const beforeEviction = computed; parity('bounded eviction');
check(computed === beforeEviction + 1, 'a fifth distinct physical path evicts the oldest of four preparations');
const custom = { x: A.x, z: A.z, townId: A.townId, walk: walkingCatchment(g, A) };
const beforeCustom = computed;
parity('caller-owned walk fallback', () => quote([custom, B])); parity('caller-owned walk fallback repeat', () => quote([custom, B]));
check(computed === beforeCustom + 2, 'uncommitted/caller-owned walking descriptors always execute their own allocation');

const oversized = Array.from({ length: 65 }, (_, i) => i % 2 ? B : A), beforeOversized = computed;
parity('oversized physical path fallback', () => quote(oversized)); parity('oversized physical path repeat', () => quote(oversized));
check(computed === beforeOversized + 2, 'oversized native queries retain the original pass without cache retention');

const bid = [...walkingCatchment(g, A).buildings.keys()].find(id => g.world.buildings.get(id)!.pop > 0)!;
check(bid !== undefined, 'native catchment contains a generated populated building');
if (bid !== undefined) {
  const building = g.world.buildings.get(bid)!, beforePop = quote().covered, beforeChange = computed;
  building.pop += 1; g.world.touchBuilding(building);
  const afterPop = parity('native attributed lot edit');
  check(computed > beforeChange && afterPop.covered !== beforePop, 'native lot version invalidates retained populations and updates genuine covered demand');
}
const regionOf = d.regionOf, beforeRegion = computed;
d.regionOf = function(b: any) { return regionOf.call(this, b); };
parity('region evaluator identity');
check(computed === beforeRegion + 1, 'a changed native region evaluator cannot reuse another evaluator\'s population rows');
d.regionOf = regionOf;
g.demand.rebuild(); parity('native district rebuild');
g.world.setVertex(1, 1, g.world.h[g.world.vi(1, 1)] + .01); parity('native terrain edit');
const previousTick = computed; g.stepTick(); parity('next native tick');
check(computed > previousTick, 'next fixed tick invalidates the disposable preparation');

// A failed/nested preparation cannot publish a partial allocation.
const region = d.regionOf; let thrown = false;
literal(() => quote([A])); const singleStats = JSON.stringify(d.forecastClaimStats);
literal(() => quote()); let throwStats = '';
d.regionOf = () => { throwStats = JSON.stringify(d.forecastClaimStats); throw new Error('diagnostic region failure'); };
try { quote([A]); } catch (e) { thrown = (e as Error).message === 'diagnostic region failure'; }
d.regionOf = region;
check(thrown, 'native allocation propagates a failing region read');
check(throwStats === singleStats && JSON.stringify(d.forecastClaimStats) === singleStats,
  'throwing population reads observe the original diagnostic assignment before allocation');
parity('after failed preparation');
let nesting = false, nested = 0;
d.regionOf = function(b: any) {
  if (!nesting && !nested) { nesting = true; nested++; quote([A], 150); nesting = false; }
  return region.call(this, b);
};
quote();
check(JSON.stringify(d.forecastClaimStats) === singleStats, 'nested allocation retains the literal diagnostic assignment order');
parity('nested independent preparation');
check(nested === 1, 'a nested native frequency quote completes its independent allocation');
d.regionOf = region;

const saved = JSON.stringify(serialize(g)), cold = deserialize(JSON.parse(saved));
const cq = cold.demand.forecastLine([cold.stations.get(A.id)!, cold.stations.get(B.id)!], 'mainline', 100, 120, 0, line.id);
check(JSON.stringify(cq) === JSON.stringify(quote()) && JSON.stringify(serialize(cold)) === saved,
  'cold deserialization returns identical complete forecasts without saved cache state');
let exact = true;
for (let tick = 0; tick < 128; tick++) {
  g.stepTick(); cold.stepTick();
  if (JSON.stringify(serialize(g)) !== JSON.stringify(serialize(cold))) { exact = false; break; }
}
check(exact && !checkReservations(g).length && !checkReservations(cold).length, 'warm and cold native service continue exactly with lawful reservations');
console.log('native walking preparations', { computed, reused });
if (fails.length) process.exit(1);
