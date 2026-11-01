// Retained native upgrade quotes: paid physical fixture, pure capture and every logical cold continuation.
// Bundle as ai-selection-quotes.mjs. Fixed-tick selection scheduling is checked in ai-selection.ts.
import { flat, newTown, district } from './linegrow-fixtures';
import { deserialize, serialize } from '../src/game/save';
import { pickBus } from '../src/game/ai';
import * as bus from '../src/game/ai-bus';
import * as works from '../src/game/route-works';
import { buildRoadDepot } from '../src/game/routing';
import { savePlannerTask, loadPlannerTask } from '../src/game/ai-task-data';
import { outAndBack } from '../src/game/lines';
import type { Game } from '../src/game/game';

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const bytes = (world: Game) => JSON.stringify(serialize(world));
const { g, me } = flat(), town = newTown(g, 'Continuation', 220, 256);
district(g, town, 145, 350, 256, 64, 30_000, true, false);
const stops: number[] = [];
for (const x of [157, 221, 285]) {
  const error = g.stations.commitBusStop(x, 252, me);
  if (error) throw new Error(error);
  const station = g.stations.findSharedStop(x, 252, me);
  if (!station) throw new Error('Native stop fixture is missing');
  stops.push(station.id);
}
const line = g.lines.create('road', me);
line.stops = outAndBack(stops); g.lines.rebuild();
const first = g.stations.get(stops[0])!, depot = buildRoadDepot(g, first.stops[0].x, first.stops[0].z, me);
if (depot < 0) throw new Error('Native depot fixture is missing');
const model = pickBus(g.year, town.pop)!;
for (let i = 0; i < 3; i++) if (typeof g.vehicles.buyRoad(depot, model, line.id) === 'string') throw new Error('Native bus purchase failed');
(g.aiOf(me) as any).adoptLines(); g.demand.rebuild();
const base = copy(serialize(g));
const scope = (world: Game) => { const ai = world.aiOf(me)!; return { company: me, config: ai.config, focus: ai.config.focus }; };
const host = (world: Game): bus.BusHost => (world.aiOf(me) as any).busHost();
const managed = (world: Game): ReadonlyMap<number, object> => (world.aiOf(me) as any).lines;
interface QuoteCase {
  name: string; cursor: () => any; run: (world: Game, cursor: any) => Generator<void, any>; built?: boolean;
}
const cases: QuoteCase[] = [
  { name: 'more vehicles', cursor: bus.newMoreValueCursor, run: (w, c) => bus.moreValue(host(w), w.lines.get(line.id)!, undefined, c) },
  { name: 'extensions', cursor: bus.newExtensionsCursor, run: (w, c) => bus.planExtensions(host(w), w.lines.get(line.id)!, 3, c) },
  { name: 'tram', cursor: bus.newTramValueCursor, run: (w, c) => bus.tramUpgradeValue(host(w), w.lines.get(line.id)!, c), built: true },
  ...(['elevated', 'ground', 'underground'] as const).map(level => ({
    name: `city ${level}`, cursor: bus.newCityValueCursor, built: level !== 'ground',
    run: (w: Game, c: bus.CityValueCursor) => bus.cityRailUpgradeValue(host(w), w.lines.get(line.id)!, level === 'underground' ? 'metro' : 'lightrail', level, c),
  })),
  { name: 'route upgrade', cursor: bus.newRouteUpgradeCursor, run: (w, c) => bus.routeUpgradeValue(host(w), w.lines.get(line.id)!, c), built: true },
  { name: 'city geometry', cursor: works.newCityRailPlanCursor, run: (w, c) => works.cityRailPlanGen(w, line.id, me, 'lightrail', 'elevated', c), built: true },
];
for (const test of cases) {
  const world = deserialize(copy(base)), cursor = test.cursor(), job = test.run(world, cursor), seen = new Set<string>();
  const twins: { world: Game; job: Generator<void, any> }[] = [];
  let units = 0;
  for (;;) {
    units++;
    const result = job.next(), full = bytes(world);
    for (const twin of twins) {
      if (JSON.stringify(twin.job.next()) !== JSON.stringify(result) || bytes(twin.world) !== full)
        throw new Error(`${test.name}: cold continuation differs at work unit ${units}`);
    }
    if (result.done) {
      if (!seen.size || units < 3) throw new Error(`${test.name}: no retained native work was exercised`);
      if (test.built && !(result.value?.quote?.ok ?? result.value?.works?.ok)) throw new Error(`${test.name}: native paid upgrade is no longer buildable`);
      if (result.value?.outlay !== undefined && ![result.value.outlay, result.value.revenue, result.value.yearly].every(Number.isFinite))
        throw new Error(`${test.name}: invalid economic quote`);
      console.log('PASS', test.name, units, 'work units,', seen.size, 'cold stages');
      break;
    }
    const stage = JSON.stringify([cursor.stage, cursor.plan?.stage, cursor.forecast?.stage, cursor.baseline?.stage, cursor.city?.stage]);
    if (!seen.has(stage)) {
      seen.add(stage);
      const graph = savePlannerTask(world, managed(world), cursor, scope(world)), cold = deserialize(copy(JSON.parse(full)));
      const restored = loadPlannerTask<any>(cold, managed(cold), copy(graph), scope(cold));
      if (bytes(world) !== full || bytes(cold) !== full
        || JSON.stringify(savePlannerTask(cold, managed(cold), restored, scope(cold))) !== JSON.stringify(graph))
        throw new Error(`${test.name}: capture or immediate JSON restore differs at ${stage}`);
      twins.push({ world: cold, job: test.run(cold, restored) });
    }
    if (units > 1500) throw new Error(`${test.name}: quote exceeded its bounded fixture`);
  }
}
console.log('ALL CHECKS PASSED');
