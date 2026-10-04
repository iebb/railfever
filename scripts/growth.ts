// Town growth against public transport service: 20-year runs on 768 maps with AI companies (two seeds by default).
// Towns are classed by the service they had (residents near active stations, passengers transported rather than
// giving up waiting), then their growth is compared with the targets of towns.ts; the passengers who gave up waiting
// are counted per year (and checked against the stations' and towns' own counters).
// npx esbuild scripts/growth.ts --bundle --platform=node --format=esm --outfile=$S/growth.mjs && node $S/growth.mjs [seeds] [years] [size]
//   [--ai=3] [--year=1950] [--out=runs.json: dump the monthly samples] [--report=runs.json,...: report earlier dumps only]
//   [--check-report: run checks on dumps] [--legacy-activity: compare the original 30-day cohort]
import { readFileSync, writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import type { Station } from '../src/game/stations';
import { townService, GROWTH_ACTIVE_DAYS } from '../src/game/towns';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { fails, check, fmt, busStopSites, addBusStop, roadDepotNear } from './lib';

/** Monthly sample: stations called this month and active for growth, catchments, passengers and service. */
interface Month { pop: number; act: number; act90: number; catch: number; gen: number; trans: number; lost: number; boarded: number; rating: number; calls: number; score?: number; speed?: number }
interface TownLog { id: number; name: string; profile: string; pop0: number; months: Month[] }
interface Year { year: number; gen: number; lost: number; ms: number; ticks: number; ambient: number; vehicles: number; pop: number }
interface Run { seed: number; size: number; years: number; towns: TownLog[]; yearly: Year[] }
type Cls = 'well served' | 'poorly served' | 'unserved';

/**
 * Classes by the service a town had over the run (fixed, so older runs dumped with --out compare alike): unserved
 * with a station active under GROWTH_ACTIVE_DAYS in under 5 % of the months (essentially no service: a town served
 * now and then, e.g. 23 of 240 months by coaches, grows from that service and is poorly served), well served with one in at least half of
 * them and a service level (below) of at least 0.08, else poorly served.
 */
const UNSERVED_MONTHS = 0.05, WELL_MONTHS = 0.5, WELL_SERVICE = 0.08;
/**
 * Target growth over 20 years per class (the geometric mean of the class: a few towns hemmed in by their neighbours
 * or the terrain hardly grow whatever their service), with some room for the two-seed sample.
 */
const TARGET: Record<Cls, [number, number]> = { 'well served': [1.6, 2.5], 'poorly served': [1.3, 1.6], 'unserved': [1.1, 1.3] };
const SLACK = 0.1;
/** Ceilings on the share of passengers who give up waiting: over a run of ten years or more, and in its last year. */
const ABANDON_RUN = 0.3, ABANDON_YEAR = 0.35;

const argv = process.argv.slice(2);
const pos = argv.filter((a) => !a.startsWith('--'));
const opt = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const seeds = (pos[0] ?? '7,23').split(',').map(Number);
const YEARS = Number(pos[1] ?? 20), SIZE = Number(pos[2] ?? 768), NAI = Number(opt('ai') ?? 3);
const START = Number(opt('year') ?? 1950);
// Diagnostic comparison with the original 30-day activity cohort; normal checks follow townService.
const legacyActivity = argv.includes('--legacy-activity');
const defaultTowns = (size: number) => Math.max(3, Math.min(40, Math.round(3.2 * (size / 384) ** 2)));

/** One seed: AI companies build their networks; monthly samples of every town. */
function simulate(seed: number): Run {
  const T0 = performance.now();
  const g = Game.create({ size: SIZE, seed, towns: defaultTowns(SIZE), hilliness: 'hilly', water: 'medium', startYear: START, aiCompanies: NAI });
  const genMs = performance.now() - T0;
  // passengers who gave up waiting, counted independently of the game's counters (the queue cap: trimWaiting)
  const lostSt = new Map<number, number>(), lostTown = new Map<number, number>();
  const S = g.stations as unknown as { trimWaiting: (st: Station, max: number) => void };
  const trim = S.trimWaiting.bind(g.stations);
  S.trimWaiting = (st: Station, max: number) => {
    const before = st.waitingTotal;
    trim(st, max);
    const n = before - st.waitingTotal;
    if (n) { lostSt.set(st.id, (lostSt.get(st.id) ?? 0) + n); lostTown.set(st.townId, (lostTown.get(st.townId) ?? 0) + n); }
  };
  const calls = new Map<number, number>();
  const logs: TownLog[] = g.towns.list.map((t) => ({ id: t.id, name: t.name, profile: t.profile ?? 'balanced', pop0: t.pop, months: [] }));
  const yearly: Year[] = [];
  let yGen = 0, yLost = 0, yMs = 0, yTicks = 0, counterErr = 0;
  const T1 = performance.now();
  while (g.day < YEARS * 360) {
    const t = performance.now();
    for (let i = 0; i < g.ticksPerDay; i++) g.stepTick();
    yMs += performance.now() - t; yTicks += g.ticksPerDay;
    // a vehicle called at the station yesterday (lastCall: only vehicles set it; building a station is no call)
    for (const st of g.stations.map.values()) if (st.lastCall >= 0 && g.day - st.lastCall === 1) calls.set(st.id, (calls.get(st.id) ?? 0) + 1);
    if (g.day % 30 !== 0) continue;
    // month end (the game has moved this month's counters to *Last): its counters of passengers who gave up against
    // ours; the stations' counters: their own passengers, plus those of stations merged into them during the month
    let mine = 0, all = 0, counted = 0;
    for (const [id, n] of lostSt) { all += n; if (g.stations.get(id)) mine += n; }
    for (const st of g.stations.map.values()) counted += st.lostLast;
    if (counted < mine || counted > all) { counterErr++; console.log(`  ${g.dateString()}: stations' lostLast ${counted}, counted ${mine} (${all} with removed stations)`); }
    yLost += all;
    for (const L of logs) {
      const town = g.towns.list[L.id];
      if ((town.passLostLast ?? 0) !== (lostTown.get(L.id) ?? 0)) { counterErr++; console.log(`  ${g.dateString()}: ${town.name} passLostLast ${town.passLostLast}, counted ${lostTown.get(L.id) ?? 0}`); }
      let act = 0, act90 = 0, cp = 0, rt = 0, cl = 0, boarded = 0;
      for (const st of g.stations.map.values()) {
        if (!g.lines.stationServed(st.id) || Math.hypot(st.x - town.x, st.z - town.z) > town.radius + 10) continue;
        if (st.lastCall >= 0 && g.day - st.lastCall <= GROWTH_ACTIVE_DAYS) act90++;
        const c30 = calls.get(st.id) ?? 0;
        if (c30 <= 0) continue;
        act++; cp += st.catchPop; rt += st.rating * st.catchPop; cl += c30 * st.catchPop; boarded += st.pickupLast;
      }
      const sv = townService(g, town);
      L.months.push({
        pop: town.pop, act, act90, catch: Math.round(cp), gen: town.passGenLast, trans: town.passTransLast, lost: lostTown.get(L.id) ?? 0, boarded,
        rating: cp > 0 ? rt / cp : 0, calls: cp > 0 ? cl / cp : 0, score: sv.score, speed: sv.speed,
      });
      yGen += town.passGenLast;
    }
    lostSt.clear(); lostTown.clear(); calls.clear();
    if (g.day % 360 === 0) {
      const y: Year = { year: START + g.day / 360 - 1, gen: yGen, lost: yLost, ms: yMs, ticks: yTicks, ambient: g.vehicles.ambient.length, vehicles: g.vehicles.map.size, pop: g.towns.list.reduce((a, t) => a + t.pop, 0) };
      yearly.push(y);
      console.log(`  ${seed} ${y.year}: pop ${y.pop}, ${y.vehicles} vehicles, ${y.ambient} town cars, passengers ${y.gen}, gave up ${y.lost} (${fmt((100 * y.lost) / Math.max(1, y.gen), 0)}%), ${fmt(y.ms / y.ticks, 3)} ms/tick`);
      yGen = 0; yLost = 0; yMs = 0; yTicks = 0;
    }
  }
  console.log(`seed ${seed}: ${g.towns.list.length} towns, gen ${fmt(genMs / 1000, 1)} s, ${YEARS} years in ${fmt((performance.now() - T1) / 1000, 0)} s`);
  check(counterErr === 0, `seed ${seed}: station and town counters of passengers who gave up waiting match ours (${counterErr} mismatches)`);
  return { seed, size: SIZE, years: YEARS, towns: logs, yearly };
}

/**
 * The service history of stations: building a station is no call (a town is not served before a vehicle calls), and
 * the service frequency is the share of the last 30 days with a call (none left 31 days after the last one).
 */
function historyChecks() {
  const g = Game.create({ size: 256, seed: 3, towns: 3, hilliness: 'flat', water: 'low', startYear: 1990 });
  g.vehicles.ambientEnabled = false;
  const town = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const sites = busStopSites(g, town, 0, 10, 30);
  const ids = sites.map(([x, z]) => addBusStop(g, x, z, 0));
  const depot = sites.length ? roadDepotNear(g, sites[0][0], sites[0][1], 0) : -1;
  if (ids.length < 2 || ids.some((id) => id < 0) || depot < 0) { console.log('  service history: no bus line could be built (skipped)'); return; }
  const line = g.lines.create('road', 0);
  line.stops = ids;
  g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, line.id);
  g.lines.rebuild();
  const st = ids.map((id) => g.stations.get(id)!);
  const sv0 = townService(g, town);
  check(st.every((s) => s.lastCall === -1 && s.callDays === 0) && sv0.stations === 0 && sv0.speed === 1,
    `a bus line in its depot does not serve the town yet (${sv0.stations} active stations, speed ${fmt(sv0.speed, 2)})`);
  // a vehicle calls every day for 90 days, then none: the share of the last 30 days with a call
  const s0 = st[0];
  const day = () => { g.day = g.day + 1; g.stations.updateRatings(); };
  for (let d = 0; d < 90; d++) { s0.lastCall = g.day; day(); }
  const lastCall = s0.lastCall, full = g.stations.callShare(s0);
  while (g.day < lastCall + 30) day();
  const at30 = g.stations.callShare(s0);
  day();
  const at31 = g.stations.callShare(s0);
  const active31 = townService(g, town).stations;
  check(full === 1 && Math.abs(at30 - 1 / 30) < 1e-9 && at31 === 0,
    `service frequency: share of the last 30 days with a call (${fmt(full, 3)}; 30 days after the last call ${fmt(at30, 3)}, 31 days ${fmt(at31, 3)})`);
  while (g.day < lastCall + GROWTH_ACTIVE_DAYS) day();
  const active90 = townService(g, town).stations;
  day();
  const expired = townService(g, town);
  check(active31 === 1 && active90 === 1 && expired.stations === 0 && expired.speed === 1,
    `growth service remains active through ${GROWTH_ACTIVE_DAYS} days and expires after ${GROWTH_ACTIVE_DAYS + 1} (${active31}; ${active90}; ${expired.stations})`);
}

/**
 * A town's service over the run: the share of its residents near stations a vehicle called at each month, times the
 * share of passengers who did not give up waiting (months without passengers: all), averaged over the months; and
 * the share of the months with a station active under the production GROWTH_ACTIVE_DAYS window.
 */
function service(L: TownLog): { level: number; active: number; coverage: number; transported: number } {
  let level = 0, active = 0, coverage = 0, gen = 0, lost = 0;
  for (const m of L.months) {
    const c = m.pop > 0 ? Math.min(1, m.catch / m.pop) : 0;
    const T = m.gen > 0 ? Math.max(0, Math.min(1, 1 - m.lost / m.gen)) : 1;
    level += c * T; coverage += c; gen += m.gen; lost += m.lost;
    if ((legacyActivity ? m.act : m.act90) > 0) active++;
  }
  const n = Math.max(1, L.months.length);
  return { level: level / n, active: active / n, coverage: coverage / n, transported: gen > 0 ? Math.max(0, 1 - lost / gen) : 1 };
}
function classOf(s: ReturnType<typeof service>): Cls {
  return s.active < UNSERVED_MONTHS ? 'unserved' : s.active >= WELL_MONTHS && s.level >= WELL_SERVICE ? 'well served' : 'poorly served';
}
function median(a: number[]): number {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? (b.length % 2 ? b[(b.length - 1) / 2] : (b[b.length / 2 - 1] + b[b.length / 2]) / 2) : NaN;
}
const geomean = (a: number[]) => Math.exp(a.reduce((s, x) => s + Math.log(x), 0) / Math.max(1, a.length));
function fmtK(n: number) { return n >= 10000 ? `${fmt(n / 1000, 0)}k` : String(n); }

/** The towns by class with their growth, the class means against the targets, and the passengers who gave up. */
function report(runs: Run[], checks: boolean) {
  const by = new Map<Cls, number[]>();
  console.log(`\ntowns (active: ${legacyActivity ? 'legacy 30-day calls' : `production ${GROWTH_ACTIVE_DAYS}-day history`}; near: residents near stations called at this month; service: near x transported)`);
  console.log('  seed town                 profile       pop ->    pop  growth  active  near  transp.  service  speed  class');
  for (const r of runs) {
    const rows = r.towns.map((L) => ({ L, s: service(L), end: L.months[L.months.length - 1]?.pop ?? L.pop0 })).sort((a, b) => b.s.level - a.s.level);
    for (const { L, s, end } of rows) {
      const cls = classOf(s), ratio = end / Math.max(1, L.pop0);
      const sp = L.months.filter((m) => m.speed !== undefined);
      const speed = sp.length ? fmt(sp.reduce((a, m) => a + m.speed!, 0) / sp.length, 1) : '-';
      by.set(cls, [...(by.get(cls) ?? []), ratio]);
      console.log(`  ${String(r.seed).padStart(4)} ${L.name.padEnd(20)} ${L.profile.padEnd(10)} ${String(L.pop0).padStart(6)} -> ${String(end).padStart(6)}  ${fmt(ratio, 2)}x  ${fmt(s.active * 100, 0).padStart(4)}%  ${fmt(s.coverage * 100, 0).padStart(3)}%  ${fmt(s.transported * 100, 0).padStart(5)}%    ${fmt(s.level, 3)}  ${speed.padStart(5)}  ${cls}`);
    }
  }
  console.log('\ngrowth by class (geometric mean, median, range; target)');
  const order: Cls[] = ['well served', 'poorly served', 'unserved'];
  const mean = new Map<Cls, number>();
  for (const c of order) {
    const a = by.get(c) ?? [];
    if (!a.length) { console.log(`  ${c.padEnd(14)} no towns`); continue; }
    mean.set(c, geomean(a));
    console.log(`  ${c.padEnd(14)} ${String(a.length).padStart(2)} towns: ${fmt(geomean(a), 2)}x, median ${fmt(median(a), 2)}x, ${fmt(Math.min(...a), 2)}-${fmt(Math.max(...a), 2)}x (target ${TARGET[c][0]}-${TARGET[c][1]}x)`);
  }
  console.log('\npassengers who gave up waiting (all towns; per year)');
  const nYears = Math.max(...runs.map((r) => r.yearly.length));
  // every fourth year and the last one
  for (const i of [...new Set([...Array.from({ length: Math.ceil(nYears / 4) }, (_, k) => k * 4), nYears - 1])]) {
    console.log('  ' + runs.map((r) => { const y = r.yearly[i]; return y ? `${r.seed} ${y.year}: ${fmtK(y.lost)} of ${fmtK(y.gen)} (${fmt((100 * y.lost) / Math.max(1, y.gen), 0)}%)` : ''; }).join('   '));
  }
  const tot = runs.map((r) => r.yearly.reduce((a, y) => [a[0] + y.gen, a[1] + y.lost], [0, 0]));
  console.log('  all years: ' + runs.map((r, i) => `${r.seed}: ${fmtK(tot[i][1])} of ${fmtK(tot[i][0])} (${fmt((100 * tot[i][1]) / Math.max(1, tot[i][0]), 0)}%)`).join(', '));
  const ms = runs.flatMap((r) => r.yearly), ticks = ms.reduce((a, y) => a + y.ticks, 0);
  if (ticks) console.log(`  simulation: ${fmt(ms.reduce((a, y) => a + y.ms, 0) / ticks, 3)} ms per tick (AI included), ${Math.max(...ms.map((y) => y.ambient))} town cars at most`);
  if (!checks) return;
  // An independent ceiling on passengers who give up waiting (the queue cap: the AI's fleets against the demand its
  // catchments raise), over the run and in its last year, so a recalibration cannot hide overloaded networks.
  for (const [i, r] of runs.entries()) {
    const share = tot[i][1] / Math.max(1, tot[i][0]), last = r.yearly[r.yearly.length - 1];
    const lastShare = last ? last.lost / Math.max(1, last.gen) : 0;
    if (r.yearly.length < 10) continue;
    check(share <= ABANDON_RUN, `seed ${r.seed}: ${fmt(share * 100, 0)}% of the passengers give up waiting over the run (at most ${ABANDON_RUN * 100}%)`);
    check(lastShare <= ABANDON_YEAR, `seed ${r.seed}: ${fmt(lastShare * 100, 0)}% give up waiting in the last year (at most ${ABANDON_YEAR * 100}%)`);
  }
  // growth responds to service: classes in order, their means near the targets (scaled to the run's length)
  const years = Math.max(...runs.map((r) => r.yearly.length));
  const scale = (x: number) => Math.pow(x, years / 20);
  for (const c of order) {
    const m = mean.get(c);
    if (m === undefined || years < 10) continue;
    check(m >= scale(TARGET[c][0] - SLACK) && m <= scale(TARGET[c][1] + SLACK), `${c} towns grow ${fmt(m, 2)}x in ${years} years (target ${fmt(scale(TARGET[c][0]), 2)}-${fmt(scale(TARGET[c][1]), 2)}x)`);
  }
  const w = mean.get('well served'), p = mean.get('poorly served'), u = mean.get('unserved');
  if (w !== undefined && u !== undefined) check(w > u, 'well-served towns grow faster than unserved ones');
  if (w !== undefined && p !== undefined) check(w > p, 'well-served towns grow faster than poorly served ones');
  if (p !== undefined && u !== undefined) check(p > u, 'poorly served towns grow faster than unserved ones');
}

// --report=a.json,b.json: report earlier dumps; --check-report also runs history and report assertions.
const reportOnly = opt('report');
const checkReport = argv.includes('--check-report');
if (!reportOnly || checkReport) historyChecks();
const runs: Run[] = reportOnly ? reportOnly.split(',').flatMap((f) => JSON.parse(readFileSync(f, 'utf8')) as Run[]) : seeds.map(simulate);
const out = opt('out');
if (out && !reportOnly) writeFileSync(out, JSON.stringify(runs));
report(runs, !reportOnly || checkReport);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
