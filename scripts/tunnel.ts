import { Game } from '../src/game/game';
import { planRoute, commitPlan } from '../src/game/construction';
const g = Game.create({ size: 128, seed: 99, towns: 8, hilliness: 'mountainous', water: 'low', startYear: 1950 });
const w = g.world;
let maxH = 0; for (const h of w.hgt) maxH = Math.max(maxH, h);
console.log('max level', maxH);
let found = 0, tried = 0;
for (let z = 8; z < w.size - 8 && found < 3; z += 3) for (let x = 8; x < w.size - 30 && found < 3; x += 2) {
  const h0 = w.tileMax(x, z);
  if (w.isWater(x, z) || !w.isEmpty(w.idx(x, z)) || w.slope(x, z) !== 0) continue;
  for (let L = 5; L <= 16; L++) {
    if (!w.inBounds(x + L, z)) break;
    const hE = w.tileMax(x + L, z);
    let peak = 0; for (let k = 1; k < L; k++) peak = Math.max(peak, w.tileMin(x + k, z));
    if (peak >= h0 + 4 && Math.abs(hE - h0) <= 1 && w.isEmpty(w.idx(x + L, z)) && !w.isWater(x + L, z)) {
      tried++;
      const t0 = performance.now();
      const p = planRoute(g, 'rail', x, z, x + L, z);
      const links = p.steps.filter((s) => s.link).map((s) => s.link!.kind + s.link!.span);
      const prof = []; for (let k = 0; k <= L; k++) prof.push(w.corners(x + k, z).join(''));
      console.log('cand', x, z, L, 'h0', h0, 'peak', peak, 'ok', p.ok, p.error, 'links', links, 'steps', p.steps.length, 'cost', p.cost, prof.join(' '));
      if (p.ok && links.some((l) => l.startsWith('tunnel'))) { found++; console.log('tunnel route', x, z, L, 'cost', p.cost, links, (performance.now() - t0).toFixed(0) + 'ms', commitPlan(g, p)); }
      break;
    }
  }
}
console.log('tried', tried, 'found', found);
