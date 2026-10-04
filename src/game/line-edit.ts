// Stops added to a line where they belong (the line window while adding stops on the map, linegrow): where the station
// fits (on the line's way between two of its stops, else beyond the nearer end), at the start, at the end, or after a
// chosen stop. A line listed out and back (A, B, C, B: the AI's lines, joined lines) is edited by its path and stays
// out and back. Pure: the caller sets the stops.
import type { Game } from './game';
import type { Line } from './lines';
import { linearStops, outAndBack } from './lines';
import { findRailRoute, railNext } from './train';

/** Where a new stop goes: where it fits, first, last, or after the stop at this index of Line.stops. */
export type StopPlace = 'auto' | 'start' | 'end' | number;

/** Does a rail route from station a's platforms to station b pass station s's platforms? */
function railPasses(g: Game, a: number, b: number, s: number, owner: number): boolean {
  const net = g.world.net, A = g.stations.get(a), S = g.stations.get(s);
  if (!A?.rail || !S?.rail) return false;
  const own = new Set([...S.rail.edges, ...S.rail.throughEdges]);
  for (const eid of A.rail.edges) {
    const e = net.edges.get(eid);
    if (!e) continue;
    for (const d of [1, -1]) {
      const r = findRailRoute(g, railNext(g, e, d, owner), b, owner, -1, 20000);
      if (r && r.conts.some((c) => own.has(c.edge.id))) return true;
    }
  }
  return false;
}

/** Where a station fits into a list of stops (an index to insert before): on the way between two, else the cheaper detour or end. */
function fitIndex(g: Game, l: Line, list: number[], s: number, loop: boolean): number {
  if (list.length < 2) return list.length;
  const at = (id: number) => g.stations.get(id);
  const S = at(s);
  if (!S) return list.length;
  const pairs = loop ? list.length : list.length - 1;
  if (l.kind === 'rail') for (let j = 0; j < pairs; j++) {
    const a = list[j], b = list[(j + 1) % list.length];
    if (a !== b && railPasses(g, a, b, s, l.owner)) return j + 1;
  }
  const d = (a: number, b: number) => { const p = at(a), q = at(b); return p && q ? Math.hypot(p.x - q.x, p.z - q.z) : Infinity; };
  let best = list.length, cost = loop ? Infinity : d(list[list.length - 1], s);
  if (!loop && d(list[0], s) < cost) { cost = d(list[0], s); best = 0; }
  for (let j = 0; j < pairs; j++) {
    const a = list[j], b = list[(j + 1) % list.length], c = d(a, s) + d(s, b) - d(a, b);
    if (c < cost - 1e-9) { cost = c; best = j + 1; }
  }
  return best;
}

/**
 * The line's stops with station `s` added at `place`, and the index of the new stop in them; null where it would follow
 * or precede itself (already the stop there).
 */
export function stopsWithInserted(g: Game, l: Line, s: number, place: StopPlace): { stops: number[]; at: number } | null {
  const path = l.loop !== true && l.stops.length >= 3 ? linearStops(l.stops) : null;
  const list = path ?? [...l.stops];
  const loop = !path && g.lines.isLoop(l);
  let i: number, returning = false;
  if (place === 'start') i = 0;
  else if (place === 'end') i = list.length;
  else if (place === 'auto') i = fitIndex(g, l, list, s, loop);
  else {
    const k = Math.max(0, Math.min(l.stops.length - 1, place));
    // The turning stop and the return occurrences point towards the start, including the final gap back to A.
    returning = !!path && k >= path.length - 1;
    i = path ? returning ? l.stops.length - k : k + 1 : k + 1;
  }
  if (list[i - 1] === s || list[i] === s || (loop && list.length && ((i === 0 && list[list.length - 1] === s) || (i === list.length && list[0] === s)))) return null;
  if (path && path.includes(s)) return null;
  const out = [...list.slice(0, i), s, ...list.slice(i)];
  const stops = path ? outAndBack(out) : out;
  return { stops, at: returning ? stops.length - i : i };
}

/** Change a route while preserving each vehicle's target station and occurrence, including pending departures. */
export function replaceLineStops(g: Game, l: Line, stops: number[]): void {
  const old = l.stops;
  const remap = (index: number) => {
    const station = old[index];
    if (station === undefined) return 0;
    const occurrence = old.slice(0, index).filter((s) => s === station).length;
    const indexes = stops.flatMap((s, i) => s === station ? [i] : []);
    return indexes[Math.min(occurrence, indexes.length - 1)] ?? 0;
  };
  // All operators' vehicles belong to this route, including trains on a canonicalised through service.
  for (const id of l.vehicles) {
    const v = g.vehicles.get(id);
    if (!v) continue;
    v.stopIndex = remap(v.stopIndex);
    if (v.spacing.departureIndex >= 0) v.spacing.departureIndex = remap(v.spacing.departureIndex);
  }
  l.stops = stops;
  delete l.spacing;
  g.lines.rebuild();
  for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged();
}
