// Durable project choice: native scheduling, retained inputs and exact cold continuation before any Project exists.
// Bundle as ai-selection.mjs. Construction continuation is covered separately by the rail/road job regressions.
import { Game } from '../src/game/game';
import { saveNetwork, loadNetwork } from '../src/game/ai-network';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { RoadVehicle } from '../src/game/roadvehicle';
import { Train } from '../src/game/train';
import { selectionDemandSnapshot, selectionDemandInputs } from '../src/game/ai-selection';
import { snapshotTrips } from '../src/game/demand';
import { serialize, deserialize } from '../src/game/save';
import { savePlannerTask, loadPlannerTask } from '../src/game/ai-task-data';
import { pointWalkingCatchment, ownPlannerWalk } from '../src/game/catchment';
import { retainPlannerInput, withPlannerInputCapture, withPlannerInputRestore } from '../src/game/ai-task-inputs';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const bytes = (g: Game) => JSON.stringify(serialize(g));
const require = (value: unknown, message: string) => { if (!value) throw new Error(message); };

/** Native Train construction owns cars by reference; a retained fleet planner must share that same array. */
function retainedTrainCars() {
  const create = () => Game.create({ size: 128, seed: 7, towns: 0, hilliness: 'flat', water: 'low' });
  const g = create(), managed = new Map<number, object>(), model = MODEL_BY_ID.get('steam_a')!;
  const cars = [model], high = new Train(g, 9, cars, -1), low = new Train(g, 3, cars, -1);
  // Deliberately insert the larger ID first: native shared-consist restoration uses the lowest ID, not Map order.
  g.vehicles.map.set(high.id, high); g.vehicles.map.set(low.id, low); g.vehicles.nextId = 10;
  const equal = [...cars], task = { first: cars, second: cars, equal, equalAlias: equal };
  const before = bytes(g), graph = savePlannerTask(g, managed, task);
  require(bytes(g) === before, 'train consist capture leaves the native world unchanged');
  const entries = (graph.records[0] as { entries: [string, any][] }).entries;
  require(entries.find(([key]) => key === 'first')?.[1].native === 'trainCars'
    && entries.find(([key]) => key === 'first')?.[1].id === low.id, 'shared cars bind to the lowest physical train ID');
  const current = loadPlannerTask<typeof task>(g, managed, copy(graph));
  require(current.first === cars && current.second === low.cars && current.first === high.cars
    && current.equal === current.equalAlias && current.equal !== cars && current.equal[0] === model,
    'current native consist aliases bind by identity while equal detached arrays stay detached');

  // Reproduce restoreAIs-before-loadNetwork: separately restored trains initially have distinct equal arrays.
  const cold = create(), coldHigh = new Train(cold, high.id, [...cars], -1), coldLow = new Train(cold, low.id, [...cars], -1);
  cold.vehicles.map.set(coldHigh.id, coldHigh); cold.vehicles.map.set(coldLow.id, coldLow); cold.vehicles.nextId = 10;
  const restored = loadPlannerTask<typeof task>(cold, managed, copy(graph));
  require(restored.first === coldLow.cars && restored.first !== coldHigh.cars, 'task decoding binds the future canonical consist before network restoration');
  loadNetwork(cold, copy(saveNetwork(g)));
  require(restored.first === coldLow.cars && restored.first === coldHigh.cars
    && JSON.stringify(savePlannerTask(cold, managed, restored)) === JSON.stringify(graph),
    'late native shared-consist restoration preserves the already-decoded planner alias');

  low.cars = [...cars];
  const stillShared = savePlannerTask(g, managed, { cars });
  require((stillShared.records[0] as { entries: [string, any][] }).entries[0][1].id === high.id,
    'a consist still owned by another current train remains native after one member changes cars');
  high.cars = [...cars];
  const replaced = loadPlannerTask<any>(g, managed, copy(savePlannerTask(g, managed, { a: cars, b: cars, live: low.cars })));
  require(replaced.a === replaced.b && replaced.a !== low.cars && replaced.a !== high.cars && replaced.live === low.cars,
    'replaced consist arrays retain detached aliases instead of binding by model values');
  const removedCars = high.cars; g.vehicles.map.delete(high.id);
  const removed = loadPlannerTask<any>(g, managed, copy(savePlannerTask(g, managed, { a: removedCars, b: removedCars })));
  require(removed.a === removed.b && removed.a !== low.cars && removed.a[0] === model,
    'removed train consists remain detached even beside a value-equal current consist');

  const live = savePlannerTask(g, managed, { cars: low.cars });
  low.cars.push(MODEL_BY_ID.get('coach_wood')!);
  require(loadPlannerTask<any>(g, managed, copy(live)).cars === low.cars
    && loadPlannerTask<any>(g, managed, copy(live)).cars.length === 2, 'native cars references use the actual current array authority');
  let trainRejected = false;
  try { savePlannerTask(g, managed, { train: low }); } catch { trainRejected = true; }
  require(trainRejected, 'native consist binding does not allow current Train instances into task records');
  g.vehicles.map.delete(low.id);
  let missingRejected = false;
  try { loadPlannerTask(g, managed, copy(live)); } catch { missingRejected = true; }
  require(missingRejected, 'missing physical train references are rejected');
  const road = new RoadVehicle(g, low.id, MODEL_BY_ID.get('bus_a')!, -1);
  (road as any).cars = low.cars; g.vehicles.map.set(road.id, road);
  let wrongKindRejected = false;
  try { loadPlannerTask(g, managed, copy(live)); } catch { wrongKindRejected = true; }
  require(wrongKindRejected, 'a road vehicle cannot satisfy a native train consist reference');
  const roadCars = loadPlannerTask<any>(g, managed, copy(savePlannerTask(g, managed, { cars: low.cars })));
  require(roadCars.cars !== low.cars, 'a road vehicle cars property has no native consist authority');
  console.log('PASS native train consist current/shared/stale aliases and physical restore authority');
}

function retainedData() {
  const g = Game.create({ size: 128, seed: 7, towns: 4, hilliness: 'flat', water: 'low', aiCompanies: 1 });
  const ai = g.ais[0], managed = new Map<number, object>();
  const scope = (project?: object) => ({ company: ai.companyId, config: ai.config, focus: ai.config.focus, project });
  const data = g.demand.tripSnapshotData(), snapshot = selectionDemandSnapshot(data), view = selectionDemandInputs(snapshot);
  require(!Array.isArray(snapshot.od) && !Array.isArray(snapshot.ld), 'native Float32 demand tables retain immutable planner inputs');
  for (const field of ['od', 'ld', 'big', 'attract'] as const)
    require(data[field].every((value, i) => Object.is(value, view[field][i])), 'packed native demand values are lossless');
  for (let r = 0; r < data.regions.length; r++) for (let q = 0; q < data.regions.length; q++)
    require(Object.is(snapshotTrips(data, r, q), snapshotTrips(view, r, q)), 'packed demand keeps evaluator arithmetic exact');
  const custom = { ...data, od: [Math.PI, -0, Number.MIN_VALUE], ld: [Infinity, -Infinity, NaN], big: [1 + Number.EPSILON], attract: [-0] };
  const customSnapshot = selectionDemandSnapshot(custom), customView = selectionDemandInputs(customSnapshot);
  const sparse = new Array<number>(2); sparse[1] = -0;
  require(selectionDemandSnapshot({ ...data, ld: sparse }).ld === sparse, 'custom sparse demand tables retain their holes');
  require(Array.isArray(customSnapshot.od) && Array.isArray(customSnapshot.big), 'custom double inputs stay unquantized');
  for (const field of ['od', 'ld', 'big', 'attract'] as const)
    require(custom[field].every((value, i) => Object.is(value, customView[field][i])), 'custom double and IEEE values survive packing or fallback');
  const shared: any = { value: 1 }, holes: unknown[] = [];
  holes.length = 2; holes[1] = undefined;
  const task: any = { a: shared, b: shared, map: new Map([[shared, shared]]), set: new Set([shared]),
    floats: new Float64Array([-0, Infinity, -Infinity, NaN]), holes, absent: undefined,
    config: ai.config, focus: ai.config.focus, act: ai.config.activeness, town: g.towns.list[0] };
  task.self = task; shared.parent = task;
  ai.config = { ...ai.config, activeness: 1.7, focus: { rail: 0, road: 4, tram: 1 } };
  const graph = savePlannerTask(g, managed, task, scope());
  const cold = loadPlannerTask<any>(g, managed, copy(graph), scope());
  require(cold.self === cold && cold.a === cold.b && cold.a.parent === cold && cold.map.get(cold.a) === cold.a
    && cold.set.has(cold.a), 'detached graph aliases and cycles survive JSON');
  require(cold.config !== ai.config && cold.focus === cold.config.focus && cold.focus !== ai.config.focus
    && cold.town === g.towns.list[0] && cold.act === 1, 'current and replaced native/config inputs retain their identities');
  require(Object.hasOwn(cold, 'absent') && cold.absent === undefined && !(0 in cold.holes) && 1 in cold.holes
    && Object.is(cold.floats[0], -0) && cold.floats[1] === Infinity && cold.floats[2] === -Infinity
    && Number.isNaN(cold.floats[3]), 'JSON preserves task scalar and sparse-array values');
  require(JSON.stringify(savePlannerTask(g, managed, cold, scope())) === JSON.stringify(graph), 'graph encoding is canonical after cold restore');
  let accessed = false;
  for (const bad of [() => 0, new Uint8Array([1]), new Date(), { get value() { accessed = true; return 1; } },
    { get selectionRoutingEpoch() { accessed = true; return 1; } }, { get selectionDemandEpoch() { accessed = true; return 1; } }]) {
    let rejected = false;
    try { savePlannerTask(g, managed, { bad }, scope()); } catch { rejected = true; }
    require(rejected, 'unsupported task runtime values must be rejected');
  }
  require(!accessed, 'task encoding must not invoke arbitrary getters');
  const project = { kind: 'rail', get openingLine() { accessed = true; return 1; } };
  const projectGraph = savePlannerTask(g, managed, { project }, scope(project));
  require(loadPlannerTask<any>(g, managed, copy(projectGraph), scope(project)).project === project && !accessed,
    'the installed native Project binds by identity without reading instrumentation accessors');
  const staleProject = { kind: 'rail', edges: [1, 2] }, nextProject = { kind: 'bus', edges: [] };
  const staleGraph = savePlannerTask(g, managed, { a: staleProject, b: staleProject }, scope(nextProject));
  const stale = loadPlannerTask<any>(g, managed, copy(staleGraph), scope(nextProject));
  require(stale.a === stale.b && stale.a !== nextProject && stale.a.edges.join() === '1,2', 'replaced Project inputs remain detached aliases');

  const source = g.lines.create('road', ai.companyId), survivor = g.lines.create('road', ai.companyId);
  const currentLines = savePlannerTask(g, managed, { a: source, b: source, survivor }, scope());
  const current = loadPlannerTask<any>(g, managed, copy(currentLines), scope());
  require(current.a === source && current.a === current.b && current.survivor === survivor, 'current native line aliases bind physically');
  g.lines.delete(source.id);
  for (const redirected of [false, true]) {
    if (redirected) g.lines.redirectLine(source.id, survivor.id, -1, new Map(), source);
    let rejected = false;
    try { loadPlannerTask(g, managed, copy(currentLines), scope()); } catch { rejected = true; }
    require(rejected, 'a missing physical line cannot restore through an incumbent redirect');
  }
  require(g.lines.get(source.id) === survivor, 'native semantic line redirect exists in the fixture');
  const detachedLines = savePlannerTask(g, managed, { a: source, b: source, survivor }, scope());
  const detached = loadPlannerTask<any>(g, managed, copy(detachedLines), scope());
  require(detached.a === detached.b && detached.a !== survivor && detached.a.id === source.id && detached.survivor === survivor,
    'removed native line inputs remain detached aliases while the incumbent stays native');

  let roadWalk: ReturnType<typeof pointWalkingCatchment> | undefined;
  for (const edge of g.world.net.edges.values()) {
    if (edge.kind !== 'road') continue;
    const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(edge, edge.len / 2, p);
    const candidate = pointWalkingCatchment(g, p.x, p.z, 'bus');
    if (candidate.buildings.size) { roadWalk = candidate; break; }
  }
  require(roadWalk, 'native walking fixture reaches inhabited buildings');
  const walk = roadWalk!;
  const owned = ownPlannerWalk(walk), other = ownPlannerWalk(walk);
  const empty = pointWalkingCatchment(g, -100, -100, 'rail');
  const ownedEmpty = ownPlannerWalk(empty), otherEmpty = ownPlannerWalk(empty);
  require(owned !== other && owned.buildings !== other.buildings && ownedEmpty !== otherEmpty
    && ownedEmpty.buildings !== otherEmpty.buildings && ownedEmpty.segments !== otherEmpty.segments,
    'each durable walk owns its inputs, including repeated empty cache results');
  const firstBuilding = walk.buildings.keys().next().value!;
  require(owned.buildings.get(firstBuilding) !== walk.buildings.get(firstBuilding), 'owned walk building entries are detached scalar inputs');
  let unbrandedRejected = false;
  try { ownPlannerWalk({ get segments() { accessed = true; return []; }, buildings: new Map() }); } catch { unbrandedRejected = true; }
  require(unbrandedRejected && !accessed, 'owned walking snapshots reject arbitrary unbranded accessors');
  const ownedGraph = savePlannerTask(g, managed, { owned, ownedEmpty }, scope());
  const ownedCold = loadPlannerTask<any>(g, managed, copy(ownedGraph), scope());
  const liveLater = savePlannerTask(g, managed, { ...{ owned, ownedEmpty }, later: ownPlannerWalk(empty) }, scope());
  const coldLater = savePlannerTask(g, managed, { ...ownedCold, later: ownPlannerWalk(empty) }, scope());
  require(JSON.stringify(liveLater) === JSON.stringify(coldLater), 'a later empty walk cannot split an incidental pre-save cache alias');
  const before = bytes(g), captured = savePlannerTask(g, managed, { walk }, scope());
  require(bytes(g) === before, 'capturing a native lazy walk leaves the world unchanged');
  const aliasGraph = savePlannerTask(g, managed, { walk, segments: walk.segments, buildings: walk.buildings }, scope());
  const alias = loadPlannerTask<any>(g, managed, copy(aliasGraph), scope());
  require(alias.walk.segments === alias.segments && alias.walk.buildings === alias.buildings, 'native walk input aliases survive');
  require(walk.segments.length > 0, 'native retained walking geometry was materialized from its captured roads');
  const walked = new Set(walk.segments.map(segment => segment.edge));
  const edge = [...g.world.net.edges.values()].find(e => walked.has(e.id) && e.kind === 'road' && e.len > 4 && e.station < 0 && e.depot < 0);
  require(edge && g.world.net.splitEdge(edge.id, edge.len / 2), 'native walking fixture has a road that can be split');
  g.lines.rebuild();
  const edited = bytes(g);
  require(JSON.stringify(savePlannerTask(g, managed, { walk }, scope())) === JSON.stringify(captured) && bytes(g) === edited,
    'retained native walking inputs survive a later road edit and routing rebuild without changing the world');

  const a = retainPlannerInput(new Float32Array([-0, 1, NaN])), b = retainPlannerInput(new Float32Array([-0, 1, NaN]));
  const pooled = withPlannerInputCapture(g, () => savePlannerTask(g, managed, { a, b }, scope()));
  const restored = withPlannerInputRestore(g, copy(pooled.inputs), () => loadPlannerTask<any>(g, managed, copy(pooled.value), scope()));
  require(restored.a === restored.b && Object.is(restored.a.value[0], -0) && Number.isNaN(restored.a.value[2]),
    'content-equal immutable inputs share a lossless invocation-local payload');
  console.log('PASS planner graph, native walking snapshots and immutable input data');
}

function nativeSelection(focus = { rail: 1, road: 0, tram: 0 }) {
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1950,
    aiCompanies: 1, aiConfigs: [{ focus, activeness: .25 }] });
  const ai = g.ais[0] as any, seen = new Set<string>();
  let twins: { g: Game; label: string; left: number }[] = [], began = false, handedOff = false, activeAcrossMonth = false;
  let finish = Infinity;
  for (let n = 0; n < 100 * g.ticksPerDay; n++) {
    g.stepTick();
    for (const twin of twins) twin.g.stepTick();
    const full = bytes(g);
    for (const twin of twins) {
      require(bytes(twin.g) === full && twin.g.ais[0].busy === ai.busy, `${twin.label}: full cold continuation differs at tick ${g.tick}`);
      twin.left--;
    }
    twins = twins.filter(twin => twin.left > 0);
    const task = ai.selection;
    if (task) began = true;
    if (task && g.day >= 30) activeAcrossMonth = true;
    const key = task?.stage === 'init' ? 'before first work' : task?.stage === 'demand' ? 'demand row'
      : task?.stage === 'rail' && task.rail?.stage === 'sites' ? 'station search'
      : task?.stage === 'rail' && task.rail?.stage === 'forecast' ? 'retained fleet forecast' : undefined;
    if (key && !seen.has(key)) checkpoint(key, key === 'station search' ? 640 : 128);
    if (began && !handedOff && !task) {
      handedOff = true; finish = g.tick + 640;
      require(!(serialize(g) as any).ais[0].state.selection, 'completed selection metadata must clear before the next job or idle state is saved');
      if (focus.rail) {
        require(ai.project?.kind === 'rail' && ai.rng.state === 3663146384,
          'native passive company preserves its original weighted railway choice and RNG');
        checkpoint('rail handoff before first work', 640);
      }
      else { require(!ai.project && !ai.busy && ai.state.phase === 'idle', 'no viable option returns immediately to idle'); checkpoint('exhausted selection', 640); }
    }
    if (handedOff && g.tick >= finish && !twins.length) break;
    if (n === 100 * g.ticksPerDay - 1) throw new Error('native selection did not finish within its bounded fixture');
    function checkpoint(label: string, left: number) {
      seen.add(label);
      const cold = deserialize(copy(serialize(g)));
      require(bytes(cold) === full && cold.ais[0].busy === ai.busy, `${label}: immediate JSON roundtrip differs`);
      twins.push({ g: cold, label, left });
    }
  }
  require(began && handedOff && seen.has('before first work') && seen.has('demand row'), 'native selection and its initial save boundaries were exercised');
  if (focus.rail) require(activeAcrossMonth && seen.has('station search') && seen.has('retained fleet forecast'),
    'retained native selection crosses a real monthly update and its railway quote stages');
  console.log('PASS native selector', focus.rail ? 'rail handoff' : 'no options', [...seen].join(', '));
}

retainedTrainCars();
retainedData();
nativeSelection();
nativeSelection({ rail: 0, road: 0, tram: 0 });
console.log('ALL CHECKS PASSED');
