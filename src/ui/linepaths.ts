// Physical route of a line (track / road between consecutive stops) as 3D polylines for display.
import type { Game } from '../game/game';
import type { Line } from '../game/lines';
import { findRailRoute, Cont } from '../game/train';
import { findRoadRoute } from '../game/roadvehicle';
import { tramUsable } from '../game/build-ops';

export interface LinePath {
  /** polylines (xyz triples), one per reachable leg */
  curves: Float32Array[];
  /** per polyline vertex: the network edge it lies on, signed by travel direction ((id + 1) * dir) */
  edges: Int32Array[];
  /** legs (from, to station ids) without a route */
  broken: [number, number][];
}

/** Append the samples of edge `id` travelled in direction dir (optionally only s in [s0, s1]); `ids` gets the
 *  signed edge id of every sample. */
function pushEdge(g: Game, out: number[], ids: number[], id: number, dir: number, s0 = 0, s1 = Infinity) {
  const net = g.world.net;
  const e = net.edges.get(id);
  if (!e) return;
  const geo = net.geo(e);
  const n = geo.n;
  for (let k = 0; k < n; k++) {
    const i = dir > 0 ? k : n - 1 - k;
    const s = geo.cum[i];
    if (s < s0 - 1e-6 || s > s1 + 1e-6) continue;
    out.push(geo.pts[i * 3], geo.pts[i * 3 + 1], geo.pts[i * 3 + 2]);
    ids.push((id + 1) * (dir > 0 ? 1 : -1));
  }
}

/** Route polylines for every leg of the line (best effort; unreachable legs are reported). */
export function computeLinePath(g: Game, line: Line): LinePath {
  const res: LinePath = { curves: [], edges: [], broken: [] };
  const n = line.stops.length;
  if (n < 2) return res;
  // legs: round the ring for a loop line; out along the stops and back again otherwise
  const legs: [number, number][] = [];
  if (g.lines.isLoop(line)) for (let i = 0; i < n; i++) legs.push([line.stops[i], line.stops[(i + 1) % n]]);
  else {
    for (let i = 0; i + 1 < n; i++) legs.push([line.stops[i], line.stops[i + 1]]);
    for (let i = n - 1; i > 0; i--) legs.push([line.stops[i], line.stops[i - 1]]);
  }
  const seen = new Set<string>();
  for (const [aId, bId] of legs) {
    if (seen.has(aId + '>' + bId)) continue;
    seen.add(aId + '>' + bId);
    const a = g.stations.get(aId);
    const b = g.stations.get(bId);
    if (!a || !b || a.id === b.id) continue;
    const pts: number[] = [], ids: number[] = [];
    if (line.kind === 'rail') {
      if (!a.rail || !b.rail) { res.broken.push([a.id, bId]); continue; }
      // leave the station on any platform in either direction
      const start: Cont[] = [];
      for (const eid of a.rail.edges) {
        const e = g.world.net.edges.get(eid);
        if (e) start.push({ edge: e, dir: 1 }, { edge: e, dir: -1 });
      }
      const r = start.length ? findRailRoute(g, start, bId, line.owner, -1, 40000) : null;
      if (!r) { res.broken.push([a.id, bId]); continue; }
      for (const c of r.conts) pushEdge(g, pts, ids, c.edge.id, c.dir);
    } else {
      // buses use any road; trams only tram tracks they may use, from and to tram stops
      const tram = line.kind === 'tram';
      const allow = tram ? (e: Parameters<typeof tramUsable>[1]) => tramUsable(g, e, line.owner) : undefined;
      const stopsA = tram ? g.stations.tramStops(a, line.owner) : a.stops;
      const stopsB = tram ? g.stations.tramStops(b, line.owner) : b.stops;
      let best: { pts: number[]; ids: number[]; cost: number } | null = null;
      for (const stop of stopsA) {
        const e = g.world.net.edges.get(stop.edge);
        if (!e) continue;
        for (const dir of [1, -1]) {
          const r = findRoadRoute(g, e, dir, bId, 30000, allow);
          if (!r) continue;
          const p: number[] = [], pi: number[] = [];
          if (dir > 0) pushEdge(g, p, pi, e.id, 1, stop.s); else pushEdge(g, p, pi, e.id, -1, 0, stop.s);
          let cost = dir > 0 ? e.len - stop.s : stop.s;
          r.forEach((c, k) => {
            const ce = g.world.net.edges.get(c.edge);
            if (!ce) return;
            const last = k === r.length - 1;
            const tgt = last ? stopsB.find((q) => q.edge === c.edge) : undefined;
            if (tgt) { if (c.dir > 0) pushEdge(g, p, pi, c.edge, 1, 0, tgt.s); else pushEdge(g, p, pi, c.edge, -1, tgt.s); cost += c.dir > 0 ? tgt.s : ce.len - tgt.s; }
            else { pushEdge(g, p, pi, c.edge, c.dir); cost += ce.len; }
          });
          if (!best || cost < best.cost) best = { pts: p, ids: pi, cost };
        }
      }
      if (!best) { res.broken.push([a.id, bId]); continue; }
      pts.push(...best.pts);
      ids.push(...best.ids);
    }
    if (pts.length >= 6) { res.curves.push(Float32Array.from(pts)); res.edges.push(Int32Array.from(ids)); }
  }
  return res;
}
