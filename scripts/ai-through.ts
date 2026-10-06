// Small native own / foreign / own service, economic rejection, access denial and pending-planner replay.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { outAndBack, linearStops } from '../src/game/lines';
import { patternStops, addPattern, setVehiclePattern } from '../src/game/patterns';
import { runNetworkTask, networkDaily, networkPlanner, networkProfile } from '../src/game/ai-network';
import { buildThroughConnections, quoteThrough, throughRouteProof, type ThroughLink, type ThroughHost } from '../src/game/ai-through';
import { planConnection, planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { buildDepotOnLine } from '../src/game/routing';
import { station, depotFor, check, done, build, free, railOpts, flatGame, endNode } from './stationlib';
import { connectDouble } from './lib';
import { bezLine, bezOffset, bezDeriv } from '../src/game/geom';

const json = (g: Game) => JSON.stringify(serialize(g));
const cars = () => [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!];
function fixture() {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: 2 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.aiAcquisitions = false; g.world.h.fill(4); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  const sts = [40, 140, 240, 340].map((x, i) => station(g, x, 192, Math.PI / 2, 12, 2, i === 0 || i === 3 ? 1 : 2)!);
  if (sts.some(s => !s)) throw new Error('station fixture');
  for (let i = 0; i < 3; i++) if (!connectDouble(g, sts[i], sts[i + 1], i === 1 ? 2 : 1, () => {}).ok) throw new Error('native double fixture');
  const dp = depotFor(g, sts[0], sts[1], 1), dpC = depotFor(g, sts[3], sts[2], 1);
  let dpB = -1;
  for (const e of [...g.world.net.edges.values()].filter(e => e.owner === 2 && e.station < 0 && e.len > 15).sort((a, b) => b.len - a.len)) {
    for (const side of [1, -1] as const) { dpB = buildDepotOnLine(g, e.id, e.len / 2, 2, { dir: 1, side }); if (dpB >= 0) break; }
    if (dpB >= 0) break;
  }
  const lines = [1, 2, 1].map((owner, i) => {
    const l = g.lines.create('rail', owner); l.stops = [sts[i].id, sts[i + 1].id];
    const depot = [dp, dpB, dpC][i], t = g.vehicles.buyTrain(depot, cars(), l.id);
    if (!(t instanceof Train)) throw new Error(String(t));
    (g.aiOf(owner)! as any).lines.set(l.id, { kind: 'rail', towns: [], depot, maxVehicles: 6, opened: g.day, double: true });
    return l;
  });
  g.lines.rebuild(); return { g, sts, lines };
}
function receipts(g: Game, amount: number, locals = 0) {
  // Controlled receipts isolate the investment choice; physical routes, fares in operation, stock and capacity remain native.
  g.demand.forecastLine = ((points: any[]) => ({ revenue: points.length >= 4 ? amount : locals,
    boardings: amount / 10000, covered: 10000, transfers: 0, legLoads: Array(2 * (points.length - 1)).fill(amount > 0 ? 10 : 0) })) as any;
}
const f = fixture(), baseline = serialize(f.g), ownFleet = f.lines.filter(l => l.owner === 1).flatMap(l => l.vehicles), foreignFleet = [...f.lines[1].vehicles];
{
  const g = deserialize(baseline), records: { n: number; kmh: number }[] = [];
  g.demand.forecastLine = ((sites: any[], _mode: string, kmh: number) => { records.push({ n: sites.length, kmh });
    return { revenue: sites.length === 4 ? 1e8 : 0, boardings: 10000, covered: 10000, transfers: 0, legLoads: [10] }; }) as any;
  const slow = cars().map(m => ({ ...m, id: 'slow-' + m.id, speed: 12 }));
  const q = quoteThrough({ g, me: 1, ai: g.aiOf(1)! } as ThroughHost, f.lines.map(l => g.lines.get(l.id)!), f.sts.map(s => s.id), slow, 0, []);
  check(!!q && q.kmh <= 12, 'pricing respects a slow consist without a 20 km/h speed floor');
  check(records.filter(r => r.n === 2).every(r => r.kmh > q!.kmh), 'retained faster locals use their own cycle and speed');
  // The source platform's head fragment is shorter than the body; native ordered groups still depart legally.
  const st = g.stations.get(f.sts[1].id)!;
  for (const id of [...st.rail!.edges]) g.world.net.splitEdge(id, 1);
  check(!!throughRouteProof(g, f.sts.map(s => s.id), 1, cars()), 'split foreign platforms use full-body native departure groups');
  const a = g.lines.get(f.lines[0].id)!, original = g.vehicles.get(a.vehicles[0]) as Train;
  const spare = g.vehicles.buyTrain(original.depotId, cars(), a.id) as Train, local = addPattern(g, a.id, 'distinct local', a.stops.map(() => true))!;
  setVehiclePattern(g, original.id, local.id);
  check(!quoteThrough({ g, me: 1, ai: g.aiOf(1)! } as ThroughHost, f.lines.map(l => g.lines.get(l.id)!), f.sts.map(s => s.id), cars(), 0, [], spare),
    'reuse cannot remove the only train of a distinct retained pattern');
}
receipts(f.g, 1e8);
check(runNetworkTask(f.g.aiOf(1)!, 'through', 3), 'bounded through review starts');
const pending = json(f.g), loaded = deserialize(JSON.parse(pending)); receipts(loaded, 1e8);
check(json(loaded) === pending, 'pending three-leg candidate saves exactly');
for (let i = 0; i < 12 && networkPlanner(f.g.aiOf(1)!)?.task; i++) {
  networkDaily(f.g.aiOf(1)!); networkDaily(loaded.aiOf(1)!);
  check(json(f.g) === json(loaded), 'pending review resumes identically at work unit ' + i);
}
const through = f.g.lines.all().find(l => l.owner === 1 && new Set(l.stops).size === 4);
check(!!through, 'own / foreign / own chain opens one full through timetable');
if (through) {
  check(linearStops(through.stops)?.join() === f.sts.map(s => s.id).join(), 'physical station calls retained in order');
  check(through.vehicles.length === ownFleet.length + 1, 'one paid through train added, original outer stock retained');
  for (const id of ownFleet) { const t = f.g.vehicles.get(id)!;
    check(t.lineId === through.id && new Set(patternStops(through, t.pattern).map(i => through.stops[i])).size === 2, 'original outer fleet keeps its local short-turn'); }
  check(f.g.lines.get(f.lines[1].id) === f.lines[1] && f.lines[1].vehicles.join() === foreignFleet.join(), 'foreign timetable, ownership and stock retained');
  check(f.g.lines.nextHop(f.sts[0].id, f.sts[3].id)?.alight === f.sts[3].id, 'passengers offered one ride across both company boundaries');
  const tt = through.vehicles.map(id => f.g.vehicles.get(id)).find(t => t instanceof Train && !ownFleet.includes(t.id)) as Train;
  check(!!tt && tt.pattern === undefined, 'new train runs the all-through pattern');
  const calls = new Set<number>();
  for (let i = 0; i < 12000; i++) {
    for (const [s, target] of [[f.sts[0], f.sts[3]], [f.sts[3], f.sts[0]]])
      f.g.stations.addWaiting(s, through.id, target.id, target.id, Math.max(0, 8 - s.waitingTotal));
    f.g.stepTick(); if (tt.state === 'loading') calls.add(tt.atStation);
  }
  console.log('through physical calls', [...calls], 'delivered', tt.delivered, 'state', tt.state);
  check(f.sts.every(s => calls.has(s.id)), 'native train actually visits all four stations');
  check(f.g.agreement(1, 2)?.paidTotal! > 0, 'ordinary usage-based access fees paid to the foreign owner');
  const after = json(deserialize(serialize(f.g))), before = json(f.g);
  if (after !== before) { let i = 0; while (after[i] === before[i]) i++; console.log('save diff', before.slice(i - 70, i + 160), after.slice(i - 70, i + 160)); }
  check(after === before, 'operating full-through line saves exactly');
  const continuation = deserialize(serialize(f.g));
  for (let i = 0; i < 64; i++) { f.g.stepTick(); continuation.stepTick(); }
  check(json(continuation) === json(f.g), 'operating full-through line resumes exactly for 64 native ticks');
}
const noPay = deserialize(baseline); receipts(noPay, 0); const money = noPay.company(1).economy.money, edges = noPay.world.net.edges.size;
runNetworkTask(noPay.aiOf(1)!, 'through');
check(noPay.lines.all().length === 3 && noPay.company(1).economy.money === money && noPay.world.net.edges.size === edges, 'unpaid through service spends nothing and retains three locals');
const retained = deserialize(baseline); receipts(retained, 2e6, 2e6); runNetworkTask(retained.aiOf(1)!, 'through');
check(retained.lines.all().length === 3, 'unchanged own local receipts cannot pay twice for a through service');
const denied = deserialize(baseline); denied.setAccessPolicy(2, 'auto-reject'); receipts(denied, 1e8); runNetworkTask(denied.aiOf(1)!, 'through');
check(denied.lines.all().length === 3 && denied.vehicles.map.size === 3, 'denied foreign access does not buy a through train or bypass routing');

// Three physically separate rail services: the middle has an interior call between the two local turnouts.
{
  const g = flatGame(384); g.addAICompany({ startMoney: 1e9 }); g.addAICompany({ startMoney: 1e9 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  const A = [station(g, 35, 100, Math.PI / 2, 12, 2, 1)!, station(g, 135, 100, Math.PI / 2, 12, 2, 1)!];
  const B = [station(g, 105, 120, Math.PI / 2, 12, 2, 2)!, station(g, 175, 120, Math.PI / 2, 12, 2, 2)!, station(g, 245, 120, Math.PI / 2, 12, 2, 2)!];
  const C = [station(g, 215, 140, Math.PI / 2, 12, 2, 1)!, station(g, 335, 140, Math.PI / 2, 12, 2, 1)!];
  const paths = [A, B, C], ls = [];
  for (const [i, ps] of paths.entries()) {
    const owner = i === 1 ? 2 : 1;
    for (let j = 1; j < ps.length; j++) check(connectDouble(g, ps[j - 1], ps[j], owner, () => {}).ok, 'separate native corridor built');
    const l = g.lines.create('rail', owner); l.stops = outAndBack(ps.map(s => s.id)); ls.push(l);
    if (owner === 1) {
      const depot = depotFor(g, i === 0 ? ps[0] : ps.at(-1)!, i === 0 ? ps[1] : ps[0], owner);
      const t = g.vehicles.buyTrain(depot, cars(), l.id); check(t instanceof Train, 'separate outer paid train built');
      (g.aiOf(1)! as any).lines.set(l.id, { kind: 'rail', towns: [], depot, maxVehicles: 6, opened: g.day, double: true });
    }
  }
  g.lines.rebuild(); receipts(g, 1e8);
  const gapReceipts = (world: Game) => world.demand.forecastLine = ((sites: any[]) => ({ revenue: sites.some(s => s.id === A[0].id) && sites.some(s => s.id === C.at(-1)!.id) ? 1e8 : 0,
    boardings: 10000, covered: 10000, transfers: 0, legLoads: [10] })) as any;
  gapReceipts(g);
  const rails = g.world.net.edges.size;
  runNetworkTask(g.aiOf(1)!, 'through', 9);
  const saved = deserialize(serialize(g)); gapReceipts(saved);
  check(json(saved) === json(g), 'saved pending two-gap survey preserves its plain turnout choices');
  networkDaily(g.aiOf(1)!); networkDaily(saved.aiOf(1)!);
  check(json(saved) === json(g), 'two native junctions and paid service commit identically after save/load');
  const l = g.lines.all().find(l => l.owner === 1 && l.stops.includes(A[0].id) && l.stops.includes(C.at(-1)!.id));
  if (!l) console.log('gap decisions', networkProfile.decisions, g.aiOf(1)!.log);
  check(!!l && g.world.net.edges.size > rails, 'three-leg review builds two native local turnouts for a disconnected foreign middle');
  if (l) {
    check(!!throughRouteProof(g, linearStops(l.stops)!, 1, cars()), 'completed gap service has lawful native routes and full platforms in both directions');
    check(ls.every(old => !!throughRouteProof(g, linearStops(old.stops)!, old.owner, cars())), 'both native junctions retain the three original local railway routes');
  }
}

// Native two-connector transaction: splitting a foreign asset at the first turnout, then failing the second.
{
  const g = Game.create({ size: 256, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: 2 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.world.h.fill(4); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  const a = build(g, free(g, 30, 80), free(g, 220, 80), railOpts(1), 'outer rail');
  const b = build(g, free(g, 30, 81.5), free(g, 220, 81.5), railOpts(2), 'foreign middle rail');
  check(!!a && !!b, 'connector fixture has two real parallel rails');
  const es = [...g.world.net.edges.values()], ea = es.find(e => e.owner === 1)!, eb = es.find(e => e.owner === 2)!;
  const link: ThroughLink = { ax: 90, az: 80, atx: 1, atz: 0, bx: 110, bz: 81.5, btx: 1, btz: 0, d: 20, left: [], right: [], value: 0, la: false, lb: false };
  const p = planConnection(g, ea.id, 60, eb.id, 80, 1);
  check(p.ok, 'native first turnout plan valid');
  const savedOwners = new Map([...g.world.net.nodes].map(([id, n]) => [id, n.owner]));
  const tree = g.world.addTree({ x: 100, z: 80.75, s: 1, type: 0, tint: .5 }), heights = [...g.world.h];
  const cash = g.company(1).economy.money, foreign = g.company(2).economy.money, access = JSON.stringify(g.access), month = JSON.stringify(g.company(2).economy.current);
  let count = 0;
  const tx = buildThroughConnections(g, [link, link], () => ++count === 1 ? p : null);
  check(!!tx.error, 'blocked second connector aborts the transaction');
  check([...g.world.net.edges.values()].filter(e => e.owner === 2).reduce((n, e) => n + e.len, 0) >= eb.len - 1e-6, 'foreign rail split descendants remain usable and owned');
  check([...g.world.net.nodes].every(([id, n]) => !savedOwners.has(id) || n.owner === savedOwners.get(id)), 'original rail-node ownership preserved');
  check(g.company(1).economy.money === cash && g.company(2).economy.money === foreign && JSON.stringify(g.access) === access && JSON.stringify(g.company(2).economy.current) === month,
    'only failed connector construction refunded; foreign money and access unchanged');
  check(tx.edges.every(id => !g.world.net.edges.has(id)), 'rollback removes all added connectors only');
  check(!!g.world.trees[tree] && [...g.world.h].every((h, i) => h === heights[i]), 'failed connectors restore local trees and graded terrain');
  build(g, free(g, 30, 83), free(g, 220, 83), railOpts(1), 'second owned outer rail');
  const second = { ...link, ax: 150, az: 81.5, bx: 170, bz: 83 };
  const pair = buildThroughConnections(g, [link, second], s => {
    const A = g.world.net.nearestEdge(s.ax, s.az, .2, 'rail'), B = g.world.net.nearestEdge(s.bx, s.bz, .2, 'rail');
    return A && B ? planConnection(g, A.edge.id, A.s, B.edge.id, B.s, 1) : null;
  });
  check(!pair.error && pair.edges.length >= 2 && pair.cost > 0, 'both native local connectors build after resolving the first split');
  const usage = JSON.stringify(g.access), paid = g.company(1).economy.money;
  pair.rollback();
  check(pair.edges.every(id => !g.world.net.edges.has(id)) && g.company(1).economy.money > paid && JSON.stringify(g.access) === usage,
    'successful two-connector ledger also rolls back only its paid connectors');
}

// Actual retained curved platform, split into fragments, continuing to a native straight terminus.
{
  const g = flatGame(256); g.addAICompany({ startMoney: 1e9 }); g.addAICompany({ startMoney: 1e9 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  const net = g.world.net, base = { x0: 70, z0: 70, x1: 70, z1: 100, x2: 100, z2: 130, x3: 130, z3: 130 }, rails = [];
  for (let i = 0; i < 2; i++) {
    const c = bezOffset(base, i * .5), ad = bezDeriv(c, 0), bd = bezDeriv(c, 1);
    const a = net.addNode('rail', c.x0, 3.1, c.z0, ad.x, ad.z, 2), b = net.addNode('rail', c.x3, 3.1, c.z3, bd.x, bd.z, 2);
    rails.push(net.addEdge('rail', a.id, b.id, c, new Float32Array(300).fill(3.1), [], 'standard', 2));
  }
  const ra = net.addNode('road', 70, 3, 115, 0, 0, -1), rb = net.addNode('road', 104, 3, 144, 0, 0, -1);
  net.addEdge('road', ra.id, rb.id, bezLine(ra.x, ra.z, rb.x, rb.z), new Float32Array(100).fill(3), [], 'street', -1);
  const p = planStationOnTrack(g, rails[0].id, rails[0].len / 2, { length: 20, tracks: 2, reuseTrack: true, style: 'modern' }, 2);
  const r = commitStationOnTrack(g, p), curve = g.stations.get(r.station), end = station(g, 170, 129.75, Math.PI / 2, 12, 2, 1);
  check(!r.error && !!curve?.rail?.alignment && !!end, 'real curved foreign platform and native terminus constructed');
  if (curve?.rail && end) {
    for (let i = 0; i < 2; i++) {
      const a = net.nodes.get(rails[i].b)!, b = net.nodes.get(endNode(g, end, i, false))!;
      net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(100).fill(3.1), [], 'standard', 2);
    }
    for (const id of [...curve.rail.edges]) net.splitEdge(id, 1);
    const before = json(g), proof = throughRouteProof(g, [curve.id, end.id], 1, cars());
    check(!!proof && proof.legs.some(l => l.cap < 150), 'curved fragmented platform proves actual body routing and curve speed limits');
    check(json(g) === before, 'curved native proof preserves saved state exactly');
    g.setAccessPolicy(2, 'auto-reject');
    check(!throughRouteProof(g, [curve.id, end.id], 1, cars()), 'curved native proof respects foreign access denial');
  }
}
console.log('bounded through work', networkProfile.tasks.through);
done();
