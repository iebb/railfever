// Native tram work must survive saves at its survey, construction and depot-search boundaries.
// Bundle as tram-continuation.mjs and run from a scratch directory. No saved-world fixture is required.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import type { TramProject } from '../src/game/ai-tram';

type Probe = { startTram(town?: number): boolean; project: { kind: string } | null; tram: { status: string; reason: string; record(): TramProject | null } | null };
const probe = (g: Game) => g.ais[0] as unknown as Probe;
const saved = (g: Game) => JSON.stringify(serialize(g));
function same(a: Game, b: Game, label: string) {
  const actual = saved(a), expected = saved(b);
  if (actual === expected) return;
  let i = 0; while (i < Math.min(actual.length, expected.length) && actual[i] === expected[i]) i++;
  throw new Error(`${label}: difference at ${i}: ${actual.slice(Math.max(0, i - 70), i + 160)} / ${expected.slice(Math.max(0, i - 70), i + 160)}`);
}
function fixture(warm = false, start = true) {
  const g = Game.create({ size: 384, seed: 11, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1965, aiCompanies: 1 });
  g.company(1).economy.money = 50_000_000;
  if (warm) for (const b of [...g.world.buildings.values()].reverse()) g.world.touchBuilding(b);
  if (start) assert(probe(g).startTram(), 'native AI starts a tram project');
  return g;
}

// Every replica starts from the *live source*, then advances alongside that source through completion.
// Mid-day saves therefore cover both suspended native tasks and the controller's fixed work allowance.
const source = fixture(), replicas: { g: Game; stage: string }[] = [], stages = new Set<string>();
let partial: string | undefined, maxUnitMs = 0;
for (let ticks = 0; probe(source).project && ticks < 6000; ticks++) {
  const record = probe(source).tram?.record(), task = record?.continuation?.task;
  const stage = task?.stage;
  const checkpoint = stage && stage + (stage === 'ends' && (task!.survey?.side ?? 0) > 0 ? ':second-end'
    : stage === 'stops' && task!.at > 0 ? ':partial'
    : stage === 'vehicles' && task!.at > 1 ? ':partial'
    : stage === 'depot-site' && task!.depot && (task!.depot.k > 2 || task!.depot.side > 0 || task!.depot.end > 0) ? ':later-search' : '');
  if (checkpoint && !stages.has(checkpoint)) {
    const g = deserialize(JSON.parse(saved(source)));
    same(source, g, checkpoint + ' restores without advancing or changing state');
    replicas.push({ g, stage: checkpoint }); stages.add(checkpoint);
    for (const r of replicas) same(source, r.g, r.stage + ' source continuation through ' + checkpoint);
  }
  if (!partial && record?.stations.length && record.depot < 0) partial = saved(source);
  const start = performance.now(); source.stepTick(); maxUnitMs = Math.max(maxUnitMs, performance.now() - start);
  for (const r of replicas) r.g.stepTick();
}
assert.equal(probe(source).project, null, 'native tram project finishes within its work budget');
const line = [...source.lines.map.values()].find(l => l.owner === 1 && l.kind === 'tram');
assert(line && line.vehicles.length >= 2, 'native project opens a staffed tram line');
for (const stage of ['axis', 'ends', 'path', 'points', 'sites', 'score', 'quote', 'stops', 'stop-build', 'depot-site', 'depot-build', 'line', 'vehicles'])
  assert(stages.has(stage), 'source reached native stage ' + stage);
for (const checkpoint of ['ends:second-end', 'stops:partial', 'vehicles:partial', 'depot-site:later-search'])
  assert(stages.has(checkpoint), 'source saved native progress within ' + checkpoint);
for (const r of replicas) same(source, r.g, r.stage + ' source replay through completion');
source.aiEnabled = false; for (const r of replicas) r.g.aiEnabled = false;
for (let tick = 0; tick < 80; tick++) { source.stepTick(); for (const r of replicas) r.g.stepTick(); }
for (const r of replicas) same(source, r.g, r.stage + ' source replay after opening');
assert(partial, 'source saved partially built tram assets');

// Native growth reindexes buildings. A cache's insertion history must not change a survey after a cold load.
const warm = fixture(true, false), warmLoaded = deserialize(JSON.parse(saved(warm)));
assert(probe(warm).startTram() && probe(warmLoaded).startTram(), 'live and clean-loaded worlds independently start their next native project');
same(warm, warmLoaded, 'independent native starts agree despite different spatial-index histories');
for (let tick = 0; probe(warm).project && tick < 6000; tick++) {
  warm.stepTick(); warmLoaded.stepTick();
  if (tick % 40 === 0) same(warm, warmLoaded, 'warm/cold native survey continuation');
}
assert.equal(probe(warm).project, null);
same(warm, warmLoaded, 'warm spatial-history source/load replay through tram opening');

// Old tram records have no continuation marker. Retain their native cleanup migration and its owed population work.
const migration = deserialize(JSON.parse(partial));
const firstPartial = probe(migration).tram!.record()!.stations[0], original = migration.stations.get(firstPartial)!;
const stop = original.stops[0];
let survivor = -1;
const candidates: { x: number; z: number; d: number }[] = [];
for (const road of migration.world.net.edgesNear(stop.x - 12, stop.z - 12, stop.x + 12, stop.z + 12)) {
  if (road.kind !== 'road' || road.depot >= 0) continue;
  for (let s = .8; s < road.len; s += .8) {
    const q = { x: 0, y: 0, z: 0 }; migration.world.net.pointAt(road, s, q);
    const d = Math.hypot(q.x - stop.x, q.z - stop.z);
    if (d >= 3 && d <= 12) candidates.push({ ...q, d });
  }
}
for (const q of candidates.sort((a, b) => a.d - b.d)) {
  const plan = migration.stations.planBusStop(q.x, q.z, 0);
  if (!plan.ok || plan.join) continue;
  const id = migration.stations.nextId;
  if (!migration.stations.commitBusStop(q.x, q.z, 0)) {
    if (!migration.stations.link(firstPartial, id)) { survivor = id; break; }
    migration.stations.removeStation(id);
  }
}
assert(survivor >= 0, 'native player builds a neighbouring stop while the tram project is partial');
migration.flushNetworkChanges(); migration.stations.recomputeCatchment(); migration.demand.recomputeShares(); migration.lines.catchmentDirty = false;
const legacyData = serialize(migration), legacyRecord = legacyData.ais[0].state.tram;
const legacyStations = [...legacyRecord.stations];
delete legacyRecord.continuation;
const legacy = deserialize(legacyData);
for (const id of legacyStations) assert(!legacy.stations.get(id), 'legacy partial tram stop is cleaned up');
assert(legacy.stations.get(survivor), 'legacy cleanup keeps the linked player stop');
assert.deepEqual(legacyData.ais[0].state.tram.stations, legacyStations, 'legacy loading never destroys the input cleanup record');
assert(legacy.stations.catchmentPopulationPending, 'load-time cleanup owes a population refresh even for a clean saved world');
legacy.stations.recomputeCatchment();
const full = (legacy.stations as any).debugFullCatchment();
for (const s of legacy.stations.map.values()) assert.equal(s.catchPop, full.stations.get(s.id)?.pop ?? 0, 'legacy cleanup publishes exact surviving population');

// Normal world edits can invalidate the next construction unit. The live and restored jobs must fail alike.
const failure = fixture();
for (let ticks = 0; probe(failure).tram?.record()?.continuation?.task?.stage !== 'quote' && ticks < 6000; ticks++) failure.stepTick();
const pending = probe(failure).tram?.record();
assert.equal(pending?.continuation?.task?.stage, 'quote');
const edge = pending!.continuation!.task!.fresh[0];
assert.notEqual(edge, undefined);
failure.world.net.removeEdge(edge); failure.onNetworkChanged();
const resumedFailure = deserialize(JSON.parse(saved(failure)));
same(failure, resumedFailure, 'invalidated construction restores its pending native decision');
for (let tick = 0; probe(failure).project && tick < 80; tick++) { failure.stepTick(); resumedFailure.stepTick(); }
assert.equal(probe(failure).project, null, 'native invalidated project finishes its failure cleanup');
same(failure, resumedFailure, 'native failure and cleanup replay exactly');
assert(![...failure.lines.map.values()].some(l => l.owner === 1 && l.kind === 'tram'));
// An inactive planner is deliberately absent from saves. A new native start must publish its own
// caption before the first work unit, rather than retaining a previous failed project's caption.
const previousStatus = probe(failure).tram!.status, previousReason = probe(failure).tram!.reason;
assert(previousStatus.startsWith('failed: ') && previousReason.length > 0,
  'warm planner really retains the preceding native construction failure');
const previousLog = [...failure.ais[0].log], retry = deserialize(JSON.parse(saved(failure)));
assert.equal(probe(retry).tram, null, 'cold controller has no inactive planner or inherited failure caption');
assert(probe(failure).startTram() && probe(retry).startTram(),
  'warm failed and independently cold controllers both start the next eligible native tram project');
const restarted = probe(failure).tram!.record()!, restoredStart = probe(retry).tram!.record()!;
assert.equal(restarted.continuation!.task!.stage, 'axis', 'new start is captured before its first work unit');
assert.equal(restarted.continuation!.status, `planning trams in ${failure.towns.list[restarted.town].name}`);
assert.equal(restarted.continuation!.reason, '', 'new project clears only its current reason');
assert.deepEqual(failure.ais[0].log.slice(0, previousLog.length), previousLog,
  'new planning caption preserves the existing native failure log');
assert.deepEqual(restarted, restoredStart, 'new current native record is independent of prior inactive planner history');
same(failure, retry, 'native restart before first work has exact full-save equality');
let restartTicks = 0;
while (probe(failure).project && restartTicks++ < 6000) {
  failure.stepTick(); retry.stepTick();
  same(failure, retry, 'native restart source/cold equality at tick ' + restartTicks);
}
assert.equal(probe(failure).project, null, 'native restarted project completes or cleans up within its existing work budget');
for (let tick = 0; tick < 80; tick++) {
  failure.stepTick(); retry.stepTick();
  same(failure, retry, 'native post-restart source/cold tick ' + tick);
}

console.log(`PASS ${stages.size} live-source tram checkpoints, mid-day saves, independent future projects after warm/cold history, legacy cleanup/population work, native track failure/restart before first work and exact post-opening replay; maximum source tick ${maxUnitMs.toFixed(2)}ms`);
