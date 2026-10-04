// Independent regressions for all nine findings at 2cfdae3. Run linegrow-fixes.mjs [1..9].
import { flat, newTown, district, cityLine, mainCityLine, presholm, runDays, linePath, M, stat } from './linegrow-fixtures';
import { growTask, growLine, terminusOf, outerEnd, planTerminusYard, buildTerminusYard, moveDepotHome, type GrowHost, type GrowCursor, type GrowOption } from '../src/game/ai-grow';
import { Train, depotReaches } from '../src/game/train';
import { addPattern, setVehiclePattern, linePatterns } from '../src/game/patterns';
import { buildDepotOnLine } from '../src/game/routing';
import { outAndBack, type Line } from '../src/game/lines';
import { stopsWithInserted } from '../src/game/line-edit';
import { addStopToLine } from '../src/ui/win-lines';
import { serialize, deserialize } from '../src/game/save';
import type { Game } from '../src/game/game';
import type { AIController } from '../src/game/ai';
import { check, fails, checkReservations } from './lib';

const selected = process.argv.slice(2);
const want = (n: number) => !selected.length || selected.includes(String(n));
const ext: GrowOption = { kind: 'ext', end: 1, n: 3, turn: 0, level: 'ground', pop: 4500 };
const fixture = () => presholm('west', 'tail', 3, 4500);
const generous = (g: Game) => { g.demand.forecastLine = (points) => ({ revenue: points.length > 5 ? 30_000_000 : 500_000, boardings: 1000, covered: 10000, transfers: 0 }); };

// The same host contract used by the saved network planner, with funding and target remapping kept explicit.
function host(g: Game, ai: AIController): GrowHost {
  const me = ai.companyId, eco = g.company(me).economy;
  return {
    g, ai, me, note: (s) => ai.log.push(s), news() {}, considered() {}, succeed() {}, cared: () => false, careFor() {},
    stat: (key, n = 1) => { (ai.stats as any)[key] = ((ai.stats as any)[key] ?? 0) + n; },
    canSpend: (cost) => { while (eco.money < cost + 300_000 && eco.borrow()) {} return eco.money >= cost; },
    affordable: (cost) => cost <= ai.available(),
    managed: () => (ai as any).lines,
    fleet: (l) => ({ ours: l.vehicles.filter((id) => g.vehicles.get(id)?.owner === me), others: l.vehicles.filter((id) => g.vehicles.get(id)?.owner !== me).length }),
    setStops: (l, stops) => {
      const old = [...l.stops];
      for (const id of l.vehicles) {
        const v = g.vehicles.get(id)!;
        const station = old[v.stopIndex], occurrence = old.slice(0, v.stopIndex).filter((s) => s === station).length;
        const indexes = stops.flatMap((s, i) => s === station ? [i] : []);
        v.stopIndex = indexes[Math.min(occurrence, indexes.length - 1)] ?? 0;
      }
      l.stops = stops; g.lines.rebuild();
      for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged();
    },
    signal: () => 0, canon() {}, mayAlter: () => true, consent: () => true, demolitionOk: () => true,
    compensate: (ids) => { for (const id of ids) { const b = g.world.buildings.get(id); if (b) eco.spend(3000 + b.pop * 1250, 'construction', true); } },
    localOnly: (l, sid) => { for (const p of linePatterns(l)) if (p.kind !== 'local') l.stops.forEach((s, i) => { if (s === sid) p.stops[i] = false; }); },
  };
}
type Item = { ids: number[]; grow?: GrowCursor };
const itemFor = (l: Line, option = ext): Item => ({ ids: [l.id], grow: { at: 1, opts: [{ ...option }] } });
const step = (h: GrowHost, item: Item) => { const gen = growTask(h, item); while (!gen.next().done) {} };
const finish = (h: GrowHost, item: Item) => { for (let i = 0; item.grow && i < 50; i++) step(h, item); check(!item.grow, 'growth work finishes'); };

if (want(1)) {
  for (const legacyMoved of [false, true]) {
    const { g, ai, line, depot } = presholm('east', 'old', 2, 4500);
    generous(g);
    const h = host(g, ai), item = itemFor(line), oldPath = linePath(line);
    const spare = g.vehicles.buyTrain(depot, [M('lrv_b')], null) as Train;
    const construction = g.company(ai.companyId).economy.thisYear.construction;
    for (let i = 0; item.grow && item.grow.at < 4 && i < 30; i++) step(h, item);
    const build = item.grow?.made;
    check(!!build?.links.length, '1: fault injection reaches the last build boundary');
    if (build) {
      // A saved cursor from 2cfdae3 may already have relocated. Exercise its protected recovery path too.
      if (legacyMoved && !build.moved) {
        const last = g.stations.get(build.stations.at(-1)!)!, before = g.stations.get(build.stations.at(-2)!)!;
        const yard = planTerminusYard(g, ai.companyId, last, outerEnd(last, before), null, () => true);
        const next = yard ? buildTerminusYard(g, ai.companyId, yard, () => true) : -1;
        check(next >= 0 && !moveDepotHome(g, depot, next), '1: legacy cursor fixture relocates its depot');
        for (const id of build.spur) if (g.world.net.edges.has(id)) g.world.net.removeEdge(id);
        build.moved = true; g.onNetworkChanged();
      }
      const charged = g.company(ai.companyId).economy.thisYear.construction;
      // In a legacy cursor an invalid station reference must not destroy the remaining usable infrastructure.
      // The normal cursor exercises actual platform removal before the atomic final step.
      if (legacyMoved) build.stations.push(-1);
      else check(!g.stations.removeStation(build.stations[0]), '1: unused extension station removed between work units');
      finish(h, item);
      const dp = g.depots.get(spare.depotId);
      check(!!dp && oldPath.some((sid) => depotReaches(g, dp, sid, spare.cars)), '1: final validation failure preserves the homed train route');
      check(spare.depotId !== depot || Math.abs(g.company(ai.companyId).economy.thisYear.construction - construction) < .01, '1: rollback refunds exactly the removed works');
      if (legacyMoved) check(charged === g.company(ai.companyId).economy.thisYear.construction, '1: retained legacy depot and recovery tracks are not refunded');
      spare.setLine(line.id); runDays(g, 40);
      check(spare.state !== 'noroute', '1: spare can run the old route after failed extension');
      check(checkReservations(g).length === 0, '1: rollback reservations consistent');
    }
  }
}

if (want(2)) {
  const { g, ai, line } = fixture(), before = [...line.stops], n = line.vehicles.length;
  const forecasts: { stops: number; headway: number }[] = [];
  g.demand.forecastLine = (points, _mode, _kmh, headway) => {
    forecasts.push({ stops: points.length, headway });
    return { revenue: 1e10 / headway * (1 + .05 * (points.length - 5)), boardings: 1000, covered: 10000, transfers: 0 };
  };
  const h = host(g, ai), item = itemFor(line);
  finish(h, item);
  const old = forecasts.filter((f) => f.stops === 5), extended = forecasts.filter((f) => f.stops === 8);
  check(old.length > 1 && Math.min(...old.map((f) => f.headway)) < Math.max(...old.map((f) => f.headway)) * .8, '2: fleet-only forecast includes its improved frequency');
  check(extended.length > 0 && Math.min(...old.map((f) => f.headway)) < extended[0].headway, '2: each alternative uses its own cycle and headway');
  check(line.stops.join() === before.join() && line.vehicles.length > n, '2: higher-scoring fleet-only investment wins without extension construction');
}

if (want(3)) {
  for (const income of [0, 1]) {
    const { g, ai, line, t } = fixture(); generous(g);
    g.day = 720; (ai as any).lines.get(line.id).opened = 0; line.incomeLast = income;
    const h = host(g, ai), before = line.stops.join(), money = g.company(ai.companyId).economy.money;
    finish(h, itemFor(line));
    district(g, t, 342, 414, 256, 64, 4500); g.day += 360; line.incomeLast = income;
    finish(h, itemFor(line));
    check(line.stops.join() === before && g.company(ai.companyId).economy.money === money, `3: measured passenger receipts ${income} do not fund successive optimistic extensions`);
    const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
    check(JSON.stringify(serialize(loaded)) === saved, '3: forecast/receipt observation round-trips exactly');
    check(Object.values(line.growth ?? {}).some((p: any) => p.expected > 0 && p.receipts === 0 && p.rate <= income / 500_000), '3: a measured zero period is saved separately from a missing observation');
  }
  const { g, ai, line } = fixture();
  let annual = 1_000_000;
  g.demand.forecastLine = (points) => ({ revenue: points.length > 5 ? 30_000_000 : annual, boardings: 1000, covered: 10000, transfers: 0 });
  const h = host(g, ai);
  step(h, itemFor(line));
  const period = Object.values(line.growth ?? {})[0];
  check(period?.rate === .5, '3: missing observation has a conservative prior');
  if (period) {
    period.counter += 100_000; g.day += 180; annual = 9_000_000;
    step(h, itemFor(line));
    check(Math.abs(period.expected - 500_000) < .01 && period.receipts === 100_000, '3: receipts calibrate against the saved period forecast, not today\'s changed forecast');
    const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
    check(JSON.stringify(serialize(loaded)) === saved, '3: calibrated evidence survives save/load');
    runDays(g, 30); runDays(loaded, 30);
    check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), '3: collecting passenger receipts replays exactly');
  }
  const young = fixture(); generous(young.g);
  const yh = host(young.g, young.ai);
  step(yh, itemFor(young.line));
  young.g.day += 360;
  step(yh, itemFor(young.line));
  check(Object.values(young.line.growth ?? {}).some((p) => p.days === 360 && p.rate === 0), '3: a full measured zero year removes the young-service prior entirely');
}

if (want(4)) {
  for (const fault of ['disconnected', 'unwired']) {
    const { g, ai, me } = flat(), town = newTown(g, 'Gapford', 220, 256);
    district(g, town, 150, 195, 256, 64, 3500); district(g, town, 246, 296, 256, 64, 3500);
    const { line, sts, depot } = cityLine(g, me, [158, 183, 258, 283], 256, 'west', 'tail', 3);
    runDays(g, 30); district(g, town, 195, 246, 256, 64, 5000); runDays(g, 5);
    const end = terminusOf(g, sts[0], outerEnd(sts[0], sts[1]), me)!;
    for (const id of end.lead) {
      check(!g.vehicles.isEdgeBusy(id), '4: faulty spur is unused');
      if (fault === 'disconnected') g.world.net.removeEdge(id);
      else g.world.net.edges.get(id)!.type = 'standard';
    }
    g.onNetworkChanged(); g.lines.rebuild();
    check(!line.stops.some((sid) => depotReaches(g, g.depots.get(depot)!, sid, [M('lrv_b')])), `4: ${fault} depot cannot serve the actual consist`);
    if (fault === 'unwired') check(line.stops.some((sid) => depotReaches(g, g.depots.get(depot)!, sid)), '4: unwired depot has a topological route');
    g.demand.forecastLine = (points) => ({ revenue: points.length > 4 ? 30_000_000 : 500_000, boardings: 1000, covered: 10000, transfers: 0 });
    const n = line.vehicles.length, h = host(g, ai);
    let purchaseFunding = 0;
    const fund = h.canSpend;
    h.canSpend = (cost, share) => { if (Math.abs(cost - M('lrv_b').cost * 1.1) < .01) purchaseFunding++; return fund(cost, share); };
    finish(h, itemFor(line, { kind: 'fill', a: sts[1].id, b: sts[2].id, x: 221, z: 256, pop: 5000 }));
    check(stat(ai, 'netGrowInfill') === 1, '4: fixture builds its infill stop');
    check(line.vehicles.length === n && purchaseFunding === 0, `4: ${fault} infill depot buys and borrows for no train`);
  }
}

if (want(5)) {
  const { g, ai, me, line, sts } = presholm('west', 'tail', 3, 4500, 2); generous(g);
  const short = addPattern(g, line.id, 'local', line.stops.map((sid) => sts.slice(0, 3).some((s) => s.id === sid)), 'Short')!;
  const old = new Set(line.vehicles), oldPath = linePath(line);
  for (const id of old) check(!setVehiclePattern(g, id, short.id), '5: own fleet runs the short pattern');
  const partner = g.ais[1].companyId; sts[1].owner = partner;
  check(!g.lines.join(line.id, partner), '5: partner joins the route');
  let depot = -1;
  for (const e of [...g.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === me && e.station < 0 && e.depot < 0 && e.len > 8).sort((a, b) => a.id - b.id)) { depot = buildDepotOnLine(g, e.id, e.len / 2, partner); if (depot >= 0) break; }
  check(depot >= 0 && g.vehicles.buyTrain(depot, [M('lrv_b')], line.id) instanceof Train, '5: partner runs the affected all-stops pattern');
  runDays(g, 20);
  finish(host(g, ai), itemFor(line));
  const added = linePath(line).filter((sid) => !oldPath.includes(sid));
  const bought = line.vehicles.map((id) => g.vehicles.get(id) as Train).filter((v) => v.owner === me && !old.has(v.id));
  check(added.length > 0 && bought.length > 0, '5: shared short-turn fixture extends and buys an affected fleet');
  check(bought.every((v) => { const p = linePatterns(line).find((p) => p.id === v.pattern) ?? linePatterns(line)[0]; return added.every((sid) => line.stops.some((s, i) => s === sid && p.stops[i] !== false)); }), '5: every extension purchase serves all new stops');
  check(linePatterns(line).find((p) => p.id === short.id)!.stops.every((serves, i) => !added.includes(line.stops[i]) || !serves), '5: original short-turn remains unchanged');
}

if (want(6)) {
  const { g, me } = flat(); g.economy.money = 100_000_000; newTown(g, 'Player', 220, 256);
  const { line, sts, depot } = cityLine(g, 0, [158, 228, 253], 256, 'west', 'tail', 1);
  const sid = g.stations.nextId, plan = g.stations.planRail(278, 256, Math.PI / 2, 7, 2, 0, { trackType: 'lightrail', style: 'none' });
  check(plan.ok && !g.stations.commitRail(plan, 0), '6: player builds a new terminus');
  const partner = g.vehicles.buyTrain(depot, [M('lrv_b')], line.id) as Train; partner.owner = me;
  const through = g.vehicles.buyTrain(depot, [M('lrv_b')], line.id) as Train;
  g.lines.redirect.set(999, { line: line.id, pattern: 0 }); through.setLine(999);
  runDays(g, 8);
  const fleet = line.vehicles.map((id) => g.vehicles.get(id)!);
  for (const v of fleet) { v.stopIndex = 3; v.spacing.departureIndex = 3; }
  const ui = { game: g, toast() {}, sound() {}, hud: { onToolChange() {} }, wm: { get() { return null; } } } as any;
  addStopToLine(ui, line.id, sid);
  check(fleet.every((v) => line.stops[v.stopIndex] === sts[1].id && v.stopIndex === 5), '6: player, partner and through vehicles retain the return occurrence destination');
  check(fleet.every((v) => v.spacing.departureIndex === 5 || v.spacing.departureIndex === -1), '6: pending departures remap or reset safely');
}

if (want(7)) {
  const { g } = flat(); newTown(g, 'Player', 220, 256); g.economy.money = 100_000_000;
  const { line, sts } = cityLine(g, 0, [158, 228, 253], 256, 'west', 'tail', 0);
  const A = sts[0].id, B = sts[1].id, C = sts[2].id, S = 1001, T = 1002;
  line.loop = false;
  const first = stopsWithInserted(g, line, S, 3)!;
  check(first.stops.join() === outAndBack([A, S, B, C]).join() && first.at === 5, '7: clicked return B keeps its directed B-to-A gap and returns the inserted occurrence');
  line.stops = first.stops;
  const next = stopsWithInserted(g, line, T, first.at)!;
  check(next.stops.join() === outAndBack([A, T, S, B, C]).join() && next.at === 7, '7: consecutive return insertions keep their direction');
  line.stops = [A, B, C, B]; line.loop = true;
  check(stopsWithInserted(g, line, S, 'end')!.stops.join() === [A, B, C, B, S].join(), '7: explicit loop preserves its complete ordered stop list');
}

if (want(8)) {
  const { g, ai, me } = flat(), a = newTown(g, 'West City', 100, 256), b = newTown(g, 'East City', 325, 256);
  district(g, a, 50, 150, 256, 64, 9000); district(g, b, 266, 394, 256, 64, 18000);
  const { line } = mainCityLine(g, me, [70, 125, 270, 325, 380], 256, 'west', 'tail', 3);
  generous(g); const h = host(g, ai), before = [...line.stops], n = line.vehicles.length;
  check(!growLine(h, line), '8: intercity diesel/IC route is ineligible for city growth');
  finish(h, itemFor(line));
  check(line.stops.join() === before.join() && line.vehicles.length === n, '8: city task preserves intercity behavior');
}

if (want(9)) {
  const { g, ai, me, line } = fixture(); generous(g);
  const h = host(g, ai), item = itemFor(line), eco = g.company(me).economy;
  eco.money = 1_000_000; eco.loan = 0; eco.maxLoan = 25_000_000;
  const construction = eco.thisYear.construction, cash = eco.money;
  step(h, item); step(h, item);
  const build = item.grow?.made;
  check(eco.loan > 0 && !!build, '9: fixture borrows for its first construction step');
  check(!!build && Math.abs(build.spent - (construction - eco.thisYear.construction)) < .01, '9: saved construction debit excludes borrowed cash');
  if (build) {
    g.stations.planRail = (() => ({ ok: false, error: 'regression failure injection' })) as any;
    finish(h, item);
    check(Math.abs(eco.thisYear.construction - construction) < .01 && Math.abs(eco.money - eco.loan - cash) < .01, '9: borrowed rollback restores construction and cash net of debt');
  }
}

console.log(fails.length ? `${fails.length} FAILURES` : 'ALL NINE REGRESSIONS PASSED');
process.exitCode = fails.length ? 1 : 0;
