// Tunnels need real cover (UPDATE 9d): a double-track line at a constant level through gentle hills gets
// cuttings or one long, properly covered tunnel — never short tunnel pairs with an open gap between them, and
// no tunnel lining left sticking out of the ground (thin cover is backfilled after building).
// npx esbuild scripts/cover.ts --bundle --platform=node --format=esm --outfile=$S/cover.mjs && node $S/cover.mjs
import { Game } from '../src/game/game';
import { planEdge, commitProposal } from '../src/game/construction';
import { TUNNEL_LINING } from '../src/game/terraform';
import { profAt } from '../src/game/network';
import { fails, check, fmt, free, railOpts } from './lib';

// hills across the line: [centre x, height above the plain, half width]
const cases: { name: string; hills: [number, number, number][] }[] = [
  { name: 'a gentle hill', hills: [[128, 2.4, 22]] },
  { name: 'a higher hill', hills: [[128, 5, 26]] },
  { name: 'two hills with a dip between', hills: [[112, 4.2, 14], [146, 4.2, 14]] },
  { name: 'a long low ridge', hills: [[128, 3.2, 40]] },
];
for (const c of cases) {
  const g = Game.create({ size: 256, seed: 4, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
  g.economy.money = 1e9;
  const w = g.world, net = w.net;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) {
    let h = 3;
    for (const [cx, hh, hw] of c.hills) { const d = Math.abs(x - cx) / hw; if (d < 1) h += hh * (0.5 + 0.5 * Math.cos(d * Math.PI)); }
    w.h[w.vi(x, z)] = h;
  }
  w.heightsVersion++;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  const p = planEdge(g, free(g, 40, 128), free(g, 216, 128), railOpts(0, 2));
  check(p.ok, `${c.name}: planned (${p.errors.join(', ')})`);
  const tp = p.tracks[0];
  const tun = tp.sections.filter((s) => s.type === 'tunnel');
  let gaps = Infinity;
  for (let i = 1; i < tun.length; i++) gaps = Math.min(gaps, tun[i].s0 - tun[i - 1].s1);
  let deepest = 0;
  for (let s = 0; s <= tp.len; s += 1) {
    const f = s / tp.len, x = tp.bez.x0 + (tp.bez.x3 - tp.bez.x0) * f;
    deepest = Math.max(deepest, w.heightAt(x, 128) - profAt(tp.prof, tp.len, s));
  }
  console.log(`  ${c.name}: ${tun.length ? tun.map((s) => `tunnel ${fmt(s.s1 - s.s0, 0)} u`).join(' + ') : 'cutting only'} (deepest cut ${fmt(deepest * 10, 0)} m), ` +
    `cost ${fmt(p.cost / 1e6, 2)} M (tunnels ${fmt(p.stats.costSplit!.tunnels / 1e6, 2)}, earthworks ${fmt(p.stats.costSplit!.earthworks / 1e6, 2)})`);
  check(tun.every((s) => s.s1 - s.s0 >= 8), `${c.name}: no short tunnels`);
  check(gaps >= 10, `${c.name}: no short open gaps between tunnels`);
  check(commitProposal(g, p) === null, `${c.name}: built`);
  // every tunnel stretch (portals aside) is under the ground, lining included
  let exposed = 0, samples = 0;
  for (const e of net.edges.values()) {
    if (e.kind !== 'rail') continue;
    const geo = net.geo(e);
    for (let i = 0; i < geo.n; i++) {
      const s = geo.cum[i];
      if (!e.sections.some((q) => q.type === 'tunnel' && s >= q.s0 + 1 && s <= q.s1 - 1)) continue;
      samples++;
      if (w.heightAt(geo.pts[i * 3], geo.pts[i * 3 + 2]) < geo.pts[i * 3 + 1] + TUNNEL_LINING.rail + 0.3) exposed++;
    }
  }
  check(exposed === 0, `${c.name}: tunnels covered (${exposed} of ${samples} points short of cover)`);
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
