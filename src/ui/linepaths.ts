// Compute the physical route of a line (track/road pieces between its stops) for display.
import type { Game } from '../game/game';
import type { Line } from '../game/lines';
import { findRailRoute } from '../game/train';
import { findRoadRoute } from '../game/roadvehicle';
import type { PathCurve } from '../game/geom';

export interface PathPiece { curve: PathCurve; rev: boolean }

/** Route pieces for each leg of the line (best effort; unreachable legs are skipped). */
export function computeLinePath(g: Game, line: Line): PathPiece[] {
  const w = g.world;
  const out: PathPiece[] = [];
  const n = line.stops.length;
  if (n < 2) return out;
  for (let i = 0; i < n; i++) {
    const from = g.stations.get(line.stops[i]);
    const to = line.stops[(i + 1) % n];
    if (!from || (n === 2 && i === 1)) continue; // a two-stop line runs the same route back
    let best: { segs: { curve: PathCurve; rev: boolean }[]; cost: number } | null = null;
    for (const t of from.tiles) {
      const kind = w.stationKind[t];
      if ((line.kind === 'rail') !== (kind === 1)) continue;
      for (let e = 0; e < 4; e++) {
        // only start from edges that leave the station
        const nb = w.neighbour(t, e);
        if (nb >= 0 && w.station[nb] === from.id && w.stationKind[nb] === kind) continue;
        if (nb < 0) continue;
        // leave the station through edge e: start by entering the neighbour from the opposite side
        const node = { t: nb, e: (e + 2) % 4 };
        if (line.kind === 'rail') {
          if (!(w.railEdges(t) & (1 << e)) || !(w.railEdges(nb) & (1 << node.e))) continue;
          const r = findRailRoute(g, { via: [], node }, to, -1, 8000);
          if (r && (!best || r.cost < best.cost)) best = r;
        } else {
          if (!(w.road[t] & (1 << e)) || !(w.road[nb] & (1 << node.e))) continue;
          const r = findRoadRoute(g, { via: [], node }, to, 8000);
          if (r && (!best || r.cost < best.cost)) best = r;
        }
      }
    }
    if (best) for (const s of best.segs) out.push({ curve: s.curve, rev: s.rev });
  }
  return out;
}
