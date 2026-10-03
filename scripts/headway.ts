// Headway audit. Bundle as headway.mjs in the scratch directory, then run with node there.
// --baseline records the unregulated simulation before implementation; --quick skips full AI games.
import { writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { Vehicle } from '../src/game/vehicle';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { Lines, outAndBack, type Line } from '../src/game/lines';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { simNow } from '../src/game/fares';
import { nextStopIndex, patternOf, patternHeadway, vehiclesByPattern, holdForSpacing, spacingSchedule, isTimingPoint, SPACING_HOLD, setVehiclePattern } from '../src/game/patterns';
import { autoSignalLine } from '../src/game/signals';
import { planDoubleTrack, commitDoubleTrack, connectStationThroat, finishDoubleTrack } from '../src/game/trackops';
import { busStopSites, addBusStop, roadDepotNear, check, fails, checkReservations } from './lib';
import { flatGame, station, endNode, newTrack, loco, depotFor, build, railOpts, nodeSnap } from './stationlib';

const baseline = process.argv.includes('--baseline');
const quick = process.argv.includes('--quick');
const mean = (xs: number[]) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const cv = (xs: number[]) => { const m = mean(xs); return m > 0 ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / m : 0; };
const fmt = (n: number) => n.toFixed(3);
interface Arrival { time: number; vehicle: number; line: number; key: string; station: number; multi: boolean; kind: string }
interface Audit { g: Game; arrivals: Arrival[]; deliveries: number[]; blockedHolds: number; releases: Map<number, number>; worstWait: number }
let active: Audit | undefined;
const serve = Vehicle.prototype.serveStation;
Vehicle.prototype.serveStation = function (st, perPax) {
  const l = this.line;
  if (active && l) {
    const pid = patternOf(l, this.pattern)?.id ?? 0;
    const next = l.stops[nextStopIndex(l, this.pattern, this.stopIndex)];
    const fleet = vehiclesByPattern(active.g, l).get(pid) ?? [];
    active.arrivals.push({ time: simNow(active.g), vehicle: this.id, line: l.id, station: st.id, kind: l.kind,
      multi: fleet.length >= 2,
      key: `${l.id}:${pid}:${st.id}:${next}:${l.stops.join(',')}:${fleet.map((v) => v.id).join(',')}` });
  }
  const before = this.delivered, dwell = serve.call(this, st, perPax);
  if (active) active.deliveries[this.owner] = (active.deliveries[this.owner] ?? 0) + this.delivered - before;
  return dwell;
};
// Check the safety decision at each vehicle's update, including its physical road queue at that instant.
for (const prototype of [Train.prototype, RoadVehicle.prototype]) {
  const update = prototype.update;
  prototype.update = function (dt) {
    const blocked = active?.g.vehicles.spacingBlocked(this) ?? false;
    update.call(this, dt);
    if (active && blocked && this.status === 'Holding for even spacing') active.blockedHolds++;
  };
}

function gaps(arrivals: Arrival[], since: number, stationId?: number, minGaps = 5) {
  const groups = new Map<string, number[]>();
  for (const a of arrivals) {
    if (a.time < since || (stationId !== undefined && a.station !== stationId)) continue;
    const ts = groups.get(a.key) ?? []; ts.push(a.time); groups.set(a.key, ts);
  }
  return [...groups].map(([key, ts]) => ({ key, gaps: ts.slice(1).map((t, i) => t - ts[i]) })).filter((s) => s.gaps.length >= minGaps);
}

function run(g: Game, days: number): Audit {
  const audit: Audit = { g, arrivals: [], deliveries: [], blockedHolds: 0, releases: new Map(), worstWait: 0 }; active = audit;
  const waiting = new Map<number, number>();
  while (g.day < days) {
    g.stepTick();
    const now = simNow(g);
    for (const v of g.vehicles.map.values()) {
      if (v.status === 'Holding for even spacing' && g.vehicles.spacingBlocked(v)) audit.blockedHolds++;
      if ((v instanceof Train ? v.onMap : (v as RoadVehicle).onMap) && !audit.releases.has(v.id)) audit.releases.set(v.id, now);
      if (v.state === 'waiting' || v.state === 'noroute') {
        const start = waiting.get(v.id) ?? now; waiting.set(v.id, start);
        audit.worstWait = Math.max(audit.worstWait, now - start);
      } else waiting.delete(v.id);
    }
  }
  active = undefined;
  check(audit.blockedHolds === 0, 'no spacing hold while another vehicle waits behind / for its platform');
  return audit;
}

function busFixture(spacing: boolean) {
  const g = Game.create({ size: 512, seed: 23, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  g.economy.money = 40_000_000;
  const town = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const sites = busStopSites(g, town, 0, 25, 60);
  if (sites.length !== 2) throw new Error('Seed 23 bus stop fixture missing');
  const stops = sites.map(([x, z]) => addBusStop(g, x, z, 0));
  const depot = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const l = g.lines.create('road'); l.stops = stops; l.evenSpacing = spacing;
  const buses = Array.from({ length: 3 }, () => g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, l.id));
  if (buses.some((v) => typeof v === 'string')) throw new Error('Seed 23 bus purchase failed');
  return { g, l, stops, buses: buses as RoadVehicle[] };
}

function bus(spacing: boolean) {
  const { g, l, stops, buses } = busFixture(spacing);
  const H = patternHeadway(g, l);
  const audit = run(g, 720);
  const last = gaps(audit.arrivals, 720, stops[0])[0]?.gaps ?? [];
  const deliveries = buses.map((v) => v.delivered);
  const ts = audit.arrivals.filter((a) => a.station === stops[0]).map((a) => a.time);
  const all = ts.slice(1).map((t, i) => t - ts[i]);
  const windows = all.slice(5).map((_, i) => cv(all.slice(i, i + 6)));
  const settled = windows.findIndex((_, i) => windows.slice(i).every((n) => n < 0.25));
  const settledAt = settled >= 0 ? ts[settled + 6] : Infinity;
  const cycle = mean(last) * buses.length;
  const releases = buses.map((v) => audit.releases.get(v.id)!);
  const result = { H, cv: cv(last), gaps: last, settledAt, settledCycles: settledAt / cycle, deliveries, total: deliveries.reduce((a, b) => a + b, 0), releases };
  console.log(`bus ${spacing ? 'on' : 'off'}: H=${fmt(H)}s, last-year CV=${fmt(result.cv)}, deliveries=${deliveries.join('/')} total=${result.total}; settled by ${fmt(result.settledCycles)} cycles, releases=${releases.map(fmt).join('/')}s`);
  if (spacing) {
    check(last.length >= 12 && result.cv < 0.25, 'bus headway CV < 0.25 in the final year');
    check(result.settledCycles <= 4, 'six-gap rolling CV falls below 0.25 within four cycles and stays there');
    check(Math.max(...deliveries) <= 1.5 * Math.min(...deliveries), 'lifetime deliveries per bus within a factor of 1.5');
    check(releases.slice(1).every((t, i) => t - releases[i] >= H), 'depot releases staggered by at least H');
  }
  return result;
}

/** Existing fleets in an old save must recover too, without another depot launch. */
function busRecovery() {
  const { g, l, stops, buses } = busFixture(false);
  run(g, 180);
  const before = buses.map((v) => v.delivered);
  g.lines.setEvenSpacing(l.id, true);
  const audit = run(g, 900);
  const last = gaps(audit.arrivals, simNow(g) - 720, stops[0])[0]?.gaps ?? [];
  const deliveries = buses.map((v, i) => v.delivered - before[i]);
  const result = { cv: cv(last), deliveries };
  console.log(`existing bus fleet: final-year CV=${fmt(result.cv)}, deliveries after enabling=${deliveries.join('/')}`);
  check(last.length >= 12 && result.cv < 0.25, 'an existing bunched fleet recovers without depot dispatch');
  check(Math.max(...deliveries) <= 1.5 * Math.min(...deliveries), 'existing fleet deliveries balance after enabling spacing');
  return result;
}

function rail(spacing: boolean, double: boolean) {
  const g = flatGame(256); g.vehicles.ambientEnabled = false;
  const net = g.world.net;
  const A = station(g, 20, 128, Math.PI / 2, 8, 2)!, B = station(g, 236, 128, Math.PI / 2, 8, 2)!;
  const first = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, double ? 2 : 1));
  if (double) {
    check(!finishDoubleTrack(g, newTrack(g, first), 0).error, 'double track finished');
  } else {
    const z = net.nodes.get(endNode(g, A, 0, true))!.z;
    for (const x of [70, 110, 146, 186]) { const ne = net.nearestEdge(x, z, 0.5, 'rail')!; net.splitEdge(ne.edge.id, ne.s); }
    for (const x of [90, 166]) {
      const ne = net.nearestEdge(x, z, 0.5, 'rail')!;
      check(!commitDoubleTrack(g, planDoubleTrack(g, [ne.edge.id], 1, 0), false).error, 'passing loop built');
    }
    for (const st of [A, B]) connectStationThroat(g, st.id, 0);
  }
  const l = g.lines.create('rail'); l.stops = [A.id, B.id]; l.evenSpacing = spacing;
  if (!double) autoSignalLine(g, l.id, 0);
  const depot = depotFor(g, A, B);
  const trains = Array.from({ length: 3 }, () => g.vehicles.buyTrain(depot, loco(), l.id) as Train);
  const audit = run(g, 1440);
  const samples = gaps(audit.arrivals, 2160);
  const counts = trains.map((t) => audit.arrivals.filter((a) => a.vehicle === t.id).length);
  const result = { cv: mean(samples.map((s) => cv(s.gaps))), counts, H: patternHeadway(g, l), worstWait: audit.worstWait, blockedHolds: audit.blockedHolds };
  console.log(`rail ${double ? 'double' : 'single+loops'} ${spacing ? 'on' : 'off'}: H=${fmt(result.H)}s, CV=${fmt(result.cv)}, visits=${counts.join('/')}, worst path wait=${fmt(audit.worstWait)}s, unsafe holds=${audit.blockedHolds}`);
  check(counts.every((n) => n >= 15), 'each train keeps shuttling');
  check(audit.worstWait < 90, 'no train deadlocked for 90 simulation seconds');
  if (spacing) check(samples.length >= 2 && result.cv < 0.25, 'rail headway CV < 0.25 at both termini');
  check(checkReservations(g).length === 0, 'rail reservations consistent');
  if (spacing) replay(g, double ? 'double-track regulation' : 'single-track regulation');
  return result;
}

function ai(seed: number, spacing: boolean) {
  const g = Game.create({ size: 512, seed, towns: Math.round(512 / 38), hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 3 });
  const create = g.lines.create.bind(g.lines);
  g.lines.create = (kind, owner) => { const l = create(kind, owner); l.evenSpacing = spacing; return l; };
  const started = performance.now();
  const audit = run(g, 1440);
  // Last two years, including lines later sold or merged. Require three measured gaps per channel; do not
  // report CV=0 for absent samples, or mix visits made while a pattern had only one vehicle into its headway.
  const multi = audit.arrivals.filter((a) => a.multi && a.time >= 1440);
  const samples = gaps(multi, 1440, undefined, 3);
  const ids = [...new Set(multi.map((a) => a.line))];
  const lines = ids.map((id) => ({ id, kind: multi.find((a) => a.line === id)!.kind,
    cv: mean(samples.filter((s) => s.key.startsWith(`${id}:`)).map((s) => cv(s.gaps))),
    samples: samples.filter((s) => s.key.startsWith(`${id}:`)).reduce((a, s) => a + s.gaps.length, 0) })).filter((l) => l.samples > 0);
  // Count real destination deliveries over the entire run, including vehicles/lines sold by the AI.
  const deliveries = g.companies.slice(1).map((c) => audit.deliveries[c.id] ?? 0);
  const money = g.companies.slice(1).map((c) => Math.round(c.economy.money));
  const result = { seed, cv: mean(lines.map((l) => l.cv)), lines, deliveries, total: deliveries.reduce((a, b) => a + b, 0), money };
  console.log(`AI seed ${seed} ${spacing ? 'on' : 'off'} (${((performance.now() - started) / 1000).toFixed(1)}s): CV=${fmt(result.cv)} (${lines.length} lines), delivered=${result.total} [${deliveries.join('/')}], money=[${money.join('/')}]`);
  console.log(`  CV by mode: ${['road', 'tram', 'rail'].map((kind) => {
    const ls = lines.filter((l) => l.kind === kind); return `${kind} ${ls.length ? fmt(mean(ls.map((l) => l.cv))) : 'n/a'}`;
  }).join(', ')}`);
  check(lines.length > 0, `AI seed ${seed}: measured multi-vehicle headways`);
  check(checkReservations(g).length === 0, `AI seed ${seed}: reservations consistent`);
  return result;
}

function replay(g: Game, label: string) {
  const saved = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(saved));
  check(JSON.stringify(serialize(loaded)) === saved, `${label}: exact JSON round trip`);
  for (let i = 0; i < 1200; i++) { g.stepTick(); loaded.stepTick(); }
  check(JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)), `${label}: exact continuation for 60 simulation seconds`);
}

function rulesAndSaves() {
  console.log('holding/release rules, topology, defaults, and exact save replay');
  const { g, l, buses } = busFixture(true);
  g.stepTick();
  check(buses.some((v) => v.status === 'Waiting to depart (spacing)'), 'simultaneous purchase waits in the depot');
  replay(g, 'depot spacing wait');
  const limit = g.tick + Math.ceil(400 / g.tickSeconds);
  while (g.tick < limit && !buses.some((v) => v.status === 'Holding for even spacing')) g.stepTick();
  check(buses.some((v) => v.status === 'Holding for even spacing'), 'fixture exercises an actual spacing hold');
  const held = buses.find((v) => v.status === 'Holding for even spacing')!;
  const st = held.targetStation()!;
  const dest = l.stops[nextStopIndex(l, held.pattern, held.stopIndex)];
  const load = held.load, delivered = held.delivered, income = held.incomeYear, mark = held.opMark;
  g.stations.addWaiting(st, l.id, dest, dest, 1, 0, simNow(g));
  held.continueBoarding(1);
  check(held.load > load, 'new passengers board during a spacing hold');
  check(held.delivered === delivered && held.incomeYear === income && held.opMark === mark, 'hold boarding never repeats unloading, fares or arrival accounting');
  replay(g, 'active spacing hold');

  const v = buses[0], other = buses[1];
  const H = patternHeadway(g, l), now = simNow(g);
  const schedule = spacingSchedule(g, v)!;
  const key = `${l.stops[v.stopIndex]}:${l.stops[nextStopIndex(l, v.pattern, v.stopIndex)]}`;
  schedule.clock.departures[key] = { at: now, vehicle: other.id };
  v.resetSpacing();
  // No road body is needed for the pure timing rules; the physical queue rule is exercised below.
  const oldSeg = v.seg; v.seg = null;
  check(holdForSpacing(g, v), 'early vehicle holds after a recent departure');
  check(v.spacing.until === now + SPACING_HOLD * H, 'hold deadline uses simulation seconds and 0.6H');
  g.tick = Math.ceil(v.spacing.until / g.tickSeconds);
  schedule.clock.departures[key].at = simNow(g);
  check(!holdForSpacing(g, v) && !holdForSpacing(g, v), 'fresh departures cannot extend / restart an expired hold');
  v.resetSpacing();
  schedule.clock.departures[key].at = simNow(g) - H;
  check(!holdForSpacing(g, v), 'late vehicle never waits');
  v.seg = oldSeg;

  // Real stationary vehicles on one lane, with a bus queued 0.2 units behind the held bus's rear.
  while (g.tick < limit * 2 && !(v.state === 'loading' && v.seg && v.pos > v.length + 0.3)) g.stepTick();
  check(v.state === 'loading' && !!v.seg, 'physical road queue fixture reaches a stop');
  if (v.seg) {
    other.placeAt(v.seg, v.pos - v.length - 0.2); other.speed = 0; other.state = 'running';
    g.vehicles.noteOnRoad(other);
    const queueKey = `${l.stops[v.stopIndex]}:${l.stops[nextStopIndex(l, v.pattern, v.stopIndex)]}`;
    spacingSchedule(g, v)!.clock.departures[queueKey] = { at: simNow(g), vehicle: other.id };
    v.resetSpacing();
    check(g.vehicles.spacingBlocked(v) && !holdForSpacing(g, v), 'release immediately for a bus queued behind at the stop');
  }
  g.lines.setEvenSpacing(l.id, false);
  check(!holdForSpacing(g, v) && !g.vehicles.waitForSpacingRelease(other), 'toggle off releases both kinds of wait');
  check(!l.spacing && buses.every((b) => b.spacing.until < 0), 'toggle clears obsolete clocks and hold deadlines');
  const { evenSpacing: _setting, spacing: _clocks, ...oldLine } = l;
  check(Lines.restore(oldLine).evenSpacing === true, 'old saves default Even spacing on');
  check(Lines.restore(l).evenSpacing === false, 'disabled line setting survives saves');
  check(g.lines.create('rail', 1).evenSpacing === true, 'AI-created lines default Even spacing on');

  const loop: Line = { ...l, loop: true, stops: [10, 11, 12], patterns: undefined };
  check(isTimingPoint(loop, undefined, 0) && !isTimingPoint(loop, undefined, 1), 'loop regulates its first stop');
  loop.patterns = [{ id: 1, name: 'Skip first', kind: 'rapid', stops: [false, true, true] }];
  check(isTimingPoint(loop, 1, 1) && !isTimingPoint(loop, 1, 0), 'loop pattern regulates its first served stop');
  const short = { ...l, loop: false, stops: outAndBack([10, 11, 12, 13]),
    patterns: [{ id: 1, name: 'Short turn', kind: 'local' as const, stops: [false, true, true, false, true, true] }] };
  check(isTimingPoint(short, 1, 1) && isTimingPoint(short, 1, 2) && isTimingPoint(short, 1, 4) && isTimingPoint(short, 1, 5), 'short-turn pattern regulates both turning stations');

  const railGame = flatGame();
  const A = station(railGame, 30, 128, Math.PI / 2, 8, 2)!, B = station(railGame, 220, 128, Math.PI / 2, 8, 2)!;
  const rl = railGame.lines.create('rail'); rl.stops = [A.id, B.id];
  const depot = depotFor(railGame, A, B);
  const t = railGame.vehicles.buyTrain(depot, loco(), rl.id) as Train;
  const behind = railGame.vehicles.buyTrain(depot, loco(), rl.id) as Train;
  const clock = spacingSchedule(railGame, t)!.clock;
  clock.departures[`${A.id}:${B.id}`] = { at: simNow(railGame), vehicle: behind.id };
  t.state = 'loading'; behind.state = 'waiting'; behind.blockedBy = t.id;
  check(!holdForSpacing(railGame, t), 'waiting train releases the timing-point hold for its platform');
  behind.blockedBy = 0;
  check(holdForSpacing(railGame, t), 'free platform permits the timing-point hold');
  t.spacing.departureIndex = 0;
  check(setVehiclePattern(railGame, t.id, undefined) === null && t.spacing.until < 0 && t.spacing.departureIndex < 0,
    'pattern reassignment clears the previous hold and departure stop');
  behind.spacing.departureIndex = 0; behind.spacing.until = 10;
  railGame.vehicles.noteSpacingRelease(behind);
  check(behind.spacing.departureIndex < 0 && behind.spacing.until < 0, 'depot dispatch never records a stale station departure');
}

const reports: Record<string, unknown> = {};
const busOff = bus(false); reports.busOff = busOff;
if (!baseline) {
  const busOn = bus(true); reports.busOn = busOn;
  check(busOn.total >= busOff.total, 'bus regulation preserves / increases total deliveries');
}
for (const double of [false, true]) {
  reports[double ? 'doubleOff' : 'singleOff'] = rail(false, double);
  if (!baseline) reports[double ? 'doubleOn' : 'singleOn'] = rail(true, double);
}
if (!quick) for (const seed of [7, 23]) {
  const off = ai(seed, false); reports[`ai${seed}Off`] = off;
  if (!baseline) {
    const on = ai(seed, true); reports[`ai${seed}On`] = on;
    check(on.cv < off.cv, `AI seed ${seed}: mean headway CV improves`);
  }
}
if (!baseline) { reports.busRecovery = busRecovery(); rulesAndSaves(); }
const json = process.argv.find((a) => a.startsWith('--json='))?.slice(7);
if (json) writeFileSync(json, JSON.stringify(reports, null, 2) + '\n');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
