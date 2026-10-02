// Passenger calibration: actual boardings (including transfers), queues and loads in the last full year.
// Bundle into the scratch directory, then run: node ridership.mjs [7,23,51] [years=3] [size=512] [ais=3]
// Save a baseline with --label=before --json=/path/before.json; compare with --compare=/path/before.json.
// Physical service rates are shown separately: a 360-day game year is only 720 seconds at DAY_SECONDS=2.
import { readFileSync, writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import type { Station } from '../src/game/stations';
import { DAY_SECONDS, DAYS_PER_MONTH, MONTHS_PER_YEAR } from '../src/game/constants';
import { GEN_RATE, LD_RATE } from '../src/game/demand';
import { FARE_RATE } from '../src/game/fares';

const positional = process.argv.slice(2).filter((s) => !s.startsWith('--'));
const seeds = (positional[0] ?? '7,23,51').split(',').map(Number);
const years = Number(positional[1] ?? 3), size = Number(positional[2] ?? 512), ais = Number(positional[3] ?? 3);
if (years < 2 || !Number.isInteger(years) || seeds.some((s) => !Number.isFinite(s))) throw new Error('Use finite seeds and at least two whole years');
const flag = (name: string) => process.argv.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3);
const yearDays = DAYS_PER_MONTH * MONTHS_PER_YEAR, yearSeconds = yearDays * DAY_SECONDS;
const lastYearStart = (years - 1) * yearDays;
const label = flag('label') ?? 'current';
const f = (n: number, digits = 1) => n.toFixed(digits);
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const percentile = (xs: number[], p: number) => {
  if (!xs.length) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
};
interface StationStats {
  id: number; name: string; town: number; mode: string; catchPop: number;
  months: number[]; waiting: number[];
}
interface VehicleStats {
  id: number; name: string; line: string; mode: string; capacity: number; loads: number[];
}
interface Run {
  g: Game; stations: Map<number, StationStats>; vehicles: Map<number, VehicleStats>;
}
let active: Run | undefined;
function stationStats(run: Run, st: Station): StationStats {
  let s = run.stations.get(st.id);
  if (!s) {
    s = { id: st.id, name: st.name, town: st.townId, mode: run.g.stations.mode(st), catchPop: st.catchPop, months: Array(MONTHS_PER_YEAR).fill(0), waiting: [] };
    run.stations.set(st.id, s);
  }
  s.name = st.name; s.town = st.townId; s.catchPop = st.catchPop;
  return s;
}
// Wrap the real boarding operation: monthly counters reset and many stations have no train visit in a month.
// Summing true pickups over all twelve months avoids extrapolating an empty/peak month into a year.
const serve = Vehicle.prototype.serveStation;
Vehicle.prototype.serveStation = function (st, perPax) {
  const before = st.pickupMonth, dwell = serve.call(this, st, perPax);
  if (active && active.g.day >= lastYearStart && active.g.day < years * yearDays) {
    const month = Math.floor((active.g.day - lastYearStart) / DAYS_PER_MONTH);
    stationStats(active, st).months[month] += st.pickupMonth - before;
  }
  return dwell;
};

const reports = [];
console.log(`${label}: GEN_RATE=${GEN_RATE}, LD_RATE=${LD_RATE}, FARE_RATE=${FARE_RATE}; ${yearSeconds}s of physical service/game year`);
console.log('Boardings/day = a literal 16-hour physical service day; annual/res = measured game-year boardings / town population. These clocks are deliberately separate.');
for (const seed of seeds) {
  const started = performance.now();
  const g = Game.create({ size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: ais });
  const run: Run = { g, stations: new Map(), vehicles: new Map() };
  active = run;
  let ticks = 0;
  while (g.day < years * yearDays) {
    g.update(0.25);
    if (++ticks % 4 || g.day < lastYearStart || g.day >= years * yearDays) continue;
    // One sample per physical second, including zero queues and empty vehicles. Retain sold/closed services.
    for (const st of g.stations.map.values()) stationStats(run, st).waiting.push(st.waitingTotal);
    for (const v of g.vehicles.map.values()) {
      if (!v.line || v.capacity <= 0 || !['running', 'loading', 'waiting'].includes(v.state)) continue;
      let s = run.vehicles.get(v.id);
      if (!s) {
        s = { id: v.id, name: v.name, line: v.line.name, mode: v.line.kind, capacity: v.capacity, loads: [] };
        run.vehicles.set(v.id, s);
      }
      s.name = v.name; s.line = v.line.name; s.capacity = v.capacity;
      s.loads.push(v.load / v.capacity);
    }
  }
  active = undefined;
  const stations = [...run.stations.values()].map((s) => ({ ...s, annual: s.months.reduce((a, b) => a + b, 0), waitMean: mean(s.waiting), waitP50: percentile(s.waiting, 0.5), waitP90: percentile(s.waiting, 0.9), waitMax: Math.max(0, ...s.waiting) }));
  const vehicles = [...run.vehicles.values()].map((v) => ({ ...v, loadMean: mean(v.loads), loadP90: percentile(v.loads, 0.9), full: mean(v.loads.map((x) => x >= 0.95 ? 1 : 0)) }));
  const towns = g.towns.list.map((t) => ({ id: t.id, name: t.name, pop: t.pop, annual: stations.filter((s) => s.town === t.id).reduce((a, s) => a + s.annual, 0) }));
  console.log(`\nseed ${seed}, year ${g.year - 1}, ${ais} AI, ${f((performance.now() - started) / 1000)}s; population ${towns.reduce((a, t) => a + t.pop, 0)}`);
  console.log('town / station (mode)                         pop/catch   board/mo avg [min..max]  board/year  /resident   /16h-day  waiting mean/p50/p90/max');
  for (const t of towns.sort((a, b) => a.pop - b.pop)) {
    console.log(`${t.name.padEnd(45)} ${String(t.pop).padStart(8)}                           ${String(t.annual).padStart(10)} ${f(t.annual / Math.max(1, t.pop), 2).padStart(10)}`);
    for (const s of stations.filter((s) => s.town === t.id).sort((a, b) => a.id - b.id)) {
      console.log(`  ${(`${s.id} ${s.name} (${s.mode})`).padEnd(43)} ${f(s.catchPop, 0).padStart(8)} ${f(s.annual / MONTHS_PER_YEAR).padStart(10)} [${Math.min(...s.months)}..${Math.max(...s.months)}] ${String(s.annual).padStart(10)} ${f(s.annual / Math.max(1, t.pop), 2).padStart(10)} ${f(s.annual / yearSeconds * 16 * 3600, 0).padStart(10)}  ${f(s.waitMean)}/${s.waitP50}/${s.waitP90}/${s.waitMax}`);
    }
  }
  console.log('vehicle / line (mode, seats)                 load mean / p90 / time >=95%');
  for (const v of vehicles) console.log(`  ${`${v.id} ${v.name} / ${v.line} (${v.mode}, ${v.capacity})`.padEnd(70)} ${f(v.loadMean * 100)}% / ${f(v.loadP90 * 100)}% / ${f(v.full * 100)}%`);
  const rail = stations.filter((s) => !['bus', 'road', 'tram'].includes(s.mode));
  const summary = {
    seed, annual: stations.reduce((a, s) => a + s.annual, 0), railAnnual: rail.reduce((a, s) => a + s.annual, 0),
    railStations: rail.length, railWaitP90: percentile(rail.flatMap((s) => s.waiting), 0.9),
    loadMean: mean(vehicles.flatMap((v) => v.loads)), full: mean(vehicles.flatMap((v) => v.loads.map((x) => x >= 0.95 ? 1 : 0))),
  };
  console.log(`TOTAL: ${summary.annual} boardings/year (${summary.railAnnual} rail), rail waiting p90 ${summary.railWaitP90}, load ${f(summary.loadMean * 100)}%, full ${f(summary.full * 100)}%, ${summary.railStations} rail stations`);
  reports.push({ ...summary, towns, stations, vehicles });
}
const baselinePath = flag('compare');
if (baselinePath) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as { reports: typeof reports };
  console.log('\nBefore -> after (same seeds; AI projects and town growth can change):');
  for (const r of reports) {
    const b = baseline.reports.find((s) => s.seed === r.seed);
    if (b) console.log(`seed ${r.seed}: board/year ${b.annual} -> ${r.annual}; rail ${b.railAnnual} -> ${r.railAnnual}; rail wait p90 ${b.railWaitP90} -> ${r.railWaitP90}; load ${f(b.loadMean * 100)}% -> ${f(r.loadMean * 100)}%; full ${f(b.full * 100)}% -> ${f(r.full * 100)}%; rail stations ${b.railStations} -> ${r.railStations}`);
  }
}
const json = flag('json');
if (json) writeFileSync(json, JSON.stringify({ label, years, size, ais, yearSeconds, genRate: GEN_RATE, ldRate: LD_RATE, fareRate: FARE_RATE, reports }, null, 2) + '\n');
