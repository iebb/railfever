// World generation scale test: Game.create time per phase, towns (sizes, streets, buildings, parks, plazas,
// spacing), generated country roads (edges, length, structures, connectivity) and sim cost for map sizes
// 512..1536 with the default number of towns (title screen), plus a crowded 512 map; town street networks
// connected to their centres.
// npx esbuild scripts/scale.ts --bundle --platform=node --format=esm --outfile=$S/scale.mjs && node $S/scale.mjs [seed]
import { Game } from '../src/game/game';
import { generateHeights, generateTrees } from '../src/game/terrain-gen';
import { generateIntercityRoads } from '../src/game/roads';
import { BT_PARK, BT_PLAZA } from '../src/game/towns';
import { fmt, fails, check } from './lib';
import { townNetworks } from './townstats';

const seed = Number(process.argv[2] ?? 5);
// the title screen's map presets with their default number of towns, and a crowded 512 map
const defaultTowns = (size: number) => Math.max(3, Math.min(48, Math.round(4.5 * (size / 384) ** 2)));
for (const [size, towns] of [[512, defaultTowns(512)], [768, defaultTowns(768)], [1024, defaultTowns(1024)], [1536, defaultTowns(1536)], [512, 20]] as const) {
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
  const pops = g.towns.list.map((t) => t.pop).sort((a, b) => b - a);
  let gaps = 0;
  for (const t of g.towns.list) gaps += Math.min(...g.towns.list.filter((o) => o !== t).map((o) => Math.hypot(o.x - t.x, o.z - t.z) - t.radius - o.radius));
  console.log(`  towns: largest ${pops[0]}, median ${pops[Math.floor(pops.length / 2)]}, smallest ${pops[pops.length - 1]} people; ` +
    `open country to the nearest town ${fmt(gaps / g.towns.list.length / 100, 2)} km on average; tallest building ${Math.max(...[...g.world.buildings.values()].map((b) => b.floors))} storeys`);
  console.log(`  ${streets} street edges (${fmt(streetLen, 0)} u), ${roads} country road edges (${fmt(roadLen, 0)} u; ${rs.built} roads: ${rs.mst} tree + ${rs.extra} shortcuts, ${rs.failed} pairs skipped, ` +
    `${rs.bridges} bridge / ${rs.tunnels} tunnel sections), ${linked}/${towns} towns linked; ${g.world.trees.filter(Boolean).length} trees, ${g.vehicles.ambient.length} town cars; ${fmt(sim, 2)} ms per game day`);
  check(ms < (size <= 768 ? 2500 : size <= 1024 ? 4000 : 6000), `${size} map generated in time (${fmt(ms, 0)} ms)`);
  check(roads > 0, `${size} map has country roads`);
  check(linked >= towns - 1, `${size} map: towns linked by road (${linked}/${towns})`);
  check(pops[0] <= 5000, `${size} map: no huge cities at the start (largest ${pops[0]})`);
  const nets = townNetworks(g);
  const worst = nets.reduce((a, n) => (n.pct < a.pct ? n : a), nets[0]);
  console.log(`  town streets: worst connectivity ${fmt(worst.pct, 1)} % (${worst.town.name}), ${fmt(nets.reduce((a, n) => a + n.deadEnds, 0) / nets.length, 1)} dead ends per town`);
  check(nets.every((n) => n.pct >= 98), `${size} map: every town's streets connected to its centre`);
  check(Math.max(...[...g.world.buildings.values()].map((b) => b.floors)) <= 6, `${size} map: no high-rises at the start`);
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
