// Road structures: a road bridge over a river and a road tunnel; a bus runs across both, and bulldozing
// the road under the bus returns it to its depot cleanly.
// npx esbuild scripts/tunnel2.ts --bundle --platform=node --format=esm --outfile=$S/tunnel2.mjs && node $S/tunnel2.mjs
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { RoadVehicle } from '../src/game/roadvehicle';
import { bulldoze } from '../src/game/build-ops';
import { fails, check, build, free, roadOpts, nodeNear, addBusStop, roadDepotNear } from './lib';
import { nodeSnap } from '../src/game/routing';

const g = Game.create({ size: 160, seed: 2, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
g.economy.money = 1e8;
const w = g.world;
for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) {
  let h = 2;
  if (Math.abs(x - 70) < 6) h = -1; // river
  h += Math.max(0, 10 - Math.abs(x - 105) * 0.9); // hill
  w.h[w.vi(x, z)] = h;
}
const p1 = build(g, free(g, 40, 80), free(g, 88, 80), roadOpts(0, 'road'), 'bridge road');
const n1 = nodeNear(g, 'road', 88, 80, 0.3);
const p2 = n1 ? build(g, nodeSnap(g, n1.id, 'road'), free(g, 125, 80), roadOpts(0, 'road', { heightOffset: 2 - w.heightAt(125, 80) }), 'tunnel road') : null;
const bridges = (p1?.stats.bridges ?? 0) + (p2?.stats.bridges ?? 0), tunnels = (p1?.stats.tunnels ?? 0) + (p2?.stats.tunnels ?? 0);
console.log(`  road: ${bridges} bridge(s), ${tunnels} tunnel(s)`);
check(bridges >= 1, 'road bridge over the river');
check(tunnels >= 1, 'road tunnel through the hill');
const s0 = addBusStop(g, 45, 80, 0), s1 = addBusStop(g, 121, 80, 0);
const dep = roadDepotNear(g, 50, 80, 0);
check(s0 > 0 && s1 > 0 && dep > 0, `stops and depot (${s0}, ${s1}, ${dep})`);
const line = g.lines.create('road', 0);
line.stops = [s0, s1];
const bus = g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_b')!, line.id) as RoadVehicle;
let stops = 0, hidden = 0, last = '';
const q = { x: 0, y: 0, z: 0 };
for (let i = 0; i < 4 * 300; i++) {
  g.update(0.25);
  if (bus.seg) { const s = bus.pointBehind(0, q); if (s && bus.hiddenAt(s, bus.pos)) hidden++; }
  if (bus.state === 'loading' && last !== 'loading') stops++;
  last = bus.state;
}
console.log(`  bus: ${stops} stops, ${hidden} ticks hidden in the tunnel, delivered ${bus.delivered}`);
check(stops >= 4, 'bus crossed the bridge and tunnel repeatedly');
check(hidden > 0, 'bus hidden inside the tunnel');
// bulldoze the bridge road while the bus is on it
let onBridge = false;
for (let i = 0; i < 4 * 200 && !onBridge; i++) { g.update(0.25); bus.worldPos(q); onBridge = Math.abs(q.x - 70) < 3; }
const res = bulldoze(g, 70, 80, 70, 80, 0, false);
for (let i = 0; i < 40; i++) g.update(0.25);
console.log(`  bulldoze under the bus: ${res.error ?? 'removed'}; bus ${bus.state} "${bus.status}"`);
check(res.error === 'Vehicle in the way' || bus.state === 'depot' || bus.state === 'noroute', 'bulldozing under a bus is refused or returns it to its depot');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
