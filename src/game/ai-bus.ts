// Road services of the AI companies (buses and coaches), chosen by what they earn (AGENT.md: incentives, not quotas).
//  - roadForecast: the riders and receipts of a road line through given stops (existing stations or planned street
//    sites), by the passenger generation's own rules (demand.ts weights): residents shared with every served station's
//    walk (Stations' share-out), the regional OD and long-distance demand to the line's other stops and to everything
//    reachable by changing at its stops (rail stations of a stop's complex: feeders), trip factors by the expected
//    journey time, bus fares (fares.ts) with the change rule of the receipts (vehicle.ts: x0.9 for a change of vehicle,
//    none inside one station complex), and the seats the vehicles offer.
//  - more vehicles on an existing route: the forecast at one more vehicle (shorter headway, more seats), calibrated by
//    the line's observed receipts, must repay it; on another company's open line we run it as a partner and pay for the
//    stops we use (track access), so a route short of capacity gets a partner rather than a parallel line;
//  - longer routes: a stop beyond either end or inserted on the way (line-edit.ts), where it reaches residents no stop
//    serves, a rail station (feeder) or a nearby village, priced as the forecast's gain against the stop, the extra
//    vehicles that keep the headway and their running costs;
//  - a busy town bus line becomes a tram line, a busy coach line gives way to a railway, where that pays (below);
//  - new lines (town buses, feeders from rail stations, coaches) are quoted with the same forecast, so a copy of an
//    existing service shares its residents and riders and does not pay, while joining or extending it does: a town bus or
//    coach market the project choice picks is planned then (roadMarket: the best of a new line, a partner on a line
//    serving it and an extension of ours to it), and each project choice weighs one partner and one extension of ours.
// Pure reads apart from the build steps (roadPlanJob), which run as an AI project; caches are derived data of the day.
import type { Game } from './game';
import type { Station } from './stations';
import type { Line, Hop } from './lines';
import type { NEdge } from './network';
import type { VehicleModel } from './vehicle-types';
import type { Town } from './towns';
import type { RoadVehicle } from './roadvehicle';
import { roadDepotReaches } from './roadvehicle';
import { linearStops, outAndBack } from './lines';
import { stopsWithInserted, replaceLineStops } from './line-edit';
import * as Constants from './constants';
import { UNIT_M, LOCAL_SERVED_SHARE, MAINLINE_FEEDER_SHARE } from './constants';
import { TF_TYPICAL, TRIPS_PER_MONTH, localTripMultiplier, stationActive } from './demand';
import { tripFactor, refTime, fareFor, urbanIntensity, transferWalkTime, TRANSFER_FARE_FACTOR, type FareMode } from './fares';
import { walkingCatchment, pointWalkingCatchment, walkClaimShares, walkWeight, type WalkingCatchment } from './catchment';
import { WALK_LINE, TRANSFER_RANGE } from './stations';
import { consistOf, hopEstimate, estimateVehicleYear, YEAR_S } from './opcosts';
import { patternHeadways } from './patterns';
import { addTramTracks, removeTramTracks, roadPath as streetPath } from './build-ops';
import { pickTram, pathPoints, tramDepotGen } from './ai-tram';
import { TRAM } from './constants';

// ============================================================================ forecast

/** Diagnostics (tests, benchmarks): forecasts made and their milliseconds; the monthly fleet checks' share. */
export const busProfile = { forecasts: 0, ms: 0, fleetChecks: 0, fleetMs: 0 };

/**
 * Walking residents make this many trips per resident of the demand model's base rate (feature-detected: a branch that
 * calibrates it, constants.WALK_TRIP_INTENSITY, applies it to walkers in generationPopulation; 1 where it does not).
 */
function walkIntensity(): number {
  const k = Number((Constants as unknown as Record<string, unknown>).WALK_TRIP_INTENSITY);
  return Number.isFinite(k) && k > 0 ? k : 1;
}
/** Stations closer than this (units) share few trips within a region (people walk): demand.ts WALK. */
const WALK = 25;
/** demand.ts localCapture: the local trip rate a station keeps of its residents' OD share (60..100%) by service quality. */
const localCapture = (local: number, localF: number) => local > 0
  ? (0.6 + 0.4 * Math.min(1, local / LOCAL_SERVED_SHARE)) * Math.max(0.6, Math.min(1.6, localF / local)) : 0;
/** Road hops: dwell (patterns.ts DWELL.road) and the detour of a road leg over the straight line (lineTable). */
const ROAD_DWELL = 6, ROAD_DETOUR = 1.3;
/** Share of the seats riders fill on the busiest leg before the rest give up (buses bunch; ends run lighter). */
const SEAT_USE = 0.85;

/** A stop of a road line: an existing station (bus stop, or a rail station's stop) or a planned street site. */
export interface RoadSite {
  x: number; z: number; townId: number;
  /** the station the stop is (or will be part of) */
  station?: Station;
  /** stations a planned stop will be linked to for transfers (Stations.link): its complex */
  links?: number[];
  /** where the vehicles stop on the road (a station's bus stop; default x, z) */
  road?: { x: number; z: number };
}
/** The service a forecast assumes: its vehicles, their seats, the timetable; the demand it is valued on (default all). */
export interface RoadService { model: VehicleModel; vehicles: number; loop: boolean; purpose?: 'city' | 'intercity' | 'all' }
export interface RoadForecast {
  /** passengers boarding a year (direct and changing) */
  riders: number;
  /** their receipts on this line a year */
  revenue: number;
  /** receipts of our other lines from the journeys this line brings them (feeders into our railways) */
  network: number;
  /** riders changing to or from another line at a stop's complex, and their receipts on this line */
  transfers: number; transferRevenue: number;
  /** residents claimed per stop */
  pops: number[];
  /** cycle (s), headway (s), the mean hop driven (units) and the seats a year past each point of the route */
  cycle: number; headway: number; hop: number; seats: number;
  /** passengers who would ride and do not fit */
  unserved: number;
}

/** Time of each hop of the route (s, ride and dwell) and the cycle: lineTable's road estimate for the model. */
export function roadTimetable(g: Game, sites: { x: number; z: number; townId: number }[], model: VehicleModel, loop: boolean): { hops: number[]; cycle: number } {
  const c = consistOf([model]), n = sites.length, hops: number[] = [];
  let cycle = 0;
  const legs = loop ? n : n - 1;
  for (let i = 0; i < legs; i++) {
    const a = sites[i], b = sites[(i + 1) % n];
    const d = Math.hypot(a.x - b.x, a.z - b.z) * ROAD_DETOUR;
    const cap = a.townId >= 0 && a.townId === b.townId ? 50 : 90;
    const t = d > 0.5 ? hopEstimate(c, d * UNIT_M, c.seats * 0.5, Math.min(cap, model.speed)).t + ROAD_DWELL : 0;
    hops.push(t); cycle += t;
  }
  // out and back: the way back takes as long
  if (!loop) cycle *= 2;
  return { hops, cycle };
}

/**
 * The hops as the vehicles drive them (s: the road path at its limits, acceleration, dwell) and the cycle; null when a
 * hop has no road. Receipts and seats follow these (the timetable the passengers plan by is roadTimetable's).
 */
export function roadDriving(g: Game, sites: { x: number; z: number; townId: number; road?: { x: number; z: number } }[], model: VehicleModel, loop: boolean): { hops: number[]; cycle: number; length: number } | null {
  const c = consistOf([model]), n = sites.length, hops: number[] = [];
  let cycle = 0, length = 0;
  const legs = loop ? n : n - 1;
  for (let i = 0; i < legs; i++) {
    const a = sites[i], b = sites[(i + 1) % n];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 0.5) { hops.push(0); continue; }
    const p = roadPath(g, a.road ?? a, b.road ?? b, model.speed, Math.max(60, Math.hypot(a.x - b.x, a.z - b.z) * 5));
    if (!p) return null;
    const cap = Math.max(8, p.length * UNIT_M / Math.max(1, p.seconds) * 3.6);
    const t = hopEstimate(c, Math.max(10, p.length * UNIT_M), c.seats * 0.5, Math.min(cap, model.speed)).t + ROAD_DWELL;
    hops.push(t); cycle += t; length += p.length;
  }
  if (!loop) { cycle *= 2; length *= 2; }
  return { hops, cycle, length };
}

/** A small binary heap of (cost, id) for the road path search. */
class MinHeap {
  private c: number[] = []; private v: number[] = [];
  get size() { return this.c.length; }
  push(cost: number, id: number) {
    const c = this.c, v = this.v; let i = c.length; c.push(cost); v.push(id);
    while (i > 0) { const p = (i - 1) >> 1; if (c[p] <= c[i]) break; [c[p], c[i]] = [c[i], c[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop(): [number, number] {
    const c = this.c, v = this.v, top: [number, number] = [c[0], v[0]], lc = c.pop()!, lv = v.pop()!;
    if (c.length) {
      c[0] = lc; v[0] = lv; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

/**
 * The road a vehicle drives between two stop sites: length (units) and driving time at the roads' limits (s, before
 * acceleration and dwell), by the quickest way over the road network (as the vehicles' router prefers faster roads);
 * null when no road joins them within `maxLen`. Cached for the day (derived from the network).
 */
export function roadPath(g: Game, a: { x: number; z: number }, b: { x: number; z: number }, kmh = 90, maxLen = 1500): { length: number; seconds: number } | null {
  const key = `${a.x.toFixed(2)},${a.z.toFixed(2)}>${b.x.toFixed(2)},${b.z.toFixed(2)}@${kmh}`, cache = reads(g).paths;
  if (cache.has(key)) return cache.get(key)!;
  const net = g.world.net, ok = (e: { kind: string; depot: number }) => e.kind === 'road' && e.depot < 0;
  const ea = net.nearestEdge(a.x, a.z, 4, 'road', ok), eb = net.nearestEdge(b.x, b.z, 4, 'road', ok);
  let out: { length: number; seconds: number } | null = null;
  const speed = (e: { type: string }) => Math.max(8, Math.min(kmh, (Constants.ROAD_TYPES[e.type] ?? Constants.ROAD_TYPES.road).speed)) / 3.6;
  if (ea && eb) {
    if (ea.edge.id === eb.edge.id) { const L = Math.abs(ea.s - eb.s); out = { length: L, seconds: L * UNIT_M / speed(ea.edge) }; }
    else {
      // time-ordered search over nodes; each settled node keeps the length that reached it
      const best = new Map<number, number>(), len = new Map<number, number>(), heap = new MinHeap();
      const va = speed(ea.edge);
      const seed = (node: number, l: number) => { const t = l * UNIT_M / va; if (t < (best.get(node) ?? Infinity)) { best.set(node, t); len.set(node, l); heap.push(t, node); } };
      seed(ea.edge.a, ea.s); seed(ea.edge.b, ea.edge.len - ea.s);
      const goal = new Map<number, number>([[eb.edge.a, eb.s], [eb.edge.b, eb.edge.len - eb.s]]);
      const vb = speed(eb.edge);
      let bestT = Infinity, settled = 0;
      while (heap.size && settled < 6000) {
        const [t, id] = heap.pop();
        if (t > (best.get(id) ?? Infinity) + 1e-9 || t >= bestT) continue;
        settled++;
        const l0 = len.get(id)!;
        if (l0 > maxLen) continue;
        const end = goal.get(id);
        if (end !== undefined) { const tt = t + end * UNIT_M / vb; if (tt < bestT) { bestT = tt; out = { length: l0 + end, seconds: tt }; } }
        for (const eid of net.nodes.get(id)?.edges ?? []) {
          const e = net.edges.get(eid);
          if (!e || !ok(e)) continue;
          const o = e.a === id ? e.b : e.a, nt = t + e.len * UNIT_M / speed(e);
          if (nt < (best.get(o) ?? Infinity) - 1e-9) { best.set(o, nt); len.set(o, l0 + e.len); heap.push(nt, o); }
        }
      }
    }
  }
  cache.set(key, out);
  return out;
}

/** Ride time (s) from stop i to stop j along the route (one way round a loop, the shorter way on a line out and back). */
function rideTime(hops: number[], i: number, j: number, loop: boolean): number {
  if (i === j) return 0;
  const n = loop ? hops.length : hops.length + 1;
  if (loop) { let t = 0; for (let k = i; k !== j; k = (k + 1) % n) t += hops[k]; return t; }
  let t = 0;
  for (let k = Math.min(i, j); k < Math.max(i, j); k++) t += hops[k];
  return t;
}

/** Legs passed riding from i to j (indices into a legLoads array: forward hops, then the reverse ones for out and back). */
function addLoad(loads: number[], hopsN: number, i: number, j: number, loop: boolean, count: number) {
  if (i === j) return;
  if (loop) { const n = hopsN; for (let k = i; k !== j; k = (k + 1) % n) loads[k] += count; return; }
  if (i < j) for (let k = i; k < j; k++) loads[k] += count;
  else for (let k = j; k < i; k++) loads[hopsN + k] += count;
}

interface Claimed { pop: number; walking: Map<number, number>; walk: WalkingCatchment }

/**
 * Residents each site would serve: its walk's buildings shared with every other served station that reaches them (one
 * claim per station complex, by walking distance: Stations' share-out, catchment.ts walkClaimShares).
 */
function claimSites(g: Game, sites: RoadSite[], skip: Set<number>): Claimed[] {
  const D = g.demand, B = g.world.buildings;
  const walks: WalkingCatchment[] = sites.map((s) => s.station && !s.links?.length && s.station.stops.length
    ? walkingCatchment(g, s.station) : pointWalkingCatchment(g, s.x, s.z, 'bus'));
  const groups = sites.map((s, i) => s.station ? g.stations.catchmentGroup(s.station.id)
    : s.links?.length ? g.stations.catchmentGroup(s.links[0]) : -1000 - i);
  const own = new Set(sites.flatMap((s) => s.station ? [s.station.id] : []));
  // other served stations near the sites: their walks claim the same buildings
  const near: { id: number; group: number; walk: WalkingCatchment }[] = [];
  for (const st of g.stations.map.values()) {
    if (own.has(st.id) || skip.has(st.id) || !g.lines.stationServed(st.id) || !stationActive(g, st)) continue;
    if (!sites.some((s) => Math.abs(s.x - st.x) < 45 && Math.abs(s.z - st.z) < 45)) continue;
    near.push({ id: st.id, group: g.stations.catchmentGroup(st.id), walk: walkingCatchment(g, st) });
  }
  const out: Claimed[] = sites.map((_, i) => ({ pop: 0, walking: new Map(), walk: walks[i] }));
  const seen = new Set<number>();
  for (let i = 0; i < sites.length; i++) for (const bid of walks[i].buildings.keys()) {
    if (seen.has(bid)) continue;
    seen.add(bid);
    const b = B.get(bid);
    if (!b || !(b.pop > 0)) continue;
    const claims: { group: number; weight: number; site: number }[] = [];
    for (let j = 0; j < sites.length; j++) { const e = walks[j].buildings.get(bid); if (e) claims.push({ group: groups[j], weight: walkWeight(e.distance), site: j }); }
    for (const o of near) { const e = o.walk.buildings.get(bid); if (e) claims.push({ group: o.group, weight: walkWeight(e.distance), site: -1 }); }
    const shares = walkClaimShares(claims), r = D.regionOf(b);
    if (r < 0) continue;
    claims.forEach((c, k) => {
      if (c.site < 0 || !(shares[k] > 0)) return;
      const p = b.pop * shares[k], o = out[c.site];
      o.pop += p; o.walking.set(r, (o.walking.get(r) ?? 0) + p);
    });
  }
  return out;
}

/**
 * OD (local) and long-distance trip shares from a population's regions to a destination's covered regions. `xc`: the
 * city trips of x (regions of one town: demand.ts DemandSet); the rest of x and all of y are inter-city trips.
 */
function odShares(g: Game, from: Map<number, number>, fromPop: number, to: [number, number][], walk: number): { x: number; xc: number; xb: number; y: number } {
  const D = g.demand, n = D.regions.length, od = D.od, ld = D.ld;
  let x = 0, xc = 0, xb = 0, y = 0;
  if (!(fromPop > 0)) return { x, xc, xb, y };
  for (const [r, pop] of from) for (const [q, cov] of to) {
    if (r >= n || q >= n || !(cov > 0)) continue;
    const s = pop / fromPop, v = s * od[r * n + q] * cov * (r === q ? walk : 1);
    x += v;
    // (xb: the big-city trips to other towns on top of the captured local rate, demand.ts icBoost)
    if (D.sameTown(r, q)) xc += v; else xb += v * D.icBoost(r, q);
    y += s * (ld[r * n + q] ?? 0) * cov / TRIPS_PER_MONTH;
  }
  return { x, xc, xb, y };
}

/** Covered share of each region by a claimed population: [region, coverage]. */
function coverageOf(g: Game, c: Map<number, number>): [number, number][] {
  const R = g.demand.regions;
  return [...c].map(([r, pop]) => [r, Math.min(1, pop / Math.max(1, R[r]?.pop ?? 1))]);
}

/** Is a change from a vehicle arriving at `at` to one boarding at `boarding` free (one station complex: vehicle.ts)? */
function freeChange(g: Game, at: number, boarding: number): boolean { return at >= 0 && boarding >= 0 && g.stations.isSameStationComplex(at, boarding); }

/** The first hop's line runs for `owner` (its vehicles' share of the line), for receipts of our own network. */
function ownShare(g: Game, lineId: number, owner: number): number {
  const l = g.lines.get(lineId);
  if (!l || !l.vehicles.length) return 0;
  let ours = 0;
  for (const id of l.vehicles) if (g.vehicles.get(id)?.owner === owner) ours++;
  return ours / l.vehicles.length;
}

/**
 * Riders a year a line could still seat: its vehicles' seats over the year at SEAT_USE (the timetable's cycle) less the
 * boardings it has (its last month's, a year).
 */
function spareSeats(g: Game, lineId: number): number {
  const l = g.lines.get(lineId);
  if (!l) return 0;
  let seats = 0;
  for (const p of patternHeadways(g, l)) {
    if (!(p.cycle > 0)) continue;
    const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v) => !!v && v.carries('pax'));
    const cap = vs.length ? vs.reduce((a, v) => a + v!.capacity, 0) / vs.length : 0;
    seats += p.vehicles * cap * YEAR_S / p.cycle * SEAT_USE;
  }
  // (both directions: a rider takes a seat one way)
  return Math.max(0, 2 * seats - Math.max(l.passLast, l.passMonth) * 12);
}

/** Mode of a routed journey's first onward line (fares.ts FareMode), as the receipts price it. */
function lineMode(g: Game, lineId: number): FareMode { const l = g.lines.get(lineId); return l?.kind === 'rail' ? 'rail' : l?.kind === 'tram' ? 'tram' : 'bus'; }


/** Per-day derived reads shared by the forecasts of one day (disposable: keyed by everything they depend on). */
interface DayReads { key: string; cover: Map<number, [number, number][]>; regional: Map<number, [number, number][]>; base: Map<number, { local: number; localF: number }>; paths: Map<string, { length: number; seconds: number } | null>; pairs?: Float64Array }
const dayReads = new WeakMap<Game, DayReads>();
function reads(g: Game): DayReads {
  const key = `${g.day}:${g.lines.version}:${g.demand.version}:${g.networkVersion}:${g.world.net.version}:${g.world.lotVersions.version}:${g.stations.map.size}`;
  let r = dayReads.get(g);
  if (!r || r.key !== key) { r = { key, cover: new Map(), regional: new Map(), base: new Map(), paths: new Map() }; dayReads.set(g, r); }
  return r;
}
/** A station's walking coverage of each region (same-town trips) or its regional one with car feeders (cross-town). */
function coverOf(g: Game, st: Station, regional: boolean): [number, number][] {
  const r = reads(g), m = regional ? r.regional : r.cover;
  let c = m.get(st.id);
  if (!c) { c = g.demand.coverage(st, regional); m.set(st.id, c); }
  return c;
}
/** A station's population by region: walking residents (same town) or with its car feeders (regional, from coverage). */
function originOf(g: Game, st: Station): { walking: Map<number, number>; regional: Map<number, number>; regionalPop: number } {
  const D = g.demand, walking = new Map((D.shares.get(st.id) ?? []).map(([r, sh]) => [r, st.catchPop * sh] as [number, number]));
  const regional = new Map<number, number>();
  for (const [r, cov] of coverOf(g, st, true)) regional.set(r, cov * Math.max(1, D.regions[r]?.pop ?? 1));
  let regionalPop = 0;
  for (const v of regional.values()) regionalPop += v;
  return { walking, regional, regionalPop };
}
/** The OD share and service-weighted share of a station's trips to the destinations it reaches today (weights() local). */
function baseLocal(g: Game, st: Station, table: Map<number, Hop>): { local: number; localF: number } {
  const r = reads(g), hit = r.base.get(st.id);
  if (hit) return hit;
  const o = originOf(g, st);
  let local = 0, localF = 0;
  for (const [dest, hop] of table) {
    const ds = g.stations.get(dest);
    if (!ds || !stationActive(g, ds)) continue;
    const same = st.townId >= 0 && st.townId === ds.townId, d = Math.hypot(st.x - ds.x, st.z - ds.z);
    const sh = same ? odShares(g, o.walking, st.catchPop, coverOf(g, ds, false), Math.min(1, d / WALK))
      : odShares(g, o.regional, o.regionalPop, coverOf(g, ds, true), 1);
    if (!(sh.x > 0)) continue;
    const f = tripFactor(Math.max(1, hop.cost), refTime(d, same ? Math.min(urbanIntensity(g, st), urbanIntensity(g, ds)) : 0)) / TF_TYPICAL;
    local += sh.x; localF += sh.x * f;
  }
  const out = { local, localF };
  r.base.set(st.id, out);
  return out;
}

/**
 * Coach riders walk further than town bus riders to a service they know: residents within this distance (units) of a stop
 * of another company's established service between the same two towns keep riding it.
 */
const HOLD = 35;
/** Share of a site's walking residents no other company's service between its town and town `to` holds (HOLD). */
function freeFrom(g: Game, owner: number, site: RoadSite, to: number, walk: WalkingCatchment, replacing: number): number {
  const held: Station[] = [];
  for (const l of g.lines.map.values()) {
    if (l.id === replacing || l.owner === owner || l.kind === 'tram' || l.operators?.includes(owner) || new Set(l.stops).size < 2 || !l.vehicles.length) continue;
    let here = false, there = false;
    for (const id of l.stops) { const t = g.stations.get(id)?.townId; if (t === site.townId) here = true; if (t === to) there = true; }
    if (!here || !there) continue;
    for (const id of l.stops) { const st = g.stations.get(id); if (st && st.townId === site.townId && !held.includes(st)) held.push(st); }
  }
  if (!held.length) return 1;
  let all = 0, free = 0;
  for (const bid of walk.buildings.keys()) {
    const b = g.world.buildings.get(bid);
    if (!b || !(b.pop > 0)) continue;
    all += b.pop;
    if (!held.some((st) => Math.hypot(st.x - b.x, st.z - b.z) <= HOLD)) free += b.pop;
  }
  return all > 0 ? free / all : 1;
}

/**
 * Whether another company's established service between two towns has stops within HOLD of both sites: riders changing
 * onto a line of ours there to ride between those towns have that service already.
 */
function rivalNear(g: Game, owner: number, a: RoadSite, b: RoadSite, replacing: number): boolean {
  for (const l of g.lines.map.values()) {
    if (l.id === replacing || l.owner === owner || l.kind === 'tram' || l.operators?.includes(owner) || !l.vehicles.length) continue;
    let nearA = false, nearB = false;
    for (const id of l.stops) {
      const st = g.stations.get(id);
      if (!st) continue;
      if (Math.hypot(st.x - a.x, st.z - a.z) <= HOLD) nearA = true;
      if (Math.hypot(st.x - b.x, st.z - b.z) <= HOLD) nearB = true;
    }
    if (nearA && nearB) return true;
  }
  return false;
}

/**
 * A coach route (in two towns or more) whose two ends lie near the stops of one line of another company (within HOLD):
 * a near-duplicate of that service. Its riders between the ends keep riding the established line, and the market for the
 * pair is that line's: a company runs vehicles on it as a partner instead (moreValue) rather than opening a copy.
 */
function shadowed(g: Game, owner: number, sites: RoadSite[], replacing: number): boolean {
  if (sites.length < 2) return false;
  const a = sites[0], b = sites[sites.length - 1];
  if (a.townId === b.townId) return false;
  return rivalNear(g, owner, a, b, replacing);
}

/** Trips a month between two towns (both ways), from the regional demand model (as the AI's town demand pairs them). */
function pairTrips(g: Game, a: number, b: number): number {
  const r = reads(g), nt = g.towns.list.length;
  if (a < 0 || b < 0 || a >= nt || b >= nt) return 0;
  if (!r.pairs) {
    const D = g.demand, R = D.regions, n = R.length, P = new Float64Array(nt * nt);
    if (D.od.length === n * n) for (let x = 0; x < n; x++) {
      const ta = R[x].town;
      if (ta < 0 || ta >= nt) continue;
      for (let q = 0; q < n; q++) {
        const tb = R[q].town;
        if (q === x || tb < 0 || tb >= nt || tb === ta) continue;
        // (the inter-city demand set: demand.ts trips)
        const t = D.trips(x, q, 'intercity');
        P[ta * nt + tb] += t; P[tb * nt + ta] += t;
      }
    }
    r.pairs = P;
  }
  return r.pairs[a * nt + b];
}

/**
 * The public-transport market between two towns (their trips a year at a coach's 25% capture: AIController.pairMarket)
 * and the riders other companies' services carry between them now (their last month, shared over the town pairs each
 * serves): the share of the market a service of ours can still win. A second coach line between towns another company
 * serves well takes riders from it rather than adding any.
 */
function pairRoom(g: Game, owner: number, a: number, b: number, replacing: number): number {
  let carried = 0;
  for (const l of g.lines.map.values()) {
    if (l.id === replacing || l.owner === owner || l.operators?.includes(owner) || l.kind === 'tram' || l.stops.length < 2 || !l.vehicles.length) continue;
    const towns = new Set(l.stops.map((id) => g.stations.get(id)?.townId ?? -1).filter((t) => t >= 0));
    if (!towns.has(a) || !towns.has(b)) continue;
    carried += l.passLast * 12 / Math.max(1, towns.size * (towns.size - 1) / 2);
  }
  if (!(carried > 0)) return 1;
  const market = pairTrips(g, a, b) * 0.25 * 12;
  return market > 0 ? Math.max(0, 1 - carried / market) : 0;
}

/**
 * Share of a journey's riders this line carries where another service also connects the two stations (routing's
 * attractive set: the faster one, both when they are about as fast).
 */
function racing(ours: number, theirs: number | undefined): number {
  if (theirs === undefined) return 1;
  return ours <= theirs ? (theirs <= ours * 1.25 ? 0.5 : 1) : ours <= theirs * 1.25 ? 0.5 : 0;
}

/** A trip's count a year: generation x (OD share x trip factor x capture x urban uplift + long distance) (weights()). */
function tripCount(gen: number, x: number, y: number, f: number, k: number, mult: number, feeder: number): number {
  return gen * (x * f * k * mult + y * Math.max(0.3, Math.min(2, f))) * feeder;
}

/**
 * Yearly riders and receipts of a road line through `sites` (in route order) run by `service`, for `owner`. `replacing`:
 * the line being re-quoted (routes over it are left out of the stations' current tables). Generator: steps per stop and
 * per few stations reaching the line.
 */
export function* roadForecast(g: Game, owner: number, sites: RoadSite[], service: RoadService, replacing = -1): Generator<void, RoadForecast> {
  return (yield* roadForecasts(g, owner, sites, service, [service.vehicles], replacing))[0];
}

/** The same forecast for several fleet sizes in one pass (the demand is read once; headways, fares and seats differ). */
export function* roadForecasts(g: Game, owner: number, sites: RoadSite[], service: RoadService, fleets: number[], replacing = -1): Generator<void, RoadForecast[]> {
  const gen = forecastSteps(g, owner, sites, service, fleets.length ? fleets : [service.vehicles], replacing);
  for (;;) {
    const t0 = performance.now(), r = gen.next();
    busProfile.ms += performance.now() - t0;
    if (r.done) { busProfile.forecasts++; return r.value; }
    yield;
  }
}

/** A town bus line's forecast (trips within the town, and the access legs of trips to other towns by rail: feeders). */
export function* busCityForecast(g: Game, owner: number, sites: RoadSite[], service: RoadService, fleets?: number[], replacing = -1): Generator<void, RoadForecast[]> {
  return yield* roadForecasts(g, owner, sites, { ...service, purpose: 'city' }, fleets ?? [service.vehicles], replacing);
}

/** A coach line's forecast (trips between towns). */
export function* coachIntercityForecast(g: Game, owner: number, sites: RoadSite[], service: RoadService, fleets?: number[], replacing = -1): Generator<void, RoadForecast[]> {
  return yield* roadForecasts(g, owner, sites, { ...service, purpose: 'intercity' }, fleets ?? [service.vehicles], replacing);
}

/** The forecast for a line's stops by what it serves: a coach line (stops in two towns or more) or a town line. */
export function* lineForecast(g: Game, owner: number, sites: RoadSite[], service: RoadService, fleets?: number[], replacing = -1): Generator<void, RoadForecast[]> {
  const towns = new Set(sites.map((s) => s.townId));
  return towns.size >= 2 ? yield* coachIntercityForecast(g, owner, sites, service, fleets, replacing) : yield* busCityForecast(g, owner, sites, service, fleets, replacing);
}

function* forecastSteps(g: Game, owner: number, sites: RoadSite[], service: RoadService, fleets: number[], replacing: number): Generator<void, RoadForecast[]> {
  const D = g.demand, K = walkIntensity(), M = fleets.length;
  const n = sites.length, loop = service.loop && n >= 3, purpose = service.purpose ?? 'all';
  if (!D.regions.length) D.rebuild();
  // passengers plan by the timetable's estimate (routing: patterns.ts lineTable); fares and seats follow the road driven
  const tt = roadTimetable(g, sites, service.model, loop), drive = roadDriving(g, sites, service.model, loop);
  const headway = fleets.map((v) => tt.cycle / Math.max(1, v));
  const realCycle = drive?.cycle ?? Infinity, realHeadway = fleets.map((v) => realCycle / Math.max(1, v));
  const results: RoadForecast[] = fleets.map((_, m) => ({ riders: 0, revenue: 0, network: 0, transfers: 0, transferRevenue: 0, pops: sites.map(() => 0),
    cycle: realCycle, headway: realHeadway[m], hop: drive ? drive.length / Math.max(1, loop ? n : 2 * (n - 1)) : 20, seats: 0, unserved: 0 }));
  if (n < 2 || !(tt.cycle > 0) || !drive || !(drive.cycle > 0)) return results;
  const claims = claimSites(g, sites, new Set());
  for (const r of results) r.pops = claims.map((c) => c.pop);
  yield;
  const stationOf = (i: number) => sites[i].station?.id ?? -1;
  const own = new Set(sites.flatMap((s) => s.station ? [s.station.id] : []));
  const mode: FareMode = service.model.kind === 'tram' ? 'tram' : 'bus';
  const centreOf = (a: { x: number; z: number; townId: number }, b: { x: number; z: number; townId: number }) =>
    a.townId >= 0 && a.townId === b.townId ? Math.min(urbanIntensity(g, a), urbanIntensity(g, b)) : 0;
  const skipHop = (hop: Hop) => hop.line === replacing || (hop.lines?.includes(replacing) ?? false);
  // which demand the service is valued on (demand.ts DemandSet, by the towns of a trip's two regions: odShares xc): a town
  // line (busCityForecast) on city trips and, on its legs within one town, the access legs of inter-city trips (riders to
  // and from the town's stations and coach stops: feeders); a coach line (coachIntercityForecast) on inter-city trips.
  // The share of a part's riders counted, by its count's own terms (tripCount).
  const counted = (p: { x: number; xc: number; xb: number; y: number }, f: number, k: number, mult: number, inTown: boolean) => {
    if (purpose === 'all' || (purpose === 'city' && inTown)) return 1;
    const city = p.xc * f * k * mult, all = (p.x + p.xb) * f * k * mult + p.y * Math.max(0.3, Math.min(2, f));
    const share = !(city > 0) || !(all > 0) ? 0 : city >= all ? 1 : city / all;
    return purpose === 'city' ? share : 1 - share;
  };
  const inTown = (a: number, b: number) => sites[a].townId >= 0 && sites[a].townId === sites[b].townId;
  // where each stop's riders can change: the stop's own station and the stations a planned stop will be linked to
  const onward: { at: number; walk: number; table: Map<number, Hop> }[][] = sites.map((s) => {
    const out: { at: number; walk: number; table: Map<number, Hop> }[] = [];
    const add = (id: number, walk: number) => { const t = g.lines.routing.get(id) ?? new Map<number, Hop>(); if (!out.some((o) => o.at === id)) out.push({ at: id, walk, table: t }); };
    if (s.station) add(s.station.id, 0);
    for (const id of s.links ?? []) {
      const st = g.stations.get(id);
      if (st) add(id, transferWalkTime(Math.hypot(st.x - s.x, st.z - s.z) * 0.6, true));
    }
    return out;
  });
  // a change at stop k onto a service boarding at `boarding`: free inside one station complex (vehicle.ts); a planned
  // stop is linked to the stations it changes at
  const freeAt = (k: number, other: number) => stationOf(k) < 0 || g.stations.isSameStationComplex(stationOf(k), other);
  const hopsN = tt.hops.length, loads = fleets.map(() => new Array(loop ? n : 2 * (n - 1)).fill(0));
  const held = new Map<number, number>(), legs = new Map<number, number>();
  // (coach riders near another company's service between two towns keep riding it, and the riders it carries there
  // leave less of the towns' market: the residents of stop i riding to town `to`, also on to other services from there)
  const heldAt = (i: number, to: number) => {
    const s = sites[i];
    if (s.townId < 0 || to < 0 || s.townId === to) return 1;
    const key = i * 4096 + to, known = held.get(key);
    if (known !== undefined) return known;
    const v = freeFrom(g, owner, s, to, claims[i].walk, replacing) * pairRoom(g, owner, s.townId, to, replacing);
    held.set(key, v);
    return v;
  };
  // (riders changing onto the line at stop k to ride to stop j in another town: none where another company's service
  // stops near both, else the towns' market left)
  const legFree = (k: number, j: number) => {
    const a = sites[k], b = sites[j];
    if (a.townId < 0 || b.townId < 0 || a.townId === b.townId) return 1;
    const key = k * 4096 + j, known = legs.get(key);
    if (known !== undefined) return known;
    const v = rivalNear(g, owner, a, b, replacing) ? 0 : pairRoom(g, owner, a.townId, b.townId, replacing);
    legs.set(key, v);
    return v;
  };
  // ride times without the wait (the wait is half the headway of each fleet size)
  const rideOnly = (i: number, j: number) => rideTime(tt.hops, i, j, loop);
  const driveT = (m: number, i: number, j: number) => realHeadway[m] / 2 + rideTime(drive.hops, i, j, loop);
  // receipts our other lines get from the riders this line brings them, by line (capped below by their spare seats)
  const onwardBy = fleets.map(() => new Map<number, { riders: number; revenue: number }>());
  const network = (m: number, hop: Hop | undefined, d: number, count: number, factor: number) => {
    if (!hop || hop.line === WALK_LINE) return;
    const share = ownShare(g, hop.line, owner);
    if (!(share > 0)) return;
    const o = onwardBy[m].get(hop.line) ?? { riders: 0, revenue: 0 };
    o.riders += count; o.revenue += share * fareFor(d, Math.max(1, hop.cost), count, { mode: lineMode(g, hop.line) }) * factor;
    onwardBy[m].set(hop.line, o);
  };
  const ride = (m: number, i: number, j: number, count: number, factor: number, transfer: boolean) => {
    const a = sites[i], b = sites[j], r = results[m];
    r.riders += count;
    addLoad(loads[m], hopsN, i, j, loop, count);
    const fare = fareFor(Math.hypot(a.x - b.x, a.z - b.z), driveT(m, i, j), count, { mode, centre: centreOf(a, b) }) * factor;
    r.revenue += fare;
    if (transfer) { r.transfers += count; r.transferRevenue += fare; }
  };
  const factorOf = (cost: number, d: number, centre: number) => tripFactor(Math.max(1, cost), refTime(d, centre)) / TF_TYPICAL;
  // ------------------------------------------------ the line's own stops: riders to its other stops and onwards
  type Part = { x: number; xc: number; xb: number; y: number; f: number[]; same: boolean; rail: boolean; j: number; to: number; hop?: Hop; at: number; d: number; share: number[] };
  for (let i = 0; i < n; i++) {
    if (i % 3 === 2) yield;
    const s = sites[i], c = claims[i];
    if (!(c.pop > 0)) continue;
    const parts: Part[] = [];
    const localF = fleets.map(() => 0);
    let localX = 0;
    const mine = stationOf(i) >= 0 ? g.lines.routing.get(stationOf(i)) : undefined;
    for (let j = 0; j < n; j++) {
      if (j === i || !(claims[j].pop > 0) || (stationOf(i) >= 0 && stationOf(i) === stationOf(j))) continue;
      const t = sites[j], d = Math.hypot(s.x - t.x, s.z - t.z), same = s.townId >= 0 && s.townId === t.townId;
      const sh = odShares(g, c.walking, c.pop, coverageOf(g, claims[j].walking), Math.min(1, d / WALK));
      if (!(sh.x > 0) && !(sh.y > 0)) continue;
      // (another service between the same two stations takes its share)
      const other = stationOf(j) >= 0 ? mine?.get(stationOf(j)) : undefined, theirs = other && !skipHop(other) ? other.cost : undefined;
      const free = same ? 1 : heldAt(i, t.townId);
      const centre = centreOf(s, t), f: number[] = [], share: number[] = [];
      for (let m = 0; m < M; m++) {
        const cost = headway[m] / 2 + rideOnly(i, j);
        share.push(racing(cost, theirs) * free);
        f.push(factorOf(Math.min(cost, theirs ?? Infinity), d, centre));
        localF[m] += sh.x * f[m];
      }
      localX += sh.x;
      if (share.some((v) => v > 0)) parts.push({ ...sh, f, same, rail: false, j, to: -1, at: -1, d, share });
    }
    // everything reachable by changing at a stop of the line, or straight from this stop without it (competition)
    const best = new Map<number, { cost: number; k: number; hop: Hop; at: number }>();
    for (let k = 0; k < n; k++) {
      const r = k === i ? 0 : headway[0] / 2 + rideOnly(i, k);
      for (const o of onward[k]) for (const [dest, hop] of o.table) {
        if (skipHop(hop) || own.has(dest)) continue;
        const cost = r + o.walk + hop.cost, prev = best.get(dest);
        if (!prev || cost < prev.cost - 1e-9) best.set(dest, { cost, k, hop, at: o.at });
      }
    }
    for (const [dest, b] of best) {
      const ds = g.stations.get(dest);
      if (!ds || !stationActive(g, ds)) continue;
      const same = s.townId >= 0 && s.townId === ds.townId, d = Math.hypot(s.x - ds.x, s.z - ds.z);
      const sh = odShares(g, c.walking, c.pop, coverOf(g, ds, !same), Math.min(1, d / WALK));
      if (!(sh.x > 0) && !(sh.y > 0)) continue;
      const centre = centreOf(s, ds), rest = b.k === i ? b.cost : b.cost - headway[0] / 2;
      const f = fleets.map((_, m) => factorOf(b.k === i ? b.cost : rest + headway[m] / 2, d, centre));
      localX += sh.x;
      for (let m = 0; m < M; m++) localF[m] += sh.x * f[m];
      if (b.k === i) continue;
      const rail = lineMode(g, b.hop.line) === 'rail';
      const keep = heldAt(i, sites[b.k].townId);
      if (!(keep > 0)) continue;
      parts.push({ ...sh, f, same, rail, j: b.k, to: dest, hop: b.hop, at: b.at, d: Math.hypot(sites[b.k].x - ds.x, sites[b.k].z - ds.z), share: fleets.map(() => keep) });
    }
    const gen = c.pop * K * TRIPS_PER_MONTH * 12;
    for (let m = 0; m < M; m++) {
      const kCap = localF[m] > 0 ? localCapture(localX, localF[m]) / localF[m] : 0;
      for (const p of parts) {
        const mult = p.same ? localTripMultiplier(g, s, p.rail ? 'rail' : mode, p.f[m]) : 1;
        const count = tripCount(gen, p.x + p.xb, p.y, p.f[m], kCap, mult, !p.same && p.rail ? 1 + MAINLINE_FEEDER_SHARE : 1) * p.share[m]
          * counted(p, p.f[m], kCap, mult, inTown(i, p.j));
        if (!(count > 0)) continue;
        if (p.to < 0) { ride(m, i, p.j, count, 1, false); continue; }
        const boarding = p.hop!.line === WALK_LINE ? p.hop!.alight : p.at;
        const factor = freeAt(p.j, boarding) ? 1 : TRANSFER_FARE_FACTOR;
        ride(m, i, p.j, count, factor, true);
        network(m, p.hop, p.d, count, factor);
      }
    }
  }
  // ------------------------------------------------ riders from elsewhere changing onto the line at its stops
  const entries = new Map<number, { k: number; walk: number }[]>();
  for (let k = 0; k < n; k++) for (const o of onward[k]) {
    const list = entries.get(o.at) ?? [];
    list.push({ k, walk: o.walk });
    entries.set(o.at, list);
  }
  let work = 0;
  for (const [from, table] of g.lines.routing) {
    if (own.has(from)) continue;
    const st = g.stations.get(from);
    if (!st || !stationActive(g, st) || !(st.catchPop > 0)) continue;
    let reach: { k: number; cost: number; at: number; hop?: Hop }[] | null = null;
    for (const [at, list] of entries) {
      const hop = at === from ? undefined : table.get(at);
      if (at !== from && (!hop || skipHop(hop))) continue;
      for (const e of list) (reach ??= []).push({ k: e.k, cost: (hop?.cost ?? 0) + e.walk, at, hop });
    }
    if (!reach) continue;
    if (++work % 10 === 0) yield;
    const genPop = D.generationPopulation(st), o = originOf(g, st), base = baseLocal(g, st, table);
    let localX = base.local;
    const localF = fleets.map(() => base.localF);
    const parts: { j: number; x: number; xc: number; xb: number; y: number; f: number[]; same: boolean; k: number; at: number; hop?: Hop; rail: boolean; share: number[] }[] = [];
    for (let j = 0; j < n; j++) {
      if (!(claims[j].pop > 0)) continue;
      let bestK: { k: number; cost: number; at: number; hop?: Hop } | null = null;
      for (const r of reach) {
        if (r.k === j) continue;
        const cost = r.cost + headway[0] / 2 + rideOnly(r.k, j);
        if (!bestK || cost < bestK.cost) bestK = { k: r.k, cost, at: r.at, hop: r.hop };
      }
      if (!bestK) continue;
      const t = sites[j], same = st.townId >= 0 && st.townId === t.townId, d = Math.hypot(st.x - t.x, st.z - t.z);
      const rail = !!bestK.hop && lineMode(g, bestK.hop.line) === 'rail';
      // (a station of the line that other services reach already: they take their share)
      const theirs = stationOf(j) >= 0 ? table.get(stationOf(j)) : undefined, other = theirs && !skipHop(theirs) ? theirs.cost : undefined;
      const sh = same ? odShares(g, o.walking, st.catchPop, coverageOf(g, claims[j].walking), Math.min(1, d / WALK))
        : odShares(g, o.regional, o.regionalPop, coverageOf(g, claims[j].walking), 1);
      if (!(sh.x > 0) && !(sh.y > 0)) continue;
      const centre = same ? Math.min(urbanIntensity(g, st), urbanIntensity(g, t)) : 0, rest = bestK.cost - headway[0] / 2;
      const f: number[] = [], share: number[] = [], leg = legFree(bestK.k, j);
      for (let m = 0; m < M; m++) {
        const cost = rest + headway[m] / 2;
        f.push(factorOf(cost, d, centre)); share.push(racing(cost, other) * leg);
        localF[m] += sh.x * f[m];
      }
      localX += sh.x;
      if (share.some((v) => v > 0)) parts.push({ j, ...sh, f, same, k: bestK.k, at: bestK.at, hop: bestK.hop, rail, share });
    }
    if (!parts.length) continue;
    const gen = genPop * TRIPS_PER_MONTH * 12, walkers = genPop > 0 ? Math.min(1, st.catchPop * K / genPop) : 1;
    for (let m = 0; m < M; m++) {
      const kCap = localF[m] > 0 ? localCapture(localX, localF[m]) / localF[m] : 0;
      for (const p of parts) {
        const mult = p.same ? localTripMultiplier(g, st, p.rail ? 'rail' : mode, p.f[m]) * walkers : 1;
        const count = tripCount(gen, p.x + p.xb, p.y, p.f[m], kCap, mult, !p.same && p.rail && st.roadAccess ? 1 + MAINLINE_FEEDER_SHARE : 1) * p.share[m]
          * counted(p, p.f[m], kCap, mult, inTown(p.k, p.j));
        if (!(count > 0)) continue;
        // they arrive at `at` (the stop's station or one linked to it) and change there: free inside one complex; residents
        // of `at` itself walk on without a change
        const factor = !p.hop || freeAt(p.k, p.at) ? 1 : TRANSFER_FARE_FACTOR;
        ride(m, p.k, p.j, count, factor, true);
        network(m, p.hop, Math.hypot(st.x - sites[p.k].x, st.z - sites[p.k].z), count, 1);
      }
    }
  }
  for (let m = 0; m < M; m++) {
    const r = results[m];
    // ------------------------------------------------ our other lines carry what their spare seats take
    for (const [id, o] of onwardBy[m]) r.network += o.revenue * Math.min(1, spareSeats(g, id) / Math.max(1, o.riders));
    // ------------------------------------------------ seats: riders beyond the busiest leg's capacity give up
    r.seats = YEAR_S / Math.max(1, realCycle) * fleets[m] * service.model.capacity * SEAT_USE;
    const maxLoad = Math.max(0, ...loads[m]);
    if (maxLoad > r.seats) {
      const fit = r.seats / maxLoad;
      r.unserved = r.riders * (1 - fit);
      r.riders *= fit; r.revenue *= fit; r.network *= fit; r.transfers *= fit; r.transferRevenue *= fit;
    }
  }
  return results;
}

// ============================================================================ options

/** What the road planner uses of its company (AIController.busHost). */
export interface BusHost {
  g: Game;
  me: number;
  /** money the company can commit (AIController.available) */
  available(): number;
  /** the company's managed lines (AIController.lines) */
  managed: Map<number, LineInfo>;
  /** the project being built (stations and depots it laid are taken up if it is abandoned) */
  project(): { stations: number[]; depots: number[] } | null;
  note(s: string): void;
  borrowFor(amount: number): boolean;
  roadDepot(x: number, z: number): Generator<void, number>;
  linkTransfers(id: number): void;
  canonical(id: number): number;
  stats: { lines: number; vehicles: number; busStops: number; coaches: number; joined: number; grown: number; trams: number };
  isFailed(key: string): boolean;
  markFailed(key: string, days: number): void;
}

/** The parts of AIController.LineInfo the road planner reads and writes. */
export interface LineInfo {
  kind: 'rail' | 'bus' | 'tram'; towns: number[]; depot: number; maxVehicles: number; opened: number; lastSold?: number;
  shared?: number; joined?: boolean;
}

/** A road project the planner valued: our yearly receipts and costs from it and what it costs to open. */
export interface RoadPlan {
  kind: 'join' | 'extend' | 'line' | 'tram';
  /** tram: the upgrade the line gets */
  upgrade?: TramUpgrade;
  /** the existing line (join / extend) */
  line?: number;
  /** the new line's stops in route order, or (extend) the stop to add */
  sites: RoadSite[];
  /** extend: where the stop goes ('start', 'end' or the index of Line.stops it follows) */
  place?: 'start' | 'end' | number;
  loop?: boolean;
  model: VehicleModel;
  /** vehicles to buy */
  vehicles: number;
  towns: number[];
  revenue: number; yearly: number; outlay: number;
  why: string;
}

/** Yearly upkeep of a bus stop (Game.stationMaintenance) and a road depot (build-ops depotUpkeep); their prices. */
const STOP_UPKEEP = 3000, STOP_COST = 30_000, DEPOT_COST = 60_000, DEPOT_UPKEEP = 6000;
/** A vehicle loses value to a tenth over 15 years (Vehicles.resaleValue): its yearly write-off, as a share of its price. */
const WRITE_OFF = 0.9 / 15;

/** The yearly running cost of one vehicle of `model` on hops of `hop` units (opcosts estimate). */
function runningCost(g: Game, model: VehicleModel, hop: number): number {
  try { const c = estimateVehicleYear([model], Math.max(10, hop), g.year, 0.5).total; return c >= 0 ? c : model.running; }
  catch { return model.running; }
}

/** A vehicle's yearly capital charge: write-off (as its resale value falls) and interest on its price. */
function capital(g: Game, owner: number, price: number): number {
  return price * (WRITE_OFF + (g.company(owner).economy.interestRate ?? 0.05));
}

/**
 * Does a plan pay with a margin for the forecast's error (a fifth of its yearly costs and 5k)? The fleet review asks the
 * same of an added vehicle (ai.ts manage: receipts 1.2 x costs).
 */
export function pays(plan: { revenue: number; yearly: number }): boolean { return plan.revenue > plan.yearly * 1.2 + 5000; }

/** Score of a yearly surplus on an outlay, as AIController.chooseProject compares its options. */
export function roadScore(revenue: number, yearly: number, outlay: number): number {
  return Math.sqrt(Math.max(0, (revenue - yearly) / Math.max(1, outlay))) + 0.15;
}

/** The line's stops in route order (out-and-back lines listed once) and whether it circulates as a loop. */
export function routeOf(g: Game, l: Line): { path: number[]; loop: boolean } | null {
  const loop = g.lines.isLoop(l);
  const path = loop ? [...l.stops] : linearStops(l.stops) ?? (new Set(l.stops).size === 2 ? [...new Set(l.stops)] : null);
  return path && path.length >= 2 ? { path, loop } : null;
}

function siteOf(st: Station): RoadSite { return { x: st.x, z: st.z, townId: st.townId, station: st, road: st.stops[0] ? { x: st.stops[0].x, z: st.stops[0].z } : undefined }; }

/** The line's own road vehicles of an operator, and the model they run. */
function fleetOf(g: Game, l: Line, owner?: number): { vehicles: RoadVehicle[]; model: VehicleModel | null } {
  const vehicles = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is RoadVehicle => v?.kind === 'road' && (owner === undefined || v.owner === owner));
  return { vehicles, model: vehicles.find((v) => v.model)?.model ?? null };
}

/** Observed receipts of a line against its forecast (bounded): the forecast's error on this line, used for its changes. */
function calibration(l: Line, f: RoadForecast, age: number): number {
  const forecast = worth(f, 1) - NETWORK_TRUST * f.network;
  if (age < 420 || !(forecast > 0) || !(l.incomeLast > 0)) return NEW_LINE_CAL;
  const pax = l.incomeLast - (l.mail?.incomeLast ?? 0);
  return Math.max(0.3, Math.min(1.5, pax / forecast));
}

/**
 * What a forecast is worth to the company a year: its direct riders' receipts, the changing riders' (less sure: routing
 * may carry them otherwise; in 10-year runs they came out at about 0.6-0.8 of the forecast) and the receipts it brings
 * our other lines (counted at half), times the line's calibration (`cal`: observed / forecast; new lines 0.85).
 */
export function worth(f: RoadForecast, cal = NEW_LINE_CAL): number {
  return ((f.revenue - f.transferRevenue) + TRANSFER_TRUST * f.transferRevenue) * cal + NETWORK_TRUST * f.network;
}
/** The forecast's observed bias: direct riders' receipts of new lines, changing riders' and our network's receipts. */
const NEW_LINE_CAL = 0.85, TRANSFER_TRUST = 0.7, NETWORK_TRUST = 0.5;

/** Days a line has run (its first vehicle's purchase). */
function lineAge(g: Game, l: Line): number {
  let first = g.day;
  for (const id of l.vehicles) { const v = g.vehicles.get(id); if (v) first = Math.min(first, v.boughtDay); }
  return g.day - first;
}

/**
 * Most vehicles a road line takes with partners on it (all operators): two per stop. (A line of ours alone may grow to
 * ai.ts manage's street ceiling, two per stop of its route out and back.)
 */
export function roadFleetCap(g: Game, l: Line): number { return 2 * new Set(l.stops).size; }

/** Road depot of ours that reaches the station (its vehicles can start there), nearest first; -1: none. */
function ownDepotFor(g: Game, owner: number, stationId: number): number {
  const st = g.stations.get(stationId);
  if (!st) return -1;
  let best = -1, bd = Infinity;
  for (const d of g.depots.map.values()) {
    if (d.owner !== owner || d.kind !== 'road') continue;
    const dist = Math.hypot(d.x - st.x, d.z - st.z);
    if (dist < bd && dist < 90 && roadDepotReaches(g, d, stationId)) { bd = dist; best = d.id; }
  }
  return best;
}

/**
 * Riders a year one vehicle more wins back of those giving up at the line's stops (their queue outgrew the stop:
 * Stations.trimWaiting; each stop's losses in the line's share of its queue, as ai.ts manage counts them), and their
 * receipts at the line's observed fare. A vehicle meets a queue grown over one headway: with n + 1 vehicles it is n / (n + 1)
 * as long, so the share lost falls from p to max(0, 1 - (1 - p)(n + 1) / n).
 */
/** Riders given up at a stop shared with other lines also give up for those lines' queues: half of them count. */
const WIN_BACK_TRUST = 0.5;
function winBack(g: Game, l: Line, n: number): number {
  let lost = 0;
  for (const sid of new Set(l.stops)) {
    const st = g.stations.get(sid);
    if (!st || !(st.lostLast > 0)) continue;
    let mine = 0, all = 0;
    for (const w of st.waiting.values()) { all += w.count; if (w.line === l.id) mine += w.count; }
    if (all > 0) lost += st.lostLast * mine / all;
  }
  const rode = l.passLast, arrived = rode + lost;
  if (!(lost > 0) || !(rode > 0) || n < 1) return 0;
  const p = lost / arrived, after = Math.max(0, 1 - (1 - p) * (n + 1) / n);
  const fare = Math.max(0, l.incomeLast - (l.mail?.incomeLast ?? 0)) / (12 * rode);
  return (p - after) * arrived * 12 * fare;
}

/**
 * More vehicles on an existing road line, run by us: the forecast at one vehicle more (shorter headway, more seats)
 * against the current one, calibrated by the line's receipts, and the riders giving up it wins back (winBack): the gain
 * must repay the vehicle, its running and (on
 * another company's open line, as a partner) the fees for the stops we use. A route whose demand wants more capacity
 * thus gets more vehicles, ours or a partner's, rather than a parallel line.
 */
export function* moreValue(h: BusHost, l: Line): Generator<void, RoadPlan | null> {
  const g = h.g, me = h.me, route = routeOf(g, l);
  if (!route || l.kind !== 'road') return null;
  const all = fleetOf(g, l), n = all.vehicles.length;
  const model = all.model, alone = l.owner === me && !(l.operators?.length);
  if (!model || !n || n >= (alone ? 2 * l.stops.length : roadFleetCap(g, l))) return null;
  const sites = route.path.map((id) => g.stations.get(id)).filter((s): s is Station => !!s).map(siteOf);
  if (sites.length !== route.path.length) return null;
  const [before, after] = yield* lineForecast(g, me, sites, { model, vehicles: n, loop: route.loop }, [n, n + 1], l.id);
  const cal = calibration(l, before, lineAge(g, l));
  const ours = l.owner === me;
  const running = runningCost(g, model, before.hop);
  let revenue: number, fees = 0, outlay = model.cost;
  // The riders the vehicle adds to the line (a shorter headway, seats for those left behind): what it must pay for, ours
  // or a partner's. (A partner's vehicle earns its share of all riders, but taking riders from the vehicles already there
  // adds nothing to the route: on a route with room to spare, a further operator's vehicle does not pay.)
  revenue = Math.max(0, worth(after, cal) - worth(before, cal)) + WIN_BACK_TRUST * winBack(g, l, n);
  if (!ours) {
    const items = route.path.map((id) => g.stations.get(id)!).filter((st) => st.owner !== me);
    for (const owner of new Set(items.map((st) => st.owner))) fees += g.accessChargeEstimate(me, owner, items.filter((st) => st.owner === owner), 1 / (n + 1));
  }
  let depotUpkeep = 0;
  if (!route.path.some((id) => ownDepotFor(g, me, id) >= 0)) { outlay += DEPOT_COST; depotUpkeep = DEPOT_UPKEEP; }
  const yearly = running + fees + depotUpkeep + capital(g, me, model.cost) + (outlay - model.cost) * 0.05;
  const towns = [...new Set(sites.map((s) => s.townId).filter((t) => t >= 0))];
  return { kind: 'join', line: l.id, sites: [], model, vehicles: 1, towns, revenue, yearly, outlay,
    why: `${ours ? 'one more vehicle' : 'partner'}: ${Math.round(revenue / 1000)}k/year against ${Math.round(yearly / 1000)}k (line ${Math.round(worth(after, cal) / 1000)}k with ${n + 1})` };
}

/**
 * Does one more vehicle of ours on this road line (our own, or one we run as a partner) earn more than it costs? The
 * monthly fleet review (ai.ts manage) asks before it buys one for passengers left waiting.
 */
export function roadVehiclePays(h: BusHost, l: Line): boolean {
  const t0 = performance.now(), gen = moreValue(h, l);
  let r = gen.next();
  while (!r.done) r = gen.next();
  busProfile.fleetChecks++; busProfile.fleetMs += performance.now() - t0;
  const plan = r.value;
  return !!plan && pays(plan);
}

/**
 * Our bus stops beside rail stations that came later (any company's: walking passages are public) join their complex:
 * linked for transfers where the walk allows it (Stations.canLink), so riders change between the buses and the trains
 * inside one station (no transfer charge, vehicle.ts). Monthly (ai.ts manage); returns the links made.
 */
export function linkStopsToRail(h: BusHost): number {
  const g = h.g;
  let n = 0;
  const rail = [...g.stations.map.values()].filter((st) => st.rail && g.lines.stationServed(st.id));
  for (const st of [...g.stations.map.values()]) {
    if (st.owner !== h.me || st.rail || !st.stops.length || !g.lines.stationServed(st.id)) continue;
    for (const r of rail) {
      if (Math.hypot(r.x - st.x, r.z - st.z) > TRANSFER_RANGE * 2 + r.rail!.length || g.stations.complex(st.id).includes(r.id)) continue;
      if (g.stations.canLink(st.id, r.id) === null && g.stations.link(st.id, r.id) === null) {
        n++;
        h.note(`walking transfer ${st.name} - ${r.name}`);
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------- stop sites
export interface StopSite extends RoadSite { pop: number; free: number; rail: boolean }

/**
 * Bus stop sites on the streets within `r` of (x, z): the middle of each street edge where a stop of ours can go (an own
 * rail station there takes it: Stations.planBusStop; an open neighbour's stop beside it is used instead), with the
 * residents its walk reaches, those no served station holds yet (Stations' share-out), and whether it changes to a rail
 * service (a served rail station of its complex, or one within transfer reach it will be linked to).
 */
export function* stopSites(g: Game, owner: number, x: number, z: number, r: number, townId?: number): Generator<void, StopSite[]> {
  const net = g.world.net, out: StopSite[] = [], q = { x: 0, y: 0, z: 0 }, seen = new Set<number>();
  const linkCands = [...g.stations.map.values()].filter((st) => (st.owner === owner || !!st.rail) && Math.hypot(st.x - x, st.z - z) < r + 40);
  // street points: the middle of each street, and the street points nearest the forecourts of the rail stations around (a
  // stop there becomes part of an own station or is linked to it)
  const points: { e: NEdge; s: number }[] = [];
  for (const e of net.edgesNear(x - r, z - r, x + r, z + r)) {
    if (e.kind !== 'road' || e.depot >= 0 || e.station >= 0 || e.len < 4 || e.tram) continue;
    points.push({ e, s: e.len / 2 });
  }
  for (const st of linkCands) {
    if (!st.rail || !g.lines.stationServed(st.id) || Math.hypot(st.x - x, st.z - z) > r) continue;
    for (const p of [g.stations.forecourt(st), st.rail.forecourt2, { x: st.x, z: st.z }]) {
      const ne = p ? net.nearestEdge(p.x, p.z, 12, 'road', (e) => e.depot < 0 && e.station < 0 && !e.tram && e.len >= 4) : null;
      if (ne && !points.some((o) => o.e === ne.edge && Math.abs(o.s - ne.s) < 2)) points.push({ e: ne.edge, s: Math.max(2, Math.min(ne.edge.len - 2, ne.s)) });
    }
  }
  let work = 0;
  for (const { e, s: at } of points) {
    net.pointAt(e, at, q);
    if (Math.hypot(q.x - x, q.z - z) > r) continue;
    if (++work % 8 === 0) yield;
    const t = g.towns.nearest(q.x, q.z);
    if (townId !== undefined && t?.id !== townId) continue;
    let station: Station | undefined, links: number[] = [];
    const plan = g.stations.planBusStop(q.x, q.z, owner);
    if (plan.ok) station = plan.join ?? undefined;
    else {
      const shared = g.stations.findSharedStop(q.x, q.z, owner);
      if (!shared || (shared.owner !== owner && g.accessPolicy(shared.owner) !== 'open')) continue;
      station = shared;
    }
    if (station && seen.has(station.id)) continue;
    if (station) seen.add(station.id);
    // the stations a new stop here is linked to for transfers (Stations.commitBusStop, AIController.linkTransfers): ours and
    // rail stations within the transfer walk (Stations.canLink)
    if (!station) {
      const stop = { id: -1, owner, townId: g.towns.nearest(q.x, q.z)?.id ?? -1, x: q.x, z: q.z, rail: null, links: [] as number[],
        stops: [{ edge: e.id, s: at, x: q.x, z: q.z }] } as unknown as Station;
      for (const st of linkCands) {
        if (Math.hypot(st.x - q.x, st.z - q.z) > TRANSFER_RANGE * 2 + (st.rail?.length ?? 0)) continue;
        if (g.stations.gap(stop, st) <= g.stations.linkRange(stop, st)) links.push(st.id);
      }
    }
    const walk = station ? walkingCatchment(g, station) : pointWalkingCatchment(g, q.x, q.z, 'bus');
    let pop = 0, free = 0;
    for (const bid of walk.buildings.keys()) {
      const b = g.world.buildings.get(bid);
      if (!b || !(b.pop > 0)) continue;
      const held = g.stations.stationsForBuilding(bid).w.reduce((a, w) => a + w, 0);
      pop += b.pop; free += b.pop * Math.max(0, 1 - held);
    }
    const complex = station ? g.stations.complex(station.id) : links;
    const rail = complex.some((id) => { const st = g.stations.get(id); return !!st?.rail && g.lines.stationServed(id); });
    out.push({ x: station ? station.x : q.x, z: station ? station.z : q.z, townId: t?.id ?? -1, station, links: station ? undefined : links, pop, free, rail,
      road: { x: q.x, z: q.z } });
  }
  return out;
}

/** Planned or existing stops closer than this (units) serve the same walkers twice. */
const STOP_GAP = 10;
const far = (a: { x: number; z: number }, list: { x: number; z: number }[], d = STOP_GAP) => list.every((b) => Math.hypot(a.x - b.x, a.z - b.z) >= d);

/** Vehicles for a new line: about one every `headway` seconds (2 to 5), as the AI's town buses run. */
function fleetFor(cycle: number, headway: number, max = 5): number { return Math.max(2, Math.min(max, Math.round(cycle / headway))); }

/** The yearly figures of a new line: receipts, running and upkeep, and the outlay (stops, depot, vehicles). */
function lineEconomics(g: Game, owner: number, f: RoadForecast, sites: RoadSite[], model: VehicleModel, vehicles: number) {
  // stops to build: every site without a stop of its station (an own rail station gets one; a shared stop costs none)
  const newStops = sites.filter((s) => !s.station || !s.station.stops.length).length;
  const running = vehicles * runningCost(g, model, f.hop);
  const outlay = newStops * STOP_COST + DEPOT_COST + vehicles * model.cost;
  const yearly = running + newStops * STOP_UPKEEP + DEPOT_UPKEEP + capital(g, owner, vehicles * model.cost) + (newStops * STOP_COST + DEPOT_COST) * 0.05;
  return { revenue: worth(f), yearly, outlay };
}

// ---------------------------------------------------------------------------- new lines
/** Town bus headway the planner aims at (s): about what the AI's three-bus town lines run. */
const TOWN_HEADWAY = 40;

/**
 * Route candidates through a town's stop sites: chains outwards from a rail station's stop (a feeder: the districts the
 * station's walk does not reach) or from the centre (across it, both ways), and a ring round the centre; each stop the
 * best of the sites 12-32 units on from the last (residents no station holds, then all it reaches), never doubling back.
 */
export function townRoutes(T: Town, sites: StopSite[]): { stops: StopSite[]; loop: boolean; why: string }[] {
  const out: { stops: StopSite[]; loop: boolean; why: string }[] = [];
  if (sites.length < 2) return out;
  const value = (s: StopSite) => s.free + 0.25 * s.pop;
  const chain = (start: StopSite, max: number, away?: { x: number; z: number }, least = 15) => {
    const stops = [start];
    let dir: { x: number; z: number } | null = away ?? null;
    while (stops.length < max) {
      const last = stops[stops.length - 1];
      let best: StopSite | null = null, bv = 0;
      for (const s of sites) {
        const d = Math.hypot(s.x - last.x, s.z - last.z);
        if (d < 12 || d > 32 || !far(s, stops)) continue;
        if (dir && ((s.x - last.x) * dir.x + (s.z - last.z) * dir.z) / d < 0.3) continue;
        const v = value(s) / (1 + d / 60);
        if (v > bv) { bv = v; best = s; }
      }
      if (!best || bv < least) break;
      const d = Math.hypot(best.x - last.x, best.z - last.z);
      dir = { x: (best.x - last.x) / d, z: (best.z - last.z) / d };
      stops.push(best);
    }
    return stops;
  };
  const central = [...sites].sort((a, b) => Math.hypot(a.x - T.x, a.z - T.z) - Math.hypot(b.x - T.x, b.z - T.z) || b.pop - a.pop)[0];
  // feeders: from the town's rail interchanges outwards
  const hubs = sites.filter((s) => s.rail).sort((a, b) => Math.hypot(a.x - T.x, a.z - T.z) - Math.hypot(b.x - T.x, b.z - T.z)).slice(0, 2);
  for (const h of hubs) {
    // into town from the station: towards the centre first (thinner streets near a station are passed through), then
    // on into the districts the station's walk does not reach
    const dc = Math.hypot(T.x - h.x, T.z - h.z);
    const c = dc > 20 ? chain(h, 6, { x: (T.x - h.x) / dc, z: (T.z - h.z) / dc }, 4) : chain(h, 5);
    if (c.length >= 3) out.push({ stops: c, loop: false, why: 'feeder' });
  }
  // across the centre: outwards one way, then the other
  {
    const one = chain(central, 3);
    if (one.length >= 2) {
      const d = Math.hypot(one[1].x - central.x, one[1].z - central.z);
      const other = chain(central, 3, { x: -(one[1].x - central.x) / d, z: -(one[1].z - central.z) / d });
      const stops = [...other.slice(1).reverse(), ...one];
      if (stops.length >= 3 || (stops.length === 2 && hubs.length === 0)) out.push({ stops, loop: false, why: 'cross-town' });
    }
  }
  // a ring round the centre at about half the town's radius (an interchange first when one lies near it)
  {
    const R = Math.max(12, Math.min(26, T.radius * 0.5)), n = T.pop >= 5000 ? 5 : 4;
    const first = hubs.find((h) => Math.abs(Math.hypot(h.x - T.x, h.z - T.z) - R) < 10);
    const a0 = first ? Math.atan2(first.z - T.z, first.x - T.x) : 0;
    const ring: StopSite[] = first ? [first] : [];
    for (let k = ring.length; k < n; k++) {
      const a = a0 + (k * 2 * Math.PI) / n, px = T.x + Math.cos(a) * R, pz = T.z + Math.sin(a) * R;
      let best: StopSite | null = null, bd = 9;
      for (const s of sites) { const d = Math.hypot(s.x - px, s.z - pz); if (d < bd && far(s, ring, 11)) { bd = d; best = s; } }
      if (best) ring.push(best);
    }
    if (ring.length >= 4) {
      const ang = (s: StopSite) => ((Math.atan2(s.z - T.z, s.x - T.x) - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI);
      out.push({ stops: ring.sort((a, b) => ang(a) - ang(b)), loop: true, why: 'ring' });
    }
  }
  return out;
}

/** The best town bus line for T by the forecast (a feeder, a line across the centre or a ring), with its economics. */
export function* planTownLine(h: BusHost, T: Town, model: VehicleModel): Generator<void, RoadPlan | null> {
  const g = h.g, sites = yield* stopSites(g, h.me, T.x, T.z, T.radius + 6, T.id);
  let best: RoadPlan | null = null, bestScore = -Infinity;
  for (const r of townRoutes(T, sites)) {
    const probe = roadTimetable(g, r.stops, model, r.loop);
    // a frequent service or a sparser one: whichever earns more on its outlay
    const fleets = [...new Set([fleetFor(probe.cycle, TOWN_HEADWAY, r.loop ? 6 : 5), fleetFor(probe.cycle, 2 * TOWN_HEADWAY, 4)])];
    const fs = yield* busCityForecast(g, h.me, r.stops, { model, vehicles: fleets[0], loop: r.loop }, fleets);
    for (const [m, vehicles] of fleets.entries()) {
    const f = fs[m];
    if (!(f.cycle > 0) || !Number.isFinite(f.cycle)) continue;
    const e = lineEconomics(g, h.me, f, r.stops, model, vehicles);
    const score = e.revenue > e.yearly ? roadScore(e.revenue, e.yearly, e.outlay) : (e.revenue - e.yearly) / Math.max(1, e.outlay);
    if (score > bestScore) {
      bestScore = score;
      best = { kind: 'line', sites: r.stops, loop: r.loop, model, vehicles, towns: [T.id], ...e,
        why: `${r.why} in ${T.name}: ${r.stops.length} stops, ${Math.round(f.riders)} riders, ${Math.round(e.revenue / 1000)}k/year against ${Math.round(e.yearly / 1000)}k` };
    }
    }
  }
  return best;
}

/** The stop for a coach line in a town: its rail interchange or a central street, where it reaches most residents of its own. */
function* coachSite(g: Game, owner: number, T: Town): Generator<void, StopSite | null> {
  const sites = yield* stopSites(g, owner, T.x, T.z, Math.max(10, T.radius * 0.7), T.id);
  let best: StopSite | null = null, bv = -Infinity;
  for (const s of sites) {
    const d = Math.hypot(s.x - T.x, s.z - T.z);
    const v = (s.free + 0.3 * s.pop) * (s.rail ? 1.4 : 1) / (1 + d / Math.max(10, T.radius));
    if (v > bv) { bv = v; best = s; }
  }
  return best;
}

/**
 * Towns on the road between two places a coach can call at (as real intercity coaches do): within a short detour (a fifth
 * longer than the straight way) and between them, the larger first.
 */
export function townsOnTheWay(g: Game, a: { x: number; z: number }, b: { x: number; z: number }, skip: Set<number>, max = 3): Town[] {
  const d = Math.hypot(a.x - b.x, a.z - b.z);
  if (d < 40) return [];
  return g.towns.list.filter((T) => {
    if (skip.has(T.id) || T.pop < 250) return false;
    const along = ((T.x - a.x) * (b.x - a.x) + (T.z - a.z) * (b.z - a.z)) / (d * d);
    return along > 0.1 && along < 0.9 && Math.hypot(T.x - a.x, T.z - a.z) + Math.hypot(b.x - T.x, b.z - T.z) - d <= 0.2 * d;
  }).sort((p, q) => q.pop - p.pop || p.id - q.id).slice(0, max);
}

/**
 * A coach line between two towns over the roads, calling at the towns on the way where their riders (between every pair
 * of its stops) repay the stop, the coaches it needs and the time the dwell and detour cost the end-to-end riders; two to
 * five coaches, by the forecast on the trips between towns. The design that earns most a year after its costs (capital
 * charges included) is taken.
 */
export function* planCoach(h: BusHost, A: Town, B: Town, model: VehicleModel): Generator<void, RoadPlan | null> {
  const g = h.g, sa = yield* coachSite(g, h.me, A), sb = yield* coachSite(g, h.me, B);
  if (!sa || !sb || shadowed(g, h.me, [sa, sb], -1)) return null;
  const quote = function* (sites: StopSite[]): Generator<void, { plan: RoadPlan; score: number } | null> {
    const fleets = [2, 3, 4, 5];
    const fs = yield* coachIntercityForecast(g, h.me, sites, { model, vehicles: 2, loop: false }, fleets);
    let out: { plan: RoadPlan; score: number } | null = null;
    for (const [m, vehicles] of fleets.entries()) {
      const f = fs[m];
      if (!(f.cycle > 0) || !Number.isFinite(f.cycle)) return null;
      const e = lineEconomics(g, h.me, f, sites, model, vehicles);
      // (the yearly surplus after running, upkeep and capital charges)
      const score = e.revenue - e.yearly;
      const names = sites.map((s) => g.towns.list[s.townId]?.name ?? '?');
      if (!out || score > out.score) out = { score, plan: { kind: 'line', sites, loop: false, model, vehicles, towns: [...new Set(sites.map((s) => s.townId))], ...e,
        why: `coaches ${names.join(' - ')}: ${Math.round(f.riders)} riders, ${Math.round(e.revenue / 1000)}k/year against ${Math.round(e.yearly / 1000)}k` } };
    }
    return out;
  };
  const first: { plan: RoadPlan; score: number } | null = yield* quote([sa, sb]);
  if (!first) return null;
  let best: { plan: RoadPlan; score: number } = first;
  // towns on the way, one at a time where it pays more (ordered along the route)
  for (const T of townsOnTheWay(g, A, B, new Set([A.id, B.id]))) {
    const site = yield* coachSite(g, h.me, T);
    if (!site) continue;
    const sites: RoadSite[] = [...best.plan.sites];
    const along = (s: { x: number; z: number }) => (s.x - A.x) * (B.x - A.x) + (s.z - A.z) * (B.z - A.z);
    let at = sites.length - 1;
    while (at > 0 && along(sites[at - 1]) > along(site)) at--;
    const q: { plan: RoadPlan; score: number } | null = yield* quote([...sites.slice(0, at), site, ...sites.slice(at)] as StopSite[]);
    if (q && q.score > best.score + 5000) best = q;
  }
  return best.plan;
}

// ---------------------------------------------------------------------------- extensions
/**
 * One of our road lines with a stop added at route position `at` (`place`: where line-edit puts it): the forecast's gain
 * (calibrated by the line's receipts; partners' vehicles take their share) with the fleet as it is or the vehicles that
 * keep the headway, whichever earns more, against the stop and the vehicles' costs. `before`: the line's forecast now.
 */
export function* extendPlan(h: BusHost, l: Line, site: RoadSite, place: 'start' | 'end' | number, at: number, why: string, before?: RoadForecast): Generator<void, RoadPlan | null> {
  const g = h.g, me = h.me, route = routeOf(g, l);
  if (!route || l.kind !== 'road' || l.owner !== me) return null;
  const { vehicles, model } = fleetOf(g, l);
  const n = vehicles.length, ours = vehicles.filter((v) => v.owner === me).length;
  const stations = route.path.map((id) => g.stations.get(id)).filter((s): s is Station => !!s);
  if (!model || !ours || stations.length !== route.path.length) return null;
  const sites = stations.map(siteOf), towns = new Set(stations.map((s) => s.townId));
  const next = [...sites.slice(0, at), site, ...sites.slice(at)];
  // (no extension that makes the line, or its new stretch to another town, a near-duplicate of another company's coaches)
  if (!route.loop && shadowed(g, me, next, l.id) && !shadowed(g, me, sites, l.id)) return null;
  const from = place === 'start' ? sites[0] : place === 'end' ? sites[sites.length - 1] : null;
  if (from && shadowed(g, me, [from, site], l.id)) return null;
  // (valued on one demand before and after: a town line growing into another town on all of it)
  const coachNow = towns.size >= 2, coachNext = new Set(next.map((s) => s.townId)).size >= 2;
  const purpose = coachNow !== coachNext ? 'all' : coachNow ? 'intercity' : 'city';
  if (!before || coachNow !== coachNext) before = (yield* roadForecasts(g, me, sites, { model, vehicles: n, loop: route.loop, purpose }, [n], l.id))[0];
  const cal = calibration(l, before, lineAge(g, l));
  const drive = roadDriving(g, next, model, route.loop);
  if (!drive || !(before.cycle > 0)) return null;
  // the fleet as it is, or the vehicles that keep the headway on the longer route: whichever earns more
  const keep = Math.min(roadFleetCap(g, l) + 2, Math.max(n, Math.round(n * drive.cycle / before.cycle)));
  const newStop = !site.station || !site.station.stops.length ? 1 : 0, T = g.towns.list[site.townId];
  let best: RoadPlan | null = null;
  const fleets = keep > n ? [n, keep] : [n];
  const fs = yield* roadForecasts(g, me, next, { model, vehicles: n, loop: route.loop, purpose }, fleets, l.id);
  for (const [m, nv] of fleets.entries()) {
    const f = fs[m];
    const extra = nv - n;
    // (partners' vehicles share the riders: ours take our share of them)
    const gain = worth(f, cal) * (ours + extra) / nv - worth(before, cal) * ours / n;
    const yearly = ((ours + extra) * runningCost(g, model, f.hop) - ours * runningCost(g, model, before.hop)) + newStop * STOP_UPKEEP
      + capital(g, me, extra * model.cost) + newStop * STOP_COST * 0.05;
    const outlay = newStop * STOP_COST + extra * model.cost;
    if (!best || gain - yearly > best.revenue - best.yearly) best = { kind: 'extend', line: l.id, sites: [site], place, model, vehicles: extra,
      towns: [...new Set([...towns, site.townId])].filter((t) => t >= 0), revenue: gain, yearly, outlay: Math.max(outlay, 1),
      why: `${l.name} ${why}${T ? ` (${T.name})` : ''}: +${Math.round(gain / 1000)}k/year against ${Math.round(yearly / 1000)}k, ${extra} more vehicles` };
  }
  return best;
}

/**
 * Longer routes for one of our road lines: a stop beyond either end (residents no stop serves yet, a rail interchange, or
 * for coaches the next town on), or one inserted on the way between two stops where it costs a short detour (for coaches,
 * a town on the road between two of its towns); each priced
 * by the forecast's gain (calibrated by the line's receipts) against the stop, the vehicles that keep the headway and
 * their running costs. The best few candidates by residents are forecast.
 */
export function* planExtensions(h: BusHost, l: Line, maxForecasts = 3): Generator<void, RoadPlan[]> {
  const g = h.g, me = h.me, route = routeOf(g, l);
  if (!route || l.kind !== 'road' || l.owner !== me) return [];
  const { vehicles, model } = fleetOf(g, l);
  const n = vehicles.length, ours = vehicles.filter((v) => v.owner === me).length;
  if (!model || !ours || route.path.length >= 8) return [];
  const stations = route.path.map((id) => g.stations.get(id)).filter((s): s is Station => !!s);
  if (stations.length !== route.path.length) return [];
  const sites = stations.map(siteOf);
  const towns = new Set(stations.map((s) => s.townId));
  const coach = towns.size >= 2;
  const cands: { site: StopSite; place: 'start' | 'end' | number; at: number; value: number; why: string }[] = [];
  // (a coach line does not move a stop next to another company's stop on a line serving its towns: those residents ride
  // that service, HOLD, and the two lines would run stop beside stop)
  const rivals: Station[] = [];
  if (coach) for (const o of g.lines.map.values()) {
    if (o.owner === me || o.operators?.includes(me) || o.kind === 'tram' || !o.vehicles.length) continue;
    const ot = new Set(o.stops.map((id) => g.stations.get(id)?.townId));
    if ([...towns].filter((t) => ot.has(t)).length < 2) continue;
    for (const id of o.stops) { const st = g.stations.get(id); if (st) rivals.push(st); }
  }
  const add = (site: StopSite, place: 'start' | 'end' | number, at: number, why: string, bonus = 1) => {
    if (!far(site, sites) || !far(site, rivals, HOLD)) return;
    if (site.station && route.path.includes(site.station.id)) return;
    cands.push({ site, place, at, value: (site.free + 0.2 * site.pop) * (site.rail ? 1.5 : 1) * bonus, why });
  };
  // beyond the ends of a line out and back
  if (!route.loop) for (const end of ['start', 'end'] as const) {
    const i = end === 'start' ? 0 : sites.length - 1, j = end === 'start' ? 1 : sites.length - 2;
    const t = sites[i], p = sites[j], d0 = Math.hypot(t.x - p.x, t.z - p.z) || 1, ux = (t.x - p.x) / d0, uz = (t.z - p.z) / d0;
    yield;
    for (const s of yield* stopSites(g, me, t.x, t.z, 34)) {
      const d = Math.hypot(s.x - t.x, s.z - t.z);
      if (d < 12 || ((s.x - t.x) * ux + (s.z - t.z) * uz) / d < 0.35) continue;
      add(s, end, end === 'start' ? 0 : sites.length, s.rail ? 'to the rail station' : 'beyond the terminus');
    }
    // coaches: the next town on (a village or town that no stop of the line serves)
    if (coach) for (const T of g.towns.list) {
      if (towns.has(T.id) || T.pop < 250) continue;
      const d = Math.hypot(T.x - t.x, T.z - t.z);
      if (d < 50 || d > 160 || ((T.x - t.x) * ux + (T.z - t.z) * uz) / d < 0.5) continue;
      yield;
      const s = yield* coachSite(g, me, T);
      if (s) add(s, end, end === 'start' ? 0 : sites.length, `on to ${T.name}`, 1.5);
    }
  }
  // on the way: a stop between two stops a short detour away
  const legs = route.loop ? sites.length : sites.length - 1;
  for (let k = 0; k < legs; k++) {
    const a = sites[k], b = sites[(k + 1) % sites.length], d = Math.hypot(a.x - b.x, a.z - b.z);
    // between two towns: a town on the way (a coach calling there picks up the trips to and from it)
    if (a.townId !== b.townId) {
      for (const T of townsOnTheWay(g, a, b, towns, 2)) {
        yield;
        const s = yield* coachSite(g, me, T);
        if (s) add(s, k, k + 1, `via ${T.name}`, 1.5);
      }
      continue;
    }
    if (d < 22) continue;
    yield;
    for (const s of yield* stopSites(g, me, (a.x + b.x) / 2, (a.z + b.z) / 2, d / 2)) {
      const detour = Math.hypot(a.x - s.x, a.z - s.z) + Math.hypot(s.x - b.x, s.z - b.z) - d;
      if (detour > Math.max(6, d * 0.3)) continue;
      add(s, route.loop ? k : k, k + 1, s.rail ? 'via the rail station' : 'a stop on the way');
    }
  }
  if (!cands.length) return [];
  cands.sort((x, y) => y.value - x.value);
  const [before] = yield* lineForecast(g, me, sites, { model, vehicles: n, loop: route.loop }, [n], l.id);
  const out: RoadPlan[] = [];
  const tried = new Set<string>();
  for (const c of cands) {
    if (tried.size >= maxForecasts) break;
    const key = `${c.site.x.toFixed(1)},${c.site.z.toFixed(1)}`;
    if (tried.has(key)) continue;
    tried.add(key);
    const plan = yield* extendPlan(h, l, c.site, c.place, c.at, c.why, before);
    if (plan) out.push(plan);
  }
  return out;
}

// ---------------------------------------------------------------------------- the options of a project choice
/** An option of AIController.chooseProject (the fields this planner reads and sets). */
export interface ProjectOption { score: number; kind: string; towns: number[]; viable?: boolean; road?: RoadPlan }

/** Other companies' road lines we may run vehicles on (open to partners, stops we may use), busiest per vehicle first. */
function joinable(g: Game, me: number): Line[] {
  const out: { l: Line; v: number }[] = [];
  for (const l of g.lines.map.values()) {
    if (l.kind !== 'road' || l.owner === me || l.owner === PLAYER_ID || l.operators?.includes(me) || !l.vehicles.length) continue;
    if (g.lines.partnerPolicy(l) !== 'open' || !routeOf(g, l)) continue;
    if (l.stops.some((id) => { const st = g.stations.get(id); return !st || !g.canUse(me, st.owner); })) continue;
    if (lineAge(g, l) < 30 || l.vehicles.length >= roadFleetCap(g, l)) continue;
    out.push({ l, v: l.incomeLast / l.vehicles.length });
  }
  return out.sort((a, b) => b.v - a.v || a.l.id - b.l.id).map((o) => o.l);
}
const PLAYER_ID = 0;

/**
 * Road options for a project choice: vehicles on other companies' open lines (partners), longer routes for our own lines,
 * and the town bus and coach options re-quoted with the forecast (their sites and fleets planned), so that an existing
 * route's partner or extension competes with a new line by what each earns. `weight`: the company's road focus weight.
 */
export function* roadOptions(h: BusHost, opts: ProjectOption[], avail: number, weight: number): Generator<void, void> {
  const g = h.g, me = h.me;
  const push = (plan: RoadPlan, kind: string) => opts.push({ score: planScore(plan) * weight, kind, towns: plan.towns, viable: pays(plan) && plan.outlay <= avail, road: plan });
  // a partner on the busiest open line of another company that may take one more vehicle (one a choice: a line where it
  // does not pay is looked at again in half a year)
  if (avail > 300_000) {
    const l = joinable(g, me).find((x) => !h.isFailed('roadjoin' + x.id));
    if (l) {
      const plan = yield* moreValue(h, l);
      if (plan && pays(plan)) push(plan, 'busjoin'); else h.markFailed('roadjoin' + l.id, 180);
    }
  }
  // a longer route for one of our lines, in turn
  const own = [...g.lines.map.values()].filter((l) => l.kind === 'road' && l.owner === me && l.vehicles.length && !h.isFailed('roadext' + l.id)).sort((a, b) => a.id - b.id);
  if (own.length && avail > 200_000) {
    const l = own[Math.floor(g.day / 30) % own.length];
    const plans = (yield* planExtensions(h, l)).filter(pays);
    for (const plan of plans) push(plan, 'busext');
    if (!plans.length) h.markFailed('roadext' + l.id, 180);
  }
  // a busy town bus line of ours to trams (the busiest by riders a vehicle, one a choice)
  if (avail > 1_000_000) {
    const busy = [...g.lines.map.values()].filter((l) => l.kind === 'road' && l.owner === me && l.vehicles.length >= 3 && !h.isFailed('tramup' + l.id)
      && l.incomeLast > l.costLast && new Set(l.stops.map((id) => g.stations.get(id)?.townId)).size === 1 && new Set(l.stops).size >= 3)
      .sort((a, b) => b.passLast / b.vehicles.length - a.passLast / a.vehicles.length || a.id - b.id)[0];
    if (busy) {
      const plan = yield* tramUpgradeValue(h, busy);
      if (plan && pays(plan)) push(plan, 'busrail'); else h.markFailed('tramup' + busy.id, 360);
    }
  }
}

/** Score of a plan as a project option: its return on the outlay when it pays with the margin, else none. */
export function planScore(plan: RoadPlan): number { return pays(plan) ? roadScore(plan.revenue, plan.yearly, plan.outlay) : 0; }

/**
 * A town bus or coach market the project choice picked (AIController: a 'bus' town or a 'coach' town pair): the best of a
 * new line planned by the forecast, vehicles on a line already serving it (ours or as a partner), and for coaches one of
 * our lines extended from a town of the pair to the other. A served pair thus gets a partner or a longer line rather than
 * a near-copy (the copy's riders near the served stops keep riding the service they know: HOLD). Null when none pays.
 */
export function* roadMarket(h: BusHost, kind: 'bus' | 'coach', towns: number[]): Generator<void, RoadPlan | null> {
  const g = h.g, me = h.me, plans: RoadPlan[] = [];
  const A = g.towns.list[towns[0]], B = kind === 'coach' ? g.towns.list[towns[1]] : undefined;
  if (!A || (kind === 'coach' && !B)) return null;
  // (another company already planning or building coaches between these towns: its plan comes first)
  if (kind === 'coach' && g.ais.some((ai) => {
    const p = (ai as unknown as { project?: { kind: string; towns: number[] } | null }).project;
    return ai.companyId !== me && !ai.disposed && p?.kind === 'coach' && p.towns.includes(A.id) && p.towns.includes(B!.id);
  })) return null;
  // lines already serving the market (others' open ones we may join; ours, one vehicle more)
  const serving = [...g.lines.map.values()].filter((l) => {
    if (l.kind !== 'road' || !l.vehicles.length || !routeOf(g, l)) return false;
    const t = townsOf(g, l);
    return kind === 'coach' ? t.includes(A.id) && t.includes(B!.id) : t.length === 1 && t[0] === A.id;
  }).filter((l) => l.owner === me || l.operators?.includes(me) || joinable(g, me).includes(l))
    .sort((a, b) => b.incomeLast / b.vehicles.length - a.incomeLast / a.vehicles.length || a.id - b.id).slice(0, 2);
  for (const l of serving) { const p = yield* moreValue(h, l); if (p) plans.push(p); }
  if (kind === 'coach') {
    const model = coachModel(g.year);
    if (model) { const p = yield* planCoach(h, A, B!, model); if (p) plans.push(p); }
    // one of our lines ending in one town of the pair, extended to the other
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'road' || l.owner !== me || !l.vehicles.length) continue;
      const route = routeOf(g, l);
      if (!route || route.loop || route.path.length >= 8) continue;
      const t = townsOf(g, l);
      if (t.includes(A.id) && t.includes(B!.id)) continue;
      for (const end of ['start', 'end'] as const) {
        const st = g.stations.get(end === 'start' ? route.path[0] : route.path[route.path.length - 1]);
        const to = st?.townId === A.id ? B! : st?.townId === B!.id ? A : null;
        if (!st || !to) continue;
        const site = yield* coachSite(g, me, to);
        if (!site) continue;
        const p = yield* extendPlan(h, l, site, end, end === 'start' ? 0 : route.path.length, `on to ${to.name}`);
        if (p) plans.push(p);
      }
    }
  } else {
    const model = pickBusFor(g.year, A.pop);
    if (model) { const p = yield* planTownLine(h, A, model); if (p) plans.push(p); }
  }
  let best: RoadPlan | null = null;
  for (const p of plans) if (pays(p) && (!best || planScore(p) > planScore(best))) best = p;
  return best;
}

/** Towns a line's stops are in. */
function townsOf(g: Game, l: Line): number[] { return [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))]; }

/** The bus for a town of `pop` and the coach of the year (ai.ts pickBus / pickCoach, as the projects buy them). */
let pickBusFor: (year: number, pop: number) => VehicleModel | null = () => null;
let coachModel: (year: number) => VehicleModel | null = () => null;
/** ai.ts registers its vehicle choice (no import cycle at module load). */
export function setRoadModels(bus: typeof pickBusFor, coach: typeof coachModel) { pickBusFor = bus; coachModel = coach; }

// ---------------------------------------------------------------------------- building
/** Our station at a site (an existing one, or the stop just built there), or -1. */
function stationAt(g: Game, owner: number, x: number, z: number, before: number): number {
  let sid = -1, bd = Infinity;
  for (const st of g.stations.map.values()) {
    if (st.owner !== owner && st.id < before) continue;
    for (const q of st.stops) { const d = Math.hypot(q.x - x, q.z - z); if (d < bd) { bd = d; sid = st.id; } }
  }
  return bd < 4 ? sid : -1;
}

/** Build a stop at a planned site (or use the station there): its station id, or -1. New stations go to the project. */
function* buildStop(h: BusHost, s: RoadSite): Generator<void, number> {
  const g = h.g, me = h.me;
  if (s.station && g.stations.get(s.station.id) && s.station.stops.length) return s.station.id;
  const before = g.stations.nextId, at = s.road ?? s;
  const err = g.stations.commitBusStop(at.x, at.z, me);
  yield;
  if (err) {
    // a stop came here meanwhile: ours or an open neighbour's is used
    const shared = g.stations.findSharedStop(at.x, at.z, me);
    return shared && (shared.owner === me || g.accessPolicy(shared.owner) === 'open') ? shared.id : -1;
  }
  const sid = stationAt(g, me, at.x, at.z, before);
  if (g.stations.nextId > before) { h.project()?.stations.push(before); h.linkTransfers(before); }
  h.stats.busStops++;
  return sid;
}

/** A road depot of ours reaching the station, or a new one near it (-1: none). */
function* depotFor(h: BusHost, stationId: number): Generator<void, number> {
  const g = h.g, have = ownDepotFor(g, h.me, stationId);
  if (have >= 0) return have;
  const st = g.stations.get(stationId);
  if (!st) return -1;
  const dep = yield* h.roadDepot(st.stops[0]?.x ?? st.x, st.stops[0]?.z ?? st.z);
  if (dep >= 0) {
    h.project()?.depots.push(dep);
    const dp = g.depots.get(dep);
    if (!dp || !roadDepotReaches(g, dp, stationId)) return -1;
  }
  return dep;
}

/**
 * Carry out a road plan as the company's project: run vehicles on the line (as a partner where it is another's), extend
 * one of our lines by its stop, or open the new line. Returns a note of the outcome; failures mark the option for a while.
 */
export function* roadPlanJob(h: BusHost, plan: RoadPlan): Generator<void, string> {
  const g = h.g, me = h.me;
  const fail = (key: string, why: string, days = 360) => { h.markFailed(key, days); return `road project failed: ${why}`; };
  if (plan.kind === 'join') {
    const l = g.lines.get(plan.line ?? -1);
    if (!l || l.id !== plan.line || l.kind !== 'road') return fail('roadjoin' + plan.line, 'line gone');
    if (l.owner !== me) { const err = g.lines.join(l.id, me); if (err) return fail('roadjoin' + l.id, err, 720); }
    let dep = -1;
    for (const sid of new Set(l.stops)) { dep = ownDepotFor(g, me, sid); if (dep >= 0) break; }
    if (dep < 0) {
      if (!h.borrowFor(DEPOT_COST + plan.model.cost)) { if (l.owner !== me) g.lines.leave(l.id, me); return fail('roadjoin' + l.id, 'no money', 180); }
      dep = yield* depotFor(h, l.stops[0]);
    }
    if (dep < 0) { if (l.owner !== me) g.lines.leave(l.id, me); return fail('roadjoin' + l.id, 'no depot site', 720); }
    if (!h.borrowFor(plan.model.cost)) { if (l.owner !== me) g.lines.leave(l.id, me); return fail('roadjoin' + l.id, 'no money', 180); }
    const v = g.vehicles.buyRoad(dep, plan.model, l.id);
    if (typeof v === 'string') { if (l.owner !== me) g.lines.leave(l.id, me); return fail('roadjoin' + l.id, v, 720); }
    h.stats.vehicles++;
    const ours = l.vehicles.filter((id) => g.vehicles.get(id)?.owner === me).length;
    const info = h.managed.get(l.id);
    if (info) info.maxVehicles = Math.max(info.maxVehicles, ours);
    else {
      h.managed.set(l.id, { kind: 'bus', towns: [...plan.towns], depot: dep, maxVehicles: Math.max(2, ours), opened: g.day, joined: true, shared: l.owner });
      h.stats.joined++;
      g.postNews(`${g.company(me).name} runs buses on ${g.company(l.owner).name}'s ${l.name} too.`, 'ai', g.stations.get(l.stops[0])?.x, g.stations.get(l.stops[0])?.z);
    }
    return `${l.owner === me ? 'added a vehicle to' : 'joined'} ${l.name} (${plan.why})`;
  }
  if (plan.kind === 'tram' && plan.upgrade) {
    const l = g.lines.get(plan.line ?? -1);
    if (!l || l.id !== plan.line) return fail('tramup' + plan.line, 'line gone');
    const need = plan.upgrade.trackCost + plan.upgrade.depotCost + plan.upgrade.tramCost;
    if (need > h.available() + plan.upgrade.resale + 300_000 || !h.borrowFor(need)) return fail('tramup' + l.id, 'no money', 360);
    const oldName = l.name, built = { depots: [] as number[] };
    const err = yield* buildTramUpgrade(g, plan.upgrade, me, built);
    for (const d of built.depots) h.project()?.depots.push(d);
    if (err) return fail('tramup' + l.id, err, 720);
    const info = h.managed.get(l.id), dep = l.vehicles.map((id) => (g.vehicles.get(id) as RoadVehicle | undefined)?.depotId).find((d) => d !== undefined);
    if (info) { info.kind = 'tram'; info.depot = dep ?? info.depot; info.maxVehicles = Math.max(4, l.vehicles.length); }
    h.stats.trams++;
    const st = g.stations.get(l.stops[0]);
    g.postNews(`${g.company(me).name} upgrades ${oldName} to trams (${l.name}).`, 'ai', st?.x, st?.z);
    return `upgraded ${oldName} to trams as ${l.name} (${plan.why})`;
  }
  if (plan.kind === 'extend') {
    const l = g.lines.get(plan.line ?? -1), s = plan.sites[0];
    if (!l || l.id !== plan.line || l.owner !== me || !s) return fail('roadext' + plan.line, 'line gone');
    const cost = (s.station?.stops.length ? 0 : STOP_COST) + plan.vehicles * plan.model.cost;
    if (cost > h.available() + 200_000 || !h.borrowFor(cost)) return fail('roadext' + l.id, 'no money', 180);
    const sid = yield* buildStop(h, s);
    if (sid < 0) return fail('roadext' + l.id, 'no stop site', 360);
    if (l.stops.includes(sid)) return fail('roadext' + l.id, 'stop already served', 360);
    // (a line out and back stays one: two stops and a third between them are A, X, B, X, not a loop)
    const route = routeOf(g, l), place = plan.place ?? 'auto';
    let stops: number[] | null = null;
    if (route && !route.loop && place !== 'auto') {
      const at = place === 'start' ? 0 : place === 'end' ? route.path.length : place + 1;
      stops = outAndBack([...route.path.slice(0, at), sid, ...route.path.slice(at)]);
    } else stops = stopsWithInserted(g, l, sid, place)?.stops ?? null;
    if (!stops || new Set(stops).size < 3) return fail('roadext' + l.id, 'stop does not fit', 360);
    const oldName = l.name;
    replaceLineStops(g, l, stops);
    yield;
    const info = h.managed.get(l.id);
    let bought = 0;
    for (let i = 0; i < plan.vehicles; i++) {
      const dep = info?.depot ?? -1;
      const v = dep >= 0 ? g.vehicles.buyRoad(dep, plan.model, l.id) : 'no depot';
      if (typeof v !== 'string') { bought++; h.stats.vehicles++; }
      yield;
    }
    if (info) {
      info.towns = [...new Set([...info.towns, ...plan.towns])];
      info.maxVehicles = Math.max(info.maxVehicles, l.vehicles.filter((id) => g.vehicles.get(id)?.owner === me).length);
    }
    h.stats.grown++;
    const st = g.stations.get(sid);
    g.postNews(`${g.company(me).name} extends ${oldName} to ${st?.name ?? 'a new stop'}.`, 'ai', st?.x, st?.z);
    return `extended ${oldName} to ${st?.name ?? sid}, ${bought} more vehicles (${plan.why})`;
  }
  // a new line
  const key = plan.towns.length >= 2 ? 'coach' + Math.min(plan.towns[0], plan.towns[1]) + '-' + Math.max(plan.towns[0], plan.towns[1]) : 'bus' + plan.towns[0];
  if (!pays(plan)) return fail(key, `forecast ${Math.round(plan.revenue / 1000)}k/year below ${Math.round(plan.yearly / 1000)}k`, 720);
  // Quoted again before building: another company may have opened a service in these towns while we planned (its
  // riders near its stops keep riding it), and a copy of it would not pay.
  {
    const [f] = yield* lineForecast(g, me, plan.sites, { model: plan.model, vehicles: plan.vehicles, loop: !!plan.loop });
    const again = { revenue: worth(f), yearly: plan.yearly };
    if (!pays(again)) return fail(key, `forecast now ${Math.round(again.revenue / 1000)}k/year below ${Math.round(plan.yearly / 1000)}k`, 720);
  }
  if (plan.outlay > h.available() + 200_000 || !h.borrowFor(plan.outlay)) return fail(key, 'no money', 360);
  const ids: number[] = [];
  for (const s of plan.sites) {
    const sid = yield* buildStop(h, s);
    if (sid < 0 || ids.includes(sid)) return fail(key, 'stop sites taken', 360);
    ids.push(sid);
  }
  const dep = yield* depotFor(h, ids[0]);
  if (dep < 0) return fail(key, 'no depot site', 720);
  const dp = g.depots.get(dep)!;
  for (const sid of ids) { yield; if (!roadDepotReaches(g, dp, sid)) return fail(key, 'no road route', 720); }
  const line = g.lines.create('road', me);
  line.stops = plan.loop ? [...ids] : outAndBack(ids);
  if (plan.loop) line.loop = true;
  let bought = 0;
  for (let i = 0; i < plan.vehicles; i++) { const v = g.vehicles.buyRoad(dep, plan.model, line.id); if (typeof v !== 'string') { bought++; h.stats.vehicles++; } yield; }
  if (!bought) { g.lines.delete(line.id); return fail(key, 'could not buy vehicles', 360); }
  h.managed.set(line.id, { kind: 'bus', towns: [...plan.towns], depot: dep, maxVehicles: Math.max(plan.vehicles + 1, plan.loop ? 6 : 5), opened: g.day });
  h.stats.lines++;
  if (plan.towns.length >= 2) h.stats.coaches++;
  const A = g.towns.list[plan.towns[0]], B = g.towns.list[plan.towns[1]];
  g.postNews(B ? `${g.company(me).name} starts coaches between ${A?.name} and ${B.name}.` : `${g.company(me).name} starts a bus line in ${A?.name ?? 'town'}.`, 'ai', A?.x, A?.z);
  const id = h.canonical(line.id);
  return `opened ${g.lines.get(id)?.name ?? line.name} (${ids.length} stops, ${bought} vehicles; ${plan.why})`;
}

// ============================================================================ a bus line upgraded to trams
/**
 * A town bus line becomes a tram line where its riders pay for it: tram tracks laid in the streets it runs on, stop to
 * stop, so its stops (and their station complexes) become tram stops; the same line (its stops, its waiting passengers,
 * a tram number and name: Lines.retype) runs trams from a tram depot; the buses are sold. Trams seat more and charge the
 * tram fare, so a full bus line gains riders it loses today and receipts per rider. The AI quotes it by the forecast
 * against the buses' earnings (tramUpgradeValue); players use the line window (planTramUpgrade / buildTramUpgrade).
 */
export interface TramUpgrade {
  ok: boolean; error?: string;
  line: number;
  /** the streets of the route; those without tram tracks (laid at TRAM.costPerUnit) and their length */
  edges: number[]; fresh: number[]; trackLength: number; trackCost: number;
  /** a tram depot of ours on the route (else a new one: depotCost) */
  depot: number; depotCost: number;
  model: VehicleModel | null; trams: number; tramCost: number;
  /** what the line's buses fetch when sold */
  resale: number;
  /** tracks, depot and trams less the buses' resale */
  cost: number;
}

/** The street edges a road line runs on, stop to stop (as the tram planner routes: build-ops roadPath); null when a leg has none. */
function lineStreets(g: Game, l: Line): number[] | null {
  const route = routeOf(g, l);
  if (!route) return null;
  const st = route.path.map((id) => g.stations.get(id)).filter((x): x is Station => !!x && x.stops.length > 0);
  if (st.length !== route.path.length) return null;
  const edges = new Set<number>();
  const legs = route.loop ? st.length : st.length - 1;
  for (let i = 0; i < legs; i++) {
    const a = st[i], b = st[(i + 1) % st.length];
    // the stops of the two stations nearest each other
    let pa = a.stops[0], pb = b.stops[0], best = Infinity;
    for (const p of a.stops) for (const q of b.stops) { const d = Math.hypot(p.x - q.x, p.z - q.z); if (d < best) { best = d; pa = p; pb = q; } }
    const path = streetPath(g, pa.x, pa.z, pb.x, pb.z, Math.max(60, best * 3));
    if (!path) return null;
    for (const id of path) edges.add(id);
  }
  return [...edges];
}

/** The tram upgrade of a road line of `owner` (`trams`: how many; default the buses' seats and a quarter more). */
export function planTramUpgrade(g: Game, lineId: number, owner: number, trams?: number): TramUpgrade {
  const net = g.world.net, l = g.lines.get(lineId);
  const out: TramUpgrade = { ok: false, line: lineId, edges: [], fresh: [], trackLength: 0, trackCost: 0, depot: -1, depotCost: 0, model: null, trams: 0, tramCost: 0, resale: 0, cost: 0 };
  const fail = (error: string) => ({ ...out, error });
  if (!l || l.id !== lineId || l.kind !== 'road') return fail('Not a bus line');
  if (l.owner !== owner) return fail('Not your line');
  if (l.vehicles.some((id) => g.vehicles.get(id)?.owner !== owner)) return fail('Partners run buses on it');
  const route = routeOf(g, l);
  if (!route || new Set(route.path).size < 2) return fail('Too few stops');
  const towns = new Set(route.path.map((id) => g.stations.get(id)?.townId ?? -1));
  const T = g.towns.list[[...towns][0] ?? -1];
  const model = pickTram(g.year, T?.pop ?? 3000);
  if (!model) return fail('No trams this year');
  const edges = lineStreets(g, l);
  if (!edges) return fail('No street route between its stops');
  for (const id of edges) {
    const e = net.edges.get(id);
    if (!e) return fail('No street route between its stops');
    if (e.tram && !g.canUse(owner, e.tramOwner ?? -1)) return fail('Tram tracks of another company');
    if (e.owner >= 0 && !g.canUse(owner, e.owner)) return fail('Road of another company');
  }
  const fresh = edges.filter((id) => !net.edges.get(id)!.tram);
  const dry = addTramTracks(g, fresh, owner, true);
  if (dry.error) return fail(dry.error);
  const buses = fleetOf(g, l, owner);
  const seats = buses.vehicles.reduce((a, v) => a + v.capacity, 0);
  const n = trams ?? Math.max(2, Math.min(12, Math.ceil(seats * 1.25 / Math.max(1, model.capacity))));
  // an own tram depot whose exit lies on the route (else a new one)
  const on = new Set(edges);
  let depot = -1;
  for (const d of g.depots.map.values()) if (d.owner === owner && d.kind === 'tram' && net.nodes.get(d.node)?.edges.some((id) => on.has(id))) { depot = d.id; break; }
  const resale = buses.vehicles.reduce((a, v) => a + g.vehicles.resaleValue(v), 0);
  const depotCost = depot >= 0 ? 0 : 120_000;
  const tramCost = n * model.cost;
  return { ok: true, line: lineId, edges, fresh, trackLength: fresh.reduce((a, id) => a + net.edges.get(id)!.len, 0), trackCost: dry.cost, depot, depotCost,
    model, trams: n, tramCost, resale, cost: dry.cost + depotCost + tramCost - resale };
}

/**
 * Build a tram upgrade: the tracks, a depot when the route has none of ours, the line moved over to trams (Lines.retype)
 * and the buses sold. Returns null when done, else why not (tracks laid by it are taken up again). `built`: stations and
 * depots it builds (an AI project's record).
 */
export function* buildTramUpgrade(g: Game, plan: TramUpgrade, owner: number, built?: { depots: number[] }): Generator<void, string | null> {
  const check = planTramUpgrade(g, plan.line, owner, plan.trams);
  if (!check.ok || !check.model) return check.error ?? 'Not possible';
  const e = g.company(owner).economy, need = check.trackCost + check.depotCost + check.tramCost;
  if (e.money < need) return 'Not enough money';
  const laid = addTramTracks(g, check.fresh, owner);
  if (laid.error && laid.changed === 0 && check.fresh.length) return laid.error;
  yield;
  const l = g.lines.get(plan.line)!, stations = [...new Set(l.stops)];
  let dep = -1;
  for (const d of g.depots.map.values()) if (d.owner === owner && d.kind === 'tram' && roadDepotReaches(g, d, stations[0])) { dep = d.id; break; }
  if (dep < 0) {
    dep = yield* tramDepotGen(g, pathPoints(g, check.edges), stations, owner);
    if (dep >= 0) built?.depots.push(dep);
  }
  if (dep < 0 || !stations.every((sid) => roadDepotReaches(g, g.depots.get(dep)!, sid))) {
    removeTramTracks(g, check.fresh.filter((id) => g.world.net.edges.get(id)?.tramOwner === owner), owner);
    return 'No tram depot site on the route';
  }
  for (const v of fleetOf(g, l, owner).vehicles) g.vehicles.sell(v.id);
  g.lines.retype(l.id, 'tram');
  let bought = 0;
  for (let i = 0; i < check.trams; i++) { if (typeof g.vehicles.buyRoad(dep, check.model, l.id) !== 'string') bought++; yield; }
  return bought ? null : 'Could not buy trams';
}

/**
 * The tram upgrade of one of our town bus lines as a project: the trams' forecast (more seats, the tram fare) against
 * the buses' (both calibrated by the line's receipts), the tracks', depot's and trams' costs and upkeep against the
 * buses' running costs and resale. Null when the line cannot take trams.
 */
export function* tramUpgradeValue(h: BusHost, l: Line): Generator<void, RoadPlan | null> {
  const g = h.g, me = h.me, route = routeOf(g, l);
  const base = planTramUpgrade(g, l.id, me);
  if (!base.ok || !base.model || !route) return null;
  const buses = fleetOf(g, l, me);
  if (!buses.model || !buses.vehicles.length) return null;
  const sites = route.path.map((id) => siteOf(g.stations.get(id)!));
  const [before] = yield* busCityForecast(g, me, sites, { model: buses.model, vehicles: buses.vehicles.length, loop: route.loop }, undefined, l.id);
  const cal = calibration(l, before, lineAge(g, l));
  const busYear = buses.vehicles.length * runningCost(g, buses.model, before.hop);
  let best: RoadPlan | null = null;
  const fleets = [base.trams, base.trams + 1];
  const fs = yield* busCityForecast(g, me, sites, { model: base.model, vehicles: base.trams, loop: route.loop }, fleets, l.id);
  for (const [m, n] of fleets.entries()) {
    const up = n === base.trams ? base : planTramUpgrade(g, l.id, me, n);
    const f = fs[m];
    const gain = worth(f, cal) - worth(before, cal);
    // trams' running, the tracks' and depot's upkeep and capital (tracks written off over 30 years), less the buses'
    const fixed = up.trackCost + up.depotCost;
    const yearly = n * runningCost(g, base.model, f.hop) - busYear + up.trackLength * TRAM.maintPerUnit + (up.depot >= 0 ? 0 : 9000)
      + capital(g, me, n * base.model.cost) + fixed * (1 / 30 + (g.company(me).economy.interestRate ?? 0.05));
    const plan: RoadPlan = { kind: 'tram', line: l.id, sites: [], model: base.model, vehicles: n, towns: [...new Set(sites.map((x) => x.townId))].filter((t) => t >= 0),
      revenue: gain, yearly, outlay: Math.max(1, up.cost), upgrade: up,
      why: `${l.name} to trams: +${Math.round(gain / 1000)}k/year against ${Math.round(yearly / 1000)}k, ${n} trams, ${Math.round(up.cost / 1000)}k` };
    if (!best || plan.revenue - plan.yearly > best.revenue - best.yearly) best = plan;
  }
  return best;
}

// ============================================================================ coaches replaced by a railway
/**
 * Busy coach lines of ours a railway between their towns would replace (three coaches or more, earning 20% over their
 * costs, no partner's vehicles): by town pair (AIController pairKey order), the line and its yearly surplus shared over
 * the pairs it serves. The project choice does not count such a line as a rival service for a railway between those
 * towns, and charges the railway the surplus the coaches would forgo (ai.ts chooseProject); retireToRail moves the
 * coaches' riders over once the railway runs.
 */
export function coachUpgrades(h: BusHost): Map<string, { line: number; profit: number }> {
  const g = h.g, out = new Map<string, { line: number; profit: number }>();
  for (const l of g.lines.map.values()) {
    if (l.kind !== 'road' || l.owner !== h.me || l.vehicles.length < 3 || l.vehicles.some((id) => g.vehicles.get(id)?.owner !== h.me)) continue;
    if (!(l.incomeLast > 1.2 * l.costLast)) continue;
    const t = townsOf(g, l);
    if (t.length < 2) continue;
    const pairs: string[] = [];
    for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) pairs.push(t[i] < t[j] ? `${t[i]}-${t[j]}` : `${t[j]}-${t[i]}`);
    for (const k of pairs) if (!out.has(k)) out.set(k, { line: l.id, profit: (l.incomeLast - l.costLast) / pairs.length });
  }
  return out;
}

/**
 * A coach line of ours whose towns a railway of ours now links, station in each town: its stops join the stations'
 * complexes where the walk allows (Stations.link), and once every stop is in one (or within HOLD of a station), the
 * railway takes its riders: the coaches are withdrawn (sold), the railway keeps the line's name (a custom one) and
 * colour. Monthly (ai.ts manage); returns the lines retired.
 */
export function retireToRail(h: BusHost): number {
  const g = h.g, me = h.me;
  let n = 0;
  for (const l of [...g.lines.map.values()]) {
    if (l.kind !== 'road' || l.owner !== me || l.vehicles.some((id) => g.vehicles.get(id)?.owner !== me)) continue;
    const towns = townsOf(g, l);
    if (towns.length < 2) continue;
    const rail = [...g.lines.map.values()].find((r) => r.kind === 'rail' && r.owner === me && r.vehicles.length
      && towns.every((t) => r.stops.some((id) => g.stations.get(id)?.townId === t)));
    if (!rail) continue;
    const stations = [...new Set(rail.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s);
    let all = true;
    for (const sid of new Set(l.stops)) {
      const st = g.stations.get(sid);
      if (!st) { all = false; continue; }
      const near = stations.filter((r) => r.townId === st.townId).sort((a, b) => Math.hypot(a.x - st.x, a.z - st.z) - Math.hypot(b.x - st.x, b.z - st.z))[0];
      if (!near) { all = false; continue; }
      const complex = g.stations.complex(st.id);
      if (!complex.includes(near.id) && g.stations.canLink(st.id, near.id) === null) g.stations.link(st.id, near.id);
      if (!g.stations.complex(st.id).includes(near.id) && Math.hypot(near.x - st.x, near.z - st.z) > HOLD) all = false;
    }
    if (!all) continue;
    if (!l.autoName && rail.autoName) g.lines.rename(rail.id, l.name);
    if (rail.autoColor) g.lines.setColor(rail.id, l.color);
    for (const v of fleetOf(g, l, me).vehicles) g.vehicles.sell(v.id);
    const name = l.name;
    g.lines.delete(l.id);
    h.managed.delete(l.id);
    h.note(`${name}: riders move to ${rail.name}, coaches withdrawn`);
    const st = g.stations.get(rail.stops[0]);
    g.postNews(`${g.company(me).name} replaces ${name} by ${rail.name}.`, 'ai', st?.x, st?.z);
    n++;
  }
  return n;
}

// ============================================================================ a new tram line
/**
 * A tram route the tram planner (ai-tram.ts) proposes, quoted by the road forecast with tram fares: its riders shared with
 * every served stop near it (a copy of another company's trams in the same streets shares their walkers and does not
 * pay), against the tracks, stops, depot and trams, their running and upkeep. The planner opens it only when it pays.
 */
export function* tramRouteValue(g: Game, owner: number, stops: { x: number; z: number }[], trackLength: number, model: VehicleModel, trams: number): Generator<void, { revenue: number; yearly: number; outlay: number; riders: number }> {
  const sites: RoadSite[] = stops.map((s) => ({ x: s.x, z: s.z, townId: g.towns.nearest(s.x, s.z)?.id ?? -1, road: { x: s.x, z: s.z } }));
  const [f] = yield* busCityForecast(g, owner, sites, { model, vehicles: trams, loop: false });
  const fixed = trackLength * TRAM.costPerUnit + stops.length * STOP_COST + 120_000;
  const yearly = trams * runningCost(g, model, f.hop) + trackLength * TRAM.maintPerUnit + stops.length * STOP_UPKEEP + 9000
    + capital(g, owner, trams * model.cost) + fixed * (1 / 30 + (g.company(owner).economy.interestRate ?? 0.05));
  return { revenue: worth(f), yearly, outlay: fixed + trams * model.cost, riders: f.riders };
}
