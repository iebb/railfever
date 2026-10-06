// Owned rail extensions: both-end hub selection, marginal fleet reuse, economic fallback and decision replay.
// Bundle as ai-extensions.mjs and run with Node. Controlled receipts isolate planner investment choices.
import { AIController } from '../src/game/ai';
import { Game } from '../src/game/game';
import type { Town } from '../src/game/towns';
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { flatGame, station, endNode, depotFor, loco, check, fails, build, free, railOpts, nodeSnap } from './stationlib';
import { roadOpts } from './lib';

AIController.profile = true;
const access = (g: Game) => g.ais[0] as AIController & Record<string, any>;
const run = <T>(job: Generator<void, T>) => { let step = job.next(); while (!step.done) step = job.next(); return step.value; };
const g = flatGame(320);
g.addAICompany({ startMoney: 30e6, focus: { rail: 1, road: 0, tram: 0 }, risk: 0.7 });
g.addAICompany({ startMoney: 30e6, focus: { rail: 1, road: 0, tram: 0 } });
g.aiAcquisitions = false;
const ai = access(g), owner = ai.companyId, foreignOwner = g.ais[1].companyId;
const points = [[240, 120], [140, 120], [60, 120], [60, 240], [160, 240]];
g.towns.list = points.map(([x, z], id): Town => ({ id, name: `Town ${id}`, x, z, angle: 0, pop: 2000, radius: 20,
  buildings: new Set(), nextGrowthDay: 100, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 }));
check(!!build(g, free(g, 20, 111), free(g, 280, 111), roadOpts(), 'station access'), 'fixture access road');
const foreign = station(g, 240, 120, Math.PI / 2, 12, 2, foreignOwner)!;
const terminus = station(g, 140, 120, Math.PI / 2, 12, 2, owner)!;
const origin = station(g, 60, 120, Math.PI / 2, 12, 2, owner)!;
if (!foreign || !terminus || !origin) throw new Error('fixture stations');
[foreign, terminus, origin].forEach((st, id) => st.townId = id);
check(!!build(g, nodeSnap(g, endNode(g, origin, 0, true), 'rail'), nodeSnap(g, endNode(g, terminus, 0, false), 'rail'), railOpts(owner), 'paid railway'), 'fixture paid railway');
const depot = depotFor(g, origin, terminus, owner), line = g.lines.create('rail', owner);
line.stops = [origin.id, terminus.id];
const train = g.vehicles.buyTrain(depot, loco(), line.id);
check(train instanceof Train, 'fixture paid train');
if (!(train instanceof Train)) throw new Error(String(train));
ai.lines.set(line.id, { kind: 'rail', towns: [2, 1], depot, maxVehicles: 2, opened: 0 });
g.lines.rebuild();
check(g.stations.hasAccess(terminus) && g.stations.hasAccess(foreign), 'fixture owns a served accessible terminus and a rival open hub');
for (let a = 0; a < points.length; a++) for (let b = a + 1; b < points.length; b++)
  if (`${a}-${b}` !== '0-1' && `${a}-${b}` !== '3-4') ai.failed.set(`${a}-${b}`, 10000);
check(ai.hubFor(g.towns.list[0], g.towns.list[1]) === foreign, 'earlier town offers the rival hub');
check(ai.hubFor(g.towns.list[1], g.towns.list[0]) === terminus, 'later town offers our existing line terminus');
const ends = ai.railReuseEnds(g.towns.list[0], g.towns.list[1]);
check(!ends.freeA && ends.freeB === terminus, 'our terminus wins across both towns instead of being masked by the earlier foreign hub');

const saved = serialize(g);
function receipts(world: Game, gain: number, unrelated = 900_000) {
  // Native cycle, stock prices, upkeep, capital and station identities still determine the comparison.
  // An existing line's large retained receipts are unchanged when gain is zero.
  world.demand.forecastLine = ((sites: any[], _mode: unknown, _kmh: number, _headway: number, _owner: unknown, replacing?: number) => {
    const towns = [...new Set(sites.map(s => s.townId))].sort().join('-');
    const revenue = replacing === line.id ? 40e6 + (towns === '0-1-2' ? gain : 0)
      : towns === '3-4' ? unrelated : towns === '0-1' ? gain * 0.35 : 0;
    return { revenue, boardings: 10, covered: 6000, perPax: revenue / 1000, direct: 1000, transfer: 0 };
  }) as typeof world.demand.forecastLine;
}
const quoteWorld = deserialize(saved), quoteAI = access(quoteWorld);
receipts(quoteWorld, 1e6);
const qA = quoteWorld.stations.get(terminus.id)!, qB = quoteWorld.stations.get(foreign.id)!;
const quotation = () => run<number>(quoteAI.railExtensionScore(qA, qB, qA, null, loco(), 130, 12, 2e6, 1.6e6, 2e6));
check(quotation() > 0, 'extension is viable with only civil capital available: existing paid trains can serve it without another train purchase');
receipts(quoteWorld, 0);
check(quotation() === 0, 'unchanged whole-line receipts do not make an extension profitable');

function choose(world: Game, gain: number, unrelated?: number) {
  receipts(world, gain, unrelated);
  const a = access(world);
  run(a.chooseProject());
  return { kind: a.project?.kind, towns: a.project?.towns, state: a.state, options: a.lastOptions };
}
const extending = choose(deserialize(saved), 1e6);
check(extending.kind === 'rail' && extending.towns?.join('-') === '1-0', 'profitable own extension is selected ahead of a foreign or separate railway');
check(JSON.stringify(extending) === JSON.stringify(choose(deserialize(saved), 1e6)), 'owned extension decision is identical after saving/loading');
const buildWorld = deserialize(saved), buildAI = access(buildWorld);
choose(buildWorld, 1e6);
const paidFleet = [...buildWorld.lines.get(line.id)!.vehicles], lineCount = buildWorld.lines.map.size;
run(buildAI.job);
const extendedLine = buildWorld.lines.get(line.id)!;
check(extendedLine.stops.includes(foreign.id) && buildAI.project?.line === line.id, 'selected project actually continues the existing timetable into the completed branch');
check(JSON.stringify(extendedLine.vehicles) === JSON.stringify(paidFleet), 'civil-only extension opens with its existing paid fleet');
check(buildWorld.lines.map.size === lineCount, 'own extension leaves no separate or provisional timetable');
const fallback = choose(deserialize(saved), 0);
check(fallback.kind === 'rail' && fallback.towns?.join('-') === '3-4', 'separate profitable railway remains possible when our extension does not pay');
const strong = choose(deserialize(saved), 1e6, 30e6);
check(strong.kind === 'rail' && strong.towns?.join('-') === '3-4', 'substantially better unrelated investment is not displaced by an inferior extension');
console.log(`own extension ${extending.towns?.join('-')}, unpaid fallback ${fallback.towns?.join('-')}, superior investment ${strong.towns?.join('-')}`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
