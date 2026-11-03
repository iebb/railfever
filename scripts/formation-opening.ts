// Native railway opening: prospective station access and its eventual depot must keep every road seated.
import { Game } from '../src/game/game';
import { platformChoices } from '../src/game/rail-platforms';
import { check, fails, checkReservations } from './lib';
import { terrainFit, fitLine } from './terrainfit';

const g = Game.create({ size: 512, seed: 61, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
g.aiEnabled = false; g.aiAcquisitions = false;
const before = terrainFit(g), ai = g.aiOf(1)!;
check(ai.startProject('rail', [1, 4]), 'native railway opening starts');
let ticks = 0;
for (; ticks < 400 * g.ticksPerDay && ai.busy; ticks++) {
  const dayTick = g.tick % g.ticksPerDay;
  ai.work(dayTick, dayTick + 1);
  g.stepTick();
}
const line = [...g.lines.map.values()].find(l => l.owner === 1 && l.kind === 'rail');
check(!ai.busy && !!line && line.vehicles.length === 2, 'native opening completes its railway, depot and full two-train fleet');
check(!!line && line.stops.length === 2 && line.stops.every((_, i) => platformChoices(g, line, 0, i).length === 2), 'both stations retain two legal platform choices');
for (let tick = 0; tick < 64; tick++) g.stepTick();
const after = terrainFit(g);
check(after.station === 0 && after.covered === 0 && after.floating <= before.floating, 'station, access street and depot construction introduce no actual-width support failures');
check(checkReservations(g).length === 0, 'native yard and railway retain valid train reservations');
console.log(`native opening ${ticks} ticks; ${fitLine(after)}; pre-existing floating samples ${before.floating}`);
console.log(`native opening finances: loan ${g.company(1).economy.loan}, cash ${g.company(1).economy.money}`);
console.log(ai.log.slice(-4).join('\n'));
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
