// Rail-only route codes, station badges, stable through numbering and migration of old non-rail codes.
// Bundle with esbuild for Node, as with through.ts.
import { Game, PLAYER } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import type { Line } from '../src/game/lines';
import { lineCodeOf, lineMode, lineMatches, stationBadges, badgeOn } from '../src/ui/lineid';
import { fails, check, build, free, roadOpts, addBusStop } from './lib';

const g = Game.create({ size: 384, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: 1 });
g.aiEnabled = false;
g.world.h.fill(4);
g.world.heightsVersion++;
for (const c of g.companies) c.economy.money = 1e9;
g.company(PLAYER).code = 'N';
g.company(1).code = 'B';
check(!!build(g, free(g, 20, 106), free(g, 350, 106), roadOpts(PLAYER, 'street', { tram: true })), 'road with tram tracks built');
const stations = ['standard', 'metro', 'lightrail'].map((trackType, i) => {
  const id = g.stations.nextId;
  const owner = i === 2 ? 1 : PLAYER;
  const plan = g.stations.planRail(60 + i * 90, 100, Math.PI / 2, 10, 2, owner, { trackType, level: 'ground', style: 'none' });
  const err = plan.ok ? g.stations.commitRail(plan, owner) : plan.error;
  if (err) throw new Error(err);
  return g.stations.get(id)!;
});
const [a, b, c] = stations;
check(addBusStop(g, b.x, 106, PLAYER) === b.id, 'rail station has a shared bus and tram stop');
const roadOnly = addBusStop(g, 320, 106, PLAYER);
check(roadOnly > 0 && !g.stations.get(roadOnly)?.rail, 'standalone bus and tram stop built');

const main = g.lines.create('rail'), metro = g.lines.create('rail'), light = g.lines.create('rail', 1);
main.stops = [a.id, b.id]; main.code = 'S'; main.numbers = [[a.id, 1], [b.id, 7]];
metro.stops = [b.id]; metro.code = 'M';
light.stops = [c.id]; light.code = 'L';
const bus = g.lines.create('road'), tram = g.lines.create('tram');
bus.stops = [b.id, roadOnly]; tram.stops = [...bus.stops];
g.lines.rebuild();
check(lineMode(g, metro) === 'metro' && lineMode(g, light) === 'lightrail' && [main, metro, light].every((l) => !!g.lines.lineCode(l.id)), 'main line, metro and light rail have codes');
for (const l of [bus, tram]) {
  check(g.lines.routeCode(l) === '' && g.lines.lineCode(l.id) === '' && lineCodeOf(g, l) === '' && !l.code, `${l.kind} has no code or UI fallback symbol`);
  g.lines.renumber(l.id);
  g.lines.inheritRoute(l.id, main.id);
  check(!l.numbers && g.lines.stationCode(l.id, b.id) === '' && badgeOn(g, l.id, b.id) === null, `${l.kind} gets no numbers, including renumbering and through inheritance`);
}
const numbers = JSON.stringify(main.numbers);
g.lines.inheritRoute(main.id, bus.id);
check(main.code === 'S' && JSON.stringify(main.numbers) === numbers, 'a non-rail source cannot change rail numbering');
// A legacy non-rail code must not reserve a route letter or change an existing rail code.
bus.code = 'S';
check(g.lines.lineCode(main.id) === 'NS', 'non-rail codes do not conflict with existing rail codes');
delete bus.code;
check(g.lines.stationCode(main.id, a.id) === 'NS01' && g.lines.stationCode(main.id, b.id) === 'NS07', 'existing rail numbers remain stable');
check(g.lines.stationCodeEntries(b.id).length === 2 && g.lines.stationCodes(b.id).join(',') === 'NS07,NM01' && stationBadges(g, b.id).map((n) => n.code).join(',') === 'NS07,NM01', 'mixed station retains its rail codes and badges only');
check(g.lines.stationCodes(roadOnly).length === 0 && stationBadges(g, roadOnly).length === 0, 'bus and tram station has no numbering');
check(lineMatches(g, bus, { company: 'mine', hidden: ['rail', 'metro', 'lightrail', 'tram'] }) && !lineMatches(g, tram, { company: 'mine', hidden: ['tram'] }), 'mode filters still include and exclude unnumbered lines');

const through = g.lines.create('rail', 1);
through.stops = [b.id, c.id];
g.lines.inheritRoute(through.id, main.id);
g.lines.rebuild();
check(g.lines.stationCode(through.id, b.id) === 'NS07' && g.lines.stationCode(through.id, c.id) === 'BS08', 'rail through service retains NS01 and continues to BS08 across operators');
const colors = g.lines.all().map((l) => l.color);
check(new Set(colors).size === colors.length, 'colours remain unique across all modes and operators');

const old = JSON.parse(JSON.stringify(serialize(g)));
for (const l of old.lines as Line[]) if (l.kind !== 'rail') { l.code = 'S'; l.numbers = [[b.id, 2], [roadOnly, 3]]; }
const loaded = deserialize(old);
check(loaded.lines.all().filter((l) => l.kind !== 'rail').every((l) => l.code === undefined && l.numbers === undefined), 'loading an old save clears non-rail codes and numbers');
check(loaded.lines.all().filter((l) => l.kind === 'rail').every((l) => l.code === g.lines.get(l.id)?.code && JSON.stringify(l.numbers) === JSON.stringify(g.lines.get(l.id)?.numbers)), 'loading preserves every rail code and station number');
check(loaded.lines.stationCodes(roadOnly).length === 0 && loaded.lines.stationCode(main.id, a.id) === 'NS01' && loaded.lines.stationCode(through.id, c.id) === 'BS08', 'old non-rail numbering stays absent after loading and rebuilding');
check(JSON.stringify(serialize(deserialize(JSON.parse(JSON.stringify(serialize(loaded)))))) === JSON.stringify(serialize(loaded)), 'migrated save round trip is stable');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
