// Player-experience playtest: what a new player and the rivals see in the first years of a default game.
// npx esbuild scripts/playtest.ts --bundle --platform=node --format=esm --outfile=$S/playtest.mjs && node $S/playtest.mjs [mode] [options]
//   player [--seeds=1,2,3] [--years=5] [--ai=0]   a human-like first railway between two nearby towns and a town bus
//                                                  line (New Game defaults: 768 map, 13 towns, 1950, hilly, some water)
//   ai [--seeds=1,2,3] [--years=10] [--ai=1] [--style=balanced] [--size=768] [--towns=13]
//                                                  what the rivals build: modes, finances, duplicates (also rail vs
//                                                  coach), end-to-end rail lines left unjoined, X layouts, stuck vehicles
// --json=/path writes the per-seed results. Exit code 1 when a playability check fails (--check).
import { writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { MODEL_BY_ID, availableModels, VehicleModel } from '../src/game/vehicle-types';
import { AI_PRESETS } from '../src/game/ai';
import type { Station } from '../src/game/stations';
import type { Town } from '../src/game/towns';
import { stationEnds, findRailPair, buildRoadDepot } from '../src/game/routing';
import { linearStops } from '../src/game/lines';
import { fails, check, fmt, connectStations, depotBehind, townPairs, addBusStop, busStopSites, Train, checkReservations } from './lib';

const args = process.argv.slice(2);
const mode = args.find((a) => !a.startsWith('--')) ?? 'player';
const flag = (name: string, d: string) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const seeds = flag('seeds', '1,2,3').split(',').map(Number);
const YEARS = Number(flag('years', mode === 'ai' ? '10' : '5'));
const SIZE = Number(flag('size', '768')), TOWNS = Number(flag('towns', String(Math.max(3, Math.min(40, Math.round(3.2 * (Number(flag('size', '768')) / 384) ** 2))))));
const NAI = Number(flag('ai', mode === 'ai' ? '1' : '0'));
const STYLE = flag('style', 'balanced');
const YEAR0 = Number(flag('year', '1950'));
const M = (x: number) => fmt(x / 1e6, 2) + 'M';
const k = (x: number) => fmt(x / 1e3, 0) + 'k';
const days = () => g.day;
let g!: Game;

function configs(n: number) {
  const mixed = ['balanced', 'rail', 'bus', 'aggressive', 'tram', 'cautious', 'balanced'];
  return Array.from({ length: n }, (_, i) => ({ ...(AI_PRESETS.find((p) => p.id === (STYLE === 'mixed' ? mixed[i % mixed.length] : STYLE)) ?? AI_PRESETS[0]).config }));
}
function newGame(seed: number): Game {
  return Game.create({ size: SIZE, seed, towns: TOWNS, hilliness: 'hilly', water: 'medium', startYear: YEAR0, aiCompanies: NAI, aiConfigs: configs(NAI) });
}
/** Run whole days; `each` after every day. */
function runDays(n: number, each?: () => void) {
  const end = g.day + n;
  while (g.day < end) { const d = g.day; while (g.day === d) g.stepTick(); each?.(); }
}
const total = (v: Record<string, number>, keys: string[]) => keys.reduce((a, x) => a + (v[x] ?? 0), 0);
const OPS = ['crew', 'energy', 'vehicleMaint', 'running', 'maintenance', 'trackWear', 'trackFees'];

// ------------------------------------------------------------------ player
interface PlayerResult {
  seed: number; pair: string; distance: number; railCapital: number; busCapital: number; railOk: boolean; busOk: boolean;
  firstDeliveryDay: number; years: { year: number; money: number; loan: number; income: number; ops: number; interest: number; result: number; railIncome: number; railCost: number; busIncome: number; busCost: number; pax: number; townPop: number }[];
  payback: number; affordableLines: number;
}

/** Two 2-track stations near a town pair, one track between them (the checklist's first railway, with room to pass). */
function firstRailway(minD: number, maxD: number, length: number): { A: Station; B: Station; TA: Town; TB: Town; len: number; costs: string } | null {
  const tried = new Set<string>();
  for (const [TA, TB] of townPairs(g, minD, maxD)) {
    if (tried.size > 8) break;
    tried.add(TA.id + ':' + TB.id);
    const e = g.company(0).economy, m0 = e.money;
    const pr = findRailPair(g, TA, TB, { tracks: 2, length, owner: 0, front: 22 });
    if (!pr) continue;
    const ia = g.stations.nextId;
    if (g.stations.commitRail(pr.a, 0)) continue;
    const A = g.stations.get(ia)!;
    const pb = g.stations.planRail(pr.b.x, pr.b.z, pr.b.angle, length, 2, 0);
    const ib = g.stations.nextId;
    if (!pb.ok || g.stations.commitRail(pb, 0)) { g.stations.removeStation(A.id); continue; }
    const B = g.stations.get(ib)!;
    const m1 = e.money;
    const con = connectStations(g, A, B, 0, 1, () => {});
    if (!con.ok) { g.stations.removeStation(B.id); g.stations.removeStation(A.id); continue; }
    return { A, B, TA, TB, len: con.len, costs: `stations ${M(m0 - m1)}, track ${M(m1 - e.money)} (${con.bridges} bridge / ${con.tunnels} tunnel sections)` };
  }
  return null;
}

/** The newest locomotive and as many of the newest coaches as the platform takes (at most 4). */
function consist(platform: number): VehicleModel[] {
  const locos = availableModels(g.year, 'loco').filter((m) => m.traction !== 'electric');
  const loco = locos[locos.length - 1];
  const coaches = availableModels(g.year, 'wagon', false);
  const coach = coaches[coaches.length - 1];
  const cars: VehicleModel[] = [loco];
  let len = loco.length;
  while (cars.length < 5 && len + coach.length <= platform - 0.5) { cars.push(coach); len += coach.length; }
  return cars;
}

function playerRun(seed: number): PlayerResult {
  g = newGame(seed);
  const eco = g.company(0).economy;
  const money0 = eco.money, loan0 = eco.loan;
  // a player borrows when the bank balance runs short: build with an open purse, then book the shortfall as loan steps
  eco.money = 1e9;
  const settle = () => { const spent = 1e9 - eco.money; eco.money = money0 - spent; while (eco.money < 200_000 && eco.borrow()); return spent; };
  console.log(`\nseed ${seed}: ${g.towns.list.length} towns, pop ${g.towns.list.reduce((a, t) => a + t.pop, 0)}, money ${M(eco.money)} loan ${M(eco.loan)} max ${M(eco.maxLoan)}, rivals ${g.ais.length}`);
  // ---- railway
  const m0 = eco.money;
  const rw = firstRailway(120, 280, 12);
  let railLine = -1, railOk = false, railCapital = 0, pair = '-', distance = 0;
  if (rw) {
    const md = eco.money;
    let dep = depotBehind(g, rw.A, rw.B, 0);
    if (dep < 0) dep = depotBehind(g, rw.B, rw.A, 0);
    rw.costs += `, depot ${M(md - eco.money)}`;
    const line = g.lines.create('rail', 0);
    line.stops = [rw.A.id, rw.B.id];
    railLine = line.id;
    const cars = consist(rw.A.rail!.length);
    const t = dep >= 0 ? g.vehicles.buyTrain(dep, cars, line.id) : 'no depot';
    railOk = t instanceof Train;
    railCapital = m0 - eco.money;
    distance = Math.hypot(rw.A.x - rw.B.x, rw.A.z - rw.B.z);
    pair = `${rw.TA.name}(${rw.TA.pop})-${rw.TB.name}(${rw.TB.pop})`;
    console.log(`  rail ${pair}: ${fmt(distance * 0.01, 2)} km apart, ${fmt(rw.len * 0.01, 2)} km track, ${cars.map((c) => c.id).join('+')}, capital ${M(railCapital)}${railOk ? '' : ' (train: ' + t + ')'}: ${rw.costs}, train ${M(cars.reduce((a, c) => a + c.cost, 0))}`);
  } else console.log('  rail: no buildable pair');
  // ---- bus line in the biggest town with room for stops
  const m1 = eco.money;
  let busLine = -1, busOk = false;
  const towns = [...g.towns.list].sort((a, b) => b.pop - a.pop);
  for (const town of towns.slice(0, 3)) {
    const sites = busStopSites(g, town, 0, 25, 45);
    if (sites.length < 2) continue;
    const s0 = addBusStop(g, sites[0][0], sites[0][1], 0), s1 = addBusStop(g, sites[1][0], sites[1][1], 0);
    if (s0 < 0 || s1 < 0 || s0 === s1) continue;
    const dep = buildRoadDepot(g, sites[0][0], sites[0][1], 0, 26);
    if (dep < 0) continue;
    const line = g.lines.create('road', 0);
    line.stops = [s0, s1];
    busLine = line.id;
    const bus = availableModels(g.year, 'bus', false).filter((m) => m.capacity >= 25 && m.speed < 80);
    const model = bus[bus.length - 1] ?? MODEL_BY_ID.get('bus_a')!;
    let n = 0;
    for (let i = 0; i < 2; i++) if (typeof g.vehicles.buyRoad(dep, model, line.id) !== 'string') n++;
    busOk = n > 0;
    console.log(`  bus in ${town.name}(${town.pop}): stops ${fmt(Math.hypot(sites[0][0] - sites[1][0], sites[0][1] - sites[1][1]) * 0.01, 2)} km apart, ${n}x ${model.id}, capital ${M(m1 - eco.money)}`);
    break;
  }
  const busCapital = m1 - eco.money;
  const spent = settle();
  console.log(`  after building: money ${M(eco.money)} (spent ${M(spent)}), loan ${M(eco.loan)} (+${M(eco.loan - loan0)})`);
  // ---- simulate
  let firstDeliveryDay = -1;
  const years: PlayerResult['years'] = [];
  let prevRail = { inc: 0, cost: 0 }, prevBus = { inc: 0, cost: 0 };
  for (let y = 0; y < YEARS; y++) {
    runDays(360, () => { if (firstDeliveryDay < 0 && g.vehicles.ofOwner(0).some((v) => v.delivered > 0)) firstDeliveryDay = days(); });
    const yt = eco.yearTotals[eco.yearTotals.length - 1];
    const v = yt?.v ?? ({} as Record<string, number>);
    const rl = g.lines.get(railLine), bl = g.lines.get(busLine);
    const pax = g.vehicles.ofOwner(0).reduce((a, x) => a + x.delivered, 0);
    const row = {
      year: yt?.year ?? 0, money: eco.money, loan: eco.loan, income: (v.income ?? 0) + (v.mailIncome ?? 0), ops: total(v, OPS), interest: v.interest ?? 0,
      result: total(v, ['income', 'mailIncome', 'trackIncome', ...OPS, 'interest']),
      railIncome: rl?.incomeLast ?? 0, railCost: rl?.costLast ?? 0, busIncome: bl?.incomeLast ?? 0, busCost: bl?.costLast ?? 0, pax,
      townPop: g.towns.list.reduce((a, t) => a + t.pop, 0),
    };
    void prevRail; void prevBus;
    years.push(row);
    console.log(`  ${row.year}: money ${M(row.money)} loan ${M(row.loan)} | income ${k(row.income)} ops ${k(row.ops)} interest ${k(row.interest)} => ${k(row.result)}/yr | rail ${k(row.railIncome)} (veh ${k(row.railCost)}) bus ${k(row.busIncome)} (veh ${k(row.busCost)}) | pax ${row.pax} | towns ${row.townPop}`);
  }
  if (args.includes('-v')) for (const st of g.stations.all().filter((x) => x.owner === 0)) {
    const t = g.towns.list[st.townId];
    console.log(`    ${st.rail ? 'rail' : 'stop'} ${st.name}: ${t ? fmt(Math.hypot(st.x - t.x, st.z - t.z), 0) + ' u from centre of ' + t.name + ' r' + fmt(t.radius, 0) : ''}, catchment ${fmt(st.catchPop, 0)}, generating ${fmt(g.demand.generationPopulation(st), 0)}, rating ${fmt(st.rating, 2)}, generated ${st.genLast}/mo, picked up ${st.pickupLast}/mo, links ${st.links.length}`);
  }
  const last = years[years.length - 1];
  const opResult = last.income + last.ops; // before interest
  const capital = railCapital + busCapital;
  const payback = opResult > 0 ? capital / opResult : Infinity;
  // how many more such railways the remaining cash and credit would buy
  const credit = eco.money + (eco.maxLoan - eco.loan);
  const affordableLines = railCapital > 0 ? Math.floor(credit / railCapital) : 0;
  console.log(`  first delivery day ${firstDeliveryDay}; operating result ${k(opResult)}/yr on ${M(capital)} capital: payback ${isFinite(payback) ? fmt(payback, 1) + ' yr' : 'never'}; cash+credit ${M(credit)} = ${affordableLines} more such railways`);
  return { seed, pair, distance, railCapital, busCapital, railOk, busOk, firstDeliveryDay, years, payback, affordableLines };
}

// ------------------------------------------------------------------ AI
interface AIResult {
  seed: number; companies: { name: string; money: number; loan: number; rail: number; road: number; coach: number; tram: number; trains: number; buses: number; trams: number; railKm: number; income: number; result: number; railIncome: number; defunct: boolean }[];
  firstRailDay: number; zombies: number; dupCoach: number; dupRail: number; dupMixed: number; endToEnd: number; xQuads: number; stuck: number; stuckNames: string[]; reservations: number; msPerDay: number; townPop0: number; townPop: number;
  yearly: string[];
}

/** Town a station belongs to (nearest centre). */
function townOf(st: Station): number {
  let best = -1, bd = Infinity;
  for (const t of g.towns.list) { const d = Math.hypot(t.x - st.x, t.z - st.z); if (d < bd) { bd = d; best = t.id; } }
  return best;
}
const isTram = (l: { kind: string; tram?: boolean }) => l.kind === 'tram' || !!(l as { tram?: boolean }).tram;

function aiRun(seed: number): AIResult {
  g = newGame(seed);
  const pop0 = g.towns.list.reduce((a, t) => a + t.pop, 0);
  console.log(`\nseed ${seed}: ${g.towns.list.length} towns, pop ${pop0}, ${g.ais.length} rivals (${STYLE})`);
  const waitDays = new Map<number, number>();
  let firstRailDay = -1;
  const t0 = performance.now();
  const yearly: string[] = [];
  for (let y = 0; y < YEARS; y++) {
    runDays(360, () => {
      if (firstRailDay < 0 && g.lines.all().some((l) => l.owner > 0 && l.kind === 'rail' && l.vehicles.length)) firstRailDay = g.day;
      for (const v of g.vehicles.all()) {
        if (v.owner === 0) continue;
        if (v.state === 'waiting' || v.state === 'noroute') waitDays.set(v.id, (waitDays.get(v.id) ?? 0) + 1); else waitDays.delete(v.id);
      }
    });
    const s = g.ais.map((ai) => {
      const co = g.company(ai.companyId), ls = g.lines.all().filter((l) => l.owner === ai.companyId);
      return `${co.name.split(' ')[0]} ${M(co.economy.money)}/${M(co.economy.loan)} r${ls.filter((l) => l.kind === 'rail').length} b${ls.filter((l) => l.kind === 'road' && !isTram(l)).length} t${ls.filter(isTram).length}`;
    }).join(' | ');
    yearly.push(`${g.year}: ${s}`);
    console.log(`  ${g.year}: ${s}`);
  }
  const msPerDay = (performance.now() - t0) / (YEARS * 360);
  const companies: AIResult['companies'] = [];
  for (const ai of g.ais) {
    const co = g.company(ai.companyId), ls = g.lines.all().filter((l) => l.owner === ai.companyId);
    const vs = g.vehicles.all().filter((v) => v.owner === ai.companyId);
    let railKm = 0;
    for (const e of g.world.net.edges.values()) if (e.owner === ai.companyId && e.kind === 'rail') railKm += e.len / 100;
    const road = ls.filter((l) => l.kind === 'road' && !isTram(l));
    const coach = road.filter((l) => new Set(l.stops.map((s) => { const st = g.stations.get(s); return st ? townOf(st) : -1; })).size > 1);
    const yt = co.economy.yearTotals[co.economy.yearTotals.length - 1]?.v ?? ({} as Record<string, number>);
    companies.push({
      name: co.name, money: co.economy.money, loan: co.economy.loan, rail: ls.filter((l) => l.kind === 'rail').length, road: road.length, coach: coach.length, tram: ls.filter(isTram).length,
      trains: vs.filter((v) => v instanceof Train).length, buses: vs.filter((v) => !(v instanceof Train) && (v as { model?: VehicleModel }).model?.kind === 'bus').length,
      trams: vs.filter((v) => (v as { model?: VehicleModel }).model?.kind === 'tram').length, railKm,
      income: (yt.income ?? 0) + (yt.mailIncome ?? 0), result: total(yt, ['income', 'mailIncome', 'trackIncome', ...OPS, 'interest']),
      railIncome: ls.filter((l) => l.kind === 'rail').reduce((a, l) => a + l.incomeLast, 0), defunct: !!co.defunct,
    });
  }
  // near-duplicate services: two lines (any owners) whose terminals are each within 30 units (300 m) of the other's
  // (a line's termini: the ends of its path, not of its out-and-back stop list)
  const ends = (l: { stops: number[] }) => { const p = linearStops(l.stops) ?? l.stops, a = g.stations.get(p[0]), b = g.stations.get(p[p.length - 1]); return a && b && a !== b ? [a, b] : null; };
  const near = (p: Station, q: Station) => Math.hypot(p.x - q.x, p.z - q.z) < 30;
  const dup = (kind: (l: { kind: string; stops: number[] }) => boolean, other?: (l: { kind: string; stops: number[] }) => boolean) => {
    const ls = g.lines.all().filter((l) => l.owner > 0 && l.vehicles.length && kind(l));
    const ms = other ? g.lines.all().filter((l) => l.owner > 0 && l.vehicles.length && other(l)) : ls;
    let n = 0;
    for (let i = 0; i < ls.length; i++) for (let j = other ? 0 : i + 1; j < ms.length; j++) {
      const a = ends(ls[i]), b = ends(ms[j]);
      if (!a || !b || Math.hypot(a[0].x - a[1].x, a[0].z - a[1].z) < 60) continue;
      if ((near(a[0], b[0]) && near(a[1], b[1])) || (near(a[0], b[1]) && near(a[1], b[0]))) {
        n++;
        console.log(`    duplicate: ${g.company(ls[i].owner).name.split(' ')[0]} ${ls[i].name} (${ls[i].stops.map((id) => g.stations.get(id)?.name).join(' - ')}, ${k(ls[i].incomeLast)}) ~ ${g.company(ms[j].owner).name.split(' ')[0]} ${ms[j].name} (${ms[j].stops.map((id) => g.stations.get(id)?.name).join(' - ')}, ${k(ms[j].incomeLast)})`);
      }
    }
    return n;
  };
  const dupCoach = dup((l) => l.kind === 'road' && !isTram(l)), dupRail = dup((l) => l.kind === 'rail');
  const dupMixed = dup((l) => l.kind === 'rail', (l) => l.kind === 'road' && !isTram(l));
  // end-to-end rail lines: a terminus of one within 30 units of a terminus of the other (not joined into one line)
  let endToEnd = 0;
  const rl = g.lines.all().filter((l) => l.owner > 0 && l.vehicles.length && l.kind === 'rail');
  for (let i = 0; i < rl.length; i++) for (let j = i + 1; j < rl.length; j++) {
    const a = ends(rl[i]), b = ends(rl[j]);
    if (!a || !b) continue;
    for (const x of a) for (const y of b) {
      const far = [a.find((s) => s !== x)!, b.find((s) => s !== y)!];
      if (!near(x, y) || near(far[0], far[1]) || far[0].townId === far[1].townId) continue;
      endToEnd++;
      const how = x === y ? 'same station' : g.stations.complex(x.id).includes(y.id) ? 'one complex' : 'separate stations';
      console.log(`    end to end (${how}, ${Math.hypot(x.x - y.x, x.z - y.z).toFixed(0)} u): ${g.company(rl[i].owner).name.split(' ')[0]} ${rl[i].name} (${rl[i].stops.map((id) => g.stations.get(id)?.name).join(' - ')}, ${k(rl[i].incomeLast)}) + ${g.company(rl[j].owner).name.split(' ')[0]} ${rl[j].name} (${rl[j].stops.map((id) => g.stations.get(id)?.name).join(' - ')}, ${k(rl[j].incomeLast)})`);
    }
  }
  // X layouts: one company runs all four of a-b1, a-b2, c-b1, c-b2 (terminal towns of its rail lines)
  let xQuads = 0;
  for (const ai of g.ais) {
    const set = new Set<string>(), termini = new Set<number>();
    for (const l of g.lines.all()) {
      if (l.owner !== ai.companyId || l.kind !== 'rail' || l.stops.length < 2) continue;
      const path = [...new Set(l.stops)], ta = g.stations.get(path[0])?.townId ?? -1, tb = g.stations.get(path[path.length - 1])?.townId ?? -1;
      if (ta < 0 || tb < 0 || ta === tb) continue;
      const a = ta, b = tb;
      set.add(a + ':' + b); set.add(b + ':' + a); termini.add(a); termini.add(b);
    }
    const T = [...termini];
    for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) for (let p = 0; p < T.length; p++) for (let q = p + 1; q < T.length; q++) {
      const ids = new Set([T[i], T[j], T[p], T[q]]);
      if (ids.size < 4) continue;
      if (set.has(T[i] + ':' + T[p]) && set.has(T[i] + ':' + T[q]) && set.has(T[j] + ':' + T[p]) && set.has(T[j] + ':' + T[q]) && i < p) {
        xQuads++;
        console.log(`    X: ${g.company(ai.companyId).name.split(' ')[0]} runs ${[[i, p], [i, q], [j, p], [j, q]].map(([u, v]) => g.towns.list[T[u]].name + '-' + g.towns.list[T[v]].name).join(', ')}`);
      }
    }
  }
  // lines that earn nothing a whole year with vehicles on them (stuck, starved or pointless)
  const zombies = g.lines.all().filter((l) => l.owner > 0 && l.vehicles.length && l.incomeLast <= 0 && l.costLast > 0);
  for (const l of zombies) console.log(`    zero income: ${g.company(l.owner).name.split(' ')[0]} ${l.kind} ${l.name} (${l.stops.map((id) => g.stations.get(id)?.name).join(' - ')}): ${l.vehicles.map((id) => { const v = g.vehicles.get(id); return v ? `${v.name} ${v.state} "${v.status}"` : '?'; }).join(' | ')}`);
  const logFilter = flag('log', '');
  if (logFilter) for (const ai of g.ais) for (const line of ai.log.filter((x) => new RegExp(logFilter).test(x))) console.log(`    [${g.company(ai.companyId).name.split(' ')[0]}] ${line}`);
  const stuckIds = [...waitDays].filter(([id, d]) => d >= 20 && g.vehicles.get(id)).map(([id]) => id);
  const stuckNames = stuckIds.map((id) => { const v = g.vehicles.get(id)!; return `${v.name} ${v.state} ${waitDays.get(id)}d (${v.status}; line ${g.lines.get(v.lineId ?? -1)?.name ?? '-'})`; });
  const reservations = checkReservations(g).length;
  const pop = g.towns.list.reduce((a, t) => a + t.pop, 0);
  for (const c of companies) console.log(`  ${c.name}: ${M(c.money)} loan ${M(c.loan)}${c.defunct ? ' DEFUNCT' : ''} | rail ${c.rail} (${fmt(c.railKm, 1)} km, ${c.trains} trains, ${k(c.railIncome)}/yr) bus ${c.road - c.coach} coach ${c.coach} tram ${c.tram} | income ${k(c.income)} result ${k(c.result)}/yr`);
  for (const ai of g.ais) for (const l of g.lines.all().filter((x) => x.owner === ai.companyId)) {
    const st = l.stops.map((s) => g.stations.get(s)?.name ?? '?');
    console.log(`    ${l.kind}${isTram(l) ? '/tram' : ''} ${l.name}: ${st.length > 6 ? [...st.slice(0, 3), '…', ...st.slice(-2)].join(' - ') : st.join(' - ')} (${l.stops.length} stops), ${l.vehicles.length} veh, ${k(l.incomeLast)} inc, ${k(l.costLast)} cost`);
  }
  console.log(`  first AI railway day ${firstRailDay}; zero-income lines ${zombies.length}; duplicate coach pairs ${dupCoach}, duplicate rail pairs ${dupRail}, rail~coach ${dupMixed}, end-to-end ${endToEnd}, X quads ${xQuads}; stuck ${stuckIds.length} ${stuckNames.slice(0, 4).join(', ')}; reservations ${reservations}; towns ${pop0} -> ${pop}; ${fmt(msPerDay, 2)} ms/day`);
  return { seed, companies, firstRailDay, zombies: zombies.length, dupCoach, dupRail, dupMixed, endToEnd, xQuads, stuck: stuckIds.length, stuckNames, reservations, msPerDay, townPop0: pop0, townPop: pop, yearly };
}

// ------------------------------------------------------------------ main
const results: unknown[] = [];
for (const seed of seeds) results.push(mode === 'ai' ? aiRun(seed) : playerRun(seed));
if (mode === 'player') {
  const rs = results as PlayerResult[];
  const avg = (f: (r: PlayerResult) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
  const last = (r: PlayerResult) => r.years[r.years.length - 1];
  console.log(`\nsummary (${rs.length} seeds): rail capital ${M(avg((r) => r.railCapital))}, bus capital ${M(avg((r) => r.busCapital))}, rail income ${k(avg((r) => last(r).railIncome))}/yr, bus income ${k(avg((r) => last(r).busIncome))}/yr, company result ${k(avg((r) => last(r).result))}/yr, money ${M(avg((r) => last(r).money))}, payback ${fmt(avg((r) => Math.min(99, r.payback)), 1)} yr`);
  // Playability floor of the first lines (the preview after 2.9 fell through all three: a third of the riders):
  // the town bus repays its buses quickly, the train earns well over its running costs, and the two lines together
  // cover their running costs and the infrastructure upkeep before interest.
  if (args.includes('--check')) for (const r of rs) {
    const y = last(r);
    check(r.railOk && r.busOk, `seed ${r.seed}: the first railway and bus line could be built`);
    check(y.busIncome >= 3 * y.busCost, `seed ${r.seed}: the town bus earns at least 3x its running costs (${k(y.busIncome)} vs ${k(y.busCost)})`);
    check(y.railIncome >= 1.5 * y.railCost, `seed ${r.seed}: the first train earns at least 1.5x its running costs (${k(y.railIncome)} vs ${k(y.railCost)})`);
    check(y.income + y.ops > 0, `seed ${r.seed}: the first lines run at an operating profit before interest (${k(y.income + y.ops)}/yr)`);
  }
} else {
  const rs = results as AIResult[];
  console.log(`\nsummary (${rs.length} seeds): AI with rail ${rs.filter((r) => r.companies.some((c) => c.rail > 0)).length}/${rs.length} seeds, rail lines ${rs.map((r) => r.companies.reduce((a, c) => a + c.rail, 0)).join('/')}, coach ${rs.map((r) => r.companies.reduce((a, c) => a + c.coach, 0)).join('/')}, dup coach ${rs.map((r) => r.dupCoach).join('/')}, dup rail ${rs.map((r) => r.dupRail).join('/')}, rail~coach ${rs.map((r) => r.dupMixed).join('/')}, end-to-end ${rs.map((r) => r.endToEnd).join('/')}, X ${rs.map((r) => r.xQuads).join('/')}, stuck ${rs.map((r) => r.stuck).join('/')}, zero-income ${rs.map((r) => r.zombies).join('/')}, defunct ${rs.map((r) => r.companies.filter((c) => c.defunct).length).join('/')}`);
  if (args.includes('--check')) for (const r of rs) {
    check(r.dupCoach === 0, `seed ${r.seed}: no near-duplicate coach lines (${r.dupCoach})`);
    // (the user's pic 1: coaches beside a railway's stations at both ends)
    check(r.dupMixed === 0, `seed ${r.seed}: no coach line copying a railway stop to stop (${r.dupMixed})`);
    check(r.xQuads === 0, `seed ${r.seed}: no company runs all four lines of an X (${r.xQuads})`);
    check(r.reservations === 0, `seed ${r.seed}: reservations consistent`);
  }
}
const json = flag('json', '');
if (json) writeFileSync(json, JSON.stringify(results, null, 1));
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nDONE');
process.exitCode = fails.length ? 1 : 0;
