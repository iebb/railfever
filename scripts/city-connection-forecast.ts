// City rail must price the native paid onward journeys through a shared bus/rail facility.
// Bundle as city-connection-forecast.mjs; quotes use one native boarding queue for direct and connecting OD/sets.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { plannedSet, forecastTransferJourney, localTripMultiplier } from '../src/game/demand';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { routeGraph, routeTables } from '../src/game/lines';
import { addTramTracks } from '../src/game/build-ops';
import { pathPoints, tramDepotGen } from '../src/game/ai-tram';
import { runGen } from '../src/game/routing';
import { DAY_SECONDS } from '../src/game/constants';
import { WALK_LINE } from '../src/game/stations';
import { station, flatGame } from './stationlib';
import { build, free, edgeSnapAt, roadOpts, connectStations, depotBehind, addBusStop, roadDepotNear, check, fails, checkReservations } from './lib';

const saved = (g: Game) => JSON.stringify(serialize(g));
function scenario(kind: 'road' | 'tram') {
  console.log(`native ${kind} onward city forecast`);
  const g = flatGame(256, 4); g.aiEnabled = false;
  function town(name: string, x: number, z: number, radius: number) {
    const t: any = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius, buildings: new Set(), nextGrowthDay: 1e9,
      hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
    g.towns.list.push(t); return t;
  }
  const local = town('Connection Town', 125, 128, 95), outside = town('Outer Town', 135, 215, 20);
  check(!!build(g, free(g, 45, 134), free(g, 220, 134), roadOpts(0, 'street'), 'city street'), 'native city pedestrian street is funded');
  check(!!build(g, edgeSnapAt(g, 'road', 135, 134), free(g, 135, 235), roadOpts(0, 'street'), 'outer street'), 'native outer-town street is funded');
  const A = station(g, 75, 128, Math.PI / 2, 10, 2), B = station(g, 135, 128, Math.PI / 2, 10, 2);
  check(!!A && !!B && A.townId === local.id && B.townId === local.id, 'native city stations have real street access in the same town');
  if (!A || !B) process.exit(1);
  check(connectStations(g, A, B).ok, 'native city rail alignment and throat are funded');
  const depot = depotBehind(g, A, B), line = g.lines.create('rail', 0); line.stops = [A.id, B.id];
  const stock = g.vehicles.buyTrain(depot, ['diesel_a', 'coach_steel'].map(id => MODEL_BY_ID.get(id)!), line.id);
  check(stock instanceof Train, 'native city train is bought from its reachable depot');
  if (!(stock instanceof Train)) process.exit(1);
  function lot(t: any, x: number, z: number, pop: number) {
    const b = g.world.addBuilding({ townId: t.id, x, z, angle: Math.PI, w: 1, d: 1, type: 4, floors: 8, pop, seed: Math.round(x + z), y: 4, built: 0 });
    t.buildings.add(b.id); t.pop += pop;
  }
  for (let x = 50; x <= 215; x += 5) lot(local, x, 135.5, 250);
  for (let z = 190; z <= 230; z += 5) lot(outside, 136.5, z, 250);
  g.demand.rebuild();
  const flush = () => { g.flushNetworkChanges(); g.lines.flushCatchment(); };
  flush();
  const quote = (game: Game, headway: number, points = [game.stations.get(A.id)!, game.stations.get(B.id)!], partial?: number) =>
    game.demand.forecastLine(points, 'mainline', 80, headway, 0, line.id, partial, 'rail', plannedSet(game, points));
  const direct = quote(g, 120);
  // Frozen against the unmodified 0eb88a2 implementation, before an onward service exists.
  check(direct.boardings === 2004.0000000000002 && direct.revenue === 3623502.4292105944,
    'an isolated city line preserves the original direct-only floating-point arithmetic exactly');
  const choices: { x: number; z: number; d: number }[] = [];
  for (const e of g.world.net.edges.values()) if (e.kind === 'road') for (const f of [.1, .25, .5, .75, .9]) {
    const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len * f, p);
    if (g.stations.planBusStop(p.x, p.z, 0).join?.id === B.id) choices.push({ ...p, d: Math.hypot(p.x - B.x, p.z - B.z) });
  }
  choices.sort((a, b) => a.d - b.d);
  const near = choices[0], joined = near ? addBusStop(g, near.x, near.z, 0) : -1;
  const district = addBusStop(g, 200, 134, 0), remote = addBusStop(g, 135, 220, 0);
  const edges = [...g.world.net.edges.values()].filter(e => e.kind === 'road' && e.depot < 0).map(e => e.id);
  if (kind === 'tram') {
    const works = addTramTracks(g, edges, 0);
    check(!works.error && works.changed > 0 && works.cost > 0, 'native tram tracks are actually built and paid');
  }
  const busDepot = kind === 'road' ? roadDepotNear(g, 200, 134, 0) : runGen(tramDepotGen(g, pathPoints(g, edges), [joined, district, remote], 0));
  const road = g.lines.create(kind, 0); road.stops = [joined, district, remote, district];
  const bus = g.vehicles.buyRoad(busDepot, MODEL_BY_ID.get(kind === 'road' ? 'bus_c' : 'tram_b')!, road.id);
  check(joined === B.id && district > 0 && remote > 0 && bus instanceof RoadVehicle, 'paid native onward service uses the SAME rail station ID and reaches local and outside-town districts');
  flush();
  check(g.stations.get(district)?.townId === local.id && g.stations.get(remote)?.townId === outside.id,
    'onward districts supply both native city journeys and intercity access legs');
  const path = g.lines.nextHop(A.id, district);
  check((path?.line === line.id || path?.lines?.includes(line.id)) && g.lines.nextHop(B.id, district)?.line === road.id,
    'native local onward journey boards this city train then the actual shared-station onward service');
  const { edges: graph } = routeGraph(g), tables = routeTables(graph, graph.keys());
  check(forecastTransferJourney(tables, B.id, district, line.id, id => g.lines.get(id)?.kind === 'rail', () => 1).length === 0,
    'a passenger already inside the shared complex uses only the onward service and earns no invented city rail leg');
  const network = quote(g, 120);
  console.log('city connection quotes', JSON.stringify({ direct, network }));
  check(direct.transfers === 0 && network.transfers > 0 && network.sets.city.transfers > 0 && network.sets.intercity.access.transfers > 0,
    'shared physical interchange credits actual local onward rides and outside-town rail access exactly in their demand sets');
  const cityOnly = g.demand.forecastLine([A, B], 'mainline', 80, 120, 0, line.id, undefined, 'rail', { set: 'city' });
  const intercity = g.demand.forecastLine([A, B], 'mainline', 80, 120, 0, line.id, undefined, 'rail', { set: 'intercity' });
  check(cityOnly.boardings === network.sets.city.boardings && cityOnly.revenue === network.sets.city.revenue
    && Math.abs(network.boardings - cityOnly.boardings - network.sets.intercity.access.boardings) < 1e-8
    && Math.abs(network.revenue - cityOnly.revenue - network.sets.intercity.access.revenue) < 1e-8
    && intercity.transfers > 0 && intercity.sets.intercity.access.transfers === network.sets.intercity.access.transfers,
    'city-only and intercity/access filters retain the exact joint-capture fare and boarding attribution');
  // Observe the real generic leg records only; the wrapper retains every original native calculation and return.
  const dm = g.demand as any, native = dm.forecastMainlineConnections.bind(dm);
  let records: { station: number; count: number; connecting: boolean }[] = [];
  let connectionArgs: any[] = [];
  dm.forecastMainlineConnections = (...args: any[]) => {
    connectionArgs = args;
    const result = native(...args), rows = args[6]?.rides;
    if (rows) for (const ride of rows) { const fare = ride.fare; ride.fare = (count: number) => { records.push({ station: [A.id, B.id][ride.from], count, connecting: ride.connecting }); return fare(count); }; }
    return result;
  };
  const snapshot = saved(g), sparse = quote(g, 1200), sparseRows = records; records = [];
  // A real accepted walking-complex link must never manufacture a paid railway ride.
  const walkWorld = deserialize(JSON.parse(snapshot));
  const visitor = walkWorld.addAICompany({ startMoney: 1_000_000 });
  const walkStop = addBusStop(walkWorld, 131, 134, visitor.id);
  check(walkStop > 0 && walkStop !== B.id && (walkWorld.stations.get(B.id)!.links.includes(walkStop) || !walkWorld.stations.link(B.id, walkStop)),
    'a distinct native surface facility accepts a lawful walking link to the interchange');
  walkWorld.flushNetworkChanges(); walkWorld.lines.flushCatchment();
  const walkGraph = routeGraph(walkWorld).edges, walkTables = routeTables(walkGraph, walkGraph.keys());
  check(walkWorld.stations.isSameStationComplex(B.id, walkStop)
    && walkGraph.get(B.id)?.some(edge => edge.to === walkStop && edge.line === WALK_LINE)
    && !walkTables.get(B.id)?.has(walkStop)
    && forecastTransferJourney(walkTables, B.id, walkStop, line.id,
      id => walkWorld.lines.get(id)?.kind === 'rail', () => 1,
      (a, b) => walkWorld.stations.isSameStationComplex(a, b)).length === 0,
    'staying entirely inside one actual walking complex earns no invented city rail fare');
  // Controlled cross-boundary catchment: real graph/facilities, but only cross-region long-distance demand.
  // Their station town IDs still match, which must not turn long-distance trips into boosted local OD.
  const boundary = deserialize(JSON.parse(snapshot)), boundaryDemand = boundary.demand as any;
  const [nativeSites, nativeWalking, nativeBackground, nativeContext, speed, gap] = connectionArgs;
  const mixedWalking = nativeWalking.map((s: any) => ({ pop: s.pop, regions: new Map(s.regions) }));
  const foreignRegion = boundary.demand.regions.find(r => r.town === outside.id)!.id;
  mixedWalking[0].regions.set(foreignRegion, 80); mixedWalking[0].pop += 80;
  boundary.demand.od.fill(0); boundary.demand.ld.fill(0);
  for (const r of boundary.demand.regions) if (r.town === local.id) {
    boundary.demand.ld[foreignRegion * boundary.demand.regions.length + r.id] = .1;
    boundary.demand.ld[r.id * boundary.demand.regions.length + foreignRegion] = .1;
  }
  const unboosted: any[] = [], boosted: any[] = [];
  const args = [nativeSites, mixedWalking, nativeBackground, nativeContext, speed, gap];
  const raw = boundaryDemand.forecastMainlineConnections(...args, { rides: unboosted, localTrips: false });
  const urban = boundaryDemand.forecastMainlineConnections(...args, { rides: boosted, localTrips: true });
  check(unboosted.some(ride => ride.sameTown && ride.passengers > 0)
    && localTripMultiplier(boundary, A, 'rail') > 1 && JSON.stringify(raw) === JSON.stringify(urban),
    'same-town facilities with mixed-region claims preserve long-distance demand exactly without urban OD uplift');
  const fast = quote(g, 600);
  check(fast.boardings > sparse.boardings && fast.revenue > sparse.revenue, 'sparse real city calls retain a positive native joint-queue headway return');
  const capWorld = deserialize(JSON.parse(snapshot)), origins = new Set(sparseRows.map(r => r.station));
  for (const id of origins) {
    const st = capWorld.stations.get(id)!; st.waiting.clear(); st.waitingTotal = 0;
    capWorld.stations.addWaiting(st, line.id, id === A.id ? B.id : A.id, id === A.id ? B.id : A.id, 100_000);
    capWorld.stations.trimWaiting(st, 600 + st.rail!.tracks * st.rail!.length * 12 + st.stops.length * 150);
    const count = sparseRows.filter(r => r.station === id).reduce((n, r) => n + r.count, 0);
    check(count <= st.waitingTotal * 360 * DAY_SECONDS / 1200 + 1e-8,
      `direct and connecting OD/sets jointly fit physical station${id}'s native integer queue (no duplicate budgets)`);
  }
  check(sparseRows.some(r => r.connecting) && sparseRows.some(r => !r.connecting), 'the same physical boarding budgets really contain both direct and connecting riders');
  check(saved(g) === snapshot, 'full native forecasts and joint capture are saved-state pure');
  const clone = deserialize(JSON.parse(snapshot)), cold = quote(clone, 1200);
  check(JSON.stringify(cold) === JSON.stringify(sparse) && saved(clone) === snapshot, 'warm/cold full quotes and complete saved states match exactly');
  const duplicate = quote(g, 1200, [A, B, B]);
  check(duplicate.boardings === sparse.boardings && duplicate.revenue === sparse.revenue,
    'a repeated occurrence of the SAME boarding facility cannot duplicate its joint queue or demand claim');
  check(quote(g, 1200, undefined, 0).transfers === 0, 'a single partial-pattern quote never acquires the whole line attractive-set connecting receipts');
  let exact = true;
  for (let tick = 0; tick < 160; tick++) { g.stepTick(); clone.stepTick(); if (saved(g) !== saved(clone)) { exact = false; break; } }
  check(exact && !checkReservations(g).length && !checkReservations(clone).length, 'native purchased stock continues exactly with legal reservations after quoted save/reload');
  const end = g.day + 180;
  while (g.day < end) g.stepTick();
  console.log(`native ${kind} delivered rail ${stock.delivered}, onward ${bus instanceof RoadVehicle ? bus.delivered : 0}`);
  check(stock.delivered > 0 && bus instanceof RoadVehicle && bus.delivered > 0 && line.incomeYear + line.incomeLast > 0,
    'native city and onward services actually carry paid passengers after construction');
}
scenario('road'); scenario('tram');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED'); process.exitCode = fails.length ? 1 : 0;
