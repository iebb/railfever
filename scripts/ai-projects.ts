// Railway opportunity eligibility, funded continuations and saved decision replay.
// Bundle as ai-projects.mjs and run with Node.
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { serialize, deserialize } from '../src/game/save';
import { addBusStop, check, fails } from './lib';

AIController.profile = true;
const access = (g: Game) => g.ais[0] as AIController & Record<string, any>;
const g = Game.create({ size: 768, seed: 61, towns: 20, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 1 });
g.aiAcquisitions = false;
const ai = access(g), B = g.towns.list[14], C = g.towns.list[12];
// Plenty of credit makes the losing corridor an economic rejection, rather than an affordability failure.
ai.eco.money = 25_000_000;
const angle = Math.atan2(C.x - B.x, C.z - B.z);
let plan = g.stations.planRail(B.x, B.z, angle, 10, 2, ai.companyId, { level: 'underground', depth: 2.2, style: 'none', entrances: 4 });
for (const off of [5, -5, 10, -10, 15, -15]) {
  if (plan.ok) break;
  plan = g.stations.planRail(B.x - Math.cos(angle) * off, B.z + Math.sin(angle) * off, angle, 10, 2, ai.companyId,
    { level: 'underground', depth: 2.2, style: 'none', entrances: 4 });
}
const id = g.stations.nextId, error = plan.ok ? g.stations.commitRail(plan, ai.companyId) : plan.error;
if (error) throw new Error(error);
const hub = g.stations.get(id)!; hub.townId = B.id;
// A rival coach route already serves the small towns. The quick railway quote shares their unchanged demand.
const stops = [B, C].map((town) => {
  let stop = -1;
  for (let dx = -10; dx <= 10 && stop < 0; dx += 2) for (let dz = -10; dz <= 10 && stop < 0; dz += 2)
    stop = addBusStop(g, town.x + dx, town.z + dz, 0);
  if (stop < 0) throw new Error(`No coach stop in ${town.name}`);
  g.stations.get(stop)!.townId = town.id; return stop;
});
const coach = g.lines.create('bus', 0); coach.stops = stops; g.lines.rebuild();
check(ai.hubFor(B, C) === hub, 'losing continuation has a real owned hub with free platform ends');
check(ai.hubFor(B, g.towns.list[7]) === hub, 'funded continuation uses the same real hub');
const before = serialize(g);
function choose(world: Game) {
  const a = access(world), job = a.chooseProject();
  let step = job.next(); while (!step.done) step = job.next();
  return a;
}
const pair = (a: AIController, other: number) => a.lastOptions.filter((o) => o.kind === 'rail' && o.towns.includes(B.id) && o.towns.includes(other));
const ordinary = choose(deserialize(before));
check(pair(ordinary, C.id).length === 0, 'capital-adjusted losing railway has no eligible ordinary quotation');
check(pair(ordinary, 7).length === 1, 'profitable affordable railway still has an eligible quotation');

ai.state.corridor = [hub.id, C.id];
const negativeSave = serialize(g), negative = choose(g), negativeReplay = choose(deserialize(negativeSave));
check(pair(negative, C.id).length === 0, 'saved losing continuation cannot borrow another railway score');
check(!negative.state.corridor, 'losing continuation is released for other opportunities');
check(negative.lastOptions.some((o) => ['metro', 'lightrail'].includes(o.kind) && o.score > 0), 'viable city railway remains in the ordinary opportunity comparison');

const goodWorld = deserialize(before), good = access(goodWorld);
good.state.corridor = [hub.id, 7];
const positiveSave = serialize(goodWorld), positive = choose(goodWorld), positiveReplay = choose(deserialize(positiveSave));
const quote = pair(ordinary, 7)[0], preferred = pair(positive, 7);
check(preferred.length === 1, 'funded continuation reuses its own quotation exactly once');
check(!!quote && Math.abs((preferred[0]?.score ?? 0) - quote.score * 1.2) < 1e-10, 'funded continuation retains the existing preference on its own return');
check(positive.state.corridor?.[0] === hub.id && positive.state.corridor?.[1] === 7, 'funded continuation remains saved');
const decision = (a: AIController & Record<string, any>) => JSON.stringify({ options: a.lastOptions, corridor: a.state.corridor,
  project: a.project && { kind: a.project.kind, towns: a.project.towns }, state: a.state });
check(decision(negative) === decision(negativeReplay), 'losing continuation makes the identical decision after saving/loading');
check(decision(positive) === decision(positiveReplay), 'funded continuation makes the identical decision after saving/loading');
console.log(`eligible rail return ${quote?.score.toFixed(3)}, funded continuation ${preferred[0]?.score.toFixed(3)}; ${pair(negative, C.id).length} losing corridor options; ${negative.lastOptions.filter((o) => ['metro', 'lightrail'].includes(o.kind)).length} viable city options`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
