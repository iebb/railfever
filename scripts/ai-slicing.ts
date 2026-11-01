// Failed native urban station attempts consume separate deterministic work units and resume at the next offset.
// Bundle as ai-slicing.mjs. This fixture uses the actual five road-support refusals behind seed23's day94 spike.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { check, fails } from './lib';

const saved = (g: Game) => JSON.stringify(serialize(g));
const g = Game.create({ size: 512, seed: 23, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 1 });
g.aiEnabled = false;
const ai = g.ais[0] as any, town = g.towns.list.find(t => t.name === 'Dunworth')!;
const x = 295.0184579240133, z = 247.47525043977953;
const angle = Math.atan2((295.1588637279137 - x) / 1.5, (245.98183616027399 - z) / 1.5);
const offsets = [0, 1.5, -1.5, 3, -3];
const before = saved(g), stamps = [g.world.net.nextNode, g.world.net.nextEdge, g.world.net.version, g.world.heightsVersion];
const quotes = offsets.map(d => g.stations.planRail(x + Math.sin(angle) * d, z + Math.cos(angle) * d, angle, 7, 2, ai.companyId,
  { aiSurvey: true, trackType: 'electric', mode: 'lightrail', level: 'ground', depth: 2.2, height: 1.5 }));
check(quotes.every(p => !p.ok && p.error === 'Too close to road at another height'), 'all five original native positions really fail the physical road-support guard');
check(saved(g) === before && JSON.stringify(stamps) === JSON.stringify([g.world.net.nextNode, g.world.net.nextEdge, g.world.net.version, g.world.heightsVersion]),
  'five native refusal quotes preserve all saved state, geometry allocators and terrain versions');
check(ai.startProject('lightrail', [town.id]), 'the native urban job is scheduled before restoring its pending survey');
// A real saved survey can be between any two native offsets. Retain the complete ordinary layout metadata;
// only the selected physical trial is fixed to the independently checked original failing five positions.
const layout = { ...ai.urbanLayout(town, 'lightrail', undefined, 3, 7), x, z, angle, targets: [0, 26, 52], L: 52, interchanges: [] };
ai.urbanSurvey = { maxStops: 3, unit: ai.urbanUnit('lightrail', 7).id, trials: [{ layout, level: 'ground', count: 3 }],
  trial: 0, site: 0, offset: 0, sites: [], best: { ...layout }, stageBest: { ...layout }, bestReturn: -1e30, stageReturn: -1e30, stageCount: 3 };
const initial = saved(g), initialCash = ai.eco.money, initialLoan = ai.eco.loan;
type Call = { x: number; z: number; ok: boolean; error?: string };
function observe(game: Game) {
  const calls: Call[] = [], native = game.stations.planRail.bind(game.stations);
  game.stations.planRail = (...args: Parameters<typeof game.stations.planRail>) => {
    const p = native(...args); calls.push({ x: args[0], z: args[1], ok: p.ok, error: p.error }); return p;
  };
  return calls;
}
// One generator.next is exactly one native project work unit (AIController.work uses the same boundary).
function unit(game: Game) { const a = game.ais[0] as any; check(!a.job.next().done, 'the pending urban job yields after its bounded work unit'); }
const calls = observe(g);
for (let at = 1; at <= 2; at++) {
  const n = calls.length; unit(g);
  check(calls.length === n + 1 && ai.urbanSurvey.offset === at && ai.urbanSurvey.site === 0 && ai.project.planned === at,
    `failed site offset${at} uses one native quote and saves the exact next offset/work count`);
}
const mid = saved(g), cold = deserialize(JSON.parse(mid)), ca = cold.ais[0] as any, coldCalls = observe(cold);
check(saved(cold) === mid && ca.urbanSurvey.offset === 2, 'a real mid-offset native job save reloads exactly without restarting its search');
for (let at = 3; at <= 5; at++) {
  const n = calls.length, cn = coldCalls.length; unit(g); unit(cold);
  check(calls.length === n + 1 && coldCalls.length === cn + 1 && ai.urbanSurvey.offset === at && ca.urbanSurvey.offset === at,
    `warm/cold offset${at} each executes only the next original native site`);
  check(saved(g) === saved(cold), `native job state, RNG, cash and cursor continue exactly after offset${at}`);
}
check(calls.every((p, i) => p.x === x + Math.sin(angle) * offsets[i] && p.z === z + Math.cos(angle) * offsets[i]
  && !p.ok && p.error === quotes[i].error), 'all five native offsets, their original order and physical refusals are retained');
const n = calls.length; unit(g); unit(cold);
check(calls.length === n && ai.urbanSurvey.site === 1 && ai.urbanSurvey.offset === 0 && ai.urbanSurvey.sites.length === 1,
  'after all five refusals the original local forecast-site fallback consumes its own unit without an extra native attempt');
check(saved(g) === saved(cold) && ai.eco.money === initialCash && ai.eco.loan === initialLoan,
  'warm/cold fallback preserves exact state and survey work spends no cash or credit');
// Through corridors retain the stricter existing rule: no virtual centre can replace an unbuildable native site.
const through = deserialize(JSON.parse(initial)), ta = through.ais[0] as any;
ta.urbanSurvey.trials[0].layout.towns = [town.id, 5];
const throughCalls = observe(through);
for (let at = 1; at <= 5; at++) { const n = throughCalls.length; unit(through); check(throughCalls.length === n + 1 && ta.urbanSurvey.offset === at,
  `through-corridor offset${at} also retains one native attempt per unit`); }
unit(through);
check(ta.urbanSurvey.trial === 1 && ta.urbanSurvey.site === 0 && ta.urbanSurvey.offset === 0 && !ta.urbanSurvey.sites.length && throughCalls.length === 5,
  'five failed native through sites skip the original trial without invented virtual demand');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
