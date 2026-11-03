// A paid mainline opening keeps its exact native next unit across every fixed-tick save.
// The original generator is compared separately from a frozen pre-port build; this fixture
// exercises the public lifecycle, not a second implementation of the planner.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { planEdge, commitProposal } from '../src/game/construction';
import { checkReservations, checkNaN } from './lib';
import { newRouteCursor, stepRouteCursor, saveRouteCursor, loadRouteCursor, captureCorridorSnapshot } from '../src/game/routing';
import { createCorridorKernel, corridorFrontierCodec } from '../src/game/planning-corridor';
import { corridorWorkerSource } from '../src/game/corridor-worker';
import { savePlannerTask, loadPlannerTask } from '../src/game/ai-task-data';
import { retainPlannerInput, savePlannerInput, loadPlannerInput, withPlannerInputCapture, withPlannerInputRestore } from '../src/game/ai-task-inputs';
import { flatGame, free, build, railOpts } from './stationlib';

const saved = (g: Game) => JSON.stringify(serialize(g));
const cold = (g: Game) => deserialize(JSON.parse(saved(g)));
let checks = 0;
const ledgerOnly = process.argv.includes('--ledger-only');
function check(ok: unknown, label: string): asserts ok { assert(ok, label); checks++; }

// Packed saves preserve the actual discovery and heap order, not a reconstructed search.
// Public record() copies and decoded input arrays cannot become an authoritative cache.
if (!ledgerOnly) {
  const g = Game.create({ size: 256, seed: 23, towns: 0, hilliness: 'hilly', water: 'low', startYear: 1990 });
  const before = saved(g); let slices = 0, workerSnapshot: ReturnType<typeof captureCorridorSnapshot> | null = null;
  for (const kind of ['road', 'rail'] as const) for (const parallel of [0, 3]) {
    const snapshot = captureCorridorSnapshot(g, { x: 25, z: 25, tx: 1, tz: 0 }, { x: 225, z: 210, tx: 1, tz: 0 },
      { kind, owner: 0, parallel, cell: 5, maxExpand: 4000, minR: kind === 'rail' ? 14 : 5 });
    workerSnapshot = snapshot;
    const warm = createCorridorKernel(snapshot);
    while (warm.state === 'running') {
      const plain = warm.record(), packed = warm.packedRecord();
      check(warm.packedRecord().packed === packed.packed, 'unchanged private frontier bytes are reused');
      const input = { ...packed, packed: packed.packed.slice() }, twin = createCorridorKernel(snapshot, input);
      check(JSON.stringify(twin.record()) === JSON.stringify(plain), 'packed native frontier restores every discovered value and heap entry');
      // Both the ordinary public record and the input supplied to restore are disposable.
      const expected = JSON.stringify(plain);
      if (plain.cells.length) plain.cells[0] = -1;
      input.packed.fill(0);
      check(JSON.stringify(twin.record()) === expected && warm.packedRecord().packed === packed.packed,
        'mutating detached public records or restore inputs leaves native state and private bytes unchanged');
      const a = warm.step(31), b = twin.step(31);
      check(a === b && JSON.stringify(warm.record()) === JSON.stringify(twin.record()), 'packed cold continuation has the exact next native slice');
      check(warm.packedRecord().packed !== packed.packed, 'every native search step invalidates the private packed cache');
      const legacy = createCorridorKernel(snapshot, JSON.parse(JSON.stringify(warm.record())));
      check(JSON.stringify(legacy.record()) === JSON.stringify(warm.record()), 'plain sparse continuation remains readable');
      check(++slices < 1000, 'native frontier corpus remains bounded');
    }
    const bytes = warm.packedRecord().packed, state = warm.record(); warm.restore(state);
    check(warm.packedRecord().packed !== bytes && JSON.stringify(warm.record()) === JSON.stringify(state),
      'restoring the native frontier also invalidates private packed bytes without changing its values');
  }
  check(saved(g) === before, 'packing, loading and advancing pure search frontiers do not mutate the game');
  let reply: any = null;
  const worker = { onmessage: null as unknown as (event: { data: unknown }) => void, postMessage: (value: unknown) => { reply = value; } };
  new Function('self', corridorWorkerSource())(worker);
  const { h, lock, ...descriptor } = workerSnapshot!;
  worker.onmessage({ data: { kind: 'terrain', terrainId: descriptor.terrainId, h, lock } });
  worker.onmessage({ data: { kind: 'run', id: 1, snapshot: descriptor, budget: 31 } });
  check(!reply.error && JSON.stringify(reply.result) === JSON.stringify(createCorridorKernel(workerSnapshot!).run(31)),
    'self-contained inline worker executes the same complete native search and slices');
  console.log(`packed frontiers: ${slices} exact native slices, road/rail and parallel controls`);
}

if (!ledgerOnly) {
  const codec = corridorFrontierCodec(), height = new Float32Array(9), cost = new Float32Array(288), parent = new Int32Array(288).fill(-1);
  height[1] = -0; height[2] = 2 ** -149; cost[7] = -0; cost[8] = 1 / 3;
  const values = [-0, Math.PI, 2 ** -1000, Infinity, -Infinity, NaN];
  const packed = codec.pack({ dimensions: [4, 3, 4], cells: [1, 2], info: new Uint8Array(9), height,
    states: [7, 8], cost, parent, closed: new Uint8Array(288), heap: { f: values, v: values.map((_, i) => i) },
    parallel: [2], parallelValues: new Uint8Array(36) });
  const state = { version: 1 as const, packed, expanded: 0, state: 'running' as const, path: null }, decoded = codec.unpack(state);
  check(Object.is(decoded.cells[2], -0) && decoded.cells[5] === 2 ** -149 && Object.is(decoded.states[1], -0)
    && decoded.states[5] === cost[8] && decoded.heap.f.every((x, i) => Object.is(x, values[i])),
    'explicit little-endian format preserves Float32 costs, Float64 priorities, IEEE values and negative zero');
  const mutations: ((bytes: Uint8Array) => void)[] = [
    bytes => new DataView(bytes.buffer).setUint16(4, 2, true),
    bytes => new DataView(bytes.buffer).setUint16(6, 0, true),
    bytes => new DataView(bytes.buffer).setUint32(32, 0xffffffff, true),
    bytes => new DataView(bytes.buffer).setFloat64(16, NaN, true),
    bytes => new DataView(bytes.buffer).setUint32(48, 9, true),
  ];
  for (const mutate of mutations) {
    const bytes = packed.slice(); mutate(bytes); let rejected = false;
    try { codec.unpack({ ...state, packed: bytes }); } catch { rejected = true; }
    check(rejected, 'invalid packed version, endian, count or bounds reject before native restore');
  }
}

// A paused sliced search owns the terrain and locks captured at its original unit. Both
// branches receive the same genuine road edit afterwards; loading must not restart from
// that newer world or discard already-expanded frontier cells.
if (!ledgerOnly) {
  const g = flatGame(256); g.aiEnabled = false;
  let h = cold(g);
  const from = { x: 25, z: 120, tx: 1, tz: 0 }, to = { x: 225, z: 120, tx: 1, tz: 0 };
  const options = { kind: 'rail' as const, owner: 0, tracks: 1, y0: 3, y1: 3, minR: 14,
    lead: 6, rmax: 80, rgood: 12, sliced: true, maxExpand: 20_000 };
  const live = newRouteCursor(from, to, options, 7);
  let twin = newRouteCursor(from, to, options, 7), units = 0, edited = false;
  while (true) {
    const encoded = withPlannerInputCapture(h, () => savePlannerTask(h, new Map(), saveRouteCursor(twin)));
    const detached = JSON.parse(JSON.stringify(encoded));
    twin = withPlannerInputRestore(h, detached.inputs,
      () => loadRouteCursor(h, loadPlannerTask(h, new Map(), detached.value)));
    const roundtrip = withPlannerInputCapture(h, () => savePlannerTask(h, new Map(), saveRouteCursor(twin)));
    check(JSON.stringify(roundtrip) === JSON.stringify(encoded), `route unit ${units}: complete frontier and inputs round-trip`);
    const a = stepRouteCursor(g, live), b = stepRouteCursor(h, twin);
    check(a.done === b.done && JSON.stringify(a.value) === JSON.stringify(b.value), `route unit ${units}: same native next result`);
    check(saved(g) === saved(h), `route unit ${units}: quote leaves native worlds identical`);
    units++;
    if (units === 3) {
      for (const world of [g, h]) check(build(world, free(world, 75, 110), free(world, 75, 130),
        { ...railOpts(0), kind: 'road', type: 'road', tracks: 1 }, 'road added during captured search'), 'native edit commits during saved search');
      edited = true;
    }
    if (a.done) { check(edited && typeof a.value !== 'string', 'captured search completes a real route after the native edit'); break; }
    check(units < 1000, 'captured search remains bounded');
  }
  console.log(`captured route: ${units} exact units with a native mid-search road edit`);
}

// The immutable input table is optional, self-contained and scoped to one save. Equal
// private copies share content; normal mutable world arrays are never retained here.
if (!ledgerOnly) {
  const g = flatGame(64), a = retainPlannerInput(Float32Array.from([NaN, Infinity, -Infinity, -0, 1.25]));
  const b = retainPlannerInput(Float32Array.from(a.value));
  const graph = () => savePlannerTask(g, new Map(), { a, b });
  const inline = graph(), inlineLoaded = loadPlannerTask<any>(g, new Map(), JSON.parse(JSON.stringify(inline)));
  check(inlineLoaded.a === inlineLoaded.b && Object.is(inlineLoaded.a.value[3], -0)
    && Number.isNaN(inlineLoaded.a.value[0]), 'standalone task preserves exact IEEE values and shared immutable aliases');
  const pooled = withPlannerInputCapture(g, graph), detached = JSON.parse(JSON.stringify(pooled));
  const restored = withPlannerInputRestore(g, detached.inputs,
    () => loadPlannerTask<any>(g, new Map(), detached.value));
  const again = withPlannerInputCapture(g, () => savePlannerTask(g, new Map(), restored));
  check(restored.a === restored.b && JSON.stringify(again) === JSON.stringify(pooled), 'pooled graph preserves aliases and immediate byte-identical metadata');
  const nested = withPlannerInputCapture(g, () => {
    const before = savePlannerInput(g, a);
    try { withPlannerInputCapture(g, () => { savePlannerInput(g, retainPlannerInput(new Uint8Array([1]))); throw Error('expected'); }); } catch { /* outer scope survives */ }
    const after = savePlannerInput(g, a);
    return [before, after];
  });
  check(JSON.stringify(nested.value[0]) === JSON.stringify(nested.value[1]) && 'inline' in savePlannerInput(g, a), 'nested capture restores its outer context even after an exception');
  let missingRejected = false;
  try { withPlannerInputRestore(g, undefined, () => loadPlannerInput(g, { ref: 'missing' })); } catch { missingRejected = true; }
  check(missingRejected && 'inline' in savePlannerInput(g, a), 'incomplete input tables reject and leave no process context behind');
}

if (!ledgerOnly) {
  const g = Game.create({ seed: 23, size: 512, towns: 5, hilliness: 'flat', water: 'low', startYear: 1950, aiCompanies: 1 });
  g.aiEnabled = true;
  const ai = g.ais[0] as any;
  check(ai.startProject('rail', [0, 1]), 'native intercity project starts with ordinary finance');
  check(!!serialize(g).ais[0].state.railOpening, 'handoff metadata exists before the first planner unit');
  let h = cold(g), frames = 0;
  const stages = new Set<string>(), checkpoints = new Map<string, ReturnType<typeof serialize>>();
  check(saved(g) === saved(h), 'handoff save is immediately byte-identical');
  while (ai.busy && frames < 2600) {
    g.stepTick(); h.stepTick(); frames++;
    const data = serialize(g), bytes = JSON.stringify(data);
    check(bytes === saved(h), `opening tick ${g.tick}: same full native continuation`);
    const task = ai.railOpening, phase = task?.child?.phase ?? task?.phase ?? 'done'; stages.add(phase);
    if (!checkpoints.has(phase)) checkpoints.set(phase, data);
    h = deserialize(JSON.parse(bytes));
    check(bytes === saved(h), `opening tick ${g.tick}: cold metadata and full save round-trip`);
    check(!checkNaN(g) && !checkReservations(g).length, `opening tick ${g.tick}: physical positions and reservations stay valid`);
    if (g.tick % 400 === 0) console.log(`paid opening: day ${g.day}, phase ${phase}, ${frames} exact cold ticks`);
  }
  check(!ai.busy && !ai.project && !ai.railOpening, 'native opening finishes and clears its task');
  for (const phase of ['pair', 'centralA', 'alternativeRoutes', 'priceMore', 'approvalReady', 'stationCheck',
    'stationAccess', 'chainWork', 'depotSearch', 'accessPair', 'loopCommit', 'fleetBuy'])
    check(stages.has(phase), `every-tick cold replay covers ${phase}`);
  const line = [...g.lines.map.values()].find(l => l.owner === ai.companyId && l.kind === 'rail');
  check(!!line && line.stops.length === 2 && line.vehicles.length === 2, 'native paid railway has both stations and the full two-train fleet');
  check(line.vehicles.every(id => g.vehicles.get(id) instanceof Train), 'opening buys actual native trains');
  check(g.company(ai.companyId).economy.money > 0 && !ai.toJSON().state.failed.length, 'ordinary native funding completes without a hidden failed task');
  check(!serialize(g).ais[0].state.railOpening && !('aiPlannerInputs' in serialize(g)), 'finished opening leaves no active-task snapshot payload');
  const legacy = JSON.parse(JSON.stringify(checkpoints.get('pair')));
  delete legacy.ais[0].state.railOpening; delete legacy.aiPlannerInputs;
  const migrated = deserialize(legacy);
  check(!(migrated.ais[0] as any).busy && !serialize(migrated).ais[0].state.railOpening
    && migrated.company(ai.companyId).economy.money === legacy.companies[ai.companyId].economy.money,
    'historical unbuilt rail frames without continuation data keep their explicit legacy cleanup behavior');
  // Cancel real saved native phases in isolated forks; neither iterator disposal nor its
  // retained paid ledger may keep work alive or affect the original completed railway.
  const original = saved(g);
  for (const phase of ['pair', 'stationAccess', 'chainWork', 'depotSearch']) {
    const input = checkpoints.get(phase)!;
    const a = deserialize(JSON.parse(JSON.stringify(input))), b = deserialize(JSON.parse(JSON.stringify(input)));
    (a.ais[0] as any).cancelJob(); (b.ais[0] as any).cancelJob();
    check(saved(a) === saved(b) && !(a.ais[0] as any).busy && !serialize(a).ais[0].state.railOpening,
      `${phase}: explicit native cancellation is exact and clears the continuation`);
    for (let tick = 0; tick < 64; tick++) { a.stepTick(); b.stepTick(); }
    check(saved(a) === saved(b) && !checkReservations(a).length, `${phase}: cancelled native worlds retain exact safe continuation`);
  }
  check(saved(g) === original, 'isolated cancellation branches leave the original railway untouched');
  for (let tick = 0; tick < 640; tick++) {
    g.stepTick(); h.stepTick();
    check(saved(g) === saved(h), `operating tick ${tick}: exact post-opening replay`);
    check(!checkNaN(g) && !checkReservations(g).length, `operating tick ${tick}: valid native physical state`);
  }
  console.log(`paid opening: ${frames} every-tick cold saves, ${stages.size} phases, 640 exact operating ticks`);
}

// A mainline's repeated native track(fromId) calls must keep older owned track out
// of its rollback ledger after an authorized turnout cuts that track in two.
{
  const g = Game.create({ seed: 23, size: 512, towns: 5, hilliness: 'flat', water: 'low', startYear: 1950, aiCompanies: 1 });
  g.aiEnabled = true;
  const a = g.ais[0] as any, net = g.world.net, oldId = net.nextEdge;
  check(build(g, free(g, 35, 35), free(g, 47, 35), railOpts(a.companyId), 'paid incumbent railway'), 'native incumbent owned railway is built before the project');
  check(a.startProject('rail', [0, 1]), 'native mainline starts beside existing owned infrastructure');
  for (let tick = 0; tick < 2600 && a.busy && a.railOpening?.phase !== 'chainWork'; tick++) g.stepTick();
  const q = a.railOpening?.chainInputs;
  check(a.busy && !!q && oldId < q.e0 && net.edges.has(oldId), 'native chain begins with an older incumbent edge outside its transaction');
  const old = net.edges.get(oldId)!, at = { x: 0, y: 0, z: 0 }; net.pointAt(old, old.len / 2, at);
  const from = { kind: 'edge' as const, edge: oldId, s: old.len / 2, ...at };
  const proposal = [[71, 45], [71, 25], [11, 45], [11, 25]].map(([x, z]) => planEdge(g, from, free(g, x, z), railOpts(a.companyId))).find(p => p.ok);
  check(!!proposal && !commitProposal(g, proposal), 'authorized paid turnout really splits the older track during native construction');
  const halves = [...(a.splitPieces as Set<number>)].filter(id => {
    const e = net.edges.get(id); return e?.owner === a.companyId && (e.a === old.a || e.b === old.b);
  });
  check(halves.length === 2 && halves.every(id => !a.project.edges.includes(id)), 'both actual incumbent halves are excluded before saving');
  const before = serialize(g), h = deserialize(JSON.parse(JSON.stringify(before))), b = h.ais[0] as any;
  const hadLedger = halves.every(id => before.ais[0].state.splitPieces?.includes(id));
  const watch = a.watch.units; let exact = saved(g) === saved(h);
  for (let tick = 0; tick < 20; tick++) { g.stepTick(); h.stepTick(); exact &&= saved(g) === saved(h); }
  const excluded = halves.every(id => !a.project.edges.includes(id) && !b.project.edges.includes(id));
  const continued = a.watch.units > watch;
  a.cancelJob(); b.cancelJob(); exact &&= saved(g) === saved(h);
  const retained = halves.every(id => g.world.net.edges.has(id) && h.world.net.edges.has(id));
  console.log(`native split ledger: saved=${hadLedger}, nextWork=${continued}, excluded=${excluded}, retained=${retained}, exact=${exact}`);
  check(hadLedger && continued && excluded && retained && exact,
    'a cold mainline retains native incumbent ownership through further actual work and cancellation');
  for (let tick = 0; tick < 128; tick++) { g.stepTick(); h.stepTick(); check(saved(g) === saved(h), 'incumbent-preserving cancellation has exact native replay'); }
  check(!checkReservations(g).length, 'incumbent-preserving cancellation keeps valid native reservations');
}

console.log(`ALL CHECKS PASSED (${checks})`);
