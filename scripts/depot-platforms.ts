// Depot feasibility must use the same full-platform fit and onward routing as a real consist.
import { Train, depotReaches, depotServes } from '../src/game/train';
import { planStationUpgrade, commitStationUpgrade } from '../src/game/stations';
import { serialize, deserialize } from '../src/game/save';
import { checkReservations } from './lib';
import { setSignal } from '../src/game/signals';
import { flatGame, station, endNode, nodeSnap, build, free, railOpts, loco, depotFor, check, done } from './stationlib';

function need(v: unknown, label: string): asserts v { if (!v) throw new Error('fixture setup: ' + label); }
const g = flatGame(192), net = g.world.net;
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
const A = station(g, 35, 96, Math.PI / 2, 4, 1)!, B = station(g, 155, 96, Math.PI / 2, 10, 1)!;
need(A && B && build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'),
  nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(), 'line'), 'connected stations');
const depot = depotFor(g, A, B), dp = g.depots.get(depot);
need(dp, 'depot');
const cars = loco(), length = cars.reduce((n, c) => n + c.length, 0);
need(length > 4 && length < 10, 'consist longer than short station');
check(depotReaches(g, dp, A.id) && depotServes(g, dp, A.id, B.id) >= 0,
  'geometry-only depot probes remain available when no consist is supplied');
check(!depotReaches(g, dp, A.id, cars), 'a supplied consist cannot reach a station whose whole platform is too short');
check(depotReaches(g, dp, B.id, cars), 'the consist can pass the short station and reach a fitting platform');
check(depotServes(g, dp, A.id, B.id, cars) === -1,
  'reaching a fitting first call does not make a too-short onward platform serviceable');
const upgrade = planStationUpgrade(g, A.id, { length: 10 });
need(upgrade.ok && !commitStationUpgrade(g, upgrade), 'lengthen short station');
check(depotReaches(g, dp, A.id, cars) && depotServes(g, dp, A.id, B.id, cars) >= 0,
  'native platform growth restores depot feasibility for the full consist');

// Each split fragment is shorter than the train, but the physical platform still fits it.
A.rail!.groups = g.stations.railTrackGroups(A);
const split = net.splitEdge(A.rail!.groups[0].steps[0].edge, 3)!;
need(split && net.splitEdge(split.e2.id, 3), 'split physical platform');
g.onNetworkChanged(); g.flushNetworkChanges();
check(depotReaches(g, dp, A.id, cars) && depotServes(g, dp, A.id, B.id, cars) >= 0,
  'fit uses a complete physical platform rather than individual split edges');
const before = JSON.stringify(serialize(g));
const loaded = deserialize(JSON.parse(before)), loadedDepot = loaded.depots.get(depot)!;
for (let i = 0; i < 3; i++) {
  check(depotServes(g, dp, A.id, B.id, cars) === depotServes(loaded, loadedDepot, A.id, B.id, cars),
    'warm and cold depot feasibility decisions agree after save/load');
}
check(before === JSON.stringify(serialize(g)), 'depot feasibility reads do not mutate saved simulation state');
const line = g.lines.create('rail', 0); line.stops = [A.id, B.id]; line.evenSpacing = false; g.lines.rebuild();
const train = g.vehicles.buyTrain(depot, cars, line.id); need(train instanceof Train, 'train');
const calls = new Set<number>();
for (let i = 0; i < 160 * 40; i++) { g.stepTick(); if (train.state === 'loading') calls.add(train.atStation); }
check(calls.has(A.id) && calls.has(B.id) && train.state !== 'noroute', 'the approved native consist serves both physical platforms');
check(checkReservations(g).length === 0, 'native operation preserves reservation ownership');

// A cheap arrival ends on an isolated platform. The other arrival platform can continue to C, while
// one-way starters beyond B prevent serving this pair by first visiting C and reversing there.
{
  const world = flatGame(256), n = world.world.net;
  world.aiEnabled = false; world.vehicles.ambientEnabled = false;
  const a = station(world, 40, 128, Math.PI / 2, 10, 1)!, b = station(world, 160, 128, Math.PI / 2, 10, 2)!,
    c = station(world, 220, 128, Math.PI / 2, 10, 1)!;
  need(a && b && c, 'alternative arrival stations');
  const from = nodeSnap(world, endNode(world, a, 0, true), 'rail');
  need(build(world, from, nodeSnap(world, endNode(world, b, 1, false), 'rail'), railOpts(), 'cheap dead end'), 'cheap arrival');
  need(build(world, from, free(world, 100, 150), railOpts(), 'detour first half'), 'detour');
  const via = n.nearestNode(100, 150, 0.1, 'rail')!;
  need(build(world, nodeSnap(world, via.id, 'rail'), nodeSnap(world, endNode(world, b, 0, false), 'rail'), railOpts(), 'detour second half'), 'legal arrival');
  need(build(world, nodeSnap(world, endNode(world, b, 0, true), 'rail'),
    nodeSnap(world, endNode(world, c, 0, false), 'rail'), railOpts(), 'onward'), 'onward connection');
  const connection = n.nearestEdge(190, 128, 2, 'rail')!;
  need(connection, 'onward signal edge');
  const original = connection.edge, first = original.len / 3;
  need(!setSignal(world, original.id, first, 'oneway', true, 0), 'outbound one-way starter');
  const rest = n.nearestEdge(200, 128, 2, 'rail')!;
  need(rest && !setSignal(world, rest.edge.id, rest.edge.len / 2, 'oneway', true, 0), 'second outbound starter');
  const id = depotFor(world, a, b), d = world.depots.get(id); need(d, 'alternative arrival depot');
  check(depotServes(world, d, b.id, c.id, cars) === b.id,
    'depot service searches a lawful alternative arrival rather than rejecting the cheapest dead-end platform');
  check(checkReservations(world).length === 0, 'alternative feasibility probes acquire no train reservations');
}
done();
