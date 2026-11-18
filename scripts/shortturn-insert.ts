// Stop insertion preserves a short-turn's physical termini on a directional shared railway.
import { Game } from '../src/game/game';
import { bezLine } from '../src/game/geom';
import type { Line } from '../src/game/lines';
import type { Town } from '../src/game/towns';
import { linePatterns, patternStops, stopsAt } from '../src/game/patterns';
import { platformChoices, platformPreference, setPlatformPreference } from '../src/game/rail-platforms';
import { serialize, deserialize } from '../src/game/save';
import { Train, deadlockCycles } from '../src/game/train';
import { check, fails, checkReservations } from './lib';

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

function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
function addTown(g: Game, name: string, x: number, z: number, pop: number, width: number, height: number): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0,
    passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) {
    if (zs[i - 1] < z && zs[i] > z) continue;
    road(g, rx, zs[i - 1], rx, zs[i]);
  }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) {
    if (Math.abs(rz + 1.1 - z) < 4) continue;
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  return t;
}
const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'none', startYear: 1995 });
g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
addTown(g, 'Carlhurst', 240, 320, 5200, 32, 32);
addTown(g, 'Glencliff', 100, 320, 5000, 32, 32);
addTown(g, 'Chalport', 388, 368, 5400, 112, 56);
addTown(g, 'Westmoor', 60, 40, 6000, 64, 48);
addTown(g, 'Northport', 220, 40, 5800, 64, 48);
g.player.hqTown = 3; g.demand.rebuild();
g.addAICompany({ activeness: 0.5, risk: 0.8, startMoney: 20_000_000, focus: { rail: 4, road: 0, tram: 0 } });
g.addAICompany({ activeness: 3.0, risk: 1.0, startMoney: 35_000_000, accessPolicy: 'open', focus: { rail: 4, road: 0, tram: 0 } });
g.addAICompany({ activeness: 1.5, risk: 0.8, startMoney: 12_000_000, accessPolicy: 'open', focus: { rail: 4, road: 0, tram: 0 } });
g.company(1).hqTown = 3; g.company(2).hqTown = 0; g.company(3).hqTown = 1;
g.ais[0].state.cooldown = 44; g.ais[1].state.cooldown = 0; g.ais[2].state.cooldown = 32;
let line: Line | undefined, beforeStops: number[] = [], pid = -1, manual: { station: number; group: number } | undefined;
let inserted = -1, insertionDay = -1;
while (g.day < 500) {
  g.stepTick();
  const train = g.vehicles.trains().find(v => v.owner === 3 && v.line?.owner === 2);
  const l = train?.line;
  if (!line && l && l.stops.length === 4 && l.patterns?.some(p => JSON.stringify(p.stops) === '[true,true,false,true]')) {
    line = l; beforeStops = [...l.stops]; pid = l.patterns.find(p => JSON.stringify(p.stops) === '[true,true,false,true]')!.id;
    const choice = platformPreference(l, pid, 3);
    check(!!choice && setPlatformPreference(g, l, pid, 3, choice.group) === null, 'native existing turnback accepts its current valid manual platform');
    if (choice) manual = { station: choice.station, group: choice.group };
  }
  if (line && line.stops.length === 6) {
    inserted = line.stops.find(s => !beforeStops.includes(s)) ?? -1;
    insertionDay = g.day; break;
  }
}
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
  // (2.10+ joinLines places Local (through) at linePatterns(l)[0] while preserving keep's original pattern id 0)
  check(linePatterns(l)[0]!.stops.every(Boolean), 'the full-through service still serves the new station');
  check(!l.platforms?.some(q => q.pattern === pid && q.station === inserted), 'short-turn has no phantom platform call at the excluded new facility');
  const savedManual = l.platforms?.find(q => q.pattern === pid && q.station === manual?.station && q.occurrence === 1);
  check(!!savedManual?.manual && savedManual.group === manual?.group, 'manual platform preference follows its repeated occurrence across insertion');
  check(l.platforms?.filter(q => !q.manual).every(q => platformChoices(g, l, q.pattern, q.stop).some(c => c.id === q.group)),
    'Auto allocations remain physically valid for the actual stopping patterns');
  // Drain the projects already running without allowing a new selection. The native urban survey can
  // exhaust 1,500 sites after retrying its selected layout: here it retires on day 622, 373 days after
  // insertion. Allow 480 setup days; the operating and replay windows below remain 360 days / 640 ticks.
  const draining = new Map(g.ais.map(ai => [ai.companyId, (ai as any).project]));
  const nativeSave = JSON.stringify(serialize(g));
  const inhibitSelection = () => { for (const ai of g.ais) ai.state.cooldown = Math.max(ai.state.cooldown, 18); };
  inhibitSelection();
  const setup = serialize(g), original = JSON.parse(nativeSave);
  setup.ais.forEach((ai: any, i: number) => { ai.state.cooldown = original.ais[i].state.cooldown; });
  check(JSON.stringify(setup) === nativeSave, 'drain setup changes only saved controller cooldowns');
  let originalProjectsOnly = true;
  while (g.day < insertionDay + 480 && g.ais.some(a => (a as any).project)) {
    inhibitSelection();
    g.stepTick();
    originalProjectsOnly &&= g.ais.every(ai => !(ai as any).project || (ai as any).project === draining.get(ai.companyId));
  }
  check(originalProjectsOnly, 'drain advances only the original native projects without selecting replacements');
  check(!g.ais.some(a => (a as any).project || a.busy), 'unrelated construction completes before the train replay checkpoint');
  console.log('native construction drain', JSON.stringify({ day: g.day, elapsedDays: g.day - insertionDay, originalProjectsOnly }));
  g.aiEnabled = false;
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
  console.log('native short-turn service', JSON.stringify({ fleet: stock.map(v => v.id), delivered: [delivered0, delivered1],
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
