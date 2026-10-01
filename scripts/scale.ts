import { Game } from '../src/game/game';
import { planBusStop, commitBusStop, commitDepot, autoDepotDir } from '../src/game/build-ops';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
const g = Game.create({ size: 256, seed: 77, towns: 48, hilliness: 'hilly', water: 'medium', startYear: 1960 });
g.economy.money = 1e10;
const w = g.world;
let lines = 0;
for (const town of g.towns.list) {
  const cands: [number, number][] = [];
  for (let z = town.z - 9; z <= town.z + 9; z++) for (let x = town.x - 9; x <= town.x + 9; x++) if (w.inBounds(x, z) && planBusStop(g, x, z).ok) cands.push([x, z]);
  if (cands.length < 2) continue;
  const a = cands[0], b = cands.find((c) => Math.hypot(c[0] - a[0], c[1] - a[1]) > 6 && !g.stations.findNear(c[0], c[1], c[0], c[1], 2));
  if (!b) continue;
  if (commitBusStop(g, a[0], a[1]) || commitBusStop(g, b[0], b[1])) continue;
  let dep = -1;
  for (let r = 1; r < 6 && dep < 0; r++) for (let dz = -r; dz <= r && dep < 0; dz++) for (let dx = -r; dx <= r; dx++) {
    const x = a[0] + dx, z = a[1] + dz;
    if (!w.inBounds(x, z) || !w.isEmpty(w.idx(x, z))) continue;
    const d = autoDepotDir(g, 'road', x, z, -1);
    if (d < 0) continue;
    if (!commitDepot(g, 'road', x, z, d)) { dep = w.depot[w.idx(x, z)]; break; }
  }
  if (dep < 0) continue;
  const l = g.lines.create('road');
  l.stops = [w.station[w.idx(a[0], a[1])], w.station[w.idx(b[0], b[1])]];
  for (let i = 0; i < 3; i++) g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_b')!, l.id);
  lines++;
}
console.log('lines', lines, 'vehicles', g.vehicles.map.size, 'ambient', g.vehicles.ambient.length);
const t0 = performance.now();
const d0 = g.day;
for (let i = 0; i < 20 * 60; i++) g.update(0.05); // 60 s game time
const ms = performance.now() - t0;
console.log('60s game time took', ms.toFixed(0), 'ms =>', (ms / 1200).toFixed(2), 'ms per 50ms step; days', g.day - d0);
const moving = g.vehicles.roads().filter((v) => v.state === 'running').length;
console.log('moving', moving, 'delivered', g.vehicles.all().reduce((s, v) => s + v.delivered, 0));
