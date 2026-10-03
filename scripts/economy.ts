// Economy balance check: yearly income/costs of typical lines (rail intercity, busy town bus, short/empty lines).
// Fares and costs: fares.ts (distance x value of time: waiting + riding vs walking / driving), opcosts.ts (vehicle
// overheads, crew, energy, maintenance; track base upkeep + wear). Line maintenance below is the base upkeep of
// the line's infrastructure (Game.edgeMaintenance / stationMaintenance); track wear is in the company totals.
// npx esbuild scripts/economy.ts --bundle --platform=node --format=esm --outfile=$S/economy.mjs && node $S/economy.mjs [seed]
// Seed 7 checks the catchment-calibrated incomes below. --json=/path/before.json saves another seed's exact results;
// --baseline=/path/before.json checks each income stays within 15% of that baseline instead.
import { readFileSync, writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { MODEL_BY_ID, VehicleModel } from '../src/game/vehicle-types';
import { CATEGORIES } from '../src/game/economy';
import type { Line } from '../src/game/lines';
import { fmt, depotBehind, placeAndConnect, addBusStop, roadDepotNear, Train, check, fails } from './lib';

const seed = Number(process.argv.slice(2).find((s) => !s.startsWith('--')) ?? 7);
const YEARS = 4;
const flag = (name: string) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
// Measured with the doubled street-walking reach (rail 336 m for every track type, bus 224 m, before the 1.25 grid
// allowance; residents beyond 210 m partly covered), one rail fare and the town growth recalibrated for it. Four
// years, final full year, no AI. Income / operating result, k a year, v2.5 (b7dfcc3) -> now: intercity rail 95.4 / -242
// -> 495.3 / +160, busy bus 113.7 / +40 -> 225.7 / +151, short bus 8.7 / -25 -> 22.7 / -11, village rail 226.3 / -139
// -> 302.6 / -71; boardings a year 46 -> 231, 231 -> 473, 59 -> 150, 70 -> 82. (The previous baseline held incomes
// 89.1 / 100.7 / 8.8 / 207.3 and no operating results, so its profit checks compared with NaN and failed.) The
// intercity stations sit at the town edges, where the doubled reach first takes in much of Coldden; the busy bus now
// pays back its two buses in about 3.6 years, the intercity line its train in 9.4.
const seed7Baseline = {
  seed: 7, results: [
    {"name": "rail Oldwood-Coldden (104 u track)", "income": 495250.35209041135, "net": 159993.16202841047},
    {"name": "busy bus in Oldwood (2x Metro Articulated)", "income": 225670.58011157747, "net": 151397.7358406316},
    {"name": "short bus in Oldwood (1x City Liner)", "income": 22679.010597900255, "net": -11123.100097258226},
    {"name": "village rail Redwell(345)-Southley(237)", "income": 302585.1612691777, "net": -71039.67326408514},
  ],
};
const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
g.economy.money = 1e9;

/** Yearly base maintenance of the infrastructure used by a line (edges owned by the player near its stations' routes). */
function lineMaintenance(edges: Set<number>, stations: number[], depots: number[]): number {
  let c = 0;
  for (const id of edges) {
    const e = g.world.net.edges.get(id);
    if (e) c += g.edgeMaintenance(e);
  }
  for (const sid of stations) {
    const st = g.stations.get(sid);
    if (st) c += g.stationMaintenance(st);
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
const months = new Map<number, number[]>(), loads = new Map<number, number[]>();
for (let y = 0; y < YEARS; y++) {
  // Measure a whole final year; a rail station may have zero visits in the last month alone.
  for (const c of cases) { months.set(c.line.id, []); loads.set(c.line.id, []); }
  let ticks = 0;
  while (g.day < (y + 1) * 360) {
    const day = g.day;
    g.update(0.25);
    if (g.day !== day && g.day % 30 === 0) for (const c of cases) months.get(c.line.id)!.push(c.line.passLast);
    if (++ticks % 4 === 0) for (const c of cases) for (const id of c.line.vehicles) {
      const v = g.vehicles.get(id);
      if (v && v.capacity > 0 && ['running', 'loading', 'waiting'].includes(v.state)) loads.get(c.line.id)!.push(v.load / v.capacity);
    }
  }
}
console.log(`economy (seed ${seed}), last full year ${g.year - 1}; fares.ts / opcosts.ts`);
const results: { name: string; income: number; boardings: number; load: number; net: number }[] = [];
for (const c of cases) {
  const inc = c.line.incomeLast, run = c.line.costLast;
  const net = inc - run - c.maint;
  const mm = months.get(c.line.id)!, ll = loads.get(c.line.id)!;
  const pax = mm.reduce((a, b) => a + b, 0), load = ll.reduce((a, b) => a + b, 0) / Math.max(1, ll.length);
  results.push({ name: c.name, income: inc, boardings: pax, load, net });
  console.log('  vehicles: ' + c.line.vehicles.map((id) => { const v = g.vehicles.get(id)!; return v.state + ' ' + v.status + ' d=' + v.delivered; }).join(' | '));
  console.log(`${c.name}, ${fmt(c.dist, 0)} u apart: income ${fmt(inc / 1e3, 0)}k, running ${fmt(run / 1e3, 0)}k, maintenance ${fmt(c.maint / 1e3, 0)}k -> net ${fmt(net / 1e3, 0)}k/yr; vehicles ${fmt(c.cost / 1e3, 0)}k -> payback ${net > 0 ? fmt(c.cost / net, 1) + ' yrs' : 'never'}; boardings ${fmt(pax / 12, 1)}/month avg (${pax}/year), load ${fmt(load * 100, 1)}%`);
}
const yr = g.economy.yearTotals[g.economy.yearTotals.length - 1];
console.log(`company ${yr.year}: ` + CATEGORIES.filter((k) => yr.v[k]).map((k) => `${k} ${fmt(yr.v[k] / 1e3, 0)}k`).join(', '));
const baselinePath = flag('baseline');
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) as typeof seed7Baseline : seed === 7 ? seed7Baseline : undefined;
if (baseline) {
  check(baseline.seed === seed, 'income baseline uses the same seed');
  for (const r of results) {
    const b = baseline.results.find((s) => s.name === r.name);
    check(!!b, `baseline contains ${r.name}`);
    if (b) {
      const ratio = r.income / Math.max(1, b.income);
      console.log(`  income before -> after ${r.name}: ${fmt(b.income / 1000)}k -> ${fmt(r.income / 1000)}k (${fmt((ratio - 1) * 100, 1)}%)`);
      check(ratio >= 0.85 && ratio <= 1.15, `${r.name} income within 15% of baseline`);
      const profitChange = Math.abs(r.net - b.net) / Math.max(1, Math.abs(b.net));
      check(profitChange <= 0.15, `${r.name} operating result within 15% of baseline`);
    }
  }
}
const json = flag('json');
if (json) writeFileSync(json, JSON.stringify({ seed, results }, null, 2) + '\n');
process.exitCode = fails.length ? 1 : 0;
