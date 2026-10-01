// Shared helpers for the headless simulation tests (bundle with esbuild, run with node).
import { Game } from '../src/game/game';
import { findSnap, planEdge, commitProposal, BuildOptions, Snap, Proposal } from '../src/game/construction';
import { toggleSignal } from '../src/game/build-ops';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import { Train, CROSS_BASE, findRailRoute, railNext } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import {
  findStationSite, stationEnds, CorridorSearch, alignCorridor, chainProfile, buildChain, nodeSnap, OPoint, SiteOpts, buildRailDepot, buildDepotOnLine, buildRoadDepot, findRailPair,
  routeConflict,
} from '../src/game/ai';

export const fails: string[] = [];
export function check(cond: any, msg: string) { if (!cond) { fails.push(msg); console.log('  FAIL: ' + msg); } }
export const fmt = (x: number, d = 1) => x.toFixed(d);

export function railOpts(owner = 0, tracks = 1, extra: Partial<BuildOptions> = {}): BuildOptions {
  return { kind: 'rail', type: 'standard', tracks, heightOffset: 0, crossing: 'auto', owner, ...extra };
}
export function roadOpts(owner = 0, type = 'road', extra: Partial<BuildOptions> = {}): BuildOptions {
  return { kind: 'road', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner, ...extra };
}
export const free = (g: Game, x: number, z: number): Snap => ({ kind: 'free', x, z, y: g.world.heightAt(x, z) });

/** planEdge + commitProposal; returns the proposal or null (logs the reason). */
export function build(g: Game, a: Snap, b: Snap, o: BuildOptions, label = ''): Proposal | null {
  const p = planEdge(g, a, b, o);
  if (!p.ok) { console.log(`  build ${label} failed: ${p.errors.join(', ')}`); return null; }
  const err = commitProposal(g, p);
  if (err) { console.log(`  commit ${label} failed: ${err}`); return null; }
  return p;
}

/** Edge snap on the edge nearest to (x,z). */
export function edgeSnapAt(g: Game, kind: 'rail' | 'road', x: number, z: number): Snap {
  return findSnap(g, kind, x, z, 0.6);
}

export function nodeNear(g: Game, kind: 'rail' | 'road', x: number, z: number, r = 0.1) {
  return g.world.net.nearestNode(x, z, r, kind, (n) => n.edges.length > 0);
}

/**
 * Connect two rail stations (2 tracks, axes facing each other) with a routed main line:
 * straight lead-out from A's track 0, A* corridor, railway alignment into B's track 0, and switches
 * from track 1 into the leads.
 */
export function connectStations(g: Game, A: Station, B: Station, owner = 0, tracks = 1, log = console.log): { ok: boolean; len: number; bridges: number; tunnels: number; minR: number } {
  const ra = A.rail!, rb = B.rail!;
  const ea = stationEnds(g, A), eb = stationEnds(g, B);
  const net = g.world.net;
  const fail = { ok: false, len: 0, bridges: 0, tunnels: 0, minR: 0 };
  const facing = (st: Station, other: Station) => { const r = st.rail!; return Math.sin(r.angle) * (other.x - st.x) + Math.cos(r.angle) * (other.z - st.z) > 0; };
  const endA = (i: number) => (facing(A, B) ? ea[i].front : ea[i].back), endB = (i: number) => (facing(B, A) ? eb[i].front : eb[i].back);
  const fa = facing(A, B) ? 1 : -1, fb = facing(B, A) ? 1 : -1;
  const fA = { x: Math.sin(ra.angle) * fa, z: Math.cos(ra.angle) * fa }, fB = { x: Math.sin(rb.angle) * fb, z: Math.cos(rb.angle) * fb };
  const a0 = net.nodes.get(endA(0))!, b0 = net.nodes.get(endB(0))!;
  const LEAD = 20;
  const from: OPoint = { x: a0.x + fA.x * LEAD, z: a0.z + fA.z * LEAD, tx: fA.x, tz: fA.z };
  const to: OPoint = { x: b0.x + fB.x * LEAD, z: b0.z + fB.z * LEAD, tx: -fB.x, tz: -fB.z };
  const t0 = performance.now();
  const avoid = [
    { x0: a0.x - fA.x * 4, z0: a0.z - fA.z * 4, x1: from.x - fA.x * 4, z1: from.z - fA.z * 4, r: 4 },
    { x0: b0.x - fB.x * 4, z0: b0.z - fB.z * 4, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
  ];
  const cs = new CorridorSearch(g, from, to, { kind: 'rail', owner, avoid });
  const path = cs.run();
  if (!path) { log(`  corridor: none (expanded ${cs.expanded})`); return fail; }
  const al = alignCorridor(path, from, to);
  const way = [...al.way, { x: b0.x, z: b0.z, tx: -fB.x, tz: -fB.z }];
  const exclude = new Set<number>([...a0.edges, ...b0.edges]);
  const prof = chainProfile(g, [{ x: a0.x, z: a0.z, tx: fA.x, tz: fA.z }, ...way], tracks, ra.y, rb.y, 'rail', exclude);
  log(`  corridor: ${path.length} pts, expanded ${cs.expanded}, ${fmt(performance.now() - t0)} ms; ${way.length} waypoints, min radius ${fmt(al.minR)}${prof ? ', crossings ' + prof.crossings.map((c) => c.mode).join('/') : ', PROFILE INFEASIBLE'}`);
  const res = buildChain(g, a0.id, way, railOpts(owner, tracks), b0.id, prof, (s) => log('   ' + s));
  log(`  chain: ok=${res.ok} ${res.error ?? ''} edges=${res.edges} len=${fmt(res.built)} bridges=${res.bridges} tunnels=${res.tunnels} cost=${Math.round(res.cost)}`);
  for (const n of res.notes ?? []) log('   ' + n);
  if (!res.ok) return { ...fail, len: res.built };
  // switches: track 1 joins the leads 14 units out
  const s1 = edgeSnapAt(g, 'rail', a0.x + fA.x * 14, a0.z + fA.z * 14);
  build(g, nodeSnap(g, endA(1), 'rail'), s1, railOpts(owner), 'throat A');
  const s2 = edgeSnapAt(g, 'rail', b0.x + fB.x * 14, b0.z + fB.z * 14);
  build(g, nodeSnap(g, endB(1), 'rail'), s2, railOpts(owner), 'throat B');
  return { ok: true, len: res.built, bridges: res.bridges, tunnels: res.tunnels, minR: al.minR };
}

/** Rail depot for a station: stub behind a free back end, else a siding off the line towards `toward`. */
export function depotBehind(g: Game, st: Station, toward: Station, owner = 0): number {
  const dir = { x: toward.x - st.x, z: toward.z - st.z };
  let id = buildRailDepot(g, st, owner, dir);
  if (id >= 0) return id;
  const l = Math.hypot(dir.x, dir.z) || 1;
  for (const d of [30, 40, 50, 60]) {
    const x = st.x + (dir.x / l) * (st.rail!.length / 2 + d), z = st.z + (dir.z / l) * (st.rail!.length / 2 + d);
    const ne = g.world.net.nearestEdge(x, z, 12, 'rail', (e) => e.owner === owner && e.station < 0 && e.depot < 0 && e.len > 8);
    if (!ne) continue;
    id = buildDepotOnLine(g, ne.edge.id, Math.min(ne.edge.len - 3, Math.max(3, ne.s)), owner);
    if (id >= 0) return id;
  }
  return -1;
}

/** Find two bus stop sites on streets of a town, `minD`..`maxD` apart. */
export function busStopSites(g: Game, town: Town, owner: number, minD = 10, maxD = 30): [number, number][] {
  const cands: [number, number][] = [];
  for (const e of g.towns.streets(town, 0)) {
    if (e.len < 4) continue;
    const p = { x: 0, y: 0, z: 0 };
    g.world.net.pointAt(e, e.len / 2, p);
    const bp = g.stations.planBusStop(p.x, p.z, owner);
    if (bp.ok && !bp.join) cands.push([p.x, p.z]);
  }
  cands.sort((a, b) => Math.hypot(a[0] - town.x, a[1] - town.z) - Math.hypot(b[0] - town.x, b[1] - town.z));
  for (const a of cands) for (const b of cands) {
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d >= minD && d <= maxD) return [a, b];
  }
  return [];
}

/** Road depot next to a street near (x,z). Returns depot id or -1. */
export function roadDepotNear(g: Game, x: number, z: number, owner: number, onEdges?: number[]): number {
  return buildRoadDepot(g, x, z, owner, 26, onEdges ? (e) => onEdges.includes(e.id) : undefined);
}

export function checkReservations(g: Game): string[] {
  const errs: string[] = [];
  const V = g.vehicles as any;
  const res: Map<number, number> = V.res;
  for (const [r, id] of res) {
    const t = g.vehicles.get(id);
    if (!(t instanceof Train)) { errs.push(`reservation ${r} by missing train ${id}`); continue; }
    if (!t.segs.some((s) => s.res.includes(r))) errs.push(`reservation ${r} by ${t.name} not on its path`);
    if (r < CROSS_BASE && !g.world.net.edges.has(r)) errs.push(`reservation of removed edge ${r}`);
  }
  return errs;
}

export function checkNaN(g: Game): string | null {
  const p = { x: 0, y: 0, z: 0 };
  for (const v of g.vehicles.map.values()) { v.worldPos(p); if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return `${v.name} at NaN`; }
  for (const a of g.vehicles.ambient) { a.worldPos(p); if (!isFinite(p.x) || !isFinite(p.y) || !isFinite(p.z)) return `ambient ${a.id} at NaN`; }
  return null;
}

export function pickTownPair(g: Game, minD: number, maxD: number, exclude: Set<number> = new Set()): [Town, Town] | null {
  return townPairs(g, minD, maxD, exclude)[0] ?? null;
}

/** Candidate town pairs within a distance range, best (population product) first. */
export function townPairs(g: Game, minD: number, maxD: number, exclude: Set<number> = new Set()): [Town, Town][] {
  const out: { p: [Town, Town]; s: number }[] = [];
  for (const a of g.towns.list) for (const b of g.towns.list) {
    if (a.id >= b.id || exclude.has(a.id) || exclude.has(b.id)) continue;
    const d = Math.hypot(a.x - b.x, a.z - b.z);
    if (d < minD || d > maxD) continue;
    out.push({ p: a.pop >= b.pop ? [a, b] : [b, a], s: a.pop * b.pop });
  }
  return out.sort((x, y) => y.s - x.s).map((x) => x.p);
}

/** Place a pair of 2-track stations for a rail link (feasible heights, good catchment). */
export function placeStationPair(g: Game, minD: number, maxD: number, owner = 0, exclude: Set<number> = new Set(), length = 16): { A: Station; B: Station; TA: Town; TB: Town } | null {
  for (const [TA, TB] of townPairs(g, minD, maxD, exclude)) {
    const pr = findRailPair(g, TA, TB, { tracks: 2, length, owner });
    if (!pr) continue;
    const ia = g.stations.nextId;
    if (g.stations.commitRail(pr.a, owner)) continue;
    const A = g.stations.get(ia)!;
    // the second plan may conflict now; re-plan it at the same spot
    const pb = g.stations.planRail(pr.b.x, pr.b.z, pr.b.angle, length, 2, owner);
    const ib = g.stations.nextId;
    if (!pb.ok || g.stations.commitRail(pb, owner)) { g.stations.removeStation(A.id); continue; }
    return { A, B: g.stations.get(ib)!, TA, TB };
  }
  return null;
}

export function placeStation(g: Game, town: Town, toward: { x: number; z: number }, owner = 0, tracks = 2, length = 16, extra: Partial<SiteOpts> = {}): Station | null {
  const plan = findStationSite(g, town, toward, { tracks, length, owner, ...extra });
  if (!plan) return null;
  const before = g.stations.nextId;
  const err = g.stations.commitRail(plan, owner);
  if (err) { console.log('  commitRail failed:', err); return null; }
  return g.stations.get(before) ?? null;
}

/** Build a bus stop and return the id of the station it belongs to (it may join a nearby station). */
export function addBusStop(g: Game, x: number, z: number, owner: number): number {
  const err = g.stations.commitBusStop(x, z, owner);
  if (err) return -1;
  let best = -1, bd = Infinity;
  for (const st of g.stations.map.values()) for (const p of st.stops) { const d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; best = st.id; } }
  return best;
}

export { Train, RoadVehicle };

/** Rail edges (owned by `owner`, not station/depot) created since edge id `from`. */
export function newRailEdges(g: Game, from: number, owner = 0): number[] {
  const out: number[] = [];
  for (const [id, e] of g.world.net.edges) if (id >= from && e.kind === 'rail' && e.owner === owner && e.station < 0 && e.depot < 0) out.push(id);
  return out;
}

/**
 * Double-track line between two 2-track stations (each main track runs into one platform track), with a
 * crossover near each terminus and one-way signals: the "out" track carries A->B trains, "in" B->A.
 */
export function connectDouble(g: Game, A: Station, B: Station, owner = 0, log = console.log): { ok: boolean; signals: number; crossovers: number; len: number } {
  const net = g.world.net;
  const fail = { ok: false, signals: 0, crossovers: 0, len: 0 };
  const ra = A.rail!, rb = B.rail!;
  const facing = (st: Station, o: Station) => Math.sin(st.rail!.angle) * (o.x - st.x) + Math.cos(st.rail!.angle) * (o.z - st.z) > 0;
  const ea = stationEnds(g, A), eb = stationEnds(g, B);
  const fa = facing(A, B) ? 1 : -1, fb = facing(B, A) ? 1 : -1;
  const fA = { x: Math.sin(ra.angle) * fa, z: Math.cos(ra.angle) * fa }, fB = { x: Math.sin(rb.angle) * fb, z: Math.cos(rb.angle) * fb };
  const frontsA = ea.map((e) => (fa > 0 ? e.front : e.back)), frontsB = eb.map((e) => (fb > 0 ? e.front : e.back));
  const cA = { x: ra.x + fA.x * ra.length / 2, z: ra.z + fA.z * ra.length / 2 }, cB = { x: rb.x + fB.x * rb.length / 2, z: rb.z + fB.z * rb.length / 2 };
  const LEAD = 22;
  const from: OPoint = { x: cA.x + fA.x * LEAD, z: cA.z + fA.z * LEAD, tx: fA.x, tz: fA.z };
  const to: OPoint = { x: cB.x + fB.x * LEAD, z: cB.z + fB.z * LEAD, tx: -fB.x, tz: -fB.z };
  const avoid = [
    { x0: cA.x - fA.x * ra.length, z0: cA.z - fA.z * ra.length, x1: from.x - fA.x * 4, z1: from.z - fA.z * 4, r: 4 },
    { x0: cB.x - fB.x * rb.length, z0: cB.z - fB.z * rb.length, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
  ];
  const cs = new CorridorSearch(g, from, to, { kind: 'rail', owner, avoid });
  const path = cs.run();
  if (!path) { log('  double: no corridor'); return fail; }
  const al = alignCorridor(path, from, to);
  const way = [...al.way, { x: cB.x, z: cB.z, tx: -fB.x, tz: -fB.z }];
  const exclude = new Set<number>([...ra.edges, ...rb.edges]);
  const prof = chainProfile(g, [{ x: cA.x, z: cA.z, tx: fA.x, tz: fA.z }, ...way], 2, ra.y, rb.y, 'rail', exclude);
  if (!prof) { log('  double: profile infeasible'); return fail; }
  const e0 = net.nextEdge;
  log(`  double: first new edge #${e0}, profile crossings ${prof.crossings.map((c) => c.mode + '#' + c.edge).join(',')}`);
  if (routeConflict(g, prof, 'rail', 2, exclude)) { log('  double: route conflicts with other edges or itself'); return fail; }
  const res = buildChain(g, frontsA[0], way, railOpts(owner, 2), frontsB[0], prof, (s) => log('   ' + s));
  log(`  double chain: ok=${res.ok} ${res.error ?? ''} edges=${res.edges} len=${fmt(res.built)} bridges=${res.bridges} tunnels=${res.tunnels}`);
  if (!res.ok) return fail;
  {
    // how far does each platform get (no signals yet)?
    for (const eid of ra.edges) {
      const e = net.edges.get(eid)!;
      for (const dir of [1, -1]) {
        const seen = new Set<number>(); let frontier = [{ e, dir }]; let reachedB = false, steps = 0, lastNode = -1;
        while (frontier.length && steps++ < 400) {
          const nx: { e: typeof e; dir: number }[] = [];
          for (const f of frontier) for (const c of net.nextRail(f.e, f.dir)) {
            if (seen.has(c.edge.id * 2 + (c.dir > 0 ? 1 : 0))) continue;
            seen.add(c.edge.id * 2 + (c.dir > 0 ? 1 : 0));
            if (c.edge.station === B.id) reachedB = true;
            lastNode = c.node.id;
            nx.push({ e: c.edge, dir: c.dir });
          }
          frontier = nx;
        }
        if (seen.size > 2) log(`  double: from platform ${eid} dir ${dir}: ${seen.size} edge-dirs, reached B ${reachedB}, last node ${lastNode}`);
      }
    }
  }
  // which main track is on the right when travelling A->B ("out")?
  const edges = newRailEdges(g, e0, owner);
  const right = (x: number, z: number, px: number, pz: number, tx: number, tz: number) => (x - px) * -tz + (z - pz) * tx > 0;
  // tracks near a point: the two parallel edges closest to it
  const tracksAt = (x: number, z: number, tx: number, tz: number) => {
    const near = edges.map((id) => ({ id, ne: net.nearestEdge(x, z, 1.5, 'rail', (e) => e.id === id) })).filter((q) => q.ne).sort((p, q) => p.ne!.d - q.ne!.d).slice(0, 2);
    if (near.length < 2) return null;
    const pts = near.map((q) => { const p = { x: 0, y: 0, z: 0 }; net.pointAt(q.ne!.edge, q.ne!.s, p); return { id: q.id, x: p.x, z: p.z }; });
    const r0 = right(pts[0].x, pts[0].z, x, z, tx, tz);
    return r0 ? { out: pts[0], in: pts[1] } : { out: pts[1], in: pts[0] };
  };
  let crossovers = 0;
  // crossovers on the straight leads (single edges per track): near A "in" -> "out" moving towards B,
  // near B "out" -> "in" moving towards A
  for (const [c, f, fromKey, toKey] of [[cA, fA, 'in', 'out'], [cB, fB, 'out', 'in']] as const) {
    let made = false;
    for (const [d1, d2] of [[9, 19], [10, 20], [8, 17]]) {
      const x1 = c.x + f.x * d1, z1 = c.z + f.z * d1, x2 = c.x + f.x * d2, z2 = c.z + f.z * d2;
      const dirAB = c === cA ? { x: f.x, z: f.z } : { x: -f.x, z: -f.z };
      const a1 = tracksAt(x1, z1, dirAB.x, dirAB.z), a2 = tracksAt(x2, z2, dirAB.x, dirAB.z);
      if (!a1 || !a2) continue;
      const s1 = findSnap(g, 'rail', a1[fromKey].x, a1[fromKey].z, 0.3), s2 = findSnap(g, 'rail', a2[toKey].x, a2[toKey].z, 0.3);
      if (s1.kind !== 'edge' || s2.kind !== 'edge') continue;
      if (build(g, s1, s2, railOpts(owner), 'crossover')) { crossovers++; made = true; break; }
    }
    if (!made) log('  double: crossover failed');
  }
  // one-way signals at 1/3 and 2/3 of the line on both tracks
  let signals = 0;
  for (const f of [0.33, 0.66]) {
    const i = Math.floor(prof.x.length * f);
    const x = prof.x[i], z = prof.z[i];
    const j = Math.min(prof.x.length - 1, i + 2);
    const tx = prof.x[j] - x, tz = prof.z[j] - z, tl = Math.hypot(tx, tz) || 1;
    const tr = tracksAt(x, z, tx / tl, tz / tl);
    if (!tr) { log(`  double: no parallel tracks at ${fmt(x)},${fmt(z)}`); continue; }
    for (const key of ['out', 'in'] as const) {
      const p = tr[key];
      const err = toggleSignal(g, p.x, p.z, owner);
      if (err) { log(`  double: signal failed: ${err}`); continue; }
      const n = net.nearestNode(p.x, p.z, 1.0, 'rail', (nn) => nn.signal > 0 && nn.edges.length === 2);
      if (!n) { log(`  double: signal node not found at ${fmt(p.x)},${fmt(p.z)}`); continue; }
      // the edge towards B (out) or towards A (in): the one passing closer to a point further along the route
      const k = Math.max(0, Math.min(prof.x.length - 1, i + (key === 'out' ? 5 : -5)));
      let best = n.edges[0], bd = Infinity;
      for (const eid of n.edges) {
        const ne = net.nearestEdge(prof.x[k], prof.z[k], 3, 'rail', (q) => q.id === eid);
        const dd = ne ? ne.d : Infinity;
        if (dd < bd) { bd = dd; best = eid; }
      }
      n.signal = net.sideAt(net.edges.get(best)!, n.id) > 0 ? 2 : 3;
      // keep the line usable: if the signal cuts a station off, it faces the wrong way
      const routesOk = () => [[A, B], [B, A]].every(([st, o]) => st.rail!.edges.some((eid) => [1, -1].some((dir) => !!findRailRoute(g, railNext(g, net.edges.get(eid)!, dir, owner), o.id, owner, -1))));
      if (!routesOk()) { n.signal = n.signal === 2 ? 3 : 2; if (!routesOk()) { n.signal = 0; continue; } }
      signals++;
    }
  }
  g.onNetworkChanged();
  // every platform must reach the other station
  for (const [st, o] of [[A, B], [B, A]] as [Station, Station][]) for (const eid of st.rail!.edges) {
    const e = net.edges.get(eid)!;
    const ok = [1, -1].some((dir) => !!findRailRoute(g, railNext(g, e, dir, owner), o.id, owner, -1));
    if (!ok) log(`  double: no route from ${st.name} platform ${eid} to ${o.name}`);
  }
  return { ok: true, signals, crossovers, len: res.built };
}
