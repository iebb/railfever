// Regional passenger demand. Towns are split into districts (a centre and outer sectors for towns of 1,500+,
// one region for smaller towns); every region produces trips (from its residents) and attracts them (jobs and
// residents). Two trip purposes (a gravity model): local trips with a strong distance decay (an origin-destination
// matrix: most stay in town or go to the next one), and long-distance trips between towns far apart with a weak
// decay, weighted by both ends' sizes (big towns far apart exchange many). Both are scaled by the trip factor of
// the service (fares.ts tripFactor: expected door-to-door time against the alternative), so fast, frequent and
// direct services unlock more trips. Stations draw passengers from the regions in their catchment; passenger
// generation (game.ts) sends them to the regions the network serves, in proportion to that demand. demandView()
// reports towns, regions, town pairs and the largest regional flows for the UI.
import type { Game } from './game';
import type { Station, StationPlan, RailMode } from './stations';
import { WALK_LINE, PLATFORM_LENGTH, stationLayout } from './stations';
import { routeGraph, routeTables, transferComplexes, type Hop, type RouteEdge } from './lines';
import { tripFactor, refTime, urbanIntensity, estimateLegTime, fareFor, distanceFare, railHistory, transferWalkTime, TRANSFER_FARE_FACTOR, type DemandSite, type FareMode } from './fares';
import type { Building } from './world';
import type { Town } from './towns';
import { DAY_SECONDS, DAYS_PER_MONTH, PASSENGER_RATE_SCALE, WALK_TRIP_INTENSITY, LOCAL_DEMAND_DISTANCE, LOCAL_DEMAND_EXP, LOCAL_SERVED_SHARE, URBAN_DEMAND, MAINLINE_FEEDER_SHARE, MAINLINE_FEEDERS } from './constants';
import { BT_SHOP, BT_OFFICE, BT_TOWER } from './towns';
import { planWalkingCatchment, walkingCatchment, pointWalkingCatchment, walkLimit, pedestrianRoad, walkWeight, coverOf, walkClaimShares, prospectiveWalkGroups, type WalkingCatchment } from './catchment';
import { patternHeadways, linePatterns, lineTable } from './patterns';
import { sampleDemandDestinations } from './demand-sampling';

export interface Region {
  id: number;
  town: number;
  /** 'town': a small town as one region; 'centre' / 'district': centre and outer sectors of a larger town */
  kind: 'town' | 'centre' | 'district';
  /** pop-weighted centre and rough radius (units) */
  x: number; z: number; r: number;
  /** residents and jobs */
  pop: number; jobs: number;
  /** trips per month produced and attracted (the potential, all modes) */
  produced: number; attracted: number;
}

/**
 * Destinations of a station's passengers: reachable stations and their weights (local and long-distance trips,
 * scaled by the trip factor of the service there); `served` = their sum = the station's generation rate factor
 * (1: a station reaching a fair share of its local demand by a typical service).
 */
export interface StationDemand { dest: number[]; w: number[]; served: number }

/**
 * Passengers per catchment inhabitant per GAME day, before (0.2 + rating). The single calendar calibration is
 * PASSENGER_RATE_SCALE: a 2-second game day cannot sustain the old queues between physically timed trains.
 * Apply the same scale to LD_RATE, so local/long-distance shares and tripFactor elasticity keep their meaning.
 */
// Covered residents make 20% more trips after the walking limits shrink; local and regional rates scale together.
// (Walking residents make WALK_TRIP_INTENSITY times these trips: constants.ts.)
export const GEN_RATE = 0.0102 * PASSENGER_RATE_SCALE;
/** Trips per inhabitant per month when covered by a station with a typical rating. */
export const TRIPS_PER_MONTH = GEN_RATE * DAYS_PER_MONTH * (0.2 + 0.65);
/** Towns from this size are split into a centre and outer districts. */
export const DISTRICT_MIN_POP = 1500;

/** Distance decay of local trips (the OD matrix): ~1 nearby, falling off strongly (∝ d^-1.7) between towns. */
export const odDecay = (d: number) => 1 / Math.pow(1 + (d / LOCAL_DEMAND_DISTANCE) * (d / LOCAL_DEMAND_DISTANCE), LOCAL_DEMAND_EXP);
/** Long-distance trips: between towns from LD_MIN units apart (fully from LD_FULL), decaying weakly (∝ d^-0.8). */
export const LD_MIN = 60, LD_FULL = 130;
export const ldDecay = (d: number) => {
  if (d <= LD_MIN) return 0;
  const t = Math.min(1, (d - LD_MIN) / (LD_FULL - LD_MIN));
  return t * t * (3 - 2 * t) * Math.pow(d / 100, -0.8);
};
/** Long-distance trips per inhabitant and month, per 1,000 attraction (jobs + 0.4 residents) at the far end, at 100 units. */
export const LD_RATE = 0.0144 * PASSENGER_RATE_SCALE;
/** Trip factor of a typical service of the game (it leaves the demand as it was); fast direct services earn more. */
export const TF_TYPICAL = 1.3;

/** Trips within a region (across town): a share of its own attraction (many such trips are walked). */
const INTRA = 0.35;
/** Stations closer than this (units) share few trips within a region (people walk). */
const WALK = 25;

/**
 * Only short trips within the same town get the urban uplift, by mode (rail: every track type alike); regional and
 * long-distance OD stay unchanged.
 */
export function localTripMultiplier(g: Game, site: DemandSite, mode: FareMode, quality = 1): number {
  return 1 + URBAN_DEMAND[mode] * urbanIntensity(g, site) * Math.max(0.35, Math.min(1.5, quality));
}
const localCapture = (local: number, localF: number) => local > 0
  ? (0.6 + 0.4 * Math.min(1, local / LOCAL_SERVED_SHARE)) * Math.max(0.6, Math.min(1.6, localF / local)) : 0;
export interface ServiceForecast {
  boardings: number; revenue: number; covered: number; transfers: number;
  /** Annual passengers occupying each adjacent leg, forward first, then reverse. Counts each long rider on every leg. */
  legLoads: number[];
}

function addLegLoad(loads: number[], stops: number, from: number, to: number, passengers: number): void {
  for (let i = Math.min(from, to); i < Math.max(from, to); i++) loads[i + (from > to ? stops - 1 : 0)] += passengers;
}
/**
 * A forecast origin's trip-making population (generationPopulation): its walking residents at WALK_TRIP_INTENSITY plus
 * the car feeders (all - walking) at the base rate, by region; `walking` and `all` are true residents.
 */
function intensified(walking: { pop: number; regions: Map<number, number> }, all: { pop: number; regions: Map<number, number> }) {
  const regions = new Map<number, number>();
  for (const [r, pop] of all.regions) regions.set(r, pop + (WALK_TRIP_INTENSITY - 1) * (walking.regions.get(r) ?? 0));
  return { pop: all.pop + (WALK_TRIP_INTENSITY - 1) * walking.pop, regions };
}
export interface ForecastSite extends DemandSite { walk: WalkingCatchment; length?: number; tracks?: number }
const feederQuality = (headway: number) => Math.max(0, Math.min(1,
  (MAINLINE_FEEDERS.cutoffHeadway - headway) / (MAINLINE_FEEDERS.cutoffHeadway - MAINLINE_FEEDERS.fullHeadway)));
interface FeederSite extends DemandSite { quality: number; access?: { x: number; z: number }[] }
interface FeederPool { pop: number; regions: Map<number, number> }
const feederPoolMemo = new WeakMap<DemandModel, { stamp: string; entries: { sig: number[]; covered: Set<number>; pools: FeederPool[] }[] }>();
const feederSites = new WeakMap<DemandModel, { key: string; sites: Map<string, Map<number, number>> }>();
const feederClaims = new WeakMap<DemandModel, {
  bids: number[]; sums: number[]; qualities: number[]; first: number[]; last: number[];
  indices: number[]; weights: number[]; next: number[];
  claimById: Uint32Array;
}>();
type ForecastPoint = StationPlan | Station | ForecastSite;
const forecastStation = (p: ForecastPoint): Station | null => 'id' in p ? p : 'join' in p ? p.join : null;
/** Same passenger areas as the committed facility, including native curves and an inherited joined stop. */
function plannedStation(p: StationPlan, id: number, owner?: number, townId = -1): Station {
  return { ...(p.join ?? { stops: [], links: [] }), id, owner: owner ?? p.join?.owner ?? 0,
    x: p.x, z: p.z, townId: p.join?.townId ?? townId, city: p.city, rail: {
      x: p.x, z: p.z, y: p.y, angle: p.angle, length: p.length, tracks: p.tracks,
      level: p.level, underground: p.underground, depth: p.depth, height: p.height, alignment: p.alignment, style: p.style,
      mode: p.mode, trackType: p.trackType,
      width: p.layout.width, trackOffsets: p.layout.trackOffsets, platforms: p.layout.platforms,
    } } as Station;
}

/** City rides of a complete routed transfer journey, with the fare history of each boarding. */
export function forecastTransferJourney(tables: Map<number, Map<number, Hop>>, from: number, destination: number,
  cityLine: number, isRail: (line: number) => boolean, railFare: (from: number, to: number) => number,
  sameComplex: (a: number, b: number) => boolean = () => false
): { from: number; to: number; railBefore: number; changes: number }[] {
  const rides: { line: number; from: number; to: number }[] = [], seen = new Set<number>();
  let at = from, aboard = false;
  while (at !== destination && !seen.has(at)) {
    seen.add(at);
    const hop = tables.get(at)?.get(destination); if (!hop) break;
    if (hop.line === WALK_LINE) aboard = false;
    else {
      const last = rides[rides.length - 1];
      // Consecutive hops on one vehicle keep their original boarding and fare history (Vehicle.serveStation).
      if (aboard && last?.line === hop.line) last.to = hop.alight;
      else rides.push({ line: hop.line, from: at, to: hop.alight });
      aboard = true;
    }
    at = hop.alight;
  }
  if (at !== destination || rides.length < 2) return [];
  let railBefore = 0, changesBefore = 0;
  return rides.flatMap((ride, before) => {
    const history = railBefore;
    const next = rides[before + 1];
    const endingChange = next ? !sameComplex(ride.to, next.from) : ride.to !== destination && !sameComplex(ride.to, destination);
    const changes = changesBefore + (endingChange ? 1 : 0);
    changesBefore += endingChange ? 1 : 0;
    if (isRail(ride.line)) railBefore = railHistory(railBefore + railFare(ride.from, ride.to));
    return ride.line === cityLine ? [{ from: ride.from, to: ride.to, railBefore: history,
      // Passenger receipts apply changes already made and the change at this leg's end, not later changes.
      changes }] : [];
  });
}

/** Residents and jobs of a building. */
function residentsJobs(b: Building): [number, number] {
  if (b.type === BT_SHOP) return [b.pop * 0.3, b.pop];
  if (b.type === BT_OFFICE) return [0, b.pop * 1.2];
  if (b.type === BT_TOWER) return [b.pop * 0.4, b.pop * 0.9];
  return [b.pop, 0];
}

/** Can a station take part in passenger traffic? (ground rail stations need road access; stations.ts) */
export function stationActive(g: Game, st: Station): boolean {
  const s = g.stations as unknown as { hasAccess?: (st: Station) => boolean };
  if ((st as unknown as { roadAccess?: boolean }).roadAccess === false) return false;
  return s.hasAccess ? s.hasAccess(st) !== false : true;
}

const NO_DEMAND: StationDemand = { dest: [], w: [], served: 0 };

/** The regional demand model of a game (kept in game.demand, saved with it). */
export class DemandModel {
  /** Disposable overlap-only work counts for planner diagnostics. */
  forecastClaimStats = { buildings: 0, oldRecords: 0, newRecords: 0 };
  regions: Region[] = [];
  /** per town: district layout (core radius, sector count) and its region ids (centre / the town first) */
  private towns = new Map<number, { core: number; sectors: number; ids: number[] }>();
  /** od[r * n + q]: share of the local trips produced in r that go to q (rows sum to 1; r -> r: across the region) */
  od = new Float32Array(0);
  /** ld[r * n + q]: long-distance trips per inhabitant of r and month to q (other towns far away; 0 within a town) */
  ld = new Float32Array(0);
  /** per station: [region, share of its catchment population] */
  shares = new Map<number, [number, number][]>();
  /** bumped when regions or station shares change */
  version = 0;
  /** distance decay between regions, dec[r * n + q] (r == q: within the region) */
  private dec = new Float32Array(0);
  /** next town to refresh (a few per day, see daily) */
  private cursor = 0;
  private cache = new Map<number, StationDemand>();
  /** Private rows for the current weights sweep; public coverage queries still return fresh arrays. */
  private weightCoverage = new WeakMap<Station, { walking?: [number, number][]; regional?: [number, number][] }>();
  private cacheKey = '';
  private feederKey = '';
  private feeders = new Map<number, FeederPool>();
  private feederWalkKey = '';
  private forecastGraphKey = '';
  private forecastRouting: Game['lines']['routing'] | null = null;
  private forecastGraph = new Map<number, { to: number; line: number; cost: number }[]>();
  private feederWalks = new Map<string, Map<number, number>>();

  constructor(private g: Game) {}

  /** Region of a building (-1: none). */
  regionOf(b: Building): number {
    const t = this.towns.get(b.townId);
    if (!t) return -1;
    if (!t.sectors) return t.ids[0];
    const town = this.g.towns.list[b.townId];
    if (!town) return t.ids[0];
    const dx = b.x - town.x, dz = b.z - town.z;
    if (dx * dx + dz * dz <= t.core * t.core) return t.ids[0];
    const k = Math.min(t.sectors - 1, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * t.sectors));
    return t.ids[1 + k];
  }

  /** District layout of a town by its size. */
  private layoutOf(t: Town): { sectors: number; core: number } {
    const split = t.pop >= DISTRICT_MIN_POP;
    return { sectors: !split ? 0 : t.pop < 3000 ? 3 : t.pop < 6000 ? 4 : 6, core: split ? Math.max(8, t.radius * 0.4) : 0 };
  }

  /** All regions from the towns as they are now, and the OD matrix (new games, and when a town's layout changes). */
  rebuild() {
    const g = this.g;
    this.regions = [];
    this.towns.clear();
    for (const t of g.towns.list) {
      const lay = this.layoutOf(t);
      const ids: number[] = [];
      const add = (kind: Region['kind']) => { const id = this.regions.length; this.regions.push({ id, town: t.id, kind, x: t.x, z: t.z, r: 0, pop: 0, jobs: 0, produced: 0, attracted: 0 }); ids.push(id); };
      if (!lay.sectors) add('town'); else { add('centre'); for (let k = 0; k < lay.sectors; k++) add('district'); }
      this.towns.set(t.id, { core: lay.core, sectors: lay.sectors, ids });
    }
    for (const t of g.towns.list) this.aggregateTown(t);
    this.computeDecay();
    this.computeOD();
    this.version++;
    // region ids changed: the stations' shares are worked out again
    this.shares.clear();
    if (g.lines) g.lines.catchmentDirty = true;
  }

  /**
   * A town's district layout changed (it grew past a size step): its regions are made anew and aggregated; the
   * other towns keep theirs (renumbered), so this costs one town instead of a full rebuild.
   */
  private relayout(t: Town) {
    const g = this.g, old = this.regions, oldTowns = this.towns;
    this.regions = [];
    this.towns = new Map();
    const remap = new Map<number, number>();
    for (const tw of g.towns.list) {
      const prev = oldTowns.get(tw.id);
      const ids: number[] = [];
      if (prev && tw.id !== t.id) {
        for (const oid of prev.ids) { const id = this.regions.length; this.regions.push({ ...old[oid], id }); ids.push(id); remap.set(oid, id); }
        this.towns.set(tw.id, { core: prev.core, sectors: prev.sectors, ids });
        continue;
      }
      const lay = this.layoutOf(tw);
      const add = (kind: Region['kind']) => { const id = this.regions.length; this.regions.push({ id, town: tw.id, kind, x: tw.x, z: tw.z, r: 0, pop: 0, jobs: 0, produced: 0, attracted: 0 }); ids.push(id); };
      if (!lay.sectors) add('town'); else { add('centre'); for (let k = 0; k < lay.sectors; k++) add('district'); }
      this.towns.set(tw.id, { core: lay.core, sectors: lay.sectors, ids });
    }
    for (const tw of g.towns.list) if (tw.id === t.id || !oldTowns.has(tw.id)) this.aggregateTown(tw);
    // stations keep their shares of the other towns' regions; the town's own come with the next catchment update
    for (const [sid, arr] of [...this.shares]) {
      const kept = arr.filter(([r]) => remap.has(r)).map(([r, v]) => [remap.get(r)!, v] as [number, number]);
      if (kept.length) this.shares.set(sid, kept); else this.shares.delete(sid);
    }
    if (g.lines) g.lines.catchmentDirty = true;
    this.computeDecay();
    this.computeOD();
    this.version++;
  }

  /** Residents, jobs, centre and extent of a town's regions (from its buildings); returns their ids. */
  private aggregateTown(t: Town): number[] {
    const lay = this.towns.get(t.id);
    if (!lay) return [];
    const acc = new Float64Array(lay.ids.length * 4); // sum w x, sum w z, sum w, sum w (x² + z²)
    for (const id of lay.ids) { const R = this.regions[id]; R.pop = 0; R.jobs = 0; }
    const base = lay.ids[0];
    for (const bid of t.buildings) {
      const b = this.g.world.buildings.get(bid);
      if (!b || b.pop <= 0) continue;
      const r = this.regionOf(b);
      if (r < base || r >= base + lay.ids.length) continue;
      const [res, jobs] = residentsJobs(b);
      const R = this.regions[r], k = (r - base) * 4;
      R.pop += res; R.jobs += jobs;
      acc[k] += b.x * b.pop; acc[k + 1] += b.z * b.pop; acc[k + 2] += b.pop; acc[k + 3] += b.pop * (b.x * b.x + b.z * b.z);
    }
    for (const id of lay.ids) {
      const R = this.regions[id], k = (id - base) * 4, w = acc[k + 2];
      if (w > 0) { R.x = acc[k] / w; R.z = acc[k + 1] / w; } else { R.x = t.x; R.z = t.z; }
      R.r = w > 0 ? Math.sqrt(Math.max(0, acc[k + 3] / w - R.x * R.x - R.z * R.z)) * 1.5 + 4 : 6;
      R.produced = TRIPS_PER_MONTH * (R.pop + 0.3 * R.jobs);
      R.attracted = 0.4 * R.pop + R.jobs;
    }
    return lay.ids;
  }

  /**
   * Daily upkeep: a few towns' regions are refreshed (each town about every two weeks) and the OD matrix updated;
   * a town that changes its district layout (grows past a threshold) rebuilds the model.
   */
  daily() {
    const T = this.g.towns.list;
    if (!T.length) return;
    if (!this.regions.length || this.towns.size !== T.length) { this.rebuild(); return; }
    const k = Math.max(1, Math.ceil(T.length / 15));
    const changed: number[] = [];
    for (let i = 0; i < k; i++) {
      const t = T[this.cursor % T.length];
      this.cursor = (this.cursor + 1) % T.length;
      const lay = this.towns.get(t.id), want = this.layoutOf(t);
      if (!lay) { this.rebuild(); return; }
      if (want.sectors !== lay.sectors) { this.relayout(t); return; }
      lay.core = want.core;
      changed.push(...this.aggregateTown(t));
    }
    this.updateDecay(changed);
    this.computeOD();
    this.version++;
  }

  /** Distance decay between all region centres (and within each region). */
  private computeDecay() {
    const n = this.regions.length, R = this.regions;
    this.dec = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      this.dec[r * n + r] = odDecay(R[r].r);
      for (let q = r + 1; q < n; q++) { const d = odDecay(Math.hypot(R[r].x - R[q].x, R[r].z - R[q].z)); this.dec[r * n + q] = d; this.dec[q * n + r] = d; }
    }
  }

  private updateDecay(ids: number[]) {
    const n = this.regions.length, R = this.regions;
    if (this.dec.length !== n * n) { this.computeDecay(); return; }
    for (const r of ids) {
      this.dec[r * n + r] = odDecay(R[r].r);
      for (let q = 0; q < n; q++) if (q !== r) { const d = odDecay(Math.hypot(R[r].x - R[q].x, R[r].z - R[q].z)); this.dec[r * n + q] = d; this.dec[q * n + r] = d; }
    }
  }

  private computeOD() {
    const n = this.regions.length, R = this.regions, dec = this.dec;
    if (dec.length !== n * n) this.computeDecay();
    if (this.od.length !== n * n) this.od = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      let sum = 0;
      for (let q = 0; q < n; q++) {
        const w = q === r ? R[r].attracted * this.dec[r * n + r] * INTRA : R[q].attracted * this.dec[r * n + q];
        this.od[r * n + q] = w;
        sum += w;
      }
      if (sum > 0) for (let q = 0; q < n; q++) this.od[r * n + q] /= sum;
    }
    // long-distance trips: gravity between regions of towns far apart (weak decay, by the far end's attraction)
    if (this.ld.length !== n * n) this.ld = new Float32Array(n * n);
    for (let r = 0; r < n; r++) for (let q = 0; q < n; q++) {
      if (R[r].town === R[q].town) { this.ld[r * n + q] = 0; continue; }
      const d = Math.hypot(R[r].x - R[q].x, R[r].z - R[q].z);
      this.ld[r * n + q] = LD_RATE * (R[q].attracted / 1000) * ldDecay(d);
    }
  }

  /** Potential trips per month from region r to region q (all modes): local (OD share of r's trips) plus long-distance. */
  trips(r: number, q: number): number {
    const n = this.regions.length, R = this.regions;
    if (r < 0 || q < 0 || r >= n || q >= n) return 0;
    const town = this.g.towns.list[R[r].town];
    const local = R[r].town === R[q].town && town
      ? 1 + 6 * urbanIntensity(this.g, { ...R[r], townId: town.id }) : 1;
    return R[r].produced * this.od[r * n + q] * local + R[r].pop * (this.ld[r * n + q] ?? 0);
  }

  /** A consistent demand snapshot for planners that yield across days. Daily aggregation mutates both
   * regions and OD arrays, so a long-running planner must not mix rows from different updates. */
  tripSnapshot() {
    const regions = this.regions.map((r) => ({ ...r })), n = regions.length;
    const od = this.od.slice(), ld = this.ld.slice();
    const local = regions.map((r) => {
      const town = this.g.towns.list[r.town];
      return town ? 1 + 6 * urbanIntensity(this.g, { ...r, townId: town.id }) : 1;
    });
    return { regions, trips: (r: number, q: number) => {
      if (r < 0 || q < 0 || r >= n || q >= n) return 0;
      const from = regions[r], to = regions[q];
      return from.produced * od[r * n + q] * (from.town === to.town ? local[r] : 1)
        + from.pop * (ld[r * n + q] ?? 0);
    } };
  }

  // ---------------------------------------------------------------- service quality (trip factor)
  /**
   * Trip factor (fares.ts tripFactor, relative to a typical service: TF_TYPICAL) of travelling from st to d by the
   * network: the routed journey's expected time (Hop.cost, sim seconds: half the headway of the services worth
   * taking, the rides, and the transfers with their penalty) against the alternative (walking / driving) for the
   * straight distance. Fast, frequent, direct services: above 1; slow, sparse or roundabout ones: below.
   */
  serviceFactor(st: Station, d: Station, hop: Hop): number {
    const centre = st.townId >= 0 && st.townId === d.townId ? Math.min(urbanIntensity(this.g, st), urbanIntensity(this.g, d)) : 0;
    return tripFactor(Math.max(1, hop.cost), refTime(Math.hypot(d.x - st.x, d.z - st.z), centre)) / TF_TYPICAL;
  }

  /** Only actual cross-town rail patterns (any track type) attract car feeders; combine their scheduled frequencies. */
  private mainlineFrequency(st: Station): number {
    let frequency = 0;
    for (const l of this.g.lines.map.values()) {
      if (l.kind !== 'rail' || !l.stops.includes(st.id) || !l.stops.some((id) => {
        const s = this.g.stations.get(id); return s?.rail && s.townId !== st.townId;
      })) continue;
      for (const h of patternHeadways(this.g, l)) {
        const p = linePatterns(l).find((p) => p.id === h.pid);
        if (h.headway > 0 && l.stops.some((id, i) => id === st.id && p?.stops[i] !== false)) frequency += 1 / h.headway;
      }
    }
    return frequency > 0 ? feederQuality(1 / frequency) : 0;
  }

  /** Cars can approach a forecourt on a road bridge/ramp. Follow that real road to an at-grade street before
   * using the bounded street/frontage search; a ground-only walking entrance cannot seed on the bridge. */
  private feederAccess(x: number, z: number, budget: number): { x: number; z: number; cost: number }[] {
    const g = this.g, net = g.world.net, nearest = net.nearestEdge(x, z, 8, 'road', pedestrianRoad);
    if (!nearest) return [];
    const seeds: { x: number; z: number; cost: number }[] = [], nodes = new Map<number, number>();
    const pending: { edge: number; s: number; cost: number; dir: number }[] = [
      { edge: nearest.edge.id, s: nearest.s, cost: nearest.d, dir: -1 },
      { edge: nearest.edge.id, s: nearest.s, cost: nearest.d, dir: 1 },
    ];
    for (let k = 0; k < pending.length && k < 160; k++) {
      const step = pending[k], e = net.edges.get(step.edge); if (!e || step.cost >= budget) continue;
      const end = step.dir > 0 ? e.len : 0, length = Math.abs(end - step.s);
      let found = false;
      for (let d = 0; d <= length + 2; d += 2) {
        const at = Math.min(length, d), cost = step.cost + at, s = step.s + step.dir * at;
        if (cost >= budget) break;
        const p = { x: 0, y: 0, z: 0 }; net.pointAt(e, s, p);
        if (net.sectionAt(e, s) === 'ground' && Math.abs(p.y - g.world.heightAt(p.x, p.z)) < 0.8) {
          seeds.push({ ...p, cost }); found = true; break;
        }
        if (at === length) break;
      }
      if (found) continue;
      const id = step.dir > 0 ? e.b : e.a, cost = step.cost + length;
      if (cost >= budget || cost >= (nodes.get(id) ?? Infinity)) continue;
      nodes.set(id, cost);
      for (const edge of net.nodes.get(id)?.edges ?? []) {
        const road = net.edges.get(edge); if (!road || !pedestrianRoad(road) || edge === e.id) continue;
        pending.push({ edge, s: road.a === id ? 0 : road.len, cost, dir: road.a === id ? 1 : -1 });
      }
    }
    return seeds;
  }

  /** Town-pair proposals revisit the same station access with different frequencies. Cache only geometry;
   * population, competing claims, eligibility and service quality are still calculated for each proposal. */
  private feederGeometryKey(): string {
    const g = this.g;
    return `${g.world.net.version}:${g.lines.version}:${g.world.heightsVersion}:${g.world.nextBuildingId}:${g.world.buildings.size}`;
  }

  private feederWalk(x: number, z: number, reach: number): Map<number, number> {
    const g = this.g, key = this.feederGeometryKey();
    if (key !== this.feederWalkKey) { this.feederWalkKey = key; this.feederWalks.clear(); }
    const site = `${x}:${z}:${reach}`, cached = this.feederWalks.get(site);
    if (cached) return cached;
    const buildings = new Map<number, number>();
    const seen = new Set<string>();
    for (const entry of this.feederAccess(x, z, reach)) {
      // On an at-grade road both search directions start at the same point. Walk it once; raised
      // roads can have different ramp exits, which remain separate seeds.
      const seed = `${entry.x}:${entry.z}:${entry.cost}`;
      if (seen.has(seed)) continue;
      seen.add(seed);
      const remaining = reach - entry.cost;
      const walk = pointWalkingCatchment(g, entry.x, entry.z, 'rail', remaining / walkLimit('rail') - 1, 0.05);
      for (const [bid, w] of walk.buildings) buildings.set(bid, Math.min(buildings.get(bid) ?? Infinity, w.distance + entry.cost));
    }
    if (this.feederWalks.size >= 256) this.feederWalks.clear();
    this.feederWalks.set(site, buildings);
    return buildings;
  }

  /** Merge an access site's walks once, in their original lot order. Frequencies and competing claims use
   * these distances repeatedly; no populations, district ids or quality weights belong in this cache. */
  private feederSiteWalk(s: FeederSite): Map<number, number> {
    const key = this.feederGeometryKey();
    let memo = feederSites.get(this);
    if (!memo || memo.key !== key) {
      memo = { key, sites: new Map() };
      feederSites.set(this, memo);
    }
    const access = s.access?.length ? s.access : [s];
    let site = `${s.x}:${s.z}:${MAINLINE_FEEDERS.reach}`;
    for (const p of access) site += `:${p.x}:${p.z}`;
    const cached = memo.sites.get(site);
    if (cached) return cached;
    const buildings = new Map<number, number>();
    for (const p of access) {
      const leg = Math.hypot(p.x - s.x, p.z - s.z), reach = MAINLINE_FEEDERS.reach - leg;
      if (reach <= 0) continue;
      for (const [bid, distance] of this.feederWalk(p.x, p.z, reach))
        buildings.set(bid, Math.min(buildings.get(bid) ?? Infinity, distance + leg));
    }
    if (memo.sites.size >= 256) memo.sites.clear();
    memo.sites.set(site, buildings);
    return buildings;
  }

  /** Forecasts of one service at several frequencies repeat the same claim (a quality below the feeder
   * threshold claims nothing). Reuse an identical claim within the same tick and world state (performance only). */
  private feederPools(sites: FeederSite[], covered: Set<number>): FeederPool[] {
    const w = this.g.world;
    const stamp = `${this.version}:${this.g.tick}:${this.feederGeometryKey()}:${w.lotVersions.version}`;
    const sig: number[] = [];
    for (const s of sites) {
      sig.push(s.x, s.z, s.townId, s.quality, s.access?.length ?? -1);
      for (const a of s.access ?? []) sig.push(a.x, a.z);
    }
    let memo = feederPoolMemo.get(this);
    if (!memo || memo.stamp !== stamp) { memo = { stamp, entries: [] }; feederPoolMemo.set(this, memo); }
    const copy = (pools: FeederPool[]) => pools.map((p) => ({ pop: p.pop, regions: new Map(p.regions) }));
    for (const e of memo.entries) {
      if (e.sig.length !== sig.length || e.covered.size !== covered.size) continue;
      let same = true;
      for (let i = 0; i < sig.length && same; i++) same = Object.is(e.sig[i], sig[i]);
      if (same) for (const bid of covered) if (!e.covered.has(bid)) { same = false; break; }
      if (same) return copy(e.pools);
    }
    const pools = this.claimFeederPools(sites, covered);
    if (memo.entries.length >= 8) memo.entries.shift();
    memo.entries.push({ sig, covered: new Set(covered), pools: copy(pools) });
    return pools;
  }

  /** A separate car feeder pool, never a wider walking catchment. Catchments with an existing intercity route
   * are excluded: those residents already enter through routed feeder transfers. A local-only bus does not
   * supply a railway it cannot reach. Competing main-line stations share every lot once. */
  private claimFeederPools(sites: FeederSite[], covered: Set<number>): FeederPool[] {
    const result = sites.map(() => ({ pop: 0, regions: new Map<number, number>() }));
    // Each lot has a numeric claim index, avoiding a claim object per lot on every forecast. Parallel arrays
    // retain first-claim insertion order and the linked site order, including the original floating-point sums.
    const buffers = feederClaims.get(this) ?? { bids: [], sums: [], qualities: [], first: [], last: [], indices: [], weights: [], next: [], claimById: new Uint32Array(256) };
    // A nested read gets independent scratch; an exception simply discards this disposable buffer.
    feederClaims.delete(this);
    // Native lot ids are dense. Bound the lookup table, and keep sparse or non-integer legacy ids in a Map.
    // Zero means unclaimed; touched entries are cleared before scratch can be reused, without an aging stamp.
    const limit = this.g.world.nextBuildingId <= 65536 ? this.g.world.nextBuildingId : 0;
    if (limit > buffers.claimById.length) {
      let size = buffers.claimById.length;
      while (size < limit) size *= 2;
      buffers.claimById = new Uint32Array(size);
    }
    const { bids, sums, qualities, first, last, indices, weights, next } = buffers;
    const claimById = buffers.claimById;
    let sparse: Map<number, number> | undefined;
    let claimCount = 0, rowCount = 0;
    sites.forEach((s, i) => {
      if (s.quality <= 0 || (this.g.towns.list[s.townId]?.pop ?? 0) < 1500) return;
      const buildings = this.feederSiteWalk(s);
      for (const [bid, distance] of buildings) {
        const b = this.g.world.buildings.get(bid);
        if (!b || b.townId !== s.townId || covered.has(bid)) continue;
        const dense = bid >= 0 && bid < claimById.length && Number.isInteger(bid);
        const claim = dense ? claimById[bid] - 1 : sparse?.get(bid) ?? -1;
        const k = rowCount++, weight = s.quality / (1 + distance / 30);
        indices[k] = i; weights[k] = weight; next[k] = -1;
        if (claim >= 0) {
          sums[claim] += weight; qualities[claim] = Math.max(qualities[claim], s.quality);
          next[last[claim]] = k; last[claim] = k;
        } else {
          const c = claimCount++;
          if (dense) claimById[bid] = c + 1;
          else (sparse ??= new Map()).set(bid, c);
          bids[c] = bid; sums[c] = weight; qualities[c] = s.quality; first[c] = k; last[c] = k;
        }
      }
    });
    for (let claim = 0; claim < claimCount; claim++) {
      const bid = bids[claim];
      if (bid >= 0 && bid < claimById.length && Number.isInteger(bid)) claimById[bid] = 0;
      const b = this.g.world.buildings.get(bid)!, r = this.regionOf(b); if (r < 0) continue;
      for (let k = first[claim]; k >= 0; k = next[k]) {
        const pop = b.pop * MAINLINE_FEEDERS.share * qualities[claim] * weights[k] / sums[claim], pool = result[indices[k]];
        pool.pop += pop; pool.regions.set(r, (pool.regions.get(r) ?? 0) + pop);
      }
    }
    // Retain ordinary query buffers only; a large UI query cannot pin unbounded scratch in the game.
    if (next.length <= 16384 && bids.length <= 8192) feederClaims.set(this, buffers);
    return result;
  }

  private feederSite(st: Station): FeederSite {
    const r = st.rail, forecourt = this.g.stations.forecourt(st);
    const access = [forecourt, r?.forecourt2, ...(r?.entrances ?? [])].filter((p): p is { x: number; z: number } => !!p);
    return { ...st, quality: this.mainlineFrequency(st), access };
  }

  /**
   * Buildings within `reach` units of a railway station by road from its forecourts and entrances, with their
   * distances: the car feeders' geometry (feederPools), for the mail feeders (mail.ts). Reads the network only (the
   * walks are cached geometry): the passenger demand is untouched.
   */
  feederReach(st: Station, reach: number): Map<number, number> {
    const r = st.rail, forecourt = this.g.stations.forecourt(st);
    return this.feederReachAt(st, [forecourt, r?.forecourt2, ...(r?.entrances ?? [])].filter((p): p is { x: number; z: number } => !!p), reach);
  }

  /** feederReach of a site with these road accesses (a planned station: its access street's ends; none: the site). */
  feederReachAt(site: { x: number; z: number }, access: { x: number; z: number }[] | undefined, reach: number): Map<number, number> {
    const buildings = new Map<number, number>();
    for (const p of access?.length ? access : [site]) {
      const leg = Math.hypot(p.x - site.x, p.z - site.z), left = reach - leg;
      if (left <= 0) continue;
      for (const [bid, distance] of this.feederWalk(p.x, p.z, left)) buildings.set(bid, Math.min(buildings.get(bid) ?? Infinity, distance + leg));
    }
    return buildings;
  }

  /**
   * Walking residents (at WALK_TRIP_INTENSITY: the trips they make, in residents of the base rate) plus separately
   * claimed car feeders, including park-and-ride with no walking lots.
   */
  generationPopulation(st: Station): number {
    this.refreshFeeders();
    return st.catchPop * WALK_TRIP_INTENSITY + (this.feeders.get(st.id)?.pop ?? 0);
  }

  private refreshFeeders() {
    const key = `${this.version}:${this.g.lines.version}:${this.g.networkVersion}`;
    if (this.feederKey === key) return;
    this.feederKey = key; this.feeders.clear();
    const covered = new Set<number>(), stations: Station[] = [];
    for (const st of this.g.stations.map.values()) {
      if (!stationActive(this.g, st) || !this.g.lines.stationServed(st.id)) continue;
      if ([...(this.g.lines.routing.get(st.id)?.keys() ?? [])].some((id) => this.g.stations.get(id)?.townId !== st.townId))
        for (const bid of walkingCatchment(this.g, st).buildings.keys()) covered.add(bid);
      if (st.rail) stations.push(st);
    }
    const pools = this.feederPools(stations.map((st) => this.feederSite(st)), covered);
    stations.forEach((st, i) => this.feeders.set(st.id, pools[i]));
  }

  /** Which regions each station's catchment covers (after catchments change; game.ts / lines.ts call it). */
  recomputeShares() {
    const g = this.g, w = g.world;
    this.shares.clear();
    // Strict walking catchment: demand uses the same distance-weighted building shares as passenger generation.
    for (const st of g.stations.map.values()) {
      if (!stationActive(g, st)) continue;
      const m = new Map<number, number>();
      const sh = g.stations.buildingShares(st);
      for (let i = 0; i < sh.ids.length; i++) {
        const b = w.buildings.get(sh.ids[i]);
        if (!b || b.pop <= 0) continue;
        const r = this.regionOf(b);
        if (r >= 0) m.set(r, (m.get(r) ?? 0) + b.pop * sh.w[i]);
      }
      let tot = 0;
      for (const v of m.values()) tot += v;
      if (tot > 0) this.shares.set(st.id, [...m].sort((a, b) => a[0] - b[0]).map(([r, v]) => [r, v / tot]));
    }
    this.version++;
  }

  /** Coverage of each region by a station (share of the region's residents it serves), [region, coverage][]. */
  coverage(st: Station, feeders = true): [number, number][] {
    this.refreshFeeders();
    return this.coverageSnapshot(st, feeders);
  }

  /** UI estimate from the last computed walking shares and feeder pools; never refreshes access or catchments. */
  coverageSnapshot(st: Station, feeders = true): [number, number][] {
    const sh = this.shares.get(st.id);
    const pops = new Map((sh ?? []).map(([r, s]) => [r, st.catchPop * s]));
    for (const [r, pop] of (feeders ? this.feeders.get(st.id)?.regions : undefined) ?? []) pops.set(r, (pops.get(r) ?? 0) + pop);
    return [...pops].map(([r, pop]) => [r, Math.min(1, pop / Math.max(1, this.regions[r]?.pop ?? 1))]);
  }

  /**
   * The mode carrying a routed journey from station `from` to `dest`: rail when a rail line with vehicles carries any
   * of its legs (whatever platforms the stations have: an unused rail platform at a bus stop adds nothing), else tram
   * when a tram line does, else bus.
   */
  private journeyMode(from: number, dest: number, hop: Hop): FareMode {
    const g = this.g;
    let mode: FareMode = 'bus', h: Hop | undefined = hop;
    for (let legs = 0; h && legs < 8; legs++) {
      for (const id of h.lines ?? [h.line]) {
        const l = g.lines.get(id);
        if (!l || !l.vehicles.length) continue;
        if (l.kind === 'rail') return 'rail';
        if (l.kind === 'tram') mode = 'tram';
      }
      if (h.alight === dest || h.alight === from) break;
      h = g.lines.routing.get(h.alight)?.get(dest);
    }
    return mode;
  }

  /**
   * Destinations of a station's passengers by OD demand (cached for the day, until routing or catchments change).
   * Large networks rotate a bounded set of actual destinations daily; their block weights approximate the full
   * OD totals. Small networks keep the exact calculation. Physical routing and receipts remain native.
   * The day, the town lots and the fleet are part of the key: the urban uplift follows towns as they grow
   * (urbanIntensity) and the services that carry each journey (journeyMode), which change without a routing or
   * network version; a game loaded later that day works out the same weights as the one that went on.
   */
  weights(st: Station): StationDemand {
    const g = this.g;
    const key = g.day + ':' + g.world.lotVersions.version + ':' + g.vehicles.map.size + ':' + g.lines.version + ':' + this.version + ':' + g.networkVersion;
    if (key !== this.cacheKey) { this.cache.clear(); this.weightCoverage = new WeakMap(); this.cacheKey = key; }
    const c = this.cache.get(st.id);
    if (c) return c;
    this.refreshFeeders();
    const table = g.lines.routing.get(st.id), walkingOrigin = this.shares.get(st.id);
    // (walkers make WALK_TRIP_INTENSITY times the trips of the car feeders: generationPopulation)
    const pool = this.feeders.get(st.id), walkers = st.catchPop * WALK_TRIP_INTENSITY, originPop = walkers + (pool?.pop ?? 0);
    const pops = new Map((walkingOrigin ?? []).map(([r, s]) => [r, walkers * s]));
    for (const [r, pop] of pool?.regions ?? []) pops.set(r, (pops.get(r) ?? 0) + pop);
    const origin = [...pops].map(([r, pop]) => [r, pop / Math.max(1, originPop)] as [number, number]);
    if (!table || !origin.length || !this.regions.length || !stationActive(g, st)) { this.cache.set(st.id, NO_DEMAND); return NO_DEMAND; }
    const n = this.regions.length, od = this.od, ld = this.ld;
    const parts: { d: number; x: number; y: number; f: number; local: number; feeder: number }[] = [];
    let local = 0, localF = 0;
    const destinations: Station[] = [];
    for (const d of table.keys()) {
      const ds = g.stations.get(d);
      if (ds && stationActive(g, ds)) destinations.push(ds);
    }
    for (const { destination: ds, weight } of sampleDemandDestinations(st, g.day, destinations)) {
      const d = ds.id, hop = table.get(d)!;
      // local trips (the OD share) and long-distance trips (relative to the local trip rate) to d's regions
      let x = 0, y = 0;
      const walk = Math.min(1, Math.hypot(ds.x - st.x, ds.z - st.z) / WALK);
      const sameTown = st.townId >= 0 && st.townId === ds.townId;
      const source = sameTown ? walkingOrigin ?? [] : origin;
      let row = this.weightCoverage.get(ds);
      if (!row) { row = {}; this.weightCoverage.set(ds, row); }
      const coverageMode = sameTown ? 'walking' : 'regional';
      const coverage = row[coverageMode] ??= this.coverageSnapshot(ds, !sameTown);
      for (const [q, cov] of coverage) for (const [r, sr] of source) {
        if (r >= n || q >= n) continue;
        x += sr * od[r * n + q] * cov * (r === q ? walk : 1);
        y += sr * (ld[r * n + q] ?? 0) * cov;
      }
      x *= weight;
      y /= TRIPS_PER_MONTH;
      y *= weight;
      if (!(x > 0) && !(y > 0)) continue;
      const f = this.serviceFactor(st, ds, hop);
      // the uplift and the car feeders of the service that carries the journey, not of the platforms the station has
      const mode = this.journeyMode(st.id, d, hop);
      parts.push({ d, x, y, f, local: sameTown ? localTripMultiplier(g, st, mode, f) * walkers / Math.max(1, originPop) : 1,
        feeder: !sameTown && mode === 'rail' && st.roadAccess ? 1 + MAINLINE_FEEDER_SHARE : 1 });
      local += x; localF += x * f;
    }
    // local trips: the station's rate (60% of the full rate for a single destination, the full rate once it reaches
    // 15% of its local demand) times the mean trip factor, shared out by OD x trip factor; long-distance trips on top
    const rate = localCapture(local, localF);
    const k = localF > 0 ? rate / localF : 0;
    const dest: number[] = [], w: number[] = [];
    let served = 0;
    for (const p of parts) {
      const v = (p.x * p.f * k * p.local + p.y * Math.max(0.3, Math.min(2, p.f))) * p.feeder;
      if (!(v > 0)) continue;
      dest.push(p.d); w.push(v); served += v;
    }
    const res: StationDemand = { dest, w, served };
    this.cache.set(st.id, res);
    return res;
  }

  /**
   * Read-only project estimate using street walks, the same overlapping-building shares, OD capture and service
   * elasticity as weights(). Counts covered people once. No fixed town coverage or assumed train occupancy.
   * One rail model whatever the construction `style` of the stops (only the platform length, for the queue a stop
   * holds, follows it): every stop is limited by the queue it holds between trains. Cross-town trips draw on the car
   * feeder pool too; a city line's (every stop in one town) transfer demand is the arrivals at the town's other served
   * rail stations continuing to these districts, not another population pool.
   */
  forecastLine(points: ForecastPoint[], _style: RailMode, kmh: number, headway: number, owner?: number, replacingLine?: number,
    replacingPattern?: number, fareMode: FareMode = 'rail'): ServiceForecast {
    // fareMode 'bus' / 'tram': a road service between these stops (coaches): the same catchment claims, competition
    // and destination choice, with that mode's fares and urban uplift; no car feeders or rail connections.
    // Keep every stop occurrence and output leg index. A joined facility/duplicate occurrence
    // shares one physical population claim and origin; it is not another passenger destination.
    const identities = points.map((p, i) => forecastStation(p)?.id ?? -i - 1);
    const first = new Map<number, number>(); identities.forEach((id, i) => { if (!first.has(id)) first.set(id, i); });
    const ranks = [...first.keys()], rank = identities.map(id => ranks.indexOf(id));
    points = points.map((p, i) => first.get(identities[i]) === i
      ? points.find(q => 'join' in q && q.join?.id === identities[i]) ?? p : p);
    const g = this.g;
    if (!this.regions.length) this.rebuild();
    const n = this.regions.length;
    const sites = points.map((p) => {
      const built = 'id' in p;
      const townId = 'townId' in p ? p.townId : g.towns.nearest(p.x, p.z)?.id ?? -1;
      return { x: p.x, z: p.z, townId, pop: 0, regions: new Map<number, number>(),
        walk: 'walk' in p ? p.walk : built ? walkingCatchment(g, p) : planWalkingCatchment(g, p) };
    });
    const own = new Set(points.flatMap(p => { const st = forecastStation(p); return st ? [st.id] : []; }));
    const ownStation = (id: number) => own.has(id);
    // Forecast the same one-claim-per-complex allocation as the committed station share-out.
    const prospective = prospectiveWalkGroups(g, points), groups = prospective.groups;
    const competing = new Map<number, WalkingCatchment>(), oldClaims = new Map<number, { key: number; group: number; weight: number }[]>();
    const union = new Map<number, Map<number, { distance: number; limit: number }>>();
    const proposedGroups = new Set(groups), native: { id: number; group: number; oldGroup: number; walk: WalkingCatchment }[] = [];
    const include = (group: number, walk: WalkingCatchment) => {
      let buildings = union.get(group); if (!buildings) union.set(group, buildings = new Map());
      for (const [bid, entry] of walk.buildings) if (entry.distance < (buildings.get(bid)?.distance ?? Infinity)) buildings.set(bid, entry);
    };
    sites.forEach((s, i) => { if (first.get(identities[i]) === i) include(groups[i], s.walk); });
    for (const st of g.stations.map.values()) {
      if (!g.lines.stationServed(st.id)) continue;
      const walk = walkingCatchment(g, st), oldGroup = g.stations.catchmentGroup(st.id), group = prospective.native(st.id);
      native.push({ id: st.id, group, oldGroup, walk });
      if (proposedGroups.has(group)) include(group, walk);
      if (!ownStation(st.id)) competing.set(st.id, walk);
    }
    const sums = new Set<number>();
    for (const buildings of union.values()) for (const bid of buildings.keys()) sums.add(bid);
    for (const { id, oldGroup, walk } of native) {
      for (const [bid, entry] of walk.buildings) {
        if (!sums.has(bid)) continue;
        let list = oldClaims.get(bid); if (!list) oldClaims.set(bid, list = []);
        list.push({ key: id, group: oldGroup, weight: walkWeight(entry.distance) });
      }
    }
    const claims = new Map<number, { key: number; group: number; weight: number }[]>();
    const add = (key: number, group: number, walk?: WalkingCatchment) => {
      for (const [bid, entry] of union.get(group) ?? walk?.buildings ?? []) {
        if (!sums.has(bid)) continue;
        let list = claims.get(bid); if (!list) claims.set(bid, list = []);
        list.push({ key, group, weight: walkWeight(entry.distance) });
      }
    };
    sites.forEach((_, i) => { if (first.get(identities[i]) === i) add(identities[i], groups[i]); });
    for (const [id, walk] of competing) add(id, prospective.native(id), walk);
    const allocation = (claims: typeof oldClaims) => new Map([...claims].map(([bid, list]) => {
      const shares = walkClaimShares(list);
      return [bid, new Map(list.map((c, i) => [c.key, shares[i]]))] as const;
    }));
    const oldShares = allocation(oldClaims), newShares = allocation(claims);
    this.forecastClaimStats = { buildings: sums.size, oldRecords: [...oldClaims.values()].reduce((n, a) => n + a.length, 0),
      newRecords: [...claims.values()].reduce((n, a) => n + a.length, 0) };
    for (let i = 0; i < sites.length; i++) {
      if (first.get(identities[i]) !== i) continue;
      const s = sites[i];
      s.walk = { segments: s.walk.segments, buildings: union.get(groups[i]) ?? s.walk.buildings };
      for (const [bid] of s.walk.buildings) {
        const b = g.world.buildings.get(bid); if (!b || b.pop <= 0) continue;
        const pop = b.pop * (newShares.get(bid)?.get(identities[i]) ?? 0);
        const r = this.regionOf(b); if (r < 0) continue;
        s.pop += pop; s.regions.set(r, (s.regions.get(r) ?? 0) + pop);
      }
    }
    // Keep the walking-only population for intra-town trips: car feeders provide regional access, not extra
    // local residents at the platforms. This matches weights() when a through railway has several city stops.
    const walking = sites.map((s) => ({ pop: s.pop, regions: new Map(s.regions) }));
    // A city line has no cross-town trips, hence no car feeders (as in weights(): only cross-town service has a pool).
    const city = sites.every((s) => s.townId >= 0 && s.townId === sites[0].townId);
    const backgroundFeeders = new Map<number, FeederPool>();
    if (!city && fareMode === 'rail') {
      const covered = new Set<number>(sums.keys());
      for (const st of g.stations.map.values()) if (g.lines.stationServed(st.id)
        && [...(g.lines.routing.get(st.id)?.keys() ?? [])].some((id) => g.stations.get(id)?.townId !== st.townId))
        for (const bid of walkingCatchment(g, st).buildings.keys()) covered.add(bid);
      const extra: FeederSite[] = sites.map((s, i) => {
        const p = points[i], built = forecastStation(p);
        const access = built ? this.feederSite(built).access
          : 'access' in p ? p.access?.tracks.flatMap(t => [t.start, t.end]) : undefined;
        return { ...s, quality: first.get(identities[i]) === i ? feederQuality(headway) : 0, access };
      });
      const others = [...g.stations.map.values()].filter(st => st.rail && stationActive(g, st) && g.lines.stationServed(st.id) && !ownStation(st.id));
      for (const st of others) extra.push(this.feederSite(st));
      const pools = this.feederPools(extra, covered);
      others.forEach((st, i) => backgroundFeeders.set(st.id, pools[sites.length + i]));
      sites.forEach((s, i) => {
        s.pop += pools[i].pop;
        for (const [r, pop] of pools[i].regions) s.regions.set(r, (s.regions.get(r) ?? 0) + pop);
      });
    }
    const context = this.forecastRoutes(points, kmh, headway, owner, replacingLine, replacingPattern);
    const background = new Map<number, { walking: Map<number, number>; regional: Map<number, number> }>();
    if (context) {
      this.refreshFeeders();
      for (const [id, walk] of competing) {
        const st = g.stations.get(id)!; if (!stationActive(g, st)) continue;
        const regions = new Map((this.shares.get(id) ?? []).map(([r, share]) => [r, st.catchPop * share]));
        // Only the overlapping buildings change their native walking allocation. Outside shares stay intact.
        for (const [bid] of union.get(prospective.native(id)) ?? walk.buildings) if (sums.has(bid)) {
          const b = g.world.buildings.get(bid); if (!b || b.pop <= 0) continue;
          const r = this.regionOf(b); if (r < 0) continue;
          const old = oldShares.get(bid)?.get(id) ?? 0, now = newShares.get(bid)?.get(id) ?? 0;
          regions.set(r, Math.max(0, (regions.get(r) ?? 0) + b.pop * (now - old)));
        }
        const regional = new Map(regions);
        for (const [r, pop] of (backgroundFeeders.get(id) ?? this.feeders.get(id))?.regions ?? [])
          regional.set(r, (regional.get(r) ?? 0) + pop);
        background.set(id, { walking: regions, regional });
      }
    }
    let boardings = 0, revenue = 0, transfers = 0;
    const legLoads = new Array(Math.max(0, 2 * (sites.length - 1))).fill(0);
    for (let i = 0; i < sites.length; i++) {
      const s = sites[i]; if (!s.pop) continue;
      // Trips as generationPopulation counts them: walkers at WALK_TRIP_INTENSITY, car feeders at the base rate.
      const gen = intensified(walking[i], s);
      const parts: { count: number; ld: number; f: number; d: number; seconds: number; j: number; centre: number; sourceShare: number }[] = [];
      let local = 0, localF = 0;
      for (let j = 0; j < sites.length; j++) {
        if (i === j || groups[i] === groups[j] || !sites[j].pop) continue;
        const t = sites[j], d = Math.hypot(s.x - t.x, s.z - t.z), walk = Math.min(1, d / WALK);
        const sameTown = s.townId >= 0 && s.townId === t.townId;
        const source = sameTown ? walking[i] : gen, destination = sameTown ? walking[j] : t;
        if (!source.pop || !destination.pop) continue;
        let x = 0, y = 0;
        for (const [r, origin] of source.regions) for (const [q, dest] of destination.regions) {
          const w = origin / source.pop * Math.min(1, dest / Math.max(1, this.regions[q].pop));
          x += w * this.od[r * n + q] * (r === q ? walk : 1);
          y += w * this.ld[r * n + q] / TRIPS_PER_MONTH;
        }
        const centre = s.townId === t.townId ? Math.min(urbanIntensity(g, s), urbanIntensity(g, t)) : 0;
        const seconds = estimateLegTime(d, kmh, headway, 1.05) + Math.max(0, Math.abs(rank[i] - rank[j]) - 1) * 8;
        const f = tripFactor(seconds, refTime(d, centre)) / TF_TYPICAL;
        parts.push({ count: x, ld: y, f, d, seconds, j, centre, sourceShare: sameTown ? walking[i].pop * WALK_TRIP_INTENSITY / gen.pop : 1 }); local += x; localF += x * f;
      }
      // Every reachable destination competes for local trips, as in weights(). Only this service's
      // own destinations receive direct receipts here; external transfer receipts are priced separately.
      for (const [id, hop] of context?.tables.get(context.ids[i]) ?? []) {
        if (ownStation(id) || context!.ids.includes(id)) continue;
        const dest = g.stations.get(id), cov = background.get(id);
        if (!dest || !cov) continue;
        const sameTown = s.townId >= 0 && s.townId === dest.townId;
        const source = sameTown ? walking[i] : gen;
        if (!source.pop) continue;
        const regions = sameTown ? cov.walking : cov.regional;
        const d = Math.hypot(s.x - dest.x, s.z - dest.z), walk = Math.min(1, d / WALK);
        let x = 0;
        for (const [r, origin] of source.regions) for (const [q, pop] of regions) {
          if (r >= n || q >= n) continue;
          x += origin / source.pop * Math.min(1, pop / Math.max(1, this.regions[q].pop)) * this.od[r * n + q] * (r === q ? walk : 1);
        }
        const centre = sameTown ? Math.min(urbanIntensity(g, s), urbanIntensity(g, dest)) : 0;
        const f = tripFactor(hop.cost, refTime(d, centre)) / TF_TYPICAL;
        local += x; localF += x * f;
      }
      const k = localF > 0 ? localCapture(local, localF) / localF : 0;
      const wanted = parts.map((p) => {
        const sameTown = s.townId >= 0 && s.townId === sites[p.j].townId;
        const factor = sameTown ? localTripMultiplier(g, s, fareMode, p.f) * p.sourceShare : 1;
        const feeder = !sameTown && fareMode === 'rail' ? 1 + MAINLINE_FEEDER_SHARE : 1;
        const count = gen.pop * TRIPS_PER_MONTH * 12 * (p.count * p.f * k * factor + p.ld * Math.max(0.3, Math.min(2, p.f))) * feeder;
        return count;
      });
      // Passengers abandon queues between sparse physically timed trains. Use the very same useful queue ceiling as
      // Stations.trimWaiting (walking residents and platform space), with one call per cycle at termini and two in
      // the middle, for every rail stop (a busy city stop on a through line as on a city line).
      const sum = wanted.reduce((a, c) => a + c, 0);
      const p = points[i];
      const length = 'rail' in p ? p.rail?.length ?? 0 : 'length' in p ? p.length ?? PLATFORM_LENGTH.mainline : PLATFORM_LENGTH.mainline;
      const tracks = 'rail' in p ? p.rail?.tracks ?? 0 : 'tracks' in p ? p.tracks ?? 2 : 2;
      const queue = Math.min(300, 12 + walking[i].pop * 0.035 * WALK_TRIP_INTENSITY + (fareMode === 'rail' ? tracks * length * 0.75 : 4));
      const slots = queue * (360 * DAY_SECONDS) / Math.max(1, headway) * (rank[i] === 0 || rank[i] === ranks.length - 1 ? 1 : 2);
      const capture = Math.min(1, slots / Math.max(1, sum));
      for (let j = 0; j < parts.length; j++) {
        const p = parts[j], count = wanted[j] * capture;
        boardings += count;
        addLegLoad(legLoads, sites.length, i, p.j, count);
        // (direct rides on the line: the full fare; a leg ending in a change or after one pays TRANSFER_FARE_FACTOR, as below)
        revenue += fareFor(p.d, p.seconds, count, { mode: fareMode, centre: p.centre });
      }
    }
    if (fareMode !== 'rail') { /* road services: direct riders only */ } else if (city) {
      const connecting = this.forecastTransfers(points, sites, kmh, headway, _style, owner, replacingLine);
      transfers = connecting.boardings; boardings += connecting.boardings; revenue += connecting.revenue;
      connecting.legLoads.forEach((load, i) => { legLoads[i] += load; });
    // A partial-pattern attractive set contains unmodified services too; its whole-line receipts
    // cannot all be assigned to the one pattern being requoted.
    } else if (context && replacingPattern === undefined) {
      const connecting = this.forecastMainlineConnections(sites, walking, background, context, kmh, headway);
      transfers = connecting.boardings; boardings += connecting.boardings; revenue += connecting.revenue;
      connecting.legLoads.forEach((load, i) => { legLoads[i] += load; });
    }
    return { boardings, revenue, transfers, legLoads, covered: sites.reduce((a, s) => a + s.pop, 0) };
  }

  /** Disposable passenger graph for the proposed timetable. Never edits a live line, pattern or vehicle. */
  private forecastRoutes(points: ForecastPoint[], kmh: number, headway: number, owner?: number,
    replacingLine?: number, replacingPattern?: number) {
    const g = this.g, ids = points.map((p, i) => forecastStation(p)?.id ?? -i - 1), own = new Set(ids);
    const unique = [...own], rank = ids.map(id => unique.indexOf(id));
    // No other destinations: retain the previous direct forecast arithmetic exactly.
    if (![...g.lines.routing.keys()].some(id => !own.has(id))) return null;
    const key = g.lines.version + ':' + g.networkVersion;
    if (key !== this.forecastGraphKey || this.forecastRouting !== g.lines.routing) {
      this.forecastGraphKey = key; this.forecastRouting = g.lines.routing; this.forecastGraph = routeGraph(g).edges;
    }
    const edges = new Map(this.forecastGraph), copied = new Set<number>(), proposed = -2;
    const add = (from: number, to: number, line: number, cost: number, internalTransfer = false) => {
      if (!copied.has(from)) { edges.set(from, [...(edges.get(from) ?? [])]); copied.add(from); }
      edges.get(from)!.push({ to, line, cost, ...(internalTransfer ? { internalTransfer } : {}) });
    };
    const existing = replacingLine === undefined ? undefined : g.lines.get(replacingLine);
    const operator = owner ?? points.map(forecastStation).find(st => st)?.owner;
    const replace = existing?.kind === 'rail' && operator !== undefined && g.lines.operatorsOf(existing).includes(operator)
      && (replacingPattern !== undefined ? linePatterns(existing).some(p => p.id === replacingPattern) : existing.stops.every(id => own.has(id)));
    const opts = new Map<string, { ride: number; f: number }[]>();
    const option = (from: number, to: number, ride: number, f: number) => {
      const key = from + ':' + to, arr = opts.get(key) ?? []; arr.push({ ride, f }); opts.set(key, arr);
    };
    if (replace) {
      for (const [id, es] of edges) edges.set(id, es.filter(e => e.line !== existing.id));
      if (replacingPattern !== undefined) {
        // Rebuild native attractive sets from the untouched patterns, not an aggregate with the old
        // quoted pattern still in it. Hop times/frequencies are exactly those used by lineGraph().
        const n = existing.stops.length;
        for (const pt of lineTable(g, existing).pats) if (pt.pid !== replacingPattern) {
          for (let a = 0; a < n; a++) if (pt.flags[a]) {
            let ride = 0; const seen = new Set([existing.stops[a]]);
            for (let k = 1, j = a; k < n; k++) {
              ride += pt.flags[j] ? pt.hop[j] : 0; j = (a + k) % n;
              if (!pt.flags[j] || seen.has(existing.stops[j])) continue;
              seen.add(existing.stops[j]);
              option(existing.stops[a], existing.stops[j], Math.max(1, ride - 10), pt.freq);
            }
          }
        }
      }
    }
    for (let i = 0; i < points.length; i++) for (let j = 0; j < points.length; j++) if (ids[i] !== ids[j]
      && ids.indexOf(ids[i]) === i && ids.indexOf(ids[j]) === j) {
      const d = Math.hypot(points[i].x - points[j].x, points[i].z - points[j].z);
      const ride = estimateLegTime(d, kmh, 0, 1.05) + Math.max(0, Math.abs(rank[i] - rank[j]) - 1) * 8;
      if (replace) option(ids[i], ids[j], ride, 1 / Math.max(1, headway));
      else add(ids[i], ids[j], proposed, ride + Math.max(0, headway) / 2);
    }
    if (replace) for (const [key, arr] of opts) {
      arr.sort((a, b) => a.ride - b.ride);
      let F = 0, RF = 0, T = Infinity;
      for (const o of arr) { if (o.ride >= T) break; F += o.f; RF += o.f * o.ride; T = (0.5 + RF) / F; }
      const [from, to] = key.split(':').map(Number); add(from, to, existing.id, T);
    }
    for (let i = 0; i < points.length; i++) {
      const p = points[i]; if (ids.indexOf(ids[i]) !== i || !('links' in p)) continue;
      // A built point already has these graph links. StationPlan.links is the native preflight's
      // exact accepted transfer set; a join reuses its station and inherited links.
      if ('id' in p) continue;
      const links = new Map(p.links.map(st => [st.id, st]));
      for (const id of p.join?.links ?? []) { const st = g.stations.get(id); if (st) links.set(id, st); }
      for (const st of links.values()) {
        if (st.id === ids[i]) continue;
        const facility = plannedStation(p, ids[i], operator);
        if (g.stations.gap(facility, st) > g.stations.linkRange(facility, st)) continue;
        for (const [from, to] of [[ids[i], st.id], [st.id, ids[i]]])
          edges.set(from, (edges.get(from) ?? []).filter(e => e.line !== WALK_LINE || e.to !== to));
        const time = transferWalkTime(g.stations.gap(facility, st), true);
        add(ids[i], st.id, WALK_LINE, time, true); add(st.id, ids[i], WALK_LINE, time, true);
      }
    }
    const sameComplex = this.forecastComplexes(points, edges);
    return { ids, tables: routeTables(edges, unique, new Map(), sameComplex), edges,
      proposed: replace ? existing.id : proposed, sameComplex };
  }

  private forecastComplexes(points: ForecastPoint[], edges: Map<number, RouteEdge[]>) {
    const combined = new Set(points.flatMap(p => 'join' in p && p.join?.stops.length ? [p.join.id] : []));
    return transferComplexes(edges, (a, b) => this.g.stations.isSameStationComplex(a, b) || (a === b && combined.has(a)));
  }

  /** Receipts on this proposed trunk, not on the other services carrying its connecting passengers. */
  private forecastMainlineConnections(sites: {
    x: number; z: number; townId: number; pop: number; regions: Map<number, number>;
  }[], walking: { pop: number; regions: Map<number, number> }[], background: Map<number, {
    walking: Map<number, number>; regional: Map<number, number>;
  }>, context: NonNullable<ReturnType<DemandModel['forecastRoutes']>>, kmh: number, headway: number
  ): { boardings: number; revenue: number; legLoads: number[] } {
    const g = this.g, indices = new Map<number, number>(), n = this.regions.length;
    context.ids.forEach((id, i) => { if (!indices.has(id)) indices.set(id, i); });
    // An isolated proposal cannot carry a connecting journey. Include incoming edges too:
    // a one-way background service may feed this trunk without a return connection.
    let connected = false;
    for (const [from, edges] of context.edges) {
      if (edges.some(edge => indices.has(from) !== indices.has(edge.to))) { connected = true; break; }
    }
    if (!connected) return { boardings: 0, revenue: 0, legLoads: new Array(Math.max(0, 2 * (sites.length - 1))).fill(0) };
    const ranks = [...indices.keys()], rank = context.ids.map(id => ranks.indexOf(id));
    const tables = routeTables(context.edges, context.edges.keys(), new Map(), context.sameComplex);
    const locations = new Map<number, { x: number; z: number; townId: number;
      walking: Map<number, number>; regional: Map<number, number> }>();
    for (const [id, i] of indices) locations.set(id, { ...sites[i], walking: walking[i].regions, regional: sites[i].regions });
    for (const [id, shares] of background) {
      const st = g.stations.get(id); if (st) locations.set(id, { x: st.x, z: st.z, townId: st.townId, ...shares });
    }
    let boardings = 0, revenue = 0;
    const legLoads = new Array(Math.max(0, 2 * (sites.length - 1))).fill(0);
    for (const [from, origin] of locations) {
      const walkingPop = [...origin.walking.values()].reduce((sum, v) => sum + v, 0);
      const regionalPop = [...origin.regional.values()].reduce((sum, v) => sum + v, 0);
      // (walkers make WALK_TRIP_INTENSITY times the trips: generationPopulation)
      const regional = intensified({ pop: walkingPop, regions: origin.walking }, { pop: regionalPop, regions: origin.regional });
      const parts: { to: number; pop: number; x: number; y: number; f: number; local: boolean }[] = [];
      let local = 0, localF = 0;
      for (const [to, hop] of tables.get(from) ?? []) {
        const dest = locations.get(to); if (!dest) continue;
        const sameTown = origin.townId >= 0 && origin.townId === dest.townId;
        const source = sameTown ? origin.walking : regional.regions;
        const target = sameTown ? dest.walking : dest.regional;
        const pop = sameTown ? walkingPop : regional.pop; if (!(pop > 0)) continue;
        const d = Math.hypot(origin.x - dest.x, origin.z - dest.z), walk = Math.min(1, d / WALK);
        let x = 0, y = 0;
        for (const [r, residents] of source) for (const [q, covered] of target) {
          if (r >= n || q >= n) continue;
          const weight = residents / pop * Math.min(1, covered / Math.max(1, this.regions[q].pop));
          x += weight * this.od[r * n + q] * (r === q ? walk : 1);
          y += weight * this.ld[r * n + q] / TRIPS_PER_MONTH;
        }
        const centre = sameTown ? Math.min(urbanIntensity(g, origin), urbanIntensity(g, dest)) : 0;
        const f = tripFactor(hop.cost, refTime(d, centre)) / TF_TYPICAL;
        parts.push({ to, pop: sameTown ? pop * WALK_TRIP_INTENSITY : pop, x, y, f, local: sameTown }); local += x; localF += x * f;
      }
      const capture = localF > 0 ? localCapture(local, localF) / localF : 0;
      for (const part of parts) {
        // Direct journeys between our own stops were priced above, once per physical station claim.
        if (indices.has(from) && indices.has(part.to)) continue;
        const rides = forecastTransferJourney(tables, from, part.to, context.proposed,
          line => line === context.proposed || g.lines.get(line)?.kind === 'rail', (a, b) => {
            const p = locations.get(a) ?? g.stations.get(a), q = locations.get(b) ?? g.stations.get(b);
            return p && q ? distanceFare(Math.hypot(p.x - q.x, p.z - q.z)) : 0;
          }, context.sameComplex);
        if (!rides.length) continue;
        const passengers = part.pop * TRIPS_PER_MONTH * 12 * (part.x * part.f * capture
          + part.y * Math.max(0.3, Math.min(2, part.f))) * (part.local ? 1 : 1 + MAINLINE_FEEDER_SHARE);
        for (const ride of rides) {
          const a = indices.get(ride.from), b = indices.get(ride.to); if (a === undefined || b === undefined) continue;
          const d = Math.hypot(sites[a].x - sites[b].x, sites[a].z - sites[b].z);
          boardings += passengers; addLegLoad(legLoads, sites.length, a, b, passengers);
          const seconds = estimateLegTime(d, kmh, headway, 1.05) + Math.max(0, Math.abs(rank[a] - rank[b]) - 1) * 8;
          revenue += fareFor(d, seconds, passengers,
            { mode: 'rail', centre: Math.min(urbanIntensity(g, sites[a]), urbanIntensity(g, sites[b])), railBefore: ride.railBefore })
            * Math.pow(TRANSFER_FARE_FACTOR, ride.changes);
        }
      }
    }
    return { boardings, revenue, legLoads };
  }

  /** Route proposed city connections through the same passenger graph and transfer penalties as actual journeys.
   * A main-line arrival whose destination is reached by the walking complex needs no urban ride. Count only
   * journeys between an outside town and a proposed stop whose chosen route actually boards this city service. */
  private forecastTransfers(points: (StationPlan | Station | ForecastSite)[], sites: {
    x: number; z: number; townId: number; pop: number; regions: Map<number, number>;
  }[], kmh: number, headway: number, mode: RailMode, owner?: number, replacingLine?: number): { boardings: number; revenue: number; legLoads: number[] } {
    const g = this.g, townId = sites[0]?.townId, proposed = -2;
    const legLoads = new Array(Math.max(0, 2 * (sites.length - 1))).fill(0);
    const built = new Set(points.flatMap(p => { const st = forecastStation(p); return st ? [st.id] : []; }));
    const operator = owner ?? points.find((p): p is Station => 'id' in p)?.owner;
    const nearby = [...g.stations.map.values()].filter((st) => st.rail && st.townId === townId
      && !built.has(st.id) && g.lines.stationServed(st.id) && stationActive(g, st)
      // Existing walking links remain passenger links; new links need the exact canLink access rule.
      && (points.some((p) => 'id' in p && p.links.includes(st.id)) || (operator !== undefined
        && (st.owner === operator || g.canUse(operator, st.owner) || g.canUse(st.owner, operator)))));
    if (!nearby.length) return { boardings: 0, revenue: 0, legLoads };
    const ids = points.map((p, i) => forecastStation(p)?.id ?? -i - 1), indices = new Map<number, number>();
    ids.forEach((id, i) => { if (!indices.has(id)) indices.set(id, i); });
    const ranks = [...indices.keys()], rank = ids.map(id => ranks.indexOf(id));
    const { edges, served } = routeGraph(g);
    // Requoting an existing city line replaces its frequency; it must not compete against its own old timetable.
    const existing = replacingLine === undefined ? undefined : g.lines.get(replacingLine);
    if (existing?.kind === 'rail' && operator !== undefined && g.lines.operatorsOf(existing).includes(operator)
      && existing.stops.every((id) => built.has(id)))
      for (const [id, es] of edges) edges.set(id, es.filter((e) => e.line !== existing.id));
    const add = (from: number, to: number, line: number, cost: number, internalTransfer = false) => {
      let es = edges.get(from); if (!es) { es = []; edges.set(from, es); }
      es.push({ to, line, cost, ...(internalTransfer ? { internalTransfer } : {}) });
    };
    const boarding = new Set<number>();
    for (let i = 0; i < sites.length; i++) {
      if (indices.get(ids[i]) !== i) continue;
      for (let j = 0; j < sites.length; j++) if (ids[i] !== ids[j] && indices.get(ids[i]) === i && indices.get(ids[j]) === j) {
        const d = Math.hypot(sites[i].x - sites[j].x, sites[i].z - sites[j].z);
        add(ids[i], ids[j], proposed, estimateLegTime(d, kmh, headway, 1.05) + Math.max(0, Math.abs(rank[i] - rank[j]) - 1) * 8);
      }
      const point = points[i], site = sites[i];
      const plan = 'layout' in point ? point : undefined;
      const virtual = 'id' in point ? point : plan ? plannedStation(plan, ids[i], operator, site.townId) : { id: ids[i], townId, x: site.x, z: site.z,
        city: mode !== 'mainline' && g.stations.cityAt(site.x, site.z, g.towns.list[site.townId]), stops: [], rail: { x: site.x, z: site.z,
          angle: Math.PI / 2, length: ('length' in point ? point.length : undefined) ?? 12,
          tracks: 2, width: stationLayout(2, 0, 'middle', 'side').width, trackOffsets: stationLayout(2, 0, 'middle', 'side').trackOffsets,
          platforms: stationLayout(2, 0, 'middle', 'side').platforms } } as unknown as Station;
      for (const st of nearby) {
        // Built points keep their real links. Plans use the same platform gap and core transfer range as canLink.
        if ('id' in point && !point.links.includes(st.id)) continue;
        const gap = g.stations.gap(virtual, st), range = g.stations.linkRange(virtual, st);
        if (gap > range) continue;
        const time = transferWalkTime(gap, true);
        add(ids[i], st.id, WALK_LINE, time, true); add(st.id, ids[i], WALK_LINE, time, true); boarding.add(ids[i]);
      }
    }
    if (!boarding.size) return { boardings: 0, revenue: 0, legLoads };
    const external = [...served].map((id) => g.stations.get(id)!).filter((st) => st && st.townId !== townId && stationActive(g, st));
    if (!external.length) return { boardings: 0, revenue: 0, legLoads };
    const sameComplex = this.forecastComplexes(points, edges);
    const tables = routeTables(edges, edges.keys(), new Map(), sameComplex), n = this.regions.length;
    const coverage = new Map<number, [number, number][]>();
    for (const id of edges.keys()) {
      const i = indices.get(id), st = g.stations.get(id);
      coverage.set(id, i !== undefined ? [...sites[i].regions].map(([r, pop]) => [r, Math.min(1, pop / Math.max(1, this.regions[r]?.pop ?? 1))])
        : st ? this.coverage(st) : []);
    }
    let count = 0, revenue = 0;
    for (const from of [...external.map((st) => st.id), ...ranks]) {
      const i = indices.get(from), st = g.stations.get(from), site = i !== undefined ? sites[i] : st!;
      // Trip-making population (generationPopulation): walkers at WALK_TRIP_INTENSITY, car feeders at the base rate.
      // (A planned city stop has no car feeders: its sites' regions are all walkers.)
      const origin = new Map<number, number>(i !== undefined ? [...sites[i].regions].map(([r, pop]) => [r, pop * WALK_TRIP_INTENSITY])
        : (this.shares.get(from) ?? []).map(([r, share]) => [r, st!.catchPop * WALK_TRIP_INTENSITY * share]));
      if (i === undefined) for (const [r, pop] of this.feeders.get(from)?.regions ?? []) origin.set(r, (origin.get(r) ?? 0) + pop);
      const pops = [...origin];
      const pop = pops.reduce((sum, [, v]) => sum + v, 0); if (!(pop > 0)) continue;
      const parts: { to: number; x: number; y: number; f: number; cost: number }[] = [];
      let local = 0, localF = 0;
      for (const [to, hop] of tables.get(from) ?? []) {
        const j = indices.get(to), dest = j !== undefined ? sites[j] : g.stations.get(to); if (!dest) continue;
        let x = 0, y = 0;
        const walk = Math.min(1, Math.hypot(dest.x - site.x, dest.z - site.z) / WALK);
        for (const [r, origin] of pops) for (const [q, cov] of coverage.get(to) ?? []) {
          x += origin / pop * this.od[r * n + q] * cov * (r === q ? walk : 1);
          y += origin / pop * this.ld[r * n + q] * cov / TRIPS_PER_MONTH;
        }
        const centre = site.townId === dest.townId ? Math.min(urbanIntensity(g, site), urbanIntensity(g, dest)) : 0;
        const f = tripFactor(hop.cost, refTime(Math.hypot(dest.x - site.x, dest.z - site.z), centre)) / TF_TYPICAL;
        parts.push({ to, x, y, f, cost: hop.cost }); local += x; localF += x * f;
      }
      const k = localF > 0 ? localCapture(local, localF) / localF : 0;
      for (const part of parts) {
        const j = indices.get(part.to);
        if (i === undefined ? j === undefined : j !== undefined || g.stations.get(part.to)?.townId === townId) continue;
        const legs = forecastTransferJourney(tables, from, part.to, proposed,
          (line) => line === proposed || g.lines.get(line)?.kind === 'rail', (a, b) => {
            const from = indices.has(a) ? sites[indices.get(a)!] : g.stations.get(a);
            const to = indices.has(b) ? sites[indices.get(b)!] : g.stations.get(b);
            return from && to ? distanceFare(Math.hypot(from.x - to.x, from.z - to.z)) : 0;
          }, sameComplex);
        const passengers = pop * TRIPS_PER_MONTH * 12 * (part.x * part.f * k + part.y * Math.max(0.3, Math.min(2, part.f)))
          * (1 + MAINLINE_FEEDER_SHARE);
        for (const leg of legs) {
          const a = indices.get(leg.from), b = indices.get(leg.to); if (a === undefined || b === undefined) continue;
          const d = Math.hypot(sites[a].x - sites[b].x, sites[a].z - sites[b].z);
          count += passengers;
          addLegLoad(legLoads, sites.length, a, b, passengers);
          revenue += fareFor(d, estimateLegTime(d, kmh, headway, 1.05), passengers,
            { mode: 'rail', centre: Math.min(urbanIntensity(g, sites[a]), urbanIntensity(g, sites[b])),
              railBefore: leg.railBefore })
            * Math.pow(TRANSFER_FARE_FACTOR, leg.changes);
        }
      }
    }
    return { boardings: count, revenue, legLoads };
  }

  toJSON() {
    return {
      regions: this.regions.map((r) => ({ ...r })),
      towns: [...this.towns].map(([t, v]) => [t, v.core, v.sectors, [...v.ids]]),
      shares: [...this.shares].map(([s, a]) => [s, a.map((x) => [...x])]),
      cursor: this.cursor,
    };
  }

  load(d: any) {
    if (!d || !Array.isArray(d.regions)) return false;
    this.regions = d.regions.map((r: Region) => ({ ...r }));
    // Potential trips are derived rates, not historical counts: saves made before calibration must use today's
    // rates immediately, just like the freshly computed long-distance matrix below.
    for (const r of this.regions) r.produced = TRIPS_PER_MONTH * (r.pop + 0.3 * r.jobs);
    this.towns = new Map((d.towns ?? []).map((t: [number, number, number, number[]]) => [t[0], { core: t[1], sectors: t[2], ids: [...t[3]] }]));
    this.shares = new Map((d.shares ?? []).map((s: [number, [number, number][]]) => [s[0], s[1].map((x) => [x[0], x[1]] as [number, number])]));
    this.cursor = d.cursor ?? 0;
    this.computeDecay();
    this.computeOD();
    this.version++;
    return true;
  }
}

// ============================================================================ the demand view (UI)

export interface DemandTown {
  id: number; x: number; z: number; pop: number;
  /** passengers generated in / delivered to the town last month */
  generated: number; transported: number;
  /** share of the residents living in the catchment of served stations (0..1) */
  served: number;
  /** potential trips per month starting in the town (all destinations), and of those within the town */
  potential: number; local: number;
  /** share of the local potential the network can carry */
  localServed: number;
  /** served stations in the town */
  stations: number;
}

export interface DemandRegion extends Region {
  /** share of the residents in the catchment of served stations (0..1) */
  served: number;
}

export interface DemandPair {
  /** town ids, a < b */
  a: number; b: number;
  /** straight-line distance (units) */
  dist: number;
  /** potential trips per month in both directions */
  potential: number;
  /** share of the potential the network can carry now (0..1) */
  served: number;
  /** share of the carried part whose first leg is on the company's lines (0..1) */
  mine: number;
}

/** A regional OD flow (both directions). */
export interface DemandFlow { a: number; b: number; trips: number; served: number }

export interface DemandView { towns: DemandTown[]; pairs: DemandPair[]; regions: DemandRegion[]; flows: DemandFlow[]; maxPotential: number }

const viewCache = new WeakMap<Game, { key: string; view: DemandView }>();

/** Demand from the last computed catchment snapshot (served counts every company's lines).
 * Pending construction/monthly refreshes belong to the simulation, including while the UI is open. */
export function demandView(g: Game, company = 0): DemandView {
  const m = g.demand;
  const key = `${g.day}:${g.lines.version}:${m.version}:${company}`;
  const c = viewCache.get(g);
  if (c && c.key === key) return c.view;
  const view = computeView(g, company);
  viewCache.set(g, { key, view });
  return view;
}

/** The line of the first leg actually ridden on the way to `dest` (walking transfers looked through). */
function firstRide(g: Game, hop: Hop | undefined, dest: number): number {
  for (let i = 0; hop && hop.line === WALK_LINE && i < 4; i++) hop = g.lines.nextHop(hop.alight, dest);
  return hop ? hop.line : WALK_LINE;
}

function computeView(g: Game, company: number): DemandView {
  const m = g.demand;
  const R = m.regions, n = R.length, T = g.towns.list, nt = T.length;
  // reach[r * n + q]: share of r's residents in catchments reaching stations that cover q, weighted by that coverage
  const reach = new Float64Array(n * n), reachMine = new Float64Array(n * n);
  const servedPop = new Float64Array(n);
  const townStations = new Int32Array(nt);
  const cov = new Map<number, [number, number][]>();
  for (const st of g.stations.map.values()) cov.set(st.id, m.coverageSnapshot(st));
  for (const st of g.stations.map.values()) {
    const table = g.lines.routing.get(st.id);
    // Read saved access too: stationActive/hasAccess can apply a pending street edit.
    if (!table || !table.size || st.roadAccess === false) continue;
    if (st.townId >= 0 && st.townId < nt) townStations[st.townId]++;
    const from = cov.get(st.id)!;
    for (const [r, cr] of from) servedPop[r] += cr * R[r].pop;
    for (const [d, hop] of table) {
      const to = cov.get(d), ds = g.stations.get(d);
      if (!to || !to.length || !ds || ds.roadAccess === false) continue;
      const mine = g.lines.get(firstRide(g, hop, d))?.owner === company;
      for (const [r, cr] of from) for (const [q, cq] of to) {
        reach[r * n + q] += cr * cq;
        if (mine) reachMine[r * n + q] += cr * cq;
      }
    }
  }
  const { trips } = m.tripSnapshot();
  const regions: DemandRegion[] = R.map((r) => ({ ...r, served: r.pop > 0 ? Math.min(1, servedPop[r.id] / r.pop) : 0 }));
  // towns
  const towns: DemandTown[] = T.map((t) => ({
    id: t.id, x: t.x, z: t.z, pop: t.pop, generated: t.passGenLast, transported: t.passTransLast,
    served: 0, potential: 0, local: 0, localServed: 0, stations: townStations[t.id],
  }));
  const tPop = new Float64Array(nt), localCarried = new Float64Array(nt);
  for (const r of R) {
    const tw = towns[r.town]; if (!tw) continue;
    tPop[r.town] += r.pop; tw.served += servedPop[r.id];
  }
  const pairPot = new Float64Array(nt * nt), pairCar = new Float64Array(nt * nt), pairMine = new Float64Array(nt * nt);
  const flows: DemandFlow[] = [];
  for (let r = 0; r < n; r++) {
    const t = trips(r, r), tw = towns[R[r].town];
    if (tw) tw.potential += t;
    if (tw && t > 0) { tw.local += t; localCarried[R[r].town] += t * Math.min(1, reach[r * n + r]); }
  }
  for (let r = 0; r < n; r++) for (let q = r + 1; q < n; q++) {
    const t1 = trips(r, q), t2 = trips(q, r), tot = t1 + t2;
    const a = R[r].town, b = R[q].town;
    if (towns[a]) towns[a].potential += t1;
    if (towns[b]) towns[b].potential += t2;
    if (!(tot > 0)) continue;
    const car = t1 * Math.min(1, reach[r * n + q]) + t2 * Math.min(1, reach[q * n + r]);
    const mine = t1 * Math.min(1, reachMine[r * n + q]) + t2 * Math.min(1, reachMine[q * n + r]);
    if (a === b) { towns[a].local += tot; localCarried[a] += car; }
    else { const i = Math.min(a, b) * nt + Math.max(a, b); pairPot[i] += tot; pairCar[i] += car; pairMine[i] += mine; }
    if (tot >= 0.5) flows.push({ a: r, b: q, trips: tot, served: car / tot });
  }
  for (const tw of towns) {
    tw.served = tPop[tw.id] > 0 ? Math.min(1, tw.served / tPop[tw.id]) : 0;
    tw.localServed = tw.local > 0 ? Math.min(1, localCarried[tw.id] / tw.local) : 0;
  }
  const pairs: DemandPair[] = [];
  let maxPotential = 0;
  for (let i = 0; i < nt; i++) for (let j = i + 1; j < nt; j++) {
    const k = i * nt + j, potential = pairPot[k];
    if (potential < 0.5) continue;
    pairs.push({ a: T[i].id, b: T[j].id, dist: Math.hypot(T[i].x - T[j].x, T[i].z - T[j].z), potential, served: Math.min(1, pairCar[k] / potential), mine: pairCar[k] > 0 ? Math.min(1, pairMine[k] / pairCar[k]) : 0 });
    if (potential > maxPotential) maxPotential = potential;
  }
  pairs.sort((p, q) => q.potential - p.potential);
  flows.sort((p, q) => q.trips - p.trips);
  if (flows.length > 200) flows.length = 200;
  return { towns, pairs, regions, flows, maxPotential };
}

/** Passengers waiting at a station, by destination town (and the lines they wait for). */
export function stationDemand(g: Game, stationId: number): { town: number; count: number; lines: { line: number; count: number }[] }[] {
  const st = g.stations.get(stationId);
  if (!st) return [];
  const byTown = new Map<number, { town: number; count: number; lines: Map<number, number> }>();
  for (const w of st.waiting.values()) {
    const t = g.stations.get(w.dest)?.townId ?? -1;
    let e = byTown.get(t);
    if (!e) { e = { town: t, count: 0, lines: new Map() }; byTown.set(t, e); }
    e.count += w.count;
    e.lines.set(w.line, (e.lines.get(w.line) ?? 0) + w.count);
  }
  return [...byTown.values()]
    .map((e) => ({ town: e.town, count: e.count, lines: [...e.lines].map(([line, count]) => ({ line, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
}
