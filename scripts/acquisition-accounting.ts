// Pending wear bills and retired mail legs must follow companies through acquisitions.
// Bundle as acquisition-accounting.mjs and run from a scratch directory.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { bezLine } from '../src/game/geom';
import { consistOf, passageWear, trackPassage } from '../src/game/opcosts';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import type { Vehicle } from '../src/game/vehicle';
import { serialize, deserialize } from '../src/game/save';
import { settleMail, stationMail } from '../src/game/mail';
import { mailFare, simNow } from '../src/game/fares';
import { RoadVehicle, roadDepotReaches } from '../src/game/roadvehicle';
import { nativeRoadItinerary } from '../src/game/road-physics';
import { readWalkingCatchment } from '../src/game/catchment';
import { addBusStop, roadDepotNear } from './lib';

const stock = [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!];
const near = (actual: number, expected: number, label: string) => assert(Math.abs(actual - expected) < 1e-7, `${label}: ${actual} != ${expected}`);
function merge(g: Game, buyer: number, target: number) {
  // Establish full ownership through the legacy buyout fixture, then exercise the real merger.
  g.shares.recordBuyout(buyer, target);
  assert.equal(g.mergeOwnedCompany(buyer, target), null);
}
function wearFixture(owner: number, user: number) {
  const g = Game.create({ size: 128, seed: 37, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 2 });
  g.aiEnabled = false; g.aiAcquisitions = false;
  for (const co of g.companies) co.economy.money = 100_000_000;
  g.world.h.fill(2); g.world.heightsVersion++;
  g.setAccessPolicy(owner, 'open'); g.setAccessMultiplier(owner, 0);
  assert.equal(g.requestAccess(user, owner), 'granted');
  const net = g.world.net, a = net.addNode('rail', 20, 2, 20, 1, 0, owner), b = net.addNode('rail', 30, 2, 20, 1, 0, owner);
  const e = net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(11).fill(2), [], 'standard', owner);
  const t = { owner: user, cars: stock, speed: 4, load: 40, mailLoad: 0 } as unknown as Vehicle & { cars: typeof stock; speed: number };
  const wear = passageWear(consistOf(stock), 40, e.len, t.speed * 36);
  trackPassage(g, t, e, e.len);
  return { g, e, wear };
}
const tests: [string, () => void][] = [
  ['acquired operator reimburses its pre-merger wear, live and after save/load', () => {
    const { g, wear } = wearFixture(0, 1);
    merge(g, 2, 1);
    const loaded = deserialize(serialize(g));
    for (const h of [g, loaded]) {
      h.billAccess();
      near(h.companies[2].economy.current.trackFees, -wear, 'buyer pays acquired usage');
      near(h.companies[0].economy.current.trackIncome, wear, 'owner recovers guest wear');
      near(h.companies[0].economy.current.trackWear, -wear, 'gross wear remains charged');
      near(h.companies[1].economy.current.trackFees, 0, 'retired operator books no new debt');
      h.billAccess();
      near(h.companies[2].economy.current.trackFees, -wear, 'wear charged exactly once');
    }
    assert.equal(JSON.stringify(serialize(loaded)), JSON.stringify(serialize(g)));
  }],
  ['removed track wear follows acquired owner, live and after save/load', () => {
    const { g, e, wear } = wearFixture(1, 0);
    g.world.net.removeEdge(e.id);
    merge(g, 2, 1);
    const loaded = deserialize(serialize(g));
    for (const h of [g, loaded]) {
      h.billAccess();
      near(h.companies[2].economy.current.trackWear, -wear, 'buyer inherits removed-edge bill');
      near(h.companies[2].economy.current.trackIncome, wear, 'buyer receives reimbursement');
      near(h.companies[0].economy.current.trackFees, -wear, 'guest pays removed-edge wear');
    }
    assert.equal(JSON.stringify(serialize(loaded)), JSON.stringify(serialize(g)));
  }],
  ['acquired operator on its buyer\'s track does not pay itself', () => {
    const { g, wear } = wearFixture(0, 1);
    merge(g, 0, 1);
    g.billAccess();
    near(g.companies[0].economy.current.trackWear, -wear, 'merged company retains gross wear');
    near(g.companies[0].economy.current.trackIncome, 0, 'no self reimbursement');
    near(g.companies[0].economy.current.trackFees, 0, 'no self fee');
  }],
  ['retired mail leg pays the final buyer across all fifteen acquisitions', () => {
    const g = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980, aiCompanies: 15 });
    g.aiEnabled = false; g.aiAcquisitions = false; g.economy.money = 1e9;
    // Settlement is mode-independent. A surveyed flat street with native stops/depot and walking residents
    // establishes acceptance directly, without depending on an unrelated hilly rail/throat search.
    g.world.h.fill(4); g.world.heightsVersion++;
    const net = g.world.net, a = net.addNode('road', 20, 4, 60, 0, 0, -1), b = net.addNode('road', 220, 4, 60, 0, 0, -1);
    net.addEdge('road', a.id, b.id, bezLine(20, 60, 220, 60), new Float32Array(201).fill(4), [], 'street', -1);
    const homes = [60, 180].map(x => g.world.addBuilding({ townId: -1, x, z: 59.6, angle: 0, w: 0.8, d: 0.8,
      type: 0, floors: 2, pop: 1000, seed: 1, y: 4, built: 0 }));
    const ids = [60, 180].map(x => addBusStop(g, x, 60, 0)), depot = roadDepotNear(g, 100, 60, 0);
    assert(ids.every(id => id >= 0) && ids[0] !== ids[1], 'native mail stops build separately');
    assert(depot >= 0, 'native mail depot builds');
    const line = g.lines.create('road', 0); line.stops = ids;
    const truck = g.vehicles.buyRoad(depot, MODEL_BY_ID.get('mailtruck_b')!, line.id);
    assert(truck instanceof RoadVehicle, `native mail truck purchase: ${typeof truck === 'string' ? truck : 'vehicle'}`);
    g.flushNetworkChanges(); g.lines.flushCatchment();
    const pr = { A: g.stations.get(ids[0])!, B: g.stations.get(ids[1])! };
    assert([pr.A, pr.B].every((st, i) => readWalkingCatchment(g, st).buildings.has(homes[i].id)), 'residents reach each served stop by native walking paths');
    assert(ids.every(id => roadDepotReaches(g, g.depots.get(depot)!, id)), 'native depot reaches both mail stops');
    assert.equal(nativeRoadItinerary(g, line)?.stops.length, 2, 'native service completes both directed mail calls');
    assert(g.mail.accepts(pr.A) && g.mail.accepts(pr.B), 'actual mail service accepts at both resident destinations');
    for (let target = 1; target < 15; target++) merge(g, target + 1, target);
    merge(g, 0, 15);
    const saved = serialize(g), loaded = deserialize(saved);
    for (const h of [g, loaded]) {
      const destination = h.stations.get(pr.B.id)!;
      assert(h.mail.accepts(destination));
      const distance = Math.hypot(pr.A.x - pr.B.x, pr.A.z - pr.B.z), count = 7, seconds = 100;
      const before = h.companies.map(c => c.economy.current.mailIncome);
      const deliveries = stationMail(h, destination).arrivedMonth;
      settleMail(h, destination, count, { o: pr.A.id, od: distance, p: simNow(h) - seconds, c: 1, legs: [[-1, -1, 1, distance]] }, null);
      const expected = mailFare(distance, seconds, count, 1);
      near(h.companies[0].economy.current.mailIncome - before[0], expected, 'final buyer receives the complete fare');
      for (let id = 1; id < h.companies.length; id++) near(h.companies[id].economy.current.mailIncome - before[id], 0, 'retired company earns no new mail');
      near(stationMail(h, destination).arrivedMonth - deliveries, count, 'delivered units conserved');
    }
    assert.equal(JSON.stringify(serialize(loaded)), JSON.stringify(serialize(g)));
    for (let tick = 0; tick < 64; tick++) { g.stepTick(); loaded.stepTick(); }
    assert.equal(JSON.stringify(serialize(loaded)), JSON.stringify(serialize(g)), 'native service replays exactly after acquired-leg settlement');
  }],
];
for (const [label, run] of tests) {
  try { run(); console.log(`PASS ${label}`); }
  catch (error) { console.error(`FAIL ${label}:`, error); process.exitCode = 1; }
}
