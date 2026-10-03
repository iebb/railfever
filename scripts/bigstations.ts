// Bigger stations and a connected network: building styles (placements, access, costs, restyling, save),
// expanding a running terminus from 2 to 4 platforms (turnout ladder, signals, capacity figures), a connection
// between two lines, two single tracks paired into a double track, and merging stations (one rail part, or a
// transfer complex shown as one station).
// npx esbuild scripts/bigstations.ts --bundle --platform=node --format=esm --outfile=$S/bigstations.mjs && node $S/bigstations.mjs
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { restoreStation, planStationUpgrade, commitStationUpgrade, stationCapacity, stationComplex } from '../src/game/stations';
import type { Station } from '../src/game/stations';
import { STATION_STYLES, stylesFor, defaultStationStyle, styleOf } from '../src/game/station-styles';
import { finishDoubleTrack, planConnection, commitConnection, pairAsDoubleTrack, canMerge, mergeStations } from '../src/game/trackops';
import { autoSignalNetwork } from '../src/game/signals';
import { Train, findRailRoute, railNext } from '../src/game/train';
import { roadOpts } from './lib';
import { depotAtEnd } from '../src/game/routing';
import { depotSize } from '../src/game/build-ops';
import { rectsOverlap } from '../src/game/towns';
import { flatGame, station, endNode, newTrack, loco, depotFor, runTrains, check, fmt, build, free, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
const PI2 = Math.PI / 2;
const road = (g: Game, x0: number, z0: number, x1: number, z1: number) => build(g, free(g, x0, z0), free(g, x1, z1), roadOpts(0, 'road'), 'road');
/** An out-and-back line over the stations. */
const lineOf = (g: Game, stops: Station[], owner = 0) => {
  const l = g.lines.create('rail', owner);
  const ids = stops.map((s) => s.id);
  l.stops = [...ids, ...ids.slice(1, -1).reverse()];
  g.lines.rebuild();
  return l;
};
const lonLat = (st: Station, x: number, z: number) => { const r = st.rail!; const fx = Math.sin(r.angle), fz = Math.cos(r.angle); return { lon: (x - r.x) * fx + (z - r.z) * fz, lat: (x - r.x) * fz - (z - r.z) * fx }; };
/** Is every station track connected (track beyond) at the given end? */
const connectedAt = (g: Game, st: Station, front: boolean) => g.stations.trackEnds(st, true).every((t) => (g.world.net.nodes.get(front ? t.front : t.back)?.edges.length ?? 0) >= 2);

// A depot's door 50 m behind an end of the platforms must fit, including on rotated and wide stations.
{
  console.log('short depot stubs behind station ends');
  for (const [angle, tracks, style] of [[0, 2, 'classic'], [PI2, 8, 'classic'], [0.6, 2, 'none']] as const) for (const front of [false, true]) {
    const g = flatGame(192), net = g.world.net;
    const S = station(g, 96, 96, angle, 12, tracks, 0, { style })!;
    check(!!S, 'depot-stub station built');
    if (!S) continue;
    const n = net.nodes.get(endNode(g, S, 0, front))!, sign = front ? 1 : -1;
    const dx = Math.sin(angle) * sign, dz = Math.cos(angle) * sign;
    const sx = n.x + dx * 5, sz = n.z + dz * 5;
    const dp = g.depots.plan('rail', sx + dx * 2.15, sz + dz * 2.15, angle + (front ? Math.PI : 0), 0);
    const szD = depotSize('rail');
    const rect = { x: dp.x, z: dp.z, angle: dp.angle, w: szD.w, d: szD.d };
    const fps = g.stations.footprints(S);
    check(dp.ok && !fps.some((f) => rectsOverlap(rect, f, 0.02)), `L=5 depot fits behind ${style}, ${tracks} tracks, ${front ? 'front' : 'back'} (${dp.error ?? 'ok'})`);
    check(fps.filter((f) => f.part === 'platforms').every((f) => f.d <= S.rail!.length), 'platform footprint stops at the end nodes');
    const stub = build(g, nodeSnap(g, n.id, 'rail'), free(g, sx, sz), railOpts(0, 1, { straight: true }), '50 m depot stub');
    const end = net.nearestNode(sx, sz, 0.1, 'rail');
    const id = stub && end ? depotAtEnd(g, end.id, 0) : -1;
    check(id >= 0, 'short stub and depot commit successfully');
    if (id >= 0) {
      const depot = g.depots.get(id)!;
      const doorGap = (depot.x - n.x) * dx + (depot.z - n.z) * dz - szD.d / 2;
      check(doorGap >= 5, 'depot building stays clear of the station buffer stops');
    }
  }
}

// ------------------------------------------------------------------ 1. building styles
{
  console.log('building styles');
  const g = flatGame(256);
  road(g, 10, 117, 246, 117);
  const ids = ['none', 'shelter', 'classic', 'brick', 'modern', 'concourse', 'terminal'];
  const plans = ids.map((id, i) => g.stations.planRail(28 + i * 32, 123, PI2, 10, id === 'terminal' ? 4 : 2, 0, { style: id }));
  for (const [i, p] of plans.entries()) console.log(`  ${ids[i].padEnd(9)} ${p.ok ? 'ok' : p.error} access ${p.roadAccess}${p.access ? ' (street)' : ''}, building ${fmt(p.building.w, 1)} x ${fmt(p.building.d, 1)}, cost ${fmt(p.cost / 1e3, 0)}k`);
  check(plans.every((p, i) => p.ok && p.style === ids[i] && p.roadAccess), 'every style planned with road access');
  const [none, , classic, , , conc, term] = plans;
  const at = (p: typeof none) => ({ lon: (p.building.x - p.x) * Math.sin(p.angle) + (p.building.z - p.z) * Math.cos(p.angle), lat: (p.building.x - p.x) * Math.cos(p.angle) - (p.building.z - p.z) * Math.sin(p.angle) });
  check(none.building.w <= 1 && Math.abs(at(none).lon) > none.length / 2 - 1, 'no building: a ramp pad at a platform end');
  check(Math.abs(at(conc).lat) < 0.05 && conc.building.d > conc.layout.width + 2 && !!conc.forecourt2, 'concourse: across the tracks, a forecourt on each side');
  check(Math.abs(at(term).lon) > term.length / 2 && Math.abs(at(term).lat) < 0.05, 'terminal: across the buffer end');
  check(none.cost < classic.cost && classic.cost < conc.cost, `costs by style (none ${fmt(none.cost / 1e3, 0)}k < classic ${fmt(classic.cost / 1e3, 0)}k < concourse ${fmt(conc.cost / 1e3, 0)}k)`);
  const t2 = g.stations.planRail(28, 160, PI2, 10, 2, 0, { style: 'terminal' });
  check(!t2.ok && /platform tracks/.test(t2.error ?? ''), `terminal with 2 tracks refused (${t2.error})`);
  check(stylesFor('ground', 1, 1900).some((s) => s.id === 'brick') && !stylesFor('ground', 1, 1900).some((s) => s.id === 'concourse' || s.id === 'terminal'), 'styles by era and size');
  check(defaultStationStyle(2020, 2, 'ground', 'mainline', 9000) === 'concourse' && defaultStationStyle(1890, 2, 'ground', 'mainline', 3000) === 'brick' && defaultStationStyle(2000, 2, 'ground', 'lightrail', 20000) === 'shelter' && defaultStationStyle(2000, 2, 'underground', 'metro', 9000) === 'none', 'default styles');
  const built: Station[] = [];
  for (const p of plans) { const id = g.stations.nextId; check(!g.stations.commitRail(p, 0), `${p.style} built`); built.push(g.stations.get(id)!); }
  check(built.every((s, i) => s.rail!.style === ids[i] && s.roadAccess), 'built with their styles and road access');
  // the concourse station: either side gives access
  const cs = built[5];
  check(!!cs.rail!.forecourt2 && g.stations.footprints(cs).filter((f) => f.part === 'building').length === 2 && g.stations.footprints(cs).some((f) => f.part === 'deck'), 'concourse structures: two pavilions and the deck over the tracks');
  // restyle
  const cl = built[2];
  const up = planStationUpgrade(g, cl.id, { style: 'modern' });
  check(up.ok && up.cost > 0, `restyle classic -> modern planned (${up.error ?? fmt(up.cost / 1e3, 0) + 'k'})`);
  check(!commitStationUpgrade(g, up) && cl.rail!.style === 'modern' && cl.roadAccess, 'restyled');
  // save
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const sig = (x: Game) => JSON.stringify(x.stations.all().map((s) => [s.id, s.rail?.style, s.rail?.forecourt2, s.rail?.building, s.roadAccess]));
  check(sig(g2) === sig(g), 'save round trip: styles, buildings, forecourts');
  // stations below or above the street: no building by default (entrances only); a building widens the catchment
  const ug = g.stations.planRail(60, 110, PI2, 12, 2, 0, { level: 'underground' });
  const ugB = g.stations.planRail(60, 110, PI2, 12, 2, 0, { level: 'underground', style: 'modern' });
  const r0 = g.stations.planCatchShapes(ug)[0]?.r ?? 0, r1 = g.stations.planCatchShapes(ugB)[0]?.r ?? 0;
  console.log(`  underground: ${ug.style} (${ug.ok ? 'ok' : ug.error}) radius ${fmt(r0, 1)}, with a modern building ${ugB.style} (${ugB.ok ? 'ok' : ugB.error}) radius ${fmt(r1, 1)}, cost +${fmt((ugB.cost - ug.cost) / 1e3, 0)}k`);
  check(ug.ok && ug.style === 'none' && ugB.ok && ugB.style === 'modern' && Math.abs(r1 - r0 * 1.25) < 1e-6 && ugB.cost > ug.cost, 'underground: no building by default; a street-level building widens the catchment (+25%)');
  const uid = g.stations.nextId;
  check(!g.stations.commitRail(ug, 0), 'underground station built (entrances only)');
  const U = g.stations.get(uid)!;
  const rs = planStationUpgrade(g, U.id, { style: 'classic' });
  check(rs.ok && !!rs.restyleOnly && !commitStationUpgrade(g, rs) && U.rail!.style === 'classic' && U.rail!.level === 'underground' && Math.abs((g.stations.catchmentShapes(U)[0]?.r ?? 0) - 33.6) < 1e-6, `a street-level building added later (${rs.error ?? 'ok'}): catchment 336 m`);
  const g3 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  check(JSON.stringify(g3.stations.catchmentShapes(g3.stations.get(U.id)!)) === JSON.stringify(g.stations.catchmentShapes(U)), 'save round trip keeps the building and its catchment');
  const odd = restoreStation(JSON.parse(JSON.stringify({ ...built[2], waiting: [], rail: { ...built[2].rail, style: 'gothic-revival' } })));
  const old = restoreStation(JSON.parse(JSON.stringify({ ...built[2], waiting: [], rail: { ...built[2].rail, style: undefined } })));
  check(odd.rail!.style === 'classic' && old.rail!.style === 'classic' && styleOf('gothic-revival').id === 'classic' && !!STATION_STYLES.none, 'unknown and missing styles load as classic');
}

// ------------------------------------------------------------------ 2. a running terminus grows from 2 to 4 platforms
{
  console.log('expanding a terminus');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 10, 117, 246, 117);
  const A = station(g, 40, 123, PI2, 10, 2)!, B = station(g, 200, 123, PI2, 10, 2)!;
  const e0 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(0, 2), 'double line');
  const f = finishDoubleTrack(g, newTrack(g, e0), 0);
  check(!f.error && f.crossovers === 4, `double track with crossovers (${f.error ?? 'ok'})`);
  const dep = depotFor(g, A, B);
  const l = lineOf(g, [A, B]);
  const trains = [0, 1, 2, 3].map(() => g.vehicles.buyTrain(dep, loco(), l.id) as Train);
  autoSignalNetwork(g, 0);
  const r1 = runTrains(g, trains, 90);
  const before = trains.map((t) => r1.arrivals.get(t.id)?.length ?? 0);
  const cap0 = stationCapacity(g, B.id)!;
  console.log(`  before: arrivals ${before.join('/')}, B: occupancy ${fmt(cap0.occupancy * 100, 0)}%, ${fmt(cap0.trainsPerDay, 2)} trains a day, ${cap0.lines} line, terminus ${cap0.terminus}, recommended ${JSON.stringify(cap0.recommended)} (${cap0.reason})`);
  check(cap0.platforms === 2 && cap0.trainsPerDay > 0 && cap0.occupancy > 0 && cap0.terminus && cap0.lines === 1, 'capacity figures of the busy terminus');
  const up = planStationUpgrade(g, B.id, { tracks: 4, side: 'auto' });
  console.log(`  upgrade: ${up.ok ? 'ok' : up.error}, cost ${fmt(up.cost / 1e3, 0)}k, demolish ${up.plan?.demolish.length ?? 0}, keep ${up.keep.join(',')}`);
  check(up.ok && up.tracks === 4, 'two more platforms planned beside the old ones');
  let err: string | null = 'busy';
  let waited = 0;
  for (; waited < 240 && err === 'busy'; waited++) { err = commitStationUpgrade(g, up); if (err === 'busy') for (let k = 0; k < 2; k++) g.update(0.25); }
  console.log(`  committed after ${fmt(waited / 4, 1)} days of waiting for a free throat`);
  check(!err && B.rail!.tracks === 4, `rebuilt while the line runs (${err ?? 'ok'})`);
  check(connectedAt(g, B, false), 'all four platform tracks reach the line at the throat (turnout ladder)');
  const starters = g.stations.trackEnds(B).filter((t) => net.nodes.get(t.back)?.signal).length;
  check(starters === 4, `the throat signalled again: a starter on each platform track (${starters})`);
  const used = new Set<number>();
  const pe = new Set(B.rail!.edges);
  let tick = 0;
  for (let d = 0; d < 240; d++) for (let k = 0; k < 8; k++) {
    g.update(0.25); tick++;
    if (tick % 4) continue;
    for (const t of trains) if (t.state === 'loading' && t.atStation === B.id) for (const s of t.segs) if (pe.has(s.e)) used.add(s.e);
  }
  const after = trains.map((t) => t.id);
  const r2 = runTrains(g, trains, 1);
  void r2; void after;
  const cap = stationCapacity(g, B.id)!;
  console.log(`  after: platform tracks used ${used.size}, B: occupancy ${fmt(cap.occupancy * 100, 0)}%, ${fmt(cap.trainsPerDay, 2)} trains a day`);
  check(used.size >= 3, 'trains use the new platforms');
  const r3 = runTrains(g, trains, 120);
  const later = trains.map((t) => r3.arrivals.get(t.id)?.length ?? 0);
  console.log(`  120 more days: arrivals ${later.join('/')}, worst wait ${r3.worst.days} days (${r3.worst.kind})`);
  check(later.every((c) => c >= 1) && later.reduce((a, b) => a + b, 0) >= 7 && r3.worst.days < 35, 'all trains keep running');
}

// ------------------------------------------------------------------ 3. a connection between two lines
{
  console.log('connecting two lines');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 10, 93, 246, 93);
  road(g, 140, 100, 140, 246);
  // line 1 west - east; line 2 from the south ends in a stub short of line 1
  const P = station(g, 40, 100, PI2, 10, 1)!, Q = station(g, 210, 100, PI2, 10, 1)!;
  const R = station(g, 150, 210, 0, 10, 1)!;
  build(g, nodeSnap(g, endNode(g, P, 0, true), 'rail'), nodeSnap(g, endNode(g, Q, 0, false), 'rail'), railOpts(0), 'line 1');
  const e2 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, R, 0, false), 'rail'), free(g, 150, 135), railOpts(0), 'line 2 stub');
  const stub = newTrack(g, e2)[0];
  const l1 = [...net.edges.values()].find((e) => e.kind === 'rail' && e.station < 0 && e.id < e2)!;
  const pa = { x: 0, y: 0, z: 0 };
  // a point on line 1 west of the stub: trains from P run on to R
  let sA = 0;
  for (let s = 0; s <= l1.len; s += 1) { net.pointAt(l1, s, pa); if (pa.x >= 112) { sA = s; break; } }
  const st = net.edges.get(stub)!;
  const sB = net.nodes.get(st.a)!.z < net.nodes.get(st.b)!.z ? 2 : st.len - 2;
  const plan = planConnection(g, l1.id, sA, stub, sB, 0, { search: 8 });
  console.log(`  plan: ${plan.ok ? 'ok' : plan.error}, length ${fmt(plan.length, 1)}, min radius ${fmt(plan.minRadius * 10, 0)} m, cost ${fmt(plan.cost / 1e3, 0)}k, turnouts at ${plan.turnouts.map((t) => `${fmt(t.x, 1)},${fmt(t.z, 1)}`).join(' / ')}`);
  check(plan.ok && plan.turnouts.length === 2 && plan.minRadius >= 12, 'a connecting curve within the curve limit');
  const res = commitConnection(g, plan);
  check(!res.error && res.edges.length >= 1, `built (${res.error ?? res.edges.length + ' edges'})`);
  const switches = [...net.nodes.values()].filter((n) => n.kind === 'rail' && n.edges.length === 3);
  check(switches.length === 2, `turnouts split into both tracks (${switches.length} switches)`);
  const pe = net.edges.get(P.rail!.edges[0])!;
  const route = [1, -1].map((d) => findRailRoute(g, railNext(g, pe, d, 0), R.id, 0, -1, 40000)).find((x) => !!x);
  check(!!route, 'a train from P finds a route onto line 2 to R');
  const dep = depotFor(g, P, Q);
  const l = lineOf(g, [P, R]);
  const t = g.vehicles.buyTrain(dep, loco(), l.id) as Train;
  const r = runTrains(g, [t], 200);
  const arr = r.arrivals.get(t.id) ?? [];
  console.log(`  a through service P - R: ${arr.length} stops (${arr.filter((x) => x === R.id).length} at R)`);
  check(arr.filter((x) => x === R.id).length >= 1 && arr.filter((x) => x === P.id).length >= 1, 'a train runs from line 1 onto line 2 and back');
}

// ------------------------------------------------------------------ 4. two single tracks side by side paired
{
  console.log('pairing two single tracks');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 10, 113, 246, 113);
  road(g, 10, 147, 246, 147);
  const A1 = station(g, 30, 120, PI2, 10, 1)!, B1 = station(g, 222, 120, PI2, 10, 1)!;
  const A2 = station(g, 30, 140, PI2, 10, 1)!, B2 = station(g, 222, 140, PI2, 10, 1)!;
  const e1 = net.nextEdge;
  build(g, nodeSnap(g, endNode(g, A1, 0, true), 'rail'), nodeSnap(g, endNode(g, B1, 0, false), 'rail'), railOpts(0), 'line 1');
  const t1 = newTrack(g, e1);
  const e2 = net.nextEdge;
  // line 2 swings over beside line 1 (1 unit apart) for the middle of the way
  build(g, free(g, 85, 121), free(g, 165, 121), railOpts(0), 'line 2 middle');
  const n2 = [...net.nodes.values()].find((n) => Math.hypot(n.x - 85, n.z - 121) < 0.1)!;
  const n3 = [...net.nodes.values()].find((n) => Math.hypot(n.x - 165, n.z - 121) < 0.1)!;
  build(g, nodeSnap(g, endNode(g, A2, 0, true), 'rail'), nodeSnap(g, n2.id, 'rail'), railOpts(0), 'line 2 west');
  build(g, nodeSnap(g, n3.id, 'rail'), nodeSnap(g, endNode(g, B2, 0, false), 'rail'), railOpts(0), 'line 2 east');
  const t2 = newTrack(g, e2);
  const pr = pairAsDoubleTrack(g, t1, t2, 0);
  console.log(`  paired: ${pr.crossovers} crossovers, ${pr.signals} signals, cost ${fmt(pr.cost / 1e3, 0)}k ${pr.error ?? ''}`);
  check(!pr.error && pr.crossovers === 4 && pr.signals >= 2, 'one directional double track with crossovers at both ends');
  const l1 = lineOf(g, [A1, B1]), l2 = lineOf(g, [A2, B2]);
  const d1 = depotFor(g, A1, B1), d2 = depotFor(g, A2, B2);
  const trains = [...[0, 1].map(() => g.vehicles.buyTrain(d1, loco(), l1.id) as Train), ...[0, 1].map(() => g.vehicles.buyTrain(d2, loco(), l2.id) as Train)];
  autoSignalNetwork(g, 0);
  const r = runTrains(g, trains, 360);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  console.log(`  1 year, 2 + 2 trains: arrivals ${counts.join('/')}, worst wait ${r.worst.days} days (${r.worst.kind})`);
  // (one-platform termini at both ends of each line: a train sometimes waits there for its sister train)
  check(counts.every((c) => c >= 4) && r.worst.days < 45, 'both lines keep running over the paired track');
  check(pr.signals >= 8, 'entry signals where the tracks part, so trains wait outside the crossovers');
}

// ------------------------------------------------------------------ 5. merging stations
{
  console.log('merging stations');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 10, 150, 246, 150);
  road(g, 10, 174, 246, 174);
  // two termini side by side (1 unit between their track areas), buildings on their outer sides
  const M1 = station(g, 100, 160, PI2, 10, 2, 0, { buildingSide: 1 })!;
  const M2 = station(g, 100, 162.6, PI2, 10, 2, 0, { buildingSide: -1 })!;
  check(!!M1 && !!M2, 'two stations side by side');
  // a line at each; M2's line runs to a far station
  const F = station(g, 220, 162.6, PI2, 10, 2)!;
  build(g, nodeSnap(g, endNode(g, M2, 0, true), 'rail'), nodeSnap(g, endNode(g, F, 0, false), 'rail'), railOpts(0), 'line to F');
  const lF = lineOf(g, [M2, F]);
  const cm = canMerge(g, M1.id, M2.id);
  check(cm.ok && cm.kind === 'rebuild', `side by side: one station (${cm.reason})`);
  const mr = mergeStations(g, M1.id, M2.id);
  check(!mr.error && mr.kind === 'rebuild' && !g.stations.get(M2.id) && M1.rail!.tracks === 4, `merged into one rail part (${mr.error ?? M1.rail!.tracks + ' tracks'})`);
  check(M1.rail!.edges.every((id) => net.edges.get(id)!.station === M1.id) && g.stations.trackEnds(M1).length === 4, 'all four platform tracks belong to it');
  check(lF.stops.includes(M1.id) && !lF.stops.includes(M2.id), 'the line moved to the merged station');
  check(M1.rail!.platforms.length === 2 && M1.rail!.trackOffsets.length === 4, `platforms united (${M1.rail!.platforms.map((p) => fmt(p.off, 2)).join(', ')})`);
  const dep = depotFor(g, F, M1);
  const t = g.vehicles.buyTrain(dep, loco(), lF.id) as Train;
  const r = runTrains(g, [t], 120);
  check((r.arrivals.get(t.id) ?? []).includes(M1.id), 'a train serves the merged station');
  // a station at an angle nearby: a transfer complex instead, shown as one
  const N = station(g, 116, 169, PI2 + 0.6, 8, 1)!;
  const cn = canMerge(g, M1.id, N.id);
  console.log(`  at an angle: ${cn.kind} (${cn.reason})`);
  check(cn.ok && cn.kind === 'complex', 'not parallel: a transfer complex');
  const mn = mergeStations(g, M1.id, N.id);
  const cx = stationComplex(g, N.id);
  check(!mn.error && M1.links.includes(N.id) && cx.main === M1.id && cx.parts.length === 2, `linked; the complex shows as ${g.stations.get(cx.main)!.name}`);
  // slightly turned, unconnected: laid anew along the axis
  const K1 = station(g, 60, 210, PI2, 10, 2, 0, { buildingSide: 1 })!;
  const K2 = station(g, 60, 212.7, PI2 + 0.07, 10, 1, 0, { buildingSide: -1 })!;
  const ck = canMerge(g, K1.id, K2.id);
  const mk = ck.kind === 'rebuild' ? mergeStations(g, K1.id, K2.id) : { error: ck.reason };
  const straight = K1.rail!.edges.every((id) => { const e = net.edges.get(id)!; const a = net.nodes.get(e.a)!, b = net.nodes.get(e.b)!; return Math.abs(Math.abs((b.x - a.x) / e.len) - 1) < 1e-3; });
  check(!mk.error && K1.rail!.tracks === 3 && straight, `4 degrees apart, free ends: merged with the tracks laid along the axis (${mk.error ?? 'ok'})`);
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const sig = (x: Game) => JSON.stringify(x.stations.all().map((s) => [s.id, s.links, s.rail && [s.rail.tracks, s.rail.trackOffsets, s.rail.platforms, s.rail.edges, s.rail.length]]));
  check(sig(g2) === sig(g), 'save round trip of the merged stations and the complex');
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();
