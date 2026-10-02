// Headless smoke test of the v2 simulation: rail line between two towns (bridges/tunnels), depot, train, line;
// structures forced by height offset; level crossing with road traffic stopping for trains; over/underpass;
// bus line in a town; double-track line with crossovers, one-way signals and two trains; town growth; perf.
// npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=$S/smoke.mjs && node $S/smoke.mjs [seed]
import { Game } from '../src/game/game';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { sitePop, removeEdges } from '../src/game/routing';
import { CROSS_BASE, findRailRoute, railNext } from '../src/game/train';
import { roadDepotReaches } from '../src/game/roadvehicle';
import {
  fails, check, fmt, connectDouble, depotBehind, busStopSites, roadDepotNear, checkReservations, checkNaN,
  placeStationPair, placeAndConnect, addBusStop, newRailEdges, build, free, railOpts, roadOpts, Train, RoadVehicle,
} from './lib';

const seed = Number(process.argv[2] ?? 7);
const T0 = performance.now();
const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
console.log(`world: ${g.towns.list.length} towns, ${g.world.net.edges.size} street edges, ${g.world.buildings.size} buildings, gen ${fmt(performance.now() - T0, 0)} ms`);
g.economy.money = 80_000_000;
const net = g.world.net;
const loco = MODEL_BY_ID.get('diesel_b')!, coach = MODEL_BY_ID.get('coach_ic')!;

// ------------------------------------------------------------------ 1. single-track line between two towns
const e0 = net.nextEdge;
const pair = placeAndConnect(g, 60, 150, 0)!;
check(pair, 'station pair placed and connected');
const { A, B, TA, TB, con } = pair;
console.log(`rail: ${TA.name} (${TA.pop}) <-> ${TB.name} (${TB.pop}), ${fmt(Math.hypot(TA.x - TB.x, TA.z - TB.z))} units`);
console.log(`  stations ${A.name} y=${fmt(A.rail!.y, 2)} catch ${fmt(sitePop(g, A.x, A.z, 16), 0)}, ${B.name} y=${fmt(B.rail!.y, 2)} catch ${fmt(sitePop(g, B.x, B.z, 16), 0)}`);
check(con.ok, 'main line connected');
const mainEdges = newRailEdges(g, e0);
const depot = depotBehind(g, A, B, 0);
check(depot > 0, 'rail depot built');

// ------------------------------------------------------------------ 2. structures forced by height offset
{
  let bridges = 0, tunnels = 0;
  for (const [h, want] of [[2.2, 'bridge'], [-3.2, 'tunnel']] as const) {
    let done = false;
    for (let k = 0; k < 40 && !done; k++) {
      const x = 40 + ((k * 37) % 300), z = 40 + ((k * 71) % 300);
      const ang = k * 0.7, x2 = x + Math.sin(ang) * 30, z2 = z + Math.cos(ang) * 30;
      if (net.edgesNear(Math.min(x, x2) - 3, Math.min(z, z2) - 3, Math.max(x, x2) + 3, Math.max(z, z2) + 3).length) continue;
      const p = build(g, free(g, x, z), free(g, x2, z2), railOpts(0, 1, { heightOffset: h }), want);
      if (!p) continue;
      if (want === 'bridge' && p.stats.bridges) { bridges++; done = true; }
      if (want === 'tunnel' && p.stats.tunnels) { tunnels++; done = true; }
    }
  }
  console.log(`  height offset spurs: bridge ${bridges}, tunnel ${tunnels}; main line ${con.bridges} bridges, ${con.tunnels} tunnels`);
  check(bridges + con.bridges > 0 && tunnels + con.tunnels > 0, 'bridges and tunnels built');
}

// ------------------------------------------------------------------ 3. double track with crossovers, one-way signals, two trains
const dTrains: Train[] = [];
let dbl = { ok: false, signals: 0, crossovers: 0, len: 0 };
let dblDepot = -1, dblLine = -1;
const eDbl = net.nextEdge;
{
  const used = new Set([TA.id, TB.id]);
  for (let attempt = 0; attempt < 4 && !dbl.ok; attempt++) {
    const pr2 = placeStationPair(g, 70, 200, 0, used);
    if (!pr2) break;
    used.add(pr2.TA.id); used.add(pr2.TB.id);
    console.log(`double track: ${pr2.TA.name} <-> ${pr2.TB.name}`);
    const eTry = net.nextEdge;
    dbl = connectDouble(g, pr2.A, pr2.B, 0);
    if (!dbl.ok) { removeEdges(g, newRailEdges(g, eTry), 0); g.stations.removeStation(pr2.A.id); g.stations.removeStation(pr2.B.id); continue; }
    console.log(`  crossovers ${dbl.crossovers}, signals ${dbl.signals}`);
    const dep2 = depotBehind(g, pr2.A, pr2.B, 0);
    if (dbl.ok && dep2 > 0) {
      const l2 = g.lines.create('rail', 0);
      l2.stops = [pr2.A.id, pr2.B.id];
      dblDepot = dep2; dblLine = l2.id;
    }
  }
}
check(dbl.ok && dbl.crossovers === 2 && dbl.signals >= 2, 'double track with crossovers and signals');
const dblEdges = newRailEdges(g, eDbl);

// ------------------------------------------------------------------ 4. crossings (main line and double track): level (with a bus over it), over, under
const crossEdges: Record<string, number> = {};
let crossBus: RoadVehicle | null = null;
let levelCrossing = -1;
{
  // candidate points on the main line: on the ground, away from structures and the stations
  const cands: { e: number; s: number }[] = [];
  const lineEdges = [...mainEdges, ...dblEdges];
  for (const id of lineEdges) {
    const e = net.edges.get(id);
    if (!e) continue;
    for (let s0 = 3; s0 < e.len - 3; s0 += 2) {
      if (e.sections.some((q) => s0 > q.s0 - 3 && s0 < q.s1 + 3)) continue;
      const p = { x: 0, y: 0, z: 0 };
      net.pointAt(e, s0, p);
      if (Math.hypot(p.x - A.x, p.z - A.z) > 20 && Math.hypot(p.x - B.x, p.z - B.z) > 20) cands.push({ e: id, s: s0 });
    }
  }
  console.log(`  crossing candidates: ${cands.length} points on ${lineEdges.length} line edges`);
  for (const mode of ['level', 'over', 'under'] as const) {
    // the test road crosses at right angles, or rotated by about 25 degrees either way
    candLoop: for (const cand of cands) for (const rot of [0, 0.45, -0.45]) {
      const e = net.edges.get(cand.e);
      if (!e) continue;
      const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
      net.pointAt(e, cand.s, p, d);
      if ([...net.crossings.values()].some((c) => Math.hypot(c.x - p.x, c.z - p.z) < 14)) continue;
      // level crossings need the railway at ground level and flat approaches
      const l0 = Math.hypot(d.x, d.z) || 1;
      const rel = p.y - g.world.heightAt(p.x, p.z);
      if (mode === 'level' && (rel < -0.3 || rel > 0.7)) { if (process.argv.includes('-v') && rot === 0) console.log(`    level cand: rail ${fmt(rel, 2)} above ground`); continue; }
      void l0;
      const l = Math.hypot(d.x, d.z) || 1, nx0 = -d.z / l, nz0 = d.x / l;
      const nx = nx0 * Math.cos(rot) - nz0 * Math.sin(rot), nz = nx0 * Math.sin(rot) + nz0 * Math.cos(rot);
      // approach length: long enough for the road grade on hillsides (level crossings)
      let L = 11;
      if (mode === 'level') {
        L = [10, 14, 18, 22, 26].find((k) => [-1, 1].every((sg) => Math.abs(g.world.heightAt(p.x + nx * k * sg, p.z + nz * k * sg) - (p.y - 0.04)) <= 0.065 * k)) ?? -1;
        if (L < 0) { if (process.argv.includes('-v')) console.log(`    level cand: approaches too steep (rot ${rot})`); continue; }
      }
      // the test road must not touch other roads (country roads, streets) near the line
      const clear = (L: number) => {
        for (let k = 0; k <= 2 * L; k++) { const x = p.x + nx * (k - L), z = p.z + nz * (k - L); if (net.nearestEdge(x, z, 1.6, undefined, (q) => !lineEdges.includes(q.id))) return false; }
        return true;
      };
      if (mode !== 'level') L = [11, 9, 14].find(clear) ?? -1;
      if (L < 0 || !clear(L)) { if (process.argv.includes('-v')) console.log(`    ${mode} cand blocked`); continue; }
      const a = { x: p.x - nx * L, z: p.z - nz * L }, b = { x: p.x + nx * L, z: p.z + nz * L };
      const pr = build(g, free(g, a.x, a.z), free(g, b.x, b.z), roadOpts(0, 'road', { crossing: mode }), mode + ' crossing');
      if (!pr || !pr.crossings.length) { if (pr) console.log('  (no crossing detected)'); continue; }
      crossEdges[mode] = e.id;
      console.log(`  ${mode} crossing at ${fmt(p.x)},${fmt(p.z)}: modes ${pr.crossings.map((c) => c.mode).join(',')}, road bridges ${pr.stats.bridges}`);
      if (mode === 'level') {
        const c = [...net.crossings.values()].find((c) => c.kind === 'level' && Math.hypot(c.x - p.x, c.z - p.z) < 1);
        levelCrossing = c ? c.id : -1;
        // a bus shuttling across the level crossing (stops where the road is on the ground)
        const stopAt = (sg: number) => {
          for (const k of [L - 3, L - 1.5, L - 4.5, L - 6, 5]) {
            const x = p.x + nx * k * sg, z = p.z + nz * k * sg;
            const bp = g.stations.planBusStop(x, z, 0);
            if (bp.ok) return addBusStop(g, x, z, 0);
            if (k === 5) console.log(`    stop ${sg}: ${bp.error}`);
          }
          return -1;
        };
        const s1 = stopAt(-1), s2 = stopAt(1);
        const roadEdges = [...net.edges.values()].filter((q) => q.kind === 'road' && q.owner === 0 && pr.tracks.length && Math.hypot((q.bez.x0 + q.bez.x3) / 2 - p.x, (q.bez.z0 + q.bez.z3) / 2 - p.z) < L + 2).map((q) => q.id);
        let dep = roadDepotNear(g, p.x - nx * (L - 3), p.z - nz * (L - 3), 0, roadEdges);
        // fallback: at a dead end of the crossing road, facing it
        for (const sg of [-1, 1]) {
          if (dep > 0) break;
          const ex = p.x + nx * (L + 2.4) * sg, ez = p.z + nz * (L + 2.4) * sg;
          const plan = g.depots.plan('road', ex, ez, Math.atan2(-nx * sg, -nz * sg), 0);
          if (plan.ok) { const id = g.depots.nextId; if (!g.depots.commit('road', plan, 0)) dep = id; }
          else console.log(`    depot at road end: ${plan.error}`);
        }
        // the depot must reach both stops
        if (dep > 0 && s1 > 0 && s2 > 0 && !(roadDepotReaches(g, g.depots.get(dep)!, s1) && roadDepotReaches(g, g.depots.get(dep)!, s2))) { console.log('    depot does not reach the stops'); g.depots.remove(dep); dep = -1; }
        if (s1 > 0 && s2 > 0 && dep > 0) {
          const bl = g.lines.create('road', 0);
          bl.stops = [s1, s2];
          const v = g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_b')!, bl.id);
          if (v instanceof RoadVehicle) crossBus = v;
        }
        console.log(`    level crossing id ${levelCrossing}, bus stops ${s1},${s2}, depot ${dep}`);
      }
      break candLoop;
    }
  }
  // no free flat stretch on the lines: use a level crossing the line got where it crossed a country road
  if (levelCrossing < 0) {
    const lc = [...net.crossings.values()].find((c) => c.kind === 'level' && (lineEdges.includes(c.e1) || lineEdges.includes(c.e2)));
    const roadId = lc ? (lineEdges.includes(lc.e1) ? lc.e2 : lc.e1) : -1;
    const road = net.edges.get(roadId);
    if (lc && road) {
      levelCrossing = lc.id;
      const s0 = lineEdges.includes(lc.e1) ? lc.s2 : lc.s1;
      const q0 = { x: 0, y: 0, z: 0 }, t0 = { x: 0, y: 0, z: 0 };
      net.pointAt(road, s0, q0, t0);
      const tl = Math.hypot(t0.x, t0.z) || 1;
      // stops on the road a few units either side of the tracks (the road may continue on other edges)
      const stopOn = (dir: number) => {
        for (const k of [4, 6, 3, 8, 10]) {
          const x = lc.x + (t0.x / tl) * k * dir, z = lc.z + (t0.z / tl) * k * dir;
          if (g.stations.planBusStop(x, z, 0).ok) return { id: addBusStop(g, x, z, 0), x, z };
        }
        return null;
      };
      const st1 = stopOn(-1), st2 = stopOn(1);
      let dep = st1 ? roadDepotNear(g, st1.x, st1.z, 0) : -1;
      if (dep > 0 && st1 && st2 && !(roadDepotReaches(g, g.depots.get(dep)!, st1.id) && roadDepotReaches(g, g.depots.get(dep)!, st2.id))) { g.depots.remove(dep); dep = -1; }
      if (st1 && st2 && st1.id > 0 && st2.id > 0 && st1.id !== st2.id && dep > 0) {
        const bl = g.lines.create('road', 0);
        bl.stops = [st1.id, st2.id];
        const v = g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_b')!, bl.id);
        if (v instanceof RoadVehicle) crossBus = v;
      }
      console.log(`  level crossing of the line with a country road at ${fmt(lc.x)},${fmt(lc.z)}: id ${lc.id}, bus stops ${st1?.id},${st2?.id}, depot ${dep}`);
    }
  }
  // over/under passes need no trains: if the lines have no free stretch, cross a test spur in open country
  for (const mode of ['over', 'under'] as const) {
    if (crossEdges[mode] !== undefined) continue;
    const size = g.world.size, n = Math.floor((size - 48) / 6);
    for (let k = 0; k < n * n; k++) {
      const x = 24 + ((k * 37) % n) * 6, z = 24 + Math.floor(k / n) * 6;
      // nothing near the spur (rail along x) and the test road (along z)
      let busy = false;
      for (let t = -20; t <= 20 && !busy; t += 1) {
        if (net.nearestEdge(x + t, z, 2) || (Math.abs(t) <= 13 && net.nearestEdge(x, z + t, 2))) busy = true;
        if (g.world.buildingsNear(x + t, z, 1.5).length || (Math.abs(t) <= 13 && g.world.buildingsNear(x, z + t, 1.5).length)) busy = true;
      }
      if (busy) continue;
      let mn = Infinity, mx = -Infinity;
      for (let dz = -12; dz <= 12; dz += 4) for (let dx = -15; dx <= 15; dx += 5) { const h = g.world.heightAt(x + dx, z + dz); mn = Math.min(mn, h); mx = Math.max(mx, h); }
      if (mn < 0.3 || mx - mn > 6) continue;
      // an underpass needs the railway up on a bridge: the spur rises to a raised middle node
      let spur: ReturnType<typeof build> = null;
      if (mode === 'over') spur = build(g, free(g, x - 15, z), free(g, x + 15, z), railOpts(0, 1), 'test spur');
      else {
        const h1 = build(g, free(g, x - 18, z), free(g, x + 1, z), railOpts(0, 1, { heightOffset: 1.5 }), 'test spur (up)');
        const mid = h1 ? net.nearestNode(x + 1, z, 0.2, 'rail') : null;
        spur = mid ? build(g, { kind: 'node', x: mid.x, z: mid.z, y: mid.y, node: mid.id }, free(g, x + 20, z), railOpts(0, 1), 'test spur (down)') : null;
      }
      if (!spur) continue;
      const pr = build(g, free(g, x, z - 12), free(g, x, z + 12), roadOpts(0, 'road', { crossing: mode }), mode + ' crossing (spur)');
      if (pr && pr.crossings.length) { crossEdges[mode] = spur.tracks.length ? (net.nearestEdge(x, z, 1, 'rail')?.edge.id ?? -1) : -1; console.log(`  ${mode} crossing on a test spur at ${fmt(x)},${fmt(z)}: modes ${pr.crossings.map((c) => c.mode).join(',')}, road bridges ${pr.stats.bridges}`); break; }
    }
  }
  check(levelCrossing > 0, 'level crossing built');
  check(crossBus, 'bus across the level crossing');
  const over = crossEdges.over !== undefined, under = crossEdges.under !== undefined;
  check(over && under, 'over- and underpass built');
  if (under) { const re = net.edges.get(crossEdges.under); check(re && re.sections.some((s) => s.type === 'bridge') || [...net.edges.values()].some((e) => e.kind === 'rail' && e.owner === 0 && e.sections.some((s) => s.type === 'bridge')), 'underpass: the railway got a bridge'); }
}

// ------------------------------------------------------------------ 5. trains
const line = g.lines.create('rail', 0);
line.stops = [A.id, B.id];
const tr = g.vehicles.buyTrain(depot, [loco, coach, coach, coach], null);
check(tr instanceof Train, 'train bought: ' + (typeof tr === 'string' ? tr : ''));
const train = tr as Train;
if (train instanceof Train) train.setLine(line.id);
if (dblDepot > 0) for (let i = 0; i < 2; i++) { const t = g.vehicles.buyTrain(dblDepot, [loco, coach, coach], dblLine); if (t instanceof Train) dTrains.push(t); }
check(dTrains.length === 2, 'two trains on the double track');

// ------------------------------------------------------------------ 6. bus line in the biggest town
const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
const sites = busStopSites(g, big, 0, 25, 60);
let bus: RoadVehicle | null = null;
if (sites.length === 2) {
  const s0 = addBusStop(g, sites[0][0], sites[0][1], 0), s1 = addBusStop(g, sites[1][0], sites[1][1], 0);
  check(s0 > 0 && s1 > 0 && s0 !== s1, `bus stops built ${s0} ${s1}`);
  const bdep = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  check(bdep > 0, 'road depot built');
  const bl = g.lines.create('road', 0);
  bl.stops = [s0, s1];
  const b = g.vehicles.buyRoad(bdep, MODEL_BY_ID.get('bus_c')!, bl.id);
  if (b instanceof RoadVehicle) bus = b;
  console.log(`  bus line in ${big.name}: stops ${fmt(Math.hypot(sites[0][0] - sites[1][0], sites[0][1] - sites[1][1]))} apart`);
}
check(bus, 'town bus bought');

// ------------------------------------------------------------------ 7. intercity bus over the country roads
// a stop in each of two neighbouring towns joined by the generated roads; the bus must drive between them
let icBus: RoadVehicle | null = null;
const icStops: number[] = [];
{
  const roadEdges = [...net.edges.values()].filter((e) => e.kind === 'road' && e.type === 'road' && e.owner === -1);
  check(roadEdges.length > 0, `country roads generated (${roadEdges.length} edges, ${fmt(roadEdges.reduce((a, e) => a + e.len, 0), 0)} u)`);
  const stopIn = (t: typeof big) => {
    const cands = g.towns.streets(t, 0).filter((e) => e.type === 'street' && e.len > 4).map((e) => { const p = { x: 0, y: 0, z: 0 }; net.pointAt(e, e.len / 2, p); return p; })
      .sort((a, b) => Math.hypot(a.x - t.x, a.z - t.z) - Math.hypot(b.x - t.x, b.z - t.z));
    for (const p of cands.slice(0, 30)) if (g.stations.planBusStop(p.x, p.z, 0).ok) return { id: addBusStop(g, p.x, p.z, 0), x: p.x, z: p.z };
    return null;
  };
  const towns = [...g.towns.list].sort((a, b) => b.pop - a.pop);
  // the length of the way by road between two points (Dijkstra over the road graph; Infinity if none)
  const byRoad = (ax: number, az: number, bx: number, bz: number): number => {
    const na = net.nearestNode(ax, az, 12, 'road'), nb = net.nearestNode(bx, bz, 12, 'road');
    if (!na || !nb) return Infinity;
    const dist = new Map<number, number>([[na.id, 0]]), q: [number, number][] = [[0, na.id]];
    while (q.length) {
      let bi = 0;
      for (let i = 1; i < q.length; i++) if (q[i][0] < q[bi][0]) bi = i;
      const [dd, n] = q.splice(bi, 1)[0];
      if (n === nb.id) return dd;
      if (dd > (dist.get(n) ?? Infinity)) continue;
      for (const eid of net.nodes.get(n)?.edges ?? []) {
        const e = net.edges.get(eid)!;
        if (e.kind !== 'road') continue;
        const m = e.a === n ? e.b : e.a, nd = dd + e.len;
        if (nd < (dist.get(m) ?? Infinity)) { dist.set(m, nd); q.push([nd, m]); }
      }
    }
    return Infinity;
  };
  outer: for (const ta of towns) for (const tb of towns) {
    const d = Math.hypot(ta.x - tb.x, ta.z - tb.z);
    if (ta.id >= tb.id || d < 50 || d > 140) continue;
    // neighbours by road (not the long way round a ridge)
    if (byRoad(ta.x, ta.z, tb.x, tb.z) > d * 2.2) continue;
    const sa = stopIn(ta), sb = sa ? stopIn(tb) : null;
    if (!sa || !sb || sa.id < 0 || sb.id < 0 || sa.id === sb.id) continue;
    const dep = roadDepotNear(g, sa.x, sa.z, 0);
    if (dep < 0 || !roadDepotReaches(g, g.depots.get(dep)!, sb.id)) { if (dep > 0) g.depots.remove(dep); continue; }
    const l = g.lines.create('road', 0);
    l.stops = [sa.id, sb.id];
    const b = g.vehicles.buyRoad(dep, MODEL_BY_ID.get('bus_c')!, l.id);
    if (b instanceof RoadVehicle) { icBus = b; icStops.push(sa.id, sb.id); console.log(`  intercity bus ${ta.name} - ${tb.name} (${fmt(d, 0)} u apart)`); break outer; }
  }
}
check(icBus, 'intercity bus bought');

// ------------------------------------------------------------------ simulate
const popSim = g.towns.list.map((t) => t.pop);
const bld0 = g.world.buildings.size, edges0 = net.edges.size;
const arrivals = new Map<number, Map<number, number>>();
const lastAt = new Map<number, number>();
let busArr = 0, lastBus = '', crossBusArr = 0, lastCrossBus = '';
const icVisits = new Map<number, number>();
let icLast = '', icOnRoad = 0, icTicks = 0;
let closedTicks = 0, waitedAtCrossing = 0, unsafe = 0, signalWaits = 0;
let errors = 0, nanMsg: string | null = null;
const T1 = performance.now();
const days = 720, startDay = g.day;
let lastLog = -1;
const cr = levelCrossing > 0 ? net.crossings.get(levelCrossing) : undefined;
const pv = { x: 0, y: 0, z: 0 };
while (g.day < startDay + days) {
  try { g.update(0.25); } catch (e) { errors++; console.log('EXCEPTION', (e as Error).stack?.split('\n').slice(0, 6).join('\n')); if (errors > 3) break; }
  for (const t of [train, ...dTrains]) {
    if (!(t instanceof Train)) continue;
    if (t.state === 'loading' && lastAt.get(t.id) !== t.atStation) {
      lastAt.set(t.id, t.atStation);
      const m = arrivals.get(t.id) ?? new Map<number, number>();
      m.set(t.atStation, (m.get(t.atStation) ?? 0) + 1);
      arrivals.set(t.id, m);
    }
    if (t.state === 'waiting' && t.blockedBy) signalWaits++;
  }
  if (bus) { if (bus.state === 'loading' && lastBus !== 'loading') busArr++; lastBus = bus.state; }
  if (crossBus) { if (crossBus.state === 'loading' && lastCrossBus !== 'loading') crossBusArr++; lastCrossBus = crossBus.state; }
  if (icBus) {
    const icb: RoadVehicle = icBus;
    if (icb.state === 'loading' && icLast !== 'loading') { const st = icb.line?.stops[icb.stopIndex] ?? -1; icVisits.set(st, (icVisits.get(st) ?? 0) + 1); }
    icLast = icb.state;
    if (icb.seg && icb.state === 'running') { icTicks++; if (net.edges.get(icb.seg.e)?.type === 'road') icOnRoad++; }
  }
  if (cr) {
    const closed = g.vehicles.crossingClosed.has(cr.id);
    if (closed) closedTicks++;
    // road vehicles waiting in front of the closed crossing
    for (const v of [...g.vehicles.roads(), ...g.vehicles.ambient]) {
      if (!v.seg || v.seg.e !== cr.e2) continue;
      v.worldPos(pv);
      const d = Math.hypot(pv.x - cr.x, pv.z - cr.z);
      if (closed && d < 2.2 && v.speed < 0.02) waitedAtCrossing++;
      // safety: no road vehicle on the crossing while a train occupies it
      if (d < 0.35 && g.vehicles.getRes(CROSS_BASE + cr.id) && [...g.vehicles.trains()].some((t) => t.occupiedEdges().includes(cr.e1) && (() => { const q = { x: 0, y: 0, z: 0 }; for (let k = 0; k <= 10; k++) { t.pointBehind((t.length * k) / 10, q); if (Math.hypot(q.x - cr.x, q.z - cr.z) < 0.4) return true; } return false; })())) unsafe++;
    }
  }
  if (!nanMsg && g.day % 5 === 0) nanMsg = checkNaN(g);
  if (g.day % 120 === 0 && g.day !== lastLog) {
    lastLog = g.day;
    console.log(`  ${g.dateString()}: train ${train.state} "${train.status}" | double ${dTrains.map((t) => t.state).join('/')} | buses ${busArr}/${crossBusArr} stops | crossing closed ${closedTicks} ticks, waits ${waitedAtCrossing} | money ${fmt(g.economy.money / 1e6, 2)}M`);
    if (icBus && process.argv.includes('-v')) { const ib: RoadVehicle = icBus; ib.worldPos(pv); console.log(`    intercity bus ${ib.state} "${ib.status}" at ${fmt(pv.x)},${fmt(pv.z)} speed ${fmt(ib.speedKmh, 0)} km/h, stuck ${fmt(ib.stuck, 1)}`); }
  }
}
const simMs = performance.now() - T1;
console.log(`simulated ${days} days in ${fmt(simMs, 0)} ms (${fmt(simMs / days, 2)} ms/day)`);
const arr = (t: Train | undefined) => (t ? [...(arrivals.get(t.id)?.values() ?? [])] : []);
check(errors === 0, 'no exceptions');
check(!nanMsg, 'no NaN positions ' + (nanMsg ?? ''));
check(arr(train).length === 2 && arr(train).every((n) => n >= 3), `train served both stations repeatedly (${arr(train).join('/')})`);
check(A.genLast + A.genMonth > 0 && B.genLast + B.genMonth > 0, 'passengers generated');
check(train.delivered > 0, `train delivered passengers (${train.delivered})`);
check(line.incomeYear + line.incomeLast > 0, 'rail line income > 0');
check(busArr >= 4 && (bus?.delivered ?? 0) > 0, `town bus served its stops (${busArr} stops, ${bus?.delivered} delivered)`);
check(crossBusArr >= 4, `bus across the level crossing kept running (${crossBusArr} stops)`);
if (icBus) {
  const ib: RoadVehicle = icBus;
  check(icStops.every((s) => (icVisits.get(s) ?? 0) >= 2), `intercity bus served both towns (${icStops.map((s) => icVisits.get(s) ?? 0).join('/')} stops, ${ib.delivered} delivered)`);
  check(icOnRoad > 0, `intercity bus drove on the country roads (${fmt((100 * icOnRoad) / Math.max(1, icTicks), 0)}% of its running time)`);
  console.log(`  intercity bus: ${icStops.map((s) => icVisits.get(s) ?? 0).join('/')} stops, ${ib.delivered} delivered, ${fmt((100 * icOnRoad) / Math.max(1, icTicks), 0)}% of its running time on country roads`);
}
check(closedTicks > 0, `level crossing closed for trains (${closedTicks} ticks)`);
check(waitedAtCrossing > 0, `road vehicles waited at the closed crossing (${waitedAtCrossing} vehicle-ticks)`);
check(unsafe === 0, `no road vehicle on the crossing while a train passes (${unsafe})`);
for (const t of dTrains) check(arr(t).length === 2 && arr(t).every((n) => n >= 2), `double-track ${t.name} served both stations (${arr(t).join('/')})`);
console.log(`  signal/path waits: ${signalWaits} train-ticks`);
if (crossBus) { crossBus.worldPos(pv); console.log(`  crossing bus: ${crossBus.state} "${crossBus.status}" at ${fmt(pv.x)},${fmt(pv.z)} seg ${crossBus.seg?.kind}${crossBus.seg?.e} pos ${fmt(crossBus.pos, 2)} speed ${fmt(crossBus.speedKmh, 0)} line ${crossBus.line?.stops.join(',')}`); }
for (const t of dTrains) {
  const seg = t.segs[t.headSeg];
  const e = seg ? net.edges.get(seg.e) : undefined;
  console.log(`  ${t.name}: ${t.state} "${t.status}" head edge ${seg?.e} dir ${seg?.dir} station ${e?.station} target ${t.routeTarget} pending ${t.pending.length}`);
  if (e) for (const dir of [1, -1]) { const r = findRailRoute(g, railNext(g, e, dir, 0), t.targetStation()!.id, 0, -1); console.log(`    from head edge dir ${dir}: ${r ? r.conts.length + ' edges' : 'NONE'}`); }
}
const resErr = checkReservations(g);
check(resErr.length === 0, 'reservations consistent ' + resErr.slice(0, 3).join('; '));
console.log(`train: delivered ${train.delivered}, profit ${fmt(train.profitLast / 1e3, 0)}k last year; double-track trains delivered ${dTrains.map((t) => t.delivered).join('/')}`);
console.log(`towns: buildings ${bld0} -> ${g.world.buildings.size}, network edges ${edges0} -> ${net.edges.size}`);
console.log('  ' + g.towns.list.map((t, i) => `${t.name} ${popSim[i]}->${t.pop}${t.served ? ' (served)' : ''}`).join(', '));
check(g.towns.list.reduce((a, t) => a + t.pop, 0) > popSim.reduce((a, b) => a + b, 0), 'towns grew in total');
check(g.world.buildings.size > bld0, 'new buildings appeared');

// ------------------------------------------------------------------ performance: one game day with many vehicles
{
  g.speed = 1;
  const t = performance.now(); const d0 = g.day;
  while (g.day < d0 + 30) g.update(0.25);
  console.log(`perf: ${fmt((performance.now() - t) / 30, 2)} ms per game day with ${g.vehicles.map.size} company vehicles + ${g.vehicles.ambient.length} town cars (see scripts/perf.ts for the 512-map stress test)`);
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
