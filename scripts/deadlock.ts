// Bundle as deadlock.mjs with esbuild and run with node.
import '../src/game/patterns';
import { Game, TICK, TICKS_PER_DAY } from '../src/game/game';
import { Train, deadlockCycles, resolveDeadlocks } from '../src/game/train';
import { setSignal } from '../src/game/signals';
import { connectStationThroat } from '../src/game/trackops';
import { buildDepotOnLine } from '../src/game/routing';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { outAndBack } from '../src/game/lines';
import { serialize, deserialize } from '../src/game/save';
import { station, endNode, depotFor, loco, build, nodeSnap, railOpts, check, fails, done } from './stationlib';
import { checkReservations } from './lib';

if (!process.argv[1]?.endsWith('deadlock.mjs')) throw new Error('bundle this test as deadlock.mjs');

function flatGame() {
  const g = Game.create({ size: 256, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  g.aiEnabled = false;
  g.vehicles.ambientEnabled = false;
  g.world.h.fill(3); g.world.heightsVersion++;
  for (const t of g.world.trees) if (t) g.world.removeTreesNear(t.x, t.z, 0.1);
  for (const c of g.companies) c.economy.money = 1e9;
  return g;
}

interface Fixture { g: Game; a: Train; b: Train; following?: Train[] }

function fixture(queued = false): Fixture {
  const g = flatGame();
  const A = station(g, 40, 128, Math.PI / 2, 12, 2, 0)!;
  const B = station(g, 145, 128, Math.PI / 2, 12, 1, 0)!;
  const C = station(g, 205, 128, Math.PI / 2, 12, 2, 1)!;
  if (!A || !B || !C) throw new Error('stations');
  check(!!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'A-B'), 'shared single track A-B built');
  check(!!build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(1), 'B-C'), 'shared single track B-C built');
  for (const front of [false, true]) {
    const n = g.world.net.nodes.get(endNode(g, B, 0, front))!;
    const e = n.edges.map(id => g.world.net.edges.get(id)!).find(e => e.station < 0)!;
    const s = e.a === n.id ? 0 : e.len;
    check(!setSignal(g, e.id, front ? (e.a === n.id ? 2 : e.len - 2) : s, 'twoway', true, e.owner), 'path signal at the junction platform');
  }
  for (const st of [A, C]) check(connectStationThroat(g, st.id, st.owner).connected === 1, 'passing platform connected');
  const dA = depotFor(g, A, B, 0), dC = depotFor(g, C, B, 1);
  check(dA >= 0 && dC >= 0, 'both companies have depots');
  const l = g.lines.create('rail', 0);
  l.stops = outAndBack([A.id, B.id, C.id]); l.evenSpacing = false;
  g.lines.setPartnerPolicy(l.id, 'open');
  check(g.lines.join(l.id, 1) === null, 'company 1 joins the line');
  g.lines.rebuild();
  if (queued) for (const x of [95, 177]) {
    const n = g.world.net.nearestEdge(x, 128.225, 0.5, 'rail')!;
    check(!setSignal(g, n.edge.id, n.s, 'twoway', true, n.edge.owner), 'following trains have separate approach sections');
  }
  const a = g.vehicles.buyTrain(dA, loco(), l.id), b = g.vehicles.buyTrain(dC, loco(), l.id);
  if (!(a instanceof Train) || !(b instanceof Train)) throw new Error(`train purchase: ${a}, ${b}`);
  a.stopIndex = 1; b.stopIndex = 3;
  const following: Train[] = [];
  if (queued) {
    const fa = g.vehicles.buyTrain(dA, loco(), l.id), fb = g.vehicles.buyTrain(dC, loco(), l.id);
    if (!(fa instanceof Train) || !(fb instanceof Train)) throw new Error(`following train purchase: ${fa}, ${fb}`);
    fa.stopIndex = 1; fb.stopIndex = 3;
    following.push(fa, fb);
  }
  return { g, a, b, following };
}

/** The first train stops with its tail still inside a siding depot. The other approaches the same signal. */
function depotFixture(block: boolean, starters = true) {
  const g = flatGame(), net = g.world.net;
  const A = station(g, 55, 128, Math.PI / 2, 40, 2, 0)!;
  const C = station(g, 205, 128, Math.PI / 2, 40, 2, 1)!;
  if (!A || !C) throw new Error('depot fixture stations');
  check(!!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(0), 'single track'), 'depot fixture single track built');
  check(g.requestAccess(1, 0) === 'granted', 'depot operator has track access');
  // The player builds this shared fixture: AI operators may use player rail but cannot alter it.
  check(g.requestAccess(0, 1) === 'granted', 'player fixture builder has access to the partner station');
  for (const st of [A, C]) check(connectStationThroat(g, st.id, 0).connected === 1, 'depot fixture passing platform connected');
  const ne = net.nearestEdge(135, 128.225, 0.5, 'rail')!;
  const siding = buildDepotOnLine(g, ne.edge.id, ne.s, 1), home = depotFor(g, A, C, 0);
  check(siding >= 0 && home >= 0, 'a siding depot and a station depot built');
  const sig = net.nearestEdge(132, 128.225, 0.5, 'rail')!;
  check(!setSignal(g, sig.edge.id, sig.s, 'twoway', true, 0, { signalKind: block ? 'block' : 'path' }), 'short depot exit signal placed');
  if (block && starters) for (const x of [95, 165]) {
    const ne = net.nearestEdge(x, 128.225, 0.5, 'rail')!;
    check(!setSignal(g, ne.edge.id, ne.s, 'twoway', true, ne.edge.owner), 'path signal keeps the passing platforms outside the block');
  }
  const l = g.lines.create('rail', 0); l.stops = [A.id, C.id]; l.evenSpacing = false;
  g.lines.setPartnerPolicy(l.id, 'open');
  check(g.lines.join(l.id, 1) === null, 'siding operator joins the shared line');
  g.lines.rebuild();
  const cars = [MODEL_BY_ID.get('diesel_b')!, ...Array.from({ length: 12 }, () => MODEL_BY_ID.get('coach_ic')!)];
  let a: Train | string, b: Train | string;
  if (block && starters) {
    b = g.vehicles.buyTrain(home, loco(), l.id);
    if (!(b instanceof Train)) throw new Error(b);
    b.stopIndex = 1;
    const left = net.nearestEdge(110, 128.225, 0.5, 'rail')!.edge.id;
    for (let i = 0; !g.vehicles.getRes(left) && i < 100 * TICKS_PER_DAY; i++) g.stepTick();
    check(g.vehicles.getRes(left) === b.id, 'opposing train reserves the approach before the siding departure');
    a = g.vehicles.buyTrain(siding, cars, l.id);
  } else {
    a = g.vehicles.buyTrain(siding, cars, l.id); b = g.vehicles.buyTrain(home, loco(), l.id);
  }
  if (!(a instanceof Train) || !(b instanceof Train)) throw new Error(`depot fixture train purchase: ${a}, ${b}`);
  a.stopIndex = 0; b.stopIndex = 1;
  return { g, a, b };
}

const saved = (g: Game) => JSON.stringify(serialize(g));
// Terrain is immutable in these townless fixtures. Compare all other saved state at every tick, and full saves daily.
const dynamic = (g: Game) => { const { world, ...state } = serialize(g); return JSON.stringify(state); };
const geometry = (t: Train) => [0, t.length / 2, t.length].map(d => {
  const p = { x: 0, y: 0, z: 0 }; const s = t.pointBehind(d, p); return { p, e: s?.seg.e, dir: s?.seg.dir };
});

function run(f: Fixture, label: string, inDepot = false) {
  const { g, a, b } = f, trains = [a, b, ...(f.following ?? [])], days = f.following?.length ? 600 : 300;
  let cycle = false;
  for (let i = 0; i < 200 * TICKS_PER_DAY; i++) {
    g.stepTick();
    if (deadlockCycles(g, 0).length) { cycle = true; break; }
  }
  check(cycle && a.owner !== b.owner, `${label}: two operators form a real reservation cycle`);
  if (!cycle) return;
  if (inDepot) check(trains.some(t => t.segs[t.tailInfo().seg].e < 0), `${label}: a train's tail is still inside its depot`);
  const start = g.tick, json = saved(g);
  console.log(`${label}: cycle on day ${g.day}; ${trains.map(t => `${t.id} waits for ${t.blockedBy}`).join(', ')}`);

  const decision = deserialize(JSON.parse(json)), decision2 = deserialize(JSON.parse(json));
  const centers = decision.vehicles.trains().map(t => geometry(t)[1].p);
  const stops = decision.vehicles.trains().map(t => t.stopIndex);
  const moved = resolveDeadlocks(decision, 0);
  resolveDeadlocks(decision2, 0);
  if (f.following?.length) check(!moved && saved(decision) === json, `${label}: failed recovery while followers brake preserves the wait age and route`);
  else check(moved, `${label}: a deadlocked train can retreat`);
  check(saved(decision) === saved(decision2), `${label}: recovery selection is deterministic`);
  check(decision.vehicles.trains().every((t, i) => {
    const p = geometry(t)[1].p, old = centers[i];
    return Math.hypot(p.x - old.x, p.y - old.y, p.z - old.z) < 1e-9 && t.stopIndex === stops[i];
  }), `${label}: reversing preserves position and the service stop`);
  const recovering = decision.vehicles.trains().find(t => t.backoff);
  if (recovering) {
    const before = saved(decision);
    check(!recovering.breakDeadlock() && saved(decision) === before, `${label}: a failed recovery attempt preserves the wait age and route`);
  }

  // Cached status may name a different blocker after replanning; live reservations must still reveal the cycle.
  const graph = deserialize(JSON.parse(json)), ga = graph.vehicles.get(a.id) as Train;
  ga.blockedBy = 0;
  check(deadlockCycles(graph, 0).some(c => c.some(t => t.id === a.id) && c.some(t => t.id === b.id)), `${label}: live wait graph ignores stale blockedBy`);

  const replays: Game[] = [], phases = new Set<string>();
  const checkpoint = (phase: string) => {
    if (phases.has(phase)) return;
    phases.add(phase);
    const snapshot = saved(g), loaded = deserialize(JSON.parse(snapshot));
    check(saved(loaded) === snapshot, `${label}: exact ${phase} save round trip`);
    replays.push(loaded);
  };
  checkpoint('deadlock');
  let firstRecovery = -1, replayError = '', physicalError = '';
  const visits = new Map<number, number>(), prev = new Map<number, string>();
  for (let i = 0; i < days * TICKS_PER_DAY; i++) {
    const before = trains.map(t => ({ onMap: t.onMap, center: geometry(t)[1].p }));
    g.stepTick();
    for (const loaded of replays) loaded.stepTick();
    if (!replayError) {
      const ref = dynamic(g), geo = JSON.stringify(trains.map(geometry));
      for (const loaded of replays) {
        const actual = dynamic(loaded);
        if (actual !== ref || JSON.stringify(trains.map(t => geometry(loaded.vehicles.get(t.id) as Train))) !== geo
          || (g.tick % TICKS_PER_DAY === 0 && saved(loaded) !== saved(g))) {
          replayError = `tick ${g.tick}`;
          let at = 0; while (at < Math.min(ref.length, actual.length) && ref[at] === actual[at]) at++;
          console.log(`  replay mismatch at ${g.tick}, save ${replays.indexOf(loaded)}, JSON offset ${at}:\n    ${ref.slice(Math.max(0, at - 100), at + 140)}\n    ${actual.slice(Math.max(0, at - 100), at + 140)}`);
          break;
        }
      }
    }
    const occupied = new Map<number, number>();
    for (const [j, t] of trains.entries()) {
      if (t.state === 'loading' && prev.get(t.id) !== 'loading') visits.set(t.id, (visits.get(t.id) ?? 0) + 1);
      prev.set(t.id, t.state);
      const p = geometry(t)[1].p, old = before[j];
      if (t.onMap && old.onMap && Math.hypot(p.x - old.center.x, p.y - old.center.y, p.z - old.center.z) > t.maxSpeed * TICK + 0.02) physicalError ||= `position jump at tick ${g.tick}`;
      for (const e of t.occupiedEdges()) {
        if ((occupied.has(e) && occupied.get(e) !== t.id) || g.vehicles.getRes(e) !== t.id) physicalError ||= `occupied track collision/unreserved edge ${e} at tick ${g.tick}`;
        occupied.set(e, t.id);
      }
    }
    const retreat = trains.find(t => t.backoff);
    if (retreat) {
      if (firstRecovery < 0) {
        firstRecovery = g.tick;
        if (f.following?.length) check(f.following.includes(retreat), `${label}: a following train clears the blocked retreat first`);
      }
      checkpoint('reserved retreat');
      if (retreat.speed > 0.05) checkpoint('moving retreat');
      if (retreat.segs.some(s => s.e < 0 && s.dir < 0)) checkpoint('reverse depot track');
      if (retreat.state === 'waiting' || retreat.state === 'depot') checkpoint('yield hold');
    }
    if (trains.some(t => t.backoff && t.status === 'Moving aside to free the path')) checkpoint('further refuge');
    if (firstRecovery >= 0 && !retreat) checkpoint('resumed service');
  }
  const counts = trains.map(t => visits.get(t.id) ?? 0);
  check(firstRecovery >= 0 && firstRecovery - start <= Math.ceil(40 / TICK) + 3 * TICKS_PER_DAY + 1, `${label}: automatic resolution starts within 40 seconds plus three days`);
  check(counts.every(n => n >= 2), `${label}: every train resumes service within ${days} days`);
  check(!replayError, `${label}: exact replay at every tick from all checkpoints (${replayError || replays.length + ' saves'})`);
  check(!physicalError && checkReservations(g).length === 0, `${label}: physical movement, exclusive occupancy and consistent reservations (${physicalError || 'OK'})`);
  check(phases.has('moving retreat') && phases.has('yield hold') && phases.has('resumed service'), `${label}: replay covers movement, yielding and resumed service`);
  if (inDepot) check(phases.has('reverse depot track'), `${label}: replay includes backing physically into the depot`);
  if (f.following?.length) check(phases.has('further refuge'), `${label}: a yielded train can move to a further refuge when its hold forms another cycle`);
  console.log(`  arrivals ${counts.join('/')}; recovery after ${firstRecovery < 0 ? 'never' : ((firstRecovery - start) * TICK).toFixed(2) + ' s'}; ${replays.length} replay checkpoints`);
}

run(fixture(), 'junction platform');
run(depotFixture(false), 'short depot exit, path signal', true);
run(depotFixture(true), 'short depot exit, block signal', true);
run(fixture(true), 'queued junction platform');
done();
