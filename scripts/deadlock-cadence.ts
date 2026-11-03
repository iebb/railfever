// Paid opposing services: gameplay recovery responds earlier without changing native refuge safety.
import '../src/game/patterns';
import assert from 'node:assert/strict';
import { Game, TICK, TICKS_PER_DAY } from '../src/game/game';
import { Train, deadlockCycles, resolveDeadlocks } from '../src/game/train';
import { outAndBack } from '../src/game/lines';
import { setSignal } from '../src/game/signals';
import { connectStationThroat } from '../src/game/trackops';
import { serialize, deserialize } from '../src/game/save';
import { station, endNode, depotFor, loco, build, nodeSnap, railOpts } from './stationlib';
import { checkReservations } from './lib';

assert(process.argv[1]?.endsWith('deadlock-cadence.mjs'), 'bundle as deadlock-cadence.mjs');
const saved = (g: Game) => JSON.stringify(serialize(g));
const cold = (raw: string) => {
  const g = deserialize(JSON.parse(raw));
  assert.equal(saved(g), raw, 'independent cold full-save round trip');
  return g;
};
// Townless fixture terrain is immutable; compare all other saved state each tick and whole saves daily.
const dynamic = (g: Game) => { const { world, ...state } = serialize(g); return JSON.stringify(state); };
const g = Game.create({ size: 256, seed: 7, towns: 0, hilliness: 'flat', water: 'low',
  startYear: 1990, aiCompanies: 1, startMoney: 1_000_000_000 });
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
g.world.h.fill(3); g.world.heightsVersion++;
for (const t of g.world.trees) if (t) g.world.removeTreesNear(t.x, t.z, 0.1);
const moneyBefore = g.companies.map(c => c.economy.money);
const A = station(g, 40, 128, Math.PI / 2, 12, 2, 0);
const B = station(g, 145, 128, Math.PI / 2, 12, 1, 0);
const C = station(g, 205, 128, Math.PI / 2, 12, 2, 1);
assert(A && B && C, 'fixed native opposing fixture stations');
assert(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
  nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0)), 'paid A-B');
assert(build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'),
  nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(1)), 'paid B-C');
for (const front of [false, true]) {
  const n = g.world.net.nodes.get(endNode(g, B, 0, front))!;
  const e = n.edges.map(id => g.world.net.edges.get(id)!).find(e => e.station < 0)!;
  assert(!setSignal(g, e.id, front ? (e.a === n.id ? 2 : e.len - 2) : (e.a === n.id ? 0 : e.len),
    'twoway', true, e.owner), 'native junction path signal');
}
for (const st of [A, C]) assert.equal(connectStationThroat(g, st.id, st.owner).connected, 1);
const dA = depotFor(g, A, B, 0), dC = depotFor(g, C, B, 1);
assert(dA >= 0 && dC >= 0, 'paid native depots');
const line = g.lines.create('rail', 0);
line.stops = outAndBack([A.id, B.id, C.id]); line.evenSpacing = false;
g.lines.setPartnerPolicy(line.id, 'open');
assert.equal(g.lines.join(line.id, 1), null, 'native partner permission');
g.lines.rebuild();
const a = g.vehicles.buyTrain(dA, loco(), line.id), b = g.vehicles.buyTrain(dC, loco(), line.id);
assert(a instanceof Train && b instanceof Train, 'native paid opposing trains');
a.stopIndex = 1; b.stopIndex = 3;
assert(g.companies.every((c, i) => c.economy.money < moneyBefore[i]), 'construction and stock actually paid');
let cycle: Train[] | undefined;
for (let i = 0; i < 200 * TICKS_PER_DAY; i++) {
  g.stepTick();
  cycle = deadlockCycles(g, 0).find(c => c.includes(a) && c.includes(b));
  if (cycle && cycle.every(t => t.speed <= 0.01)) break;
}
assert(cycle?.length === 2 && cycle.every(t => t.speed <= 0.01), 'actual stopped native reservation cycle');
assert(!g.deadlockScan && !a.backoff && !b.backoff, 'checkpoint precedes native recovery');
assert(cycle.some(t => t.stuckTime < 10), 'checkpoint predates new eligibility, without forged wait ages');
const initial = saved(g), twin = cold(initial), start = g.tick;
const diagnostic = cold(initial);
assert.equal(resolveDeadlocks(diagnostic), false, 'public diagnostic default still waits forty seconds');
assert.equal(saved(diagnostic), initial, 'default diagnostic leaves this young native cycle intact');

// A native non-default continuation must keep its own threshold when Game resumes it.
const sliced = cold(initial);
resolveDeadlocks(sliced, 0, 1);
assert(sliced.deadlockScan && sliced.deadlockScan.minWait === 0, 'native budget-one saved scan');
const loaded = cold(saved(sliced));
let completed = false;
for (let i = 0; i < 128; i++) {
  sliced.stepTick(); loaded.stepTick();
  assert.equal(saved(sliced), saved(loaded), 'saved scan and retreat exact at every tick');
  if (sliced.deadlockScan) assert.equal(sliced.deadlockScan.minWait, 0, 'active saved policy remains authoritative');
  else { completed = true; break; }
}
assert(completed, 'small native continuation completes');

// This tiny two-train fixture fits a normal scan slice. This bound is not a whole-fleet deadline.
const responseBound = Math.ceil(10 / TICK) + TICKS_PER_DAY + 1;
let firstRecovery = -1;
for (let i = 0; i < responseBound; i++) {
  g.stepTick(); twin.stepTick();
  assert.equal(dynamic(g), dynamic(twin), 'response exact at every fixed tick');
  if (g.tick % TICKS_PER_DAY === 0) assert.equal(saved(g), saved(twin), 'daily full response save exact');
  if (a.backoff || b.backoff) { firstRecovery = g.tick; break; }
}
assert(firstRecovery >= 0 && firstRecovery - start <= responseBound,
  'small native opposing cycle begins a guarded retreat within ten seconds plus one day');
const retreatSave = saved(g), replay = cold(retreatSave);
const calls = new Map<number, number>(), previous = new Map<number, string>();
let movingRetreat = false, resumed = false;
for (let i = 0; i < 300 * TICKS_PER_DAY; i++) {
  const before = [a, b].map(t => { const p = { x: 0, y: 0, z: 0 }; t.pointBehind(t.length / 2, p); return { onMap: t.onMap, p }; });
  g.stepTick(); twin.stepTick(); replay.stepTick();
  const ref = dynamic(g);
  assert.equal(dynamic(twin), ref, 'initial cold replay exact throughout service');
  assert.equal(dynamic(replay), ref, 'mid-retreat cold replay exact throughout service');
  if (g.tick % TICKS_PER_DAY === 0) {
    assert.equal(saved(twin), saved(g), 'daily full initial replay exact');
    assert.equal(saved(replay), saved(g), 'daily full retreat replay exact');
  }
  const occupied = new Map<number, number>();
  for (const [j, t] of [a, b].entries()) {
    const p = { x: 0, y: 0, z: 0 }; t.pointBehind(t.length / 2, p);
    const old = before[j];
    assert(!t.onMap || !old.onMap || Math.hypot(p.x - old.p.x, p.y - old.p.y, p.z - old.p.z) <= t.maxSpeed * TICK + 0.02,
      'native body moves within its physical tick speed');
    if (t.state === 'loading' && previous.get(t.id) !== 'loading') calls.set(t.id, (calls.get(t.id) ?? 0) + 1);
    previous.set(t.id, t.state);
    movingRetreat ||= !!t.backoff && t.speed > 0.05;
    for (const e of t.occupiedEdges()) {
      assert(!occupied.has(e) || occupied.get(e) === t.id, 'exclusive occupied track');
      assert.equal(g.vehicles.getRes(e), t.id, 'whole occupied body reserved'); occupied.set(e, t.id);
    }
  }
  resumed ||= !a.backoff && !b.backoff;
}
assert(movingRetreat && resumed, 'native physical retreat moves and finishes');
assert([a, b].every(t => (calls.get(t.id) ?? 0) >= 2), 'both paid services make real calls after recovery');
assert.equal(saved(twin), saved(g)); assert.equal(saved(replay), saved(g));
assert.equal(checkReservations(g).length, 0, 'all native reservations consistent');
console.log(JSON.stringify({ status: 'PASS', start, firstRecovery, responseBound, calls: [...calls],
  fixture: 'original paid opposing geometry; borrowed startMoney1e9; no synthetic wait/reservation',
  legacyQualification: 'native saved minWait0 continuation; literal40 continuation source unchanged' }));
console.log('ALL CHECKS PASSED');
