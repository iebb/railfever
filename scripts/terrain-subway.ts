// Fixed-step surface-formation regression introduced by the subway planner/land prices.
// Bundle as terrain-subway.mjs and run from the bundle directory.
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { terrainFit, fitLine, noteStations, Sites } from './terrainfit';
import { check, fails } from './lib';
if (!process.argv[1]?.endsWith('terrain-subway.mjs')) throw new Error('bundle as terrain-subway.mjs');
const g = Game.create({ size: 512, seed: 7, towns: 6, hilliness: 'hilly', water: 'medium', startYear: 1960, aiCompanies: 3 });
const sites: Sites = new Map();
for (let tick = 0; tick < 720 * TICKS_PER_DAY; tick++) {
  g.stepTick();
  if (g.tick % TICKS_PER_DAY === 0) noteStations(g, sites);
}
const r = terrainFit(g, undefined, sites);
console.log(`tick ${g.tick}, day ${g.day}: ${fitLine(r)}`);
for (const ex of r.examples) console.log(`  ${ex}`);
check(g.tick === 28800, 'exactly 28,800 committed ticks');
check(r.covered === 0 && r.floating === 0 && r.station === 0, 'surface network fits its terrain after two years (seed 7)');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
