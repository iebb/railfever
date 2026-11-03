// Pure directed road quotes against the actual isolated native driver, not an estimator mirroring itself.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { nativeRoadItinerary, evaluateNativeRoadCycle } from '../src/game/road-physics';
import { RoadVehicle, makeLaneSeg, roadAcceleration } from '../src/game/roadvehicle';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack } from '../src/game/lines';
import { addPattern } from '../src/game/patterns';
import { roadCurbRoute } from '../src/game/ai-bus';

function fixture(points: number[][], h: (x: number, z: number) => number, loop = true) {
  const g = Game.create({ size: 128, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1980 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.vehicles.ambient = [];
  for (let z = 0; z <= 128; z++) for (let x = 0; x <= 128; x++) g.world.h[g.world.vi(x, z)] = h(x, z);
  g.world.heightsVersion++;
  const net = g.world.net, nodes = points.map(([x, z]) => net.addNode('road', x, h(x, z), z));
  const stops: number[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length], length = Math.hypot(a.x - b.x, a.z - b.z);
    const prof = Float32Array.from({ length: Math.ceil(length) + 1 }, (_, j) => h(a.x + (b.x - a.x) * j / Math.ceil(length), a.z + (b.z - a.z) * j / Math.ceil(length)));
    const edge = net.addEdge('road', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), prof, [], 'street', -1);
    const p = { x: 0, y: 0, z: 0 }; net.pointAt(edge, edge.len / 2, p);
    assert.equal(g.stations.commitBusStop(p.x, p.z, 0), null);
    stops.push(g.stations.nextId - 1);
  }
  const l = g.lines.create('road', 0); l.stops = loop ? stops : outAndBack(stops); l.loop = loop; l.evenSpacing = false;
  return { g, l, stops };
}

function nativeCycle(source: Game, line: number, model: VehicleModel) {
  const g = deserialize(serialize(source)), l = g.lines.get(line)!, route = nativeRoadItinerary(g, l)!;
  const v = new RoadVehicle(g, g.vehicles.nextId++, model, -1);
  v.owner = l.owner; v.lineId = l.id; l.vehicles = [v.id]; g.vehicles.map.clear(); g.vehicles.map.set(v.id, v);
  const first = route.legs[0].parts[0], startIndex = l.stops.findIndex(id => id === route.stops[0]);
  v.stopIndex = startIndex; v.placeAt(makeLaneSeg(g, g.world.net.edges.get(first.seg.e)!, first.seg.dir), first.from);
  v.load = model.capacity * 0.5; v.mailLoad = (model.mail ?? 0) * 0.5;
  let elapsed = 0, done = false, arrivals = 0;
  // Handle mass consistently while excluding demand and fare mutations from this independent physical oracle.
  v.serveStation = () => { v.load = model.capacity * 0.5; v.mailLoad = (model.mail ?? 0) * 0.5; if (++arrivals === route.stops.length) done = true; return 2; };
  v.depart();
  for (let k = 0; k < 60000 && !done; k++) { g.tick++; g.vehicles.update(g.tickSeconds); elapsed += g.tickSeconds; }
  assert(done, 'native driver completes the directed cycle');
  // Initial depart has no handling; include destination handling at the final arrival for a full cycle.
  return elapsed + 2;
}

const bus = MODEL_BY_ID.get('bus_a')!, coach = MODEL_BY_ID.get('coach_a')!, postbus = MODEL_BY_ID.get('postbus_a')!;
for (const [name, points, terrain, loop] of [
  ['sharp triangle', [[20, 20], [108, 20], [66, 105]], () => 3, true],
  ['steep asymmetric return', [[25, 25], [100, 25], [100, 95], [25, 95]], (x: number, z: number) => 3 + 0.07 * (x - 25) + Math.sin(z * 0.12) * 0.5, false],
  ['short corner legs', [[60, 60], [66, 60], [66, 66], [60, 66]], () => 3, true],
] as const) {
  const { g, l } = fixture(points.map(p => [...p]), terrain, loop), before = JSON.stringify(serialize(g));
  const route = nativeRoadItinerary(g, l)!; assert(route);
  const descriptor = { id: -1, owner: l.owner, kind: l.kind, stops: [...l.stops], loop: l.loop } as typeof l;
  assert.deepEqual(evaluateNativeRoadCycle(g, descriptor, bus), evaluateNativeRoadCycle(g, l, bus), 'unregistered route descriptors may quote existing committed stop targets');
  const base = evaluateNativeRoadCycle(g, l, bus)!, slower = evaluateNativeRoadCycle(g, l, { ...bus, speed: bus.speed / 2 })!;
  assert.notEqual(slower, base, 'different model properties get their own physical quote');
  assert(slower.cycle >= base.cycle, 'a lower maximum speed cannot shorten the native trip, even where corners already limit speed');
  const mail = evaluateNativeRoadCycle(g, l, postbus)!, noMail = evaluateNativeRoadCycle(g, l, { ...postbus, mail: 0 })!;
  assert.notEqual(mail, noMail, 'mail capacity participates in the physical quote cache key');
  assert(mail.cycle >= noMail.cycle, 'half a mail payload cannot make the native postbus faster');
  if (name === 'sharp triangle') assert(mail.cycle > noMail.cycle, 'mail payload changes actual acceleration-limited running time');
  const previous = roadCurbRoute(g, l);
  assert.deepEqual([...route.calls], [...previous.calls], 'canonical itinerary preserves native curb identity');
  assert.deepEqual(route.sites.map(s => s.station.id), route.stops);
  assert(route.legs.every((leg, i) => leg.from === route.stops[i] && leg.to === route.stops[(i + 1) % route.stops.length]));
  for (const model of [bus, coach, postbus]) {
    const quote = evaluateNativeRoadCycle(g, l, model)!; assert(quote);
    const actual = nativeCycle(g, l.id, model), error = Math.abs(quote.cycle / actual - 1);
    console.log(`${name} ${model.id}: quoted ${quote.cycle.toFixed(2)} s, native ${actual.toFixed(2)} s (${(error * 100).toFixed(2)}%)`);
    assert(error < 0.05, `${name}: native free-flow quote is within 5%`);
    assert.equal(evaluateNativeRoadCycle(g, l, model), quote, 'unchanged model/itinerary quote is cached');
    const loaded = deserialize(serialize(g));
    assert.deepEqual(evaluateNativeRoadCycle(loaded, loaded.lines.get(l.id)!, model), quote, 'cold save/load geometry gives identical quote');
  }
  assert.equal(JSON.stringify(serialize(g)), before, 'cold and warm quotes leave all saved state unchanged');
  const replay = deserialize(serialize(g)), replayLine = replay.lines.get(l.id)!, start = route.legs[0].parts[0];
  const vehicle = new RoadVehicle(replay, replay.vehicles.nextId++, bus, -1);
  vehicle.lineId = replayLine.id; vehicle.stopIndex = replayLine.stops.indexOf(route.stops[0]);
  replayLine.vehicles = [vehicle.id]; replay.vehicles.map.set(vehicle.id, vehicle);
  vehicle.placeAt(makeLaneSeg(replay, replay.world.net.edges.get(start.seg.e)!, start.seg.dir), start.from); vehicle.depart();
  const saved = serialize(replay), warm = deserialize(saved), cold = deserialize(saved);
  evaluateNativeRoadCycle(warm, warm.lines.get(l.id)!, bus);
  // Surveying only one side must not change native movement, vehicle RNG, or the fixed-step replay.
  for (let i = 0; i < 256; i++) { warm.stepTick(); cold.stepTick(); }
  assert(JSON.stringify(serialize(warm)) === JSON.stringify(serialize(cold)), 'quoted native vehicle replays exactly against cold unquoted copy');
  const cached = nativeRoadItinerary(g, l); g.day++; g.demand.version++;
  assert.equal(nativeRoadItinerary(g, l), cached, 'day/demand changes retain structural geometry');
  const express = addPattern(g, l.id, 'express', l.stops.map((_, i) => i !== 1))!;
  assert(nativeRoadItinerary(g, l, express.id), 'short-turn/express patterns have their own directed cycle');
  const native = evaluateNativeRoadCycle(g, l, bus)!;
  l.stops = [...l.stops].reverse();
  assert.notEqual(evaluateNativeRoadCycle(g, l, bus), native, 'in-place route edits invalidate geometry and model quote');
  const prospective = { ...l, stops: [l.stops[0], 999999] };
  const pending = JSON.stringify(serialize(g));
  assert.equal(nativeRoadItinerary(g, prospective), null, 'uncommitted/missing targets request explicit survey fallback');
  assert.equal(evaluateNativeRoadCycle(g, prospective, bus), null);
  assert.equal(JSON.stringify(serialize(g)), pending, 'prospective refusal creates no temporary target or metadata');
}
// Raw historical stop positions inside a junction trim clamp to the native lane endpoint. Float32
// cumulative arcs can round past the double curve length; they remain a valid, shared physical berth.
{
  const { g, l } = fixture([[20, 20], [108, 20], [66, 105]], () => 3);
  const move = (s: number) => {
    for (const sid of l.stops) {
      const st = g.stations.get(sid)!, stop = st.stops[0], edge = g.world.net.edges.get(stop.edge)!;
      const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(edge, s, p);
      Object.assign(stop, { s, x: p.x, z: p.z }); st.x = p.x; st.z = p.z;
    }
  };
  move(0.05);
  const first = nativeRoadItinerary(g, l)!, quote = evaluateNativeRoadCycle(g, l, bus)!;
  assert(first && quote, 'junction-clamped native berths have complete directed geometry');
  const actual = nativeCycle(g, l.id, bus);
  assert(Math.abs(quote.cycle / actual - 1) < 0.05, 'junction-clamped quote matches actual native driving');
  move(0.1);
  assert.deepEqual([...nativeRoadItinerary(g, l)!.calls], [...first.calls], 'different raw coordinates retain the same native curb');
  assert.deepEqual(evaluateNativeRoadCycle(g, l, bus), quote, 'endpoint clamping preserves exact physical leg times');
}
// Preserve exact operation order in the native acceleration extraction, including minimum-speed denominator.
for (const speed of [0, 0.2, 1.3]) for (const grade of [-0.15, 0, 0.15]) {
  const power = 140, mass = 12, tract = Math.min(1.6, power / (mass * Math.max(3, speed * 10)));
  assert.equal(roadAcceleration(power, mass, speed, grade), (tract - 0.02) / 10 - 0.981 * grade);
}
console.log('ALL CHECKS PASSED');
