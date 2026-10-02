// Train physics (UPDATE 9j): braking curve and distances, curve speeds with cant, Davis resistance with per-train
// aerodynamics, acceleration and top speed of high-speed sets by era, conventional EMU / locomotive trains, and the
// energy counters opcosts reads (tractionJ, regenJ, auxJ, km, hours).
// npx esbuild scripts/physics.ts --bundle --platform=node --format=esm --outfile=$S/physics.mjs && node $S/physics.mjs [line-km>=40]
import { MODEL_BY_ID, VehicleModel, aeroOf, auxKwOf } from '../src/game/vehicle-types';
import { Train, brakeDistance, brakeSpeed, brakeRate, makeSeg, trainForces, DAVIS } from '../src/game/train';
import { curveSpeed, planEdge, commitProposal } from '../src/game/construction';
import { KMH_TO_UPS, TRACK_TYPES, PSTEP, DAY_SECONDS, DAYS_PER_MONTH } from '../src/game/constants';
import { flatGame, station, endNode, fails, check, fmt, free, railOpts, nodeSnap } from './stationlib';

import { bezLine } from '../src/game/geom';
import { consistOf, energyCost, vehicleMonth } from '../src/game/opcosts';

const LINE_KM = Number(process.argv[2] ?? 40);
const DT = 0.05;
const M = (id: string) => MODEL_BY_ID.get(id)!;
const keys = ['tractionJ', 'regenJ', 'auxJ', 'km', 'hours'] as const;
const zero = () => ({ tractionJ: 0, regenJ: 0, auxJ: 0, km: 0, hours: 0 });
const kmh = (v: number) => v / KMH_TO_UPS;

// ---- 1. braking curve, curve speeds
console.log('braking: service 0.7 m/s2 to 160 km/h, 0.5 m/s2 from 300 km/h');
for (const v of [100, 160, 200, 250, 300, 350, 400]) {
  const d = brakeDistance(v * KMH_TO_UPS);
  console.log(`  from ${v} km/h: ${fmt(d * 10 / 1000, 2)} km (rate there ${fmt(brakeRate(v * KMH_TO_UPS) * 10, 2)} m/s2)`);
  check(Math.abs(kmh(brakeSpeed(d)) - v) < 0.5, `brakeSpeed inverts brakeDistance at ${v} km/h`);
}
check(Math.abs(brakeDistance(160 * KMH_TO_UPS) * 10 - (44.44 ** 2) / 1.4) < 5, 'from 160 km/h at 0.7 m/s2: ~1.41 km');
check(brakeDistance(400 * KMH_TO_UPS) * 10 > 10_500 && brakeDistance(400 * KMH_TO_UPS) * 10 < 12_500, 'from 400 km/h: 10.5-12.5 km');
console.log('curve speeds with cant: 4.1 sqrt(R[m]) conventional, 4.3 sqrt(R[m]) high-speed');
for (const R of [30, 100, 490, 870]) console.log(`  R ${R * 10} m: conventional ${fmt(curveSpeed(R, 'standard'), 0)} km/h, high-speed ${fmt(curveSpeed(R, 'highspeed'), 0)} km/h`);
check(Math.abs(curveSpeed(490, 'highspeed') - 301) < 2 && Math.abs(curveSpeed(870, 'highspeed') - 401) < 2, 'high-speed: 300 km/h at R 4.9 km, 400 km/h at R 8.7 km');
check(Math.abs(curveSpeed(100, 'standard') - 129.7) < 1, 'conventional: 130 km/h at R 1 km');
check(TRACK_TYPES.highspeed.speed === 400 && TRACK_TYPES.highspeed.costPerUnit > TRACK_TYPES.electric.costPerUnit * 2 && TRACK_TYPES.highspeed.maintPerUnit >= TRACK_TYPES.standard.maintPerUnit * 3, 'high-speed track: 400 km/h, dearer to build and maintain');
// aerodynamics: per train, not per mass
const aeroOfTrain = (cars: VehicleModel[]) => aeroOf(cars[0]).nose + cars.reduce((a, c) => a + aeroOf(c).len * c.length, 0);
{
  const hs = ['hsr_a', 'hsr_b', 'hsr_c', 'hsr_d', 'hsr_e'].map((id) => MODEL_BY_ID.get(id)!);
  console.log('high-speed sets: ' + hs.map((m) => `${m.id} ${m.intro} ${m.speed} km/h ${m.power} kW ${m.weight} t c=${fmt(aeroOfTrain([m]), 1)}`).join('; '));
  check(hs.every((m, i) => i === 0 || (m.intro > hs[i - 1].intro && m.speed > hs[i - 1].speed)), 'high-speed sets by era: faster with each generation');
  const ic = [MODEL_BY_ID.get('diesel_b')!, ...Array(8).fill(MODEL_BY_ID.get('coach_ic')!)];
  console.log(`  c of a diesel + 8 IC coaches (${fmt(ic.reduce((a, c) => a + c.length, 0) * 10, 0)} m): ${fmt(aeroOfTrain(ic), 1)}; steam + 4 wooden coaches: ${fmt(aeroOfTrain([MODEL_BY_ID.get('steam_a')!, ...Array(4).fill(MODEL_BY_ID.get('coach_wood')!)]), 1)}`);
}

// ---- 2. what each high-speed set can sustain on level track (traction = resistance), steady-state energy
{
  const g0 = flatGame(256);
  const balance = (t: Train) => { let v = 1; while (v < 140 && trainForces(t, v + 0.25).traction > trainForces(t, v + 0.25).resistance) v += 0.25; return v * 3.6; };
  for (const id of ['hsr_a', 'hsr_b', 'hsr_c', 'hsr_d', 'hsr_e', 'emu_b']) {
    const t = new Train(g0, 9000, [MODEL_BY_ID.get(id)!], -1);
    const b = balance(t), top = t.maxSpeedKmh, fr = trainForces(t, top / 3.6);
    console.log(`  ${id}: could run ${fmt(b, 0)} km/h on the level (rated ${top}); at ${top} km/h resistance ${fmt(fr.resistance / 1000, 1)} kN (${fmt(fr.resistance / 1000 / t.capacity * 1000 / 3.6, 1)} Wh per seat-km at the wheels), spare acceleration ${fmt((fr.traction - fr.resistance) / (t.mass * 1060), 2)} m/s2`);
    check(b >= top, `${id} can reach its rated ${top} km/h on level track (balancing speed ${fmt(b, 0)})`);
  }
  const t = new Train(g0, 9001, [MODEL_BY_ID.get('hsr_e')!], -1);
  const e400 = trainForces(t, 400 / 3.6).resistance, e300 = trainForces(t, 300 / 3.6).resistance;
  console.log(`  steady running, same set: energy per seat-km at 400 km/h ${fmt((e400 / e300 - 1) * 100, 0)} % above 300 km/h`);
  check(e400 / e300 >= 1.6 && e400 / e300 <= 1.8, 'steady running at 400 km/h takes 60-80 % more energy per seat-km than at 300 km/h (same set)');
  const aero = t.phys.aero, emptyMass = t.mass;
  t.load = t.capacity;
  check(t.phys.aero === aero && Math.abs(trainForces(t, 400 / 3.6).resistance - e400 -
    (t.mass - emptyMass) * 1000 * (DAVIS.a0 + DAVIS.a1 * 400 / 3.6)) < 1e-8,
    'passenger mass increases mechanical resistance without multiplying aerodynamic drag');
}

// ---- 3. long straight fixtures: real network / stations / reservations, a small terrain allocation.
// The approach extends beyond the terrain boundary; headless train geometry does not need a 40 km square map.
function straight(cars: VehicleModel[], type = 'highspeed', red = false, km = LINE_KM) {
  const g = flatGame(256);
  g.economy.money = 1e12;
  const A = station(g, 60, 128, Math.PI / 2, 24, 1, 0, { trackType: type })!;
  const B = station(g, 190, 128, Math.PI / 2, 24, 1, 0, { trackType: type })!;
  if (!A || !B) throw new Error('physics fixture stations');
  const net = g.world.net, near = net.nodes.get(endNode(g, B, 0, true))!;
  const far = net.addNode('rail', near.x + km * 100, near.y, near.z, 1, 0);
  const edge = (a: typeof near, b: typeof near) => net.addEdge('rail', a.id, b.id,
    bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil((b.x - a.x) / PSTEP) + 1).fill(near.y), [], type, 0);
  const platform = net.edges.get(B.rail!.edges[0])!;
  const stop = makeSeg(g, platform, platform.b === near.id ? -1 : 1);
  const t = new Train(g, 1, cars, -1);
  let blocked = 0;
  if (red) {
    const signal = net.addNode('rail', near.x + 1000, near.y, near.z, 1, 0);
    signal.signal = 1; signal.signalKind = 'block';
    const approach = edge(signal, far), beyond = edge(near, signal);
    t.segs = [makeSeg(g, approach, -1)];
    t.pending = [makeSeg(g, beyond, -1), stop];
    blocked = beyond.id;
    g.vehicles.setRes(blocked, 2); // another train holds the block beyond the signal
  } else t.segs = [makeSeg(g, edge(near, far), -1), stop];
  const l = g.lines.create('rail', 0); l.stops = [A.id, B.id];
  // Finish network notifications before installing the deterministic physics fixture.
  g.flushNetworkChanges();
  t.lineId = l.id; t.stopIndex = 1; t.routeTarget = B.id;
  t.headPos = t.length; t.state = 'running'; t.opMark = 0;
  for (const s of t.segs) for (const r of s.res) g.vehicles.setRes(r, t.id);
  g.vehicles.map.set(t.id, t);
  return { g, t, B, blocked };
}

interface Run {
  vmax: number; t100: number; t200: number; t300: number; km300: number; km390: number; kmTop: number;
  trip: number; brakeAt: number; brakeKm: number; resets: number; overrun: number; stopErrorM: number;
  maxBrakeLow: number; maxBrakeHigh: number; envelopeM: number; peakWheelW: number;
  energy: ReturnType<typeof zero>; seats: number;
}
function run(cars: VehicleModel[], type: string, label: string): Run {
  const { g, t, B } = straight(cars, type);
  const r: Run = { vmax: 0, t100: -1, t200: -1, t300: -1, km300: -1, km390: -1, kmTop: -1,
    trip: -1, brakeAt: -1, brakeKm: -1, resets: 0, overrun: 0, stopErrorM: Infinity,
    maxBrakeLow: 0, maxBrakeHigh: 0, envelopeM: 0, peakWheelW: 0, energy: zero(), seats: t.capacity };
  const startDist = t.distToEnd();
  let time = 0, month = DAY_SECONDS * DAYS_PER_MONTH;
  for (let i = 0; i < 3600 / DT; i++) {
    const before = { ...r.energy };
    for (const k of keys) before[k] = t[k];
    const v0 = t.speedKmh, mass0 = t.mass;
    t.update(DT);
    time += DT;
    g.day = Math.floor(time / DAY_SECONDS); g.dayFrac = time / DAY_SECONDS - g.day;
    for (const k of keys) {
      const delta = t[k] - before[k];
      if (!Number.isFinite(delta) || delta < -1e-6) r.overrun++;
      r.energy[k] += delta;
    }
    r.peakWheelW = Math.max(r.peakWheelW, (t.tractionJ - before.tractionJ) / DT);
    const v = t.speedKmh, distKm = (startDist - t.distToEnd()) / 100;
    if (r.t100 < 0 && v >= 100) r.t100 = time;
    if (r.t200 < 0 && v >= 200) r.t200 = time;
    if (r.t300 < 0 && v >= 300 - 1e-6) { r.t300 = time; r.km300 = distKm; }
    if (r.km390 < 0 && v >= 390) r.km390 = distKm;
    if (r.kmTop < 0 && v >= t.maxSpeedKmh - 0.1) r.kmTop = distKm;
    if (r.brakeAt < 0 && v0 > 60 && v < v0 - 0.01) { r.brakeAt = v0; r.brakeKm = t.distToEnd() / 100; }
    r.vmax = Math.max(r.vmax, v);
    const decel = (v0 - v) / 3.6 / DT;
    // Arrival snaps speeds below ~2 km/h to rest; measure the service brake while moving.
    if (v > 5 && v0 <= 160) r.maxBrakeLow = Math.max(r.maxBrakeLow, decel);
    if (v > 300) r.maxBrakeHigh = Math.max(r.maxBrakeHigh, decel);
    r.envelopeM = Math.max(r.envelopeM, (brakeDistance(t.speed) - t.distToEnd()) * 10);
    if (t.headPos > t.segs[t.headSeg].len + 1e-6 || t.distToEnd() < -1e-6) r.overrun++;
    if (time + 1e-6 >= month) {
      const used = { tractionJ: t.tractionJ, regenJ: t.regenJ, auxJ: t.auxJ, km: t.km, hours: t.hours };
      const bill = vehicleMonth(g, t);
      check(keys.every((k) => t[k] === 0), `${label}: monthly operating costs reset all five physics counters`);
      check(Math.abs(bill.km - used.km) < 1e-9 && Math.abs(bill.kwh - energyCost(consistOf(cars), used.tractionJ, used.regenJ, used.auxJ, g.year).kwh) < 1e-7,
        `${label}: monthly bill uses measured km and energy`);
      check(Math.abs(bill.hours - used.hours) < 1e-6, `${label}: physical service time agrees with the monthly bill`);
      r.resets++; month += DAY_SECONDS * DAYS_PER_MONTH;
    }
    if (t.state === 'loading') {
      check(t.atStation === B.id && t.speed === 0, `${label}: stops at the destination station`);
      check(t.regenJ - before.regenJ <= 0.5 * mass0 * 1060 * (v0 / 3.6) ** 2 + 1e-5,
        `${label}: the final stop cannot regenerate more than its remaining kinetic energy`);
      r.stopErrorM = Math.abs(t.distToEnd()) * 10;
      r.trip = time;
      // At a dwell: hotel/time continue, wheel/braking energy and distance stay still.
      const beforeDwell = { tractionJ: t.tractionJ, regenJ: t.regenJ, auxJ: t.auxJ, km: t.km, hours: t.hours };
      t.loadTimer = 2; t.update(1);
      check(t.tractionJ === beforeDwell.tractionJ && t.regenJ === beforeDwell.regenJ && t.km === beforeDwell.km,
        `${label}: a stationary train does not count wheel work or distance`);
      check(Math.abs(t.auxJ - beforeDwell.auxJ - t.phys.aux * 1000) < 1e-5 && Math.abs(t.hours - beforeDwell.hours - 1 / 3600) < 1e-12,
        `${label}: auxiliary watts and service seconds continue during dwell`);
      break;
    }
  }
  console.log(`  ${label}: ${t.mass} t, ${t.power} kW; peak ${fmt(r.vmax, 1)} km/h; 0-100/200/300 ${fmt(r.t100, 1)}/${fmt(r.t200, 1)}/${fmt(r.t300, 1)} s; 300/390/top at ${fmt(r.km300, 2)}/${fmt(r.km390, 2)}/${fmt(r.kmTop, 2)} km; trip ${fmt(r.energy.km, 2)} km in ${fmt(r.trip / 60, 2)} min; wheels/brakes/aux ${fmt(r.energy.tractionJ / 3.6e6, 1)}/${fmt(r.energy.regenJ / 3.6e6, 1)}/${fmt(r.energy.auxJ / 3.6e6, 1)} kWh; ${r.resets} monthly resets; station error ${fmt(r.stopErrorM, 3)} m`);
  check(r.trip > 0 && r.overrun === 0 && r.stopErrorM < 1e-6, `${label}: complete run without station or reservation overruns`);
  check(r.envelopeM < 0.5, `${label}: speed stays within the reserved-distance braking envelope (${fmt(r.envelopeM, 3)} m excess)`);
  check(r.maxBrakeLow >= 0.6 && r.maxBrakeLow <= 0.71, `${label}: conventional-speed service brake 0.6-0.7 m/s2 (${fmt(r.maxBrakeLow, 3)})`);
  if (r.vmax > 310) check(r.maxBrakeHigh >= 0.49 && r.maxBrakeHigh <= 0.51, `${label}: high-speed service brake ~0.5 m/s2 (${fmt(r.maxBrakeHigh, 3)})`);
  check(keys.every((k) => r.energy[k] > 0) && Math.abs(r.energy.km - startDist / 100) < 0.001 && Math.abs(r.energy.hours * 3600 - r.trip) < 1e-6,
    `${label}: counters accumulate joules, kilometres and hours in physical units`);
  check(Math.abs(r.energy.auxJ - cars.reduce((s, c) => s + auxKwOf(c), 0) * 1000 * r.trip) < 0.01,
    `${label}: hotel energy equals per-car watts times service seconds`);
  check(r.resets > 0, `${label}: counters restart and accumulate after monthly resets`);
  check(r.peakWheelW <= t.power * 1000 * 0.92 * 1.00001, `${label}: wheel energy never exceeds installed power x transmission efficiency`);
  return r;
}

console.log(`runs on a ${LINE_KM} km straight (unloaded):`);
const runs = {
  loco: run([M('diesel_b'), ...Array(6).fill(M('coach_ic'))], 'standard', 'diesel IC'),
  emu: run([M('emu_b')], 'electric', 'suburban EMU'),
  hsrA: run([M('hsr_a')], 'highspeed', 'HSR 1964'),
  hsrC: run([M('hsr_c')], 'highspeed', 'HSR 1997'),
  hsrE: run([M('hsr_e')], 'highspeed', 'HSR 2025'),
};
check(runs.emu.t100 > 25 && runs.emu.t100 < 70, `suburban EMU: realistic 0-100 (${fmt(runs.emu.t100, 1)} s)`);
check(runs.loco.t100 > 40 && runs.loco.t100 < 150, `diesel IC: realistic 0-100 (${fmt(runs.loco.t100, 1)} s)`);
check(runs.hsrE.km390 > 0 && runs.hsrE.km390 <= 15 && runs.hsrE.vmax >= 399.9,
  `hsr_e reaches >=390 km/h within 15 km and sustains its 400 km/h rating (${fmt(runs.hsrE.km390, 2)} km)`);
check(runs.hsrC.kmTop > 0 && runs.hsrC.kmTop < runs.hsrE.kmTop, 'the 300 km/h set reaches its top speed sooner');
const need = brakeDistance(runs.hsrE.brakeAt * KMH_TO_UPS) / 100;
check(runs.hsrE.brakeKm >= need * 0.95 && runs.hsrE.brakeKm <= need * 1.05,
  `hsr_e starts braking a service braking distance out (${fmt(runs.hsrE.brakeKm, 2)} km, needs ${fmt(need, 2)} km)`);

// ---- 4. equal-distance cruise energy: the SAME set at 300 and 400 km/h, without start/stop energy.
const cruise = (kmh: number) => {
  const { t } = straight([{ ...M('hsr_e'), speed: kmh }], 'highspeed', false, 80);
  t.speed = kmh * KMH_TO_UPS;
  const seconds = 3600 / kmh; // 1 km at this speed
  let elapsed = 0;
  while (elapsed < seconds - 1e-9) {
    const dt = Math.min(DT, seconds - elapsed);
    t.update(dt); elapsed += dt;
  }
  const wheel = t.tractionJ / 3.6e6 / t.km / t.capacity * 1000;
  const source = energyCost(consistOf(t.cars), t.tractionJ, t.regenJ, t.auxJ, 2025).kwh / t.km / t.capacity * 1000;
  check(Math.abs(t.km - 1) < 1e-8 && t.regenJ === 0 && Math.abs(t.speedKmh - kmh) < 1e-8, `${kmh} km/h: exactly 1 km of steady motoring`);
  check(Math.abs(t.tractionJ - trainForces(t, kmh / 3.6).resistance * 1000) < 1e-4, `${kmh} km/h: wheel joules equal resistance times metres`);
  return { wheel, source };
};
const e300 = cruise(300), e400 = cruise(400);
console.log(`same hsr_e at cruise: 300/400 = ${fmt(e300.wheel, 2)}/${fmt(e400.wheel, 2)} Wh/seat-km at wheels (+${fmt((e400.wheel / e300.wheel - 1) * 100, 1)}%); with efficiency and hotel = ${fmt(e300.source, 2)}/${fmt(e400.source, 2)} (+${fmt((e400.source / e300.source - 1) * 100, 1)}%)`);
check(e400.wheel / e300.wheel >= 1.6 && e400.wheel / e300.wheel <= 1.8, '400 vs 300 km/h measured wheel energy per seat-km increases 60-80%');
check(e400.source / e300.source >= 1.6 && e400.source / e300.source <= 1.8, '400 vs 300 km/h measured source energy per seat-km increases 60-80%, including hotel load');

// ---- 5. a red block signal: accelerate to 400, stop on the reserved side, wait, then continue on green.
{
  const { g, t, B, blocked } = straight([M('hsr_e')], 'highspeed', true);
  let peak = 0, reached = false, overrun = 0, brake = 0;
  for (let i = 0; i < 1800 / DT; i++) {
    const v0 = t.speedKmh;
    t.update(DT); peak = Math.max(peak, t.speedKmh);
    if (t.speedKmh > 300) brake = Math.max(brake, (v0 - t.speedKmh) / 3.6 / DT);
    if (t.segs.some((s) => s.e === blocked) || t.distToEnd() < -1e-6) overrun++;
    if (t.state === 'waiting' && t.speed === 0) { reached = true; break; }
  }
  check(reached && peak >= 399.9 && overrun === 0 && Math.abs(t.distToEnd()) < 1e-9, '400 km/h train stops exactly at a red block signal without entering the occupied block');
  check(brake >= 0.49 && brake <= 0.51, `red-signal service braking ~0.5 m/s2 at high speed (${fmt(brake, 3)})`);
  const rem = t.distToEnd(), usedKm = t.km, usedJ = t.tractionJ, brakeJ = t.regenJ;
  for (let i = 0; i < 40; i++) t.update(DT);
  check(t.speed === 0 && t.distToEnd() === rem && t.km === usedKm && t.tractionJ === usedJ && t.regenJ === brakeJ && g.vehicles.getRes(blocked) === 2,
    'the train remains behind the red signal, counting no phantom wheel work or distance');
  g.vehicles.releaseRes(blocked, 2);
  for (let i = 0; i < 1800 / DT && t.state !== 'loading'; i++) t.update(DT);
  check(t.state === 'loading' && t.atStation === B.id && t.speed === 0 && Math.abs(t.distToEnd()) < 1e-9,
    'green signal releases the train; it stops at the station without an overrun');
  console.log(`  red signal: peak ${fmt(peak, 1)} km/h, stop ${fmt(rem * 10, 3)} m before signal; high-speed braking ${fmt(brake, 3)} m/s2; zero overruns`);
}

// The actual Game monthly hook also consumes and clears the counters, then starts a fresh accumulation.
{
  const { g, t } = straight([M('hsr_e')]);
  let hadUsage = false;
  while (g.day < DAYS_PER_MONTH) {
    if (t.tractionJ > 0 && t.auxJ > 0 && t.km > 0 && t.hours > 0) hadUsage = true;
    g.update(DT);
  }
  check(hadUsage && keys.every((k) => t[k] === 0) && t.opLast && t.opLast.km > 0 && t.opLast.kwh > 0 && t.opLast.hours > 0,
    'Game month end charges the physical usage and resets all five counters');
  g.update(DT);
  check(t.tractionJ > 0 && t.auxJ > 0 && t.km > 0 && Math.abs(t.hours - DT / 3600) < 1e-12,
    'the first tick of the new month starts fresh physical counters');
  console.log(`  Game monthly hook: ${fmt(t.opLast!.km, 3)} km, ${fmt(t.opLast!.kwh, 2)} kWh, ${fmt(t.opLast!.hours * 3600, 2)} service seconds charged; reset verified`);
}

// No energy is invented for a powerless train, or recovered from passive rolling/aerodynamic resistance.
{
  const { t } = straight([M('coach_ic')]);
  for (let i = 0; i < 100; i++) t.update(DT);
  check(t.speed === 0 && t.km === 0 && t.tractionJ === 0 && t.regenJ === 0 && t.auxJ > 0 && t.hours > 0,
    'an unpowered train stays still, counting only service time and hotel load');
  t.speed = 80 * KMH_TO_UPS;
  for (let i = 0; i < 100; i++) t.update(DT);
  check(t.speedKmh < 80 && t.km > 0 && t.tractionJ === 0 && t.regenJ === 0,
    'passive resistance slows a coasting train without counting it as regenerative braking');
}

// a curve's speed limit on a track segment
{
  const g = flatGame(512);
  for (const type of ['standard', 'highspeed']) {
    const z0 = type === 'standard' ? 100 : 300;
    const p0 = planEdge(g, free(g, 60, z0), free(g, 160, z0), railOpts(0, 1, { type }));
    if (!p0.ok || commitProposal(g, p0)) { check(false, `${type} straight`); continue; }
    const n0 = [...g.world.net.nodes.values()].find((n) => Math.abs(n.x - 160) < 0.5 && Math.abs(n.z - z0) < 0.5)!;
    const e0 = g.world.net.nextEdge;
    const p = planEdge(g, nodeSnap(g, n0.id, 'rail'), free(g, 400, z0 + 70), railOpts(0, 1, { type }));
    if (!p.ok || commitProposal(g, p)) { check(false, `${type} curve line (${p.errors.join(', ')})`); continue; }
    const e = g.world.net.edges.get(e0)!;
    const geo = g.world.net.geo(e);
    const lim = kmh(makeSeg(g, e, 1).limit);
    console.log(`  ${type} edge: min radius ${fmt(geo.minRadius * 10, 0)} m, limit ${fmt(lim, 0)} km/h`);
    check(Math.abs(lim - Math.min(TRACK_TYPES[type].speed, curveSpeed(geo.minRadius, type))) < 1, `${type}: the segment limit follows the curve speed with cant`);
  }
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
