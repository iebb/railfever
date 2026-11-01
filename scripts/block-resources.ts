// Geometry-only degree-two splits preserve native blocks, occupation and paid-service prices.
import assert from 'node:assert/strict';
import { flat, newTown, district, cityLine } from './linegrow-fixtures';
import { serialize, deserialize } from '../src/game/save';
import { sharedCapacityPlan, marginalTrainInvestment } from '../src/game/ai-capacity';
import { blockEdges, Train } from '../src/game/train';
import { setSignal } from '../src/game/signals';
import { RAIL } from '../src/game/constants';
import { checkReservations } from './lib';
import type { Game } from '../src/game/game';

let checks = 0;
function check(value: unknown, message: string): asserts value { assert(value, message); checks++; }
const saved = (g: Game) => JSON.stringify(serialize(g));
const cold = (g: Game) => deserialize(JSON.parse(saved(g)));
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b));
const { g, me } = flat(); g.vehicles.ambientEnabled = false;
const town = newTown(g, 'Block City', 220, 256); district(g, town, 80, 360, 256, 32, 12000);
const f = cityLine(g, me, [100, 220, 340], 256, 'west', 'tail', 6), lineId = f.line.id, net = g.world.net;
// Keep native station starters / junction protection; establish two equally located paid block signals on
// both lanes of a clear central span, rather than depending on an incidental automatic-signal offset.
for (const n of [...net.nodes.values()]) if (n.signal && n.edges.length === 2
  && n.edges.every(id => { const e = net.edges.get(id)!; return e.station < 0 && e.depot < 0; })) {
  const e = net.edges.get(n.edges[0])!;
  check(!setSignal(g, e.id, e.a === n.id ? 0 : e.len, 'none', true, me), 'native plain-line signal removal');
}
for (const x of [140, 180]) for (const side of [-1, 1]) {
  const hit = net.nearestEdge(x, 256 + side * RAIL.spacing / 2, .2, 'rail', e => e.station < 0 && e.depot < 0)!;
  check(hit, 'paid running lane reaches the block boundary');
  check(!setSignal(g, hit.edge.id, hit.s, 'twoway', true, me, { signalKind: 'block' }), 'native matched block signal purchase');
}
// Actual lots beside the built access streets give native walking and fares without multiplying demand.
for (const st of f.sts) {
  const fc = g.stations.forecourt(st)!, hit = net.nearestEdge(fc.x, fc.z, 3, 'road')!, p = { x: 0, y: 0, z: 0 };
  net.pointAt(hit.edge, hit.s, p);
  const b = g.world.addBuilding({ townId: town.id, x: p.x, z: p.z + 1.1, angle: 0, w: .6, d: .6, type: 4,
    floors: 8, pop: 120, seed: 10000 + town.buildings.size, y: 4, built: 0 });
  town.buildings.add(b.id); town.pop += b.pop;
}
g.demand.rebuild(); g.stations.refreshAccess(true); g.lines.flushCatchment();
const laneIds = [-1, 1].map(side => net.nearestEdge(160, 256 + side * RAIL.spacing / 2, .2, 'rail')!.edge.id);
const core = sharedCapacityPlan(g, f.line).resources.find(r => r.kind === 'block' && laneIds.every(id => r.edges.includes(id)) && Math.abs(r.length - 40) < 1e-4);
check(new Set(laneIds).size === 2 && core?.available === 2, 'two native forty-unit running lanes bounded by real signals');
function quote(world: Game) {
  const line = world.lines.get(lineId)!, train = world.vehicles.get(line.vehicles[0]) as Train;
  const plan = sharedCapacityPlan(world, line), bid = marginalTrainInvestment(world, line, me, train.madeUp, train.pattern);
  return { revenue: plan.revenue, limit: plan.limit, physical: plan.physical, bid,
    allocations: plan.allocations.map(a => ({ ...a, traffic: a.traffic })),
    blocks: plan.resources.filter(r => r.kind === 'block').map(r => ({ length: r.length, available: r.available })).sort((a, b) => a.length - b.length || a.available - b.available),
    platforms: plan.resources.filter(r => r.kind === 'platform').map(r => ({ edges: r.edges, available: r.available })) };
}
const initial = quote(g), baseSave = saved(g);
check(initial.revenue > 0 && f.line.vehicles.length === 6 && g.company(me).economy.money < 150_000_000,
  'positive native fare quote uses six paid trains and paid track, stations, depot and signals');
function sameQuote(a: ReturnType<typeof quote>, b: ReturnType<typeof quote>) {
  check(near(a.revenue, b.revenue) && near(a.bid.pooled, b.bid.pooled) && near(a.bid.investor, b.bid.investor), 'neutral split preserves complete pooled and investor prices');
  check(a.limit === b.limit && a.physical === b.physical && JSON.stringify(a.platforms) === JSON.stringify(b.platforms), 'neutral split preserves physical slots, allocations and facility resources');
  check(a.blocks.length === b.blocks.length && a.blocks.every((r, i) => near(r.length, b.blocks[i].length) && r.available === b.blocks[i].available), 'neutral split preserves every physical block span and paired capacity');
  check(a.allocations.length === b.allocations.length && a.allocations.every((x, i) => {
    const y = b.allocations[i]; return x.line === y.line && x.owner === y.owner && x.pattern === y.pattern && x.trains === y.trains && near(x.traffic, y.traffic);
  }), 'neutral split preserves native operating-agreement allocation');
}
let split: Game | undefined;
for (const ids of [laneIds.slice(0, 1), laneIds, [...laneIds].reverse()]) {
  const world = deserialize(JSON.parse(baseSave)), wn = world.world.net, replacements = new Map<number, number>();
  for (const id of ids) {
    const e = wn.edges.get(id)!, old = blockEdges(g, id, net.edges.get(id)!.a).slice().sort((a, b) => a - b);
    const cut = wn.splitEdge(id, e.len / 2)!; check(cut && cut.node.signal === 0 && cut.node.edges.length === 2, 'native split adds only an unsignalled degree-two vertex');
    replacements.set(cut.e1.id, id); replacements.set(cut.e2.id, id);
    const normal = [...new Set(blockEdges(world, cut.e1.id, cut.e1.a).map(eid => replacements.get(eid) ?? eid))].sort((a, b) => a - b);
    check(JSON.stringify(old) === JSON.stringify(normal), 'native signal-guarded block is identical after mapping split fragments');
  }
  sameQuote(initial, quote(world)); const snapshot = saved(world), loaded = cold(world);
  quote(world); check(saved(world) === snapshot, 'warm quotes preserve complete native state');
  check(JSON.stringify(quote(loaded)) === JSON.stringify(quote(world)) && saved(loaded) === snapshot, 'cold resource reconstruction preserves exact quotes and save state');
  split = world;
}
// Matched real signals change the physical reservation boundaries and stop the same chain joining.
const signalled = deserialize(JSON.parse(baseSave)), sn = signalled.world.net, se = sn.edges.get(laneIds[0])!;
const cut = sn.splitEdge(se.id, se.len / 2)!, cash = signalled.company(me).economy.money;
check(!setSignal(signalled, cut.e1.id, cut.e1.len, 'twoway', true, me, { signalKind: 'block' })
  && signalled.company(me).economy.money < cash, 'new reservation boundary is a real paid signal');
const opposite = sn.nearestEdge(cut.node.x, 256 + RAIL.spacing / 2, .2, 'rail', e => ![cut.e1.id, cut.e2.id].includes(e.id))!;
check(opposite && !setSignal(signalled, opposite.edge.id, opposite.s, 'twoway', true, me, { signalKind: 'block' }), 'opposite lane buys its matched native signal');
const changed = sharedCapacityPlan(signalled, signalled.lines.get(lineId)!);
check(!changed.resources.some(r => r.kind === 'block' && r.edges.includes(cut.e1.id) && r.edges.includes(cut.e2.id)), 'real matched signal boundary is never joined across');
check(blockEdges(signalled, cut.e1.id, cut.e1.a).length < blockEdges(g, se.id, se.a).length + 1, 'native reservation walk also stops at the new signal');
check(changed.resources.filter(r => r.edges.includes(cut.e1.id) || r.edges.includes(cut.e2.id)).every(r => r.available === 2), 'signal splits retain the two physical lanes without manufacturing capacity');
// A divergent legacy profile with matching endpoints and midpoint must not become one paired block.
// This negative save-geometry control is never operated or accepted as new construction.
const divergent = deserialize(JSON.parse(baseSave)), de = divergent.world.net.edges.get(laneIds[0])!;
check(de.prof.length > 8, 'native running edge has an interior profile sample');
de.prof[Math.floor(de.prof.length / 4)] += .5; divergent.world.net.touchEdge(de); divergent.onNetworkChanged();
check(!sharedCapacityPlan(divergent, divergent.lines.get(lineId)!).resources.some(r => r.kind === 'block' && core!.edges.every(id => r.edges.includes(id))),
  'whole-profile validation rejects a separated interior despite matching span endpoints');
const replay = cold(split!); let exact = true;
for (let tick = 0; tick < 128; tick++) { split!.stepTick(); replay.stepTick(); exact &&= saved(split!) === saved(replay); }
check(exact && !checkReservations(split!).length && !checkReservations(replay).length, 'native paid traffic retains exact replay and lawful reservations after neutral splits');
console.log(`PASS ${checks} native block-resource checks`, JSON.stringify({ revenue: initial.revenue, bid: initial.bid, blocks: initial.blocks.length, replayTicks: 128 }));
