// City and inter-city demand sets (demand.ts DemandSet): trips within a town are city trips, trips between towns
// inter-city trips; the two sets add up to the previous single model; forecasts by set (a city bus on city demand, a
// coach on inter-city demand); passengers keep their set through a change of vehicle; old saves load and new saves
// replay exactly.
// npx esbuild scripts/demandsets.ts --bundle --platform=node --format=esm --outfile=$S/demandsets.mjs && node $S/demandsets.mjs [fixture dir]
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../src/game/game';
import { World } from '../src/game/world';
import { bezLine } from '../src/game/geom';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { plannedSet, DEMAND_SETS, stationDemand, demandView } from '../src/game/demand';
import { urbanIntensity } from '../src/game/fares';
import { addBusStop, roadDepotNear, checkNaN, checkReservations } from './lib';

const fixtures = process.argv[2] ?? 'scripts/fixtures/saves';
const close = (a: number, b: number, rel = 1e-9, label = '') =>
  assert.ok(Math.abs(a - b) <= rel * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} vs ${b}`);

// ------------------------------------------------------------------ a small native network: three towns in rows
const g = new Game({ size: 384, seed: 11, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990 }, new World(384));
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
  const t: any = { id: row, name: `Row ${row}`, x: 160, z: z + 3, angle: 0, pop: 0, radius: 145,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0,
    passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  rowIds.push(Array.from({ length: 12 }, (_, i) => {
    const id = addBusStop(g, 40 + 22 * i, z, 0); assert.ok(id >= 0, `stop ${row}/${i}`);
    g.stations.get(id)!.townId = row; return id;
  }));
  for (let x = 20; x <= 290; x += 6) {
    const b = g.world.addBuilding({ townId: row, x, z: z + 3, angle: Math.PI, w: 1, d: 1, type: 4,
      floors: 4, pop: 60, seed: x + row * 512, y: 3, built: 0 });
    t.buildings.add(b.id); t.pop += b.pop;
  }
  const depot = roadDepotNear(g, 160, z, 0); assert.ok(depot >= 0); depots.push(depot);
  const l = g.lines.create('road', 0); l.stops = [...rowIds[row]]; l.evenSpacing = false; lineIds.push(l.id);
  for (let i = 0; i < 3; i++) assert.notEqual(typeof g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, l.id), 'string');
}
// a coach between the towns' first stops: inter-city trips change to it from the city buses
road(30, 50, 30, 120); road(30, 120, 30, 190);
const coach = g.lines.create('road', 0); coach.stops = rowIds.map(ids => ids[0]); coach.evenSpacing = false;
for (let i = 0; i < 3; i++) assert.notEqual(typeof g.vehicles.buyRoad(depots[0], MODEL_BY_ID.get('bus_c')!, coach.id), 'string');
g.initializeHeadquarters();
g.demand.rebuild(); g.lines.rebuild(); g.flushNetworkChanges(); g.lines.flushCatchment();
for (let i = 0; i < 40; i++) g.stepTick();
const m = g.demand, R = m.regions, n = R.length;
const townOf = (id: number) => g.stations.get(id)?.townId ?? -1;

// ------------------------------------------------------------------ 1. the sets by geography, and their sum
{
  assert.ok(n > 3, 'towns of 1,500+ are split into districts');
  const snap = m.tripSnapshot();
  let city = 0, inter = 0;
  for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) {
    const all = m.trips(r, q), c = m.trips(r, q, 'city'), i = m.trips(r, q, 'intercity'), same = R[r].town === R[q].town;
    // the previous single model: local OD (urban uplift within a town) plus long-distance trips
    const town = g.towns.list[R[r].town];
    const previous = R[r].produced * m.od[r * n + q] * (same && town ? 1 + 6 * urbanIntensity(g, { ...R[r], townId: town.id }) : 1)
      + R[r].pop * m.ld[r * n + q];
    close(all, previous, 1e-12, `trips ${r}->${q} equal the previous model`);
    assert.equal(c + i, all, `trips ${r}->${q}: city + inter-city = all`);
    assert.equal(same ? i : c, 0, `trips ${r}->${q}: ${same ? 'within a town: city' : 'between towns: inter-city'}`);
    assert.equal(m.setOf(r, q), same ? 'city' : 'intercity');
    for (const set of [...DEMAND_SETS, 'all'] as const) assert.equal(snap.trips(r, q, set), m.trips(r, q, set), 'snapshot by set');
    city += c; inter += i;
  }
  assert.ok(city > 0 && inter > 0, `both sets have trips (city ${city.toFixed(1)}, inter-city ${inter.toFixed(1)} a month)`);
  console.log(`  trips a month: city ${city.toFixed(1)}, inter-city ${inter.toFixed(1)}`);
}

// ------------------------------------------------------------------ 2. station destinations: totals conserved
let expectInter = 0, expectAll = 0;
{
  for (const st of g.stations.map.values()) {
    const dw = m.weights(st);
    if (!dw.dest.length) continue;
    close(dw.w.reduce((a, b) => a + b, 0), dw.served, 1e-12, 'served is the sum of the weights');
    close(dw.city.reduce((a, b) => a + b, 0), dw.cityServed, 1e-12, 'cityServed is the sum of the city weights');
    dw.dest.forEach((d, i) => {
      assert.ok(dw.city[i] >= 0 && dw.city[i] <= dw.w[i], 'a city part within its weight');
      assert.equal(dw.city[i], townOf(d) === st.townId ? dw.w[i] : 0, `${st.id}->${d}: ${townOf(d) === st.townId ? 'all city' : 'all inter-city'} trips`);
    });
    const city = m.stationDemand(st, 'city'), inter = m.stationDemand(st, 'intercity');
    close(city.served + inter.served, dw.served, 1e-12, 'the sets add up to the station rate factor');
    assert.equal(m.stationDemand(st), dw, 'all: the weights themselves');
    expectAll += dw.served * g.demand.generationPopulation(st); expectInter += inter.served * g.demand.generationPopulation(st);
  }
  assert.ok(expectInter > 0 && expectInter < expectAll, 'stations send passengers of both sets');
}

// ------------------------------------------------------------------ 3. forecasts by set
{
  const city = rowIds[0].map(id => g.stations.get(id)!);
  assert.deepEqual(plannedSet(g, city), { set: 'city', access: true }, 'a line within one town is planned on city demand (and access legs)');
  const quote = (pts: typeof city, o?: Parameters<typeof m.forecastLine>[8]) => m.forecastLine(pts, 'mainline', 25, 120, 0, undefined, undefined, 'bus', o);
  const all = quote(city), explicit = quote(city, { set: 'all' }), planned = quote(city, plannedSet(g, city)), strict = quote(city, { set: 'city' });
  assert.deepEqual(explicit, all, 'set "all" is the previous forecast');
  assert.ok(all.sets.city.boardings > 0, 'a city bus carries city trips');
  close(all.sets.city.boardings + all.sets.intercity.boardings, all.boardings, 1e-9, 'city bus: sets add up');
  close(all.sets.intercity.access.boardings, all.sets.intercity.boardings, 1e-9, 'city bus: its inter-city riders are all on access legs');
  close(planned.boardings, all.boardings, 1e-9, 'city bus planned on city demand plus access legs');
  close(strict.boardings, all.sets.city.boardings, 1e-9, 'strict city set');
  close(strict.revenue, all.sets.city.revenue, 1e-9, 'strict city receipts');
  console.log(`  city bus: ${all.boardings.toFixed(0)} a year, city ${all.sets.city.boardings.toFixed(0)}, inter-city ${all.sets.intercity.boardings.toFixed(0)}`);

  const ends = [rowIds[0][0], rowIds[2][0]].map(id => g.stations.get(id)!);
  assert.deepEqual(plannedSet(g, ends, 'bus'), { set: 'intercity' }, 'a coach between towns is planned on inter-city demand');
  assert.deepEqual(plannedSet(g, ends), { set: 'intercity', cityLegs: true }, 'a railway between towns: inter-city, and city trips on its legs in town');
  const c2 = quote(ends, plannedSet(g, ends, 'bus')), c2all = quote(ends);
  assert.ok(c2.boardings > 0, 'a coach between towns has inter-city riders');
  assert.equal(c2all.sets.city.boardings, 0, 'a coach between two towns carries no city trips');
  close(c2.boardings, c2all.boardings, 1e-9, 'coach: inter-city is everything');
  // an intermediate coach stop in the first town: the city trips between its two stops are not inter-city demand
  const via = [rowIds[0][0], rowIds[0][8], rowIds[2][0]].map(id => g.stations.get(id)!);
  const v = quote(via, plannedSet(g, via, 'bus')), vall = quote(via);
  assert.ok(vall.sets.city.boardings > 0, 'city trips between two stops in one town');
  assert.ok(v.boardings < vall.boardings && v.boardings > 0, 'the coach is planned on its inter-city riders only');
  close(v.boardings, vall.boardings - vall.sets.city.boardings, 1e-9, 'inter-city = all less city');
  close(v.revenue, vall.revenue - vall.sets.city.revenue, 1e-9, 'inter-city receipts = all less city');
  close(vall.sets.city.revenue + vall.sets.intercity.revenue, vall.revenue, 1e-9, 'coach with a town stop: sets add up');
  assert.ok(v.legLoads.every((x, i) => x <= vall.legLoads[i] + 1e-9), 'inter-city leg loads within the totals');
  // the same stops served by a railway: its legs in the first town carry that town's city trips too
  const r = quote(via, plannedSet(g, via));
  close(vall.sets.city.town.boardings, vall.sets.city.boardings, 1e-9, 'here every city trip rides a leg within its town');
  close(r.boardings, vall.boardings, 1e-9, 'inter-city plus city trips on legs in town');
  close(r.revenue, v.revenue + vall.sets.city.town.revenue, 1e-9, 'its receipts: inter-city plus city in town');
  console.log(`  coach via a town stop: all ${vall.boardings.toFixed(0)}, inter-city ${v.boardings.toFixed(0)} (city ${vall.sets.city.boardings.toFixed(0)})`);
}

// ------------------------------------------------------------------ 4. passengers keep their set to the destination
{
  for (const st of g.stations.map.values()) st.genAccum = 1;
  let transferred = 0, egress = 0, aboard = 0, gen = 0, genInter = 0;
  const check = () => {
    for (const st of g.stations.map.values()) for (const w of st.waiting.values()) {
      if (st.townId !== townOf(w.dest)) assert.equal(w.ic, 1, `waiting at ${st.id} for ${w.dest} in another town: inter-city`);
      if ((w.transfers ?? 0) > 0) {
        assert.equal(w.ic, 1, 'only inter-city trips change vehicles in this network');
        transferred += w.count;
        if (st.townId === townOf(w.dest)) egress += w.count;
      }
    }
    aboardCheck();
  };
  // (a bus ride takes days: the cargo is looked at more often)
  const aboardCheck = () => {
    for (const v of g.vehicles.map.values()) for (const c of v.cargo.values()) {
      if (townOf(c.from) !== townOf(c.dest)) assert.equal(c.ic, 1, 'aboard between towns: inter-city');
      // inter-city trips on a city bus: the leg to the coach
      if (c.ic && lineIds.includes(v.lineId ?? -1)) aboard += c.count;
    }
  };
  for (let day = 0; day < 200; day++) {
    for (let t = 0; t < 40; t++) { g.stepTick(); if (t % 8 === 7) aboardCheck(); }
    check();
    if (g.day % 30 === 0) for (const st of g.stations.map.values()) { gen += st.genLast; genInter += st.icGenLast ?? 0; }
  }
  assert.equal(checkNaN(g), null); assert.deepEqual(checkReservations(g), []);
  assert.ok(transferred > 0 && egress > 0, `inter-city passengers wait for their last leg after a change (${egress})`);
  assert.ok(aboard > 0, `inter-city passengers ride a city bus to the coach (${aboard})`);
  assert.ok(genInter > 0 && genInter < gen, 'both sets are generated');
  // the generated split follows the station weights (sampling noise of a few hundred passengers)
  const share = genInter / gen, expected = expectInter / expectAll;
  assert.ok(Math.abs(share - expected) < 0.35 * expected + 0.02, `inter-city share ${share.toFixed(3)} near the weights' ${expected.toFixed(3)}`);
  const view = demandView(g);
  assert.ok(view.towns.every(t => Math.abs(t.potential - t.local - t.intercity) <= 1e-6 * Math.max(1, t.potential)), 'town potential = city + inter-city');
  assert.ok(view.setFlows!.city.every(f => R[f.a].town === R[f.b].town) && view.setFlows!.intercity.every(f => R[f.a].town !== R[f.b].town), 'flows by set');
  const waits = stationDemand(g, rowIds[2][0]), ic = stationDemand(g, rowIds[2][0], 'intercity'), cc = stationDemand(g, rowIds[2][0], 'city');
  assert.equal(waits.reduce((a, e) => a + e.count, 0), ic.reduce((a, e) => a + e.count, 0) + cc.reduce((a, e) => a + e.count, 0), 'waiting by set adds up');
  console.log(`  generated ${gen}, inter-city ${genInter} (${(100 * share).toFixed(1)}%, weights ${(100 * expected).toFixed(1)}%); inter-city passengers waiting for their last leg after a change: ${egress} (summed daily)`);
}

// ------------------------------------------------------------------ 5. exact replay of a new save
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
{
  const saved = serialize(g);
  assert.equal(saved.demandSets, 1, 'new saves mark their demand sets');
  assert.ok(saved.stations.some((s: any) => s.waiting.some((w: any) => w.ic === 1)), 'waiting groups save their set');
  assert.ok(saved.vehicles.some((v: any) => v.cargo.some((c: any) => c.ic === 1)), 'cargo groups save their set');
  const twin = deserialize(JSON.parse(JSON.stringify(saved))); twin.aiEnabled = false; twin.vehicles.ambientEnabled = false;
  equalSave(g, twin, 'identical right after loading');
  for (let i = 0; i < 40 * 35; i++) {
    g.stepTick(); twin.stepTick();
    if ((i + 1) % 200 === 0) equalSave(g, twin, 'queues, sets and counters continue identically after loading');
  }
  equalSave(g, twin, 'identical across a month end');
}

// ------------------------------------------------------------------ 6. older saves load (their groups split by towns)
const olds = ['legacy-v2.9.json', 'aiw2000.json'].map(f => join(fixtures, f)).filter(existsSync);
if (!olds.length) console.log(`  SKIPPED old saves: no legacy fixture in ${fixtures}`);
let connecting = 0;
for (const file of olds) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.demandSets, undefined, 'a save from before the demand sets');
  const old = deserialize(raw);
  const town = (id: number) => old.stations.get(id)?.townId ?? -1;
  const rule = (at: number, dest: number) => (town(at) >= 0 && town(at) === town(dest) ? undefined : 1);
  let groups = 0, inter = 0, cargo = 0;
  for (const st of old.stations.map.values()) for (const w of st.waiting.values()) {
    assert.equal(w.ic, rule(st.id, w.dest), 'a legacy waiting group: set by the towns of its station and destination');
    groups++; if (w.ic) inter += w.count;
  }
  for (const v of old.vehicles.map.values()) for (const c of v.cargo.values()) {
    assert.equal(c.ic, rule(c.from, c.dest), 'a legacy cargo group: set by the towns of its boarding stop and destination');
    cargo++;
  }
  assert.ok(groups > 0, 'the fixture has waiting passengers');
  // the forecasts of the AI's railways (connections included): sets add up, a planned quote is within the total
  for (const rail of [...old.lines.map.values()].filter(l => l.kind === 'rail' && l.vehicles.length && new Set(l.stops).size >= 2)) {
    const pts = [...new Set(rail.stops)].map(id => old.stations.get(id)!);
    const all = old.demand.forecastLine(pts, 'mainline', 60, 300, rail.owner, rail.id);
    const on = old.demand.forecastLine(pts, 'mainline', 60, 300, rail.owner, rail.id, undefined, 'rail', plannedSet(old, pts));
    close(all.sets.city.boardings + all.sets.intercity.boardings, all.boardings, 1e-9, 'railway: sets add up');
    close(all.sets.city.revenue + all.sets.intercity.revenue, all.revenue, 1e-9, 'railway: receipts add up');
    close(all.sets.city.transfers + all.sets.intercity.transfers, all.transfers, 1e-9, 'railway: connecting riders add up');
    assert.ok(on.boardings <= all.boardings + 1e-9 && on.revenue <= all.revenue + 1e-9, 'a planned set within the total');
    connecting += all.transfers;
  }
  // saved again (with sets), the upgraded game replays exactly
  const resave = serialize(old);
  assert.equal(resave.demandSets, 1, 'saved again with sets');
  const upgraded = deserialize(JSON.parse(JSON.stringify(resave))), twin = deserialize(JSON.parse(JSON.stringify(serialize(upgraded))));
  equalSave(upgraded, twin, 'an upgraded old save saves and loads exactly');
  for (let i = 0; i < 40 * 31; i++) { upgraded.stepTick(); twin.stepTick(); }
  equalSave(upgraded, twin, 'an upgraded old save replays exactly');
  assert.equal(checkNaN(upgraded), null);
  const counted = [...upgraded.stations.map.values()].filter(st => st.genLast > 0);
  assert.ok(counted.length > 0 && counted.every(st => st.icGenLast !== undefined && st.icGenLast <= st.genLast), 'monthly counts by set after a month');
  assert.ok([...upgraded.lines.map.values()].every(l => l.icPassLast === undefined || l.icPassLast <= l.passLast), 'line boardings by set within the total');
  console.log(`  ${file.split('/').pop()}: ${groups} waiting groups (${inter} inter-city passengers), ${cargo} cargo groups split by towns`);
}
if (olds.length) assert.ok(connecting > 0, 'a railway forecast with connecting riders');

console.log('PASS: city / inter-city sets by geography, conserved totals, forecasts by set, sets kept through changes, saves');
