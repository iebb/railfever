// An atomic terminal-to-terminal service needs one real receiving slot free, across all operators.
import { serialize, deserialize } from '../src/game/save';
import { Train, deadlockCycles } from '../src/game/train';
import { atomicTerminalCell, blockedTerminalCells } from '../src/game/rail-capacity-cells';
import { capacityRouteBetween } from '../src/game/rail-capacity-routes';
import { marginalSharedTrain, marginalSharedConsist, sharedTrainAllowed, sharedCapacityPlan } from '../src/game/ai-capacity';
import { connectStationThroat, planDoubleTrack, commitDoubleTrack } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { checkReservations } from './lib';
import { flatGame, station, endNode, build, railOpts, nodeSnap, loco, depotFor, check, done } from './stationlib';

function fixture(tracks = 2, shared = false) {
  const g = flatGame(256); g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  for (let i = 0; i < 2; i++) g.addAICompany({ startMoney: 50_000_000 });
  const A = station(g, 20, 128, Math.PI / 2, 10, tracks, 1)!;
  const B = station(g, 236, 128, Math.PI / 2, 10, 2, 1)!;
  if (!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
    nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(1))) throw new Error('fixture track');
  for (const st of [A, B]) connectStationThroat(g, st.id, 1);
  const depots = [depotFor(g, A, B, 1), depotFor(g, B, A, shared ? 2 : 1)];
  const l = g.lines.create('rail', 1); l.stops = [A.id, B.id];
  if (shared) {
    g.lines.invite(l.id, 2);
    l.patterns = [0, 1].map(id => ({ id, name: `Local ${id}`, kind: 'local', stops: [true, true], ids: [...l.stops] }));
  }
  g.lines.rebuild(); l.incomeLast = 30_000_000; l.passLast = 500;
  return { g, A, B, l, depots };
}

for (const shared of [false, true]) {
  const f = fixture(2, shared), { g, A, B, l } = f, label = shared ? 'shared patterns' : 'private';
  const before = JSON.stringify(serialize(g)), cell = atomicTerminalCell(g, l.stops, 1, loco());
  check(cell?.slots.length === 4, `${label}: both connected full-consist platforms at each terminal are real slots`);
  check(JSON.stringify(serialize(g)) === before, `${label}: cell inspection is pure`);
  const trains: Train[] = [];
  for (let i = 0; i < 3; i++) {
    const side = i % 2, owner = shared && side ? 2 : 1;
    const t = g.vehicles.buyTrain(f.depots[side], loco(), l.id);
    if (!(t instanceof Train)) throw new Error(t);
    t.stopIndex = side; if (shared) t.pattern = side; trains.push(t);
  }
  const owner = shared ? 2 : 1, pattern = shared ? 1 : 0;
  const quote = marginalSharedTrain(g, l, owner, loco(), pattern);
  check(quote < 0, `${label}: fourth departure prices the incumbents' blocked receipts`);
  check(!sharedTrainAllowed(g, l, owner, loco(), pattern), `${label}: no purchase bypasses the empty receiving slot`);
  const plan = sharedCapacityPlan(g, l);
  check(plan.physical === 3 && plan.allocations.reduce((n, a) => n + a.trains, 0) <= 3,
    `${label}: full auction keeps all operators/patterns inside the same physical cell`);
  const data = JSON.stringify(serialize(g)), h = deserialize(JSON.parse(data));
  check(marginalSharedTrain(h, h.lines.get(l.id)!, owner, loco(), pattern) === quote,
    `${label}: cold capacity caches price the same saved departure`);
  let exact = true;
  for (let i = 0; i < 80; i++) { g.stepTick(); h.stepTick(); exact &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(h)); }
  check(exact, `${label}: saved stock, physical admission and receipts replay every fixed tick`);
  autoSignalLine(g, l.id, 1);
  const calls = trains.map(() => new Set<number>()); let cycles = 0, valid = true;
  for (let i = 0; i < 720 * g.ticksPerDay; i++) {
    g.stepTick();
    trains.forEach((t, j) => { if (t.state === 'loading') calls[j].add(t.atStation); });
    if (g.tick % g.ticksPerDay === 0) { cycles += deadlockCycles(g, 20).length; valid &&= !checkReservations(g).length; }
  }
  check(calls.every(c => c.has(A.id) && c.has(B.id)), `${label}: all three native trains operate at both termini`);
  check(cycles === 0 && valid, `${label}: two operating years have no mutual cycle or reservation inconsistency`);
  check(trains.every(t => t.onMap), `${label}: the accepted fleet really operates on the map`);
}

{
  const { g, A, l } = fixture(3), net = g.world.net;
  check(atomicTerminalCell(g, l.stops, 1, loco())?.slots.length === 5, 'a legal connected third platform adds a receiving slot');
  const third = A.rail!.edges[2], e = net.edges.get(third)!;
  for (const nid of [e.a, e.b]) for (const id of [...net.nodes.get(nid)!.edges]) if (id !== third) net.removeEdge(id);
  g.onNetworkChanged();
  check(atomicTerminalCell(g, l.stops, 1, loco())?.slots.length === 4, 'an unconnected painted platform adds no headroom');
}

{
  const { g, A, l, depots } = fixture(3), net = g.world.net;
  const third = net.edges.get(A.rail!.edges[2])!, split = net.splitEdge(third.id, third.len - 6)!;
  net.removeEdge(split.e1.id); g.onNetworkChanged();
  check(atomicTerminalCell(g, l.stops, 1, loco())?.slots.length === 4, 'a physically short platform adds no full-consist slot');
  const t = g.vehicles.buyTrain(depots[0], loco(), l.id);
  if (!(t instanceof Train)) throw new Error(t);
  const longer = [...loco(), loco()[1]];
  check(marginalSharedConsist(g, l, t, longer) === -Infinity,
    'a proposed consist cannot retain a cell which no longer fits it');
}

{
  const blocked = blockedTerminalCells([{ slots: [1, 2, 3], count: 2 }, { slots: [2, 3, 4], count: 2 }, { slots: [5, 6], count: 1 }]);
  check(blocked.has(0) && blocked.has(1) && !blocked.has(2), 'overlapping restricted groups cannot borrow a disjoint spare slot');
  check(!blockedTerminalCells([{ slots: [1, 2, 3], count: 1 }, { slots: [2, 3, 4], count: 2 }, { slots: [5, 6], count: 1 }]).size,
    'overlapping groups with a reachable spare keep their receipts');
  const overbooked = blockedTerminalCells([{ slots: [1, 2], count: 3 }, { slots: [3, 4], count: 2 }]);
  check(overbooked.size === 2 && overbooked.has(0) && overbooked.has(1),
    'inherited overbooked stock cannot mask an unrelated full class');
  const spare = blockedTerminalCells([{ slots: [1, 2], count: 3 }, { slots: [3, 4], count: 1 }]);
  check(spare.size === 1 && spare.has(0), 'an unrelated class with a physical receiving spare keeps its receipts');
  const newFull = blockedTerminalCells([{ slots: [1, 2], count: 3 }, { slots: [3], count: 1 }]);
  check(newFull.has(1), 'an unrelated new candidate cannot hide its missing receiving space behind inherited overbooking');
  const reordered = blockedTerminalCells([{ slots: [5, 6], count: 1 }, { slots: [3, 4], count: 2 }, { slots: [1, 2], count: 3 }]);
  check(reordered.size === 2 && reordered.has(1) && reordered.has(2), 'blocked full classes and lawful spares do not depend on channel order');
}

{
  const { g, A, l, depots } = fixture(), net = g.world.net;
  const short = net.edges.get(A.rail!.edges[1])!, split = net.splitEdge(short.id, short.len - 6)!;
  net.removeEdge(split.e1.id); g.onNetworkChanged();
  const small = [loco()[0]], ts: Train[] = [];
  for (let i = 0; i < 2; i++) {
    const t = g.vehicles.buyTrain(depots[i], small, l.id); if (!(t instanceof Train)) throw new Error(t); ts.push(t);
  }
  check(atomicTerminalCell(g, l.stops, 1, small)?.slots.length === 4 && atomicTerminalCell(g, l.stops, 1, loco())?.slots.length === 3,
    'unequal physical platform lengths change the exact proposed stock slot set');
  check(sharedTrainAllowed(g, l, 1, small) && !sharedTrainAllowed(g, l, 1, loco()),
    'a long private candidate cannot borrow its short incumbents receiving slot');
  const third = g.vehicles.buyTrain(depots[0], small, l.id); if (!(third instanceof Train)) throw new Error(third);
  check(marginalSharedConsist(g, l, ts[0], small) === Infinity && marginalSharedConsist(g, l, ts[0], loco()) === -Infinity,
    'private replacement keeps fare approval but declines loss of the last usable receiving slot');
}

{
  const { g, A, B, l } = fixture(), net = g.world.net;
  check(atomicTerminalCell(g, l.stops, 1, loco())?.slots.length === 4, 'plain cell cache is warm before a legacy signal edit');
  const z = net.nodes.get(endNode(g, A, 0, true))!.z, n = net.nearestEdge(120, z, .5, 'rail')!;
  const split = net.splitEdge(n.edge.id, n.s)!; g.onNetworkChanged();
  atomicTerminalCell(g, l.stops, 1, loco());
  // Legacy callers can edit signals directly; derived warm and cold cells must still agree.
  split.node.signal = 1;
  const data = JSON.stringify(serialize(g)), h = deserialize(JSON.parse(data));
  check(atomicTerminalCell(g, [A.id, B.id], 1, loco()) === null && atomicTerminalCell(h, [A.id, B.id], 1, loco()) === null,
    'direct facing signal edits invalidate warm cell recognition just like cold loading');
}

{
  const { g, A, B, l } = fixture(), net = g.world.net;
  const z = net.nodes.get(endNode(g, A, 0, true))!.z;
  for (const x of [90, 150]) { const n = net.nearestEdge(x, z, .5, 'rail')!; net.splitEdge(n.edge.id, n.s); }
  const middle = net.nearestEdge(120, z, .5, 'rail')!;
  const plan = planDoubleTrack(g, [middle.edge.id], 1, 1), built = commitDoubleTrack(g, plan, false);
  check(plan.ok && !built.error, 'a physical passing loop builds legally');
  const signals = autoSignalLine(g, l.id, 1);
  check(signals.signals.some(s => s.role === 'loop'), 'the completed passing place has genuine exit holding boundaries');
  check(atomicTerminalCell(g, [A.id, B.id], 1, loco()) === null, 'a real passing place removes the closed terminal constraint');
  check(atomicTerminalCell(g, [A.id, B.id, 9999], 1, loco()) === null, 'intermediate services are not assigned a two-terminal bound');
  check(!!capacityRouteBetween(g, A.id, B.id, 1), 'the upgraded physical route remains usable');
}

done();
