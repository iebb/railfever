// Full line upgrades, double junctions, access funding, congestion incentives and mid-upgrade replay.
// Bundle as dualtrack.mjs and run from the requested scratch directory.
import { Game, PLAYER } from '../src/game/game';
import { AIController, type LineInfo } from '../src/game/ai';
import { planDoubleTrack, commitDoubleTrack, connectStationThroat, planConnection, commitConnection } from '../src/game/trackops';
import { lineIsDouble, upgradeRoute, trackIsDouble, congestionReturn } from '../src/game/dualtrack';
import { autoSignalLine, setSignal } from '../src/game/signals';
import { serialize, deserialize } from '../src/game/save';
import { findSnap } from '../src/game/construction';
import { Train, makeSeg, CROSS_BASE, lineCongestion, findRailRoute, railNext } from '../src/game/train';
import { station, endNode, nodeSnap, railOpts, free, build, depotFor, loco, check, done, runTrains } from './stationlib';
import { checkReservations } from './lib';
import { routeBetween } from '../src/game/ai-network';
import { bezLine, bezFromTangents, arcTable } from '../src/game/geom';
import { RAIL, PSTEP } from '../src/game/constants';
import { electrify } from '../src/game/build-ops';

if (!process.argv[1]?.endsWith('dualtrack.mjs')) throw new Error('bundle this test as dualtrack.mjs');

type InternalAI = AIController & { relieveCongestion: (l: any, info: LineInfo) => boolean; job: Generator<void, void> | null; project: any };
function fixture(owner = 1, throat = true, middle = false, tracks = 2) {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 2 });
  g.aiEnabled = false; g.world.h.fill(3); g.world.heightsVersion++;
  for (const co of g.companies) co.economy.money = 1e8;
  const A = station(g, 30, 192, Math.PI / 2, 12, tracks, owner)!;
  const B = station(g, middle ? 188 : 348, 192, Math.PI / 2, 12, tracks, owner)!;
  const C = middle ? station(g, 348, 192, Math.PI / 2, 12, tracks, owner)! : null;
  for (const [a, b] of C ? [[A, B], [B, C]] : [[A, B]]) {
    const start = nodeSnap(g, endNode(g, a, tracks - 1, true), 'rail');
    const end = nodeSnap(g, endNode(g, b, tracks - 1, false), 'rail');
    const p = build(g, start, end, railOpts(owner), 'single main');
    if (!p) throw new Error('fixture main');
  }
  if (throat) for (const st of [A, B, ...(C ? [C] : [])]) connectStationThroat(g, st.id, owner);
  const l = g.lines.create('rail', owner);
  l.stops = [A.id, B.id, ...(C ? [C.id] : [])];
  l.incomeLast = 1_000_000;
  const dep = depotFor(g, A, B, owner);
  const ai = g.ais.find((a) => a.companyId === owner)! as unknown as InternalAI;
  const info: LineInfo = { kind: 'rail', towns: [], depot: dep, maxVehicles: 4, opened: -720 };
  if (ai) (ai as any).lines.set(l.id, info);
  return { g, A, B, C, l, dep, ai, info };
}
function finish(ai: InternalAI) {
  for (let i = 0; ai.job && i < 2000; i++) { if (ai.job.next().done) ai.job = null; }
  check(!ai.job, 'upgrade job completes');
}
function congest(f: ReturnType<typeof fixture>) {
  const trains: Train[] = [];
  for (let i = 0; i < 3; i++) { const v = f.g.vehicles.buyTrain(f.dep, loco(), f.l.id); if (typeof v === 'string') throw new Error(v); trains.push(v); }
  // Stable signal waits reproduce the live congestion detector without needing a random deadlock.
  for (const t of trains) { t.state = 'waiting'; t.stuckTime = 300; }
  check(lineCongestion(f.g, f.l.id).level >= 2, 'fixture is congested');
  return trains;
}
function scenario(name: string, test: () => void) {
  console.log(name);
  try { test(); } catch (e) { check(false, `${name}: ${(e as Error).message}`); }
}

scenario('1. passenger congestion: complete approaches before a cut', () => {
  const f = fixture(); const trains = congest(f);
  f.info.congestion = 1;
  check(congestionReturn(f.g, f.l) > 0, 'stalled service and waiting passengers have recoverable revenue');
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  console.log(`  full ${f.info.double}, loops ${f.info.loops}, edges ${f.g.world.net.edges.size}, ${f.ai.log.slice(-2).join(" / ")}`);
  check(f.info.double && lineIsDouble(f.g, f.l, 1), 'congested AI passenger line is fully double, including both throats');
  check(trains.every((t) => !!f.g.vehicles.get(t.id)), 'no train cut before completing the second track');
});

scenario('2. loop completion and cash deferral', () => {
  const f = fixture(); const net = f.g.world.net;
  const route = upgradeRoute(f.g, f.A.id, f.B.id, 1);
  // Split a plain central stretch and lay a stopgap loop, retaining single station approaches.
  const longest = route.map((id) => net.edges.get(id)!).sort((a, b) => b.len - a.len)[0];
  const cut = net.splitEdge(longest.id, 60)!; const cut2 = net.splitEdge(cut.e2.id, cut.e2.len - 60)!;
  const loop = planDoubleTrack(f.g, [cut2.e1.id], -1, 1, false);
  check(loop.ok && !commitDoubleTrack(f.g, loop).error, 'stopgap loop built');
  f.info.loops = 1; f.info.congestion = 2;
  const trains = congest(f);
  f.g.company(1).economy.money = 0; f.g.company(1).economy.loan = f.g.company(1).economy.maxLoan;
  f.ai.relieveCongestion(f.l, f.info);
  check(trains.every((t) => f.g.vehicles.get(t.id)), 'cash shortage defers construction instead of cutting trains');
  f.g.company(1).economy.money = 1e8; f.g.day += 30;
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  check(f.info.double && lineIsDouble(f.g, f.l, 1), 'AI retries despite loops and completes the remaining single stretches');
  check(trains.every((t) => f.g.vehicles.get(t.id)), 'loop completion precedes congestion cuts');
});

scenario('3. accessible track: payer, owner, signalling, revoked access', () => {
  const f = fixture(); const g = f.g;
  g.setAccessPolicy(1, 'ask');
  const ids = upgradeRoute(g, f.A.id, f.B.id, 1);
  const denied = planDoubleTrack(g, ids, -1, PLAYER);
  check(!denied.ok && /needs track access/i.test(denied.errors[0]), 'without access doubling is refused with a clear access message');
  g.setAccessPolicy(1, 'auto-approve'); g.requestAccess(PLAYER, 1);
  const pl = planDoubleTrack(g, ids, 1, PLAYER);
  const money = g.economy.money, ownerMoney = g.company(1).economy.money;
  const before = JSON.stringify(serialize(g));
  planDoubleTrack(g, ids, 1, PLAYER);
  check(JSON.stringify(serialize(g)) === before, 'accessible double preview is pure');
  const r = commitDoubleTrack(g, pl);
  console.log(`  access build ${r.error ?? 'OK'}, finish ${r.finishError ?? 'OK'}, cost ${r.cost}`);
  check(!r.error && money - g.economy.money === r.cost && r.cost > 0, 'player pays the complete construction bill');
  check(g.company(1).economy.money === ownerMoney && r.edges.every((id) => g.world.net.edges.get(id)?.owner === 1), 'AI retains added track and is not charged for construction');
  check(lineIsDouble(g, f.l, PLAYER), 'accessible station throats are fully doubled');
  const preview = autoSignalLine(g, f.l.id, PLAYER, { preview: true });
  check(!preview.warnings.some((w) => /access|left as it is/.test(w)), 'automatic signal tool accepts accessible track');
  g.endAccess(PLAYER, 1);
  const e = [...g.world.net.edges.values()].find((e) => e.owner === 1 && e.station < 0 && e.depot < 0)!;
  check(/track access/.test(setSignal(g, e.id, e.len / 2, 'twoway', true, PLAYER) ?? ''), 'signalling without access is refused');
  const player = fixture(PLAYER); player.g.setAccessPolicy(PLAYER, 'auto-approve'); player.g.requestAccess(2, PLAYER); const state = JSON.stringify(serialize(player.g));
  const attempt = planDoubleTrack(player.g, upgradeRoute(player.g, player.A.id, player.B.id, PLAYER), -1, 2);
  check(!attempt.ok && /player/.test(attempt.errors[0]) && JSON.stringify(serialize(player.g)) === state, 'AI never alters player track, even when access is granted');
  const rail = player.g.world.net.edges.get(upgradeRoute(player.g, player.A.id, player.B.id, PLAYER)[0])!;
  check(/player/.test(setSignal(player.g, rail.id, rail.len / 2, 'twoway', true, 2) ?? '') && JSON.stringify(serialize(player.g)) === state, 'AI signalling also leaves accessible player rails unchanged');
  check(/player/.test(electrify(player.g, [rail.id], 2).error ?? '') && JSON.stringify(serialize(player.g)) === state, 'AI electrification also leaves accessible player rails unchanged');
});

scenario('4. exact replay halfway through a multi-station upgrade', () => {
  const f = fixture(1, true, true); congest(f); f.info.congestion = 1;
  f.ai.relieveCongestion(f.l, f.info);
  const scheduled = deserialize(serialize(f.g));
  check(!!scheduled.ais[0].state.doubleJob && JSON.stringify(serialize(scheduled)) === JSON.stringify(serialize(f.g)), 'upgrade scheduled before its first work tick also resumes exactly');
  f.ai.job!.next();
  check(!!f.ai.state.doubleJob?.built && !!f.ai.job, 'save is taken after construction, before the next station leg');
  f.g.day = 37; f.g.tick = 37 * 40;
  const snapshot = serialize(f.g); const h = deserialize(snapshot);
  const resumed = h.ais[0] as unknown as InternalAI;
  check(JSON.stringify(serialize(h)) === JSON.stringify(snapshot), 'mid-upgrade save/load is an exact round trip');
  finish(f.ai); finish(resumed);
  check(JSON.stringify(serialize(h)) === JSON.stringify(serialize(f.g)), 'upgrade choices, IDs, money and cursor replay exactly');
  check(lineIsDouble(h, h.lines.get(f.l.id)!, 1), 'resumed line is fully double');
  for (let i = 0; i < 80; i++) { f.g.stepTick(); h.stepTick(); }
  check(JSON.stringify(serialize(h)) === JSON.stringify(serialize(f.g)), 'fixed ticks after the upgrade remain identical');
});

scenario('5. double branch junction: two leads, protected diamond and operating trains', () => {
  const f = fixture(1, true), { g } = f, net = g.world.net;
  const C = station(g, 266, 114, Math.PI * 0.75, 12, 2, 1)!;
  const hit = findSnap(g, 'rail', 160, 191.51, 0.5);
  check(!!build(g, hit, nodeSnap(g, endNode(g, C, 1, false), 'rail'), railOpts(1), 'single branch'), 'single branch fixture built');
  connectStationThroat(g, C.id, 1);
  check(f.ai.upgradeLine(f.l.id), 'trunk upgrade including the existing branch junction');
  const branch = g.lines.create('rail', 1); branch.stops = [f.A.id, C.id]; branch.incomeLast = 1_000_000;
  const bi: LineInfo = { kind: 'rail', towns: [], depot: f.dep, maxVehicles: 3, opened: g.day };
  (f.ai as any).lines.set(branch.id, bi);
  check(f.ai.upgradeLine(branch.id), 'branch gets its second lead onto the second main track');
  console.log(`  junction full ${bi.double}, diamonds ${net.crossings.size}, ${f.ai.log.slice(-2).join(' / ')}`);
  check(lineIsDouble(g, f.l, 1) && lineIsDouble(g, branch, 1), 'both routes remain double through the junction and all station approaches');
  const diamonds = [...net.crossings.values()].filter((c) => c.kind === 'diamond');
  check(diamonds.length > 0, 'flat double junction has a registered diamond crossing');
  check(diamonds.every((c) => makeSeg(g, net.edges.get(c.e1)!, 1).res.includes(CROSS_BASE + c.id) && makeSeg(g, net.edges.get(c.e2)!, 1).res.includes(CROSS_BASE + c.id)), 'conflicting diamond moves reserve the same crossing resource');
  const junctionResources = (a: number, b: number) => new Set((routeBetween(g, a, b, 1) ?? []).flatMap((id) => {
    const e = net.edges.get(id)!, p = { x: 0, y: 0, z: 0 }; net.pointAt(e, e.len / 2, p);
    return Math.hypot(p.x - 160, p.z - 191.51) < 16 ? makeSeg(g, e, 1).res : [];
  }));
  const independent = [[f.A.id, f.B.id, C.id, f.A.id], [f.B.id, f.A.id, f.A.id, C.id]].some(([a, b, c, d]) => {
    const x = junctionResources(a, b), y = junctionResources(c, d);
    return x.size > 0 && y.size > 0 && ![...x].some((id) => y.has(id));
  });
  check(independent, 'opposing non-conflicting junction moves have disjoint path resources and can pass together');
  const trains: Train[] = [];
  for (const l of [f.l, branch]) {
    for (let i = 0; i < 2; i++) { const t = g.vehicles.buyTrain(f.dep, loco(), l.id); if (typeof t !== 'string') trains.push(t); }
  }
  const result = runTrains(g, trains, 720);
  console.log(`  junction arrivals ${trains.map((t)=>result.arrivals.get(t.id)?.length??0).join('/')}, longest wait ${result.worst.days}`);
  check(trains.length === 4 && trains.every((t) => (result.arrivals.get(t.id)?.length ?? 0) >= 6), 'trains in both directions on both routes keep passing through the double junction');
  check(result.worst.days < 30 && checkReservations(g).length === 0, 'junction protections allow independent paths and prevent deadlocks');
});

scenario('6. AI services can fund another AI company\'s accessible formation', () => {
  const f = fixture(), { g } = f;
  g.setAccessPolicy(1, 'auto-approve'); g.requestAccess(2, 1);
  const ai = g.ais[1], l = g.lines.create('rail', 2);
  l.stops = [...f.l.stops]; l.incomeLast = 1_000_000;
  (ai as any).lines.set(l.id, { ...f.info, shared: 1 });
  const ownerMoney = g.company(1).economy.money, payerMoney = g.company(2).economy.money, first = g.world.net.nextEdge;
  check(ai.upgradeLine(l.id), 'AI upgrades accessible AI rails used by its service');
  check(lineIsDouble(g, l, 2) && g.company(2).economy.money < payerMoney && g.company(1).economy.money === ownerMoney, 'AI operator pays for a complete shared-line upgrade');
  check([...g.world.net.edges.values()].filter((e) => e.id >= first).every((e) => e.owner === 1), 'new shared main tracks, turnouts and crossovers retain the infrastructure owner');
});

scenario('7. a short deviation completes an obstructed formation without altering player rails', () => {
  const f = fixture(), { g } = f;
  check(!!build(g, free(g, 166, 192.03), free(g, 184, 192.03), railOpts(PLAYER), 'player formation beside the route'), 'parallel player obstruction built');
  const protectedTrack = () => JSON.stringify([...g.world.net.edges.values()].filter((e) => e.owner === PLAYER));
  const before = protectedTrack(); congest(f); f.info.congestion = 1;
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  check(f.info.double && lineIsDouble(g, f.l, 1), 'AI prices and builds a short second-track deviation around the obstructed piece');
  check(protectedTrack() === before, 'even an obstructing accessible player formation stays exactly unchanged');
});

scenario('8. bridge-supported flying movement is an alternative to a flat diamond', () => {
  const f = fixture(), { g } = f, net = g.world.net;
  check(!!build(g, free(g, 190, 145), free(g, 190, 225), { ...railOpts(1), crossing: 'level' }, 'crossing railway'), 'crossing track built');
  const route = upgradeRoute(g, f.A.id, f.B.id, 1);
  const pl = planDoubleTrack(g, route, 1, 1, true, { flying: true });
  check(pl.ok && pl.proposals.some((p) => p.crossings.some((c) => c.mode === 'over')), 'flying option previews a grade-separated movement with room for its ramps');
  const res = commitDoubleTrack(g, pl);
  check(!res.error && !res.finishError && res.edges.some((id) => net.edges.get(id)?.sections.some((s) => s.type === 'bridge')), 'flying movement, directional signals and station crossovers build');
  check(lineIsDouble(g, f.l, 1), 'bridge profile counts as a complete second track rather than a single-track gap');
});

scenario('9. station approaches can reach companion platforms on opposite sides', () => {
  const f = fixture(1, false), { g } = f, net = g.world.net;
  const route = upgradeRoute(g, f.A.id, f.B.id, 1);
  // Reverse B's approach to use its other original platform; the second lead must cross the old main.
  for (const id of route) net.removeEdge(id);
  check(!!build(g, nodeSnap(g, endNode(g, f.A, 1, true), 'rail'), nodeSnap(g, endNode(g, f.B, 0, false), 'rail'), railOpts(1), 'opposite platform main'), 'opposite-side main built');
  const pl = planDoubleTrack(g, upgradeRoute(g, f.A.id, f.B.id, 1), 1, 1);
  const r = commitDoubleTrack(g, pl);
  check(!r.error && !r.finishError && lineIsDouble(g, f.l, 1), 'both approaches reach separate platforms even when their relative sides differ');
  check([...net.crossings.values()].some((c) => c.kind === 'diamond'), 'approach changing sides has a protected, registered diamond rather than overlapping rails');
});

scenario('10. congestion notice cooldown survives a save', () => {
  const f = fixture(PLAYER), { g } = f; congest(f);
  g.stations.refreshAccess();
  g.day = 30; (g as any).congestionNews();
  const h = deserialize(serialize(g));
  g.day = h.day = 60;
  (g as any).congestionNews(); (h as any).congestionNews();
  check(JSON.stringify(serialize(g)) === JSON.stringify(serialize(h)), 'save/load does not repeat a congestion notice or change the replay');
});

scenario('11. automatic stopgap loops are completed after the obstruction is removed', () => {
  const f = fixture(), { g } = f;
  const obstacles = [193.2, 189.8].map((z) => station(g, 176, z, Math.PI / 2, 16, 2, PLAYER));
  check(obstacles.every(Boolean), 'protected stations obstruct both sides of a long single edge');
  if (obstacles.some((st) => !st)) return;
  congest(f); f.info.congestion = 1;
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  console.log(`  stopgap loops ${f.info.loops ?? 0}, full ${f.info.double}, ${f.ai.log.at(-1)}`);
  check(!f.info.double && (f.info.loops ?? 0) > 0, 'AI builds affordable loops on clear parts of the unsplit formation');
  for (const st of obstacles) check(!g.stations.removeStation(st!.id), 'player removes its obstructing station');
  for (const id of f.l.vehicles) g.vehicles.get(id)!.state = 'depot';
  g.day = f.info.upgradeRetry ?? 181;
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  check(f.info.double && lineIsDouble(g, f.l, 1), 'recent waiting-passenger losses pay for finishing loops even after the detector clears');
});

scenario('12. standalone accessible crossovers keep the owner and recheck access at construction', () => {
  const { g } = fixture(), net = g.world.net;
  const rails = [110, 110 + RAIL.spacing].map((z) => {
    const a = net.addNode('rail', 90, 3, z, 1, 0, 1), b = net.addNode('rail', 210, 3, z, -1, 0, 1);
    return net.addEdge('rail', a.id, b.id, bezLine(a.x, z, b.x, z), new Float32Array(Math.ceil(120 / PSTEP) + 1).fill(3), [], 'standard', 1);
  });
  g.setAccessPolicy(1, 'ask');
  check(/track access/.test(planConnection(g, rails[0].id, 20, rails[1].id, 32, PLAYER).error ?? ''), 'a separate crossover tool also requires access');
  g.setAccessPolicy(1, 'auto-approve'); g.requestAccess(PLAYER, 1);
  const pl = planConnection(g, rails[0].id, 20, rails[1].id, 32, PLAYER);
  check(pl.ok && !!pl.crossover, 'accessible crossover preview succeeds');
  g.endAccess(PLAYER, 1);
  const before = JSON.stringify(serialize(g));
  check(/track access/.test(commitConnection(g, pl).error ?? '') && JSON.stringify(serialize(g)) === before, 'revoked access invalidates a preview without any construction');
  g.requestAccess(PLAYER, 1);
  const points = [net.nearestEdge(150, 110, 0.01, 'rail')!, net.nearestEdge(162, 110 + RAIL.spacing, 0.01, 'rail')!];
  const buildPlan = planConnection(g, points[0].edge.id, points[0].s, points[1].edge.id, points[1].s, PLAYER);
  const money = g.economy.money, ownerMoney = g.company(1).economy.money, upkeep = g.maintenanceOf(1), payerUpkeep = g.maintenanceOf(PLAYER);
  const res = commitConnection(g, buildPlan, { signals: false });
  check(!res.error && res.edges.length === 1 && res.edges.every((id) => net.edges.get(id)?.owner === 1), 'new crossover belongs to the original formation owner, excluding split parent rails');
  check(money - g.economy.money === buildPlan.cost && g.company(1).economy.money === ownerMoney, 'the upgrading player alone pays for the crossover');
  check(g.maintenanceOf(1) > upkeep && g.maintenanceOf(PLAYER) === payerUpkeep, 'owner retains crossover maintenance, shared with users through existing access billing');
  g.setAccessPolicy(PLAYER, 'auto-approve'); g.requestAccess(2, PLAYER);
  const nodes = [90, 210].map((x) => net.addNode('rail', x, 3, 100, 1, 0, PLAYER));
  const protectedRail = net.addEdge('rail', nodes[0].id, nodes[1].id, bezLine(90, 100, 210, 100), new Float32Array(Math.ceil(120 / PSTEP) + 1).fill(3), [], 'standard', PLAYER);
  const approach = net.nearestEdge(130, 110, 0.01, 'rail')!;
  check(/player/.test(planConnection(g, protectedRail.id, 20, approach.edge.id, approach.s, 2).error ?? ''), 'AI connection tools reject a player approach even with track access');
});

scenario('13. a platform rebuild inside the saved double-track job replays exactly', () => {
  const f = fixture(1, false, false, 1); congest(f); f.info.congestion = 1;
  f.ai.relieveCongestion(f.l, f.info);
  f.ai.job!.next();
  check(f.A.rail!.tracks === 2 && f.B.rail!.tracks === 1 && f.ai.state.doubleJob?.at === 0, 'first saved work unit provides the missing companion platform');
  const h = deserialize(serialize(f.g));
  check(JSON.stringify(serialize(f.g)) === JSON.stringify(serialize(h)), 'platform rebuild checkpoint round trips exactly');
  finish(f.ai); finish(h.ais[0] as unknown as InternalAI);
  check(JSON.stringify(serialize(f.g)) === JSON.stringify(serialize(h)) && lineIsDouble(h, h.lines.get(f.l.id)!, 1), 'replayed station rebuilding and complete approaches match exactly');
});

scenario('14. an obstructed throat still permits a temporary open-line loop', () => {
  const f = fixture(1, false), { g } = f, net = g.world.net;
  const first = net.nextEdge;
  check(!!build(g, free(g, 40, 192.03), free(g, 40, 196), railOpts(PLAYER), 'protected rail beside the approach'), 'a protected rail obstructs both second-platform approaches');
  const protectedEdges = [...net.edges.values()].filter((e) => e.id >= first && e.owner === PLAYER);
  const protectedState = JSON.stringify(protectedEdges);
  congest(f); f.info.congestion = 1;
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  check(!f.info.double && (f.info.loops ?? 0) > 0, 'a failed throat preview still produces an open-line stopgap loop');
  check(JSON.stringify(protectedEdges.map((e) => net.edges.get(e.id))) === protectedState, 'loop construction never edits the obstructing player rail');
  for (const e of protectedEdges) net.removeEdge(e.id);
  g.onNetworkChanged(); g.day = f.info.upgradeRetry ?? 181;
  f.ai.relieveCongestion(f.l, f.info); finish(f.ai);
  console.log(`  throat retry ${f.info.double}, ${f.ai.log.at(-1)}`);
  check(f.info.double && lineIsDouble(g, f.l, 1), 'the remaining throat is completed when the obstruction is removed');
  check([f.A, f.B].every((st) => st.rail!.edges.every((id) => {
    const e = net.edges.get(id)!;
    return [1, -1].some((d) => !!findRailRoute(g, railNext(g, e, d, 1, false, null, true), st === f.A ? f.B.id : f.A.id, 1, -1));
  })), 'all platforms can depart after completing a loop on its opposite side');
  const trains = f.l.vehicles.map((id) => g.vehicles.get(id) as Train);
  for (const t of trains) t.state = 'depot';
  const running = runTrains(g, trains, 720);
  console.log(`  completed loop arrivals ${trains.map((t) => running.arrivals.get(t.id)?.length ?? 0).join('/')}, longest wait ${running.worst.days}`);
  check(trains.every((t) => (running.arrivals.get(t.id)?.length ?? 0) >= 6) && running.worst.days < 30 && checkReservations(g).length === 0, 'trains keep running both ways through completed loop entrances without deadlock');
});

scenario('15. a circular service also doubles its closing leg', () => {
  const g = Game.create({ size: 768, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  g.aiEnabled = false; g.world.h.fill(3); g.world.heightsVersion++;
  g.company(1).economy.money = 1e8;
  const A = station(g, 200, 220, Math.PI / 2, 12, 2, 1)!;
  const B = station(g, 560, 220, Math.PI / 2, 12, 2, 1)!;
  const C = station(g, 380, 570, Math.PI / 2, 12, 2, 1)!;
  const net = g.world.net;
  for (const [a, b] of [[A, B], [B, C], [C, A]]) {
    const n = net.nodes.get(endNode(g, a, 1, true))!, m = net.nodes.get(endNode(g, b, 1, false))!;
    const bez = a === A ? bezLine(n.x, n.z, m.x, m.z) : bezFromTangents(n.x, n.z, 1, 0, m.x, m.z, 1, 0, 150, 150);
    const len = arcTable(bez).len;
    net.addEdge('rail', n.id, m.id, bez, new Float32Array(Math.ceil(len / PSTEP) + 1).fill(3), [], 'standard', 1);
  }
  g.onNetworkChanged();
  const dep = depotFor(g, A, B, 1), l = g.lines.create('rail', 1);
  l.stops = [A.id, B.id, C.id]; l.incomeLast = 1_000_000;
  const ai = g.ais[0], info: LineInfo = { kind: 'rail', towns: [], depot: dep, maxVehicles: 4, opened: -720 };
  (ai as any).lines.set(l.id, info);
  check(ai.upgradeLine(l.id) && info.double && lineIsDouble(g, l, 1), 'all three legs of the circular service are doubled, including C to A');
  check(upgradeRoute(g, C.id, A.id, 1).every((id) => trackIsDouble(g, id, 1)), 'the closing leg has no single approach or junction piece');
});

scenario('16. revoked access cannot split reused companion rail', () => {
  const f = fixture(PLAYER, false), { g } = f, net = g.world.net;
  const route = upgradeRoute(g, f.A.id, f.B.id, PLAYER), e = net.edges.get(route[0])!;
  const start = net.nodes.get(e.a)!, end = net.nodes.get(e.b)!, z = start.z - RAIL.spacing;
  const a = net.addNode('rail', start.x + 35, 3, z, 1, 0, 2), b = net.addNode('rail', end.x - 35, 3, z, -1, 0, 2);
  net.addEdge('rail', a.id, b.id, bezLine(a.x, z, b.x, z), new Float32Array(Math.ceil((b.x - a.x) / PSTEP) + 1).fill(3), [], 'standard', 2);
  g.setAccessPolicy(2, 'auto-approve'); g.requestAccess(PLAYER, 2); g.onNetworkChanged();
  const pl = planDoubleTrack(g, route, -1, PLAYER);
  check(pl.ok && !!pl.reuse?.some(Boolean), 'preview reuses the rival companion track');
  g.endAccess(PLAYER, 2);
  const before = JSON.stringify(serialize(g)), r = commitDoubleTrack(g, pl);
  check(/track access/.test(r.error ?? '') && JSON.stringify(serialize(g)) === before, 'revoked companion rights reject before any rail split, charge or ID change');
});

scenario('17. an occupied new diamond is protected before save/load', () => {
  const f = fixture(), { g } = f, net = g.world.net;
  const C = station(g, 270, 75, Math.PI * 0.75, 12, 2, 1)!;
  check(!!build(g, findSnap(g, 'rail', 160, 191.51, 0.5), nodeSnap(g, endNode(g, C, 1, false), 'rail'), railOpts(1), 'occupied branch'), 'branch built');
  connectStationThroat(g, C.id, 1);
  const l = g.lines.create('rail', 1); l.stops = [f.A.id, C.id];
  const main = upgradeRoute(g, f.A.id, f.B.id, 1), mainSet = new Set(main);
  const e = upgradeRoute(g, f.A.id, C.id, 1).map((id) => net.edges.get(id)!).filter((e) => !mainSet.has(e.id)).sort((a, b) => b.len - a.len)[0];
  const t = g.vehicles.buyTrain(f.dep, loco(), l.id) as Train;
  t.releaseAll(); t.segs = [makeSeg(g, e, 1)]; t.headSeg = 0; t.headPos = e.len / 2; t.state = 'stopped'; t.routeTarget = C.id;
  g.vehicles.setRes(e.id, t.id);
  const plans = [-1, 1].map((s) => planDoubleTrack(g, main, s as -1 | 1, 1));
  const pl = plans.find((p) => p.ok && p.proposals.some((q) => q.crossings.some((c) => c.mode === 'diamond' && c.edge === e.id)));
  check(!!pl, 'complete upgrade crosses the occupied branch');
  if (!pl) return;
  check(!commitDoubleTrack(g, pl).error, 'upgrade commits beside the occupied branch');
  const c = [...net.crossings.values()].find((c) => c.e1 === e.id || c.e2 === e.id)!;
  check(!!c && t.segs.some((s) => s.res.includes(CROSS_BASE + c.id)) && g.vehicles.getRes(CROSS_BASE + c.id) === t.id, 'cached path and live reservation include the new diamond');
  if (!c) return;
  const rival = g.vehicles.buyTrain(f.dep, loco(), f.l.id) as Train;
  rival.releaseAll(); rival.pending = [makeSeg(g, net.edges.get(c.e1 === e.id ? c.e2 : c.e1)!, 1)]; rival.state = 'waiting';
  const h = deserialize(serialize(g));
  check(!(rival as any).tryExtend() && !(h.vehicles.get(rival.id) as any).tryExtend(), 'conflicting train is blocked both live and after load');
  for (let i = 0; i < 80; i++) { g.stepTick(); h.stepTick(); }
  check(JSON.stringify(serialize(g)) === JSON.stringify(serialize(h)), 'occupied diamond replays exactly');
});

done();
