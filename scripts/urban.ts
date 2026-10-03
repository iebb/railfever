import { lineTable as startupTable, patternOf as startupPattern } from '../src/game/patterns';
import type { Vehicle as StartupVehicle } from '../src/game/vehicle';
// Urban rail: station modes from the platform track type (main line / metro / light rail) with their catchment
// walking limits and layouts; strict catchment (only street-connected buildings, shared out among stations,
// worked out alike after loading); a dense underground metro line (6 stations, ~10 units apart, platform screen
// doors, side platforms) made directional in one go and run with trains; auto-links by mode; a junction station
// where a metro line meets another company's electric suburban line, with through-running trains both ways.
// npx esbuild scripts/urban.ts --bundle --platform=node --format=esm --outfile=$S/urban.mjs && node $S/urban.mjs
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { stationLayout, defaultPlatformLength, CATCHMENT_RADIUS } from '../src/game/stations';
import type { Station } from '../src/game/stations';
import { styleOf } from '../src/game/station-styles';
import { finishDoubleTrack } from '../src/game/trackops';
import { autoSignalLine, autoSignalNetwork } from '../src/game/signals';
import { Train } from '../src/game/train';
import { depotAtEnd } from '../src/game/routing';
import type { BuildOptions } from '../src/game/construction';
import { roadOpts } from './lib';
import { flatGame, station, endNode, newTrack, runTrains, check, fmt, build, free, railOpts, nodeSnap, done } from './stationlib';

const T0 = performance.now();
const PI2 = Math.PI / 2;
const road = (g: Game, x0: number, z0: number, x1: number, z1: number) => build(g, free(g, x0, z0), free(g, x1, z1), roadOpts(0, 'road'), 'road');
const house = (g: Game, x: number, z: number, pop = 10) => g.world.addBuilding({ townId: -1, x, z, angle: 0, w: 0.8, d: 0.8, type: 0, floors: 2, pop, seed: 1, y: g.world.heightAt(x, z), built: 0 });
/** An out-and-back line over the stations (A, B, C, D, C, B). */
const lineOf = (g: Game, stops: Station[], owner = 0) => {
  const l = g.lines.create('rail', owner);
  const ids = stops.map((s) => s.id);
  l.stops = [...ids, ...ids.slice(1, -1).reverse()];
  g.lines.rebuild();
  return l;
};
const model = (id: string) => MODEL_BY_ID.get(id)!;
/** Track between two stations' track-0 ends (2 tracks), at a level when the planner offers it. */
function link(g: Game, a: Station, b: Station, owner: number, extra: Partial<BuildOptions>, label: string) {
  return build(g, nodeSnap(g, endNode(g, a, 0, true), 'rail'), nodeSnap(g, endNode(g, b, 0, false), 'rail'), railOpts(owner, 2, extra), label);
}
const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// ------------------------------------------------------------------ 1. station modes, layouts, catchment radii
{
  console.log('station modes');
  const g = flatGame(256);
  road(g, 20, 118, 236, 118);
  const side = stationLayout(2, 0, 'middle', 'side'), isl = stationLayout(2);
  check(near(side.trackOffsets[0], -0.225) && near(side.trackOffsets[1], 0.225) && side.platforms.length === 2 && side.platforms.every((p) => Math.abs(p.off) > 0.6), `side platforms: tracks at the plain double-track spacing (${side.trackOffsets.map((o) => fmt(o, 3)).join(', ')}), platforms outside`);
  check(isl.platforms.length === 1 && near(isl.platforms[0].off, 0), 'island platform between two tracks (main-line default)');
  const pm = g.stations.planRail(60, 124, PI2, defaultPlatformLength('metro'), 2, 0, { trackType: 'metro' });
  console.log(`  metro plan: ${pm.ok ? 'ok' : pm.error}, ${pm.level}, depth ${fmt(pm.depth, 2)}, psd ${pm.psd}, ${pm.platformStyle}, ${pm.length * 10} m, ${pm.entrances.length} entrances, cost ${fmt(pm.cost / 1e6, 2)}M`);
  check(pm.ok && pm.mode === 'metro' && pm.level === 'underground' && pm.psd && pm.platformStyle === 'side' && pm.length === 12 && near(pm.depth, 2.2), 'metro: underground (22 m deep), platform screen doors, side platforms, 120 m platforms');
  const sm = g.stations.planCatchShapes(pm);
  check(sm.length >= 2 && sm.every((c) => c.mode === 'metro' && c.r === CATCHMENT_RADIUS.metro && c.r === 12.6), `metro catchment: 126 m walking limits at the ${sm.length} entrances`);
  const pl = g.stations.planRail(120, 124, PI2, defaultPlatformLength('lightrail'), 2, 0, { trackType: 'lightrail' });
  check(pl.ok && pl.mode === 'lightrail' && pl.level === 'ground' && !pl.psd && pl.platformStyle === 'side' && g.stations.planCatchShapes(pl).every((c) => c.r === 10.5 && c.mode === 'lightrail'), `light rail: on the ground, side platforms, 105 m walking limit (${pl.error ?? 'ok'})`);
  const pe = g.stations.planRail(180, 124, PI2, 8, 2, 0, { trackType: 'electric' });
  check(pe.ok && pe.mode === 'mainline' && pe.platformStyle === 'island' && !pe.psd && pe.style === 'classic' && g.stations.planCatchShapes(pe).every((c) => Math.abs(c.r - 20.16) < 1e-9 && c.mode === 'rail'), `electric main line: island platform, 168 m walking limit + 20% for its building (${pe.error ?? 'ok'})`);
  const built: [Station, string][] = [];
  for (const [p, tt] of [[pm, 'metro'], [pl, 'lightrail'], [pe, 'electric']] as const) {
    const id = g.stations.nextId;
    check(!g.stations.commitRail(p, 0), `${tt} station built`);
    built.push([g.stations.get(id)!, tt]);
  }
  const net = g.world.net;
  check(built.every(([st, tt]) => st.rail!.trackType === tt && st.rail!.edges.every((id) => net.edges.get(id)!.type === tt)), 'platform tracks of the station\'s track type');
  check(built.map(([st]) => g.stations.mode(st)).join() === 'metro,lightrail,mainline', `station modes ${built.map(([st]) => g.stations.mode(st)).join(', ')}`);
  check(built.every(([st]) => g.stations.catchmentShapes(st).every((c) => Math.abs(c.r - CATCHMENT_RADIUS[g.stations.mode(st) === 'mainline' ? 'rail' : (g.stations.mode(st) as 'metro' | 'lightrail')] * (1 + styleOf(st.rail!.style).catchBonus)) < 1e-9)), 'built stations: catchment radius by mode (and building)');
  check(built[0][0].rail!.style === 'none' && built[1][0].rail!.style === 'shelter', 'no building for the metro station (street entrances), a halt for light rail');
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const sig = (x: Game) => JSON.stringify(x.stations.all().map((s) => [s.id, s.rail?.trackType, s.rail?.psd, s.rail?.platformStyle, s.rail?.trackOffsets, x.stations.mode(s)]));
  check(sig(g2) === sig(g), 'save round trip: track type, screen doors, platform style and mode restored');
}

// ------------------------------------------------------------------ 2. strict catchment, shares, save
{
  console.log('strict catchment');
  const g = flatGame(256);
  road(g, 20, 118, 236, 118);
  const A = station(g, 80, 124, PI2, 8, 1)!, B = station(g, 116, 124, PI2, 8, 1)!, C = station(g, 44, 124, PI2, 8, 1)!;
  const hA = house(g, 62, 116), hAB = house(g, 97, 116), hOut = house(g, 80, 164), hC = house(g, 32, 116);
  // A and B served (a line with a train), C not
  const lab = lineOf(g, [A, B]);
  const dAB = depotAtEnd(g, endNode(g, A, 0, false), 0);
  check(dAB >= 0 && g.vehicles.buyTrain(dAB, [model('diesel_b'), model('coach_ic')], lab.id) instanceof Train, 'a train for the line A - B');
  g.lines.rebuild();
  check(g.lines.stationServed(A.id) && g.lines.stationServed(B.id) && !g.lines.stationServed(C.id), 'A and B served, C not');
  g.lines.catchmentDirty = true;
  g.lines.flushCatchment();
  const S = g.stations;
  const sf = (id: number) => S.stationsForBuilding(id);
  console.log(`  shares: hA ${JSON.stringify(sf(hA.id))}, hAB ${JSON.stringify(sf(hAB.id))}, hOut ${JSON.stringify(sf(hOut.id))}, hC ${JSON.stringify(sf(hC.id))}`);
  check(sf(hOut.id).st.length === 0 && !S.buildingShares(A).ids.includes(hOut.id), 'a house without street frontage belongs to no station');
  check(sf(hA.id).st.join() === String(A.id) && near(sf(hA.id).w[0], 1), 'inside A only (and an unserved station C): all of it to the served station A');
  const ab = sf(hAB.id), wA = ab.w[ab.st.indexOf(A.id)], wB = ab.w[ab.st.indexOf(B.id)];
  check(ab.st.length === 2 && near(wA + wB, 1) && wA > wB, `inside A and B: shared, the nearer A more (${fmt(wA, 2)} / ${fmt(wB, 2)})`);
  check(sf(hC.id).st.join() === String(C.id), 'covered by the unserved station C alone: C has it');
  check(near(A.catchPop, 10 + 10 * wA) && near(S.catchSum(A, (b) => b.pop), A.catchPop), `catchment population = shares x people (${fmt(A.catchPop, 2)})`);
  const v0 = S.catchVersion;
  // a house built after the last share-out: in no share until the next one, also after loading
  const hNew = house(g, 90, 116);
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const dump = (x: Game) => JSON.stringify([...x.stations.map.keys()].map((id) => x.stations.buildingShares(id)));
  check(dump(g2) === dump(g) && g2.stations.stationsForBuilding(hNew.id).st.length === 0 && g.stations.stationsForBuilding(hNew.id).st.length === 0, 'after loading: the same shares (the new house waits for the next share-out in both)');
  g.lines.catchmentDirty = true;
  g.lines.flushCatchment();
  check(S.catchVersion > v0 && sf(hNew.id).st.join() === String(A.id), 'next share-out: the new house joins A');
}

// ------------------------------------------------------------------ 3. dense underground metro line
{
  console.log('dense metro line');
  const g = flatGame(256);
  const net = g.world.net;
  road(g, 20, 118, 236, 118);
  // 6 stations of 120 m: 180 m to the outer ones (crossovers before the termini), 100 m between the inner ones
  const xs = [40, 70, 92, 114, 136, 166];
  const M: Station[] = [];
  for (const x of xs) {
    const st = station(g, x, 124, PI2, defaultPlatformLength('metro'), 2, 0, { trackType: 'metro' });
    if (st) M.push(st);
  }
  check(M.length === 6 && M.every((s) => s.rail!.level === 'underground' && s.rail!.psd && s.rail!.platformStyle === 'side'), `6 underground metro stations 100 m apart (${M.length})`);
  check(new Set(M.map((s) => s.name)).size === 6, `distinct names (${M.map((s) => s.name).join(', ')})`);
  check(M.every((s) => !s.links.length), 'neighbouring metro stations are not linked as interchanges');
  check(g.stations.complex(M[2].id).length === 1, 'each is its own station (no transfer complex)');
  // a main-line station beside M[2]: a hub (linked), as is a bus stop at the street
  const ml = station(g, 92, 113, PI2, 8, 2, 0, { trackType: 'electric' });
  check(!!ml && ml.links.includes(M[2].id) && !ml.links.includes(M[1].id) && !ml.links.includes(M[3].id), `main-line station beside the metro: linked to it only (${ml?.links.join(',')})`);
  const e0 = net.nextEdge;
  let ok = true;
  for (let i = 0; i + 1 < M.length; i++) {
    const p = link(g, M[i], M[i + 1], 0, { type: 'metro', level: 'underground' }, `tunnel ${i}`) ?? link(g, M[i], M[i + 1], 0, { type: 'metro' }, `tunnel ${i} (plain)`);
    if (!p) ok = false;
  }
  const tun = newTrack(g, e0);
  check(ok && tun.every((id) => net.edges.get(id)!.type === 'metro'), `metro tunnels between the stations (${tun.length} edges)`);
  check(tun.every((id) => { const e = net.edges.get(id)!; return e.sections.some((s) => s.type === 'tunnel' && s.s0 <= 0.5 && s.s1 >= e.len - 0.5); }), 'all in tunnel');
  const f = finishDoubleTrack(g, tun, 0);
  console.log(`  directional: ${f.crossovers} crossovers, ${f.signals} signals, cost ${fmt(f.cost / 1e3, 0)}k ${f.error ?? ''}`);
  check(!f.error && f.crossovers === 4 && f.signals >= 2, 'one call: right-hand running through the inline stations, crossovers before both termini');
  check(M.every((s) => s.rail!.edges.every((id) => { const e = net.edges.get(id)!; return net.nodes.get(e.a)!.edges.length <= 2 && net.nodes.get(e.b)!.edges.length <= 2; })), 'no switches at the platforms');
  const swx = [...net.nodes.values()].filter((n) => n.kind === 'rail' && n.edges.length > 2).map((n) => n.x);
  check(swx.every((x) => x < 64 || x > 142), `crossovers only between the termini and their neighbours (${swx.map((x) => fmt(x, 1)).join(', ')})`);
  const dep = depotAtEnd(g, endNode(g, M[0], 0, false), 0);
  check(dep >= 0, 'depot at the end of the line');
  const l = lineOf(g, M);
  const as = autoSignalLine(g, l.id, 0);
  console.log(`  signals: ${as.placed} placed (${as.signals.filter((q) => q.role === 'starter').length} starters) ${as.warnings.join('; ')}`);
  check(g.stations.consecutiveStops(M[0].id, M[1].id) && !g.stations.consecutiveStops(M[0].id, M[2].id), 'consecutive stops of the line known');
  const trains: Train[] = [];
  for (let i = 0; i < 4; i++) { const t = g.vehicles.buyTrain(dep, [model('metro_b')], l.id); if (t instanceof Train) trains.push(t); }
  check(trains.length === 4, `4 metro trains (${trains.length})`);
  startFleet(g, trains, 20);
  const r = runTrains(g, trains, 360);
  const counts = trains.map((t) => r.arrivals.get(t.id)?.length ?? 0);
  const seen = new Set(trains.flatMap((t) => r.arrivals.get(t.id) ?? []));
  console.log(`  1 year, 4 trains: stops ${counts.join('/')}, stations served ${seen.size}/6, worst wait ${r.worst.days} days (${r.worst.kind})`);
  check(counts.every((c) => c >= 15) && M.every((s) => seen.has(s.id)) && r.worst.days < 20, 'all trains keep running and serve every station');
}

// ------------------------------------------------------------------ 4. junction station of two operators, through running
{
  console.log('junction station, through running');
  const g = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 2005, aiCompanies: 1, aiConfigs: [{ risk: 0.5 }] });
  g.aiEnabled = false;
  const w = g.world, net = w.net;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
  w.heightsVersion++;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  g.company(0).economy.money = 1e9;
  g.company(1).economy.money = 1e9;
  g.setAccessPolicy(0, 'open');
  g.setAccessPolicy(1, 'open');
  road(g, 10, 118, 246, 118);
  // company 0, the city's metro: M1, M2 and the junction station J (at street level here)
  const ML = defaultPlatformLength('metro');
  const M1 = station(g, 40, 124, PI2, ML, 2, 0, { trackType: 'metro', level: 'ground' })!;
  const M2 = station(g, 76, 124, PI2, ML, 2, 0, { trackType: 'metro', level: 'ground' })!;
  const J = station(g, 112, 124, PI2, ML, 2, 0, { trackType: 'metro', level: 'ground' })!;
  // company 1, the suburban railway (electrified main line): S1, S2
  const S1 = station(g, 160, 124, PI2, 10, 2, 1, { trackType: 'electric' })!;
  const S2 = station(g, 206, 124, PI2, 10, 2, 1, { trackType: 'electric' })!;
  check(!!(M1 && M2 && J && S1 && S2), 'stations of both companies');
  const e0 = net.nextEdge;
  const a1 = link(g, M1, M2, 0, { type: 'metro' }, 'M1-M2'), a2 = link(g, M2, J, 0, { type: 'metro' }, 'M2-J');
  const mine0 = newTrack(g, e0, 0);
  const e1 = net.nextEdge;
  // the suburban railway builds into the junction station's free throat (company 0's station, open access)
  const b1 = link(g, J, S1, 1, { type: 'electric' }, 'J-S1'), b2 = link(g, S1, S2, 1, { type: 'electric' }, 'S1-S2');
  const mine1 = newTrack(g, e1, 1);
  check(!!(a1 && a2) && mine0.length >= 2, 'the metro line M1 - M2 - J');
  check(!!(b1 && b2) && mine1.length >= 2 && J.owner === 0 && J.rail!.edges.every((id) => net.edges.get(id)!.owner === 0), `company 1 built its line into company 0's junction station (${mine1.length} edges of its own, the station stays company 0's)`);
  const f0 = finishDoubleTrack(g, mine0, 0), f1 = finishDoubleTrack(g, mine1, 1);
  console.log(`  directional: metro ${f0.crossovers} crossovers ${f0.error ?? ''}, suburban ${f1.crossovers} crossovers ${f1.error ?? ''}`);
  check(!f0.error && !f1.error, 'both lines directional, with crossovers before their ends');
  const d0 = depotAtEnd(g, endNode(g, M1, 0, false), 0), d1 = depotAtEnd(g, endNode(g, S2, 1, true), 1);
  check(d0 >= 0 && d1 >= 0, 'a depot for each company');
  // mutual through running: the metro company's trains to S2, the suburban company's trains to M1; one terminates at J
  const L0 = lineOf(g, [M1, M2, J, S1, S2], 0), L1 = lineOf(g, [S2, S1, J, M2, M1], 1), L2 = lineOf(g, [S2, S1, J], 1);
  for (const o of [0, 1]) autoSignalNetwork(g, o);
  const t0 = [0, 1].map(() => g.vehicles.buyTrain(d0, [model('metro_b')], L0.id)).filter((t): t is Train => t instanceof Train);
  const t1 = [0, 1].map(() => g.vehicles.buyTrain(d1, [model('emu_b')], L1.id)).filter((t): t is Train => t instanceof Train);
  const t2 = [0].map(() => g.vehicles.buyTrain(d1, [model('emu_b')], L2.id)).filter((t): t is Train => t instanceof Train);
  check(t0.length === 2 && t1.length === 2 && t2.length === 1, 'metro units and suburban EMUs bought');
  const all = [...t0, ...t1, ...t2];
  const r = runTrains(g, all, 360);
  const at = (ts: Train[], st: Station) => ts.reduce((n, t) => n + (r.arrivals.get(t.id) ?? []).filter((x) => x === st.id).length, 0);
  console.log(`  1 year: metro trains at S2 ${at(t0, S2)}, at J ${at(t0, J)}; suburban trains at M1 ${at(t1, M1)}, at J ${at(t1, J)}; terminating line at J ${at(t2, J)}; worst wait ${r.worst.days} days (${r.worst.kind})`);
  check(at(t0, S2) >= 3 && at(t0, M1) >= 3, 'the metro company\'s trains run through onto the suburban line (to S2 and back)');
  check(at(t1, M1) >= 3 && at(t1, S2) >= 3, 'the suburban company\'s trains run through onto the metro (to M1 and back)');
  check(at(t2, J) >= 3 && at(t0, J) >= 3 && at(t1, J) >= 3, 'both operators\' lines stop at the junction station');
  check(r.worst.days < 30, 'no deadlock');
  const g2 = deserialize(JSON.parse(JSON.stringify(serialize(g))));
  const st2 = g2.stations.get(J.id)!;
  check(st2.owner === 0 && g2.stations.mode(st2) === 'metro' && g2.lines.get(L2.id)!.stops.includes(J.id) && g2.lines.get(L2.id)!.owner === 1, 'save round trip: the junction station and the lines using it');
}

console.log(`(${fmt((performance.now() - T0) / 1000, 1)} s)`);
done();

/** Finish staged dispatch before measuring a full operating period; bound and check the startup too. */
function startFleet(g: Game, vs: StartupVehicle[], maxWaitDays = Infinity) {
  const cycles = vs.map((v) => {
    const l = v.line;
    return l ? startupTable(g, l).pats.find((p) => p.pid === (startupPattern(l, v.pattern)?.id ?? 0))?.cycle ?? 0 : 0;
  });
  const budget = 2 * Math.max(...cycles);
  const deadline = g.tick + Math.ceil(budget / g.tickSeconds), waiting = new Map<number, number>();
  let worstWait = 0, blockedHold = false;
  while (g.tick < deadline && vs.some((v) => v.opLastSt < 0)) {
    g.stepTick();
    for (const v of vs) {
      if (v.state === 'waiting' || v.state === 'noroute') {
        const start = waiting.get(v.id) ?? g.day; waiting.set(v.id, start);
        worstWait = Math.max(worstWait, g.day - start);
      } else waiting.delete(v.id);
      blockedHold ||= v.status === 'Holding for even spacing' && g.vehicles.spacingBlocked(v);
    }
  }
  check(vs.every((v) => v.opLastSt >= 0), 'the whole fleet starts serving within two estimated cycles');
  check(worstWait < maxWaitDays && !blockedHold, 'startup preserves path-wait and platform safety limits');
}
