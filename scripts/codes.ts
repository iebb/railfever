// Rail-only route codes, station badges, route-order through numbering and migration of old non-rail codes.
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
check(new Set([main.code, metro.code]).size === 2, 'rail route letters remain unique within their company');
check([main, metro, light].every((l) => lineMode(g, l) === 'rail' && !!g.lines.lineCode(l.id)), 'lines on main-line, metro and light-rail track are all rail lines with codes');
check(new Set([main, metro, light].map((l) => `${l.owner}:${l.num}`)).size === 3 && metro.num === 2, 'one rail numbering series whatever the track type (R1, R2 …)');
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
check(g.lines.stationCode(main.id, a.id) === 'NS01' && g.lines.stationCode(main.id, b.id) === 'NS02', 'rail numbers are repaired to consecutive route order');
check(g.lines.stationCodeEntries(b.id).length === 2 && g.lines.stationCodes(b.id).join(',') === 'NS02,NM01' && stationBadges(g, b.id).map((n) => n.code).join(',') === 'NS02,NM01', 'mixed station retains its rail codes and badges only');
check(g.lines.stationCodes(roadOnly).length === 0 && stationBadges(g, roadOnly).length === 0, 'bus and tram station has no numbering');
check(lineMatches(g, bus, { company: 'mine', hidden: ['rail', 'tram'] }) && !lineMatches(g, tram, { company: 'mine', hidden: ['tram'] }), 'mode filters still include and exclude unnumbered lines');
check(!lineMatches(g, metro, { company: 'mine', hidden: ['rail'] }) && lineMatches(g, metro, { company: 'mine', hidden: ['bus', 'tram', 'coach'] }), 'the rail filter shows and hides lines on metro track like any rail line');

const through = g.lines.create('rail', 1);
through.stops = [b.id, c.id];
g.lines.inheritRoute(through.id, main.id);
g.lines.rebuild();
check(g.lines.stationCode(through.id, b.id) === 'NS02' && g.lines.stationCode(through.id, c.id) === 'BS03', 'rail through service shares NS02 and continues to BS03 across operators');
const colors = g.lines.all().map((l) => l.color);
check(new Set(colors).size === colors.length, 'colours remain unique across all modes and operators');

const old = JSON.parse(JSON.stringify(serialize(g)));
for (const l of old.lines as Line[]) if (l.kind !== 'rail') { l.code = 'S'; l.numbers = [[b.id, 2], [roadOnly, 3]]; }
const loaded = deserialize(old);
check(loaded.lines.all().filter((l) => l.kind !== 'rail').every((l) => l.code === undefined && l.numbers === undefined), 'loading an old save clears non-rail codes and numbers');
check(loaded.lines.all().filter((l) => l.kind === 'rail').every((l) => l.code === g.lines.get(l.id)?.code && JSON.stringify(l.numbers) === JSON.stringify(g.lines.get(l.id)?.numbers)), 'loading preserves every rail code and station number');
check(loaded.lines.all().every((l) => l.color === g.lines.get(l.id)?.color && l.num === g.lines.get(l.id)?.num && lineMode(loaded, l) === lineMode(g, l)) && lineMode(loaded, loaded.lines.get(light.id)!) === 'rail', 'saved metro and light-rail lines load as rail lines with their colours and numbers');
check(loaded.lines.stationCodes(roadOnly).length === 0 && loaded.lines.stationCode(main.id, a.id) === 'NS01' && loaded.lines.stationCode(through.id, c.id) === 'BS03', 'old non-rail numbering stays absent after loading and rebuilding');
check(JSON.stringify(serialize(deserialize(JSON.parse(JSON.stringify(serialize(loaded)))))) === JSON.stringify(serialize(loaded)), 'migrated save round trip is stable');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
