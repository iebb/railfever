// Scheduled directional queue capture for isolated, complete native out-and-back rail services.
// Unsupported layouts retain the original forecast; no live queues, arrivals or positions are inputs.
import type { Game } from './game';
import type { Line } from './lines';
import type { VehicleModel } from './vehicle-types';
import { Train } from './train';
import { WALK_TRIP_INTENSITY } from './constants';
import { YEAR_S } from './opcosts';
import { lineRoute, lineTable, boarding, isLoopLine } from './patterns';

export interface NativeQueueTimetable {
  line: number; pattern: number; path: readonly number[];
  /** Existing native calling layout, quoted passenger fleet, and the entire effective round trip. */
  baseCycle: number; fleet: number; effectiveCycle: number; headway: number; kmh: number;
  calls: { station: number; offset: number; alights: readonly number[] }[];
  /** Static fully-cleared proof: every origin footprint fits together in the unchanged consist. */
  footprints?: readonly number[]; seats?: number;
  /** Semantic signature: disposable cache warmup/version changes do not alter supported forecasts. */
  key: string;
}

/** Every native alight must occur before the next terminus; the two interior calls partition ALL destinations. */
export function directedMasks(stops: readonly number[], turn: number, calls: NativeQueueTimetable['calls']): boolean {
  if (turn <= 0 || calls.length !== stops.length) return false;
  const path = stops.slice(0, turn + 1);
  for (let i = 0; i < stops.length; i++) {
    const end = i < turn ? turn : stops.length;
    const ahead = new Set(Array.from({ length: end - i }, (_, j) => stops[(i + j + 1) % stops.length]));
    const c = calls[i];
    if (c.station !== stops[i] || c.alights.length !== ahead.size || c.alights.some(id => !ahead.has(id))) return false;
  }
  return path.every(station => {
    const here = calls.filter(c => c.station === station), seen = here.flatMap(c => [...c.alights]);
    return here.length === (station === path[0] || station === path[path.length - 1] ? 1 : 2)
      && seen.length === path.length - 1 && new Set(seen).size === seen.length
      && path.every(id => id === station || seen.includes(id));
  });
}
export function nativeQueueFootprint(g: Game, id: number, population?: number): number {
  const st = g.stations.get(id); if (!st?.rail) return -1;
  const r = st.rail, surface = st.stops.length, legacy = 600 + r.tracks * r.length * 12 + surface * 150;
  return Math.max(0, Math.floor(Math.min(legacy, 300,
    12 + (population ?? st.catchPop) * .035 * WALK_TRIP_INTENSITY + r.tracks * r.length * .75 + surface * 4)));
}

interface Layout { pattern: number; path: number[]; cycle: number; calls: NativeQueueTimetable['calls'] }
const layouts = new WeakMap<Game, WeakMap<Line, { key: string; layout: Layout | null }>>();
export const stockKey = (cars: readonly VehicleModel[]) => cars.map(m =>
  `${m.id}/${m.kind}/${m.capacity}/${m.speed}/${m.power}/${m.weight}/${m.length}/${m.mail}/${m.traction}/${m.unitCars}/${m.tracks?.join(',')}`).join(';');
/** Native hop offsets are uniformly stretched to the quoted effective cycle. This scheduled phase estimate
 * intentionally does not calibrate against observed arrivals, queues or congestion. */
export function nativeQueueTimetable(g: Game, l: Line, fleet: number, headway: number,
  quotedCars?: readonly VehicleModel[], quotedKmh?: number): NativeQueueTimetable | undefined {
  if (!(Number.isInteger(fleet) && fleet > 0 && Number.isFinite(headway) && headway >= 1)) return;
  const stock = l.vehicles.map(id => g.vehicles.get(id));
  if (!stock.length || stock.some(v => !(v instanceof Train))) return;
  const cars = quotedCars ?? (stock[0] as Train).madeUp, identity = stockKey(cars);
  // Reversal swaps an MU's leading model, whose nose resistance can affect native timing. madeUp
  // only normalizes hauled locomotives; heterogeneous MUs are outside this initial phase model.
  if (cars[0]?.kind === 'emu' && cars.some(m => m.id !== cars[0].id)) return;
  // With locomotives at both ends, madeUp also retains movement-dependent order.
  if (cars.length > 1 && cars[0].kind === 'loco' && cars[cars.length - 1].kind === 'loco') return;
  if (stock.some(v => stockKey((v as Train).madeUp) !== identity)) return;
  const kmh = Math.max(20, Math.min(100, ...stock.map(v => v!.maxSpeedKmh * .6)));
  if (quotedKmh !== undefined && Math.abs(quotedKmh - kmh) > 1e-9 * Math.max(1, kmh)) return;
  const route = lineRoute(l);
  if (l.kind !== 'rail' || isLoopLine(l) || route.loop || route.turn <= 0) return;
  // A conservative seat bound: directed cohorts leave before a terminus, so at most one queue per
  // origin is aboard during a half-cycle. Check before surveying every competing service.
  const footprints = route.stations.map(id => nativeQueueFootprint(g, id));
  const seats = cars.reduce((sum, m) => sum + m.capacity, 0);
  if (footprints.some(c => c < 0) || footprints.reduce((a, b) => a + b, 0) > seats) return;
  let cache = layouts.get(g); if (!cache) { cache = new WeakMap(); layouts.set(g, cache); }
  const key = `${g.lines.version}:${g.networkVersion}:${g.stations.walkVersion}:${l.id}:${l.owner}:${l.loop}:${l.stops.join(',')}:`
    + `${l.patterns?.map(p => `${p.id}/${p.ids?.join(',')}/${p.stops.join(',')}`).join(';')}:`
    + stock.map(v => `${v!.id}/${v!.owner}/${v!.pattern}/${v!.mailOnly}/${v!.capacity}/${stockKey((v as Train).madeUp)}`).join('|');
  let entry = cache.get(l);
  if (!entry || entry.key !== key) {
    let layout: Layout | null = null;
    const own = new Set(route.stations), pt = lineTable(g, l).pats;
    const isolated = l.kind === 'rail' && !isLoopLine(l) && !route.loop && route.turn > 0 && own.size === route.stations.length
      && pt.length === 1 && pt[0].flags.every(Boolean)
      && route.stations.every(id => {
        const st = g.stations.get(id);
        return !!st?.rail && st.owner === l.owner && !st.links.length && [...(g.lines.routing.get(id)?.keys() ?? [])].every(to => own.has(to))
          && ![...g.lines.map.values()].some(other => other.id !== l.id && other.stops.includes(id)
            && other.vehicles.some(vid => (g.vehicles.get(vid)?.capacity ?? 0) > 0));
      })
      && l.vehicles.every(id => { const v = g.vehicles.get(id); return !!v && v.owner === l.owner && !v.mailOnly && v.capacity > 0; });
    if (isolated && pt[0].cycle > 0) {
      let offset = 0;
      const calls = l.stops.map((station, index) => {
        const may = boarding(g, l, pt[0].pid, index, station);
        const call = { station, offset, alights: route.stations.filter(may) };
        offset += pt[0].hop[index]; return call;
      });
      if (directedMasks(l.stops, route.turn, calls)) layout = { pattern: pt[0].pid, path: route.stations, cycle: pt[0].cycle, calls };
    }
    entry = { key, layout }; cache.set(l, entry);
  }
  if (!entry.layout) return;
  const effectiveCycle = Math.max(1, headway) * fleet, scale = effectiveCycle / entry.layout.cycle;
  return { line: l.id, pattern: entry.layout.pattern, path: [...entry.layout.path], baseCycle: entry.layout.cycle, fleet, effectiveCycle, headway, kmh, footprints, seats,
    calls: entry.layout.calls.map(c => ({ ...c, alights: [...c.alights], offset: c.offset * scale })),
    key: JSON.stringify([l.id, l.owner, entry.layout.pattern, entry.layout.path, identity, fleet, effectiveCycle,
      entry.layout.cycle, kmh, seats, footprints, entry.layout.calls.map(c => [c.station, c.offset, c.alights])]) };
}

/** Annual riders by OD. Null means unsupported: the caller retains its literal original forecast. */
export function queueCapture(t: NativeQueueTimetable | undefined, station: number, alights: readonly number[],
  annual: readonly number[], capacity: number, periods = 16): number[] | null {
  if (!t) return null;
  if (t.footprints && t.footprints[t.path.indexOf(station)] !== Math.max(0, Math.floor(Math.min(300, capacity)))) return null;
  const year = YEAR_S, H = t.headway, C = Math.max(0, Math.floor(Math.min(300, capacity)));
  const calls = t.calls.filter(c => c.station === station)
    .map(c => ({ at: c.offset % H, alights: c.alights })).sort((a, b) => a.at - b.at);
  if (!calls.length || calls.length > 2 || !(H >= 1)) return null;
  const group = alights.map(id => calls.reduce((mask, c, i) => mask | (c.alights.includes(id) ? 1 << i : 0), 0));
  if (group.some((mask, i) => annual[i] > 0 && (!mask || (calls.length === 2 && mask === 3)))) return null;
  if (!C) return annual.map(() => 0);
  if (calls.length === 1 || !group.some((mask, i) => mask === 1 && annual[i] > 0)
    || !group.some((mask, i) => mask === 2 && annual[i] > 0)) {
    const sum = annual.reduce((n, x) => n + x, 0), factor = Math.min(1, C * year / H / Math.max(Number.MIN_VALUE, sum));
    return factor === 1 ? [...annual] : annual.map(x => x * factor);
  }
  const amounts = [0, 0]; annual.forEach((x, i) => amounts[group[i] === 1 ? 0 : 1] += x);
  const rates = amounts.map(x => x / year), A = rates[0] + rates[1], delta = calls[1].at - calls[0].at;
  // Exact no-overflow peaks, preserving every uncapped OD count without numerical iteration.
  if (Math.max(rates[0] * delta + rates[1] * H, rates[0] * H + rates[1] * (H - delta)) <= C) return [...annual];
  const q = [0, 0], picked = [0, 0];
  const fill = (dt: number) => {
    const free = Math.min(dt, Math.max(0, (C - q[0] - q[1]) / A));
    q[0] += rates[0] * free; q[1] += rates[1] * free;
    if (dt > free) {
      const decay = Math.exp(-A * (dt - free) / C);
      for (let k = 0; k < 2; k++) { const equilibrium = C * rates[k] / A; q[k] = equilibrium + (q[k] - equilibrium) * decay; }
    }
  };
  // Return map contracts by p0*p1<=1/4. Sixteen burn-in periods plus one measurement period
  // bound annual error below 0.00011 people for C<=300, H>=1. This bound assumes two disjoint fully cleared eligibility cohorts only.
  for (let n = 0; n <= periods; n++) {
    fill(delta); picked[1] = q[1]; q[1] = 0;
    fill(H - delta); picked[0] = q[0]; q[0] = 0;
  }
  const factors = picked.map((x, i) => Math.min(1, x / H * year / amounts[i]));
  return annual.map((x, i) => x * factors[group[i] === 1 ? 0 : 1]);
}
