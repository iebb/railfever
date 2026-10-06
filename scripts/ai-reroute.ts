// Native middle-city diversion, marginal economics, saved phases and safe second-branch cancellation.
// Bundle as ai-reroute.mjs. Controlled demand isolates investment; construction/routing/stock stay native.
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { networkDaily, saveNetwork, loadNetwork, routeBetween } from '../src/game/ai-network';
import { quoteReroute, rerouteLine, type RerouteHost } from '../src/game/ai-reroute';
import { Train, makeSeg } from '../src/game/train';
import type { Town } from '../src/game/towns';
import { flatGame, station, endNode, depotFor, loco, check, fails, build, free, railOpts, nodeSnap } from './stationlib';
import { roadOpts, checkReservations } from './lib';

const g = flatGame(384);
g.addAICompany({ startMoney: 100e6, focus: { rail: 1, road: 0, tram: 0 }, risk: .7 });
g.aiEnabled = false; g.aiAcquisitions = false;
const ai = g.ais[0] as typeof g.ais[0] & Record<string, any>, owner = ai.companyId;
g.towns.list = [[40, 200], [330, 200], [188, 224]].map(([x, z], id): Town => ({ id, name: `Town ${id}`, x, z, angle: 0,
  pop: 4000, radius: 20, buildings: new Set(), nextGrowthDay: 1e6, hasChurch: false,
  passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 }));
for (const company of g.companies) company.hqTown = 0;
check(!!build(g, free(g, 16, 192), free(g, 350, 192), roadOpts(-1, 'road', { town: true })), 'fixture public access');
check(!!build(g, free(g, 150, 228), free(g, 226, 228), roadOpts(-1, 'road', { town: true })), 'fixture city street');
const A = station(g, 40, 200, Math.PI / 2, 12, 2, owner)!, B = station(g, 330, 200, Math.PI / 2, 12, 2, owner)!;
if (!A || !B) throw new Error('fixture stations');
A.townId = 0; B.townId = 1;
const track = build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(owner));
check(!!track, 'fixture owned original corridor');
const original = [...g.world.net.edges.values()].find(e => e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0)!;
const depot = depotFor(g, A, B, owner), line = g.lines.create('rail', owner);
line.stops = [A.id, B.id];
const train = g.vehicles.buyTrain(depot, loco(), line.id);
if (!(train instanceof Train)) throw new Error(String(train));
train.retryTimer = 1e8;
ai.lines.set(line.id, { kind: 'rail', towns: [0, 1], depot, maxVehicles: 2, opened: 0 });
g.lines.rebuild(); g.stepTick(); networkDaily(ai);
const initialNetwork = saveNetwork(g);
const state = initialNetwork.companies.find(([id]) => id === owner)![1];
state.next = state.next.map(([id]) => [id, 1e9]);
state.job = { task: 'reroute', items: [{ ids: [line.id] }], cursor: 0, done: 0 };
loadNetwork(g, initialNetwork);
const base = structuredClone(serialize(g));

function receipts(world: Game, gain = 3e6) {
  world.demand.forecastLine = ((sites: any[]) => ({ revenue: 2e6 + (sites.length > 2 ? gain : 0), boardings: 100,
    covered: 4000, legLoads: Array(2 * (sites.length - 1)).fill(100), perPax: 100, direct: 100, transfer: 0 })) as typeof world.demand.forecastLine;
}
function fresh(gain = 3e6) { const world = deserialize(structuredClone(base)); receipts(world, gain); return world; }
const cursor = (world: Game) => saveNetwork(world).companies.find(([id]) => id === owner)![1].job?.items?.[0]?.reroute;
const working = (world: Game) => !!saveNetwork(world).companies.find(([id]) => id === owner)![1].job;
const step = (world: Game) => networkDaily(world.ais[0]);
function until(world: Game, stage?: string) {
  for (let i = 0; i < 20 && working(world) && (!stage || cursor(world)?.stage !== stage); i++) step(world);
  if (stage && cursor(world)?.stage !== stage) throw new Error(`expected phase ${stage}, got ${cursor(world)?.stage}`);
}
const normalized = (value: any): any => Array.isArray(value) ? value.map(normalized)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, normalized(value[k])])) : value;
const snapshot = (world: Game) => JSON.stringify(normalized(serialize(world)));
function host(world: Game): RerouteHost {
  const a = world.ais[0] as typeof ai;
  return { g: world, me: owner, ai: a, note() {}, news() {}, considered() {}, stat() {}, succeed() {}, cared() { return false; }, careFor() {},
    affordable: c => a.available() >= c, canSpend: c => a.available() >= c, managed: () => a.lines,
    setStops() {}, signal() { return 0; }, consent() { return true; }, demolitionOk() { return true; }, compensate() {} };
}
function corridor(world: Game) {
  return [routeBetween(world, A.id, B.id, owner), routeBetween(world, B.id, A.id, owner)]
    .every(route => !!route && route.every(id => world.world.net.edges.get(id)?.owner === owner));
}

const priced = fresh(), pricedLine = priced.lines.get(line.id)!, h = host(priced);
const quotes = ['ground', 'elevated', 'underground'].map(level => quoteReroute(h, pricedLine,
  { a: A.id, b: B.id, town: 2, x: 188, z: 224, angle: Math.PI / 2, level: level as 'ground' | 'elevated' | 'underground' }));
check(quotes.every(q => q && q.value.score > 0), 'all three native station levels can quote viable detours');
check(quotes[0]!.value.capital < quotes[1]!.value.capital && quotes[1]!.value.capital < quotes[2]!.value.capital,
  'ground/elevated/underground compare real civil costs');
check(quotes[0]!.value.revenue < 5e6 - 2e6 && quotes[0]!.value.headway > 0, 'whole retained receipts are subtracted and longer-cycle stock capacity is priced');

const replay = fresh(); let phases = 0;
while (working(replay) && phases < 20) {
  const saved = structuredClone(serialize(replay)), loaded = deserialize(saved); receipts(loaded);
  check(snapshot(replay) === snapshot(loaded), `phase ${cursor(replay)?.stage ?? 'finished'} exact save round trip`);
  for (let i = 0; i < TICKS_PER_DAY; i++) { replay.stepTick(); loaded.stepTick(); }
  step(replay); step(loaded);
  check(snapshot(replay) === snapshot(loaded), `phase ${phases} exact fixed-step decision replay`);
  phases++;
}
const changed = replay.lines.get(line.id)!, C = [...new Set(changed.stops)].find(id => id !== A.id && id !== B.id)!;
check(!working(replay) && C !== undefined && changed.stops.join(',') === [A.id, C, B.id, C].join(','), 'real scheduler opens A-C-B on the original line');
check(changed.vehicles.join(',') === String(train.id) && replay.lines.map.size === 1 && replay.vehicles.map.size === 1,
  'diversion reuses paid fleet and timetable without extra purchases');
check(corridor(replay), 'original native bidirectional A-B corridor survives successful diversion');
check(replay.stations.hasAccess(replay.stations.get(C)!) && checkReservations(replay).length === 0, 'new station has native access and valid train reservations');

const unpaid = fresh(0), unpaidMoney = unpaid.company(owner).economy.money, unpaidEdges = unpaid.world.net.edges.size;
until(unpaid);
check(unpaid.lines.get(line.id)!.stops.join(',') === [A.id, B.id].join(',') && unpaid.stations.map.size === 2
  && unpaid.world.net.edges.size === unpaidEdges && unpaid.company(owner).economy.money === unpaidMoney,
  'unchanged retained revenue cannot justify any detour construction');

const turning = fresh(); until(turning, 'station');
const turningTrain = turning.vehicles.get(train.id) as Train, platform = turning.world.net.edges.get(A.rail!.edges[0])!;
turningTrain.segs = [makeSeg(turning, platform, 1)]; turningTrain.headSeg = 0; turningTrain.headPos = turningTrain.length + 1;
turningTrain.state = 'loading'; turningTrain.atStation = A.id; turning.vehicles.setRes(platform.id, turningTrain.id);
check((turningTrain as any).reverseTrain(), 'fixture performs a native platform turnaround'); step(turning);
check(cursor(turning)?.stage === 'left' && !!rerouteLine(host(turning), turning.lines.get(line.id)!), 'normal consist reversal preserves the saved construction decision');

const rollback = fresh(); until(rollback, 'left');
const occupied = rollback.vehicles.get(train.id) as Train, pe = rollback.world.net.edges.get(A.rail!.edges[0])!;
occupied.segs = [makeSeg(rollback, pe, 1), makeSeg(rollback, rollback.world.net.edges.get(original.id)!, 1)];
occupied.headSeg = 0; occupied.headPos = occupied.length + 1; occupied.state = 'loading'; occupied.atStation = A.id;
occupied.routeTarget = B.id; occupied.loadTimer = 1e8;
for (const seg of occupied.segs) for (const res of seg.res) rollback.vehicles.setRes(res, occupied.id);
step(rollback);
check(cursor(rollback)?.stage === 'right' && !rollback.world.net.edges.has(original.id), 'first branch splits the reserved original corridor natively');
const descendants = occupied.segs.slice(1).map(seg => seg.e), debitEdges = cursor(rollback)!.built!.debits.flatMap(d => d.edges);
check(descendants.length === 2 && descendants.every(id => !debitEdges.includes(id)), 'original split descendants are protected from the new-work debit ledger');
const eco = rollback.company(owner).economy, spent = cursor(rollback)!.built!.spent;
eco.money = 0; eco.loan = eco.maxLoan;
eco.earn(12345, 'income'); const income = eco.thisYear.income;
step(rollback);
check(!working(rollback) && rollback.stations.map.size === 2 && debitEdges.every(id => !rollback.world.net.edges.has(id)), 'failed second branch removes only unused new work');
check(corridor(rollback) && descendants.every(id => rollback.world.net.edges.has(id) && rollback.vehicles.getRes(id) === occupied.id),
  'cancellation retains original A-B rails and future reservations in both directions');
check(eco.money === 12345 + spent && eco.thisYear.income === income, 'refund uses only recorded construction debits and preserves intervening income');
const rollbackLoaded = deserialize(structuredClone(serialize(rollback)));
check(snapshot(rollback) === snapshot(rollbackLoaded) && checkReservations(rollback).length === 0 && checkReservations(rollbackLoaded).length === 0,
  'cancelled original split reservations save and load exactly');

const edited = fresh(); until(edited, 'right');
const ownedNew = cursor(edited)!.built!.debits.flatMap(d => d.edges).find(id => edited.world.net.edges.get(id)?.station === -1)!;
const e = edited.world.net.edges.get(ownedNew)!;
edited.world.net.splitEdge(e.id, e.len / 2);
const beforeRetain = edited.company(owner).economy.money, retainedCount = edited.world.net.edges.size;
step(edited);
check(!working(edited) && edited.company(owner).economy.money === beforeRetain && edited.world.net.edges.size === retainedCount && corridor(edited),
  'external edit invalidates staged assets without an unearned refund or original-corridor removal');

console.log(`native diversion ${phases} saved phases, three levels, unpaid fallback, turnaround and two cancellation controls`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
