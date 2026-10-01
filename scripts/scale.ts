// World generation scale test: Game.create time, network and population for map sizes 256..768.
// npx esbuild scripts/scale.ts --bundle --platform=node --format=esm --outfile=$S/scale.mjs && node $S/scale.mjs
import { Game } from '../src/game/game';
import { fmt } from './lib';

for (const [size, towns] of [[256, 6], [384, 10], [512, 14], [768, 24]] as const) {
  const t0 = performance.now();
  const g = Game.create({ size, seed: 5, towns, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  const ms = performance.now() - t0;
  const t1 = performance.now();
  for (let i = 0; i < 4 * 30; i++) g.update(0.25);
  const sim = (performance.now() - t1) / 15;
  console.log(`${size}x${size}, ${towns} towns: Game.create ${fmt(ms, 0)} ms; pop ${g.towns.list.reduce((a, t) => a + t.pop, 0)}, ${g.world.buildings.size} buildings, ` +
    `${g.world.net.edges.size} street edges, ${g.world.trees.filter(Boolean).length} trees, ${g.vehicles.ambient.length} town cars; ${fmt(sim, 2)} ms per game day`);
}
