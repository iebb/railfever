import { lineTable as startupTable, patternOf as startupPattern } from '../src/game/patterns';
import type { Vehicle as StartupVehicle } from '../src/game/vehicle';
// Realistic operations (UPDATE 9j / 9k): fares with the value of time (walk / bus / train / HSR speed factors,
// waiting, the wait cap, the no-transfer bonus), operating costs (monthly breakdown sums, HSR vs intercity per
// train-km, energy per seat-km, a busy vs a poorly used HSR line), service patterns on a double-track line with
// through stations (expresses pass, boarding only on stopping patterns, the overtaking hold, a short-turn),
// one line per route (canonicalizeLines), routing that prefers direct services, and an exact save round trip.
// npx esbuild scripts/economy-ops.ts --bundle --platform=node --format=esm --outfile=$S/eo.mjs && node $S/eo.mjs
import type { Game } from '../src/game/game';
import { MODEL_BY_ID, VehicleModel } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import type { Station } from '../src/game/stations';
import type { Line } from '../src/game/lines';
import { outAndBack } from '../src/game/lines';
import { finishDoubleTrack, planStationOnTrack, commitStationOnTrack, normaliseCrossovers } from '../src/game/trackops';
import { autoSignalNetwork } from '../src/game/signals';
import { serialize, deserialize } from '../src/game/save';
import { Economy, CATEGORIES, operatingCosts } from '../src/game/economy';
import {
  refTime, speedFactor, fareFor, walkTime, tripFactor, estimateLegFare, estimateLegTime, legacyFare, simNow, NO_TRANSFER_BONUS,
  WAIT_CAP_HEADWAYS, SPEED_MAX, SPEED_MAX_SHORT, SPEED_MIN, fareCalibration,
} from '../src/game/fares';
import { estimateCostPerTrainKm, estimateVehicleYear, trackBasePerUnit, YEAR_S, KmCost } from '../src/game/opcosts';
import { PASSENGER_RATE_SCALE } from '../src/game/constants';
import {
  addPattern, setVehiclePattern, canonicalizeLines, linePatterns, patternStops, suggestExpress, patternHeadway,
  HOLD_MAX_S, PLATFORM_PASS_KMH, TRANSFER_PENALTY_S,
} from '../src/game/patterns';
import { flatGame, station, endNode, newTrack, depotFor, check, fmt, build, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
const M = (id: string) => MODEL_BY_ID.get(id)!;
const k = (x: number) => `${fmt(x / 1000, 1)}k`;
/** Passengers for `dest` start waiting at `from` (routed by the line graph, as generated passengers are). */
function inject(g: Game, from: Station, dest: Station, n: number) {
  const hop = g.lines.nextHop(from.id, dest.id);
  if (hop) g.lines.distribute(hop, n, (line, c) => g.stations.addWaiting(from, line, hop.alight, dest.id, c));
}
/** A synthetic rail model (for estimates only). */
const syn = (id: string, o: Partial<VehicleModel>): VehicleModel => ({ id, name: id, kind: 'loco', intro: 1900, retire: 2100, speed: 160, capacity: 0, power: 5000, weight: 85, cost: 3e6, running: 120_000, length: 1.9, style: 'electric', color: 0, traction: 'electric', ...o } as VehicleModel);

// ------------------------------------------------------------------ 1. fares: the value of time
{
  console.log('fares');
  // the alternative: walking for short trips, the car (walk to it, parking) beyond ~300 m
  check(Math.abs(refTime(20) - walkTime(20)) / walkTime(20) < 0.05, `200 m: walking is the alternative (ref ${fmt(refTime(20), 0)} s, walk ${fmt(walkTime(20), 0)} s)`);
  check(refTime(1000) < walkTime(1000) * 0.3, `10 km: the car (ref ${fmt(refTime(1000), 0)} s)`);
  const walk = speedFactor(20, walkTime(20)); // as slow as walking
  const bus = speedFactor(20, 20 + 30); // 200 m: 20 s wait, 30 s ride
  const train = speedFactor(150, 60 + 70); // 1.5 km: 60 s wait, 70 s ride
  const slow = speedFactor(150, 900); // a slow, infrequent service (slower than driving)
  const ic = speedFactor(1200, 300 + 600), hsr = speedFactor(1200, 300 + 260); // 12 km, 5 min wait: 72 vs 166 km/h
  console.log(`  speed factors: walk-speed ${fmt(walk, 2)}, bus ${fmt(bus, 2)}, train ${fmt(train, 2)}, slow train ${fmt(slow, 2)}, IC 12 km ${fmt(ic, 2)}, HSR 12 km ${fmt(hsr, 2)}`);
  check(walk > 0.9 && walk < 1.15, 'a service as slow as walking: factor ~1');
  check(bus > 1.4 && train > 1.4, 'a frequent bus / train beats walking or driving: factor > 1.4');
  check(slow < 0.8, 'slower than the car: factor < 0.8');
  check(hsr > ic * 1.25, 'HSR earns clearly more than a slower intercity over the same distance');
  // (the cap: a few minutes saved on a walk in town are worth less, SPEED_MAX_SHORT up to SHORT_TRIP, SPEED_MAX from 3x that)
  check(speedFactor(1200, 1) === SPEED_MAX && speedFactor(50, 1) === SPEED_MAX_SHORT && speedFactor(150, 1e6) === SPEED_MIN, 'factor clamped to 0.35..1.8 on short trips, ..2.6 on long ones');
  // waiting counts: the same ride after a longer wait pays less
  const f1 = fareFor(150, 30 + 70, 100), f2 = fareFor(150, 300 + 70, 100), f3 = fareFor(150, 900 + 70, 100);
  console.log(`  100 pax, 1.5 km, 70 s ride: wait 30 s ${k(f1)}, 300 s ${k(f2)}, 900 s ${k(f3)}`);
  check(f1 > f2 && f2 > f3, 'longer waits, lower fares');
  check(Math.abs(f3 / f2 - Math.pow(370 / 970, 0.55)) < 0.01, 'fare ratio = (leg time ratio)^0.55 (below the cap)');
  // demand elasticity and estimates
  check(tripFactor(100, 1000) === 2.5 && tripFactor(1e6, 100) === 0.3 && Math.abs(tripFactor(400, 400) - 1) < 1e-9, 'tripFactor (ref/time)^0.7 clamped 0.3..2.5');
  const expected = fareFor(500, estimateLegTime(500, 120, 200), 1);
  check(Math.abs(estimateLegFare(500, 120, 200, 1, 1.15, true, false) - expected * (1 + NO_TRANSFER_BONUS)) < 1e-9 && estimateLegTime(500, 120, 200) > 100 + 5000 / (120 / 3.6), 'boarding-based direct estimate includes the actual no-transfer bonus');
  check(Math.abs(estimateLegFare(500, 120, 200, 8, 1.15, false, false) - expected * 8) < 1e-9, 'actual boarding estimates count people once, and omit the bonus on a transfer leg');
  check(estimateLegFare(500, 120, 200) === estimateLegFare(500, 120, 200, 4, 1.15, true, false), 'project OD capture is bounded at four boardings per potential trip');
  check(estimateLegFare(20, 25, 60) < estimateLegFare(20, 25, 60, 1, 1.15, true, false) * 1.25, 'nearby urban OD trips need little capture normalisation');
  const old = (d: number, days: number) => (d * d) / (d + 8) * 9.5 * (0.8 + 0.35 * Math.min(1, Math.max(0, (d / Math.max(0.4, days) - 2) / 8)));
  const lr = [60, 150, 400].map((d) => legacyFare(d, d / 4, 1) / fareCalibration(d) / old(d, d / 4));
  console.log(`  legacy fare() vs v2.2 at 4 units/day, before fare compensation: ${lr.map((x) => fmt(x, 2)).join(' / ')}`);
  check(lr.every((x) => x > 0.6 && x < 1.6), 'legacy wrapper preserves the old distance/time balance before fare compensation');
}

// Small calibrated queues must retain people across many destinations and keep transfer counts bounded.
{
  const h = flatGame(384), st = station(h, 60, 100, Math.PI / 2, 12, 2)!;
  st.catchPop = 2000;
  for (let dest = 0; dest < 200; dest++) h.stations.addWaiting(st, 0, dest, dest, 1, 0, 10, dest % 2);
  h.stations.trimWaiting(st, 1000);
  const groups = [...st.waiting.values()];
  check(st.waitingTotal >= 30 && st.waitingTotal <= 100, 'a 2,000-person catchment has tens of waiting passengers, not hundreds');
  check(groups.length === st.waitingTotal && groups.reduce((n, x) => n + x.count, 0) === st.waitingTotal, 'many single-person OD groups survive proportional trimming without rounding loss');
  check(groups.every((x) => x.t === 10 && (x.transfers ?? 0) <= x.count), 'queue trimming retains waiting times and bounded transfer counts');
  h.stations.trimWaiting(st, 0);
  check(st.waitingTotal === 0 && st.waiting.size === 0, 'zero queue cap empties all groups');
}

// ------------------------------------------------------------------ 2. costs: HSR vs intercity per train-km
const ic: VehicleModel[] = [syn('x_eloco160', { speed: 160, power: 5600, weight: 86, running: 110_000 }), ...Array(5).fill(M('coach_ic'))];
const hsr300 = MODEL_BY_ID.get('hsr_c') ? [M('hsr_c')] : [syn('x_hsr300', { kind: 'emu', speed: 300, power: 7000, weight: 280, capacity: 460, length: 11, unitCars: 6, running: 330_000 })];
const hsr400 = MODEL_BY_ID.get('hsr_e') ? [M('hsr_e')] : [syn('x_hsr400', { kind: 'emu', speed: 400, power: 10500, weight: 290, capacity: 480, length: 11, unitCars: 6, running: 390_000 })];
{
  console.log('operating costs per train-km');
  const show = (n: string, c: KmCost) => console.log(`  ${n}: ${k(c.variable)}/km = energy ${k(c.energy)} + maintenance ${k(c.maint)} + crew ${k(c.crew)} + track wear ${k(c.wear)}; ${fmt(c.kwhPerKm, 1)} kWh/km, ${fmt(c.kwhPerSeatKm * 1000, 1)} Wh/seat-km; overheads ${k(c.overheadPerYear)}/yr`);
  const cI = estimateCostPerTrainKm(ic, 160, 2010), c3 = estimateCostPerTrainKm(hsr300, 300, 2010), c4 = estimateCostPerTrainKm(hsr400, 400, 2010);
  show('IC 160 (electric loco + 5 coaches)', cI); show(`HSR 300 (${hsr300[0].name})`, c3); show(`HSR 400 (${hsr400[0].name})`, c4);
  // energy per seat-km of the same set at 400 vs 300 km/h (and of the 400 km/h set vs the 300 km/h one)
  const s3 = estimateCostPerTrainKm(hsr400, 300, 2010);
  const r3 = c3.variable / cI.variable, r4 = c4.variable / cI.variable, e = c4.kwhPerSeatKm / s3.kwhPerSeatKm - 1, em = c4.kwhPerSeatKm / c3.kwhPerSeatKm - 1;
  console.log(`  ratios per train-km: 300/160 ${fmt(r3, 2)}x, 400/160 ${fmt(r4, 2)}x; energy per seat-km at 400 vs 300 km/h +${fmt(e * 100, 0)}% (same set), +${fmt(em * 100, 0)}% (400 km/h set vs 300 km/h set)`);
  check(r3 > 1.6 && r3 < 2.6, 'a 300 km/h HSR costs ~2x an electric intercity per train-km');
  check(r4 > 2.8 && r4 < 4.3, 'a 400 km/h HSR ~3-4x');
  check(e > 0.55 && e < 0.85, 'energy per seat-km +60-80% at 400 vs 300 km/h');
  check(trackBasePerUnit('highspeed') >= 2.9 * trackBasePerUnit('standard'), `high-speed track upkeep ~3x standard (${fmt(trackBasePerUnit('highspeed'), 0)} vs ${fmt(trackBasePerUnit('standard'), 0)} per unit and year)`);
  // a typical year keeps the old balance: diesel intercity, bus
  const y1 = estimateVehicleYear([M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')], 120, 1980), y2 = estimateVehicleYear([M('bus_c')], 25, 1990);
  console.log(`  typical year: diesel IC ${k(y1.total)} (running said 114k; ${fmt(y1.km, 1)} km), articulated bus ${k(y2.total)} (said 32k)`);
  check(Math.abs(y1.total / 114_000 - 1) < 0.35 && Math.abs(y2.total / 32_000 - 1) < 0.35, 'typical yearly costs near the models\' running costs');
  // old saves: records without the new categories load and display
  const eco = Economy.fromJSON({ money: 1, loan: 0, current: { running: -5, maintenance: -7, income: 20 }, months: [{ year: 1990, month: 1, v: { running: -3 } }] });
  check(eco.current.running === -5 && eco.current.maintenance === -7 && eco.current.crew === 0 && eco.months[0].v.energy === 0 && CATEGORIES.includes('running') && CATEGORIES.includes('trackWear'), 'old economy records load (new categories 0)');
}

// ------------------------------------------------------------------ 3. a double-track line with two through stations: patterns
console.log('service patterns');
const g = flatGame(384);
const net = g.world.net;
const Z = 192;
const A = station(g, 30, Z, Math.PI / 2, 12, 2)!, D = station(g, 354, Z, Math.PI / 2, 12, 2)!;
const e0 = net.nextEdge;
build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, D, 0, false), 'rail'), railOpts(0, 2), 'double line');
finishDoubleTrack(g, newTrack(g, e0), 0);
const insert = (x: number): Station | null => {
  const ne = net.nearestEdge(x, Z, 0.8, 'rail', (e) => e.station < 0 && e.depot < 0);
  if (!ne) return null;
  const r = commitStationOnTrack(g, planStationOnTrack(g, ne.edge.id, ne.s, { length: 12, tracks: 2, through: 2 }, 0));
  if (r.error) console.log('  insert:', r.error);
  return r.error ? null : g.stations.get(r.station) ?? null;
};
const B = insert(138), C = insert(246);
check(!!B && !!C && B.rail!.throughEdges.length > 0 && C.rail!.throughEdges.length > 0, 'two through stations (2 platforms + 2 through tracks) inserted');
// crossovers right outside every station (=====x==[station]==x=====): trains can also turn at B and C
const nc = normaliseCrossovers(g, newTrack(g, e0), 0);
console.log(`  crossovers: ${nc.crossovers}${nc.error ? ' (' + nc.error + ')' : ''}`);
autoSignalNetwork(g, 0);
const dep = depotFor(g, A, D);
check(dep >= 0, 'depot');
const L = g.lines.create('rail', 0);
L.stops = outAndBack([A.id, B!.id, C!.id, D.id]);
const local = () => [M('diesel_a'), M('coach_steel'), M('coach_steel')];
const fast = () => [M('hst'), M('coach_ic'), M('coach_ic'), M('coach_ic')];
const locals = [0, 1].map(() => g.vehicles.buyTrain(dep, local(), L.id) as Train);
const ex = g.vehicles.buyTrain(dep, fast(), L.id) as Train;
const xp = addPattern(g, L.id, 'express', L.stops.map((s) => s === A.id || s === D.id))!;
check(!!xp && linePatterns(L).length === 2 && patternStops(L, xp.id).every((i) => [A.id, D.id].includes(L.stops[i])), `express pattern: ${xp?.name}, stops ${patternStops(L, xp?.id).join(',')}`);
check(setVehiclePattern(g, ex.id, xp.id) === null && ex.pattern === xp.id, 'the HST runs the express');
const sx = suggestExpress(g, L);
check(!!sx && sx.stops.some((f) => !f), `suggestExpress skips something (${sx?.name})`);
// Observe at least two local cycles, including staged dispatch and terminus holds.
const all = [A, B!, C!, D];
const arrivals = new Map<number, Set<number>>(), arrN = new Map<number, number>();
const prev = new Map<number, string>();
let exPassThrough = 0, exPassPlatform = 0, exPlatformKmh = 0, exWrongCargo = 0, holdTicks = 0, maxHold = 0, overtakes = 0;
const holds = new Map<number, { st: number; by: string; passed: boolean }>();
const stationEdge = (st: Station, e: number) => st.rail!.edges.includes(e) ? 'platform' : st.rail!.throughEdges.includes(e) ? 'through' : '';
const runDays = (gg: Game, days: number, tick?: () => void) => { const d0 = gg.day; while (gg.day < d0 + days) { gg.update(0.25); tick?.(); } };
startFleet(g, [...locals, ex]);
let lastDay = g.day;
const operatingDays = Math.max(400, Math.ceil(2 * patternHeadway(g, L, locals[0].pattern) * locals.length * 360 / YEAR_S));
runDays(g, operatingDays, () => {
  if (g.day !== lastDay) { lastDay = g.day; for (const a of all) for (const b of all) if (a !== b) inject(g, a, b, 3); }
  for (const t of [...locals, ex]) {
    if (t.state === 'loading' && prev.get(t.id) !== 'loading') { (arrivals.get(t.id) ?? arrivals.set(t.id, new Set()).get(t.id)!).add(t.atStation); arrN.set(t.id, (arrN.get(t.id) ?? 0) + 1); }
    prev.set(t.id, t.state);
  }
  // the express: passing B and C on through tracks (or platforms at <= 120 km/h); its passengers alight at A / D only
  for (const s of ex.occupiedEdges()) for (const st of [B!, C!]) {
    const kind = stationEdge(st, s);
    if (kind === 'through') exPassThrough++;
    if (kind === 'platform') { exPassPlatform++; exPlatformKmh = Math.max(exPlatformKmh, ex.speedKmh); }
  }
  for (const c of ex.cargo.values()) if (c.alight !== A.id && c.alight !== D.id) exWrongCargo++;
  // overtaking holds of the locals: the express passes the station before the held local has left it
  for (const t of locals) {
    const h = holds.get(t.id);
    if (t.state === 'loading' && t.status.startsWith('Waiting for')) {
      holdTicks++; maxHold = Math.max(maxHold, t.holdTime);
      if (!h) holds.set(t.id, { st: t.atStation, by: t.status, passed: false });
    }
    const hh = holds.get(t.id);
    if (!hh) continue;
    const st = g.stations.get(hh.st)!;
    if (ex.occupiedEdges().some((e) => !!stationEdge(st, e))) hh.passed = true;
    if (!t.occupiedEdges().some((e) => !!stationEdge(st, e))) { if (hh.passed) overtakes++; if (process.env.DBG) console.log(`   dbg hold at ${st.name}: express passed ${hh.passed}`); holds.delete(t.id); }
  }
});
const nm = (ids: Set<number> | undefined) => [...(ids ?? [])].map((id) => g.stations.get(id)?.name.split(' ').pop()).join(',');
console.log(`  arrivals: locals ${locals.map((t) => `${arrN.get(t.id) ?? 0} at ${nm(arrivals.get(t.id))}`).join(' | ')}; express ${arrN.get(ex.id) ?? 0} at ${nm(arrivals.get(ex.id))}`);
console.log(`  express passing B/C: ${exPassThrough} ticks on through tracks, ${exPassPlatform} on platform tracks (max ${fmt(exPlatformKmh, 0)} km/h); holds: ${holdTicks} ticks, longest ${fmt(maxHold, 0)} s, ${overtakes} overtakes`);
check([...(arrivals.get(ex.id) ?? [])].every((s) => s === A.id || s === D.id) && (arrN.get(ex.id) ?? 0) >= 4, 'the express stops only at the termini (and keeps running)');
check(locals.every((t) => (arrivals.get(t.id)?.size ?? 0) === 4 && (arrN.get(t.id) ?? 0) >= 8), 'the locals stop everywhere');
check(exPassThrough > 0, 'the express passes the intermediate stations on their through tracks');
check(exPassPlatform === 0 || exPlatformKmh <= PLATFORM_PASS_KMH + 1, 'platform tracks passed at <= 120 km/h');
check(exWrongCargo === 0, 'passengers board the express only for stops it serves');
check(overtakes >= 1 && maxHold <= HOLD_MAX_S + 0.5, `a local waits at a through station while the express overtakes (bounded hold <= ${HOLD_MAX_S} s)`);
check(ex.delivered > 0 && locals.every((t) => t.delivered > 0), 'every pattern carries passengers');
// fares paid at the destination: the leg's time (wait + ride), the no-transfer bonus
{
  const t = locals[0];
  const now = simNow(g);
  const pay = (t0: number, transfers: number) => {
    t.cargo.clear(); t.load = 0;
    t.cargo.set('x', { alight: D.id, dest: D.id, count: 100, from: A.id, day: g.day, t0, transfers });
    const m0 = g.economy.money;
    t.serveStation(D, 0);
    return g.economy.money - m0;
  };
  const quick = pay(now - 200, 0), slowLeg = pay(now - 1200, 0), changed = pay(now - 200, 100);
  console.log(`  100 pax A->D: 200 s leg ${k(quick)}, 1200 s leg ${k(slowLeg)}, 200 s leg after a transfer ${k(changed)}`);
  check(slowLeg < quick * 0.5, 'a slow journey pays much less');
  check(Math.abs(quick / changed - (1 + NO_TRANSFER_BONUS)) < 1e-6, `no-transfer bonus +${NO_TRANSFER_BONUS * 100}% on a direct journey`);
  // boarding: the wait counted is at most WAIT_CAP_HEADWAYS of the service's headway (B: only the locals stop)
  t.cargo.clear(); t.load = 0;
  const hw = patternHeadway(g, L, t.pattern);
  A.waiting.clear(); A.waitingTotal = 0;
  g.stations.addWaiting(A, L.id, B!.id, B!.id, 10, 0, now - 5000);
  t.stopIndex = L.stops.indexOf(A.id);
  t.serveStation(A, 0);
  const cg = [...t.cargo.values()].find((c) => c.alight === B!.id);
  if (process.env.DBG) console.log('   dbg backlog', JSON.stringify([...t.cargo.values()]), JSON.stringify([...A.waiting.values()].filter((w) => w.alight === B!.id)), t.pattern, t.stopIndex, t.capacity, t.load, now, hw);
  check(!!cg && cg.t0! >= now - WAIT_CAP_HEADWAYS * hw - 1e-6, `a backlog counts at most ${WAIT_CAP_HEADWAYS} headways of waiting (headway ${fmt(hw, 0)} s)`);
  t.cargo.clear(); t.load = 0;
  t.onLineChanged();
}
// monthly operating costs: the parts add up, the categories match the vehicles' bills
{
  runDays(g, 30 - (g.day % 30) + 1);
  const vs = g.vehicles.all().filter((v) => v.owner === 0);
  const sumParts = vs.every((v) => v.opLast && Math.abs(v.opLast.overhead + v.opLast.crew + v.opLast.energy + v.opLast.maint - v.opLast.total) < 1e-6);
  const rec = g.economy.months[g.economy.months.length - 1].v;
  const booked = -(rec.running + rec.crew + rec.energy + rec.vehicleMaint);
  const bills = vs.reduce((s, v) => s + (v.opLast?.total ?? 0), 0);
  console.log(`  last month: overheads ${k(-rec.running)}, crew ${k(-rec.crew)}, energy ${k(-rec.energy)}, vehicle maintenance ${k(-rec.vehicleMaint)} (= ${k(bills)} billed to the trains), infrastructure ${k(-rec.maintenance)}, track wear ${k(-rec.trackWear)}; operating total ${k(-operatingCosts(rec))}`);
  for (const v of vs) console.log(`    ${v.name}${v.pattern !== undefined ? ' (express)' : ''}: ${Object.entries(v.opLast!).map(([n, x]) => `${n} ${fmt(x as number, n === 'km' || n === 'kwh' || n === 'hours' ? 2 : 0)}`).join(', ')}`);
  check(sumParts, 'each vehicle: overhead + crew + energy + maintenance = total');
  check(Math.abs(booked - bills) < 1e-3 * Math.max(1, bills), 'company categories = the vehicles\' monthly bills');
  check(rec.trackWear < 0 && rec.crew < 0 && rec.energy < 0, 'track wear, crew and energy booked');
  // km are metered per hop (until the train physics meters them continuously): over three months every train has some
  const km = new Map<number, number>();
  let md = g.day;
  runDays(g, 90, () => { if (g.day !== md) { md = g.day; if (g.day % 30 === 1) for (const v of vs) km.set(v.id, (km.get(v.id) ?? 0) + (v.opLast?.km ?? 0)); } });
  console.log(`  km in three months: ${vs.map((v) => fmt(km.get(v.id) ?? 0, 1)).join(' / ')}`);
  check(vs.every((v) => (km.get(v.id) ?? 0) > 0), 'every running train has metered km');
}

// ------------------------------------------------------------------ 4. short-turns and one line per route (9k)
console.log('one line per route');
{
  const subset = g.lines.create('rail', 0);
  subset.stops = [B!.id, C!.id];
  const st = g.vehicles.buyTrain(dep, local(), subset.id) as Train;
  const rev = g.lines.create('rail', 0);
  rev.stops = [D.id, A.id];
  const rt = g.vehicles.buyTrain(dep, fast(), rev.id) as Train;
  subset.passMonth = 7; subset.incomeYear = 1000;
  const inc0 = L.incomeYear;
  const notes = canonicalizeLines(g);
  console.log('  ' + notes.map((n) => n.text).join('\n  '));
  check(notes.length === 2 && !g.lines.map.has(subset.id) && !g.lines.map.has(rev.id), 'the B-C line and the reversed D-A line merged into the A-B-C-D line');
  check(st.lineId === L.id && rt.lineId === L.id && st.owner === 0, 'their trains run the merged line (owner kept)');
  const sp = linePatterns(L).find((p) => p.id === st.pattern)!;
  check(!!sp && patternStops(L, sp.id).every((i) => [B!.id, C!.id].includes(L.stops[i])) && /Local/.test(sp.name), `the B-C train runs a short-turn pattern (${sp?.name})`);
  check(rt.pattern === xp.id, 'the reversed A-D line became the existing express pattern');
  check(g.lines.get(subset.id) === L && L.incomeYear === inc0 + 1000, 'old id leads to the merged line; history added');
  check(canonicalizeLines(g).length === 0, 'idempotent');
  // partial overlap (X-A-B-Y, G-A-B-H) and branches stay separate lines
  const far = (x: number, z: number) => station(g, x, z, 0, 8, 1)!;
  const X = far(60, 40), Y = far(140, 40), G = far(220, 40), H = far(300, 40);
  const l1 = g.lines.create('rail', 0), l2 = g.lines.create('rail', 0), l3 = g.lines.create('rail', 0);
  l1.stops = outAndBack([X.id, A.id, B!.id, Y.id]); l2.stops = outAndBack([G.id, A.id, B!.id, H.id]); l3.stops = outAndBack([X.id, A.id, B!.id]);
  const n2 = canonicalizeLines(g);
  console.log('  ' + n2.map((x) => x.text).join('; '));
  check(g.lines.map.has(l1.id) && g.lines.map.has(l2.id) && !g.lines.map.has(l3.id) && n2.length === 1 && n2[0].into === l1.id, 'X-A-B-Y and G-A-B-H stay apart; X-A-B joins X-A-B-Y');
  g.lines.delete(l1.id); g.lines.delete(l2.id);
  for (const s of [X, Y, G, H]) g.stations.removeStation(s.id);
  // B and C are through stations on one-way signalled double track: no train can turn there (the B-C line could not
  // run before the merge either); its train goes, the short-turn is run on a single-track line below
  g.vehicles.sell(st.id);
}
{
  // a single-track line A-B-C-D (no signals: trains may reverse at every platform) and a B-C line with a train:
  // merged, its train runs the line as a short-turn and turns at B and C
  const h = flatGame(384);
  const S4 = [40, 130, 220, 310].map((x) => station(h, x, 100, Math.PI / 2, 12, 1)!);
  for (let i = 0; i < 3; i++) build(h, nodeSnap(h, endNode(h, S4[i], 0, true), 'rail'), nodeSnap(h, endNode(h, S4[i + 1], 0, false), 'rail'), railOpts(0, 1), 'single');
  const dp = depotFor(h, S4[0], S4[3]);
  const l = h.lines.create('rail', 0);
  l.stops = outAndBack(S4.map((x) => x.id));
  const sub = h.lines.create('rail', 0);
  sub.stops = [S4[1].id, S4[2].id];
  const tr = h.vehicles.buyTrain(dp, local(), sub.id) as Train;
  const notes = canonicalizeLines(h);
  check(notes.length === 1 && tr.lineId === l.id && tr.pattern !== undefined, `B-C merged as a short-turn pattern (${notes[0]?.text})`);
  const seen = new Set<number>(), pv = new Map<number, string>();
  let n = 0;
  runDays(h, 300, () => { if (tr.state === 'loading' && pv.get(tr.id) !== 'loading') { seen.add(tr.atStation); n++; } pv.set(tr.id, tr.state); });
  console.log(`  short-turn train: ${n} stops at ${[...seen].map((id) => h.stations.get(id)?.name.split(' ').pop()).join(',')} (${tr.status})`);
  check(n >= 6 && seen.size === 2 && seen.has(S4[1].id) && seen.has(S4[2].id), 'the short-turn turns at B and C');
}

// ------------------------------------------------------------------ 5. exact save round trip with patterns
console.log('save round trip');
{
  const strip = (key: string, v: unknown) => (key === 'onPlat' ? undefined : v);
  const j1 = JSON.stringify(serialize(g), strip);
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const j2 = JSON.stringify(serialize(g2), strip);
  if (j1 !== j2) { let i = 0; while (j1[i] === j2[i]) i++; console.log(`  differs at ${i}: ...${j1.slice(i - 100, i + 60)}\n  vs ...${j2.slice(i - 100, i + 60)}`); }
  check(j1 === j2, 're-serialized save identical');
  const L2 = g2.lines.get(L.id)!;
  check(JSON.stringify(L2.patterns) === JSON.stringify(L.patterns) && g2.vehicles.get(ex.id)!.pattern === ex.pattern, 'patterns and vehicle patterns restored');
  const waits = (x: Game) => JSON.stringify([...x.stations.map.values()].map((s) => [...s.waiting.values()]));
  const cargo = (x: Game) => JSON.stringify(x.vehicles.all().map((v) => [...v.cargo.values()]));
  check(waits(g2) === waits(g) && cargo(g2) === cargo(g), 'waiting times and journey times (t, t0, transfers) restored');
  for (let i = 0; i < 60 * 8; i++) {
    g.update(0.25); g2.update(0.25);
    if (process.env.DBG) {
      const a = JSON.stringify(serialize(g), strip), b = JSON.stringify(serialize(g2), strip);
      if (a !== b) { let j = 0; while (a[j] === b[j]) j++; console.log(`   dbg save: tick ${i} day ${g.day}: ...${a.slice(j - 300, j + 80)}\n   vs ...${b.slice(j - 300, j + 80)}`); break; }
    }
  }
  const sig = (x: Game) => JSON.stringify({ m: x.companies.map((c) => c.economy.money), v: x.vehicles.all().map((v) => [v.state, v.stopIndex, v.delivered, v.load, Math.round(v.profitYear)]), w: waits(x), c: cargo(x) });
  check(sig(g) === sig(g2), 'both copies run on identically for 60 days');
}

// ------------------------------------------------------------------ 5b. old saves: subset lines become patterns on load
console.log('old saves');
{
  const h = flatGame(384);
  const S3 = [60, 170, 280].map((x) => station(h, x, 120, Math.PI / 2, 12, 1)!);
  for (let i = 0; i < 2; i++) build(h, nodeSnap(h, endNode(h, S3[i], 0, true), 'rail'), nodeSnap(h, endNode(h, S3[i + 1], 0, false), 'rail'), railOpts(0, 1), 'single');
  const dp = depotFor(h, S3[0], S3[2]);
  const full = h.lines.create('rail', 0), part = h.lines.create('rail', 0);
  full.stops = outAndBack(S3.map((x) => x.id)); part.stops = [S3[0].id, S3[1].id];
  const tf = h.vehicles.buyTrain(dp, local(), full.id) as Train, tp = h.vehicles.buyTrain(dp, local(), part.id) as Train;
  runDays(h, 20);
  const data = JSON.parse(JSON.stringify(serialize(h)));
  const kept = deserialize(JSON.parse(JSON.stringify(data)));
  check(kept.lines.map.has(part.id) && kept.lines.map.has(full.id), 'a current save keeps its lines as saved');
  // a save from before the ops data: no opsVersion, no service patterns, no vehicle ops fields
  delete data.opsVersion; delete data.ops; delete data.linesRedirect;
  for (const v of data.vehicles) { delete v.pattern; delete v.ops; delete v.opLast; delete v.holdTime; delete v.phys; }
  for (const st of data.stations) for (const w of st.waiting) { delete w.t; delete w.transfers; }
  const old = deserialize(data);
  const ml = old.lines.get(full.id)!, vp = old.vehicles.get(tp.id)!;
  check(!old.lines.map.has(part.id) && old.lines.get(part.id) === ml && vp.lineId === full.id && vp.pattern !== undefined && vp.owner === 0, 'an old save: the A-B line became a short-turn pattern of A-B-C on load');
  check(old.vehicles.get(tf.id)!.lineId === full.id && linePatterns(ml).length === 2, 'the A-B-C train keeps its line (local + short-turn)');
  runDays(old, 120);
  check(vp.delivered > 0 || vp.state === 'running' || vp.state === 'loading', `the merged train runs on (${vp.status})`);
}

// ------------------------------------------------------------------ 6. routing prefers direct services
console.log('routing: transfers');
{
  const h = flatGame(512);
  const P = station(h, 60, 100, Math.PI / 2, 10, 2)!, Q = station(h, 260, 100, Math.PI / 2, 10, 2)!, R = station(h, 460, 100, Math.PI / 2, 10, 2)!;
  // timetables only need the lines' vehicles (they stay in the depot here)
  const lineWith = (stops: Station[], cars: VehicleModel[], n: number): Line => {
    const l = h.lines.create('rail', 0);
    l.stops = stops.map((s) => s.id);
    for (let i = 0; i < n; i++) { const t = new Train(h, h.vehicles.nextId++, cars, -1); h.vehicles.map.set(t.id, t); t.lineId = l.id; l.vehicles.push(t.id); }
    return l;
  };
  const direct = lineWith([P, R], [M('diesel_a'), M('coach_steel')], 1);
  const e1 = lineWith([P, Q], [M('hst'), M('coach_ic')], 2), e2 = lineWith([Q, R], [M('hst'), M('coach_ic')], 2);
  h.lines.rebuild();
  const hop = h.lines.nextHop(P.id, R.id)!;
  const tDirect = h.lines.nextHop(P.id, R.id)!.cost;
  h.lines.delete(direct.id);
  const viaQ = h.lines.nextHop(P.id, R.id)!;
  console.log(`  P->R: direct slow line ${fmt(tDirect, 0)} s; via Q on two fast lines ${fmt(viaQ.cost, 0)} s incl. the ${TRANSFER_PENALTY_S} s transfer penalty (first leg ${h.lines.get(viaQ.line)?.name})`);
  check(hop.line === direct.id, 'the direct service is preferred over a faster journey with a transfer');
  check(viaQ.line === e1.id && viaQ.alight === Q.id && viaQ.cost > TRANSFER_PENALTY_S, 'without it: change at Q (transfer penalty counted)');
  check(viaQ.cost - TRANSFER_PENALTY_S < tDirect, 'the transfer route was faster in raw time');
  void e2;
}

// ------------------------------------------------------------------ 7. HSR economics: busy vs poorly used (simulated)
console.log('HSR economics');
/** A year (the second of two) of an HSR line `distUnits` long with one high-speed set; `every` days `n` passengers each way. */
function hsrYear(n: number, every: number, distUnits: number): { income: number; vehicles: number; track: number; wear: number; profit: number; pax: number; trains: number } {
  const h = flatGame(Math.max(384, distUnits + 160));
  const x0 = 60, z = 120;
  const P = station(h, x0, z, Math.PI / 2, 12, 2, 0, { trackType: 'highspeed' })!, Q = station(h, x0 + distUnits, z, Math.PI / 2, 12, 2, 0, { trackType: 'highspeed' })!;
  const ee = h.world.net.nextEdge;
  build(h, nodeSnap(h, endNode(h, P, 0, true), 'rail'), nodeSnap(h, endNode(h, Q, 0, false), 'rail'), railOpts(0, 2, { type: 'highspeed' }), 'HSR');
  finishDoubleTrack(h, newTrack(h, ee), 0);
  autoSignalNetwork(h, 0);
  const dp = depotFor(h, P, Q);
  // the depot connection is ordinary track: high-speed units need high-speed (electrified) track
  for (const e of h.world.net.edges.values()) if (e.kind === 'rail' && e.type === 'standard') e.type = 'highspeed';
  const l = h.lines.create('rail', 0);
  l.stops = [P.id, Q.id];
  const trains = [h.vehicles.buyTrain(dp, hsr300, l.id)].filter((t): t is Train => t instanceof Train);
  let last = h.day, accumulated = 0;
  const lineEdges = [...h.world.net.edges.values()].filter((e) => e.owner === 0 && e.kind === 'rail');
  runDays(h, 360 * 2, () => { if (h.day !== last) { last = h.day; if (h.day % every === 0) {
    // Synthetic economic demand uses the same calibration as generated demand; carry fractional people forward.
    accumulated += n * PASSENGER_RATE_SCALE;
    const count = Math.floor(accumulated); accumulated -= count;
    inject(h, P, Q, count); inject(h, Q, P, count);
  } } });
  const yr = h.economy.yearTotals[h.economy.yearTotals.length - 1].v;
  const track = lineEdges.reduce((s, e) => s + h.edgeMaintenance(e), 0);
  const vehicles = -(yr.running + yr.crew + yr.energy + yr.vehicleMaint);
  const profit = yr.income + yr.running + yr.crew + yr.energy + yr.vehicleMaint + yr.trackWear - track;
  return { income: yr.income, vehicles, track, wear: -yr.trackWear, profit, pax: trains.reduce((x, t) => x + t.delivered, 0) / 2, trains: trains.length };
}
{
  const busy = hsrYear(40, 1, 900), poor = hsrYear(1, 12, 900);
  const show = (n: string, r: ReturnType<typeof hsrYear>) => console.log(`  ${n}: ${r.trains} trains, ~${fmt(r.pax, 0)} pax/yr, income ${k(r.income)}, trains ${k(r.vehicles)}, track upkeep ${k(r.track)}, wear ${k(r.wear)} -> ${k(r.profit)} a year`);
  show('busy HSR, 9 km', busy); show('poorly used HSR, 9 km', poor);
  check(busy.profit > 0, 'a busy HSR between towns far apart pays its running costs');
  check(poor.profit < 0, 'a poorly used one loses money');
  console.log(`  (one set either way: the full train dwells longer and runs fewer km, so its own costs are not higher; break-even ~${fmt((poor.vehicles + poor.track + poor.wear) / Math.max(1, poor.income / Math.max(1, poor.pax)), 0)} pax/yr)`);
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
void YEAR_S;
done();

/** Finish staged dispatch before measuring a full operating period; bound and check the startup too. */
function startFleet(g: Game, vs: StartupVehicle[], maxWaitDays = Infinity) {
  const cycles = vs.map((v) => {
    const l = v.line;
    return l ? startupTable(g, l).pats.find((p) => p.pid === (startupPattern(l, v.pattern)?.id ?? 0))?.cycle ?? 0 : 0;
  });
  const budget = 2 * Math.max(...cycles);
  const deadline = g.tick + Math.ceil(budget / g.tickSeconds), waiting = new Map<number, number>();
  let worstWait = 0, blockedHold = false;
  while (g.tick < deadline && vs.some((v) => v.opLastSt < 0)) {
    g.stepTick();
    for (const v of vs) {
      if (v.state === 'waiting' || v.state === 'noroute') {
        const start = waiting.get(v.id) ?? g.day; waiting.set(v.id, start);
        worstWait = Math.max(worstWait, g.day - start);
      } else waiting.delete(v.id);
      blockedHold ||= v.status === 'Holding for even spacing' && g.vehicles.spacingBlocked(v);
    }
  }
  check(vs.every((v) => v.opLastSt >= 0), 'the whole fleet starts serving within two estimated cycles');
  check(worstWait < maxWaitDays && !blockedHold, 'startup preserves path-wait and platform safety limits');
}
