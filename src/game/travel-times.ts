// Immutable physical service inputs. No live routing, vehicle position, demand, or game RNG is read.
import type { Game } from './game';
import type { Line } from './lines';
import type { VehicleModel } from './vehicle-types';
import { aeroOf } from './vehicle-types';
import { consistOf, modelsOf, PAX_T, type Consist } from './opcosts';
import { accelCap, brakeRate, railForces, consistRule, ruleAllows, railNext, findRailRoute, makeSeg } from './train';
import { makeLaneSeg, makeConn, findRoadRoute, roadAcceleration, type RSeg } from './roadvehicle';
import { curvePoint, type Curve3, type NEdge } from './network';
import { closestOnPolyline } from './geom';
import { tramUsable } from './build-ops';
import { readServicePatterns, DWELL, isLoopLine } from './patterns';
import { transferWalkTime } from './fares';
import { UNIT_M, TRACK_TYPES, ROAD_TYPES } from './constants';
import { PHYSICAL_POLICY, timeMs, type TravelPolicy } from './travel-policy';
export { timeMs } from './travel-policy';

export type PartId = string;
export interface BoardingPart { id: PartId; stationId: number; kind: 'rail' | 'road'; edge: number; dir: number; stop: number }
export interface PathInterval { lengthM: number; limitKmh: number; grade: number }
export interface PathProfile { revision: string; intervals: readonly PathInterval[]; lengthM: number }
export interface PathConsist extends Consist { railPhysics: { driven: number; accel: number; aero: number } }
export interface PathTime { seconds: number; peakMps: number }
export type TravelWork = 'sample' | 'traction' | 'braking' | 'integrate' | 'route' | 'service';
export class TravelInputsChanged extends Error { constructor() { super('Travel inputs changed during preparation'); } }
function finish<T>(job: Generator<TravelWork, T>): T {
  let next = job.next();
  while (!next.done) next = job.next();
  return next.value;
}
export interface RideOption {
  fromPart: PartId; toPart: PartId; lineId: number; patternId: number;
  boardOccurrence: number; alightOccurrence: number;
  /** One departure event may have adjacent short-turn indices; it still contributes frequency once. */
  boardOccurrences: readonly number[]; alightOccurrences: readonly number[];
  boardDirection: number; alightDirection: number;
  serviceKey: string; vehicleIds: readonly number[];
  /** Departures per physical simulation second; ride includes intermediate dwell, but no wait. */
  frequency: number; rideMs: number; intermediateDwellMs: number; pathRevision: string;
}
export interface Passage { fromPart: PartId; toPart: PartId; walkMs: number }
export interface PhysicalServices {
  policy: typeof PHYSICAL_POLICY; revision: string;
  parts: ReadonlyMap<PartId, BoardingPart>; options: readonly RideOption[]; passages: readonly Passage[];
}

export function pathConsist(models: VehicleModel[]): PathConsist {
  let driven = 0;
  for (const m of models) if (m.power > 0) driven += m.kind === 'emu' ? m.weight * .6 : m.weight;
  let aero = models.length ? aeroOf(models[0]).nose : 0;
  for (const m of models) aero += aeroOf(m).len * m.length;
  return { ...consistOf(models), railPhysics: { driven, accel: accelCap(models), aero } };
}

/** Forward traction pass and backward braking pass, with no stops at ordinary edge boundaries. */
export function estimatePathTime(c: PathConsist, profile: PathProfile, loadPax = c.seats * .5): PathTime | null {
  return finish(estimatePathTimeSteps(c, profile, loadPax));
}
/** Deterministic work units (128 intervals), usable by the future preparation barrier. */
export function* estimatePathTimeSteps(c: PathConsist, profile: PathProfile, loadPax = c.seats * .5): Generator<TravelWork, PathTime | null> {
  if (!(c.power > 0) || !(c.mass > 0) || !(c.vmax > 0) || !profile.intervals.length) return null;
  const intervals: PathInterval[] = [];
  for (const x of profile.intervals) {
    if (!(x.lengthM > 0) || !(x.limitKmh > 0) || !Number.isFinite(x.lengthM + x.limitKmh + x.grade)) return null;
    const n = Math.max(profile.intervals.length === 1 ? 2 : 1, Math.ceil(x.lengthM / 10));
    for (let i = 0; i < n; i++) { intervals.push({ ...x, lengthM: x.lengthM / n }); if (intervals.length % 128 === 0) yield 'sample'; }
  }
  const mass = c.mass + loadPax * PAX_T, kg = mass * 1000;
  const acceleration = (v: number, grade: number) => {
    if (c.road) return roadAcceleration(c.power, mass, v / UNIT_M, grade) * UNIT_M;
    const f = railForces(mass, c.power, c.railPhysics, v);
    return (f.traction - f.resistance - kg * 9.81 * grade) / (kg * 1.06);
  };
  const n = intervals.length, speeds = new Float64Array(n + 1), caps = new Float64Array(n + 1).fill(c.vmax / 3.6);
  for (let i = 0; i < n; i++) {
    const cap = Math.min(c.vmax, intervals[i].limitKmh) / 3.6;
    caps[i] = Math.min(caps[i], cap); caps[i + 1] = Math.min(caps[i + 1], cap);
    if (i % 128 === 127) yield 'sample';
  }
  caps[0] = caps[n] = 0;
  for (let i = 0; i < n; i++) {
    const x = intervals[i], v = speeds[i];
    if (v === 0 && acceleration(0, x.grade) <= 0) return null;
    let a = acceleration(v, x.grade);
    let next = Math.sqrt(Math.max(0, v * v + 2 * a * x.lengthM));
    // Midpoint power/resistance: a long interval must not receive starting traction at cruising speed.
    for (let k = 0; k < 4; k++) {
      a = acceleration((v + Math.min(next, caps[i + 1])) / 2, x.grade);
      next = Math.sqrt(Math.max(0, v * v + 2 * a * x.lengthM));
    }
    speeds[i + 1] = Math.min(caps[i + 1], next);
    if (i % 128 === 127) yield 'traction';
  }
  for (let i = n - 1; i >= 0; i--) {
    const b = c.road ? 3 : brakeRate(Math.max(speeds[i], speeds[i + 1]) / UNIT_M) * UNIT_M;
    speeds[i] = Math.min(speeds[i], Math.sqrt(speeds[i + 1] ** 2 + 2 * b * intervals[i].lengthM));
    if (i % 128 === 0) yield 'braking';
  }
  let seconds = 0, peakMps = 0;
  for (let i = 0; i < n; i++) {
    const sum = speeds[i] + speeds[i + 1];
    if (!(sum > 0)) return null;
    seconds += 2 * intervals[i].lengthM / sum;
    peakMps = Math.max(peakMps, speeds[i], speeds[i + 1]);
    if (i % 128 === 127) yield 'integrate';
  }
  return Number.isFinite(seconds) ? { seconds, peakMps } : null;
}

interface Call { occurrence: number; aliases: number[]; station: number }
interface CallState { part: BoardingPart; dir: number; pos: number }
interface HopProfile { profile: PathProfile; cost: number }
interface Fleet { key: string; owner: number; models: VehicleModel[]; ids: number[]; pattern: number; depot: number }
interface GeometryCache { revision: string; lanes: Map<string, RSeg>; hops: Map<string, PathProfile | null>; estimates: Map<string, Map<PathProfile, HopProfile | null>> }
const geometry = new WeakMap<Game, GeometryCache>();
const published = new WeakMap<Game, PhysicalServices>();

/** Conservative global metric fallback: shortcuts and edits outside an old path also invalidate it. */
function geometryRevision(g: Game): string {
  const net = g.world.net;
  let key = `${PHYSICAL_POLICY}/${net.version}/${g.networkVersion}/`;
  for (const e of net.edges.values()) key += `${e.id},${e.version},${e.type},${e.owner},${e.station},${e.tram},${e.tramOwner},${(e.kind === 'rail' ? TRACK_TYPES[e.type] : ROAD_TYPES[e.type])?.speed};`;
  for (const st of g.stations.map.values()) key += `${st.id}:${JSON.stringify([st.rail, st.stops, st.links])};`;
  return key;
}

function fleets(g: Game, l: Line): Fleet[] {
  const ps = readServicePatterns(l), by = new Map<string, Fleet>();
  for (const id of l.vehicles) {
    const v = g.vehicles.get(id);
    if (!v || !v.carries('pax')) continue;
    let models = modelsOf(v);
    const lead = models.findIndex((m) => m.power > 0);
    if (lead > 0 && lead === models.length - 1) models = [...models].reverse();
    const pattern = ps.find((p) => p.id === v.pattern)?.id ?? ps[0]?.id ?? 0;
    const depot = (v as unknown as { depotId: number }).depotId;
    const key = `${v.owner}/${pattern}/${models.map((m) => m.id).join(',')}/${depot}`;
    let f = by.get(key);
    if (!f) { f = { key, owner: v.owner, models, ids: [], pattern, depot }; by.set(key, f); }
    f.ids.push(id);
  }
  return [...by.values()].sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}

function calls(l: Line, flags: boolean[]): Call[] {
  const out: Call[] = [];
  for (let i = 0; i < l.stops.length; i++) if (flags[i]) {
    const prev = out.at(-1);
    if (prev?.station === l.stops[i]) prev.aliases.push(i);
    else out.push({ occurrence: i, aliases: [i], station: l.stops[i] });
  }
  if (out.length > 1 && out[0].station === out.at(-1)!.station) out[0].aliases.push(...out.pop()!.aliases);
  return out;
}

function lane(g: Game, cache: GeometryCache, edge: NEdge, dir: number): RSeg {
  const key = `${edge.id}/${dir}`;
  let seg = cache.lanes.get(key);
  if (!seg) { seg = makeLaneSeg(g, edge, dir); cache.lanes.set(key, seg); }
  return seg;
}

function callStates(g: Game, l: Line, f: Fleet, station: number, cache: GeometryCache): CallState[] {
  const st = g.stations.get(station), net = g.world.net, states: CallState[] = [];
  if (!st || !g.canUse(f.owner, st.owner)) return states;
  if (l.kind === 'rail') {
    const rule = consistRule(f.models), length = f.models.reduce((a, m) => a + m.length + .1, 0);
    for (const eid of st.rail?.edges ?? []) {
      const e = net.edges.get(eid);
      if (!e || e.kind !== 'rail' || e.station !== station || e.len + 1e-6 < length || !g.canUse(f.owner, e.owner) || !ruleAllows(rule, e)) continue;
      const part: BoardingPart = { id: `r:${station}:${eid}`, stationId: station, kind: 'rail', edge: eid, dir: 0, stop: -1 };
      for (const dir of [1, -1]) states.push({ part, dir, pos: e.len });
    }
  } else {
    st.stops.forEach((p, stop) => {
      const e = net.edges.get(p.edge);
      if (!e || e.kind !== 'road' || e.depot >= 0 || (l.kind === 'tram' && !tramUsable(g, e, f.owner))) return;
      for (const dir of [1, -1]) {
        const seg = lane(g, cache, e, dir), c = seg.curve;
        const r = closestOnPolyline(p.x, p.z, c.pts, 3, c.cum.length);
        const pos = c.cum[r.i] + (c.cum[Math.min(c.cum.length - 1, r.i + 1)] - c.cum[r.i]) * r.f;
        states.push({ part: { id: `d:${station}:${e.id}:${dir}:${stop}`, stationId: station, kind: 'road', edge: e.id, dir, stop }, dir, pos });
      }
    });
  }
  // The runtime calls the first road stop on a lane, rather than passing it for another of this station's stops.
  return states.filter((s) => s.part.kind === 'rail' || !states.some((q) => q.part.edge === s.part.edge && q.dir === s.dir && (q.pos < s.pos || (q.pos === s.pos && q.part.stop < s.part.stop))))
    .sort((a, b) => stateKey(a) < stateKey(b) ? -1 : stateKey(a) > stateKey(b) ? 1 : 0);
}
const stateKey = (s: CallState) => `${s.part.id}/${s.dir}/${s.pos}`;

/** Profile samples respect speed/grade boundaries and are no farther than 10 m apart. */
function* appendCurve(out: PathInterval[], curve: Curve3, start: number, end: number, dir: number, limit: number, slow: RSeg['slow'] = []): Generator<TravelWork, void> {
  const span = end - start;
  if (!(span > 1e-8)) return;
  const breaks = new Set<number>([start, end]);
  const n = Math.max(2, Math.ceil(span * UNIT_M / 10));
  for (let i = 1; i < n; i++) breaks.add(start + span * i / n);
  for (let i = 0; i < curve.cum.length; i++) { const s = curve.cum[i]; if (s > start && s < end) breaks.add(s); if (i % 128 === 127) yield 'sample'; }
  for (const [a, b] of slow ?? []) { if (a > start && a < end) breaks.add(a); if (b > start && b < end) breaks.add(b); }
  const points = [...breaks].sort((a, b) => a - b);
  const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 };
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1], hi = points[i], mid = (lo + hi) / 2;
    curvePoint(curve, lo, a); curvePoint(curve, hi, b);
    let cap = limit;
    for (const [p, q, v] of slow ?? []) if (mid >= p && mid <= q) cap = Math.min(cap, v);
    out.push(Object.freeze({ lengthM: (hi - lo) * UNIT_M, limitKmh: cap * 36, grade: (b.y - a.y) / (hi - lo) * dir }));
    if (i % 128 === 0) yield 'sample';
  }
  if (dir < 0) {
    // Callers pass a reversed rail curve range; reverse only this range's interval order.
    const count = points.length - 1, first = out.length - count;
    const reversed = out.splice(first, count).reverse(); out.push(...reversed);
  }
}

function* hopProfile(g: Game, l: Line, f: Fleet, a: CallState, b: CallState, cache: GeometryCache): Generator<TravelWork, PathProfile | null> {
  const key = `${l.kind}/${isLoopLine(l)}/${f.owner}/${f.models.map((m) => m.id).join(',')}/${stateKey(a)}>${stateKey(b)}`;
  if (cache.hops.has(key)) return cache.hops.get(key)!;
  const net = g.world.net, from = net.edges.get(a.part.edge)!, to = net.edges.get(b.part.edge)!;
  const intervals: PathInterval[] = [];
  if (l.kind === 'rail') {
    const rule = consistRule(f.models);
    const paths: { reverse: boolean; path: NonNullable<ReturnType<typeof findRailRoute>> }[] = [];
    for (const reverse of [false, true]) {
      const dir = reverse ? -a.dir : a.dir;
      const starts = railNext(g, from, dir, f.owner, false, rule, reverse);
      const path = findRailRoute(g, starts, b.part.stationId, f.owner, -1, Infinity, false, rule, { edge: to.id, dir: b.dir });
      yield 'route';
      if (path) paths.push({ reverse, path });
    }
    // The runtime favours forward on loops, and applies a reversing distance allowance otherwise.
    const length = f.models.reduce((n, m) => n + m.length + .1, 0);
    paths.sort((x, y) => (x.path.cost + (x.reverse ? (isLoopLine(l) ? 1e12 : 10 + length * 2) : 0)) - (y.path.cost + (y.reverse ? (isLoopLine(l) ? 1e12 : 10 + length * 2) : 0)));
    const pick = paths[0];
    if (pick) {
      if (pick.reverse) {
        const seg = makeSeg(g, from, -a.dir);
        if (seg.dir > 0) yield* appendCurve(intervals, seg.curve, length, seg.len, 1, seg.limit);
        else yield* appendCurve(intervals, seg.curve, 0, Math.max(0, seg.len - length), -1, seg.limit);
      }
      for (const c of pick.path.conts) {
        const seg = makeSeg(g, c.edge, c.dir);
        yield* appendCurve(intervals, seg.curve, 0, seg.len, seg.dir, seg.limit);
      }
    }
  } else {
    const allow = (e: NEdge) => e.kind === 'road' && (l.kind !== 'tram' || tramUsable(g, e, f.owner));
    const source = lane(g, cache, from, a.dir);
    if (from.id === to.id && a.dir === b.dir && b.pos > a.pos + .15) {
      yield* appendCurve(intervals, source.curve, a.pos, b.pos, 1, source.limit, source.slow);
    } else {
      const route = findRoadRoute(g, from, a.dir, b.part.stationId, Infinity, allow, isLoopLine(l) ? 600 : 40, { edge: to.id, dir: b.dir });
      yield 'route';
      if (route) {
        yield* appendCurve(intervals, source.curve, a.pos, source.len, 1, source.limit, source.slow);
        let prev = source;
        for (let i = 0; i < route.length; i++) {
          const r = route[i], seg = lane(g, cache, net.edges.get(r.edge)!, r.dir);
          const conn = makeConn(prev, seg, prev.dir > 0 ? net.edges.get(prev.e)!.b : net.edges.get(prev.e)!.a);
          if (conn) yield* appendCurve(intervals, conn.curve, 0, conn.len, 1, conn.limit);
          yield* appendCurve(intervals, seg.curve, 0, i === route.length - 1 ? b.pos : seg.len, 1, seg.limit, seg.slow);
          prev = seg;
        }
      }
    }
  }
  const profile = intervals.length ? Object.freeze({ revision: cache.revision, intervals: Object.freeze(intervals), lengthM: intervals.reduce((n, x) => n + x.lengthM, 0) }) : null;
  cache.hops.set(key, profile);
  return profile;
}

/** A closed physical pattern, never an independently selected platform at each consecutive hop. */
function* patternCycle(g: Game, l: Line, f: Fleet, cs: Call[], cache: GeometryCache): Generator<TravelWork, { states: CallState[]; hops: HopProfile[] } | null> {
  const candidates = cs.map((c) => callStates(g, l, f, c.station, cache));
  if (cs.length < 2 || candidates.some((x) => !x.length)) return null;
  const c = pathConsist(f.models), modelKey = f.models.map((m) => m.id).join(',');
  let timings = cache.estimates.get(modelKey);
  if (!timings) { timings = new Map(); cache.estimates.set(modelKey, timings); }
  const hop = function*(a: CallState, b: CallState): Generator<TravelWork, HopProfile | null> {
    const p = yield* hopProfile(g, l, f, a, b, cache);
    if (!p) return null;
    if (!timings.has(p)) { const t = yield* estimatePathTimeSteps(c, p); timings.set(p, t ? { profile: p, cost: t.seconds } : null); }
    return timings.get(p)!;
  };
  let best: { cost: number; key: string; states: CallState[]; hops: HopProfile[] } | null = null;
  for (const start of candidates[0]) {
    const depot = g.depots.get(f.depot), edge = depot && g.world.net.edges.get(depot.edge);
    if (!edge) continue;
    // Initial depot entry may face the other way from the steady cycle's return to its first call.
    const reachable = [1, -1].some((dir) => {
      const goal = { edge: start.part.edge, dir };
      return l.kind === 'rail'
        ? findRailRoute(g, [{ edge, dir: 1 }], start.part.stationId, f.owner, -1, Infinity, false, consistRule(f.models), goal)
        : findRoadRoute(g, edge, 1, start.part.stationId, Infinity, (e) => e.kind === 'road' && (l.kind !== 'tram' || tramUsable(g, e, f.owner)), 40, goal);
    });
    yield 'route';
    if (!reachable) continue;
    let labels = [{ cost: 0, key: stateKey(start), states: [start], hops: [] as HopProfile[] }];
    for (let i = 1; i <= cs.length && labels.length; i++) {
      const next: typeof labels = [];
      for (const b of i === cs.length ? [start] : candidates[i]) {
        let take: typeof labels[number] | null = null;
        for (const prev of labels) {
          const h = yield* hop(prev.states.at(-1)!, b);
          if (!h) continue;
          const cost = prev.cost + h.cost, key = prev.key + '>' + stateKey(b);
          if (!take || cost < take.cost || (cost === take.cost && key < take.key)) take = { cost, key, states: [...prev.states, b], hops: [...prev.hops, h] };
        }
        if (take) next.push(take);
      }
      labels = next;
    }
    const take = labels[0];
    if (take && (!best || take.cost < best.cost || (take.cost === best.cost && take.key < best.key))) best = take;
  }
  return best ? { states: best.states.slice(0, -1), hops: best.hops } : null;
}

/** Lazy, policy-keyed publication; rebuilding a legacy graph never invokes this producer. */
export function physicalServices(g: Game, policy: TravelPolicy = g.travelPolicy): PhysicalServices {
  return finish(preparePhysicalServices(g, policy));
}
/** Private resumable preparation, with atomic publication only against the original input revision. */
export function* preparePhysicalServices(g: Game, policy: TravelPolicy = g.travelPolicy): Generator<TravelWork, PhysicalServices> {
  if (policy !== PHYSICAL_POLICY) throw new Error('Physical services require the shadow policy');
  const netVersion = g.world.net.version, networkVersion = g.networkVersion, lineVersion = g.lines.version;
  const metric = geometryRevision(g);
  let cache = geometry.get(g);
  if (!cache || cache.revision !== metric) { cache = { revision: metric, lanes: new Map(), hops: new Map(), estimates: new Map() }; geometry.set(g, cache); }
  const ls = [...g.lines.map.values()].sort((a, b) => a.id - b.id);
  const fs = ls.map((l) => fleets(g, l));
  const revision = metric + '|' + ls.map((l, i) => JSON.stringify([l.id, l.kind, l.loop, l.stops, readServicePatterns(l), fs[i]])).join('|');
  const hit = published.get(g);
  if (hit?.revision === revision) return hit;
  const parts = new Map<PartId, BoardingPart>(), options: RideOption[] = [], passages: Passage[] = [];
  for (let li = 0; li < ls.length; li++) {
    const l = ls[li], ps = readServicePatterns(l), dwell = timeMs(l.kind === 'rail' ? DWELL.rail : DWELL.road);
    for (const f of fs[li]) {
      const cs = calls(l, ps.find((p) => p.id === f.pattern)!.stops);
      const job = patternCycle(g, l, f, cs, cache);
      let next = job.next();
      while (!next.done) {
        yield next.value;
        if (g.world.net.version !== netVersion || g.networkVersion !== networkVersion || g.lines.version !== lineVersion) throw new TravelInputsChanged();
        next = job.next();
      }
      const cycle = next.value;
      if (!cycle) continue;
      const hops = cycle.hops.map((h) => timeMs(h.cost));
      const cycleMs = hops.reduce((n, x) => n + x + dwell, 0);
      const frequency = f.ids.length * 1000 / cycleMs;
      for (const s of cycle.states) parts.set(s.part.id, Object.freeze(s.part));
      for (let a = 0; a < cs.length; a++) {
        let ride = 0;
        for (let k = 1; k < cs.length; k++) {
          const b = (a + k) % cs.length;
          ride += hops[(a + k - 1) % cs.length] + (k > 1 ? dwell : 0);
          if (cs[a].station === cs[b].station) continue;
          options.push(Object.freeze({
            fromPart: cycle.states[a].part.id, toPart: cycle.states[b].part.id,
            lineId: l.id, patternId: f.pattern, boardOccurrence: cs[a].occurrence, alightOccurrence: cs[b].occurrence,
            boardOccurrences: Object.freeze([...cs[a].aliases]), alightOccurrences: Object.freeze([...cs[b].aliases]),
            boardDirection: cycle.states[a].dir, alightDirection: cycle.states[b].dir,
            serviceKey: f.key, vehicleIds: Object.freeze([...f.ids]), frequency,
            rideMs: ride, intermediateDwellMs: (k - 1) * dwell, pathRevision: revision,
          }));
        }
      }
      yield 'service';
    }
  }
  // Declared links only. Stage 1 will provide measured passages between the parts within a station.
  for (const w of g.stations.walkLinks()) {
    const a = g.stations.get(w.from), b = g.stations.get(w.to);
    if (!a || !b) continue;
    const walkMs = timeMs(transferWalkTime(g.stations.gap(a, b)));
    for (const p of parts.values()) if (p.stationId === w.from) for (const q of parts.values()) if (q.stationId === w.to) passages.push(Object.freeze({ fromPart: p.id, toPart: q.id, walkMs }));
  }
  const out: PhysicalServices = Object.freeze({ policy: PHYSICAL_POLICY, revision, parts, options: Object.freeze(options), passages: Object.freeze(passages) });
  const finalLines = [...g.lines.map.values()].sort((a, b) => a.id - b.id);
  const finalRevision = geometryRevision(g) + '|' + finalLines.map((l) => JSON.stringify([l.id, l.kind, l.loop, l.stops, readServicePatterns(l), fleets(g, l)])).join('|');
  if (finalRevision !== revision) throw new TravelInputsChanged();
  published.set(g, out);
  return out;
}

/** Eviction changes work only; useful for cold-load measurements and future preparation jobs. */
export function clearTravelTimes(g: Game) { published.delete(g); geometry.delete(g); }
