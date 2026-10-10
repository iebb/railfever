// Full-cost access pricing, wear attribution, migration and exact active-agreement replay.
// Bundle as accessfees.mjs and run from the scratch directory.
import assert from 'node:assert/strict';
import { Game, PLAYER, ACCESS_CAP } from '../src/game/game';
import { ACCESS_ANNUITY, migrateAccessMultiplier } from '../src/game/access-cost';
import { BASE_INTEREST_RATE } from '../src/game/economy';
import { TRACK_TYPES, TRAM, ELECTRIFY } from '../src/game/constants';
import { bezLine } from '../src/game/geom';
import type { NEdge } from '../src/game/network';
import type { Vehicle } from '../src/game/vehicle';
import { consistOf, passageWear, trackPassage, saveOps, trackBasePerUnit } from '../src/game/opcosts';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { trackMaterialCost, trackEarthworksCost, planEdge, commitProposal } from '../src/game/construction';
import { entranceCost, stationPlatformCost, stationLevelCost, stationBuildingCost } from '../src/game/stations';
import { stationEnds, nodeSnap, buildDepotOnLine } from '../src/game/routing';
import { Train } from '../src/game/train';
import { RoadVehicle, makeLaneSeg } from '../src/game/roadvehicle';

let checks = 0;
function near(actual: number, expected: number, label: string, tolerance = 1e-7) {
  assert(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`); checks++;
}
const g = Game.create({ size: 128, seed: 37, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 2 });
g.aiEnabled = false; g.aiAcquisitions = false;
g.world.h.fill(2); g.world.heightsVersion++;
for (const co of g.companies) co.economy.money = 100_000_000;
g.setAccessMultiplier(PLAYER, 1.25);
g.requestAccess(1, PLAYER); g.requestAccess(2, PLAYER);
const net = g.world.net;
function edge(z: number, rise: number, section: 'bridge' | 'tunnel' | null = null, type = 'standard', length = 1): NEdge {
  const a = net.addNode('rail', 20, 2 + rise, z, 1, 0, PLAYER), b = net.addNode('rail', 20 + length, 2 + rise, z, 1, 0, PLAYER);
  return net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(length) + 1).fill(2 + rise),
    section ? [{ s0: 0, s1: length, type: section }] : [], type, PLAYER);
}
// A 25% earthworks premium gives the reference ~9,400 replacement / ~770 annual cost per 10 m.
const width = 0.32 * 2 + 1.5, rise = (Math.sqrt(width * width + 8 * 1875 / 900) - width) / 4;
const plain = edge(20, rise), bridge = edge(25, 1.1, 'bridge'), deep = edge(30, -8, 'tunnel');
near(ACCESS_ANNUITY, 0.0578300991336613, '4% / 30-year annuity', 1e-12);
near(BASE_INTEREST_RATE, 0.04, 'economy base rate');
// Opening the first agreement mid-month must retain the owner's earlier traffic in the denominator.
const early = Game.create({ size: 128, seed: 37, towns: 0, aiCompanies: 1 });
early.aiEnabled = false;
const en = early.world.net, ea = en.addNode('rail', 20, 2, 20, 1, 0, PLAYER), eb = en.addNode('rail', 21, 2, 20, 1, 0, PLAYER);
const ee = en.addEdge('rail', ea.id, eb.id, bezLine(ea.x, ea.z, eb.x, eb.z), new Float32Array([2, 2]), [], 'standard', PLAYER);
early.recordTrackUse(PLAYER, ee, 80);
near(early.accessUsage(ee)[PLAYER], 80, 'owner usage recorded before any agreement');
early.requestAccess(1, PLAYER); early.recordTrackUse(1, ee, 20); early.billAccess();
near(early.agreement(1, PLAYER)!.paidLastMonth * 12, early.accessChargeEstimate(1, PLAYER, [ee], 0.2), 'mid-month entrant pays real whole-month share');
near(g.accessReplacementCost(plain), 9375, 'plain reference replacement', 1);
near(g.accessFullCost(plain), 767.1571793780747, 'plain reference full cost', 0.1);
for (const e of [plain, bridge, deep]) {
  const F = g.accessFullCost(e), M = g.edgeMaintenance(e);
  const equal = g.accessChargeEstimate(1, PLAYER, [e], 0.5), sole = g.accessChargeEstimate(1, PLAYER, [e], 1);
  near(equal, F * 0.625, 'equal-use forecast'); near(sole, F * 0.75, 'sole-user ceiling');
  g.recordTrackUse(PLAYER, e, 10); g.recordTrackUse(1, e, 10); g.billAccess();
  near(g.agreement(1, PLAYER)!.paidLastMonth * 12, equal, 'equal-use billing matches quote');
  g.recordTrackUse(1, e, 10); g.billAccess();
  near(g.agreement(1, PLAYER)!.paidLastMonth * 12, sole, 'sole-user billing matches quote');
  console.log(`REFERENCE ${JSON.stringify({ kind: e === plain ? 'plain' : e === bridge ? 'bridge' : 'deep tunnel', replacement: g.accessReplacementCost(e), upkeep: M, fullCost: F,
    oldEqual: M * 2 / 3, oldSole: M, equal, sole })}`);
}
near(g.accessReplacementCost(bridge), 28500, 'low bridge uses construction structureFactor');
near(g.accessReplacementCost(deep), 72750, 'deep tunnel uses construction structureFactor');
near(g.accessReplacementCost(plain), Math.round(TRACK_TYPES.standard.costPerUnit + trackEarthworksCost(plain.prof[0] - 2, 0.32, 1)), 'same earthworks cost function');
near(g.accessReplacementCost(bridge), Math.round(trackMaterialCost('rail', 'standard', 'bridge', bridge.prof[0] - 2)), 'same bridge cost function');
for (const p of [0, 0.625, 1, 1.25, 2]) for (const share of [0, 0.01, 0.2, 0.5, 1]) {
  g.setAccessMultiplier(PLAYER, p);
  const fee = g.accessChargeEstimate(1, PLAYER, [plain], share);
  assert(fee <= ACCESS_CAP * g.accessFullCost(plain) + 1e-9); checks++;
  near(fee, Math.min(share * p, ACCESS_CAP) * g.accessFullCost(plain), 'all factors and shares obey formula');
}
g.setAccessMultiplier(PLAYER, 1.25);
g.recordTrackUse(PLAYER, plain, 2); g.recordTrackUse(1, plain, 3); g.recordTrackUse(2, plain, 5); g.billAccess();
near(g.agreement(1, PLAYER)!.paidLastMonth * 12, g.accessFullCost(plain) * 0.3 * 1.25, 'three operators: real share 30%');
near(g.agreement(2, PLAYER)!.paidLastMonth * 12, g.accessFullCost(plain) * 0.5 * 1.25, 'three operators: real share 50%');
near(g.agreement(1, PLAYER)!.usageShareLastMonth, 0.3, 'reported usage is unweighted');
near(g.accessChargeEstimate(1, PLAYER, [plain, plain], 0.3), g.accessChargeEstimate(1, PLAYER, [plain], 0.3), 'route duplicates never double-charge');

const stock = [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!];
function passage(user: number, e: NEdge, speed: number, cars: VehicleModel[] = stock, units = e.len): number {
  const t = { owner: user, cars, speed, load: 40, mailLoad: 0 } as unknown as Vehicle & { cars: VehicleModel[]; speed: number };
  const wear = passageWear(consistOf(cars), 40, units, speed * 36);
  trackPassage(g, t, e, units); return wear;
}
for (const p of [0, 1.25, 2]) {
  g.setAccessMultiplier(PLAYER, p);
  const own = passage(PLAYER, plain, 1), guest = passage(1, plain, 4, [...stock, stock[1], stock[1]]);
  near(g.accessUsage(plain)[PLAYER], g.accessUsage(plain)[1], 'heavy/fast passages have equal real distance');
  const expected = Math.min(0.5 * p, ACCESS_CAP) * g.accessFullCost(plain) / 12 + guest;
  const before = g.economy.current.trackWear;
  g.billAccess();
  near(g.agreement(1, PLAYER)!.paidLastMonth, expected, 'own wear paid in full outside factor/cap');
  near(before - g.economy.current.trackWear, own + guest, 'owner books gross wear');
  near(g.accessEarnings(PLAYER).lastMonth, expected, 'owner recovers full foreign wear');
  if (p === 0) near(g.agreement(1, PLAYER)!.paidLastMonth, guest, 'zero factor is free fixed access, wear still paid');
}
g.setAccessMultiplier(PLAYER, 0); g.recordTrackUse(1, bridge, 20); g.billAccess();
near(g.agreement(1, PLAYER)!.paidLastMonth, 0, 'zero factor without wear is free');

// Quotes are disposable, versioned and independent of a company's borrowing rate.
const oldPrice = g.accessReplacementCost(plain);
plain.type = 'electric'; net.touchEdge(plain);
near(g.accessReplacementCost(plain) - oldPrice, ELECTRIFY.costPerUnit * plain.len, 'wire invalidates replacement quote');
const annual = g.accessFullCost(plain); g.economy.interestRate = 0.11;
near(g.accessFullCost(plain), annual, 'annuity uses base rate, not company rate');
const oldBridge = g.accessReplacementCost(bridge); g.world.h.fill(1); g.world.heightsVersion++;
assert(g.accessReplacementCost(bridge) > oldBridge); checks++;
g.world.h.fill(2); g.world.heightsVersion++;
plain.type = 'standard'; net.touchEdge(plain);

const plan = g.stations.planRail(60, 70, Math.PI / 2, 8, 2, PLAYER, { style: 'classic' });
assert(plan.ok, plan.error); assert.equal(g.stations.commitRail(plan, PLAYER), null); checks += 2;
const st = g.stations.all()[0];
const r = st.rail!;
// Level, platforms and entrance fit-out use current geometry, never a stored/historical construction total.
near(g.accessReplacementCost(st), stationPlatformCost(16, 0, true), 'station facility uses retained-rail construction prices; edges recover rail capital', 1000);
const baseStation = g.accessReplacementCost(st);
r.cost = 1; near(g.accessReplacementCost(st), baseStation, 'historical station cost is ignored');
r.entrances.push({ x: 60, z: 73, angle: 0, kind: 'footbridge' }); g.stations.walkVersion++;
near(g.accessReplacementCost(st) - baseStation, entranceCost('footbridge', r), 'station entrance invalidates quote');
r.level = 'elevated'; r.height = 1.5; g.stations.walkVersion++;
near(g.accessReplacementCost(st), Math.round(stationLevelCost(stationPlatformCost(16, 0, true) - stationBuildingCost('classic'), 'elevated', 0, 1.5)
  + stationBuildingCost('classic') + entranceCost('footbridge', r)), 'elevated station level construction price');
g.setAccessMultiplier(PLAYER, 1.25);
g.recordStop({ owner: 1 } as Vehicle, st); g.recordStop({ owner: PLAYER } as Vehicle, st); g.billAccess();
near(g.agreement(1, PLAYER)!.paidLastMonth * 12, g.accessChargeEstimate(1, PLAYER, [st], 0.5), 'station billing matches forecast');

const a = net.addNode('road', 30, 2, 90), b = net.addNode('road', 40, 2, 90);
const tram = net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(11).fill(2), [], 'street', -1, { tram: true, tramOwner: PLAYER });
near(g.accessFullCost({ tram }), tram.len * (TRAM.costPerUnit * ACCESS_ANNUITY + TRAM.maintPerUnit), 'tram charges only tram capital/upkeep');
g.recordTrackUse(1, tram, 10, true); g.billAccess();
near(g.agreement(1, PLAYER)!.paidLastMonth * 12, g.accessChargeEstimate(1, PLAYER, [{ tram }], 1), 'tram billing matches forecast');
const streetcar = new RoadVehicle(g, 999, MODEL_BY_ID.get('tram_c')!, -1);
streetcar.owner = 1; streetcar.placeAt(makeLaneSeg(g, tram, 1), 1); streetcar.speed = 1;
const startPos = streetcar.pos;
(streetcar as unknown as { drive(dt: number): void }).drive(0.1);
near(g.accessUsage({ tram })[1], streetcar.pos - startPos, 'tram meters actual fixed-step travel, not a daily speed sample');
g.billAccess();
const c = net.addNode('road', 50, 2, 90);
const nextTram = net.addEdge('road', b.id, c.id, bezLine(b.x, b.z, c.x, c.z), new Float32Array(11).fill(2), [], 'street', -1, { tram: true, tramOwner: PLAYER });
streetcar.placeAt(makeLaneSeg(g, tram, 1), 0); streetcar.pos = streetcar.seg!.len - 0.02;
streetcar.ahead = [makeLaneSeg(g, nextTram, 1)]; streetcar.speed = 1;
(streetcar as unknown as { drive(dt: number): void }).drive(0.1);
assert.equal(streetcar.seg!.e, nextTram.id, 'tram crosses an edge boundary during the step'); checks++;
near(g.accessUsage({ tram })[1], 0.02, 'edge boundary charges only distance left on first edge');
near(g.accessUsage({ tram: nextTram })[1], streetcar.pos, 'edge boundary charges remaining distance on second edge');
g.billAccess();

// AI conservative route and train-count forecasts call the same helper; a light entrant pays proportionately.
const bound = (g.ais[0] as unknown as { railFeeBound(points: unknown[], rails: Set<number>): number }).railFeeBound([], new Set([plain.id, bridge.id]));
const buildAnnual = g.accessFullCost(plain) + g.accessFullCost(bridge);
near(bound, buildAnnual * 0.75, 'AI access vs parallel build uses capped full cost');
assert(bound < buildAnnual); checks++;
const light = g.accessChargeEstimate(g.ais[0].companyId, PLAYER, [plain], 1 / (49 + 1));
near(light, g.accessChargeEstimate(1, PLAYER, [plain], 0.02), 'light AI forecast uses real 1/50 usage');
assert(light < g.accessFullCost(plain) * 0.03); checks++;
console.log(`AI COMPARISON ${JSON.stringify({ buildAnnual, accessAnnual: bound, lightAnnual: light })}`);

// Split a metered edge mid-month: fixed shares and individual wear survive together.
const splitEdge = edge(100, rise, null, 'standard', 10);
passage(PLAYER, splitEdge, 1); const guestWear = passage(1, splitEdge, 4);
const split = net.splitEdge(splitEdge.id, splitEdge.len * 0.4)!;
near(saveOps(g).wearUsers.filter(([id]) => id === split.e1.id || id === split.e2.id).reduce((n, [, u]) => n + u[1], 0), guestWear, 'split conserves each user wear');
g.billAccess();
near(g.agreement(1, PLAYER)!.paidLastMonth, g.accessChargeEstimate(1, PLAYER, [split.e1, split.e2], 0.5) / 12 + guestWear, 'split bill charges full individual wear');

// Warm and cold quotes produce the same saved state and month-end replay with active agreements and wear.
passage(1, plain, 4); passage(PLAYER, plain, 1); g.recordTrackUse(2, bridge, 4);
g.onNetworkChanged(); g.flushNetworkChanges(); g.stepTick();
const saved = JSON.stringify(serialize(g));
g.accessFullCost(plain); g.accessFullCost(st); g.estimateAccessShare(PLAYER, 1);
assert.equal(JSON.stringify(serialize(g)), saved, 'quotes are read-only'); checks++;
const loaded = deserialize(JSON.parse(saved));
assert.equal(JSON.stringify(serialize(loaded)), saved, 'active agreements and per-user wear round-trip exactly'); checks++;
for (const until = g.day + 65; g.day < until;) { g.stepTick(); loaded.stepTick(); }
assert.equal(JSON.stringify(serialize(loaded)), JSON.stringify(serialize(g)), 'exact replay through two bills with active agreements'); checks++;

// A real train operates across another company's infrastructure: replay physics, meters and bills together.
const live = Game.create({ size: 128, seed: 41, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
live.aiEnabled = false; live.aiAcquisitions = false; live.world.h.fill(2); live.world.heightsVersion++;
for (const co of live.companies) co.economy.money = 100_000_000;
const stations = [20, 108].map(x => {
  const id = live.stations.nextId, plan = live.stations.planRail(x, 64, Math.PI / 2, 10, 1, PLAYER);
  assert(plan.ok, plan.error); assert.equal(live.stations.commitRail(plan, PLAYER), null); checks += 2;
  return live.stations.get(id)!;
});
const link = planEdge(live, nodeSnap(live, stationEnds(live, stations[0])[0].front, 'rail'), nodeSnap(live, stationEnds(live, stations[1])[0].back, 'rail'),
  { kind: 'rail', type: 'standard', owner: PLAYER, tracks: 1, heightOffset: 0, crossing: 'auto' });
assert(link.ok, link.errors.join('; ')); assert.equal(commitProposal(live, link), null); checks += 2;
live.requestAccess(1, PLAYER);
const corridor = [...live.world.net.edges.values()].find(e => e.kind === 'rail' && e.station < 0 && e.depot < 0)!;
const depot = buildDepotOnLine(live, corridor.id, corridor.len / 2, 1);
assert(depot >= 0, 'foreign operator builds its depot beside licensed track'); checks++;
const service = live.lines.create('rail', PLAYER); service.stops = stations.map(s => s.id); live.lines.rebuild();
live.lines.setPartnerPolicy(service.id, 'open');
assert.equal(live.lines.join(service.id, 1), null); checks++;
const train = live.vehicles.buyTrain(depot, stock, service.id);
assert(train instanceof Train, typeof train === 'string' ? train : 'foreign train bought'); checks++;
const usedForeign = () => [...live.world.net.edges.values()].some(e => (live.accessUsage(e)[1] ?? 0) > 0);
while (live.day < 120 && !usedForeign()) live.stepTick();
assert(usedForeign(), `running train meters foreign usage (${train.state}: ${train.status}, day ${live.day})`); checks++;
const liveSaved = JSON.stringify(serialize(live)), liveCopy = deserialize(JSON.parse(liveSaved));
assert.equal(JSON.stringify(serialize(liveCopy)), liveSaved, 'real shared service round-trips exactly'); checks++;
for (let tick = 0; tick < 65 * live.ticksPerDay; tick++) { live.stepTick(); liveCopy.stepTick(); }
assert(live.agreement(1, PLAYER)!.paidTotal > 0 && live.vehicles.get(train.id)?.state !== 'noroute', 'shared train operates and pays access bills'); checks++;
assert.equal(JSON.stringify(serialize(liveCopy)), JSON.stringify(serialize(live)), 'real shared service replays exactly across three month ends'); checks++;

// Price factors also affect a cautious owner's consent, through expected fixed-fee income.
const ask = deserialize(JSON.parse(liveSaved)); ask.endAccess(1, PLAYER);
const owner = 1, user = PLAYER, owned = ask.lines.create('rail', owner), rival = ask.lines.create('rail', user);
for (let i = 0; i < stations.length; i++) {
  const st = ask.stations.get(stations[i].id)!; st.owner = owner; st.townId = i;
}
owned.stops = stations.map(s => s.id); rival.stops = [...owned.stops]; owned.incomeLast = 80_000;
ask.ais[0].config = { ...ask.ais[0].config, risk: 0.5 }; ask.setAccessPolicy(owner, 'ask');
ask.setAccessMultiplier(owner, 0); assert.equal(ask.requestAccess(user, owner), 'rejected', 'free access cannot offset a competitor’s lost fares'); checks++;
ask.setAccessMultiplier(owner, 2); assert.equal(ask.requestAccess(user, owner), 'granted', 'full-cost fee income makes the competing request worthwhile'); checks++;

for (const oldMultiplier of [0, 1, 2, 3]) {
  const old = JSON.parse(saved); old.accessVersion = 2;
  old.accessMult[PLAYER] = oldMultiplier; old.ais[0].config.accessMultiplier = oldMultiplier;
  const migrated = deserialize(old);
  near(migrated.accessMultiplier(PLAYER), oldMultiplier * 0.625, 'old human multiplier migration');
  near(migrated.accessMultiplier(1), oldMultiplier * 0.625, 'old AI personality migration');
  near(deserialize(serialize(migrated)).accessMultiplier(PLAYER), migrated.accessMultiplier(PLAYER), 'migration happens once');
}
near(migrateAccessMultiplier(2), 1.25, 'old default becomes new default');
near(g.ais[0].config.accessMultiplier, 0.625, 'new AI retains mapped permissive personality');
g.setAccessMultiplier(PLAYER, 3); near(g.accessMultiplier(PLAYER), 2, 'new maximum');
near(trackBasePerUnit('standard'), 225, 'reference annual base upkeep');
console.log(`ALL ${checks} ACCESS FEE CHECKS PASSED`);
