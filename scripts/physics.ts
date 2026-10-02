// Train physics (UPDATE 9j): braking curve and distances, curve speeds with cant, Davis resistance with per-train
// aerodynamics, acceleration and top speed of high-speed sets by era, conventional EMU / locomotive trains, and the
// energy counters opcosts reads (tractionJ, regenJ, auxJ, km, hours).
// npx esbuild scripts/physics.ts --bundle --platform=node --format=esm --outfile=$S/physics.mjs && node $S/physics.mjs [size]
import { MODEL_BY_ID, VehicleModel, aeroOf } from '../src/game/vehicle-types';
import { Train, brakeDistance, brakeSpeed, brakeRate, makeSeg } from '../src/game/train';
import { curveSpeed, planEdge, commitProposal } from '../src/game/construction';
import { KMH_TO_UPS, TRACK_TYPES } from '../src/game/constants';
import { flatGame, station, endNode, depotFor, fails, check, fmt, free, railOpts, nodeSnap } from './stationlib';

const SIZE = Number(process.argv[2] ?? 2048);
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

// ---- 2. runs on a long straight line
interface Run { id: string; vmax: number; t100: number; t200: number; t300: number; reached: number; dist: number; brakeAt: number; trip: number; tractionKWh: number; regenKWh: number; auxKWh: number; km: number; hours: number; seats: number }
function run(type: string, cars: VehicleModel[], label: string): Run | null {
  const g = flatGame(SIZE);
  const z = SIZE / 2, x0 = 80, x1 = SIZE - 40;
  const A = station(g, x0, z, Math.PI / 2, 16, 1, 0, { trackType: type } as never), B = station(g, x1, z, Math.PI / 2, 16, 1, 0, { trackType: type } as never);
  if (!A || !B) { check(false, `${label}: stations`); return null; }
  const p = planEdge(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 1, { type }));
  if (!p.ok || commitProposal(g, p)) { check(false, `${label}: line built (${p.errors.join(', ')})`); return null; }
  const dep = depotFor(g, A, B);
  const l = g.lines.create('rail', 0);
  l.stops = [A.id, B.id];
  const t = g.vehicles.buyTrain(dep, cars, l.id);
  if (!(t instanceof Train)) { check(false, `${label}: train bought (${t})`); return null; }
  const r: Run = { id: label, vmax: 0, t100: -1, t200: -1, t300: -1, reached: -1, dist: 0, brakeAt: -1, trip: -1, tractionKWh: 0, regenKWh: 0, auxKWh: 0, km: 0, hours: 0, seats: t.capacity };
  g.speed = 1;
  let started = -1, time = 0, prevV = 0, loadedA = false;
  const top = t.maxSpeedKmh;
  // the counters are taken and reset monthly by opcosts: sum their increments
  const keys = ['tractionJ', 'regenJ', 'auxJ', 'km', 'hours'] as const;
  const sum = { tractionJ: 0, regenJ: 0, auxJ: 0, km: 0, hours: 0 }, prev = { tractionJ: 0, regenJ: 0, auxJ: 0, km: 0, hours: 0 };
  for (let i = 0; i < 20 * 60 * 30 && r.trip < 0; i++) {
    g.update(0.05);
    time += 0.05;
    for (const k of keys) { const c = t[k]; if (started >= 0) sum[k] += c >= prev[k] ? c - prev[k] : c; prev[k] = c; }
    if (!t.onMap) continue;
    const v = t.speedKmh;
    if (t.state === 'loading' && t.atStation === A.id) { loadedA = true; continue; }
    if (!loadedA) continue;
    if (started < 0) { started = time; for (const k of keys) prev[k] = t[k]; }
    const el = time - started;
    if (r.t100 < 0 && v >= 100) r.t100 = el;
    if (r.t200 < 0 && v >= 200) r.t200 = el;
    if (r.t300 < 0 && v >= 300) r.t300 = el;
    if (r.reached < 0 && v >= top - 2) r.reached = el;
    if (v > r.vmax) r.vmax = v;
    if (r.brakeAt < 0 && v < prevV - 0.3 && v > 50) {
      // braking for the terminus: what is left to its platform
      let d = 0; const hs = t.segs[t.headSeg]; d = hs.len - t.headPos; for (let k = t.headSeg + 1; k < t.segs.length; k++) d += t.segs[k].len;
      r.brakeAt = v; r.dist = d * 10;
    }
    prevV = v;
    if (t.state === 'loading' && t.atStation === B.id) r.trip = el;
  }
  r.tractionKWh = sum.tractionJ / 3.6e6; r.regenKWh = sum.regenJ / 3.6e6; r.auxKWh = sum.auxJ / 3.6e6; r.km = sum.km; r.hours = sum.hours;
  console.log(`  ${label} (${cars.map((c) => c.id).join('+')}, ${fmt(t.mass, 0)} t, ${t.power} kW, ${r.seats} seats) on ${type}: top ${fmt(r.vmax, 0)} km/h (0-100 ${fmt(r.t100, 0)} s, 0-200 ${fmt(r.t200, 0)} s, 0-300 ${fmt(r.t300, 0)} s, to top ${fmt(r.reached, 0)} s); braking from ${fmt(r.brakeAt, 0)} km/h ${fmt(r.dist / 1000, 2)} km out; trip ${fmt(r.km, 1)} km in ${fmt(r.trip / 60, 1)} min; ` +
    `wheels ${fmt(r.tractionKWh, 0)} kWh (${fmt(r.tractionKWh / Math.max(0.1, r.km), 1)} kWh/km, ${fmt((r.tractionKWh / Math.max(0.1, r.km) / r.seats) * 1000, 1)} Wh/seat-km), brakes ${fmt(r.regenKWh, 0)} kWh, hotel ${fmt(r.auxKWh, 1)} kWh, ${fmt(r.hours * 60, 1)} min`);
  return r;
}

console.log(`runs on a ${fmt((SIZE - 120) / 100, 1)} km straight line:`);
const M = (id: string) => MODEL_BY_ID.get(id)!;
const runs = {
  loco: run('standard', [M('diesel_b'), ...Array(6).fill(M('coach_ic'))], 'diesel IC'),
  emu: run('electric', [M('emu_b')], 'suburban EMU'),
  hsrA: run('highspeed', [M('hsr_a')], 'HSR 1964'),
  hsrC: run('highspeed', [M('hsr_c')], 'HSR 1997'),
  hsrE: run('highspeed', [M('hsr_e')], 'HSR 2025'),
};
for (const [k, r] of Object.entries(runs)) check(r && r.trip > 0, `${k}: reaches the far station`);
if (runs.emu) check(runs.emu.t100 > 25 && runs.emu.t100 < 70, `suburban EMU: 0-100 km/h in 25-70 s (${fmt(runs.emu.t100, 0)})`);
if (runs.loco) check(runs.loco.t100 > 40 && runs.loco.t100 < 150, `diesel IC: 0-100 km/h in 40-150 s (${fmt(runs.loco.t100, 0)})`);
if (runs.hsrE) {
  check(runs.hsrE.vmax > 380, `HSR 2025 reaches its 400 km/h on a long line (${fmt(runs.hsrE.vmax, 0)})`);
  check(runs.hsrE.dist > 8000, `HSR 2025 brakes for the terminus from far out (${fmt(runs.hsrE.dist / 1000, 1)} km at ${fmt(runs.hsrE.brakeAt, 0)} km/h)`);
}
if (runs.hsrC) check(runs.hsrC.vmax > 290 && runs.hsrC.t300 > 0, `HSR 1997 reaches 300 km/h (${fmt(runs.hsrC.vmax, 0)})`);
if (runs.hsrC && runs.hsrE) {
  const per = (r: Run) => r.tractionKWh / r.km / r.seats;
  console.log(`  energy at the wheels per seat-km: 400 km/h set ${fmt((per(runs.hsrE) / per(runs.hsrC) - 1) * 100, 0)} % over the 300 km/h set`);
  check(per(runs.hsrE) > per(runs.hsrC) * 1.25, 'the 400 km/h set uses clearly more energy per seat-km than the 300 km/h set');
}
for (const r of Object.values(runs)) if (r) check(r.tractionKWh > 0 && r.regenKWh > 0 && r.auxKWh > 0 && Math.abs(r.km - (SIZE - 120 - 32) / 100) < 1.5 && r.hours > 0, `${r.id}: energy counters (traction, brakes, hotel, km, hours) accumulate`);
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
