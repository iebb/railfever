// Country roads between the towns, built at world generation: a minimum spanning tree over the towns
// plus shortcuts where the road network would make a long detour. Routed like the AI's roads (terrain
// A* corridor, curve alignment, grade-limited profile, chained construction). Each road leaves a town
// from the end of an arterial, or from an outer grid street facing the other town, and so joins its
// street grid with a junction; crossing country roads meet at level junctions.
import type { Game } from './game';
import type { Town } from './towns';
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
      else for (const [ax, az] of axes) dirs.push([ax, az], [-ax, -az]);
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
  for (const [i, j] of combos.slice(0, 3)) {
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
    const from: OPoint = { x: xa.x, z: xa.z, tx: xa.tx, tz: xa.tz };
    const to: OPoint = { x: xb.x, z: xb.z, tx: -xb.tx, tz: -xb.tz };
    const ex = new Set<number>([...na.edges, ...nb.edges]);
    const plan = runGen(routeGen(g, from, to, {
      kind: 'road', owner: -1, tracks: 1, y0: na.y, y1: nb.y, avoid, exclude: ex, roadJunctions: true,
      buildingCost: 8, lead: Math.min(8, gap / 4), slopeCost: 2.5, maxExpand: 120000, rmax: 80, rgood: 12, minR: 5, retries: 1,
    }));
    if (typeof plan === 'string') { why = plan; continue; }
    const prof = plan.prof;
    const L = prof.s[prof.s.length - 1];
    if (L > gap * (relaxed ? 2.2 : 1.8) + 25) { why = 'detour too long'; continue; }
    const runs = structureRuns(prof);
    if (runs.water > (relaxed ? MAX_WATER_2 : MAX_WATER)) { why = `water crossing ${runs.water.toFixed(0)} u`; continue; }
    if (runs.tunnel > (relaxed ? MAX_TUNNEL_2 : MAX_TUNNEL)) { why = `tunnel ${runs.tunnel.toFixed(0)} u`; continue; }
    const e0 = net.nextEdge;
    const r = buildChain(g, xa.node, plan.way.slice(1), ROAD_OPTS(), xb.node, prof);
    if (!r.ok) { rollback(g, e0, prof); why = 'construction: ' + (r.error ?? '?'); continue; }
    st.built++; st.edges += r.edges; st.length += r.built; st.bridges += r.bridges; st.tunnels += r.tunnels;
    st.log.push(`${A.name} - ${B.name}: ${r.built.toFixed(0)} u, ${r.edges} edges, ${r.bridges} bridges, ${r.tunnels} tunnels`);
    return r.built + centres;
  }
  st.log.push(`${A.name} - ${B.name}: ${why}${relaxed ? ' (second pass)' : ''}`);
  return null;
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
