// AI companies test: new game with AI competitors, simulate several years headless, report what each built.
// npx esbuild scripts/ai.ts --bundle --platform=node --format=esm --outfile=$S/ai.mjs && node $S/ai.mjs [seed] [years] [size] [ais]
import { Game } from '../src/game/game';
import { fmtMoney } from '../src/game/economy';
import { Train } from '../src/game/train';
import { AIController } from '../src/game/ai';
import { fails, check, fmt, checkReservations, checkNaN } from './lib';
AIController.profile = process.argv.includes('--profile');

const seed = Number(process.argv[2] ?? 7), YEARS = Number(process.argv[3] ?? 5), SIZE = Number(process.argv[4] ?? 384), NAI = Number(process.argv[5] ?? 3);
const T0 = performance.now();
const g = Game.create({ size: SIZE, seed, towns: Math.round(SIZE / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: NAI });
console.log(`map ${SIZE} seed ${seed}: ${g.towns.list.length} towns, pop ${g.towns.list.reduce((a, t) => a + t.pop, 0)}, ${g.ais.length} AI companies, gen ${fmt(performance.now() - T0, 0)} ms`);
// time the AI work per day
const aiTime = g.ais.map(() => ({ t: 0, n: 0, max: 0 }));
g.ais.forEach((ai, i) => {
  // daily() picks projects; work() runs the project's units spread over the day (max: the slowest call)
  const f = ai.daily.bind(ai), w = ai.work.bind(ai);
  ai.daily = () => { const t = performance.now(); f(); const dt = performance.now() - t; aiTime[i].t += dt; aiTime[i].n++; aiTime[i].max = Math.max(aiTime[i].max, dt); };
  ai.work = (f0: number, f1: number) => { const t = performance.now(); w(f0, f1); const dt = performance.now() - t; aiTime[i].t += dt; aiTime[i].max = Math.max(aiTime[i].max, dt); };
});
let errors = 0;
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { errors++; origWarn('WARN', ...a); };
const T1 = performance.now();
const days = YEARS * 360;
let nan: string | null = null;
while (g.day < days) {
  try { g.update(0.25); } catch (e) { errors++; console.log('EXCEPTION', (e as Error).stack?.split('\n').slice(0, 6).join('\n')); if (errors > 3) break; }
  if (g.day % 30 === 0 && !nan) nan = checkNaN(g);
  if (g.day % 360 === 0 && g.dayFrac < 0.13) {
    console.log(`  ${g.dateString()}: ` + g.ais.map((ai) => `${g.company(ai.companyId).name.split(' ')[0]} ${fmtMoney(g.company(ai.companyId).economy.money)} loan ${fmtMoney(g.company(ai.companyId).economy.loan)} [${ai.state.phase}]`).join(' | '));
  }
}
const simMs = performance.now() - T1;
console.log(`simulated ${YEARS} years in ${fmt(simMs / 1000, 1)} s (${fmt(simMs / days, 2)} ms/day)`);
for (let i = 0; i < g.ais.length; i++) {
  const ai = g.ais[i], co = g.company(ai.companyId), st = ai.stats;
  const lines = g.lines.all().filter((l) => l.owner === ai.companyId);
  const vehicles = g.vehicles.all().filter((v) => v.owner === ai.companyId);
  const stations = g.stations.all().filter((s) => s.owner === ai.companyId);
  let track = 0, road = 0, bridges = 0, tunnels = 0;
  for (const e of g.world.net.edges.values()) {
    if (e.owner !== ai.companyId) continue;
    if (e.kind === 'rail') track += e.len; else road += e.len;
    for (const s of e.sections) if (s.type === 'bridge') bridges++; else tunnels++;
  }
  const earning = lines.filter((l) => l.vehicles.length && l.incomeLast + l.incomeYear > 0);
  const delivered = vehicles.reduce((a, v) => a + v.delivered, 0);
  console.log(`\n${co.name}: money ${fmtMoney(co.economy.money)}, loan ${fmtMoney(co.economy.loan)}, net worth ${fmtMoney(co.economy.netWorth)}`);
  console.log('  yearly result: ' + co.economy.yearTotals.map((y) => `${y.year}: ${fmtMoney(Object.values(y.v).reduce((a, b) => a + b, 0))} (income ${fmtMoney(y.v.income)}, construction ${fmtMoney(y.v.construction)}, vehicles ${fmtMoney(y.v.vehicles)}, running ${fmtMoney(y.v.running)}, maint ${fmtMoney(y.v.maintenance)}, interest ${fmtMoney(y.v.interest)})`).join('\n                 '));
  console.log(`  built: ${stations.filter((s) => s.rail).length} rail stations, ${stations.reduce((a, s) => a + s.stops.length, 0)} bus stops, ${fmt(track / 100, 1)} km track, ${fmt(road / 100, 1)} km road, ${bridges} bridge / ${tunnels} tunnel sections`);
  console.log(`  lines: ${lines.length} (${lines.filter((l) => l.kind === 'rail').length} rail), vehicles ${vehicles.length} (${vehicles.filter((v) => v instanceof Train).length} trains), delivered ${delivered}, projects ${ai.state.projects}, failed ${st.failed}, sold ${st.sold}`);
  for (const l of lines) console.log(`    ${l.name}: ${l.stops.map((s) => g.stations.get(s)?.name).join(' - ')}, ${l.vehicles.length} veh, income last/this year ${fmtMoney(l.incomeLast)}/${fmtMoney(l.incomeYear)}, cost ${fmtMoney(l.costLast)}`);
  console.log(`  AI time: avg ${fmt(aiTime[i].t / Math.max(1, aiTime[i].n), 2)} ms/day, max ${fmt(aiTime[i].max, 1)} ms`);
  console.log('  log: ' + ai.log.slice(process.argv.includes('--log') ? 0 : -8).join('\n       '));
  check(earning.length >= 1, `${co.name} has a working line earning money`);
  check(vehicles.length >= 1, `${co.name} has vehicles`);
  check(aiTime[i].t / Math.max(1, aiTime[i].n) < 5, `${co.name} AI time per day < 5 ms`);
  check(aiTime[i].max < 30, `${co.name} AI work per day stays sliced (max ${fmt(aiTime[i].max, 1)} ms)`);
}
// grid towns and country roads: the companies still find sites (railways at the town edges, stops on the grid)
const aiRail = g.ais.filter((ai) => g.stations.all().some((s) => s.owner === ai.companyId && s.rail)).length;
const aiBus = g.ais.filter((ai) => g.lines.all().some((l) => l.owner === ai.companyId && l.kind === 'road')).length;
console.log(`
companies with a railway: ${aiRail}/${g.ais.length}, with a bus service: ${aiBus}/${g.ais.length}; country roads ${[...g.world.net.edges.values()].filter((e) => e.kind === 'road' && e.type === 'road' && e.owner === -1).length} edges`);
check(aiRail >= 1, 'an AI company built a railway');
check(aiBus >= 1, 'an AI company runs buses');
check(errors === 0, 'no exceptions or AI errors');
check(!nan, 'no NaN positions ' + (nan ?? ''));
const res = checkReservations(g);
check(res.length === 0, 'reservations consistent ' + res.slice(0, 3).join('; '));
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
