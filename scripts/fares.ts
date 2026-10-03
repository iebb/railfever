// Fare-history and change-class cohorts through waiting, boarding, transfers, absorption and line redirects; the
// transfer reduction (each change of vehicle takes 10% off the leg ending in it and every later leg).
// Bundle as fares.mjs (esbuild --bundle --platform=node --format=esm) and run with node.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import type { CargoGroup } from '../src/game/vehicle';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { distanceFare, railLegFare, speedFactor, fareFor, simNow, railHistory, FARE_LEVEL, TRANSFER_FARE_FACTOR, transferFareFactor, CHANGE_CLASSES } from '../src/game/fares';
import { RAIL_FARE } from '../src/game/constants';
import { serialize, deserialize } from '../src/game/save';
import { canonicalizeLines } from '../src/game/patterns';
import { bezLine } from '../src/game/geom';
import { addBusStop, check, fails } from './lib';

/** Small deterministic passenger fixture, also used by the save regressions. */
export function fareFixture() {
  const g = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000 });
  g.aiEnabled = false; g.economy.money = 1e9; g.world.h.fill(4); g.world.heightsVersion++;
  const net = g.world.net, a = net.addNode('road', 20, 4, 60, 0, 0, -1), b = net.addNode('road', 220, 4, 60, 0, 0, -1);
  net.addEdge('road', a.id, b.id, bezLine(20, 60, 220, 60), new Float32Array(201).fill(4), [], 'street', -1);
  const ids = [40, 52, 64, 88, 140].map((x) => addBusStop(g, x, 60, 0));
  assert(ids.every((id) => id >= 0));
  g.tick = 4000;
  return { g, ids, stations: ids.map((id) => g.stations.get(id)!) };
}

export function fareTrain(g: Game, stops: number[]) {
  const l = g.lines.create('rail'); l.stops = stops;
  const t = new Train(g, g.vehicles.nextId++, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!], -1);
  t.lineId = l.id; t.state = 'stopped'; g.vehicles.map.set(t.id, t); l.vehicles.push(t.id);
  return { t, l };
}

function settle(g: Game, t: Train, to: number, groups: CargoGroup[]) {
  t.cargo.clear(); t.load = 0;
  groups.forEach((c, i) => { t.cargo.set('probe' + i, { ...c }); t.load += c.count; });
  const before = t.incomeYear;
  t.serveStation(g.stations.get(to)!, 0);
  return t.incomeYear - before;
}

function regressions() {
  // A first rail minimum and an already paid minimum must remain separate at every boarding.
  {
    const { g, ids, stations } = fareFixture(), { t, l } = fareTrain(g, [ids[0], ids[1]]);
    const now = simNow(g), prior = distanceFare(12);
    const groups: CargoGroup[] = [
      { from: ids[0], alight: ids[1], dest: ids[1], count: 1, day: g.day, t0: now - 40, transfers: 0 },
      { from: ids[0], alight: ids[1], dest: ids[1], count: 1, day: g.day, t0: now - 40, transfers: 1, rail: prior },
    ];
    const separate = settle(g, t, ids[1], groups);
    g.stations.addWaiting(stations[0], l.id, ids[1], ids[1], 1, 0, now - 40, 0, 0);
    g.stations.addWaiting(stations[0], l.id, ids[1], ids[1], 1, 0, now - 40, 1, prior);
    check(stations[0].waiting.size === 2, 'fresh and transfer waiting histories stay in distinct cohorts');
    t.stopIndex = 0; t.serveStation(stations[0], 0);
    check(t.load === 2 && t.cargo.size === 2, 'both fare cohorts board separately');
    const before = t.incomeYear; t.serveStation(stations[1], 0);
    const together = t.incomeYear - before;
    console.log(`mixed waiting receipts: separate ${separate}, together ${together}`);
    check(Math.abs(together - separate) < 1e-8, 'mixed waiting preserves aggregate rail receipts');
  }
  {
    const { g, ids, stations } = fareFixture(), { t, l } = fareTrain(g, [ids[0], ids[1]]);
    const now = simNow(g), prior = distanceFare(12);
    // First board the transfer, then a fresh arrival during the dwell (the actual cargo-combining path).
    g.stations.addWaiting(stations[0], l.id, ids[1], ids[1], 1, 0, now - 40, 1, prior);
    t.serveStation(stations[0], 0);
    g.stations.addWaiting(stations[0], l.id, ids[1], ids[1], 1, 0, now - 40);
    t.continueBoarding(1);
    // (the fresh passenger rides directly: the full fare; the other changed vehicles once before: x0.9)
    const expected = fareFor(12, 40, 1, { mode: 'rail' })
      + fareFor(12, 40, 1, { mode: 'rail', railBefore: prior }) * TRANSFER_FARE_FACTOR;
    const before = t.incomeYear; t.serveStation(stations[1], 0);
    const actual = t.incomeYear - before;
    console.log(`mixed boarding receipts: expected ${expected}, actual ${actual}`);
    check(Math.abs(actual - expected) < 1e-8, 'boarding fresh arrivals into transfer cargo preserves receipts');
  }

  // Passengers with different changes of vehicle so far pay different transfer reductions: never one group (as with
  // fare histories), waiting or aboard; the 3+ class gathers the rest, its fare from the class's mean changes.
  {
    const { g, ids, stations } = fareFixture(), { t, l } = fareTrain(g, [ids[0], ids[1]]);
    g.lines.rebuild();
    const now = simNow(g), changes = [0, 1, 2, 3, 4];
    // (one rail history for all, at the minimum: only the changes differ)
    for (const k of changes) g.stations.addWaiting(stations[0], l.id, ids[1], ids[1], 2, 0, now - 40, 2 * k, RAIL_FARE.minimum);
    const totals = [...stations[0].waiting.values()].map((w) => w.transfers ?? 0).sort((a, b) => a - b);
    check(stations[0].waiting.size === CHANGE_CLASSES + 1 && JSON.stringify(totals) === JSON.stringify([0, 2, 4, 14]),
      `waiting passengers with 0, 1, 2 and 3+ changes form ${CHANGE_CLASSES + 1} groups, keeping every change (${totals})`);
    t.stopIndex = 0; t.serveStation(stations[0], 0);
    check(t.cargo.size === CHANGE_CLASSES + 1 && t.load === 2 * changes.length && JSON.stringify([...t.cargo.values()].map((c) => c.transfers ?? 0).sort((a, b) => a - b)) === JSON.stringify(totals),
      'they board as separate cargo groups with their changes');
    const before = t.incomeYear; t.serveStation(stations[1], 0);
    const receipts = t.incomeYear - before;
    const exact = changes.reduce((sum, k) => sum + fareFor(12, 40, 2, { mode: 'rail', railBefore: RAIL_FARE.minimum }) * transferFareFactor(k), 0);
    console.log(`change classes: receipts ${receipts}, exact ${exact}`);
    check(Math.abs(receipts / exact - 1) < 0.001, 'their receipts are the exact transfer reductions (the 3+ class within a tenth of a percent)');
    const data = JSON.stringify(serialize(g));
    check(JSON.stringify(serialize(deserialize(JSON.parse(data)))) === data, 'change classes round-trip exactly');
  }
  // A journey with one change earns 10% less than direct, whatever the split of its legs; two changes 10-19% less.
  {
    const { g, ids, stations } = fareFixture(), a = fareTrain(g, [ids[0], ids[2]]), b = fareTrain(g, [ids[2], ids[4]]), c = fareTrain(g, [ids[0], ids[4]]);
    g.lines.rebuild();
    const now = simNow(g), leg = (from: number, to: number) => Math.hypot(stations[from].x - stations[to].x, stations[from].z - stations[to].z);
    const pay = (t: Train, from: number, to: number, transfers: number, rail = 0) => {
      t.cargo.clear(); t.load = 10;
      t.cargo.set('j', rail ? { from: ids[from], alight: ids[to], dest: ids[4], count: 10, day: g.day, t0: now - 60, transfers, rail }
        : { from: ids[from], alight: ids[to], dest: ids[4], count: 10, day: g.day, t0: now - 60, transfers });
      const before = t.incomeYear; t.serveStation(stations[to], 0); return t.incomeYear - before;
    };
    const history = railHistory(distanceFare(leg(0, 2)));
    const direct = pay(c.t, 0, 4, 0), first = pay(a.t, 0, 2, 0), second = pay(b.t, 2, 4, 10, history);
    const plain = fareFor(leg(0, 2), 60, 10, { mode: 'rail' }) + fareFor(leg(2, 4), 60, 10, { mode: 'rail', railBefore: history });
    console.log(`one change: legs ${first} + ${second} against ${plain} without the reduction (direct ${direct})`);
    check(Math.abs((first + second) / plain - TRANSFER_FARE_FACTOR) < 1e-9 && Math.abs(first / fareFor(leg(0, 2), 60, 10, { mode: 'rail' }) - TRANSFER_FARE_FACTOR) < 1e-9,
      'a journey with one change earns x0.9 on both legs: 10% less than the same legs without a change');
  }

  // Partial boarding and rail -> road -> rail transfers retain both cohorts' per-passenger histories.
  {
    const { g, ids, stations } = fareFixture(), first = fareTrain(g, [ids[0], ids[1]]), last = fareTrain(g, [ids[2], ids[3]]);
    const road = g.lines.create('road'); road.stops = [ids[1], ids[2]];
    const bus = new RoadVehicle(g, g.vehicles.nextId++, MODEL_BY_ID.get('bus_c')!, -1, false);
    bus.lineId = road.id; bus.state = 'stopped'; g.vehicles.map.set(bus.id, bus); road.vehicles.push(bus.id);
    g.lines.rebuild();
    const now = simNow(g), earlier = [100, 200], histories = earlier.map((r) => r + distanceFare(12));
    assert(histories.every((r) => r < RAIL_FARE.minimum), 'both transferred histories stay below the cap');
    earlier.forEach((rail, i) => first.t.cargo.set('p' + i,
      { from: ids[0], alight: ids[1], dest: ids[3], count: 4, day: g.day, t0: now - 40, transfers: 4, rail }));
    first.t.load = 8; first.t.serveStation(stations[1], 0);
    const hasBoth = (groups: Iterable<{ rail?: number }>) => JSON.stringify([...groups].map((c) => c.rail).sort()) === JSON.stringify([...histories].sort());
    check(hasBoth(stations[1].waiting.values()), 'rail alighting retains both histories on transfer waiting');
    bus.serveStation(stations[1], 0);
    check(bus.load === 8 && hasBoth(bus.cargo.values()), 'road cargo keeps both earlier rail histories');
    bus.serveStation(stations[2], 0);
    g.stations.rerouteWaiting(stations[2]); g.lines.rebuild();
    check(hasBoth(stations[2].waiting.values()), 'road transfers and both waiting reroute paths keep fare cohorts');
    const data = JSON.stringify(serialize(g));
    check(JSON.stringify(serialize(deserialize(JSON.parse(data)))) === data, 'transfer waiting cohorts round-trip exactly');
    last.t.load = last.t.capacity - 2;
    last.t.serveStation(stations[2], 0);
    check([...last.t.cargo.values()].every((c) => c.rail === histories[0]) && hasBoth(stations[2].waiting.values()),
      'partial boarding preserves per-passenger history in cargo and residual waiting');
    const parallel = fareTrain(g, [ids[2], ids[3]]);
    for (const rail of histories) g.lines.distribute({ line: last.l.id, alight: ids[3], cost: 1, lines: [last.l.id, parallel.l.id] }, 20,
      (line, n) => g.stations.addWaiting(stations[2], line, ids[3], ids[3], n, 0, now, n, rail));
    check([...stations[2].waiting.values()].every((w) => histories.includes(w.rail!)), 'parallel-service distribution keeps each fare history unscaled');
  }
  {
    const { g, ids, stations } = fareFixture(), next = fareTrain(g, [ids[1], ids[3]]);
    g.lines.rebuild();
    for (const rail of [200, 300]) (g.stations as any).walkTo(ids[1], ids[3], 3, 0, simNow(g), 3, stations[0], rail);
    check(stations[1].waiting.size === 2 && [...stations[1].waiting.values()].every((w) => w.line === next.l.id && w.count === 3 && [200, 300].includes(w.rail!)),
      'walking transfers retain separate fare cohorts');
  }

  // Once earlier distance fares reach the minimum, every later rail leg pays its full distance fare.
  {
    const { g, ids, stations } = fareFixture(), first = fareTrain(g, [ids[0], ids[1]]),
      middle = fareTrain(g, [ids[1], ids[2]]), last = fareTrain(g, [ids[2], ids[3]]);
    g.lines.rebuild();
    const now = simNow(g), histories = [RAIL_FARE.minimum, RAIL_FARE.minimum + 0.25, 600, 50_000];
    for (const d of [2, 12, 24, 100, 800]) check(histories.every((r) => Math.abs(railLegFare(d, r) - distanceFare(d)) < 1e-8),
      `at/above-minimum histories pay identical full distance fares for a ${d}-unit leg`);
    for (const rail of histories) g.stations.addWaiting(stations[0], first.l.id, ids[1], ids[3], 1, 0, now - 40, 1, rail);
    const waiting = [...stations[0].waiting.values()];
    check(waiting.length === 1 && waiting[0].rail === RAIL_FARE.minimum && waiting[0].count === histories.length && waiting[0].transfers === histories.length,
      'at/above-minimum waiting histories merge into one capped cohort without losing passengers or flags');
    first.t.serveStation(stations[0], 0);
    // A later above-minimum arrival must also merge with the already boarded cargo during its dwell.
    histories.push(900);
    g.stations.addWaiting(stations[0], first.l.id, ids[1], ids[3], 1, 0, now - 40, 1, histories.at(-1)!);
    first.t.continueBoarding(1);
    const cargo = [...first.t.cargo.values()];
    check(cargo.length === 1 && cargo[0].rail === RAIL_FARE.minimum && cargo[0].count === histories.length && cargo[0].transfers === histories.length,
      'at/above-minimum cargo histories merge during boarding and dwell');
    const before = first.t.incomeYear;
    first.t.serveStation(stations[1], 0);
    const receipts = first.t.incomeYear - before;
    // (one change before this leg and one at its end: x0.81)
    const factor = transferFareFactor(2);
    const separate = histories.reduce((sum, railBefore) => sum + fareFor(12, 40, 1, { mode: 'rail', railBefore }) * factor, 0);
    check(Math.abs(receipts - separate) < 1e-8 && Math.abs(receipts - histories.length * FARE_LEVEL * distanceFare(12) * speedFactor(12, 40) * factor) < 1e-8,
      'merged capped cargo earns identical receipts to separate uncapped histories');
    for (const [service, from, to, d] of [[middle, 1, 2, 12], [last, 2, 3, 24]] as const) {
      const queue = [...stations[from].waiting.values()];
      check(queue.length === 1 && queue[0].rail === RAIL_FARE.minimum && queue[0].count === histories.length && queue[0].transfers === histories.length * (from + 1),
        `rail transfer ${from} keeps one saturated history cohort with its changes of vehicle`);
      service.t.serveStation(stations[from], 0);
      const income = service.t.incomeYear;
      service.t.serveStation(stations[to], 0);
      // (the middle leg after two changes ends in a third, the last leg after three: x0.729 each)
      check(Math.abs(service.t.incomeYear - income - histories.length * FARE_LEVEL * distanceFare(d) * speedFactor(d, 0) * transferFareFactor(3)) < 1e-8,
        `later rail leg ${from} pays its full distance fare after capping, less its transfer reduction`);
    }
  }

  // A busy interchange needs one saturated group per route tuple, however many histories arrive there.
  {
    const { g, ids, stations } = fareFixture(), incoming = fareTrain(g, [ids[0], ids[1]]), outgoing = fareTrain(g, [ids[1], ids[3]]);
    g.lines.rebuild();
    const now = simNow(g), arrivals = 256, st = stations[1];
    [0, 200, 300].forEach((rail, i) => g.stations.addWaiting(st, outgoing.l.id, ids[3], ids[3], i + 1, 0, now, rail ? i + 1 : 0, rail));
    let maxGroups = st.waiting.size;
    for (let i = 0; i < arrivals; i++) {
      settle(g, incoming.t, ids[1], [{ from: ids[0], alight: ids[1], dest: ids[3], count: 1, day: g.day,
        t0: now - 40, transfers: 1, rail: RAIL_FARE.minimum + i * 0.125 }]);
      maxGroups = Math.max(maxGroups, st.waiting.size);
    }
    const waiting = [...st.waiting.values()], saturated = waiting.find((w) => w.rail === RAIL_FARE.minimum);
    check(maxGroups === 4 && waiting.length === 4 && waiting.every((w) => w.line === outgoing.l.id && w.alight === ids[3] && w.dest === ids[3]),
      '256 distinct above-minimum transfer histories stay bounded to four groups with fresh and two sub-minimum cohorts');
    // (each arrival changed vehicles before and changes again here: two changes each)
    check(saturated?.count === arrivals && saturated.transfers === 2 * arrivals && saturated.t === now && st.waitingTotal === arrivals + 6,
      'bounded interchange queues retain every arrival, change of vehicle and waiting clock');
    g.stations.rerouteWaiting(st); g.lines.rebuild();
    check(st.waiting.size === 4, 'rerouting the busy interchange keeps the same group bound');
    outgoing.t.serveStation(st, 0);
    const all = [...outgoing.t.cargo.values(), ...st.waiting.values()];
    check(outgoing.t.cargo.size === 4 && st.waiting.size <= 4 && outgoing.t.load === Math.min(outgoing.t.capacity, arrivals + 6)
      && all.every((c) => [0, 200, 300, RAIL_FARE.minimum].includes(c.rail ?? 0))
      && [0, 200, 300, RAIL_FARE.minimum].every((rail, i) => all.filter((c) => (c.rail ?? 0) === rail).reduce((sum, c) => sum + c.count, 0) === [1, 2, 3, arrivals][i]),
      'boarding a bounded interchange keeps cargo bounded and conserves each fare cohort');
    const data = JSON.stringify(serialize(g));
    check(JSON.stringify(serialize(deserialize(JSON.parse(data)))) === data, 'bounded waiting and cargo cohorts round-trip exactly');
  }

  // Absorption preserves the queues it moves and those elsewhere whose destinations it re-keys.
  {
    const { g, ids, stations } = fareFixture(), { t, l } = fareTrain(g, [ids[0], ids[1], ids[3]]);
    const now = simNow(g), incoming = fareTrain(g, [ids[4], ids[1]]);
    g.lines.rebuild();
    g.stations.addWaiting(stations[0], l.id, ids[3], ids[3], 1, 0, now - 20, 0);
    g.stations.addWaiting(stations[1], l.id, ids[3], ids[3], 2, 0, now - 80, 2, 200);
    // (one passenger with the same history who changed twice: a group of its own)
    g.stations.addWaiting(stations[1], l.id, ids[3], ids[3], 1, 0, now - 60, 2, 200);
    g.stations.addWaiting(stations[4], incoming.l.id, ids[1], ids[1], 2, 0, now - 70, 2, 300);
    // Same history converging from two boarding stops: preserve individual timing and transfer flags too.
    [ids[0], ids[1]].forEach((from, i) => t.cargo.set('absorb' + i,
      { from, alight: ids[3], dest: ids[3], count: i + 1, day: g.day - i, t0: now - 30 - i * 50, transfers: i * 2, rail: 300 }));
    t.load = 3;
    assert.equal(g.stations.merge(ids[0], ids[1]), null, 'nearby bus stops merge');
    const moved = [...stations[0].waiting.values()].find((w) => w.rail === 200 && w.count === 2);
    const twice = [...stations[0].waiting.values()].find((w) => w.rail === 200 && w.count === 1);
    const redirected = [...stations[4].waiting.values()][0];
    check(stations[0].waiting.size === 3 && moved?.count === 2 && twice?.count === 1, 'absorption keeps fresh and transfer fare histories and change classes distinct');
    check(moved?.t === now - 80 && moved.transfers === 2 && twice?.t === now - 60 && twice.transfers === 2, 'absorption retains moved waiting times and changes of vehicle');
    check(redirected?.alight === ids[0] && redirected.dest === ids[0] && redirected.t === now - 70 && redirected.transfers === 2 && redirected.rail === 300,
      'absorption retains waiting time, transfers and history when re-keying other stations');
    check(t.cargo.size === 2 && [...t.cargo.values()].every((c, i) => c.from === ids[0] && c.t0 === now - 30 - i * 50 && c.transfers === i * 2 && c.rail === 300),
      'absorbed cargo retains individual timing, transfer flags and fare history');
    const data = JSON.stringify(serialize(g));
    check(JSON.stringify(serialize(deserialize(JSON.parse(data)))) === data, 'absorbed queues and converged cargo round-trip exactly');
  }

  // Canonicalising two parallel lines calls patterns.redirectWaiting, then Lines.rerouteWaiting.
  {
    const { g, ids, stations } = fareFixture(), a = fareTrain(g, [ids[0], ids[3]]), b = fareTrain(g, [ids[0], ids[3]]);
    g.lines.rebuild();
    const now = simNow(g);
    g.stations.addWaiting(stations[0], a.l.id, ids[3], ids[3], 2, 0, now - 40, 0);
    g.stations.addWaiting(stations[0], b.l.id, ids[3], ids[3], 3, 0, now - 80, 3, 200);
    canonicalizeLines(g, a.l.id);
    check(g.lines.all().length === 1, 'parallel lines canonicalise to one service');
    const waiting = [...stations[0].waiting.values()];
    const transfer = waiting.find((w) => w.rail === 200);
    check(waiting.length === 2 && waiting.every((w) => w.line === a.l.id) && transfer?.t === now - 80 && transfer.count === 3 && transfer.transfers === 3,
      'line redirects retain distinct fare histories and their waiting state');
  }
}

if (process.argv[1]?.endsWith('fares.mjs')) {
  regressions();
  console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
  process.exitCode = fails.length ? 1 : 0;
}
