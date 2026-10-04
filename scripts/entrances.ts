// Station entrances: a ground station's side hall, footbridge / underpass and platform-end gate on both sides of
// the tracks (sites, collisions, stairs spacing, access streets), the walking catchment they add, removal (station
// window and demolition), costs and upkeep, rebuilding in place (moved entrances keep a street, or go with a
// warning), re-levelling, save / load (exact, old saves), and the AI adding entrances where the residents they newly
// reach pay for them (fixtures: called directly and in the running game, saved and reloaded), then a long run on a
// seeded world that must replay exactly after loading (entrances there as the AI finds them worth it).
// Bundle as entrances.mjs (esbuild --bundle --platform=node --format=esm) and run with node.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { rectsOverlap } from '../src/game/towns';
import { distToRect } from '../src/game/world';
import { bulldoze } from '../src/game/build-ops';
import {
  ENTRANCE_TYPES, GROUND_ENTRANCES, entranceCost, entranceLandings, entranceKind, landingRect, entranceAlong,
  planStationUpgrade, commitStationUpgrade, railWidth, entranceUpkeep, entrancesGo, landingDoor,
} from '../src/game/stations';
import { planRelevel, commitRelevel } from '../src/game/trackops';
import type { Station, EntranceKind } from '../src/game/stations';
import { walkingCatchment, walkingCatchmentWithout, walkingPopulation, entrancePlanCatchment } from '../src/game/catchment';
import { stationCrossings } from '../src/game/station-styles';
import { runNetworkTask, networkDaily, networkPlanner, saveNetwork, loadNetwork } from '../src/game/ai-network';
import type { AIController } from '../src/game/ai';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { RoadVehicle } from '../src/game/roadvehicle';
import { PASSENGER_RATE_SCALE, PASSENGER_FARE_SCALE } from '../src/game/constants';
import { addBusStop, fails } from './lib';
import { flatGame, station, endNode, loco, depotFor, check, build, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
if (!process.argv[1]?.endsWith('entrances.mjs')) throw new Error('bundle this test as entrances.mjs');

type G = Game;
const flush = (g: G) => { g.stations.refreshAccess(true); g.lines.catchmentDirty = true; g.lines.flushCatchment(); };
const pop = (g: G, ids: Iterable<number>) => { let p = 0; for (const id of ids) p += g.world.buildings.get(id)?.pop ?? 0; return p; };
function streets(g: G, owner = -1) {
  const net = g.world.net;
  const node = (x: number, z: number) => net.addNode('road', x, 3, z, 0, 0, owner);
  return (x0: number, z0: number, x1: number, z1: number, type = 'street') => {
    const a = node(x0, z0), b = node(x1, z1), len = Math.hypot(x1 - x0, z1 - z0);
    return net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(3), [], type, owner);
  };
}
const house = (g: G, x: number, z: number, angle: number, p = 20, townId = -1) =>
  g.world.addBuilding({ townId, x, z, angle, w: 0.8, d: 0.8, type: 0, floors: 2, pop: p, seed: 1, y: 3, built: 0 });
/** Residents only entrance `i` of a station brings within walking reach (as the station window lists them). */
const alone = (g: G, S: Station, i: number) => { const wo = walkingCatchmentWithout(g, S, i).buildings; return pop(g, [...walkingCatchment(g, S).buildings.keys()].filter((id) => !wo.has(id))); };
/** Everything planning may not change. */
const stateOf = (g: G) => JSON.stringify([serialize(g), g.world.net.nextNode, g.world.net.nextEdge, g.world.net.version, g.networkVersion,
  g.lines.catchmentDirty, g.stations.walkVersion, [...g.world.dirtyObj], [...g.world.dirtyTerrain]]);
/** Landings of every entrance clear of the track area, roads and each other. */
function clearOfEverything(g: G, st: Station): string | null {
  const r = st.rail!, net = g.world.net;
  const plat = { x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: r.length };
  const rects = r.entrances.flatMap((e, i) => entranceLandings(e).map((p) => ({ i, rect: landingRect(entranceKind('ground', e), p) })));
  for (const { i, rect } of rects) {
    if (rectsOverlap(rect, plat, 0)) return `entrance ${i} overlaps the track area`;
    if (rectsOverlap(rect, r.building, 0)) return `entrance ${i} overlaps the station building`;
    for (const e of net.edgesNear(rect.x - 3, rect.z - 3, rect.x + 3, rect.z + 3)) {
      const geo = net.geo(e), hw = net.halfWidth(e);
      for (let k = 0; k < geo.n; k++) if (distToRect(geo.pts[k * 3], geo.pts[k * 3 + 2], rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2) < hw - 0.06) return `entrance ${i} stands on ${e.kind} ${e.id}`;
    }
    for (const o of rects) if (o.i !== i && rectsOverlap(rect, o.rect, 0)) return `entrances ${i} and ${o.i} overlap`;
  }
  return null;
}

/**
 * A two-track ground station along x (tracks east-west, axis angle pi/2: right of the axis is north, -z) between
 * two streets: the station building's street south of the tracks, and a street right beside the track area to the
 * north, with houses along both (their front doors on the street). The streets are not connected: only an entrance
 * on the north side reaches the north houses.
 */
function fixture(owner = 0) {
  const g = flatGame(192, 3);
  const road = streets(g);
  road(50, 99.2, 142, 99.2); // south: the building's street
  road(50, 93.9, 142, 93.9); // north: beside the track area
  const north: number[] = [], south: number[] = [];
  for (let x = 60; x <= 132; x += 4) { north.push(house(g, x, 92.3, 0).id); south.push(house(g, x, 100.6, Math.PI).id); }
  const S = station(g, 96, 96, Math.PI / 2, 10, 2, owner)!;
  return { g, S, north, south };
}

// Read the real planner's saved valuation, then compare it with live shares after building that entrance.
// Unequal walks to a served bus stop and the new railway entrance expose equal-stop-count attribution.
{
  console.log('entrance valuation: unequal overlapping walks match the live share-out');
  const { g, ai, me, H } = aiFixture();
  const near = addBusStop(g, 74, 93.9, 0), far = addBusStop(g, 140, 93.9, 0);
  const busLine = g.lines.create('road', 0); busLine.stops = [near, far];
  const bus = new RoadVehicle(g, g.vehicles.nextId++, MODEL_BY_ID.get('bus_c')!, -1, false);
  bus.lineId = busLine.id; bus.state = 'stopped'; g.vehicles.map.set(bus.id, bus); busLine.vehicles.push(bus.id);
  // An unserved overlapping stop must not participate while served stations reach the residents.
  const unserved = addBusStop(g, 102, 93.9, 0);
  g.lines.rebuild(); flush(g);
  check(near >= 0 && far >= 0 && unserved >= 0 && g.lines.stationServed(near) && !g.lines.stationServed(unserved), 'overlap fixture has served and unserved competing stops');
  const current = walkingCatchment(g, H).buildings;
  runNetworkTask(ai, 'capacity', 0);
  const network = saveNetwork(g), state = network.companies.find(([id]) => id === me)![1];
  state.job = { task: 'capacity', cursor: 0, done: 0, items: [{ ids: [H.id], entrance: { at: 0 } }] };
  loadNetwork(g, network);
  networkDaily(ai);
  const best = saveNetwork(g).companies.find(([id]) => id === me)?.[1].job?.items?.[0].entrance?.best;
  check(!!best && H.rail!.entrances.length === 0, 'capture a positive saved entrance valuation before construction');
  if (best) {
    const plan = g.stations.planEntrance(H.id, best.x, best.z, me, best.kind, { street: false });
    check(plan.ok && !plan.access, 'valued entrance reaches the existing street without new construction');
    const loaded = deserialize(JSON.parse(JSON.stringify(serialize(g)))), st = loaded.stations.get(H.id)!;
    const built = loaded.stations.planEntrance(st.id, best.x, best.z, me, best.kind, { street: false });
    check(!loaded.stations.commitEntrance(st.id, built, me), 'build the valued entrance for a live share comparison');
    flush(loaded);
    let live = 0;
    for (const id of walkingCatchment(loaded, st).buildings.keys()) {
      if (current.has(id)) continue;
      const shares = loaded.stations.stationsForBuilding(id), i = shares.st.indexOf(st.id);
      if (i >= 0) live += loaded.world.buildings.get(id)!.pop * shares.w[i];
    }
    // Fixture has no observed pickups or income: the planner's fixed default annual value per resident.
    const perResident = 2 * PASSENGER_RATE_SCALE * 300 * PASSENGER_FARE_SCALE * 1.5;
    const valued = ((best.gain + plan.cost) / (5 + 5 * ai.config.risk) + ENTRANCE_TYPES[plan.kind].upkeep) / perResident;
    console.log(`  entrance residents: valued ${valued}, live ${live}`);
    check(live > 0 && Math.abs(valued - live) < 1e-8, 'entrance resident valuation equals live best coverage and relative walking weights');
  }
}
if (process.argv.includes('--regression')) { done(); process.exit(fails.length ? 1 : 0); }

// ------------------------------------------------------------------------------------------ placement
{
  console.log('ground station: entrances on both sides of the tracks');
  const { g, S, north, south } = fixture();
  const r = S.rail!;
  flush(g);
  const before = S.catchPop, beforeSet = new Set(walkingCatchment(g, S).buildings.keys());
  const side = (p: { x: number; z: number }) => ((p.x - r.x) * Math.cos(r.angle) - (p.z - r.z) * Math.sin(r.angle) >= 0 ? 'north' : 'south');
  check(r.level === 'ground' && side(r.building) === 'south' && S.roadAccess, `fixture: the building and its forecourt on the south street (${side(r.building)})`);
  check(north.every((id) => !beforeSet.has(id)) && south.some((id) => beforeSet.has(id)), `before: only south houses within walking reach (${before.toFixed(0)} residents)`);

  // planning is pure: every kind on both sides, with and without access streets, leaves the game as it was
  const state = () => stateOf(g);
  const before0 = state();
  let planned = 0;
  for (const kind of GROUND_ENTRANCES) for (const z of [94.6, 97.6]) for (const x of [91, 94, 96, 99, 101]) planned += g.stations.planEntrance(S.id, x, z, 0, kind).ok ? 1 : 0;
  check(state() === before0 && planned > 10, `planning entrances changes nothing (${planned} valid plans of ${GROUND_ENTRANCES.length * 10})`);

  // a side hall on the north side, right beside the street there
  const hall = g.stations.planEntrance(S.id, 96, 94.6, 0, 'hall');
  check(hall.ok && hall.kind === 'hall' && hall.landings.length === 1 && side(hall.landings[0]) === 'north' && hall.landings[0].road && !hall.access,
    `side hall planned north of the tracks beside the street (${hall.error ?? 'ok'})`);
  check(hall.cost === entranceCost('hall', r) && hall.cost >= 55_000, `side hall price by type and track width (${hall.cost})`);
  const money0 = g.economy.money;
  check(!g.stations.commitEntrance(S.id, hall, 0) && r.entrances.length === 1 && g.economy.money === money0 - hall.cost, 'side hall built and paid for');
  check(r.entrances[0].kind === 'hall' && r.entrances[0].cost === hall.cost, 'the entrance keeps its kind and price');
  flush(g);
  const withHall = new Set(walkingCatchment(g, S).buildings.keys());
  const gained = north.filter((id) => withHall.has(id));
  check(!withHall.has(north[0]) && !withHall.has(north[north.length - 1]) && gained.some((id) => Math.abs(g.world.buildings.get(id)!.x - hall.landings[0].x) <= 8), 'the hall reaches nearby surviving north houses and excludes the far ends after the 30% walking reduction');
  check(gained.length >= 6 && S.catchPop > before + 100, `catchment gain: ${gained.length} north houses newly within reach, ${before.toFixed(0)} -> ${S.catchPop.toFixed(0)} residents`);
  console.log(`  catchment with the north side hall: ${before.toFixed(0)} -> ${S.catchPop.toFixed(0)} residents (${gained.length} north houses newly within walking reach)`);
  const solo = pop(g, [...withHall].filter((id) => !walkingCatchmentWithout(g, S, 0).buildings.has(id)));
  check(solo === pop(g, gained), `the station window's newly covered residents of the hall (${solo}) are exactly the north houses it reaches`);

  // the same place again: its stairs would meet the hall's
  const again = g.stations.planEntrance(S.id, 96.3, 94.6, 0, 'footbridge');
  check(!again.ok && /stairs/.test(again.error ?? ''), `no second crossing on top of the first (${again.error})`);

  // a footbridge further along: stairs down to both streets' sides
  const fb = g.stations.planEntrance(S.id, 99.5, 94.6, 0, 'footbridge');
  check(fb.ok && fb.landings.length === 2 && new Set(fb.landings.map(side)).size === 2, `footbridge with stairs on both sides (${fb.error ?? fb.landings.map(side).join('/')}, ${fb.warnings.join('; ')})`);
  check(fb.landings.some((p) => p.road) && Math.abs(entranceAlong(r, fb.entrance!) - 3.5) < 0.01, 'footbridge landings: a street on the north side; stairs at the clicked place along the platforms');
  check(!g.stations.commitEntrance(S.id, fb, 0), 'footbridge built');

  // the south side: a gate at the west platform end, through a short access street to the south street
  const gate = g.stations.planEntrance(S.id, 91.2, 97.5, 0, 'gate');
  check(gate.ok && side(gate.landings[0]) === 'south' && !!gate.access && gate.cost > entranceCost('gate', r),
    `gate at the platform end south of the tracks with an access street (${gate.error ?? `${gate.access?.stats.len.toFixed(1)} u, ${gate.cost}`})`);
  const edges0 = g.world.net.edges.size;
  check(!g.stations.commitEntrance(S.id, gate, 0) && g.world.net.edges.size > edges0, 'gate built with its street');
  flush(g);
  check(g.stations.entranceAccess(S, r.entrances[2]) && S.roadAccess, 'the gate reaches the street through its access street');
  console.log(`  with a footbridge and a gate as well: ${S.catchPop.toFixed(0)} residents (gate street ${gate.access?.stats.len.toFixed(1)} u)`);
  const clash = clearOfEverything(g, S);
  check(!clash, `entrances clear of tracks, roads, the building and each other (${clash ?? 'clear'})`);

  // collisions: a house where the entrance would stand, an underground kind at a ground station
  const blocker = house(g, 97.5, 94.6, 0, 5);
  const blocked = g.stations.planEntrance(S.id, 97.5, 94.6, 0, 'underpass');
  check(!blocked.ok && /Building/.test(blocked.error ?? ''), `a house in the way blocks the site (${blocked.error})`);
  g.world.removeBuilding(blocker.id);
  check(!g.stations.planEntrance(S.id, 92.5, 94.6, 0, 'pavilion').ok, 'street pavilions are for stations below or above the street');
  check(!g.stations.planEntrance(S.id, 140, 140, 0, 'hall').ok, 'too far from the platforms: refused');

  // costs and upkeep per type
  const kinds = GROUND_ENTRANCES.map((k) => [k, entranceCost(k, r), ENTRANCE_TYPES[k].upkeep] as [EntranceKind, number, number]);
  console.log(`  prices: ${kinds.map(([k, c, u]) => `${k} ${(c / 1000).toFixed(0)}k (+${(u / 1000).toFixed(1)}k/yr)`).join(', ')}`);
  const upkeep = r.entrances.reduce((s, e) => s + ENTRANCE_TYPES[e.kind!].upkeep, 0);
  const base = (20000 + r.tracks * r.length * 500) + upkeep;
  check(g.stationMaintenance(S) === base && upkeep > 0, `station upkeep includes its added entrances (${g.stationMaintenance(S)})`);

  // rebuilding in place: longer platforms keep the entrances beside the new track area
  const n = r.entrances.length;
  const up = planStationUpgrade(g, S.id, { length: 12 });
  check(up.ok && !commitStationUpgrade(g, up), `station lengthened (${up.error ?? 'ok'})`);
  const r2 = g.stations.get(S.id)!.rail!;
  check(r2.length === 12 && r2.entrances.length === n && !clearOfEverything(g, S), `entrances kept after rebuilding (${r2.entrances.length}/${n}; ${clearOfEverything(g, S) ?? 'clear'})`);
  flush(g);
  check(north.filter((id) => walkingCatchment(g, S).buildings.has(id)).length >= gained.length, 'the north houses are still reached after rebuilding');

  // save / load: exact round trip, the same catchment
  const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(loaded)) === saved, 'save round trip is exact with entrances');
  const L = loaded.stations.get(S.id)!;
  check(JSON.stringify(L.rail!.entrances) === JSON.stringify(r2.entrances), 'entrances restored (kinds, both landings, prices)');
  flush(loaded); flush(g);
  check(L.catchPop === g.stations.get(S.id)!.catchPop && L.roadAccess, `same catchment after loading (${L.catchPop.toFixed(0)})`);
  for (let i = 0; i < 2 * g.ticksPerDay; i++) { g.stepTick(); loaded.stepTick(); }
  const sa = serialize(g) as Record<string, unknown>, sb = serialize(loaded) as Record<string, unknown>;
  const differ = Object.keys(sa).filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
  check(!differ.length, `loaded game replays exactly (${differ.join(', ') || 'same'})`);
  if (differ.includes('stations')) {
    const A = JSON.stringify(sa.stations), Bs = JSON.stringify(sb.stations);
    let at = 0; while (A[at] === Bs[at]) at++;
    console.log('   original:', A.slice(Math.max(0, at - 200), at + 120));
    console.log('   loaded:  ', Bs.slice(Math.max(0, at - 200), at + 120));
  }

  // removal: the station window (by index) and demolition (a point on a landing); the station stays
  const before2 = g.stations.get(S.id)!.catchPop;
  const hallAt = r2.entrances.findIndex((e) => e.kind === 'hall');
  check(!g.stations.removeEntrance(S.id, hallAt, 0) && r2.entrances.length === n - 1, 'side hall removed in the station window');
  const fbAt = r2.entrances.findIndex((e) => e.kind === 'footbridge'), far = r2.entrances[fbAt].far!;
  const preview = bulldoze(g, far.x, far.z, far.x, far.z, 0, true);
  check(preview.changed === 1 && preview.stationIds.length === 0 && preview.cost > 0, `demolishing a footbridge landing: just the entrance (${preview.changed} object, ${preview.cost})`);
  const roads = g.world.net.edges.size;
  const dz = bulldoze(g, far.x, far.z, far.x, far.z, 0, false);
  check(!dz.error && r2.entrances.length === n - 2 && !!g.stations.get(S.id), 'footbridge demolished, the station stays');
  check(g.world.net.edges.size === roads, 'the street beside the demolished landing stays');
  flush(g);
  const after = g.stations.get(S.id)!.catchPop;
  check(after < before2 && north.every((id) => !walkingCatchment(g, S).buildings.has(id)), `removing the north entrances removes their coverage (${before2.toFixed(0)} -> ${after.toFixed(0)})`);
}

// ------------------------------------------------------------------------------------------ below / above the street
{
  console.log('underground and elevated stations: pavilions and stair towers, old saves');
  const g = flatGame(192, 3);
  const road = streets(g);
  road(40, 84, 150, 84); road(40, 108, 150, 108);
  for (let x = 70; x <= 122; x += 4) { house(g, x, 82.4, 0); house(g, x, 109.6, Math.PI); }
  const U = station(g, 96, 96, Math.PI / 2, 12, 2, 0, { trackType: 'metro' })!;
  check(U.rail!.level === 'underground' && U.rail!.entrances.length >= 2 && U.rail!.entrances.every((e) => e.kind === undefined), 'metro station: entrances built with it carry no kind (the station’s own upkeep)');
  const m0 = g.stationMaintenance(U);
  const ep = g.stations.planEntrance(U.id, 110, 84.9, 0, 'footbridge');
  check(ep.ok && ep.kind === 'pavilion' && ep.cost === 90_000, `added street entrance: a pavilion whatever the tool's ground kind (${ep.error ?? ep.kind})`);
  check(!g.stations.commitEntrance(U.id, ep, 0) && g.stationMaintenance(U) === m0 + ENTRANCE_TYPES.pavilion.upkeep, 'an added pavilion carries its upkeep');
  const last = U.rail!.entrances.length - 1, e = U.rail!.entrances[last];
  const dz = bulldoze(g, e.x, e.z, e.x, e.z, 0, false);
  check(!dz.error && U.rail!.entrances.length === last && !!g.stations.get(U.id), 'demolishing one pavilion keeps the station');
  // an older save: entrances without kind or price load unchanged
  const data = JSON.parse(JSON.stringify(serialize(g)));
  for (const s of data.stations) if (s.rail) for (const q of s.rail.entrances) { delete q.kind; delete q.cost; }
  const old = deserialize(data), OU = old.stations.get(U.id)!;
  check(OU.rail!.entrances.length === U.rail!.entrances.length && old.stationMaintenance(OU) === m0 && OU.roadAccess, 'old saves: entrances load as before (no upkeep added)');
  flush(old); flush(g);
  check(OU.catchPop === U.catchPop && OU.catchPop > 0, `old save: the same walking catchment (${OU.catchPop.toFixed(0)})`);
}

// ------------------------------------------------------------------------------------------ the station's own crossings
{
  console.log('ground station: added entrances keep clear of the station\u2019s own footbridge and stairs');
  // a six-track classic station (three island platforms: its own underpass stairs and footbridge), a street beside
  // the tracks on the north side, the building's street on the south
  const g = flatGame(192, 3), road = streets(g);
  const width = railWidth({ tracks: 6, through: 0, trackOffsets: [], platforms: [], throughOffsets: [] } as never);
  road(40, 96 + width / 2 + 2.8, 150, 96 + width / 2 + 2.8);
  const S = station(g, 96, 96, Math.PI / 2, 12, 6, 0)!;
  const r = S.rail!;
  road(40, 96 - (r.width / 2 + 1.3), 150, 96 - (r.width / 2 + 1.3));
  const own = stationCrossings(r);
  check(r.platforms.length === 3 && own.footbridge !== null && own.stairs.length === 3, `fixture: 120 m, 3 platforms, its own footbridge at ${own.footbridge?.toFixed(2)} and stairs (${own.stairs.map((q) => q.along.toFixed(2)).join(', ')})`);
  const north = (a: number) => ({ x: 96 + a, z: 96 - (r.width / 2 + 0.6) });
  const over = g.stations.planEntrance(S.id, north(own.footbridge!).x, north(own.footbridge!).z, 0, 'footbridge');
  check(!over.ok && /own footbridge/.test(over.error ?? ''), `no added footbridge over the station's own (${over.error ?? 'accepted'})`);
  const onStairs = g.stations.planEntrance(S.id, north(own.stairs[0].along).x, north(own.stairs[0].along).z, 0, 'underpass');
  check(!onStairs.ok && /own stairs/.test(onStairs.error ?? ''), `no added underpass on the station's own stairs (${onStairs.error ?? 'accepted'})`);
  // lengthening moves the station's own footbridge: an added one beside it moves on (or goes), never over it
  const g2 = flatGame(192, 3), road2 = streets(g2);
  road2(40, 96 + width / 2 + 2.8, 150, 96 + width / 2 + 2.8);
  const S2 = station(g2, 96, 96, Math.PI / 2, 10, 6, 0)!;
  road2(40, 96 - (S2.rail!.width / 2 + 1.3), 150, 96 - (S2.rail!.width / 2 + 1.3));
  const before = stationCrossings(S2.rail!).footbridge!;
  const fb = g2.stations.planEntrance(S2.id, 96 + 4.2, 96 - (S2.rail!.width / 2 + 0.6), 0, 'footbridge');
  check(fb.ok && !g2.stations.commitEntrance(S2.id, fb, 0), `100 m: a footbridge at 42 m along, clear of the station's own at ${(before * 10).toFixed(0)} m (${fb.error ?? 'built'})`);
  const up = planStationUpgrade(g2, S2.id, { length: 12 });
  check(up.ok && !commitStationUpgrade(g2, up), `lengthened to 120 m (${up.error ?? 'ok'})`);
  const r2 = g2.stations.get(S2.id)!.rail!, after = stationCrossings(r2).footbridge!;
  const clashes = r2.entrances.filter((e) => { const x = entranceAlong(r2, e); return x + 0.75 + 0.1 > after - 0.15 && x - 0.75 - 0.1 < after + 0.45; });
  check(r2.entrances.length === 1 && !clashes.length, `after lengthening its footbridge stays clear of the station's own (now at ${(after * 10).toFixed(0)} m; added one at ${r2.entrances.map((e) => (entranceAlong(r2, e) * 10).toFixed(0)).join(', ')} m)`);
}

// ------------------------------------------------------------------------------------------ rebuilding: entrances keep a street
/**
 * A ground station along x (right of the axis is north, -z) with the building's street south of the tracks and a
 * street `gap` beyond the track area to the north, houses along it: an entrance on the north side needs its own
 * access street.
 */
function farStreet(tracks: number, length: number, gap: number) {
  const g = flatGame(192, 3), road = streets(g);
  const width = railWidth({ tracks, through: 0, trackOffsets: [], platforms: [], throughOffsets: [] } as never);
  road(40, 96 + width / 2 + 2.8, 150, 96 + width / 2 + 2.8);
  const S = station(g, 96, 96, Math.PI / 2, length, tracks, 0)!;
  const nz = 96 - (S.rail!.width / 2 + gap);
  road(40, nz, 150, nz);
  for (let x = 70; x <= 122; x += 3) house(g, x, nz - 1.6, 0);
  flush(g);
  return { g, S };
}
{
  console.log('rebuilding in place: a moved entrance keeps a street to its residents, or goes (warned, with its upkeep)');
  // six tracks: lengthening moves the station's own footbridge onto the added one, which moves on along the
  // platforms, away from the end of its access street
  const { g, S } = farStreet(6, 10, 5);
  const fb = g.stations.planEntrance(S.id, 96 + 4.15, 96 - (S.rail!.width / 2 + 0.6), 0, 'footbridge');
  check(fb.ok && !!fb.access && !g.stations.commitEntrance(S.id, fb, 0), `a footbridge with its own access street to the north street (${fb.error ?? `${fb.access?.stats.len.toFixed(1)} u`})`);
  flush(g);
  const gain0 = alone(g, S, 0), keep0 = g.stationMaintenance(S) - (20000 + S.rail!.tracks * S.rail!.length * 500);
  check(gain0 > 100 && keep0 === ENTRANCE_TYPES.footbridge.upkeep, `it brings ${gain0} residents for ${keep0} a year`);
  const before = stateOf(g);
  const up = planStationUpgrade(g, S.id, { length: 12 });
  check(stateOf(g) === before, 'planning the rebuild (with what becomes of its entrances) changes nothing');
  check(up.ok && up.entrances?.fates[0]?.fate === 'street' && up.entrances.streets > 0 && up.warnings.some((w) => /footbridge moves .*new access street/.test(w)),
    `the plan says so: it moves and gets a new access street, included in the price (${up.error ?? `${up.warnings.join('; ')}; street ${up.entrances?.streets}`})`);
  const money = g.economy.money;
  check(!commitStationUpgrade(g, up) && Math.abs(money - g.economy.money - up.cost) < 1, `rebuilt for the planned price (${Math.round(money - g.economy.money)} of ${up.cost})`);
  flush(g);
  const r2 = g.stations.get(S.id)!.rail!, e2 = r2.entrances[0];
  check(r2.entrances.length === 1 && Math.abs(entranceAlong(r2, e2) - 4.15) > 0.5 && g.stations.entranceAccess(S, e2),
    `the footbridge moved along the platforms (${(entranceAlong(r2, e2) * 10).toFixed(0)} m) and a street reaches it`);
  const gain1 = alone(g, S, 0);
  check(gain1 >= gain0 * 0.8, `it still brings its residents (${gain0} -> ${gain1})`);
  console.log(`  lengthened 100 -> 120 m: the footbridge moved ${((entranceAlong(r2, e2) - 4.15) * 10).toFixed(0)} m along with a new ${up.entrances?.streets} street; its residents ${gain0} -> ${gain1}`);
  check(!clearOfEverything(g, S), `clear of tracks, roads and the building (${clearOfEverything(g, S) ?? 'clear'})`);

  // a gate at the platform end moves with it; houses stand where its new street would run: it goes
  const g2 = flatGame(192, 3), road = streets(g2);
  road(30, 99.2, 150, 99.2); road(30, 89, 150, 89);
  for (let x = 80; x <= 116; x += 3) house(g2, x, 87.4, 0);
  const S2 = station(g2, 96, 96, Math.PI / 2, 10, 2, 0)!;
  flush(g2);
  const gate = g2.stations.planEntrance(S2.id, 100.5, 94.5, 0, 'gate');
  check(gate.ok && !!gate.access && !g2.stations.commitEntrance(S2.id, gate, 0), `a gate at the east platform end with its access street (${gate.error ?? 'built'})`);
  flush(g2);
  const e0 = S2.rail!.entrances[0], price = e0.cost!, value0 = S2.rail!.cost!;
  check(alone(g2, S2, 0) > 100 && entranceUpkeep(S2.rail) === ENTRANCE_TYPES.gate.upkeep, `the gate brings ${alone(g2, S2, 0)} residents`);
  // (the platforms grow by 10 m at each end: its new street side)
  const door = landingDoor('gate', { x: e0.x + 1, z: e0.z, angle: e0.angle });
  for (const [dx, dz] of [[-0.6, -1.3], [0.4, -1.3], [1.4, -1.0], [-1.6, -1.5]]) house(g2, door.x + dx, door.z + dz, 0, 5);
  flush(g2);
  const up2 = planStationUpgrade(g2, S2.id, { length: 12 });
  check(up2.ok && up2.entrances?.fates[0]?.fate === 'cut' && up2.warnings.some((w) => /gate goes \(no street reaches it/.test(w)),
    `the plan warns that the gate goes (${up2.error ?? up2.warnings.join('; ')})`);
  const news0 = g2.news.length;
  check(!commitStationUpgrade(g2, up2), 'rebuilt');
  flush(g2);
  const r3 = g2.stations.get(S2.id)!.rail!;
  check(r3.entrances.length === 0 && entranceUpkeep(r3) === 0 && g2.stationMaintenance(S2) === 20000 + r3.tracks * r3.length * 500,
    `the gate is gone, its upkeep with it (${r3.entrances.length} entrances, ${g2.stationMaintenance(S2)} a year)`);
  check(r3.cost === value0 + up2.cost - price, `its price left the station's value (${value0} + ${up2.cost} - ${price} = ${r3.cost})`);
  check(g2.news.length > news0 && /gate was taken down/.test(g2.news[g2.news.length - 1].text), `noted in the news ("${g2.news[g2.news.length - 1]?.text}")`);
  console.log(`  a gate whose new street would demolish houses: "${up2.warnings.join('; ')}"; news: "${g2.news[g2.news.length - 1]?.text}"`);

  // re-levelling: lifted onto a viaduct its added entrances go (warned, like moving the station); brought back to
  // the ground in place they stay
  for (const level of ['elevated', 'ground'] as const) {
    const { g: g3, S: S3 } = farStreet(2, 10, 5);
    const f3 = g3.stations.planEntrance(S3.id, 98, 96 - (S3.rail!.width / 2 + 0.6), 0, 'footbridge');
    check(f3.ok && !g3.stations.commitEntrance(S3.id, f3, 0), `re-level (${level}): a footbridge with its street`);
    flush(g3);
    const gone = entrancesGo('ground', S3.rail!.entrances, 'taken down at the old site');
    check(gone === 'Its added footbridge goes (taken down at the old site)', `moving the station warns alike ("${gone}")`);
    const value = S3.rail!.cost!, price3 = S3.rail!.entrances[0].cost!;
    const rp = planRelevel(g3, [...S3.rail!.edges], level, 0);
    const warned = rp.warnings.some((w) => w.startsWith(`${S3.name}: its added footbridge goes`));
    check(rp.ok && warned === (level !== 'ground'), `re-level (${level}): ${level !== 'ground' ? 'warns that the footbridge goes' : 'no warning'} (${rp.error ?? (rp.warnings.join('; ') || 'none')})`);
    check(!commitRelevel(g3, rp), `re-levelled (${level})`);
    flush(g3);
    const r4 = g3.stations.get(S3.id)!.rail!, sp = rp.stations.find((x) => x.id === S3.id)?.plan;
    // (the station's value: 70% of the old structures plus the new ones; an entrance that stays keeps its price)
    const want = sp ? Math.round((value - price3) * 0.7 + sp.cost) + (level === 'ground' ? price3 : 0) : NaN;
    if (level === 'ground') check(r4.entrances.length === 1 && g3.stations.entranceAccess(S3, r4.entrances[0]) && alone(g3, S3, 0) > 100 && r4.cost === want,
      `back on the ground: the footbridge stays, on its street, at its price (${r4.cost} = ${want})`);
    else check(r4.level === 'elevated' && !r4.entrances.some((e) => e.kind) && entranceUpkeep(r4) === 0 && r4.cost === want,
      `on the viaduct: the footbridge is gone with its upkeep and value (${r4.entrances.length} stair towers; ${r4.cost} = ${want})`);
  }
}

// ------------------------------------------------------------------------------------------ the station's own hall at street level
{
  console.log('below / above the street: an added entrance never stands on the station\u2019s own hall');
  // (the street right beside the hall: a pavilion on its sidewalk there would stand on the hall)
  const g = flatGame(192, 3), road = streets(g);
  road(40, 99.5, 150, 99.5);
  const U = station(g, 96, 96, Math.PI / 2, 12, 2, 0, { trackType: 'metro', style: 'classic' })!;
  const r = U.rail!;
  check(r.level === 'underground' && r.style === 'classic' && !!r.forecourt, `fixture: an underground station with a hall at street level (${r.style}, forecourt ${!!r.forecourt})`);
  const hall = r.building;
  const onHall = g.stations.planEntrance(U.id, hall.x, 99.5 - 0.9, 0);
  check(!onHall.ok && /hall/.test(onHall.error ?? ''), `no pavilion on or in front of its own hall (${onHall.error ?? 'accepted'})`);
  const clear = [...r.entrances, hall].reduce((x, q) => Math.max(x, q.x), 0) + 6;
  const away = g.stations.planEntrance(U.id, clear, 99.5 - 0.9, 0);
  check(away.ok, `a pavilion further along the street is fine (${away.error ?? 'ok'})`);
  const built = r.entrances.every((e) => !rectsOverlap({ x: e.x, z: e.z, angle: e.angle, w: 0.7, d: 1.1 }, hall, 0));
  check(built, 'the entrances planned with it keep clear of its hall');
}

// ------------------------------------------------------------------------------------------ AI (fixture)
function aiFixture() {
  const g = Game.create({ size: 192, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  const w = g.world;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  g.aiAcquisitions = false;
  const ai = g.ais[0], me = ai.companyId;
  g.company(me).economy.money = 200_000_000;
  ai.state.cooldown = 1e9;
  const road = streets(g);
  road(30, 99.2, 150, 99.2); road(30, 93.9, 150, 93.9);
  const north: number[] = [];
  for (let x = 74; x <= 118; x += 4) north.push(house(g, x, 92.3, 0, 60).id);
  for (let x = 74; x <= 118; x += 4) house(g, x, 100.6, Math.PI, 30);
  const H = station(g, 96, 96, Math.PI / 2, 10, 2, me)!, B = station(g, 160, 96, Math.PI / 2, 10, 2, me)!;
  build(g, nodeSnap(g, endNode(g, H, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'H-B');
  const l = g.lines.create('rail', me);
  l.stops = [H.id, B.id];
  g.lines.rebuild();
  const dep = depotFor(g, B, H, me);
  const train = dep >= 0 ? g.vehicles.buyTrain(dep, loco(), l.id) : 'no depot';
  check(typeof train !== 'string', `AI fixture: a train on the line (${typeof train === 'string' ? train : 'ok'})`);
  flush(g);
  return { g, ai, me, H, north };
}
const stat = (ai: AIController, k: string) => (ai.stats as unknown as Record<string, number>)[k] ?? 0;
{
  console.log('AI: an entrance where the residents it newly reaches pay for it');
  const { g, ai, H, north } = aiFixture();
  const before = H.catchPop;
  runNetworkTask(ai, 'capacity');
  const r = H.rail!;
  const ent = r.entrances[0];
  check(stat(ai, 'netEntrances') === 1 && r.entrances.length === 1, `AI added one entrance (${r.entrances.map((e) => e.kind).join(', ') || 'none'}; ${ai.log.slice(-1).join('')})`);
  flush(g);
  const reached = north.filter((id) => walkingCatchment(g, H).buildings.has(id)).length;
  check(!!ent && reached >= 6 && H.catchPop > before, `the AI's ${ent?.kind ?? '?'} reaches the north street (${reached} houses; ${before.toFixed(0)} -> ${H.catchPop.toFixed(0)} residents)`);
  check(!clearOfEverything(g, H), `the AI's entrance is clear of tracks and roads (${clearOfEverything(g, H) ?? 'clear'})`);
  // at most one change per station a year (the cooldown is saved with the planner)
  runNetworkTask(ai, 'capacity');
  check(stat(ai, 'netEntrances') === 1, 'cooldown: no second entrance in the same year');
  const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(loaded)) === saved, 'AI fixture save round trip is exact');
  g.day += 361; loaded.day += 361;
  runNetworkTask(g.ais[0], 'capacity'); runNetworkTask(loaded.ais[0], 'capacity');
  const pick = (x: Game) => JSON.stringify(x.stations.get(H.id)!.rail!.entrances);
  check(pick(g) === pick(loaded) && JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)), `a year on, the original and the loaded AI decide alike (${g.stations.get(H.id)!.rail!.entrances.length} entrances)`);
  // nothing newly reached: no entrance
  const { g: g2, ai: ai2, H: H2 } = aiFixture();
  for (const id of [...g2.world.buildings.keys()]) if (g2.world.buildings.get(id)!.z < 96) g2.world.removeBuilding(id);
  flush(g2);
  runNetworkTask(ai2, 'capacity');
  check(stat(ai2, 'netEntrances') === 0 && H2.rail!.entrances.length === 0, 'no residents across the tracks: the AI adds no entrance');
}

// ------------------------------------------------------------------------------------------ AI: valued over work units
{
  console.log('AI: the entrance is valued over work units (a saved cursor); a game saved mid-valuation resumes alike');
  const { g, ai, H } = aiFixture();
  // (the capacity job and its work items, one station each; then a work unit a day as the planner runs it)
  runNetworkTask(ai, 'capacity', 1);
  const cursorOf = (x: Game) => saveNetwork(x).companies.find(([id]) => id === ai.companyId)?.[1].job?.items?.find((i) => i.entrance)?.entrance;
  let units = 0;
  while (units < 60 && !((cursorOf(g)?.at ?? 0) > 0) && networkPlanner(ai)?.task) { networkDaily(ai); units++; }
  const cur = cursorOf(g);
  check(!!cur && cur.at > 0 && H.rail!.entrances.length === 0, `mid-valuation after ${units} work units: a saved cursor (${JSON.stringify(cur)})`);
  console.log(`  saved after ${units} work units, mid-valuation: ${JSON.stringify(cur)}`);
  const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
  check(JSON.stringify(serialize(loaded)) === data && JSON.stringify(cursorOf(loaded)) === JSON.stringify(cur), 'the cursor and its best place so far round-trip');
  for (const w of [g, loaded]) for (let i = 0; i < 60 && networkPlanner(w.ais[0])?.task; i++) networkDaily(w.ais[0]);
  check(stat(ai, 'netEntrances') === 1 && H.rail!.entrances.length === 1 && JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)),
    `resuming builds the same entrance in both (${H.rail!.entrances.map((e) => e.kind).join(', ') || 'none'}; ${JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)) ? 'identical' : 'differ'})`);
}

// ------------------------------------------------------------------------------------------ AI: access streets through houses
/**
 * The AI fixture with the north street away from the tracks (an entrance there needs an access street) and a house
 * standing where the cheapest one, a gate at the east platform end, would run its street; `others` more houses on the
 * north street beyond it.
 */
function streetThroughHouse(blockPop: number, others: number) {
  const g = Game.create({ size: 192, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  const w = g.world;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  g.aiAcquisitions = false;
  const ai = g.ais[0], me = ai.companyId;
  g.company(me).economy.money = 200_000_000;
  ai.state.cooldown = 1e9;
  const road = streets(g);
  road(30, 99.2, 150, 99.2); road(30, 89, 150, 89);
  for (let x = 74; x <= 118; x += 4) house(g, x, 100.6, Math.PI, 30);
  const H = station(g, 96, 96, Math.PI / 2, 10, 2, me)!, B = station(g, 160, 96, Math.PI / 2, 10, 2, me)!;
  build(g, nodeSnap(g, endNode(g, H, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(me), 'H-B');
  const l = g.lines.create('rail', me);
  l.stops = [H.id, B.id];
  g.lines.rebuild();
  const dep = depotFor(g, B, H, me);
  const train = dep >= 0 ? g.vehicles.buyTrain(dep, loco(), l.id) : 'no depot';
  check(typeof train !== 'string', `street fixture: a train on the line (${typeof train === 'string' ? train : 'ok'})`);
  const gate = g.stations.planEntrance(H.id, 96 + 4.5, 94.5, me, 'gate', { street: false });
  const blocker = house(g, gate.door?.x ?? 100.5, 91.2, Math.PI, blockPop);
  for (let i = 0; i < others; i++) house(g, 104 + i * 3, 87.4, 0, 60);
  flush(g);
  return { g, ai, me, H, blocker };
}
{
  console.log('AI: residents an access street demolishes are no gain, and are compensated');
  const { g, ai, me, H, blocker } = streetThroughHouse(80, 0);
  const plan = g.stations.planEntrance(H.id, 96 + 4.5, 94.5, me, 'gate');
  check(plan.ok && !!plan.access?.demolish.includes(blocker.id), `fixture: the gate's street runs through the house (${plan.error ?? `demolishes ${plan.access?.demolish.length}`})`);
  check(!entrancePlanCatchment(g, H, plan).buildings.has(blocker.id), 'the forecast (AI and tool preview) leaves the demolished house out');
  const money = g.company(me).economy.money;
  runNetworkTask(ai, 'capacity');
  check(stat(ai, 'netEntrances') === 0 && g.world.buildings.has(blocker.id) && H.rail!.entrances.length === 0,
    `no entrance whose only new residents its own street demolishes (${H.rail!.entrances.map((e) => e.kind).join(', ') || 'none'}; spent ${Math.round(money - g.company(me).economy.money)})`);
  // with residents beyond it, the AI builds and pays compensation for the house it demolishes
  const b = streetThroughHouse(10, 5);
  const spends: [number, string, boolean][] = [];
  const eco = b.g.company(b.me).economy, spend = eco.spend.bind(eco);
  eco.spend = (x, cat, force = false) => { spends.push([x, cat, force]); return spend(x, cat, force); };
  runNetworkTask(b.ai, 'capacity');
  eco.spend = spend;
  const paid = spends.some(([x, cat, force]) => cat === 'construction' && force && Math.abs(x - (3000 + 10 * 1250)) < 1e-6);
  // The entrance at this station must pay for its street and the compensation from the residents it newly covers.
  check(b.H.rail!.entrances.length === 1 && stat(b.ai, 'netEntrances') >= 1 && !b.g.world.buildings.has(b.blocker.id) && paid,
    `the AI's entrance demolished the house in its street's way and paid its compensation (${b.H.rail!.entrances.map((e) => e.kind).join(', ') || 'none'}; ${spends.map(([x, c, f]) => `${c}${f ? '!' : ''} ${Math.round(x)}`).join(', ')})`);
}

// ------------------------------------------------------------------------------------------ AI (running game, saved and reloaded)
{
  console.log('AI in the running game: the entrance comes by its own schedule, and a game saved halfway there decides alike');
  // the day the AI builds it, running on its own (the network tasks' schedule: no direct call)
  const probe = aiFixture();
  let day = -1;
  while (probe.g.day < 120 && day < 0) { probe.g.stepTick(); if (probe.H.rail!.entrances.length) day = probe.g.day; }
  check(day > 1 && stat(probe.ai, 'netEntrances') === 1 && probe.ai.log.some((l) => /residents newly within walking reach/.test(l)),
    `the AI adds the entrance on its own (day ${day}: ${probe.ai.log.filter((l) => /walking reach/.test(l)).join('') || 'none'})`);
  console.log(`  day ${day}: ${probe.ai.log.filter((l) => /walking reach/.test(l)).join('') || 'no entrance'}`);
  // the same game saved halfway there (its network planner under way) and reloaded: both build it that day
  const { g, H, north } = aiFixture();
  while (g.day < Math.floor(day / 2)) g.stepTick();
  const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(loaded)) === saved && !H.rail!.entrances.length, `saved on day ${g.day}, before the entrance: round trip exact`);
  const LH = loaded.stations.get(H.id)!;
  let dayA = -1, dayB = -1;
  while (g.day < day + 30) {
    g.stepTick(); loaded.stepTick();
    if (dayA < 0 && H.rail!.entrances.length) dayA = g.day;
    if (dayB < 0 && LH.rail!.entrances.length) dayB = loaded.day;
  }
  flush(g); flush(loaded);
  check(north.filter((id) => walkingCatchment(g, H).buildings.has(id)).length >= 6, 'it reaches the houses across the tracks');
  const sa = serialize(g) as Record<string, unknown>, sb = serialize(loaded) as Record<string, unknown>;
  const differ = Object.keys(sa).filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
  check(dayA === day && dayB === day && JSON.stringify(LH.rail!.entrances) === JSON.stringify(H.rail!.entrances) && !differ.length,
    `the original and the reloaded game build the same entrance on day ${day} (${dayA}, ${dayB}; ${differ.join(', ') || 'identical'})`);
}

// ------------------------------------------------------------------------------------------ AI (seeded world: a long run, replayed)
{
  const seed = Number(process.argv[2] ?? 23), years = Number(process.argv[3] ?? 4);
  console.log(`AI on seed ${seed}: ${years} years, 384 map, 3 rail-minded companies (saved and reloaded two years before the end; entrances where the AI finds them worth it)`);
  const g = Game.create({ size: 384, seed, towns: 9, hilliness: 'hilly', water: 'medium', startYear: 1985, aiConfigs: new Array(3).fill({ focus: { rail: 2.5, road: 0.8, tram: 0.5 } }) });
  g.aiAcquisitions = false;
  const count = (x: Game) => x.ais.reduce((n, a) => n + stat(a, 'netEntrances'), 0);
  const notes: string[] = [];
  const watch = (x: Game) => { for (const a of x.ais) for (const l of a.log) if (/residents newly within walking reach/.test(l) && !notes.includes(l)) notes.push(l); };
  // (a project in progress is wound up on loading: save between projects, as netsave does)
  while (g.day < (years - 2) * 360 || g.ais.some((a) => a.busy)) { g.stepTick(); if (g.tick % g.ticksPerDay === 0) watch(g); }
  const mid = count(g), saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(loaded)) === saved, `seed ${seed}: save round trip exact on day ${g.day}`);
  while (g.day < years * 360) { g.stepTick(); loaded.stepTick(); if (g.tick % g.ticksPerDay === 0) watch(g); }
  const n = count(g);
  for (const l of notes) console.log(`    ${l}`);
  const stations = [...g.stations.map.values()].filter((st) => st.rail && st.owner > 0);
  const kept = stations.flatMap((st) => st.rail!.entrances.filter((e) => e.kind).map((e) => `${st.name}: ${e.kind}`));
  console.log(`  ${stations.length} AI rail stations now; ${n} entrances added (${mid} before the save), standing: ${kept.join('; ') || 'none'}`);
  check(notes.length === n, `seed ${seed}: every entrance the AI added came with its reason (${n})`);
  for (const st of stations) if (st.rail!.entrances.some((e) => e.kind)) { const clash = clearOfEverything(g, st); check(!clash, `seed ${seed}: ${st.name}'s entrances clear (${clash ?? 'ok'})`); }
  const sa = serialize(g) as Record<string, unknown>, sb = serialize(loaded) as Record<string, unknown>;
  const differ = Object.keys(sa).filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
  check(!differ.length && count(loaded) === n, `seed ${seed}: the reloaded game makes the same entrance decisions (${differ.join(', ') || 'identical'})`);
}

console.log(`(${((performance.now() - T0) / 1000).toFixed(1)} s)`);
done();
