import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { commitDepot } from '../src/game/build-ops';

const g = Game.create({ size: 96, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1960 });
const w = g.world;
const L = 3;
for (let i = 0; i < w.hgt.length; i++) w.hgt[i] = L;
for (let t = 0; t < w.size * w.size; t++) w.trees[t] = 0;
const P = { NS: 1, EW: 2, NE: 4, ES: 8, SW: 16, WN: 32 };
const set = (x: number, z: number, m: number) => { w.rail[w.idx(x, z)] |= m; w.markTile(x, z); };
// stations
const A = g.stations.create(11, 20), B = g.stations.create(81, 20);
for (const [st, x0] of [[A, 10], [B, 78]] as const) for (let x = x0; x < x0 + 4; x++) for (const z of [20, 21]) { set(x, z, P.EW); g.stations.addTile(st, w.idx(x, z), 1); }
// throat A at x=14, throat B at x=77
set(14, 20, P.EW | P.ES); set(14, 21, P.WN);
set(77, 20, P.EW | P.SW); set(77, 21, P.NE);
for (let x = 15; x < 77; x++) set(x, 20, P.EW);
// passing loop 40..49 on z=21
set(40, 20, P.SW); set(40, 21, P.NE);
for (let x = 41; x < 49; x++) set(x, 21, P.EW);
set(49, 21, P.WN); set(49, 20, P.ES);
// one-way signals inside the loop: z=20 eastbound only, z=21 westbound only
// piece EW forward = from edge E? PIECE_EDGES[1] = [1,3] => forward is E->W (westbound)
w.signal[w.idx(44, 20)] = 3; // one-way reversed => eastbound (W->E)
w.signal[w.idx(44, 21)] = 2; // one-way forward => westbound (E->W)
// two-way signals at loop entries on the main line
// (no signals on the shared single track)

// depots behind the stations (west of A and east of B)
set(9, 20, P.EW); set(82, 21, 0);
console.log('depA', commitDepot(g, 'rail', 8, 20, 1));
set(82, 20, P.EW);
console.log('depB', commitDepot(g, 'rail', 83, 20, 3));
// road crossing the main line at x=30 (level crossing) with a bus line over it
import { planRoute, commitPlan } from '../src/game/construction';
import { commitBusStop, commitDepot as depot2 } from '../src/game/build-ops';
{
  const p = planRoute(g, 'road', 30, 8, 30, 32);
  console.log('road', p.ok, p.error, commitPlan(g, p), 'crossing tile road/rail', w.road[w.idx(30, 20)], w.rail[w.idx(30, 20)]);
  console.log('stops', commitBusStop(g, 30, 10), commitBusStop(g, 30, 30));
  console.log('bus depot', depot2(g, 'road', 31, 12, 3));
}
const line = g.lines.create('rail');
line.stops = [A.id, B.id];
const deps = [...w.depots.values()];
const mk = (d: number) => g.vehicles.buyTrain(deps[d].id, [MODEL_BY_ID.get('diesel_a')!, MODEL_BY_ID.get('coach_steel')!, MODEL_BY_ID.get('coach_steel')!], line.id) as Train;
const t1 = mk(0), t2 = mk(1), t3 = mk(0);
t2.stopIndex = 1; // second train starts towards B... (it is at B's side)
const bl = g.lines.create('road');
bl.stops = [w.station[w.idx(30, 10)], w.station[w.idx(30, 30)]];
const bdep = [...w.depots.values()].find((d) => d.kind === 'road')!;
const buses = [0, 1, 2].map(() => g.vehicles.buyRoad(bdep.id, MODEL_BY_ID.get('bus_b')!, bl.id) as any);
let passes = 0;
let lastLog = '';
for (let i = 0; i < 20 * 400; i++) {
  g.update(0.1);
  const s = [t1, t2, t3].map((t) => t.state[0]).join('');
  if (i % 400 === 0) {
    const pos = [t1, t2, t3].map((t) => { const p = { x: 0, y: 0, z: 0 }; t.worldPos(p); return `${p.x.toFixed(0)},${p.z.toFixed(0)} ${t.state} ${t.status}`; });
    const line2 = pos.join(' | ');
    if (line2 !== lastLog) { console.log('day', g.day, line2); lastLog = line2; }
  }
}
console.log('bus delivered', buses.map((b: any) => b.delivered), 'bus profit', buses.map((b: any) => Math.round(b.profitYear)));
console.log('bus states', buses.map((b: any) => b.state + ' ' + b.status));
console.log('train states', [t1, t2, t3].map((t) => t.state + ' ' + t.status));
console.log('trips', [t1, t2, t3].map((t) => t.profitYear.toFixed(0)));
