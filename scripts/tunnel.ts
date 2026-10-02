// Structures: a railway through a hill (tunnel) and across a valley (bridge) on synthetic terrain; a train
// runs through both, is hidden inside the tunnel, and follows the deck height on the bridge.
// npx esbuild scripts/tunnel.ts --bundle --platform=node --format=esm --outfile=$S/tunnel.mjs && node $S/tunnel.mjs
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { fails, check, build, free, railOpts, nodeNear, fmt } from './lib';
import { nodeSnap, buildRailDepot } from '../src/game/routing';

const g = Game.create({ size: 192, seed: 4, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
g.economy.money = 1e8;
const w = g.world;
// flat land at 3, a ridge (height 12) around x=80 and a valley (height -1, water) around x=120
for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) {
  let h = 3;
  h += Math.max(0, 9 - Math.abs(x - 80) * 0.6);
  if (Math.abs(x - 122) < 9) h = Math.min(h, -1 + Math.abs(x - 122) * 0.4);
  w.h[w.vi(x, z)] = h;
}
for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
// stations at both ends, straight line between them
const pa = g.stations.planRail(30, 96, Math.PI / 2, 12, 1, 0), pb = g.stations.planRail(170, 96, Math.PI / 2, 12, 1, 0);
check(pa.ok && pb.ok, `stations planned ${pa.error ?? ''} ${pb.error ?? ''}`);
const ia = g.stations.nextId; g.stations.commitRail(pa, 0);
const ib = g.stations.nextId; g.stations.commitRail(pb, 0);
const A = g.stations.get(ia)!, B = g.stations.get(ib)!;
const aEnd = nodeNear(g, 'rail', 36, 96, 0.3)!, bEnd = nodeNear(g, 'rail', 164, 96, 0.3)!;
let tunnels = 0, bridges = 0;
const p1 = build(g, nodeSnap(g, aEnd.id, 'rail'), free(g, 100, 96), railOpts(0, 1, { heightOffset: 3 - w.heightAt(100, 96) }), 'through the ridge');
const n1 = nodeNear(g, 'rail', 100, 96, 0.3);
const p2 = n1 ? build(g, nodeSnap(g, n1.id, 'rail'), nodeSnap(g, bEnd.id, 'rail'), railOpts(0), 'across the valley') : null;
for (const p of [p1, p2]) if (p) { tunnels += p.stats.tunnels; bridges += p.stats.bridges; }
console.log(`  track: ${tunnels} tunnel(s), ${bridges} bridge(s); max grade ${fmt(Math.max(p1?.stats.maxGrade ?? 0, p2?.stats.maxGrade ?? 0) * 100, 1)}%`);
check(tunnels >= 1 && bridges >= 1, 'tunnel and bridge built');
const dep = buildRailDepot(g, A, 0, { x: 1, z: 0 });
check(dep >= 0, 'depot built');
const line = g.lines.create('rail', 0);
line.stops = [A.id, B.id];
const t = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], line.id) as Train;
let hidden = 0, onBridge = 0, arrivals = 0, last = '';
const q = { x: 0, y: 0, z: 0 };
for (let i = 0; i < 4 * 400; i++) {
  g.update(0.25);
  if (!t.onMap) continue;
  const at = t.pointBehind(0, q);
  if (at && t.hiddenAt(at.seg, at.sp)) hidden++;
  if (Math.abs(q.x - 122) < 4 && q.y - w.heightAt(q.x, q.z) > 1.5) onBridge++;
  if (t.state === 'loading' && last !== 'loading') arrivals++;
  last = t.state;
}
console.log(`  train: ${arrivals} stops, hidden in tunnel ${hidden} ticks, on the bridge deck ${onBridge} ticks, delivered ${t.delivered}`);
check(arrivals >= 3, 'train shuttles through the structures');
check(hidden > 0, 'train hidden inside the tunnel');
check(onBridge > 0, 'train ran on the bridge deck');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
