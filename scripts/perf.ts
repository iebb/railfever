import { Game } from '../src/game/game';
import { planRoute } from '../src/game/construction';
const g = Game.create({ size: 192, seed: 21, towns: 20, hilliness: 'hilly', water: 'medium', startYear: 1950 });
const pairs = [[20, 20, 60, 30], [20, 20, 100, 90], [10, 100, 150, 120], [30, 150, 160, 40]];
for (const [a, b, c, d] of pairs) {
  for (const kind of ['rail', 'road'] as const) {
    const t0 = performance.now();
    const p = planRoute(g, kind, a, b, c, d);
    console.log(kind, a, b, c, d, 'ok', p.ok, p.error ?? '', 'steps', p.steps.length, 'ms', (performance.now() - t0).toFixed(0), 'cost', p.cost);
  }
}
