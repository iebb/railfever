// A small native connected network plus pure quadrature controls; bundle as demand-sampling.mjs.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { World } from '../src/game/world';
import { bezLine } from '../src/game/geom';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { sampleDemandDestinations, DEMAND_DESTINATION_LIMIT } from '../src/game/demand-sampling';
import { addBusStop, roadDepotNear, checkNaN, checkReservations } from './lib';

const from = { id: 7, x: 100, z: 100, townId: 0, catchPop: 200 };
const points = Array.from({ length: 129 }, (_, i) => ({
  id: i + 10, x: 103 + i * 3, z: 100 + i % 3, townId: i < 12 ? 0 : Math.floor(i / 8) + 1,
  catchPop: 10 + (i * 17) % 151,
}));
const small = points.slice(0, DEMAND_DESTINATION_LIMIT).reverse();
assert.deepEqual(sampleDemandDestinations(from, 3, small), small.map(destination => ({ destination, weight: 1 })),
  'small networks preserve all destinations, exact order and unit weights');
const seen = new Set<number>();
for (let day = 0; day < points.length; day++) {
  const sampled = sampleDemandDestinations(from, day, points);
  assert.equal(sampled.length, DEMAND_DESTINATION_LIMIT, 'work is bounded');
  assert.equal(new Set(sampled.map(s => s.destination.id)).size, sampled.length, 'no duplicate sampled route');
  assert.equal(sampled.reduce((n, s) => n + s.weight, 0), points.length, 'sample blocks preserve total destination mass');
  assert.deepEqual(sampled, sampleDemandDestinations(from, day, [...points].reverse()),
    'stable IDs and geometry determine selection, regardless of route Map insertion history');
  sampled.forEach(s => { assert.ok(points.includes(s.destination)); seen.add(s.destination.id); });
}
assert.equal(seen.size, points.length, 'every actual destination rotates into generation');
assert.notDeepEqual(sampleDemandDestinations(from, 3, points), sampleDemandDestinations(from, 4, points),
  'the saved day rotates the selected destinations');

const g = new Game({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990 }, new World(384));
g.world.h.fill(3); g.world.heightsVersion++; g.economy.money = 1e9;
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
const net = g.world.net, rowIds: number[][] = [], depots: number[] = [], lineIds: number[] = [];
function road(x0: number, z0: number, x1: number, z1: number) {
  const a = net.nearestNode(x0, z0, .01, 'road') ?? net.addNode('road', x0, 3, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, .01, 'road') ?? net.addNode('road', x1, 3, z1, 0, 0, -1);
  return net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1),
    new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(3), [], 'street', -1);
}
for (let row = 0; row < 3; row++) {
  const z = 50 + row * 70;
  road(5, z, 30, z); road(30, z, 272, z); road(272, z, 379, z);
  const t: any = { id: row, name: `Test ${row}`, x: 160, z: z + 3, angle: 0, pop: 0, radius: 145,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0,
    passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  rowIds.push(Array.from({ length: 12 }, (_, i) => {
    const id = addBusStop(g, 40 + 22 * i, z, 0); assert.ok(id >= 0, `native stop ${row}/${i}`);
    g.stations.get(id)!.townId = row; return id;
  }));
  assert.equal(new Set(rowIds[row]).size, 12, 'native stops stay distinct');
  for (let x = 20; x <= 290; x += 6) {
    const b = g.world.addBuilding({ townId: row, x, z: z + 3, angle: Math.PI, w: 1, d: 1, type: 4,
      floors: 4, pop: 40, seed: x + row * 512, y: 3, built: 0 });
    t.buildings.add(b.id); t.pop += b.pop;
  }
  const depot = roadDepotNear(g, 160, z, 0); assert.ok(depot >= 0); depots.push(depot);
  const l = g.lines.create('road', 0); l.stops = [...rowIds[row]]; l.evenSpacing = false; lineIds.push(l.id);
  for (let i = 0; i < 2; i++) assert.notEqual(typeof g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, l.id), 'string');
}
road(30, 50, 30, 120); road(30, 120, 30, 190);
const join = g.lines.create('road', 0); join.stops = rowIds.map(ids => ids[0]); join.evenSpacing = false;
for (let i = 0; i < 2; i++) assert.notEqual(typeof g.vehicles.buyRoad(depots[0], MODEL_BY_ID.get('bus_c')!, join.id), 'string');
g.initializeHeadquarters();
g.demand.rebuild(); g.lines.rebuild(); g.flushNetworkChanges(); g.lines.flushCatchment();
const station = g.stations.get(rowIds[0][6])!;
assert.ok(g.lines.routing.get(station.id)!.size > DEMAND_DESTINATION_LIMIT, 'native connected graph exercises approximation');
for (let i = 0; i < 80; i++) g.stepTick();
// Seed the native fractional accumulator so this short replay crosses real generation/queue/RNG work now,
// rather than needing a long calendar run on the deliberately sparse eight-bus timetable.
for (const st of g.stations.map.values()) st.genAccum = 1;
const nativeWeights = g.demand.weights(station);
assert.ok(nativeWeights.served > 0 && nativeWeights.dest.length <= DEMAND_DESTINATION_LIMIT);
assert.ok(nativeWeights.dest.every(id => g.lines.routing.get(station.id)!.has(id)), 'every selected trip has a native route');
const saved = JSON.stringify(serialize(g));
const twin = deserialize(JSON.parse(saved)); twin.aiEnabled = false; twin.vehicles.ambientEnabled = false;
function equalSave(a: Game, b: Game, label: string) {
  const expected = serialize(a), actual = serialize(b);
  function difference(x: any, y: any, path = ''): string | null {
    if (Object.is(x, y)) return null;
    if (!x || !y || typeof x !== 'object' || typeof y !== 'object') return `${path}: ${x} / ${y}`;
    if (JSON.stringify(Object.keys(x)) !== JSON.stringify(Object.keys(y))) return `${path}: keys differ`;
    for (const key of Object.keys(x)) { const d = difference(x[key], y[key], path + '.' + key); if (d) return d; }
    return null;
  }
  assert.equal(difference(expected, actual), null, label);
}
equalSave(g, twin, 'native fixture serializes identically immediately after load');
assert.deepEqual(twin.demand.weights(twin.stations.get(station.id)!), nativeWeights,
  'a cold loaded demand model produces the exact warm original approximation');
assert.equal(JSON.stringify(serialize(g)), saved, 'demand reads are pure');
for (let i = 0; i < 240; i++) {
  g.stepTick(); twin.stepTick();
  if ((i + 1) % 40 === 0) equalSave(g, twin,
    'fixed native simulation, queues, RNG and finances continue identically after a saved daily phase');
}
assert.equal(checkNaN(g), null); assert.deepEqual(checkReservations(g), []);
assert.ok(g.vehicles.roads().some(v => v.onMap), 'paid buses actually operate on the native network');
assert.ok([...g.stations.map.values()].some(s => s.genMonth > 0), 'native daily generation produces real waiting passengers');

const beforeLot = g.demand.weights(station);
const b = g.world.addBuilding({ townId: 0, x: station.x, z: station.z + 3, angle: Math.PI, w: 1, d: 1, type: 4,
  floors: 4, pop: 200, seed: 999, y: 3, built: 0 });
g.towns.list[0].buildings.add(b.id); g.towns.list[0].pop += b.pop;
g.lines.flushCatchment();
assert.notEqual(g.demand.weights(station), beforeLot, 'a new native lot invalidates demand in the same day');
const beforeFleet = g.demand.weights(station);
assert.notEqual(typeof g.vehicles.buyRoad(depots[0], MODEL_BY_ID.get('bus_c')!, lineIds[0]), 'string');
assert.notEqual(g.demand.weights(station), beforeFleet, 'a paid fleet edit invalidates demand in the same day');
const changed = g.lines.get(lineIds[0])!, removed = rowIds[0][7], oldStops = [...changed.stops];
changed.stops = changed.stops.filter(id => id !== removed); g.lines.rebuild();
assert.ok(!g.demand.weights(station).dest.includes(removed), 'a removed physical call cannot remain in demand');
changed.stops = oldStops; g.lines.rebuild();
assert.ok(g.lines.routing.get(station.id)!.has(removed), 'restoring the actual call restores physical reachability');
console.log('PASS: bounded rotating demand, native routes, lot/fleet/call invalidation, exact cold/warm save replay');
