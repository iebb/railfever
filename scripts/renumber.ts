// Route-order station numbers belong to the model, including through families, migrations and redirects.
// Bundle as renumber.mjs with esbuild --bundle --platform=node --format=esm, then run from the scratch directory.
import assert from 'node:assert/strict';
import { Game, PLAYER } from '../src/game/game';
import { outAndBack, type Line } from '../src/game/lines';
import { joinLines, canonicalizeLines } from '../src/game/patterns';
import { serialize, deserialize } from '../src/game/save';
import { stationBadges, badgeOn, lineCodeOf } from '../src/ui/lineid';
import { addStopToLine } from '../src/ui/win-lines';
import type { UI } from '../src/ui/ui';
import { station } from './stationlib';
import { connectDouble, build, free, roadOpts, addBusStop } from './lib';

if (!process.argv[1]?.endsWith('renumber.mjs')) throw new Error('bundle this test as renumber.mjs');
let checks = 0;
function equal(actual: unknown, expected: unknown, label: string) {
  if (typeof actual === 'string' && typeof expected === 'string' && actual !== expected && expected.length > 1000) {
    let i = 0; while (actual[i] === expected[i] && i < expected.length) i++;
    throw new Error(`${label}: differs at ${i}\nexpected: ${expected.slice(i - 70, i + 120)}\nactual:   ${actual.slice(i - 70, i + 120)}`);
  }
  assert.deepEqual(actual, expected, label); checks++;
}
function ok(value: unknown, label: string) { assert.ok(value, label); checks++; }
const saved = (g: Game) => JSON.stringify(serialize(g));
const values = (l: Line) => l.numbers?.map(([, n]) => n);
function game(size = 384) {
  const g = Game.create({ size, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: 3 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  g.world.h.fill(4); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  return g;
}
function stations(g: Game, owners: number[] = [0, 0, 0, 0, 0, 0], spacing = 55) {
  const out = owners.map((owner, i) => {
    const s = station(g, 40 + i * spacing, 192, Math.PI / 2, 10, 2, owner);
    if (!s) throw new Error(`station ${i} failed`);
    return s;
  });
  g.stations.refreshAccess();
  return out;
}
function line(g: Game, stops: number[], owner = PLAYER, loop = false) {
  const l = g.lines.create('rail', owner); l.stops = [...stops]; l.loop = loop;
  g.lines.rebuild(); return l;
}
function numbers(g: Game, l: Line, path: number[], expected: number[], label: string) {
  equal(g.lines.routeStations(l), path, label + ': route is unchanged');
  equal(l.numbers, path.map((s, i) => [s, expected[i]]), label + ': station numbers');
}
function roundTrip(g: Game, label: string) {
  const json = saved(g), loaded = deserialize(JSON.parse(json));
  equal(saved(loaded), json, label + ': exact save/load'); return loaded;
}

console.log('screenshot: reversed foreign base, joined or extended through service');
{
  const g = game(), S = stations(g, [1, 1, 2, 2, 2]), ids = S.map((s) => s.id);
  g.company(1).code = 'V'; g.company(2).code = 'E';
  S.forEach((s, i) => { s.name = ['Upper Dungate', 'Ashthorpe', 'Ashthorpe east', 'Marstow', 'Whitewick'][i]; });
  const base = line(g, [ids[1], ids[0]], 1); base.code = 'A'; g.lines.rebuild();
  const through = line(g, outAndBack([ids[0], ids[1], ids[4]]), 2);
  g.lines.inheritRoute(through.id, base.id);
  through.stops = outAndBack(ids); g.lines.rebuild();
  numbers(g, through, ids, [1, 2, 3, 4, 5], 'the reported through route after middle insertions');
  numbers(g, base, [ids[1], ids[0]], [2, 1], 'the base aligns with its continuation');
  equal(ids.map((s) => g.lines.stationCode(through.id, s)), ['VA01', 'VA02', 'EA03', 'EA04', 'EA05'], 'company letters follow station ownership');
  equal(through.routeFamily, base.routeFamily, 'the family link is saved');
  roundTrip(g, 'screenshot family');
}

console.log('creation, extensions at either end, insertion, removal, reorder and empty routes');
{
  const g = game(), ids = stations(g).map((s) => s.id), l = line(g, [ids[1], ids[3]]);
  numbers(g, l, [ids[1], ids[3]], [1, 2], 'creation');
  l.stops.push(ids[4]); g.lines.rebuild();
  numbers(g, l, [ids[1], ids[3], ids[4]], [1, 2, 3], 'end extension');
  l.stops.unshift(ids[0]); g.lines.rebuild();
  numbers(g, l, [ids[0], ids[1], ids[3], ids[4]], [1, 2, 3, 4], 'start extension');
  l.stops.splice(2, 0, ids[2]); g.lines.rebuild();
  numbers(g, l, ids.slice(0, 5), [1, 2, 3, 4, 5], 'middle insertion');
  g.lines.onStationRemoved(ids[1]);
  numbers(g, l, [ids[0], ids[2], ids[3], ids[4]], [1, 2, 3, 4], 'station removal');
  l.stops = [ids[4], ids[0], ids[3], ids[2]]; g.lines.rebuild();
  numbers(g, l, l.stops, [1, 2, 3, 4], 'reordering');
  const original = l.numbers; g.lines.rebuild(false);
  equal(l.numbers === original, true, 'frequency rebuild retains an unchanged number array');
  l.stops = []; g.lines.rebuild(); equal(l.numbers, [], 'removing every stop clears the numbers');
  // Use the real player stop-add handler: it must trigger the central model rule.
  const ui = { game: g, sound() {}, toast() {}, hud: { onToolChange() {} }, wm: { get() {} } } as unknown as UI;
  addStopToLine(ui, l.id, ids[4]); addStopToLine(ui, l.id, ids[0]); addStopToLine(ui, l.id, ids[2]);
  numbers(g, l, [ids[4], ids[0], ids[2]], [1, 2, 3], 'player line editor');
  roundTrip(g, 'edited player line');
}

console.log('family attachment orientation, changes to either member and owner-letter collisions');
{
  const g = game(), ids = stations(g, [0, 0, 1, 1, 0, 2]).map((s) => s.id);
  const base = line(g, [ids[1], ids[0]]), through = line(g, [ids[1], ids[2]], 1);
  g.lines.inheritRoute(through.id, base.id);
  numbers(g, base, [ids[1], ids[0]], [2, 1], 'reverse base at a shared terminus');
  numbers(g, through, [ids[1], ids[2]], [2, 3], 'through departure continues upward');
  through.stops.push(ids[3]); g.lines.rebuild();
  numbers(g, through, through.stops, [2, 3, 4], 'through extension');
  base.stops.push(ids[4]); g.lines.rebuild();
  numbers(g, base, base.stops, [3, 2, 1], 'base extension changes every family member');
  numbers(g, through, through.stops, [3, 4, 5], 'shared number shifts after base extension');
  through.stops = [ids[3], ids[2], ids[1]]; g.lines.rebuild();
  numbers(g, through, through.stops, [5, 4, 3], 'a reversed through line keeps its tail after the base');
  base.stops = [ids[1], ids[4]]; g.lines.rebuild();
  numbers(g, through, through.stops, [4, 3, 2], 'base removal shifts the through family');
  const blocked = line(g, [ids[0], ids[4]]);
  const code = blocked.code; g.lines.inheritRoute(blocked.id, base.id);
  equal(blocked.code, code, 'a through link cannot collide with another route letter of its owner');
  equal(values(blocked), [1, 2], 'a blocked link retains independent route-order numbers');
  const unrelated = line(g, [ids[4], ids[5]], 2); unrelated.code = base.code; g.lines.rebuild();
  equal(values(unrelated), [1, 2], 'equal letters without inheritance do not join families');
  ok(unrelated.routeFamily !== base.routeFamily, 'unrelated routes save distinct family identities');
  roundTrip(g, 'family and unrelated equal letter');
}

console.log('joining into a through family and redirecting a dropped family base');
{
  const g = game(512), S = stations(g, [0, 0, 0, 1, 2, 3], 85), ids = S.map((s) => s.id);
  for (const c of g.companies) g.setAccessPolicy(c.id, 'open');
  for (let i = 0; i < S.length - 1; i++) ok(connectDouble(g, S[i], S[i + 1], S[i].owner, () => {}).ok, `join track ${i}`);
  const base = line(g, outAndBack([ids[2], ids[1], ids[0]]));
  const through = line(g, outAndBack([ids[0], ids[1], ids[2], ids[3]]), 1);
  g.lines.inheritRoute(through.id, base.id);
  const end = line(g, [ids[3], ids[4]], 2), other = line(g, [ids[4], ids[5]], 3);
  g.lines.inheritRoute(other.id, end.id);
  const joined = joinLines(g, through, end, { notify: false, renumber: false });
  if (typeof joined === 'string') throw new Error(joined);
  equal(joined.line, through, 'longer through line survives');
  numbers(g, through, ids.slice(0, 5), [1, 2, 3, 4, 5], 'join renumbers even with the old opt-out');
  numbers(g, base, [ids[2], ids[1], ids[0]], [3, 2, 1], 'join updates the original base');
  numbers(g, other, [ids[4], ids[5]], [5, 6], 'the dropped base family follows the survivor');
  equal(other.code, through.code, 'a redirected family inherits the survivor letter');
  equal(g.lines.get(end.id), through, 'removed line id redirects to the survivor');
  other.stops.unshift(ids[3]); g.lines.rebuild();
  numbers(g, other, other.stops, [4, 5, 6], 'edits after a family redirect');
  roundTrip(g, 'joined route families');
}

console.log('canonical redirects and deletion of the family base');
{
  const g = game(), ids = stations(g).map((s) => s.id);
  const base = line(g, [ids[0], ids[1]]), through = line(g, outAndBack(ids.slice(0, 4)), 1);
  g.lines.inheritRoute(through.id, base.id);
  const longer = line(g, outAndBack(ids.slice(0, 3)));
  equal(canonicalizeLines(g, base.id, { sameOwnerOnly: true }).length, 1, 'base is merged into its longer same-owner line');
  equal(g.lines.get(base.id), longer, 'canonicalized base redirects');
  equal(through.routeFamily, longer.routeFamily, 'canonical redirects relink through family');
  through.stops = outAndBack(ids.slice(0, 5)); g.lines.rebuild();
  numbers(g, longer, ids.slice(0, 3), [1, 2, 3], 'redirected family base');
  numbers(g, through, ids.slice(0, 5), [1, 2, 3, 4, 5], 'redirected through extension');
  g.lines.delete(longer.id);
  numbers(g, through, ids.slice(0, 5), [1, 2, 3, 4, 5], 'remaining family after base deletion');
  roundTrip(g, 'deleted family base');
}

console.log('out-and-back routes and loops use their natural route order');
{
  const g = game(), ids = stations(g).map((s) => s.id), l = line(g, outAndBack(ids.slice(0, 4)));
  numbers(g, l, ids.slice(0, 4), [1, 2, 3, 4], 'outward path');
  l.stops = outAndBack([ids[0], ids[2], ids[3], ids[4]]); g.lines.rebuild();
  equal(l.stops.map((s) => badgeOn(g, l.id, s)?.num), ['01', '02', '03', '04', '03', '02'], 'return calls repeat their station number');
  const loop = line(g, ids.slice(0, 4), 1, true);
  loop.stops.splice(1, 0, ids[4]); g.lines.rebuild();
  numbers(g, loop, loop.stops, [1, 2, 3, 4, 5], 'loop insertion');
  loop.stops = [ids[2], ids[3], ids[0], ids[4], ids[1]]; g.lines.rebuild();
  numbers(g, loop, loop.stops, [1, 2, 3, 4, 5], 'loop starting stop and direction');
  roundTrip(g, 'out-and-back and loop');
}

console.log('branch gaps and incompatible route orders have deterministic priorities');
{
  const g = game(), ids = stations(g).map((s) => s.id);
  const base = line(g, ids.slice(0, 3)), a = line(g, [ids[1], ids[3]], 1), b = line(g, [ids[1], ids[4]], 2);
  g.lines.inheritRoute(a.id, base.id); g.lines.inheritRoute(b.id, base.id);
  equal(values(base), [1, 2, 4], 'base branch has a gap after the oldest continuing spine');
  equal(values(a), [2, 3], 'oldest continuing spine has consecutive numbers');
  equal(values(b), [2, 5], 'other branch increases with a deterministic gap');
  const before = g.lines.all().map((l) => [l.id, l.numbers]);
  g.lines.map = new Map([...g.lines.map].reverse()); g.lines.renumber(b.id);
  equal(g.lines.all().map((l) => [l.id, l.numbers]).sort((a, b) => Number(a[0]) - Number(b[0])), before, 'Map insertion order cannot change family numbering');
  roundTrip(g, 'branched family');
  const star = game(), p = stations(star).map((s) => s.id);
  const ab = line(star, p.slice(0, 3)), bc = line(star, [p[2], p[1], p[3]], 1), ac = line(star, [p[0], p[1], p[3]], 2);
  star.lines.inheritRoute(bc.id, ab.id); star.lines.inheritRoute(ac.id, ab.id);
  // The junction cannot lie numerically between all three pairs of branch termini at once.
  equal(values(bc), [1, 2, 3], 'an impossible three-branch family retains its oldest continuing spine');
  equal(values(ab), [4, 2, 1], 'the base follows the spine in the impossible branch family');
  equal(values(ac), [4, 2, 3], 'the final branch retains shared numbers despite an unavoidable direction change');
  roundTrip(star, 'impossible three-branch family');
  const h = game(), s = stations(h).map((s) => s.id);
  const ring = line(h, s.slice(0, 3), 0, true), crossing = line(h, [s[0], s[2], s[1]], 1, true);
  h.lines.inheritRoute(crossing.id, ring.id);
  equal(values(ring), [1, 2, 3], 'earlier loop keeps its natural order under a conflicting crossing');
  equal(values(crossing), [1, 3, 2], 'impossible monotonic crossing retains shared station numbers');
  roundTrip(h, 'incompatible loops');
  const r = game(), t = stations(r).map((s) => s.id);
  const oldBase = line(r, t.slice(0, 2)), continuation = line(r, t.slice(1), 1);
  r.lines.inheritRoute(continuation.id, oldBase.id);
  continuation.stops.shift(); r.lines.rebuild(); // the family is temporarily disconnected
  const reconnect = line(r, [t[1], t[2], t[0], t[3]], 2);
  r.lines.inheritRoute(reconnect.id, oldBase.id);
  equal(values(oldBase), [3, 1], 'reorient an earlier member to make a reconnected family monotonic');
  equal(values(continuation), [2, 4, 5, 6], 'the original spine remains monotonic after backtracking');
  equal(values(reconnect), [1, 2, 3, 4], 'a feasible reconnect wins over conflicting preferred directions');
  roundTrip(r, 'reconnected family');
}

console.log('station absorption replaces ids and renumbers the rail route');
{
  const g = game(), S = stations(g, [0, 0, 0, 0]);
  ok(build(g, free(g, 20, 206), free(g, 350, 206), roadOpts()), 'road for station absorption');
  const bus = addBusStop(g, S[1].x, 206, PLAYER);
  ok(bus > 0 && bus !== S[1].id, 'separate nearby bus station');
  const l = line(g, S.slice(0, 3).map((s) => s.id));
  equal(g.stations.merge(bus, S[1].id), null, 'rail platforms are absorbed into the nearby bus station');
  ok(g.stations.get(bus)?.rail && !g.stations.get(S[1].id), 'merged station retains the platforms under its surviving id');
  numbers(g, l, [S[0].id, bus, S[2].id], [1, 2, 3], 'absorb replaces the station id in route order');
  roundTrip(g, 'station absorption');
}

console.log('old-save numbering and inferred route-family migration');
{
  const g = game(), ids = stations(g, [1, 1, 2, 2, 2]).map((s) => s.id);
  const base = line(g, [ids[1], ids[0]], 1), through = line(g, outAndBack(ids), 2);
  g.lines.inheritRoute(through.id, base.id);
  const old = JSON.parse(saved(g));
  for (const l of old.lines) delete l.routeFamily;
  old.lines.find((l: Line) => l.id === base.id).numbers = [[ids[1], 1], [ids[0], 2]];
  old.lines.find((l: Line) => l.id === through.id).numbers = ids.map((s, i) => [s, [2, 1, 4, 5, 3][i]]);
  const loaded = deserialize(old), again = deserialize(JSON.parse(JSON.stringify(old)));
  equal(values(loaded.lines.get(through.id)!), [1, 2, 3, 4, 5], 'legacy screenshot is repaired on load');
  equal(values(loaded.lines.get(base.id)!), [2, 1], 'legacy base is oriented with the continuing route');
  equal(loaded.lines.get(through.id)!.routeFamily, base.id, 'legacy shared letter and numbers infer a saved family');
  equal(saved(loaded), saved(again), 'migration is deterministic');
  roundTrip(loaded, 'migrated family');
  const h = game(), local = stations(h).map((s) => s.id), l = line(h, local.slice(0, 3));
  const oldSingle = JSON.parse(saved(h)); delete oldSingle.lines[0].routeFamily;
  oldSingle.lines[0].numbers = [[local[0], 7], [local[1], 2], [local[2], 99]];
  equal(values(deserialize(oldSingle).lines.get(l.id)!), [1, 2, 3], 'standalone legacy numbers compact in route order');
}

console.log('UI reads never repair numbering, including an uncommitted stop edit');
{
  const g = game(), ids = stations(g).map((s) => s.id), l = line(g, ids.slice(0, 3));
  l.stops.unshift(ids[4]);
  const before = saved(g), version = g.lines.version;
  for (let i = 0; i < 3; i++) {
    lineCodeOf(g, l); g.lines.routeCode(l); g.lines.lineCode(l.id);
    for (const s of ids) { badgeOn(g, l.id, s); stationBadges(g, s); g.lines.stationCodes(s); }
  }
  equal(saved(g), before, 'number and badge reads are byte-pure');
  equal(g.lines.version, version, 'display never rebuilds routing');
  g.lines.rebuild(); numbers(g, l, l.stops, [1, 2, 3, 4], 'the model commits numbering at rebuild');
}

console.log('exact replay through further stop edits on original and loaded games');
{
  const g = game(), ids = stations(g).map((s) => s.id);
  const base = line(g, [ids[1], ids[0]]), through = line(g, outAndBack(ids.slice(0, 4)), 1);
  g.lines.inheritRoute(through.id, base.id);
  const loaded = roundTrip(g, 'replay start');
  for (let tick = 0; tick < 180; tick++) {
    for (const x of [g, loaded]) {
      const l = x.lines.get(through.id)!;
      if (tick === 20) l.stops = outAndBack(ids.slice(0, 5));
      if (tick === 50) l.stops = outAndBack([ids[0], ids[1], ids[3], ids[4]]);
      if (tick === 80) x.lines.get(base.id)!.stops = [ids[1], ids[0], ids[5]];
      if ([20, 50, 80].includes(tick)) x.lines.rebuild();
      x.stepTick();
    }
    equal(saved(loaded), saved(g), `exact replay tick ${tick}`);
  }
  roundTrip(g, 'replay end');
}
console.log(`ALL ${checks} CHECKS PASSED`);
