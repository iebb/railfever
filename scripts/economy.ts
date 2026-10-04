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
import { distanceFare, simNow } from '../src/game/fares';
import { RAIL_FARE } from '../src/game/constants';
import { bezLine } from '../src/game/geom';
import { patternHeadways } from '../src/game/patterns';

const seed = Number(process.argv.slice(2).find((s) => !s.startsWith('--')) ?? 7);
const YEARS = 4;
const flag = (name: string) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
// Re-captured after the independent load/payback/village/exploit bands and urban economics passed. Release 2.6
// (d95e283) -> 70% walking limits: rail/tram/bus 33.6/30.8/22.4 -> 23.52/21.56/15.68 units, full coverage 21 -> 14.7,
// weight scale 8 -> 5.6. Local/long-distance generation +20%; urban uplift 6/3/1.5 -> 8/4/2; separate car feeders
// 50% -> 75%, cutoff headway 200 -> 300 s; rail minimum 500 -> 550 once per journey. Growth full reach 0.3 -> 0.4,
// no-call credit 0.15 -> 0.08. Four years, final full year, no AI. Income / operating result, k/year, old -> new:
// intercity 502.7 / +167.5 -> 490.7 / +155.4, busy bus 196.4 / +122.5 -> 175.8 / +101.8,
// short bus 23.1 / -10.7 -> 18.2 / -15.6, village railway 305.2 / -68.4 -> 242.1 / -133.2.
// Intercity and busy-bus full-capital paybacks 51.0 -> 55.0 and 5.6 -> 6.7 years; urban fixtures light rail 3.5 -> 4.6
// and subway 8.3 -> 13.4. Narrower walks intentionally reduce local/village traffic; covered residents and separate
// urban feeders sustain the useful intercity service. No balance checks or queue limits have been loosened.
// These are repeatability checks; the bands below the simulation are the balance checks.
const seed7Baseline = {
  "seed": 7,
  "results": [
    {
      "name": "rail Oldwood-Coldden (104 u track)",
      "income": 490727.68561051134,
      "net": 155353.67224508338
    },
    {
      "name": "busy bus in Oldwood (2x Metro Articulated)",
      "income": 175757.10905794488,
      "net": 101796.7907211971
    },
    {
      "name": "short bus in Oldwood (1x City Liner)",
      "income": 18235.172678850053,
      "net": -15560.166389677128
    },
    {
      "name": "village rail Redwell(345)-Southley(237)",
      "income": 242145.6385487659,
      "net": -133161.3952190478
    }
  ]
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

interface Case { name: string; line: Line; cost: number; maint: number; dist: number; capital: number }
const cases: Case[] = [];
const newEdges = (before: Set<number>) => new Set([...g.world.net.edges.keys()].filter((id) => !before.has(id) && g.world.net.edges.get(id)!.owner === 0));

// ---- intercity rail, 1 train
{
  const money0 = g.economy.money;
  const before = new Set(g.world.net.edges.keys());
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {})!;
  const con = pr.con;
  const dep = depotBehind(g, pr.A, pr.B, 0);
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const cars: VehicleModel[] = [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!];
  const t = g.vehicles.buyTrain(dep, cars, line.id);
  if (!(t instanceof Train) || !con.ok) console.log('rail setup failed', con, t);
  cases.push({ name: `rail ${pr.TA.name}-${pr.TB.name} (${fmt(con.len, 0)} u track)`, line, cost: cars.reduce((a, c) => a + c.cost, 0), maint: lineMaintenance(newEdges(before), [pr.A.id, pr.B.id], [dep]), dist: Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z), capital: money0 - g.economy.money });
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
  const pr = pick(minD, maxD, used), money0 = g.economy.money;
  if (!pr) { console.log('no sites for', label); continue; }
  used.push(...pr);
  const s0 = addBusStop(g, pr[0][0], pr[0][1], 0), s1 = addBusStop(g, pr[1][0], pr[1][1], 0);
  const dep = busDepot >= 0 ? busDepot : (busDepot = roadDepotNear(g, pr[0][0], pr[0][1], 0));
  console.log(`  ${label}: stops ${s0},${s1} depot ${dep}`);
  const line = g.lines.create('road', 0);
  line.stops = [s0, s1];
  const m = MODEL_BY_ID.get(model)!;
  for (let i = 0; i < n; i++) g.vehicles.buyRoad(dep, m, line.id);
  cases.push({ name: `${label} in ${big.name} (${n}x ${m.name})`, line, cost: m.cost * n, maint: lineMaintenance(new Set(), [s0, s1], [dep]), dist: Math.hypot(pr[0][0] - pr[1][0], pr[0][1] - pr[1][1]), capital: money0 - g.economy.money });
}
// ---- an empty rail line: two small villages
{
  const small = [...g.towns.list].sort((a, b) => a.pop - b.pop), money0 = g.economy.money;
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
    cases.push({ name: `village rail ${pr.TA.name}(${pr.TA.pop})-${pr.TB.name}(${pr.TB.pop})`, line, cost: cars.reduce((a, c) => a + c.cost, 0), maint: lineMaintenance(newEdges(before), [pr.A.id, pr.B.id], [dep]), dist: Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z), capital: money0 - g.economy.money });
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
const results: { name: string; income: number; boardings: number; load: number; net: number; capital: number }[] = [];
for (const c of cases) {
  const inc = c.line.incomeLast, run = c.line.costLast;
  const net = inc - run - c.maint;
  const mm = months.get(c.line.id)!, ll = loads.get(c.line.id)!;
  const pax = mm.reduce((a, b) => a + b, 0), load = ll.reduce((a, b) => a + b, 0) / Math.max(1, ll.length);
  results.push({ name: c.name, income: inc, boardings: pax, load, net, capital: c.capital });
  console.log('  access: ' + c.line.stops.map((id) => { const st = g.stations.get(id)!; return `${fmt(st.catchPop, 0)} walking / ${fmt(g.demand.generationPopulation(st), 0)} eligible`; }).join(' | ') + '; headway ' + patternHeadways(g, c.line).map((p) => fmt(p.headway, 0)).join('/') + 's');
  console.log('  vehicles: ' + c.line.vehicles.map((id) => { const v = g.vehicles.get(id)!; return v.state + ' ' + v.status + ' d=' + v.delivered; }).join(' | '));
  console.log(`${c.name}, ${fmt(c.dist, 0)} u apart: income ${fmt(inc / 1e3, 0)}k, running ${fmt(run / 1e3, 0)}k, maintenance ${fmt(c.maint / 1e3, 0)}k -> net ${fmt(net / 1e3, 0)}k/yr; vehicles ${fmt(c.cost / 1e3, 0)}k -> payback ${net > 0 ? fmt(c.cost / net, 1) + ' yrs' : 'never'}, full capital ${fmt(c.capital / 1e3, 0)}k -> ${net > 0 ? fmt(c.capital / net, 1) + ' yrs' : 'never'}; boardings ${fmt(pax / 12, 1)}/month avg (${pax}/year), load ${fmt(load * 100, 1)}%`);
}
const yr = g.economy.yearTotals[g.economy.yearTotals.length - 1];
console.log(`company ${yr.year}: ` + CATEGORIES.filter((k) => yr.v[k]).map((k) => `${k} ${fmt(yr.v[k] / 1e3, 0)}k`).join(', '));
// Independent balance bands (not the captured baseline): loads, and paybacks of the full capital (track, stations,
// depot and vehicles against the operating result), so that a recalibration cannot hide a regression.
if (seed === 7) {
  const r = (prefix: string) => results.find((x) => x.name.startsWith(prefix));
  const payback = (x: { net: number; capital: number }) => (x.net > 0 ? x.capital / x.net : Infinity);
  const ic = r('rail '), bus = r('busy bus'), village = r('village rail');
  if (ic) {
    check(ic.load >= 0.1 && ic.load <= 0.8, `intercity rail between towns of 2,500 and 1,600 runs 10-80% full (${fmt(ic.load * 100, 1)}%)`);
    // (one train on a line over hilly ground, five bridges and three tunnels: civil works last a century)
    check(ic.net > 0 && payback(ic) <= 60, `intercity rail repays its full capital within 60 years (${fmt(payback(ic), 1)})`);
  }
  if (bus) {
    check(bus.load >= 0.15 && bus.load <= 0.8, `a busy town bus runs 15-80% full (${fmt(bus.load * 100, 1)}%)`);
    check(payback(bus) >= 1.5 && payback(bus) <= 8, `a busy town bus repays its full capital in 1.5-8 years (${fmt(payback(bus), 1)})`);
  }
  if (village) check(village.net < 0, `a railway between two villages does not pay its way (${fmt(village.net / 1e3, 0)}k a year)`);
}
// Exploit check: one journey split over transfers earns about what the direct ride does (the rail minimum is paid
// once per journey: fares.ts railLegFare, the journey's rail fares so far carried in its waiting and cargo groups).
{
  const h = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000 });
  h.aiEnabled = false; h.world.h.fill(4); h.world.heightsVersion++;
  const net = h.world.net, a = net.addNode('road', 20, 4, 60, 0, 0, -1), b = net.addNode('road', 200, 4, 60, 0, 0, -1);
  net.addEdge('road', a.id, b.id, bezLine(20, 60, 200, 60), new Float32Array(181).fill(4), [], 'street', -1);
  const ids = [40, 52, 64, 76, 88].map((x) => addBusStop(h, x, 60, 0));
  const train = new Train(h, 100, [MODEL_BY_ID.get('diesel_b')!], -1);
  h.tick = 4000;
  const now = simNow(h);
  let rail = 0;
  const settle = (from: number, to: number, dest: number, seconds: number, transfers: number) => {
    train.cargo.clear(); train.load = 1;
    train.cargo.set('x', rail ? { from, alight: to, dest, count: 1, day: h.day, t0: now - seconds, transfers, rail } : { from, alight: to, dest, count: 1, day: h.day, t0: now - seconds, transfers });
    const before = train.incomeYear, A = h.stations.get(from)!, B = h.stations.get(to)!;
    train.serveStation(B, 0);
    rail += distanceFare(Math.hypot(A.x - B.x, A.z - B.z));
    return train.incomeYear - before;
  };
  const journey = () => {
    rail = 0;
    const direct = settle(ids[0], ids[4], ids[4], 160, 0);
    rail = 0;
    // (leg i after i changes of vehicle, each leg but the last ending in another: each change takes 10% off the leg
    // ending in it and the later legs, fares.ts TRANSFER_FARE_FACTOR)
    return { direct, split: [0, 1, 2, 3].reduce((n, i) => n + settle(ids[i], ids[i + 1], ids[4], 40, i), 0) };
  };
  const { direct, split } = journey();
  // the same without any minimum: short legs earn a little more per unit by the distance curve alone
  const minimum = RAIL_FARE.minimum;
  RAIL_FARE.minimum = 0;
  const plain = journey();
  RAIL_FARE.minimum = minimum;
  console.log(`exploit check: a 480 m journey by rail in 160 s earns ${fmt(direct, 0)} direct, ${fmt(split, 0)} over four transfers (${fmt(split / direct, 2)}x; ${fmt(plain.split / plain.direct, 2)}x by the distance fares alone)`);
  check(ids.every((id) => id >= 0) && split / direct <= Math.max(1.25, (plain.split / plain.direct) * 1.05),
    `splitting a journey over transfers earns no more than the distance fares make it (${fmt(split / direct, 2)}x; a minimum on every leg made it 4.25x)`);
}
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
