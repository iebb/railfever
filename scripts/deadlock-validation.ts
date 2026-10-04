// Independent validator counterexamples, plus a bounded wait-graph timing check.
import '../src/game/patterns';
import { Game, TICK, TICKS_PER_DAY } from '../src/game/game';
import { Train, deadlockCycles, resolveDeadlocks, blockEdges, makeSeg } from '../src/game/train';
import * as trainCode from '../src/game/train';
import { setSignal } from '../src/game/signals';
import { connectStationThroat } from '../src/game/trackops';
import { outAndBack } from '../src/game/lines';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { runNetworkTask } from '../src/game/ai-network';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { station, endNode, depotFor, loco, build, nodeSnap, railOpts, check, done } from './stationlib';
import { checkReservations, addBusStop, roadDepotNear, roadOpts, free } from './lib';

if (!process.argv[1]?.endsWith('deadlock-validation.mjs')) throw new Error('bundle as deadlock-validation.mjs');
function need(v: unknown, label: string): asserts v { if (!v) throw new Error('fixture setup: ' + label); }
function flat() {
  const g = Game.create({ size: 256, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  g.world.h.fill(3); g.world.heightsVersion++;
  for (const t of g.world.trees) if (t) g.world.removeTreesNear(t.x, t.z, 0.1);
  for (const c of g.companies) c.economy.money = 1e9;
  return g;
}
const saved = (g: Game) => JSON.stringify(serialize(g));
const DEADLOCK_WORK = (trainCode as unknown as { DEADLOCK_WORK?: number }).DEADLOCK_WORK ?? 2048;
function exact(a: Game, b: Game) {
  const left = saved(a), right = saved(b);
  if (left === right) return true;
  let i = 0; while (left[i] === right[i]) i++;
  console.log(`save mismatch at ${i}: ${left.slice(i - 60, i + 160)} / ${right.slice(i - 60, i + 160)}`);
  return false;
}

function joint() {
  const g = flat(), net = g.world.net;
  const A = station(g, 40, 128, Math.PI / 2, 12, 2, 0)!, B = station(g, 145, 128, Math.PI / 2, 12, 1, 0)!, C = station(g, 205, 128, Math.PI / 2, 12, 2, 1)!;
  need(A && B && C, 'stations');
  need(build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0), 'A-B'), 'A-B');
  need(build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(1), 'B-C'), 'B-C');
  for (const front of [false, true]) {
    const n = net.nodes.get(endNode(g, B, 0, front))!, e = n.edges.map(id => net.edges.get(id)!).find(e => e.station < 0)!;
    need(!setSignal(g, e.id, front ? (e.a === n.id ? 2 : e.len - 2) : (e.a === n.id ? 0 : e.len), 'twoway', true, e.owner), 'junction signal');
  }
  for (const st of [A, C]) need(connectStationThroat(g, st.id, st.owner).connected === 1, 'throats');
  const dA = depotFor(g, A, B, 0), dC = depotFor(g, C, B, 1);
  need(dA >= 0 && dC >= 0, 'depots');
  const l = g.lines.create('rail', 0); l.stops = outAndBack([A.id, B.id, C.id]); l.evenSpacing = false;
  g.lines.setPartnerPolicy(l.id, 'open'); need(g.lines.join(l.id, 1) === null, 'join'); g.lines.rebuild();
  for (const x of [95, 177]) {
    const ne = net.nearestEdge(x, 128.225, 0.5, 'rail')!;
    const east = net.nodes.get(ne.edge.b)!.x > net.nodes.get(ne.edge.a)!.x;
    need(!setSignal(g, ne.edge.id, ne.s, 'oneway', x < 145 ? !east : east, ne.edge.owner, { signalKind: 'block', pass: true }), 'approach block signal');
  }
  const trains: Train[] = [];
  for (const [dp, index] of [[dA, 1], [dC, 3]]) {
    const t = g.vehicles.buyTrain(dp, loco(), l.id); need(t instanceof Train, 'purchase'); t.stopIndex = index; trains.push(t);
  }
  for (let i = 0; i < 500 * TICKS_PER_DAY && !deadlockCycles(g, 0).length; i++) g.stepTick();
  need(deadlockCycles(g, 0).length, 'natural opposing cycle');
  return { g, trains, A, C };
}

function guardedEntries(g: Game, t: Train) {
  return t.segs.slice(t.headSeg + 1).flatMap(s => {
    const e = g.world.net.edges.get(s.e), n = e && g.world.net.nodes.get(s.dir > 0 ? e.a : e.b);
    return e && n?.signalKind === 'block' && g.world.net.signalFor(n, g.world.net.sideAt(e, n.id)) > 0
      ? [{ edge: e.id, block: blockEdges(g, e.id, n.id) }] : [];
  });
}

function safety() {
  // A large block still guards its last branch; it must never fall back to only the chosen path.
  const large = flat(), net = large.world.net;
  let from = net.addNode('rail', 30, 3, 100, 1, 0, 0), first: ReturnType<typeof net.addEdge> | undefined, last = 0;
  const approach = net.addNode('rail', 29, 3, 100, 1, 0, 0);
  net.addEdge('rail', approach.id, from.id, bezLine(29, 100, 30, 100), new Float32Array([3, 3]), [], 'standard', 0);
  for (let i = 0; i < 500; i++) {
    const to = net.addNode('rail', 30 + (i + 1) * 0.25, 3, 100, 1, 0, 0);
    const e = net.addEdge('rail', from.id, to.id, bezLine(from.x, 100, to.x, 100), new Float32Array([3, 3]), [], 'standard', 0);
    first ??= e; last = e.id; from = to;
  }
  need(first && !setSignal(large, first.id, 0, 'twoway', true, 0, { signalKind: 'block' }), 'large block signal');
  const entry = new Train(large, 1, loco(), -1); entry.pending = [makeSeg(large, first, 1)]; large.vehicles.setRes(last, 99);
  const guarded = blockEdges(large, first.id, first.a), denied = !(entry as any).tryExtend();
  check(guarded.length === 500 && denied, 'all 500 edges remain protected by a block guard');

  const f = joint(), { g } = f;
  // Park off-route platform branches after the opposing pair has departed and formed its cycle.
  for (const [st, dp] of [[f.A, f.trains[0].depotId], [f.C, f.trains[1].depotId]] as const) {
    const local = g.lines.create('rail', st.owner); local.stops = [st.id]; local.evenSpacing = false; g.lines.rebuild();
    const hold = g.vehicles.buyTrain(dp, loco(), local.id); need(hold instanceof Train, 'parked train');
    for (let i = 0; hold.state !== 'loading' && i < 200 * TICKS_PER_DAY; i++) {
      for (const t of f.trains) t.stuckTime = 0;
      g.stepTick();
    }
    need(hold.state === 'loading', 'branch occupied'); hold.state = 'stopped';
  }
  for (const t of f.trains) t.stuckTime = 100;
  need(deadlockCycles(g, 0).length, 'cycle with occupied branches');
  const job = deserialize(JSON.parse(saved(g)));
  let queuedReplay: Game | undefined;
  for (let i = 0; i < 2000; i++) {
    resolveDeadlocks(job, 0, 1);
    if (queuedReplay) { resolveDeadlocks(queuedReplay, 0, 1); need(exact(job, queuedReplay), 'exact recovery candidate queue replay'); }
    if (job.deadlockScan?.recovery && !queuedReplay) queuedReplay = deserialize(JSON.parse(saved(job)));
    if (!job.deadlockScan) break;
  }
  check(!!queuedReplay, 'failed refuge selection saves and replays the remaining recovery candidates');
  resolveDeadlocks(g, 0);
  const unsafe = g.vehicles.trains().filter(t => t.backoff).flatMap(t => guardedEntries(g, t)
    .filter(q => q.block.some(r => g.vehicles.getRes(r) && g.vehicles.getRes(r) !== t.id)));
  check(!unsafe.length, 'retreat planning rejects every occupied guarded branch');

  // Reserve a safe retreat first, then turn a facing guard red before the train reaches it.
  const moving = joint(), mg = moving.g;
  for (const t of moving.trains) t.stuckTime = 100;
  need(resolveDeadlocks(mg, 0), 'initial safe retreat');
  const retreat = mg.vehicles.trains().find(t => t.backoff)!;
  const guard = guardedEntries(mg, retreat)[0]; need(guard, 'retreat crosses facing block signal');
  const offRoute = guard.block.find(r => !retreat.segs.some(s => s.res.includes(r)));
  need(offRoute !== undefined, 'separate guarded branch');
  const parked = new Train(mg, 99, loco(), -1), e = mg.world.net.edges.get(offRoute)!;
  parked.owner = e.owner; parked.state = 'stopped'; parked.segs = [makeSeg(mg, e, 1)]; parked.headPos = e.len;
  mg.vehicles.map.set(parked.id, parked); for (const r of parked.segs[0].res) mg.vehicles.setRes(r, parked.id);
  const replay = deserialize(JSON.parse(saved(mg)));
  let crossed = false;
  for (let i = 0; i < 80 * TICKS_PER_DAY; i++) {
    mg.stepTick(); replay.stepTick();
    crossed ||= retreat.occupiedEdges().includes(guard.edge);
    if (i % TICKS_PER_DAY === 0) need(saved(mg) === saved(replay), 'exact red-block retreat replay');
  }
  check(!crossed && retreat.speed === 0, 'moving retreat stops before a newly occupied guarded branch');
  check(retreat.blockingTrains().includes(parked.id), 'retreat stopped at a facing guard reports its off-route blocker');
  parked.releaseAll(); replay.vehicles.get(parked.id)!.releaseAll();
  for (let i = 0; i < 100 * TICKS_PER_DAY && !retreat.occupiedEdges().includes(guard.edge); i++) { mg.stepTick(); replay.stepTick(); }
  check(retreat.occupiedEdges().includes(guard.edge) && saved(mg) === saved(replay), 'retreat resumes on green with exact save/load replay');
  check(checkReservations(mg).length === 0, 'guarded retreat reservations remain consistent');
}

function splitFixture(split: boolean, short = false) {
  const g = flat(), net = g.world.net;
  const A = station(g, 20, 128, Math.PI / 2, 12, 1, 0)!, C = station(g, 146, 128, Math.PI / 2, 12, 1, 1)!;
  need(A && C, 'single-platform termini'); g.setAccessPolicy(0, 'open'); g.setAccessPolicy(1, 'open');
  const end = net.nodes.get(endNode(g, A, 0, true))!, z = end.z, y = end.y, nodes = new Map<string, number>();
  nodes.set('26,' + z, end.id); nodes.set('140,' + z, endNode(g, C, 0, false));
  const node = (x: number, zz = z) => {
    const key = x + ',' + zz; let id = nodes.get(key);
    if (id === undefined) { id = net.addNode('rail', x, y, zz, 1, 0, 0).id; nodes.set(key, id); }
    return id;
  };
  const edge = (ax: number, az: number, bx: number, bz: number) => net.addEdge('rail', node(ax, az), node(bx, bz), bezLine(ax, az, bx, bz), new Float32Array([y, y]), [], 'standard', 0);
  for (let x = 26; x < 60; x++) edge(x, z, x + 1, z);
  const ea = edge(60, z, 80, z), eb = edge(80, z, 100, z);
  need(!setSignal(g, ea.id, ea.len, 'twoway', true, 0), 'opposing body signal');
  for (let x = 100; x < 140; x++) edge(x, z, x + 1, z);
  for (const [a, b] of [[28, 40], [60, 48]]) {
    let e = edge(a, z, b, z + 0.45);
    while (e.len > 1.8) { const parts = net.splitEdge(e.id, 1); need(parts, 'split crossover'); e = parts.e2; }
  }
  const loop = split ? Array.from({ length: 8 }, (_, i) => edge(40 + i, z + 0.45, 41 + i, z + 0.45)) : [edge(40, z + 0.45, 48, z + 0.45)];
  const l = g.lines.create('rail', 0); l.stops = [A.id, C.id]; l.evenSpacing = false;
  g.lines.setPartnerPolicy(l.id, 'open'); need(g.lines.join(l.id, 1) === null, 'split fixture join');
  g.lines.rebuild(); g.onNetworkChanged(); g.flushNetworkChanges();
  // Sample newly built stations before the replay checkpoint (old-save defaults otherwise differ).
  for (let i = 0; i < TICKS_PER_DAY; i++) g.stepTick();
  const a = new Train(g, 1, loco(), -1), b = new Train(g, 2, loco(), -1); a.owner = 0; b.owner = 1;
  g.vehicles.nextId = 3;
  for (const [t, e, dir, stop] of [[a, ea, 1, 1], [b, eb, -1, 0]] as const) {
    g.vehicles.map.set(t.id, t); t.lineId = l.id; l.vehicles.push(t.id); t.stopIndex = stop;
    t.segs = [makeSeg(g, e, dir)]; t.headPos = e.len; g.vehicles.setRes(e.id, t.id);
  }
  g.lines.rebuild();
  for (const t of [a, b]) {
    need((t as any).planRoute(false), 'service route'); need(!(t as any).tryExtend(), 'opposing body blocks route'); t.state = 'waiting'; t.stuckTime = 100;
  }
  // Only the final loop edge is unneeded: checking that edge alone would falsely accept this refuge.
  if (short) for (const t of [a, b]) for (const e of net.edges.values()) {
    if (e.id !== loop[loop.length - 1].id) t.pending.push(makeSeg(g, e, 1));
  }
  return { g, a, b, loop };
}

function split() {
  for (const segmented of [false, true]) {
    const { g, a, b, loop } = splitFixture(segmented);
    need(deadlockCycles(g, 0).length === 1, 'segmented refuge cycle');
    const moved = resolveDeadlocks(g, 0), retreat = g.vehicles.trains().find(t => t.backoff);
    check(moved && !!retreat, `${segmented ? 'eight-edge' : 'one-edge'} 8-unit refuge fits a ${a.length.toFixed(1)}-unit train`);
    if (!retreat) continue;
    const replay = deserialize(JSON.parse(saved(g)));
    let held = false, physical = true;
    for (let i = 0; i < 180 * TICKS_PER_DAY; i++) {
      const before = { x: 0, y: 0, z: 0 }; retreat.worldPos(before);
      g.stepTick(); replay.stepTick();
      const after = { x: 0, y: 0, z: 0 }; retreat.worldPos(after);
      physical &&= Math.hypot(after.x - before.x, after.y - before.y, after.z - before.z) <= retreat.maxSpeed * TICK + 0.02;
      if (!held && retreat.backoff && retreat.state === 'waiting' && retreat.distToEnd() < 0.02) {
        held = true;
        physical &&= !retreat.segs.some(s => s.res.some(r => retreat.backoff!.clear.includes(r)));
      }
      if (i % TICKS_PER_DAY === 0) need(exact(g, replay), 'segmented refuge exact replay');
    }
    console.log(JSON.stringify({ segmented, held, physical, occupied: retreat.occupiedEdges(), loop: loop.map(e => e.id), state: retreat.state, reservations: checkReservations(g) }));
    check(held && physical && checkReservations(g).length === 0, 'whole body clears the contested track without jumps or reservation conflicts');
    check(!deadlockCycles(g, 0).some(c => c.includes(a) && c.includes(b)), 'opposing pair no longer stays deadlocked');
  }
  const blocked = splitFixture(true, true);
  check(!resolveDeadlocks(blocked.g, 0), 'refuge rejected when an earlier footprint segment is needed by the other train');
}

function stopFixture(secondOwned = false) {
  const g = flat(), me = 1, ai = g.ais[0]; g.setAccessPolicy(0, 'open');
  need(build(g, free(g, 30, 70), free(g, 230, 70), roadOpts(-1, 'road', { town: true, straight: true }), 'public street'), 'road');
  const A = addBusStop(g, 50, 70, me), X = addBusStop(g, 54, 70, 0), B = addBusStop(g, 210, 70, 0);
  need(A >= 0 && X >= 0 && B >= 0 && new Set([A, X, B]).size === 3, 'distinct stops');
  const ownB = secondOwned ? addBusStop(g, 190, 70, me) : B; need(ownB >= 0, 'destination stop');
  const l = g.lines.create('road', me); l.stops = [A, ownB]; g.lines.rebuild();
  const dp = roadDepotNear(g, 40, 70, me); need(dp >= 0, 'depot'); const model = MODEL_BY_ID.get('bus_b')!;
  need(typeof g.vehicles.buyRoad(dp, model, l.id) !== 'string', 'initial bus');
  return { g, me, ai, l, dp, model, X };
}

function stops() {
  const { g, me, ai, l, dp, model } = stopFixture();
  need(runNetworkTask(ai, 'stops'), 'stop consolidation task');
  const next = g.vehicles.buyRoad(dp, model, l.id);
  console.log(JSON.stringify({ stopOwners: l.stops.map(id => g.stations.get(id)?.owner), purchase: typeof next === 'string' ? next : 'OK' }));
  check(g.lines.operateError(l, me) === null && typeof next !== 'string', 'consolidation keeps the last owned stop and capacity purchases eligible');
  // Consolidation still works when a different owned stop preserves operating eligibility.
  const other = stopFixture(true); need(runNetworkTask(other.ai, 'stops'), 'eligible consolidation task');
  check(other.l.stops.includes(other.X) && other.g.lines.operateError(other.l, other.me) === null, 'redundant owned stop can consolidate while another owned stop remains');
}

function graphReplay() {
  const { g } = splitFixture(true), checkpoints = new Map<string, Game>();
  let recovered = false;
  for (let i = 0; i < 2000; i++) {
    recovered ||= resolveDeadlocks(g, 0, 1);
    for (const copy of checkpoints.values()) resolveDeadlocks(copy, 0, 1);
    const phase = g.deadlockScan?.phase;
    if (phase && !checkpoints.has(phase)) checkpoints.set(phase, deserialize(JSON.parse(saved(g))));
    for (const copy of checkpoints.values()) need(exact(g, copy), 'exact sliced graph replay');
    if (!g.deadlockScan) break;
  }
  check(recovered && checkpoints.has('graph') && checkpoints.has('scc') && checkpoints.has('resolve'), 'complete sliced wait graph replays exactly through construction, SCC traversal and recovery');
}

function perf() {
  for (const count of [1000, 5000]) {
    const g = flat(), st = station(g, 40, 128, Math.PI / 2, 12, 1, 0)!;
    const template = makeSeg(g, g.world.net.edges.get(st.rail!.edges[0])!, 1);
    for (let id = 1; id <= count; id++) {
      const t = new Train(g, id, loco(), -1); t.state = 'waiting'; t.stuckTime = 100;
      t.pending = Array.from({ length: 100 }, (_, j) => ({ ...template, res: [count + ((id + j) % count) + 1] }));
      g.vehicles.map.set(id, t); g.vehicles.setRes(count + id, id);
    }
    resolveDeadlocks(g, 101, DEADLOCK_WORK);
    check(!g.deadlockScan, 'only trains past the wait threshold start graph work');
    const times: number[] = []; let complete = false;
    // Three full scans; all edges are retained, but no gameplay tick performs a full scan at this scale.
    for (let round = 0; round < 3; round++) for (let i = 0; i < 3000; i++) {
      const start = performance.now(); resolveDeadlocks(g, 40, DEADLOCK_WORK); times.push(performance.now() - start);
      if (g.deadlockScan?.phase === 'scc') complete ||= g.deadlockScan.edges.every(es => es.length === 100);
      if (!g.deadlockScan) break;
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)], p95 = times[Math.floor(times.length * 0.95)], max = times[times.length - 1];
    console.log(JSON.stringify({ waiting: count, lookahead: 100, slices: times.length, medianMs: median, p95Ms: p95, maxMs: max }));
    check(complete, `${count} waiting trains: complete 100-segment graph is built over several ticks`);
    check(median < 5 && p95 < 10, `${count} waiting trains: median graph slice < 5 ms and p95 < 10 ms`);
  }
}

const mode = process.argv[2] ?? 'all';
if (mode === 'all' || mode === 'safety') safety();
if (mode === 'all' || mode === 'split') split();
if (mode === 'all' || mode === 'stops') stops();
if (mode === 'all' || mode === 'graph') graphReplay();
if (mode === 'all' || mode === 'perf') perf();
done();
