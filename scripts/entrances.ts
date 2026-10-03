// Station entrances: a ground station's side hall, footbridge / underpass and platform-end gate on both sides of
// the tracks (sites, collisions, stairs spacing, access streets), the walking catchment they add, removal (station
// window and demolition), costs and upkeep, rebuilding in place, save / load (exact, old saves), and the AI adding
// entrances where the residents they newly reach pay for them (a fixture, then a seeded world).
// Bundle as entrances.mjs (esbuild --bundle --platform=node --format=esm) and run with node.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { rectsOverlap } from '../src/game/towns';
import { distToRect } from '../src/game/world';
import { bulldoze } from '../src/game/build-ops';
import {
  ENTRANCE_TYPES, GROUND_ENTRANCES, entranceCost, entranceLandings, entranceKind, landingRect, entranceAlong,
  planStationUpgrade, commitStationUpgrade, railWidth,
} from '../src/game/stations';
import type { Station, EntranceKind } from '../src/game/stations';
import { walkingCatchment, walkingCatchmentWithout, walkingPopulation } from '../src/game/catchment';
import { runNetworkTask } from '../src/game/ai-network';
import type { AIController } from '../src/game/ai';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
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
  const state = () => JSON.stringify([serialize(g), g.world.net.nextNode, g.world.net.nextEdge, g.world.net.version, g.networkVersion,
    g.lines.catchmentDirty, g.stations.walkVersion, [...g.world.dirtyObj], [...g.world.dirtyTerrain]]);
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
  const blocker = house(g, 94, 94.6, 0, 5);
  const blocked = g.stations.planEntrance(S.id, 94, 94.6, 0, 'underpass');
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

// ------------------------------------------------------------------------------------------ AI (seeded world)
{
  const seed = Number(process.argv[2] ?? 23), years = Number(process.argv[3] ?? 4);
  console.log(`AI on seed ${seed}: ${years} years, 384 map, 3 rail-minded companies (saved and reloaded two years before the end)`);
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
  check(n > 0 && notes.length === n, `seed ${seed}: the AI added entrances where they pay (${n})`);
  check(n > mid, `seed ${seed}: an entrance decision falls in the replayed year (${mid} -> ${n})`);
  for (const st of stations) if (st.rail!.entrances.some((e) => e.kind)) { const clash = clearOfEverything(g, st); check(!clash, `seed ${seed}: ${st.name}'s entrances clear (${clash ?? 'ok'})`); }
  const sa = serialize(g) as Record<string, unknown>, sb = serialize(loaded) as Record<string, unknown>;
  const differ = Object.keys(sa).filter((k) => JSON.stringify(sa[k]) !== JSON.stringify(sb[k]));
  check(!differ.length && count(loaded) === n, `seed ${seed}: the reloaded game makes the same entrance decisions (${differ.join(', ') || 'identical'})`);
}

console.log(`(${((performance.now() - T0) / 1000).toFixed(1)} s)`);
done();
