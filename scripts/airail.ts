// Ten-year railway endurance audit. Bundle as airail.mjs; optional args: seeds, sizes, years, AI count.
// Also counts cross-company links (ai-network.ts xlink: curves between two AI companies' networks, direct services across
// them, mutual through trains, walking links) and track junctions / services across companies, with the link task's
// decisions (why pairs were not linked); --xlink checks that cross-company connections or services appear in a quarter
// of the worlds at least (the natural sweep: 5,7,23,51 512,768 9 4 --xlink). The link task builds only what pays, so in
// small worlds with little demand between neighbouring networks most connections are shared stations.
import '../src/game/patterns';
import { Game } from '../src/game/game';
import { fmtMoney } from '../src/game/economy';
import { networkProfile } from '../src/game/ai-network';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const seeds = (args[0] ?? '5,7,23').split(',').map(Number);
const sizes = (args[1] ?? '512,768').split(',').map(Number);
const years = Number(args[2] ?? 10), count = Number(args[3] ?? 3);
let failures = 0, surviving = 0, linked = 0, links = 0, services = 0, partners = 0, walks = 0, crossWorlds = 0;
const stat = (s: object, k: string) => (s as Record<string, number>)[k] ?? 0;
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
  // cross-company: curves built by the link task, direct services running across two companies' stations, track junctions
  const sum = (k: string) => g.ais.reduce((n, ai) => n + stat(ai.stats, k), 0);
  const across = live.filter((l) => new Set(l.stops.map((sid) => g.stations.get(sid)?.owner)).size >= 2);
  const operators = across.filter((l) => new Set(l.vehicles.map((id) => g.vehicles.get(id)?.owner)).size >= 2);
  const net = g.world.net;
  const junctions = [...net.nodes.values()].filter((n) => n.kind === 'rail' && new Set(n.edges.map((id) => net.edges.get(id)?.owner).filter((o) => o !== undefined && o > 0)).size >= 2).length;
  const worldLinks = sum('netXLinks');
  links += worldLinks; services += across.length; partners += sum('netXPartner'); walks += sum('netXComplex');
  if (worldLinks) linked++;
  if (worldLinks || across.length || junctions) crossWorlds++;
  console.log(`  cross-company: links built ${worldLinks} (partner trains ${sum('netXPartner')}, walking links ${sum('netXComplex')}), services across companies ${across.length} (${operators.length} run by two operators), track junctions between companies ${junctions}`);
  for (const l of across) console.log(`    ${l.name} (${g.company(l.owner).code}): ${[...new Set(l.stops)].map((sid) => `${g.stations.get(sid)?.name}/${g.company(g.stations.get(sid)?.owner ?? -1).code}`).join(' - ')}; trains ${l.vehicles.map((id) => g.company(g.vehicles.get(id)?.owner ?? -1).code).join('')}; income ${fmtMoney(l.incomeLast)} / cost ${fmtMoney(l.costLast)} last year`);
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
    // the link task's notes: links built, given up, or found not to pay
    for (const s of ai.log.filter((x) => /linked with|no link |walking link |link .* given up/.test(x)).slice(-6)) console.log(`    xlink: ${s}`);
    if (e.money + Math.max(0, e.maxLoan - e.loan) < 0) { console.error(`FAIL ${g.company(ai.companyId).name}: exhausted cash and credit`); failures++; }
    if (ai.log.some((s) => /error:|network work.*failed/.test(s))) { console.error(`FAIL AI error: ${ai.log.filter((s) => /error:|failed/.test(s)).join('; ')}`); failures++; }
  }
  console.log(`  elapsed ${((performance.now() - start) / 1000).toFixed(1)}s; midconnect decisions ${JSON.stringify(Object.fromEntries(Object.entries(networkProfile.decisions).filter(([k]) => k.startsWith('midconnect.'))))}`);
  console.log(`  xlink decisions ${JSON.stringify(Object.fromEntries(Object.entries(networkProfile.decisions).filter(([k]) => k.startsWith('xlink.')).map(([k, v]) => [k, Math.round(v * 10) / 10])))}`);
  for (const k of Object.keys(networkProfile.decisions)) delete networkProfile.decisions[k];
}
if (years >= 10 && surviving <= seeds.length * sizes.length / 2) { console.error(`FAIL rail networks survive on only ${surviving}/${seeds.length * sizes.length} worlds`); failures++; }
const worlds = seeds.length * sizes.length;
console.log(`Cross-company links: ${links} built by the link task in ${linked}/${worlds} worlds (${partners} mutual through trains, ${walks} walking links); ${services} services across companies running at the end; cross-company connections or services in ${crossWorlds}/${worlds} worlds.`);
if (process.argv.includes('--xlink') && crossWorlds < Math.ceil(worlds / 4)) { console.error(`FAIL cross-company connections in only ${crossWorlds}/${worlds} worlds (${links} links, ${services} services)`); failures++; }
console.log(`Rail networks present after ${years} years: ${surviving}/${worlds} worlds. ${failures ? failures + ' FAILURES' : 'ALL CHECKS PASSED'}`);
process.exitCode = failures ? 1 : 0;
