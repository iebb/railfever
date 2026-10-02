// World generation scale test: Game.create time per phase, grid towns (streets, buildings, parks, plazas),
// generated country roads (edges, length, structures, connectivity) and sim cost for map sizes 256..768.
// npx esbuild scripts/scale.ts --bundle --platform=node --format=esm --outfile=$S/scale.mjs && node $S/scale.mjs [seed]
import { Game } from '../src/game/game';
import { generateHeights, generateTrees } from '../src/game/terrain-gen';
import { generateIntercityRoads } from '../src/game/roads';
import { BT_PARK, BT_PLAZA } from '../src/game/towns';
import { fmt, fails, check } from './lib';

const seed = Number(process.argv[2] ?? 5);
for (const [size, towns] of [[256, 6], [384, 10], [512, 14], [768, 24]] as const) {
  // the phases of Game.create, timed separately
  const opts = { size, seed, towns, hilliness: 'hilly' as const, water: 'medium' as const, startYear: 1980 };
  const t0 = performance.now();
  const g0 = new Game(opts);
  generateHeights(g0.world, { seed, hilliness: opts.hilliness, water: opts.water });
  const t1 = performance.now();
  g0.towns.generate(towns, seed);
  const t2 = performance.now();
  const rs = generateIntercityRoads(g0);
  const t3 = performance.now();
  generateTrees(g0.world, seed);
  const t4 = performance.now();
  // the real thing (must match the phases)
  const tc = performance.now();
  const g = Game.create(opts);
  const ms = performance.now() - tc;
  const net = g.world.net;
  let streets = 0, streetLen = 0, roads = 0, roadLen = 0;
  for (const e of net.edges.values()) if (e.kind === 'road') { if (e.type === 'street') { streets++; streetLen += e.len; } else { roads++; roadLen += e.len; } }
  let parks = 0, plazas = 0;
  for (const b of g.world.buildings.values()) { if (b.type === BT_PARK) parks++; if (b.type === BT_PLAZA) plazas++; }
  // towns reachable from the first town over the road graph
  const comp = new Map<number, number>();
  const reach = (t: { x: number; z: number; radius: number }) => net.nearestNode(t.x, t.z, t.radius + 6, 'road', (n) => n.edges.length > 0);
  const s0 = reach(g.towns.list[0]);
  if (s0) {
    const q = [s0.id]; comp.set(s0.id, 0);
    while (q.length) { const id = q.pop()!; for (const eid of net.nodes.get(id)!.edges) { const e = net.edges.get(eid)!; const o = e.a === id ? e.b : e.a; if (!comp.has(o)) { comp.set(o, 0); q.push(o); } } }
  }
  const linked = g.towns.list.filter((t) => { const n = reach(t); return n && comp.has(n.id); }).length;
  const t5 = performance.now();
  for (let i = 0; i < 4 * 30; i++) g.update(0.25);
  const sim = (performance.now() - t5) / 15;
  console.log(`${size}x${size}, ${towns} towns: Game.create ${fmt(ms, 0)} ms (heights ${fmt(t1 - t0, 0)}, towns ${fmt(t2 - t1, 0)}, roads ${fmt(t3 - t2, 0)}, trees ${fmt(t4 - t3, 0)}); ` +
    `pop ${g.towns.list.reduce((a, t) => a + t.pop, 0)}, ${g.world.buildings.size} buildings (${parks} parks, ${plazas} plazas)`);
  console.log(`  ${streets} street edges (${fmt(streetLen, 0)} u), ${roads} country road edges (${fmt(roadLen, 0)} u; ${rs.built} roads: ${rs.mst} tree + ${rs.extra} shortcuts, ${rs.failed} pairs skipped, ` +
    `${rs.bridges} bridge / ${rs.tunnels} tunnel sections), ${linked}/${towns} towns linked; ${g.world.trees.filter(Boolean).length} trees, ${g.vehicles.ambient.length} town cars; ${fmt(sim, 2)} ms per game day`);
  check(ms < 2500 || size > 512, `${size} map generated in under 2.5 s (${fmt(ms, 0)} ms)`);
  check(roads > 0, `${size} map has country roads`);
  check(linked >= towns - 1, `${size} map: towns linked by road (${linked}/${towns})`);
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
