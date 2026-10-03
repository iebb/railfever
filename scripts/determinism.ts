// Headless multiplayer evidence; never patches the simulation or its clocks/RNGs.
// node_modules/.bin/esbuild scripts/determinism.ts --bundle --platform=node --format=esm \
//   --outfile=$S/determinism.mjs
// node $S/determinism.mjs [--seed=7] [--days=360] [--every=30] [--size=384] [--ais=2]
// Exit 1: identical-step replicas differ. Exit 2: invalid options/fixture/error.
// All chunk sizes should MATCH; --strict-chunking makes any chunking divergence fail the run.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Game, TICK, TICKS_PER_DAY, type NewGameOptions } from '../src/game/game';
import { World } from '../src/game/world';
import { DAY_SECONDS } from '../src/game/constants';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { RoadVehicle, roadDepotReaches } from '../src/game/roadvehicle';
import { addBusStop, busStopSites, depotBehind, placeAndConnect, roadDepotNear } from './lib';

function numberOption(name: string, fallback: number, min = 1): number {
  const arg = process.argv.slice(2).find((s) => s.startsWith(`--${name}=`));
  const value = arg === undefined ? fallback : Number(arg.slice(name.length + 3));
  if (!Number.isInteger(value) || value < min) throw new Error(`--${name} must be an integer >= ${min}`);
  return value;
}

type Fixture = { railLine: number; busLine: number; train: number; transcript: unknown[] };

/** Identical deterministic site search + construction sequence, following smoke.ts.
 * Helpers exercise planRail/commitRail, planEdge/commitProposal and depot plan/commit.
 * This is a test fixture, not an implementation of the proposed network command API.
 */
function buildFixture(g: Game): Fixture {
  const transcript: unknown[] = [];
  g.economy.money = 80_000_000; // Explicit equal test funding, as in smoke.ts.
  const pair = placeAndConnect(g, 60, 150, 0, new Set(), 1, () => {});
  if (!pair?.con.ok) throw new Error('Fixture: no connected rail station pair (try the default seed/size)');
  transcript.push({ kind: 'rail-link', stations: [pair.A.id, pair.B.id], towns: [pair.TA.id, pair.TB.id],
    sites: [pair.A, pair.B].map((s) => ({ x: s.x, z: s.z, angle: s.rail!.angle })), length: pair.con.len });
  const depot = depotBehind(g, pair.A, pair.B, 0);
  if (depot < 0) throw new Error('Fixture: no rail depot');
  transcript.push({ kind: 'rail-depot', id: depot });

  const rail = g.lines.create('rail', 0);
  rail.stops = [pair.A.id, pair.B.id];
  g.lines.rebuild();
  transcript.push({ kind: 'create-line', mode: 'rail', id: rail.id, stops: [...rail.stops] });
  const models = ['diesel_b', 'coach_ic', 'coach_ic'];
  const cars = models.map((id) => {
    const m = MODEL_BY_ID.get(id);
    if (!m) throw new Error(`Fixture: unknown model ${id}`);
    return m;
  });
  const train = g.vehicles.buyTrain(depot, cars, null);
  if (!(train instanceof Train)) throw new Error(`Fixture: buy train: ${train}`);
  train.setLine(rail.id);
  transcript.push({ kind: 'buy-train', depot, models, id: train.id }, { kind: 'set-line', vehicle: train.id, line: rail.id });

  // A second working mode, including road traffic, passenger queues and a road depot.
  // Fail visibly if the fixture cannot be made; do not silently skip its coverage.
  let busLine = -1;
  for (const town of [...g.towns.list].sort((a, b) => b.pop - a.pop || a.id - b.id)) {
    const sites = busStopSites(g, town, 0, 12, 30);
    if (sites.length !== 2) continue;
    const a = addBusStop(g, sites[0][0], sites[0][1], 0);
    const b = addBusStop(g, sites[1][0], sites[1][1], 0);
    if (a < 0 || b < 0 || a === b) throw new Error('Fixture: bus stops failed or joined the same station');
    const dp = roadDepotNear(g, sites[0][0], sites[0][1], 0);
    if (dp < 0) throw new Error('Fixture: no road depot');
    const depotObject = g.depots.get(dp)!;
    if (!roadDepotReaches(g, depotObject, a) || !roadDepotReaches(g, depotObject, b)) {
      throw new Error('Fixture: road depot cannot reach both bus stops');
    }
    const line = g.lines.create('road', 0);
    line.stops = [a, b];
    g.lines.rebuild();
    transcript.push({ kind: 'bus-stops', sites, ids: [a, b] }, { kind: 'road-depot', id: dp },
      { kind: 'create-line', mode: 'road', id: line.id, stops: [...line.stops] });
    for (let i = 0; i < 2; i++) {
      const bus = g.vehicles.buyRoad(dp, MODEL_BY_ID.get('bus_b')!, line.id);
      if (!(bus instanceof RoadVehicle)) throw new Error(`Fixture: buy bus: ${bus}`);
      transcript.push({ kind: 'buy-road', depot: dp, model: 'bus_b', line: line.id, id: bus.id });
    }
    busLine = line.id;
    break;
  }
  if (busLine < 0) throw new Error('Fixture: no bus service site');
  g.flushNetworkChanges();
  g.lines.flushCatchment();
  return { railLine: rail.id, busLine, train: train.id, transcript };
}

// Scalar keys sorted by Unicode code units (not locale); arrays retain their order.
// Map/Set order is deliberately retained because it can affect simulation outcomes.
// Tag non-finite numbers and -0 instead of letting JSON collapse them to null/0.
function canonical(value: unknown): string {
  if (value === undefined) return '["$undefined"]';
  if (typeof value === 'number' && (!Number.isFinite(value) || Object.is(value, -0))) return JSON.stringify(['$number', String(value), Object.is(value, -0)]);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value instanceof Map) return canonical([...value]);
  if (value instanceof Set) return canonical([...value]);
  if (ArrayBuffer.isView(value)) return canonical(Array.from(value as unknown as ArrayLike<number>));
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((key) => JSON.stringify(key) + ':' + canonical(obj[key])).join(',') + '}';
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex');
type Capture = { hash: string; sections: Record<string, string> };

/** Full diagnostic hash, intentionally more expensive than a production daily hash.
 * Save JSON covers terrain, trees, buildings, all entities/economies/RNGs/AI/demand/access/ops.
 * Add versions, routing and reservations omitted by saves. Cosmetic time/news and timing
 * profiles are excluded. JS generator instruction pointers cannot be inspected here.
 */
function capture(g: Game): Capture {
  const data = serialize(g) as Record<string, unknown>;
  delete data.visualTime;
  delete data.news;
  const v = g.vehicles as unknown as { res: Map<number, number> };
  const state = g as unknown as { deferCatchment: boolean };
  data.runtime = { speed: g.speed, paused: g.paused, networkVersion: g.networkVersion,
    netVersion: g.world.net.version, heightsVersion: g.world.heightsVersion, linesVersion: g.lines.version,
    demandVersion: g.demand.version, deferCatchment: state.deferCatchment,
    reservations: [...v.res], crossingClosed: [...g.vehicles.crossingClosed],
    routing: [...g.lines.routing].map(([id, table]) => [id, [...table]]), aiBusy: g.ais.map((a) => [a.companyId, a.busy]) };
  const sections = Object.fromEntries(Object.keys(data).sort().map((key) => [key, canonical(data[key])]));
  return { hash: digest(canonical(sections)), sections };
}

function firstDifference(a: unknown, b: unknown, path = '$'): string | null {
  if (Object.is(a, b)) return null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: different types`;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return `${path}.length: ${a.length} != ${b.length}`;
    for (let i = 0; i < a.length; i++) { const d = firstDifference(a[i], b[i], `${path}[${i}]`); if (d) return d; }
  } else {
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(aa), ...Object.keys(bb)])].sort()) {
      const d = firstDifference(aa[key], bb[key], `${path}.${key}`); if (d) return d;
    }
  }
  return null;
}

function compare(label: string, a: Capture, b: Capture, day: number): boolean {
  if (a.hash === b.hash) return true;
  console.log(`DIVERGENCE ${label}: first observed at nominal day ${day}; hashes ${a.hash} / ${b.hash}`);
  const keys = Object.keys(a.sections).filter((k) => a.sections[k] !== b.sections[k]);
  console.log(`  changed sections: ${keys.join(', ')}`);
  const priority = ['day', 'dayFrac', 'vehicles', 'rng', 'companies'];
  const details = [...priority.filter((k) => keys.includes(k)), ...keys.filter((k) => !priority.includes(k))];
  for (const key of details.slice(0, 5)) {
    const diff = firstDifference(JSON.parse(a.sections[key]), JSON.parse(b.sections[key]), '$.' + key);
    console.log(`  ${diff?.slice(0, 500)}`);
  }
  return false;
}

type Stream = { name: string; g: Game; fixture: Fixture; dt: number; calls: number; active: boolean };

function advance(s: Stream, seconds: number) {
  // Drive by integer update indices, not game.day or accumulated wall-clock floats.
  // All checkpoints/commands land at the same total supplied seconds in every stream.
  const end = Math.round(seconds / s.dt);
  if (Math.abs(end * s.dt - seconds) > 1e-8) throw new Error('Checkpoint does not align with dt');
  while (s.calls < end) { s.g.update(s.dt); s.calls++; }
  assert.equal(s.g.tick, Math.round(seconds / TICK), `${s.name}: exact committed tick at checkpoint`);
  assert.equal(s.g.dayFrac, 0, `${s.name}: integer day boundary`);
}

/** Scheduler and legacy-save boundaries, using an empty headless world without patching methods. */
function checkScheduler() {
  const empty = () => new Game({ size: 64, seed: 1, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 }, new World(64));
  const g = empty();
  g.update(1 / 60); g.update(1 / 60);
  assert.equal(g.tick, 0, 'partial frames do not enter simulation');
  assert(Math.abs(g.alpha - 2 / 3) < 1e-12, 'render alpha retains partial wall time');
  g.update(1 / 60);
  assert.equal(g.tick, 1, 'three 60 fps frames commit one tick');
  assert.equal(g.alpha, 0);
  for (const dt of [0, -1, NaN, Infinity]) g.update(dt);
  assert.equal(g.tick, 1, 'invalid wall time does not tick');
  g.update(TICK / 2);
  g.paused = true; g.update(10);
  assert.equal(g.tick, 1, 'pause stops ticks');
  assert.equal(g.alpha, 0, 'pause clears the wall-time remainder');
  g.paused = false; g.update(TICK / 2);
  assert.equal(g.tick, 1, 'resume starts with a fresh remainder');
  g.stepTick();
  assert.equal(g.tick, 2, 'headless stepTick always commits one tick');
  for (const speed of [1, 2, 4, 8]) {
    const paced = empty(); paced.speed = speed;
    for (let frame = 0; frame < 60; frame++) paced.update(1 / 60);
    assert.equal(paced.tick, 20 * speed, `one wall second at ${speed}x`);
    const tick = paced.tick;
    paced.update(1000);
    assert.equal(paced.tick - tick, 8 * speed, `stalled frame is bounded at ${speed}x`);
    assert(paced.alpha >= 0 && paced.alpha < 1);
  }
  const month = empty(); month.tick = 30 * TICKS_PER_DAY - 1;
  month.stepTick();
  assert.equal(month.day, 30); assert.equal(month.dayFrac, 0);
  assert(month.lines.catchmentDirty, 'monthly catchment waits for the next tick');
  month.update(TICK / 2);
  assert(month.lines.catchmentDirty, 'a render-only frame does not flush monthly catchment');
  month.update(TICK / 2);
  assert(!month.lines.catchmentDirty, 'next committed tick flushes monthly catchment');
  const saved = empty(); saved.tick = 1234567; saved.update(TICK / 2);
  const data = serialize(saved), loaded = deserialize(JSON.parse(JSON.stringify(data)));
  assert.equal(loaded.tick, saved.tick, 'save restores the exact integer tick');
  assert.equal(JSON.stringify(serialize(loaded)), JSON.stringify(data), 'tick save round trip is exact');
  assert.equal(loaded.alpha, 0, 'wall-time remainder stays outside the saved simulation');
  const legacy = { ...data, day: 5, dayFrac: 0.425 }; delete legacy.tick;
  assert.equal(deserialize(legacy).tick, 217, 'legacy fractional days derive ticks');
  assert.equal(deserialize({ ...legacy, dayFrac: 0.999999999999 }).tick, 240, 'legacy floating day boundary rounds to its tick');
  const date = empty(); date.day = 29; date.dayFrac = 0.999999999999;
  assert.equal(date.tick, 1200, 'writable calendar tolerates accumulated physics-time roundoff');
  date.day = 359; date.dayFrac = 0.99;
  assert.equal(date.tick, 14399, 'explicit date jumps retain the next daily boundary');
  for (const tick of [35, 45, 60, 113, 158]) {
    const timer = empty();
    for (let i = 0; i < tick; i++) timer.stepTick();
    const data = JSON.stringify(serialize(timer));
    assert.equal(JSON.stringify(serialize(deserialize(JSON.parse(data)))), data, `ambient countdown round trip at tick ${tick}`);
  }
  console.log('SCHEDULER: PASS fractional frames, pause/resume, 1x/2x/4x/8x, bounded stalls, monthly catchment, exact/legacy tick saves');
}

type ScheduledCommand = { day: number; kind: 'rename-lines' | 'repay-loan' | 'change-line-color' };
const commands: ScheduledCommand[] = [
  { day: 60, kind: 'rename-lines' }, { day: 120, kind: 'repay-loan' }, { day: 180, kind: 'change-line-color' },
];

function apply(s: Stream, c: ScheduledCommand) {
  const { g, fixture } = s;
  if (c.kind === 'rename-lines') {
    g.lines.rename(fixture.railLine, 'Probe Intercity');
    g.lines.rename(fixture.busLine, 'Probe Town Bus');
  } else if (c.kind === 'repay-loan') {
    if (!g.economy.repay()) throw new Error('Scripted loan repayment rejected');
  } else {
    g.lines.setColor(fixture.railLine, '#123abc');
    g.lines.rebuild(); // The UI performs this after a colour change too.
  }
}

function summary(s: Stream) {
  const g = s.g;
  return { stream: s.name, suppliedSeconds: s.calls * s.dt, updates: s.calls,
    tick: g.tick, day: g.day, dayFrac: g.dayFrac, companies: g.activeCompanies.length,
    edges: g.world.net.edges.size, stations: g.stations.map.size, lines: g.lines.map.size, vehicles: g.vehicles.map.size,
    delivered: g.vehicles.all().filter((v) => v.owner === 0).reduce((n, v) => n + v.delivered, 0),
    ai: g.ais.map((a) => ({ company: a.companyId, phase: a.state.phase, projects: a.state.projects, vehicles: a.stats.vehicles })) };
}

function main() {
  checkScheduler();
  const seed = numberOption('seed', 7, 0), days = numberOption('days', 360), every = numberOption('every', 30);
  const size = numberOption('size', 384, 192), ais = numberOption('ais', 2, 0);
  if (ais > 7) throw new Error('--ais must be <= 7');
  const options: NewGameOptions = { size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: ais };
  console.log(`Node ${process.version}; options ${JSON.stringify(options)}; ${days} days; sample every ${every} days; AI enabled; speed 1`);
  const specs: [string, number][] = [['fixed A', 0.05], ['fixed B', 0.05], ['chunk 0.1', 0.1], ['frame 1/60', 1 / 60]];
  const streams: Stream[] = specs.map(([name, dt]) => {
    const g = Game.create({ ...options }); // Each world is fresh, with its own options object.
    const fixture = buildFixture(g);
    console.log(`  ${name}: fixture ${digest(canonical(fixture.transcript)).slice(0, 16)}; rail ${fixture.railLine}, bus ${fixture.busLine}, train ${fixture.train}`);
    return { name, dt, g, fixture, calls: 0, active: true };
  });
  const initial = capture(streams[0].g);
  for (const s of streams.slice(1)) {
    if (canonical(s.fixture.transcript) !== canonical(streams[0].fixture.transcript) || !compare(s.name, initial, capture(s.g), 0)) {
      throw new Error(`Initial fixture mismatch: ${s.name}`);
    }
  }
  const rawSave = JSON.stringify(serialize(streams[0].g));
  console.log(`  initial save: ${Buffer.byteLength(rawSave)} JSON bytes; ${gzipSync(rawSave).byteLength} gzip bytes (Node gzip, not a network benchmark)`);
  console.log(`  initial state hash ${initial.hash}`);
  const checkpoints = new Set<number>([1, days]);
  for (let day = every; day <= days; day += every) checkpoints.add(day);
  for (const c of commands) if (c.day <= days) checkpoints.add(c.day);
  let fixedFailed = false, chunkFailed = false, lastDay = 0;
  for (const day of [...checkpoints].sort((a, b) => a - b)) {
    for (const s of streams) if (s.active) advance(s, day * DAY_SECONDS);
    const command = commands.find((c) => c.day === day);
    if (command) { for (const s of streams) if (s.active) apply(s, command); console.log(`  command at nominal day ${day}: ${command.kind}`); }
    const ref = capture(streams[0].g);
    for (let i = 1; i < streams.length; i++) {
      const s = streams[i];
      if (!s.active) continue;
      if (!compare(`fixed A vs ${s.name} (previous checkpoint ${lastDay})`, ref, capture(s.g), day)) {
        if (i === 1) fixedFailed = true; else chunkFailed = true;
        s.active = false; // Retain its first divergence state; keep the independent comparisons running.
      }
    }
    console.log(`  day ${day}, tick ${streams[0].g.tick}: A ${ref.hash.slice(0, 16)}; fixed ${fixedFailed ? 'DIVERGED' : 'MATCH'}; chunking ${chunkFailed ? 'DIVERGED' : 'MATCH'}`);
    lastDay = day;
    if (fixedFailed) break;
  }
  for (const s of streams) console.log('  final ' + JSON.stringify(summary(s)));
  console.log(`IDENTICAL FIXED STEPS: ${fixedFailed ? 'FAIL' : `PASS through ${days} nominal days`}`);
  for (const s of streams.slice(2)) console.log(`CHUNKING ${s.dt}: ${s.active ? `MATCH through ${days} days (${s.g.tick} ticks)` : 'DIVERGED (first observation above)'}`);
  console.log('Scope: one process/JS engine, one fixture; equal hashes do not prove cross-browser or save/resume determinism. No time or RNG monkeypatches.');
  process.exitCode = fixedFailed || (chunkFailed && process.argv.includes('--strict-chunking')) ? 1 : 0;
}

try { main(); } catch (e) { console.error('PROBE ERROR:', (e as Error).stack); process.exitCode = 2; }
