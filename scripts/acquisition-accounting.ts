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
import { placeAndConnect, depotBehind } from './lib';

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
    const g = Game.create({ size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 15 });
    g.aiEnabled = false; g.aiAcquisitions = false; g.economy.money = 1e9;
    const pr = placeAndConnect(g, 80, 160, 0, new Set(), 1, () => {});
    assert(pr);
    const depot = depotBehind(g, pr.A, pr.B, 0), line = g.lines.create('rail', 0);
    line.stops = [pr.A.id, pr.B.id];
    assert(g.vehicles.buyTrain(depot, [stock[0], MODEL_BY_ID.get('van_ic')!], line.id));
    g.lines.rebuild();
    assert(g.mail.accepts(pr.B), 'actual mail service accepts at destination');
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
  }],
];
for (const [label, run] of tests) {
  try { run(); console.log(`PASS ${label}`); }
  catch (error) { console.error(`FAIL ${label}:`, error); process.exitCode = 1; }
}
