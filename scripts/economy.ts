// Economy balance check: yearly income/costs of typical lines (rail intercity, busy town bus, short/empty lines).
// npx esbuild scripts/economy.ts --bundle --platform=node --format=esm --outfile=$S/economy.mjs && node $S/economy.mjs [seed]
import { Game } from '../src/game/game';
import { MODEL_BY_ID, VehicleModel } from '../src/game/vehicle-types';
import { TRACK_TYPES, ROAD_TYPES } from '../src/game/constants';
import type { Line } from '../src/game/lines';
import { fmt, depotBehind, placeAndConnect, addBusStop, roadDepotNear, Train } from './lib';

const seed = Number(process.argv[2] ?? 7);
const YEARS = 4;
const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
g.economy.money = 1e9;

/** Yearly maintenance of the infrastructure used by a line (edges owned by the player near its stations' routes). */
function lineMaintenance(edges: Set<number>, stations: number[], depots: number[]): number {
  let c = 0;
  for (const id of edges) {
    const e = g.world.net.edges.get(id);
    if (!e) continue;
    const per = e.kind === 'rail' ? (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).maintPerUnit : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).maintPerUnit;
    c += e.len * per;
    for (const s of e.sections) c += (s.s1 - s.s0) * per * (s.type === 'tunnel' ? 4 : 3);
  }
  for (const sid of stations) {
    const st = g.stations.get(sid);
    if (!st) continue;
    if (st.rail) c += 20000 + st.rail.tracks * st.rail.length * 500;
    c += st.stops.length * 3000;
  }
  for (const d of depots) { const dp = g.depots.get(d); if (dp) c += dp.kind === 'rail' ? 12000 : 6000; }
  return c;
}

interface Case { name: string; line: Line; cost: number; maint: number; dist: number }
const cases: Case[] = [];
const newEdges = (before: Set<number>) => new Set([...g.world.net.edges.keys()].filter((id) => !before.has(id) && g.world.net.edges.get(id)!.owner === 0));

// ---- intercity rail, 1 train
{
  const before = new Set(g.world.net.edges.keys());
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {})!;
  const con = pr.con;
  const dep = depotBehind(g, pr.A, pr.B, 0);
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const cars: VehicleModel[] = [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!];
  const t = g.vehicles.buyTrain(dep, cars, line.id);
  if (!(t instanceof Train) || !con.ok) console.log('rail setup failed', con, t);
  cases.push({ name: `rail ${pr.TA.name}-${pr.TB.name} (${fmt(con.len, 0)} u track)`, line, cost: cars.reduce((a, c) => a + c.cost, 0), maint: lineMaintenance(newEdges(before), [pr.A.id, pr.B.id], [dep]), dist: Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z) });
}
// ---- bus lines in the biggest town: busy (2 buses, ~15-20 apart) and short (1 bus, ~6-8 apart)
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const pts: [number, number][] = [];
for (const e of g.towns.streets(big, 0)) {
  if (e.len < 4) continue;
  const p = { x: 0, y: 0, z: 0 };
  g.world.net.pointAt(e, e.len / 2, p);
  const bs = g.stations.planBusStop(p.x, p.z, 0);
  if (bs.ok && !bs.join && pts.every((q) => Math.hypot(q[0] - p.x, q[1] - p.z) > 5)) pts.push([p.x, p.z]);
}
pts.sort((a, b) => Math.hypot(a[0] - big.x, a[1] - big.z) - Math.hypot(b[0] - big.x, b[1] - big.z));
const pick = (minD: number, maxD: number, avoid: [number, number][]): [[number, number], [number, number]] | null => {
  for (const a of pts) for (const b of pts) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d < minD || d > maxD || [a, b].some((p) => avoid.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 14))) continue;
    return [a, b];
  }
  return null;
};
const used: [number, number][] = [];
let busDepot = -1;
for (const [label, minD, maxD, n, model] of [['busy bus', 15, 24, 2, 'bus_c'], ['short bus', 5, 8, 1, 'bus_b']] as const) {
  const pr = pick(minD, maxD, used);
  if (!pr) { console.log('no sites for', label); continue; }
  used.push(...pr);
  const s0 = addBusStop(g, pr[0][0], pr[0][1], 0), s1 = addBusStop(g, pr[1][0], pr[1][1], 0);
  const dep = busDepot >= 0 ? busDepot : (busDepot = roadDepotNear(g, pr[0][0], pr[0][1], 0));
  console.log(`  ${label}: stops ${s0},${s1} depot ${dep}`);
  const line = g.lines.create('road', 0);
  line.stops = [s0, s1];
  const m = MODEL_BY_ID.get(model)!;
  for (let i = 0; i < n; i++) g.vehicles.buyRoad(dep, m, line.id);
  cases.push({ name: `${label} in ${big.name} (${n}x ${m.name})`, line, cost: m.cost * n, maint: lineMaintenance(new Set(), [s0, s1], [dep]), dist: Math.hypot(pr[0][0] - pr[1][0], pr[0][1] - pr[1][1]) });
}
// ---- an empty rail line: two small villages
{
  const small = [...g.towns.list].sort((a, b) => a.pop - b.pop);
  const before = new Set(g.world.net.edges.keys());
  const ex = new Set(g.towns.list.filter((t) => !small.slice(0, 5).includes(t)).map((t) => t.id));
  const pr = placeAndConnect(g, 60, 200, 0, ex, 1, () => {});
  if (pr) {
    const con = pr.con;
    const dep = depotBehind(g, pr.A, pr.B, 0);
    const line = g.lines.create('rail', 0);
    line.stops = [pr.A.id, pr.B.id];
    const cars: VehicleModel[] = [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!];
    console.log(`  village rail: connected ${con.ok} depot ${dep}`);
    if (con.ok && dep > 0) g.vehicles.buyTrain(dep, cars, line.id);
    cases.push({ name: `village rail ${pr.TA.name}(${pr.TA.pop})-${pr.TB.name}(${pr.TB.pop})`, line, cost: cars.reduce((a, c) => a + c.cost, 0), maint: lineMaintenance(newEdges(before), [pr.A.id, pr.B.id], [dep]), dist: Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z) });
  }
}
// ---- simulate
for (let y = 0; y < YEARS; y++) {
  for (let i = 0; i < 4 * 360 * 2; i++) g.update(0.25);
  if (y === 0) continue; // first year is warm-up
}
console.log(`economy (seed ${seed}), last full year ${g.year - 1}; fare model in vehicle.ts`);
for (const c of cases) {
  const inc = c.line.incomeLast, run = c.line.costLast;
  const net = inc - run - c.maint;
  const pax = c.line.passLast;
  console.log('  vehicles: ' + c.line.vehicles.map((id) => { const v = g.vehicles.get(id)!; return v.state + ' ' + v.status + ' d=' + v.delivered; }).join(' | '));
  console.log(`${c.name}, ${fmt(c.dist, 0)} u apart: income ${fmt(inc / 1e3, 0)}k, running ${fmt(run / 1e3, 0)}k, maintenance ${fmt(c.maint / 1e3, 0)}k -> net ${fmt(net / 1e3, 0)}k/yr; vehicles ${fmt(c.cost / 1e3, 0)}k -> payback ${net > 0 ? fmt(c.cost / net, 1) + ' yrs' : 'never'}; pax/month ${pax}`);
}
