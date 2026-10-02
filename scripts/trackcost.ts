// Track costs on hilly ground with a bridge and a tunnel (1 km): single vs double track built together, and a
// second track laid beside an existing one later, with the shared-formation cost model (SHARED_TRACK) and the
// old model (every track pays materials and structures in full).
// npx esbuild scripts/trackcost.ts --bundle --platform=node --format=esm --outfile=$S/trackcost.mjs && node $S/trackcost.mjs
import { Game } from '../src/game/game';
import { planEdge, commitProposal, SHARED_TRACK } from '../src/game/construction';
import { fails, check, free, railOpts, fmt } from './lib';

const g = Game.create({ size: 256, seed: 4, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
g.economy.money = 1e9;
const w = g.world;
// rolling hills around height 4, a ridge (tunnel) at x = 95 and a river valley (bridge) at x = 140
for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) {
  let h = 4 + Math.sin(x * 0.21) * 0.7 + Math.sin(z * 0.17 + x * 0.05) * 0.5;
  h += Math.max(0, 8 - Math.abs(x - 95) * 0.7);
  if (Math.abs(x - 140) < 8) h = Math.min(h, -1 + Math.abs(x - 140) * 0.45);
  w.h[w.vi(x, z)] = h;
}
w.heightsVersion++;
for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);

const plan = (z: number, tracks: number) => planEdge(g, free(g, 70, z), free(g, 170, z), railOpts(0, tracks, { heightOffset: 4 - w.heightAt(70, z) }));
const PER = 7500;
/** The cost model before this round: every track pays materials, bridges x6 and tunnels x9; earthworks once. */
const oldCost = (p: ReturnType<typeof plan>) => {
  let c = 0;
  for (const tp of p.tracks) {
    let bl = 0, tl = 0;
    for (const sec of tp.sections) { if (sec.type === 'bridge') bl += sec.s1 - sec.s0; else tl += sec.s1 - sec.s0; }
    c += PER * (tp.len - bl - tl) + PER * 6 * bl + PER * 9 * tl;
  }
  const sp = p.stats.costSplit!;
  return c + sp.earthworks / (1 + SHARED_TRACK.earthworks * (p.tracks.length - 1)) + sp.other;
};
const M = (v: number) => fmt(v / 1e6, 2) + ' M';
const one = plan(128, 1), two = plan(128, 2);
for (const p of [one, two]) check(p.ok, `planned: ${p.errors.join(', ')}`);
const st = one.stats, sp = one.stats.costSplit!;
let bl = 0, tl = 0;
for (const sec of one.tracks[0].sections) { if (sec.type === 'bridge') bl += sec.s1 - sec.s0; else tl += sec.s1 - sec.s0; }
console.log(`1 km of standard track (${PER} per unit on the ground): ${st.bridges} bridge (${fmt(bl, 0)} units), ${st.tunnels} tunnel (${fmt(tl, 0)} units)`);
console.log(`  single track:          before ${M(oldCost(one))}, now ${M(one.cost)}  (ground ${M(sp.track)}, bridge ${M(sp.bridges)} = ${fmt(sp.bridges / bl / PER, 1)}x per unit, tunnel ${M(sp.tunnels)} = ${fmt(sp.tunnels / tl / PER, 1)}x per unit, earthworks ${M(sp.earthworks)})`);
console.log(`  double track together: before ${M(oldCost(two))} (x${fmt(oldCost(two) / oldCost(one), 2)}), now ${M(two.cost)} (x${fmt(two.cost / one.cost, 2)}; shared formation saves ${M(two.stats.sharedSaving ?? 0)})`);
// a second track beside the built one (e.g. the parallel copy)
check(commitProposal(g, one) === null, 'single track built');
const side = planEdge(g, free(g, 70, 128.45), free(g, 170, 128.45), railOpts(0, 1, { heightOffset: 4 - w.heightAt(70, 128.45) }));
check(side.ok, `track beside it planned: ${side.errors.join(', ')}`);
console.log(`  second track beside it: before ~${M(oldCost(one))} (as a new track), now ${M(side.cost)} (saving ${M(side.stats.sharedSaving ?? 0)})`);
check(two.cost < one.cost * 1.6, 'double track costs well under twice a single track');
check(side.cost < one.cost * 0.6, 'a track beside an existing one shares its formation');
check(sp.bridges / bl / PER >= 4 && sp.tunnels / tl / PER >= 8, 'viaducts >= 4x and tunnels >= 8x ground track per unit');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
