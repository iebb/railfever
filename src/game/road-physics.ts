// Pure native road itineraries and free-flow running times. Traffic and departure holds are not capacity.
import type { Game } from './game';
import type { Line } from './lines';
import type { Station } from './stations';
import type { VehicleModel } from './vehicle-types';
import { patternStops } from './patterns';
import { curvePoint } from './network';
import { tramUsable } from './build-ops';
import { closestOnPolyline } from './geom';
import { MAIL_UNIT_T } from './constants';
import { findRoadRoute, makeLaneSeg, makeConn, stopPosOnLane, roadAcceleration, ROAD_BRAKE, type RSeg } from './roadvehicle';

export interface NativeRoadSite {
  x: number; z: number; townId: number; station: Station; road: { x: number; z: number };
}
interface RoadPart { seg: RSeg; from: number; to: number; s: number }
export interface NativeRoadLeg {
  from: number; to: number; length: number;
  /** Native lane/connector slices in driving order; these derived values must not be edited. */
  parts: RoadPart[];
}
export interface NativeRoadItinerary {
  calls: Map<string, number>;
  sites: NativeRoadSite[];
  /** Call occurrences, including separate outward and return visits to an interior station. */
  stops: number[];
  /** Leg i runs from stops[i] to stops[(i + 1) % stops.length]. */
  legs: NativeRoadLeg[];
}
export interface NativeRoadCycle {
  stops: number[];
  /** Directed leg times including 2 s handling at the destination; subtract that handling for ride-only fares. */
  hops: number[];
  cycle: number; length: number;
}
interface Entry { signature: string; route: NativeRoadItinerary | null }
const routes = new WeakMap<Game, WeakMap<Line, Map<string, Entry>>>();

/**
 * The same directed itinerary serves curb workload and running time. Uncommitted/missing/disconnected stops
 * return null: prospective-site callers must use their explicit survey fallback, never add temporary stations.
 * Cache only geometry/access/pattern inputs; time, demand, queues and unrelated terrain do not change a lane.
 */
export function nativeRoadItinerary(g: Game, l: Line, pid?: number, operator = l.owner): NativeRoadItinerary | null {
  if (l.kind !== 'road' && l.kind !== 'tram') return null;
  let lines = routes.get(g);
  if (!lines) { lines = new WeakMap(); routes.set(g, lines); }
  let cache = lines.get(l);
  if (!cache) { cache = new Map(); lines.set(l, cache); }
  const key = `${pid ?? ''}:${operator}`;
  const signature = JSON.stringify([g.networkVersion, g.world.net.version, l.kind, l.loop,
    l.stops, l.patterns?.map(p => [p.id, p.stops, p.ids]),
    [...new Set(l.stops)].map(id => { const st = g.stations.get(id); return st ? [id, st.x, st.z, st.townId, st.stops.map(p => [p.edge, p.s, p.x, p.z])] : [id]; })]);
  const known = cache.get(key);
  if (known?.signature === signature) return known.route;
  const route = buildItinerary(g, l, pid, operator);
  cache.set(key, { signature, route });
  return route;
}

function buildItinerary(g: Game, l: Line, pid: number | undefined, operator: number): NativeRoadItinerary | null {
  // Native pattern alignment repairs metadata. Survey a copy to preserve the live/save state exactly.
  const copy = { ...l, patterns: l.patterns?.map(p => ({ ...p, stops: [...p.stops], ids: p.ids && [...p.ids] })) };
  const ids = patternStops(copy, pid).map(i => l.stops[i]).filter((id, i, a) => i === 0 || id !== a[i - 1]);
  if (ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
  const net = g.world.net, first = g.stations.get(ids[0])?.stops[0];
  let edge = first && net.edges.get(first.edge), dir = 1, at = first?.s ?? 0;
  if (!edge || !first || ids.length < 2) return null;
  const previous = g.stations.get(ids[ids.length - 1]), a = { x: 0, y: 0, z: 0 }, b = { ...a };
  net.pointAt(edge, Math.max(0, at - 0.1), a); net.pointAt(edge, Math.min(edge.len, at + 0.1), b);
  if (previous) dir = (first.x - previous.x) * (b.x - a.x) + (first.z - previous.z) * (b.z - a.z) >= 0 ? 1 : -1;
  const calls = new Map<string, number>(), sites: NativeRoadSite[] = [], stops: number[] = [], legs: NativeRoadLeg[] = [];
  const lanes = new Map<string, RSeg>();
  const laneOf = (id: number, direction: number) => {
    const key = `${id}:${direction}`;
    let lane = lanes.get(key);
    if (!lane) { lane = makeLaneSeg(g, net.edges.get(id)!, direction); lanes.set(key, lane); }
    return lane;
  };
  for (let i = 1; i <= ids.length * 2; i++) {
    const origin = edge, originDir = dir, st = g.stations.get(ids[i % ids.length]);
    if (!st) return null;
    let stop = st.stops.filter(p => p.edge === edge!.id && dir * (p.s - at) > 0.15).sort((a, b) => dir * (a.s - b.s))[0];
    let path: ReturnType<typeof findRoadRoute> = [];
    if (!stop) {
      path = findRoadRoute(g, edge, dir, st.id, 40000, l.kind === 'tram' ? e => tramUsable(g, e, operator) : undefined, g.lines.isLoop(l) ? 600 : 40);
      const arrival = path?.[path.length - 1];
      if (!arrival) return null;
      const next = net.edges.get(arrival.edge);
      if (!next) return null;
      edge = next; dir = arrival.dir;
      stop = st.stops.filter(p => p.edge === edge!.id).sort((a, b) => dir * (a.s - b.s))[0];
    }
    if (!stop) return null;
    at = stop.s;
    if (i <= ids.length) continue; // establish the native cyclic arrival direction before collecting calls
    let lane = laneOf(origin.id, originDir), length = 0;
    const parts: RoadPart[] = [];
    const add = (seg: RSeg, from: number, to: number) => {
      if (from < 0 || to < 0) return false;
      // stopPosOnLane interpolates Float32 cumulative arcs; curve.len is double precision. A berth
      // clamped at a junction may round a few millionths beyond the actual segment endpoint.
      from = Math.min(from, seg.len); to = Math.min(to, seg.len);
      if (to < from - 1e-8) return false;
      if (to > from + 1e-9) { parts.push({ seg, from, to, s: length }); length += to - from; }
      return true;
    };
    const start = stopPosOnLane(g, lane, ids[(i - 1) % ids.length]);
    if (!path?.length) {
      if (!add(lane, start, stopPosOnLane(g, lane, st.id))) return null;
    } else {
      if (!add(lane, start, lane.len)) return null;
      for (let k = 0; k < path.length; k++) {
        const q = path[k], next = laneOf(q.edge, q.dir), last = net.edges.get(lane.e)!;
        const conn = makeConn(lane, next, lane.dir > 0 ? last.b : last.a);
        if (conn) add(conn, 0, conn.len);
        if (!add(next, 0, k === path.length - 1 ? stopPosOnLane(g, next, st.id) : next.len)) return null;
        lane = next;
      }
    }
    if (!parts.length) return null;
    legs.push({ from: ids[(i - 1) % ids.length], to: st.id, parts, length });
    const p = closestOnPolyline(stop.x, stop.z, lane.curve.pts, 3, lane.curve.cum.length);
    const point = { x: 0, y: 0, z: 0 };
    curvePoint(lane.curve, lane.curve.cum[p.i] + (lane.curve.cum[p.i + 1] - lane.curve.cum[p.i]) * p.f, point);
    const berth = `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`;
    calls.set(berth, (calls.get(berth) ?? 0) + 1);
    sites.push({ x: st.x, z: st.z, townId: st.townId, station: st, road: { x: stop.x, z: stop.z } });
    stops.push(st.id);
  }
  // Preserve the curb API's arrival-call order; align directed origin legs with those same calls.
  legs.push(legs.shift()!);
  return { calls, sites, stops, legs };
}

interface Samples { grid: Float64Array; limits: Float64Array }
const samples = new WeakMap<NativeRoadLeg, Samples>();
/** 2.5 m intervals, plus exact segment and slow-zone boundaries (no speed calibration factor). */
function sample(leg: NativeRoadLeg): Samples {
  const known = samples.get(leg);
  if (known) return known;
  const xs = [0, leg.length];
  const step = Math.min(0.25, leg.length / 8);
  for (let s = step; s < leg.length; s += step) xs.push(s);
  for (const p of leg.parts) {
    xs.push(p.s, p.s + p.to - p.from);
    for (const zone of p.seg.slow ?? []) for (const x of [zone[0], zone[1]])
      if (x > p.from && x < p.to) xs.push(p.s + x - p.from);
  }
  xs.sort((a, b) => a - b);
  const grid = Float64Array.from(xs.filter((x, i) => i === 0 || x - xs[i - 1] > 1e-8)), limits = new Float64Array(grid.length);
  let j = 0;
  for (let k = 0; k < grid.length; k++) {
    const s = grid[k];
    while (j + 1 < leg.parts.length && s > leg.parts[j].s + leg.parts[j].to - leg.parts[j].from + 1e-8) j++;
    const p = leg.parts[j], pos = p.from + s - p.s;
    let cap = p.seg.limit;
    for (const q of p.seg.slow ?? []) if (pos >= q[0] - 1e-8 && pos <= q[1] + 1e-8) cap = Math.min(cap, q[2]);
    limits[k] = cap;
  }
  const result = { grid, limits }; samples.set(leg, result); return result;
}

function height(leg: NativeRoadLeg, s: number): number {
  const parts = leg.parts;
  let lo = 0, hi = parts.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (parts[m].s <= s) lo = m; else hi = m - 1; }
  const p = parts[lo], out = { x: 0, y: 0, z: 0 };
  curvePoint(p.seg.curve, Math.max(p.from, Math.min(p.to, p.from + s - p.s)), out);
  return out.y;
}

/** A long vehicle can span more than one very short stop-to-stop leg. */
function heightBehind(route: NativeRoadItinerary, k: number, s: number): number {
  for (let n = 0; s < 0 && n < route.legs.length; n++) {
    k = (k + route.legs.length - 1) % route.legs.length;
    s += route.legs[k].length;
  }
  return height(route.legs[k], s);
}

const cycles = new WeakMap<NativeRoadItinerary, Map<string, NativeRoadCycle>>();
/** Pure half-full, free-flow cycle; traffic/holds are excluded so congestion cannot reward buying more buses. */
export function evaluateNativeRoadCycle(g: Game, l: Line, model: VehicleModel, pid?: number, operator = l.owner): NativeRoadCycle | null {
  const route = nativeRoadItinerary(g, l, pid, operator);
  if (!route || !(model.weight > 0 && model.power > 0 && model.speed > 0 && model.length > 0)) return null;
  let cache = cycles.get(route);
  if (!cache) { cache = new Map(); cycles.set(route, cache); }
  const key = [model.speed, model.power, model.weight, model.capacity, model.length, model.mail ?? 0].join(':');
  const known = cache.get(key);
  if (known) return known;
  const hops: number[] = [], mass = model.weight + model.capacity * 0.5 * 0.075 + (model.mail ?? 0) * 0.5 * MAIL_UNIT_T, cruise = model.speed / 36;
  for (let k = 0; k < route.legs.length; k++) {
    const leg = route.legs[k];
    const { grid, limits } = sample(leg), n = grid.length, envelope = new Float64Array(n);
    for (let i = 0; i < n; i++) envelope[i] = Math.min(cruise, limits[i]) ** 2;
    envelope[n - 1] = 0;
    for (let i = n - 2; i >= 0; i--) envelope[i] = Math.min(envelope[i], envelope[i + 1] + 2 * ROAD_BRAKE * (grid[i + 1] - grid[i]));
    let speed = 0, seconds = 0;
    for (let i = 0; i < n - 1; i++) {
      const s = grid[i], ds = grid[i + 1] - s, back = s - model.length;
      const grade = model.length > 0.1 ? (height(leg, s) - heightBehind(route, k, back)) / model.length : 0;
      const acceleration = Math.max(roadAcceleration(model.power, mass, speed, grade), 0.01);
      const next = Math.sqrt(Math.min(envelope[i + 1], speed * speed + 2 * acceleration * ds));
      seconds += 2 * ds / Math.max(1e-9, speed + next); speed = next;
    }
    hops.push(seconds + 2);
  }
  const result = { stops: [...route.stops], hops, cycle: hops.reduce((a, b) => a + b, 0), length: route.legs.reduce((a, b) => a + b.length, 0) };
  cache.set(key, result);
  return result;
}
