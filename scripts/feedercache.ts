// Access-site geometry is disposable. Native generated roads/lots, changing claims and forecasts
// retain the previous uncached merge's exact order and arithmetic. Bundle as feedercache.mjs.
import { Game, TICK } from '../src/game/game';
import { MAINLINE_FEEDERS } from '../src/game/constants';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { check, fails, placeAndConnect, depotBehind, checkReservations } from './lib';

// The previous feederPools access merge, kept as an independent no-site-cache control.
function previousWalk(this: any, s: any): Map<number, number> {
  const buildings = new Map<number, number>();
  for (const p of s.access?.length ? s.access : [s]) {
    const leg = Math.hypot(p.x - s.x, p.z - s.z), reach = MAINLINE_FEEDERS.reach - leg;
    if (reach <= 0) continue;
    for (const [bid, distance] of this.feederWalk(p.x, p.z, reach))
      buildings.set(bid, Math.min(buildings.get(bid) ?? Infinity, distance + leg));
  }
  return buildings;
}
function withoutSiteCache<T>(d: any, query: () => T): T {
  const fast = d.feederSiteWalk;
  d.feederSiteWalk = previousWalk;
  try { return query(); } finally { d.feederSiteWalk = fast; }
}
const poolJSON = (p: any[]) => JSON.stringify(p.map(s => ({ pop: s.pop, regions: [...s.regions] })));
const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'flat', water: 'low', startYear: 1990,
  aiConfigs: [{ startMoney: 60_000_000, focus: { rail: 2, road: .3, tram: 1.5 } }] });
g.aiEnabled = false; g.aiAcquisitions = false; g.vehicles.ambientEnabled = false; g.economy.money = 100_000_000;
const pair = placeAndConnect(g, 65, 140, 0, new Set(), 1, () => {});
check(pair, 'generated native railway construction succeeds');
if (!pair) process.exit(1);
const { A, B, TA } = pair, depot = depotBehind(g, A, B), line = g.lines.create('rail', 0);
line.stops = [A.id, B.id];
const cars = ['diesel_a', 'coach_steel', 'coach_steel'].map(id => MODEL_BY_ID.get(id)!);
const train = g.vehicles.buyTrain(depot, cars, line.id);
check(train instanceof Train, 'funded native train uses an accessible depot');
if (!(train instanceof Train)) process.exit(1);
g.flushNetworkChanges(); g.lines.flushCatchment();
const d: any = g.demand;
const roads = g.towns.streets(TA, 0).map(e => {
  const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len / 2, p); return p;
}).filter(p => Math.hypot(p.x - A.x, p.z - A.z) < 60);
check(TA.pop >= 1500 && roads.length > 1, 'native town supplies eligible feeders and distinct street access');
if (TA.pop < 1500 || roads.length < 2) process.exit(1);
const site = { ...d.feederSite(A), quality: .8, access: [...d.feederSite(A).access, roads[0], roads[roads.length - 1]] };
const rival = { ...site, x: roads[1].x, z: roads[1].z, quality: .45, access: [roads[1], roads[0]] };
const sites = [site, rival, { ...d.feederSite(B), quality: .7 }], covered = new Set<number>();
const nativeWalk = d.feederWalk.bind(d);
let walkCalls = 0;
d.feederWalk = (...args: number[]) => { walkCalls++; return nativeWalk(...args); };
function parity(label: string) {
  const before = JSON.stringify(serialize(g));
  for (const s of sites) check(JSON.stringify([...d.feederSiteWalk(s)]) === JSON.stringify([...previousWalk.call(d, s)]),
    label + ' exact merged lot order and distances');
  const fast = d.feederPools(sites, covered), old = withoutSiteCache(d, () => d.feederPools(sites, covered));
  check(poolJSON(fast) === poolJSON(old), label + ' exact native populations, competing weights and region order');
  check(JSON.stringify(serialize(g)) === before, label + ' leaves full saved state unchanged');
  return fast;
}
const first = parity('cold');
check(first[0].pop > 0 && first[1].pop > 0, 'overlapping native access sites claim actual generated residents');
const lots = [...d.feederSiteWalk(site).keys()] as number[];
check(lots.length > 10 && lots.some(bid => d.feederSiteWalk(rival).has(bid)), 'multi-access geometry contains shared native lots');
const initialWalkCalls = walkCalls;
for (let i = 0; i < 20; i++) d.feederPools(sites, covered);
check(walkCalls === initialWalkCalls, 'repeated pool queries reuse the merged geometry without walking or merging access maps');
parity('warm');
const inherited: any = Object.create(d), parentWalk = d.feederSiteWalk(site), beforePreview = walkCalls;
check(JSON.stringify([...inherited.feederSiteWalk(site)]) === JSON.stringify([...parentWalk])
  && inherited.feederSiteWalk(site) !== parentWalk && walkCalls > beforePreview,
  'an inherited preview starts with its own disposable site cache');
check(d.feederSiteWalk(site) === parentWalk, 'preview reads do not replace the parent geometry cache');

// Live quantities must change the result even with the same cached geometry.
const bid = lots.find(id => g.world.buildings.get(id)?.townId === TA.id)!;
const building = g.world.buildings.get(bid)!;
const initialPool = poolJSON(d.feederPools(sites, covered)), population = building.pop;
building.pop += 137;
check(poolJSON(parity('live population')) !== initialPool, 'live population is not cached');
building.pop = population;
const beforeQuality = poolJSON(d.feederPools(sites, covered)); site.quality = .25; rival.quality = .95;
check(poolJSON(parity('live quality')) !== beforeQuality, 'quality and competing allocation are recomputed');
const beforeCovered = poolJSON(d.feederPools(sites, covered)); covered.add(bid);
check(poolJSON(parity('live covered lot')) !== beforeCovered, 'covered lots are excluded from warm geometry');
covered.clear();
const beforeTown = poolJSON(d.feederPools(sites, covered)), townId = building.townId;
building.townId = -1;
check(poolJSON(parity('live lot town')) !== beforeTown, 'lot town eligibility is recomputed'); building.townId = townId;
const townPop = TA.pop; TA.pop = 1499;
check(parity('live town eligibility')[0].pop === 0, 'native small-town cutoff remains live'); TA.pop = townPop;

// Districts can be rebuilt without any access geometry version change.
const version = d.feederGeometryKey(), oldRegion = d.regionOf(building), radius = TA.radius;
TA.radius = 10000; g.demand.rebuild();
parity('district rebuild');
check(d.feederGeometryKey() === version && d.regionOf(building) !== oldRegion,
  'region remapping is recomputed independently of retained walking geometry');
TA.radius = radius; g.demand.rebuild();

function newGeometry(label: string, change: () => void) {
  const prior = d.feederSiteWalk(site); change();
  check(d.feederSiteWalk(site) !== prior, label + ' invalidates the merged map'); parity(label);
}
newGeometry('direct access coordinate edit', () => { site.access[1] = { x: roads[0].x + .25, z: roads[0].z }; });
newGeometry('direct site coordinate edit', () => { site.x += .25; });
newGeometry('access order edit', () => { site.access.reverse(); });
newGeometry('direct access addition', () => { site.access.push(roads[1]); });
newGeometry('access removal', () => { site.access.splice(1, 1); });
newGeometry('fallback without access', () => { site.access.length = 0; });
newGeometry('line geometry epoch', () => { g.lines.version++; });
newGeometry('terrain geometry epoch', () => { g.world.heightsVersion++; });
const street = g.towns.streets(TA, 0)[0];
newGeometry('native road removal', () => { g.world.net.removeEdge(street.id); });
const donor = g.world.buildings.get(lots[1])!;
let added = -1;
newGeometry('native building addition', () => { added = g.world.addBuilding({ ...donor, x: donor.x + .1, z: donor.z + .1 }).id; });
newGeometry('native building removal', () => { g.world.removeBuilding(added); });

// The public getter must still return a caller-owned map.
const publicWalk = g.demand.feederReachAt(site, site.access, MAINLINE_FEEDERS.reach);
publicWalk.clear();
check(g.demand.feederReachAt(site, site.access, MAINLINE_FEEDERS.reach).size > 0,
  'editing a public returned map cannot corrupt future geometry');
parity('public map edit');
const retained = d.feederSiteWalk(site);
for (let i = 0; i < 300; i++) d.feederSiteWalk({ x: -200 - i, z: -200, townId: -1, quality: 1 });
check(d.feederSiteWalk(site) !== retained, 'bounded site cache evicts and recomputes an early result'); parity('evicted');

// Full forecasts use native fares, headways, routed coverage and mutable outputs.
const forecast = (h = 140, kmh = 120) => g.demand.forecastLine([A, B], 'mainline', kmh, h, 0, line.id);
forecast();
g.aiEnabled = true;
const urbanTown = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
check(g.ais[0].startProject('lightrail', [urbanTown.id]), 'funded native AI city project starts before the saved replay');
const aiBefore = JSON.stringify(g.ais[0].state);
const saved = JSON.stringify(serialize(g));
for (const h of [140, 90, 250, 301, 140]) {
  const fast = forecast(h), old = withoutSiteCache(d, () => forecast(h));
  check(JSON.stringify(fast) === JSON.stringify(old), 'complete forecast matches previous merge at headway ' + h);
}
check(JSON.stringify(forecast(90)) !== JSON.stringify(forecast(250)), 'headway changes live quality, demand and fare estimates');
for (const kmh of [80, 160]) check(JSON.stringify(forecast(140, kmh)) === JSON.stringify(withoutSiteCache(d, () => forecast(140, kmh))),
  'live speed and fare forecast matches previous merge at ' + kmh + 'km/h');
const quote = forecast(), revenue = quote.revenue; quote.revenue = -1; quote.legLoads.fill(-1);
check(forecast().revenue === revenue && forecast().legLoads.every(v => v >= 0), 'forecast output remains independent and live');
check(saved === JSON.stringify(serialize(g)), 'warm and uncached forecast reads are serialized-pure');
const twin = deserialize(JSON.parse(saved)), cold: any = twin.demand;
cold.feederSiteWalk = previousWalk;
const twinQuote = (h = 140) => twin.demand.forecastLine([twin.stations.get(A.id)!, twin.stations.get(B.id)!], 'mainline', 120, h, 0, line.id);
check(JSON.stringify(forecast()) === JSON.stringify(twinQuote()) && saved === JSON.stringify(serialize(twin)),
  'loaded no-site-cache control has exact forecast and full native state');
let exact = true, plannerRan = false;
for (let tick = 0; tick < 640; tick++) {
  if (tick % 40 === 0) check(JSON.stringify(forecast(100 + tick % 170)) === JSON.stringify(twinQuote(100 + tick % 170)),
    'live warm/cold native forecast at fixed tick ' + tick);
  g.update(TICK); twin.update(TICK);
  if ((g.ais[0] as any).urbanSurvey || (g.ais[0] as any).urbanTask) plannerRan = true;
  if (JSON.stringify(serialize(g)) !== JSON.stringify(serialize(twin))) { exact = false; console.log('first replay mismatch', tick); break; }
}
check(exact, 'all 640 full serialized native ticks match the previous merge control');
check(JSON.stringify(g.ais[0].state) !== aiBefore && plannerRan,
  'native AI advances its saved city survey and construction planner during the exact replay');
check(checkReservations(g).length === 0 && checkReservations(twin).length === 0, 'native replay keeps lawful reservations');
console.log('FEEDER_CACHE_PROOF', JSON.stringify({ lots: lots.length, initialWalkCalls, ticks: 640, exact, revenue, ai: g.ais[0].state }));
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
