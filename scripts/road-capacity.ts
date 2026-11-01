// Road fleet growth uses the actual vehicle, route cycle and every operator sharing a curb.
// Bundle as road-capacity.mjs; run from a scratch directory.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID, availableModels } from '../src/game/vehicle-types';
import { planTownLine, roadPlanJob, roadCapacityQuote, roadCurbRoute, roadForecasts, roadDriving, moreValue, pays, routeOf, type BusHost } from '../src/game/ai-bus';
import { nativeRoadItinerary, evaluateNativeRoadCycle } from '../src/game/road-physics';
import { YEAR_S } from '../src/game/opcosts';
import { RoadVehicle, makeLaneSeg, roadDepotReaches } from '../src/game/roadvehicle';
import { simNow, fareFor, stationFareContext } from '../src/game/fares';
import { bezLine } from '../src/game/geom';
import { addPattern } from '../src/game/patterns';
import { outAndBack } from '../src/game/lines';
import { roadDepotNear } from './lib';
import { TramPlanner } from '../src/game/ai-tram';
import { modelYearCost, type LineInfo } from '../src/game/ai';

function drain<T>(g: Generator<void, T>): T { let r = g.next(); while (!r.done) r = g.next(); return r.value; }
const host = (g: Game): BusHost => (g.ais[0] as unknown as { busHost(): BusHost }).busHost();
const old = MODEL_BY_ID.get('bus_a')!, modern = MODEL_BY_ID.get('bus_b')!;

// Zero-wait riders board before origin handling and pay at alighting, before destination handling.
function nativeRiderTime(includeOriginHandling: boolean) {
  const g = Game.create({ size: 128, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1965 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.vehicles.ambient = [];
  g.world.h.fill(2); g.world.heightsVersion++;
  const net = g.world.net, a = net.addNode('road', 20, 2, 64), b = net.addNode('road', 110, 2, 64);
  net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(91).fill(2), [], 'road', -1);
  const ids: number[] = [];
  for (const x of [45, 85]) { assert.equal(g.stations.commitBusStop(x, 64, 0), null); ids.push(g.stations.nextId - 1); }
  const line = g.lines.create('road', 0); line.stops = ids; line.loop = false; line.evenSpacing = false;
  const route = nativeRoadItinerary(g, line)!; assert(route);
  const v = new RoadVehicle(g, g.vehicles.nextId++, old, -1);
  v.owner = 0; v.lineId = line.id; line.vehicles = [v.id]; g.vehicles.map.set(v.id, v);
  const first = route.legs[0].parts[0]; v.stopIndex = line.stops.indexOf(route.stops[0]);
  v.placeAt(makeLaneSeg(g, net.edges.get(first.seg.e)!, first.seg.dir), first.from); g.lines.rebuild();
  const from = g.stations.get(route.stops[0])!, to = g.stations.get(route.stops[1])!;
  g.stations.addWaiting(from, line.id, to.id, to.id, 1, 0, simNow(g));
  const dwell = v.serveStation(from, 0.05), t0 = [...v.cargo.values()][0]?.t0;
  assert.equal(v.load, 1); assert.equal(t0, simNow(g), 'zero-wait rider clock starts before origin handling');
  if (includeOriginHandling) { v.state = 'loading'; v.loadTimer = dwell; } else v.depart();
  for (let tick = 0; tick < 30000 && !v.delivered; tick++) g.stepTick();
  assert.equal(v.delivered, 1);
  const elapsed = simNow(g) - t0!;
  const fare = fareFor(Math.hypot(from.x - to.x, from.z - to.z), elapsed, 1, stationFareContext(g, from, to, 'bus'));
  assert(Math.abs(v.incomeYear - fare) < 1e-9, 'native fare is charged before destination handling');
  return { elapsed, dwell, tick: g.tickSeconds };
}
const riding = nativeRiderTime(false), boarded = nativeRiderTime(true);
assert(Math.abs(boarded.elapsed - riding.elapsed - boarded.dwell) <= boarded.tick,
  'native fare clock retains origin handling; equal native destination bases must not be subtracted');

// A bidirectional triangular street has independent curbs on each side. Native routing chooses them.
{
  const h = Game.create({ size: 128, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1965, aiCompanies: 1 });
  h.aiEnabled = false; h.world.h.fill(2); h.world.heightsVersion++;
  const net = h.world.net, corners = [[25, 25], [105, 25], [65, 105]].map(([x, z]) => net.addNode('road', x, 2, z, 1, 0, -1));
  const stops: number[] = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i], b = corners[(i + 1) % corners.length];
    const edge = net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(Math.hypot(a.x - b.x, a.z - b.z)) + 1).fill(2), [], 'road', -1);
    const p = { x: 0, y: 0, z: 0 }; net.pointAt(edge, edge.len / 2, p);
    const plan = h.stations.planBusStop(p.x, p.z, 1);
    assert(plan.ok); const id = h.stations.nextId;
    assert.equal(h.stations.commitBusStop(p.x, p.z, 1), null); stops.push(id);
  }
  const clockwise = h.lines.create('road', 1); clockwise.stops = stops; clockwise.loop = true;
  const reverse = h.lines.create('road', 0); reverse.stops = [...stops].reverse(); reverse.loop = true;
  const a = roadCurbRoute(h, clockwise), b = roadCurbRoute(h, reverse);
  assert.equal(a.calls.size, 3); assert.equal(b.calls.size, 3);
  assert([...a.calls.keys()].every(k => !b.calls.has(k)), 'opposite lane berths are independent');
  const day = h.day, demandVersion = h.demand.version;
  h.day++; h.demand.version++;
  assert.equal(roadCurbRoute(h, clockwise), a, 'unchanged native itinerary stays cached across days and demand rebuilds');
  h.day = day; h.demand.version = demandVersion;
  const heightsVersion = h.world.heightsVersion; h.world.heightsVersion++;
  assert.equal(roadCurbRoute(h, clockwise), a, 'unrelated terrain epochs do not invalidate native lane profiles');
  h.world.heightsVersion = heightsVersion;
  clockwise.stops = [...stops].reverse();
  assert.deepEqual([...roadCurbRoute(h, clockwise).calls.keys()].sort(), [...b.calls.keys()].sort(), 'direct stop-order edits invalidate itinerary cache');
  clockwise.stops = stops;
  const shifted = h.stations.get(stops[0])!.stops[0], originalStop = { ...shifted }, point = { x: 0, y: 0, z: 0 };
  net.pointAt(net.edges.get(shifted.edge)!, shifted.s + 1, point);
  shifted.s++; shifted.x = point.x; shifted.z = point.z;
  assert.notDeepEqual([...roadCurbRoute(h, clockwise).calls.keys()].sort(), [...a.calls.keys()].sort(), 'native stop geometry edits invalidate itinerary cache');
  Object.assign(shifted, originalStop);
  const relevelled = net.edges.get(originalStop.edge)!, profile = new Float32Array(relevelled.prof);
  relevelled.prof = Float32Array.from(profile, height => height + 1); net.touchEdge(relevelled);
  assert.notDeepEqual([...roadCurbRoute(h, clockwise).calls.keys()].sort(), [...a.calls.keys()].sort(), 'native network geometry changes invalidate itinerary cache');
  relevelled.prof = profile; net.touchEdge(relevelled);
  const returning = h.lines.create('road', 1); returning.stops = outAndBack(stops); returning.loop = false;
  assert.equal(roadCurbRoute(h, returning).sites.length, 4, 'interior out-and-back stop is called in both directions, terminal once');
  const express = addPattern(h, returning.id, 'express', returning.stops.map(id => id !== stops[1]))!;
  assert.equal(roadCurbRoute(h, returning, express.id).sites.length, 2, 'native pattern skips the intermediate curb');
  const expressFlags = [...express.stops]; express.stops = returning.stops.map(() => true);
  assert.equal(roadCurbRoute(h, returning, express.id).sites.length, 4, 'direct pattern edits invalidate itinerary cache');
  express.stops = expressFlags;
  const alias = { ...h.stations.get(stops[0])!, id: h.stations.nextId++ };
  h.stations.map.set(alias.id, alias);
  const aliasLine = h.lines.create('road', 0); aliasLine.stops = [alias.id, ...stops.slice(1)]; aliasLine.loop = true;
  assert.deepEqual([...roadCurbRoute(h, aliasLine).calls.keys()].sort(), [...a.calls.keys()].sort(), 'curb identity follows geometry across station IDs');
  const upperCorners = corners.map(c => net.addNode('road', c.x, 12, c.z, 1, 0, -1)), upperStops: number[] = [];
  for (let i = 0; i < upperCorners.length; i++) {
    const from = upperCorners[i], to = upperCorners[(i + 1) % upperCorners.length];
    const edge = net.addEdge('road', from.id, to.id, bezLine(from.x, from.z, to.x, to.z), new Float32Array(Math.ceil(Math.hypot(from.x - to.x, from.z - to.z)) + 1).fill(12), [], 'road', -1);
    const station = h.stations.get(stops[i])!;
    const upper = { ...station, id: h.stations.nextId++, stops: station.stops.map(s => ({ ...s, edge: edge.id })) };
    h.stations.map.set(upper.id, upper); upperStops.push(upper.id);
  }
  const elevated = h.lines.create('road', 1); elevated.stops = upperStops; elevated.loop = true;
  assert([...roadCurbRoute(h, elevated).calls.keys()].every(k => !roadCurbRoute(h, clockwise).calls.has(k)), 'stacked streets at identical map coordinates have independent curbs');
  for (const sid of stops) {
    const edge = net.edges.get(h.stations.get(sid)!.stops[0].edge)!; edge.tram = true; edge.tramOwner = 1;
  }
  const tram = h.lines.create('tram', 1); tram.stops = [...stops]; tram.loop = true;
  h.setAccessPolicy(1, 'auto-reject');
  assert.equal(roadCurbRoute(h, tram, undefined, 1).calls.size, 3, 'tram owner reaches its own native curbs');
  assert.equal(roadCurbRoute(h, tram, undefined, 0).calls.size, 0, 'partner without tram access has no complete curb itinerary');
  const tramSites = stops.map(id => ({ ...h.stations.get(id)!, station: h.stations.get(id)! }));
  const denied = drain(roadForecasts(h, 0, tramSites, { model: MODEL_BY_ID.get('tram_b')!, vehicles: 1, loop: true }, [1]))[0];
  assert.equal(denied.cycle, Infinity, 'committed native targets without operator access cannot use an undirected survey fallback');
  h.setAccessPolicy(1, 'open');
  assert.equal(roadCurbRoute(h, tram, undefined, 0).calls.size, 3, 'opening access invalidates operator-specific curb cache');
  // Native vehicles need no depot for this stationary planning fixture.
  const v = new RoadVehicle(h, h.vehicles.nextId++, old, -1); v.owner = 1; v.lineId = clockwise.id;
  h.vehicles.map.set(v.id, v); clockwise.vehicles.push(v.id);
  const quiet = drain(moreValue(host(h), clockwise, modern));
  assert(quiet && !pays(quiet), 'an empty town does not buy capacity despite physical room');
  const shortened = addPattern(h, clockwise.id, 'short-turn', clockwise.stops.map(id => id !== stops[1]))!;
  v.pattern = shortened.id;
  const patternSave = JSON.stringify(serialize(h));
  assert.equal(drain(moreValue(host(h), clockwise, modern)), null, 'no fabricated full-route revenue quote for a short-turn fleet');
  assert.equal(JSON.stringify(serialize(h)), patternSave, 'pattern quote aligns metadata only on copies');
  const nearJunction = (s: number, owner: number) => {
    const ids = stops.map(sid => {
      const source = h.stations.get(sid)!, edge = net.edges.get(source.stops[0].edge)!;
      const point = { x: 0, y: 0, z: 0 }; net.pointAt(edge, s, point);
      const station = { ...source, id: h.stations.nextId++, owner, x: point.x, z: point.z,
        stops: [{ edge: edge.id, s, x: point.x, z: point.z }] };
      h.stations.map.set(station.id, station); return station.id;
    });
    const line = h.lines.create('road', owner); line.stops = ids; line.loop = true;
    return line;
  };
  const nearA = nearJunction(0.05, 1), nearB = nearJunction(0.1, 0);
  assert.deepEqual([...roadCurbRoute(h, nearA).calls.keys()].sort(), [...roadCurbRoute(h, nearB).calls.keys()].sort(), 'distinct raw stop coordinates clamp to the same native junction berths');
  const putVehicle = (line: typeof clockwise) => {
    const bus = new RoadVehicle(h, h.vehicles.nextId++, old, -1); bus.owner = line.owner; bus.lineId = line.id;
    h.vehicles.map.set(bus.id, bus); line.vehicles.push(bus.id);
  };
  putVehicle(nearA);
  const aloneNearJunction = roadCapacityQuote(h, nearA, modern);
  for (let i = 0; i < 3; i++) putVehicle(nearB);
  assert(roadCapacityQuote(h, nearA, modern).limit < aloneNearJunction.limit, 'geometric prefilter retains shared traffic whose raw coordinates differ at junction trims');
}

const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1965, aiCompanies: 1 });
g.aiEnabled = false; g.aiAcquisitions = false; g.companies[1].economy.money = 1e9;
const town = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const plan = drain(planTownLine(host(g), town, old));
assert(plan, 'natural town has a viable bus route');
assert.match(drain(roadPlanJob(host(g), plan)), /^opened /);
const line = [...g.lines.map.values()].find(l => l.owner === 1 && l.kind === 'road')!;
assert(line);
for (const id of line.vehicles.slice(2)) g.vehicles.sell(id); // natural demand with a deliberately reduced service
const depot = [...g.depots.map.values()].find(d => d.owner === 1 && d.kind === 'road')!;
assert(depot);
const route = routeOf(g, line)!;
const sites = route.path.map(id => ({ ...g.stations.get(id)!, station: g.stations.get(id)! }));
const n = line.vehicles.length;
const current = line.vehicles.map(id => (g.vehicles.get(id) as RoadVehicle).model!);
const forecasts = drain(roadForecasts(g, 1, sites, { model: modern, models: current, vehicles: n, loop: route.loop }, [n, n + 1], line.id));
const baseline = drain(roadForecasts(g, 1, sites, { model: old, vehicles: n, loop: route.loop }, [n], line.id))[0];
assert(Math.abs(forecasts[0].seats - baseline.seats) < 1e-7, 'existing old fleet capacity is retained when pricing a modern purchase');
assert(forecasts[1].seats > forecasts[0].seats, 'proposed model adds actual seat throughput');
const oldCycle = evaluateNativeRoadCycle(g, line, old)!, newCycle = evaluateNativeRoadCycle(g, line, modern)!;
assert(Math.abs(forecasts[0].cycle - oldCycle.cycle) < 1e-7, 'existing service uses its directed native free-flow cycle');
assert(Math.abs(forecasts[1].headway - 1 / (n / oldCycle.cycle + 1 / newCycle.cycle)) < 1e-7,
  'mixed fleet frequency sums its exact native model cycles');
assert(Math.abs(forecasts[1].seats - (n * old.capacity / oldCycle.cycle + modern.capacity / newCycle.cycle) * YEAR_S * 0.85) < 1e-7,
  'seat throughput follows native free-flow time without counting congestion as physical capacity');
const survey = sites.map(({ station, ...site }) => site);
const surveyed = drain(roadForecasts(g, 1, survey, { model: old, vehicles: n, loop: route.loop }, [n], line.id))[0];
assert.equal(surveyed.cycle, roadDriving(g, survey, old, route.loop)!.cycle, 'uncommitted survey targets retain the explicit routing fallback');
const emptyFleet = drain(roadForecasts(g, 1, sites, { model: old, vehicles: 0, loop: route.loop }, [0], line.id))[0];
assert.equal(emptyFleet.seats, 0); assert.equal(emptyFleet.riders, 0); assert(Number.isFinite(emptyFleet.cycle));
const quote = drain(moreValue(host(g), line, modern));
assert(quote && quote.model.id === modern.id && quote.outlay >= modern.cost, 'purchase quote uses exactly the bus being bought');
assert(pays(quote), 'additional modern bus earns its costs on the naturally busy town route');
const quiet = roadCapacityQuote(g, line, modern);
assert(quiet.limit > n, 'light curb workload has physical room for another bus');
assert(Number.isFinite(quiet.delayCost), 'light curb delay is priced');
const busySave = JSON.stringify(serialize(g));
for (const h of [g, deserialize(JSON.parse(busySave))]) {
  const before = JSON.stringify(serialize(h)), l = h.lines.get(line.id)!;
  const offered = drain(moreValue(host(h), l, modern));
  assert(offered && pays(offered), 'busy quote remains profitable after rebuilding derived caches');
  assert.deepEqual(offered, quote, 'cold and warm derived caches produce the identical economic decision');
  assert.equal(JSON.stringify(serialize(h)), before, 'profitable forecast reads leave saves unchanged');
}

// Another operator on another line at the same stops consumes the same physical curbs.
const partner = g.lines.create('road', 0);
partner.stops = [...line.stops]; partner.loop = line.loop;
g.economy.money = 1e9;
const firstStop = g.stations.get(line.stops[0])!;
const foreignDepot = roadDepotNear(g, firstStop.x, firstStop.z, 0);
assert(foreignDepot >= 0, 'native partner depot is buildable');
const ownQuote = roadCapacityQuote(g, line, modern);
const truck = MODEL_BY_ID.get('mailtruck_b')!;
const mailPartner = g.lines.create('road', 0); mailPartner.stops = [...line.stops]; mailPartner.loop = line.loop;
const mailVehicles: RoadVehicle[] = [];
for (let i = 0; i < 3; i++) {
  const v = g.vehicles.buyRoad(foreignDepot, truck, mailPartner.id);
  assert(v instanceof RoadVehicle); mailVehicles.push(v);
}
const mailShared = roadCapacityQuote(g, line, modern);
assert(mailShared.limit < ownQuote.limit, 'catalog mail trucks consume the same native passenger curbs');
for (const v of mailVehicles) v.model = { ...truck, mail: 0 };
const emptyTrucks = roadCapacityQuote(g, line, modern);
assert(mailShared.limit < emptyTrucks.limit, 'full native mail handling reduces curb capacity beyond empty-truck clearance');
for (const v of mailVehicles) { v.model = truck; g.vehicles.sell(v.id); }
g.lines.delete(mailPartner.id);
assert.deepEqual(roadCapacityQuote(g, line, modern), ownQuote, 'removing native shared mail traffic restores available capacity');
for (let i = 0; i < 3; i++) {
  const v = g.vehicles.buyRoad(foreignDepot, modern, partner.id);
  assert(v instanceof RoadVehicle);
}
partner.incomeLast = 2_000_000;
const shared = roadCapacityQuote(g, line, modern);
assert(shared.limit < ownQuote.limit, 'foreign service reduces available curb slots');
assert(shared.delayCost > ownQuote.delayCost, 'cost includes delay to the foreign operator\'s receipts');
while (roadCapacityQuote(g, line, modern).limit > line.vehicles.length) {
  assert(g.vehicles.buyRoad(foreignDepot, modern, partner.id) instanceof RoadVehicle);
  assert(partner.vehicles.length < 500, 'finite native stop throughput');
}
assert.equal(drain(moreValue(host(g), line, modern)), null, 'saturated shared curbs reject an extra bus');

// Quotes consume no simulation state, including after derived caches are discarded by loading.
const saved = JSON.stringify(serialize(g));
for (const h of [g, deserialize(JSON.parse(saved))]) {
  const before = JSON.stringify(serialize(h)), l = h.lines.get(line.id)!;
  for (let i = 0; i < 3; i++) { roadCapacityQuote(h, l, modern); drain(moreValue(host(h), l, modern)); }
  assert.equal(JSON.stringify(serialize(h)), before, 'capacity and purchase reads leave saves unchanged');
}
const replay = deserialize(JSON.parse(saved));
for (let tick = 0; tick < g.ticksPerDay * 3; tick++) { g.stepTick(); replay.stepTick(); }
assert.equal(JSON.stringify(serialize(g)), JSON.stringify(serialize(replay)), 'shared saturated fleets replay exactly');
// A literal tram service uses the same exact-model economic and shared-curb admission in monthly management.
{
  const h = Game.create({ size: 384, seed: 11, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1965,
    aiConfigs: [{ activeness: 1, focus: { rail: 0, road: 0, tram: 1 } }] });
  h.aiEnabled = false; h.aiAcquisitions = false;
  const ai = h.ais[0], eco = h.company(ai.companyId).economy;
  eco.money += 50_000_000;
  while (eco.loan > 0 && eco.repay()) { /* settle the native opening loan before comparing purchase charges */ }
  const planner = new TramPlanner(h, ai.companyId);
  assert(planner.start());
  let result = planner.step(1), units = 1;
  while (result === 'running' && units++ < 2000) result = planner.step(1);
  assert.equal(result, 'done', planner.reason);
  const project = planner.project!, line = h.lines.get(project.line)!;
  assert.equal(line.kind, 'tram'); assert(line.vehicles.length >= 2);
  const manager = ai as unknown as { lines: Map<number, LineInfo>; manage(): void };
  const info: LineInfo = { kind: 'tram', towns: [project.town], depot: project.depot, maxVehicles: line.vehicles.length, opened: h.day };
  manager.lines.set(line.id, info);
  h.flushNetworkChanges(); h.stations.recomputeCatchment(); h.lines.flushCatchment();
  const model = availableModels(h.year, 'tram').sort((a, b) => b.capacity / (b.cost + modelYearCost(b, h.year) * 8)
    - a.capacity / (a.cost + modelYearCost(a, h.year) * 8))[0];
  assert(model);
  const crowd = () => {
    line.incomeLast = line.costLast * 2 + 1_000_000; line.passLast = 100;
    for (const sid of new Set(line.stops)) {
      const st = h.stations.get(sid)!, to = line.stops.find(id => id !== sid)!;
      h.stations.addWaiting(st, line.id, to, to, 20); st.lostLast = 4 * model.capacity;
    }
  };
  crowd();
  const quiet = drain(moreValue(host(h), line, model));
  assert(quiet && pays(quiet), 'a native quiet tram has a positive exact-model marginal quote');
  console.log(`tram admission, quiet: ${quiet.why}; existing yard, ${model.cost} paid`);
  assert.equal(quiet.outlay, model.cost, 'the existing paid tram depot is reused without a phantom road-depot charge');
  assert.equal(drain(moreValue(host(h), line, modern)), null, 'a bus cannot be quoted for a tram line');
  const n0 = line.vehicles.length, cash0 = eco.money;
  manager.manage();
  assert.equal(line.vehicles.length, n0 + 1, 'monthly review buys the profitable tram');
  assert.equal((h.vehicles.get(line.vehicles.at(-1)!) as RoadVehicle).model, model, 'monthly quote and purchase use the same current tram');
  assert(Math.abs(cash0 - eco.money - model.cost) < 1e-7, 'the admitted tram is paid at its native price');

  // Another paid operator shares these berths. Its fare losses must count before physical saturation.
  const partner = h.lines.create('road', 0); partner.stops = [...line.stops]; partner.loop = line.loop;
  h.economy.money += 20_000_000;
  const stop = h.stations.get(line.stops[0])!.stops[0];
  const partnerDepot = roadDepotNear(h, stop.x, stop.z, 0);
  assert(partnerDepot >= 0); partner.incomeLast = 2_000_000;
  assert(roadDepotReaches(h, h.depots.get(partnerDepot)!, line.stops[0]) && roadCurbRoute(h, line, undefined, 0).calls.size > 0);
  assert.equal(drain(moreValue({ ...host(h), me: 0 }, line, model)), null,
    'a reachable road depot cannot fund a tram purchase without an owned native tram yard');
  let economicSave = '';
  while (roadCapacityQuote(h, line, model).limit >= 2 + line.stops.length || !economicSave) {
    assert(h.vehicles.buyRoad(partnerDepot, modern, partner.id) instanceof RoadVehicle);
    assert(partner.vehicles.length < 100);
    const quote = drain(moreValue(host(h), line, model));
    if (quote && !pays(quote)) {
      console.log(`tram admission, shared: ${quote.why}; curb delay ${Math.round(roadCapacityQuote(h, line, model).delayCost)}`);
      economicSave = JSON.stringify(serialize(h));
    }
    if (roadCapacityQuote(h, line, model).limit === line.vehicles.length) break;
  }
  assert(economicSave, 'foreign curb delay can make a physical tram slot uneconomic');

  // Paid stock occupies its real curbs before the legacy stop-count limit is reached.
  while (roadCapacityQuote(h, line, model).limit > line.vehicles.length) {
    assert(h.vehicles.buyRoad(project.depot, model, line.id) instanceof RoadVehicle);
    assert(line.vehicles.length < 100);
  }
  assert(line.vehicles.length < 2 + line.stops.length, 'physical tram capacity is stricter than the old stop-count ceiling');
  info.maxVehicles = 2 + line.stops.length;
  crowd();
  const saved = JSON.stringify(serialize(h));
  for (const world of [deserialize(JSON.parse(economicSave)), h, deserialize(JSON.parse(saved))]) {
    const l = world.lines.get(line.id)!, before = JSON.stringify(serialize(world));
    const quote = drain(moreValue(host(world), l, model));
    assert(!quote || !pays(quote), 'native trams refuse saturated or uneconomic shared curbs');
    assert.equal(JSON.stringify(serialize(world)), before, 'tram refusal quotes are pure with cold and warm caches');
    const controller = world.ais[0] as unknown as { lines: Map<number, LineInfo>; manage(): void };
    const assets = () => JSON.stringify([world.company(ai.companyId).economy.toJSON(), world.vehicles.nextId, l.vehicles,
      l.stops, l.patterns, controller.lines.get(l.id), [...world.vehicles.map.values()].map(v => [v.id, v.owner, v.lineId])]);
    const prior = assets(); controller.manage();
    assert.equal(assets(), prior, 'monthly curb refusal spends nothing and preserves stock, owners, routes and fleet limits');
  }
  h.flushNetworkChanges(); h.stations.recomputeCatchment(); h.lines.flushCatchment();
  const loaded = deserialize(JSON.parse(JSON.stringify(serialize(h))));
  for (let tick = 0; tick < h.ticksPerDay * 3; tick++) {
    h.stepTick(); loaded.stepTick();
    const a = JSON.stringify(serialize(h)), b = JSON.stringify(serialize(loaded));
    if (a !== b) {
      let at = 0; while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
      assert.fail(`native tram replay tick ${tick}, byte ${at}: ${a.slice(at - 60, at + 100)} vs ${b.slice(at - 60, at + 100)}`);
    }
  }
}
console.log('PASS actual mixed fleet and purchase model; quiet/shared/saturated physical admission; foreign delay costs; pure reads and exact replay');
