// Shared capacity follows native resource pools as well as representative rail paths.
import { flatGame, station, endNode, build, nodeSnap, railOpts, loco, depotFor } from './stationlib';
import { check, fails, checkReservations } from './lib';
import { usesSharedRail, sharedCapacityPlan } from '../src/game/ai-capacity';
import { capacityRouteBetween } from '../src/game/rail-capacity-routes';
import { openingRailCall } from '../src/game/ai';
import { Train } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';

function fixture(shared: boolean) {
  const g = flatGame(256); g.vehicles.ambientEnabled = false;
  const leftZ = shared ? 128 : 100, rightZ = shared ? 128 : 160;
  const west = station(g, 20, leftZ, Math.PI / 2, 12, 1)!,
    centre = station(g, 128, leftZ, Math.PI / 2, 12, shared ? 2 : 1)!,
    other = shared ? centre : station(g, 128, rightZ, Math.PI / 2, 12, 1)!,
    east = station(g, 236, rightZ, Math.PI / 2, 12, 1)!;
  build(g, nodeSnap(g, endNode(g, west, 0, true), 'rail'),
    nodeSnap(g, endNode(g, centre, 0, false), 'rail'), railOpts(), 'west separate approach');
  build(g, nodeSnap(g, endNode(g, other, shared ? 1 : 0, true), 'rail'),
    nodeSnap(g, endNode(g, east, 0, false), 'rail'), railOpts(), 'east separate approach');
  const a = g.lines.create('rail', 0), b = g.lines.create('rail', 0);
  a.stops = [west.id, centre.id]; b.stops = [east.id, other.id]; g.lines.rebuild();
  for (const [line, st, towards] of [[a, west, centre], [b, east, other]] as const) {
    const dep = depotFor(g, st, towards), t = g.vehicles.buyTrain(dep, loco(), line.id);
    if (!(t instanceof Train)) throw new Error('native fixture train: ' + t);
    const call = openingRailCall(g, t);
    check(call >= 0, 'actual purchased stock has a lawful depot call'); t.stopIndex = call;
  }
  return { g, a, b, centre, other };
}
const routeEdges = (f: ReturnType<typeof fixture>, line: typeof f.a) => new Set(line.stops.flatMap((from, i) =>
  capacityRouteBetween(f.g, from, line.stops[(i + 1) % line.stops.length], line.owner) ?? []));

const shared = fixture(true), ae = routeEdges(shared, shared.a), be = routeEdges(shared, shared.b);
check(ae.size > 0 && be.size > 0 && [...ae].every(id => !be.has(id)),
  'same-company services use different real representative rails at one two-platform station');
check(usesSharedRail(shared.g, shared.a) && usesSharedRail(shared.g, shared.b),
  'both services are shared through their native pooled platform resource');
const agreement = sharedCapacityPlan(shared.g, shared.a);
check(agreement.lines.includes(shared.a.id) && agreement.lines.includes(shared.b.id)
  && agreement.resources.some(r => r.kind === 'platform' && r.edges.includes(shared.centre.rail!.edges[0])
    && r.edges.includes(shared.centre.rail!.edges[1])),
  'the existing native operating agreement already joins the two platform rails');
// Warm native demand snapshots first; the predicate and subsequent pricing are passive reads.
sharedCapacityPlan(shared.g, shared.b);
const before = JSON.stringify({ save: serialize(shared.g), reservations: [...(shared.g.vehicles as any).res] });
usesSharedRail(shared.g, shared.a); usesSharedRail(shared.g, shared.b); sharedCapacityPlan(shared.g, shared.a);
check(JSON.stringify({ save: serialize(shared.g), reservations: [...(shared.g.vehicles as any).res] }) === before,
  'warm resource detection and the unchanged native pricing preserve complete state/RNG/reservations');
shared.g.aiEnabled = true; // There are no AI controllers; this exercises the normal daily observer without an auction.
for (let tick = 0; tick < shared.g.ticksPerDay; tick++) shared.g.stepTick();
check(shared.a.capacity?.day === shared.g.day && shared.b.capacity?.day === shared.g.day && shared.g.day === 1,
  'normal native daily capacity observations reach both pooled-platform services');
const loaded = deserialize(JSON.parse(JSON.stringify(serialize(shared.g))));
let exact = JSON.stringify(serialize(shared.g)) === JSON.stringify(serialize(loaded));
for (let tick = 0; tick < 640; tick++) {
  shared.g.stepTick(); loaded.stepTick();
  if (JSON.stringify(serialize(shared.g)) !== JSON.stringify(serialize(loaded))) { exact = false; break; }
}
check(exact && checkReservations(shared.g).length === 0 && checkReservations(loaded).length === 0,
  'observed resource sharing replays every complete native save/RNG state for 640 ticks with lawful reservations');

const separate = fixture(false);
check(!usesSharedRail(separate.g, separate.a) && !usesSharedRail(separate.g, separate.b),
  'physically disjoint approaches and different station resources remain unshared');
const raw = separate.g.lines.create('rail', 0); raw.stops = [...separate.a.stops]; separate.g.lines.rebuild();
check(usesSharedRail(separate.g, separate.a) && usesSharedRail(separate.g, raw),
  'original raw-rail overlap remains shared');
const operator = separate.g.addAICompany().id;
separate.g.lines.invite(separate.b.id, operator);
check(separate.b.operators?.includes(operator) && usesSharedRail(separate.g, separate.b),
  'an explicit native operator agreement remains shared');
separate.g.setAccessPolicy(0, 'open');
const foreign = separate.g.lines.create('rail', operator); foreign.stops = [...separate.a.stops]; separate.g.lines.rebuild();
check(!!capacityRouteBetween(separate.g, foreign.stops[0], foreign.stops[1], operator)
  && usesSharedRail(separate.g, foreign), 'usable foreign-title rail remains shared');
console.log(fails.length ? `${fails.length} CHECKS FAILED` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
