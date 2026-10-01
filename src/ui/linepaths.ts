// Physical route of a line (track / road between consecutive stops) as 3D polylines for display.
import type { Game } from '../game/game';
import type { Line } from '../game/lines';
import { findRailRoute, Cont } from '../game/train';
import { findRoadRoute } from '../game/roadvehicle';

export interface LinePath {
  /** polylines (xyz triples), one per reachable leg */
  curves: Float32Array[];
  /** legs (from, to station ids) without a route */
  broken: [number, number][];
}

/** Append the samples of edge `id` travelled in direction dir (optionally only s in [s0, s1]). */
function pushEdge(g: Game, out: number[], id: number, dir: number, s0 = 0, s1 = Infinity) {
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
  }
}

/** Route polylines for every leg of the line (best effort; unreachable legs are reported). */
export function computeLinePath(g: Game, line: Line): LinePath {
  const res: LinePath = { curves: [], broken: [] };
  const n = line.stops.length;
  if (n < 2) return res;
  for (let i = 0; i < n; i++) {
    const a = g.stations.get(line.stops[i]), bId = line.stops[(i + 1) % n];
    const b = g.stations.get(bId);
    if (!a || !b || a.id === b.id) continue;
    const pts: number[] = [];
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
      for (const c of r.conts) pushEdge(g, pts, c.edge.id, c.dir);
    } else {
      let best: { pts: number[]; cost: number } | null = null;
      for (const stop of a.stops) {
        const e = g.world.net.edges.get(stop.edge);
        if (!e) continue;
        for (const dir of [1, -1]) {
          const r = findRoadRoute(g, e, dir, bId, 30000);
          if (!r) continue;
          const p: number[] = [];
          if (dir > 0) pushEdge(g, p, e.id, 1, stop.s); else pushEdge(g, p, e.id, -1, 0, stop.s);
          let cost = dir > 0 ? e.len - stop.s : stop.s;
          r.forEach((c, k) => {
            const ce = g.world.net.edges.get(c.edge);
            if (!ce) return;
            const last = k === r.length - 1;
            const tgt = last ? b.stops.find((q) => q.edge === c.edge) : undefined;
            if (tgt) { if (c.dir > 0) pushEdge(g, p, c.edge, 1, 0, tgt.s); else pushEdge(g, p, c.edge, -1, tgt.s); cost += c.dir > 0 ? tgt.s : ce.len - tgt.s; }
            else { pushEdge(g, p, c.edge, c.dir); cost += ce.len; }
          });
          if (!best || cost < best.cost) best = { pts: p, cost };
        }
      }
      if (!best) { res.broken.push([a.id, bId]); continue; }
      pts.push(...best.pts);
    }
    if (pts.length >= 6) res.curves.push(Float32Array.from(pts));
  }
  return res;
}
