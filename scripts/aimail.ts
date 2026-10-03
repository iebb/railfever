// Mail AI: natural 1950 games (two rail-focused AIs, six years, seeds 7/23), platform queues, annual reviews,
// van-safe passenger growth/cuts, and exact mid-run saves. Bundle as aimail.mjs and run there.
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { pickTrain, modelYearCost, type LineInfo } from '../src/game/ai';
import { forecastMailRevenue, projectMail, mailVans, type MailQueue } from '../src/game/ai-mail';
import { MODEL_BY_ID, carriesMail } from '../src/game/vehicle-types';
import { lineTable } from '../src/game/patterns';
import { railModeOf } from '../src/game/stations';
import { addMail } from '../src/game/mail';
import type { Line } from '../src/game/lines';
import { fails, check, fmt, placeAndConnect, depotBehind, Train, checkNaN, checkReservations } from './lib';

if (!process.argv[1]?.endsWith('aimail.mjs')) throw new Error('bundle this test as aimail.mjs');
const seeds = (process.argv[2] ?? '7,23').split(',').map(Number);
const YEARS = 6;
const saved = (g: Game) => JSON.stringify(serialize(g));
const seats = (t: Train) => t.cars.filter((m) => m.capacity > 0).length;
const vans = (t: Train) => mailVans(t).map((m) => m.id).sort();
const sameVans = (a: Train, before: string[]) => JSON.stringify(vans(a)) === JSON.stringify(before);
function identical(g: Game, loaded: Game, label: string): boolean {
  const a = saved(g), b = saved(loaded);
  if (a === b) return true;
  let at = 0; while (at < Math.min(a.length, b.length) && a[at] === b[at]) at++;
  check(false, `${label}: saves differ at character ${at}`);
  console.log(`  original ${a.slice(Math.max(0, at - 100), at + 160)}\n  loaded   ${b.slice(Math.max(0, at - 100), at + 160)}`);
  return false;
}

type Probe = {
  lines: Map<number, LineInfo>;
  relengthen: [number, number, string[]][];
  lengthenTrain(l: Line, info: LineInfo, trains: Train[], waiting: number): boolean;
  replaceTrains(): void;
};

function policyChecks() {
  console.log('mail policy: eligibility, forecasting, platform queues, growth, cuts and low loads');
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1950, aiCompanies: 2 });
  g.aiEnabled = false;
  const ai = g.ais[0], me = ai.companyId, probe = ai as unknown as Probe;
  g.company(me).economy.money = 100_000_000;
  const pr = placeAndConnect(g, 80, 160, me, new Set(), 1, () => {});
  check(!!pr, 'policy fixture: railway built');
  if (!pr) return;
  const depot = depotBehind(g, pr.A, pr.B, me), l = g.lines.create('rail', me);
  l.stops = [pr.A.id, pr.B.id];
  const t = g.vehicles.buyTrain(depot, pickTrain(1950, 16, 150, 2)!, l.id);
  check(t instanceof Train, `policy fixture: passenger train (${typeof t === 'string' ? t : t.id})`);
  if (!(t instanceof Train)) return;
  const info: LineInfo = { kind: 'rail', towns: [pr.TA.id, pr.TB.id], depot, maxVehicles: 2, opened: 0 };
  probe.lines.set(l.id, info);
  g.lines.rebuild(); g.lines.flushCatchment(); g.stations.refreshAccess(true);
  g.day = 179;
  // Known catchment sizes isolate the economics/decision boundaries from the site selector.
  for (const st of [pr.A, pr.B]) st.catchPop = 3000;
  const table = lineTable(g, l), headway = 1 / table.pats.reduce((s, p) => s + p.freq, 0);
  const points = [pr.A, pr.B], cars = t.madeUp;
  const preview = forecastMailRevenue(g, points, t.maxSpeedKmh * 0.6, headway, 60, l);
  check(preview > 1.5 * (modelYearCost(MODEL_BY_ID.get('van_steel')!, g.year) + 95_000 / 8), `real mail model gives a paying forecast (${fmt(preview / 1000)}k/year)`);
  check(g.mail.toJSON() === null && points.every((st) => !st.mail), 'forecasting creates no mail state and consumes no mail randomness');
  const opening = projectMail(g, points, cars, 1, t.maxSpeedKmh * 0.6, headway, 16);
  check(opening.revenue > 0 && opening.cars.filter(carriesMail).length === 1, 'a paying main-line project opens with one van');
  const steam = ['steam_b', 'coach_steel', 'coach_steel'].map((id) => MODEL_BY_ID.get(id)!);
  check(projectMail(g, points, steam, 1, 70, headway, 10).cars.filter(carriesMail).length === 1,
    'a 9.7-unit steam consist with its van fits a 10-unit platform');
  check(projectMail(g, points, cars, 1, t.maxSpeedKmh * 0.6, headway, t.length + 0.4).revenue === 0, 'a project needs platform room for its van');
  check(projectMail(g, points, [MODEL_BY_ID.get('hsr_a')!], 1, 150, headway, 16).revenue === 0, 'HSR units get no mail project bonus or vans');
  check(projectMail(g, points, cars, 1, t.maxSpeedKmh * 0.6, headway, 16).yearly === modelYearCost(MODEL_BY_ID.get('van_steel')!, g.year), 'project accounts include van operating costs');
  const expensive = projectMail(g, points, cars, 100, t.maxSpeedKmh * 0.6, headway, 16);
  check(expensive.revenue > 0 && !expensive.cars.some(carriesMail) && expensive.price === 0,
    'project evaluation includes potential mail, while opening vans still require the purchase margin');

  ai.mailPolicy.manage(l, info);
  check(!ai.mailPolicy.mailQueue.length && info.mailLook === undefined, 'no existing-line review before 180 days');
  g.day = 180;
  for (const type of ['urban', 'hsr', 'track', 'foreign'] as const) {
    const owner = l.owner, track = pr.A.rail!.trackType;
    if (type === 'urban') info.urban = 'metro';
    if (type === 'hsr') info.hsr = true;
    if (type === 'track') pr.A.rail!.trackType = 'lightrail';
    if (type === 'foreign') l.owner = 0;
    ai.mailPolicy.manage(l, info);
    check(!ai.mailPolicy.mailQueue.length && info.mailLook === undefined, `${type}: excluded from mail reviews`);
    if (type === 'track') check(projectMail(g, points, cars, 1, 70, headway, 16).revenue === 0, 'city-style track gets no mail project bonus');
    delete info.urban; delete info.hsr; l.owner = owner; pr.A.rail!.trackType = track;
  }
  const length = pr.A.rail!.length;
  pr.A.rail!.length = t.length + 0.4;
  ai.mailPolicy.manage(l, info);
  check(!ai.mailPolicy.mailQueue.length && info.mailLook === 180, 'short platforms reject an addition and save the review day');
  pr.A.rail!.length = length;
  ai.mailPolicy.manage(l, info);
  check(!ai.mailPolicy.mailQueue.length, 'a failed review is not repeated within 360 days');
  // Start a fresh review to exercise the success branch independently of the short-platform trial.
  delete info.mailLook;
  ai.mailPolicy.manage(l, info);
  check(ai.mailPolicy.mailQueue.length === 1 && !t.mailCapacity, 'one van queued for the next platform stop');
  check(probe.lengthenTrain(l, info, [t], t.capacity * 5) && !probe.relengthen.length,
    'passenger growth waits for pending mail changes to reserve their platform room');
  const queue: MailQueue = ai.mailPolicy.mailQueue.map(([id, models]) => [id, [...models]]);
  const data = saved(g), loaded = deserialize(JSON.parse(data));
  check(identical(g, loaded, 'pending mail queue round trip'), 'pending queue save round-trips exactly');
  check(JSON.stringify(loaded.ais[0].mailPolicy.mailQueue) === JSON.stringify(queue), 'mail targets restored');
  let matched = true, fitted = false;
  for (let k = 0; k < 300 * TICKS_PER_DAY && !t.mailCapacity; k++) {
    g.stepTick(); loaded.stepTick(); ai.mailPolicy.step(); loaded.ais[0].mailPolicy.step();
    if (t.mailCapacity) fitted = t.state === 'loading';
    if (g.tick % TICKS_PER_DAY === 0 && matched) matched = identical(g, loaded, 'queued van replay');
  }
  check(t.mailCapacity === 60 && fitted && !ai.mailPolicy.mailQueue.length, 'the van is recomposed at a platform');
  check(matched && identical(g, loaded, 'after queued van fitting'), 'queued recomposition replays identically');
  if (!t.mailCapacity) return;

  g.day = (info.mailLook ?? g.day) + 360;
  for (const st of points) {
    st.catchPop = 3000;
    const other = points.find((s) => s.id !== st.id)!;
    addMail(g, st, l.id, other.id, other.id, 100);
  }
  ai.mailPolicy.mailLoads.set(t.id, { capacity: t.mailCapacity, lowSince: g.day });
  ai.mailPolicy.manage(l, info);
  check(ai.mailPolicy.mailQueue[0]?.[1].length === 2, 'a profitable backlog above 1.5 van capacities queues a second van');
  for (let k = 0; k < 300 * TICKS_PER_DAY && t.mailCapacity < 120; k++) { g.stepTick(); ai.mailPolicy.step(); }
  check(t.mailCapacity === 120 && mailVans(t).length === 2, 'second van fitted, never a third');
  if (mailVans(t).length !== 2) return;
  const before = vans(t), n = seats(t);
  const grew = probe.lengthenTrain(l, info, [t], t.capacity * 5);
  check(grew && probe.relengthen.some(([id, , ids]) => id === t.id && ids.filter((id) => carriesMail(MODEL_BY_ID.get(id)!)).length === 2), 'lengthening reserves room for and queues both vans');
  // Old saves can have passenger-only replacement targets: the current vans still win at replacement time.
  for (const q of probe.relengthen) q[2] = q[2].filter((id) => !carriesMail(MODEL_BY_ID.get(id)!));
  let historyKept = false;
  for (let k = 0; k < 300 * TICKS_PER_DAY && g.vehicles.get(t.id); k++) {
    g.stepTick(); ai.mailPolicy.step();
    const before = ai.mailPolicy.mailLoads.get(t.id)?.lowSince;
    probe.replaceTrains();
    if (!g.vehicles.get(t.id)) {
      const newId = l.vehicles.find((id) => id !== t.id)!;
      historyKept = ai.mailPolicy.mailLoads.get(newId)?.lowSince === before;
    }
  }
  const nt = l.vehicles.map((id) => g.vehicles.get(id)).find((v): v is Train => v instanceof Train);
  check(!!nt && nt.id !== t.id && seats(nt) > n && sameVans(nt, before), 'replacement grows passenger capacity and retains both vans, including old saved targets');
  check(historyKept, 'van usage history survives train replacement');
  if (!nt) return;
  // A non-canonical consist with vans last reproduces the original last-wagon regression directly.
  nt.cars = [...nt.madeUp.filter((m) => !carriesMail(m)), ...mailVans(nt)];
  nt.load = 0; nt.cargo.clear();
  const account = ai.railPolicy.account(l), oldSeats = seats(nt);
  Object.assign(account, { lossYears: 1, lastProfit: -100_000, profit: -100_000, step: 0, lastCut: g.day - 360, occupancy: 0 });
  ai.railPolicy.review(l);
  check(seats(nt) === oldSeats - 1 && sameVans(nt, before), 'rail cuts remove a passenger coach when the last wagon is a van');
  check(seats(nt) >= 1, 'cuts preserve a passenger service');
  account.step = 0; account.lossYears = 0; account.lastProfit = 0; account.profit = 0;
  nt.mailCargo.clear(); nt.mailLoad = 0;
  ai.mailPolicy.mailLoads.set(nt.id, { capacity: nt.mailCapacity, lowSince: g.day - 359 });
  nt.mailLoad = nt.mailCapacity / 2;
  ai.mailPolicy.step(); nt.mailLoad = 0;
  check(ai.mailPolicy.mailLoads.get(nt.id)?.lowSince === g.day - 359, 'a full first van does not hide an unused second van');
  delete info.mailLook;
  ai.mailPolicy.manage(l, info);
  check(!ai.mailPolicy.mailQueue.length, 'underloaded vans get a full year before removal');
  ai.mailPolicy.mailLoads.get(nt.id)!.lowSince = g.day - 360;
  info.mailLook = g.day - 360;
  ai.mailPolicy.manage(l, info);
  check(ai.mailPolicy.mailQueue[0]?.[1].length === 1, 'a continuous year below 10% queues one van for removal');
  check(!nt.onMap, 'underuse fixture: replacement train still in its depot');
  ai.mailPolicy.step();
  check(mailVans(nt).length === 1 && !nt.onMap, 'an idle van can be removed without waiting for a train to leave its depot');
  for (let k = 0; k < 300 * TICKS_PER_DAY && mailVans(nt).length === 2; k++) { g.stepTick(); ai.mailPolicy.step(); }
  check(mailVans(nt).length === 1, 'underloaded van removed through recomposition');
  nt.mailLoad = Math.ceil(nt.mailCapacity * 0.1);
  ai.mailPolicy.step(); nt.mailLoad = 0;
  check(ai.mailPolicy.mailLoads.get(nt.id)?.lowSince === g.day, 'a useful load resets the underuse clock');
  check(!checkNaN(g) && checkReservations(g).length === 0, 'policy fixture has finite positions and consistent reservations');
}

function naturalRun(seed: number) {
  const start = performance.now();
  // The rail preference used by airail: normal capital, risk, work budgets and project profitability checks.
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1950,
    aiConfigs: Array.from({ length: 2 }, () => ({ focus: { rail: 2.5, road: 1.2, tram: 0.5 } })) });
  g.aiAcquisitions = false;
  let replay: Game | null = null, replayDay = -1, matched = true;
  let mailLines = new Set<number>(), badLine = false, tooMany = false, vanished = false;
  const previous = new Map<number, string[]>();
  let costs = 0, capital = 0, maxVans = 0, openedWithVans = 0;
  const known = new Set<number>();
  for (let day = 0; day < YEARS * 360; day++) {
    // In-flight construction jobs are abandoned on load. Hold off new projects briefly to choose an idle save.
    if (!replay && g.day >= YEARS * 180) for (const ai of g.ais) ai.state.cooldown = Math.max(ai.state.cooldown, 2);
    for (let k = 0; k < TICKS_PER_DAY; k++) { g.stepTick(); replay?.stepTick(); }
    for (const t of g.vehicles.trains()) {
      if (t.owner <= 0) continue;
      const count = mailVans(t).length, l = t.line, ai = g.ais.find((a) => a.companyId === t.owner)!;
      const info = l && ai.railLineInfo(l.id);
      if (!known.has(t.id)) { known.add(t.id); if (count && info && g.day - info.opened < 180) openedWithVans++; }
      maxVans = Math.max(maxVans, count); tooMany ||= count > 2;
      if (count && l) {
        mailLines.add(l.id);
        badLine ||= !!info?.urban || !!info?.hsr || l.kind !== 'rail' || !t.cars.some((m) => m.kind === 'loco')
          || l.stops.some((id) => { const r = g.stations.get(id)?.rail; return !r || railModeOf(r.trackType) !== 'mainline' || r.trackType === 'highspeed'; });
      }
      const old = previous.get(t.id);
      if (old && old.length > count && !ai.log.some((s) => s.includes(`mail van`) && s.includes(t.name))) vanished = true;
      previous.set(t.id, vans(t));
      costs += mailVans(t).reduce((s, m) => s + modelYearCost(m, g.year), 0) / 360;
      capital += mailVans(t).reduce((s, m) => s + m.cost / 8, 0) / 360;
    }
    if (replay && matched) matched = identical(g, replay, `seed ${seed}, replay day ${g.day}`);
    if (!replay && g.day >= YEARS * 180 && g.ais.every((ai) => !ai.busy)) {
      const data = saved(g); replay = deserialize(JSON.parse(data)); replayDay = g.day;
      matched = identical(g, replay, `seed ${seed}, mid-run round trip`);
    }
    if (g.day % 360 === 0) console.log(`seed ${seed}: year ${g.day / 360}/${YEARS}, AI rail lines ${g.lines.all().filter((l) => l.kind === 'rail' && l.owner > 0).length}, mail lines ${mailLines.size}, max ${maxVans} vans/train`);
  }
  const income = g.companies.filter((c) => c.ai).reduce((s, c) => s + c.economy.yearTotals.reduce((s, y) => s + y.v.mailIncome, 0) + c.economy.thisYear.mailIncome, 0);
  if (!mailLines.size) for (const ai of g.ais) console.log(`  ${g.company(ai.companyId).name}: ${ai.log.join('\n  ')}`);
  check(mailLines.size > 0, `seed ${seed}: at least one AI line gets vans`);
  check(openedWithVans > 0, `seed ${seed}: a profitable new rail project opens with vans`);
  check(!badLine, `seed ${seed}: no vans on city-style or HSR lines`);
  check(!tooMany && !vanished, `seed ${seed}: at most two vans, none lost to passenger cuts`);
  check(income > costs + capital, `seed ${seed}: mail income ${fmt(income / 1000)}k exceeds van operating costs and price/8 ${fmt((costs + capital) / 1000)}k`);
  check(replayDay >= YEARS * 180 && replayDay < (YEARS - 1) * 360 && matched, `seed ${seed}: mid-run save replays exactly through year six (saved day ${replayDay})`);
  check(g.ais.every((ai) => !ai.log.some((s) => /error:|network work.*failed/.test(s))), `seed ${seed}: no AI errors`);
  check(!checkNaN(g) && checkReservations(g).length === 0, `seed ${seed}: finite positions and consistent reservations`);
  console.log(`seed ${seed}: mail ${fmt(income / 1000)}k, van operation ${fmt(costs / 1000)}k (plus price/8 ${fmt(capital / 1000)}k), ${openedWithVans} opening trains; saved day ${replayDay}, ${g.day - replayDay} identical replay days; ${fmt((performance.now() - start) / 1000)}s`);
}

policyChecks();
for (const seed of seeds) naturalRun(seed);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
