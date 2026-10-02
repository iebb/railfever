// Terrain fit invariant (UPDATE 9e): after world generation, after a few years of an AI game and after every
// step of a construction fuzz, the terrain never covers rails (roads are draped on the terrain) and never
// leaves rails or roads floating on ground sections. Reports counts by cause.
// npx esbuild scripts/terrain-fit.ts --bundle --platform=node --format=esm --outfile=$S/terrain-fit.mjs && node $S/terrain-fit.mjs [seeds] [years] [steps]
import { Game } from '../src/game/game';
import { planEdge, commitProposal, findSnap } from '../src/game/construction';
import { bulldoze, terraformBrush } from '../src/game/build-ops';
import { buildRailDepot, buildRoadDepot } from '../src/game/routing';
import { RNG } from '../src/game/rng';
import { WATER_Y } from '../src/game/constants';
import { terrainFit, fitLine, FitReport, noteStations, Sites } from './terrainfit';
import { fails, check } from './lib';

const seeds = (process.argv[2] ?? '5,7,11').split(',').map(Number);
const YEARS = Number(process.argv[3] ?? 2), STEPS = Number(process.argv[4] ?? 150);
const ok = (r: FitReport, what: string) => {
  console.log(`  ${what}: ${fitLine(r)}`);
  for (const ex of r.examples.slice(0, 3)) console.log(`      ${ex}`);
  check(r.covered === 0, `${what}: no rails covered by the terrain (${r.covered})`);
  check(r.floating <= r.samples * 0.001, `${what}: (almost) nothing floating (${r.floating})`);
  check(r.station === 0, `${what}: station sites fit too (${r.station}; station site levelling, stations.ts)`);
};
/** Dry land dug below the water line (pits): vertices under WATER_Y + 0.05 not connected to open water. */
const pits = (g: Game): number => {
  const w = g.world, s1 = w.size + 1, wet = new Uint8Array(s1 * s1);
  const q: number[] = [];
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) if ((x === 0 || z === 0 || x === w.size || z === w.size) && w.h[z * s1 + x] < WATER_Y + 0.05) { wet[z * s1 + x] = 1; q.push(z * s1 + x); }
  while (q.length) {
    const k = q.pop()!, x = k % s1, z = (k / s1) | 0;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nz = z + dz;
      if (nx < 0 || nz < 0 || nx > w.size || nz > w.size) continue;
      const kk = nz * s1 + nx;
      if (!wet[kk] && w.h[kk] < WATER_Y + 0.05) { wet[kk] = 1; q.push(kk); }
    }
  }
  let n = 0;
  for (let k = 0; k < s1 * s1; k++) if (!wet[k] && w.h[k] < WATER_Y + 0.05) n++;
  return n;
};

for (const seed of seeds) {
  console.log(`seed ${seed}`);
  // 1. a generated world (towns, country roads)
  const g = Game.create({ size: 512, seed, towns: 6, hilliness: 'hilly', water: 'medium', startYear: 1960, aiCompanies: 3 });
  const lakes0 = pits(g);
  ok(terrainFit(g), 'generated');
  // 2. a few years of AI building and town growth
  g.speed = 8;
  const sites: Sites = new Map();
  for (let d = 0; d < YEARS * 360; d++) { g.update(0.25); noteStations(g, sites); }
  ok(terrainFit(g, undefined, sites), `after ${YEARS} years`);
  console.log(`  inland water below the sea line: ${lakes0} vertices at the start, ${pits(g)} now`);
  // 3. construction fuzz on a smaller map: every step
  const h = Game.create({ size: 256, seed, towns: 4, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  h.economy.money = 1e9;
  const r = new RNG(seed * 31 + 7);
  let worst: FitReport | null = null, bad = 0, badSt = 0;
  const hsites: Sites = new Map();
  for (let step = 0; step < STEPS; step++) {
    const town = h.towns.list[r.int(h.towns.list.length)];
    const near = (x: number, z: number, d: number) => ({ x: Math.max(6, Math.min(h.world.size - 6, x + (r.next() - 0.5) * 2 * d)), z: Math.max(6, Math.min(h.world.size - 6, z + (r.next() - 0.5) * 2 * d)) });
    const k = r.next();
    if (k < 0.5) {
      const kind = r.chance(0.6) ? 'rail' : 'road';
      const a = near(town.x, town.z, town.radius + 25), b = near(a.x, a.z, 25);
      const p = planEdge(h, findSnap(h, kind, a.x, a.z, 1.5), findSnap(h, kind, b.x, b.z, 1.5), { kind, type: kind === 'rail' ? 'standard' : r.chance(0.5) ? 'road' : 'street', tracks: kind === 'rail' ? 1 + r.int(2) : 1, heightOffset: r.chance(0.2) ? (r.next() - 0.5) * 4 : 0, crossing: 'auto', owner: 0 });
      if (p.ok) commitProposal(h, p);
    } else if (k < 0.65) {
      const a = near(town.x, town.z, town.radius + 10);
      const p = h.stations.planRail(a.x, a.z, r.next() * Math.PI * 2, 8, 1 + r.int(2), 0);
      if (p.ok) h.stations.commitRail(p, 0);
    } else if (k < 0.75) {
      const sts = h.stations.all().filter((s) => s.rail);
      if (sts.length && r.chance(0.5)) buildRailDepot(h, sts[r.int(sts.length)], 0);
      else buildRoadDepot(h, town.x + (r.next() - 0.5) * 20, town.z + (r.next() - 0.5) * 20, 0, 10);
    } else if (k < 0.87) {
      const a = near(town.x, town.z, town.radius + 12), wd = r.chance(0.5) ? 0 : 1 + r.next() * 4;
      bulldoze(h, a.x, a.z, a.x + wd, a.z + wd, 0, false);
    } else {
      const a = near(town.x, town.z, town.radius + 20);
      terraformBrush(h, a.x, a.z, 1 + r.next() * 3, r.pick(['raise', 'lower', 'level'] as const), h.world.heightAt(a.x, a.z), 0);
    }
    const fit = terrainFit(h, undefined, hsites);
    if (fit.covered || fit.floating > fit.samples * 0.001) bad++;
    if (fit.station) badSt++;
    if (!worst || fit.covered + fit.floating > worst.covered + worst.floating) worst = fit;
  }
  console.log(`  fuzz: ${STEPS} steps, ${bad} with misfits (${badSt} with misfits at station sites); worst step ${worst ? fitLine(worst) : '-'}`);
  for (const ex of worst?.examples.slice(0, 3) ?? []) console.log(`      ${ex}`);
  check(bad === 0, `fuzz: the terrain fits after every step (${bad} steps with misfits)`);
  check(badSt === 0, `fuzz: station sites fit after every step (${badSt} steps; stations.ts)`);
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
