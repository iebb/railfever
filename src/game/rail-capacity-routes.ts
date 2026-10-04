// Capacity/headways need rail routes without importing the AI's road/construction planners.
import type { Game } from './game';
import { findRailRoute, railNext } from './train';

const routes = new WeakMap<Game, { key: string; paths: Map<string, number[] | null> }>();

/** Direct AI policy edits refresh permissions without changing the track's version. */
export function capacityTopologyKey(g: Game): string {
  return `${g.networkVersion}/` + g.companies.map(user => g.companies.reduce((bits, owner) =>
    bits | (g.canUse(user.id, owner.id) ? 1 << owner.id : 0), 0)).join(',');
}

export function capacityRouteBetween(g: Game, a: number, b: number, owner: number): number[] | null {
  const sa = g.stations.get(a), sb = g.stations.get(b), net = g.world.net;
  if (!sa?.rail || !sb?.rail || a === b) return null;
  // Fixed topology routes are reused by resource inventories, bids and departure clocks. Reservations
  // deliberately do not invalidate this cache, so saving/loading cannot change the chosen corridor.
  let memo = routes.get(g);
  const topology = capacityTopologyKey(g);
  if (!memo || memo.key !== topology) { memo = { key: topology, paths: new Map() }; routes.set(g, memo); }
  const key = `${a}:${b}:${owner}`;
  if (memo.paths.has(key)) return memo.paths.get(key)!;
  let best: { ids: number[]; cost: number } | null = null;
  for (const id of sa.rail.edges) {
    const e = net.edges.get(id);
    if (!e) continue;
    for (const direction of [1, -1]) {
      const route = findRailRoute(g, railNext(g, e, direction, owner), b, owner, -1, 15000, false, null, true);
      if (route && (!best || route.cost < best.cost)) best = { ids: route.conts.map(c => c.edge.id), cost: route.cost };
    }
  }
  const result = best?.ids ?? null;
  memo.paths.set(key, result);
  return result;
}
