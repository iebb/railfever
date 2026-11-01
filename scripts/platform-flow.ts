// Opposing calls at an inline station price the actual running path they would share.
import { serialize, deserialize } from '../src/game/save';
import { Train, deadlockCycles } from '../src/game/train';
import { platformFlowCosts, platformPreference, reconcilePlatforms, setPlatformPreference } from '../src/game/rail-platforms';
import { replaceLineStops } from '../src/game/line-edit';
import { finishDoubleTrack, planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { setSignal } from '../src/game/signals';
import { checkReservations } from './lib';
import { flatGame, station, endNode, nodeSnap, build, railOpts, depotFor, loco, check, done } from './stationlib';

function need(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
const g = flatGame(256), net = g.world.net;
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
const A = station(g, 30, 120, Math.PI / 2, 10, 2)!, B = station(g, 225, 140, Math.PI / 2 + .12, 10, 2)!;
need(A && B, 'native end stations');
need(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), 'curved pair').ok,
  'native paired running tracks');
const finish = finishDoubleTrack(g, [...net.edges.values()].filter(e => e.station < 0 && e.depot < 0).map(e => e.id), 0);
need(!finish.error && finish.crossovers >= 4, 'native terminal crossovers');
// Bidirectional running is a legal player configuration. Retain the native station starters,
// turnout and crossing protection; remove only ordinary two-edge plain-line direction restrictions.
for (const node of net.nodes.values()) if (node.signal && node.edges.length === 2
  && !node.edges.some(id => net.edges.get(id)!.station >= 0)) {
  const edge = net.edges.get(node.edges[0])!;
  need(!setSignal(g, edge.id, edge.a === node.id ? 0 : edge.len, 'none', true, 0), 'native plain-line signal removal');
}
const at = net.nearestEdge(145, 130, 20, 'rail', e => e.station < 0 && e.depot < 0)!;
const plan = planStationOnTrack(g, at.edge.id, at.s, { length: 10, tracks: 2, reuseTrack: true, style: 'none' }, 0);
need(plan.ok, plan.error ?? 'native inline station quote');
const inserted = commitStationOnTrack(g, plan); need(!inserted.error, inserted.error ?? 'native inline station commit');
const M = g.stations.get(inserted.station)!, line = g.lines.create('rail', 0);
line.stops = [A.id, B.id]; g.lines.rebuild();
replaceLineStops(g, line, [A.id, M.id, B.id, M.id]);
const depot = depotFor(g, A, B); need(depot >= 0, 'native depot');
const first = g.vehicles.buyTrain(depot, loco(), line.id) as Train;
need(first instanceof Train, 'first paid native train');
reconcilePlatforms(g, true);
check([1, 3].every(stop => platformFlowCosts(g, line, 0, stop).size === 0), 'one physical train does not invent opposing traffic from its own later call');
const trains = [first, ...[0, 1].map(() => g.vehicles.buyTrain(depot, loco(), line.id) as Train)];
need(trains.every(t => t instanceof Train), 'three paid native trains');
reconcilePlatforms(g, true);
const outward = platformPreference(line, 0, 1)!, inward = platformPreference(line, 0, 3)!;
check(outward.group !== inward.group, 'opposing paid calls use separate lawful inline platforms despite the shorter shared approach');
const before = JSON.stringify(serialize(g)), flow = () => [1, 3].map(stop => [...platformFlowCosts(g, line, 0, stop)]);
const warm = JSON.stringify(flow());
check(warm !== '[[],[]]', 'shared opposing running paths have a physical cost derived from their actual edges and paid stock');
for (let i = 0; i < 3; i++) flow();
check(JSON.stringify(serialize(g)) === before, 'warm flow and platform reads preserve every saved decision');
const cold = deserialize(JSON.parse(before)), coldLine = cold.lines.get(line.id)!;
check(JSON.stringify([1, 3].map(stop => [...platformFlowCosts(cold, coldLine, 0, stop)])) === warm
  && JSON.stringify(serialize(cold)) === before, 'cold flow reconstruction has identical physical costs without changing the save');
check(!setPlatformPreference(cold, coldLine, 0, 3, outward.group), 'a lawfully reachable manual shared-platform preference remains available');
reconcilePlatforms(cold, true);
check(platformPreference(coldLine, 0, 3)?.manual && platformPreference(coldLine, 0, 3)?.group === outward.group,
  'physical Auto pricing preserves the explicit manual platform choice');

// A different operator's native purchase changes the first line's physical load without
// changing any member of that first fleet. Warm reconciliation must equal a cold saved game.
const shared = deserialize(JSON.parse(before));
shared.addAICompany({ startMoney: 50_000_000, accessPolicy: 'open' });
shared.aiEnabled = false; shared.setAccessPolicy(0, 'open'); shared.refreshAccess();
const peer = shared.lines.create('rail', 1);
peer.stops = [B.id, M.id, A.id, M.id]; shared.lines.rebuild();
for (const stop of [1, 3]) need(!setPlatformPreference(shared, peer, 0, stop, outward.group), 'lawful peer manual call');
const b = shared.stations.get(B.id)!;
const peerDepot = depotFor(shared, { ...b, rail: { ...b.rail!, edges: [b.rail!.edges[1]] } }, shared.stations.get(A.id)!, 1);
need(peerDepot >= 0, 'native independent paid depot');
const auto = (world: typeof shared) => JSON.stringify(world.lines.get(line.id)!.platforms);
function crossLineChange(world: typeof shared, label: string, edit: () => void) {
  for (let i = 0; i < 3; i++) reconcilePlatforms(world);
  const previous = auto(world);
  edit();
  const loaded = deserialize(JSON.parse(JSON.stringify(serialize(world))));
  reconcilePlatforms(world); reconcilePlatforms(loaded);
  check(auto(world) !== previous, `${label}: other-line traffic changes the unchanged first fleet's Auto choices`);
  let exact = JSON.stringify(serialize(world)) === JSON.stringify(serialize(loaded));
  // Include another unchanged reconciliation: pre-pass allocation inputs must invalidate both
  // the warm cache and the cold reconstruction equally when the previous choices changed.
  for (let i = 0; i < 3 && exact; i++) {
    reconcilePlatforms(world); reconcilePlatforms(loaded);
    exact = JSON.stringify(serialize(world)) === JSON.stringify(serialize(loaded));
  }
  check(exact, `${label}: warm and cold reconciliation preserve identical complete saved decisions`);
  for (let i = 0; i < 128 && exact; i++) {
    world.stepTick(); loaded.stepTick(); exact = JSON.stringify(serialize(world)) === JSON.stringify(serialize(loaded));
  }
  check(exact && checkReservations(world).length === 0, `${label}: native traffic and reservations replay exactly after the change`);
}
let peerTrain: Train | undefined;
crossLineChange(shared, 'peer stock purchase', () => {
  const bought = shared.vehicles.buyTrain(peerDepot, loco(), peer.id);
  need(bought instanceof Train, 'native partner train purchase'); peerTrain = bought;
});
const paidPeer = JSON.stringify(serialize(shared));
crossLineChange(shared, 'peer stock sale', () => shared.vehicles.sell(peerTrain!.id));
const revoked = deserialize(JSON.parse(paidPeer));
crossLineChange(revoked, 'peer access revocation', () => { revoked.setAccessPolicy(0, 'ask'); revoked.refreshAccess(); });

const arrivals = new Map<number, Set<number>>(), directions = new Map<number, Set<number>>(), prior = new Map<number, string>();
let cycles = 0, longest = 0;
for (let i = 0; i < 720 * g.ticksPerDay; i++) {
  g.stepTick();
  if (g.tick % g.ticksPerDay === 0) {
    cycles += deadlockCycles(g, 20).length;
    longest = Math.max(longest, ...trains.map(t => t.stuckTime));
  }
  for (const t of trains) {
    if (t.state === 'loading' && prior.get(t.id) !== 'loading') {
      const served = arrivals.get(t.id) ?? new Set<number>(); served.add(t.atStation); arrivals.set(t.id, served);
      if (t.atStation === M.id) {
        const groups = directions.get(t.stopIndex) ?? new Set<number>(), head = t.segs[t.headSeg];
        const group = g.stations.railTrackGroups(M).find(p => p.steps.some(s => s.edge === head.e));
        need(group, 'native arrival covers a physical platform'); groups.add(group.id); directions.set(t.stopIndex, groups);
      }
    }
    prior.set(t.id, t.state);
  }
}
console.log('native opposing inline calls', JSON.stringify({ longest, cycles, calls: [...arrivals].map(([id, ids]) => [id, [...ids]]),
  directionalPlatforms: [...directions].map(([stop, ids]) => [stop, [...ids]]) }));
check(trains.every(t => [A.id, M.id, B.id].every(id => arrivals.get(t.id)?.has(id))), 'all three paid trains physically serve both termini and the inline station');
check(directions.get(1)?.size === 1 && directions.get(3)?.size === 1
  && [...directions.get(1)!][0] !== [...directions.get(3)!][0], 'actual native arrivals preserve the two opposing platform flows');
check(cycles === 0 && longest < 120, 'native operation has no mutual-wait cycles or sustained 120-second holds');
check(checkReservations(g).length === 0, 'native paired-flow service preserves every physical reservation');
const replay = deserialize(JSON.parse(JSON.stringify(serialize(g))));
let exact = true;
for (let i = 0; i < 640 && exact; i++) {
  g.stepTick(); replay.stepTick(); exact = JSON.stringify(serialize(g)) === JSON.stringify(serialize(replay));
}
check(exact, 'warm and cold flow costs continue every saved native decision exactly for 640 ticks');
done();
