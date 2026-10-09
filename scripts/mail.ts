// Mail mechanics on a two-town railway (seed 7, the economy test's intercity line): no mail before a van; a mail van
// carries mail beside the passengers and books 'mailIncome', costing the passengers no more than a fourth coach (the
// same extra mass and length) would; mail trains carry
// mail only; mail fare units; postbus -> rail transfers through a linked stop; trams never carry mail; queue trimming,
// lost mail and the mail rating; recomposing (refused on a short platform, while running; paid and refunded); merged
// stations and lines keep their mail; journeys priced whole and shared by their legs; mail catchments by mail service
// alone; mail feeders by the mail service; a single line's capture.
// npx esbuild scripts/mail.ts --bundle --platform=node --format=esm --outfile=$S/mail.mjs && node $S/mail.mjs
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { MODEL_BY_ID, MODELS, availableModels, carriesMail, mailOnlyModel, type VehicleModel } from '../src/game/vehicle-types';
import { MAIL_UNIT_T, MAIL_STATION, MAIL_CAPTURE } from '../src/game/constants';
import { mailFare, mailRefTime, mailEffDist as effDist, mailTripFactor, MAIL_FARE, simNow } from '../src/game/fares';
import { stationMail, addMail, trimMail, mailQueueCap, mailLostShare, mailEra, townMailFactor, isFull, newJourney, loadMail, unloadMail, offloadMail, absorbMail, settleMail, journeyOf, mailByTown } from '../src/game/mail';
import { mailFleet, canonicalizeLines } from '../src/game/patterns';
import { mergeStops, WALK_LINE } from '../src/game/stations';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { fails, check, fmt, placeAndConnect, depotBehind, addBusStop, roadDepotNear, busStopSites, Train, RoadVehicle } from './lib';

if (!process.argv[1]?.endsWith('mail.mjs')) throw new Error('bundle this test as mail.mjs');
const M = (id: string) => MODEL_BY_ID.get(id)!;
const runDays = (g: Game, days: number, each?: () => void) => { for (let d = 0; d < days; d++) { for (let k = 0; k < TICKS_PER_DAY; k++) g.stepTick(); each?.(); } };

// ---- units, fares, models
{
  check(MAIL_UNIT_T === 0.1 && M('van_ic').mail === 80 && M('van_wood').mail === 40 && M('mail_emu').mail === 160, 'mail in units of 0.1 t: vans 4 / 6 / 8 t, the postal unit 16 t');
  const d = 100, ref = mailRefTime(d);
  check(Math.abs(mailFare(d, ref, 1) - MAIL_FARE.rate * effDist(d)) < 1e-9, `a unit of mail carried 1 km as fast as the alternative pays rate x effective distance (${fmt(mailFare(d, ref, 1), 1)})`);
  check(Math.abs(MAIL_FARE.rate - 13.65) < 1e-9, 'the mail rate is the long-leg passenger rate (13.65)');
  check(Math.abs(mailFare(d, ref / 4, 10) - 10 * MAIL_FARE.rate * effDist(d) * 1.6) < 1e-9 && Math.abs(mailFare(d, ref * 20, 10) - 10 * MAIL_FARE.rate * effDist(d) * 0.15) < 1e-9, 'the time factor is clamped to 0.15 .. 1.6');
  check(mailFare(d, ref * 2, 4) < mailFare(d, ref, 4) && mailFare(0.5, ref, 4) === 0 && mailFare(d, ref, 0) === 0, 'slower journeys pay less; no fare without distance or mail');
  check(Math.abs(mailFare(d, ref, 5, 2) - 0.81 * mailFare(d, ref, 5)) < 1e-9, 'each change of vehicle costs 10% of the receipts');
  check(Math.abs(mailEra(1950) - 1) < 1e-12 && Math.abs(mailEra(2000) - 1.35) < 1e-12 && mailEra(1800) === 0.35 && Math.abs(mailEra(1962.5) - 1.1) < 1e-12, 'mail per person by era');
  check(townMailFactor(3000) === 1 && townMailFactor(100) === 0.75 && townMailFactor(1e6) === 1.3, 'town size factor');
  check(MODELS.filter((m) => m.kind === 'tram').every((m) => !carriesMail(m)), 'trams never carry mail');
  check(MODELS.filter((m) => carriesMail(m)).every((m) => !['metro', 'lrv', 'hsr', 'emu_'].some((p) => m.id.startsWith(p))), 'no mail compartments in metro, light rail, commuter or high-speed units');
  check(availableModels(1980, 'wagon', false).every((m) => !carriesMail(m)) && availableModels(1980, 'wagon', true).every((m) => carriesMail(m) && m.id.startsWith('van')), 'passenger and mail stock apart');
  check(mailOnlyModel(M('mailtruck_b')) && !mailOnlyModel(M('postbus_b')) && carriesMail(M('postbus_b')) && M('postbus_b').capacity > 0, 'postbuses carry passengers and mail');
}

/** The economy test's intercity railway with one train (`cars`); a second identical game differs only in the train. */
function fixture(cars: VehicleModel[]) {
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  g.economy.money = 1e9;
  const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {})!;
  const dep = depotBehind(g, pr.A, pr.B, 0);
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const train = g.vehicles.buyTrain(dep, cars, line.id) as Train;
  return { g, pr, dep, line, train };
}

// ---- lost acceptance: naturally posted in-flight mail must not be delivered or paid on any settlement path
{
  const f = fixture([M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic')]);
  const { g, pr, train } = f;
  for (let k = 0; k < 720 * TICKS_PER_DAY && ![...train.mailCargo.values()].some((c) => c.dest === pr.B.id); k++) g.stepTick();
  const cargo = [...train.mailCargo.values()].filter((c) => c.dest === pr.B.id);
  check(cargo.length > 0 && g.mail.accepts(pr.B), 'acceptance fixture: naturally posted mail aboard for an accepting destination');
  if (cargo.length) {
    const initial = JSON.stringify(serialize(g)), units = cargo.reduce((n, c) => n + c.count, 0), j = journeyOf(cargo[0]);
    for (const path of ['unload', 'offload', 'walk', 'absorb', 'settle'] as const) {
      const h = deserialize(JSON.parse(initial)), t = h.vehicles.get(train.id)!;
      const A = h.stations.get(pr.A.id)!, B = h.stations.get(pr.B.id)!;
      for (const st of h.stations.map.values()) if (st.mail) { st.mail.waiting.clear(); st.mail.total = 0; }
      for (const [key, c] of t.mailCargo) if (c.dest !== B.id) { t.mailLoad -= c.count; t.mailCargo.delete(key); }
      for (const e of [...h.world.net.edges.values()]) if (e.kind === 'road') h.world.net.removeEdge(e.id);
      h.onNetworkChanged(); h.flushNetworkChanges(); h.lines.flushCatchment();
      check(A.roadAccess === false && B.roadAccess === false && !h.mail.accepts(B) && h.mail.rate(B) === 0, `${path}: destination lost road access and acceptance`);
      const totals = () => ({
        lost: h.stations.all().reduce((n, st) => n + (st.mail?.lostMonth ?? 0), 0),
        arrived: h.stations.all().reduce((n, st) => n + (st.mail?.arrivedMonth ?? 0), 0),
        delivered: h.towns.list.reduce((n, town) => n + (town.mail?.deliveredMonth ?? 0), 0),
        income: h.economy.thisYear.mailIncome, vehicle: t.mailDelivered,
      });
      const before = totals();
      if (path === 'unload') check(unloadMail(h, t, B) === units, 'unload: all affected units get off');
      if (path === 'offload') check(offloadMail(h, t, units, B) === units, 'offload: all affected units get off');
      if (path === 'walk') addMail(h, A, WALK_LINE, B.id, B.id, units, { ...j, legs: [[t.id, f.line.id, t.owner, j.od]] });
      if (path === 'absorb') {
        addMail(h, A, f.line.id, B.id, B.id, units, { ...j, legs: [[t.id, f.line.id, t.owner, j.od]] });
        const deliveries = absorbMail(h, A, B, (id) => id === B.id ? A.id : id);
        if (deliveries) for (const d of deliveries) settleMail(h, d.st, d.count, d.j, null);
      }
      if (path === 'settle') settleMail(h, B, units, j, { v: t, line: t.line, dist: j.od });
      const after = totals();
      check(after.lost - before.lost === units && after.arrived === before.arrived && after.delivered === before.delivered && after.vehicle === before.vehicle,
        `${path}: ${units} units counted as lost, with no station, town or vehicle deliveries`);
      check(after.income === before.income, `${path}: lost acceptance pays no operator`);
      console.log(`lost acceptance / ${path}: ${units} units, lost ${after.lost - before.lost}, income ${fmt(after.income - before.income, 2)}`);
    }
  }
}

// ---- passengers only: no mail at all; with a van: mail income, passengers as with any fourth car
const plain = fixture([M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')]);
const vans = fixture([M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic'), M('coach_ic')]);
const heavy = fixture([M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic'), M('coach_ic')]);
check(plain.train instanceof Train && vans.train instanceof Train && heavy.train instanceof Train, 'trains bought');
let vanLoad = 0, coachLoad = 0, samples = 0;
runDays(plain.g, 360 * 3);
runDays(heavy.g, 360 * 3);
runDays(vans.g, 360 * 3, () => {
  const t = vans.train;
  if (t.onMap && vans.g.day > 360) { samples++; vanLoad += t.mailLoad / t.mailCapacity; coachLoad += t.load / t.capacity; }
});
{
  const g = plain.g, y = g.economy.yearTotals[g.economy.yearTotals.length - 1].v;
  check(g.lines.mailRouting.size === 0 && [...g.stations.map.values()].every((st) => !st.mail) && g.mail.toJSON() === null, 'no van: no mail routing, no station mail, mail randomness unused');
  check(y.mailIncome === 0 && !plain.line.mail && plain.train.mailDelivered === 0, 'no van: no mail income');
}
{
  const g = vans.g, l = vans.line, y = g.economy.yearTotals[g.economy.yearTotals.length - 1].v, yp = plain.g.economy.yearTotals[plain.g.economy.yearTotals.length - 1].v;
  const paxV = l.incomeLast - (l.mail?.incomeLast ?? 0), paxP = plain.line.incomeLast, paxH = heavy.line.incomeLast;
  console.log(`year ${g.year - 1}: passenger income ${fmt(paxP / 1000, 1)}k without a van, ${fmt(paxV / 1000, 1)}k with one, ${fmt(paxH / 1000, 1)}k with a fourth coach instead; mail ${fmt((l.mail?.incomeLast ?? 0) / 1000, 1)}k (${fmt(100 * (l.mail?.incomeLast ?? 0) / Math.max(1, paxV), 1)}% of passenger income); company mail ${fmt(y.mailIncome / 1000, 1)}k`);
  console.log(`  loads: van ${fmt(100 * vanLoad / Math.max(1, samples), 1)}%, coaches ${fmt(100 * coachLoad / Math.max(1, samples), 1)}%; delivered ${vans.train.mailDelivered} units, ${vans.train.delivered} passengers`);
  check(y.mailIncome > 0 && (l.mail?.incomeLast ?? 0) > 0 && vans.train.mailDelivered > 0, 'a mail van earns mail income (company, line, train)');
  // (2.7: every car slows the train, and the passengers' car feeders follow the headway up to 300 s: a heavier train
  // loses passengers whatever the car; mail must not cost them more than that)
  check(paxV >= 0.97 * paxH && paxV <= paxP * 1.03 && Math.abs(y.income - yp.income) <= 0.15 * yp.income,
    `passenger income with a van at least that with a fourth coach instead, within 3% (${fmt(100 * (paxV / paxH - 1), 2)}%; ${fmt(100 * (paxV / paxP - 1), 2)}% against no fourth car)`);
  check(Math.abs(l.incomeLast - paxV - (l.mail?.incomeLast ?? 0)) < 1e-6, 'the line income is the total; mail a part of it');
  check(l.mail !== undefined && g.lines.mailServed(vans.pr.A.id) && g.lines.mailServed(vans.pr.B.id), 'both stations mail-served');
  const A = g.stations.get(vans.pr.A.id)!;
  check(!!A.mail && A.mail.genLast + A.mail.genMonth >= 0 && A.mail.rating > 0.3 && A.mail.total <= mailQueueCap(g, A), `station mail state: rating ${fmt(A.mail?.rating ?? 0, 2)}, queue ${A.mail?.total} under its cap ${mailQueueCap(g, A)}`);
}

// ---- a mail train (vans only) beside the passenger train
{
  const f = fixture([M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')]);
  const mt = f.g.vehicles.buyTrain(f.dep, [M('diesel_b'), M('van_ic'), M('van_ic')], f.line.id) as Train;
  check(mt instanceof Train && mt.mailOnly && mt.capacity === 0 && mt.mailCapacity === 160, 'a mail train: vans only');
  check(mailFleet(f.g, f.line) === 'some', 'a mixed line: the mail fleet differs from the passenger fleet');
  const A = f.g.stations.get(f.pr.A.id)!;
  let paxPickupByMail = false, mailCalls = 0;
  runDays(f.g, 600, () => {
    if (mt.state === 'loading' && mt.atStation === A.id) { mailCalls++; if (A.lastPickup === f.g.day && f.train.atStation !== A.id && f.train.state !== 'loading') paxPickupByMail = true; }
  });
  console.log(`mail train: delivered ${mt.mailDelivered} units, ${mt.delivered} passengers; passenger train ${f.train.delivered}; calls at ${A.name} ${mailCalls}`);
  check(mt.mailDelivered > 0 && mt.delivered === 0 && mt.load === 0, 'the mail train delivers mail and never takes passengers');
  check(f.train.mailDelivered === 0 && f.train.mailLoad === 0, 'the passenger train carries no mail');
  check(!paxPickupByMail, "the mail train's calls do not count as passenger pickups");
  check(!!f.line.spacing?.['m0'], 'the mail train runs its own spacing clock (m0)');
  // full-load modes (for a later full-load order): mail-only trains wait for mail by default
  const load = mt.mailLoad;
  mt.mailLoad = mt.mailCapacity;
  check(isFull(mt) && isFull(mt, 'all') && isFull(mt, 'any') && !isFull(f.train) && isFull(f.train, 'mail') && !isFull(f.train, 'any'), 'full-load modes');
  mt.mailLoad = load;
}

// ---- postbus -> rail transfers through a stop linked to the station
{
  const f = vans;
  const g = f.g, A = g.stations.get(f.pr.A.id)!, TA = f.pr.TA;
  // a stop by the station (joined to it or linked for walking), and one across town
  let s2 = -1, s1 = -1, bd = -1;
  for (const e of g.towns.streets(TA, 0)) {
    // (every unit: since the walks were halved after 2.9 an intermediate change walks at most about 50 m)
    for (let s = 0.5; s < e.len && s2 < 0; s += 1) {
      const p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, s, p);
      const d = Math.hypot(p.x - A.x, p.z - A.z), bp = g.stations.planBusStop(p.x, p.z, 0);
      if (d >= 2 && d <= 16 && bp.ok && !bp.join && bp.links.some((st) => st.id === A.id)) { s2 = addBusStop(g, p.x, p.z, 0); if (s2 === A.id) s2 = -1; }
    }
    if (s2 >= 0) break;
  }
  // (since the walks were halved after 2.9 a separate stop rarely lies within the ~50 m intermediate walk while
  // clear of the 80 m in which a stop becomes part of the station: then a stop joined to it)
  if (s2 < 0) for (const e of g.towns.streets(TA, 0)) {
    for (let s = 0.5; s < e.len && s2 < 0; s += 1) {
      const p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, s, p);
      const bp = g.stations.planBusStop(p.x, p.z, 0);
      if (bp.ok && bp.join?.id === A.id && addBusStop(g, p.x, p.z, 0) >= 0 && A.stops.length) s2 = A.id;
    }
    if (s2 >= 0) break;
  }
  if (s2 >= 0 && s2 !== A.id && !g.stations.get(s2)!.links.includes(A.id)) g.stations.link(s2, A.id);
  // across town: in the town, away from the station, nearest the town centre (its own catchment)
  const across: [number, number, number][] = [];
  for (const e of g.towns.streets(TA, 0)) {
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    const d = Math.hypot(p.x - A.x, p.z - A.z), bp = g.stations.planBusStop(p.x, p.z, 0);
    if (d >= 24 && d <= 60 && bp.ok && !bp.join && !bp.links.length && g.towns.nearest(p.x, p.z)?.id === TA.id) across.push([p.x, p.z, Math.hypot(p.x - TA.x, p.z - TA.z)]);
  }
  across.sort((a, b) => a[2] - b[2]);
  if (across.length) { s1 = addBusStop(g, across[0][0], across[0][1], 0); bd = roadDepotNear(g, across[0][0], across[0][1], 0); }
  check(s1 >= 0 && s2 >= 0 && bd >= 0 && (s2 === A.id || g.stations.get(s2)!.links.includes(A.id)), `a stop joined or linked to ${A.name} and one across town`);
  if (s1 >= 0 && s2 >= 0 && bd >= 0) {
    const bl = g.lines.create('road', 0);
    bl.stops = [s1, s2];
    const pb = g.vehicles.buyRoad(bd, M('postbus_b'), bl.id) as RoadVehicle;
    check(pb instanceof RoadVehicle && pb.carries('pax') && pb.carries('mail') && !pb.mailOnly, 'a postbus: passengers and mail');
    const S1 = g.stations.get(s1)!, B = g.stations.get(f.pr.B.id)!;
    const hop = g.lines.mailNextHop(s1, B.id);
    check(!!hop && hop.line === bl.id, 'mail from across town to the other town: by postbus first');
    const toTown = g.mail.weights(S1).dest.map((id) => g.stations.get(id)!.townId);
    check(toTown.includes(B.townId), 'the stop across town posts mail to the other town');
    let postedS1 = 0, postedA = 0, deliveredB = 0, onPostbus = 0;
    const B0 = B.mail ? B.mail.arrivedMonth : 0;
    runDays(g, 540, () => {
      if (g.day % 30 === 0) { postedS1 += S1.mail?.genLast ?? 0; postedA += A.mail?.genLast ?? 0; deliveredB += B.mail?.arrivedLast ?? 0; }
      onPostbus = Math.max(onPostbus, pb.mailLoad);
    });
    console.log(`  across town: ${S1.name} catchPop ${fmt(S1.catchPop, 0)} mailPop ${fmt(g.mail.mailPop(S1), 0)} accepts ${g.mail.accepts(S1)} served ${fmt(g.mail.weights(S1).served, 3)} mail ${JSON.stringify(S1.mail && { ...S1.mail, waiting: undefined })}`);
    console.log(`transfers: posted across town ${postedS1}, at ${A.name} ${postedA}; delivered at ${B.name} ${deliveredB - B0} (postbus carried up to ${onPostbus} units; line ${JSON.stringify(bl.mail)})`);
    check(postedS1 > 0 && (bl.mail?.month ?? 0) + (bl.mail?.last ?? 0) + onPostbus > 0, 'the postbus carries mail posted across town');
    check(deliveredB - B0 > postedA, `the railway delivers more than its own station posted: postbus mail changed to the train (${deliveredB - B0} > ${postedA})`);
    // the station window's mail by town reads the queues of every origin (keys line:alight:dest:o) and creates nothing
    const rail = g.lines.mailNextHop(A.id, B.id)!, before = stationMail(g, A).total;
    addMail(g, A, rail.line, rail.alight, B.id, 3, newJourney(g, A, B.id));
    addMail(g, A, rail.line, rail.alight, B.id, 4, newJourney(g, S1, B.id));
    const keys = [...A.mail!.waiting.keys()].filter((k) => k.startsWith(`${rail.line}:${rail.alight}:${B.id}:`));
    const byTown = mailByTown(g, A.id), toB = byTown.find((e) => e.town === B.townId);
    check(keys.includes(`${rail.line}:${rail.alight}:${B.id}:${A.id}`) && keys.includes(`${rail.line}:${rail.alight}:${B.id}:${S1.id}`) && A.mail!.total === before + 7,
      'mail from two origins for the same leg waits in two groups (key line:alight:dest:origin)');
    check(byTown.reduce((n, e) => n + e.count, 0) === A.mail!.total && !!toB && toB.lines.reduce((n, x) => n + x.count, 0) === toB.count && new Set(byTown.map((e) => e.town)).size === byTown.length,
      `mail by destination town counts every group once (${byTown.map((e) => `${g.towns.list[e.town]?.name}: ${e.count}`).join(', ')})`);
    const quiet = [...g.stations.map.values()].find((st) => !st.mail);
    check(mailByTown(g, -1).length === 0 && (!quiet || (mailByTown(g, quiet.id).length === 0 && !quiet.mail)), 'mail by town of a station without mail is empty and creates no mail state');
  }
}

// ---- trams never
{
  check(availableModels(2000, 'tram', true).length === 0, 'no tram model carries mail');
}

// ---- queue cap, lost mail and the mail rating
{
  const g = vans.g, A = g.stations.get(vans.pr.A.id)!, m = stationMail(g, A);
  const hop = g.lines.mailNextHop(A.id, vans.pr.B.id)!;
  const lost0 = m.lostMonth, cap = mailQueueCap(g, A);
  check(cap === Math.floor(Math.min(MAIL_STATION.cap, MAIL_STATION.base + MAIL_STATION.perPop * g.mail.mailPop(A) + MAIL_STATION.perTrack * A.rail!.tracks + MAIL_STATION.perStop * A.stops.length)), `queue cap ${cap}`);
  addMail(g, A, hop.line, hop.alight, vans.pr.B.id, 1000, newJourney(g, A, vans.pr.B.id));
  const before = m.total;
  trimMail(g, A);
  check(m.total === cap && m.lostMonth - lost0 === before - cap, `over the cap: trimmed to ${cap}, ${before - cap} units lost`);
  check(mailLostShare(m) > 0, 'lost mail counts in the lost share');
  // no vehicle for a long time, a long queue and lost mail: the rating falls
  const r0 = m.rating;
  m.lastPickup = g.day - 100;
  g.mail.updateRating(A);
  check(m.rating < r0, `the rating falls after 100 days without a mail call and lost mail (${fmt(r0, 3)} -> ${fmt(m.rating, 3)})`);
}

// ---- recomposing: refused while running or on a short platform; paid and refunded
{
  const f = fixture([M('diesel_b'), M('coach_ic'), M('coach_ic')]);
  const g = f.g, t = f.train, eco = g.economy;
  check(t.onMap === false && g.vehicles.recompose(t, [M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic')]) === null, 'a van added in the depot');
  check(t.mailCapacity === 80 && t.value === M('diesel_b').cost + M('van_ic').cost + 2 * M('coach_ic').cost, 'the van is paid for and joins the train value');
  let running = false;
  runDays(g, 400, () => { if (!running && t.state === 'running') { running = true; check(g.vehicles.recompose(t, [M('diesel_b'), M('coach_ic')])?.includes('depot or at a platform') ?? false, 'no recomposing on the move'); } });
  while (t.state !== 'loading') g.stepTick();
  const st = g.stations.get(t.atStation)!;
  const long = [M('diesel_b'), M('van_ic'), ...Array(6).fill(M('coach_ic'))];
  check(long.reduce((s, c) => s + c.length + 0.1, 0) > st.rail!.length && (g.vehicles.recompose(t, long) ?? '').includes('does not fit'), `refused: ${long.length} cars do not fit the ${st.rail!.length}-unit platform`);
  // a second train with a van keeps mail running on the line
  check(g.vehicles.buyTrain(f.dep, [M('diesel_b'), M('van_ic'), M('coach_ic')], f.line.id) instanceof Train, 'a second train with a van');
  const money = eco.money, value = t.value, resale = g.vehicles.resaleValue(t);
  // mail aboard beyond the room of the shorter train is queued at the platform again
  const other = st.id === f.pr.A.id ? f.pr.B.id : f.pr.A.id;
  t.mailCargo.clear();
  t.mailCargo.set(`${st.id}:${other}:${other}:${st.id}`, { alight: other, dest: other, count: 30, from: st.id, ...newJourney(g, st, other) });
  t.mailLoad = 30;
  const queued = st.mail?.total ?? 0;
  check(g.vehicles.recompose(t, [M('diesel_b'), M('coach_ic'), M('coach_ic')]) === null, 'the van removed at the platform');
  check(t.mailCapacity === 0 && t.mailLoad === 0 && (st.mail?.total ?? 0) === queued + 30, 'its mail is queued at the platform again');
  check(Math.abs(eco.money - money - resale * M('van_ic').cost / value) < 1e-6 && t.value === value - M('van_ic').cost, 'refunded at the resale share of its price');
}

// ---- merged stations and lines keep their mail
{
  const g = vans.g;
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const pts: [number, number][] = [];
  for (const e of g.towns.streets(big, 0)) {
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    const bp = g.stations.planBusStop(p.x, p.z, 0);
    if (bp.ok && !bp.join && !bp.links.length) pts.push([p.x, p.z]);
  }
  let pair: [number, number] | null = null;
  outer: for (const a of pts) for (const b of pts) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d > 2 && d < 7) { const ia = addBusStop(g, a[0], a[1], 0), ib = addBusStop(g, b[0], b[1], 0); if (ia >= 0 && ib >= 0 && ia !== ib) { pair = [ia, ib]; break outer; } }
  }
  check(!!pair, 'two adjacent bus stops');
  if (pair) {
    const [ia, ib] = pair, a = g.stations.get(ia)!, b = g.stations.get(ib)!, B = vans.pr.B.id;
    addMail(g, b, vans.line.id, vans.pr.A.id, B, 12, newJourney(g, b, B));
    stationMail(g, b).genMonth += 5;
    const genA = stationMail(g, a).genMonth;
    const res = mergeStops(g, ia, ib);
    check(!res.error && !g.stations.get(ib) && a.mail?.genMonth === genA + 5, `merged stops: b's mail figures join a's (${res.error ?? 'ok'})`);
    check(!b.mail, "b's mail state moves");
  }
  // a second line on the same route merges into the first as a service pattern; mail waiting for it follows
  const l2 = g.lines.create('rail', 0);
  l2.stops = [...vans.line.stops];
  const t2 = g.vehicles.buyTrain(vans.dep, [M('diesel_b'), M('van_ic'), M('coach_ic')], l2.id) as Train;
  const A = g.stations.get(vans.pr.A.id)!;
  addMail(g, A, l2.id, vans.pr.B.id, vans.pr.B.id, 7, newJourney(g, A, vans.pr.B.id));
  (l2.mail ??= { month: 0, last: 0, incomeYear: 0, incomeLast: 0 }).incomeYear += 1000;
  const inc = vans.line.mail?.incomeYear ?? 0;
  const merged = canonicalizeLines(g, l2.id);
  const survivor = g.lines.get(l2.id)!;
  const w = [...(A.mail?.waiting.values() ?? [])].filter((x) => x.line === survivor.id && x.dest === vans.pr.B.id);
  check(merged.length === 1 && survivor.id === vans.line.id && t2.lineId === survivor.id, 'the second line merged into the first');
  check(![...(A.mail?.waiting.values() ?? [])].some((x) => x.line === l2.id) && w.reduce((n, x) => n + x.count, 0) >= 7, 'mail waiting for the merged line waits for the surviving line');
  check((survivor.mail?.incomeYear ?? 0) === inc + 1000, 'line mail figures merged');
}

// ---- exact replay with mail (vans, a mail train, a postbus with transfers, merged stations and lines)
{
  const g = vans.g;
  g.vehicles.buyTrain(vans.dep, [M('diesel_b'), M('van_ic'), M('van_ic')], vans.line.id);
  runDays(g, 60);
  const json = JSON.stringify(serialize(g)), g2 = deserialize(JSON.parse(json));
  check(JSON.stringify(serialize(g2)) === json, 'a save with mail re-serializes identically');
  let same = true, day = 0;
  for (; day < 240 && same; day++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) { g.stepTick(); g2.stepTick(); }
    if (day % 30 === 29) same = JSON.stringify(serialize(g)) === JSON.stringify(serialize(g2));
  }
  const w = [...g.stations.map.values()].reduce((n, st) => n + (st.mail?.total ?? 0), 0), a = g.vehicles.all().reduce((n, v) => n + v.mailLoad, 0);
  console.log(`replay: ${day} days compared, mail waiting ${w}, aboard ${a}, delivered ${g.vehicles.all().reduce((n, v) => n + v.mailDelivered, 0)}`);
  check(same && day === 240, 'a game with mail replays exactly after loading (240 days, saves every 30)');
}

// ---- mail only (no passenger vehicle at all): mail trucks between two towns; exact replay
{
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  g.economy.money = 1e9;
  const stopNear = (t: (typeof g.towns.list)[number]): [number, number] | null => {
    const pts: [number, number, number][] = [];
    for (const e of g.towns.streets(t, 0)) {
      const p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, e.len / 2, p);
      const bp = g.stations.planBusStop(p.x, p.z, 0);
      if (bp.ok && !bp.join && g.towns.nearest(p.x, p.z)?.id === t.id) pts.push([p.x, p.z, Math.hypot(p.x - t.x, p.z - t.z)]);
    }
    pts.sort((a, b) => a[2] - b[2]);
    return pts.length ? [pts[0][0], pts[0][1]] : null;
  };
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop);
  let made: { line: number; trucks: RoadVehicle[] } | null = null;
  outer: for (const A of big) for (const B of big) {
    const d = Math.hypot(A.x - B.x, A.z - B.z);
    if (A.id === B.id || d < 60 || d > 160) continue;
    const sa = stopNear(A), sb = stopNear(B);
    if (!sa || !sb) continue;
    const ia = addBusStop(g, sa[0], sa[1], 0), ib = addBusStop(g, sb[0], sb[1], 0), dep = roadDepotNear(g, sa[0], sa[1], 0);
    if (ia < 0 || ib < 0 || ia === ib || dep < 0) continue;
    const l = g.lines.create('road', 0);
    l.stops = [ia, ib];
    const trucks = [0, 1].map(() => g.vehicles.buyRoad(dep, M('mailtruck_b'), l.id)).filter((v): v is RoadVehicle => v instanceof RoadVehicle);
    made = { line: l.id, trucks };
    break outer;
  }
  check(!!made && made.trucks.length === 2 && made.trucks.every((v) => v.mailOnly), 'a mail-truck line between two towns');
  if (made) {
    runDays(g, 240);
    const delivered = made.trucks.reduce((n, v) => n + v.mailDelivered, 0);
    console.log(`mail trucks: delivered ${delivered} units, passengers ${made.trucks.reduce((n, v) => n + v.delivered, 0)}; passenger routing ${g.lines.routing.size} stations, mail ${g.lines.mailRouting.size}`);
    check(g.lines.routing.size === 0 && g.lines.mailRouting.size === 2 && delivered > 0, 'mail flows without any passenger service');
    const json = JSON.stringify(serialize(g)), g2 = deserialize(JSON.parse(json));
    check(JSON.stringify(serialize(g2)) === json, 'the mail-only save re-serializes identically');
    let same = true, day = 0;
    for (; day < 240 && same; day++) {
      for (let k = 0; k < TICKS_PER_DAY; k++) { g.stepTick(); g2.stepTick(); }
      if (day % 30 === 29) same = JSON.stringify(serialize(g)) === JSON.stringify(serialize(g2));
    }
    check(same && day === 240, 'a mail-only game replays exactly after loading (240 days, saves every 30)');
  }
}

// ---- journeys: priced once, by the whole journey (distance from where it was posted, time since then, x 0.9 per change),
// shared by the legs by the distances they carried; splitting a journey never earns more than carrying it direct
{
  /** A flat map with one straight street and mail stops on it; mail trucks on lines between stops (they stay in the depot). */
  const straight = (stopsX: number[], lines: [number, number][]) => {
    const h = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000 });
    h.aiEnabled = false; h.world.h.fill(4); h.world.heightsVersion++;
    const net = h.world.net, a = net.addNode('road', 20, 4, 60, 0, 0, -1), b = net.addNode('road', 220, 4, 60, 0, 0, -1);
    net.addEdge('road', a.id, b.id, bezLine(20, 60, 220, 60), new Float32Array(201).fill(4), [], 'street', -1);
    // A payable delivery now needs an accepting destination: real walking residents at these served stops.
    for (const x of stopsX) h.world.addBuilding({ townId: -1, x, z: 59.6, angle: 0, w: 0.8, d: 0.8, type: 0, floors: 2, pop: 1000, seed: 1, y: 4, built: 0 });
    h.economy.money = 1e8;
    const ids = stopsX.map((x) => addBusStop(h, x, 60, 0)), dep = roadDepotNear(h, 100, 60, 0);
    const trucks = lines.map(([i, j]) => {
      const l = h.lines.create('road', 0);
      l.stops = [ids[i], ids[j]];
      return h.vehicles.buyRoad(dep, M('mailtruck_c'), l.id) as RoadVehicle;
    });
    h.flushNetworkChanges(); h.lines.flushCatchment();
    check(ids.filter((id) => h.lines.mailServed(id)).every((id) => h.mail.accepts(h.stations.get(id)!)), 'straight-street fare fixture: every served destination accepts mail');
    return { h, ids, trucks, ok: ids.every((id) => id >= 0) && dep >= 0 && trucks.every((t) => t instanceof RoadVehicle) };
  };
  const at = (h: Game, seconds: number) => { h.tick = Math.round(seconds / h.tickSeconds); };
  // Absorption can give an unserved target its source's mail service. Check acceptance after that service moves.
  const merged = straight([40, 46, 140], [[1, 2]]);
  if (merged.ok) {
    const { h, ids, trucks } = merged, A = h.stations.get(ids[0])!, B = h.stations.get(ids[1])!, D = h.stations.get(ids[2])!, t = trucks[0];
    check(A.id !== B.id && !h.mail.accepts(A) && h.mail.accepts(B), 'accepting absorption: target will inherit the source mail service');
    at(h, 200);
    const j = { ...newJourney(h, D, B.id), legs: [[t.id, t.line!.id, t.owner, 94] as [number, number, number, number]] };
    addMail(h, A, t.line!.id, B.id, B.id, 10, j);
    const income = h.economy.thisYear.mailIncome;
    at(h, 1000);
    const res = mergeStops(h, A.id, B.id);
    check(!res.error && h.mail.accepts(A) && A.mail?.arrivedMonth === 10 && A.mail.lostMonth === 0,
      'accepting absorption: merged service and geometry are ready before settlement');
    check(Math.abs(h.economy.thisYear.mailIncome - income - mailFare(j.od, 800, 10)) < 1e-6,
      'accepting absorption: legitimate mail still pays its whole journey fare once');
  }
  /** Post 10 units at the first stop at 200 s, ride `legs` ([truck, from, to, start s, end s]); the trucks' receipts. */
  const journey = (w: ReturnType<typeof straight>, dest: number, legs: [number, number, number, number, number][], save?: number) => {
    let { h } = w;
    at(h, 200);
    const S0 = h.stations.get(w.ids[0])!, hop = h.lines.mailNextHop(S0.id, w.ids[dest])!;
    h.stations.addMail(S0, hop.line, hop.alight, w.ids[dest], 10);
    legs.forEach(([k, a, b, t0, t1], i) => {
      if (i === save) h = deserialize(JSON.parse(JSON.stringify(serialize(h))));
      const v = h.vehicles.get(w.trucks[k].id)!;
      at(h, 200 + t0); loadMail(h, v, h.stations.get(w.ids[a])!);
      at(h, 200 + t1); unloadMail(h, v, h.stations.get(w.ids[b])!);
    });
    return { income: w.trucks.map((t) => h.vehicles.get(t.id)!.incomeYear), company: h.economy.thisYear.mailIncome, delivered: h.stations.get(w.ids[dest])!.mail?.arrivedMonth ?? 0 };
  };
  const X = [40, 65, 90, 115, 140];
  const direct = straight(X, [[0, 4]]), split = straight(X, [[0, 1], [1, 2], [2, 3], [3, 4]]), split2 = straight(X, [[0, 1], [1, 2], [2, 3], [3, 4]]);
  const feeder = straight([40, 45, 140], [[0, 1], [1, 2]]);
  check(direct.ok && split.ok && split2.ok && feeder.ok, 'straight-street fixtures');
  if (direct.ok && split.ok && split2.ok && feeder.ok) {
    const fare = (changes: number) => mailFare(100, 1000, 10, changes);
    const d = journey(direct, 4, [[0, 0, 4, 0, 1000]]);
    const sp = journey(split, 4, [[0, 0, 1, 0, 250], [1, 1, 2, 250, 500], [2, 2, 3, 500, 750], [3, 3, 4, 750, 1000]]);
    const sv = journey(split2, 4, [[0, 0, 1, 0, 250], [1, 1, 2, 250, 500], [2, 2, 3, 500, 750], [3, 3, 4, 750, 1000]], 2);
    const fd = journey(feeder, 2, [[0, 0, 1, 900, 950], [1, 1, 2, 950, 1000]]);
    const sum = (x: number[]) => x.reduce((a, b) => a + b, 0);
    console.log(`journeys of 10 units over 1 km in 1000 s: direct ${fmt(d.company, 1)}, four legs ${fmt(sp.company, 1)} (${sp.income.map((x) => fmt(x, 1)).join(' / ')}), 50 m feeder after 900 s then the trunk ${fmt(fd.company, 1)} (${fd.income.map((x) => fmt(x, 1)).join(' / ')})`);
    check(Math.abs(d.company - fare(0)) < 1e-6 && d.delivered === 10, `direct: the journey fare (${fmt(fare(0), 1)})`);
    check(Math.abs(sp.company - fare(3)) < 1e-6 && Math.abs(sum(sp.income) - sp.company) < 1e-6 && sp.company < d.company, `four legs: the same journey x 0.9^3 (${fmt(sp.company / d.company, 3)} of direct), never more`);
    check(sp.income.every((x) => Math.abs(x - sp.company / 4) < 1e-6), 'the legs share the receipts by the distances they carried (a quarter each)');
    check(Math.abs(fd.company - fare(1)) < 1e-6 && Math.abs(fd.income[0] - fd.company * 0.05) < 1e-6 && Math.abs(fd.income[1] - fd.company * 0.95) < 1e-6, `a short feeder after a long wait: the journey keeps its age (${fmt(fd.company / d.company, 3)} of direct; feeder 5%, trunk 95%)`);
    check(sv.income.every((x, i) => x === sp.income[i]) && sv.company === sp.company, 'a journey saved halfway pays exactly the same (journey state in the saves)');
  }
}

// ---- mail catchments by mail service alone: a passenger bus beside mail-only stops takes none of their mail
{
  const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 2000 });
  g.economy.money = 1e9;
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const sites = busStopSites(g, big, 0, 16, 30);
  const P = sites.map(([x, z]) => addBusStop(g, x, z, 0));
  /** A street point 4.5-9 units from (x, z) where a separate stop fits. */
  const beside = (x: number, z: number): [number, number] | null => {
    for (const e of g.towns.streets(big, 0)) for (let s = 0.5; s < e.len; s += 1) {
      const p = { x: 0, y: 0, z: 0 };
      g.world.net.pointAt(e, s, p);
      const d = Math.hypot(p.x - x, p.z - z), bp = d >= 4.5 && d <= 9 ? g.stations.planBusStop(p.x, p.z, 0) : null;
      if (bp?.ok && !bp.join) return [p.x, p.z];
    }
    return null;
  };
  const near = sites.map(([x, z]) => beside(x, z));
  const Mids = near.map((q) => (q ? addBusStop(g, q[0], q[1], 0) : -1));
  const dep = sites.length ? roadDepotNear(g, sites[0][0], sites[0][1], 0) : -1;
  check(P.length === 2 && P.every((id) => id >= 0) && Mids.every((id) => id >= 0 && !P.includes(id)) && dep >= 0, 'passenger stops and mail-only stops beside them');
  if (P.length === 2 && Mids.every((id) => id >= 0 && !P.includes(id)) && dep >= 0) {
    const pl = g.lines.create('road', 0);
    pl.stops = P;
    const bus = g.vehicles.buyRoad(dep, M('bus_c'), pl.id) as RoadVehicle;
    runDays(g, 3);
    const shares = (id: number) => JSON.stringify(g.stations.buildingShares(id));
    const before = P.map((id) => [g.stations.get(id)!.catchPop, shares(id)]);
    const ml = g.lines.create('road', 0);
    ml.stops = Mids;
    check(g.vehicles.buyRoad(dep, M('mailtruck_c'), ml.id) instanceof RoadVehicle, 'a mail truck on the mail-only stops');
    runDays(g, 3);
    check(P.every((id, i) => g.stations.get(id)!.catchPop === before[i][0] && shares(id) === before[i][1]), 'mail service leaves the passenger catchments exactly as they were');
    const mailPops = () => Mids.map((id) => g.mail.mailPop(g.stations.get(id)!));
    const withBus = mailPops();
    g.vehicles.sell(bus.id);
    const withoutBus = mailPops();
    console.log(`mail-only stops beside a passenger bus: mail population ${withBus.map((x) => fmt(x, 1)).join(' / ')} with the bus, ${withoutBus.map((x) => fmt(x, 1)).join(' / ')} without`);
    check(withBus.every((x, i) => x === withoutBus[i]), 'passenger service takes nothing from the mail catchments');
    check(Mids.every((id) => g.mail.accepts(g.stations.get(id)!)), 'the mail-only stops accept mail');
  }
}

// ---- mail feeders follow the mail service (as the passengers' car feeders follow theirs); a single line's capture
{
  const f = fixture([M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic')]);
  const g = f.g, A = g.stations.get(f.pr.A.id)!, B = g.stations.get(f.pr.B.id)!;
  const mailPops = () => [A, B].map((st) => g.mail.mailPop(st));
  runDays(g, 2);
  const sparse = mailPops(), paxSparse = [A, B].map((st) => g.demand.generationPopulation(st));
  const buy = (cars: VehicleModel[]) => check(g.vehicles.buyTrain(f.dep, cars, f.line.id) instanceof Train, 'another train bought');
  buy([M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')]); buy([M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')]);
  runDays(g, 2);
  const paxOnly = mailPops(), paxFrequent = [A, B].map((st) => g.demand.generationPopulation(st));
  buy([M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic')]); buy([M('diesel_b'), M('van_ic'), M('coach_ic'), M('coach_ic')]);
  runDays(g, 2);
  const frequent = mailPops();
  console.log(`mail feeders: mail population ${sparse.map((x) => fmt(x, 0)).join(' / ')} with one van train, ${paxOnly.map((x) => fmt(x, 0)).join(' / ')} with two more passenger trains (passengers ${paxSparse.map((x) => fmt(x, 0)).join(' / ')} -> ${paxFrequent.map((x) => fmt(x, 0)).join(' / ')}), ${frequent.map((x) => fmt(x, 0)).join(' / ')} with three van trains`);
  check(sparse.every((x, i) => x === paxOnly[i]) && paxFrequent.some((x, i) => x > paxSparse[i]), 'passenger trains bring passengers car feeders, and the mail none');
  check(frequent.some((x, i) => x > paxOnly[i]) && frequent.every((x, i) => x >= paxOnly[i]), 'frequent mail trains bring the mail feeders of the town');
  const { n, share } = g.mail.townShares(), s = share[A.townId * n + B.townId], hop = g.lines.mailNextHop(A.id, B.id)!, w = g.mail.weights(A);
  const capture = MAIL_CAPTURE.floor + (1 - MAIL_CAPTURE.floor) * Math.min(1, s / MAIL_CAPTURE.full);
  const tf = mailTripFactor(Math.hypot(B.x - A.x, B.z - A.z), hop.cost);
  check(w.dest.length === 1 && w.dest[0] === B.id && Math.abs(w.served - capture * tf) < 1e-12, `a line to one town that receives ${fmt(100 * s, 1)}% of the mail posts ${fmt(capture, 3)} x the trip factor (${fmt(w.served, 3)})`);
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
