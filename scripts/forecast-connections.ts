// Exact connection pricing and work avoided by isolated proposals.
// Bundle as forecast-connections.mjs; optionally pass a bundled previous DemandModel module and --timing.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { DemandModel } from '../src/game/demand';
import type { RouteEdge } from '../src/game/lines';
import { WALK_LINE } from '../src/game/stations';

const candidate = (DemandModel.prototype as any).forecastMainlineConnections as (...args: any[]) => any;
const baseline = process.argv.slice(2).find(arg => arg !== '--timing');
const controlModule = baseline ? await import(pathToFileURL(baseline).href) : null;
const control = controlModule ? controlModule.DemandModel.prototype.forecastMainlineConnections as typeof candidate : null;
type Work = { sources: number; populationSums: number };
class Regions extends Map<number, number> {
  constructor(private work: Work, entries: [number, number][]) { super(entries); }
  values() { this.work.populationSums++; return super.values(); }
}
class Graph extends Map<number, RouteEdge[]> {
  constructor(private work: Work, entries: [number, RouteEdge[]][]) { super(entries); }
  *keys() { for (const id of super.keys()) { this.work.sources++; yield id; } }
}
type Kind = 'isolated' | 'incoming' | 'outgoing' | 'mixed' | 'shared' | 'planned-walk' | 'zero-pop';
const fixture = (kind: Kind, count = 8, reverse = false) => {
  const work: Work = { sources: 0, populationSums: 0 }, proposed = kind === 'shared' ? 10 : 42;
  const ids = kind === 'shared' ? [1, 2] : [-1, -2];
  const order = Array.from({ length: count }, (_, i) => 100 + i);
  if (reverse) order.reverse();
  const stations = new Map<number, any>();
  const region = (id: number, extra: boolean) => new Regions(work, [
    [id % 2, kind === 'zero-pop' ? 0 : 65.0000000003 + id % 7],
    [1 - id % 2, kind === 'zero-pop' ? 0 : extra ? 22.0000000007 : 7.0000000001],
  ]);
  const background = new Map<number, any>();
  for (const id of order) {
    stations.set(id, { id, x: 10 + (id - 100) * 12, z: id % 3 * 8, townId: id % 2 });
    background.set(id, { walking: region(id, false), regional: region(id, true) });
  }
  const sites = ids.map((id, i) => ({ x: 35 + i * 80, z: 24, townId: i, pop: 100,
    regions: region(i, true) }));
  const walking = sites.map((_, i) => ({ pop: 80, regions: region(i, false) }));
  const edges = new Graph(work, [...ids, ...order].map(id => [id, []]));
  const add = (from: number, to: number, line: number, cost: number) => edges.get(from)!.push({ to, line, cost });
  add(ids[0], ids[1], proposed, 44); add(ids[1], ids[0], proposed, 46);
  for (const from of order) for (const to of order) if (from !== to) add(from, to, 10 + from % 2, 8 + Math.abs(from - to) * 5);
  if (kind === 'incoming' || kind === 'mixed' || kind === 'shared' || kind === 'zero-pop') add(order[0], ids[0], 10, 8);
  if (kind === 'outgoing' || kind === 'mixed' || kind === 'shared' || kind === 'zero-pop') add(ids[1], order.at(-1)!, 11, 9);
  if (kind === 'planned-walk') {
    add(order[0], ids[0], WALK_LINE, 3); add(ids[1], order.at(-1)!, 11, 9);
  }
  const g: any = { stations: { get: (id: number) => stations.get(id) }, lines: { get: () => ({ kind: 'rail' }) },
    towns: { list: [{ pop: 1000 }, { pop: 1000 }] } };
  const demand = new DemandModel(g);
  demand.regions = [0, 1].map(id => ({ id, town: id, kind: 'town', x: id * 80, z: 0, r: 30,
    pop: 600, jobs: 200, produced: 1, attracted: 1 }));
  demand.od = new Float32Array([.7, .3, .4, .6]); demand.ld = new Float32Array([0, .03, .02, 0]);
  const context = { ids, edges, proposed, sameComplex: () => false };
  return { work, demand, args: [sites, walking, background, context, 80, 120], origins: count + sites.length };
};
const run = (fn: typeof candidate, kind: Kind, count: number, reverse: boolean) => {
  const f = fixture(kind, count, reverse);
  const result = fn.call(f.demand, ...f.args);
  return { result, work: f.work, origins: f.origins };
};
const rows: any[] = [];
for (const count of [2, 8, 24]) for (const reverse of [false, true]) for (const kind of
  ['isolated', 'incoming', 'outgoing', 'mixed', 'shared', 'planned-walk', 'zero-pop'] as Kind[]) {
  const actual = run(candidate, kind, count, reverse), previous = control && run(control, kind, count, reverse);
  if (previous) assert.deepEqual(actual.result, previous.result, `${kind}/${count}/${reverse}: exact previous-function output`);
  if (kind === 'isolated') {
    assert.deepEqual(actual.result, { boardings: 0, revenue: 0, legLoads: [0, 0] });
    assert.equal(actual.work.sources, 0); assert.equal(actual.work.populationSums, 0);
    if (previous) assert.equal(previous.work.sources, count + 2);
  } else {
    assert.equal(actual.work.sources, count + 2, `${kind}: retain all native graph sources`);
    assert.equal(actual.work.populationSums, 2 * actual.origins, `${kind}: one sum per origin and population kind`);
    if (kind === 'incoming' || kind === 'outgoing' || kind === 'mixed' || kind === 'planned-walk')
      assert(actual.result.boardings > 0 && actual.result.revenue > 0, `${kind}: genuine connecting receipts survive`);
  }
  if (count === 24 && !reverse) rows.push({ kind, old: previous?.work, fixed: actual.work,
    boardings: actual.result.boardings, revenue: actual.result.revenue });
}
console.log(`PASS 42 connection contexts: isolated, both one-way directions, mixed, shared line, planned walk, zero population; insertion orders preserved${control ? '; exact previous-function outputs' : ''}`);
console.log(JSON.stringify(rows));

// Daily weights share destination coverage privately, without changing public array ownership.
const weightControl = controlModule ? controlModule.DemandModel.prototype.weights as (st: any) => any : null;
const weightCandidate = DemandModel.prototype.weights;
const weightFixture = (count = 16) => {
  const work = { snapshots: 0, feederRefreshes: 0 }, stations = new Map<number, any>();
  for (let id = 1; id <= count; id++) stations.set(id, { id, x: id * 12, z: id % 3 * 8,
    townId: id % 2, catchPop: 80.0000000003 + id, roadAccess: true });
  const routing = new Map<number, Map<number, any>>();
  for (const from of stations.keys()) routing.set(from, new Map([...stations.keys()].filter(to => from !== to)
    .map(to => [to, { line: 42, alight: to, cost: 30 + Math.abs(from - to) * 8 }])));
  const g: any = { day: 3, networkVersion: 4, world: { lotVersions: { version: 2 } }, vehicles: { map: new Map() },
    stations: { get: (id: number) => stations.get(id), hasAccess: () => true },
    lines: { routing, version: 5, get: () => ({ kind: 'rail', vehicles: [1] }) }, towns: { list: [{ pop: 1000 }, { pop: 1000 }] } };
  const model = new DemandModel(g);
  model.regions = [0, 1].map(id => ({ id, town: id, kind: 'town', x: id * 80, z: 0, r: 30,
    pop: 600, jobs: 200, produced: 1, attracted: 1 }));
  model.od = new Float32Array([.7, .3, .4, .6]); model.ld = new Float32Array([0, .03, .02, 0]);
  for (const st of stations.values()) {
    model.shares.set(st.id, [[st.townId, .7], [1 - st.townId, .3]]);
    (model as any).feeders.set(st.id, { pop: 12.0000000007,
      regions: new Map([[st.townId, 4.0000000001], [1 - st.townId, 8.0000000006]]) });
  }
  (model as any).refreshFeeders = () => { work.feederRefreshes++; };
  const snapshot = model.coverageSnapshot;
  model.coverageSnapshot = (st, feeders = true) => { work.snapshots++; return snapshot.call(model, st, feeders); };
  return { model, g, stations, work };
};
const fixed = weightFixture(), old = weightFixture();
const sweep = (f: ReturnType<typeof weightFixture>, method: (st: any) => any) => [...f.stations.values()].map(st => method.call(f.model, st));
let exactSweeps = 0;
const compareSweep = () => {
  const actual = sweep(fixed, weightCandidate), expected = weightControl && sweep(old, weightControl);
  if (expected) assert.deepEqual(actual, expected, 'daily weights exactly match the previous function');
  exactSweeps++;
  return actual;
};
compareSweep();
const firstWork = { old: { ...old.work }, fixed: { ...fixed.work } };
assert.equal(fixed.work.snapshots, 2 * fixed.stations.size);
assert.equal(fixed.work.feederRefreshes, fixed.stations.size);
if (weightControl) {
  assert.equal(old.work.snapshots, old.stations.size * (old.stations.size - 1));
  assert.equal(old.work.feederRefreshes, old.stations.size * old.stations.size);
}
const publicRows = fixed.model.coverageSnapshot(fixed.stations.get(2)!, true);
publicRows[0][1] = -1000; publicRows.push([99, 1000]);
assert.notDeepEqual(publicRows, fixed.model.coverageSnapshot(fixed.stations.get(2)!, true), 'public coverage remains fresh');
for (const f of [fixed, old]) { f.g.day++; f.work.snapshots = 0; f.work.feederRefreshes = 0; }
compareSweep();
const warm = { ...fixed.work }; compareSweep();
assert.deepEqual(fixed.work, warm, 'warm weights skip both coverage publication and redundant feeder refresh');
const mutations: ((f: ReturnType<typeof weightFixture>) => void)[] = [
  f => f.g.day++, f => f.g.world.lotVersions.version++, f => f.g.vehicles.map.set(1, {}),
  f => f.g.lines.version++, f => f.model.version++, f => f.g.networkVersion++,
];
for (const change of mutations) {
  for (const f of [fixed, old]) {
    change(f); f.work.snapshots = 0; f.work.feederRefreshes = 0;
    for (const st of f.stations.values()) { st.catchPop += 1.0000000003; f.model.shares.set(st.id, [[st.townId, .6], [1 - st.townId, .4]]); }
  }
  compareSweep();
  assert.equal(fixed.work.snapshots, 2 * fixed.stations.size, 'each inherited cache-key change clears private coverage rows');
}
for (const f of [fixed, old]) {
  f.g.day++; weightCandidate.call(f.model, f.stations.get(1)!);
  f.stations.set(2, { ...f.stations.get(2), catchPop: 240 });
}
assert.deepEqual(weightCandidate.call(fixed.model, fixed.stations.get(3)!),
  (weightControl ?? weightCandidate).call(old.model, old.stations.get(3)!), 'replacement station object cannot alias prior coverage');
console.log(`PASS ${exactSweeps} daily sweeps: exact outputs, all inherited cache-key changes, replacement station identity and fresh public coverage`);
console.log(JSON.stringify({ dailyWork: firstWork }));

if (process.argv.includes('--timing') && control && weightControl) {
  const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];
  const measure = (action: () => void, repeats: number) => {
    const start = performance.now(); for (let i = 0; i < repeats; i++) action();
    return (performance.now() - start) / repeats;
  };
  const paired = (before: () => void, after: () => void, repeats: number) => {
    for (let i = 0; i < 4; i++) { before(); after(); }
    const old: number[] = [], fixed: number[] = [];
    for (let i = 0; i < 7; i++) {
      if (i % 2) { fixed.push(measure(after, repeats)); old.push(measure(before, repeats)); }
      else { old.push(measure(before, repeats)); fixed.push(measure(after, repeats)); }
    }
    return { oldMs: median(old), fixedMs: median(fixed), pairedSamples: 7 };
  };
  const forecasts = (kind: Kind) => {
    const a = fixture(kind, 24), b = fixture(kind, 24);
    return paired(() => control.call(a.demand, ...a.args), () => candidate.call(b.demand, ...b.args), 6);
  };
  const a = weightFixture(128), b = weightFixture(128);
  const weights = paired(() => { a.g.day++; sweep(a, weightControl); }, () => { b.g.day++; sweep(b, weightCandidate); }, 2);
  console.log(JSON.stringify({ timing: { isolated: forecasts('isolated'), mixed: forecasts('mixed'), weights },
    scope: 'serial synthetic native routing/fare kernels and daily weights, not browser FPS or whole-scene timing' }));
}
