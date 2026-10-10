// Save/load round trip: serialize -> JSON -> deserialize mid-simulation (player lines + AI companies, mail vans,
// a mail train and a postbus), then continue both copies and check they stay consistent.
// npx esbuild scripts/save.ts --bundle --platform=node --format=esm --outfile=$S/save.mjs && node $S/save.mjs [seed]
import { gzipSync } from 'node:zlib';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { networkPlanner, runNetworkTask } from '../src/game/ai-network';
import { distanceFare, speedFactor, fareFor, simNow, transferFareFactor, FARE_LEVEL, TRANSFER_FARE_FACTOR } from '../src/game/fares';
import { RAIL_FARE } from '../src/game/constants';
import { fareFixture, fareTrain } from './fares';
import { fails, check, fmt, connectStations, depotBehind, placeStationPair, placeAndConnect, busStopSites, addBusStop, roadDepotNear, checkReservations, checkNaN, Train } from './lib';

// Line/pattern edits may converge drop-offs, including groups with the same history but different clocks.
{
  console.log('converged cargo fare histories and group identity after a line edit');
  const { g, ids, stations } = fareFixture(), { t, l } = fareTrain(g, [ids[0], ids[2], ids[3], ids[1]]);
  const now = simNow(g);
  // (below the minimum, as offsets from it: the minimum rose to 550 with the 2.7 recalibration, and earlier fares of
  // 200 and 300 left nothing to pay on this leg)
  const histories = [RAIL_FARE.minimum - 300, RAIL_FARE.minimum - 200, RAIL_FARE.minimum - 200];
  histories.forEach((rail, i) => t.cargo.set('converged' + i,
    { from: ids[0], alight: i === 0 ? ids[2] : ids[3], dest: ids[1], count: 1, day: g.day - i, t0: now - 40 - i * 10, transfers: 1, rail }));
  t.load = 3; l.stops = [ids[0], ids[1]]; t.stopIndex = 1; t.fixCargo(); g.lines.rebuild();
  const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data)), lt = loaded.vehicles.get(t.id) as Train;
  check(JSON.stringify(serialize(loaded)) === data, 'converged cargo save round trip is byte-identical');
  check(JSON.stringify([...lt.cargo]) === JSON.stringify([...t.cargo]), 'converged cargo retains keys, order and every group field');
  const before = t.incomeYear, restoredBefore = lt.incomeYear;
  t.serveStation(stations[1], 0); lt.serveStation(loaded.stations.get(ids[1])!, 0);
  const live = t.incomeYear - before, restored = lt.incomeYear - restoredBefore;
  console.log(`  receipts: live ${live}, loaded ${restored}`);
  // (each changed vehicles once before: x0.9)
  const expected = histories.reduce((sum, railBefore, i) => sum + fareFor(12, 40 + i * 10, 1, { mode: 'rail', railBefore }) * TRANSFER_FARE_FACTOR, 0);
  check(expected > 0 && Math.abs(live - expected) < 1e-8 && live === restored, 'loading preserves receipts when cargo drop-offs converge');
  check(JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)), 'converged cargo settles identically after loading');
}
// Released 2.6 saves have no cohort identities; an already averaged history remains one coherent legacy cohort.
{
  const { g, ids, stations } = fareFixture(), { t, l } = fareTrain(g, [ids[0], ids[1]]), now = simNow(g);
  g.lines.rebuild();
  g.stations.addWaiting(stations[0], l.id, ids[1], ids[1], 4, 0, now - 80, 2, 600);
  t.cargo.set('legacy', { from: ids[0], alight: ids[1], dest: ids[1], count: 2, day: g.day, t0: now - 40, transfers: 1, rail: 600 });
  t.load = 2;
  const data = JSON.parse(JSON.stringify(serialize(g))); data.game = '2.6';
  // addWaiting already caps live histories; put the uncapped value back into the actual legacy payload.
  data.stations.find((s: any) => s.id === ids[0]).waiting[0].rail = 600;
  const loaded = deserialize(data), lt = loaded.vehicles.get(t.id) as Train;
  check(lt.load === 2 && lt.cargo.size === 1 && [...lt.cargo.values()][0].rail === RAIL_FARE.minimum, 'legacy merged cargo loads with its capped history and count');
  const w = [...loaded.stations.get(ids[0])!.waiting.values()][0];
  check(w.count === 4 && w.transfers === 2 && w.rail === RAIL_FARE.minimum && w.t === now - 80, 'legacy merged waiting history and flags load sensibly');
  const saved = JSON.stringify(serialize(loaded)), again = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(again)) === saved, 'legacy fare cohorts settle into an exact native round trip');
  // Check both migrated cohorts' receipts: their passengers who changed (legacy flags count one change each) and those
  // who did not pay the group's mean transfer reduction (x0.9^0.5 here, within 0.2% of 0.95 for the exact split).
  const settled = deserialize(JSON.parse(saved)), train = settled.vehicles.get(t.id) as Train;
  const before = train.incomeYear;
  train.serveStation(settled.stations.get(ids[1])!, 0);
  const expectedCargo = FARE_LEVEL * distanceFare(12) * speedFactor(12, 40) * 2 * transferFareFactor(1, 2);
  check(Math.abs(train.incomeYear - before - expectedCargo) < 1e-8
    && Math.abs(expectedCargo - fareFor(12, 40, 2, { mode: 'rail', railBefore: 600 }) * transferFareFactor(1, 2)) < 1e-8,
    'legacy cargo cap preserves full distance receipts with the mean transfer reduction');
  train.stopIndex = 0; train.serveStation(settled.stations.get(ids[0])!, 0);
  const boarded = [...train.cargo.values()];
  check(train.load === 4 && boarded.length === 1 && boarded[0].rail === RAIL_FARE.minimum && boarded[0].transfers === 2 && boarded[0].t0 === now - 80,
    'legacy capped waiting boards with its count, timing and transfer flags');
  const boardingIncome = train.incomeYear;
  train.serveStation(settled.stations.get(ids[1])!, 0);
  const expectedWaiting = FARE_LEVEL * distanceFare(12) * speedFactor(12, 80) * 4 * transferFareFactor(2, 4);
  check(Math.abs(train.incomeYear - boardingIncome - expectedWaiting) < 1e-8
    && Math.abs(expectedWaiting - fareFor(12, 80, 4, { mode: 'rail', railBefore: 600 }) * transferFareFactor(2, 4)) < 1e-8,
    'legacy waiting cap preserves full distance receipts with the mean transfer reduction');
  for (let i = 0; i < 40; i++) { loaded.stepTick(); again.stepTick(); }
  check(JSON.stringify(serialize(again)) === JSON.stringify(serialize(loaded)), 'legacy fare cohorts replay exactly after migration');
}
if (process.argv.includes('--regression')) {
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exit(fails.length ? 1 : 0);
}

const seed = Number(process.argv[2] ?? 7);
const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2 });
g.economy.money = 40_000_000;
// player network: a railway and a bus line
// (a pair that connects: since the walks were halved after 2.9 the first pair placed need not have a route)
const pr = placeAndConnect(g, 60, 150, 0, new Set(), 1, () => {})!;
check(!!pr, 'player railway placed and connected');
const dep = depotBehind(g, pr.A, pr.B, 0);
const line = g.lines.create('rail', 0);
line.stops = [pr.A.id, pr.B.id];
g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], line.id);
// mail: a mixed consist (a van behind the locomotive) and a mail train beside the passenger train
const mixed = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('van_ic')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], line.id);
const mailTrain = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('van_ic')!], line.id);
check(mixed instanceof Train && mixed.mailCapacity > 0 && mailTrain instanceof Train && mailTrain.mailOnly, 'a mixed consist and a mail train');
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, big, 0, 12, 30);
if (sites.length === 2) {
  const s0 = addBusStop(g, sites[0][0], sites[0][1], 0), s1 = addBusStop(g, sites[1][0], sites[1][1], 0);
  const bd = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const bl = g.lines.create('road', 0);
  bl.stops = [s0, s1];
  for (let i = 0; i < 2; i++) g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, bl.id);
  g.vehicles.buyRoad(bd, MODEL_BY_ID.get('postbus_b')!, bl.id);
}
// company state: AI settings, a track access agreement, a renamed line, a bought (defunct) company
g.ais[0].config = { ...g.ais[0].config, activeness: 1.4, risk: 0.7, focus: { rail: 2, road: 1, tram: 0.5 } };
check(g.requestAccess(0, g.ais[1].companyId) === 'granted', 'access agreement signed');
g.setAccessPolicy(0, 'ask');
check(g.requestAccess(g.ais[0].companyId, 0, 'test') === 'pending', 'a pending request to the player (saved too)');
g.lines.rename(line.id, 'Main Line');
// Construction projects are not persisted; network jobs are saved and must replay mid-job.
const busy = () => g.ais.some((a) => a.busy);
while (g.day < 200 || busy()) g.update(0.25);
g.economy.money += 80_000_000;
const bought = g.ais[1].companyId;
check(g.buyCompany(0, bought) === null, 'player buys an AI company');
while (g.day < 240 || busy()) g.update(0.25);
// save with mail waiting at stations and aboard (at most another 200 days)
const mailState = (x: Game) => ({
  waiting: [...x.stations.map.values()].reduce((n, st) => n + (st.mail?.total ?? 0), 0),
  aboard: x.vehicles.all().reduce((n, v) => n + v.mailLoad, 0),
});
for (let i = 0; i < 200 * 40 && (mailState(g).waiting === 0 || mailState(g).aboard === 0 || busy()); i++) g.stepTick();
check(mailState(g).waiting > 0 && mailState(g).aboard > 0, `mail waiting (${mailState(g).waiting}) and aboard (${mailState(g).aboard}) at the save`);
if (!g.ais.some((a) => networkPlanner(a)?.task)) runNetworkTask(g.ais[0], 'decommission', 1);
check(g.ais.some((a) => !!networkPlanner(a)?.task), 'deliberately save during a network job');
const t0 = performance.now();
const data = serialize(g);
const json = JSON.stringify(data);
const t1 = performance.now();
const g2 = deserialize(JSON.parse(json));
const t2 = performance.now();
console.log(`saved on ${g.dateString()}: serialize ${fmt(t1 - t0, 0)} ms, deserialize ${fmt(t2 - t1, 0)} ms, JSON ${fmt(json.length / 1e6, 2)} MB, gzip ${fmt(gzipSync(json).length / 1e6, 2)} MB`);
console.log(`  ${g.vehicles.map.size} vehicles, ${g.vehicles.ambient.length} town cars, ${g.world.net.edges.size} edges, ${g.stations.map.size} stations, ${g.companies.length} companies`);
const sig = (x: Game) => ({
  money: x.companies.map((c) => Math.round(c.economy.money)),
  delivered: x.vehicles.all().reduce((a, v) => a + v.delivered, 0),
  pop: x.towns.list.reduce((a, t) => a + t.pop, 0),
  edges: x.world.net.edges.size, vehicles: x.vehicles.map.size, ambient: x.vehicles.ambient.length,
  states: x.vehicles.all().map((v) => v.state[0]).join(''),
});
const s0 = sig(g), s0b = sig(g2);
check(JSON.stringify(s0) === JSON.stringify(s0b), 'state identical right after loading');
check(JSON.stringify(g2.ais.map((a) => a.config)) === JSON.stringify(g.ais.map((a) => a.config)), 'AI configs restored');
check(JSON.stringify(g2.access) === JSON.stringify(g.access) && g2.accessMultiplier(0) === g.accessMultiplier(0), 'access agreements, fees and multipliers restored');
check(JSON.stringify(g2.accessRequests) === JSON.stringify(g.accessRequests) && g2.accessPolicy(0) === g.accessPolicy(0), 'access requests and policies restored');
check(!!g2.company(bought).defunct && g2.company(bought).boughtBy === 0 && !g2.ais.some((a) => a.companyId === bought), 'defunct company restored');
check(g2.lines.get(line.id)?.name === 'Main Line' && g2.lines.all().every((l) => { const o = g.lines.get(l.id)!; return o.name === l.name && o.autoName === l.autoName && o.num === l.num && o.color === l.color; }), 'line names, numbers and colours restored');
check(checkReservations(g2).length === 0, 'reservations rebuilt consistently');
// mail restored: queues, mail aboard, line and town figures, mail's random stream
check(JSON.stringify(mailState(g2)) === JSON.stringify(mailState(g)), 'mail waiting and aboard restored');
check(!!data.mail && JSON.stringify(g2.mail.toJSON()) === JSON.stringify(g.mail.toJSON()), "mail's random stream saved and restored");
check([...g.stations.map.values()].every((st) => JSON.stringify(st.mail ? [...st.mail.waiting.values()] : null) === JSON.stringify(g2.stations.get(st.id)?.mail ? [...g2.stations.get(st.id)!.mail!.waiting.values()] : null)), 'mail queues restored group by group');
check(g.vehicles.all().every((v) => JSON.stringify([...v.mailCargo.values()]) === JSON.stringify([...g2.vehicles.get(v.id)!.mailCargo.values()]) && v.mailDelivered === g2.vehicles.get(v.id)!.mailDelivered), 'mail aboard restored vehicle by vehicle');
check(g.lines.all().every((l) => JSON.stringify(l.mail) === JSON.stringify(g2.lines.get(l.id)!.mail)), 'line mail figures restored');
check(g2.economy.months.length === g.economy.months.length && g.economy.months.every((m, i) => m.v.mailIncome === g2.economy.months[i].v.mailIncome), 'mail income history restored');
check(g.lines.mailRouting.size > 0 && [...g.lines.mailRouting.keys()].join() === [...g2.lines.mailRouting.keys()].join(), 'mail routing rebuilt alike');
// a save without mail state (format 3 before mail) loads: mail starts from the map seed
{
  const noMail = JSON.parse(json);
  delete noMail.mail;
  for (const st of noMail.stations) delete st.mail;
  for (const v of noMail.vehicles) { delete v.mail; delete v.mailLoad; delete v.mailDelivered; }
  for (const l of noMail.lines) delete l.mail;
  for (const t of noMail.towns) delete t.mail;
  for (const c of noMail.companies) for (const r of [c.economy.current, c.economy.thisYear, ...c.economy.months.map((m: { v: object }) => m.v)]) delete (r as Record<string, unknown>).mailIncome;
  const old = deserialize(noMail);
  check(old.economy.current.mailIncome === 0 && old.mail.toJSON() === null && [...old.stations.map.values()].every((st) => !st.mail), 'a save without mail loads (no mail state, the random stream from the seed)');
  for (let i = 0; i < 40 * 30; i++) old.stepTick();
  check(old.lines.mailActive && [...old.stations.map.values()].some((st) => st.mail), 'its mail vans start mail again');
}
// a second round trip of the loaded game must give the same data
const json2 = JSON.stringify(serialize(g2));
if (json2 !== json) {
  let i = 0;
  while (i < json.length && json[i] === json2[i]) i++;
  console.log(`  re-serialized JSON differs at ${i}: ...${json.slice(Math.max(0, i - 120), i + 60)}...\n  vs ...${json2.slice(Math.max(0, i - 120), i + 60)}...`);
}
check(json2 === json, `re-serialized save identical (${json.length} vs ${json2.length} chars)`);
let errors = 0;
const replayStart = g.day;
while (g.day < replayStart + 360) {
  try { g.stepTick(); g2.stepTick(); } catch (e) { errors++; console.log('EXCEPTION', (e as Error).stack?.split('\n').slice(0, 5).join('\n')); break; }
  if (g.day === replayStart + 120 && g.tick % g.ticksPerDay === 0) {
    const a = JSON.stringify(serialize(g)), b = JSON.stringify(serialize(g2));
    if (a !== b) {
      let at = 0; while (a[at] === b[at]) at++;
      console.log(`  replay differs at ${at}: ${a.slice(Math.max(0, at - 100), at + 160)}\n  loaded: ${b.slice(Math.max(0, at - 100), at + 160)}`);
    }
    check(a === b, 'mid-job save replays exactly for 120 days with stepTick');
  }
}
const a = sig(g), b = sig(g2);
console.log(`after a year: original ${JSON.stringify({ ...a, states: undefined })}\n              loaded   ${JSON.stringify({ ...b, states: undefined })}`);
check(errors === 0, 'no exceptions');
const close = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y));
check(a.money.every((m, i) => close(m, b.money[i], 0.02)), 'company money within 2%');
check(close(a.delivered, b.delivered, 0.03), 'passengers delivered within 3%');
check(close(a.pop, b.pop, 0.02), 'town population within 2%');
console.log(`  exact match: ${JSON.stringify(a) === JSON.stringify(b)}`);
check(!checkNaN(g2), 'no NaN in the loaded game');
check(checkReservations(g2).length === 0, 'reservations consistent in the loaded game');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
void Train;
