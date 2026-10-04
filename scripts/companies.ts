// Companies: AI configurations (activeness / focus / risk) over three years, a player buyout of an AI company
// and an AI buying another one, automatic line names and colours, the demand model, and a save round trip of
// the company state (configs, access agreements and fees, defunct companies, line naming).
// npx esbuild scripts/companies.ts --bundle --platform=node --format=esm --outfile=$S/companies.mjs && node $S/companies.mjs [seed] [years] [size]
import { Game, PLAYER } from '../src/game/game';
import { fmtMoney, CATEGORIES } from '../src/game/economy';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { AIController, AIConfig, AI_PRESETS, pickTrain } from '../src/game/ai';
import { TramPlanner } from '../src/game/ai-tram';
import { colorDistance, LINE_PALETTES } from '../src/game/lines';
import { demandView, stationDemand } from '../src/game/demand';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { fare } from '../src/game/vehicle';
import type { Economy, Category } from '../src/game/economy';
import { fails, check, fmt, checkReservations, checkNaN, placeAndConnect, depotBehind } from './lib';

const seed = Number(process.argv[2] ?? 5), YEARS = Number(process.argv[3] ?? 3), SIZE = Number(process.argv[4] ?? 512);
const CONFIGS: { label: string; cfg: Partial<AIConfig> }[] = [
  { label: 'passive', cfg: { activeness: 0.25, risk: 0.1 } },
  { label: 'aggressive', cfg: { activeness: 2, risk: 0.9, startMoney: 8_000_000 } },
  { label: 'rail', cfg: { focus: { rail: 3, road: 0.2, tram: 0.2 } } },
  { label: 'bus', cfg: { focus: { rail: 0, road: 3, tram: 0 } } },
  { label: 'tram', cfg: { focus: { rail: 0, road: 0.3, tram: 3 } } },
];
const T0 = performance.now();
const g = Game.create({ size: SIZE, seed, towns: Math.round(SIZE / 42), hilliness: 'hilly', water: 'medium', startYear: 1985, aiConfigs: CONFIGS.map((c) => c.cfg) });
const IDS = g.ais.map((a) => a.companyId);
const busTowns = g.towns.list.filter((t) => t.pop >= 900).length, tramTowns = g.towns.list.filter((t) => t.pop >= TramPlanner.minPop).length;
// the personalities are compared over the years: no company buys another meanwhile (tested below)
g.aiAcquisitions = false;
console.log(`map ${SIZE} seed ${seed}: ${g.towns.list.length} towns (biggest ${Math.max(...g.towns.list.map((t) => t.pop))}), pop ${g.towns.list.reduce((a, t) => a + t.pop, 0)}, ${g.ais.length} AI companies, gen ${fmt(performance.now() - T0, 0)} ms`);
check(g.ais.length === 5 && g.companies.length === 6, '5 AI companies from aiConfigs');
check(g.ais[1].config.activeness === 2 && g.ais[0].config.activeness === 0.25 && g.ais[3].config.focus.rail === 0, 'configs applied');
check(g.company(2).economy.money === 8_000_000 && g.company(2).economy.loan === 5_000_000, 'start money: 8M cash, 5M of it borrowed');
check(new Set(g.companies.map((c) => c.color)).size === 6 && new Set(g.companies.map((c) => c.name)).size === 6, 'distinct company names and colours');
check(AI_PRESETS.length >= 4, 'AI presets');

// ------------------------------------------------------------------ 1. five AI personalities over the years
const aiTime = g.ais.map(() => ({ t: 0, n: 0, max: 0 }));
const AIS = [...g.ais];
AIS.forEach((ai, i) => {
  const f = ai.daily.bind(ai);
  ai.daily = () => { const t = performance.now(); f(); const dt = performance.now() - t; aiTime[i].t += dt; aiTime[i].n++; aiTime[i].max = Math.max(aiTime[i].max, dt); };
});
let errors = 0;
const origWarn = console.warn;
console.warn = (...a: unknown[]) => { errors++; origWarn('WARN', ...a); };
const T1 = performance.now();
while (g.day < YEARS * 360) {
  try { g.update(0.25); } catch (e) { errors++; console.log('EXCEPTION', (e as Error).stack?.split('\n').slice(0, 6).join('\n')); if (errors > 3) break; }
}
console.log(`simulated ${YEARS} years in ${fmt((performance.now() - T1) / 1000, 1)} s (${fmt((performance.now() - T1) / (YEARS * 360), 2)} ms/day)`);
interface Summary { label: string; id: number; projects: number; rail: number; bus: number; tram: number; vehicles: number; assets: number; built: number; value: number; urban: number }
const sums: Summary[] = AIS.map((ai, i) => {
  const id = ai.companyId, e = g.company(id).economy;
  const lines = g.lines.all().filter((l) => l.owner === id);
  const spent = (k: 'construction' | 'vehicles') => -(e.yearTotals.reduce((a, y) => a + y.v[k], 0) + e.thisYear[k]);
  return {
    label: CONFIGS[i].label, id, projects: ai.state.projects, rail: lines.filter((l) => l.kind === 'rail').length, bus: lines.filter((l) => l.kind === 'road').length,
    tram: lines.filter((l) => l.kind === 'tram').length, vehicles: g.vehicles.all().filter((v) => v.owner === id).length,
    // (urban railways: metro / light rail lines, all of whose stations are urban)
    urban: lines.filter((l) => l.kind === 'rail' && l.stops.every((sid) => { const st = g.stations.get(sid); return !!st?.rail && st.rail.trackType !== undefined && ['metro', 'lightrail'].includes(st.rail.trackType); })).length,
    assets: g.companyAssets(id).total, built: spent('construction') + spent('vehicles'), value: g.companyValue(id),
  };
});
for (const [i, s] of sums.entries()) {
  const ai = AIS[i], co = g.company(s.id);
  console.log(`${s.label.padEnd(10)} ${co.name.padEnd(22)} act ${ai.config.activeness} risk ${ai.config.risk}: projects ${s.projects}, lines rail/bus/tram ${s.rail}/${s.bus}/${s.tram}, vehicles ${s.vehicles}, spent ${fmtMoney(s.built)}, assets ${fmtMoney(s.assets)}, value ${fmtMoney(s.value)}, cash ${fmtMoney(co.economy.money)}, loan ${fmtMoney(co.economy.loan)}; AI ${fmt(aiTime[i].t / Math.max(1, aiTime[i].n), 2)} ms/day (max ${fmt(aiTime[i].max, 1)})`);
  console.log('             ' + ai.log.slice(process.argv.includes('--log') ? 0 : -4).join(' | '));
}
const [passive, aggressive, railCo, busCo, tramCo] = sums;
check(passive.built < aggressive.built * 0.6, `passive company builds little (${fmtMoney(passive.built)} vs aggressive ${fmtMoney(aggressive.built)})`);
check(passive.rail + passive.bus + passive.tram < aggressive.rail + aggressive.bus + aggressive.tram, 'aggressive company runs more lines than the passive one');
check(aggressive.rail + aggressive.bus + aggressive.tram >= 2, 'aggressive company expands to several lines');
check(railCo.rail >= 1, 'rail-focused company runs a railway');
check(busCo.rail === 0 && (busCo.bus >= 1 || busTowns === 0), `bus-focused company runs buses and no railway (${busTowns} towns of 900+)`);
// (a tram company may also run light rail, an urban railway; no main-line railway)
check(tramCo.rail - tramCo.urban === 0 && (tramCo.tram >= 1 || tramTowns === 0), `tram-focused company runs trams, no main-line railway (${tramTowns} towns of ${TramPlanner.minPop}+)`);
check(IDS.every((id) => !g.company(id).defunct), 'no buyouts while acquisitions are off');
check(AIS.every((ai) => ai.state.phase !== 'consolidating' || g.company(ai.companyId).economy.loan > 0), 'sane AI states');
for (const [i] of sums.entries()) check(aiTime[i].t / Math.max(1, aiTime[i].n) < 4, `${sums[i].label}: AI time per day < 4 ms`);
check(errors === 0, 'no exceptions or AI errors');
// configs are live: more activeness -> more work per day
const b0 = AIS[0].budget;
AIS[0].config = { ...AIS[0].config, activeness: 1.5 };
check(AIS[0].budget > b0, `runtime config change takes effect (budget ${b0} -> ${AIS[0].budget})`);
// AI trains open short: loco + 2-3 coaches
const aiTrains = g.vehicles.all().filter((v): v is Train => v instanceof Train && v.owner > 0);
console.log(`  AI trains: ${aiTrains.map((t) => t.cars.length - 1).join(',')} coaches; AI stations ${g.stations.all().filter((st) => st.owner > 0 && st.rail).map((st) => st.rail!.length).join(',')} long`);
check(aiTrains.every((t) => t.cars.length - 1 <= 5) && g.stations.all().every((st) => st.owner <= 0 || !st.rail || st.rail.length <= 12), 'AI trains and stations are compact');
{
  const aiRail = g.stations.all().filter((st) => st.owner > 0 && st.rail);
  const withAccess = aiRail.filter((st) => g.stations.hasAccess(st)).length;
  console.log(`  AI rail stations with road access: ${withAccess}/${aiRail.length}`);
  for (const st of aiRail) if (!g.stations.hasAccess(st)) console.log(`    no access: ${st.name} (${st.rail?.level ?? 'ground'}), ${g.aiOf(st.owner)?.phase}`);
  check(withAccess === aiRail.length, 'AI rail stations are connected to the roads');
}
{
  // passengers piling up on an AI railway: its train is replaced by a longer one (up to the platforms)
  const t0 = aiTrains.find((t) => t.line && t.line.owner > 0 && t.cars.length - 1 < 3 && g.ais.some((a) => a.companyId === t.owner));
  if (!t0) console.log('  (no short AI train to lengthen)');
  if (t0 && t0.line) {
    const l = t0.line, ai = g.ais.find((a) => a.companyId === l.owner)!;
    const n0 = t0.cars.length - 1;
    g.company(l.owner).economy.money += 5_000_000;
    l.incomeLast = l.costLast * 2 + 1_000_000; // a line that pays
    // (no new project meanwhile: the money is for the longer platforms and train)
    if (!ai.busy) ai.state.cooldown = Math.max(ai.state.cooldown, 400);
    // This is a capacity stress fixture. Inject at the decision instant as well: natural walking-catchment
    // queues are deliberately trimmed before monthly management and would erase the synthetic crowd.
    const crowd = () => { for (const sid of l.stops) {
      const st = g.stations.get(sid)!; const other = l.stops.find((x) => x !== sid)!;
      g.stations.addWaiting(st, l.id, other, other, 400 - Math.min(400, st.waitingTotal));
    } };
    const manage = ai.monthly.bind(ai);
    ai.monthly = () => { crowd(); manage(); };
    let longer = -1;
    for (let d = 0; d < 180 && longer < 0; d++) {
      for (const sid of l.stops) { const st = g.stations.get(sid)!; const other = l.stops.find((x) => x !== sid)!; g.stations.addWaiting(st, l.id, other, other, 400 - Math.min(400, st.waitingTotal)); }
      const d0 = g.day;
      while (g.day === d0) g.update(0.25);
      for (const id of l.vehicles) { const tr = g.vehicles.get(id); if (tr instanceof Train && tr.cars.length - 1 > n0) longer = tr.cars.length - 1; }
    }
    ai.monthly = manage;
    const platform = Math.min(...l.stops.map((sid) => g.stations.get(sid)?.rail?.length ?? 99));
    const fits = pickTrain(g.year, platform, 150, 5)!.length - 1;
    console.log(`  lengthening: ${l.name} ${n0} -> ${longer} coaches (platforms ${platform} take ${fits}); ${ai.log.slice(-1)[0]}`);
    check(longer > n0 || fits <= n0, 'a crowded AI railway gets a longer train (as long as its platforms allow)');
  }
}

{
  // riders giving up waiting on a profitable bus or tram line at its fleet limit: the limit rises and a vehicle is added
  type Info = { kind: string; depot: number; maxVehicles: number; lastSold?: number };
  let pick: { ai: AIController; l: NonNullable<ReturnType<typeof g.lines.get>>; info: Info } | undefined;
  for (const ai of AIS) {
    if (g.company(ai.companyId).defunct) continue;
    // Finish the project before selecting a line for capacity management.
    for (let d = g.day + 720; ai.busy && g.day < d;) g.update(0.25);
    if (ai.busy) continue;
    pick = ai.managedLines().map((lid) => ({ ai, l: g.lines.get(lid)!, info: (ai as unknown as { lines: Map<number, Info> }).lines.get(lid)! }))
      .find(({ l, info }) => l && info && l.kind !== 'rail' && l.owner === ai.companyId && l.vehicles.length > 0 && new Set(l.stops).size >= 2
        // (a line whose stops all belong to others now takes no more vehicles of ours: lines.ts operateError)
        && g.lines.operateError(l, ai.companyId) === null);
    if (pick) break;
  }
  if (!pick) console.log('  (no AI bus or tram line to crowd)');
  else {
    const { ai, l, info } = pick;
    ai.state.cooldown = Math.max(ai.state.cooldown, 400);
    const n0 = l.vehicles.length, v0 = g.vehicles.get(l.vehicles[0])!;
    const grow = Math.sqrt(ai.config.activeness);
    // at its limit and paying well
    info.maxVehicles = Math.max(1, Math.floor(n0 / grow)); info.lastSold = -1e9;
    const m0 = info.maxVehicles;
    g.company(l.owner).economy.money += 50_000_000;
    // (at the decision instant: queues are trimmed before monthly management; last month's riders who gave up)
    const crowd = () => {
      l.incomeLast = l.costLast * 2 + 1_000_000;
      for (const sid of new Set(l.stops)) {
        const st = g.stations.get(sid)!, other = l.stops.find((x) => x !== sid)!;
        g.stations.addWaiting(st, l.id, other, other, 20);
        st.lostLast = 4 * v0.capacity;
      }
    };
    const manage = ai.monthly.bind(ai);
    ai.monthly = () => { crowd(); manage(); };
    const d0 = g.day;
    while (g.day < d0 + 100 && l.vehicles.length <= n0 && !g.company(l.owner).defunct) g.update(0.25);
    console.log(`  riders giving up on ${l.name} (${new Set(l.stops).size} stops, activeness ${ai.config.activeness}): limit ${m0} -> ${info.maxVehicles}, vehicles ${n0} -> ${l.vehicles.length}; ${ai.log.slice(-2).join(' | ')}`);
    check(info.maxVehicles > m0 && l.vehicles.length > n0, 'riders giving up on a profitable bus or tram line at its limit raise the limit and add a vehicle');
    // at the limit its stops set (a bus line: two vehicles a stop; trams: two more than its stops) the limit stays put
    const hard = info.kind === 'bus' ? l.stops.length * 2 : 2 + l.stops.length, model = (g.vehicles.get(l.vehicles[0]) as RoadVehicle).model!;
    for (let k = 0; k < 12 && l.vehicles.length < hard; k++) g.vehicles.buyRoad(info.depot, model, l.id);
    info.maxVehicles = Math.max(info.maxVehicles, Math.ceil(hard / grow) + 1);
    const m1 = info.maxVehicles, n1 = l.vehicles.length;
    for (const d1 = g.day; g.day < d1 + 70 && !g.company(l.owner).defunct;) g.update(0.25);
    ai.monthly = manage;
    check(n1 === hard && info.maxVehicles === m1 && l.vehicles.length <= hard, `a crowded line at the limit its stops set raises nothing more (${n1} of ${hard} vehicles, limit ${m1} -> ${info.maxVehicles})`);
  }
}

// extending an AI railway from one of its stations (a hub) to another town
{
  let tried = 0, built = '';
  for (const ai of AIS) {
    if (built || g.company(ai.companyId).defunct) continue;
    while (ai.busy) g.update(0.25);
    for (const st of g.stations.all()) {
      if (built || tried >= 12 || st.owner !== ai.companyId || !st.rail) continue;
      const A = g.towns.list[st.townId];
      if (!A) continue;
      for (const C of [...g.towns.list].sort((p, q) => Math.hypot(p.x - A.x, p.z - A.z) - Math.hypot(q.x - A.x, q.z - A.z))) {
        const d = Math.hypot(C.x - A.x, C.z - A.z);
        if (C === A || d < 60 || d > 220 || ai.hubFor(A, C) !== st) continue;
        tried++;
        g.company(ai.companyId).economy.money += 20_000_000;
        const r0 = ai.stats.reused;
        ai.startProject('rail', [A.id, C.id], st.id);
        while (ai.busy) g.update(0.25);
        if (ai.stats.reused > r0) built = ai.log[ai.log.length - 1];
        else console.log(`    hub ${st.name} -> ${C.name}: ${ai.log[ai.log.length - 1]}`);
        break;
      }
    }
  }
  console.log(`  hub extension: ${built || `none built (${tried} tried)`}`);
}

// an AI railway with a second track (trackops: opened doubled, upgraded, or passing loops; one-way running with
// block signals): the trains keep running
{
  let done = '';
  const info = (ai: AIController, lid: number) => (ai as unknown as { lines: Map<number, { double?: boolean; loops?: number }> }).lines.get(lid);
  for (const pass of [0, 1]) {
    for (const ai of AIS) {
      if (done || g.company(ai.companyId).defunct) continue;
      for (const lid of ai.managedLines()) {
        const l = g.lines.get(lid), li = info(ai, lid);
        if (done || !l || !li || l.kind !== 'rail' || l.owner !== ai.companyId || !l.vehicles.length) continue;
        if (pass === 0) {
          // one the company doubled itself
          if (!li.double && !li.loops) continue;
          done = `${l.name}: ${li.double ? 'double track' : li.loops + ' passing loops'} (by the AI)`;
        } else {
          g.company(ai.companyId).economy.money += 30_000_000;
          const s0 = ai.stats.signals, d0 = ai.stats.trackDouble, l0 = ai.stats.loops;
          if (!ai.upgradeLine(lid)) { console.log(`    double ${l.name}: ${ai.log[ai.log.length - 1]}`); continue; }
          done = `${l.name}: +${fmt((ai.stats.trackDouble - d0) / 100, 2)} km second track (${ai.stats.loops > l0 ? ai.stats.loops - l0 + ' passing loops' : 'all of it'}), ${ai.stats.signals - s0} signals`;
          console.log(`    ${ai.log[ai.log.length - 1]}`);
        }
        const signals = [...g.world.net.nodes.values()].filter((n) => n.signal && n.owner === ai.companyId).length;
        const del0 = l.vehicles.reduce((a, id) => a + (g.vehicles.get(id)?.delivered ?? 0), 0);
        const each0 = new Map(l.vehicles.map((id) => [id, g.vehicles.get(id)?.delivered ?? 0] as [number, number]));
        // Exercise the rebuilt railway even when the smaller walking catchment produces very few trips.
        for (const sid of new Set(l.stops)) {
          const dest = l.stops.find((id) => id !== sid), st = g.stations.get(sid);
          if (st && dest !== undefined) g.stations.addWaiting(st, l.id, dest, dest, 40);
        }
        // Keep the rebuilt service fixed while checking track operation. Otherwise a scheduled business
        // decision can close this losing test line during the observation and remove all measured trains.
        const aiEnabled = g.aiEnabled; g.aiEnabled = false;
        for (const d0 = g.day; g.day < d0 + 120;) g.update(0.25);
        g.aiEnabled = aiEnabled;
        const del1 = l.vehicles.reduce((a, id) => a + (g.vehicles.get(id)?.delivered ?? 0), 0);
        const lost = l.vehicles.map((id) => g.vehicles.get(id)).filter((v) => v && v.state === 'noroute');
        console.log(`  double track: ${done}; ${signals} signals on the company's track; ${l.vehicles.length} trains delivered ${del0} -> ${del1} in 120 days, ${lost.length} without route`);
        // (passengers delivered meanwhile: by the trains running all along, and by any put on since; a train sold or
        // lengthened into a new one takes its own count along)
        const gained = l.vehicles.reduce((a, id) => a + (g.vehicles.get(id)?.delivered ?? 0) - (each0.get(id) ?? 0), 0);
        check(lost.length === 0 && checkReservations(g).length === 0 && gained > 0, `trains keep running on the railway with a second track (${gained} delivered)`);
      }
    }
  }
  if (!done) console.log('  double track: no AI railway could be doubled');
}

// AI project mix and network reuse (for the report)
{
  const kinds = new Map<string, number>();
  for (const l of g.lines.all()) {
    if (l.owner === PLAYER) continue;
    const towns = new Set(l.stops.map((sid) => g.stations.get(sid)?.townId ?? -1));
    const k = l.kind === 'road' ? (towns.size > 1 ? 'coach' : 'town bus') : l.kind;
    kinds.set(k, (kinds.get(k) ?? 0) + 1);
  }
  let track = 0, dbl = 0, reused = 0, shared = 0, coaches = 0, doubled = 0, loops = 0, signals = 0;
  for (const ai of AIS) { track += ai.stats.track; dbl += ai.stats.trackDouble; reused += ai.stats.reused; shared += ai.stats.shared; coaches += ai.stats.coaches; doubled += ai.stats.doubled; loops += ai.stats.loops; signals += ai.stats.signals; }
  console.log(`  AI project mix: ${[...kinds].map(([k, n]) => `${k} ${n}`).join(', ')}; new track ${fmt(track / 100, 1)} km (second track ${fmt(dbl / 100, 1)} km on ${doubled} lines, ${loops} of them as passing loops, ${signals} signals), stations reused ${reused}, lines on others' railways ${shared}, coach lines ${coaches}`);
}

// ------------------------------------------------------------------ 2. line names and colours
{
  const own = (id: number) => g.lines.all().filter((l) => l.owner === id);
  for (const s of sums) {
    for (const l of own(s.id)) {
      const re = l.kind === 'rail' ? /^RE?\d+ \S/ : l.kind === 'tram' ? /^Tram \d+ \S/ : /^Bus \d+ \S/;
      check(re.test(l.name) && l.autoName, `auto name "${l.name}"`);
    }
    const ls = own(s.id);
    const nums = new Map<string, number[]>();
    for (const l of ls) { const k = l.kind; nums.set(k, [...(nums.get(k) ?? []), l.num]); }
    for (const [k, ns] of nums) check(new Set(ns).size === ns.length, `${s.label}: ${k} line numbers unique (${ns.join(',')})`);
    let minD = Infinity;
    for (let i = 0; i < ls.length; i++) for (let j = i + 1; j < ls.length; j++) minD = Math.min(minD, colorDistance(ls[i].color, ls[j].color));
    if (ls.length >= 2 && ls.length <= 8) check(minD > 15, `${s.label}: line colours distinct (min dE ${fmt(minD, 0)})`);
  }
  const sample = g.lines.all().slice(0, 6).map((l) => `${l.name} [${l.color}]`);
  console.log('  line names: ' + sample.join(' | '));
  // player lines: numbering per company and kind, renaming, colours
  const pl1 = g.lines.create('rail', PLAYER), pl2 = g.lines.create('rail', PLAYER), pb = g.lines.create('road', PLAYER);
  check(pl1.name === 'R1' && pl2.name === 'R2' && pb.name === 'Bus 1', `fresh player lines numbered per kind (${pl1.name}, ${pl2.name}, ${pb.name})`);
  const st2 = g.stations.all().filter((s) => s.rail);
  const twoTowns = st2.find((a) => st2.some((b) => b.townId !== a.townId));
  if (twoTowns) {
    const other = st2.find((b) => b.townId !== twoTowns.townId)!;
    pl1.stops = [twoTowns.id, other.id];
    g.lines.rebuild();
    check(pl1.name === `R1 ${g.towns.list[twoTowns.townId].name} – ${g.towns.list[other.townId].name}` || /^RE1 /.test(pl1.name), `rail name from towns: "${pl1.name}"`);
  }
  const bt = g.stations.all().filter((s) => s.stops.length);
  const tw = bt.find((a) => bt.some((b) => b !== a && b.townId === a.townId));
  if (tw) {
    const b2 = bt.find((b) => b !== tw && b.townId === tw.townId)!;
    pb.stops = [tw.id, b2.id];
    g.lines.rebuild();
    check(pb.name.startsWith(`Bus 1 ${g.towns.list[tw.townId].name}: `), `bus name within one town: "${pb.name}"`);
  }
  g.lines.rename(pl2.id, 'Coastal Express');
  g.lines.rebuild();
  check(pl2.name === 'Coastal Express' && !pl2.autoName, 'rename sticks');
  pl2.name = 'Direct rename';
  g.lines.rebuild();
  check(pl2.name === 'Direct rename', 'a name assigned directly sticks');
  g.lines.rename(pl2.id, '');
  check(pl2.autoName && pl2.name === 'R2', 'empty name returns to the automatic name');
  check(colorDistance(pl1.color, pl2.color) > 15 && pl1.color !== pb.color, 'distinct colours for the player lines');
  // (UPDATE 9b: colours are unique across every company's lines: the per-kind palettes first, then further hues)
  check([pl1, pb].every((x) => g.lines.all().filter((l) => l.color === x.color).length === 1) && (LINE_PALETTES.rail.includes(pl1.color) || /^#/.test(pl1.color)), 'colours unique across all lines (palettes first, then further hues)');
  g.lines.setColor(pl2.id, '#123456');
  check(pl2.color === '#123456' && !pl2.autoColor, 'setColor');
  g.lines.delete(pl1.id); g.lines.delete(pl2.id); g.lines.delete(pb.id);
}

// ------------------------------------------------------------------ 3. demand model
{
  // (the catchments the line edits above left to recompute are not the view's cost)
  g.lines.flushCatchment();
  const t0 = performance.now();
  g.lines.version++;
  const dv = demandView(g);
  const t1 = performance.now();
  for (let i = 0; i < 100; i++) demandView(g);
  const t2 = performance.now();
  const big = [...dv.towns].sort((a, b) => b.pop - a.pop);
  const servedPairs = dv.pairs.filter((p) => p.served > 0);
  console.log(`demand: ${dv.towns.length} towns, ${dv.pairs.length} pairs (max ${fmt(dv.maxPotential, 0)} trips/month), served pairs ${servedPairs.length}; compute ${fmt(t1 - t0, 2)} ms, cached ${fmt((t2 - t1) / 100, 3)} ms`);
  const totalTrips = dv.towns.reduce((a, t) => a + t.potential, 0), local = dv.towns.reduce((a, t) => a + t.local, 0);
  console.log(`  regions: ${dv.regions.length} (${dv.regions.filter((r) => r.kind === 'district').length} outer districts in ${new Set(dv.regions.filter((r) => r.kind === 'centre').map((r) => r.town)).size} towns), ${fmt(totalTrips, 0)} trips/month, ${fmt((1 - local / Math.max(1, totalTrips)) * 100, 0)}% between towns; top flows ${dv.flows.slice(0, 3).map((f) => `${g.towns.list[dv.regions[f.a].town].name}/${dv.regions[f.a].kind}-${g.towns.list[dv.regions[f.b].town].name}/${dv.regions[f.b].kind} ${fmt(f.trips, 0)}`).join(', ')}`);
  console.log(`  fares per passenger: ${[10, 30, 100, 200].map((d) => `${d} u ${fmtMoney(fare(d, d / 8, 1))}`).join(', ')}`);
  check(dv.regions.length >= dv.towns.length && dv.flows.length > 0 && local < totalTrips, 'regional model: districts, flows, intercity share');
  console.log('  top pairs: ' + dv.pairs.slice(0, 4).map((p) => `${g.towns.list[p.a].name}-${g.towns.list[p.b].name} ${fmt(p.potential, 0)}/mo served ${fmt(p.served * 100, 0)}%`).join(', '));
  check(dv.towns.length === g.towns.list.length, 'demand: every town');
  check(dv.pairs.length > 0 && dv.pairs.every((p) => p.potential > 0 && p.served >= 0 && p.served <= 1 && p.mine >= 0 && p.mine <= 1 && p.a < p.b), 'demand: sane pairs');
  check(big[0].potential > big[big.length - 1].potential, 'demand: bigger towns generate more trips');
  check(dv.towns.every((t) => t.served >= 0 && t.served <= 1 && t.potential >= t.local), 'demand: sane towns');
  check(servedPairs.length > 0, 'demand: AI railways serve some town pairs');
  check(t1 - t0 < 20, 'demand: computed in < 20 ms');
  check((t2 - t1) / 100 < 0.05, 'demand: cached calls are free');
  const st = [...g.stations.map.values()].sort((a, b) => b.waitingTotal - a.waitingTotal)[0];
  if (st) {
    const sd = stationDemand(g, st.id);
    check(sd.reduce((a, x) => a + x.count, 0) === st.waitingTotal, 'station demand adds up to the waiting passengers');
  }
}

// ------------------------------------------------------------------ 3b. an AI runs its trains on the player's railway (track access)
const runDays = (n: number) => { const d0 = g.day; while (g.day < d0 + n) g.update(0.25); };
const total = (e: Economy, cat: Category) => e.yearTotals.reduce((a, y) => a + y.v[cat], 0) + e.thisYear[cat];
{
  g.economy.money = 1e8;
  const pr = placeAndConnect(g, 60, 200, PLAYER, new Set(), 1, () => {});
  const dep = pr ? depotBehind(g, pr.A, pr.B, PLAYER) : -1;
  if (!pr || dep < 0) console.log('  (no player railway could be placed: share test skipped)');
  else {
    const pl = g.lines.create('rail', PLAYER);
    pl.stops = [pr.A.id, pr.B.id];
    const ptr = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], pl.id) as Train;
    const ai = g.ais.find((a) => a.companyId === railCo.id)!;
    while (ai.busy) g.update(0.25);
    g.company(ai.companyId).economy.money += 6_000_000;
    // the player asks to be asked here (open access, the default, needs no request: see access.ts / networks.ts)
    g.setAccessPolicy(PLAYER, 'ask');
    check(ai.startShare(PLAYER, pr.A.id, pr.B.id), 'AI starts running trains on the player railway');
    // the player is asked (default policy) and approves
    const mine = () => g.requestsTo(PLAYER).find((q) => q.user === ai.companyId);
    while (ai.busy && !mine()) g.update(0.25);
    const req = mine();
    check(!!req && req.user === ai.companyId && ai.phase.startsWith('waiting for track access'), 'the AI asks the player for track access and waits');
    if (req) check(g.approveAccess(req.id) === null, 'player approves');
    while (ai.busy) g.update(0.25);
    const al = g.lines.all().find((l) => l.owner === ai.companyId && l.stops.includes(pr.A.id) && l.stops.includes(pr.B.id));
    console.log(`  share: ${ai.log.slice(-3).join(' | ')}; agreement ${g.hasAccess(ai.companyId, PLAYER)}, line ${al?.name ?? '-'}`);
    // (UPDATE 9k: a company running services on a line owns one of its stations: a line of the AI's between two of
    // the player's stations is refused; track access fees are covered by access.ts and through.ts)
    // (the agreement it no longer needs is ended again: endUnusedAccess)
    check(!al && ai.log.some((x) => /no station of ours on the line/.test(x)), 'the AI asked for track access but runs no line without a station of its own');
    if (al) {
    const inc0 = total(g.economy, 'trackIncome'), d0 = ptr.delivered;
    runDays(150);
    const at = al ? g.vehicles.get(al.vehicles[0]) : undefined;
    console.log(`  150 days: player earned ${fmtMoney(total(g.economy, 'trackIncome') - inc0)} in fees; AI train ${at?.status} delivered ${at?.delivered}; player train delivered ${d0} -> ${ptr.delivered}`);
    check(total(g.economy, 'trackIncome') > inc0, 'the player earns track access fees from the AI train');
    const agr = g.agreement(ai.companyId, PLAYER);
    console.log(`  agreement: usage share last month ${fmt((agr?.usageShareLastMonth ?? 0) * 100, 0)}%, paid last month ${fmtMoney(agr?.paidLastMonth ?? 0)}, total ${fmtMoney(agr?.paidTotal ?? 0)}; player earned ${fmtMoney(g.accessEarnings(PLAYER).total)}`);
    check(!!agr && agr.usageShareLastMonth > 0.05 && agr.paidTotal > 0, 'the AI pays its usage share of the shared railway');
    const access = g.stations.hasAccess(pr.A) && g.stations.hasAccess(pr.B);
    if (!access) console.log('  (the player stations have no road access: no passengers, delivery check skipped)');
    check(!access || (!!at && at.delivered > 0 && ptr.delivered > d0), 'both trains carry passengers on the shared railway');
    const errs = checkReservations(g);
    check(errs.length === 0, 'reservations consistent on the shared railway ' + errs.slice(0, 3).join('; '));
    // the player closes its network: the agreement ends, the AI closes the line and removes its depot
    const aiDepot = at ? (at as Train).depotId : -1;
    g.setAllowAccess(PLAYER, false);
    check(!g.hasAccess(ai.companyId, PLAYER) && !!al && al.stops.length === 0, 'closing the network ends the agreement and the stops');
    runDays(35);
    check(!!al && !g.lines.get(al.id) && !g.depots.get(aiDepot), 'the AI closed its line and removed its depot');
    check(ptr.state !== 'noroute', 'the player train is not affected');
    g.setAllowAccess(PLAYER, true);
    }
  }
}

// ------------------------------------------------------------------ 4. access agreement with an AI (for the save test)
check(g.requestAccess(PLAYER, railCo.id) === 'granted' && g.canUse(PLAYER, railCo.id), 'player signs an access agreement with an AI');
g.setAllowAccess(PLAYER, true);

// ------------------------------------------------------------------ 5. buyouts
{
  const target = busCo.id, tco = g.company(target);
  g.economy.money = 1e9;
  const price = g.buyoutPrice(target), value = g.companyValue(target);
  const tv = g.vehicles.all().filter((v) => v.owner === target);
  const tl = g.lines.all().filter((l) => l.owner === target);
  const te = [...g.world.net.edges.values()].filter((e) => e.owner === target).length;
  const ts = g.stations.all().filter((s) => s.owner === target).length;
  const td = g.depots.all().filter((d) => d.owner === target).length;
  const tLoan = tco.economy.loan, tMoney = tco.economy.money, pLoan = g.economy.loan, pMoney = g.economy.money;
  const delivered0 = tv.reduce((a, v) => a + v.delivered, 0);
  check(price >= value && price > 0, `buyout price ${fmtMoney(price)} >= value ${fmtMoney(value)}`);
  check(g.buyCompany(PLAYER, PLAYER) !== null && g.buyCompany(target, PLAYER) !== null, 'the player company cannot be bought');
  const err = g.buyCompany(PLAYER, target);
  check(err === null, 'player buys ' + tco.name + (err ? ': ' + err : ''));
  console.log(`buyout: ${tco.name} for ${fmtMoney(price)} (value ${fmtMoney(value)}): ${tv.length} vehicles, ${tl.length} lines, ${te} edges, ${ts} stations, ${td} depots, loan ${fmtMoney(tLoan)}`);
  check(tco.defunct === true && tco.boughtBy === PLAYER && !g.ais.some((a) => a.companyId === target), 'target defunct, AI removed');
  check(![...g.world.net.edges.values()].some((e) => e.owner === target || e.tramOwner === target) && ![...g.world.net.nodes.values()].some((n) => n.owner === target), 'all track, roads and nodes transferred');
  check(!g.stations.all().some((s) => s.owner === target) && !g.depots.all().some((d) => d.owner === target), 'stations and depots transferred');
  check(tl.every((l) => l.owner === PLAYER) && tv.every((v) => v.owner === PLAYER), 'lines and vehicles transferred');
  check(Math.abs(g.economy.loan - (pLoan + tLoan)) < 1 && tco.economy.loan === 0, 'loan taken over');
  check(Math.abs(g.economy.money - (pMoney - price + tMoney)) < 1, 'paid the price, took over the cash');
  check(g.economy.thisYear.acquisition !== 0 && CATEGORIES.includes('acquisition'), 'booked as acquisition');
  check(tv.every((v) => !v.name.startsWith(tco.name.split(' ')[0] + ' ')), 'vehicles renamed for the player');
  check(!g.access.some((a) => a.user === target || a.owner === target), 'agreements merged');
  check(g.buyCompany(PLAYER, target) !== null, 'a defunct company cannot be bought again');
  check(g.activeCompanies.length === 5, 'defunct company hidden from the active list');
  runDays(90);
  const delivered1 = tv.reduce((a, v) => a + v.delivered, 0);
  const lost = tv.filter((v) => v.state === 'noroute');
  console.log(`  90 days later: delivered ${delivered0} -> ${delivered1}, states ${tv.map((v) => v.state[0]).join('')}`);
  check(delivered1 > delivered0, 'the bought vehicles keep carrying passengers');
  check(lost.length === 0, 'no bought vehicle lost its route ' + lost.map((v) => v.name + ': ' + v.status).join('; '));
  const errs = checkReservations(g);
  check(errs.length === 0, 'reservations consistent after the buyout ' + errs.slice(0, 3).join('; '));
}
g.aiAcquisitions = true;
{
  // an AI buys another AI and runs its lines
  const buyer = aggressive.id, target = tramCo.id;
  g.company(buyer).economy.money = 5e8;
  const tl = g.lines.all().filter((l) => l.owner === target).map((l) => l.id);
  const tv = g.vehicles.all().filter((v) => v.owner === target);
  const err = g.buyCompany(buyer, target);
  check(err === null, 'AI buys AI' + (err ? ': ' + err : ''));
  runDays(31);
  const ctl = g.ais.find((a) => a.companyId === buyer)!;
  check(tl.every((id) => ctl.managedLines().includes(id)), 'the buyer AI manages the bought lines');
  check(tv.every((v) => v.owner === buyer && v.state !== 'noroute'), 'bought trams keep running');
  check(tv.some((v) => v instanceof RoadVehicle && v.model?.kind === 'tram') || !tl.length, 'trams among the bought vehicles');
}

// ------------------------------------------------------------------ 6. save round trip of the company state
{
  while (g.ais.some((a) => a.busy)) g.update(0.25);
  g.ais[0].config = { activeness: 0.6, focus: { rail: 2, road: 0.5, tram: 1.5 }, risk: 0.3, startMoney: 5_000_000, accessMultiplier: 1.5 };
  g.setAccessMultiplier(PLAYER, 2.5);
  const lr = g.lines.all()[0];
  if (lr) g.lines.rename(lr.id, 'Renamed line');
  const json = JSON.stringify(serialize(g));
  const g2 = deserialize(JSON.parse(json));
  const json2 = JSON.stringify(serialize(g2));
  if (json2 !== json) {
    let i = 0;
    while (i < json.length && json[i] === json2[i]) i++;
    console.log(`  re-serialized JSON differs at ${i}: ...${json.slice(Math.max(0, i - 120), i + 60)}...\n  vs ...${json2.slice(Math.max(0, i - 120), i + 60)}...`);
  }
  check(json2 === json, 'save round trip: identical re-serialization');
  check(JSON.stringify(g2.access) === JSON.stringify(g.access) && g2.canUse(PLAYER, railCo.id), 'agreements and fees restored');
  check(g2.accessMultiplier(PLAYER) === 2.5 && g2.accessMultiplier(g.ais[0].companyId) === 1.5, 'access multipliers restored');
  console.log('  defunct: ' + g.companies.filter((c) => c.defunct).map((c) => `${c.name} (bought by ${g.company(c.boughtBy ?? -1).name})`).join(', '));
  check(g2.companies.filter((c) => c.defunct).length >= 2 && g2.companies.every((c, i) => !!c.defunct === !!g.companies[i].defunct && c.boughtBy === g.companies[i].boughtBy), 'defunct companies restored');
  check(g2.ais.length === g.ais.length && g2.ais.every((a) => !g2.company(a.companyId).defunct), 'no AI for defunct companies');
  check(JSON.stringify(g2.ais.map((a) => a.config)) === JSON.stringify(g.ais.map((a) => a.config)), 'AI configs restored');
  check(g2.lines.all().every((l) => { const o = g.lines.get(l.id)!; return o.name === l.name && o.autoName === l.autoName && o.num === l.num && o.color === l.color && o.autoColor === l.autoColor; }), 'line naming state restored');
  check(!!lr && g2.lines.get(lr.id)!.name === 'Renamed line' && !g2.lines.get(lr.id)!.autoName, 'renamed line stays renamed');
  check(JSON.stringify(g2.economy.thisYear) === JSON.stringify(g.economy.thisYear), 'economy categories restored');
  // Compare exactly sixty simulation days. The wall-clock frame budget may drop different ticks in the
  // warm original and cold loaded game; those scheduling differences are not save-state differences.
  for (let tick = 0; tick < 60 * g.ticksPerDay; tick++) { g.stepTick(); g2.stepTick(); }
  const m1 = g.companies.map((c) => Math.round(c.economy.money)), m2 = g2.companies.map((c) => Math.round(c.economy.money));
  console.log(`  60 days after loading: money ${m1.map(fmtMoney).join(' / ')} vs ${m2.map(fmtMoney).join(' / ')}; ${g.ais.map((a) => `${g.company(a.companyId).name.split(' ')[0]}: ${a.phase}, loan ${fmtMoney(g.company(a.companyId).economy.loan)}`).join('; ')}`);
  check(m1.every((m, i) => Math.abs(m - m2[i]) <= 0.02 * Math.max(1, Math.abs(m), Math.abs(m2[i]))), 'loaded game runs on alike');
  check(!checkNaN(g2) && checkReservations(g2).length === 0, 'loaded game consistent');
}
void Train; void AIController;
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
