// Fleet operations, age-progressive maintenance, per-vehicle track wear & access fee attribution,
// arrival-staged vehicle & line auto-replacement, short-turn pattern detection, and AI fleet modernization.
// npx esbuild scripts/fleet.ts --bundle --platform=node --format=esm --outfile=$S/fleet.mjs && node $S/fleet.mjs
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { AGE_WEAR_START, AGE_WEAR_RATE, AGE_WEAR_MAX, MAINT_PER_CAR_KM, ageMaintFactor, calibration, estimateVehicleYear, maintSpeed, monthWear } from '../src/game/opcosts';
import { electrify } from '../src/game/build-ops';
import { autoSignalLine, setSignal } from '../src/game/signals';
import { depotServes } from '../src/game/train';
import { addPattern, setVehiclePattern, suggestShortTurn } from '../src/game/patterns';
import { outAndBack } from '../src/game/lines';
import { serialize, deserialize } from '../src/game/save';
import { upgradeOption } from '../src/ui/win-info';
import { fails, check, fmt, placeStationPair, connectDouble, placeAndConnect, depotBehind, addBusStop, roadDepotNear, busStopSites, Train, RoadVehicle } from './lib';

if (!process.argv[1]?.endsWith('fleet.mjs')) throw new Error('bundle this test as fleet.mjs');
const M = (id: string) => {
  const m = MODEL_BY_ID.get(id);
  if (!m) throw new Error('unknown model ' + id);
  return m;
};
const runTicks = (g: Game, n: number) => { for (let i = 0; i < n; i++) g.stepTick(); };
const runDays = (g: Game, days: number) => runTicks(g, days * TICKS_PER_DAY);
function sameState(a: Game, b: Game, label: string) {
  const sa = JSON.stringify(serialize(a)), sb = JSON.stringify(serialize(b));
  if (sa !== sb) {
    let i = 0;
    while (i < sa.length && i < sb.length && sa[i] === sb[i]) i++;
    console.log(`  DIFF (${label}) at ${i}: A=${sa.slice(Math.max(0, i - 60), i + 100)} | B=${sb.slice(Math.max(0, i - 60), i + 100)}`);
  }
  check(sa === sb, label);
}

// ---- 1. Age-progressive maintenance curve & estimator parity
{
  check(ageMaintFactor(0) === 1 && ageMaintFactor(8) === 1 && ageMaintFactor(AGE_WEAR_START) === 1,
    'vehicles up to 12 years old pay 1.0x base maintenance (calibration bands untouched)');
  const f22 = ageMaintFactor(22);
  check(Math.abs(f22 - (1 + 10 * AGE_WEAR_RATE)) < 1e-12, `22-year vehicle pays ${fmt(f22, 3)}x maintenance`);
  check(Math.abs(ageMaintFactor(60) - (1 + AGE_WEAR_MAX)) < 1e-12, `age maintenance caps smoothly at ${1 + AGE_WEAR_MAX}x`);
  const cars = [M('diesel_a'), M('coach_steel'), M('coach_steel')];
  const yrYoung = estimateVehicleYear(cars, 120, 1980, 0.5, Infinity, 5);
  const yrOld = estimateVehicleYear(cars, 120, 1980, 0.5, Infinity, 22);
  check(Math.abs(yrOld.maint / yrYoung.maint - f22) < 1e-9 && yrOld.crew === yrYoung.crew && yrOld.energy === yrYoung.energy,
    'estimateVehicleYear scales maintenance by ageMaintFactor while keeping crew and energy unchanged');
}

// ---- 2. Live age maintenance, per-vehicle trackWear & foreign trackFees, edge split, and mid-month save/load
{
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'flat', water: 'low', startYear: 1985, aiCompanies: 1 });
  g.aiEnabled = false;
  g.economy.money = 5e7;
  g.company(1).economy.money = 5e7;
  g.company(0).accessPolicy = 'open';
  const skip = new Set<string>();
  let stPair: ReturnType<typeof placeStationPair> = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const cand = placeStationPair(g, 60, 150, 0, new Set(), 16, skip);
    if (!cand) break;
    const dc = connectDouble(g, cand.A, cand.B, 0, () => {});
    if (dc.ok) { stPair = cand; break; }
    skip.add(cand.TA.id + ':' + cand.TB.id);
    g.stations.removeStation(cand.A.id); g.stations.removeStation(cand.B.id);
  }
  const pr = stPair ?? placeAndConnect(g, 60, 150, 0, new Set(), 2, () => {})!;
  const dep0 = depotBehind(g, pr.A, pr.B, 0);
  const depB = depotBehind(g, pr.B, pr.A, 0);
  const line0 = g.lines.create('rail', 0);
  line0.stops = [pr.A.id, pr.B.id];

  const tYoung = g.vehicles.buyTrain(dep0, [M('diesel_b'), M('coach_ic'), M('coach_ic')], line0.id) as Train;
  const tAged = g.vehicles.buyTrain(depB >= 0 ? depB : dep0, [M('diesel_b'), M('coach_ic'), M('coach_ic')], line0.id) as Train;
  tYoung.stopIndex = depotServes(g, g.depots.get(tYoung.depotId)!, pr.A.id, pr.B.id) === pr.B.id ? 1 : 0;
  tAged.stopIndex = depotServes(g, g.depots.get(tAged.depotId)!, pr.A.id, pr.B.id) === pr.B.id ? 1 : 0;
  tAged.boughtDay = g.day - 24 * 360; // 24 years old -> +42% maintenance

  // Warm up 1 month so both trains clear the depot and run steadily on the double-track line, then step 14 days into month 1
  runDays(g, 30);
  runDays(g, 14);
  // Find a worn, currently clear main-line rail edge and split it mid-month via setSignal
  let midEdge = [...g.world.net.edges.values()].find((e) =>
    e.kind === 'rail' && e.owner === 0 && e.station < 0 && e.depot < 0 && e.len > 6
    && monthWear(g, e.id) > 0 && !g.vehicles.isEdgeBusy(e.id));
  for (let step = 0; !midEdge && step < 10 * TICKS_PER_DAY; step++) {
    g.stepTick();
    midEdge = [...g.world.net.edges.values()].find((e) =>
      e.kind === 'rail' && e.owner === 0 && e.station < 0 && e.depot < 0 && e.len > 6
      && monthWear(g, e.id) > 0 && !g.vehicles.isEdgeBusy(e.id));
  }
  check(!!midEdge, 'found clear worn rail edge to split mid-month');
  if (midEdge) {
    const sigErr = setSignal(g, midEdge.id, midEdge.len * 0.5, 'twoway', true, 0);
    check(sigErr === null, `split worn rail edge mid-month via signal placement (${sigErr ?? 'ok'})`);
  }

  // Mid-month save/load round-trip check
  const snap = JSON.stringify(serialize(g));
  const g2 = deserialize(JSON.parse(snap));
  const remTicks = (30 * TICKS_PER_DAY) - (g.tick % (30 * TICKS_PER_DAY));
  runTicks(g, remTicks);
  runTicks(g2, remTicks);

  sameState(g, g2, 'mid-month save/load after edge split produces byte-identical month-end state and opLast');
  check((tYoung.opLast?.trackWear ?? 0) > 0 && (tAged.opLast?.trackWear ?? 0) > 0,
    `own-track trains receive per-vehicle opLast.trackWear (${Math.round(tYoung.opLast?.trackWear ?? 0)} / ${Math.round(tAged.opLast?.trackWear ?? 0)})`);
  check(!(tYoung.opLast?.trackFees), 'own-track train has zero foreign trackFees');

  // Verify live maintenance ratio per unit activity matches ageMaintFactor
  const zeroAgeMaint = (v: Train) => {
    const cal = calibration(v.cars), c = cal.consist;
    return MAINT_PER_CAR_KM * c.carUnits * maintSpeed(c.vmax) * v.opLast!.km + cal.timeMaintPerS * (v.opLast!.hours * 3600);
  };
  check((tYoung.opLast?.km ?? 0) > 0.5 && (tAged.opLast?.km ?? 0) > 0.5, 'both young and aged trains accumulated distance in month 1');
  if ((tYoung.opLast?.km ?? 0) > 0.5 && (tAged.opLast?.km ?? 0) > 0.5) {
    const multYoung = tYoung.opLast!.maint / zeroAgeMaint(tYoung);
    const multAged = tAged.opLast!.maint / zeroAgeMaint(tAged);
    check(Math.abs(multYoung - 1) < 1e-6 && Math.abs(multAged - ageMaintFactor(tAged.age)) < 1e-6,
      `aged train pays ${fmt(multAged, 4)}x maintenance vs young ${fmt(multYoung, 4)}x (expected ${fmt(ageMaintFactor(tAged.age), 4)}x)`);
  }

  // Foreign track & station access fee attribution on a rival vehicle using owner 0's infrastructure
  const foreignEdge = [...g.world.net.edges.values()].find((e) => e.kind === 'rail' && e.owner === 0 && e.station < 0 && e.depot < 0)!;
  const rivalDep = depotBehind(g, pr.B, pr.A, 1);
  if (rivalDep >= 0) {
    const rLine = g.lines.create('rail', 1);
    const rTrain = new Train(g, g.vehicles.nextId++, [M('diesel_b'), M('coach_ic')], rivalDep);
    rTrain.owner = 1;
    rTrain.name = 'Rival Train';
    g.vehicles.map.set(rTrain.id, rTrain);
    rTrain.lineId = rLine.id;
    g.recordTrackUse(1, foreignEdge, 50, false, rTrain.id);
    g.recordStop(rTrain, pr.A);
    const ticksToNextMonth = (30 * TICKS_PER_DAY) - (g.tick % (30 * TICKS_PER_DAY));
    const midSnap = JSON.stringify(serialize(g));
    const gReloaded = deserialize(JSON.parse(midSnap));
    runTicks(g, ticksToNextMonth);
    runTicks(gReloaded, ticksToNextMonth);
    const rt1 = g.vehicles.get(rTrain.id)!, rt2 = gReloaded.vehicles.get(rTrain.id)!;
    check((rt1.opLast?.trackFees ?? 0) > 0 && rt1.opLast?.trackFees === rt2.opLast?.trackFees,
      `foreign train receives exact opLast.trackFees (${Math.round(rt1.opLast?.trackFees ?? 0)}) preserved across save/load`);
    g.vehicles.sell(rTrain.id);
    g.lines.delete(rLine.id);
  }
}

// ---- 3. Upgrade rules, arrival-staged replacement, cargo & pattern preservation, and age-threshold auto-replace
{
  const g = Game.create({ size: 384, seed: 11, towns: 10, hilliness: 'flat', water: 'low', startYear: 1960 });
  g.economy.money = 5e7;
  const pr = placeAndConnect(g, 70, 150, 0, new Set(), 2, () => {})!;
  const dep = depotBehind(g, pr.A, pr.B, 0);
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const pat = addPattern(g, line.id, 'local', [true, true], 'Custom Local')!;

  const t1 = g.vehicles.buyTrain(dep, [M('steam_b'), M('van_wood'), M('coach_wood'), M('coach_wood')], line.id) as Train;
  const t2 = g.vehicles.buyTrain(dep, [M('steam_b'), M('van_wood'), M('coach_wood'), M('coach_wood')], line.id) as Train;
  setVehiclePattern(g, t1.id, pat.id);
  setVehiclePattern(g, t2.id, pat.id);

  // Advance year to 2002 so modern diesel (hst) & electric (bullet) models are unlocked
  g.options.startYear = 2002 - Math.floor(g.day / 360);
  // Unwired line must reject electric loco in replaceValidate / setLineReplace and upgradeOption must pick diesel!
  const unwiredErr = g.vehicles.setLineReplace(line.id, 0, [M('bullet'), M('coach_hs'), M('coach_hs')], 0);
  check(typeof unwiredErr === 'string', `unwired line rejects electric consist (${unwiredErr})`);
  const optUnwired = upgradeOption(g, t1);
  check(!!optUnwired && optUnwired.cars[0].traction !== 'electric' && optUnwired.cars.some((c) => c.mail && c.mail > 0),
    'upgradeOption on unwired line picks modern diesel loco and preserves mail van');

  // Electrify the entire rail network of owner 0 -> upgradeOption should now offer electric traction!
  const allRail = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail').map((e) => e.id);
  electrify(g, allRail, 0);
  const optWired = upgradeOption(g, t1);
  check(!!optWired && optWired.cars[0].traction === 'electric' && optWired.cars.some((c) => c.id === 'van_ic'),
    `upgradeOption on wired line picks electric loco (${optWired?.cars[0].id}) and upgrades mail van to van_ic`);

  // Run until t1 is moving on map with passengers aboard
  for (let k = 0; k < 180 * TICKS_PER_DAY && !(t1.onMap && t1.state === 'running' && t1.load > 0); k++) g.stepTick();
  check(t1.onMap && t1.state === 'running' && t1.load > 0, `train 1 running in transit with ${t1.load} passengers`);

  const targetCars = [M('bullet'), M('van_ic'), M('coach_hs'), M('coach_hs')];
  // Queue single-vehicle replacement while t1 is running between stations
  const qRes = g.vehicles.orderVehicleReplace(t1, targetCars);
  check(qRes === 'queued' && t1.replaceWith?.join(',') === targetCars.map((c) => c.id).join(','),
    'orderVehicleReplace queues replacement while train is running between stations');

  // Save/load while replacement is queued mid-run!
  const midSave = JSON.stringify(serialize(g));
  const gCopy = deserialize(JSON.parse(midSave));

  // Step until t1 arrives at next station and completes replacement
  let ticks = 0;
  while (ticks < 60 * TICKS_PER_DAY && g.vehicles.get(t1.id)?.replaceWith) {
    g.stepTick();
    gCopy.stepTick();
    ticks++;
  }
  check(!t1.replaceWith && t1.cars.some((c) => c.id === 'bullet') && t1.pattern === pat.id,
    'queued train replaced seamlessly on station arrival while preserving assigned service pattern');
  sameState(g, gCopy, 'save/load mid-queued-replacement continues byte-identically through arrival swap');

  // Test tight trade-in cash on depot train: money < grossCost, money + resale >= grossCost
  const tTrade = g.vehicles.buyTrain(dep, [M('hst'), M('coach_ic'), M('coach_ic')], line.id) as Train;
  const resale = g.vehicles.resaleValue(tTrade);
  const swapCost = targetCars.reduce((s, c) => s + c.cost, 0);
  g.economy.loan = g.economy.maxLoan; // no extra borrowing headroom
  g.economy.money = Math.max(10_000, swapCost - resale + 5_000);
  check(g.economy.money < swapCost && g.economy.money + resale >= swapCost, 'cash below gross price but covers net trade-in');
  const tradeErr = g.vehicles.replaceNow(tTrade, targetCars, null);
  check(tradeErr === null && tTrade.cars.some((c) => c.id === 'bullet'), 'replaceNow succeeds using trade-in value without requiring gross cash upfront');
  g.economy.loan = 0;
  g.economy.money = 5e7;

  // Test line-level age-threshold auto-replace (minAge = 15): young train stays as-is, aged train replaces!
  t1.boughtDay = g.day; // age 0
  t2.boughtDay = g.day - 18 * 360; // age 18 >= 15
  const ruleCars = [M('bullet'), M('coach_hs'), M('coach_hs'), M('coach_hs')];
  const lRes = g.vehicles.setLineReplace(line.id, 0, ruleCars, 15);
  check(typeof lRes !== 'string' && line.replace?.[0]?.minAge === 15, 'setLineReplace installs minAge=15 rule');
  runDays(g, 45);
  check(t2.age < 2 && t2.cars.filter((c) => c.id === 'coach_hs').length === 3, 'aged train (18 yrs) auto-replaced under minAge=15 rule');
  check(t1.cars.some((c) => c.id === 'van_ic'), 'young train (0 yrs) kept its existing consist under minAge=15 rule');
  check(line.replace?.[0]?.minAge === 15, 'age-threshold auto-replace rule stays active on line for future ageing stock');

  // Coach vs city bus separation in upgradeOption
  const town = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const sites = busStopSites(g, town, 0);
  if (sites.length >= 2) {
    const sA = addBusStop(g, sites[0][0], sites[0][1], 0), sB = addBusStop(g, sites[1][0], sites[1][1], 0);
    const rDep = roadDepotNear(g, sites[0][0], sites[0][1], 0);
    if (sA >= 0 && sB >= 0 && rDep >= 0) {
      const bLine = g.lines.create('road', 0);
      bLine.stops = [sA, sB];
      const cityBus = g.vehicles.buyRoad(rDep, M('bus_a'), bLine.id) as RoadVehicle;
      const coachBus = g.vehicles.buyRoad(rDep, M('coach_a'), bLine.id) as RoadVehicle;
      const upCity = upgradeOption(g, cityBus);
      const upCoach = upgradeOption(g, coachBus);
      check(!!upCity && upCity.cars[0].style !== 'coach', `city bus upgrades to city bus (${upCity?.cars[0].id}), never intercity coach`);
      check(!!upCoach && upCoach.cars[0].style === 'coach', `intercity coach upgrades to intercity coach (${upCoach?.cars[0].id})`);
    }
  }
}

// ---- 4. Short-turn suggestion on asymmetric 5-stop corridors
{
  const g = Game.create({ size: 384, seed: 23, towns: 10, hilliness: 'flat', water: 'low', startYear: 1980 });
  g.economy.money = 5e7;
  const stops: number[] = [];
  const placed: [number, number][] = [];
  for (const town of [...g.towns.list].sort((a, b) => b.pop - a.pop)) {
    for (const e of g.towns.streets(town, 0)) {
      if (stops.length >= 5) break;
      if (e.len < 4) continue;
      const p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, e.len / 2, p);
      if (placed.some(([x, z]) => Math.hypot(x - p.x, z - p.z) < 10)) continue;
      const bp = g.stations.planBusStop(p.x, p.z, 0);
      if (!bp.ok || bp.join) continue;
      const id = addBusStop(g, p.x, p.z, 0);
      if (id >= 0 && !stops.includes(id)) { stops.push(id); placed.push([p.x, p.z]); }
    }
    if (stops.length >= 5) break;
  }
  check(stops.length === 5, 'created 5-stop corridor for short-turn check');
  if (stops.length === 5) {
    const l = g.lines.create('road', 0);
    l.stops = outAndBack(stops);
    // Balanced traffic -> no short-turn suggested
    for (const sid of stops) {
      const st = g.stations.get(sid)!;
      st.catchPop = 200; st.pickupLast = 40; st.arrivedLast = 40;
    }
    check(suggestShortTurn(g, l) === null, 'balanced 5-stop line does not suggest a short-turn');
    // Heavy inner core (stops 1..3) vs quiet outer tails (stops 0 and 4)
    for (const i of [0, 4]) { const st = g.stations.get(stops[i])!; st.catchPop = 30; st.pickupLast = 5; st.arrivedLast = 5; }
    for (const i of [1, 2, 3]) { const st = g.stations.get(stops[i])!; st.catchPop = 400; st.pickupLast = 120; st.arrivedLast = 120; }
    const sug = suggestShortTurn(g, l);
    check(!!sug && !sug.stops[0] && sug.stops[1] && sug.stops[2] && sug.stops[3] && !sug.stops[4],
      `asymmetric 5-stop corridor suggests inner short-turn (${sug?.name})`);
  }
}

// ---- 5. AI autonomous fleet modernization (physics-based payback, post-electrification & aged fleet)
{
  const g = Game.create({ size: 448, seed: 7, towns: 12, hilliness: 'flat', water: 'dry', startYear: 1955, aiCompanies: 1 });
  const ai = g.ais[0];
  const me = ai.companyId;
  g.company(me).economy.money = 2.5e7;
  const skip5 = new Set<string>();
  let pair5: ReturnType<typeof placeStationPair> = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const cand = placeStationPair(g, 190, 340, me, new Set(), 16, skip5);
    if (!cand) break;
    const dc = connectDouble(g, cand.A, cand.B, me, () => {});
    if (dc.ok) { pair5 = cand; break; }
    skip5.add(cand.TA.id + ':' + cand.TB.id);
    g.stations.removeStation(cand.A.id); g.stations.removeStation(cand.B.id);
  }
  const pr = pair5 ?? placeAndConnect(g, 180, 340, me, new Set(), 2, () => {})!;
  const dep = depotBehind(g, pr.A, pr.B, me);
  const dep2 = depotBehind(g, pr.B, pr.A, me);
  const line = g.lines.create('rail', me);
  line.stops = [pr.A.id, pr.B.id];
  if (!pair5) autoSignalLine(g, line.id, me);

  const t1 = g.vehicles.buyTrain(dep, [M('steam_b'), M('van_wood'), M('coach_wood'), M('coach_wood')], line.id) as Train;
  const t2 = g.vehicles.buyTrain(dep2 >= 0 ? dep2 : dep, [M('steam_b'), M('van_wood'), M('coach_wood'), M('coach_wood')], line.id) as Train;
  t1.stopIndex = depotServes(g, g.depots.get(t1.depotId)!, pr.A.id, pr.B.id) === pr.B.id ? 1 : 0;
  t2.stopIndex = depotServes(g, g.depots.get(t2.depotId)!, pr.A.id, pr.B.id) === pr.B.id ? 1 : 0;

  // Let the AI adopt the line and establish healthy traffic
  runDays(g, 90);
  // Advance era to 2000, electrify the line, replenish AI treasury, and age the steam trains to 28 years
  g.options.startYear = 2000 - Math.floor(g.day / 360);
  const railEdges = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail').map((e) => e.id);
  electrify(g, railEdges, me);
  g.company(me).economy.money = 2.5e7;
  t1.boughtDay = g.day - 28 * 360;
  t2.boughtDay = g.day - 28 * 360;
  const info = ai.railLineInfo(line.id);
  check(!!info, 'AI adopted railway line');
  if (info) {
    info.opened = g.day - 800;
    info.electric = g.day - 30;
    // Marginal revenue that cannot repay replacement outlay -> AI must decline
    line.incomeLast = 120_000;
    line.costLast = 115_000;
    (ai as unknown as { manage: () => void }).manage();
    check(!line.replace?.[me] && t1.madeUp[0].traction === 'steam', 'AI declines fleet modernization when revenue cannot repay net outlay');

    // Strong intercity revenue -> AI stages electric modernization and swaps trains + mail vans on arrival
    info.modernizeLook = undefined;
    line.incomeLast = 1_800_000;
    line.costLast = 260_000;
    (ai as unknown as { manage: () => void }).manage();
    const modernizedNow = [t1, t2].some((t) => t.madeUp[0]?.traction === 'electric') || !!line.replace?.[me];
    check(modernizedNow, 'AI stages fleet modernization on profitable wired line with aged steam trains');
    runDays(g, 95);
    check(t1.madeUp[0].traction === 'electric' && t2.madeUp[0].traction === 'electric'
      && t1.madeUp.some((c) => c.id === 'van_ic') && !line.replace?.[me],
      `both AI trains upgraded to electric (${t1.madeUp[0].id}) + van_ic on arrival and one-shot rule cleared`);
  }
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
