// Walking catchments: barriers, frontage, entrances, distance shares, local caches, hover timing and saves.
// Bundle with esbuild into the scratchpad, then run with node.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { CATCHMENT_RADIUS } from '../src/game/stations';
import type { StationPlan } from '../src/game/stations';
import { ROAD_TYPES } from '../src/game/constants';
import { bezLine } from '../src/game/geom';
import {
  walkingCatchment, walkingPopulation, planWalkingCatchment, walkSitePop, walkLimit, FRONTAGE_REACH, FULL_COVER_WALK, walkWeight, coverOf,
} from '../src/game/catchment';
import { drawCatchStreets, catchWalkLimit } from '../src/ui/gameapi';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { roadDepotNear } from './lib';
import { flatGame, station, check, done } from './stationlib';

const T0 = performance.now(), near = (a: number, b: number) => Math.abs(a - b) < 1e-4;
const node = (g: Game, x: number, z: number) => g.world.net.addNode('road', x, 3, z, 0, 0, -1);
function road(g: Game, a: ReturnType<typeof node>, b: ReturnType<typeof node>, type = 'road', bridge = false) {
  const len = Math.hypot(a.x - b.x, a.z - b.z);
  return g.world.net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(len) + 1).fill(3), bridge ? [{ s0: 0, s1: len, type: 'bridge' }] : [], type, -1);
}
const house = (g: Game, x: number, z: number, angle = 0, pop = 10) => g.world.addBuilding({ townId: -1, x, z, angle, w: 0.8, d: 0.8, type: 0, floors: 2, pop, seed: 1, y: 3, built: 0 });
function bus(g: Game, x: number, z: number) {
  const id = g.stations.nextId, err = g.stations.commitBusStop(x, z, 0);
  if (err) throw new Error(err); return g.stations.get(id)!;
}
function flush(g: Game) { g.stations.refreshAccess(true); g.lines.catchmentDirty = true; g.lines.flushCatchment(); }

check(CATCHMENT_RADIUS.rail === 23.52 && CATCHMENT_RADIUS.tram === 21.56 && CATCHMENT_RADIUS.bus === 15.68 && FULL_COVER_WALK === 14.7 && Object.keys(CATCHMENT_RADIUS).join() === 'rail,tram,bus', 'walking and full-coverage limits reduced by 30%; one rail limit for every track type');
check(near(2 * walkLimit('rail') ** 2 / (Math.PI * CATCHMENT_RADIUS.rail ** 2), 3.125 / Math.PI), '1.25 grid allowance preserves circular area to within 0.6%');
check([0, 8, 21, 28, 42, 50.4].every((oldDistance) => near(walkWeight(oldDistance * 0.7), 1 / (1 + oldDistance / 8)) && near(coverOf(walkWeight(oldDistance * 0.7)), Math.min(1, (1 + 21 / 8) / (1 + oldDistance / 8)))), 'distance weights and the full-coverage taper keep the release-2.6 shape at 70% of the distances');
check((['rail', 'tram', 'bus'] as const).map((mode) => `${Math.round(catchWalkLimit(mode) * 10)} m`).join(', ') === '294 m, 270 m, 196 m', 'mapmodes legend distances derive from the shorter walking limits, including the grid allowance');

{
  console.log('river barrier, long-edge origins and bidirectional country-road walks');
  const g = flatGame(128, 3, (x) => x >= 65 && x <= 67 ? -1 : 3), net = g.world.net;
  const l0 = node(g, 62, 20), l1 = node(g, 62, 110), r0 = node(g, 70, 20), r1 = node(g, 70, 110);
  const left = road(g, l0, l1), right = road(g, r0, r1), S = bus(g, 62, 60);
  const across = house(g, 72, 60, -Math.PI / 2), down = house(g, 60, 68, Math.PI / 2), up = house(g, 60, 52, Math.PI / 2);
  const farDoor = house(g, 57.5, 60, Math.PI / 2), beyond = house(g, 60, 90, Math.PI / 2), trimmed = house(g, 60, 82, Math.PI / 2);
  flush(g);
  const c = walkingCatchment(g, S);
  check(Math.hypot(across.x - S.x, across.z - S.z) < CATCHMENT_RADIUS.bus && !c.buildings.has(across.id), 'across a river, inside the former circle, without a reachable bridge: not covered');
  check(c.buildings.has(down.id) && c.buildings.has(up.id) && near(c.buildings.get(down.id)!.distance, 9.6), 'down/up a country road within budget: covered, including the 1.6-unit door leg');
  check(!c.buildings.has(farDoor.id) && !c.buildings.has(beyond.id), `a door farther than ${FRONTAGE_REACH} from a street or beyond the walking limit is excluded`);
  check(!c.buildings.has(trimmed.id), 'a street-connected home inside the old bus limit but outside the shorter limit is excluded');
  const origin = S.stops[0].z, limit = walkLimit('bus');
  check(c.segments.every((s) => s.edge === left.id && s.z0 >= origin - limit - 1e-8 && s.z1 <= origin + limit + 1e-8), 'isochrone clips a long road edge to the shorter budget even when neither endpoint is reachable');
  const ra = net.addNode('rail', 62, 3, 60, 1, 0), rb = net.addNode('rail', 70, 3, 60, 1, 0);
  net.addEdge('rail', ra.id, rb.id, bezLine(62, 60, 70, 60), new Float32Array(9).fill(3), [], 'standard', 0);
  check(!walkingCatchment(g, S).buildings.has(across.id), 'a railway across the river never becomes a walking path');
  const ld = net.splitEdge(left.id, 75)!, rd = net.splitEdge(right.id, 75)!;
  road(g, ld.node, rd.node, 'road', true);
  check(!walkingCatchment(g, S).buildings.has(across.id), 'a bridge farther down the road than the budget remains out of reach');
  const ln = net.splitEdge(ld.e1.id, 41)!, rn = net.splitEdge(rd.e1.id, 41)!;
  road(g, ln.node, rn.node, 'road', true);
  g.stations.refreshAccess();
  check(g.lines.catchmentDirty, 'a nearby road edit invalidates shares even when station road access stays true');
  g.lines.flushCatchment();
  check(walkingCatchment(g, S).buildings.has(across.id), 'a reachable road bridge unlocks the opposite frontage');
}

{
  console.log('underground entrances and unconnected access');
  const g = flatGame(128);
  road(g, node(g, 16, 52), node(g, 112, 52)); road(g, node(g, 16, 76), node(g, 112, 76));
  const S = station(g, 64, 64, Math.PI / 2, 12, 2, 0, { trackType: 'electric', mode: 'metro' })!;
  if (!S) throw new Error('metro fixture');
  S.rail!.entrances = [{ x: 54, z: 52.8, angle: Math.PI }, { x: 80, z: 76.8, angle: Math.PI }, { x: 30, z: 65, angle: 0 }];
  const a = house(g, 58, 50), b = house(g, 84, 74), platform = house(g, 64, 63);
  flush(g);
  const c = walkingCatchment(g, S);
  check(c.buildings.has(a.id) && c.buildings.has(b.id) && !c.buildings.has(platform.id), 'entrances on two disconnected streets define coverage; platform proximity gives no access');
  S.rail!.entrances.splice(1, 1); flush(g);
  check(walkingCatchment(g, S).buildings.has(a.id) && !walkingCatchment(g, S).buildings.has(b.id), 'removing an entrance removes only its street coverage');
  S.rail!.entrances = [{ x: 64, z: 65, angle: 0 }]; flush(g);
  check(!S.roadAccess && walkingCatchment(g, S).buildings.size === 0 && S.catchPop === 0, 'a station without connected entrances has no catchment');
}

{
  console.log('strict distance shares, regional caches and exact save round trips');
  const g = flatGame(192), main = road(g, node(g, 20, 60), node(g, 160, 60));
  const A = bus(g, 52, 60), B = bus(g, 72, 60), b = house(g, 60, 58);
  flush(g);
  const sh = g.stations.stationsForBuilding(b.id), a = sh.w[sh.st.indexOf(A.id)], other = sh.w[sh.st.indexOf(B.id)];
  check(sh.st.length === 2 && near(a + other, 1) && a > other, `walking-nearer station gets more population (${a.toFixed(4)} / ${other.toFixed(4)})`);
  const ca = walkingCatchment(g, A), cb = walkingCatchment(g, B);
  console.log(`  door distances ${ca.buildings.get(b.id)?.distance} / ${cb.buildings.get(b.id)?.distance}; stop positions ${A.stops[0].x} / ${B.stops[0].x}`);
  check(near(ca.buildings.get(b.id)!.distance, 9.6) && near(cb.buildings.get(b.id)!.distance, 13.6), 'shares use the measured street walk plus door leg');
  check(near(A.catchPop + B.catchPop, b.pop) && near(g.stations.catchSum(A, (b) => b.pop), A.catchPop), 'strict shares conserve population and preserve catchSum');
  road(g, node(g, 130, 150), node(g, 170, 150));
  check(walkingCatchment(g, A) === ca, 'a distant road edit reuses the cached station catchment');
  const newB = house(g, 54, 58);
  const added = walkingCatchment(g, A);
  check(added.buildings.has(newB.id) && added.segments === ca.segments, 'a new building updates connections while reusing the bounded Dijkstra');
  g.world.removeBuilding(newB.id);
  check(!walkingCatchment(g, A).buildings.has(newB.id), 'demolished buildings leave the local cache');
  const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(loaded)) === saved, 'save round trip is byte-for-byte exact with derived catchments omitted');
  check(JSON.stringify(loaded.stations.buildingShares(A.id)) === JSON.stringify(g.stations.buildingShares(A)), 'walking shares rebuild identically after load');
  check(JSON.stringify(serialize(loaded)) === saved, 'reading rebuilt walking shares does not change the save');
  const old = JSON.parse(saved); delete old.catchMaxB;
  check(deserialize(old).stations.buildingShares(A.id).ids.includes(b.id), 'old saves without catchment snapshot metadata still load');
  const v = g.stations.catchVersion, cut = g.world.net.splitEdge(main.id, 36)!;
  g.world.net.removeEdge(cut.e2.id); flush(g);
  check(g.stations.catchVersion > v && !g.stations.buildingShares(A).ids.includes(b.id), 'local removal disconnects frontage and recomputes shares');
}

{
  console.log('clean saves retain incremental catchment timing with sixteen stations');
  const g = flatGame(256);
  g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  road(g, node(g, 16, 60), node(g, 240, 60));
  const stops = Array.from({ length: 16 }, (_, i) => bus(g, 25 + i * 13, 60));
  g.day = 1;
  g.stations.recomputeCatchment(); g.flushNetworkChanges(); g.lines.flushCatchment();
  const horizon = g.stations.catchMaxB, oldPop = stops[2].catchPop;
  check(horizon === 0, 'zero is a real historical horizon when the last share-out contained no buildings');
  // A lot can exist beyond the last share-out. Loading must retain the saved horizon and populations.
  const b = house(g, 60, 58);
  const pending = house(g, 64, 58);
  const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
  check(!g.lines.catchmentDirty && JSON.stringify(serialize(loaded)) === data, 'sixteen-station clean save round trip is exact');
  check(loaded.stations.catchMaxB === horizon && loaded.stations.get(stops[2].id)!.catchPop === oldPop,
    'clean load preserves historical building horizon and catchment populations');
  // Do not read buildingShares before this trigger: a getter would hide the cold-cache replay regression.
  for (const w of [g, loaded]) {
    const building = w.world.buildings.get(b.id)!;
    building.pop += 8; w.world.touchBuilding(building);
    w.lines.markDemandSharesDirty(); w.stepTick();
  }
  check(!g.lines.catchmentDirty && !loaded.lines.catchmentDirty && loaded.stations.catchMaxB === pending.id,
    'the first live invalidation commits immediately in both original and loaded games');
  check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), 'first incremental invalidation after a clean load is byte-identical');
  for (let i = 0; i < 2 * g.ticksPerDay; i++) { g.stepTick(); loaded.stepTick(); }
  check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), 'sixteen-station clean save continues exactly for two days');

  const building = g.world.buildings.get(b.id)!;
  building.pop += 10; g.world.touchBuilding(building); g.lines.markDemandSharesDirty();
  const dirtyData = JSON.stringify(serialize(g)), dirty = deserialize(JSON.parse(dirtyData));
  check(dirty.lines.catchmentDirty && JSON.stringify(serialize(dirty)) === dirtyData,
    'a pending dirty save preserves its populations and pending refresh on immediate round trip');
  dirty.lines.flushCatchment();
  check(dirty.lines.catchmentDirty && dirty.stations.catchmentWorkPending,
    'a dirty load retains bounded cold catchment preparation rather than applying its pending work on load');
}

{
  console.log('pending road edits retain warm catchment timing with sixteen rail stations');
  const base = flatGame(384); base.aiEnabled = false; base.vehicles.ambientEnabled = false;
  const roads: number[] = [], stations: number[] = [], ends: number[] = [];
  for (let i = 0; i < 16; i++) {
    const st = station(base, 30 + i % 4 * 60, 30 + Math.floor(i / 4) * 60, Math.PI / 2, 8, 1, 0, { style: 'modern' });
    check(!!st, 'pending-road fixture constructs every rail facility');
    if (!st) throw new Error('Pending-road fixture');
    const f = base.stations.forecourt(st)!;
    const a = node(base, f.x - 24, f.z), b = node(base, f.x, f.z);
    roads.push(road(base, a, b).id); stations.push(st.id); ends.push(b.id);
    house(base, f.x - 6, f.z - 2); house(base, f.x + 7, f.z - 2);
  }
  base.day = 1; base.flushNetworkChanges(); base.stations.recomputeCatchment(); base.lines.flushCatchment();
  check(base.stations.map.size === 16 && base.stations.all().every(st => st.roadAccess && st.catchPop > 0),
    'all sixteen rail facilities retain nonzero populations before the edit');
  base.stepTick();
  check(base.tick > 0 && base.tick % base.ticksPerDay !== base.ticksPerDay - 1, 'pending edit starts inside a day where a cold sixteen-station share cache would slice');
  const initial = JSON.stringify(serialize(base));
  for (const paused of [true, false]) for (const edit of ['remove', 'add', 'unrelated'] as const) {
    const g = deserialize(JSON.parse(initial)); g.paused = paused;
    const first = g.stations.get(stations[0])!, oldPop = first.catchPop;
    if (edit === 'remove') g.world.net.removeEdge(roads[0]);
    else if (edit === 'add') {
      const a = g.world.net.nodes.get(ends[0])!;
      road(g, a, node(g, a.x + 10, a.z));
    } else road(g, node(g, 4, 360), node(g, 12, 360));
    g.onNetworkChanged();
    const pending = JSON.stringify(serialize(g)), state = JSON.parse(pending);
    check(!state.catchmentDirty && state.networkDirty && state.catchmentRoadsDirty === (edit !== 'unrelated'),
      `${edit}/${paused}: save retains the unflushed road edit without applying its catchment population`);
    const loaded = deserialize(JSON.parse(pending)); loaded.paused = paused;
    check(JSON.stringify(serialize(loaded)) === pending && loaded.stations.get(first.id)!.catchPop === oldPop,
      `${edit}/${paused}: pending save round trip preserves its population`);
    if (paused) {
      g.update(0); loaded.update(0);
      check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), `${edit}/paused: construction flush is exact`);
    }
    let exact = true, immediate = true;
    for (let i = 0; i < 2 * g.ticksPerDay; i++) {
      g.stepTick(); loaded.stepTick();
      if (i === 0) immediate = !g.stations.catchmentWorkPending && !loaded.stations.catchmentWorkPending &&
        !g.lines.catchmentDirty && !loaded.lines.catchmentDirty;
      if (JSON.stringify(serialize(loaded)) !== JSON.stringify(serialize(g))) exact = false;
    }
    check(immediate && exact, `${edit}/${paused}: warm pending edit commits without cold slicing and every replay tick is exact`);
    check(edit === 'remove' ? first.catchPop === 0 && !first.roadAccess : edit === 'add' ? first.catchPop > oldPop : first.catchPop === oldPop,
      `${edit}/${paused}: the relevant road edit changes coverage and an unrelated edit preserves saved population`);
  }
}

{
  console.log('pedestrian exclusions and station-complex passages');
  const g = flatGame(128);
  ROAD_TYPES.nofoot = { ...ROAD_TYPES.road, id: 'nofoot', pedestrians: false };
  const e = road(g, node(g, 20, 60), node(g, 100, 60), 'nofoot'), S = bus(g, 40, 60), b = house(g, 44, 58);
  check(walkingCatchment(g, S).buildings.size === 0 && walkSitePop(g, 40, 60, 'bus') === 0, 'pedestrian-excluded roads give neither passenger catchment nor an AI estimate');
  e.type = 'road'; g.world.net.touchEdge(e); flush(g);
  check(walkingCatchment(g, S).buildings.has(b.id), 'country roads without sidewalks remain walkable');
  const a0 = node(g, 20, 90), a1 = node(g, 45, 90), b0 = node(g, 55, 90), b1 = node(g, 100, 90);
  road(g, a0, a1); road(g, b0, b1);
  const A = bus(g, 44, 90), B = bus(g, 56, 90), h = house(g, 56, 88);
  A.links = [B.id]; B.links = [A.id]; flush(g);
  check(walkingCatchment(g, A).buildings.has(h.id), 'explicit links through a station complex remain pedestrian passages');
  A.links = []; B.links = []; flush(g);
  check(!walkingCatchment(g, A).buildings.has(h.id), 'without the station-complex link, separate roads remain disconnected');
}

{
  console.log('rounded road endpoints in station passages');
  const g = flatGame(128), e = road(g, node(g, 20, 60), node(g, 64.123457, 60));
  const S = station(g, 64, 66, Math.PI / 2, 8, 2)!;
  const geo = g.world.net.geo(e), end = { x: geo.pts[(geo.n - 1) * 3], z: geo.pts[(geo.n - 1) * 3 + 2] };
  S.rail!.forecourt = end; S.rail!.forecourt2 = { ...end };
  S.stops.push({ edge: e.id, s: e.len, ...end });
  const b = house(g, 62, 58); flush(g);
  const c = walkingCatchment(g, S);
  check(c.buildings.has(b.id) && [...c.buildings.values()].every((b) => b.distance >= 0), 'Float32 endpoint rounding cannot create negative walks or unbounded Dijkstra cycles');
}

{
  console.log('planned access street frontages');
  const g = flatGame(128); road(g, node(g, 16, 50), node(g, 112, 50));
  const plan = g.stations.planRail(64, 74, Math.PI / 2, 8, 2, 0);
  check(plan.ok && !!plan.access, 'planned ground station includes an access street');
  if (plan.access) {
    const track = plan.access.tracks[0], p = { x: 0, z: 0 };
    const bez = track.bez, u = 0.5;
    p.x = (1-u)**3 * bez.x0 + 3*(1-u)**2*u*bez.x1 + 3*(1-u)*u*u*bez.x2 + u**3*bez.x3;
    p.z = (1-u)**3 * bez.z0 + 3*(1-u)**2*u*bez.z1 + 3*(1-u)*u*u*bez.z2 + u**3*bez.z3;
    const b = house(g, p.x + 2, p.z, -Math.PI / 2), before = JSON.stringify(serialize(g));
    const c = planWalkingCatchment(g, plan);
    check(c.segments.some((s) => s.edge === -1) && c.buildings.has(b.id), 'hover includes the proposed street and homes gaining frontage on it');
    check(JSON.stringify(serialize(g)) === before, 'hover leaves network, station and save state unchanged');
  }
}

{
  console.log('hover preview and AI site estimate performance');
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 0 });
  const net = g.world.net, edge = [...net.edges.values()].find((e) => e.kind === 'road' && e.len >= 8 && e.sections.length === 0)!;
  const p = { x: 0, y: 0, z: 0 }; net.pointAt(edge, edge.len / 2, p);
  const plan = g.stations.planRail(p.x, p.z, 0, 8, 2, 0);
  const times: number[] = [];
  let last = planWalkingCatchment(g, plan);
  for (let i = 0; i < 120; i++) {
    net.pointAt(edge, edge.len / 2 + (i % 20 - 10) * 0.03, p);
    const preview: StationPlan = { ...plan, x: p.x, z: p.z, level: 'ground', mode: 'mainline', style: 'classic', roadAccess: true, forecourt: { x: p.x, z: p.z }, forecourt2: null, access: null, join: null };
    const start = performance.now(); last = planWalkingCatchment(g, preview); walkingPopulation(g, last); times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const median = times[60], p95 = times[114], mean = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(`  ${g.world.buildings.size} buildings, ${net.edges.size} edges; hover median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, mean ${mean.toFixed(3)} ms`);
  check(median < 3 && p95 < 8 && mean < 4 && last.segments.length > 0, 'hover walking preview stays within a few milliseconds');
  const n = net.nodes.get(edge.a)!;
  const before = JSON.stringify(serialize(g)), t = performance.now(), estimates = Array.from({ length: 200 }, () => walkSitePop(g, n.x, n.z, 'rail'));
  console.log(`  cached AI estimate ${(performance.now() - t).toFixed(2)} ms / 200 calls, population ${estimates[0]}`);
  check(estimates.every((pop) => pop === estimates[0]) && JSON.stringify(serialize(g)) === before, 'AI site estimates are fast, stable and read-only');
  const drawn = new Map<string, number>();
  drawCatchStreets({ setSegments: (key, segs) => { drawn.set(key, segs?.length ?? 0); } }, 'test', last);
  check([...drawn.values()].some((n) => n > 0), 'UI catchment layer draws reached streets');
  drawCatchStreets({ setSegments: (key, segs) => { drawn.set(key, segs?.length ?? 0); } }, 'test', null);
  check([...drawn.values()].every((n) => n === 0), 'closing a preview clears every mode layer');
}

{
  // Coverage follows the best walk: a second stop just as far away shares the building's coverage, it adds none
  // (a house about 18 units' walk from either stop is covered as from one stop at that distance).
  const g = flatGame();
  const n = (x: number, z: number) => node(g, x, z);
  const w0 = n(20, 60), w1 = n(66, 60), w2 = n(160, 60), s0 = n(66, 110);
  road(g, w0, w1, 'street'); road(g, w1, w2, 'street'); road(g, w1, s0, 'street');
  const h = house(g, 64, 71, Math.PI / 2, 100);
  const A = bus(g, 60, 60), C = bus(g, 140, 60);
  const line = g.lines.create('road'); line.stops = [A.id, C.id];
  const depotId = roadDepotNear(g, 140, 60, 0);
  check(depotId >= 0 && typeof g.vehicles.buyRoad(depotId, MODEL_BY_ID.get('bus_c')!, line.id) !== 'string', 'a bus on the line');
  g.lines.rebuild(); flush(g);
  const one = g.stations.stationsForBuilding(h.id), cover1 = one.w.reduce((a, b) => a + b, 0);
  const B = bus(g, 72, 60);
  line.stops = [A.id, B.id, C.id]; g.lines.rebuild(); flush(g);
  const two = g.stations.stationsForBuilding(h.id), cover2 = two.w.reduce((a, b) => a + b, 0);
  const dA = walkingCatchment(g, A).buildings.get(h.id)?.distance ?? 0, dB = walkingCatchment(g, B).buildings.get(h.id)?.distance ?? 0;
  console.log(`  a house ${dA.toFixed(1)} / ${dB.toFixed(1)} units' walk from two stops: covered ${cover1.toFixed(4)} by one, ${cover2.toFixed(4)} by both (${two.w.map((x) => x.toFixed(4)).join(' + ')})`);
  check(dA > FULL_COVER_WALK && near(dA, dB) && cover1 < 1 && near(cover1, cover2) && two.st.length === 2 && near(two.w[0], two.w[1]), 'a second stop as far away shares the coverage of the best walk, it adds none');
}

done(T0);
