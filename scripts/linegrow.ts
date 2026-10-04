// City lines grow with their towns (linegrow): termini that leave the line's way on free, an AI city line extended
// beyond its terminus when the town grows past it (trains through the new stations, the depot out of the way), a stop
// in a long gap that filled in, no extension where it does not pay, exact save/load replay (also mid-task), a depot
// moved with trains in it, and the player's stops inserted where they belong.
// Bundle into the scratch directory (linegrow.mjs) and run node linegrow.mjs [scenario ...] (default: all).
import '../src/game/patterns';
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { AIController } from '../src/game/ai';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import type { Line } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack, linearStops } from '../src/game/lines';
import { stationEnds, nodeSnap, depotAtEnd, buildDepotOnLine } from '../src/game/routing';
import { connectStationThroat, finishDoubleTrack, planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { planEdge, commitProposal } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';
import { runNetworkTask, networkPlanner, networkProfile, scheduleNetworkTask } from '../src/game/ai-network';
import { terminusOf, outerEnd, planTerminusYard, buildTerminusYard, cityStationSpacing, lineTrackAt } from '../src/game/ai-grow';
import { Train } from '../src/game/train';
import { patternHeadways, addPattern, setVehiclePattern, linePatterns } from '../src/game/patterns';
import { stopsWithInserted, replaceLineStops, type StopPlace } from '../src/game/line-edit';
import { check, fails, fmt, checkReservations } from './lib';

const M = (id: string) => MODEL_BY_ID.get(id)!;
const want = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const run = (name: string) => !want.length || want.includes(name);
const stat = (ai: AIController, k: string) => (ai.stats as unknown as Record<string, number>)[k] ?? 0;
const runDays = (g: Game, days: number, each?: () => void) => { const end = g.day + days; while (g.day < end) { g.stepTick(); each?.(); } };

/** A flat world with one AI company (no projects of its own; the network task runs when a scenario says). */
function flat(companies = 1): { g: Game; ai: AIController; me: number } {
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: Array.from({ length: companies }, () => ({ startMoney: 150_000_000, accessPolicy: 'open' as const })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  // (the network tasks run when a scenario says: runNetworkTask, or g.aiEnabled for the daily work)
  g.aiEnabled = false;
  const ai = g.ais[0];
  for (const c of g.ais) c.state.cooldown = 1e9;
  return { g, ai, me: ai.companyId };
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
function newTown(g: Game, name: string, x: number, z: number): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius: 60, buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false,
    passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  return t;
}
/**
 * A district of a town: a street grid every 8 units over [x0, x1] x [z - h/2, z + h/2] (rows along x; no street across
 * the railway's strip |dz| < 7 unless `cross`), apartment blocks on lots along the rows outside the strip, `pop` residents.
 * Lots near rail track or depots stay empty (the district grows around the railway).
 */
function district(g: Game, t: Town, x0: number, x1: number, z: number, h: number, pop: number, cross = false, strip = true) {
  const xs: number[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += 8) xs.push(x);
  const zs: number[] = [];
  for (let k = 0; k * 8 <= h + 1e-6; k++) zs.push(z - h / 2 + k * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) { if (!cross && zs[i - 1] < z && zs[i] > z) continue; road(g, rx, zs[i - 1], rx, zs[i]); }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x0 + 2; rx < x1; rx += 4) {
    if (strip && Math.abs(rz - z) < 7) continue;
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

/** A ground light-rail city line of `owner` along z = `z` with stations at `xs`, double track, signals and trains. */
function cityLine(g: Game, owner: number, xs: number[], z: number, depotAt: 'west' | 'east', yard: 'tail' | 'old', trains = 2): { line: Line; sts: Station[]; depot: number } {
  const type = 'lightrail', PL = 7, net = g.world.net;
  const sts: Station[] = [];
  for (const x of xs) {
    const id = g.stations.nextId, p = g.stations.planRail(x, z, Math.PI / 2, PL, 2, owner, { trackType: type, level: 'ground', style: 'none' });
    const err = p.ok ? g.stations.commitRail(p, owner) : p.error;
    if (err) throw new Error(`station at ${x}: ${err}`);
    sts.push(g.stations.get(id)!);
  }
  const e0 = net.nextEdge;
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = stationEnds(g, sts[i]).map((e) => e.front), b = stationEnds(g, sts[i + 1]).map((e) => e.back);
    const pj = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), { kind: 'rail', type, tracks: 2, heightOffset: 0, crossing: 'level', owner });
    if (!pj.ok || commitProposal(g, pj)) throw new Error(`track ${i}: ${pj.errors[0]}`);
  }
  const doubles = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id);
  const at = depotAt === 'west' ? sts[0] : sts[sts.length - 1], N = depotAt === 'west' ? sts[1] : sts[sts.length - 2];
  let depot = -1;
  if (yard === 'tail') {
    const y = planTerminusYard(g, owner, at, outerEnd(at, N), null, () => true);
    if (!y) throw new Error('no yard site');
    depot = buildTerminusYard(g, owner, y, () => true);
  } else {
    // the 2.7 layout: a ramp straight on from the first track, the other track joined to it
    const end = outerEnd(at, N), heads = stationEnds(g, at).map((e) => e[end]);
    const n0 = net.nodes.get(heads[0])!, sg = end === 'front' ? 1 : -1;
    const pj = planEdge(g, nodeSnap(g, heads[0], 'rail'), { kind: 'free', x: n0.x + 12 * sg, z: n0.z, y: 4 }, { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner });
    if (!pj.ok || commitProposal(g, pj)) throw new Error('old ramp: ' + pj.errors[0]);
    const endNode = net.nearestNode(n0.x + 12 * sg, n0.z, 0.1, 'rail', (n) => n.edges.length === 1)!;
    depot = depotAtEnd(g, endNode.id, owner);
    connectStationThroat(g, at.id, owner);
  }
  if (depot < 0) throw new Error('no depot');
  finishDoubleTrack(g, doubles, owner);
  const line = g.lines.create('rail', owner);
  line.stops = outAndBack(sts.map((s) => s.id));
  g.lines.rebuild();
  autoSignalLine(g, line.id, owner);
  for (let i = 0; i < trains; i++) { const t = g.vehicles.buyTrain(depot, [M('lrv_b')], line.id); if (!(t instanceof Train)) throw new Error(String(t)); }
  // (an AI company takes the line on as its own: AIController.adoptLines)
  (g.aiOf(owner) as unknown as { adoptLines(): void } | undefined)?.adoptLines();
  return { line, sts, depot };
}

/** Stations trains of a line stop at over some days (loading there). */
function calls(g: Game, l: Line, days: number): Set<number> {
  const seen = new Set<number>();
  runDays(g, days, () => { for (const id of l.vehicles) { const v = g.vehicles.get(id) as Train | undefined; if (v && v.state === 'loading' && v.atStation >= 0) seen.add(v.atStation); } });
  return seen;
}

/**
 * No depot or track straight on beyond a terminus's outer end, other than a branch turning off within the switch zone
 * of the new track's start (the platform ends, or a tail's fork `from` units out): its tracks have room there.
 */
function wayOnFree(g: Game, st: Station, end: 'front' | 'back', reach: number, from = 0): string | null {
  const r = st.rail!, sg = end === 'front' ? 1 : -1, ux = Math.sin(r.angle) * sg, uz = Math.cos(r.angle) * sg;
  const ex = r.x + ux * r.length / 2, ez = r.z + uz * r.length / 2, half = (r.width ?? 2) / 2 + 0.6;
  for (let s = from + 14.5; s <= reach; s += 1) {
    const x = ex + ux * s, z = ez + uz * s;
    if (g.depots.near(x, z, half).length) return `a depot ${s} units out`;
    const e = g.world.net.nearestEdge(x, z, half, 'rail');
    if (e && Math.abs(g.world.net.heightAtS(e.edge, e.s) - r.y) < 0.62) return `track ${s} units out`;
  }
  for (const d of g.depots.map.values()) {
    const dx = d.x - ex, dz = d.z - ez, along = dx * ux + dz * uz, lat = Math.abs(dx * uz - dz * ux);
    if (along > 0 && along < reach && lat < half + 1.5) return `depot ${d.id} on the way on`;
  }
  return null;
}

function linePath(l: Line): number[] { return linearStops(l.stops) ?? []; }

// ------------------------------------------------------------------------------------------------ scenarios
if (run('termini')) {
  console.log('termini: an AI city railway keeps its termini free ends the line can run on from');
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
    check(!!line, `${mode}: the city railway opens (${ai.log.slice(-2).join(' | ')})`);
    if (!line) continue;
    const path = linePath(line);
    for (const [T, N] of [[path[0], path[1]], [path[path.length - 1], path[path.length - 2]]].map(([a, b]) => [g.stations.get(a)!, g.stations.get(b)!])) {
      const end = outerEnd(T, N), te = terminusOf(g, T, end, ai.companyId)!;
      const free = wayOnFree(g, T, end, cityStationSpacing(g, T.x, T.z, lineTrackAt(g, T), T.rail!.length) * 1.5, te.kind === 'tail' ? te.tail : 0);
      console.log(`  ${mode} ${T.name}: ${te.kind}${te.kind === 'tail' ? ` (tail ${fmt(te.tail)} from track ${te.root})` : ''}; way on: ${free ?? 'free'}`);
      check(te.kind === 'free' || te.kind === 'tail', `${mode} ${T.name}: the terminus is a free end or a tail beside its way on (${te.kind})`);
      check(!free, `${mode} ${T.name}: nothing straight on beyond the platforms (${free})`);
    }
    const seen = calls(g, line, 360);
    if (!path.every((sid) => seen.has(sid)) || process.argv.includes('--trains')) console.log('  trains: ' + line.vehicles.map((id) => { const v = g.vehicles.get(id) as Train; const w = v as unknown as Record<string, any>; const p = { x: 0, y: 0, z: 0 }; v.worldPos(p); return `${v.name} ${v.state} '${v.status}' at ${v.atStation} speed ${fmt(v.speed, 2)} stuck ${fmt(w.stuckTime ?? 0)} by ${w.blockedBy} pos ${fmt(p.x)},${fmt(p.z)} segs ${(w.segs ?? []).map((q: { e: number }) => q.e).join('/')} pend ${(w.pending ?? []).map((q: { e: number }) => q.e).join('/')}`; }).join('\n    '));
    check(path.every((sid) => seen.has(sid)), `${mode}: trains from the depot serve every station (${seen.size}/${path.length})`);
    check(checkReservations(g).length === 0, `${mode}: reservations consistent`);
  }
}

/** Presholm: a city light-rail line along a town (its depot at one end), the town grown past its east terminus by `grow` residents. */
function presholm(depotAt: 'west' | 'east', yard: 'tail' | 'old', trains: number, grow: number, companies = 1) {
  const { g, ai, me } = flat(companies);
  const t = newTown(g, 'Presholm', 220, 256);
  // These construction cases need a dense walking district under half city reach.
  // Keep the population, concentrate its buildings near the platforms.
  district(g, t, 150, 270, 256, 32, 7000);
  // The old three-train fixture earns more by adding fleet on its existing route (validation finding 2).
  // Construction scenarios start with that demand already served, so new district coverage wins on incentives.
  const { line, sts, depot } = cityLine(g, me, [158, 183, 208, 233, 258], 256, depotAt, yard, Math.max(6, trains));
  runDays(g, 30);
  if (grow) district(g, t, 270, 342, 256, 32, grow);
  runDays(g, 5);
  return { g, ai, me, t, line, sts, depot };
}
/** The company's daily network work with the task brought forward (as its schedule would run it), until it extended or `days` passed. */
function growDaily(g: Game, ai: AIController, days: number, done = () => stat(ai, 'netExtended') + stat(ai, 'netGrowInfill') > 0) {
  g.aiEnabled = true;
  scheduleNetworkTask(ai, 'extend', 0);
  for (let d = 0; d < days && !done(); d++) runDays(g, 1);
  for (let d = 0; d < 30 && networkPlanner(ai)?.task === 'extend'; d++) runDays(g, 1);
  g.aiEnabled = false;
}
const decisions = () => Object.entries(networkProfile.decisions).filter(([k]) => k.startsWith('extend.')).map(([k, v]) => `${k} ${v}`).join(', ');

if (run('extend')) {
  console.log('extend: the town grows past a city line\'s terminus; the line runs on through new stations');
  // Maintaining frequency must pay for each departure's occupation and delay. This new district
  // funds the third profitable train; at 4500 residents its marginal return was negative.
  const { g, ai, me, line, sts, depot } = presholm('west', 'tail', 3, 6500);
  const before = linePath(line), east = sts[sts.length - 1], trains0 = line.vehicles.length;
  const head0 = patternHeadways(g, line)[0]?.headway ?? 0;
  networkProfile.tasks['extend'] = { steps: 0, ms: 0, max: 0 };
  growDaily(g, ai, 300);
  const after = linePath(line);
  console.log('  ' + ai.log.slice(-3).join(' | '));
  console.log(`  decisions: ${decisions()}`);
  const tp = networkProfile.tasks['extend'];
  console.log(`  work units: ${tp?.steps ?? 0}, ${fmt(tp?.ms ?? 0)} ms, slowest ${fmt(tp?.max ?? 0)} ms`);
  check(stat(ai, 'netExtended') === 1 && after.length > before.length, `extend: the line runs on beyond ${east.name} (${before.length} -> ${after.length} stations)`);
  const added = after.filter((sid) => !before.includes(sid));
  check(added.length >= 1 && added.every((sid) => (g.stations.get(sid)?.x ?? 0) > east.x + 5), 'extend: the new stations lie beyond the old terminus');
  check(after.indexOf(east.id) > 0 && after.indexOf(east.id) < after.length - 1, 'extend: the old terminus is a through stop now');
  check(!!g.depots.get(depot), 'extend: the depot at the other end stays');
  const last = g.stations.get(after[after.length - 1])!;
  const te = terminusOf(g, last, outerEnd(last, g.stations.get(after[after.length - 2])!), me);
  check(te?.kind === 'free', `extend: the new terminus is a free end again (${te?.kind})`);
  // (the build runs in steps, each a work unit: the valuations, its three stations, the track, the line; wall-clock
  // times on a shared machine vary, so the bound is loose)
  check((tp?.steps ?? 0) >= 9 && (tp?.max ?? 99) < 50, `extend: the work runs in short units (${tp?.steps ?? 0} units, slowest ${fmt(tp?.max ?? 0)} ms)`);
  const seen = calls(g, line, 240);
  const head1 = patternHeadways(g, line)[0]?.headway ?? 0;
  console.log(`  trains ${trains0} -> ${line.vehicles.length}, headway ${fmt(head0, 0)} -> ${fmt(head1, 0)} s`);
  check(line.vehicles.length > trains0 && head1 <= head0 * 1.25, 'extend: trains added for about today\'s headway');
  check(added.every((sid) => seen.has(sid)) && seen.has(east.id), `extend: trains call at the new stations and run through ${east.name} (${[...seen].join(',')})`);
  check(checkReservations(g).length === 0, 'extend: reservations consistent');
}

if (run('offset')) {
  console.log('offset: a station site that does not work moves on along the line');
  const { g, ai, me, t, line, sts } = presholm('west', 'tail', 3, 0);
  // (another company's halt beside the way on, too near the first new station's ideal site: 11 units off it)
  const east = sts[sts.length - 1], ideal = east.x + east.rail!.length / 2 + 18 + east.rail!.length / 2;
  const id = g.stations.nextId, p = g.stations.planRail(ideal - 5, 266, Math.PI / 2, 7, 1, 0, { level: 'ground', style: 'none' });
  check(p.ok && !g.stations.commitRail(p, 0), `offset: a halt beside the way on (${p.error ?? 'ok'})`);
  const halt = g.stations.get(id);
  district(g, t, 270, 342, 256, 32, 4500);
  runDays(g, 5);
  const before = linePath(line);
  growDaily(g, ai, 300);
  const after = linePath(line), added = after.filter((sid) => !before.includes(sid)), first = g.stations.get(added[0] ?? -1);
  console.log('  ' + ai.log.slice(-1).join(' | '));
  console.log(`  first new station at ${fmt(first?.x ?? 0)},${fmt(first?.z ?? 0)} (ideal ${fmt(ideal)},256; the halt at ${fmt(halt?.x ?? 0)},${fmt(halt?.z ?? 0)})`);
  check(stat(ai, 'netExtended') === 1 && !!first && !after.includes(id), `offset: the line runs on beyond ${east.name} (${before.length} -> ${after.length})`);
  check(!!first && !!halt && first.x >= ideal + 4.9 && Math.hypot(first.x - halt.x, first.z - halt.z) > 13, `offset: its first new station moved on from the ideal site (${fmt(first?.x ?? 0)},${fmt(first?.z ?? 0)} vs ${fmt(ideal)},256)`);
  check(checkReservations(g).length === 0, 'offset: reservations consistent');
  void me;
}

if (run('underground')) {
  console.log('underground: a dense district built across the line\'s way on: the line runs on in a tunnel');
  const { g, ai, me, t, line, sts } = presholm('west', 'tail', 3, 0);
  // (a square, then blocks of flats with their streets right across the way on)
  district(g, t, 292, 372, 256, 32, 6000, true, false);
  runDays(g, 5);
  const before = linePath(line), east = sts[sts.length - 1];
  growDaily(g, ai, 300);
  const after = linePath(line), added = after.filter((sid) => !before.includes(sid));
  console.log('  ' + ai.log.slice(-2).join(' | '));
  console.log(`  decisions: ${decisions()}`);
  check(stat(ai, 'netExtended') === 1 && added.length >= 1, `underground: the line runs on beyond ${east.name} (${before.length} -> ${after.length})`);
  check(added.length >= 1 && added.every((sid) => g.stations.get(sid)?.rail?.level === 'underground'), 'underground: its new stations lie underground');
  const seen = calls(g, line, 240);
  check(added.every((sid) => seen.has(sid)), 'underground: trains call there');
  check(checkReservations(g).length === 0, 'underground: reservations consistent');
}

if (run('services')) {
  console.log('services: a short-turn service and another company\'s trains on the line keep working as it grows');
  const { g, ai, me, line, sts, depot } = presholm('west', 'tail', 2, 4500, 2);
  // a short-turn service over the first three stations, with a train of its own
  const short = addPattern(g, line.id, 'local', line.stops.map((sid) => sts.slice(0, 3).some((s) => s.id === sid)), 'Short');
  const st0 = g.vehicles.buyTrain(depot, [M('lrv_b')], line.id) as Train;
  // The player keeps this timetable while the AI coordinates its own and its partner's fleet.
  // A loss-making AI short turn may be withdrawn before growth, which is a separate capacity decision.
  g.setAccessPolicy(0, 'open');
  sts[0].owner = 0; st0.owner = 0;
  check(g.lines.join(line.id, 0) === null, 'services: the player joins with its short-turn train');
  check(!!short && !setVehiclePattern(g, st0.id, short.id), 'services: a short-turn service runs');
  // another company runs trains on the line too (it owns one of its stations; open access)
  const partner = g.ais[1].companyId;
  sts[1].owner = partner;
  check(g.lines.join(line.id, partner) === null, 'services: the partner joins the line');
  const net = g.world.net;
  let pdep = -1;
  for (const e of [...net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === me && e.station < 0 && e.depot < 0 && e.len > 8).sort((a, b) => a.id - b.id)) {
    pdep = buildDepotOnLine(g, e.id, e.len / 2, partner);
    if (pdep >= 0) break;
  }
  const pt = pdep >= 0 ? g.vehicles.buyTrain(pdep, [M('lrv_b')], line.id) : 'no depot';
  check(pt instanceof Train, `services: the partner's train on the line (${typeof pt === 'string' ? pt : 'ok'})`);
  runDays(g, 20);
  const before = linePath(line), east = sts[sts.length - 1];
  growDaily(g, ai, 300);
  const after = linePath(line), added = after.filter((sid) => !before.includes(sid));
  console.log('  ' + ai.log.slice(-1).join(' | '));
  check(stat(ai, 'netExtended') === 1 && added.length >= 1, `services: the line runs on beyond ${east.name}`);
  const pats = linePatterns(line), sp = pats.find((p) => p.id === short?.id), local = pats.find((p) => p.id !== short?.id);
  const at = (p: typeof sp, sid: number) => line.stops.some((x, i) => x === sid && p!.stops[i] !== false);
  check(!!sp && added.every((sid) => !at(sp, sid)) && !!local && added.every((sid) => at(local, sid)), 'services: the short-turn keeps its stops, the local serves the new stations');
  const seenShort = new Set<number>(), seenPartner = new Set<number>();
  runDays(g, 300, () => {
    if (st0.state === 'loading' && st0.atStation >= 0) seenShort.add(st0.atStation);
    if (pt instanceof Train && pt.state === 'loading' && pt.atStation >= 0) seenPartner.add(pt.atStation);
  });
  check([...seenShort].every((sid) => sts.slice(0, 3).some((s) => s.id === sid)) && seenShort.size >= 2, `services: the short-turn train stays on its stretch (${[...seenShort].join(',')})`);
  check(added.some((sid) => seenPartner.has(sid)), `services: the partner's train runs on to the new stations (${[...seenPartner].join(',')})`);
  check(checkReservations(g).length === 0, 'services: reservations consistent');
}

if (run('nopay')) {
  console.log('nopay: a few houses beyond the terminus: no extension');
  const { g, ai, line } = presholm('west', 'tail', 3, 160);
  const before = linePath(line);
  growDaily(g, ai, 200);
  console.log(`  decisions: ${decisions()}`);
  check(stat(ai, 'netExtended') === 0 && linePath(line).join() === before.join(), 'nopay: the line keeps its stations');
  check((networkProfile.decisions['extend.line'] ?? 0) > 0, 'nopay: the line was looked at');
}

if (run('infill')) {
  console.log('infill: the town fills in a long gap between two stations; a stop goes in there');
  const { g, ai, me } = flat();
  const t = newTown(g, 'Gapford', 220, 256);
  district(g, t, 150, 195, 256, 64, 3500);
  district(g, t, 246, 296, 256, 64, 3500);
  // Cover the existing route's fleet opportunity first; the gap's new catchment can then justify a halt.
  const { line, sts } = cityLine(g, me, [158, 183, 258, 283], 256, 'west', 'tail', 12);
  runDays(g, 30);
  district(g, t, 195, 246, 256, 64, 5000);
  runDays(g, 5);
  const before = linePath(line);
  check(runNetworkTask(ai, 'extend' as never), 'infill: the task runs');
  const after = linePath(line);
  console.log('  ' + ai.log.slice(-2).join(' | '));
  console.log(`  decisions: ${decisions()}`);
  const added = after.filter((sid) => !before.includes(sid)), st = g.stations.get(added[0] ?? -1);
  check(stat(ai, 'netGrowInfill') === 1 && added.length === 1, `infill: one new stop (${before.length} -> ${after.length})`);
  check(!!st && st.x > sts[1].x + 10 && st.x < sts[2].x - 10 && after.indexOf(st.id) === after.indexOf(sts[1].id) + 1, 'infill: between the two stations of the gap');
  const seen = calls(g, line, 240);
  check(!!st && seen.has(st.id), 'infill: trains call there');
  check(checkReservations(g).length === 0, 'infill: reservations consistent');
}

if (run('relocate')) {
  console.log('relocate: a depot straight on beyond the terminus moves beside the line, a train inside it with it');
  const { g, ai, me, line, sts, depot } = presholm('east', 'old', 2, 4500);
  const east = sts[sts.length - 1], before = linePath(line);
  // a spare train in the depot (no line yet) and one more for the line, waiting to leave
  const spare = g.vehicles.buyTrain(depot, [M('lrv_b')], null) as Train;
  const queued = g.vehicles.buyTrain(depot, [M('lrv_b')], line.id) as Train;
  check(spare instanceof Train && queued instanceof Train && !spare.onMap, 'relocate: a train stands in the depot');
  const old = terminusOf(g, east, outerEnd(east, sts[sts.length - 2]), me);
  check(old?.kind === 'lead', `relocate: the old depot lead sits beyond the terminus (${old?.kind})`);
  growDaily(g, ai, 300);
  console.log('  ' + ai.log.slice(-3).join(' | '));
  console.log(`  decisions: ${decisions()}`);
  const after = linePath(line);
  check(stat(ai, 'netDepotsMoved') === 1 && !g.depots.get(depot), 'relocate: the old depot is taken down');
  const home = spare.depotId, nd = g.depots.get(home);
  check(!!nd && home !== depot && nd.owner === me && !spare.onMap, 'relocate: the train inside moved with the depot');
  check(line.vehicles.every((id) => (g.vehicles.get(id) as Train).depotId === home), 'relocate: the line\'s trains have the new depot as their home');
  check(stat(ai, 'netExtended') === 1 && after.length > before.length && after.indexOf(east.id) < after.length - 1, `relocate: the line runs on beyond ${east.name} (${before.length} -> ${after.length})`);
  check(!old || !old.lead.some((id) => g.world.net.edges.has(id)), 'relocate: the old lead is taken up');
  const last = g.stations.get(after[after.length - 1])!, nte = terminusOf(g, last, outerEnd(last, g.stations.get(after[after.length - 2])!), me);
  const way = nte ? wayOnFree(g, last, nte.end, 40, nte.tail) : 'no terminus';
  check(nte?.kind === 'tail' && !way, `relocate: the depot's new yard leaves the new terminus extendable (${nte?.kind}; ${way ?? 'way on free'})`);
  spare.setLine(line.id);
  // Start beside its relocated depot, then verify the service through subsequent stops.
  spare.stopIndex = line.stops.indexOf(last.id); spare.onLineChanged();
  const seen = new Set<number>();
  runDays(g, 240, () => { if (spare.state === 'loading' && spare.atStation >= 0) seen.add(spare.atStation); });
  check(seen.size >= 2, `relocate: the train from the moved depot runs the line (${seen.size} stations)`);
  check(checkReservations(g).length === 0, 'relocate: reservations consistent');
}

if (run('tailend')) {
  console.log('tailend: the line runs on from the terminus with its yard; the yard moves out to the new terminus');
  const { g, ai, me, line, sts, depot } = presholm('east', 'tail', 3, 4500);
  const east = sts[sts.length - 1], before = linePath(line);
  const te0 = terminusOf(g, east, outerEnd(east, sts[sts.length - 2]), me);
  check(te0?.kind === 'tail' && te0.depots.includes(depot), `tailend: the yard's ramp leaves the tail beyond ${east.name} (${te0?.kind})`);
  growDaily(g, ai, 300);
  console.log('  ' + ai.log.slice(-2).join(' | '));
  const after = linePath(line), added = after.filter((sid) => !before.includes(sid));
  check(stat(ai, 'netExtended') === 1 && added.length >= 1 && after.indexOf(east.id) < after.length - 1, `tailend: the line runs on beyond ${east.name} (${before.length} -> ${after.length})`);
  const home = (g.vehicles.get(line.vehicles[0]) as Train).depotId;
  check(stat(ai, 'netDepotsMoved') === 1 && !g.depots.get(depot) && !!g.depots.get(home) && !te0?.lead.some((id) => g.world.net.edges.has(id)),
    'tailend: the depot moved out to the new terminus, its old ramp taken up');
  const last = g.stations.get(after[after.length - 1])!, nte = terminusOf(g, last, outerEnd(last, g.stations.get(after[after.length - 2])!), me);
  check(nte?.kind === 'tail' && nte.depots.includes(home), `tailend: the new terminus has the yard beside its way on (${nte?.kind})`);
  const seen = calls(g, line, 300), stuck = line.vehicles.map((id) => g.vehicles.get(id) as Train).filter((t) => t.state === 'noroute');
  check(after.every((sid) => seen.has(sid)), `tailend: trains call at every station (${seen.size}/${after.length})`);
  check(!stuck.length && line.vehicles.every((id) => (g.vehicles.get(id) as Train).depotId === home), `tailend: every train (the new ones too) finds its way from the depot (${stuck.map((t) => t.status).join('; ') || 'none stuck'})`);
  check(checkReservations(g).length === 0, 'tailend: reservations consistent');
}

if (run('replay')) {
  console.log('replay: saves while the task surveys, values and builds replay exactly');
  const { g, ai } = presholm('west', 'tail', 3, 4500);
  g.aiEnabled = true;
  scheduleNetworkTask(ai, 'extend', 0);
  const days = (n: number, loaded: { g: Game }[]) => { for (let d = 0; d < n; d++) for (let k = 0; k < TICKS_PER_DAY; k++) { g.stepTick(); for (const r of loaded) r.g.stepTick(); } };
  for (let d = 0; d < 200 && networkPlanner(ai)?.task !== 'extend'; d++) days(1, []);
  check(networkPlanner(ai)?.task === 'extend', 'replay: the task is in flight');
  const runs: { g: Game; at: number; ok: boolean }[] = [];
  let compared = 0;
  for (let d = 0; d < 60; d++) {
    if (networkPlanner(ai)?.task === 'extend' && runs.length < 10) {
      const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
      const same = JSON.stringify(serialize(loaded)) === data;
      check(same, `replay: day ${g.day} round trip`);
      runs.push({ g: loaded, at: g.day, ok: same });
    }
    days(1, runs.filter((r) => r.ok));
    const now = JSON.stringify(serialize(g));
    for (const r of runs) {
      if (!r.ok) continue;
      const other = JSON.stringify(serialize(r.g));
      compared++;
      if (other !== now) {
        let i = 0; while (i < now.length && now[i] === other[i]) i++;
        check(false, `replay: saved on day ${r.at}, differs on day ${g.day} at ${i}: ${now.slice(Math.max(0, i - 80), i + 80)} vs ${other.slice(Math.max(0, i - 80), i + 80)}`);
        r.ok = false;
      }
    }
  }
  console.log(`  ${runs.length} saves during the task, ${compared} daily comparisons; extended: ${stat(ai, 'netExtended')}; ${runs.filter((r) => r.ok).length} replays exact`);
  check(runs.length >= 4 && runs.every((r) => r.ok) && stat(ai, 'netExtended') === 1, 'replay: every save replays exactly through the build');
}

if (run('player')) {
  console.log('player: track on from a terminus and new stops at the end and in between, without rebuilding the line');
  const { g } = flat();
  const t = newTown(g, 'Playford', 220, 256);
  district(g, t, 150, 300, 256, 64, 6000);
  g.economy.money = 80_000_000;
  const { line, sts } = cityLine(g, 0, [158, 228, 253], 256, 'west', 'tail', 2);
  line.stops = sts.map((s) => s.id); line.loop = false; g.lines.rebuild();
  for (const v of line.vehicles) g.vehicles.get(v)?.onLineChanged();
  const add = (sid: number, place: StopPlace) => {
    const r = stopsWithInserted(g, line, sid, place);
    if (r) replaceLineStops(g, line, r.stops);
    return r;
  };
  // the rail tool from the terminus's free track ends: double track on to a new station
  const C = sts[2], heads = stationEnds(g, C).map((e) => e.front);
  const id = g.stations.nextId, p = g.stations.planRail(C.x + 25, 256, Math.PI / 2, 7, 2, 0, { trackType: 'lightrail', level: 'ground', style: 'none' });
  check(p.ok && !g.stations.commitRail(p, 0), `player: a station beyond the terminus (${p.error ?? 'ok'})`);
  const D = g.stations.get(id)!;
  const start = nodeSnap(g, heads[0], 'rail');
  check((start.group?.length ?? 0) === 2, 'player: the terminus\'s two free track ends snap together');
  const pj = planEdge(g, start, nodeSnap(g, stationEnds(g, D)[0].back, 'rail'), { kind: 'rail', type: 'lightrail', tracks: 2, heightOffset: 0, crossing: 'level', owner: 0 });
  check(pj.ok && pj.tracks.length === 2 && !commitProposal(g, pj), `player: double track continues from the terminus (${pj.errors[0] ?? 'ok'})`);
  const r1 = add(D.id, 'end');
  check(!!r1 && line.stops.join() === [...sts.map((s) => s.id), D.id].join(), 'player: the new station is the new last stop');
  // a station cut into the line between its first two stops (the station tool on a line), added where it fits
  const net = g.world.net, q = { x: 0, y: 0, z: 0 };
  let spot: { e: number; s: number } | null = null;
  for (const e of [...net.edges.values()].sort((a, b) => a.id - b.id)) {
    if (e.kind !== 'rail' || e.owner !== 0 || e.station >= 0 || e.depot >= 0 || e.len < 2) continue;
    for (let s = 0.5; s < e.len; s += 0.5) { net.pointAt(e, s, q); if (Math.abs(q.x - 193) < 0.3 && q.z > 256) { spot = { e: e.id, s }; break; } }
    if (spot) break;
  }
  const plan = spot ? planStationOnTrack(g, spot.e, spot.s, { length: 7, tracks: 2, style: 'none' }, 0) : null;
  const made = plan?.ok ? commitStationOnTrack(g, plan) : null;
  const E = made && !made.error ? g.stations.get(made.station) : undefined;
  check(!!E, `player: a station cut into the line between ${sts[0].name} and ${sts[1].name} (${plan?.error ?? made?.error ?? 'ok'})`);
  if (E) {
    const r2 = add(E.id, 'auto');
    check(!!r2 && line.stops.join() === [sts[0].id, E.id, sts[1].id, sts[2].id, D.id].join(), 'player: added where it fits, between the two stops');
  }
  check(add(D.id, 'end') === null, 'player: the last stop is not added again');
  const F = stopsWithInserted(g, line, sts[1].id, 'start');
  check(!!F && F.stops[0] === sts[1].id && F.at === 0, 'player: a stop can go first');
  const G = stopsWithInserted(g, line, D.id, 0);
  check(!!G && G.stops[1] === D.id, 'player: a stop can go after a chosen one');
  const seen = calls(g, line, 360);
  check(seen.has(D.id) && (!E || seen.has(E.id)), `player: trains serve the new last stop and the one in between (${[...seen].map((s) => g.stations.get(s)?.name).join(', ')})`);
  check(checkReservations(g).length === 0, 'player: reservations consistent');
}

console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
