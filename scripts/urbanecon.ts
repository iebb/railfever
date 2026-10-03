// Urban calibration and cooperation, using real walking catchments and naturally generated passengers.
// Bundle into scratchpad/codex/urbanecon.mjs, then node urbanecon.mjs [--maps=7,23,51] [--years=8] [--size=512].
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { Train } from '../src/game/train';
import { Vehicle } from '../src/game/vehicle';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import type { Line } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack, linearStops } from '../src/game/lines';
import { stationEnds, nodeSnap, buildDepotOnLine } from '../src/game/routing';
import { connectStationThroat } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { fareFor, refTime, urbanIntensity, estimateLegFare, estimateLegTime, NO_TRANSFER_BONUS } from '../src/game/fares';
import { localTripMultiplier } from '../src/game/demand';
import { URBAN_PAYBACK } from '../src/game/constants';
import { patternHeadways } from '../src/game/patterns';
import { walkingCatchment } from '../src/game/catchment';
import { serialize, deserialize } from '../src/game/save';
import { check, fails, fmt, build, railOpts, checkReservations, addBusStop, roadDepotNear } from './lib';

const M = (id: string) => MODEL_BY_ID.get(id)!;
const arg = (key: string) => process.argv.find((s) => s.startsWith(`--${key}=`))?.slice(key.length + 3);
const runDays = (g: Game, days: number, each?: () => void) => {
  const end = g.day + days;
  while (g.day < end) { g.stepTick(); each?.(); }
};
const accessAI = (ai: AIController) => ai as AIController & Record<string, any>;
function flat(ais: number, size = 512) {
  const g = Game.create({ size, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: Array.from({ length: ais }, () => ({ startMoney: 100_000_000, accessPolicy: 'open' as const })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  return g;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
/**
 * Dense apartment neighbourhoods on a connected pedestrian grid; reserve the centre railway alignment (no buildings
 * on it). `crossStreets`: the grid's streets cross the alignment as well, as a real grid's do (else it is a free strip
 * that a street-level line could take without a single crossing street).
 */
function town(g: Game, name: string, x: number, z: number, pop: number, width = 120, height = 64, crossStreets = false): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0,
    passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) {
    if (!crossStreets && zs[i - 1] < z && zs[i] > z) continue;
    road(g, rx, zs[i - 1], rx, zs[i]);
  }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) {
    if (Math.abs(rz - z) < 7) continue; // platforms and their entrances can be built without clearing the town
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  g.demand.rebuild(); return t;
}
function station(g: Game, x: number, z: number, owner: number, townId: number): Station {
  const id = g.stations.nextId, p = g.stations.planRail(x, z, Math.PI / 2, 12, 2, owner, { style: 'none' });
  const error = p.ok ? g.stations.commitRail(p, owner) : p.error;
  if (error) throw new Error(`station ${x},${z}: ${error}`);
  const st = g.stations.get(id)!; st.townId = townId; return st;
}
function mainLine(g: Game, a: Station, b: Station, owner: number): Line {
  const ea = stationEnds(g, a)[0].front, eb = stationEnds(g, b)[0].back;
  const e0 = g.world.net.nextEdge;
  if (!build(g, nodeSnap(g, ea, 'rail'), nodeSnap(g, eb, 'rail'), railOpts(owner))) throw new Error('main line build');
  for (const s of [a, b]) connectStationThroat(g, s.id, owner);
  const es = [...g.world.net.edges.values()].filter((e) => e.id >= e0 && e.owner === owner && e.station < 0 && e.depot < 0 && e.len > 15);
  let dep = -1;
  for (const e of es) { dep = buildDepotOnLine(g, e.id, e.len * 0.3, owner); if (dep >= 0) break; }
  if (dep < 0) throw new Error('main line depot');
  const l = g.lines.create('rail', owner); l.stops = outAndBack([a.id, b.id]); autoSignalLine(g, l.id, owner);
  const train = g.vehicles.buyTrain(dep, [M('diesel_b'), M('coach_ic'), M('coach_ic')], l.id);
  if (!(train instanceof Train)) throw new Error(train);
  accessAI(g.aiOf(owner)!).adoptLines(); return l;
}
function open(g: Game, ai: AIController, kind: 'metro' | 'lightrail' | 'crosscity', t: Town) {
  g.aiEnabled = true;
  for (const c of g.ais) c.state.cooldown = 1e9;
  check(ai.startProject(kind, [t.id]), `${kind} project starts`);
  let ticks = 0;
  while (ai.busy && ticks++ < 160000) g.stepTick();
  check(!ai.busy, `${kind} finishes within its work budget`);
  console.log('  ' + ai.log.slice(-3).join(' | '));
  // Keep services fixed while measuring, with the normal economy, routing, demand and vehicle physics active.
  for (const c of g.ais) c.monthly = () => {};
  g.aiEnabled = false;
}
function profit(g: Game, l: Line) {
  const owners = new Set(g.lines.operatorsOf(l));
  // In these standalone urban fixtures the operator's entire infrastructure belongs to the one railway.
  const upkeep = [...owners].reduce((a, owner) => a + g.maintenanceOf(owner), 0);
  return l.incomeLast - l.costLast - upkeep;
}

if (!arg('maps')) {
  console.log('frequent main-line feeder access');
  {
    const g = flat(1), a = town(g, 'West Centre', 150, 256, 6000, 64, 48), b = town(g, 'East Centre', 362, 256, 6000, 64, 48);
    // Park-and-ride stations beyond the (doubled) walking reach: a country road out of each town leads to them.
    road(g, a.x - 32, a.z - 4, a.x - 70, a.z - 4); road(g, b.x + 32, b.z - 4, b.x + 70, b.z - 4);
    const sa = station(g, a.x - 75, a.z, 1, a.id), sb = station(g, b.x + 75, b.z, 1, b.id);
    const line = mainLine(g, sa, sb, 1), ai = g.ais[0];
    const first = g.vehicles.get(line.vehicles[0]) as Train;
    const second = g.vehicles.buyTrain(first.depotId, first.cars, line.id);
    check(second instanceof Train, 'a frequent main-line timetable has two trains');
    for (const c of g.ais) c.monthly = () => {};
    g.aiEnabled = false; runDays(g, 1080);
    const walkPop = sa.catchPop + sb.catchPop;
    const covered = [sa, sb].reduce((sum, st) => sum + g.demand.coverage(st).reduce((n, [r, f]) => n + g.demand.regions[r].pop * f, 0), 0);
    const net = profit(g, line);
    console.log(`  ${fmt(patternHeadways(g, line)[0]?.headway ?? 0, 0)}s headway, ${fmt(walkPop, 0)} walking / ${fmt(covered, 0)} eligible residents; ${line.passLast} passengers last month; profit ${fmt(net / 1e6, 2)}M/year`);
    check(walkPop === 0 && covered > 0 && line.incomeLast > 0, 'a park-and-ride line works with zero walking residents at either station');
    check(covered > walkPop * 1.1, 'street-connected car/drop-off access is distinct from walking coverage');
    const walk = walkingCatchment(g, sa);
    const localOnly = g.demand.forecastLine([
      { x: sa.x, z: sa.z, townId: a.id, walk }, { x: sa.x - 12, z: sa.z, townId: a.id, walk },
    ], 'mainline', 70, 100);
    const crossTown = g.demand.forecastLine([sa, sb], 'mainline', 70, 100);
    check(localOnly.boardings === 0 && crossTown.covered > localOnly.covered && crossTown.boardings > 0, `car feeders serve cross-town trips only: none invented between stops with no walking residents (${fmt(localOnly.covered, 0)} / ${fmt(crossTown.covered, 0)} covered, ${fmt(crossTown.boardings, 0)} cross-town boardings)`);
    check(checkReservations(g).length === 0, 'main-line feeder reservations consistent');
    void ai;
  }
  console.log('a bus complex with an unused rail platform');
  {
    // Only buses run there. The local uplift follows the service that carries the journey (demand.ts journeyMode),
    // not the platforms the station has: an unused rail platform must not lend the bus trips the rail uplift.
    const g = flat(0);
    road(g, 20, 60, 200, 60);
    const t: Town = { id: 0, name: 'Bus City', x: 72, z: 60, angle: 0, pop: 8000, buildings: new Set(), radius: 50, nextGrowthDay: 1e9, hasChurch: false,
      passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
    g.towns.list.push(t);
    const plan = g.stations.planRail(60, 54, Math.PI / 2, 10, 2, 0, { style: 'none', level: 'ground', trackType: 'standard' });
    check(plan.ok && !g.stations.commitRail(plan, 0), `an unused rail platform beside the bus stop (${plan.error ?? 'ok'})`);
    const A = addBusStop(g, 60, 60, 0), B = addBusStop(g, 84, 60, 0), st = g.stations.get(A)!;
    for (const x of [64, 88]) t.buildings.add(g.world.addBuilding({ townId: 0, x, z: 62, angle: Math.PI, w: 1.4, d: 1.4, type: 4, floors: 1, pop: 4000, seed: x, y: 4, built: 0 }).id);
    const line = g.lines.create('road'); line.stops = [A, B];
    const depot = roadDepotNear(g, 140, 60, 0);
    check(!!st.rail && depot >= 0 && typeof g.vehicles.buyRoad(depot, M('bus_c'), line.id) !== 'string', 'a mixed complex served by one bus line');
    g.lines.rebuild(); g.stations.recomputeCatchment(); g.demand.rebuild(); g.demand.recomputeShares();
    const served = () => { (g.demand as any).cache.clear(); return g.demand.weights(st).served; };
    const withPlatform = served(), rail = st.rail; st.rail = null;
    const busOnly = served(); st.rail = rail;
    console.log(`  served demand ${fmt(withPlatform, 3)} with the unused platform, ${fmt(busOnly, 3)} as a plain bus stop`);
    check(withPlatform > 0 && Math.abs(withPlatform / busOnly - 1) < 1e-9, 'bus-only trips get the bus uplift, whatever platforms the station has');
  }
  console.log('AI fare estimates use the fare model of the receipts');
  {
    // project and improvement estimates price a rail leg as vehicle.ts does (the rail minimum per journey), a bus
    // leg with its boarding charge: an estimate and a passenger's receipt on the same leg agree
    const g = flat(1), ai = g.ais[0] as AIController & Record<string, any>;
    for (const [models, track, dist, len, mode] of [[[M('emu_b')], 'electric', 24, 28, 'rail'], [[M('bus_c')], 'street', 18, 20, 'bus']] as const) {
      const sv = ai.serviceYearCalc([...models], 2, dist, len, track, 0.7);
      const receipt = fareFor(dist, estimateLegTime(dist, sv.kmh, sv.headway, len / dist), 1, { mode }) * (1 + NO_TRANSFER_BONUS);
      const estimate = estimateLegFare(dist, sv.kmh, sv.headway, 1, len / dist, true, false, { mode });
      const generic = estimateLegFare(dist, sv.kmh, sv.headway, 1, len / dist, true, true, { mode });
      console.log(`  ${mode}: ${dist} u, estimate ${fmt(sv.perPax, 0)} per trip (receipt ${fmt(receipt, 0)} per passenger)`);
      check(Math.abs(estimate - receipt) < 1e-6 && Math.abs(sv.perPax - generic) < 1e-6, `${mode} estimates and receipts use one fare model`);
    }
  }
  console.log('two 3,000-person towns, central stations');
  {
    // A main line between two towns of about 3,000 with stations in their centres, one train (loco and two coaches):
    // at least 15% of the seats taken and an operating surplus after track, station and depot upkeep by year three.
    const g = flat(1), a = town(g, 'West Market', 181, 256, 3000, 96, 64), b = town(g, 'East Market', 331, 256, 3000, 96, 64);
    const sa = station(g, a.x, a.z, 1, a.id), sb = station(g, b.x, b.z, 1, b.id);
    const line = mainLine(g, sa, sb, 1);
    for (const c of g.ais) c.monthly = () => {};
    g.aiEnabled = false;
    let load = 0, net = 0;
    for (let year = 1; year <= 3; year++) {
      const loads: number[] = [];
      let ticks = 0;
      runDays(g, 360, () => { if (++ticks % 4 === 0) for (const id of line.vehicles) { const v = g.vehicles.get(id)!; if (['running', 'loading', 'waiting'].includes(v.state)) loads.push(v.load / v.capacity); } });
      load = loads.reduce((x, y) => x + y, 0) / Math.max(1, loads.length); net = profit(g, line);
      console.log(`  year ${year}: income ${fmt(line.incomeLast / 1e3, 0)}k, running ${fmt(line.costLast / 1e3, 0)}k, upkeep ${fmt(g.maintenanceOf(1) / 1e3, 0)}k -> ${fmt(net / 1e3, 0)}k; load ${fmt(load * 100, 1)}%; walking ${fmt(sa.catchPop, 0)} / ${fmt(sb.catchPop, 0)}, headway ${fmt(patternHeadways(g, line)[0]?.headway ?? 0, 0)}s`);
    }
    check(load >= 0.15 && net >= 0, `a rail line between two 3,000-person towns with central stations is ${fmt(load * 100, 0)}% full and breaks even after upkeep by year three`);
    check(checkReservations(g).length === 0, 'two-town reservations consistent');
  }
  // Full-capital payback (construction and units against the operating result): a realistic band for each style, so
  // that a recalibration cannot pass a city railway that repays in a year or never.
  const PAYBACK_BAND = { lightrail: [3, 8], metro: [4, URBAN_PAYBACK.metro] } as const;
  for (const mode of ['lightrail', 'metro'] as const) {
    console.log(`8000-person centre ${mode}`);
    // (the grid's streets cross the line's corridor: a street-level line would cross one every 80 m)
    const g = flat(1), t = town(g, 'Dense City', 256, 256, 8000, 120, 64, true), ai = g.ais[0];
    const intensity = urbanIntensity(g, { x: t.x, z: t.z, townId: t.id });
    check(intensity > 0.7 && localTripMultiplier(g, { x: t.x, z: t.z, townId: t.id }, 'rail') > 4, 'a dense centre has substantial local transit demand');
    check(fareFor(7, 60, 1, { mode: 'rail' }) > fareFor(7, 60, 1), 'a short rail hop pays the minimum fare (any track type)');
    check(refTime(100, 1) > refTime(100), 'congestion and parking slow the city car alternative');
    open(g, ai, mode, t);
    const line = g.lines.all().find((l) => l.kind === 'rail' && l.owner === ai.companyId);
    check(!!line && new Set(line.stops).size === 5, `a five-station ${mode} opens without forcing an uneconomic build`);
    if (!line) continue;
    const cost = -(g.company(ai.companyId).economy.thisYear.construction + g.company(ai.companyId).economy.thisYear.vehicles);
    runDays(g, 720);
    const net = profit(g, line);
    console.log('  stations ' + [...new Set(line.stops)].map((id) => { const s = g.stations.get(id)!; return `${s.id}: ${fmt(s.catchPop, 0)} covered / ${fmt(g.demand.weights(s).served, 1)} demand / ${s.pickupLast} boardings / ${s.roadAccess} access`; }).join(' | '));
    console.log('  trains ' + line.vehicles.map((id) => { const v = g.vehicles.get(id)!; return `${v.state} ${v.status} (${v.delivered} delivered)`; }).join(' | '));
    console.log(`  ${mode}: ${new Set(line.stops).size} stops, ${fmt(cost / 1e6, 2)}M invested, revenue ${fmt(line.incomeLast / 1e6, 2)}M, operating profit ${fmt(net / 1e6, 2)}M/year, payback ${fmt(cost / net, 1)} years`);
    check(net > 0 && net * URBAN_PAYBACK[mode] >= cost, `${mode} operates profitably and repays within ${URBAN_PAYBACK[mode]} years`);
    const [lo, hi] = PAYBACK_BAND[mode];
    check(net > 0 && cost / net >= lo && cost / net <= hi, `${mode} repays its full capital in ${lo}-${hi} years (${net > 0 ? fmt(cost / net, 1) : 'never'})`);
    check(checkReservations(g).length === 0, `${mode} reservations consistent`);
  }

  function termini(ais: number, centralPop = 16000) {
    const g = flat(ais, 768), z = 384;
    const X = town(g, 'West Town', 110, z, 12000, 64, 48);
    const C = town(g, 'Grand City', 384, z, centralPop, 208, 64);
    const Y = town(g, 'East Town', 658, z, 12000, 64, 48);
    const west = station(g, X.x, z, 1, X.id), a = station(g, 296, z, 1, C.id);
    const b = station(g, 472, z, 2, C.id), east = station(g, Y.x, z, 2, Y.id);
    const l1 = mainLine(g, west, a, 1), l2 = mainLine(g, b, east, 2);
    return { g, C, west, a, b, east, l1, l2 };
  }

  console.log('cooperative city tunnel');
  {
    const { g, C, west, a, b, east, l1 } = termini(2);
    const ai = g.ais[0], pair = accessAI(ai).crossCityPair(C);
    check(!!pair && pair[0].st.owner !== pair[1].st.owner, 'two AI companies offer facing termini on open networks');
    if (pair) {
      const partner = g.ais[1], money = partner.available(), config = partner.config;
      partner.config = { ...config, accessPolicy: 'auto-reject' };
      check(!accessAI(ai).crossCityPair(C), 'closed access vetoes inter-company cooperation');
      partner.config = config;
      partner.config = { ...partner.config, risk: 0 };
      const savedCash = g.company(2).economy.money; g.company(2).economy.money = -50_000_000;
      check(!accessAI(ai).crossCityEconomics(C, ...pair).viable, 'an insolvent partner vetoes the joint project');
      g.company(2).economy.money = savedCash;
      check(money > 0, 'partner starts solvent');
      console.log('  forecast ' + JSON.stringify(accessAI(ai).crossCityEconomics(C, ...pair), (k, v) => k === 'partner' ? !!v : v));
    }
    open(g, ai, 'crosscity', C);
    const line = g.lines.get(l1.id), path = line && linearStops(line.stops);
    const centre = g.stations.all().find((s) => s.townId === C.id && s.rail?.level === 'underground');
    check(!!centre && path?.length === 5 && !!line?.operators?.includes(2), 'one through line has the underground centre and both operators');
    if (line && centre) {
      const owned = [1, 2].map((o) => [...g.world.net.edges.values()].filter((e) => e.owner === o && e.sections.some((s) => s.type === 'tunnel')).length);
      check(owned.every((n) => n > 0), 'each company owns its half of the tunnel');
      const seen = new Map<number, Set<number>>();
      runDays(g, 1440, () => { for (const v of g.vehicles.all()) if (v instanceof Train && v.state === 'loading') {
        const set = seen.get(v.owner) ?? new Set(); set.add(v.atStation); seen.set(v.owner, set);
      } });
      check([1, 2].every((o) => seen.get(o)?.has(west.id) && seen.get(o)?.has(east.id)), 'both operators run their own trains end to end');
      check((g.agreement(1, 2)?.paidTotal ?? 0) > 0 && (g.agreement(2, 1)?.paidTotal ?? 0) > 0, 'usage-share fees flow both ways');
      check([1, 2].every((o) => g.company(o).economy.money > 0 && g.company(o).economy.loan <= g.company(o).economy.maxLoan), 'both companies remain solvent');
      const saved = deserialize(serialize(g));
      check(!!saved.lines.get(line.id)?.operators?.includes(2) && saved.agreement(1, 2)?.paidTotal === g.agreement(1, 2)?.paidTotal, 'joint operators, ownership and fee history survive saving');
      console.log(`  fees 1→2 ${fmt((g.agreement(1, 2)?.paidTotal ?? 0) / 1000)}k, 2→1 ${fmt((g.agreement(2, 1)?.paidTotal ?? 0) / 1000)}k; cash ${[1, 2].map((o) => fmt(g.company(o).economy.money / 1e6, 1) + 'M').join(' / ')}`);
      check(checkReservations(g).length === 0, 'joint tunnel reservations consistent');
    }
    void a; void b;
  }

  for (const owner of [3, 1]) {
    console.log(`${owner === 3 ? 'third company' : 'terminus owner'} urban interchange line`);
    const { g, C, a, b } = termini(3, 20000), ai = g.aiOf(owner)!;
    if (owner === 3) open(g, g.aiOf(1)!, 'crosscity', C);
    open(g, ai, 'metro', C);
    const line = g.lines.all().find((l) => l.owner === owner && l.stops.some((sid) => g.stations.get(sid)?.rail?.trackType === 'metro'));
    check(!!line, 'the AI opens an urban railway serving both main-line stations');
    if (!line) continue;
    const metro = [...new Set(line.stops)].map((sid) => g.stations.get(sid)!);
    check([a, b].every((s) => metro.some((m) => s.links.includes(m.id) && m.links.includes(s.id))), 'both termini have explicit walking transfer complexes');
    const transferBoards = new Map<number, number>();
    const serve = Vehicle.prototype.serveStation;
    Vehicle.prototype.serveStation = function(st, perPax) {
      const waiting = [...st.waiting.values()].filter((w) => w.line === line.id && (w.transfers ?? 0) > 0).reduce((n, w) => n + w.count, 0);
      const before = st.waitingTotal, result = serve.call(this, st, perPax);
      if (this.lineId === line.id && waiting > 0 && st.waitingTotal < before) transferBoards.set(this.owner, (transferBoards.get(this.owner) ?? 0) + before - st.waitingTotal);
      return result;
    };
    runDays(g, 720); Vehicle.prototype.serveStation = serve;
    const upkeep = owner === 3 ? g.maintenanceOf(owner) : metro.reduce((n, s) => n + g.stationMaintenance(s), 0)
      + [...g.world.net.edges.values()].filter((e) => e.owner === owner && e.type === 'metro').reduce((n, e) => n + g.edgeMaintenance(e), 0) + 12000;
    const net = line.incomeLast - line.costLast - upkeep;
    console.log(`  metro revenue ${fmt(line.incomeLast / 1e6, 2)}M, operating profit ${fmt(net / 1e6, 2)}M/year, transferred boardings ${transferBoards.get(owner) ?? 0}`);
    check((transferBoards.get(owner) ?? 0) > 0, 'naturally generated main-line arrivals transfer onto the urban line');
    check(net > 0, 'the interchange railway makes an operating profit after two years');
  }
} else {
  const seeds = arg('maps')!.split(',').map(Number), years = Number(arg('years') ?? 8), size = Number(arg('size') ?? 512);
  let urban = 0, profitable = 0;
  for (const seed of seeds) {
    const started = performance.now();
    const g = Game.create({ size, seed, towns: Math.round(size / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
    console.log(`seed ${seed}: map ready in ${fmt((performance.now() - started) / 1000, 1)}s`);
    const opened = new Map<number, { day: number; pop: number }>();
    const twoYearProfit = new Map<number, number>();
    const urbanProfit = (l: Line) => {
      const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)!).filter((s) => s.rail);
      const upkeep = sts.reduce((n, s) => n + g.stationMaintenance(s), 0)
        + [...g.world.net.edges.values()].filter((e) => e.owner === l.owner && ['metro', 'lightrail'].includes(e.type)).reduce((n, e) => n + g.edgeMaintenance(e), 0) + 12000;
      return l.incomeLast - l.costLast - upkeep;
    };
    let reportedYear = g.year;
    while (g.day < years * 360) {
      g.stepTick();
      for (const l of g.lines.all()) {
        if (!opened.has(l.id) && l.kind === 'rail' && l.vehicles.length > 0 && l.stops.some((s) => ['metro', 'lightrail'].includes(g.stations.get(s)?.rail?.trackType ?? ''))) {
          const pop = Math.max(...l.stops.map((id) => g.towns.list[g.stations.get(id)?.townId ?? -1]?.pop ?? 0));
          opened.set(l.id, { day: g.day, pop });
          if (process.argv.includes('--details')) console.log(`  ${g.dateString()}: urban opening ${l.name}, population ${pop}`);
        }
        const opening = opened.get(l.id);
        if (opening && g.day >= opening.day + 720 && !twoYearProfit.has(l.id)) {
          const net = urbanProfit(l); twoYearProfit.set(l.id, net);
          if (process.argv.includes('--details')) console.log(`  ${g.dateString()}: ${l.name} after two years, operating profit ${fmt(net / 1e6, 2)}M/year`);
        }
      }
      if (process.argv.includes('--details') && g.year !== reportedYear) {
        reportedYear = g.year;
        console.log(`  ${g.dateString()}, ${fmt((performance.now() - started) / 1000, 1)}s elapsed; ${g.lines.all().length} lines, ${opened.size} urban openings`);
      }
    }
    const lines = g.lines.all().filter((l) => l.kind === 'rail' && (opened.get(l.id)?.pop ?? 0) >= 5000 && l.stops.some((sid) => { const s = g.stations.get(sid); return s && ['metro', 'lightrail'].includes(s.rail?.trackType ?? '') && (g.towns.list[s.townId]?.pop ?? 0) >= 5000; }));
    urban += lines.length;
    for (const l of lines) {
      const net = urbanProfit(l), age = (g.day - (opened.get(l.id)?.day ?? g.day)) / 360, atTwo = twoYearProfit.get(l.id);
      if (net > 0 && age >= 2 && (atTwo ?? -Infinity) > 0) profitable++;
      console.log(`  seed ${seed} ${l.name}, opening population ${opened.get(l.id)?.pop}, age ${fmt(age, 1)} years, operating profit ${fmt(net / 1e6, 2)}M/year, revenue ${fmt(l.incomeLast / 1e6, 2)}M; after two years ${atTwo === undefined ? 'not reached' : fmt(atTwo / 1e6, 2) + 'M/year'}`);
    }
    console.log(`seed ${seed}: ${opened.size} urban openings (${[...opened.values()].filter((s) => s.pop >= 5000).length} in towns ≥5000), ${lines.length} qualifying lines remain; largest town ${Math.max(...g.towns.list.map((t) => t.pop))}; ${fmt((performance.now() - started) / 1000, 1)}s`);
    if (process.argv.includes('--details')) for (const ai of g.ais) console.log(`${g.company(ai.companyId).name}, ${fmt(ai.available() / 1e6, 1)}M available:\n${ai.log.join('\n')}`);
  }
  check(urban >= 1 && profitable >= 1, 'natural AI maps build a city-centre railway with positive profit after two years');
}
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
