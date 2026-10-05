// Stop insertion preserves a short-turn's physical termini on a directional shared railway.
import { Game } from '../src/game/game';
import type { Line } from '../src/game/lines';
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

const g = Game.create({ size: 512, seed: 5, towns: 12, hilliness: 'hilly', water: 'medium', startYear: 1985,
  aiConfigs: [{ activeness: 0.25, risk: 0.1 }, { activeness: 2, risk: 0.9, startMoney: 8_000_000 },
    { focus: { rail: 3, road: 0.2, tram: 0.2 } }, { focus: { rail: 0, road: 3, tram: 0 } },
    { focus: { rail: 0, road: 0.3, tram: 3 } }] });
g.aiAcquisitions = false;
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
  check(linePatterns(l).find(p => p.id === 0)!.stops.every(Boolean), 'the full-through service still serves the new station');
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
