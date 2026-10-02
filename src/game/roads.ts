// Country roads between the towns, built at world generation: a minimum spanning tree over the towns
// plus shortcuts where the road network would make a long detour. Routed like the AI's roads (terrain
// A* corridor, curve alignment, grade-limited profile, chained construction). Each road leaves a town
// from the end of an arterial, or from an outer grid street facing the other town, and so joins its
// street grid with a junction; crossing country roads meet at level junctions.
import type { Game } from './game';
import type { Town } from './towns';
import type { NNode } from './network';
import { WATER_Y, ROAD_TYPES } from './constants';
import { planEdge, commitProposal, BuildOptions } from './construction';
import { distToRect } from './world';
import { routeGen, runGen, buildChain, removeEdges, nodeSnap, OPoint, ChainProfile } from './routing';

export interface RoadGenStats {
  ms: number;
  /** connections tried / built (spanning tree, shortcuts) / given up */
  attempts: number; built: number; mst: number; extra: number; failed: number;
  edges: number; length: number; bridges: number; tunnels: number;
  log: string[];
}

interface Exit { node: number; x: number; z: number; tx: number; tz: number; score: number }

const ROAD_OPTS = (): BuildOptions => ({ kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing: 'auto', owner: -1, town: true });

/** Longest single bridge over water and longest tunnel a generated country road may have (and the
 * limits of the second pass that reaches towns the first one left unconnected). */
const MAX_WATER = 28, MAX_TUNNEL = 20, MAX_WATER_2 = 45, MAX_TUNNEL_2 = 45;

export function generateIntercityRoads(g: Game, o: { detour?: number; maxExtra?: number } = {}): RoadGenStats {
  const t0 = performance.now();
  const towns = g.towns.list;
  const st: RoadGenStats = { ms: 0, attempts: 0, built: 0, mst: 0, extra: 0, failed: 0, edges: 0, length: 0, bridges: 0, tunnels: 0, log: [] };
  const n = towns.length;
  if (n < 2) return st;
  const size = g.world.size;
  const pairs: { a: number; b: number; d: number }[] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const d = Math.hypot(towns[i].x - towns[j].x, towns[i].z - towns[j].z);
    if (d < size * 0.6) pairs.push({ a: i, b: j, d });
  }
  pairs.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
  const parent = towns.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  // town graph weighted by road length (for the detour test)
  const adj: Map<number, number>[] = towns.map(() => new Map());
  const fails = new Array<number>(n).fill(0);
  const tried = new Set<number>();
  const attempt = (a: number, b: number, d: number, relaxed = false): boolean => {
    tried.add(a * n + b);
    st.attempts++;
    const len = connect(g, towns[a], towns[b], st, relaxed);
    if (len === null) { st.failed++; fails[a]++; fails[b]++; return false; }
    const w = Math.max(d, len);
    adj[a].set(b, Math.min(adj[a].get(b) ?? Infinity, w));
    adj[b].set(a, Math.min(adj[b].get(a) ?? Infinity, w));
    return true;
  };
  // spanning tree (Kruskal): the shortest pairs first; pairs that cannot be routed are skipped
  for (const p of pairs) {
    if (find(p.a) === find(p.b) || fails[p.a] >= 4 || fails[p.b] >= 4) continue;
    if (attempt(p.a, p.b, p.d)) { parent[find(p.a)] = find(p.b); st.mst++; }
  }
  // towns still cut off (hills, lakes): a second pass that accepts longer tunnels and bridges
  const tries2 = new Array<number>(n).fill(0);
  for (const p of pairs) {
    if (find(p.a) === find(p.b) || tries2[p.a] >= 3 || tries2[p.b] >= 3) continue;
    tries2[p.a]++; tries2[p.b]++;
    if (attempt(p.a, p.b, p.d, true)) { parent[find(p.a)] = find(p.b); st.mst++; }
  }
  // shortcuts where the network detour is long (not past a third town: its own roads serve that)
  const detour = o.detour ?? 1.6, maxExtra = o.maxExtra ?? Math.ceil(n * 0.6);
  for (const p of pairs) {
    if (st.extra >= maxExtra) break;
    if (p.d > size * 0.35 || tried.has(p.a * n + p.b) || fails[p.a] >= 4 || fails[p.b] >= 4) continue;
    if (throughTown(towns, p.a, p.b)) continue;
    if (graphDist(adj, p.a, p.b) <= detour * p.d) continue;
    if (attempt(p.a, p.b, p.d)) st.extra++;
  }
  linkIsolated(g, st);
  st.ms = performance.now() - t0;
  return st;
}

/** Does the straight line between two towns pass through another town? */
function throughTown(towns: Town[], a: number, b: number): boolean {
  const A = towns[a], B = towns[b];
  const dx = B.x - A.x, dz = B.z - A.z, l2 = dx * dx + dz * dz || 1;
  return towns.some((t, i) => {
    if (i === a || i === b) return false;
    const f = ((t.x - A.x) * dx + (t.z - A.z) * dz) / l2;
    if (f <= 0.05 || f >= 0.95) return false;
    return Math.hypot(A.x + dx * f - t.x, A.z + dz * f - t.z) < t.radius + 6;
  });
}

/** Shortest road distance between two towns over the towns graph (Infinity if not connected). */
function graphDist(adj: Map<number, number>[], a: number, b: number): number {
  const dist = adj.map(() => Infinity), done = adj.map(() => false);
  dist[a] = 0;
  for (;;) {
    let u = -1;
    for (let i = 0; i < adj.length; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
    if (u < 0) return Infinity;
    if (u === b) return dist[u];
    done[u] = true;
    for (const [v, w] of adj[u]) if (dist[u] + w < dist[v]) dist[v] = dist[u] + w;
  }
}

/**
 * Where a country road can leave a town towards direction u: dead ends of its streets (arterial ends)
 * facing that way, or outer grid nodes with a free grid direction facing that way. Best first.
 */
export function townExits(g: Game, T: Town, ux: number, uz: number): Exit[] {
  const net = g.world.net;
  const a = T.grid?.angle ?? T.angle;
  const axes: [number, number][] = [[Math.sin(a), Math.cos(a)], [Math.cos(a), -Math.sin(a)]];
  const out: Exit[] = [];
  const seen = new Set<number>();
  for (const e of g.towns.streets(T, 6)) {
    if (e.type !== 'street') continue;
    for (const nid of [e.a, e.b]) {
      if (seen.has(nid)) continue;
      seen.add(nid);
      const nd = net.nodes.get(nid);
      if (!nd || nd.edges.length > 3 || g.towns.owner(nd.x, nd.z) !== T) continue;
      const rx = nd.x - T.x, rz = nd.z - T.z;
      const along = rx * ux + rz * uz, lat = Math.abs(rx * uz - rz * ux);
      if (along < -2) continue;
      const dirs: [number, number][] = [];
      if (nd.edges.length === 1) { const ld = net.leaveDir(e, nid); dirs.push([-ld.x, -ld.z]); }
      else {
        for (const [ax, az] of axes) dirs.push([ax, az], [-ax, -az]);
        // warped layouts (organic, radial, hill, linear): straight out from the centre too
        const rl = Math.hypot(rx, rz);
        if (T.grid?.pts && rl > 1) dirs.push([rx / rl, rz / rl]);
      }
      for (const [tx, tz] of dirs) {
        const facing = tx * ux + tz * uz;
        if (facing < (nd.edges.length === 1 ? 0.25 : 0.55)) continue;
        if (nd.edges.some((id) => { const ld = net.leaveDir(net.edges.get(id)!, nid); return ld.x * tx + ld.z * tz > 0.7; })) continue;
        if (!clearAhead(g, nd.x, nd.z, tx, tz)) continue;
        out.push({ node: nid, x: nd.x, z: nd.z, tx, tz, score: along * 0.5 + facing * 30 - lat * 0.4 + (nd.edges.length === 1 ? 10 : 0) });
      }
    }
  }
  return out.sort((p, q) => q.score - p.score || p.node - q.node);
}

/** Free ground ahead of a town exit: no buildings, roads or open water for the first stretch. */
function clearAhead(g: Game, x: number, z: number, tx: number, tz: number): boolean {
  const w = g.world, net = w.net;
  for (let s = 1.2; s <= 10; s += 0.8) {
    const px = x + tx * s, pz = z + tz * s;
    if (!w.inside(px, pz, 6)) return false;
    if (s < 4 && w.heightAt(px, pz) < WATER_Y + 0.1) return false;
    for (const b of w.buildingsNear(px, pz, 3)) if (distToRect(px, pz, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 0.75) return false;
    if (s > 1.6 && net.nearestEdge(px, pz, 0.9)) return false;
  }
  return true;
}

/** Longest contiguous water stretch and tunnel of a profiled route. */
function structureRuns(prof: ChainProfile): { water: number; tunnel: number } {
  let water = 0, tunnel = 0, w0 = -1, t0 = -1;
  const n = prof.s.length;
  for (let i = 0; i <= n; i++) {
    const wet = i < n && prof.terr[i] < WATER_Y + 0.05;
    const deep = i < n && prof.y[i] - prof.terr[i] < -1.9;
    if (wet && w0 < 0) w0 = i;
    if (!wet && w0 >= 0) { water = Math.max(water, prof.s[i - 1] - prof.s[w0]); w0 = -1; }
    if (deep && t0 < 0) t0 = i;
    if (!deep && t0 >= 0) { tunnel = Math.max(tunnel, prof.s[i - 1] - prof.s[t0]); t0 = -1; }
  }
  return { water, tunnel };
}

/** Build a country road between two towns; returns its length (centre to centre) or null. */
function connect(g: Game, A: Town, B: Town, st: RoadGenStats, relaxed = false): number | null {
  const net = g.world.net;
  const d = Math.hypot(B.x - A.x, B.z - A.z) || 1;
  const ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
  const ea = townExits(g, A, ux, uz), eb = townExits(g, B, -ux, -uz);
  if (!ea.length || !eb.length) { st.log.push(`${A.name} - ${B.name}: no way out of ${ea.length ? B.name : A.name}`); return null; }
  const avoid = g.towns.list.filter((t) => t !== A && t !== B).map((t) => ({ x0: t.x, z0: t.z, x1: t.x, z1: t.z, r: t.radius + 4 }));
  // towns that (almost) touch: a straight link between the closest pair of outer street nodes
  const close: { a: Exit; b: Exit; gap: number }[] = [];
  for (const a of ea.slice(0, 6)) for (const b of eb.slice(0, 6)) { const gap = Math.hypot(b.x - a.x, b.z - a.z); if (gap <= 30 && a.node !== b.node) close.push({ a, b, gap }); }
  close.sort((p, q) => p.gap - q.gap || p.a.node - q.a.node || p.b.node - q.b.node);
  for (const c of close.slice(0, 4)) {
    const p = planEdge(g, nodeSnap(g, c.a.node, 'road'), nodeSnap(g, c.b.node, 'road'), { ...ROAD_OPTS(), straight: true });
    if (!p.ok || p.stats.bridges > 1 || p.stats.tunnels || commitProposal(g, p)) continue;
    st.built++; st.edges += p.tracks.length; st.length += p.stats.len; st.bridges += p.stats.bridges;
    st.log.push(`${A.name} - ${B.name}: ${p.stats.len.toFixed(0)} u (towns side by side)`);
    return p.stats.len + Math.hypot(c.a.x - A.x, c.a.z - A.z) + Math.hypot(c.b.x - B.x, c.b.z - B.z);
  }
  // exit pairs, best first, whose height difference a road can climb (with some winding)
  const grade = ROAD_TYPES.road.maxGrade * 0.85;
  const combos: [number, number, number][] = [];
  for (let i = 0; i < Math.min(4, ea.length); i++) for (let j = 0; j < Math.min(4, eb.length); j++) {
    const na = net.nodes.get(ea[i].node)!, nb = net.nodes.get(eb[j].node)!;
    const gap = Math.hypot(eb[j].x - ea[i].x, eb[j].z - ea[i].z);
    if (Math.abs(na.y - nb.y) > grade * gap * 1.4) continue;
    combos.push([i, j, ea[i].score + eb[j].score]);
  }
  combos.sort((p, q) => q[2] - p[2] || p[0] - q[0] || p[1] - q[1]);
  let why = combos.length ? '' : 'height difference too large';
  for (const [i, j] of combos.slice(0, 4)) {
    const xa = ea[i], xb = eb[j];
    const na = net.nodes.get(xa.node), nb = net.nodes.get(xb.node);
    if (!na || !nb) continue;
    const gap = Math.hypot(xb.x - xa.x, xb.z - xa.z);
    const centres = Math.hypot(xa.x - A.x, xa.z - A.z) + Math.hypot(xb.x - B.x, xb.z - B.z);
    if (gap < 18) {
      // neighbouring towns: one direct segment
      const p = planEdge(g, nodeSnap(g, xa.node, 'road'), nodeSnap(g, xb.node, 'road'), ROAD_OPTS());
      if (!p.ok || p.stats.minRadius < 4 || commitProposal(g, p)) { why = 'towns too close for a road'; continue; }
      st.built++; st.edges += p.tracks.length; st.length += p.stats.len; st.bridges += p.stats.bridges; st.tunnels += p.stats.tunnels;
      st.log.push(`${A.name} - ${B.name}: ${p.stats.len.toFixed(0)} u (direct)`);
      return p.stats.len + centres;
    }
    const r = routeRoad(g, xa, { x: xb.x, z: xb.z, tx: -xb.tx, tz: -xb.tz }, xb.node, [A, B], relaxed, st, `${A.name} - ${B.name}`);
    if (typeof r === 'string') { why = r; continue; }
    return r + centres;
  }
  st.log.push(`${A.name} - ${B.name}: ${why}${relaxed ? ' (second pass)' : ''}`);
  return null;
}

type Avoid = { x0: number; z0: number; x1: number; z1: number; r: number };

/**
 * Keep-out circles around the towns a road must not pass through. On crowded maps towns share land, so
 * a circle that would cover one of the road's ends is shrunk to leave it free.
 */
function avoidZones(g: Game, skip: Town[], ends: { x: number; z: number }[]): Avoid[] {
  const out: Avoid[] = [];
  for (const t of g.towns.list) {
    if (skip.includes(t)) continue;
    let r = t.radius + 4;
    for (const p of ends) r = Math.min(r, Math.hypot(p.x - t.x, p.z - t.z) - 6);
    if (r > 4) out.push({ x0: t.x, z0: t.z, x1: t.x, z1: t.z, r });
  }
  return out;
}

/**
 * Route and build a country road from a town exit to an existing node, arriving there heading along
 * `to`. Returns the length built, or why it failed (nothing is left behind then).
 */
function routeRoad(g: Game, xa: Exit, to: OPoint, goal: number, skip: Town[], relaxed: boolean, st: RoadGenStats, label: string): number | string {
  const net = g.world.net;
  const na = net.nodes.get(xa.node), nb = net.nodes.get(goal);
  if (!na || !nb) return 'node gone';
  const gap = Math.hypot(to.x - xa.x, to.z - xa.z);
  const lead = Math.min(8, gap / 4);
  const from: OPoint = { x: xa.x, z: xa.z, tx: xa.tx, tz: xa.tz };
  const ends = [from, to, { x: from.x + from.tx * lead, z: from.z + from.tz * lead }, { x: to.x - to.tx * lead, z: to.z - to.tz * lead }];
  const ex = new Set<number>([...na.edges, ...nb.edges]);
  const plan = runGen(routeGen(g, from, to, {
    kind: 'road', owner: -1, tracks: 1, y0: na.y, y1: nb.y, avoid: avoidZones(g, skip, ends), exclude: ex, roadJunctions: true,
    buildingCost: 8, lead, slopeCost: 2.5, maxExpand: 120000, rmax: 80, rgood: 12, minR: 5, retries: 2,
  }));
  if (typeof plan === 'string') return plan;
  const prof = plan.prof;
  const L = prof.s[prof.s.length - 1];
  if (L > gap * (relaxed ? 2.2 : 1.8) + 25) return 'detour too long';
  const runs = structureRuns(prof);
  if (runs.water > (relaxed ? MAX_WATER_2 : MAX_WATER)) return `water crossing ${runs.water.toFixed(0)} u`;
  if (runs.tunnel > (relaxed ? MAX_TUNNEL_2 : MAX_TUNNEL)) return `tunnel ${runs.tunnel.toFixed(0)} u`;
  const e0 = net.nextEdge;
  const r = buildChain(g, xa.node, plan.way.slice(1), ROAD_OPTS(), goal, prof);
  if (!r.ok) { rollback(g, e0, prof); return 'construction: ' + (r.error ?? '?'); }
  st.built++; st.edges += r.edges; st.length += r.built; st.bridges += r.bridges; st.tunnels += r.tunnels;
  st.log.push(`${label}: ${r.built.toFixed(0)} u, ${r.edges} edges, ${r.bridges} bridges, ${r.tunnels} tunnels`);
  return r.built;
}

/** Connected components of the road network (node id -> component). */
function roadComponents(g: Game): Map<number, number> {
  const net = g.world.net;
  const comp = new Map<number, number>();
  let c = 0;
  for (const n of net.nodes.values()) {
    if (n.kind !== 'road' || comp.has(n.id)) continue;
    const q = [n.id];
    comp.set(n.id, c);
    while (q.length) {
      const id = q.pop()!;
      for (const eid of net.nodes.get(id)!.edges) {
        const e = net.edges.get(eid)!;
        const o = e.a === id ? e.b : e.a;
        if (!comp.has(o)) { comp.set(o, c); q.push(o); }
      }
    }
    c++;
  }
  return comp;
}

/**
 * Last pass: towns (and town districts of a dozen streets or more, e.g. across a river) still cut off
 * from the network the most towns are on get a road to its nearest country road (a T junction) or
 * street end, with the longer bridges and tunnels of the second pass.
 */
function linkIsolated(g: Game, st: RoadGenStats) {
  const net = g.world.net, towns = g.towns.list;
  const comp = roadComponents(g);
  const centre = towns.map((t) => net.nearestNode(t.x, t.z, t.radius + 6, 'road', (n) => n.edges.length > 0));
  const count = new Map<number, number>();
  for (const n of centre) if (n) { const k = comp.get(n.id)!; count.set(k, (count.get(k) ?? 0) + 1); }
  let main = -1, most = 0;
  for (const [k, v] of count) if (v > most || (v === most && k < main)) { most = v; main = k; }
  if (main < 0) return;
  // the pieces: every town's centre component, and other components of its streets with >= 12 edges
  const size = new Map<number, number>();
  for (const e of net.edges.values()) {
    if (e.kind !== 'road' || e.type !== 'street' || e.owner !== -1) continue;
    const a = net.nodes.get(e.a)!;
    const T = g.towns.owner(a.x, a.z);
    if (!T) continue;
    const k = T.id * 100000 + comp.get(e.a)!;
    size.set(k, (size.get(k) ?? 0) + 1);
  }
  const pieces: { T: Town; c: number; n: number }[] = [];
  towns.forEach((T, i) => { if (centre[i]) pieces.push({ T, c: comp.get(centre[i]!.id)!, n: Infinity }); });
  for (const [k, n] of size) {
    const T = towns.find((t) => t.id === Math.floor(k / 100000));
    if (T && n >= 12) pieces.push({ T, c: k % 100000, n });
  }
  pieces.sort((p, q) => q.n - p.n || p.T.id - q.T.id || p.c - q.c);
  const joined = new Set<number>([main]);
  for (const p of pieces) {
    if (joined.has(p.c)) continue;
    if (linkPiece(g, p.T, comp, p.c, joined, st)) joined.add(p.c);
  }
}

/** A road from a cut-off piece of a town to the nearest country road or street end of the joined network. */
function linkPiece(g: Game, T: Town, comp: Map<number, number>, c: number, joined: Set<number>, st: RoadGenStats): boolean {
  const w = g.world, net = w.net;
  // the piece's middle
  let mx = 0, mz = 0, mn = 0;
  for (const n of net.nodes.values()) if (comp.get(n.id) === c && g.towns.owner(n.x, n.z) === T) { mx += n.x; mz += n.z; mn++; }
  if (!mn) return false;
  mx /= mn; mz /= mn;
  const targets: { n: NNode; d: number }[] = [];
  for (const n of net.nodes.values()) {
    if (n.kind !== 'road' || !joined.has(comp.get(n.id) ?? -1) || n.edges.length > 2) continue;
    const es = n.edges.map((id) => net.edges.get(id)!);
    if (es.some((e) => e.owner !== -1 || e.station >= 0 || e.depot >= 0)) continue;
    // middle nodes of country roads, or dead ends of streets
    if (!(n.edges.length === 2 ? es.every((e) => e.type === 'road') : es[0].type === 'street')) continue;
    const h = w.heightAt(n.x, n.z);
    if (h < WATER_Y + 0.2 || Math.abs(n.y - h) > 0.4) continue;
    const d = Math.hypot(n.x - mx, n.z - mz);
    if (d > T.radius + 150) continue;
    targets.push({ n, d });
  }
  targets.sort((p, q) => p.d - q.d || p.n.id - q.n.id);
  const picked: typeof targets = [];
  for (const t of targets) {
    if (picked.length >= 4) break;
    if (picked.some((p) => Math.hypot(p.n.x - t.n.x, p.n.z - t.n.z) < 20)) continue;
    picked.push(t);
  }
  let why = picked.length ? '' : 'no road nearby', tries = 0;
  for (const { n, d } of picked) {
    const ux = (n.x - mx) / (d || 1), uz = (n.z - mz) / (d || 1);
    const exits = townExits(g, T, ux, uz).filter((x) => comp.get(x.node) === c);
    for (const xa of exits.slice(0, 2)) {
      if (tries++ >= 6) break;
      // arrive across a country road, or straight on into a street end
      const ld = net.leaveDir(net.edges.get(n.edges[0])!, n.id);
      let tx = ld.x, tz = ld.z;
      if (n.edges.length === 2) {
        tx = -ld.z; tz = ld.x;
        if (tx * (n.x - xa.x) + tz * (n.z - xa.z) < 0) { tx = -tx; tz = -tz; }
      } else if (tx * (n.x - xa.x) + tz * (n.z - xa.z) <= 0) continue;
      const other = g.towns.owner(n.x, n.z);
      const r = routeRoad(g, xa, { x: n.x, z: n.z, tx, tz }, n.id, other ? [T, other] : [T], true, st, `${T.name} - road network`);
      if (typeof r === 'number') return true;
      why = r;
    }
  }
  st.failed++;
  st.log.push(`${T.name} - road network: ${why} (last pass)`);
  return false;
}

/** Remove the pieces of a failed road (not the split pieces of roads and streets it crossed). */
function rollback(g: Game, e0: number, prof: ChainProfile) {
  const net = g.world.net;
  const ids: number[] = [];
  for (let id = e0; id < net.nextEdge; id++) {
    const e = net.edges.get(id);
    if (!e || e.type !== 'road' || e.owner !== -1) continue;
    const geo = net.geo(e), k = Math.floor(geo.n / 2);
    const mx = geo.pts[k * 3], mz = geo.pts[k * 3 + 2], tx = geo.tan[k * 2], tz = geo.tan[k * 2 + 1];
    let best = Infinity, bi = 0;
    for (let i = 0; i < prof.x.length; i++) { const dd = (prof.x[i] - mx) ** 2 + (prof.z[i] - mz) ** 2; if (dd < best) { best = dd; bi = i; } }
    const i0 = Math.max(0, bi - 1), i1 = Math.min(prof.x.length - 1, bi + 1);
    const px = prof.x[i1] - prof.x[i0], pz = prof.z[i1] - prof.z[i0], pl = Math.hypot(px, pz) || 1;
    if (Math.sqrt(best) < 1.5 && Math.abs((px * tx + pz * tz) / pl) > 0.9) ids.push(id);
  }
  removeEdges(g, ids, -1);
}
