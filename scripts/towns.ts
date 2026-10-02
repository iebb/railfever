// Town report over several seeds and map sizes (default number of towns): sizes, layouts and growth profiles,
// street network connectivity per town (share of streets connected to the centre, dead ends, closed rings).
// npx esbuild scripts/towns.ts --bundle --platform=node --format=esm --outfile=$S/towns.mjs && node $S/towns.mjs [seeds] [sizes]
import { Game } from '../src/game/game';
import { townNetworks } from './townstats';
import { fmt, fails, check } from './lib';

const seeds = (process.argv[2] ?? '1,5,7,11,23').split(',').map(Number);
const sizes = (process.argv[3] ?? '512,768,1024').split(',').map(Number);
const defaultTowns = (size: number) => Math.max(3, Math.min(48, Math.round(4.5 * (size / 384) ** 2)));
let worst = 100, totalTowns = 0, below = 0, deadEnds = 0, ringSegs = 0, ringBuilt = 0, ringFailed = 0, rings = 0, ringsClosed = 0;
for (const size of sizes) for (const seed of seeds) {
  const towns = defaultTowns(size);
  const t0 = performance.now();
  const g = Game.create({ size, seed, towns, hilliness: 'hilly', water: 'medium', startYear: 1950 });
  const ms = performance.now() - t0;
  const nets = townNetworks(g);
  const pops = g.towns.list.map((t) => t.pop).sort((a, b) => b - a);
  const layouts = new Map<string, number>();
  for (const t of g.towns.list) layouts.set(t.grid?.layout ?? '?', (layouts.get(t.grid?.layout ?? '?') ?? 0) + 1);
  console.log(`${size}/${seed} (${towns} towns, ${fmt(ms, 0)} ms): pop ${pops.reduce((a, p) => a + p, 0)} (largest ${pops[0]}, median ${pops[Math.floor(pops.length / 2)]}), ${g.world.buildings.size} buildings; ` +
    [...layouts].map(([k, v]) => `${v} ${k}`).join(', '));
  for (const n of nets) {
    totalTowns++;
    deadEnds += n.deadEnds;
    worst = Math.min(worst, n.pct);
    if (n.ringSegs !== undefined) { ringSegs += n.ringSegs; ringBuilt += n.ringBuilt!; ringFailed += n.ringFailed!; rings += n.rings!; ringsClosed += n.ringsClosed!; }
    const ring = n.ringSegs !== undefined ? `, rings ${n.ringsClosed}/${n.rings} closed (${n.ringBuilt}/${n.ringSegs} segments)` : '';
    const flag = n.pct < 98 ? '  <-- ' : '';
    if (n.pct < 98 || process.env.ALL) console.log(`  ${n.town.name} (${n.town.grid?.layout}, ${n.town.profile}, pop ${n.town.pop}): ${n.connected}/${n.edges} streets connected (${fmt(n.pct, 1)} %), ${n.deadEnds} dead ends${ring}${flag}`);
    if (n.pct < 98) below++;
  }
}
console.log(`\n${totalTowns} towns: worst connectivity ${fmt(worst, 1)} %, ${below} below 98 %; ${fmt(deadEnds / totalTowns, 1)} dead ends per town; ` +
  `ring towns: ${ringsClosed}/${rings} inner rings closed, ${ringBuilt}/${ringSegs} ring segments built, ${ringFailed} failed (too steep, water), ` +
  `${ringSegs - ringBuilt - ringFailed} not reached yet (growth)`);
check(below === 0, 'every town has >= 98 % of its streets connected to its centre');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
