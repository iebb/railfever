// Actual lane/connector crossing gates and the complete front–tail road footprint.
// Bundle as crossings.mjs. No private saves or imported geometry are needed.
import { Game } from '../src/game/game';
import { RoadVehicle, makeLaneSeg, makeConn, type RSeg } from '../src/game/roadvehicle';
import { curvePoint, type Crossing } from '../src/game/network';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { nodeSnap } from '../src/game/routing';
import { flatGame, station, endNode, depotFor, loco } from './stationlib';
import { build, free, railOpts, roadOpts, check, fails, checkReservations, Train } from './lib';

if (!process.argv[1]?.endsWith('crossings.mjs')) throw new Error('bundle this test as crossings.mjs');

function fixture(fraction = .5, split = false, branch = false, acute = false) {
  const g = flatGame(), net = g.world.net; g.aiEnabled = false; check(g instanceof Game && g.tickSeconds === .05, 'native fixed-step game');
  if (!build(g, free(g, 90, 50), free(g, 90, 90), roadOpts(0, 'road', { tram: true }), 'road lead')) throw Error('road lead');
  const node = [...net.nodes.values()].find(n => Math.abs(n.x - 90) < .01 && Math.abs(n.z - 90) < .01)!;
  if (!build(g, nodeSnap(g, node.id, 'road'), free(g, 150, 180), roadOpts(0, 'road', { tram: true }), 'curved road')) throw Error('curved road');
  const road = [...net.edges.values()].filter(e => e.kind === 'road').at(-1)!;
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  net.pointAt(road, road.len * fraction, p, d);
  const turn = acute ? Math.PI / 3 : 0, ux = d.z * Math.cos(turn) + d.x * Math.sin(turn), uz = -d.x * Math.cos(turn) + d.z * Math.sin(turn), angle = Math.atan2(ux, uz);
  const A = station(g, p.x - ux * 30, p.z - uz * 30, angle, 12, 1)!, B = station(g, p.x + ux * 30, p.z + uz * 30, angle, 12, 1)!;
  if (!A || !B || !build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 1, { crossing: 'level' }), 'level crossing')) throw Error('native crossing');
  const crossing = [...net.crossings.values()].find(c => c.kind === 'level')!;
  if (!crossing) throw Error('missing native crossing');
  if (split) {
    // Preserve an ordinary degree-two split immediately before the protected road window.
    if (!net.splitEdge(crossing.e2, Math.max(.2, crossing.s2 - 1))) throw Error('native road split');
  }
  if (branch && !build(g, nodeSnap(g, node.id, 'road'), free(g, 65, 115), roadOpts(0), 'junction branch')) throw Error('road junction');
  g.flushNetworkChanges();
  return { g, crossing, A, B };
}
function pathFor(f: ReturnType<typeof fixture>, dir: number): RSeg[] {
  const net = f.g.world.net, road = net.edges.get(f.crossing.e2)!;
  const lane = makeLaneSeg(f.g, road, dir), start = dir > 0 ? road.a : road.b, end = dir > 0 ? road.b : road.a;
  const pick = (node: number) => net.nodes.get(node)!.edges.map(id => net.edges.get(id)!).find(e => e.kind === 'road' && e.id !== road.id);
  const before = pick(start), after = pick(end), out: RSeg[] = [];
  if (before) { const s = makeLaneSeg(f.g, before, before.b === start ? 1 : -1); out.push(s); const c = makeConn(s, lane, start); if (c) out.push(c); }
  out.push(lane);
  if (after) { const s = makeLaneSeg(f.g, after, after.a === end ? 1 : -1); const c = makeConn(lane, s, end); if (c) out.push(c); out.push(s); }
  return out;
}
function marker(path: RSeg[], c: Crossing): number {
  let at = 0, best = Infinity, result = 0, p = { x: 0, y: 0, z: 0 };
  for (const s of path) {
    const m = s.crossings.find(q => q.id === c.id);
    if (m) { curvePoint(s.curve, m.pos, p); const d = Math.hypot(p.x - c.x, p.z - c.z); if (d < best) { best = d; result = at + m.pos; } }
    at += s.len;
  }
  return result;
}
function place(v: RoadVehicle, path: RSeg[], distance: number) {
  let i = 0; while (i + 1 < path.length && distance > path[i].len) distance -= path[i++].len;
  v.placeAt(path[i], distance); v.trail = path.slice(0, i).reverse(); v.ahead = path.slice(i + 1); v.ttl = 1e6;
}
function bodyDistance(v: RoadVehicle, c: Crossing) {
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }; v.pointBehind(0, a); v.pointBehind(v.length, b);
  const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
  const q = l2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.z - a.z) * dz) / l2)) : 0;
  return { distance: Math.hypot(a.x + dx * q - c.x, a.z + dz * q - c.z), front: Math.hypot(a.x - c.x, a.z - c.z), tail: Math.hypot(b.x - c.x, b.z - c.z) };
}
function direct(v: RoadVehicle, n: number, inspect: () => void) { for (let i = 0; i < n; i++) { (v as any).drive(.05); inspect(); } }
let lowest = Infinity, count = 0;
for (const [name, fraction, split, branch, acute] of [['curve', .5, false, false, false], ['split', .5, true, false, false], ['junction', .003, false, true, false], ['acute', .5, false, false, true]] as const) {
  for (const dir of [1, -1]) for (const model of [null, MODEL_BY_ID.get('coach_d')!, MODEL_BY_ID.get('tram_e')!]) {
    const f = fixture(fraction, split, branch, acute), saved = JSON.stringify(serialize(f.g)), path = pathFor(f, dir), m = marker(path, f.crossing);
    check(JSON.stringify(serialize(f.g)) === saved, `${name} dir ${dir}: deriving actual lane/connector crossing markers is pure`);
    const v = new RoadVehicle(f.g, 1000001, model, -1, true, 5); v.owner = 0; v.cruise = 2.5;
    place(v, path, Math.max(0, m - 3)); v.speed = 2.5;
    f.g.vehicles.crossingClosed.add(f.crossing.id);
    let min = Infinity;
    direct(v, 300, () => { min = Math.min(min, bodyDistance(v, f.crossing).distance); });
    check(min >= .55, `${name} dir ${dir} ${model?.id ?? 'car'}: swept full body stays outside protected envelope (${min.toFixed(6)})`);
    check(v.speed === 0, `${name} dir ${dir} ${model?.id ?? 'car'}: closed gate holds`);
    lowest = Math.min(lowest, min); count++;
    f.g.vehicles.crossingClosed.clear(); let passed = false;
    direct(v, 300, () => { passed ||= bodyDistance(v, f.crossing).distance < .55; });
    check(passed, `${name} dir ${dir} ${model?.id ?? 'car'}: reopening releases normal passage`);
  }
}
console.log(`${count} actual curved/split/junction approaches: minimum complete-body clearance ${lowest.toFixed(6)}u`);

{
  const f = fixture(), path = pathFor(f, -1), v = new RoadVehicle(f.g, 1000001, null, -1, true, 5);
  place(v, path, marker(path, f.crossing) - .55); v.speed = 0;
  const before = bodyDistance(v, f.crossing).distance, pos = v.pos;
  check(before >= .55 && before < .6, 'fixture lies in the safe stopped band outside the train envelope');
  f.g.vehicles.crossingClosed.add(f.crossing.id); direct(v, 80, () => {});
  check(v.pos === pos && v.speed === 0 && bodyDistance(v, f.crossing).distance >= .55, 'safe stopped band holds rather than admitting a new crossing occupant');
}

// Exact old arc-dead-zone witness, plus a long body whose endpoints alone would miss occupancy.
for (const long of [false, true]) {
  const f = fixture(), path = pathFor(f, -1), m = marker(path, f.crossing);
  const v = new RoadVehicle(f.g, 1000001, long ? MODEL_BY_ID.get('tram_e')! : null, -1, true, 5);
  v.owner = 0;
  place(v, path, m + (long ? v.length / 2 : -.495)); v.speed = 0;
  const before = bodyDistance(v, f.crossing); check(before.distance < .55, `${long ? 'long' : 'dead-zone'} body genuinely occupies crossing`);
  if (long) check(before.front > .55 && before.tail > .55, 'full body occupancy is detected with both endpoints outside');
  f.g.vehicles.crossingClosed.add(f.crossing.id); let clear = false;
  direct(v, 150, () => { clear ||= bodyDistance(v, f.crossing).distance > .6; });
  check(clear && v.speed > 0, `${long ? 'long' : 'dead-zone'} existing occupant clears a newly closed gate`);
}

// A funded train reaches a real crossing, with its ordinary roadBusyNear protection still authoritative.
{
  const f = fixture(), { g, A, B, crossing } = f, dep = depotFor(g, A, B), l = g.lines.create('rail', 0);
  l.stops = [A.id, B.id]; g.lines.rebuild(); const bought = g.vehicles.buyTrain(dep, loco(), l.id);
  check(bought instanceof Train, 'native train is bought at its actual serving depot');
  if (bought instanceof Train) {
    let closed = false;
    for (let i = 0; i < 4000 && !closed; i++) { g.stepTick(); closed = g.vehicles.crossingClosed.has(crossing.id); }
    check(closed, 'native approaching train closes the crossing without fixture gate overrides');
    const path = pathFor(f, -1), v = new RoadVehicle(g, g.vehicles.nextAmbientId++, null, -1, true, 5);
    place(v, path, marker(path, crossing) - .495); v.speed = 0; g.vehicles.ambient.push(v);
    (g.vehicles as any).rebuildOcc();
    check(g.vehicles.roadBusyNear(crossing.e2, crossing.x, crossing.z, .55), 'native train sees the whole occupied car footprint');
    const checkpoint = serialize(g), twin = deserialize(checkpoint);
    check(JSON.stringify(serialize(twin)) === JSON.stringify(checkpoint), 'occupied crossing checkpoint roundtrips exactly');
    let exact = true, clear = false, calls = 0, previous = bought.state, guardedTicks = 0, protection = true, minimumRailGap = Infinity;
    for (let i = 0; i < 640; i++) {
      const occupied = g.vehicles.roadBusyNear(crossing.e2, crossing.x, crossing.z, .55);
      g.stepTick(); twin.stepTick(); exact &&= JSON.stringify(serialize(g)) === JSON.stringify(serialize(twin));
      if (occupied) {
        guardedTicks++;
        // Depot construction may have split the crossed rail since the original plan.
        const liveCrossing = g.world.net.crossings.get(crossing.id)!;
        let off = -bought.headPos, gap = Infinity;
        for (let j = bought.headSeg; j < bought.segs.length; j++) {
          const s = bought.segs[j];
          if (s.e === liveCrossing.e1) { gap = off + (s.dir > 0 ? liveCrossing.s1 : s.len - liveCrossing.s1); break; }
          off += s.len;
        }
        minimumRailGap = Math.min(minimumRailGap, gap);
        protection &&= gap >= .2;
      }
      if (bought.state === 'loading' && previous !== 'loading') calls++; previous = bought.state;
      clear ||= !g.vehicles.roadBusyNear(crossing.e2, crossing.x, crossing.z, .55);
    }
    check(exact, 'every one of 640 crossing/train/ambient/demand/world ticks replays exactly');
    check(guardedTicks > 0 && Number.isFinite(minimumRailGap) && protection, `train stays before the occupied crossing throughout ${guardedTicks} guarded ticks (${minimumRailGap.toFixed(6)}u minimum front gap)`);
    // Native braking/acceleration and the rest of the route take longer than the replay window.
    for (let i = 640; i < 4000 && calls === 0; i++) { g.stepTick(); if (bought.state === 'loading' && previous !== 'loading') calls++; previous = bought.state; }
    check(clear, 'occupied car leaves the protected envelope during the 640-tick replay');
    check(clear && calls > 0, `occupant clears and guarded train completes native station calls (${calls})`);
    check(checkReservations(g).length === 0 && checkReservations(twin).length === 0, 'native reservations remain consistent');
    console.log(`native guarded train: ${calls} calls; every 640 ticks exact; ${guardedTicks} guarded ticks, rail gap ${minimumRailGap.toFixed(6)}u; ${bought.state}/${bought.status}; car clearance ${bodyDistance(v, crossing).distance.toFixed(6)}`);
  }
}
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CROSSING CHECKS PASSED'); process.exitCode = fails.length ? 1 : 0;
