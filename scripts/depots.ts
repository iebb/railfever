// Depots beside the line (user rule, 2.11: "do not build depots on start/end of the lines"): AI rail depots stand on a
// side siding off the running line, never on the way on beyond a terminus nor as the stub that ends a line, so that
// lines can run on as their towns grow; road and tram depots stand beside a street, never where a route or street ends.
//   levels   sidings at each level: level off ground track, a ramp off a viaduct, a cavern off a tunnel; trains serve
//   city     AI city railways (light rail, subway): both termini free ends, trains from the depot serve every station
//   legacy   an older line's depot straight on beyond its terminus moves beside the line (cheap and safe), a train
//            inside it with it, and the game replays exactly across the move
//   extend   an older line's yard beyond its terminus moves beside the line when the line runs on
//   ai       natural AI games (--seeds=7,11,23 --years=4): no AI depot on the way on beyond any line's terminus, every
//            line served from its depot, road depots beside streets; a save replays exactly
// Bundle into the scratch directory as depots.mjs and run node depots.mjs [section ...] [--seeds=..] [--years=..].
import '../src/game/patterns';
import { Game } from '../src/game/game';
import { AI_PRESETS } from '../src/game/ai';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import type { Station } from '../src/game/stations';
import type { Town } from '../src/game/towns';
import { bezLine } from '../src/game/geom';
import type { Line } from '../src/game/lines';
import { stationEnds, nodeSnap, depotAtEnd } from '../src/game/routing';
import { planEdge, commitProposal } from '../src/game/construction';
import { finishDoubleTrack, connectStationThroat } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { outAndBack, linearStops } from '../src/game/lines';
import { Train, depotServes } from '../src/game/train';
import { subwayOpts } from '../src/game/subway';
import { serialize, deserialize } from '../src/game/save';
import { depotSize } from '../src/game/build-ops';
import { terminusOf, outerEnd } from '../src/game/ai-grow';
import { scheduleNetworkTask, networkPlanner } from '../src/game/ai-network';
import { buildDepotBeside, endDepots } from '../src/game/depot-sites';
import { onwardEnd, terminalEnd, inOnward, rectPoints } from '../src/game/onward';
import { flat, newTown, district, cityLine, runDays, linePath, stat } from './linegrow-fixtures';
import { check, fails, fmt, checkReservations } from './lib';

if (!process.argv[1]?.endsWith('depots.mjs')) throw new Error('bundle this test as depots.mjs');
const T0 = performance.now();
const M = (id: string) => MODEL_BY_ID.get(id)!;
const args = process.argv.slice(2);
const want = args.filter((a) => !a.startsWith('--'));
const run = (name: string) => !want.length || want.includes(name);
const flag = (name: string, d: string) => args.find((s) => s.startsWith(`--${name}=`))?.slice(name.length + 3) ?? d;
const saved = (g: Game) => JSON.stringify(serialize(g));

/**
 * Depots of a rail line (of companies `owners`) that stand on the way on beyond one of its termini: on plain track that
 * leads from the terminus's outer platform ends to depots only (a stub, a terminal yard, a tail's ramp), or the line's
 * own depot (its trains' home) with its footprint straight on beyond the platforms. The offences; `nearby` collects
 * other lines' depots that a later terminus faces (the station's siting, not a depot built there).
 */
function endDepotsOf(g: Game, owners: (o: number) => boolean, nearby: string[] = []): string[] {
  const out: string[] = [], sz = depotSize('rail');
  for (const l of g.lines.map.values()) {
    if (l.kind !== 'rail' || !owners(l.owner)) continue;
    const path = l.loop ? null : linearStops(l.stops);
    if (!path) continue;
    const homes = new Set(l.vehicles.map((id) => (g.vehicles.get(id) as Train | undefined)?.depotId ?? -1));
    for (const [i, j] of [[0, 1], [path.length - 1, path.length - 2]]) {
      const T = g.stations.get(path[i]), N = g.stations.get(path[j]);
      if (!T?.rail || !N) continue;
      const end = outerEnd(T, N), ed = endDepots(g, T, end, l.owner);
      if (ed) out.push(`${l.name}: depot ${ed.depots.join(',')} on a lead beyond ${T.name}`);
      const way = terminalEnd(g, T, end) ? onwardEnd(g, T, end) : null;
      if (way) for (const d of g.depots.map.values()) {
        if (d.kind !== 'rail' || !owners(d.owner) || !rectPoints(d.x, d.z, d.angle, sz.w, sz.d).some((q) => inOnward(q, [way]))) continue;
        (homes.has(d.id) ? out : nearby).push(`${l.name}: depot ${d.id} on the way on beyond ${T.name}`);
      }
    }
  }
  return [...new Set(out)];
}

/** Road and tram depots of `owners` whose street ends in them (the depot's link joins a dead end). */
function deadEndRoadDepots(g: Game, owners: (o: number) => boolean): number[] {
  const net = g.world.net, out: number[] = [];
  for (const d of g.depots.map.values()) {
    if (d.kind === 'rail' || !owners(d.owner)) continue;
    const n = net.nodes.get(d.node);
    if (!n || n.edges.length >= 3) continue;
    const link = n.edges.map((id) => net.edges.get(id)).find((e) => !!e && e.depot < 0);
    const m = link && net.nodes.get(link.a === n.id ? link.b : link.a);
    if (!m || m.edges.length < 3) out.push(d.id);
  }
  return out;
}

/**
 * linegrow.ts's district (lots from beyond the row street beside the line, under the halved city walking reach): a street
 * grid every 8 units over [x0, x1] x [z - h/2, z + h/2], apartment blocks on lots outside the railway's strip.
 */
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
function cityDistrict(g: Game, t: Town, x0: number, x1: number, z: number, h: number, pop: number, cross = false, strip = true) {
  const xs: number[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += 8) xs.push(x);
  const zs: number[] = [];
  for (let k = 0; k * 8 <= h + 1e-6; k++) zs.push(z - h / 2 + k * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) { if (!cross && zs[i - 1] < z && zs[i] > z) continue; road(g, rx, zs[i - 1], rx, zs[i]); }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x0 + 2; rx < x1; rx += 4) {
    // (User rule, 2.10: walking reach halved again, an in-city light-rail stop walking 74 m along streets. 2.9 kept both
    // rows beside the line clear, lots from 109 m, which its stops no longer reach at all; lots now start beyond the row
    // street north of the line, 51 m. Lots beside rail track or depots stay empty, as below.)
    if (strip && Math.abs(rz + 1.1 - z) < 4) continue;
    const near = g.world.net.edgesNear(rx - 2.5, rz + 1.1 - 2.5, rx + 2.5, rz + 1.1 + 2.5).some((e) => e.kind === 'rail')
      || g.depots.near(rx, rz + 1.1, 3).length > 0;
    if (near) continue;
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i + t.buildings.size, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  t.pop += pop;
  let x = 0, zz = 0, n = 0;
  for (const id of t.buildings) { const b = g.world.buildings.get(id)!; x += b.x; zz += b.z; n++; }
  if (n) { t.x = x / n; t.z = zz / n; }
  t.radius = Math.max(t.radius, (x1 - x0) * 0.6);
  g.demand.rebuild();
}

/** Stations a line's trains load at over `days`. */
function calls(g: Game, l: Line, days: number): Set<number> {
  const seen = new Set<number>();
  runDays(g, days, () => { for (const id of l.vehicles) { const v = g.vehicles.get(id) as Train | undefined; if (v && v.state === 'loading' && v.atStation >= 0) seen.add(v.atStation); } });
  return seen;
}

/** A double-track metro line at `level` on a flat map, directional and signalled, without a depot. */
function plainLine(level: 'ground' | 'elevated' | 'underground', xs = [158, 208, 258]) {
  const { g, me } = flat();
  const net = g.world.net, sts: Station[] = [];
  for (const x of xs) {
    const id = g.stations.nextId;
    const p = g.stations.planRail(x, 256, Math.PI / 2, 12, 2, me, { trackType: 'electric', mode: 'metro', level, style: 'none',
      ...(level === 'underground' ? { depth: 2.2 } : level === 'elevated' ? { height: 1.5 } : {}) });
    const err = p.ok ? g.stations.commitRail(p, me) : p.error;
    if (err) throw new Error(`station ${x}: ${err}`);
    sts.push(g.stations.get(id)!);
  }
  const e0 = net.nextEdge;
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = stationEnds(g, sts[i]).map((e) => e.front), b = stationEnds(g, sts[i + 1]).map((e) => e.back);
    const o = level === 'underground' ? subwayOpts('electric', 2, me, 2.2)
      : { kind: 'rail' as const, type: 'electric', tracks: 2, heightOffset: 0, crossing: 'auto' as const, owner: me, level, levelHeight: level === 'elevated' ? 1.5 : undefined };
    const pj = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), o);
    if (!pj.ok || commitProposal(g, pj)) throw new Error(`track ${i}: ${pj.errors[0]}`);
  }
  const fin = finishDoubleTrack(g, [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id), me);
  if (fin.error) throw new Error('finish: ' + fin.error);
  const line = g.lines.create('rail', me);
  line.stops = outAndBack(sts.map((s) => s.id));
  g.lines.rebuild();
  autoSignalLine(g, line.id, me);
  return { g, me, sts, line };
}

// ------------------------------------------------------------------------------------------------ sidings at each level
if (run('levels')) {
  console.log('levels: a depot beside a double-track line on the ground, on a viaduct and in a tunnel');
  for (const level of ['ground', 'elevated', 'underground'] as const) {
    const { g, me, sts, line } = plainLine(level);
    const net = g.world.net, money = g.company(me).economy.money;
    const edges = [...net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0 && e.depot < 0).map((e) => e.id);
    const dep = buildDepotBeside(g, edges, sts[0].x, sts[0].z, me, line.stops, { sections: ['ground', 'bridge', 'tunnel'] });
    const d = g.depots.get(dep);
    console.log(`  ${level}: depot ${dep} ${d ? `at ${fmt(d.x)},${fmt(d.z)} (${d.level ?? 'surface'})` : '-'}, ${fmt((money - g.company(me).economy.money) / 1000, 0)}k`);
    check(!!d && (level === 'underground') === (d.level === 'underground'), `${level}: a depot beside the line (${level === 'underground' ? 'a cavern' : 'on the surface'})`);
    if (!d) continue;
    check(!endDepotsOf(g, () => true).length, `${level}: no depot on the way on beyond either terminus (${endDepotsOf(g, () => true).join('; ')})`);
    check(sts.every((st) => (['front', 'back'] as const).every((end) => !endDepots(g, st, end, me))), `${level}: no depot lead at any platform end`);
    check(depotServes(g, d, sts[0].id, sts[1].id) >= 0, `${level}: trains from the depot serve the line`);
    for (let i = 0; i < 2; i++) check(g.vehicles.buyTrain(dep, [M('metro_a')], line.id) instanceof Train, `${level}: train ${i + 1} bought there`);
    const seen = calls(g, line, 200);
    check(sts.every((st) => seen.has(st.id)), `${level}: trains call at every station (${seen.size}/${sts.length})`);
    check(!checkReservations(g).length, `${level}: reservations consistent`);
  }
}

// ------------------------------------------------------------------------------------------------ AI city railways
if (run('city')) {
  console.log('city: AI city railways keep both termini free ends; trains from the depot beside the line serve them');
  for (const mode of ['lightrail', 'metro'] as const) {
    const { g, ai } = flat();
    const t = newTown(g, 'Long City', 256, 256);
    district(g, t, 180, 332, 256, 64, 9000, true);
    g.aiEnabled = true;
    check(ai.startProject(mode, [t.id]), `${mode}: project starts`);
    let ticks = 0;
    while (ai.busy && ticks++ < 200000) g.stepTick();
    g.aiEnabled = false;
    const line = g.lines.all().find((l) => l.kind === 'rail' && l.owner === ai.companyId);
    check(!!line, `${mode}: the city railway opens (${ai.log.slice(-1).join('')})`);
    if (!line) continue;
    const path = linePath(line), dep = (g.vehicles.get(line.vehicles[0]) as Train | undefined)?.depotId ?? -1, d = g.depots.get(dep);
    const ends = [[path[0], path[1]], [path[path.length - 1], path[path.length - 2]]].map(([a, b]) => {
      const T = g.stations.get(a)!, N = g.stations.get(b)!;
      return terminusOf(g, T, outerEnd(T, N), ai.companyId)?.kind;
    });
    console.log(`  ${mode} (${g.stations.get(path[0])?.rail?.level}): ${path.length} stations, termini ${ends.join('/')}, depot ${dep} ${d?.level ?? 'surface'}`);
    check(ends.every((k) => k === 'free'), `${mode}: both termini are free ends (${ends.join('/')})`);
    check(!endDepotsOf(g, () => true).length, `${mode}: no depot on the way on (${endDepotsOf(g, () => true).join('; ')})`);
    const seen = calls(g, line, 360);
    check(path.every((sid) => seen.has(sid)), `${mode}: trains from the depot serve every station (${seen.size}/${path.length})`);
    check(!checkReservations(g).length, `${mode}: reservations consistent`);
  }
}

// ------------------------------------------------------------------------------------------------ an older end depot moves
if (run('legacy')) {
  console.log('legacy: a depot straight on beyond a terminus (an older layout) moves beside the line when that is cheap and safe');
  const { g, ai, me } = flat();
  const net = g.world.net, type = 'lightrail', xs = [158, 188, 218, 248];
  const t = newTown(g, 'Oldfield', 200, 256);
  // (residents a block away from the line, leaving room beside it)
  district(g, t, 150, 260, 300, 24, 3000);
  const sts: Station[] = [];
  for (const x of xs) {
    const id = g.stations.nextId, p = g.stations.planRail(x, 256, Math.PI / 2, 7, 2, me, { trackType: type, level: 'ground', style: 'none' });
    const err = p.ok ? g.stations.commitRail(p, me) : p.error;
    if (err) throw new Error(`station ${x}: ${err}`);
    sts.push(g.stations.get(id)!);
  }
  const e0 = net.nextEdge;
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = stationEnds(g, sts[i]).map((e) => e.front), b = stationEnds(g, sts[i + 1]).map((e) => e.back);
    const pj = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), { kind: 'rail', type, tracks: 2, heightOffset: 0, crossing: 'level', owner: me });
    if (!pj.ok || commitProposal(g, pj)) throw new Error(`track ${i}: ${pj.errors[0]}`);
  }
  const doubles = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id);
  // the 2.7 layout: a stub straight on from the east terminus's first track, the other track joined to it
  const east = sts[sts.length - 1], heads = stationEnds(g, east).map((e) => e.front), n0 = net.nodes.get(heads[0])!;
  const stub = planEdge(g, nodeSnap(g, heads[0], 'rail'), { kind: 'free', x: n0.x + 12, z: n0.z, y: 4 }, { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner: me });
  if (!stub.ok || commitProposal(g, stub)) throw new Error('stub: ' + stub.errors[0]);
  const old = depotAtEnd(g, net.nearestNode(n0.x + 12, n0.z, 0.1, 'rail', (n) => n.edges.length === 1)!.id, me);
  connectStationThroat(g, east.id, me);
  finishDoubleTrack(g, doubles, me);
  const line = g.lines.create('rail', me);
  line.stops = outAndBack(sts.map((s) => s.id));
  g.lines.rebuild();
  autoSignalLine(g, line.id, me);
  for (let i = 0; i < 2; i++) g.vehicles.buyTrain(old, [M('lrv_b')], line.id);
  const spare = g.vehicles.buyTrain(old, [M('lrv_b')], null) as Train;
  (ai as unknown as { adoptLines(): void }).adoptLines();
  runDays(g, 20);
  const before = endDepots(g, east, 'front', me);
  check(!!before && before.depots.includes(old), 'legacy: the old depot stands on a lead beyond the terminus');
  // the company's monthly review moves it; a copy saved before goes on exactly alike
  const copy = deserialize(JSON.parse(saved(g)));
  g.aiEnabled = copy.aiEnabled = true;
  let exact = true;
  for (let d = 0; d < 70 && g.depots.get(old); d++) { runDays(g, 1); runDays(copy, 1); exact &&= saved(g) === saved(copy); }
  runDays(g, 5); runDays(copy, 5); exact &&= saved(g) === saved(copy);
  g.aiEnabled = copy.aiEnabled = false;
  console.log('  ' + ai.log.slice(-1).join(''));
  const home = spare.depotId, nd = g.depots.get(home);
  check(!g.depots.get(old) && !!nd && home !== old, 'legacy: the old depot is taken down, a new one built');
  check(!spare.onMap && line.vehicles.every((id) => (g.vehicles.get(id) as Train).depotId === home), 'legacy: the trains (one inside the depot) have the new depot as their home');
  check(terminusOf(g, east, 'front', me)?.kind === 'free' && !before?.lead.some((id) => net.edges.has(id)), 'legacy: the lead is taken up; the terminus is a free end');
  check(!endDepotsOf(g, () => true).length, `legacy: no depot on the way on (${endDepotsOf(g, () => true).join('; ')})`);
  check(exact, 'legacy: a save from before the move replays it exactly');
  spare.setLine(line.id); spare.onLineChanged();
  const seen = calls(g, line, 200);
  check(sts.every((st) => seen.has(st.id)), `legacy: trains from the moved depot serve every station (${seen.size}/${sts.length})`);
  check(!checkReservations(g).length, 'legacy: reservations consistent');
}

// ------------------------------------------------------------------------------------------------ a yard moves as the line runs on
if (run('extend')) {
  console.log('extend: a yard beyond a terminus moves beside the line when the line runs on');
  // (linegrow.ts's Presholm: a dense district along a light-rail line, its yard beyond the east terminus; the town grows
  // past that terminus)
  const { g, ai, me } = flat();
  const t = newTown(g, 'Presholm', 220, 256);
  cityDistrict(g, t, 150, 270, 256, 32, 7000);
  const { line, sts, depot } = cityLine(g, me, [158, 183, 208, 233, 258], 256, 'east', 'tail', 6);
  runDays(g, 30);
  cityDistrict(g, t, 270, 342, 256, 32, 4500);
  runDays(g, 5);
  const east = sts[sts.length - 1], before = linePath(line);
  g.aiEnabled = true;
  scheduleNetworkTask(ai, 'extend', 0);
  for (let d = 0; d < 300 && !stat(ai, 'netExtended'); d++) runDays(g, 1);
  for (let d = 0; d < 30 && networkPlanner(ai)?.task === 'extend'; d++) runDays(g, 1);
  g.aiEnabled = false;
  const after = linePath(line), home = (g.vehicles.get(line.vehicles[0]) as Train).depotId;
  console.log('  ' + ai.log.slice(-2).join(' | '));
  check(after.length > before.length && after.indexOf(east.id) < after.length - 1, `extend: the line runs on beyond ${east.name} (${before.length} -> ${after.length})`);
  check(!g.depots.get(depot) && !!g.depots.get(home), 'extend: the yard beyond the old terminus is taken down');
  check(!endDepotsOf(g, () => true).length, `extend: no depot on the way on (${endDepotsOf(g, () => true).join('; ')})`);
  const seen = calls(g, line, 300);
  check(after.every((sid) => seen.has(sid)), `extend: trains from the moved depot serve every station (${seen.size}/${after.length})`);
}

// ------------------------------------------------------------------------------------------------ natural AI games
if (run('ai')) {
  const seeds = flag('seeds', '7,11,23').split(',').map(Number), years = Number(flag('years', '4'));
  console.log(`ai: natural AI games (seeds ${seeds.join(', ')}, ${years} years, three rivals)`);
  const styles = ['rail', 'balanced', 'aggressive'];
  for (const seed of seeds) {
    const g = Game.create({ size: 768, seed, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1950, aiCompanies: 3,
      aiConfigs: styles.map((s) => ({ ...(AI_PRESETS.find((p) => p.id === s) ?? AI_PRESETS[0]).config })) });
    const ai = (o: number) => !!g.companies[o]?.ai, t0 = performance.now();
    // a save half way goes on exactly as the original for 30 days (saved while no company is in the middle of an
    // unsaved job such as evaluating projects, which never resumes after loading, on 3c7c85a as well)
    const end = g.day + years * 360, at = g.day + Math.floor(years * 180);
    let copy: Game | null = null, exact = false, from = -1;
    while (g.day < end) {
      g.stepTick(); copy?.stepTick();
      if (from < 0 && g.day >= at && g.ais.every((a) => !a.busy)) { copy = deserialize(JSON.parse(saved(g))); from = g.day; }
      if (copy && g.day >= from + 30 && g.tick % g.ticksPerDay === 0) { exact = saved(g) === saved(copy); copy = null; }
    }
    const lines = g.lines.all().filter((l) => l.kind === 'rail' && ai(l.owner) && l.vehicles.length);
    const near: string[] = [], bad = endDepotsOf(g, ai, near);
    const served = lines.filter((l) => {
      const path = linearStops(l.stops) ?? [...new Set(l.stops)];
      return l.vehicles.some((id) => { const t = g.vehicles.get(id) as Train | undefined, d = t && g.depots.get(t.depotId); return !!d && depotServes(g, d, path[0], path[1]) >= 0; });
    });
    const stuck = lines.flatMap((l) => l.vehicles.map((id) => g.vehicles.get(id) as Train)).filter((t) => t && t.state === 'noroute');
    const rail = [...g.depots.map.values()].filter((d) => d.kind === 'rail' && ai(d.owner)).length;
    const roadBad = deadEndRoadDepots(g, ai);
    console.log(`  seed ${seed}: ${fmt((performance.now() - t0) / 1000, 0)} s; ${lines.length} AI railway lines, ${rail} rail depots, ${served.length} served from their depot, ${stuck.length} trains without a route; ${roadBad.length} road depots at a dead end`);
    for (const s of bad) console.log('    ' + s);
    for (const s of new Set(near)) console.log('    (another line\'s depot, faced by a later terminus) ' + s);
    check(!bad.length, `seed ${seed}: no AI depot on the way on beyond a terminus (${bad.length})`);
    check(served.length === lines.length, `seed ${seed}: every AI railway line's trains reach it from their depot (${served.length}/${lines.length})`);
    check(!stuck.length, `seed ${seed}: no AI train without a route (${stuck.length})`);
    check(!roadBad.length, `seed ${seed}: road depots stand beside a street (${roadBad.join(',')})`);
    check(exact, `seed ${seed}: a save from day ${from} replays 30 days exactly`);
    check(!checkReservations(g).length, `seed ${seed}: reservations consistent`);
  }
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exit(fails.length ? 1 : 0);
