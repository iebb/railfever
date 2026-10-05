// Natural city-rail benchmark. Bundle as citylines.mjs, then node citylines.mjs [--full] [--json=/scratch/results.json].
// Default: two ten-year 512 maps; full: seeds 5/7/11/23/51/61 at 512 and 768. No artificial demand or forced builds.
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { URBAN_PAYBACK, discountedPayback } from '../src/game/constants';
import { railPartMode } from '../src/game/stations';
import { depotUpkeep } from '../src/game/build-ops';
import { check, fails, fmt } from './lib';
import { writeFileSync } from 'node:fs';

const full = process.argv.includes('--full');
const arg = (key: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3);
const seeds = arg('seeds')?.split(',').map(Number) ?? (full ? [5, 7, 11, 23, 51, 61] : [11, 61]);
const sizes = arg('sizes')?.split(',').map(Number) ?? (full ? [512, 768] : [512]);
const years = Number(arg('years') ?? 10);
const modeOf = (g: Game, id: number) => { const r = g.stations.get(id)?.rail; return r ? railPartMode(r) : undefined; };
const urban = (g: Game, l: ReturnType<Game['lines']['all']>[number]) => l.kind === 'rail'
  && l.stops.some((id) => modeOf(g, id) === 'metro' || modeOf(g, id) === 'lightrail');
const annuity = discountedPayback;
// Recorded release 2.8.1 (9a3e3b6), same generated maps, calendar, companies and disabled acquisitions.
const release281: Record<string, number> = {
  '512:5': 0, '512:7': 1, '512:11': 0, '512:23': 0, '512:51': 0, '512:61': 0,
  '768:5': 2, '768:7': 0, '768:11': 1, '768:23': 3, '768:51': 1, '768:61': 2,
};
interface Opening {
  id: number; owner: number; mode: 'metro' | 'lightrail'; day: number; forecast: number; forecastCost: number;
  quotedCapital: number; capital: number; rate: number; depot: number; edges: number[];
  years: { year: number; age: number; receipts: number; costs: number; surplus: number }[];
}
const results: any[] = [];
let total = 0, baseline = 0, mature = 0, capital = 0, recovered = 0;
for (const size of sizes) for (const seed of seeds) {
  const started = performance.now();
  const g = Game.create({ size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  // Acquisitions can hide a distressed operator; keep all three books visible in every comparison.
  g.aiAcquisitions = false;
  const initialPop = g.towns.list.reduce((n, t) => n + t.pop, 0), openings = new Map<number, Opening>();
  const funding = new Map<object, { spent: number }>();
  const rejection: Record<string, number> = {};
  let bankrupt = false, exceptions = 0;
  for (const ai of g.ais) {
    const a = ai as AIController & Record<string, any>;
    const survey = a.urbanStep;
    a.urbanStep = function* (...args: any[]) {
      const layout = yield* survey.apply(this, args), e = layout.quote;
      const mode = args[1] as 'metro' | 'lightrail';
      const reason = !e ? 'no affordable stage' : e.total * 1.05 > a.urbanAvailable() ? 'capital'
        : e.net * annuity(URBAN_PAYBACK[mode], ai.eco.interestRate) < e.total ? 'payback' : 'viable';
      rejection[reason] = (rejection[reason] ?? 0) + 1;
      return layout;
    };
    // Count actual construction/vehicle receipts for this funded project, including completion and its fleet.
    const spend = ai.eco.spend.bind(ai.eco), earn = ai.eco.earn.bind(ai.eco);
    ai.eco.spend = (amount, category = 'construction', force = false) => {
      const ok = spend(amount, category, force), p = a.project;
      if (ok && p && (p.kind === 'metro' || p.kind === 'lightrail') && (category === 'construction' || category === 'vehicles')) {
        const f = funding.get(p) ?? { spent: 0 }; f.spent += amount; funding.set(p, f);
        const opening = openings.get(p.line); if (opening) opening.capital = f.spent;
      }
      return ok;
    };
    ai.eco.earn = (amount, category = 'income') => {
      earn(amount, category);
      const p = a.project, f = p && funding.get(p);
      if (f && (category === 'construction' || category === 'vehicles')) {
        f.spent -= amount; const opening = openings.get(p.line); if (opening) opening.capital = f.spent;
      }
    };
  }
  const create = g.lines.create.bind(g.lines);
  g.lines.create = ((kind: Parameters<typeof create>[0], owner: number) => {
    const l = create(kind, owner), a = g.aiOf(owner) as (AIController & Record<string, any>) | undefined, task = a?.urbanTask;
    if (kind === 'rail' && task?.estimate) {
      const e = task.estimate;
      openings.set(l.id, { id: l.id, owner, mode: task.mode, day: g.day, forecast: e.forecast.revenue, forecastCost: e.yearly,
        quotedCapital: e.total, capital: funding.get(a!.project)?.spent ?? 0, rate: a!.eco.interestRate, depot: task.depot, edges: [...a!.project.edges], years: [] });
    }
    return l;
  }) as typeof g.lines.create;
  const warn = console.warn;
  console.warn = (...items: unknown[]) => { exceptions++; warn(...items); };
  let year = g.year;
  while (g.day < years * 360) {
    g.update(0.25);
    for (const ai of g.ais) {
      if (ai.eco.money < 0 && ai.eco.loan + ai.eco.loanStep > ai.eco.maxLoan) bankrupt = true;
      const a = ai as AIController & Record<string, any>, p = a.project, o = p && openings.get(p.line);
      if (o) o.capital = funding.get(p)?.spent ?? o.quotedCapital;
    }
    if (g.year === year) continue;
    year = g.year;
    for (const [id, o] of openings) {
      const l = g.lines.get(id); if (!l) continue;
      const stations = [...new Set(l.stops)].map((id) => g.stations.get(id)!).filter(Boolean);
      const upkeep = stations.reduce((n, s) => n + g.stationMaintenance(s), 0)
        + o.edges.reduce((n, id) => n + (g.world.net.edges.has(id) ? g.edgeMaintenance(g.world.net.edges.get(id)!) : 0), 0)
        + (g.depots.get(o.depot) ? depotUpkeep(g.depots.get(o.depot)!) : 0);
      // Vehicle accounts include all crew, energy and vehicle maintenance; wear and access fees are allocated by RailPolicy.
      const account = g.aiOf(o.owner)!.railPolicy.account(l);
      const conservative = l.incomeLast - l.costLast - upkeep;
      const surplus = Math.min(conservative, account.lastProfit);
      o.years.push({ year: g.year - 1, age: (g.day - o.day) / 360, receipts: l.incomeLast,
        costs: l.incomeLast - surplus, surplus });
    }
    console.log(`  seed ${seed} / ${size}: year ${year}, ${openings.size} city openings`);
  }
  console.warn = warn;
  const city = g.lines.all().filter((l) => urban(g, l));
  const key = `${size}:${seed}`, old = release281[key];
  check(old !== undefined || !!arg('years') || !!arg('seeds') || !!arg('sizes'), `${key}: recorded 2.8.1 baseline exists`);
  total += city.length; baseline += old ?? 0;
  for (const o of openings.values()) {
    const matureYears = o.years.filter((y) => y.age >= 1.5);
    if (!matureYears.length) continue;
    const net = matureYears.reduce((n, y) => n + y.surplus, 0) / matureYears.length;
    check(net > 0, `seed ${seed} ${o.mode} #${o.id}: actual mature receipts cover operating costs`);
    const cost = o.capital || o.quotedCapital;
    mature++; capital += cost; recovered += net * annuity(URBAN_PAYBACK[o.mode], o.rate);
    console.log(`    ${o.mode} #${o.id}: forecast ${fmt(o.forecast / 1e6, 2)}M/year, actual ${fmt(matureYears.reduce((n, y) => n + y.receipts, 0) / matureYears.length / 1e6, 2)}M/year; net ${fmt(net / 1e6, 2)}M/year; capital ${fmt(cost / 1e6, 2)}M (quote ${fmt(o.quotedCapital / 1e6, 2)}M)`);
  }
  const result = { seed, size, years, baseline: old, lightRail: city.filter((l) => l.stops.some((id) => modeOf(g, id) === 'lightrail')).length,
    metro: city.filter((l) => l.stops.some((id) => modeOf(g, id) === 'metro')).length, cityStations: new Set(city.flatMap((l) => l.stops)).size,
    intercity: g.lines.all().filter((l) => l.kind === 'rail' && !city.includes(l)).length, initialPop,
    finalPop: g.towns.list.reduce((n, t) => n + t.pop, 0), companies: g.ais.map((ai) => ({ owner: ai.companyId, money: ai.eco.money, loan: ai.eco.loan })),
    openings: [...openings.values()], rejection, bankrupt, exceptions, seconds: (performance.now() - started) / 1000 };
  results.push(result);
  console.log(JSON.stringify(result));
  if (arg('json')) writeFileSync(arg('json')!, JSON.stringify(results, null, 2));
  check(!bankrupt, `seed ${seed} / ${size}: no bankrupt companies`);
  check(!exceptions, `seed ${seed} / ${size}: no simulation exceptions`);
}
check(total > baseline, `natural maps open more city lines than 2.8.1 (${total} > ${baseline})`);
check(mature > 0 && recovered >= capital, `actual average surplus repays capital with interest over the civil horizon (${fmt(recovered / 1e6, 1)}M >= ${fmt(capital / 1e6, 1)}M)`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
