import { Game } from '../src/game/game';
import { planRoute, commitPlan } from '../src/game/construction';
import { makeTileSeg } from '../src/game/train';
const g = Game.create({ size: 96, seed: 5, towns: 2, hilliness: 'flat', water: 'low', startYear: 1950 });
const w = g.world;
let ox = -1, oz = -1;
outer: for (let z = 4; z < 80; z++) for (let x = 4; x < 66; x++) {
  let ok = true;
  for (let dz = -1; dz < 10 && ok; dz++) for (let dx = -1; dx < 25; dx++) { const t = w.idx(x + dx, z + dz); if (!w.isEmpty(t) || w.townOf[t] >= 0) { ok = false; break; } }
  if (ok) { ox = x; oz = z; break outer; }
}
for (let cz = oz; cz <= oz + 9; cz++) for (let cx = ox; cx <= ox + 24; cx++) w.setCorner(cx, cz, 3);
console.log('area', ox, oz, w.cornerH(ox, oz));
const base = w.cornerH(ox, oz);
// mesa with steep sides: +6 levels from x+8..x+16
for (let cz = Math.max(1, oz - 18); cz <= Math.min(w.size - 1, oz + 28); cz++) for (let cx = ox + 8; cx <= ox + 16; cx++) w.setCorner(cx, cz, base + 6);
const p = planRoute(g, 'rail', ox + 1, oz + 4, ox + 22, oz + 4);
console.log('ok', p.ok, p.error, 'cost', p.cost, p.steps.map((s) => `${s.x - ox}:${s.hIn}>${s.hOut}${s.link ? '[' + s.link.kind + s.link.span + ']' : ''}`).join(' '));
console.log('commit', commitPlan(g, p));
for (const s of w.structures.values()) console.log(s);
import { planRailStation, commitRailStation, commitDepot } from '../src/game/build-ops';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import type { Train } from '../src/game/train';
{
  // stations on both ends (EW axis), length 2: tiles at x=ox+1..ox+2 and ox+21..ox+22 already have track
  const z = oz + 4;
  const pa = planRailStation(g, ox + 2, z, 1, 2, 1);
  console.log('stA', pa.ok, pa.error, commitRailStation(g, pa));
  const pb = planRailStation(g, ox + 21, z, 1, 2, 1);
  console.log('stB', pb.ok, pb.error, commitRailStation(g, pb));
  // extend track west from station A by 1 and add depot facing east
  const st = planRoute(g, 'rail', pa.x0, z, pa.x0 - 1, z);
  console.log('stub', st.ok, st.error, commitPlan(g, st));
  console.log('depot', commitDepot(g, 'rail', pa.x0 - 2, z, 1));
  const line = g.lines.create('rail');
  line.stops = [w.station[w.idx(pa.x0, z)], w.station[w.idx(pb.x0, z)]];
  const dep = [...w.depots.keys()][0];
  const t = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_a')!, MODEL_BY_ID.get('coach_steel')!, MODEL_BY_ID.get('coach_steel')!], line.id) as Train;
  let last = '';
  let sawTunnel = false;
  for (let i = 0; i < 3000; i++) {
    g.update(0.1);
    if (t.segs.some((s) => s.sid >= 0)) sawTunnel = true;
    if (t.status !== last) { last = t.status; console.log('day', g.day, t.state, t.status); }
  }
  console.log('sawTunnel', sawTunnel, 'delivered', t.delivered, 'profit', Math.round(t.profitYear));
}
