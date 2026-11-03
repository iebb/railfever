// Paid partner/extension work, native invalidation, access and busy depot release preserve native steps and ledgers.
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { pickBus, type AIController } from '../src/game/ai';
import { planTownCandidates, pays, roadPlanJob, newRoadBuildCursor, moreValue, planExtensions, extendPlan, stopSites,
  type BusHost, type RoadPlan, type RoadBuildCursor } from '../src/game/ai-bus';
import { savePlannerTask, loadPlannerTask } from '../src/game/ai-task-data';
const drain = <T>(job: Generator<void, T>): T => { let r = job.next(); while (!r.done) r = job.next(); return r.value; };
const host = (ai: AIController): BusHost => (ai as unknown as { busHost(): BusHost }).busHost();

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const api = { Game, serialize, deserialize, pickBus, planTownCandidates, pays, roadPlanJob, moreValue, planExtensions, extendPlan, stopSites };
  type API = typeof api;
  const arg = process.argv.find(a => a.startsWith('--oracle=')), oracle: API | null = arg ? await import(pathToFileURL(arg.slice(9)).href) : null;
  const cases = ['join-new-depot', 'join-busy-depot', 'join-revoked-access', 'extend', 'paid-stop-road-loss', 'paid-depot-road-loss'] as const;
  type Case = typeof cases[number];
  function prepare(a: API, scenario: Case) {
    const g = a.Game.create({ size: 256, seed: 7, towns: 8, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 2 });
    g.aiEnabled = false; for (const co of g.companies) co.economy.money = 20_000_000;
    const h = host(g.ais[0]), T = g.towns.list[0], model = a.pickBus(g.year, T.pop)!;
    const candidates = drain(a.planTownCandidates(h, T, model));
    const base = candidates.filter(a.pays).sort((p, q) => q.revenue - q.yearly - (p.revenue - p.yearly))[0];
    assert(base, 'native paying initial line');
    if (scenario.startsWith('paid-')) return { g, owner: 1, plan: base };
    assert.match(drain(a.roadPlanJob(h, base)), /^opened /);
    const l = [...g.lines.map.values()][0];
    if (scenario.startsWith('join')) {
      // Native resale leaves spare lawful capacity; the quote itself retains native fees and ownership.
      for (const id of l.vehicles.slice(1)) g.vehicles.sell(id);
      const targetOwner = scenario === 'join-busy-depot' ? 1 : 2, target = host(g.ais[targetOwner - 1]);
      const p = drain(a.moreValue(target, l, model)); assert(p, 'native marginal quote for a lawful extra operator/vehicle');
      return { g, owner: targetOwner, plan: p };
    }
    let p: RoadPlan | undefined = drain(a.planExtensions(h, l, 12))[0];
    if (!p) {
      for (const site of drain(a.stopSites(g, 1, T.x, T.z, T.radius + 30, T.id))) {
        p = drain(a.extendPlan(h, l, site, 'end', new Set(l.stops).size, 'native continuation probe')) ?? undefined;
        if (p) break;
      }
    }
    assert(p && p.kind === 'extend', 'native extension quote can be committed by original helper');
    return { g, owner: 1, plan: p };
  }
  function run(a: API, scenario: Case, durable: boolean, cold: boolean) {
    let { g, owner, plan } = prepare(a, scenario), h = host(g.ais[owner - 1]), c = newRoadBuildCursor();
    let ledger: { stations: number[]; depots: number[]; roadLine?: number; roadJoin?: number; roadVehicles?: number[]; roadStops?: { station: number; x: number; z: number }[]; roadExtension?: { line: number; beforeStops: number[]; afterStops: number[] } } = { stations: [], depots: [] }, invalidated = false;
    h.project = () => ledger;
    let job = a.roadPlanJob(h, plan, durable ? c : undefined), result = '', units = 0;
    const actions: { unit: number; money: number; assets: string }[] = []; let previous = '';
    const initialStations = g.stations.map.size, initialDepots = g.depots.map.size;
    for (; units < 5000; units++) {
      const r = job.next(), assets = `${g.stations.map.size},${g.depots.map.size},${g.lines.map.size},${g.vehicles.map.size}`;
      if (assets !== previous) { actions.push({ unit: units + 1, money: g.company(owner).economy.money, assets }); previous = assets; }
      if (r.done) { result = r.value; break; }
      if (!invalidated && (scenario === 'paid-stop-road-loss' && g.stations.map.size > initialStations || scenario === 'paid-depot-road-loss' && g.depots.map.size > initialDepots || scenario === 'join-revoked-access')) {
        // Native access revocation or a physical road removal after a real payment.
        if (scenario === 'join-revoked-access') g.blockCompany(1, 2);
        else if (scenario === 'paid-stop-road-loss') {
          for (const e of [...g.world.net.edges.values()]) if (e.kind === 'road' && e.depot < 0) g.world.net.removeEdge(e.id);
        } else {
          const dp = [...g.depots.map.values()].find(d => d.owner === owner)!; g.world.net.removeEdge(dp.edge);
        }
        invalidated = true;
      }
      g.stepTick();
      if (cold) {
        const saved = JSON.parse(JSON.stringify({ world: a.serialize(g), task: savePlannerTask(g, h.managed, { c, plan, ledger }) }));
        g = a.deserialize(saved.world); h = host(g.ais[owner - 1]);
        const t = loadPlannerTask<{ c: RoadBuildCursor; plan: RoadPlan; ledger: typeof ledger }>(g, h.managed, saved.task);
        c = t.c; plan = t.plan; ledger = t.ledger; h.project = () => ledger; job = a.roadPlanJob(h, plan, c);
      }
    }
    assert(result && units < 5000, 'native paid variant terminates');
    if (scenario.startsWith('paid-') || scenario === 'join-revoked-access') assert(invalidated && result.startsWith('road project failed'), 'native access/physical invalidation retains the original guarded failure');
    else assert(!result.startsWith('road project failed'), result);
    // Follow actual stock out of its busy native garage, including queued sibling vehicles, with ambient traffic retained.
    for (let tick = 0; tick < 128; tick++) g.stepTick();
    return { text: JSON.stringify(a.serialize(g)), ledger, units, actions, result };
  }
  function same(a: ReturnType<typeof run>, b: ReturnType<typeof run>, why: string) {
    assert.deepEqual({ ...a, text: undefined }, { ...b, text: undefined }, why);
    if (a.text !== b.text) { let i = 0; while (a.text[i] === b.text[i]) i++; assert.fail(`${why}; first native save difference ${i}: ${a.text.slice(i - 60, i + 140)} / ${b.text.slice(i - 60, i + 140)}`); }
  }
  for (const scenario of cases) {
    const native = run(api, scenario, false, false), staged = run(api, scenario, true, false), cold = run(api, scenario, true, true);
    same(staged, native, `${scenario} original/staged native units, payments and 128-tick stock release`);
    same(cold, staged, `${scenario} every yielded cold cursor`);
    if (oracle) {
      // These exact ownership titles intentionally repair cancellation only; all native world/finance/work-unit
      // assertions stay exact against original source. Finished standalone helpers retain this external ledger.
      const { roadLine, roadJoin, roadVehicles, roadStops, roadExtension, ...originalLedger } = native.ledger;
      same({ ...native, ledger: originalLedger }, run(oracle, scenario, false, false), `${scenario} frozen original source (cleanup titles excluded explicitly)`);
      console.log(`cleanup-only titles: ${JSON.stringify({ roadLine, roadJoin, roadVehicles, roadStops, roadExtension })}`);
    }
    console.log(`PASS ${scenario}: ${staged.units + 1} native units, full world/ledger/action equality, 128 native release ticks; ${staged.result}`);
  }
}
