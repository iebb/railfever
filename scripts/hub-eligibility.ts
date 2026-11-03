// Necessary local hub fit, never a completed works/ROI/admission proof. Bundle as hub-eligibility.mjs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Game } from '../src/game/game';
import { aiPlatformLength, openingCoaches, pickTrain } from '../src/game/ai';
import type { Station } from '../src/game/stations';
import type { Town } from '../src/game/towns';
import { Train, consistRule, ruleAllows } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { outAndBack } from '../src/game/lines';
import { platformChoicesForStock } from '../src/game/rail-platforms';
import { planEdge, commitProposal } from '../src/game/construction';
import { station, depotFor } from './stationlib';
import { connectDouble } from './lib';

const bytes = (g: Game) => JSON.stringify(serialize(g));
const length = (cars: NonNullable<ReturnType<typeof pickTrain>>) => cars.reduce((n, m) => n + m.length + .1, 0);
const stock = { platform: 10, coaches: 2 };
let checks = 0;
function check(value: unknown, message: string): asserts value { assert(value, message); checks++; }
function pure<T>(g: Game, read: () => T): T {
  const before = bytes(g), result = read(), after = bytes(g);
  if (after !== before) {
    const changed: string[] = [];
    const diff = (a: any, b: any, path = '') => {
      if (changed.length >= 12 || Object.is(a, b)) return;
      if (a && b && typeof a === 'object' && typeof b === 'object')
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[key], b[key], `${path}/${key}`);
      else changed.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    };
    diff(JSON.parse(before), JSON.parse(after));
    throw new Error(`fit/discovery reads changed saved state: ${changed.join('; ')}`);
  }
  checks++; return result;
}
function town(g: Game, name: string, x: number, z: number): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop: 3000, radius: 25, buildings: new Set(),
    nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t); return t;
}
function paidStation(g: Game, x: number, z: number, L: number, owner: number, light = false, street = true) {
  const money = g.company(owner).economy.money;
  const st = station(g, x, z, Math.PI / 2, L, 2, owner,
    { style: 'none', trackType: light ? 'lightrail' : 'standard', mode: light ? 'lightrail' : 'mainline' });
  check(st?.rail, `native paid station ${x}/${z}/${L} builds`);
  check(g.company(owner).economy.money < money, 'native station pays ordinary construction capital');
  g.stations.refreshAccess();
  if (street && !g.stations.hasAccess(st)) {
    const f = g.stations.forecourt(st)!;
    // Native roadContact requires at least20u reachable street; an isolated6u spur cannot grant access.
    const p = planEdge(g, { kind: 'free', x: f.x - 12, z: f.z, y: 4 }, { kind: 'free', x: f.x + 12, z: f.z, y: 4 },
      { kind: 'road', type: 'street', tracks: 1, owner, crossing: 'auto', heightOffset: 0 });
    check(p.ok, `native forecourt street quote: ${p.errors.join(', ')}`);
    assert.equal(commitProposal(g, p), null); checks++;
    g.stations.refreshAccess(); g.lines.rebuild();
    check(g.stations.hasAccess(st), 'actual paid street provides native station walking access');
  }
  return st;
}
function fixture() {
  // Declared physical fixture: initial funding is a supported New Game option. No forecast/receipt overrides.
  const g = Game.create({ size: 384, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1985,
    aiConfigs: [1, 2].map(() => ({ startMoney: 50_000_000, accessPolicy: 'open' as const, focus: { rail: 1, road: 0, tram: 0 } })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiEnabled = false; g.aiAcquisitions = false;
  const A = town(g, 'Own short hub', 55, 190), left = town(g, 'Existing west', 140, 190);
  const B = town(g, 'Foreign branch', 230, 190), right = town(g, 'Existing east', 325, 190);
  const own = paidStation(g, A.x, A.z, 4, 1, true);
  const route = [left, B, right].map(t => paidStation(g, t.x, t.z, 10, 2));
  for (let i = 1; i < route.length; i++) check(connectDouble(g, route[i - 1], route[i], 2, () => {}).ok, 'existing foreign corridor is built through native construction');
  const l = g.lines.create('rail', 2); l.stops = outAndBack(route.map(s => s.id)); g.lines.rebuild();
  const depot = depotFor(g, route[2], route[1], 2); check(depot >= 0, 'native foreign depot builds');
  const cars = pickTrain(g.year, 10, 221, 2)!;
  const money = g.company(2).economy.money, train = g.vehicles.buyTrain(depot, cars, l.id);
  check(train instanceof Train, 'existing foreign service buys real native stock');
  assert.equal(money - g.company(2).economy.money, cars.reduce((n, c) => n + c.cost, 0)); checks++;
  g.lines.rebuild();
  g.stations.refreshAccess();
  return { g, A, B, own, foreign: route[1], line: l };
}
{
  const { g, A, B, own, foreign, line } = fixture(), ai = g.aiOf(1)! as any;
  const shortest = pickTrain(g.year, 4, 221, 2)!;
  assert.equal(length(shortest), 4.8); checks++;
  check(g.stations.railTrackGroups(own).every(p => p.length < length(shortest) + .05), 'even the actual builder-shortened one-coach body cannot fit the own four-unit station');
  check(ai.hubFor(A, B)?.id === own.id, 'omitted-context lookup retains the original HSR/unrelated-caller behavior');
  const chosen = pure(g, () => ai.railReuseEnds(A, B));
  check(chosen.freeA === null && chosen.freeB === null && chosen.branchB?.id === foreign.id,
    'unsupported own hub cannot suppress the native foreign mainline branch before pricing');
  const cars = pickTrain(g.year, 10, 221, 2)!;
  const call = line.stops.indexOf(foreign.id), options = pure(g, () => platformChoicesForStock(g, line, 0, call,
    { owner: 1, rule: consistRule(cars), length: length(cars) }));
  check(options.length > 0, 'foreign alternative has actual full-stock incoming/onward native platform choices');
  check(!pure(g, () => ai.ordinaryHubFits(own, stock)), 'short own facility fails the necessary fit gate');

  const cold = deserialize(JSON.parse(bytes(g))), ca = cold.aiOf(1)! as any;
  assert.equal(bytes(cold), bytes(g)); checks++;
  const coldChoice = pure(cold, () => ca.railReuseEnds(cold.towns.list[A.id], cold.towns.list[B.id]));
  assert.deepEqual(Object.fromEntries(Object.entries(coldChoice).map(([k, v]: any) => [k, v?.id ?? null])),
    Object.fromEntries(Object.entries(chosen).map(([k, v]: any) => [k, v?.id ?? null]))); checks++;
  for (let i = 0; i < 128; i++) { g.stepTick(); cold.stepTick(); assert.equal(bytes(g), bytes(cold), `native stock/save continuation tick${i}`); }
  checks += 128;

  // Native policy edits affect both discovery and full local edge access; no stale derived fit cache.
  g.setAccessPolicy(2, 'auto-reject');
  g.stations.refreshAccess();
  check(!pure(g, () => ai.ordinaryHubFits(foreign, stock)), 'denied foreign platform edges fail native owner access');
  check(!pure(g, () => ai.railReuseEnds(A, B)).branchB, 'denied foreign branch is not discovered');
  g.setAccessPolicy(2, 'open');
  g.stations.refreshAccess();
  check(pure(g, () => ai.ordinaryHubFits(foreign, stock)), 'reopened lawful platform is immediately eligible');

  const fit = paidStation(g, 55, 225, 10, 1, true);
  check(pure(g, () => ai.hubFor(A, B, stock))?.id === fit.id, 'fitting own light-rail facility retains ownership priority without a mainline style ban');
  const tie = paidStation(g, 55, 255, 10, 1);
  check(pure(g, () => ai.hubFor(A, B, stock))?.id === fit.id, 'fitting equal-rank own station retains the original first tie');
  check(pure(g, () => ai.ordinaryHubFits(tie, stock)), 'ordinary mainline group also fits');
  const shortForeign = paidStation(g, 230, 90, 4, 2);
  check(!pure(g, () => ai.ordinaryHubFits(shortForeign, stock)), 'too-short foreign facility is rejected equally');
  const edge = paidStation(g, 55, 90, 4.8, 1), clearance = paidStation(g, 55, 120, 4.85, 1);
  check(!pure(g, () => ai.ordinaryHubFits(edge, stock)), 'whole body without the native .05 clearance remains unavailable');
  check(pure(g, () => ai.ordinaryHubFits(clearance, stock)), 'the same real body with native clearance fits');
  // Current track classes are aliases for the same two physical rail types. Test both native aliases rather
  // than inventing an unsupported gauge/type or banning a station style to manufacture a negative.
  check(g.stations.railTrackGroups(fit).every(p => p.steps.every(s => ruleAllows(consistRule(cars), g.world.net.edges.get(s.edge)!))),
    'native light-rail wire/class alias really permits the ordinary diesel consist');

  // Capture a genuine pending chooser, not a manufactured cursor or an injected winning option.
  g.demand.rebuild(); ai.job = ai.chooseProject();
  check(!ai.job.next().done && ai.selection, 'ordinary native selector has a real saved pending work unit');
  const selectedCold = deserialize(JSON.parse(bytes(g))), coldAI = selectedCold.aiOf(1)! as any;
  assert.equal(bytes(selectedCold), bytes(g)); checks++;
  let units = 0, sawRail = false;
  while (ai.selection && units < 96) {
    const warm = ai.job.next(), cold = coldAI.job.next();
    assert.equal(warm.done, cold.done, `pending native selector completion${units}`);
    assert.equal(bytes(g), bytes(selectedCold), `pending native selector full save${units}`);
    if (ai.selection?.rail?.hubs) sawRail = true;
    units++;
  }
  check(units > 1 && sawRail, 'cold comparison exercises actual rail selector work units and hub choices');
  checks += units;
}
{
  const { g } = fixture(), ai = g.aiOf(1)! as any;
  // Two independently paid, parallel but longitudinally staggered platforms, merged with the native API:
  // nominal union10u, each physical whole group6u. No hand-edited lengths, groups or edge geometry.
  const a = paidStation(g, 100, 300, 6, 1, false, false), b = paidStation(g, 104, 303, 6, 1, false, false);
  assert.equal(g.stations.merge(a.id, b.id), null, 'native staggered platform merge succeeds'); checks++;
  const groups = g.stations.railTrackGroups(a);
  check(a.rail!.length > 9.9 && groups.length >= 2 && groups.every(q => q.length < 6.01), 'native nominal union is genuinely longer than every complete platform');
  const full = pickTrain(g.year, Math.min(stock.platform, a.rail!.length), 221, 2)!;
  const shorterOtherEnd = pickTrain(g.year, Math.min(stock.platform, a.rail!.length, 6), 221, 2)!;
  check(length(full) > 6 && length(shorterOtherEnd) + .05 < 6 && shorterOtherEnd.length === 2,
    'a real shorter other-end platform makes the unchanged builder select one coach that fits');
  check(pure(g, () => ai.ordinaryHubFits(a, stock)), 'necessary filter retains a native lower-cap stock outcome even before the other end is known');
  check(pure(g, () => ai.ordinaryHubFits(a, { ...stock, platform: 6 })), 'known shorter primary cap also preserves the lawful secondary facility');
}
// Optional exact natural checkpoint proof; the portable default does not depend on an external saved world.
const at = process.argv.indexOf('--world');
if (at >= 0) {
  const raw = readFileSync(process.argv[at + 1], 'utf8');
  assert.equal(createHash('sha256').update(raw).digest('hex'), '22319c815fcb1df7557ac93bfbf52e408365b09d342955761d6596b2b89debe6');
  const g = deserialize(JSON.parse(raw)), ai = g.aiOf(2)! as any, A = g.towns.list[0], B = g.towns.list[6];
  const context = { platform: aiPlatformLength(A.pop, B.pop, g.year), coaches: openingCoaches(A.pop, B.pop) };
  check(ai.hubFor(A, B)?.id === 34 && !pure(g, () => ai.ordinaryHubFits(g.stations.get(34)!, context)), 'exact focused5 own34 is physically unsupported');
  const choice = pure(g, () => ai.railReuseEnds(A, B));
  check(choice.branchB?.id === 1, 'exact focused5 foreign1 branch is discovered after necessary fit filtering');
  console.log('Natural focused5: physical discovery only; no works/finance/ROI/paid-investment claim.');
}
console.log(`PASS ${checks} native hub-fit, priority, access and cold-save checks`);
console.log('ALL CHECKS PASSED');
