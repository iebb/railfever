// Stations: catchment radii per mode, road access (access streets, no passengers without), underground stations
// (entrances, a tunnel line with a train), elevated stations (viaduct, a bridge line with a train), level costs,
// merging a bus stop into a rail station, linked stations with walking transfers, names for a 30-station town,
// rebuilding a station with more and longer platforms while its line runs, relocating, and the save round trip.
// npx esbuild scripts/stations.ts --bundle --platform=node --format=esm --outfile=$S/stations.mjs && node $S/stations.mjs
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { addTramTracks } from '../src/game/build-ops';
import { CATCHMENT_RADIUS, WALK_LINE, TRANSFER_RANGE, planStationUpgrade, commitStationUpgrade, relocateStation, stationLayout } from '../src/game/stations';
import type { Station } from '../src/game/stations';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { roadOpts } from './lib';
import { findSnap } from '../src/game/construction';
import { flatGame, station, endNode, loco, depotFor, runTrains, check, fmt, build, free, railOpts, nodeSnap, done } from './stationlib';
import { buildRoadDepot } from '../src/game/routing';

const T0 = performance.now();
const road = (g: Game, x0: number, z0: number, x1: number, z1: number) => build(g, free(g, x0, z0), free(g, x1, z1), roadOpts(0, 'road'), 'road');
const house = (g: Game, x: number, z: number, floors = 2) => g.world.addBuilding({ townId: -1, x, z, angle: 0, w: 0.8, d: 0.8, type: 0, floors, pop: 10, seed: 1, y: g.world.heightAt(x, z), built: 0 });
const lineOf = (g: Game, kind: 'rail' | 'road', stops: Station[]) => { const l = g.lines.create(kind, 0); l.stops = stops.map((s) => s.id); return l; };

// ------------------------------------------------------------------ 1. catchment radii per mode, road access
{
  console.log('catchment and road access');
  const g = flatGame(256);
  road(g, 20, 100, 236, 100);
  const S = station(g, 128, 104, Math.PI / 2, 8, 2)!;
  check(S && S.roadAccess && g.stations.hasAccess(S), 'station beside a road has road access');
  const sh = g.stations.catchmentShapes(S);
  check(sh.length === 3 && sh.every((c) => c.r === CATCHMENT_RADIUS.rail && c.mode === 'rail') && Math.abs(Math.max(...sh.map((c) => c.x)) - 132) < 0.01, 'rail: 3 circles of 400 m along the platforms (ends and centre)');
  const busId = g.stations.nextId;
  check(!g.stations.commitBusStop(50, 100, 0), 'bus stop built');
  const bus = g.stations.get(busId)!;
  const net = g.world.net;
  const tramEdge = net.nearestEdge(205, 100, 1, 'road')!.edge;
  addTramTracks(g, [tramEdge.id], 0);
  const tramId = g.stations.nextId;
  check(!g.stations.commitBusStop(205, 100, 0), 'tram stop built');
  const tram = g.stations.get(tramId)!;
  const rb = g.stations.catchmentShapes(bus)[0], rt = g.stations.catchmentShapes(tram)[0];
  console.log(`  radii: rail ${sh[0].r}, tram ${rt?.r} (${rt?.mode}), bus ${rb?.r} (${rb?.mode})`);
  check(rb.mode === 'bus' && rb.r === CATCHMENT_RADIUS.bus && rt.mode === 'tram' && rt.r === CATCHMENT_RADIUS.tram && CATCHMENT_RADIUS.rail > CATCHMENT_RADIUS.tram && CATCHMENT_RADIUS.tram > CATCHMENT_RADIUS.bus, 'tram and bus radii, rail > tram > bus');
  // measured from the platforms: a house 38 beyond a platform end is in, one 45 from every circle is out
  const hin = house(g, 132 + 38, 104), hout = house(g, 128, 104 + 45), hside = house(g, 128, 104 + 39);
  const cb = new Set(g.stations.catchmentBuildings(S));
  check(cb.has(hin.id) && cb.has(hside.id) && !cb.has(hout.id), 'catchment measured from the platform area');
  // no road access: no catchment
  const plan = g.stations.planRail(128, 170, Math.PI / 2, 8, 2, 0);
  console.log(`  far from roads: ok ${plan.ok}, access ${plan.roadAccess}, warning "${plan.warnings[0] ?? ''}"`);
  check(plan.ok && !plan.roadAccess && plan.warnings.length === 1, 'a station without a road within reach: buildable, warned');
  const nid = g.stations.nextId;
  g.stations.commitRail(plan, 0);
  const N = g.stations.get(nid)!;
  for (let i = 0; i < 6; i++) house(g, 120 + i * 3, 176);
  g.stations.recomputeCatchment();
  check(!N.roadAccess && !g.stations.hasAccess(N) && g.stations.catchmentShapes(N).length === 0 && g.stations.catchmentShapes(N, true).length === 3 && N.catchPop === 0, 'no road access: no active catchment, no catchment population');
  // a road to the forecourt gives access (out from the building, past the platform end, to the road)
  const fc = g.stations.forecourt(N)!;
  const out = Math.sign(fc.z - N.rail!.z) || 1;
  build(g, free(g, fc.x, fc.z), free(g, fc.x + 14, fc.z + out * 3), roadOpts(0, 'road'), 'to the forecourt');
  build(g, findSnap(g, 'road', fc.x + 14, fc.z + out * 3), findSnap(g, 'road', fc.x + 14, 100), roadOpts(0, 'road', { straight: true }), 'link');
  g.update(0.01);
  g.stations.recomputeCatchment();
  check(N.roadAccess && N.catchPop > 0, `a road reaching the forecourt gives access (pop ${fmt(N.catchPop, 0)})`);
  // an access street is planned and built automatically for a station near a road
  const p2 = g.stations.planRail(60, 122, Math.PI / 2, 8, 1, 0);
  check(p2.ok && p2.roadAccess && !!p2.access, 'station 2 km... 200 m from a road: access street planned');
  const e0 = net.nextEdge, id2 = g.stations.nextId;
  g.stations.commitRail(p2, 0);
  const st2 = g.stations.get(id2)!;
  const streets = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'road');
  check(st2.roadAccess && streets.length >= 1, `access street built (${streets.length} edges)`);
  // compact default station
  const lay = stationLayout(2);
  console.log(`  2-track layout width ${fmt(lay.width, 2)} (${fmt(lay.width * 10, 0)} m), building ${fmt(S.rail!.building.w * 10, 0)} x ${fmt(S.rail!.building.d * 10, 0)} m`);
  check(lay.width < 1.7 && S.rail!.building.w <= 3.2 && S.rail!.building.d <= 1.1, 'compact layout and building');
}

// ------------------------------------------------------------------ 2. underground station on a tunnel line with a train
let saveGame: Game | null = null;
{
  console.log('underground station');
  const g = flatGame(256, 3);
  const net = g.world.net;
  road(g, 40, 124, 90, 124);
  road(g, 40, 133, 90, 133);
  const ground = g.stations.planRail(60, 128.5, Math.PI / 2, 8, 2, 0);
  const up = g.stations.planRail(60, 128.5, Math.PI / 2, 8, 2, 0, { level: 'underground' });
  const ent = up.entrances.length * 90_000;
  console.log(`  plan: ok ${up.ok} ${up.error ?? ''}, y ${fmt(up.y, 2)} (depth ${fmt(up.depth, 1)}), ${up.entrances.length} entrances (access ${up.entrances.filter((e) => e.access).length}), cost ${fmt(up.cost / 1e6, 2)}M vs ground ${fmt(ground.cost / 1e6, 2)}M`);
  check(up.ok && up.level === 'underground' && up.entrances.length >= 2 && up.entrances.every((e) => e.access), 'planned with 2+ entrances beside the streets');
  const ratio = (up.cost - ent) / ground.cost;
  check(ratio >= 5 && ratio <= 8, `underground ${fmt(ratio, 1)}x a ground station of the same size (5-8x)`);
  const uid = g.stations.nextId;
  check(!g.stations.commitRail(up, 0), 'built');
  const U = g.stations.get(uid)!;
  const pe = U.rail!.edges.map((id) => net.edges.get(id)!);
  check(pe.every((e) => e.sections.length === 1 && e.sections[0].type === 'tunnel' && e.sections[0].s0 === 0 && e.sections[0].s1 >= e.len - 1e-6), 'platform tracks: full-length tunnel sections');
  check(U.rail!.y < g.world.heightAt(60, 128.5) - 1.5 && U.roadAccess, 'below the surface, with road access through its entrances');
  check(g.stations.catchmentShapes(U).length === U.rail!.entrances.length, 'catchment circles around the entrances');
  // a street right across the top of the station
  check(!!road(g, 58, 110, 58, 147), 'a street can cross over the underground station');
  // a tunnel line from the platform ends to a ground station
  const G = station(g, 200, 128.5, Math.PI / 2, 8, 2)!;
  const p = build(g, nodeSnap(g, endNode(g, U, 0, true), 'rail'), nodeSnap(g, endNode(g, G, 0, false), 'rail'), railOpts(0, 2), 'tunnel line');
  check(p && p.stats.tunnels >= 1, `connected by a 2-track line through a tunnel (${p?.stats.tunnels} tunnel)`);
  // entrances: add one more beside the second street, remove it again
  const ne = U.rail!.entrances.length;
  const ea = g.stations.addEntrance(U.id, 75, 133.9, 0);
  check(!ea && U.rail!.entrances.length === ne + 1, `entrance added (${ea ?? 'ok'})`);
  check(g.stations.addEntrance(U.id, 150, 124.9, 0) !== null, 'too far from the platforms: refused');
  check(!g.stations.removeEntrance(U.id, U.rail!.entrances.length - 1, 0) && U.rail!.entrances.length === ne, 'entrance removed');
  const dep = depotFor(g, G, U);
  check(dep >= 0, 'depot');
  const l = lineOf(g, 'rail', [U, G]);
  const t = g.vehicles.buyTrain(dep, loco(), l.id) as Train;
  let hidden = 0, atU = 0;
  for (let i = 0; i < 8 * 300; i++) {
    g.update(0.25);
    if (t.state === 'loading' && t.atStation === U.id) { atU++; const q = { x: 0, y: 0, z: 0 }; const at = t.pointBehind(t.length / 2, q); if (at && t.hiddenAt(at.seg, at.sp)) hidden++; }
  }
  const arr = runTrains(g, [t], 120).arrivals.get(t.id) ?? [];
  console.log(`  train: ${arr.length} stops in 120 days (${arr.filter((s) => s === U.id).length} underground), hidden while loading underground ${hidden}/${atU} ticks`);
  check(arr.filter((s) => s === U.id).length >= 1 && arr.filter((s) => s === G.id).length >= 1 && hidden > 0 && hidden === atU, 'the train serves the underground station, out of sight');
  saveGame = g;
}

// ------------------------------------------------------------------ 3. elevated station over a street with a house beneath
{
  console.log('elevated station');
  const g = flatGame(256, 3);
  const net = g.world.net;
  road(g, 60, 40, 60, 80);
  const h = house(g, 57.8, 60.6, 2);
  const ground = g.stations.planRail(60, 60, Math.PI / 2, 8, 2, 0, { buildingSide: 1 });
  const ep = g.stations.planRail(60, 60, Math.PI / 2, 8, 2, 0, { level: 'elevated' });
  const ent = ep.entrances.length * 60_000;
  console.log(`  plan: ok ${ep.ok} ${ep.error ?? ''}, deck ${fmt(ep.y - 3, 2)} above ground, ${ep.piers.length} piers, ${ep.entrances.length} towers, demolish ${ep.demolish.length}, cost ${fmt(ep.cost / 1e6, 2)}M vs ground ${fmt(ground.cost / 1e6, 2)}M`);
  check(ep.ok && ep.y - 3 >= 1.2 && ep.piers.length >= 4 && !ep.demolish.includes(h.id), 'planned on a viaduct over the street and the house');
  const ratio = (ep.cost - ent) / (2 * 8 * 9000 + 120000);
  check(ratio >= 3 && ratio <= 4, `elevated ${fmt(ratio, 1)}x a ground station of the same size (3-4x)`);
  const pierOnRoad = ep.piers.some((p) => net.nearestEdge(p.x, p.z, 0.6, 'road'));
  check(!pierOnRoad, 'no pier on the street');
  const eid = g.stations.nextId;
  check(!g.stations.commitRail(ep, 0), 'built');
  const E = g.stations.get(eid)!;
  check(g.world.buildings.has(h.id) && E.rail!.edges.every((id) => net.edges.get(id)!.sections[0]?.type === 'bridge'), 'the house stays; platform tracks on a full-length bridge');
  const G = station(g, 200, 60, Math.PI / 2, 8, 2)!;
  const p = build(g, nodeSnap(g, endNode(g, E, 0, true), 'rail'), nodeSnap(g, endNode(g, G, 0, false), 'rail'), railOpts(0, 2), 'line off the viaduct');
  check(p && p.stats.bridges >= 1, 'connected by a line coming down from the viaduct');
  const dep = depotFor(g, G, E);
  const l = lineOf(g, 'rail', [E, G]);
  const t = g.vehicles.buyTrain(dep, loco(), l.id) as Train;
  const r = runTrains(g, [t], 300);
  const arr = r.arrivals.get(t.id) ?? [];
  check(arr.filter((s) => s === E.id).length >= 2, `the train serves the elevated station (${arr.length} stops)`);
}

// ------------------------------------------------------------------ 4. merging a bus stop into a rail station, 5. linked rail stations
{
  console.log('transfer complexes');
  const g = flatGame(256, 3);
  const net = g.world.net;
  road(g, 20, 100, 150, 100);
  // a bus line first (stops 80 m and 1.6 km from the later station), then the rail station
  const b1 = g.stations.nextId; g.stations.commitBusStop(116, 100, 0);
  const b2 = g.stations.nextId; g.stations.commitBusStop(40, 100, 0);
  const B1 = g.stations.get(b1)!, B2 = g.stations.get(b2)!;
  const bd = buildRoadDepot(g, 75, 100, 0);
  check(bd >= 0, 'bus depot');
  const bl = lineOf(g, 'road', [B1, B2]);
  const buses = [0, 1].map(() => g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, bl.id) as RoadVehicle);
  for (let i = 0; i < 8 * 40; i++) g.update(0.25);
  const plan = g.stations.planRail(128, 104, Math.PI / 2, 8, 2, 0);
  check(!plan.join && plan.links.includes(B1), `the new station links the stop within ${TRANSFER_RANGE * 10} m (not joined beyond 80 m)`);
  const sid = g.stations.nextId;
  g.stations.commitRail(plan, 0);
  const S = g.stations.get(sid)!;
  check(S.links.includes(B1.id) && B1.links.includes(S.id), 'linked both ways');
  check(g.stations.canMerge(S.id, B2.id) !== null && g.stations.canMerge(S.id, B1.id) === null, 'canMerge: only the near stop');
  B1.waiting.clear(); B1.waitingTotal = 0;
  g.stations.addWaiting(B1, bl.id, B2.id, B2.id, 30);
  const before = buses.map((v) => v.delivered);
  check(!g.stations.merge(S.id, B1.id), 'merged');
  check(!g.stations.get(B1.id) && S.stops.length === 1 && bl.stops[0] === S.id && bl.stops[1] === B2.id && S.waitingTotal >= 30, 'stop, line stop and waiting passengers moved; one name kept');
  const visits = new Map<number, number>();
  let last = buses.map((v) => v.state);
  for (let i = 0; i < 8 * 200; i++) {
    g.update(0.25);
    buses.forEach((v, k) => { if (v.state === 'loading' && last[k] !== 'loading') { const st = v.line?.stops[v.stopIndex] ?? -1; visits.set(st, (visits.get(st) ?? 0) + 1); } });
    last = buses.map((v) => v.state);
  }
  const after = buses.map((v) => v.delivered);
  console.log(`  bus line after the merge: visits ${S.name} ${visits.get(S.id) ?? 0}, ${B2.name} ${visits.get(B2.id) ?? 0}; delivered ${before.join('/')} -> ${after.join('/')}`);
  check((visits.get(S.id) ?? 0) >= 2 && (visits.get(B2.id) ?? 0) >= 2 && after.reduce((a, b) => a + b, 0) >= before.reduce((a, b) => a + b, 0) + 30, 'the buses keep serving both stops and carried the waiting passengers');
}
{
  const g = flatGame(256, 3);
  const net = g.world.net;
  const A1 = station(g, 128, 104, Math.PI / 2, 8, 1)!, A2 = station(g, 128, 110, Math.PI / 2, 8, 1)!;
  const B = station(g, 220, 104, Math.PI / 2, 8, 1)!, C = station(g, 36, 110, Math.PI / 2, 8, 1)!;
  check(A1.links.includes(A2.id) && A2.links.includes(A1.id) && !A1.links.includes(B.id), `rail stations ${fmt(g.stations.gap(A1, A2) * 10, 0)} m apart linked automatically`);
  build(g, nodeSnap(g, endNode(g, A1, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'A1-B');
  build(g, nodeSnap(g, endNode(g, A2, 0, false), 'rail'), nodeSnap(g, endNode(g, C, 0, true), 'rail'), railOpts(0), 'A2-C');
  const dB = depotFor(g, B, A1), dC = depotFor(g, C, A2);
  const L1 = lineOf(g, 'rail', [A1, B]), L2 = lineOf(g, 'rail', [A2, C]);
  const t1 = g.vehicles.buyTrain(dB, loco(), L1.id) as Train, t2 = g.vehicles.buyTrain(dC, loco(), L2.id) as Train;
  const h1 = g.lines.nextHop(B.id, C.id), h2 = g.lines.nextHop(A1.id, C.id), h3 = g.lines.nextHop(A2.id, C.id);
  console.log(`  route B -> C: ${h1?.line}/${h1?.alight}, then ${h2?.line}/${h2?.alight}, then ${h3?.line}/${h3?.alight}`);
  check(h1 && h1.line === L1.id && h1.alight === A1.id && h2 && h2.line === WALK_LINE && h2.alight === A2.id && h3 && h3.line === L2.id && h3.alight === C.id, 'B -> C: train to A1, walk to A2, train to C');
  check(!g.lines.nextHop(A1.id, A2.id), 'no destination reached on foot only');
  g.stations.addWaiting(B, h1!.line, h1!.alight, C.id, 40);
  runTrains(g, [t1, t2], 240);
  console.log(`  40 passengers B -> C: delivered by the trains ${t1.delivered} (to A1) / ${t2.delivered} (A2 to C)`);
  check(t2.delivered >= 40, 'they changed trains at the linked station (all 40 arrived on the second line)');
  g.stations.unlink(A1.id, A2.id);
  check(!g.lines.nextHop(B.id, C.id), 'unlinked: no route B -> C any more');
  check(g.stations.link(A1.id, A2.id) === null && !!g.lines.nextHop(B.id, C.id), 'linked again');
  g.vehicles.sell(t2.id);
  check(!g.stations.removeStation(A2.id) && !A1.links.includes(A2.id), 'removing a station cleans its links');
  void net;
}

// ------------------------------------------------------------------ 6. names for a 30-station town
{
  console.log('names');
  const g = Game.create({ size: 384, seed: 7, towns: 8, hilliness: 'flat', water: 'low', startYear: 1990 });
  g.economy.money = 1e9;
  const T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const net = g.world.net;
  let n = 0;
  const p = { x: 0, y: 0, z: 0 };
  for (const e of g.towns.streets(T, 0)) {
    if (n >= 40) break;
    for (const f of [0.3, 0.7]) {
      if (e.len < 5) continue;
      net.pointAt(e, e.len * f, p);
      const bp = g.stations.planBusStop(p.x, p.z, 0);
      if (!bp.ok || bp.join) continue;
      if (!g.stations.commitBusStop(p.x, p.z, 0)) n++;
    }
  }
  const names = g.stations.all().filter((s) => s.townId === T.id).map((s) => s.name);
  console.log(`  ${T.name} (${T.pop}): ${names.length} stations, e.g. ${names.slice(0, 8).join(', ')}`);
  check(names.length >= 30, '30+ stations in one town');
  check(new Set(names).size === names.length && names.every((s) => !/\d/.test(s)), 'all names unique and without numbers');
}

// ------------------------------------------------------------------ 7. rebuilding a station while its line runs, relocating
{
  console.log('rebuilding and relocating');
  const g = flatGame(256, 3);
  const net = g.world.net;
  road(g, 20, 100, 236, 100);
  const A = station(g, 60, 104, Math.PI / 2, 8, 2)!, B = station(g, 200, 104, Math.PI / 2, 8, 2)!;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'line');
  build(g, nodeSnap(g, endNode(g, A, 1, true), 'rail'), { kind: 'edge', ...(() => { const q = net.nearestEdge(78, 104 + (net.nodes.get(endNode(g, A, 0, true))!.z - 104), 1, 'rail')!; const pt = { x: 0, y: 0, z: 0 }; net.pointAt(q.edge, q.s, pt); return { x: pt.x, z: pt.z, y: pt.y, edge: q.edge.id, s: q.s }; })() }, railOpts(0), 'throat');
  const dep = depotFor(g, B, A);
  const l = lineOf(g, 'rail', [A, B]);
  const t = g.vehicles.buyTrain(dep, loco(), l.id) as Train;
  const r0 = runTrains(g, [t], 120);
  const up = planStationUpgrade(g, A.id, { length: 12, tracks: 4 });
  console.log(`  plan: ok ${up.ok} ${up.error ?? ''}, extends front/back ${up.delta.map((d) => fmt(d)).join('/')}, cost ${fmt(up.cost / 1e3, 0)}k ${up.warnings.join('; ')}`);
  check(up.ok && up.length === 12 && up.tracks === 4, 'planned: 4 tracks, 120 m platforms');
  let err: string | null = 'busy';
  for (let i = 0; i < 8 * 120 && err === 'busy'; i++) { err = commitStationUpgrade(g, up); if (err === 'busy') g.update(0.25); }
  check(!err && A.rail!.tracks === 4 && Math.abs(A.rail!.length - 12) < 0.3 && A.rail!.edges.length === 4 && g.stations.get(A.id) === A, `rebuilt in place (${err ?? 'ok'}), same station`);
  const r1 = runTrains(g, [t], 160);
  const arrA = (r1.arrivals.get(t.id) ?? []).filter((s) => s === A.id).length;
  console.log(`  line before: ${(r0.arrivals.get(t.id) ?? []).length} stops / 120 days; after the rebuild: ${arrA} at ${A.name}, worst wait ${r1.worst.days} days`);
  check(arrA >= 2, 'the line keeps working through the rebuilt station');
  // relocate a station with a line: the stop keeps its id and name
  const name = A.name;
  const C = station(g, 128, 160, Math.PI / 2, 8, 1)!;
  const pr = g.stations.planRail(128, 180, Math.PI / 2, 8, 1, 0, { ignoreStation: C.id });
  const lc = lineOf(g, 'rail', [C, B]);
  const rel = relocateStation(g, C.id, pr);
  check(!rel && C.rail && Math.abs(C.rail.z - 180) < 0.01 && g.stations.get(C.id) === C && lc.stops[0] === C.id && A.name === name, `relocated (${rel ?? 'ok'}), id, name and line stop kept`);
}

// ------------------------------------------------------------------ 8. save round trip of the station fields
if (saveGame) {
  console.log('save round trip');
  const g = saveGame;
  const pick = (x: Game) => JSON.stringify(x.stations.all().map((s) => ({ id: s.id, name: s.name, links: s.links, access: s.roadAccess, rail: s.rail && { level: s.rail.level, ug: s.rail.underground, depth: s.rail.depth, height: s.rail.height, entrances: s.rail.entrances, piers: s.rail.piers, fc: s.rail.forecourt, edges: s.rail.edges } })));
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  check(pick(g) === pick(g2), 'levels, depths, entrances, links, road access restored exactly');
  for (let i = 0; i < 8 * 20; i++) { g.update(0.25); g2.update(0.25); }
  const sig = (x: Game) => x.vehicles.trains().map((t) => `${t.state}:${fmt(t.headPos, 3)}`).join('|') + x.stations.all().map((s) => s.waitingTotal).join(',');
  check(sig(g) === sig(g2), 'both copies run alike');
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();
