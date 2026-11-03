// Stop insertion preserves a short-turn's physical termini on a directional shared railway.
import { Game } from '../src/game/game';
import type { Line } from '../src/game/lines';
import { linePatterns, patternStops, stopsAt, addPattern, setVehiclePattern } from '../src/game/patterns';
import { platformChoices, platformPreference, setPlatformPreference } from '../src/game/rail-platforms';
import { serialize, deserialize } from '../src/game/save';
import { Train, deadlockCycles } from '../src/game/train';
import { check, fails, checkReservations, depotBehind } from './lib';
import { endNode, nodeSnap, railOpts, loco } from './stationlib';
import { planEdge, commitProposal } from '../src/game/construction';
import { bulldoze, terraformBrush } from '../src/game/build-ops';
import { brush } from '../src/game/terraform';
import { finishDoubleTrack } from '../src/game/trackops';
import { setSignal, SIGNAL_COST } from '../src/game/signals';
import { runNetworkTask, routeBetween } from '../src/game/ai-network';
import { buildSideDepot, sidingSpots } from '../src/game/depot-sites';
import { openingRailCall } from '../src/game/ai';

function remap(old: number[], flags: boolean[], next: number[], expected: boolean[], label: string, loop?: boolean) {
  const p = { id: 1, name: 'Test service', kind: 'local' as const, ids: [...old], stops: [...flags] };
  const l = { stops: next, patterns: [p], loop } as Line;
  linePatterns(l);
  check(JSON.stringify(p.stops) === JSON.stringify(expected), label);
  const state = JSON.stringify(l);
  linePatterns(l); patternStops(l, 1); next.forEach((_, i) => stopsAt(l, 1, i));
  check(JSON.stringify(l) === state, label + ': repeated reads are pure after explicit alignment');
}

remap([6, 5, 7, 5], [true, true, false, true], [6, 5, 10, 7, 10, 5],
  [true, true, false, false, false, true], 'new call beyond the short-turn terminus is excluded in both directions');
remap([1, 2, 3, 2], [true, true, false, true], [1, 4, 2, 3, 2, 4],
  [true, true, true, false, true, true], 'a new stop inside the short-turn span is served in both directions');
remap([1, 2, 3, 4, 3, 2], [true, false, true, false, true, false], [1, 5, 2, 3, 4, 3, 2, 5],
  [true, true, false, true, false, true, false, true], 'express/rapid skips do not exclude genuinely interior new stops');
remap([1, 2, 3, 2], [true, true, false, true], [0, 1, 2, 3, 2, 1],
  [false, true, true, false, true, true], 'extending the parent route does not extend a short-turn beyond its other terminus');
remap([1, 2, 3, 2], [true, true, true, true], [1, 2, 3, 4, 3, 2],
  [true, true, true, true, true, true], 'all-stop services still extend normally');
remap([1, 2, 3], [true, true, false], [1, 2, 4, 3],
  [true, true, true, false], 'loop insertions retain the existing default', true);
remap([1, 2, 3, 2], [true, true, false, false], [1, 4, 2, 3, 2, 4],
  [true, true, true, false, false, true], 'asymmetric existing occurrence flags remain distinct');
remap([1, 2, 1, 3], [true, false, false, true], [1, 4, 2, 1, 3],
  [true, true, false, false, true], 'ambiguous repeated physical routes retain prior insertion and occurrence behavior', false);
remap([1, 2, 3], [false, true, true], [1, 2, 4, 3],
  [false, true, true, true], 'explicit non-loop routes use their existing served physical span', false);
remap([1, 2, 3], [true, false, true], [1, 4, 2, 3],
  [true, true, false, true], 'full-span rapid insertions retain their old default', false);

const g = Game.create({ size: 512, seed: 5, towns: 12, hilliness: 'hilly', water: 'medium', startYear: 1985,
  aiConfigs: [{ activeness: 0.25, risk: 0.1 }, { activeness: 2, risk: 0.9, startMoney: 8_000_000 },
    { focus: { rail: 3, road: 0.2, tram: 0.2 } }, { focus: { rail: 0, road: 3, tram: 0 } },
    { focus: { rail: 0, road: 0.3, tram: 3 } }] });
g.aiAcquisitions = false;
// This is an explicit passenger charter, independent of which investment the rivals rank first.
// Keep the generated world/configuration and pay native demolition, earthworks, rail, access and stock costs.
// A prepared NE/SW corridor through Shelworth provides a gentle curved infill site beyond the short-turn.
g.aiEnabled = false;
function native(ok: unknown, label: string): asserts ok { check(ok, label); if (!ok) throw new Error(label); }
function fund(owner: number, cost: number) {
  const e = g.company(owner).economy;
  while (e.money < cost + 300_000 && e.borrow()) { /* ordinary bank steps and credit ceiling */ }
  native(e.money >= cost, `native charter ${owner} can fund ${Math.round(cost)}`);
}
function clear(x: number, z: number, radius: number) {
  const quote = bulldoze(g, x - radius, z - radius, x + radius, z + radius, 2, true);
  native(!quote.error, `native charter clearance: ${quote.error ?? 'ok'}`);
  fund(2, quote.cost);
  const result = bulldoze(g, x - radius, z - radius, x + radius, z + radius, 2, false);
  native(!result.error, `native charter paid clearance: ${result.error ?? 'ok'}`);
}
const town = g.towns.list.find(t => t.name === 'Shelworth')!;
const angle = Math.PI / 4, ux = Math.sin(angle), uz = Math.cos(angle), rx = uz, rz = -ux;
const at = (u: number, v: number) => ({ x: town.x + ux * u + rx * v, z: town.z + uz * u + rz * v });
const sites = [[-35, -4], [5, -4], [110, 4]].map(([u, v]) => at(u, v));
for (const p of sites) clear(p.x, p.z, 6);
for (let u = -42; u <= 117; u += 4) {
  const p = at(u, u <= 5 ? -4 : -4 + 8 * (u - 5) / 105);
  clear(p.x, p.z, 5.5);
}
for (let u = -42; u <= 117; u += 2) {
  const p = at(u, u <= 5 ? -4 : -4 + 8 * (u - 5) / 105);
  const cost = Math.round(brush(g.world, p.x, p.z, 5, 'level', 0.25, 5.5, true) * 1500);
  fund(2, cost);
  const result = terraformBrush(g, p.x, p.z, 5, 'level', 5.5, 2);
  native(!result.error, `native charter earthworks: ${result.error ?? 'ok'}`);
}
const stations = sites.map((p, index) => {
  // Face the outer station's hall towards its populated neighbourhood, keeping real local demand.
  const buildingSide: 1 | -1 = index === 0 ? 1 : -1;
  let plan = g.stations.planRail(p.x, p.z, angle, 10, 2, 2, { level: 'ground', fixedY: 5.6, style: 'modern', buildingSide });
  native(plan.ok, `native charter station: ${plan.error ?? 'ok'}`);
  if (!plan.roadAccess) {
    const f = plan.forecourt!, b = plan.building, outward = { x: f.x - b.x, z: f.z - b.z };
    const candidates = [...g.world.net.edges.values()].filter(e => e.kind === 'road' && e.depot < 0)
      .flatMap(e => { const hit = g.world.net.nearestEdge(f.x, f.z, 40, 'road', q => q.id === e.id); return hit ? [hit] : []; })
      .sort((a, b) => a.d - b.d);
    let connected = false;
    for (const hit of candidates) {
      const end = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(hit.edge, hit.s, end);
      if ((end.x - f.x) * outward.x + (end.z - f.z) * outward.z <= 0) continue;
      const target = hit.s < 0.8 || hit.s > hit.edge.len - 0.8
        ? nodeSnap(g, hit.s < 0.8 ? hit.edge.a : hit.edge.b, 'road')
        : { kind: 'edge' as const, ...end, edge: hit.edge.id, s: hit.s };
      const street = planEdge(g, { kind: 'free', ...f, y: g.world.heightAt(f.x, f.z) }, target,
        { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: 2 });
      if (!street.ok) continue;
      fund(2, street.cost);
      native(!commitProposal(g, street), 'native charter pays its forecourt access street');
      connected = true; break;
    }
    native(connected, 'native charter can connect its forecourt to a generated street');
    plan = g.stations.planRail(p.x, p.z, angle, 10, 2, 2, { level: 'ground', fixedY: 5.6, style: 'modern', buildingSide });
    native(plan.ok && plan.roadAccess, `native charter station/access geometry remains valid: ${plan.error ?? plan.warnings.join(', ')}`);
  }
  fund(2, plan.cost);
  const id = g.stations.nextId, error = g.stations.commitRail(plan, 2);
  native(!error, `native charter paid station: ${error ?? 'ok'}`);
  return g.stations.get(id)!;
});
const firstRail = g.world.net.nextEdge;
for (let leg = 0; leg < 2; leg++) for (let track = 0; track < 2; track++) {
  const plan = planEdge(g, nodeSnap(g, endNode(g, stations[leg], track, true), 'rail'),
    nodeSnap(g, endNode(g, stations[leg + 1], track, false), 'rail'), railOpts(2, 1, { designGrade: 0.01 }));
  native(plan.ok, `native charter running rail: ${plan.errors.join(', ')}`);
  fund(2, plan.cost);
  const error = commitProposal(g, plan);
  native(!error, `native charter paid rail: ${error ?? 'ok'}`);
}
const rails = [...g.world.net.edges.values()].filter(e => e.id >= firstRail && e.kind === 'rail' && e.station < 0).map(e => e.id);
fund(2, 2_000_000);
const directional = finishDoubleTrack(g, rails, 2, { turnbackStations: [stations[1].id] });
native(!directional.error && directional.signals > 0 && directional.crossovers > 0, 'native charter has directional tracks and real turnback crossovers');
const line = g.lines.create('rail', 2);
line.stops = [stations[0].id, stations[1].id, stations[2].id, stations[1].id];
g.lines.rebuild();
let pid = -1;
for (const owner of [2, 3]) {
  if (owner === 3) {
    g.requestAccess(3, 2);
    g.lines.invite(line.id, 3);
    native(g.lines.join(line.id, 3) === null && g.canUse(3, 2), 'native foreign charter has invitation and physical access');
  }
  fund(owner, 2_500_000);
  const route = routeBetween(g, owner === 3 ? stations[2].id : stations[0].id, stations[1].id, 2)!;
  native(!!route, 'native charter has a physical depot corridor');
  let depot = -1;
  for (const spot of sidingSpots(g, route, stations[0].x, stations[0].z, 2, Infinity, 16, ['ground', 'bridge', 'tunnel']).slice(0, 30)) {
    depot = buildSideDepot(g, spot.id, spot.s, owner);
    if (depot >= 0) break;
  }
  if (depot < 0) depot = depotBehind(g, owner === 3 ? stations[1] : stations[0], owner === 3 ? stations[0] : stations[1], owner);
  native(depot >= 0, 'native charter pays for its own reachable depot');
  const train = g.vehicles.buyTrain(depot, loco(), line.id);
  native(train instanceof Train, `native charter purchases passenger stock: ${typeof train === 'string' ? train : 'ok'}`);
  if (owner === 3) {
    const pattern = addPattern(g, line.id, 'local', [true, true, false, true], 'Partner short-turn');
    native(!!pattern, 'native charter creates its physical short-turn pattern');
    pid = pattern.id;
    native(setVehiclePattern(g, train.id, pid) === null, 'native foreign stock takes the short-turn');
  }
  const call = openingRailCall(g, train);
  native(call >= 0, 'native charter depot can reach and depart its actual service calls');
  train.stopIndex = call;
}
// Real block-signal construction makes the running curve segmented before station insertion.
const points: { x: number; z: number }[] = [];
for (const [a, b] of [[stations[1].id, stations[2].id], [stations[2].id, stations[1].id]]) {
  for (const id of routeBetween(g, a, b, 2) ?? []) {
    const e = g.world.net.edges.get(id)!;
    if (e.station >= 0 || e.depot >= 0 || e.len < 14) continue;
    for (let s = 2; s < e.len - 2; s += 3) { const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, s, p); points.push({ x: p.x, z: p.z }); }
  }
}
fund(2, 1_000_000 + points.length * SIGNAL_COST);
for (const p of points) {
  const hit = g.world.net.nearestEdge(p.x, p.z, 0.1, 'rail', e => e.owner === 2 && e.station < 0 && e.depot < 0);
  native(!!hit && setSignal(g, hit.edge.id, hit.s, 'twoway', false, 2, { signalKind: 'block' }) === null, 'native charter adds paid physical block sections');
}
const beforeStops = [...line.stops];
let manual: { station: number; group: number } | undefined;
const choice = platformPreference(line, pid, 3);
check(!!choice && setPlatformPreference(g, line, pid, 3, choice.group) === null, 'native existing turnback accepts its current valid manual platform');
if (choice) manual = { station: choice.station, group: choice.group };
native(runNetworkTask(g.aiOf(2)!, 'insert'), 'native funded insertion task starts');
console.log('native charter infill', JSON.stringify({ cash: g.company(2).economy.money, loan: g.company(2).economy.loan, log: g.aiOf(2)!.log }));
const inserted = line.stops.find(s => !beforeStops.includes(s)) ?? -1, insertionDay = g.day;
for (let tick = 0; tick < 30 * g.ticksPerDay && g.vehicles.trains().some(t => t.owner === 3 && !t.onMap); tick++) g.stepTick();
check(!!line && inserted >= 0, 'native funded generated-world planner inserts an actual station beyond the existing short-turn');
if (line && inserted >= 0) {
  const l = line, st = g.stations.get(inserted)!;
  const p = linePatterns(l).find(p => p.id === pid)!;
  console.log('native insertion', JSON.stringify({ day: insertionDay, before: beforeStops, after: l.stops, flags: p.stops,
    station: st.id, native: st.rail?.native, groups: g.stations.railTrackGroups(st).map(q => ({ id: q.id, length: q.length, fragments: q.steps.length })) }));
  check(st.owner === 2 && st.rail?.native && !!st.rail.alignment && g.stations.railTrackGroups(st).some(q => q.steps.length > 1),
    'inserted facility is a real curved segmented station on the rival directional railway');
  check(g.company(2).economy.yearTotals.reduce((n, y) => n + y.v.construction, g.company(2).economy.thisYear.construction) < 0,
    'the native operator paid actual construction costs');
  check(JSON.stringify(p.stops) === '[true,true,false,false,false,true]', 'native partner short-turn retains its old physical terminus');
  check(linePatterns(l).find(p => p.id === 0)!.stops.every(Boolean), 'the full-through service still serves the new station');
  check(!l.platforms?.some(q => q.pattern === pid && q.station === inserted), 'short-turn has no phantom platform call at the excluded new facility');
  const savedManual = l.platforms?.find(q => q.pattern === pid && q.station === manual?.station && q.occurrence === 1);
  check(!!savedManual?.manual && savedManual.group === manual?.group, 'manual platform preference follows its repeated occurrence across insertion');
  check(l.platforms?.filter(q => !q.manual).every(q => platformChoices(g, l, q.pattern, q.stop).some(c => c.id === q.group)),
    'Auto allocations remain physically valid for the actual stopping patterns');
  check(g.ais.every(a => !(a as any).project && !a.busy), 'native charter construction is complete before the train replay checkpoint');
  const stock = g.vehicles.trains().filter(v => v.owner === 3 && v.lineId === l.id && v.pattern === pid);
  check(stock.length > 0 && stock.every(v => v.onMap), 'actual foreign short-turn trains operate on the joint route');
  const delivered0 = stock.reduce((n, v) => n + v.delivered, 0), visited = new Set<number>(), calls = new Map<number, number>();
  let noRoute = 0, longestNoRoute = 0, run = 0, cycles = 0;
  const prior = new Map<number, string>();
  for (let i = 0; i < 360 * g.ticksPerDay; i++) {
    g.stepTick();
    const lost = stock.some(v => v.state === 'noroute'); noRoute += Number(lost); run = lost ? run + 1 : 0; longestNoRoute = Math.max(longestNoRoute, run);
    for (const v of stock) {
      if (v.state === 'loading' && prior.get(v.id) !== 'loading') { visited.add(v.routeTarget); calls.set(v.id, (calls.get(v.id) ?? 0) + 1); }
      prior.set(v.id, v.state);
    }
    if (g.tick % g.ticksPerDay === 0) cycles += deadlockCycles(g, 0).length;
  }
  const delivered1 = stock.reduce((n, v) => n + v.delivered, 0);
  console.log('native short-turn service', JSON.stringify({ catchments: stations.map(s => s.catchPop), fleet: stock.map(v => v.id), delivered: [delivered0, delivered1],
    visited: [...visited], calls: [...calls], noRouteTicks: noRoute, longestNoRouteTicks: longestNoRoute, cycles }));
  check(delivered1 > delivered0 && visited.size >= 2 && !visited.has(inserted), 'real native foreign trains deliver at successive original stops and do not visit the excluded facility');
  check(noRoute === 0 && cycles === 0 && checkReservations(g).length === 0, 'directional short-turn service has no NOROUTE, mutual cycle or reservation error');
  const snap = JSON.stringify(serialize(g));
  for (let i = 0; i < 5; i++) { linePatterns(l); l.stops.forEach((_, stop) => { platformPreference(l, pid, stop); platformChoices(g, l, pid, stop); }); }
  check(JSON.stringify(serialize(g)) === snap, 'pattern/platform/UI queries preserve every serialized decision');
  const twin = deserialize(JSON.parse(snap));
  let exact = JSON.stringify(serialize(twin)) === snap;
  for (let i = 0; i < 640; i++) { g.stepTick(); twin.stepTick(); exact &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(twin)); }
  check(exact && checkReservations(twin).length === 0, 'native short-turn and full-through stock replay every complete serialized tick for 640 fixed ticks');
}
if (fails.length) { console.log(`\n${fails.length} FAILURES`); process.exit(1); }
console.log('\nALL SHORT-TURN INSERTION CHECKS PASSED');
