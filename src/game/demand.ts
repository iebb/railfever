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
import type { Station } from './stations';
import { WALK_LINE } from './stations';
import type { Hop } from './lines';
import { tripFactor, refTime } from './fares';
import type { Building } from './world';
import type { Town } from './towns';
import { DAYS_PER_MONTH, PASSENGER_RATE_SCALE, LOCAL_DEMAND_DISTANCE, LOCAL_DEMAND_EXP, LOCAL_SERVED_SHARE } from './constants';
import { BT_SHOP, BT_OFFICE, BT_TOWER } from './towns';

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
export const GEN_RATE = 0.0085 * PASSENGER_RATE_SCALE;
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
export const LD_RATE = 0.012 * PASSENGER_RATE_SCALE;
/** Trip factor of a typical service of the game (it leaves the demand as it was); fast direct services earn more. */
export const TF_TYPICAL = 1.3;

/** Trips within a region (across town): a share of its own attraction (many such trips are walked). */
const INTRA = 0.35;
/** Stations closer than this (units) share few trips within a region (people walk). */
const WALK = 25;

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
  private cacheKey = '';

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
    return R[r].produced * this.od[r * n + q] + R[r].pop * (this.ld[r * n + q] ?? 0);
  }

  // ---------------------------------------------------------------- service quality (trip factor)
  /**
   * Trip factor (fares.ts tripFactor, relative to a typical service: TF_TYPICAL) of travelling from st to d by the
   * network: the routed journey's expected time (Hop.cost, sim seconds: half the headway of the services worth
   * taking, the rides, and the transfers with their penalty) against the alternative (walking / driving) for the
   * straight distance. Fast, frequent, direct services: above 1; slow, sparse or roundabout ones: below.
   */
  serviceFactor(st: Station, d: Station, hop: Hop): number {
    return tripFactor(Math.max(1, hop.cost), refTime(Math.hypot(d.x - st.x, d.z - st.z))) / TF_TYPICAL;
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
  coverage(st: Station): [number, number][] {
    const sh = this.shares.get(st.id);
    if (!sh) return [];
    return sh.map(([r, s]) => [r, Math.min(1, (st.catchPop * s) / Math.max(1, this.regions[r]?.pop ?? 1))]);
  }

  /** Destinations of a station's passengers by OD demand (cached until routing or catchments change). */
  weights(st: Station): StationDemand {
    const g = this.g;
    const key = g.lines.version + ':' + this.version + ':' + g.networkVersion;
    if (key !== this.cacheKey) { this.cache.clear(); this.cacheKey = key; }
    const c = this.cache.get(st.id);
    if (c) return c;
    const table = g.lines.routing.get(st.id), origin = this.shares.get(st.id);
    if (!table || !origin || !this.regions.length || !stationActive(g, st)) { this.cache.set(st.id, NO_DEMAND); return NO_DEMAND; }
    const n = this.regions.length, od = this.od, ld = this.ld;
    const parts: { d: number; x: number; y: number; f: number }[] = [];
    let local = 0, localF = 0;
    for (const [d, hop] of table) {
      const ds = g.stations.get(d);
      if (!ds || !stationActive(g, ds)) continue;
      // local trips (the OD share) and long-distance trips (relative to the local trip rate) to d's regions
      let x = 0, y = 0;
      const walk = Math.min(1, Math.hypot(ds.x - st.x, ds.z - st.z) / WALK);
      for (const [q, cov] of this.coverage(ds)) for (const [r, sr] of origin) {
        if (r >= n || q >= n) continue;
        x += sr * od[r * n + q] * cov * (r === q ? walk : 1);
        y += sr * (ld[r * n + q] ?? 0) * cov;
      }
      y /= TRIPS_PER_MONTH;
      if (!(x > 0) && !(y > 0)) continue;
      const f = this.serviceFactor(st, ds, hop);
      parts.push({ d, x, y, f });
      local += x; localF += x * f;
    }
    // local trips: the station's rate (60% of the full rate for a single destination, the full rate once it reaches
    // 15% of its local demand) times the mean trip factor, shared out by OD x trip factor; long-distance trips on top
    const rate = local > 0 ? (0.6 + 0.4 * Math.min(1, local / LOCAL_SERVED_SHARE)) * Math.max(0.6, Math.min(1.6, localF / local)) : 0;
    const k = localF > 0 ? rate / localF : 0;
    const dest: number[] = [], w: number[] = [];
    let served = 0;
    for (const p of parts) {
      const v = p.x * p.f * k + p.y * Math.max(0.3, Math.min(2, p.f));
      if (!(v > 0)) continue;
      dest.push(p.d); w.push(v); served += v;
    }
    const res: StationDemand = { dest, w, served };
    this.cache.set(st.id, res);
    return res;
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

/** Demand by town, region, town pair and regional flow, for `company`'s view (served counts every company's lines). */
export function demandView(g: Game, company = 0): DemandView {
  // (catchments first: recomputing them bumps the model's version, which is part of the key)
  g.lines.flushCatchment();
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
  g.lines.flushCatchment();
  const m = g.demand;
  if (!m.regions.length) m.rebuild();
  const R = m.regions, n = R.length, T = g.towns.list, nt = T.length;
  // reach[r * n + q]: share of r's residents in catchments reaching stations that cover q, weighted by that coverage
  const reach = new Float64Array(n * n), reachMine = new Float64Array(n * n);
  const servedPop = new Float64Array(n);
  const townStations = new Int32Array(nt);
  const cov = new Map<number, [number, number][]>();
  for (const st of g.stations.map.values()) cov.set(st.id, m.coverage(st));
  for (const st of g.stations.map.values()) {
    const table = g.lines.routing.get(st.id);
    if (!table || !table.size || !stationActive(g, st)) continue;
    if (st.townId >= 0 && st.townId < nt) townStations[st.townId]++;
    const from = cov.get(st.id)!;
    for (const [r, cr] of from) servedPop[r] += cr * R[r].pop;
    for (const [d, hop] of table) {
      const to = cov.get(d), ds = g.stations.get(d);
      if (!to || !to.length || !ds || !stationActive(g, ds)) continue;
      const mine = g.lines.get(firstRide(g, hop, d))?.owner === company;
      for (const [r, cr] of from) for (const [q, cq] of to) {
        reach[r * n + q] += cr * cq;
        if (mine) reachMine[r * n + q] += cr * cq;
      }
    }
  }
  const trips = (r: number, q: number) => m.trips(r, q);
  const regions: DemandRegion[] = R.map((r) => ({ ...r, served: r.pop > 0 ? Math.min(1, servedPop[r.id] / r.pop) : 0 }));
  // towns
  const towns: DemandTown[] = T.map((t) => ({
    id: t.id, x: t.x, z: t.z, pop: t.pop, generated: t.passGenLast, transported: t.passTransLast,
    served: 0, potential: 0, local: 0, localServed: 0, stations: townStations[t.id],
  }));
  const tPop = new Float64Array(nt), localCarried = new Float64Array(nt);
  for (const r of R) { const tw = towns[r.town]; if (!tw) continue; tw.potential += r.produced; tPop[r.town] += r.pop; tw.served += servedPop[r.id]; }
  const pairPot = new Float64Array(nt * nt), pairCar = new Float64Array(nt * nt), pairMine = new Float64Array(nt * nt);
  const flows: DemandFlow[] = [];
  for (let r = 0; r < n; r++) {
    const t = trips(r, r), tw = towns[R[r].town];
    if (tw && t > 0) { tw.local += t; localCarried[R[r].town] += t * Math.min(1, reach[r * n + r]); }
  }
  for (let r = 0; r < n; r++) for (let q = r + 1; q < n; q++) {
    const t1 = trips(r, q), t2 = trips(q, r), tot = t1 + t2;
    if (!(tot > 0)) continue;
    const car = t1 * Math.min(1, reach[r * n + q]) + t2 * Math.min(1, reach[q * n + r]);
    const mine = t1 * Math.min(1, reachMine[r * n + q]) + t2 * Math.min(1, reachMine[q * n + r]);
    const a = R[r].town, b = R[q].town;
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
