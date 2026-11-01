// A title to a newly built timetable cannot authorize deleting a different line after a native merge.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { pickBus, type AIController } from '../src/game/ai';
import { planTownCandidates, pays, type BusHost, type RoadPlan } from '../src/game/ai-bus';
import { outAndBack } from '../src/game/lines';
import { replaceLineStops } from '../src/game/line-edit';
import { canonicalizeLines } from '../src/game/patterns';
import { serialize, deserialize } from '../src/game/save';
const drain = <T>(job: Generator<void, T>): T => { let r = job.next(); while (!r.done) r = job.next(); return r.value; };
const json = (g: Game) => JSON.stringify(serialize(g));
function same(g: Game, h: Game, label: string) { assert(json(g) === json(h), label); }

for (const kind of ['market', 'bus'] as const) {
  const g = Game.create({ size: 192, seed: 7, towns: 4, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 1 });
  const ai = g.ais[0] as AIController & Record<string, any>;
  g.company(1).economy.money = 20_000_000; ai.state.cooldown = 1e9; g.aiAcquisitions = false;
  const incumbent = g.lines.create('road', 1), model = pickBus(g.year, g.towns.list[0].pop)!;
  let marketLoop = false;
  if (kind === 'market') {
    const plan = drain(planTownCandidates(ai.busHost() as BusHost, g.towns.list[0], model)).filter(pays)
      .sort((p, q) => q.revenue - q.yearly - (p.revenue - p.yearly))[0];
    assert(plan, 'actual native paying plan'); marketLoop = !!plan.loop;
    ai.project = { kind: 'bus', towns: plan.towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    ai.job = ai.roadPlanJob(plan as RoadPlan, 'bus');
  } else assert(ai.startProject('bus', [0]));
  let tick = 0;
  const pending = () => kind === 'market' ? ai.roadTask?.build : ai.roadTask;
  const boundary = () => kind === 'market' ? pending()?.stage === 'lineReachCheck' : pending()?.stage === 'line';
  while (!boundary() && ai.busy && tick++ < 3000) g.stepTick();
  assert(boundary(), `${kind}: native job reaches paid stop/depot boundary before allocating its timetable`);
  const c = pending();
  const loop = kind === 'market' ? marketLoop : !!c.ring;
  if (loop) incumbent.loop = true;
  replaceLineStops(g, incumbent, kind === 'market' && !loop ? outAndBack(c.ids) : [...c.ids]);
  // A normal intervening edit gives the preexisting timetable a paid bus. The construction job owns neither.
  const bus = g.vehicles.buyRoad(c.depot, model, incumbent.id);
  assert(typeof bus !== 'string', 'incumbent buys actual stock through the native depot');
  const titled = () => kind === 'market' ? ai.project?.roadLine : ai.project?.line >= 0 ? ai.project.line : undefined;
  while (titled() === undefined && ai.busy && tick++ < 4000) g.stepTick();
  const created = titled(); assert(created !== undefined && created !== incumbent.id, 'project creates a distinct paid timetable');
  const changes = canonicalizeLines(g, created);
  assert(changes.some(c => c.from === created && c.into === incumbent.id), 'native canonicalization absorbs the pending timetable');
  assert(!g.lines.map.has(created) && g.lines.get(created) === incumbent, 'its old ID now semantically redirects to the incumbent');
  const loaded = deserialize(JSON.parse(json(g))), loadedAI = loaded.aiOf(1)! as AIController & Record<string, any>;
  same(g, loaded, `${kind}: immediate post-merge cold save`);
  ai.cancelJob(); loadedAI.cancelJob();
  same(g, loaded, `${kind}: live/cold cancellation`);
  assert(g.lines.map.get(incumbent.id) === incumbent, `${kind}: physical incumbent survives redirected cleanup title`);
  assert(g.vehicles.get(bus.id), `${kind}: intervening paid incumbent stock survives`);
  assert(!g.lines.map.has(created) && !ai.busy && !ai.project, 'cancel releases only its actual work and continuation');
  for (let n = 0; n < 128; n++) { g.stepTick(); loaded.stepTick(); same(g, loaded, `${kind}: post-cancel fixed tick ${n}`); }
  console.log(`PASS ${kind}: native merge ${created}->${incumbent.id}, actual incumbent stock retained,128 exact cold ticks`);
}
console.log('ALL CHECKS PASSED: physical road cleanup titles');
