// Shared rail departure clocks, saved in the lowest-id line that uses the station approach.
import type { Game } from './game';
import type { Vehicle } from './vehicle';
import type { Line, PatternSpacing } from './lines';
import { nextStopIndex, patternOf, patternStops, patternHeadways } from './patterns';
import { capacityRouteBetween as routeBetween, capacityTopologyKey } from './rail-capacity-routes';
import { railCapacityOptions } from './rail-capacity-options';

interface Approach { key: string; route: string; line: number; frequency: number; vehicles: number }
const memo = new WeakMap<Game, { key: string; approaches: Map<string, Approach[]>; keys: Map<string, string> }>();
const vehicleKey = (l: Line, pid: number, index: number, mail: boolean) => `${l.id}:${pid}:${index}:${+mail}`;

function approaches(g: Game) {
  const rail = [...g.lines.map.values()].filter(l => l.kind === 'rail' && l.evenSpacing !== false).sort((a, b) => a.id - b.id);
  const key = `${capacityTopologyKey(g)}:${g.lines.version}:` + rail.map(l => `${l.id}/${l.vehicles.join(',')}/${l.evenSpacing}`).join(';');
  const hit = memo.get(g); if (hit?.key === key) return hit;
  const by = new Map<string, Approach[]>(), keys = new Map<string, string>();
  for (const l of rail) for (const mail of [false, true]) {
    for (const p of patternHeadways(g, l, mail ? 'mail' : 'pax')) {
      // Mixed vehicles belong to the passenger clock, mail-only vehicles to the mail clock, as on an ordinary line.
      const vs = l.vehicles.map(id => g.vehicles.get(id)).filter(v => v && (patternOf(l, v.pattern)?.id ?? 0) === p.pid && v.mailOnly === mail);
      if (!vs.length) continue;
      for (const i of patternStops(l, p.pid)) {
        const a = l.stops[i], b = l.stops[nextStopIndex(l, p.pid, i)], st = g.stations.get(a);
        if (!st?.rail || a === b) continue;
        const route = routeBetween(g, a, b, l.owner);
        const e = route?.map(id => g.world.net.edges.get(id)).find(e => e && e.station < 0 && e.depot < 0);
        if (!e) continue;
        const q = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len / 2, q);
        const side = (q.x - st.x) * Math.sin(st.rail.angle) + (q.z - st.z) * Math.cos(st.rail.angle) >= 0 ? 1 : -1;
        const k = `${+mail}:${a}:${side}`, entry = { key: k, line: l.id,
          route: `${l.id}/${p.pid}/${l.stops.join(',')}/${patternStops(l, p.pid).join(',')}`, frequency: vs.length / p.cycle, vehicles: vs.length };
        // A short turn may have two indices at the same platform/direction; its frequency is counted once.
        const list = by.get(k) ?? [];
        if (!list.some(x => x.route === entry.route)) list.push(entry);
        by.set(k, list); keys.set(vehicleKey(l, p.pid, i, mail), k);
      }
    }
  }
  const value = { key, approaches: by, keys }; memo.set(g, value); return value;
}

/** Separate lines/patterns on one approach share a combined headway; an ordinary pattern keeps its old rules. */
export function sharedRailSpacing(g: Game, v: Vehicle, index = v.stopIndex): { clock: PatternSpacing; headway: number; vehicles: number; key: string } | null {
  const l = v.line;
  if (!railCapacityOptions.enabled || !l || l.kind !== 'rail' || l.evenSpacing === false) return null;
  const inv = approaches(g), pid = patternOf(l, v.pattern)?.id ?? 0;
  const key = inv.keys.get(vehicleKey(l, pid, index, v.mailOnly)), list = key ? inv.approaches.get(key) : undefined;
  if (!key || !list || list.length < 2) return null;
  const lead = g.lines.map.get(Math.min(...list.map(x => x.line)))!;
  const route = list.map(x => x.route).sort().join(';'), clockKey = 'corridor:' + key;
  const clocks = lead.spacing ??= {};
  let clock = clocks[clockKey];
  if (!clock || clock.route !== route) clock = clocks[clockKey] = { route, departures: {} };
  return { clock, headway: 1 / list.reduce((n, x) => n + x.frequency, 0), vehicles: list.reduce((n, x) => n + x.vehicles, 0), key };
}
