// Regional passenger demand. Towns are split into districts (a centre and outer sectors for towns of 1,500+,
// one region for smaller towns); every region produces trips (from its residents) and attracts them (jobs and
// residents), and an origin-destination matrix with distance decay and a long tail (intercity trips are a real
// share) says where they go. Stations draw passengers from the regions in their catchment; passenger generation
// (game.ts) sends them to the regions the network serves, in proportion to the OD demand. demandView() reports
// towns, regions, town pairs and the largest regional flows for the UI.
import type { Game } from './game';
import type { Station } from './stations';
import type { Building } from './world';
import { DAYS_PER_MONTH, STATION_RADIUS, BUSSTOP_RADIUS } from './constants';
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

/** Destinations of a station's passengers: reachable stations, their OD weights, and the served share of its demand. */
export interface StationDemand { dest: number[]; w: number[]; served: number }

/** Passengers generated per catchment inhabitant per day, before the rating factor (0.2 + rating). */
export const GEN_RATE = 0.0085;
/** Trips per inhabitant per month when covered by a station with a typical rating. */
export const TRIPS_PER_MONTH = GEN_RATE * DAYS_PER_MONTH * (0.2 + 0.65);
/** Towns from this size are split into a centre and outer districts. */
export const DISTRICT_MIN_POP = 1500;

/** Distance decay of the OD matrix: ~1 nearby, a long tail (∝ d^-1.2) for intercity trips. */
export const odDecay = (d: number) => 1 / Math.pow(1 + (d / 45) * (d / 45), 0.6);
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

/** Catchment circles of a station (stations.ts catchmentShapes when there is one). */
export function catchmentCircles(g: Game, st: Station): { x: number; z: number; r: number }[] {
  const s = g.stations as unknown as { catchmentShapes?: (st: Station) => { x: number; z: number; r: number }[] };
  if (s.catchmentShapes) return s.catchmentShapes(st);
  const out: { x: number; z: number; r: number }[] = [];
  if (st.rail) out.push({ x: st.rail.x, z: st.rail.z, r: STATION_RADIUS + st.rail.length / 2 });
  for (const p of st.stops) out.push({ x: p.x, z: p.z, r: BUSSTOP_RADIUS });
  return out;
}

const NO_DEMAND: StationDemand = { dest: [], w: [], served: 0 };

/** The regional demand model of a game (kept in game.demand, saved with it). */
export class DemandModel {
  regions: Region[] = [];
  /** per town: district layout (core radius, sector count) and its region ids (centre / the town first) */
  private towns = new Map<number, { core: number; sectors: number; ids: number[] }>();
  /** od[r * n + q]: share of the trips produced in r that go to q (rows sum to 1; r -> r: across the region) */
  od = new Float32Array(0);
  /** per station: [region, share of its catchment population] */
  shares = new Map<number, [number, number][]>();
  /** bumped when regions or station shares change */
  version = 0;
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

  /** Regions from the towns as they are now, and the OD matrix (monthly). */
  rebuild() {
    const g = this.g;
    this.regions = [];
    this.towns.clear();
    for (const t of g.towns.list) {
      const split = t.pop >= DISTRICT_MIN_POP;
      const sectors = !split ? 0 : t.pop < 3000 ? 3 : t.pop < 6000 ? 4 : 6;
      const ids: number[] = [];
      const add = (kind: Region['kind']) => { const id = this.regions.length; this.regions.push({ id, town: t.id, kind, x: t.x, z: t.z, r: 0, pop: 0, jobs: 0, produced: 0, attracted: 0 }); ids.push(id); };
      if (!split) add('town'); else { add('centre'); for (let k = 0; k < sectors; k++) add('district'); }
      this.towns.set(t.id, { core: split ? Math.max(8, t.radius * 0.4) : 0, sectors, ids });
    }
    const n = this.regions.length;
    const acc = new Float64Array(n * 4); // sum w x, sum w z, sum w, sum w d^2
    for (const b of g.world.buildings.values()) {
      if (b.pop <= 0) continue;
      const r = this.regionOf(b);
      if (r < 0) continue;
      const [res, jobs] = residentsJobs(b);
      const R = this.regions[r];
      R.pop += res; R.jobs += jobs;
      acc[r * 4] += b.x * b.pop; acc[r * 4 + 1] += b.z * b.pop; acc[r * 4 + 2] += b.pop;
    }
    for (const R of this.regions) {
      const w = acc[R.id * 4 + 2];
      if (w > 0) { R.x = acc[R.id * 4] / w; R.z = acc[R.id * 4 + 1] / w; }
    }
    for (const b of g.world.buildings.values()) {
      if (b.pop <= 0) continue;
      const r = this.regionOf(b);
      if (r < 0) continue;
      const R = this.regions[r];
      acc[r * 4 + 3] += b.pop * ((b.x - R.x) * (b.x - R.x) + (b.z - R.z) * (b.z - R.z));
    }
    for (const R of this.regions) {
      const w = acc[R.id * 4 + 2];
      R.r = w > 0 ? Math.sqrt(acc[R.id * 4 + 3] / w) * 1.5 + 4 : 6;
      R.produced = TRIPS_PER_MONTH * (R.pop + 0.3 * R.jobs);
      R.attracted = 0.4 * R.pop + R.jobs;
    }
    this.computeOD();
    this.version++;
  }

  private computeOD() {
    const n = this.regions.length, R = this.regions;
    this.od = new Float32Array(n * n);
    for (let r = 0; r < n; r++) {
      let sum = 0;
      for (let q = 0; q < n; q++) {
        const w = q === r ? R[r].attracted * odDecay(R[r].r) * INTRA : R[q].attracted * odDecay(Math.hypot(R[r].x - R[q].x, R[r].z - R[q].z));
        this.od[r * n + q] = w;
        sum += w;
      }
      if (sum > 0) for (let q = 0; q < n; q++) this.od[r * n + q] /= sum;
    }
  }

  /** Which regions each station's catchment covers (after catchments change; game.ts / lines.ts call it). */
  recomputeShares() {
    const g = this.g;
    this.shares.clear();
    const circles: { st: number; x: number; z: number; r: number }[] = [];
    for (const st of g.stations.map.values()) {
      if (!stationActive(g, st)) continue;
      for (const c of catchmentCircles(g, st)) circles.push({ st: st.id, x: c.x, z: c.z, r: c.r });
    }
    if (circles.length) {
      const C = 32, key = (cx: number, cz: number) => cx * 4096 + cz;
      const cells = new Map<number, number[]>();
      circles.forEach((c, i) => {
        for (let cz = Math.floor((c.z - c.r) / C); cz <= Math.floor((c.z + c.r) / C); cz++) for (let cx = Math.floor((c.x - c.r) / C); cx <= Math.floor((c.x + c.r) / C); cx++) {
          const k = key(cx, cz);
          const a = cells.get(k);
          if (a) a.push(i); else cells.set(k, [i]);
        }
      });
      const acc = new Map<number, Map<number, number>>();
      const seen: number[] = [];
      for (const b of g.world.buildings.values()) {
        if (b.pop <= 0) continue;
        const idx = cells.get(key(Math.floor(b.x / C), Math.floor(b.z / C)));
        if (!idx) continue;
        const r = this.regionOf(b);
        if (r < 0) continue;
        seen.length = 0;
        for (const i of idx) {
          const c = circles[i];
          if ((b.x - c.x) * (b.x - c.x) + (b.z - c.z) * (b.z - c.z) > c.r * c.r || seen.includes(c.st)) continue;
          seen.push(c.st);
          let m = acc.get(c.st);
          if (!m) { m = new Map(); acc.set(c.st, m); }
          m.set(r, (m.get(r) ?? 0) + b.pop);
        }
      }
      for (const [st, m] of acc) {
        let tot = 0;
        for (const v of m.values()) tot += v;
        if (tot > 0) this.shares.set(st, [...m].sort((a, b) => a[0] - b[0]).map(([r, v]) => [r, v / tot]));
      }
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
    const n = this.regions.length, od = this.od;
    const dest: number[] = [], w: number[] = [];
    let served = 0;
    for (const d of table.keys()) {
      const ds = g.stations.get(d);
      if (!ds || !stationActive(g, ds)) continue;
      let x = 0;
      const walk = Math.min(1, Math.hypot(ds.x - st.x, ds.z - st.z) / WALK);
      for (const [q, cov] of this.coverage(ds)) for (const [r, sr] of origin) if (r < n && q < n) x += sr * od[r * n + q] * cov * (r === q ? walk : 1);
      if (!(x > 0)) continue;
      dest.push(d); w.push(x); served += x;
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
    };
  }

  load(d: any) {
    if (!d || !Array.isArray(d.regions)) return false;
    this.regions = d.regions.map((r: Region) => ({ ...r }));
    this.towns = new Map((d.towns ?? []).map((t: [number, number, number, number[]]) => [t[0], { core: t[1], sectors: t[2], ids: [...t[3]] }]));
    this.shares = new Map((d.shares ?? []).map((s: [number, [number, number][]]) => [s[0], s[1].map((x) => [x[0], x[1]] as [number, number])]));
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
  const m = g.demand;
  const key = `${g.day}:${g.lines.version}:${m.version}:${company}`;
  const c = viewCache.get(g);
  if (c && c.key === key) return c.view;
  const view = computeView(g, company);
  viewCache.set(g, { key, view });
  return view;
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
      const to = cov.get(d);
      if (!to || !to.length) continue;
      const mine = g.lines.get(hop.line)?.owner === company;
      for (const [r, cr] of from) for (const [q, cq] of to) {
        reach[r * n + q] += cr * cq;
        if (mine) reachMine[r * n + q] += cr * cq;
      }
    }
  }
  const trips = (r: number, q: number) => R[r].produced * m.od[r * n + q];
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
