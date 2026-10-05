// Bundle as catchperf.mjs; node catchperf.mjs [seed=23] [years=5] [size=768] [--matrix] [--baseline].
// --timing-only measures without the independent reference's allocations; --assert-targets checks the 768/23 budget.
// --oracle=before/catchperf.mjs compares an unchanged-code bundle, including every tick's game RNG and the final save.
// Run the baseline on unchanged sources and retain its bundle/reports. Use the same Node version and case order
// for both runs: AI service-cost memoization has rounded keys and lives for the entire process.
// --compare-before also asserts every monthly hash and passenger total against those reports in the current directory.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { bezLine } from '../src/game/geom';
import { walkingCatchment } from '../src/game/catchment';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { roadDepotNear } from './lib';

export { Game, serialize, deserialize }; // Optional unchanged-code oracle bundle for a tick-by-tick comparison.

const baseline = process.argv.includes('--baseline');
const timingOnly = process.argv.includes('--timing-only');
const measureCPU = process.argv.includes('--cpu');
const years = Number(process.argv[3] ?? 5);
const cases = process.argv.includes('--matrix')
  ? [512, 768].flatMap((size) => [7, 23].map((seed) => ({ seed, size })))
  : [{ seed: Number(process.argv[2] ?? 23), size: Number(process.argv[4] ?? 768) }];
const stats = (times: ArrayLike<number>) => {
  const sorted = Float64Array.from(times).sort();
  let sum = 0; for (let i = 0; i < times.length; i++) sum += times[i];
  return { count: times.length, mean: sum / Math.max(1, times.length),
    p99: sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * .99))] ?? 0, max: sorted.at(-1) ?? 0 };
};
function snapshot(g: Game) {
  return { stations: [...g.stations.map.values()].map((s) => [s.id, s.catchPop, g.stations.buildingShares(s)]),
    buildings: [...g.world.buildings.keys()].sort((a, b) => a - b).map((id) => [id, g.stations.stationsForBuilding(id)]) };
}
function sameSave(actual: Game, expected: Game, label: string, expectedSerialize = serialize) {
  const a = JSON.stringify(serialize(actual)), b = JSON.stringify(expectedSerialize(expected));
  if (a === b) return;
  let at = 0; while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
  throw new Error(`${label}: save differs at ${at}\nactual: ${a.slice(Math.max(0, at - 80), at + 160)}\nexpected: ${b.slice(Math.max(0, at - 80), at + 160)}`);
}
function checkFull(g: Game) {
  if (timingOnly) return;
  // Added by the incremental implementation. Baseline collects the same snapshots without this check.
  const debug = (g.stations as any).debugFullCatchment;
  if (!debug) { if (!baseline) throw new Error('debugFullCatchment is required'); return; }
  const full = debug.call(g.stations);
  for (const s of g.stations.map.values()) {
    const expected = full.stations.get(s.id) ?? { ids: [], w: [], pop: 0 };
    if (JSON.stringify(g.stations.buildingShares(s)) !== JSON.stringify({ ids: expected.ids, w: expected.w }) || s.catchPop !== expected.pop)
      throw new Error(`Station ${s.id} differs at day ${g.day}: ${s.catchPop} / ${expected.pop}`);
  }
  for (const id of g.world.buildings.keys()) {
    if (JSON.stringify(g.stations.stationsForBuilding(id)) !== JSON.stringify(full.buildings.get(id) ?? { st: [], w: [] }))
      throw new Error(`Building ${id} differs at day ${g.day}`);
  }
}

function checkHooks() {
  const g = Game.create({ size: 192, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990 });
  g.world.h.fill(3); g.world.terrainVersions.bump(); g.economy.money = 1e9;
  const net = g.world.net;
  const road = (x0: number, z0: number, x1: number, z1: number) => {
    const a = net.addNode('road', x0, 3, z0), b = net.addNode('road', x1, 3, z1);
    return net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(Math.hypot(x1-x0, z1-z0)) + 1).fill(3), [], 'road', -1);
  };
  const main = road(20, 60, 170, 60);
  const bus = (x: number) => { const id = g.stations.nextId; assert.equal(g.stations.commitBusStop(x, 60, 0), null); return g.stations.get(id)!; };
  const A = bus(52), B = bus(72), C = bus(96);
  const house = (x: number, z: number) => g.world.addBuilding({ townId: -1, x, z, angle: 0, w: .8, d: .8, floors: 2, pop: 10, type: 0, seed: 1, y: 3, built: 0 });
  let checks = 0;
  let recomputes = 0;
  const recompute = g.stations.recomputeCatchment.bind(g.stations);
  g.stations.recomputeCatchment = (slice = false) => { recomputes++; return recompute(slice); };
  const flush = () => { g.stations.refreshAccess(true); g.lines.catchmentDirty = true; g.lines.flushCatchment(); checkFull(g); checks++; };
  const b = house(60, 58); flush(); assert.equal(g.stations.stationsForBuilding(b.id).st.length, 2);
  const depot = roadDepotNear(g, 52, 60, 0, [main.id]); assert.ok(depot >= 0);
  const line = g.lines.create('road', 0); line.stops = [A.id, C.id]; g.lines.rebuild(); flush();
  const first = g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, line.id); assert.notEqual(typeof first, 'string');
  assert.ok(g.lines.catchmentDirty); g.lines.flushCatchment(); checkFull(g); checks++;
  assert.deepEqual(g.stations.stationsForBuilding(b.id).st, [A.id]);
  const version = g.stations.catchVersion;
  const calls = recomputes;
  const second = g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, line.id); assert.notEqual(typeof second, 'string');
  g.lines.flushCatchment(); assert.equal(g.stations.catchVersion, version); assert.equal(recomputes, calls);
  if (typeof second !== 'string') { second.setLine(null); second.setLine(line.id); g.vehicles.sell(second.id); }
  g.lines.flushCatchment(); assert.equal(g.stations.catchVersion, version); assert.equal(recomputes, calls);
  if (typeof first !== 'string') g.vehicles.sell(first.id);
  assert.ok(g.lines.catchmentDirty); g.lines.flushCatchment(); checkFull(g); checks++;
  assert.equal(g.stations.stationsForBuilding(b.id).st.length, 2);
  const cached = walkingCatchment(g, A);
  const distant = house(144, 140); flush(); assert.equal(walkingCatchment(g, A), cached);
  const remoteRoad = road(140, 150, 170, 150); flush(); assert.equal(walkingCatchment(g, A), cached);
  net.removeEdge(remoteRoad.id); g.world.removeBuilding(distant.id); flush(); assert.equal(walkingCatchment(g, A), cached);
  b.pop = 30; g.world.touchBuilding(b); flush();
  b.pop = 0; g.world.touchBuilding(b); flush(); assert.deepEqual(g.stations.stationsForBuilding(b.id), { st: [], w: [] });
  b.pop = 10; b.x = 64; g.world.touchBuilding(b); flush(); // footprint straddles a region boundary
  b.angle = Math.PI / 2; g.world.touchBuilding(b); flush();
  b.x = 160; g.world.touchBuilding(b); flush(); assert.equal(g.stations.stationsForBuilding(b.id).st.length, 0);
  b.x = 60; g.world.touchBuilding(b); flush();
  g.world.removeBuilding(b.id); flush(); assert.equal(g.stations.stationsForBuilding(b.id).st.length, 0);
  const restored = { ...b, id: g.world.nextBuildingId++ }; // same writes as save load
  g.world.buildings.set(restored.id, restored); g.world.bgrid.insert(restored.id, 59, 57, 61, 59); flush();
  A.links = [B.id]; B.links = [A.id]; flush(); A.links = []; B.links = []; flush();
  const currentRoad = net.edges.get(A.stops[0].edge)!;
  currentRoad.tram = true; net.touchEdge(currentRoad); flush(); delete currentRoad.tram; net.touchEdge(currentRoad); flush();
  g.world.setVertex(60, 59, -1); flush(); g.world.setVertex(60, 59, 3); flush();
  g.world.h[g.world.vi(60, 59)] = -1; g.world.heightsVersion++; flush();
  g.world.h[g.world.vi(60, 59)] = 3; g.world.heightsVersion++; flush();
  g.world.lotVersions.bump(); net.roadVersions.bump(); g.world.terrainVersions.bump(); flush();
  assert.ok(net.splitEdge(currentRoad.id, currentRoad.len / 2)); flush();
  console.log(`Hook/trigger checks: ${checks} exact full comparisons; purchase/sale, population, eligibility, geometry, region boundaries, complexes, roads, terrain, load and bulk fallback passed.`);
}

const main = process.argv[1]?.endsWith('/catchperf.mjs') && import.meta.url === pathToFileURL(process.argv[1]).href;
if (main && !baseline && !timingOnly) checkHooks();
if (main && !process.argv.includes('--hooks-only')) for (const { seed, size } of cases) {
  console.log(`Creating seed ${seed}, ${size} map, 3 AIs; ${years} years${timingOnly ? ' (timing)' : ''}`);
  const g = Game.create({ size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  const oracleArg = process.argv.find((a) => a.startsWith('--oracle='));
  const oracleModule = oracleArg ? await import(pathToFileURL(oracleArg.slice(9)).href) : undefined;
  const Oracle = oracleModule?.Game;
  const oracle = Oracle?.create(g.options) as Game | undefined;
  if (oracle) console.log('Unchanged-code oracle ready');
  let oracleDue = false;
  if (oracle) {
    const recompute = oracle.stations.recomputeCatchment.bind(oracle.stations);
    oracle.stations.recomputeCatchment = () => { const result = recompute(); oracleDue = true; return result; };
  }
  const events: unknown[] = [];
  if (oracle) for (const [name, game] of [['current', g], ['before', oracle]] as const) {
    let dirty = game.lines.catchmentDirty;
    Object.defineProperty(game.lines, 'catchmentDirty', { get: () => dirty, set: (v: boolean) => {
      if (v && !dirty) { events.push({ name, tick: game.tick, net: game.world.net.version, stack: new Error().stack?.split('\n').slice(2, 6) }); if (events.length > 10) events.shift(); }
      dirty = v;
    } });
  }
  const calls: number[] = [], ticks = new Float64Array(Math.ceil(years * 360 * g.ticksPerDay));
  const worst: { tick: number; day: number; ms: number }[] = [];
  let tickCount = 0;
  const checkpoints: { day: number; hash: string }[] = [];
  const slowCalls: { tick: number; day: number; ms: number; cpuMs?: number }[] = [];
  const cpuCalls: number[] = [];
  let due = false, checks = 0;
  const original = g.stations.recomputeCatchment.bind(g.stations);
  g.stations.recomputeCatchment = (slice = false) => {
    const cpuStart = measureCPU ? process.cpuUsage() : undefined;
    const start = performance.now(); const complete = original(slice); const ms = performance.now() - start; calls.push(ms); due = true;
    const cpu = cpuStart && process.cpuUsage(cpuStart), cpuMs = cpu ? (cpu.user + cpu.system) / 1000 : undefined;
    if (cpuMs !== undefined) cpuCalls.push(cpuMs);
    if (slowCalls.length < 8 || ms > slowCalls[slowCalls.length - 1].ms) {
      slowCalls.push({ tick: g.tick, day: g.day, ms, cpuMs });
      slowCalls.sort((a, b) => b.ms - a.ms); if (slowCalls.length > 8) slowCalls.pop();
    }
    return complete;
  };
  const start = performance.now();
  while (g.day < years * 360) {
    const t = performance.now(); g.stepTick(); const ms = performance.now() - t;
    if (oracle) {
      oracle.stepTick();
      if ((due || oracleDue) && !g.lines.catchmentDirty && !oracle.lines.catchmentDirty && JSON.stringify(snapshot(g)) !== JSON.stringify(snapshot(oracle))) {
        for (const s of g.stations.map.values()) {
          const os = oracle.stations.get(s.id);
          if (!os || JSON.stringify([s.catchPop, g.stations.buildingShares(s)]) !== JSON.stringify([os.catchPop, oracle.stations.buildingShares(os)])) {
            console.log('FIRST DIFFERENCE', g.tick, g.day, s.id, JSON.stringify({ current: [s.catchPop, g.stations.buildingShares(s)], before: os && [os.catchPop, oracle.stations.buildingShares(os)], rng: [g.rng.state, oracle.rng.state], maxB: [g.stations.catchMaxB, oracle.stations.catchMaxB], events }, null, 2));
            break;
          }
        }
        throw new Error('Unchanged-code oracle differs');
      }
      if (g.rng.state !== oracle.rng.state) throw new Error(`Passenger/game RNG differs at tick ${g.tick}, day ${g.day}`);
      oracleDue = false;
    }
    ticks[tickCount++] = ms;
    // Keep only actual top-eight ticks: don't create 72,000 throwaway records that can trigger GC in the game.
    if (worst.length < 8 || ms > worst[worst.length - 1].ms) {
      worst.push({ tick: g.tick, day: g.day, ms });
      worst.sort((a, b) => b.ms - a.ms); if (worst.length > 8) worst.pop();
    }
    if (due && !g.lines.catchmentDirty) { checkFull(g); if (!timingOnly) checks++; due = false; }
    if (g.day > (checkpoints.at(-1)?.day ?? -1) && g.day % 30 === 1) {
      checkpoints.push({ day: g.day, hash: createHash('sha256').update(JSON.stringify(snapshot(g))).digest('hex') });
    }
    if (g.day % (process.argv.includes('--verbose') ? 30 : 360) === 0 && g.tick % g.ticksPerDay === 0)
      console.log(`seed ${seed} size ${size}: day ${g.day}, ${g.stations.map.size} stations, ${calls.length} calls`);
  }
  const run = stats(calls), tickStats = stats(ticks.subarray(0, tickCount)), cpuRun = measureCPU ? stats(cpuCalls) : undefined;
  // Settle month-end work before measuring identical, unchanged calls.
  g.lines.flushCatchment(); original(); checkFull(g);
  const unchanged: number[] = [];
  for (let i = 0; i < 100; i++) { const t = performance.now(); original(); unchanged.push(performance.now() - t); }
  const saved = JSON.stringify(serialize(g)), loadTimes: number[] = [];
  const load = () => {
    const data = JSON.parse(saved), start = performance.now(), loaded = deserialize(data);
    loadTimes.push(performance.now() - start);
    return loaded;
  };
  // Clean saves restore derived shares eagerly. Keep the independent cold-work/tick-budget fixture explicit.
  const coldLoad = () => {
    const loaded = load(), S = loaded.stations as any;
    S.sharesReady = false;
    for (const key of ['shareSt', 'shareB', 'walkSt', 'covered', 'coveredPop', 'shareMembers', 'served']) S[key] = new Map();
    S.pendingPop.clear();
    S.catchInputs = { roads: -1, lots: -1, terrain: -1, stations: -1, served: -1 };
    return loaded;
  };
  const loaded = coldLoad();
  writeFileSync(`catchperf-load-${size}-${seed}.json`, saved);
  const loadSlices: number[] = [];
  const loadRecompute = loaded.stations.recomputeCatchment.bind(loaded.stations);
  loaded.stations.recomputeCatchment = (slice = false) => {
    const start = performance.now(), complete = loadRecompute(slice); loadSlices.push(performance.now() - start); return complete;
  };
  loaded.lines.catchmentDirty = true;
  loaded.lines.flushCatchment();
  if (loaded.stations.map.size >= 16 && loaded.tick > 0 && loaded.tick % loaded.ticksPerDay !== loaded.ticksPerDay - 1)
    assert.ok(loaded.stations.catchmentWorkPending && loaded.lines.catchmentDirty, 'explicitly cold shares retain sliced preparation');
  let loadTicks = 0;
  while (loaded.lines.catchmentDirty) { assert.ok(loadTicks++ < loaded.ticksPerDay); loaded.stepTick(); }
  const afterLoad = loadSlices[0];
  checkFull(loaded);
  if (!baseline && !timingOnly) {
    const synchronous = load(); synchronous.stations.recomputeCatchment(); synchronous.demand.recomputeShares(); synchronous.lines.catchmentDirty = false;
    for (let tick = 0; tick < loadTicks; tick++) synchronous.stepTick();
    sameSave(loaded, synchronous, 'sliced load and synchronous load continue identically');
    // A load on the final tick of a day must finish before that day's passenger generation.
    const late = coldLoad(), lateSync = load();
    late.dayFrac = lateSync.dayFrac = (late.ticksPerDay - 1) / late.ticksPerDay;
    late.lines.catchmentDirty = true; lateSync.stations.recomputeCatchment(); lateSync.demand.recomputeShares(); lateSync.lines.catchmentDirty = false;
    late.stepTick(); lateSync.stepTick();
    try { sameSave(late, lateSync, 'late-day load preserves passenger generation'); }
    catch (error) { writeFileSync(`catchperf-load-failure-${size}-${seed}.json`, saved); throw error; }
  }
  if (oracle) {
    oracle.lines.flushCatchment();
    sameSave(g, oracle, 'unchanged-code oracle', oracleModule!.serialize);
  }
  const report = { seed, size, years, node: process.version, mode: baseline ? 'before' : timingOnly ? 'after-timing' : 'after', calls: run, ticks: tickStats, unchanged: stats(unchanged), afterLoad,
    loadSlices: stats(loadSlices), loadTicks, loadTimes: stats(loadTimes), cpuCalls: cpuRun,
    checks, stations: g.stations.map.size, buildings: g.world.buildings.size, delivered: g.vehicles.all().reduce((a, v) => a + v.delivered, 0),
    stateHash: createHash('sha256').update(JSON.stringify(serialize(g))).digest('hex'), oracleEqual: oracle ? true : undefined,
    slowCalls: slowCalls.sort((a, b) => b.ms - a.ms).slice(0, 8),
    worst: worst.sort((a, b) => b.ms - a.ms).slice(0, 8), elapsedSeconds: (performance.now() - start) / 1000, checkpoints };
  if (!baseline && process.argv.includes('--compare-before')) {
    const before = JSON.parse(readFileSync(`catchperf-before-${size}-${seed}.json`, 'utf8'));
    assert.equal(years, before.years, 'baseline duration');
    assert.deepEqual(checkpoints, before.checkpoints, 'all monthly catchment/population snapshots match unchanged code');
    assert.equal(report.delivered, before.delivered, 'delivered passengers match unchanged code');
  }
  writeFileSync(`catchperf-${report.mode}-${size}-${seed}.json`, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ ...report, checkpoints: `${checkpoints.length} hashes` }, null, 2));
  if (!baseline && process.argv.includes('--assert-targets') && seed === 23 && size === 768 && years >= 5) {
    assert.ok(run.p99 < 4, `p99 ${run.p99.toFixed(3)} ms must be < 4 ms`);
    assert.ok(run.max < 20, `max ${run.max.toFixed(3)} ms must be < 20 ms`);
    assert.ok(report.unchanged.max < .5, `unchanged max ${report.unchanged.max.toFixed(3)} ms must be < .5 ms`);
  }
}
