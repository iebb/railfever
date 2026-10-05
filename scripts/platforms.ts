// Route platform preferences, full fragmented-platform stops, stock edits and exact saved replay.
import { serialize, deserialize } from '../src/game/save';
import { Train, findRailRoute, railNext, deadlockCycles } from '../src/game/train';
import { platformChoices, platformPreference, reconcilePlatforms, setPlatformPreference } from '../src/game/rail-platforms';
import { setPatterns, linePatterns, joinLines } from '../src/game/patterns';
import { replaceLineStops } from '../src/game/line-edit';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { arcTable, tAtS, bezPoint } from '../src/game/geom';
import { planStationOnTrack, commitStationOnTrack, finishDoubleTrack } from '../src/game/trackops';
import { depotAtEnd } from '../src/game/routing';
import { Economy } from '../src/game/economy';
import { autoSignalNetwork } from '../src/game/signals';
import { checkReservations, roadOpts } from './lib';
import { flatGame, station, endNode, nodeSnap, build, railOpts, loco, depotFor, check, done, free, newTrack, runTrains } from './stationlib';

const g = flatGame(256); g.aiEnabled = false;
g.addAICompany({ accessPolicy: 'auto-approve' }); g.company(1).economy.money = 1e9;
g.setAccessPolicy(0, 'auto-approve'); g.requestAccess(0, 1); g.requestAccess(1, 0);
const A = station(g, 40, 128, Math.PI / 2, 12, 2, 0)!, B = station(g, 216, 128, Math.PI / 2, 12, 2, 1)!;
for (let i = 0; i < 2; i++) build(g, nodeSnap(g, endNode(g, A, i, true), 'rail'), nodeSnap(g, endNode(g, B, i, false), 'rail'), railOpts(0), 'shared station track ' + i);
// Build the second operator's own depot behind the other running track (two adjacent depots would overlap).
const depA = depotFor(g, A, B), onlyB1 = { ...B, rail: { ...B.rail!, edges: [B.rail!.edges[1]] } };
const depB1 = depotFor(g, onlyB1, A, 1);
check(depA >= 0 && depB1 >= 0, 'independent depots enter both physical platforms');
const local = g.lines.create('rail', 0), other = g.lines.create('rail', 1), draft = g.lines.create('rail', 0);
local.stops = [A.id, B.id]; local.operators = [1]; other.stops = [A.id, B.id];
g.lines.rebuild();
check(local.platforms?.length === 2 && other.platforms?.length === 2 && !draft.platforms?.length, 'route creation assigns platforms before stock; unserved draft does not invent calls');
check(local.platforms!.every(p => other.platforms!.find(q => q.station === p.station)?.group !== p.group), 'unrelated routes receive different viable physical platforms');
const stable = JSON.stringify(local.platforms);
const choices = platformChoices(g, local, 0, 1);
const state = JSON.stringify(serialize(g));
for (let i = 0; i < 5; i++) { platformChoices(g, local, 0, 1); platformPreference(local, undefined, 1); linePatterns(local); }
check(state === JSON.stringify(serialize(g)), 'platform/timetable/UI data getters do not change saved decisions');
check(setPlatformPreference(g, local, 0, 1, choices[0].id) === null, 'manual choice is validated as a route preference');
check(setPlatformPreference(g, local, 0, 1, -999) !== null, 'unreachable manual platform is rejected');
check(platformPreference(local, 0, 1)?.manual, 'manual preference is saved');
setPlatformPreference(g, local, 0, 1, null);
check(!platformPreference(local, 0, 1)?.manual, 'Auto removes manual choice');

// The same physical identity survives a split; the arrival fragment is shorter than the complete train.
for (const st of [A, B]) st.rail!.groups = g.stations.railTrackGroups(st);
const group = g.stations.railTrackGroups(B)[0], oldGroup = group.id;
const firstSplit = g.world.net.splitEdge(group.steps[0].edge, 3)!;
const split = g.world.net.splitEdge(firstSplit.e2.id, 7)!;
g.lines.rebuild(false);
const grouped = g.stations.railTrackGroups(B).find(q => q.id === oldGroup)!;
check(grouped.steps.length === 3 && grouped.length > split.e2.len && grouped.id === oldGroup, 'split platform retains stable physical identity and complete length');
const ae = g.world.net.edges.get(A.rail!.groups![0].steps[0].edge)!;
const route = findRailRoute(g, railNext(g, ae, 1, 0), B.id, 0, -1, 60000, false, null, true, { group: oldGroup, length: 5 });
check(route?.conts.at(-1)?.edge.id === split.e2.id && route.conts.some(c => c.edge.id === split.e1.id), 'forward stop reaches the whole platform arrival end, beyond its first fragment');
const be = g.world.net.edges.get(B.rail!.groups![0].steps.at(-1)!.edge)!;
const reverse = findRailRoute(g, [{ edge: be, dir: -1 }], B.id, 0, -1, 60000, false, null, true, { group: oldGroup, length: 5 });
check(reverse?.conts.at(-1)?.edge.id === firstSplit.e1.id, 'reverse stop reaches the opposite arrival end');
check(!findRailRoute(g, railNext(g, ae, 1, 0), B.id, 0, -1, 60000, false, null, true, { length: 30 }), 'long consist cannot be routed to a platform that does not fit it');
check(!findRailRoute(g, [{ edge: split.e2, dir: 1 }], B.id, 0, -1, 60000, false, null, true, { length: 5 }), 'a junction into the short final fragment cannot claim the full platform length');
const allIncoming = A.rail!.groups!.flatMap(q => { const end = q.steps.at(-1)!; return railNext(g, g.world.net.edges.get(end.edge)!, end.dir, 0); });
const equalCosts = B.rail!.groups!.map(q => findRailRoute(g, allIncoming, B.id, 0, -1, 60000, false, null, true, { group: q.id, length: 5 })!.cost);
check(Math.abs(equalCosts[0]-equalCosts[1]) < 1e-4, 'parallel platform arrivals are genuine geometry ties even after a platform split');
for (const q of B.rail!.groups!) {
  const tie = findRailRoute(g, allIncoming, B.id, 0, -1, 60000, false, null, true, { preferred: q.id, length: 5 });
  check(q.steps.some(s => s.edge === tie?.conts.at(-1)?.edge.id), 'Auto retains a useful saved preference between equivalent direct arrivals');
}
g.vehicles.setRes(split.e2.id, -99);
const alternate = findRailRoute(g, allIncoming, B.id, 0, -1, 60000, false, null, false, { preferred: oldGroup, length: 5 });
check(alternate?.conts.at(-1)?.edge.id === B.rail!.groups![1].steps.at(-1)!.edge, 'a busy preferred platform yields to a reachable legal free platform');
const manualAlternate = findRailRoute(g, allIncoming, B.id, 0, -1, 60000, false, null, false, { preferred: oldGroup, manual: true, length: 5 });
check(manualAlternate?.conts.at(-1)?.edge.id === B.rail!.groups![1].steps.at(-1)!.edge, 'a busy manual preference also yields to the legal free platform');
g.vehicles.releaseRes(split.e2.id, -99);

const t0 = g.vehicles.buyTrain(depA, loco(), local.id) as Train;
const partner = g.vehicles.buyTrain(depB1, loco(), local.id) as Train;
const t1 = g.vehicles.buyTrain(depB1, loco(), other.id) as Train;
t1.state = 'stopped'; // the independent service starts after the shared operator's first service period
check(t0 instanceof Train && t1 instanceof Train && partner instanceof Train && partner.owner === 1, 'both operators and an independent route buy legal stock');
check(platformPreference(local, partner.pattern, 1)?.group === platformPreference(local, t0.pattern, 1)?.group, 'shared route operators use the same saved platform allocation');
partner.stopIndex = 1; t1.stopIndex = 1;
let loadedAtSplit = false, resized = false, arrivals = new Map<number, number>(), prior = new Map<number, string>(), worst = 0, cycles = 0;
for (let i = 0; i < 40 * 720; i++) {
  g.stepTick();
  if (i === 40 * 360) { g.vehicles.sell(partner.id); t1.state = 'depot'; }
  for (const t of [t0, t1, partner]) {
    if (t.state === 'loading' && prior.get(t.id) !== 'loading') arrivals.set(t.id, (arrivals.get(t.id) ?? 0) + 1);
    prior.set(t.id, t.state); worst = Math.max(worst, t.stuckTime);
  }
  if (!loadedAtSplit && t0.state === 'loading' && t0.atStation === B.id && t0.segs[t0.headSeg].e === split.e2.id) {
    loadedAtSplit = true;
    check(t0.headPos < t0.length && grouped.length > t0.length, 'train stops with its head on a short final fragment, body on the complete platform');
    const cars = [...loco(), MODEL_BY_ID.get('coach_ic')!], path = t0.platformResizePath(cars.reduce((n, c) => n + c.length + 0.1, 0));
    check(path !== null, 'consist validation uses full platform length behind the head');
    if (path?.length) {
      const resource = path[0].res[0]; g.vehicles.setRes(resource, t1.id);
      const before = JSON.stringify(serialize(g));
      check(g.vehicles.recomposeError(t0, cars) !== null && before === JSON.stringify(serialize(g)), 'a held rear fragment prevents lengthening without mutation');
      g.vehicles.releaseRes(resource, t1.id);
    }
    resized = g.vehicles.recompose(t0, cars) === null;
    check(resized && checkReservations(g).length === 0, 'fitting longer train reserves its actual rear platform fragments');
  }
  if (g.tick % g.ticksPerDay === 0) cycles += deadlockCycles(g, 0).length;
}
console.log('shared operating', JSON.stringify({ arrivals: [...arrivals], worst, cycles, reservations: checkReservations(g) }));
check(loadedAtSplit && resized, 'segmented arrival and paid consist edit occurred during real service');
check([t0, t1, partner].every(t => (arrivals.get(t.id) ?? 0) >= 4 && t.state !== 'noroute') && cycles === 0 && worst < 120, 'shared operators then independent platform routes keep serving without persistent interference');
check(checkReservations(g).length === 0, 'all operating reservations remain consistent');
const copy = deserialize(JSON.parse(JSON.stringify(serialize(g))));
check(JSON.stringify(serialize(g)) === JSON.stringify(serialize(copy)), 'saved platform/group/train decisions roundtrip exactly');
let exact = true;
for (let i = 0; i < 640; i++) { g.stepTick(); copy.stepTick(); if (JSON.stringify(serialize(g)) !== JSON.stringify(serialize(copy))) { exact = false; console.log('replay divergence', i); break; } }
check(exact, 'all640 subsequent full serializations remain identical');

// Explicit pattern and stop edits preserve each valid physical preference and remove unserved calls.
check(setPatterns(g, local.id, [{ id: 5, name: 'Local', kind: 'local', stops: [true, true] }]) === null, 'service edit creates its own saved call allocations');
check(local.platforms!.every(p => p.pattern === 5), 'removed patterns leave no stale platform entries');
setPlatformPreference(g, local, 5, 1, g.stations.railTrackGroups(B)[0].id);
replaceLineStops(g, local, [A.id, B.id, A.id, B.id]);
check(platformPreference(local, 5, 1)?.manual && local.platforms!.length === 4, 'duplicate station occurrences receive distinct saved calls and preserve valid manual choice');
const deletedGroup = g.stations.railTrackGroups(B)[0];
for (const step of deletedGroup.steps) g.world.net.removeEdge(step.edge);
g.lines.rebuild(false);
check(!local.platforms?.some(p => p.group === deletedGroup.id), 'removed physical track preferences revalidate to available alternatives');

{
  const j = flatGame(256); j.aiEnabled = false;
  const a = station(j, 35, 100, Math.PI / 2, 12, 1)!, b = station(j, 128, 100, Math.PI / 2, 12, 1)!, c = station(j, 220, 100, Math.PI / 2, 12, 1)!;
  for (const [from, to] of [[a, b], [b, c]]) build(j, nodeSnap(j, endNode(j, from, 0, true), 'rail'), nodeSnap(j, endNode(j, to, 0, false), 'rail'), railOpts(0), 'join route');
  const first = j.lines.create('rail'), second = j.lines.create('rail'); first.stops = [a.id, b.id]; second.stops = [b.id, c.id]; j.lines.rebuild();
  const manual = platformPreference(second, 0, 0)!.group;
  check(!setPlatformPreference(j, second, 0, 0, manual), 'short service sets manual preference before joining');
  const joined = joinLines(j, first, second, { notify: false });
  check(typeof joined !== 'string' && joined.line.platforms!.some(p => p.pattern === joined.pattern && p.station === b.id && p.manual && p.group === manual), 'joining preserves a manual physical platform under the remapped service pattern');
  const stable = JSON.stringify(first.platforms); for (let i = 0; i < 5; i++) j.lines.rebuild(false);
  check(JSON.stringify(first.platforms) === stable, 'repeated explicit rebuilds preserve valid Auto/manual allocation without load accumulation');
  const restored = deserialize(JSON.parse(JSON.stringify(serialize(j))));
  check(JSON.stringify(serialize(j)) === JSON.stringify(serialize(restored)), 'idle joined-service allocations restore without new decisions');
  const oversized = j.vehicles.buyTrain(depotFor(j, a, b), [...loco(), ...Array(4).fill(MODEL_BY_ID.get('coach_ic')!)], first.id) as Train;
  check(oversized instanceof Train && oversized.length > a.rail!.length, 'real oversized stock is retained for the stale-pattern restore fixture');
  oversized.pattern = 9876;
  const stale = deserialize(JSON.parse(JSON.stringify(serialize(j)))), restoredLine = stale.lines.get(first.id)!, restoredTrain = stale.vehicles.get(oversized.id)!;
  const beforeLookup = JSON.stringify(serialize(stale)), firstPattern = restoredLine.patterns![0].id;
  check(restoredTrain.pattern === 9876 && !platformChoices(stale, restoredLine, firstPattern, 0).length,
    'unknown saved stock pattern validates the first service using its actual consist length');
  check(beforeLookup === JSON.stringify(serialize(stale)), 'unknown-pattern fallback is a pure lookup and retains the saved ID');
  reconcilePlatforms(stale, true);
  check(!restoredLine.platforms?.some(p => p.pattern === firstPattern), 'explicit reconciliation cannot allocate a too-short platform by ignoring unknown-pattern stock');
}

// Opposing through services must prefer the direct running track at their shared bidirectional junction.
{
  const d = flatGame(256); d.aiEnabled = false; d.addAICompany(); d.company(1).economy.money = 1e9;
  d.setAccessPolicy(0, 'open'); d.setAccessPolicy(1, 'open');
  build(d, free(d, 10, 118), free(d, 246, 118), roadOpts(0, 'road'), 'shared junction street');
  const [a, b, junction, c, e] = [40, 76, 112, 160, 206].map((x, i) => station(d, x, 124, Math.PI / 2, i < 3 ? 12 : 10, 2, i < 3 ? 0 : 1,
    { trackType: 'electric', mode: i < 3 ? 'metro' : 'mainline', level: 'ground' })!);
  let from = d.world.net.nextEdge;
  for (const [x, y] of [[a, b], [b, junction]]) build(d, nodeSnap(d, endNode(d, x, 0, true), 'rail'), nodeSnap(d, endNode(d, y, 0, false), 'rail'), railOpts(0, 2, { type: 'electric' }), 'metro double');
  const metro = newTrack(d, from, 0); from = d.world.net.nextEdge;
  for (const [x, y] of [[junction, c], [c, e]]) build(d, nodeSnap(d, endNode(d, x, 0, true), 'rail'), nodeSnap(d, endNode(d, y, 0, false), 'rail'), railOpts(1, 2, { type: 'electric' }), 'partner double');
  const suburban = newTrack(d, from, 1);
  check(!finishDoubleTrack(d, metro, 0).error && !finishDoubleTrack(d, suburban, 1).error, 'both operators retain complete directional running approaches');
  const route = (ids: number[], owner: number) => { const l = d.lines.create('rail', owner); l.stops = [...ids, ...ids.slice(1, -1).reverse()]; d.lines.rebuild(); return l; };
  const outward = route([a.id, b.id, junction.id, c.id, e.id], 0), inward = route([e.id, c.id, junction.id, b.id, a.id], 1), ending = route([e.id, c.id, junction.id], 1);
  for (const owner of [0, 1]) autoSignalNetwork(d, owner);
  const forward = platformPreference(outward, 0, 2)!.group, backward = platformPreference(outward, 0, 6)!.group;
  check(forward !== backward && platformPreference(inward, 0, 2)?.group === backward && platformPreference(inward, 0, 6)?.group === forward,
    'opposing routes use the direct directional platforms before spreading onto crossover detours');
  const incoming = d.stations.railTrackGroups(b).flatMap(q => { const last = q.steps.at(-1)!; return railNext(d, d.world.net.edges.get(last.edge)!, last.dir, 0); });
  const actualAuto = findRailRoute(d, incoming, junction.id, 0, -1, 60000, false, null, false, { preferred: backward });
  const actualManual = findRailRoute(d, incoming, junction.id, 0, -1, 60000, false, null, false, { preferred: backward, manual: true });
  const directGroup = d.stations.railTrackGroups(junction).find(q => q.id === forward)!;
  const manualGroup = d.stations.railTrackGroups(junction).find(q => q.id === backward)!;
  check(directGroup.steps.some(s => s.edge === actualAuto?.conts.at(-1)?.edge.id), 'Auto cannot force a crossover detour from the train actual incoming direction');
  check(manualGroup.steps.some(s => s.edge === actualManual?.conts.at(-1)?.edge.id), 'a legal explicit manual preference still accepts its modest crossover detour');
  check(!setPlatformPreference(d, inward, 0, 2, forward), 'a reachable crossover remains a legal manual preference');
  reconcilePlatforms(d, true);
  check(platformPreference(inward, 0, 2)?.manual && platformPreference(inward, 0, 2)?.group === forward, 'explicit Auto improvement preserves a valid manual crossover preference');
  setPlatformPreference(d, inward, 0, 2, null);
  const oldAuto = inward.platforms!.find(p => p.stop === 2)!, wrong = d.stations.railTrackGroups(junction).find(q => q.id === forward)!;
  Object.assign(oldAuto, { group: wrong.id, back: wrong.back, front: wrong.front });
  const oldSave = deserialize(JSON.parse(JSON.stringify(serialize(d)))), oldRoute = oldSave.lines.get(inward.id)!;
  const before = JSON.stringify(serialize(oldSave)); platformChoices(oldSave, oldRoute, 0, 2);
  check(before === JSON.stringify(serialize(oldSave)) && platformPreference(oldRoute, 0, 2)?.group === forward, 'a restored valid old Auto decision remains unchanged by UI reads');
  reconcilePlatforms(oldSave, true);
  check(platformPreference(oldRoute, 0, 2)?.group === backward && !platformPreference(oldRoute, 0, 2)?.manual, 'explicit reconciliation corrects an old Auto crossover detour');
  reconcilePlatforms(d, true);
  const depot0 = depotAtEnd(d, endNode(d, a, 0, false), 0), depot1 = depotAtEnd(d, endNode(d, e, 1, true), 1);
  const t0 = [0, 1].map(() => d.vehicles.buyTrain(depot0, [MODEL_BY_ID.get('metro_b')!], outward.id) as Train);
  const t1 = [0, 1].map(() => d.vehicles.buyTrain(depot1, [MODEL_BY_ID.get('emu_b')!], inward.id) as Train);
  const t2 = [d.vehicles.buyTrain(depot1, [MODEL_BY_ID.get('emu_b')!], ending.id) as Train], all = [...t0, ...t1, ...t2];
  check(all.every(t => t instanceof Train), 'both shared-junction operators purchase their actual stock');
  const run = runTrains(d, all, 360), at = (ts: Train[], st: typeof a) => ts.reduce((n, t) => n + (run.arrivals.get(t.id) ?? []).filter(id => id === st.id).length, 0);
  console.log('directional shared junction', JSON.stringify({ metroEnd: at(t0, e), suburbanEnd: at(t1, a), terminatingJunction: at(t2, junction), worstDays: run.worst.days }));
  check(at(t0, e) >= 3 && at(t0, a) >= 3 && at(t1, a) >= 3 && at(t1, e) >= 3 && [t0, t1, t2].every(ts => at(ts, junction) >= 3),
    'both opposing through routes and the terminating service repeatedly serve every required shared endpoint');
  check(run.worst.days < 10 && deadlockCycles(d, 0).length === 0 && checkReservations(d).length === 0, 'direct Auto routing avoids the original eleven-day shared-junction interference');
  const loaded = deserialize(JSON.parse(JSON.stringify(serialize(d)))); let exact = JSON.stringify(serialize(d)) === JSON.stringify(serialize(loaded));
  for (let i = 0; i < 640 && exact; i++) { d.stepTick(); loaded.stepTick(); exact = JSON.stringify(serialize(d)) === JSON.stringify(serialize(loaded)); }
  check(exact, 'both operators and the terminating shared-junction service replay every saved decision for640ticks');
}

// Construct real curved facilities on inherited rail, then drive one train through their physical groups.
{
  const n = flatGame(256), net = n.world.net; n.aiEnabled = false;
  n.companies.push({ id: 1, name: 'Inherited Rail', color: '#3d8be8', ai: false, economy: new Economy(), code: 'I' });
  n.setAccessPolicy(1, 'open'); n.setAccessMultiplier(1, 2); n.refreshAccess();
  const curve = { x0: 70, z0: 70, x1: 70, z1: 100, x2: 100, z2: 130, x3: 130, z3: 130 };
  const start = net.addNode('rail', 70, 3.1, 70, 0, 1, 1), end = net.addNode('rail', 130, 3.1, 130, 1, 0, 1);
  net.addEdge('rail', start.id, end.id, curve, new Float32Array(200).fill(3.1), [], 'electric', 1);
  const tab = arcTable(curve), stops: number[] = [];
  for (const f of [.15, .5, .85]) {
    const at = bezPoint(curve, tAtS(tab, tab.len * f)), edge = net.nearestEdge(at.x, at.z, 1, 'rail', e => e.station < 0 && e.depot < 0)!;
    const plan = planStationOnTrack(n, edge.edge.id, edge.s, { length: 12, tracks: 1, reuseTrack: true, style: 'modern' }, 0);
    check(plan.ok, `native curved station quote (${plan.error ?? 'ok'})`);
    if (!plan.ok) continue;
    const built = commitStationOnTrack(n, plan); check(!built.error, `native curved station committed (${built.error ?? 'ok'})`); stops.push(built.station);
  }
  check(stops.length === 3 && stops.every(id => n.stations.get(id)?.rail?.native), 'three facilities retain the actual inherited continuous curve');
  const middle = n.stations.get(stops[1])!, group = n.stations.railTrackGroups(middle)[0];
  const first = net.splitEdge(group.steps[0].edge, 3)!, last = net.splitEdge(first.e2.id, 7)!;
  // The internal BLOCK guard also protects a real off-route branch inside the platform.
  const interior = net.splitEdge(last.e1.id, 3)!;
  first.node.signal = 1; first.node.signalKind = 'block'; last.node.signal = 1;
  const junction = interior.node, bx = junction.x + junction.tx * 12 - junction.tz * 8, bz = junction.z + junction.tz * 12 + junction.tx * 8;
  const branchEnd = net.addNode('rail', bx, junction.y, bz, junction.tx, junction.tz, 1);
  const branch = net.addEdge('rail', junction.id, branchEnd.id, {
    x0: junction.x, z0: junction.z, x1: junction.x + junction.tx * 4, z1: junction.z + junction.tz * 4,
    x2: bx - junction.tx * 4, z2: bz - junction.tz * 4, x3: bx, z3: bz,
  }, new Float32Array(40).fill(junction.y), [], 'electric', 1);
  const depot = depotAtEnd(n, start.id, 0), route = n.lines.create('rail', 0); route.stops = [...stops];
  n.lines.rebuild(); n.flushNetworkChanges();
  const autoChoices = stops.map((_, i) => platformChoices(n, route, 0, i).map(q => q.id));
  check(n.lines.isLoop(route) && autoChoices[1].length === 1, 'Auto treats three distinct native stops as a loop and offers the legal middle track');
  n.lines.setLoop(route.id, true); n.lines.rebuild(false);
  check(JSON.stringify(stops.map((_, i) => platformChoices(n, route, 0, i).map(q => q.id))) === JSON.stringify(autoChoices),
    'explicit Loop has the same native call choices as Auto on three distinct stops');
  n.lines.setLoop(route.id, false); n.lines.rebuild(false);
  check(stops.every((_, i) => platformChoices(n, route, 0, i).length === 1 && platformPreference(route, 0, i)?.group === n.stations.railTrackGroups(n.stations.get(stops[i])!)[0].id),
    'explicit three-stop Out and back assigns viable native platforms at both endpoints and the middle');
  check(setPatterns(n, route.id, [{ id: 7, name: 'Short turn', kind: 'local', stops: [false, true, true] }]) === null
    && [1, 2].every(i => platformChoices(n, route, 7, i).length === 1 && !!platformPreference(route, 7, i)) && !platformPreference(route, 7, 0),
    'a non-loop short-turn service mirrors its first and last served native calls');
  replaceLineStops(n, route, [stops[0], stops[1], stops[2], stops[1]]);
  check(setPatterns(n, route.id, [{ id: 0, name: 'Local', kind: 'local', stops: [true, true, true, true] }]) === null
    && route.platforms?.length === 4 && route.platforms.filter(p => p.station === stops[1]).length === 2
    && [0, 1, 2, 3].every(i => platformChoices(n, route, 0, i).length === 1),
    'stored outward and return native calls retain distinct repeated occurrences with their correct neighbours');
  const returnPreference = platformPreference(route, 0, 3)!;
  check(!setPlatformPreference(n, route, 0, 3, returnPreference.group), 'return occurrence accepts its own manual native preference');
  n.lines.rebuild(false);
  check(platformPreference(route, 0, 3)?.manual && !platformPreference(route, 0, 1)?.manual,
    'rebuilding preserves the manual return occurrence without copying it to the outward call');
  const train = n.vehicles.buyTrain(depot, loco(), route.id) as Train;
  check(train instanceof Train, 'own depot buys a legal consist for the inherited curved railway');
  n.vehicles.setRes(last.e2.id, -99);
  let enteredBusy = false, waited = false;
  for (let i = 0; i < 40 * 120; i++) { n.stepTick(); enteredBusy ||= train.occupiedEdges().some(id => n.stations.railTrackGroups(middle)[0].steps.some(s => s.edge === id)); waited ||= train.state === 'waiting' && train.routeTarget === middle.id; }
  check(waited && !enteredBusy && n.vehicles.getRes(first.e1.id) !== train.id, 'the whole target group stays unentered until every fragment is free, including across internal guards');
  const blockerIds: number[] = [], cursor = { phase: 'path' as const, segment: 0, resource: 0, train: 0 };
  let scanWork = 0;
  while ((cursor as { phase: string }).phase !== 'done' && scanWork < 10000) {
    const work = train.scanBlockers(cursor, 1, id => blockerIds.push(id)); check(work <= 1, 'split-platform blocker scan keeps its explicit work bound'); scanWork += work;
  }
  check(blockerIds.includes(-99), 'bounded blocker scan sees the far fragment past interior platform guards');
  n.vehicles.releaseRes(last.e2.id, -99);
  n.vehicles.setRes(branch.id, -98); enteredBusy = waited = false;
  for (let i = 0; i < 40 * 120; i++) { n.stepTick(); enteredBusy ||= train.occupiedEdges().some(id => n.stations.railTrackGroups(middle)[0].steps.some(s => s.edge === id)); waited ||= train.state === 'waiting' && train.routeTarget === middle.id; }
  check(waited && !enteredBusy && n.stations.railTrackGroups(middle)[0].steps.every(s => n.vehicles.getRes(s.edge) !== train.id),
    'an internal BLOCK guard keeps the entire free platform unentered while its off-route branch is held');
  const branchBlockers: number[] = [], branchCursor = { phase: 'path' as const, segment: 0, resource: 0, train: 0 };
  scanWork = 0;
  while ((branchCursor as { phase: string }).phase !== 'done' && scanWork < 10000) {
    const work = train.scanBlockers(branchCursor, 1, id => branchBlockers.push(id)); check(work <= 1, 'internal BLOCK dependency scan preserves the per-call work bound'); scanWork += work;
  }
  check(branchBlockers.includes(-98) && train.blockingTrains().includes(-98), 'bounded and complete blocker scans expose the same off-route BLOCK dependency');
  n.vehicles.releaseRes(branch.id, -98);
  const directions = new Set<number>(), resizedDirections = new Set<number>(); let replayed = false, prior = '', calls = 0;
  for (let i = 0; i < 40 * 720; i++) {
    n.stepTick();
    if (train.state === 'loading' && train.atStation === middle.id && prior !== 'loading') {
      calls++; const head = train.segs[train.headSeg], direction = head.dir; directions.add(direction);
      const ends = n.stations.railTrackGroups(middle)[0].steps;
      check(direction > 0 ? head.e === ends.at(-1)!.edge : head.e === ends[0].edge, 'real curved arrival stops at the complete group end in its travel direction');
      const longer = [...loco(), MODEL_BY_ID.get('coach_ic')!];
      check(n.vehicles.recompose(train, longer) === null && checkReservations(n).length === 0, 'curved platform accepts a fitting longer consist with physical rear clearance');
      resizedDirections.add(direction);
      if (!replayed) {
        setPlatformPreference(n, route, 0, train.stopIndex, group.id);
        const loaded = deserialize(JSON.parse(JSON.stringify(serialize(n))));
        let same = JSON.stringify(serialize(n)) === JSON.stringify(serialize(loaded));
        const diagnose = () => { const a = serialize(n), b = serialize(loaded); console.log('native replay mismatch', n.tick, Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k])));
          for (const k of Object.keys(a).filter(k => JSON.stringify(a[k]) !== JSON.stringify(b[k]))) { const x = JSON.stringify(a[k]), y = JSON.stringify(b[k]); let i = 0; while (x[i] === y[i] && i < x.length) i++; console.log(k, i, x.slice(i - 70, i + 180), y.slice(i - 70, i + 180)); } };
        if (!same) diagnose();
        for (let k = 0; k < 640 && same; k++) { n.stepTick(); loaded.stepTick(); same = JSON.stringify(serialize(n)) === JSON.stringify(serialize(loaded)); if (!same) diagnose(); }
        check(same, 'native curved allocation/consist/routes replay every full serialization for640ticks'); replayed = true;
      }
      n.vehicles.recompose(train, loco());
    }
    prior = train.state;
  }
  console.log('native curved service', JSON.stringify({ calls, directions: [...directions], resizedDirections: [...resizedDirections], reservations: checkReservations(n) }));
  check(directions.size === 2 && resizedDirections.size === 2 && replayed && train.state !== 'noroute', 'native segmented curve serves and fits trains in both directions');
  const frozen = JSON.stringify(serialize(n));
  for (let i = 0; i < 5; i++) { platformChoices(n, route, 0, 1); n.stations.railTrackGroups(middle); }
  check(frozen === JSON.stringify(serialize(n)), 'native group and route choices are pure reads');
  net.removeEdge(interior.e2.id); n.lines.rebuild(false);
  check(n.stations.railTrackGroups(middle).length === 0 && !route.platforms?.some(p => p.group === group.id), 'a deleted middle fragment invalidates the preferred physical platform');
  check(!findRailRoute(n, [{ edge: last.e2, dir: -1 }], middle.id, 0, -1, 60000, false, null, true, { length: 10 }), 'disconnected curved fragments cannot be summed to fit a long train');
}
done();
