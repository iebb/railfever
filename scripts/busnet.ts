// AI road services (ai-bus.ts): a company runs vehicles on another's busy line rather than opening a parallel one, extends
// its lines rather than opening short new ones, opens feeders to rail stations where the changing riders pay, opens no
// near-duplicate of a served town pair, and a game with such services replays exactly after saving and loading.
// npx esbuild scripts/busnet.ts --bundle --platform=node --format=esm --outfile=$S/busnet.mjs && node $S/busnet.mjs [seed]
import '../src/game/patterns';
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { pickCoach, pickBus, type AIController } from '../src/game/ai';
import {
  roadForecast, roadOptions, tramUpgradeValue, coachUpgrades, stopSites, townsOnTheWay, planTramUpgrade, buildTramUpgrade, roadPlanJob, roadMarket, moreValue, planCoach, planTownLine, planExtensions, routeOf, worth, pays,
  type BusHost, type RoadPlan, type ProjectOption,
} from '../src/game/ai-bus';
import type { Town } from '../src/game/towns';
import type { Line } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { outAndBack } from '../src/game/lines';
import { fails, check, fmt, depotBehind, connectStations, townPairs, checkReservations, checkNaN, roadDepotNear, Train } from './lib';
import { findRailPair } from '../src/game/routing';
import type { Station } from '../src/game/stations';

const seed = Number(process.argv[2] ?? 7);
const drain = <T>(gen: Generator<void, T>): T => { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; };
const hostOf = (ai: AIController): BusHost => (ai as unknown as { busHost(): BusHost }).busHost();
const days = (g: Game, n: number) => { for (let i = 0; i < n * TICKS_PER_DAY; i++) g.stepTick(); };
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) => Math.hypot(a.x - b.x, a.z - b.z);
const townsOf = (g: Game, l: Line) => [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
/** Run a plan as the company's project would (stations and depots it lays recorded for its clean-up). */
function build(ai: AIController, plan: RoadPlan): string {
  const a = ai as unknown as { project: unknown };
  a.project = { kind: 'bus', towns: plan.towns, stations: [], edges: [], depots: [], line: -1, started: ai.game.day };
  const out = drain(roadPlanJob(hostOf(ai), plan));
  a.project = null;
  return out;
}
/**
 * Two road lines run between the same towns from stops near each other's (the user's near-duplicate): their termini
 * near at both ends, or every stop of one near a stop of the other (a line the other shadows; lines sharing a stretch
 * of their routes and going on to other towns are not duplicates).
 */
function nearDuplicate(g: Game, a: Line, b: Line, r = 25): boolean {
  const ra = routeOf(g, a), rb = routeOf(g, b);
  if (!ra || !rb) return false;
  const ends = (p: number[]) => [g.stations.get(p[0])!, g.stations.get(p[p.length - 1])!];
  const [a0, a1] = ends(ra.path), [b0, b1] = ends(rb.path);
  if ((dist(a0, b0) <= r && dist(a1, b1) <= r) || (dist(a0, b1) <= r && dist(a1, b0) <= r)) return true;
  const stops = (l: Line) => [...new Set(l.stops)].map((id) => g.stations.get(id)!).filter(Boolean);
  const sa = stops(a), sb = stops(b), [small, big] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  return small.length >= 2 && small.every((p) => big.some((q) => dist(p, q) <= r));
}

function world(): Game {
  const road = { focus: { rail: 0, road: 1, tram: 0 }, startMoney: 20_000_000 };
  const g = Game.create({ size: 512, seed, towns: 14, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2, aiConfigs: [road, road] });
  for (const ai of g.ais) { const e = g.company(ai.companyId).economy; e.money += 20_000_000; }
  return g;
}

/** Town pairs 60-150 apart, both of 400+ residents, by size. */
function pairs(g: Game): [Town, Town][] {
  const out: [Town, Town][] = [];
  for (const A of g.towns.list) for (const B of g.towns.list) {
    const d = dist(A, B);
    if (A.id < B.id && A.pop >= 400 && B.pop >= 400 && d >= 60 && d <= 150) out.push([A, B]);
  }
  return out.sort((p, q) => q[0].pop * q[1].pop - p[0].pop * p[1].pop);
}

/** A connected two-station railway of `owner` between towns 60-200 apart (the first pair whose stations connect). */
function railway(g: Game, owner: number, exclude: Set<number>): { A: Station; B: Station; TA: Town; TB: Town; dep: number } | null {
  for (const [TA, TB] of townPairs(g, 60, 200, exclude)) {
    const pr = findRailPair(g, TA, TB, { tracks: 2, length: 16, owner, front: 22 });
    if (!pr) continue;
    const ia = g.stations.nextId;
    if (g.stations.commitRail(pr.a, owner)) continue;
    const pb = g.stations.planRail(pr.b.x, pr.b.z, pr.b.angle, 16, 2, owner), ib = g.stations.nextId;
    if (!pb.ok || g.stations.commitRail(pb, owner)) { g.stations.removeStation(ia); continue; }
    const A = g.stations.get(ia)!, B = g.stations.get(ib)!;
    if (connectStations(g, A, B, owner, 1, () => {}).ok) {
      const dep = depotBehind(g, A, B, owner), dep2 = dep >= 0 ? dep : depotBehind(g, B, A, owner);
      if (dep2 >= 0) return { A, B, TA, TB, dep: dep2 };
    }
    g.stations.removeStation(ib); g.stations.removeStation(ia);
  }
  return null;
}

function run() {
  const g = world();
  g.aiEnabled = false;
  const [A, B] = g.ais, hA = hostOf(A), hB = hostOf(B);
  const coach = pickCoach(g.year)!;
  console.log(`busnet seed ${seed}: ${g.towns.list.length} towns, ${g.towns.list.map((t) => `${t.name} ${t.pop}`).join(', ')}`);

  // ---------------------------------------------------------------- 1. a partner rather than a parallel coach line
  let XY: [Town, Town] | null = null, coachPlan: RoadPlan | null = null;
  for (const [X, Y] of pairs(g)) {
    const p = drain(planCoach(hA, X, Y, coach));
    if (p && pays(p)) { XY = [X, Y]; coachPlan = p; break; }
  }
  check(!!XY && !!coachPlan, 'a coach line between two towns pays for company A');
  if (!XY || !coachPlan) return;
  const [X, Y] = XY;
  console.log(`  A's coaches ${X.name} - ${Y.name}: ${coachPlan.why}`);
  const linesBefore = g.lines.map.size;
  console.log('  ' + build(A, coachPlan));
  const LA = [...g.lines.map.values()].find((l) => l.owner === A.companyId && l.kind === 'road');
  check(!!LA && g.lines.map.size === linesBefore + 1, 'A opened its coach line');
  if (!LA) return;
  // (one coach left: more riders than it seats, room for a partner)
  for (const id of LA.vehicles.slice(1)) g.vehicles.sell(id);
  days(g, 240);
  check(LA.incomeYear > 0, `A's coach line earns (${Math.round(LA.incomeYear / 1000)}k this year)`);
  // (B runs buses in these towns: its depot there)
  { const st = g.stations.get(LA.stops[0])!; check(roadDepotNear(g, st.x, st.z, B.companyId) >= 0, "B's road depot in " + X.name); }
  // B's choice for the same towns (its coach option picked): its own coaches there, or vehicles on A's line
  const partner = drain(moreValue(hB, LA)), copy = drain(planCoach(hB, X, Y, coach)), market = drain(roadMarket(hB, 'coach', [X.id, Y.id]));
  console.log(`  B as A's partner: ${partner?.why ?? 'no'}\n  B's own coaches: ${copy?.why ?? 'none'}\n  B's choice: ${market?.why ?? 'nothing pays'}`);
  check(!!partner && pays(partner), "B's coaches on A's busy line pay");
  check(!copy || !pays(copy) || (copy.revenue - copy.yearly) / copy.outlay < (partner!.revenue - partner!.yearly) / partner!.outlay,
    'running on A\'s line returns more than B\'s own coaches between the towns');
  check(market?.kind === 'join' && market.line === LA.id, "B's coach project for the pair becomes vehicles on A's line");
  if (copy) {
    const route = routeOf(g, LA)!, ends = [g.stations.get(route.path[0])!, g.stations.get(route.path[route.path.length - 1])!];
    const near = copy.sites.every((s) => ends.some((e) => dist(s, e) <= 25));
    console.log(`  B's own stops ${near ? 'beside' : 'away from'} A's (${copy.sites.map((s) => Math.round(Math.min(...ends.map((e) => dist(s, e))))).join('/')} units)`);
  }
  // with roadOptions alone (no coach option picked), B finds the partner option too
  const opts: ProjectOption[] = [];
  drain(roadOptions(hB, opts, hB.available(), 1));
  console.log(`  B's road options: ${opts.map((o) => `${o.kind} ${fmt(o.score, 2)}`).join('; ') || 'none'}`);
  check(opts.some((o) => o.kind === 'busjoin' && o.road?.line === LA.id && o.score > 0), "B's project options include a partner on A's line");
  if (market?.kind === 'join') {
    console.log('  ' + build(B, market));
    check(LA.operators?.includes(B.companyId) === true, "B runs vehicles on A's line as a partner");
    check(LA.vehicles.some((id) => g.vehicles.get(id)?.owner === B.companyId), "B's vehicle runs on A's line");
    check(B.railLineInfo(LA.id)?.joined === true, 'B manages the joined line');
    check(![...g.lines.map.values()].some((l) => l.owner === B.companyId && l.kind === 'road' && townsOf(g, l).includes(X.id) && townsOf(g, l).includes(Y.id)), `B opened no coach line of its own between ${X.name} and ${Y.name}`);
  }

  // ---------------------------------------------------------------- 2. a feeder to a rail station that pays
  {
    const pr = railway(g, A.companyId, new Set());
    check(!!pr, 'a railway of A between two towns');
    if (pr) {
      const dep = pr.dep;
      const rl = g.lines.create('rail', A.companyId);
      rl.stops = [pr.A.id, pr.B.id];
      for (let i = 0; i < 2; i++) {
        const t = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], rl.id);
        check(t instanceof Train, `a train on the railway${typeof t === 'string' ? ': ' + t : ''} (depot ${dep})`);
      }
      days(g, 180);
      const P = pr.TA, bus = pickBus(g.year, Math.max(P.pop, 1500))!;
      const plan = drain(planTownLine(hA, P, bus));
      console.log(`  ${P.name} (${P.pop}): ${plan?.why ?? 'no line'}`);
      const atRail = plan?.sites.findIndex((s) => g.stations.complex(s.station?.id ?? -1).includes(pr.A.id) || (s.links ?? []).includes(pr.A.id)) ?? -1;
      check(!!plan && pays(plan) && atRail >= 0, `the best bus line in ${P.name} serves ${pr.A.name} and pays`);
      if (plan && atRail >= 0) {
        // the same stops without the change to the trains: the transfers are what the feeder adds
        const f = drain(roadForecast(g, A.companyId, plan.sites, { model: bus, vehicles: plan.vehicles, loop: !!plan.loop }));
        // (the stop at the station as a plain stop on its street: no station complex, no change to the trains)
        const cut = plan.sites.map((s, i) => i === atRail ? { x: s.road?.x ?? s.x, z: s.road?.z ?? s.z, townId: s.townId } : s);
        const f0 = drain(roadForecast(g, A.companyId, cut, { model: bus, vehicles: plan.vehicles, loop: !!plan.loop }));
        console.log(`  feeder: ${Math.round(f.riders)} riders (${Math.round(f.transfers)} changing), bus ${Math.round(f.revenue / 1000)}k + rail ${Math.round(f.network / 1000)}k, worth ${Math.round(worth(f) / 1000)}k/year; without the change ${Math.round(worth(f0) / 1000)}k`);
        check(f.transfers > 0 && worth(f) > worth(f0), 'riders changing to the trains add to the feeder');
        console.log('  ' + build(A, plan));
        const FL = [...g.lines.map.values()].find((l) => l.owner === A.companyId && l.kind === 'road' && l.stops.some((s) => g.stations.complex(s).includes(pr.A.id)));
        check(!!FL, `a bus line calls at ${pr.A.name}'s complex`);
        if (FL) {
          days(g, 180);
          let onward = 0;
          for (const sid of new Set(FL.stops)) for (const w of g.stations.get(sid)?.waiting.values() ?? []) if (g.stations.get(w.dest)?.townId === pr.TB.id) onward += w.count;
          const arrivals = [...g.stations.get(pr.A.id)?.waiting.values() ?? []].filter((w) => w.line === FL.id).reduce((a, w) => a + w.count, 0);
          console.log(`  after 180 days: ${FL.name} earned ${Math.round(FL.incomeYear / 1000)}k; ${onward} waiting at its stops for ${pr.TB.name}, ${arrivals} at ${pr.A.name} for the bus`);
          check(FL.incomeYear > 0 && onward + arrivals > 0, 'the feeder carries riders between the trains and the town');
        }
      }
      // a busy coach line of ours between the railway's towns, calling at its stations: the railway replaces it
      const atRailStation = (st: Station) => drain(stopSites(g, A.companyId, st.x, st.z, 20)).find((x) => x.station?.id === st.id || x.links?.includes(st.id) || (x.station && g.stations.complex(x.station.id).includes(st.id)));
      const ca = atRailStation(pr.A), cb = atRailStation(pr.B);
      const cp0 = drain(planCoach(hA, pr.TA, pr.TB, coach));
      const cp = cp0 && ca && cb ? { ...cp0, sites: [ca, cb] } : null;
      if (!cp) console.log('  (no coach stop sites at both stations: the coach-to-rail checks are skipped)');
      if (cp) {
        const before = new Set(g.lines.map.keys());
        console.log('  ' + build(A, { ...cp, vehicles: 3, revenue: Infinity }));
        const CL = [...g.lines.map.values()].find((l) => !before.has(l.id) && l.kind === 'road');
        if (CL) {
          days(g, 760);
          const key = Math.min(pr.TA.id, pr.TB.id) + '-' + Math.max(pr.TA.id, pr.TB.id);
          const up = coachUpgrades(hA).get(key);
          console.log(`  ${CL.name}: ${Math.round(CL.incomeLast / 1000)}k income, ${Math.round(CL.costLast / 1000)}k costs last year; ${up ? `a railway would forgo ${Math.round(up.profit / 1000)}k a year` : 'not busy'}`);
          check(!up || up.line === CL.id, 'the busy coach line is the one a railway between its towns replaces');
          const atStations = new Set(CL.stops).size === [...new Set(CL.stops)].filter((sid) => g.stations.complex(sid).some((id) => id === pr.A.id || id === pr.B.id)).length;
          // (the company's monthly review moves the riders over: AIController.manage, ai-bus.ts retireToRail)
          const color = CL.color, name = CL.name;
          g.aiEnabled = true; days(g, 35); g.aiEnabled = false;
          console.log(`  after a month: ${name} ${g.lines.get(CL.id) ? 'still runs' : 'withdrawn'} (${atStations ? 'calls at' : 'does not call at'} the stations), ${rl.name} ${rl.color === color ? 'takes its colour' : ''}`);
          check(!atStations || (!g.lines.get(CL.id) && rl.color === color), 'a coach line calling at the railway\'s stations is withdrawn, the railway takes its colour');
        }
      }
    }
  }

  // ---------------------------------------------------------------- 3. a longer line rather than a new short one
  const busy = new Set([...g.lines.map.values()].filter((l) => l.kind === 'road' && l.owner === A.companyId).flatMap((l) => townsOf(g, l).length === 1 ? townsOf(g, l) : []));
  const T = [...g.towns.list].filter((t) => t.pop >= 1400 && !busy.has(t.id)).sort((a, b) => b.pop - a.pop)[0];
  check(!!T, 'a town big enough for buses');
  let LT: Line | undefined;
  if (T) {
    const bus = pickBus(g.year, T.pop)!;
    const plan = drain(planTownLine(hA, T, bus));
    check(!!plan, `a town line for ${T.name}`);
    if (plan) {
      // a short start: its first stops only, then the extensions compete with a new line
      const short: RoadPlan = { ...plan, sites: plan.sites.slice(0, 3), loop: false, vehicles: 2, revenue: Infinity };
      console.log('  ' + build(A, short));
      LT = [...g.lines.map.values()].find((l) => l.owner === A.companyId && l.kind === 'road' && townsOf(g, l).length === 1 && townsOf(g, l)[0] === T.id);
      check(!!LT, `A runs a town line in ${T.name}`);
    }
  }
  if (LT) {
    days(g, 200);
    const stops0 = new Set(LT.stops).size, lines0 = g.lines.map.size;
    const ext = drain(planExtensions(hA, LT, 4)).filter(pays).sort((p, q) => (q.revenue - q.yearly) / q.outlay - (p.revenue - p.yearly) / p.outlay);
    console.log(`  extensions of ${LT.name}: ${ext.map((p) => p.why).join(' | ') || 'none'}`);
    check(ext.length > 0, `A's town line in ${T.name} can grow by a stop that pays`);
    if (ext.length) {
      console.log('  ' + build(A, ext[0]));
      const L2 = g.lines.get(LT.id);
      check(!!L2 && L2.id === LT.id && new Set(L2.stops).size === stops0 + 1, 'the line runs on to its new stop (same line, one stop more)');
      check(g.lines.map.size === lines0, 'no new line opened for it');
      const r = L2 && routeOf(g, L2);
      check(!!r && (r.loop || new Set(L2!.stops).size === r.path.length), 'the line keeps its shape (out and back or loop)');
    }
    // (for comparison: a second line of ours in the town; the project choice offers none while we run one there)
    const T2 = drain(planTownLine(hA, T, pickBus(g.year, T.pop)!));
    if (T2 && ext.length) console.log(`  a new line instead: ${T2.why}`);
  }
  // coaches: on to the next town or a new coach line from the terminus, whichever returns more (roadMarket weighs both)
  {
    const ext = drain(planExtensions(hA, LA, 6)).filter((p) => pays(p) && p.sites[0] && !townsOf(g, LA).includes(p.sites[0].townId));
    for (const p of ext.slice(0, 1)) {
      const Z = g.towns.list[p.sites[0].townId], from = g.towns.list[(p.place === 'start' ? townsOf(g, LA)[0] : townsOf(g, LA)[townsOf(g, LA).length - 1])];
      const alt = Z && from ? drain(planCoach(hA, from, Z, coach)) : null;
      const pick = Z && from ? drain(roadMarket(hA, 'coach', [from.id, Z.id])) : null;
      const ret = (q: RoadPlan | null) => q && pays(q) ? (q.revenue - q.yearly) / Math.max(1, q.outlay) : 0;
      console.log(`  ${p.why}; new coaches ${from?.name} - ${Z?.name}: ${alt?.why ?? 'none'}; chosen: ${pick?.why ?? 'none'}`);
      check(!!pick && ret(pick) >= Math.max(ret(p), ret(alt)) - 1e-9 && (pick.kind === 'extend' || pick.kind === 'line' || pick.kind === 'join'), 'the coach market takes the better of extending the line and a new coach line');
    }
  }

  // ---------------------------------------------------------------- coaches call at the towns on the way
  {
    let tried = 0, calls = 0;
    for (const P of g.towns.list) for (const Q of g.towns.list) {
      if (P.id >= Q.id || tried >= 3) continue;
      const d = dist(P, Q);
      if (d < 90 || d > 240 || P.pop < 400 || Q.pop < 400) continue;
      const via = townsOnTheWay(g, P, Q, new Set([P.id, Q.id])).filter((t) => t.pop >= 400);
      if (!via.length) continue;
      tried++;
      const plan = drain(planCoach(hA, P, Q, coach));
      const stopsAt = plan?.towns.filter((t) => via.some((v) => v.id === t)) ?? [];
      if (stopsAt.length) calls++;
      console.log(`  ${P.name} - ${Q.name} (${via.map((v) => v.name).join(', ')} on the way): ${plan?.why ?? 'no plan'}`);
    }
    check(tried === 0 || calls > 0, 'coaches between towns call at a town on the way where it pays');
  }

  // ---------------------------------------------------------------- 4. a busy town bus line upgraded to trams, a quiet one not
  {
    // (a line through the busiest districts of the biggest town with a full fleet; and a short line in a small town)
    const towns = [...g.towns.list].sort((a, b) => b.pop - a.pop);
    const busyT = towns[0];
    const quietT = [...g.towns.list].filter((t) => t.pop >= 300 && t.pop < 1200).sort((a, b) => a.pop - b.pop)[0];
    const line = (T: Town, vehicles: number): Line | undefined => {
      const plan = drain(planTownLine(hA, T, pickBus(g.year, Math.max(T.pop, 1500))!));
      if (!plan) return undefined;
      const before = new Set(g.lines.map.keys());
      console.log('  ' + build(A, { ...plan, loop: false, vehicles, revenue: Infinity }));
      return [...g.lines.map.values()].find((l) => !before.has(l.id) && l.kind === 'road');
    };
    const busy = line(busyT, 5), quiet = quietT ? line(quietT, 2) : undefined;
    check(!!busy, `a bus line in ${busyT.name}`);
    days(g, 300);
    if (busy) {
      const plan = drain(tramUpgradeValue(hA, busy));
      console.log(`  ${busyT.name} (${busyT.pop}): ${plan?.why ?? 'no tram plan'}; load ${fmt(busy.vehicles.reduce((a, id) => a + (g.vehicles.get(id)?.load ?? 0), 0))} aboard, ${busy.passLast} riders last month`);
      check(!!plan && pays(plan), `trams pay on the busy line in ${busyT.name}`);
      if (plan && pays(plan)) {
        const id = busy.id, stops = [...busy.stops], name = busy.name;
        console.log('  ' + build(A, plan));
        const L = g.lines.get(id);
        check(!!L && L.id === id && L.kind === 'tram', `${name} runs trams now (${L?.name})`);
        check(!!L && L.stops.join() === stops.join(), 'the same stops');
        check(!!L && L.vehicles.length > 0 && L.vehicles.every((v) => g.vehicles.get(v)?.model?.kind === 'tram'), 'only trams on it');
        check(A.railLineInfo(id)?.kind === 'tram', "A manages it as a tram line");
        check(!!L && L.stops.every((sid) => g.stations.tramStops(g.stations.get(sid)!, A.companyId).length > 0), 'its stops are tram stops');
      }
    }
    if (quiet && quietT) {
      const plan = drain(tramUpgradeValue(hA, quiet));
      console.log(`  ${quietT.name} (${quietT.pop}): ${plan?.why ?? 'no tram plan'}`);
      check(!plan || !pays(plan), `no trams on the quiet line in ${quietT.name}`);
    }
    // the player's line window: the same upgrade, priced first
    const PT = towns.find((t) => t !== busyT && t.pop >= 1500);
    if (PT) {
      const pp = drain(planTownLine(hA, PT, pickBus(g.year, PT.pop)!));
      if (pp) {
        const ids = pp.sites.slice(0, 3).map((x) => { g.stations.commitBusStop(x.road?.x ?? x.x, x.road?.z ?? x.z, 0); return g.stations.findSharedStop(x.road?.x ?? x.x, x.road?.z ?? x.z, 0)?.id ?? -1; });
        if (ids.every((x) => x >= 0) && new Set(ids).size === ids.length) {
          const pl = g.lines.create('road', 0);
          pl.stops = outAndBack(ids);
          g.lines.rebuild();
          const up = planTramUpgrade(g, pl.id, 0);
          console.log(`  player's line ${pl.name}: ${up.ok ? `${fmt(up.trackLength * 10, 0)} m of track ${Math.round(up.trackCost / 1000)}k, depot ${Math.round(up.depotCost / 1000)}k, ${up.trams} trams, net ${Math.round(up.cost / 1000)}k` : up.error}`);
          check(up.ok && up.cost > 0, "the player's bus line has a priced tram upgrade");
          g.economy.money += up.cost + 1_000_000;
          const err = drain(buildTramUpgrade(g, up, 0));
          check(!err && g.lines.get(pl.id)?.kind === 'tram' && pl.vehicles.length === up.trams, `the player's line runs trams${err ? ': ' + err : ''}`);
        }
      }
    }
  }

  // ---------------------------------------------------------------- 5. no near-duplicate of a served pair, AIs on their own
  g.aiEnabled = true;
  for (let y = 0; y < 3; y++) days(g, 360);
  const road = [...g.lines.map.values()].filter((l) => l.kind === 'road' && l.vehicles.length);
  const dups: string[] = [];
  for (const a of road) for (const b of road) {
    if (a.id >= b.id || a.owner === b.owner) continue;
    const ta = townsOf(g, a), tb = townsOf(g, b);
    if (ta.filter((t) => tb.includes(t)).length < 2) continue;
    if (nearDuplicate(g, a, b)) {
      dups.push(`${a.name} / ${b.name}`);
      for (const ai of g.ais) for (const n of ai.log) if (ta.some((t) => n.includes(g.towns.list[t].name))) console.log(`   ${g.company(ai.companyId).name}: ${n}`);
    }
  }
  const partners = road.filter((l) => (l.operators?.length ?? 0) > 0).length;
  console.log(`  after 3 years: ${road.length} road lines (${partners} with partners), ${road.reduce((a, l) => a + l.vehicles.length, 0)} vehicles; near-duplicates ${dups.join(', ') || 'none'}`);
  check(!dups.length, 'no two companies run near-duplicate coach lines on one town pair');

  // ---------------------------------------------------------------- 6. exact replay after saving and loading
  const limit = g.tick + 720 * TICKS_PER_DAY;
  while (g.ais.some((a) => a.busy) && g.tick < limit) g.stepTick();
  check(!g.ais.some((a) => a.busy), 'AI projects finish before the save');
  const json = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(json));
  const again = JSON.stringify(serialize(loaded));
  if (json !== again) { let i = 0; while (i < json.length && json[i] === again[i]) i++; console.log(`  round trip differs at ${i}: ${json.slice(Math.max(0, i - 150), i + 80)}\n  loaded: ${again.slice(Math.max(0, i - 150), i + 80)}`); }
  check(json === again, 'exact round trip');
  let same = 0;
  for (; same < 150; same++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) { g.stepTick(); loaded.stepTick(); }
    const a = JSON.stringify(serialize(g)), b = JSON.stringify(serialize(loaded));
    if (a !== b) {
      let i = 0; while (i < a.length && a[i] === b[i]) i++;
      console.log(`  differs on day ${same + 1}: ${a.slice(Math.max(0, i - 120), i + 80)}\n  loaded: ${b.slice(Math.max(0, i - 120), i + 80)}`);
      break;
    }
  }
  check(same === 150, `150 daily saves identical after loading (${same})`);
  check(checkReservations(g).length === 0 && !checkNaN(g), 'consistent vehicles');
  const joined = g.ais.flatMap((ai) => ai.managedLines().map((id) => ai.railLineInfo(id)).filter((i) => i?.joined && i.kind === 'bus'));
  console.log(`  replayed with ${joined.length} joined road lines, ${g.ais.map((ai) => ai.stats.grown).join('/')} extensions`);
}

check(Number.isSafeInteger(seed), 'seed must be an integer');
const isMain = process.argv[1]?.includes('busnet');
if (isMain && Number.isSafeInteger(seed)) {
  try { run(); } catch (e) { check(false, `busnet exception: ${(e as Error).stack ?? e}`); }
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}
