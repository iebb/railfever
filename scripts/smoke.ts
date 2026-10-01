import { Game } from '../src/game/game';
import { planRoute, commitPlan } from '../src/game/construction';
import { planRailStation, commitRailStation, commitDepot, commitBusStop, planBusStop } from '../src/game/build-ops';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';

const t0 = performance.now();
const g = Game.create({ size: 128, seed: 7, towns: 9, hilliness: 'hilly', water: 'medium', startYear: 1950 });
console.log('gen ms', (performance.now() - t0).toFixed(0));
for (const t of g.towns.list) console.log(t.name, t.x, t.z, 'pop', t.pop, 'bld', t.buildings.size, 'roads', t.roads.length);
let water = 0; for (let z = 0; z < 128; z++) for (let x = 0; x < 128; x++) if (g.world.isWater(x, z)) water++;
console.log('water tiles', water);

// pick two towns 25..60 apart
let A = g.towns.list[0], B = g.towns.list[1], bestD = 1e9;
for (const a of g.towns.list) for (const b of g.towns.list) {
  if (a === b) continue;
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  if (d > 25 && d < 60 && Math.abs(d - 40) < bestD) { bestD = Math.abs(d - 40); A = a; B = b; }
}
console.log('A', A.name, 'B', B.name, Math.hypot(A.x - B.x, A.z - B.z).toFixed(1));
const axis = Math.abs(A.x - B.x) > Math.abs(A.z - B.z) ? 1 : 0;
function placeStation(town: typeof A) {
  for (let r = 3; r < 12; r++) for (let k = 0; k < 40; k++) {
    const ang = (k / 40) * Math.PI * 2;
    const x = Math.round(town.x + Math.cos(ang) * r), z = Math.round(town.z + Math.sin(ang) * r);
    const p = planRailStation(g, x, z, axis, 4, 1);
    if (!p.ok) continue;
    let free = true;
    for (let k = 1; k <= 3; k++) {
      const a = axis === 1 ? [p.x0 - k, p.z0] : [p.x0, p.z0 - k];
      const b = axis === 1 ? [p.x1 + k, p.z0] : [p.x0, p.z1 + k];
      for (const c of [a, b]) if (!g.world.inBounds(c[0], c[1]) || !g.world.isEmpty(g.world.idx(c[0], c[1])) || g.world.isWater(c[0], c[1])) free = false;
    }
    if (free) { const e = commitRailStation(g, p); if (!e) return p; }
  }
  return null;
}
const pa = placeStation(A)!, pb = placeStation(B)!;
console.log('stations', pa && [pa.x0, pa.z0, pa.x1, pa.z1], pb && [pb.x0, pb.z0, pb.x1, pb.z1]);
// connect: choose closest ends
const endsA = axis === 1 ? [[pa.x0, pa.z0], [pa.x1, pa.z0]] : [[pa.x0, pa.z0], [pa.x0, pa.z1]];
const endsB = axis === 1 ? [[pb.x0, pb.z0], [pb.x1, pb.z0]] : [[pb.x0, pb.z0], [pb.x0, pb.z1]];
let best: any = null;
for (const ea of endsA) for (const eb of endsB) {
  const d = Math.hypot(ea[0] - eb[0], ea[1] - eb[1]);
  if (!best || d < best.d) best = { d, ea, eb };
}
const t1 = performance.now();
const plan = planRoute(g, 'rail', best.ea[0], best.ea[1], best.eb[0], best.eb[1]);
console.log('plan ms', (performance.now() - t1).toFixed(0), 'ok', plan.ok, plan.error, 'steps', plan.steps.length, 'cost', plan.cost,
  'links', plan.steps.filter((s) => s.link).map((s) => s.link!.kind + s.link!.span));
console.log('commit', commitPlan(g, plan));
// depot behind station A's other end
const DX = [0, 1, 0, -1], DZ = [-1, 0, 1, 0];
let depotOk = false;
outer: for (const [ends, pp] of [[endsA, pa], [endsB, pb]] as const) {
  for (const e of ends) {
    const d = axis === 1 ? (e[0] === pp.x0 ? 3 : 1) : (e[1] === pp.z0 ? 0 : 2);
    const t1 = g.world.idx(e[0] + DX[d], e[1] + DZ[d]);
    if (g.world.rail[t1]) continue;
    for (let r = 2; r <= 5; r++) for (let off = -3; off <= 3; off++) {
      const px = e[0] + DX[d] * r + (axis === 0 ? off : 0), pz = e[1] + DZ[d] * r + (axis === 1 ? off : 0);
      if (!g.world.inBounds(px, pz) || !g.world.isEmpty(g.world.idx(px, pz))) continue;
      const ddx = e[0] - px, ddz = e[1] - pz;
      const dir = Math.abs(ddx) > Math.abs(ddz) ? (ddx > 0 ? 1 : 3) : (ddz > 0 ? 2 : 0);
      if (commitDepot(g, 'rail', px, pz, dir)) continue;
      const p2 = planRoute(g, 'rail', px, pz, e[0], e[1]);
      console.log('depot at', px, pz, 'dir', dir, 'route', p2.ok, p2.error, p2.steps.length);
      if (p2.ok && !commitPlan(g, p2)) { depotOk = true; break outer; }
    }
  }
}
const line = g.lines.create('rail');
line.stops = [pa.join ? pa.join.id : g.world.station[g.world.idx(pa.x0, pa.z0)], g.world.station[g.world.idx(pb.x0, pb.z0)]];
const depotId = [...g.world.depots.keys()][0];
const tr = g.vehicles.buyTrain(depotId, [MODEL_BY_ID.get('diesel_a')!, MODEL_BY_ID.get('coach_steel')!, MODEL_BY_ID.get('coach_steel')!, MODEL_BY_ID.get('coach_steel')!], line.id) as Train;
console.log('bought', typeof tr === 'string' ? tr : tr.name, 'money', g.economy.money);
const t2 = performance.now();
let lastStatus = '';
for (let i = 0; i < 20 * 3600; i++) {
  g.update(0.1);
  if (typeof tr !== 'string' && tr.status !== lastStatus) { lastStatus = tr.status; if (g.day < 40) console.log('day', g.day, tr.state, tr.status, 'load', tr.load, 'speed', tr.speedKmh.toFixed(0)); }
  if (i % 7200 === 0) console.log('year', g.year, 'money', Math.round(g.economy.money), 'pop', g.towns.list.reduce((a, t) => a + t.pop, 0), 'A', A.pop, 'B', B.pop, 'amb', g.vehicles.ambient.length);
}
console.log('sim ms', (performance.now() - t2).toFixed(0), 'day', g.day, 'money', Math.round(g.economy.money), 'profit', Math.round((tr as Train).profitYear + (tr as Train).profitLast));
for (const st of g.stations.all()) console.log(st.name, 'catch', st.catchPop.toFixed(0), 'waiting', st.waitingTotal, 'rating', st.rating.toFixed(2), 'genLast', st.genLast);
for (const t of g.towns.list) console.log(t.name, 'pop', t.pop);
