// A station expansion leaves a short incoming platform with no lawful departure; operational fallback
// must use another physical platform even when the saved Auto preference is busy.
import { planStationUpgrade, commitStationUpgrade } from '../src/game/stations';
import { setSignal } from '../src/game/signals';
import { electrify } from '../src/game/build-ops';
import { Train, findRailRoute, railNext } from '../src/game/train';
import { platformChoices, platformPreference } from '../src/game/rail-platforms';
import { serialize, deserialize } from '../src/game/save';
import { checkReservations } from './lib';
import { flatGame, station, endNode, nodeSnap, build, free, railOpts, loco, depotFor, check, done } from './stationlib';

function need(v: unknown, label: string): asserts v { if (!v) throw new Error('fixture setup: ' + label); }
const g = flatGame(256), net = g.world.net;
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
const A = station(g, 40, 128, Math.PI / 2, 10, 1)!, B = station(g, 208, 128, Math.PI / 2, 10, 2)!;
need(A && B, 'owned stations');
const from = nodeSnap(g, endNode(g, A, 0, true), 'rail');
need(build(g, from, free(g, 125, 146), railOpts(), 'legal detour'), 'legal detour');
const via = net.nearestNode(125, 146, 0.1, 'rail')!;
need(build(g, nodeSnap(g, via.id, 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(), 'legal platform'), 'legal platform');
need(build(g, from, nodeSnap(g, endNode(g, B, 1, false), 'rail'), railOpts(), 'short inbound track'), 'short inbound track');
const short = net.nearestEdge(130, net.nodes.get(endNode(g, B, 1, false))!.z, 1, 'rail')!;
need(short && !setSignal(g, short.edge.id, short.s, 'oneway', net.nodes.get(short.edge.b)!.x > net.nodes.get(short.edge.a)!.x, 0), 'inbound one-way signal');
const route = g.lines.create('rail', 0); route.stops = [A.id, B.id]; route.evenSpacing = false;
g.lines.rebuild();
const upgrade = planStationUpgrade(g, B.id, { tracks: 3 });
need(upgrade.ok && !commitStationUpgrade(g, upgrade), 'native owned two-to-three platform expansion');
need(B.rail!.tracks === 3, 'expanded physical platforms');
need(build(g, from, free(g, 125, 112), railOpts(), 'free detour'), 'free detour');
const viaFree = net.nearestNode(125, 112, 0.1, 'rail')!;
need(build(g, nodeSnap(g, viaFree.id, 'rail'), nodeSnap(g, endNode(g, B, 2, false), 'rail'), railOpts(), 'free platform'), 'free platform');
g.lines.rebuild(); g.flushNetworkChanges();
const groups = g.stations.railTrackGroups(B), preferred = platformPreference(route, 0, 1)!.group;
const trap = groups.find(q => q.steps.some(s => s.edge === B.rail!.edges[1]))!;
const source = net.edges.get(A.rail!.edges[0])!, incoming = railNext(g, source, 1, 0), length = loco().reduce((n, c) => n + c.length, 0);
const arrival = (world = g, extra = {}) => findRailRoute(world, incoming.map(c => ({ edge: world.world.net.edges.get(c.edge.id)!, dir: c.dir })),
  B.id, 0, -1, 60000, false, null, false, { preferred, length, onward: A.id, ...extra });
const plain = findRailRoute(g, incoming, B.id, 0, -1, 60000, false, null, false, { preferred, length });
check(trap.steps.some(s => s.edge === plain?.conts.at(-1)?.edge.id), 'unfiltered geometry chooses the shorter inbound-only expanded platform despite the tiny Auto tie preference');
check(!platformChoices(g, route, 0, 1).some(q => q.id === trap.id), 'allocator excludes the expanded platform with no lawful onward service');
check(!arrival(g, { group: trap.id }), 'operational arrivals also reject the accessible fitting platform when its onward path violates a one-way signal');
const legal = arrival();
check(legal && !trap.steps.some(s => s.edge === legal.conts.at(-1)?.edge.id), 'operational routing uses a lawful arrival and departure on the same physical platform');

const preferredGroup = groups.find(q => q.id === preferred)!;
for (const s of preferredGroup.steps) g.vehicles.setRes(s.edge, -99);
const freeAlternative = arrival();
check(freeAlternative && !preferredGroup.steps.some(s => s.edge === freeAlternative.conts.at(-1)?.edge.id)
  && !trap.steps.some(s => s.edge === freeAlternative.conts.at(-1)?.edge.id), 'busy Auto still yields to a free lawful platform without entering the shorter directional trap');
for (const s of preferredGroup.steps) g.vehicles.releaseRes(s.edge, -99);
check(!arrival(g, { length: 12 }), 'onward filtering preserves the complete incoming platform fit');

// A direct legacy signal edit must invalidate a warmed feasibility result even without a version bump.
const starter = [...net.nodes.values()].find(n => n.signal && n.kind === 'rail')!;
const oldSignal = starter.signal;
starter.signalPass = true;
check(!!arrival(g, { group: trap.id }), 'a passable reverse side restores a real lawful onward route after warming the cache');
starter.signalPass = false; starter.signal = 0;
check(!!arrival(g, { group: trap.id }), 'direct removal of a one-way signal is reflected by the warmed cache');
starter.signal = oldSignal;
const cold = deserialize(JSON.parse(JSON.stringify(serialize(g))));
check(!arrival(g, { group: trap.id }) && !arrival(cold, { group: trap.id }), 'restoring the one-way signal gives identical warm and cold lawful-route decisions');

// The onward hop has its own access, wire and full-platform requirements, independently of the arrival.
g.addAICompany({ accessPolicy: 'open' }); g.company(1).economy.money = 1e9; g.aiEnabled = false;
g.setAccessPolicy(0, 'open');
const C = station(g, 240, 128, Math.PI / 2, 4, 1, 1)!; need(C, 'foreign onward station');
need(build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(1), 'foreign onward track'), 'foreign onward track');
check(!arrival(g, { group: groups[0].id, onward: C.id }), 'a full incoming platform cannot substitute for an onward platform that is too short');
const longer = planStationUpgrade(g, C.id, { length: 10 });
need(longer.ok && !commitStationUpgrade(g, longer), 'lengthen onward station');
check(!!arrival(g, { group: groups[0].id, onward: C.id }), 'native onward platform growth invalidates warmed full-fit feasibility');
const accessVersion = g.networkVersion, ai = g.aiOf(1)!;
ai.config = { ...ai.config, accessPolicy: 'auto-reject' }; g.refreshAccess();
const revoked = deserialize(JSON.parse(JSON.stringify(serialize(g))));
check(g.networkVersion === accessVersion && !arrival(g, { group: groups[0].id, onward: C.id })
  && !arrival(revoked, { group: groups[0].id, onward: C.id }), 'direct policy revocation produces identical warm and cold decisions without changing topology versions');
ai.config = { ...ai.config, accessPolicy: 'open' }; g.refreshAccess();

const removed = deserialize(JSON.parse(JSON.stringify(serialize(g))));
check(!!arrival(removed, { group: groups[0].id, onward: C.id }), 'restored onward station warms a valid departure decision');
need(!removed.stations.removeStation(C.id), 'remove onward station');
check(!arrival(removed, { group: groups[0].id, onward: C.id }), 'native onward station removal invalidates the warmed departure decision');
check(!!arrival(g, { group: groups[0].id, onward: C.id }), 'restoring foreign access invalidates the warmed negative decision');
need(!electrify(g, [...net.edges.values()].filter(e => e.kind === 'rail').map(e => e.id), 0).error, 'wire fixture');
const wiredArrival = () => findRailRoute(g, railNext(g, net.edges.get(source.id)!, 1, 0, false, { types: null, wire: true }),
  B.id, 0, -1, 60000, false, { types: null, wire: true }, false, { length, group: groups[0].id, onward: C.id });
check(!!wiredArrival(), 'a wired onward path is available for an electric consist');
const foreignConnection = net.nodes.get(endNode(g, B, 0, true))!.edges.map(id => net.edges.get(id)!).find(e => e.station < 0)!;
foreignConnection.type = 'standard'; net.version++;
check(!wiredArrival(), 'a changed graph version invalidates cached onward feasibility when its departure-only track loses wire');
need(!electrify(g, [foreignConnection.id], 0).error, 'restore onward wire');

// The exceptional route off revoked track applies only while the train is actually caught on it.
ai.config = { ...ai.config, accessPolicy: 'auto-reject' }; g.refreshAccess();
const caughtEdge = net.edges.get(groups[0].steps[0].edge)!; caughtEdge.owner = 1; net.version++;
const escape = findRailRoute(g, railNext(g, net.edges.get(source.id)!, 1, 0, true), B.id, 0, -1, 60000, true,
  null, true, { length, group: groups[0].id, onward: C.id });
check(!!escape, 'a revoked foreign platform retains the native lawful route-off-access fallback');
caughtEdge.owner = 0; net.version++;
check(!arrival(g, { group: groups[0].id, onward: C.id }), 'an owned arrival platform cannot use the foreign escape exception for its future service');
ai.config = { ...ai.config, accessPolicy: 'open' }; g.refreshAccess();

const depot = depotFor(g, A, B); need(depot >= 0, 'depot');
const train = g.vehicles.buyTrain(depot, loco(), route.id); need(train instanceof Train, 'train');
let bad = false, previous = '', atA = 0, atB = 0, trapped = false;
for (let i = 0; i < 400 * 40; i++) {
  g.stepTick(); bad ||= train.state === 'noroute';
  trapped ||= train.occupiedEdges().some(id => trap.steps.some(s => s.edge === id));
  if (train.state === 'loading' && previous !== 'loading') { if (train.atStation === A.id) atA++; if (train.atStation === B.id) atB++; }
  previous = train.state;
}
console.log('expanded directional service', JSON.stringify({ atA, atB, bad, trapped }));
check(atA >= 3 && atB >= 3 && !bad && !trapped, 'the native train repeatedly serves both stops after expansion without entering the directional trap');
check(checkReservations(g).length === 0, 'native service reservations remain consistent');
const loaded = deserialize(JSON.parse(JSON.stringify(serialize(g))));
let exact = JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded));
for (let i = 0; i < 640 && exact; i++) { g.stepTick(); loaded.stepTick(); exact = JSON.stringify(serialize(g)) === JSON.stringify(serialize(loaded)); }
check(exact, 'expanded station service replays all saved decisions with warm and cold departure caches for 640 ticks');

// Internal split-platform starters lie behind the longer train's tail. A head-based reversal probe would
// cross those starters backwards and incorrectly reject the lawful native departure and Auto assignment.
{
  const world = flatGame(192), n = world.world.net; world.aiEnabled = false; world.vehicles.ambientEnabled = false;
  const a = station(world, 30, 100, Math.PI / 2, 10, 1)!, b = station(world, 160, 100, Math.PI / 2, 10, 1)!;
  need(a && b && build(world, nodeSnap(world, endNode(world, a, 0, true), 'rail'),
    nodeSnap(world, endNode(world, b, 0, false), 'rail'), railOpts(), 'tail parity line'), 'tail parity line');
  b.rail!.groups = world.stations.railTrackGroups(b);
  const split1 = n.splitEdge(b.rail!.groups[0].steps[0].edge, 3)!, split2 = n.splitEdge(split1.e2.id, 4)!;
  need(split1 && split2, 'split physical platform');
  split1.node.signal = split1.e2.sa > 0 ? 2 : 3; split2.node.signal = split2.e2.sa > 0 ? 2 : 3;
  const l = world.lines.create('rail', 0); l.stops = [a.id, b.id]; l.evenSpacing = false;
  const dp = depotFor(world, a, b); need(dp >= 0, 'tail parity depot');
  const t = world.vehicles.buyTrain(dp, loco(), l.id); need(t instanceof Train, 'tail parity train');
  world.onNetworkChanged(); world.lines.rebuild(false); world.flushNetworkChanges();
  const ae = n.edges.get(a.rail!.edges[0])!, start = railNext(world, ae, 1, 0);
  check(!!findRailRoute(world, start, b.id, 0, -1, 60000, false, null, true, { length: t.length, onward: a.id })
    && platformChoices(world, l, 0, 1).length === 1, 'operational filtering and Auto allocation use the lawful actual-tail reversal of a fitting segmented platform');
  check(!findRailRoute(world, start, b.id, 0, -1, 60000, false, null, true, { length: 2, onward: a.id }),
    'a different tail position cannot bypass a later internal one-way starter');
  let arrived = false, departed = false, before = '';
  for (let i = 0; i < 240 * 40; i++) {
    world.stepTick(); if (t.state === 'loading' && t.atStation === b.id) arrived = true;
    if (arrived && t.state === 'loading' && t.atStation === a.id && before !== 'loading') departed = true;
    before = t.state;
  }
  check(arrived && departed && t.state !== 'noroute' && checkReservations(world).length === 0,
    'the actual native consist arrives and lawfully reverses beyond its tail on the segmented platform');
}
done();
