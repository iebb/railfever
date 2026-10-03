// Ten-year railway endurance audit. Bundle as airail.mjs; optional args: seeds, sizes, years, AI count.
import '../src/game/patterns';
import { Game } from '../src/game/game';
import { fmtMoney } from '../src/game/economy';
import { networkProfile } from '../src/game/ai-network';

const seeds = (process.argv[2] ?? '5,7,23').split(',').map(Number);
const sizes = (process.argv[3] ?? '512,768').split(',').map(Number);
const years = Number(process.argv[4] ?? 10), count = Number(process.argv[5] ?? 3);
let failures = 0, surviving = 0;
for (const size of sizes) for (const seed of seeds) {
  const start = performance.now();
  const g = Game.create({ size, seed, towns: Math.round(size / 42), hilliness: 'hilly', water: 'medium', startYear: 1985,
    aiConfigs: Array.from({ length: count }, () => ({ focus: { rail: 2.5, road: 1.2, tram: 0.5 } })) });
  g.aiAcquisitions = false;
  let year = 0;
  while (g.day < years * 360) {
    g.stepTick();
    if (g.day >= (year + 1) * 360) {
      year++;
      console.log(`seed ${seed}, ${size}: year ${year}/${years}, rail lines ${g.lines.all().filter((l) => l.kind === 'rail' && l.owner > 0).length}`);
    }
  }
  const live = g.lines.all().filter((l) => l.kind === 'rail' && l.owner > 0 && l.vehicles.length);
  if (live.length) surviving++;
  for (const ai of g.ais) {
    const e = g.company(ai.companyId).economy, events = ai.railPolicy.events;
    const opened = events.filter((e) => e.kind === 'opened'), closed = events.filter((e) => e.kind === 'closed');
    const cuts = events.filter((e) => e.kind === 'cut'), connections = events.filter((e) => e.kind === 'connection');
    const existing = live.filter((l) => l.owner === ai.companyId).length;
    console.log(`  ${g.company(ai.companyId).name}: opened ${opened.length}, closed ${closed.length}, serving ${existing}, cuts ${cuts.length}, mid-line connections ${connections.length}; cash ${fmtMoney(e.money)}, loan ${fmtMoney(e.loan)}, credit ${fmtMoney(e.maxLoan - e.loan)}`);
    for (const event of closed) {
      console.log(`    closed day ${event.day}: ${event.name}, age ${(event.age / 360).toFixed(2)} years, ${event.lossYears} consecutive losing years; ${event.text}`);
      if (event.age < 1800 || event.lossYears < 5) { console.error('FAIL premature rail closure'); failures++; }
    }
    for (const event of cuts) console.log(`    cut day ${event.day}: ${event.name}: ${event.text}`);
    for (const event of connections) console.log(`    connection day ${event.day}: ${event.name}: ${event.text}`);
    if (e.money + Math.max(0, e.maxLoan - e.loan) < 0) { console.error(`FAIL ${g.company(ai.companyId).name}: exhausted cash and credit`); failures++; }
    if (ai.log.some((s) => /error:|network work.*failed/.test(s))) { console.error(`FAIL AI error: ${ai.log.filter((s) => /error:|failed/.test(s)).join('; ')}`); failures++; }
  }
  console.log(`  elapsed ${((performance.now() - start) / 1000).toFixed(1)}s; midconnect decisions ${JSON.stringify(Object.fromEntries(Object.entries(networkProfile.decisions).filter(([k]) => k.startsWith('midconnect.'))))}`);
}
if (years >= 10 && surviving <= seeds.length * sizes.length / 2) { console.error(`FAIL rail networks survive on only ${surviving}/${seeds.length * sizes.length} worlds`); failures++; }
console.log(`Rail networks present after ${years} years: ${surviving}/${seeds.length * sizes.length} worlds. ${failures ? failures + ' FAILURES' : 'ALL CHECKS PASSED'}`);
process.exitCode = failures ? 1 : 0;
