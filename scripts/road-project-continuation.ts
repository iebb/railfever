// Native paid road helpers: every original work boundary, detached cold cursor and unchanged-world oracle.
// Bundle as road-project-continuation.mjs; --oracle=/absolute/before.mjs compares the frozen native implementation.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { pickBus, pickCoach, type AIController } from '../src/game/ai';
import { planTownCandidates, planCoach, pays, roadPlanJob, newRoadBuildCursor, type BusHost, type RoadPlan, type RoadBuildCursor } from '../src/game/ai-bus';
import { savePlannerTask, loadPlannerTask } from '../src/game/ai-task-data';
export { Game, serialize, deserialize, pickBus, pickCoach, planTownCandidates, planCoach, pays, roadPlanJob };

const drain = <T>(job: Generator<void, T>): T => { let r = job.next(); while (!r.done) r = job.next(); return r.value; };
const host = (ai: AIController): BusHost => (ai as unknown as { busHost(): BusHost }).busHost();
const encode = (g: Game) => JSON.stringify(serialize(g));

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  type API = { Game: typeof Game; serialize: typeof serialize; deserialize: typeof deserialize; pickBus: typeof pickBus;
    planTownCandidates: typeof planTownCandidates; pays: typeof pays; roadPlanJob: typeof roadPlanJob };
  const beforeArg = process.argv.find(a => a.startsWith('--oracle='));
  const oracle: API | null = beforeArg ? await import(pathToFileURL(beforeArg.slice(9)).href) : null;
  function fixture(api: API) {
    const g = api.Game.create({ size: 256, seed: 7, towns: 8, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 1 });
    g.aiEnabled = false; g.company(1).economy.money = 20_000_000;
    const h = host(g.ais[0]);
    const candidates = g.towns.list.flatMap(T => { const model = api.pickBus(g.year, T.pop); return model ? drain(api.planTownCandidates(h, T, model)) : []; });
    const plan = candidates.filter(api.pays).sort((a, b) => b.revenue - b.yearly - (a.revenue - a.yearly))[0];
    assert(plan, 'generated native town offers a paying bus project');
    return { g, plan };
  }
  function run(api: API, durable: boolean, cold: boolean) {
    let { g, plan } = fixture(api), h = host(g.ais[0]);
    let ledger = { stations: [] as number[], depots: [] as number[] };
    h.project = () => ledger;
    let c = newRoadBuildCursor(), job = api.roadPlanJob(h, plan, durable ? c : undefined);
    const stages = new Set<string>(), actions: { unit: number; money: number; assets: string }[] = [];
    let units = 0, lastAssets = '', result = '';
    for (; units < 5000; units++) {
      const r = job.next();
      const assets = `${g.stations.map.size},${g.depots.map.size},${g.lines.map.size},${g.vehicles.map.size}`;
      if (assets !== lastAssets) { actions.push({ unit: units + 1, money: g.company(1).economy.money, assets }); lastAssets = assets; }
      if (r.done) { result = r.value; break; }
      stages.add(`${c.stage}:${c.depotSearch?.stage ?? ''}:${c.stop ? 'stop-paid' : ''}`);
      g.stepTick();
      if (cold) {
        const saved = JSON.parse(JSON.stringify({ world: api.serialize(g), task: savePlannerTask(g, h.managed, { c, plan, ledger }) }));
        const next = api.deserialize(saved.world), nextHost = host(next.ais[0]);
        const task = loadPlannerTask<{ c: RoadBuildCursor; plan: RoadPlan; ledger: typeof ledger }>(next, nextHost.managed, saved.task);
        g = next; h = nextHost; c = task.c; plan = task.plan; ledger = task.ledger; h.project = () => ledger;
        job = api.roadPlanJob(h, plan, c);
      }
    }
    assert.match(result, /^opened /, 'native paid road project opens actual stock');
    assert(g.vehicles.map.size > 0 && g.depots.map.size > 0 && ledger.stations.length >= 2, 'paid stations, depot and vehicles are retained');
    return { text: JSON.stringify(api.serialize(g)), units: units + 1, actions, result, stages: [...stages] };
  }
  function same(a: { text: string; units: number; actions: unknown; result: string }, b: typeof a, why: string) {
    assert.deepEqual({ units: a.units, actions: a.actions, result: a.result }, { units: b.units, actions: b.actions, result: b.result }, why);
    if (a.text !== b.text) { let i = 0; while (a.text[i] === b.text[i]) i++; assert.fail(`${why}; first full-save difference at ${i}: ${a.text.slice(i - 60, i + 140)} / ${b.text.slice(i - 60, i + 140)}`); }
  }
  const currentAPI = { Game, serialize, deserialize, pickBus, planTownCandidates, pays, roadPlanJob };
  const native = run(currentAPI, false, false), durable = run(currentAPI, true, false), cold = run(currentAPI, true, true);
  same(durable, native, 'cursor preserves original native logical units and every paid action');
  same(cold, durable, 'every yielded native paid unit resumes exactly after JSON cold load');
  if (oracle) same(native, run(oracle, false, false), 'frozen original source agrees in full native output and logical paid boundaries');
  console.log(`PASS native paid road construction: ${durable.units} identical work units, ${cold.stages.length} saved substages, every paid action and full saved world${oracle ? ', frozen source oracle' : ''}`);
  console.log(JSON.stringify({ stages: cold.stages, actions: cold.actions }));
}
