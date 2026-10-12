// Route upgrades as staged works (route-works.ts: construct, switch, remove; the user: "not a simple button, but
// construct-remove"): an AI and a player bus line upgraded to trams (the buses run on during the works, the line switches,
// the freed stops and depots go), an AI city bus line upgraded to a metro or light rail where that pays and not where it
// does not, a player coach line upgraded to a railway, works cancelled with a refund, and a game saved during works
// replaying exactly.
// npx esbuild scripts/upgrades.ts --bundle --platform=node --format=esm --outfile=$S/upgrades.mjs && node $S/upgrades.mjs [seed]
import '../src/game/patterns';
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { pickBus, pickCoach, type AIController } from '../src/game/ai';
import {
  planTownLine, planCoach, roadPlanJob, tramUpgradeValue, cityRailUpgradeValue, routeUpgradeValue, pays,
  type BusHost, type RoadPlan,
} from '../src/game/ai-bus';
import { planRouteUpgrade, startRouteWorks, cancelRouteWorks, worksOn, worksStatus, upgradeModes } from '../src/game/route-works';
import type { Town } from '../src/game/towns';
import type { Line } from '../src/game/lines';
import { outAndBack } from '../src/game/lines';
import { buildRoadDepot } from '../src/game/routing';
import { bezLine } from '../src/game/geom';
import { RoadVehicle } from '../src/game/roadvehicle';
import { fails, check, fmt, checkReservations, checkNaN, Train } from './lib';

const seed = Number(process.argv[2] ?? 7);
const drain = <T>(gen: Generator<void, T>): T => { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; };
const hostOf = (ai: AIController): BusHost => (ai as unknown as { busHost(): BusHost }).busHost();
const days = (g: Game, n: number) => { for (let i = 0; i < n * TICKS_PER_DAY; i++) g.stepTick(); };
const k = (x: number) => `${Math.round(x / 1000)}k`;
/** Run a road plan as the company's project would (ai.ts roadPlanJob). */
function build(ai: AIController, plan: RoadPlan): string {
  const a = ai as unknown as { project: unknown };
  a.project = { kind: 'bus', towns: plan.towns, stations: [], edges: [], depots: [], line: -1, started: ai.game.day };
  const out = drain(roadPlanJob(hostOf(ai), plan));
  a.project = null;
  return out;
}
/** Passengers the line's vehicles delivered so far. */
const delivered = (g: Game, l: Line) => l.vehicles.reduce((a, id) => a + (g.vehicles.get(id)?.delivered ?? 0), 0);

/** A player bus line through the AI's planned sites in a town, with `buses` buses. */
function playerLine(g: Game, T: Town, buses: number): Line | null {
  const host = hostOf(g.ais[0]);
  const plan = drain(planTownLine(host, T, pickBus(g.year, Math.max(T.pop, 1500))!));
  if (!plan) return null;
  const ids: number[] = [];
  for (const s of plan.sites) {
    const x = s.road?.x ?? s.x, z = s.road?.z ?? s.z;
    g.stations.commitBusStop(x, z, 0);
    const st = g.stations.findSharedStop(x, z, 0);
    if (st && st.owner === 0 && !ids.includes(st.id)) ids.push(st.id);
  }
  if (ids.length < 3) return null;
  const l = g.lines.create('road', 0);
  l.stops = outAndBack(ids);
  g.lines.rebuild();
  const st0 = g.stations.get(ids[0])!;
  const dep = buildRoadDepot(g, st0.stops[0].x, st0.stops[0].z, 0);
  for (let i = 0; i < buses; i++) g.vehicles.buyRoad(dep, pickBus(g.year, T.pop)!, l.id);
  return l.vehicles.length ? l : null;
}

/** Run a line's works to the end (at most `max` days): the days they took and whether the buses ran meanwhile. */
function runWorks(g: Game, l: Line, max = 400) {
  const w0 = worksOn(g, l.id)!;
  const stops0 = l.stops.join(), buses0 = l.vehicles.length, del0 = delivered(g, l);
  let d = 0, during = true, labels = new Set<string>(), switched = -1;
  for (; d < max && worksOn(g, l.id); d++) {
    const w = worksOn(g, l.id)!;
    labels.add(worksStatus(w).label.replace(/ · \d+%/, ''));
    if (w.stage === 'build') {
      // the bus line runs as it was until the switch
      if (l.kind !== 'road' || l.stops.join() !== stops0 || l.vehicles.length !== buses0) during = false;
    } else if (switched < 0) switched = d;
    days(g, 1);
  }
  return { days: d, during, ran: delivered(g, l) > del0 || switched > 0, labels: [...labels], total: w0.total, done: !worksOn(g, l.id) };
}

// ------------------------------------------------------------------------------ natural world
function natural(s = seed): Game {
  const road = { focus: { rail: 0, road: 1, tram: 0 }, startMoney: 20_000_000 };
  const g = Game.create({ size: 512, seed: s, towns: 14, hilliness: 'hilly', water: 'medium', startYear: 1990, aiCompanies: 1, aiConfigs: [road] });
  g.company(g.ais[0].companyId).economy.money += 60_000_000;
  g.economy.money = 80_000_000;
  g.aiEnabled = false;
  return g;
}

function aiTram(g: Game) {
  console.log('AI: a town bus line to trams, as staged works');
  const A = g.ais[0], hA = hostOf(A), me = A.companyId;
  const T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const plan = drain(planTownLine(hA, T, pickBus(g.year, Math.max(T.pop, 1500))!));
  check(!!plan, `a bus line plan in ${T.name}`);
  if (!plan) return;
  const before = new Set(g.lines.map.keys());
  console.log('  ' + build(A, { ...plan, loop: false, vehicles: 6, revenue: Infinity }));
  const L = [...g.lines.map.values()].find((l) => !before.has(l.id) && l.kind === 'road');
  check(!!L, 'the AI bus line opened');
  if (!L) return;
  days(g, 300);
  // a quiet town line: no light rail or metro (they do not pay)
  for (const [mode, level] of [['lightrail', 'elevated'], ['metro', 'underground']] as const) {
    const p = drain(cityRailUpgradeValue(hA, L, mode, level));
    console.log(`  ${mode}: ${p?.why ?? 'not possible'}`);
    check(!p || !pays(p), `no ${mode} for ${L.name} (${L.passLast} riders a month): it does not pay`);
  }
  const tram = drain(tramUpgradeValue(hA, L));
  console.log(`  ${tram?.why ?? 'no tram plan'}`);
  check(!!tram && pays(tram) && tram.works?.mode === 'tram', 'trams pay on the busy line');
  if (!tram || !pays(tram)) return;
  const id = L.id, stops = [...L.stops], depots = new Set(L.vehicles.map((v) => (g.vehicles.get(v) as RoadVehicle).depotId));
  const money0 = g.company(me).economy.money;
  console.log('  ' + build(A, tram));
  const w = worksOn(g, id);
  check(!!w && w.stage === 'build' && L.kind === 'road', 'works begin; the line is still a bus line');
  if (!w) return;
  check(g.company(me).economy.money > money0 - 1000, 'nothing is paid before the works build');
  const r = runWorks(g, L);
  console.log(`  works: ${r.days} days (planned ${r.total}), ${r.labels.join(' > ')}`);
  check(r.done && r.days >= r.total, `the works take their time (${r.days} days)`);
  check(r.during && r.ran, 'the buses run on, unchanged, until the switch');
  check(r.labels.includes('Building') && r.labels.includes('Removing old stops'), 'works report building, then removal');
  const l = g.lines.get(id);
  check(!!l && l.id === id && l.kind === 'tram' && l.stops.join() === stops.join(), 'the same line runs trams at the same stops');
  check(!!l && l.vehicles.length === tram.works!.vehicles && l.vehicles.every((v) => (g.vehicles.get(v) as RoadVehicle).isTram), 'only trams on it');
  check(!![...g.vehicles.map.values()].every((v) => !(v instanceof RoadVehicle) || v.isTram || v.lineId !== id), 'its buses are gone');
  check(stops.every((sid) => g.stations.tramStops(g.stations.get(sid)!, me).length > 0), 'its stops are tram stops now');
  check([...depots].every((d) => !g.depots.get(d)), 'the bus depot no vehicle uses is taken up');
  check(A.railLineInfo(id)?.kind === 'tram', 'the AI manages it as a tram line');
  check(!g.routeWorks.length, 'no works left');
  const del = delivered(g, l!);
  days(g, 60);
  check(delivered(g, l!) > del, 'the trams carry passengers');
}

function playerTram(g: Game) {
  console.log('player: a bus line to trams (planner), saved during the works');
  const T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[1];
  const L = playerLine(g, T, 4);
  check(!!L, `a player bus line in ${T.name}`);
  if (!L) return;
  days(g, 60);
  check(upgradeModes(g, L.id).join() === 'tram,lightrail,metro', 'a town line offers trams, light rail and a metro');
  const q = planRouteUpgrade(g, L.id, 0, 'tram');
  console.log(`  quote: ${q.ok ? `${fmt(q.trackLength * 10, 0)} m of track ${k(q.track)}, depot ${k(q.depot)}, ${q.vehicles} trams ${k(q.fleet)}, buses ${k(q.resale)}, net ${k(q.cost)}, ${q.days} days` : q.error}`);
  check(q.ok && q.cost > 0 && q.days > 0 && q.path.length >= 2, 'the planner prices the trams and the works');
  if (!q.ok) return;
  const money0 = g.economy.money, stops = L.stops.join();
  check(startRouteWorks(g, q) === null && !!worksOn(g, L.id), 'works started');
  const works = worksOn(g, L.id)!;
  check(startRouteWorks(g, q) !== null, 'one works per line');
  check(L.kind === 'road' && g.economy.money === money0, 'still a bus line; nothing paid yet');
  // a game saved during the works replays exactly
  days(g, 3);
  const w = worksOn(g, L.id)!;
  check(w.stage === 'build' && w.unit >= 1, `saved during the works (${worksStatus(w).label})`);
  const twin = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  check(JSON.stringify(serialize(twin)) === JSON.stringify(serialize(g)), 'a game saved during works loads exactly');
  const r = runWorks(g, L);
  for (let i = 0; i < r.days * TICKS_PER_DAY; i++) twin.stepTick();
  check(JSON.stringify(serialize(twin)) === JSON.stringify(serialize(g)), `the loaded game replays the works exactly (${r.days} days)`);
  check(r.done && r.during, 'the bus line ran unchanged until the switch');
  check(L.kind === 'tram' && L.stops.join() === stops && L.vehicles.length === q.vehicles, 'the line runs trams');
  // (what the works paid: their construction and the trams, less what the buses fetched)
  const spent = works.built.spent + q.fleet - q.resale;
  console.log(`  spent ${k(spent)} (quoted ${k(q.cost)}): ${works.built.debits.map((d) => k(d.cost)).join(' + ')}`);
  check(Math.abs(spent - q.cost) < Math.max(150_000, q.cost * 0.15), 'it cost what the planner said');
  check(checkReservations(g).length === 0 && checkNaN(g) === null, 'reservations and numbers sound');
}

function playerCancel(g: Game) {
  console.log('player: works cancelled before the switch, refunded');
  const T = [...g.towns.list].sort((a, b) => b.pop - a.pop)[2];
  const L = playerLine(g, T, 3);
  check(!!L, `a player bus line in ${T.name}`);
  if (!L) return;
  days(g, 30);
  // (a metro, else light rail, else trams: whatever this town allows)
  let q = planRouteUpgrade(g, L.id, 0, 'metro');
  for (const [mode, level] of [['lightrail', 'elevated'], ['lightrail', 'ground'], ['tram', undefined]] as const) {
    if (q.ok) break;
    console.log(`  ${q.mode}: ${q.error}`);
    q = planRouteUpgrade(g, L.id, 0, mode, level);
  }
  console.log(`  quote: ${q.ok ? `${q.mode}, ${q.sites?.length ?? 0} stations, ${k(q.cost)}, ${q.days} days` : q.error}`);
  check(q.ok, 'an upgrade is planned');
  if (!q.ok) return;
  const eco = g.economy, year0 = g.year, built0 = eco.thisYear.construction, stations0 = g.stations.map.size, stops = L.stops.join(), buses = L.vehicles.join();
  const rail0 = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail').length, trams = () => [...g.world.net.edges.values()].filter((e) => e.tram && e.tramOwner === 0).length, tram0 = trams();
  check(startRouteWorks(g, q) === null, 'works started');
  let d = 0;
  for (; d < 200 && (worksOn(g, L.id)?.built.debits.length ?? 0) < 2; d++) days(g, 1);
  const w = worksOn(g, L.id);
  check(!!w && w.built.debits.length >= 2 && w.stage === 'build', `two units built after ${d} days`);
  if (!w) return;
  const spent = built0 - eco.thisYear.construction;
  check(spent > 0 && Math.abs(spent - w.built.spent) < 1 && spent < q.cost, `paid as built (${k(spent)} of ${k(q.cost)})`);
  check(cancelRouteWorks(g, w.id, 1) !== null, 'another company cannot cancel them');
  check(cancelRouteWorks(g, w.id, 0) === null && !worksOn(g, L.id), 'cancelled');
  const lost = w.built.debits.reduce((a, b) => a + b.cost - b.refundable, 0), net = built0 - eco.thisYear.construction;
  console.log(`  refunded: ${k(spent)} spent, ${k(net)} after the refund (${k(lost)} of demolition not refundable)`);
  check(g.year !== year0 || Math.abs(net - lost) < 1, 'what was built is refunded (all but the demolished buildings)');
  check(g.stations.map.size === stations0 && w.built.stations.every((id) => !g.stations.get(id)), 'the new stations are taken up');
  check([...g.world.net.edges.values()].filter((e) => e.kind === 'rail').length === rail0 && trams() === tram0, 'no new track left');
  check(L.kind === 'road' && L.stops.join() === stops && L.vehicles.join() === buses, 'the bus line runs as before');
  const del = delivered(g, L);
  days(g, 20);
  check(delivered(g, L) > del, 'and carries passengers');
}

function playerCoach() {
  console.log('player: an inter-city coach line to a railway');
  // (the first map, of this seed and two more, with a coach line a railway can replace: towns on hills or by the sea
  // may have none)
  for (const s of [seed, 23, 11]) if (coachWorld(s)) return;
  check(false, 'a coach line a railway can replace');
}
function coachWorld(s: number): boolean {
  const g = natural(s), host = hostOf(g.ais[0]), coach = pickCoach(g.year)!;
  let plan: RoadPlan | null = null;
  for (const X of g.towns.list) for (const Y of g.towns.list) {
    const d = Math.hypot(X.x - Y.x, X.z - Y.z);
    if (plan || X.id >= Y.id || X.pop < 800 || Y.pop < 800 || d < 60 || d > 150) continue;
    const p = drain(planCoach(host, X, Y, coach));
    if (!p) continue;
    // (the player's coaches on these sites; a railway there must be possible)
    const ids: number[] = [];
    for (const s of p.sites) { const x = s.road?.x ?? s.x, z = s.road?.z ?? s.z; g.stations.commitBusStop(x, z, 0); const st = g.stations.findSharedStop(x, z, 0); if (st && !ids.includes(st.id)) ids.push(st.id); }
    const l = g.lines.create('road', 0);
    l.stops = outAndBack(ids); g.lines.rebuild();
    const q = planRouteUpgrade(g, l.id, 0, 'rail');
    console.log(`  ${X.name} - ${Y.name}: ${q.ok ? `${k(q.cost)}, ${fmt(q.trackLength * 10 / 1000, 1)} km, ${q.days} days` : q.error}`);
    if (q.ok) { plan = p; break; }
    g.lines.delete(l.id);
  }
  const L = [...g.lines.map.values()].find((l) => l.owner === 0 && l.kind === 'road');
  if (!plan || !L) return false;
  console.log(`  seed ${s}: ${L.name}`);
  const st0 = g.stations.get(L.stops[0])!, dep = buildRoadDepot(g, st0.stops[0].x, st0.stops[0].z, 0);
  for (let i = 0; i < 3; i++) g.vehicles.buyRoad(dep, coach, L.id);
  days(g, 60);
  check(upgradeModes(g, L.id).includes('rail') && !upgradeModes(g, L.id).includes('metro'), 'a coach line offers a railway');
  const q = planRouteUpgrade(g, L.id, 0, 'rail');
  check(q.ok && q.sites?.length === 2 && q.vehicles >= 1, 'the planner prices stations, track, depot and trains');
  if (!q.ok) return true;
  const olds = [...new Set(L.stops)], money0 = g.economy.money;
  check(startRouteWorks(g, q) === null, 'works started');
  const r = runWorks(g, L, 600);
  console.log(`  works: ${r.days} days, ${r.labels.join(' > ')}; spent ${k(money0 - g.economy.money)} (quoted ${k(q.cost)}); ${g.news[g.news.length - 1]?.text}`);
  check(r.done && r.during, 'the coaches ran until the switch');
  check(L.kind === 'rail' && new Set(L.stops).size === 2 && L.vehicles.length === q.vehicles && L.vehicles.every((v) => g.vehicles.get(v) instanceof Train), 'the line runs trains between the two stations');
  check(olds.every((id) => !g.stations.get(id)), 'the coach stops are taken up');
  check(L.stops.every((id) => !!g.stations.get(id)?.rail), 'its stops are railway stations');
  const del = delivered(g, L);
  days(g, 200);
  check(delivered(g, L) > del, `the trains carry passengers (${delivered(g, L) - del} in 200 days)`);
  check(checkReservations(g).length === 0, 'reservations consistent');
  return true;
}

// ------------------------------------------------------------------------------ a dense city
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(4), [], 'street', -1);
}
/** A dense city on a street grid (as urbanecon's fixtures): blocks of flats every 4 units along its streets. */
function city(g: Game, x: number, z: number, pop: number, width: number, height: number): Town {
  const t = { id: g.towns.list.length, name: 'Dense City', x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6, buildings: new Set<number>(), nextGrowthDay: 1e9,
    hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 } as unknown as Town;
  g.towns.list.push(t);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) road(g, rx, zs[i - 1], rx, zs[i]);
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  let left = pop;
  lots.forEach((p, i) => {
    const n = Math.ceil(left / (lots.length - i)); left -= n;
    t.buildings.add(g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: n, seed: i, y: 4, built: 0 }).id);
  });
  g.demand.rebuild();
  return t;
}

function aiCityRail() {
  console.log('AI: a busy city bus line to a metro or light rail');
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000, aiConfigs: [{ startMoney: 100_000_000, focus: { rail: 0, road: 1, tram: 0 } }] });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false; g.aiEnabled = false;
  const T = city(g, 256, 256, 40000, 160, 64), A = g.ais[0], hA = hostOf(A), me = A.companyId;
  // three buses on a long street through the centre: full, with riders giving up at every stop
  const ids: number[] = [];
  for (let x = 256 - 80 + 6; x <= 256 + 80 - 6; x += 24) { g.stations.commitBusStop(x, 252, me); const st = g.stations.findSharedStop(x, 252, me); if (st && !ids.includes(st.id)) ids.push(st.id); }
  const L = g.lines.create('road', me);
  L.stops = outAndBack(ids); g.lines.rebuild();
  const st0 = g.stations.get(ids[0])!, dep = buildRoadDepot(g, st0.stops[0].x, st0.stops[0].z, me);
  for (let i = 0; i < 3; i++) g.vehicles.buyRoad(dep, pickBus(g.year, T.pop)!, L.id);
  hA.managed.set(L.id, { kind: 'bus', towns: [T.id], depot: dep, maxVehicles: 3, opened: g.day });
  check(ids.length >= 5 && L.vehicles.length === 3, `a bus line of ${ids.length} stops in a city of ${T.pop}`);
  days(g, 450);
  const lost = ids.reduce((a, id) => a + (g.stations.get(id)?.lostLast ?? 0), 0);
  console.log(`  ${L.name}: ${L.passLast} riders last month, ${lost} gave up, ${k(L.incomeLast)} last year`);
  check(lost > 0, 'riders give up waiting for the full buses');
  const tram = drain(tramUpgradeValue(hA, L)), best = drain(routeUpgradeValue(hA, L));
  console.log(`  trams: ${tram?.why}\n  best: ${best?.why}`);
  check(!!best && pays(best) && (best.works?.mode === 'metro' || best.works?.mode === 'lightrail'), 'a metro or light rail pays here, and beats trams');
  check(!tram || !best || best.revenue - best.yearly > tram.revenue - tram.yearly, 'chosen by its surplus over the buses');
  if (!best?.works) return;
  const olds = [...new Set(L.stops)];
  console.log('  ' + build(A, best));
  const r = runWorks(g, L);
  console.log(`  works: ${r.days} days, ${r.labels.join(' > ')}`);
  check(r.done && r.during && r.ran, 'the buses ran until the switch');
  check(L.kind === 'rail' && L.vehicles.length === best.works.vehicles && L.vehicles.every((v) => g.vehicles.get(v) instanceof Train), `${L.name} runs ${best.works.mode} trains`);
  const sts = [...new Set(L.stops)].map((id) => g.stations.get(id)!);
  check(sts.length === best.works.sites!.length && sts.every((s) => s.rail?.mode === best.works!.mode && (best.works!.mode !== 'metro' || s.rail.level === 'underground')),
    `its ${sts.length} stations are ${best.works.mode} stations${best.works.mode === 'metro' ? ', underground' : ''}`);
  check(sts.every((s) => s.city), 'in-city stations (half the walking reach)');
  check(olds.every((id) => !g.stations.get(id)), 'the old bus stops are taken up');
  check(A.railLineInfo(L.id)?.urban === best.works.mode && A.railLineInfo(L.id)?.kind === 'rail', 'the AI manages it as a city railway');
  const del = delivered(g, L);
  days(g, 60);
  check(delivered(g, L) > del, 'the trains carry passengers');
  check(checkReservations(g).length === 0 && checkNaN(g) === null, 'reservations and numbers sound');
}

const t0 = performance.now();
{
  const g = natural();
  aiTram(g);
  playerTram(g);
  playerCancel(g);
}
playerCoach();
aiCityRail();
console.log(`\n${fails.length ? `${fails.length} FAILED:\n  ${fails.join('\n  ')}` : 'ALL OK'} (${fmt((performance.now() - t0) / 1000, 1)} s)`);
process.exit(fails.length ? 1 : 0);
