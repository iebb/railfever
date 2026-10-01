// Save/load round trip: serialize -> JSON -> deserialize mid-simulation (player lines + AI companies), then
// continue both copies and check they stay consistent.
// npx esbuild scripts/save.ts --bundle --platform=node --format=esm --outfile=$S/save.mjs && node $S/save.mjs [seed]
import { gzipSync } from 'node:zlib';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { fails, check, fmt, connectStations, depotBehind, placeStationPair, busStopSites, addBusStop, roadDepotNear, checkReservations, checkNaN, Train } from './lib';

const seed = Number(process.argv[2] ?? 7);
const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2 });
g.economy.money = 40_000_000;
// player network: a railway and a bus line
const pr = placeStationPair(g, 60, 150, 0)!;
connectStations(g, pr.A, pr.B, 0, 1, () => {});
const dep = depotBehind(g, pr.A, pr.B, 0);
const line = g.lines.create('rail', 0);
line.stops = [pr.A.id, pr.B.id];
g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], line.id);
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, big, 0, 12, 30);
if (sites.length === 2) {
  const s0 = addBusStop(g, sites[0][0], sites[0][1], 0), s1 = addBusStop(g, sites[1][0], sites[1][1], 0);
  const bd = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const bl = g.lines.create('road', 0);
  bl.stops = [s0, s1];
  for (let i = 0; i < 2; i++) g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, bl.id);
}
// run ~8 months, then save at a moment when no AI project is half-built (jobs are not persisted)
while (g.day < 240 || g.ais.some((a) => a.busy)) g.update(0.25);
const t0 = performance.now();
const data = serialize(g);
const json = JSON.stringify(data);
const t1 = performance.now();
const g2 = deserialize(JSON.parse(json));
const t2 = performance.now();
console.log(`saved on ${g.dateString()}: serialize ${fmt(t1 - t0, 0)} ms, deserialize ${fmt(t2 - t1, 0)} ms, JSON ${fmt(json.length / 1e6, 2)} MB, gzip ${fmt(gzipSync(json).length / 1e6, 2)} MB`);
console.log(`  ${g.vehicles.map.size} vehicles, ${g.vehicles.ambient.length} town cars, ${g.world.net.edges.size} edges, ${g.stations.map.size} stations, ${g.companies.length} companies`);
const sig = (x: Game) => ({
  money: x.companies.map((c) => Math.round(c.economy.money)),
  delivered: x.vehicles.all().reduce((a, v) => a + v.delivered, 0),
  pop: x.towns.list.reduce((a, t) => a + t.pop, 0),
  edges: x.world.net.edges.size, vehicles: x.vehicles.map.size, ambient: x.vehicles.ambient.length,
  states: x.vehicles.all().map((v) => v.state[0]).join(''),
});
const s0 = sig(g), s0b = sig(g2);
check(JSON.stringify(s0) === JSON.stringify(s0b), 'state identical right after loading');
check(checkReservations(g2).length === 0, 'reservations rebuilt consistently');
// a second round trip of the loaded game must give the same data
const json2 = JSON.stringify(serialize(g2));
if (json2 !== json) {
  let i = 0;
  while (i < json.length && json[i] === json2[i]) i++;
  console.log(`  re-serialized JSON differs at ${i}: ...${json.slice(Math.max(0, i - 120), i + 60)}...\n  vs ...${json2.slice(Math.max(0, i - 120), i + 60)}...`);
}
check(json2 === json, `re-serialized save identical (${json.length} vs ${json2.length} chars)`);
let errors = 0;
for (let d = 0; d < 360 * 16; d++) {
  try { g.update(0.125); g2.update(0.125); } catch (e) { errors++; console.log('EXCEPTION', (e as Error).stack?.split('\n').slice(0, 5).join('\n')); break; }
  if (d % 1440 === 0) { const a = sig(g), b = sig(g2); console.log(`  ${g.dateString()}: money ${a.money.map((m) => fmt(m / 1e6, 2)).join('/')} vs ${b.money.map((m) => fmt(m / 1e6, 2)).join('/')}, delivered ${a.delivered} vs ${b.delivered}, pop ${a.pop} vs ${b.pop}`); }
}
const a = sig(g), b = sig(g2);
console.log(`after a year: original ${JSON.stringify({ ...a, states: undefined })}\n              loaded   ${JSON.stringify({ ...b, states: undefined })}`);
check(errors === 0, 'no exceptions');
const close = (x: number, y: number, tol: number) => Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y));
check(a.money.every((m, i) => close(m, b.money[i], 0.02)), 'company money within 2%');
check(close(a.delivered, b.delivered, 0.03), 'passengers delivered within 3%');
check(close(a.pop, b.pop, 0.02), 'town population within 2%');
console.log(`  exact match: ${JSON.stringify(a) === JSON.stringify(b)}`);
check(!checkNaN(g2), 'no NaN in the loaded game');
check(checkReservations(g2).length === 0, 'reservations consistent in the loaded game');
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
void Train;
