// Walking catchments: barriers, frontage, entrances, distance shares, local caches, hover timing and saves.
// Bundle with esbuild into the scratchpad, then run with node.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { CATCHMENT_RADIUS } from '../src/game/stations';
import type { StationPlan } from '../src/game/stations';
import { ROAD_TYPES } from '../src/game/constants';
import { bezLine } from '../src/game/geom';
import {
  walkingCatchment, walkingPopulation, planWalkingCatchment, walkSitePop, walkLimit, FRONTAGE_REACH,
} from '../src/game/catchment';
import { drawCatchStreets } from '../src/ui/gameapi';
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

check(CATCHMENT_RADIUS.rail === 33.6 && CATCHMENT_RADIUS.tram === 30.8 && CATCHMENT_RADIUS.bus === 22.4 && Object.keys(CATCHMENT_RADIUS).join() === 'rail,tram,bus', 'path-based limits twice the earlier ones (rail 168, tram 154, bus 112 m); one rail limit for every track type');
check(near(2 * walkLimit('rail') ** 2 / (Math.PI * CATCHMENT_RADIUS.rail ** 2), 3.125 / Math.PI), '1.25 grid allowance preserves circular area to within 0.6%');

{
  console.log('river barrier, long-edge origins and bidirectional country-road walks');
  const g = flatGame(128, 3, (x) => x >= 65 && x <= 67 ? -1 : 3), net = g.world.net;
  const l0 = node(g, 62, 20), l1 = node(g, 62, 110), r0 = node(g, 70, 20), r1 = node(g, 70, 110);
  const left = road(g, l0, l1), right = road(g, r0, r1), S = bus(g, 62, 60);
  const across = house(g, 72, 60, -Math.PI / 2), down = house(g, 60, 68, Math.PI / 2), up = house(g, 60, 52, Math.PI / 2);
  const farDoor = house(g, 57.5, 60, Math.PI / 2), beyond = house(g, 60, 90, Math.PI / 2);
  flush(g);
  const c = walkingCatchment(g, S);
  check(Math.hypot(across.x - S.x, across.z - S.z) < CATCHMENT_RADIUS.bus && !c.buildings.has(across.id), 'across a river, inside the former circle, without a reachable bridge: not covered');
  check(c.buildings.has(down.id) && c.buildings.has(up.id) && near(c.buildings.get(down.id)!.distance, 9.6), 'down/up a country road within budget: covered, including the 1.6-unit door leg');
  check(!c.buildings.has(farDoor.id) && !c.buildings.has(beyond.id), `a door farther than ${FRONTAGE_REACH} from a street or beyond the walking limit is excluded`);
  check(c.segments.every((s) => s.edge === left.id && s.z0 >= 32 - 1e-8 && s.z1 <= 88 + 1e-8), 'isochrone clips a long road edge even when neither endpoint is reachable');
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
  const S = station(g, 64, 64, Math.PI / 2, 12, 2, 0, { trackType: 'metro' })!;
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

done(T0);
