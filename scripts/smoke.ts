// Headless smoke test of the v2 simulation: rail line between two towns, bus line, crossings, signals, growth.
// npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=$S/smoke.mjs && node $S/smoke.mjs
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import {
  fails, check, fmt, connectStations, depotBehind, busStopSites, roadDepotNear, checkReservations, checkNaN, pickTownPair, placeStation,
  Train, RoadVehicle,
} from './lib';

const T0 = performance.now();
const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
console.log(`world: ${g.towns.list.length} towns, ${g.world.net.edges.size} street edges, ${g.world.buildings.size} buildings, gen ${fmt(performance.now() - T0, 0)} ms`);
g.economy.money = 60_000_000;
const pop0 = g.towns.list.map((t) => t.pop);
const bld0 = g.world.buildings.size, edges0 = g.world.net.edges.size;

// ------------------------------------------------------------------ rail line
const pair = pickTownPair(g, 60, 150)!;
const [TA, TB] = pair;
console.log(`rail: ${TA.name} (${TA.pop}) <-> ${TB.name} (${TB.pop}), ${fmt(Math.hypot(TA.x - TB.x, TA.z - TB.z))} units`);
const A = placeStation(g, TA, TB)!;
const B = placeStation(g, TB, TA, 0, 2, 16, { prefY: A.rail!.y, tolY: Math.hypot(TA.x - TB.x, TA.z - TB.z) * 0.012 })!;
check(A && B, 'stations placed');
console.log(`  stations ${A?.name} @${fmt(A.x)},${fmt(A.z)} y=${fmt(A.rail!.y, 2)}  ${B?.name} @${fmt(B.x)},${fmt(B.z)} y=${fmt(B.rail!.y, 2)}`);
const con = connectStations(g, A, B, 0, 1);
const popBuilt = g.towns.list.reduce((a, t) => a + t.pop, 0);
const popB = g.towns.list.map((t) => t.pop);
check(con.ok, 'main line connected');
const depot = depotBehind(g, A, B, 0);
check(depot > 0, 'rail depot built');
const line = g.lines.create('rail', 0);
line.stops = [A.id, B.id];
const loco = MODEL_BY_ID.get('diesel_b')!, coach = MODEL_BY_ID.get('coach_ic')!;
const tr = g.vehicles.buyTrain(depot, [loco, coach, coach, coach], null);
check(tr instanceof Train, 'train bought: ' + (typeof tr === 'string' ? tr : ''));
const train = tr as Train;
if (train instanceof Train) train.setLine(line.id);

// ------------------------------------------------------------------ bus line in the biggest town
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, big, 0, 12, 30);
check(sites.length === 2, 'bus stop sites found');
let bus: RoadVehicle | null = null;
let busLineId = -1;
if (sites.length === 2) {
  const s0 = g.stations.nextId;
  const e1 = g.stations.commitBusStop(sites[0][0], sites[0][1], 0);
  const s1 = g.stations.nextId;
  const e2 = g.stations.commitBusStop(sites[1][0], sites[1][1], 0);
  check(!e1 && !e2, `bus stops built ${e1 ?? ''} ${e2 ?? ''}`);
  const bdep = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  check(bdep > 0, 'road depot built');
  const bl = g.lines.create('road', 0);
  bl.stops = [s0, s1];
  busLineId = bl.id;
  const b = g.vehicles.buyRoad(bdep, MODEL_BY_ID.get('bus_c')!, bl.id);
  check(b instanceof RoadVehicle, 'bus bought ' + (typeof b === 'string' ? b : ''));
  if (b instanceof RoadVehicle) bus = b;
  console.log(`  bus line in ${big.name}: stops ${fmt(Math.hypot(sites[0][0] - sites[1][0], sites[0][1] - sites[1][1]))} apart, depot ${bdep}`);
}

// ------------------------------------------------------------------ simulate
let leftDepot = false, arrivals = { a: 0, b: 0 }, lastAt = -1, busArr = 0, lastBusState = '';
let errors = 0, nanMsg: string | null = null;
const T1 = performance.now();
const days = 720;
const startDay = g.day;
let lastLog = -1;
while (g.day < startDay + days) {
  try { g.update(0.25); } catch (e) { errors++; console.log('EXCEPTION', (e as Error).stack?.split('\n').slice(0, 5).join('\n')); if (errors > 3) break; }
  if (train.onMap) leftDepot = true;
  if (train.state === 'loading' && train.atStation !== lastAt) {
    lastAt = train.atStation;
    if (lastAt === A.id) arrivals.a++; else if (lastAt === B.id) arrivals.b++;
  }
  if (bus && bus.state === 'loading' && lastBusState !== 'loading') busArr++;
  if (bus) lastBusState = bus.state;
  if (!nanMsg) nanMsg = checkNaN(g);
  if (g.day % 90 === 0 && g.day !== lastLog) {
    lastLog = g.day;
    console.log(`  ${g.dateString()}: train ${train.state} "${train.status}" load ${train.load} arr A${arrivals.a}/B${arrivals.b} | bus ${bus?.state} arr ${busArr} | money ${fmt(g.economy.money / 1e6, 2)}M amb ${g.vehicles.ambient.length}`);
  }
}
const simMs = performance.now() - T1;
console.log(`simulated ${days} days in ${fmt(simMs, 0)} ms (${fmt(simMs / days, 2)} ms/day)`);
check(errors === 0, 'no exceptions');
check(!nanMsg, 'no NaN positions ' + (nanMsg ?? ''));
check(leftDepot, 'train left the depot');
check(arrivals.a >= 3 && arrivals.b >= 3, `train served both stations repeatedly (A ${arrivals.a}, B ${arrivals.b})`);
check(A.genLast + A.genMonth > 0 && B.genLast + B.genMonth > 0, 'passengers generated');
check(train.delivered > 0, `train delivered passengers (${train.delivered})`);
check(line.incomeYear + line.incomeLast > 0, 'rail line income > 0');
if (bus) {
  check(busArr >= 4, `bus served its stops (${busArr} stops)`);
  check(bus.delivered > 0, `bus delivered passengers (${bus.delivered})`);
}
const resErr = checkReservations(g);
check(resErr.length === 0, 'reservations consistent ' + resErr.slice(0, 3).join('; '));
console.log(`train: delivered ${train.delivered}, profit this/last year ${fmt(train.profitYear / 1e3, 0)}k/${fmt(train.profitLast / 1e3, 0)}k; line income ${fmt((line.incomeYear + line.incomeLast) / 1e3, 0)}k`);
if (bus) console.log(`bus: delivered ${bus.delivered}, profit ${fmt(bus.profitYear / 1e3, 0)}k/${fmt(bus.profitLast / 1e3, 0)}k, line ${busLineId}`);
for (const st of [A, B]) console.log(`  ${st.name}: catch ${fmt(st.catchPop, 0)} waiting ${st.waitingTotal} rating ${fmt(st.rating, 2)} gen ${st.genLast}`);
const growth = g.towns.list.map((t, i) => t.pop - pop0[i]);
console.log(`towns: pop ${pop0.reduce((a, b) => a + b, 0)} (after construction ${popBuilt}) -> ${g.towns.list.reduce((a, t) => a + t.pop, 0)}, buildings ${bld0} -> ${g.world.buildings.size}, edges ${edges0} -> ${g.world.net.edges.size}`);
check(growth.some((x) => x > 0), 'towns grew');
console.log('  ' + g.towns.list.map((t, i) => `${t.name} ${popB[i]}->${t.pop} (served ${t.served})`).join(', '));

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
