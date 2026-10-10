// Native two-line urban through discovery, continuity, economics and saved review.
import { Game } from '../src/game/game';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { runNetworkTask, networkDaily, networkPlanner, networkProfile } from '../src/game/ai-network';
import { quoteThrough, throughRouteProof, throughQuoteContext, throughCandidates, throughMiddleLines, type ThroughHost } from '../src/game/ai-through';
import { patternStops } from '../src/game/patterns';
import { outAndBack } from '../src/game/lines';
import { railPartMode } from '../src/game/stations';
import { station, depotFor, endNode, check, done } from './stationlib';
import { newTown, district } from './linegrow-fixtures';
import { checkReservations } from './lib';
import { bezLine, bezOffset, bezDeriv } from '../src/game/geom';
import { planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { finishDoubleTrack } from '../src/game/trackops';
import { planEdge, commitProposal } from '../src/game/construction';
import { stationEnds, nodeSnap } from '../src/game/routing';
import { walkingCatchment } from '../src/game/catchment';
const saved = (g: Game) => JSON.stringify(serialize(g));
const cars = () => [MODEL_BY_ID.get('metro_a')!];
function base() {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000, aiCompanies: 2 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.aiAcquisitions = false; g.world.h.fill(4); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  return g;
}
function fixture(middle = false) {
  const g = base(), net = g.world.net;
  const xs = middle ? [40, 140, 240, 340] : [40, 180, 320];
  const towns = xs.map((x, i) => newTown(g, 'Urban ' + i, x, 192));
  for (const town of towns) town.pop = 18000;
  for (const c of g.companies) c.hqTown = 0;
  const sts = xs.map((x, i) => station(g, x, 192, Math.PI / 2, 12, 2, i === 0 ? 1 : 2,
    { trackType: 'electric', mode: i === 0 ? 'metro' : 'lightrail', level: 'ground', style: 'none' })!);
  if (sts.some(s => !s)) throw new Error('station fixture');
  for (let i = 0; i + 1 < sts.length; i++) {
    const owner = i === 0 ? 1 : 2, a = stationEnds(g, sts[i]).map(t => t.front), b = stationEnds(g, sts[i + 1]).map(t => t.back), edge0 = net.nextEdge;
    const p = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), { kind: 'rail', type: 'electric', tracks: 2, heightOffset: 0, crossing: 'auto', owner });
    if (!p.ok || commitProposal(g, p)) throw new Error('double fixture ' + i + ': ' + p.errors.join(','));
    const edges = [...net.edges.keys()].filter(id => id >= edge0);
    const finish = finishDoubleTrack(g, edges, owner); if (finish.error) throw new Error('directional fixture ' + i + ': ' + finish.error);
  }
  const ownDepot = depotFor(g, sts[0], sts[1], 1), foreignDepot = depotFor(g, sts.at(-1)!, sts.at(-2)!, 2);
  const lines = [1, 2].map((owner, i) => {
    const l = g.lines.create('rail', owner); l.stops = outAndBack(i === 0 ? [sts[0].id, sts[middle ? 2 : 1].id] : sts.slice(1).map(s => s.id));
    const depot = i ? foreignDepot : ownDepot;
    const t = g.vehicles.buyTrain(depot, cars(), l.id); if (!(t instanceof Train)) throw new Error(String(t));
    (g.aiOf(owner)! as any).lines.set(l.id, { kind: 'rail', towns: i ? towns.slice(1).map(t => t.id) : [0], depot, maxVehicles: 6, opened: g.day, double: true, urban: 'metro' });
    return l;
  });
  for (let i = 0; i < towns.length; i++) { towns[i].pop = 0; district(g, towns[i], xs[i] - 12, xs[i] + 20, 192, 32, 18000, false, false); }
  g.lines.rebuild(); for (let i = 0; i < 2; i++) g.stepTick();
  return { g, sts, lines };
}
function controlled(g: Game, positive = true) {
  g.demand.forecastLine = ((points: any[]) => ({ revenue: points.length >= 3 && positive ? 1e8 : 0,
    boardings: positive ? 10000 : 0, covered: 10000, transfers: 0, legLoads: Array(2 * (points.length - 1)).fill(10) })) as any;
}
{
  const { g, sts, lines } = fixture(), ownFleet = [...lines[0].vehicles], foreignFleet = [...lines[1].vehicles];
  const shapes = sts.map(s => JSON.stringify(s.rail)), edges = g.world.net.edges.size, construction = g.company(1).economy.thisYear.construction;
  const quote = quoteThrough({ g, me: 1, ai: g.aiOf(1)! } as ThroughHost, lines, sts.map(s => s.id), cars(), 0, []);
  console.log('native sites', sts.map(s => ({ id: s.id, access: s.roadAccess, pop: s.catchPop, buildings: walkingCatchment(g, s).buildings.size, fc: g.stations.forecourt(s) })));
  console.log('native urban pair economics', quote);
  check(!!quote && Number.isFinite(quote.score) && quote.fees > 0, 'native city quote accounts for real licensed infrastructure costs');
  controlled(g); // Isolate native construction/routing from this scene's deliberately weak marginal receipts.
  check(runNetworkTask(g.aiOf(1)!, 'through', 3), 'pair review starts without a second owned outer line');
  const pending = saved(g), clone = deserialize(JSON.parse(pending));
  controlled(clone);
  check(saved(clone) === pending, 'bounded pair directions and shortlisted entries save exactly');
  for (let i = 0; i < 24 && networkPlanner(g.aiOf(1)!)?.task; i++) {
    networkDaily(g.aiOf(1)!); networkDaily(clone.aiOf(1)!);
    check(saved(g) === saved(clone), 'saved pair quote/build resumes identically: ' + i);
  }
  console.log('paid pair review', g.aiOf(1)!.log.slice(-3), networkProfile.decisions);
  const line = g.lines.all().find(l => l.owner === 1 && new Set(l.stops).size === sts.length);
  check(!!line, 'native paid service continues over the existing foreign urban route');
  check(g.world.net.edges.size === edges && g.company(1).economy.thisYear.construction === construction, 'connected pair buys stock without connector construction');
  check(sts.every((s, i) => JSON.stringify(s.rail) === shapes[i]), 'existing foreign and own platform styles/geometry stay intact');
  check(g.lines.get(lines[1].id) === lines[1] && lines[1].vehicles.join() === foreignFleet.join(), 'foreign timetable and fleet stay intact');
  if (line) {
    check(ownFleet.every(id => new Set(patternStops(line, g.vehicles.get(id)!.pattern).map(i => line.stops[i])).size === 2), 'original city local remains its shorter pattern');
    const next = line.vehicles.map(id => g.vehicles.get(id)).find(t => t instanceof Train && !ownFleet.includes(t.id)) as Train;
    check(!!next && !!throughRouteProof(g, sts.map(s => s.id), 1, next.cars), 'new stock proves full-body bidirectional continuity');
    const replay = deserialize(JSON.parse(saved(g))); for (let tick = 0; tick < 32; tick++) { g.stepTick(); replay.stepTick(); }
    check(saved(g) === saved(replay) && !checkReservations(g).length, '32 operating ticks replay with lawful reservations');
    const visits = new Set<number>();
    for (let tick = 0; tick < 16000 && visits.size < sts.length; tick++) { g.stepTick(); if (next.state === 'loading') visits.add(next.atStation); }
    check(sts.every(s => visits.has(s.id)), 'actual train serves all through calls and returns');
    check(g.agreement(1, 2)!.paidLastMonth > 0, 'native foreign infrastructure access is actually billed');
  }
}
{
  const { g, sts } = fixture(true); controlled(g);
  const h = { g, me: 1, ai: g.aiOf(1)!, cared: () => false, selectSides: (_: number, ids: number[]) => ids } as ThroughHost;
  console.log('middle candidates', throughCandidates(h, throughMiddleLines(h)), g.lines.all().map(l => ({ id: l.id, stops: l.stops, owner: l.owner })));
  check(runNetworkTask(g.aiOf(1)!, 'through'), 'shared intermediate foreign hub review completes');
  const line = g.lines.all().find(l => l.owner === 1 && new Set(l.stops).size > 2);
  console.log('intermediate-hub review', g.aiOf(1)!.log.slice(-3), networkProfile.decisions);
  check(!!line && line.stops.includes(sts[2].id), 'owned city terminus continues from the middle of the foreign line');
}
for (const failure of ['unpaid', 'denied', 'walking'] as const) {
  const { g, sts } = fixture();
  if (failure === 'unpaid') controlled(g, false); else controlled(g);
  if (failure === 'denied') g.setAccessPolicy(2, 'auto-reject');
  if (failure === 'walking') {
    const ids = new Set(sts[1].rail!.edges); for (const id of [...g.world.net.edges.keys()]) if (!ids.has(id) && g.world.net.edges.get(id)!.kind === 'rail' && g.world.net.edges.get(id)!.owner === 1 && g.world.net.edges.get(id)!.station < 0 && g.world.net.edges.get(id)!.depot < 0) g.world.net.removeEdge(id);
    g.onNetworkChanged(); g.lines.rebuild();
  }
  const money = g.company(1).economy.money, edges = g.world.net.edges.size;
  runNetworkTask(g.aiOf(1)!, 'through');
  check(g.lines.all().length === 2 && g.company(1).economy.money === money && g.world.net.edges.size === edges, failure + ' pair does not force a service');
}
{
  const { g, sts, lines } = fixture(), h = { g, me: 1, ai: g.aiOf(1)! } as ThroughHost;
  const context = throughQuoteContext(), before = saved(g), a = quoteThrough(h, lines, sts.map(s => s.id), cars(), 0, []);
  const start = performance.now(); let b: ReturnType<typeof quoteThrough> = null;
  for (let i = 0; i < 8; i++) b = quoteThrough(h, lines, sts.map(s => s.id), cars(), 0, [], undefined, undefined, undefined, context);
  console.log('quote-local native proof reuse', { lookups: context.lookups, hits: context.hits, elapsedMs: performance.now() - start });
  check(JSON.stringify(a) === JSON.stringify(b) && context.hits >= 14 && context.routes.size === 2, 'quote-local cache reuses exact native pair and baseline proofs');
  check(saved(g) === before, 'disposable quote reuse preserves the complete save');
  g.setAccessPolicy(2, 'auto-reject');
  check(quoteThrough(h, lines, sts.map(s => s.id), cars(), 0, [], undefined, undefined, undefined, context) === null,
    'quote cache observes revoked rights in the same simulation tick');
}

{
  const g = base(), net = g.world.net, shape = { x0: 110, z0: 110, x1: 110, z1: 140, x2: 140, z2: 170, x3: 170, z3: 170 }, rails = [];
  for (let i = 0; i < 2; i++) {
    const c = bezOffset(shape, i * .5), ad = bezDeriv(c, 0), bd = bezDeriv(c, 1);
    const a = net.addNode('rail', c.x0, 4, c.z0, ad.x, ad.z, 2), b = net.addNode('rail', c.x3, 4, c.z3, bd.x, bd.z, 2);
    rails.push(net.addEdge('rail', a.id, b.id, c, new Float32Array(300).fill(4), [], 'electric', 2));
  }
  const ra = net.addNode('road', 110, 4, 155, 0, 0, -1), rb = net.addNode('road', 144, 4, 184, 0, 0, -1);
  net.addEdge('road', ra.id, rb.id, bezLine(ra.x, ra.z, rb.x, rb.z), new Float32Array(100).fill(4), [], 'street', -1);
  const p = planStationOnTrack(g, rails[0].id, rails[0].len / 2, { length: 20, tracks: 2, reuseTrack: true, mode: 'lightrail', style: 'none' }, 2);
  const built = commitStationOnTrack(g, p), J = g.stations.get(built.station)!;
  check(!built.error && !!J?.rail?.native, 'actual curved foreign urban platform exists');
  const A = station(g, 109.75, 60, 0, 12, 2, 1, { trackType: 'electric', mode: 'metro', level: 'ground', style: 'none' })!;
  const B = station(g, 230, 169.75, Math.PI / 2, 12, 2, 2, { trackType: 'electric', mode: 'lightrail', level: 'ground', style: 'none' })!;
  for (let i = 0; i < 2; i++) {
    const a = net.nodes.get(endNode(g, A, i, true))!, b = net.nodes.get(rails[i].a)!;
    net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(100).fill(4), [], 'electric', 1);
    const c = net.nodes.get(rails[i].b)!, d = net.nodes.get(endNode(g, B, i, false))!;
    net.addEdge('rail', c.id, d.id, bezLine(c.x, c.z, d.x, d.z), new Float32Array(100).fill(4), [], 'electric', 2);
  }
  const ownDepot = depotFor(g, A, J, 1), foreignDepot = depotFor(g, B, J, 2);
  const lines = [1, 2].map((owner, i) => {
    const l = g.lines.create('rail', owner); l.stops = i ? [J.id, B.id] : [A.id, J.id];
    const depot = i ? foreignDepot : ownDepot, train = g.vehicles.buyTrain(depot, cars(), l.id);
    check(train instanceof Train, 'curved fixture actual paid stock fits');
    (g.aiOf(owner)! as any).lines.set(l.id, { kind: 'rail', towns: [], depot, maxVehicles: 6, opened: g.day, double: true, urban: 'lightrail' });
    return l;
  });
  for (const id of [...J.rail!.edges]) net.splitEdge(id, 1);
  g.lines.rebuild(); controlled(g);
  const alignment = JSON.stringify(J.rail!.alignment), groups = JSON.stringify(J.rail!.groups), edgeCount = net.edges.size;
  check(!!throughRouteProof(g, [A.id, J.id, B.id], 1, cars()), 'actual split curved platforms prove full-body continuity');
  runNetworkTask(g.aiOf(1)!, 'through');
  console.log('curved pair review', g.aiOf(1)!.log.slice(-3));
  check(g.lines.all().some(l => l.owner === 1 && new Set(l.stops).size === 3), 'licensed curved/split urban pair opens through service');
  check(net.edges.size === edgeCount && JSON.stringify(J.rail!.alignment) === alignment && JSON.stringify(J.rail!.groups) === groups
    && railPartMode(J.rail!) === 'lightrail', 'curve geometry, fragments and foreign station style stay intact without new construction');
  const clone = deserialize(JSON.parse(saved(g))); for (let t = 0; t < 32; t++) { g.stepTick(); clone.stepTick(); }
  check(saved(g) === saved(clone) && !checkReservations(g).length, 'curved through operating saves replay exactly');
}
done();
