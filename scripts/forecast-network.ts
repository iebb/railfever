// Native network competition in prospective railway quotes. Bundle as forecast-network.mjs and run with Node.
// Funded construction and stock only: generated residents, native walks, timetables, fares and reservations.
import { Game, TICK } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { patternHeadways, addPattern, setVehiclePattern, linePatterns, lineTable } from '../src/game/patterns';
import { planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { commitProposal } from '../src/game/construction';
import { transferWalkTime } from '../src/game/fares';
import { WALK_LINE } from '../src/game/stations';
import type { StationPlan } from '../src/game/stations';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { check, fails, placeAndConnect, depotBehind, addBusStop, roadDepotNear, checkReservations } from './lib';

const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'flat', water: 'low', startYear: 1990 });
g.aiEnabled = false; g.economy.money = 100_000_000;
const pair = placeAndConnect(g, 65, 140, 0, new Set(), 1, () => {});
check(pair, 'native railway stations and alignment constructed');
if (!pair) process.exit(1);
const { A, B, TA } = pair, depot = depotBehind(g, A, B);
const line = g.lines.create('rail', 0); line.stops = [A.id, B.id];
const cars = ['diesel_a', 'coach_steel', 'coach_steel'].map(id => MODEL_BY_ID.get(id)!);
const train = g.vehicles.buyTrain(depot, cars, line.id);
check(train instanceof Train, 'native accessible depot funds and opens a real train');
if (!(train instanceof Train)) process.exit(1);
const flush = () => { g.flushNetworkChanges(); g.lines.flushCatchment(); };
flush();
const headway = patternHeadways(g, line)[0].headway;
const quote = (h = headway) => g.demand.forecastLine([A, B], 'mainline', 120, h, 0, line.id);
const isolated = quote();
// Frozen native construction quote: no other reachable destinations means exact parity with the direct arithmetic.
// Re-frozen for 2.10 (ef67606 gave 214.7797683186935 / 512340.1568116724 for Wilmere - Shelminster): the user's halved
// walking reach and WALK_TRIP_INTENSITY (3.2x walking trips) change the arithmetic, and the halved reach moves this
// pair search to Weyden - Sunham. Same fixture, same exact-parity tolerance.
check(Math.abs(isolated.boardings - 80.39908175050506) < 1e-8
  && Math.abs(isolated.revenue - 148704.3761182762) < 1e-6, `no-background quote preserves previous direct arithmetic (${isolated.boardings}, ${isolated.revenue})`);

// A real road service joins the railway station and serves a different district of the generated town.
const candidates: { x: number; z: number; distance: number; join?: number }[] = [];
for (const edge of g.towns.streets(TA, 0)) {
  const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(edge, edge.len / 2, p);
  const plan = g.stations.planBusStop(p.x, p.z, 0);
  if (plan.ok) candidates.push({ ...p, distance: Math.hypot(p.x - A.x, p.z - A.z), join: plan.join?.id });
}
candidates.sort((a, b) => a.distance - b.distance);
const near = candidates.find(p => p.join === A.id), far = candidates.find(p => p.distance > 25 && !p.join);
check(near && far, 'native street stops include a railway interchange and a separate district');
if (!near || !far) process.exit(1);
const start = addBusStop(g, near.x, near.z, 0), end = addBusStop(g, far.x, far.z, 0);
const roadDepot = roadDepotNear(g, far.x, far.z, 0), background = g.lines.create('road', 0);
background.stops = [start, end];
const bus = g.vehicles.buyRoad(roadDepot, MODEL_BY_ID.get('bus_c')!, background.id);
check(start === A.id && end !== start && bus instanceof RoadVehicle, 'funded background bus uses the actual shared station');
flush();
check(g.lines.nextHop(A.id, end)?.line === background.id, 'background destination is natively reachable');
const network = quote(), faster = quote(headway / 2);
console.log(`native quotes: isolated ${isolated.boardings.toFixed(3)}; network ${network.boardings.toFixed(3)}; twice-frequency ${faster.boardings.toFixed(3)}`);
check(network.boardings < isolated.boardings * 0.6, 'reachable local bus destinations reduce the proposed railway allocation');
check(faster.boardings > network.boardings && faster.revenue > network.revenue,
  'new headway updates competition and retains a positive marginal frequency return');

// Native rail plan joins the bus district and accepts a walking link to the existing railway station.
// (2.10: a joined stop keeps its id and a station complex never links consecutive stops of a line, which would leave
// the line inside one station; the background bus runs A - end, so the rail plan joins another district stop.)
const other = candidates.find(p => p.distance > 25 && !p.join && Math.hypot(p.x - far.x, p.z - far.z) > 6);
const district = other ? addBusStop(g, other.x, other.z, 0) : -1;
check(district >= 0 && district !== end && district !== A.id && !g.stations.consecutiveStops(district, A.id), 'a second district stop off the background line');
flush();
let joined: StationPlan | null = null;
for (const edge of g.towns.streets(TA, 0)) {
  const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(edge, edge.len / 2, p);
  for (const offset of [3, 5, 8]) for (const angle of [0, Math.PI / 2, Math.PI / 4]) {
    const plan = g.stations.planRail(p.x + offset, p.z + offset, angle, 10, 2, 0,
      { mode: 'mainline', level: 'elevated', height: 5, style: 'modern' });
    check(!(plan.join?.id === end && plan.links.some(st => st.id === A.id)), 'a plan joining a stop never promises a link to its consecutive stop');
    if (plan.ok && plan.roadAccess && plan.join?.id === district && plan.links.some(st => st.id === A.id)) { joined = plan; break; }
  }
  if (joined) break;
}
check(joined, 'native station preflight supplies a real join and accepted walking link');
if (joined) {
  const before = JSON.stringify(serialize(g));
  const planned = g.demand.forecastLine([joined, B], 'mainline', 120, headway, 0);
  const duplicate = g.demand.forecastLine([joined, joined.join!, B], 'mainline', 120, headway, 0);
  const reversed = g.demand.forecastLine([joined.join!, joined, B], 'mainline', 120, headway, 0);
  check(planned.boardings === duplicate.boardings && planned.revenue === duplicate.revenue && planned.covered === duplicate.covered
    && duplicate.legLoads.length === 4 && planned.legLoads.length === 2
    && JSON.stringify(reversed) === JSON.stringify(duplicate), 'join has one walking/feeder claim while original leg indexes are retained');
  check(planned.covered > 0 && planned.boardings > 0, 'native prospective join retains genuine covered demand');
  check(JSON.stringify(serialize(g)) === before, 'prospective join/link quotes leave the entire save unchanged');
  const funds = g.economy.money;
  check(!g.stations.commitRail(joined, 0), 'preflighted joined facility commits with native clearance');
  check(Math.abs(funds - g.economy.money - joined.cost) < 1e-6 && g.stations.get(district)?.rail
    && g.stations.get(district)?.links.includes(A.id), 'native join pays its complete cost and commits the accepted link');
  flush();
}

// A third real station mounts onto the operating alignment. The unchanged all-stops pattern
// must remain in the quote's network when only an express is repriced.
const branch = deserialize(serialize(g)), route = branch.lines.get(line.id)!;
let middle: ReturnType<typeof planStationOnTrack> | null = null;
for (const e of branch.world.net.edges.values()) if (e.kind === 'rail' && e.station < 0 && e.depot < 0 && e.len > 1) {
  for (const f of [.5, .25, .75]) {
    const plan = planStationOnTrack(branch, e.id, e.len * f, { length: 10, tracks: 1, reuseTrack: true, style: 'modern' }, 0);
    if (plan.ok && plan.station?.roadAccess) { middle = plan; break; }
  }
  if (middle) break;
}
check(middle, 'partial-pattern witness has a native intermediate station preflight');
let linkTarget = -1, linkedLine = -1, prospectiveCost = 0;
if (middle?.station?.access) {
  // Fund the plan's own access road, then put real native stops on it before requoting the facility.
  const access = middle.station.access, firstRoad = branch.world.net.nextEdge;
  check(!commitProposal(branch, access), 'native curved station access road is funded and committed');
  const centre = middle.station, roads = [...branch.world.net.edges.values()].filter(e => e.id >= firstRoad && e.kind === 'road');
  outer: for (const edge of roads) for (const f of [.2, .4, .6, .8]) {
    const at = { x: 0, y: 0, z: 0 }; branch.world.net.pointAt(edge, edge.len * f, at);
    if (Math.hypot(at.x - centre.x, at.z - centre.z) > 25) continue;
    const id = addBusStop(branch, at.x, at.z, 0); if (id < 0) continue;
    const seed = branch.world.net.nearestEdge(centre.x, centre.z, 2, 'rail')!;
    const pl = planStationOnTrack(branch, seed.edge.id, seed.s, { length: 10, tracks: 1, reuseTrack: true, style: 'modern' }, 0);
    if (pl.ok && pl.station?.links.some(st => st.id === id) && pl.station.join?.id !== id) { middle = pl; linkTarget = id; break outer; }
  }
  check(linkTarget > 0, 'actual curved rail preflight has a distinct accepted transfer link');
  if (linkTarget > 0) {
    const feeder = branch.lines.create('road', 0); feeder.stops = [linkTarget, end]; linkedLine = feeder.id;
    const stock = branch.vehicles.buyRoad(roadDepot, MODEL_BY_ID.get('bus_c')!, feeder.id);
    check(stock instanceof RoadVehicle, 'native background bus serves the prospective curved transfer');
    branch.flushNetworkChanges(); branch.lines.flushCatchment();
    const seed = branch.world.net.nearestEdge(middle!.station!.x, middle!.station!.z, 2, 'rail')!;
    middle = planStationOnTrack(branch, seed.edge.id, seed.s, { length: 10, tracks: 1, reuseTrack: true, style: 'modern' }, 0);
    check(middle.ok && middle.station?.links.some(st => st.id === linkTarget), 'curved proposal is refreshed after native service/access mutation');
    const before = JSON.stringify(serialize(branch)), plan = middle!.station!;
    const ctx = (branch.demand as any).forecastRoutes([plan, branch.stations.get(B.id)!], 120, headway, 0);
    const source = plan.join?.id ?? -1, hop = ctx.tables.get(source)?.get(end);
    check(hop?.line === WALK_LINE && hop.alight === linkTarget, 'proposed native curved journey uses its accepted walk before the bus');
    prospectiveCost = hop?.cost ?? 0;
    check(prospectiveCost > 0 && JSON.stringify(serialize(branch)) === before, 'proposed curved-route table is a pure derived read');
  }
}

if (middle) {
  const built = commitStationOnTrack(branch, middle); check(!built.error, `native intermediate station commits (${built.error ?? 'ok'})`);
  if (!built.error) {
    if (linkTarget > 0) {
      const st = branch.stations.get(built.station)!, target = branch.stations.get(linkTarget)!;
      const gap = branch.stations.gap(st, target), native = branch.lines.nextHop(st.id, end);
      const ride = lineTable(branch, branch.lines.get(linkedLine)!).edges.find(e => e.from === linkTarget && e.to === end)!.cost;
      check(gap > 0 && !!st.rail?.alignment && st.rail.alignment.tracks.some(t => t.pieces.length > 1),
        'curved native facility keeps a real nonzero transfer gap');
      // (2.10, d2b8e53: a walk inside one station complex skips the external transfer base time)
      const internal = branch.stations.isSameStationComplex(st.id, target.id);
      check(native?.line === WALK_LINE && Math.abs(prospectiveCost - native.cost) < 1e-8
        && Math.abs(prospectiveCost - transferWalkTime(gap, internal) - ride) < 1e-8,
        'prospective curved link uses the same actual gap and ride cost as the committed native graph');
      console.log(`curved planned link: gap ${gap.toFixed(6)}u, proposed/native ${prospectiveCost.toFixed(6)}s`);
    }
    route.stops = [A.id, built.station, B.id, built.station]; branch.lines.rebuild();
    const express = addPattern(branch, route.id, 'express', [true, false, true, false]);
    const second = branch.vehicles.buyTrain(depot, cars, route.id);
    check(express && second instanceof Train, 'both native all-stops and express patterns have funded stock');
    if (express && second instanceof Train) {
      check(!setVehiclePattern(branch, second.id, express.id), 'native express stock assignment accepted');
      branch.flushNetworkChanges(); branch.lines.flushCatchment();
      const pts = [branch.stations.get(A.id)!, branch.stations.get(B.id)!];
      const hw = Math.max(600, patternHeadways(branch, route).find(p => p.pid === express.id)!.headway);
      const q = () => branch.demand.forecastLine(pts, 'mainline', 120, hw, 0, route.id, express.id);
      const before = JSON.stringify(serialize(branch)), first = q();
      const third = branch.vehicles.buyTrain(depot, cars, route.id);
      if (third instanceof Train) setVehiclePattern(branch, third.id, express.id);
      branch.lines.flushCatchment();
      check(third instanceof Train && JSON.stringify(first) === JSON.stringify(q()),
        'selected pattern old frequency is replaced once, even when its live fleet changes');
      check(linePatterns(route).length === 2 && patternHeadways(branch, route).some(p => p.pid !== express.id),
        'unaffected native pattern and its intermediate service survive prospective replacement');
      const ctxBefore = (branch.demand as any).forecastRoutes(pts, 120, hw, 0, route.id, express.id);
      const oldMiddle = ctxBefore.tables.get(A.id).get(built.station).cost;
      const oldDistrict = ctxBefore.tables.get(B.id).get(end).cost;
      const local = branch.vehicles.buyTrain(depot, cars, route.id);
      if (local instanceof Train) setVehiclePattern(branch, local.id, linePatterns(route)[0].id);
      branch.lines.flushCatchment();
      const moreLocal = q();
      const ctxAfter = (branch.demand as any).forecastRoutes(pts, 120, hw, 0, route.id, express.id);
      check(local instanceof Train && ctxAfter.tables.get(A.id).get(built.station).cost < oldMiddle
        && ctxAfter.tables.get(B.id).get(end).cost < oldDistrict,
        'unaffected native pattern legs and frequency update downstream background journey costs');
      console.log(`retained costs: middle ${oldMiddle.toFixed(3)} → ${ctxAfter.tables.get(A.id).get(built.station).cost.toFixed(3)}s; district ${oldDistrict.toFixed(3)} → ${ctxAfter.tables.get(B.id).get(end).cost.toFixed(3)}s`);
      console.log(`partial pattern: ${first.boardings.toFixed(3)} → ${moreLocal.boardings.toFixed(3)} boardings, native patterns ${patternHeadways(branch, route).map(p => `${p.pid}:${p.vehicles}`).join('/')}`);
      check(before !== JSON.stringify(serialize(branch)), 'explicit native stock purchase remains an actual funded mutation');
      branch.flushNetworkChanges(); branch.lines.flushCatchment();
      const snapshot = JSON.stringify(serialize(branch)), warm = q(), loaded = deserialize(JSON.parse(snapshot));
      const cold = loaded.demand.forecastLine([loaded.stations.get(A.id)!, loaded.stations.get(B.id)!], 'mainline', 120, hw, 0, route.id, express.id);
      check(JSON.stringify(warm) === JSON.stringify(cold) && snapshot === JSON.stringify(serialize(branch))
        && snapshot === JSON.stringify(serialize(loaded)), 'partial-pattern warm/cold quotes are equal and serialized-pure');
      let exact = true;
      for (let tick = 0; tick < 640; tick++) {
        branch.update(TICK); loaded.update(TICK);
        if (JSON.stringify(serialize(branch)) !== JSON.stringify(serialize(loaded))) { exact = false; break; }
      }
      check(exact, 'native curved join, pattern fleets and saved quote context replay every tick for640ticks');
    }
  }
}

// Warm/cold quote caches never persist decisions; loaded stock and real calls continue exactly.
flush();
const saved = JSON.stringify(serialize(g)), warm = quote(), twin = deserialize(JSON.parse(saved));
const cold = twin.demand.forecastLine([twin.stations.get(A.id)!, twin.stations.get(B.id)!], 'mainline', 120, headway, 0, line.id);
check(JSON.stringify(warm) === JSON.stringify(cold), 'cold-loaded and warm forecast results are identical');
check(saved === JSON.stringify(serialize(g)) && saved === JSON.stringify(serialize(twin)), 'forecast reads are serialized-pure');
for (let tick = 0; tick < 640; tick++) {
  g.update(TICK); twin.update(TICK);
  if (JSON.stringify(serialize(g)) !== JSON.stringify(serialize(twin))) { check(false, `exact route/forecast replay at tick ${tick}`); break; }
}
const calls = new Map<number, number>(), states = new Map<number, string>();
const day = g.day;
while (g.day < day + 360) {
  g.update(TICK);
  for (const v of [train, bus]) if (v instanceof Train || v instanceof RoadVehicle) {
    if (v.state === 'loading' && states.get(v.id) !== 'loading') {
      const st = v.targetStation(); if (st) calls.set(st.id, (calls.get(st.id) ?? 0) + 1);
    }
    states.set(v.id, v.state);
  }
}
console.log(`native calls ${[A.id, B.id, end].map(id => `${id}:${calls.get(id) ?? 0}`).join('/')}; rail delivered ${train.delivered}; bus delivered ${bus instanceof RoadVehicle ? bus.delivered : 0}`);
check([A.id, B.id, end].every(id => (calls.get(id) ?? 0) >= 2), 'funded rail and local bus serve every stop repeatedly');
check(train.delivered > 0 && bus instanceof RoadVehicle && bus.delivered > 0, 'genuine generated passengers use both native services');
check(checkReservations(g).length === 0 && train.state !== 'noroute', 'native calls respect physical routes and reservations');
const timings: number[] = [];
for (let i = 0; i < 50; i++) { const start = performance.now(); quote(headway / (1 + i % 4)); timings.push(performance.now() - start); }
console.log(`native marginal quote: mean ${(timings.reduce((s, t) => s + t, 0) / timings.length).toFixed(3)}ms, max ${Math.max(...timings).toFixed(3)}ms`);
if (fails.length) { console.log(`\n${fails.length} FAILURES`); process.exit(1); }
console.log('\nALL NETWORK FORECAST CHECKS PASSED');
