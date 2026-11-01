// Timing must preserve native scheduling, including daily(false), shared reviews and monthly management.
import assert from 'node:assert/strict';
import { flatGame, station, endNode, build, nodeSnap, railOpts, loco, depotFor } from './stationlib';
import { observeAITiming, checkReservations } from './lib';
import { Train } from '../src/game/train';
import { openingRailCall } from '../src/game/ai';
import { connectStationThroat } from '../src/game/trackops';
import { sharedCapacityPlan } from '../src/game/ai-capacity';
import { serialize, deserialize } from '../src/game/save';
import type { Game } from '../src/game/game';

let checks = 0;
function check(value: unknown, message: string): asserts value { assert(value, message); checks++; }
const saved = (g: Game) => JSON.stringify(serialize(g));
const cold = (g: Game) => deserialize(JSON.parse(saved(g)));
const g = flatGame(256); g.aiEnabled = false; g.aiAcquisitions = false; g.vehicles.ambientEnabled = false;
for (let i = 0; i < 2; i++) g.addAICompany({ startMoney: 50_000_000, accessPolicy: 'open', focus: { rail: 3, road: 0, tram: 0 } });
g.refreshAccess();
const A = station(g, 20, 128, Math.PI / 2, 10, 2, 1), B = station(g, 236, 128, Math.PI / 2, 10, 2, 2);
check(A && B, 'quiet native stations really build');
check(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(1)),
  'native shared running line really builds');
for (const st of [A, B]) check(!connectStationThroat(g, st.id, st.owner).failed.length, 'native station throat completes');
const line = g.lines.create('rail', 1); line.stops = [A.id, B.id]; g.lines.invite(line.id, 2); g.lines.rebuild();
check(line.operators?.includes(2), 'second operator has a real native service agreement');
for (const [st, towards] of [[A, B], [B, A]]) {
  const depot = depotFor(g, st, towards, st.owner); check(depot >= 0, 'each operator owns a paid reachable depot');
  const train = g.vehicles.buyTrain(depot, loco(), line.id); check(train instanceof Train, 'operator buys an entire native consist');
  train.stopIndex = openingRailCall(g, train); check(train.stopIndex >= 0, 'paid stock has a lawful whole-consist opening route');
}
g.stations.refreshAccess(true); g.lines.flushCatchment(); g.demand.rebuild();
check(!g.towns.list.length && !g.world.buildings.size && [A, B].every(st => st.catchPop === 0)
  && line.incomeLast === 0 && line.incomeYear === 0, 'quiet fares arise from genuinely empty native catchments');
check(g.companies.slice(1).every(c => c.economy.money < 50_000_000), 'both operators paid actual infrastructure and stock costs');
const agreement = sharedCapacityPlan(g, line);
check(agreement.withdraw.length > 0 && agreement.withdraw.every(w => w.value < 0), 'native economics identifies the unprofitable paid operation without fake fares');
g.aiEnabled = true;
const initial = saved(g), baseline = cold(g), faithful = cold(g), dropped = cold(g);
const timing = observeAITiming(faithful);
check(saved(faithful) === initial && saved(baseline) === initial, 'installing the observer is a pure change to unsaved method references');
// Exact preimage of scripts/ai.ts: Game supplies false, but this wrapper invokes the default true.
for (const ai of dropped.ais) { const daily = ai.daily.bind(ai); ai.daily = () => daily(); }
let divergence: { tick: number; day: number; native: number[]; dropped: number[]; nativeCash: number[]; droppedCash: number[] } | undefined;
for (let tick = 0; tick < 640; tick++) {
  baseline.stepTick(); faithful.stepTick(); dropped.stepTick();
  check(saved(baseline) === saved(faithful), `faithful timing preserves every saved field at native tick ${tick + 1}`);
  if (!divergence && saved(baseline) !== saved(dropped)) {
    divergence = { tick: baseline.tick, day: baseline.day, native: [...baseline.vehicles.map.keys()], dropped: [...dropped.vehicles.map.keys()],
      nativeCash: baseline.companies.slice(1).map(c => c.economy.money), droppedCash: dropped.companies.slice(1).map(c => c.economy.money) };
  }
}
check(divergence?.day === 1 && divergence.tick === g.ticksPerDay && divergence.dropped.length < divergence.native.length,
  'argument-dropping preimage really withdraws paid stock early at the first daily boundary');
check(timing.every(t => t.n === baseline.day && t.calls.daily === baseline.day && t.calls.sharedCapacityDaily === baseline.day
  && t.calls.work === baseline.tick && t.calls.monthly === 1), 'all four native entry points are counted with exactly one daily denominator');
check(timing.every(t => t.t >= 0 && t.max >= 0) && !checkReservations(baseline).length && !checkReservations(faithful).length,
  'all measured native work preserves lawful reservations');
const loaded = cold(faithful); observeAITiming(loaded);
for (let tick = 0; tick < 128; tick++) {
  baseline.stepTick(); faithful.stepTick(); loaded.stepTick();
  check(saved(baseline) === saved(faithful) && saved(faithful) === saved(loaded), 'observer reconstruction preserves exact native save replay');
}

// Isolated observer boundary contract: this clock checks arithmetic/exception coverage, not performance.
// These stubs never participate in the operating/economic proof above.
const contract = deserialize(JSON.parse(initial)), ai = contract.ais[0], marker = {}, failure = new Error('observer sentinel');
let stamp = 0, self: unknown, args: unknown;
ai.daily = function (...a) { self = this; args = a; stamp += 2; return marker as never; };
ai.work = function (...a) { self = this; args = a; stamp += 5; throw failure; };
ai.sharedCapacityDaily = () => { stamp += 7; };
ai.monthly = () => { stamp += 11; };
const observed = observeAITiming(contract, () => stamp)[0];
check((ai.daily(false) as unknown) === marker && self === ai && JSON.stringify(args) === '[false]', 'typed daily arguments, receiver and result pass through unchanged');
let caught: unknown; try { ai.work(3, 4); } catch (error) { caught = error; }
check(caught === failure && self === ai && JSON.stringify(args) === '[3,4]', 'work arguments and original thrown object pass through unchanged');
ai.sharedCapacityDaily(); ai.monthly();
check(observed.t === 25 && observed.n === 1 && observed.max === 11 && observed.peak.startsWith('monthly:')
  && Object.values(observed.calls).every(n => n === 1), 'finally records failures, scheduled capacity and monthly work without inflating the daily denominator');
console.log(`PASS ${checks} AI observer checks`, JSON.stringify({ divergence, days: faithful.day, ticks: faithful.tick,
  entries: timing.map(t => ({ daily: t.n, calls: t.calls })), economicOverrides: false, nativeExact: true }));
