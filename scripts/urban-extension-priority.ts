// Bounded city growth selection: native connected/patterned extension, economic fallback and saved scheduler replay.
// Bundle as urban-extension-priority.mjs. Demand/competing opening quotes are controlled; works and routes are native.
import { flat, newTown, district, cityLine, linePath, M } from './linegrow-fixtures';
import { terminusOf, outerEnd, urbanGrowthCandidates } from '../src/game/ai-grow';
import { previewUrbanGrowth, queueUrbanGrowth, networkDaily, saveNetwork, routeBetween } from '../src/game/ai-network';
import { serialize, deserialize } from '../src/game/save';
import { stationEnds, nodeSnap } from '../src/game/routing';
import { planEdge, commitProposal } from '../src/game/construction';
import { addPattern, linePatterns } from '../src/game/patterns';
import { platformChoices } from '../src/game/rail-platforms';
import { Train, depotReaches } from '../src/game/train';
import { railPartMode } from '../src/game/stations';
import { URBAN_PAYBACK, discountedPayback } from '../src/game/constants';
import { check, fails, checkReservations } from './lib';
import type { Game } from '../src/game/game';

const run = <T>(job: Generator<void, T>) => { let s = job.next(); while (!s.done) s = job.next(); return s.value; };
const { g, ai, me } = flat(2), town = newTown(g, 'Branch City', 220, 256), foreign = g.ais[1].companyId;
ai.config = { ...ai.config, focus: { rail: 2, road: 0, tram: 0 } };
for (const co of g.companies) co.hqTown = town.id;
district(g, town, 145, 233, 256, 64, 30000);
const { line, sts, depot } = cityLine(g, me, [160, 200, 240], 256, 'west', 'tail', 3);
const short = addPattern(g, line.id, 'local', line.stops.map(id => id !== sts[2].id), 'Short turn')!;
(g.vehicles.get(line.vehicles[2]) as Train).pattern = short.id;
for (const id of line.vehicles) (g.vehicles.get(id) as Train).retryTimer = 1e8;
const remotePlan = g.stations.planRail(295, 209, Math.atan2(55, -47), 7, 2, foreign, { trackType: 'electric', mode: 'lightrail', style: 'none' });
if (!remotePlan.ok) throw new Error(remotePlan.error);
const remoteId = g.stations.nextId;
if (g.stations.commitRail(remotePlan, foreign)) throw new Error('remote station');
const remote = g.stations.get(remoteId)!;
const beforeBranch = g.world.net.nextEdge;
const T = sts[2], from = stationEnds(g, T).map(e => e.front), to = stationEnds(g, remote).map(e => e.back);
const branch = planEdge(g, nodeSnap(g, from[0], 'rail'), nodeSnap(g, to[0], 'rail'),
  { kind: 'rail', type: 'electric', tracks: 2, heightOffset: 0, crossing: 'auto', owner: me });
if (!branch.ok || commitProposal(g, branch)) throw new Error(branch.errors.join(', '));
const branchIds = [...g.world.net.edges.values()].filter(e => e.id >= beforeBranch && e.owner === me).map(e => e.id);
district(g, town, 275, 350, 256, 64, 40000);
g.onNetworkChanged(); g.lines.rebuild(); g.stepTick();
(ai as any).adoptLines();
check(terminusOf(g, T, outerEnd(T, sts[1]), me)?.kind === 'branch', 'connected urban timetable end remains eligible for native branching');
check(urbanGrowthCandidates(g, me).some(l => l.id === line.id), 'patterned city line remains in bounded existing-service inventory');
check(!!routeBetween(g, T.id, remote.id, me) && !!routeBetween(g, remote.id, T.id, me), 'fixture has lawful bidirectional connection to foreign platforms');

function receipts(world: Game, gain = 10e6) {
  world.demand.forecastLine = ((points: any[]) => ({ revenue: 1e6 + (points.length > 3 ? gain : 0),
    boardings: 1000, covered: 20000, legLoads: Array(2 * (points.length - 1)).fill(1000), direct: 1000, transfer: 0, perPax: 100 })) as typeof world.demand.forecastLine;
}
receipts(g);
const base = structuredClone(serialize(g));
function fresh(gain = 10e6) { const world = deserialize(structuredClone(base)); receipts(world, gain); return world; }
const normalized = (value: any): any => Array.isArray(value) ? value.map(normalized) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, normalized(value[k])])) : value;
const saved = (world: Game) => JSON.stringify(normalized(serialize(world)));
const active = (world: Game) => saveNetwork(world).companies.find(([id]) => id === me)?.[1].job;
const quoteWorld = fresh(), quote = run(previewUrbanGrowth(quoteWorld.aiOf(me)!, line.id));
console.log('native connected growth quote', quote && { score: quote.score, option: quote.cursor.opts?.[quote.cursor.best!.opt] });
check(!!quote && quote.score > 0 && !quote.cursor.best?.fleet, 'profitable connected continuation gets a marginal construction quote');
if (!quote) throw new Error('native connected extension is not buildable');
check(!run(previewUrbanGrowth(fresh(0).aiOf(me)!, line.id)), 'unchanged whole-line receipts do not justify extension');

const working = fresh();
check(queueUrbanGrowth(working.aiOf(me)!, quote), 'chosen extension hands off to native saved work item');
let phases = 0;
while (active(working) && phases < 16) {
  const clone = deserialize(structuredClone(serialize(working))); receipts(clone);
  check(saved(working) === saved(clone), `queued phase ${phases} round-trips exactly`);
  networkDaily(working.aiOf(me)!); networkDaily(clone.aiOf(me)!);
  for (let tick = 0; tick < 8; tick++) { working.stepTick(); clone.stepTick(); }
  check(saved(working) === saved(clone), `queued phase ${phases} fixed-tick replay is exact`);
  phases++;
}
const extended = working.lines.get(line.id)!, newCalls = linePath(extended).filter(id => !sts.some(s => s.id === id));
check(!active(working) && newCalls.length > 0 && working.lines.map.size === 1, 'actual native work extends the original timetable');
check(newCalls.every(id => railPartMode(working.stations.get(id)!.rail!) === 'lightrail'), 'new city platforms retain existing service style');
const shortAfter = linePatterns(extended).find(p => p.id === short.id)!;
check(newCalls.every(id => extended.stops.every((sid, i) => sid !== id || shortAfter.stops[i] === false)), 'short turn keeps its original coverage while the local serves new stops');
check(linePatterns(extended).every(p => extended.stops.every((_, i) => p.stops[i] === false || platformChoices(working, extended, p.id, i).length > 0)),
  'every local/short-turn served call has a native forward platform departure at intermediate stops');
check(branchIds.every(id => working.world.net.edges.get(id)?.owner === me) && working.stations.get(remoteId)?.owner === foreign
  && !!routeBetween(working, T.id, remoteId, me) && !!routeBetween(working, remoteId, T.id, me), 'original foreign-platform connection and physical ownership survive native extension');
check(linePath(extended).every(id => depotReaches(working, working.depots.get(depot)!, id, [M('lrv_b')]))
  && checkReservations(working).length === 0, 'native depot and reservations serve the expanded local');

function opening(world: Game, targetScore: number) {
  const a = world.aiOf(me)! as typeof ai & Record<string, any>;
  // A controlled competing opening isolates the chooser; selected extension works still use native plans.
  a.urbanStep = function* (T: any, mode: 'metro' | 'lightrail') {
    const layout = a.urbanLayout(T, mode, undefined, 3, 7), years = discountedPayback(URBAN_PAYBACK[mode], world.company(me).economy.interestRate);
    const total = 3e6, yearly = 100000, net = total / years + total * Math.max(0, targetScore * 4.5 / years - .15) ** 2;
    return { ...layout, quote: { total, yearly, net, forecast: { revenue: net + yearly } } };
  };
  // No intercity pair exists; local road/cross-city shortcuts get no speculative demand.
  a.townDemand = function* () { return { pair: () => 0, local: () => 0 }; };
  a.state.urbanSearchCursor = 0;
  run(a.chooseProject());
  return a;
}
const chosenWorld = fresh(), chosen = opening(chosenWorld, quote.score * .99);
check(!chosen.project && active(chosenWorld)?.task === 'extend', 'real chooser prefers close profitable own extension to an independent city opening');
const fallbackWorld = fresh(0), fallback = opening(fallbackWorld, quote.score * .99);
check(fallback.project?.kind === 'lightrail' && !active(fallbackWorld), 'profitable independent city line remains possible when continuation is unpaid');
const superiorWorld = fresh(), superior = opening(superiorWorld, quote.score * 2);
check(superior.project?.kind === 'lightrail' && !active(superiorWorld), 'substantially better independent investment remains possible');
chosen.state.urbanGrowthCursor = 7;
const loadedChosen = deserialize(structuredClone(serialize(chosenWorld)));
check(loadedChosen.aiOf(me)!.state.urbanGrowthCursor === 7 && saved(chosenWorld) === saved(loadedChosen), 'rotating existing-line cursor and queued extension save exactly');
console.log(`native patterned connected extension: ${phases} saved phases; chooser priority, unpaid fallback and superior-investment controls`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
