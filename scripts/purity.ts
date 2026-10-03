// Preview purity: shared headless fixtures, 20 varied calls per planner, plus commit equivalence.
// Bundle into the scratch directory with esbuild --bundle --platform=node --format=esm, then run with node.
import { strict as assert } from 'node:assert';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { findSnap, planEdge, commitProposal } from '../src/game/construction';
import { planDoubleTrack, commitDoubleTrack, planConnection, commitConnection, planRelevel, commitRelevel,
  planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { planStationUpgrade, commitStationUpgrade } from '../src/game/stations';
import { signalsAlong, autoSignalLine, autoSignalNetwork, setSignal } from '../src/game/signals';
import { bulldoze, electrify, addTramTracks, removeTramTracks } from '../src/game/build-ops';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { build, free, railOpts, roadOpts, addBusStop, newRailEdges, fails } from './lib';
import { flatGame, station, endNode, nodeSnap } from './stationlib';
import type { DepotKind } from '../src/game/build-ops';

const T0 = performance.now();
let calls = 0, groups = 0, commits = 0, cleanupChecks = 0;

/** Save data includes entity maps, growth caches, AI RNGs and each vehicle's RNG. */
function snapshot(g: Game): string {
  const w = g.world, n = w.net;
  const vehicles = g.vehicles as any;
  // Geometry / structure memoization is derived entirely from entities and their versions; cache presence
  // does not change results. Include the routing, reservations and dirty state that can affect future work.
  return JSON.stringify({
    save: serialize(g),
    net: { nextNode: n.nextNode, nextEdge: n.nextEdge, nextCrossing: n.nextCrossing, version: n.version },
    versions: [g.networkVersion, g.lines.version, w.heightsVersion],
    rng: { game: g.rng.state, traffic: vehicles.rng.state,
      ai: g.ais.map((a) => (a as any).rng.state),
      road: [...g.vehicles.map.values(), ...g.vehicles.ambient]
        .filter((v) => (v as any).rng).map((v) => [v.id, (v as any).rng.state]) },
    routing: [...g.lines.routing].map(([id, table]) => [id, [...table]]),
    served: [...g.lines.servedStations], catchmentDirty: g.lines.catchmentDirty,
    reservations: [...vehicles.res],
    terrain: [...w.dirtyTerrain], objects: [...w.dirtyObj], freeTrees: w.freeTrees,
    // Check spatial index contents and query ordering too, including temporary-node cleanup.
    nodeGrid: n.nodeGrid, edgeGrid: n.grid, buildingGrid: w.bgrid, treeGrid: w.treeGrid,
  }, (_key, value) => value instanceof Map || value instanceof Set ? [...value] : value);
}

function sameState(actual: string, expected: string, label: string): void {
  if (actual === expected) return;
  let at = 0;
  while (at < Math.min(actual.length, expected.length) && actual[at] === expected[at]) at++;
  assert.fail(`${label}: state differs at character ${at}\nexpected: ${expected.slice(Math.max(0, at - 50), at + 100)}\nactual:   ${actual.slice(Math.max(0, at - 50), at + 100)}`);
}

function pure(g: Game, label: string, preview: (i: number) => unknown): void {
  const before = snapshot(g);
  let successes = 0;
  for (let i = 0; i < 20; i++) {
    const result = preview(i) as { ok?: boolean } | null;
    if (result?.ok) successes++;
    sameState(snapshot(g), before, `${label}: call ${i + 1}`);
    calls++;
  }
  groups++;
  console.log(`  ${label}: 20 pure calls${successes ? ` (${successes} valid plans)` : ''}`);
}

function fixture(structures: boolean) {
  const g = flatGame(256, 3, structures
    ? (x) => 3 + Math.max(0, 9 - Math.abs(x - 110) * 0.6) - Math.max(0, 4 - Math.abs(x - 170) * 0.5)
    : undefined);
  const net = g.world.net;
  assert.ok(build(g, free(g, 20, 120), free(g, 236, 120), roadOpts(0, 'street'), 'fixture street'));
  assert.ok(build(g, free(g, 20, 60), free(g, 236, 60), roadOpts(0, 'street', { tram: true }), 'fixture tram street'));
  const A = station(g, 24, 128, Math.PI / 2, 10, 2)!;
  const B = station(g, 232, 128, Math.PI / 2, 10, 2)!;
  assert.ok(A && B, 'fixture termini');
  const e0 = net.nextEdge;
  assert.ok(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
    nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'fixture main line'));
  const main = newRailEdges(g, e0);
  const p0 = net.nextEdge;
  assert.ok(build(g, free(g, 20, 208), free(g, 236, 208), railOpts(0, 2), 'fixture parallel track'));
  const parallel = newRailEdges(g, p0);
  const C = station(g, 96, 80, Math.PI / 2, 12, 2, 0, { level: 'underground', through: 1 })!;
  assert.ok(C, 'fixture underground station');
  const dp = g.depots.plan('rail', 16, 128, Math.PI / 2, 0), depId = g.depots.nextId;
  assert.equal(g.depots.commit('rail', dp, 0), null, 'fixture rail depot');
  const line = g.lines.create('rail', 0);
  line.stops = [A.id, B.id];
  assert.notEqual(typeof g.vehicles.buyTrain(depId, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!], line.id), 'string');
  const stops = [addBusStop(g, 54, 120, 0), addBusStop(g, 200, 120, 0)];
  assert.ok(stops.every((id) => id >= 0), 'fixture bus stops');
  g.lines.rebuild();
  assert.equal(fails.length, 0, 'shared fixture checks');
  return { g, A, C, main, parallel, line };
}

for (const structures of [false, true]) {
  const { g, A, C, main, parallel, line } = fixture(structures);
  const net = g.world.net;
  console.log(structures ? 'bridge / tunnel fixture' : 'flat fixture');
  pure(g, 'planDoubleTrack', (i) => planDoubleTrack(g, i === 19 ? [-999] : main, i % 2 ? -1 : 1, 0));
  pure(g, 'planConnection', (i) => planConnection(g, parallel[0], 40 + i, parallel[1], 50 + i, i === 19 ? 1 : 0, { search: i % 3 * 2 }));
  pure(g, 'planRelevel', (i) => planRelevel(g, i === 19 ? [] : [...main, ...A.rail!.edges],
    (['ground', 'elevated', 'underground'] as const)[i % 3], 0, { height: 1.5 + i % 3 * 0.3, depth: 2 + i % 4 * 0.2 }));
  pure(g, 'planStationOnTrack', (i) => planStationOnTrack(g, main[0], 30 + i * 6,
    { length: 8 + i % 3 * 2, tracks: 1 + i % 3, through: i % 2 }, i === 19 ? 1 : 0));
  pure(g, 'planStationUpgrade', (i) => planStationUpgrade(g, i === 19 ? -999 : A.id,
    { length: 10 + i % 5, tracks: 2 + i % 3, through: i % 2, style: i % 4 === 0 ? 'none' : undefined }));
  pure(g, 'stations.planUpgrade', (i) => g.stations.planUpgrade(C.id,
    { level: (['underground', 'elevated', 'ground'] as const)[i % 3], length: 12 + i % 3, tracks: 2 + i % 2 }));
  pure(g, 'planEdge', (i) => planEdge(g, free(g, 20 + i, 184), free(g, 225 - i, 184 + i % 5),
    i % 2 ? roadOpts(0, 'street', { straight: true }) : railOpts(0, 1 + i % 3, { heightOffset: (i % 3 - 1) * 2 })));
  for (const kind of ['rail', 'road', 'tram'] as DepotKind[]) pure(g, `depots.plan(${kind})`,
    (i) => g.depots.plan(kind, kind === 'rail' ? 242 : 40 + i * 3,
      kind === 'rail' ? 128 : kind === 'tram' ? 56 : 117, i === 19 ? Math.PI : 0, 0));
  pure(g, 'stations.planRail', (i) => g.stations.planRail(60 + i * 2, 160, i % 2 ? Math.PI / 2 : 0,
    8 + i % 4 * 2, 1 + i % 4, 0, { level: (['ground', 'elevated', 'underground'] as const)[i % 3], through: i % 3 }));
  pure(g, 'stations.planBusStop', (i) => g.stations.planBusStop(30 + i * 8, i % 2 ? 60 : 120, 0, { share: i % 3 === 0 }));
  pure(g, 'stations.planEntrance', (i) => g.stations.planEntrance(i === 19 ? -999 : C.id, 80 + i, 61, 0));
  pure(g, 'stations.planCatchShapes', (i) => g.stations.planCatchShapes(
    g.stations.planRail(90 + i, 160, 0, 8 + i % 4, 2, 0, { level: (['ground', 'elevated', 'underground'] as const)[i % 3] })));
  pure(g, 'signalsAlong', (i) => signalsAlong(g, i === 19 ? -999 : main[0], i % 2 ? -1 : 1, 20 + i, 0,
    60 + i * 4, { s0: 10 + i }));
  pure(g, 'autoSignalLine(line)', (i) => autoSignalLine(g, i === 19 ? -999 : line.id, 0, { preview: true, spacing: 20 + i }));
  pure(g, 'autoSignalLine(edges)', (i) => autoSignalLine(g, i === 19 ? [] : [...main, ...parallel], 0, { preview: true, spacing: 20 + i }));
  pure(g, 'autoSignalNetwork', (i) => autoSignalNetwork(g, i === 19 ? 1 : 0, { preview: true, spacing: 20 + i }));
  pure(g, 'findSnap', (i) => findSnap(g, i % 2 ? 'rail' : 'road', 30 + i * 8, i % 2 ? 128 : 120));
  pure(g, 'bulldoze(dryRun)', (i) => bulldoze(g, 20 + i, 118, 40 + i, 130, 0, true));
  pure(g, 'electrify(dryRun)', (i) => electrify(g, i % 2 ? main : parallel, 0, true));
  pure(g, 'addTramTracks(dryRun)', (i) => addTramTracks(g, [...net.edges.values()].filter((e) => e.kind === 'road').map((e) => e.id).slice(0, 1 + i % 2), 0, true));
  pure(g, 'removeTramTracks(dryRun)', (i) => removeTramTracks(g, [...net.edges.values()].filter((e) => e.tram).map((e) => e.id).slice(0, 1 + i % 2), 0, true));
}

// Populated games use the same seeded generation / shared helpers as smoke.ts and fuzz.ts. Existing streets,
// buildings, ambient traffic, AI RNGs and town growth caches must also survive rejected and valid previews.
for (const seed of [7, 11, 23]) {
  const g = Game.create({ size: 192, seed, towns: 3, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2 });
  g.economy.money = 1e8;
  const streets = [...g.world.net.edges.values()].filter((e) => e.kind === 'road');
  assert.ok(streets.length, 'generated fixture streets');
  console.log(`populated fixture seed ${seed}`);
  pure(g, 'planEdge', (i) => planEdge(g, free(g, 20 + i * 3, 40), free(g, 150, 50 + i * 3),
    i % 2 ? railOpts(0) : roadOpts(0)));
  pure(g, 'stations.planRail', (i) => g.stations.planRail(40 + i * 4, 96, i % 2 ? 0 : Math.PI / 2, 8 + i % 3, 2, 0,
    { level: (['ground', 'elevated', 'underground'] as const)[i % 3] }));
  pure(g, 'stations.planBusStop', (i) => {
    const e = streets[i % streets.length], p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len * (0.2 + i % 7 * 0.1), p);
    return g.stations.planBusStop(p.x, p.z, i % 3, { share: i % 2 === 0 });
  });
  pure(g, 'depots.plan', (i) => g.depots.plan((['rail', 'road', 'tram'] as const)[i % 3], 40 + i * 4, 98, i * 0.2, i % 3));
}

// Exceptions and nested scopes must also leave allocators, versions and spatial ordering intact.
{
  const { g, main } = fixture(false), net = g.world.net;
  const before = snapshot(g), nextNode = net.nextNode;
  const points = [{ x: 96, y: 3, z: 176, dx: 1, dz: 0 }];
  const failure = new Error('deliberate preview failure');
  assert.throws(() => net.withTemporaryNodes('rail', points, 0, (outer) => {
    assert.equal(outer[0].id, nextNode);
    assert.equal(net.nextNode, nextNode, 'temporary nodes never advance the allocator');
    return net.withTemporaryNodes('rail', points, 0, (inner) => {
      assert.notEqual(inner[0].id, outer[0].id);
      assert.equal(net.nodes.get(outer[0].id), outer[0]);
      throw failure;
    });
  }), (e) => e === failure);
  sameState(snapshot(g), before, 'nested temporary-node exception');
  cleanupChecks++;
  const geo = net.geo;
  net.geo = (e) => {
    if (net.nodes.has(nextNode)) throw failure; // fail inside planEdge, after preview nodes have been added
    return geo.call(net, e);
  };
  try { assert.throws(() => planDoubleTrack(g, main, 1, 0), (e) => e === failure); }
  finally { net.geo = geo; }
  sameState(snapshot(g), before, 'double-track planning exception');
  cleanupChecks++;
  console.log('  exception cleanup: nested scope and double-track preview pure');
}

/** Compare a direct commit with committing the identical plan after unrelated, cancelled hover previews. */
function sameCommit(label: string, plan: (g: Game, main: number[], parallel: number[], stationId: number) => unknown,
  commit: (g: Game, p: any) => unknown): void {
  const { g: source, main, parallel, A } = fixture(false);
  const saved = JSON.stringify(serialize(source));
  const g = deserialize(JSON.parse(saved)), control = deserialize(JSON.parse(saved));
  sameState(snapshot(g), snapshot(control), `${label}: loaded fixture`);
  const p = plan(g, main, parallel, A.id);
  const expectedPlan = JSON.stringify(plan(control, main, parallel, A.id));
  assert.equal(JSON.stringify(p), expectedPlan, `${label}: plan result changed`);
  const before = snapshot(g);
  for (let i = 0; i < 20; i++) planDoubleTrack(g, main, i % 2 ? -1 : 1, 0);
  sameState(snapshot(g), before, `${label}: cancelled hover previews`);
  const actual = commit(g, p), expected = commit(control, plan(control, main, parallel, A.id));
  assert.deepEqual(actual, expected, `${label}: commit result differs`);
  assert.ok(actual === null || (actual as any)?.error === null, `${label}: fixture commit failed`);
  sameState(snapshot(g), snapshot(control), `${label}: committed simulation`);
  commits++;
  console.log(`  ${label}: direct / after-hover commits identical`);
}

sameCommit('double track', (g, main) => planDoubleTrack(g, main, 1, 0), (g, p) => commitDoubleTrack(g, p, false));
sameCommit('connection', (g, _main, parallel) => planConnection(g, parallel[0], 40, parallel[1], 50, 0), (g, p) => commitConnection(g, p, { signals: false }));
sameCommit('relevel', (g, _main, parallel) => planRelevel(g, parallel, 'elevated', 0), commitRelevel);
sameCommit('station on track', (g, _main, parallel) => planStationOnTrack(g, parallel[0], 100, { length: 10, tracks: 2 }, 0), commitStationOnTrack);
sameCommit('station upgrade', (g) => planStationUpgrade(g,
  g.stations.all().find((st) => st.rail?.level === 'underground')!.id,
  { level: 'ground', length: 14, tracks: 3 }), commitStationUpgrade);
sameCommit('edge', (g) => planEdge(g, free(g, 30, 176), free(g, 220, 176), railOpts(0)), commitProposal);
sameCommit('rail station', (g) => g.stations.planRail(120, 160, Math.PI / 2, 10, 2, 0), (g, p) => g.stations.commitRail(p, 0));
sameCommit('depot', (g) => g.depots.plan('road', 48, 117, 0, 0), (g, p) => g.depots.commit('road', p, 0));
sameCommit('bus stop', (g) => g.stations.planBusStop(48, 120, 0), (g, p) => g.stations.commitBusStop(p.px, p.pz, 0));
sameCommit('signals', (g, main) => signalsAlong(g, main[0], 1, 40, 0), (g, p) => setSignal(g, p.spots[0].edge, p.spots[0].s, 'oneway', true, 0));

console.log(`PURITY PASSED: ${calls} calls across ${groups} planner groups; ${cleanupChecks} exception checks; ${commits} commit comparisons (${((performance.now() - T0) / 1000).toFixed(1)} s)`);
