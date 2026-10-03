// Towns: street layouts on the road graph (planned grid, organic old town, radial / ring, linear along a
// valley or coast, hill town along the contours), perimeter-block frontage, parks / plazas, growth
// profiles and growth. Every layout is a lattice of street corners (i, j); non-grid layouts warp it.
import type { Game } from './game';
import { World, Building, distToRect, pointInRect } from './world';
import { RNG, hash2 } from './rng';
import { townName } from './names';
import { ROAD_TYPES, WATER_Y, PSTEP, TRACK_TYPES } from './constants';
import { planEdge, commitProposal, findSnap, BuildOptions, Proposal } from './construction';
import { NEdge, NNode } from './network';
import { closestOnPolyline } from './geom';
import { recomputeLocks, LOCK, DRY_MIN, EARTHWORKS } from './terraform';

export const BT_HOUSE_S = 0, BT_HOUSE_L = 1, BT_TOWNHOUSE = 2, BT_SHOP = 3, BT_APARTMENT = 4,
  BT_OFFICE = 5, BT_TOWER = 6, BT_CHURCH = 7, BT_PARK = 8, BT_PLAZA = 9;

export const FLOOR_H = 0.3;

export interface BuildingType {
  name: string;
  w: [number, number];
  d: [number, number];
  floors: [number, number];
  popPerFloor: [number, number];
  setback: number;
  rank: number;
}

export const BUILDING_TYPES: BuildingType[] = [
  { name: 'Cottage', w: [0.8, 1.0], d: [0.7, 0.9], floors: [1, 2], popPerFloor: [1.5, 2.5], setback: 0.35, rank: 0 },
  { name: 'House', w: [1.0, 1.3], d: [0.9, 1.1], floors: [2, 2], popPerFloor: [2, 3], setback: 0.3, rank: 1 },
  { name: 'Townhouse', w: [1.1, 1.5], d: [0.9, 1.2], floors: [3, 5], popPerFloor: [1.6, 2.2], setback: 0.08, rank: 2 },
  { name: 'Shops', w: [1.4, 2.0], d: [1.1, 1.5], floors: [2, 4], popPerFloor: [1.7, 2.3], setback: 0.06, rank: 2 },
  { name: 'Apartments', w: [1.8, 2.6], d: [1.4, 2.0], floors: [5, 9], popPerFloor: [1.4, 1.9], setback: 0.1, rank: 3 },
  { name: 'Offices', w: [2.0, 2.8], d: [1.8, 2.4], floors: [8, 16], popPerFloor: [0.95, 1.35], setback: 0.08, rank: 4 },
  { name: 'Tower', w: [2.2, 2.8], d: [2.2, 2.8], floors: [16, 38], popPerFloor: [0.95, 1.35], setback: 0.08, rank: 5 },
  { name: 'Church', w: [1.6, 1.6], d: [3.0, 3.0], floors: [1, 1], popPerFloor: [0, 0], setback: 0.4, rank: 9 },
  // land use: a whole block (rect = block interior), no floors, no inhabitants
  { name: 'Park', w: [4, 12], d: [4, 12], floors: [0, 0], popPerFloor: [0, 0], setback: 0, rank: 9 },
  { name: 'Plaza', w: [4, 12], d: [4, 12], floors: [0, 0], popPerFloor: [0, 0], setback: 0, rank: 9 },
];

/** Street layout of a town. */
export type TownLayout = 'grid' | 'organic' | 'radial' | 'linear' | 'hill';
export const TOWN_LAYOUTS: Record<TownLayout, string> = {
  grid: 'Planned grid', organic: 'Organic old town', radial: 'Radial avenues and rings', linear: 'Linear town', hill: 'Hill town',
};

/** How a town grows: speed, density and building mix. */
export type GrowthProfile = 'balanced' | 'industrial' | 'historic' | 'suburban' | 'compact';
export interface ProfileSpec {
  label: string;
  /** growth speed (running game) */
  growth: number;
  /** size of the dense zones (office / apartment core, high street) */
  core: number;
  /** how far the town spreads for its population, and how large its suburbs are */
  sprawl: number;
  /** gaps between detached houses */
  gap: number;
  /** share of towers and offices in the core */
  tall: number;
  /** block size */
  block: number;
}
export const GROWTH_PROFILES: Record<GrowthProfile, ProfileSpec> = {
  balanced: { label: 'Balanced', growth: 1, core: 1, sprawl: 1, gap: 1, tall: 1, block: 1 },
  industrial: { label: 'Fast-growing industrial city', growth: 1.6, core: 1.15, sprawl: 1.05, gap: 0.8, tall: 1.3, block: 1.1 },
  historic: { label: 'Slow-growing historic town', growth: 0.55, core: 0.9, sprawl: 0.85, gap: 0.7, tall: 0.2, block: 0.85 },
  suburban: { label: 'Sprawling suburbs', growth: 1.2, core: 0.8, sprawl: 1.2, gap: 1.35, tall: 0.6, block: 1.1 },
  compact: { label: 'Dense compact city', growth: 0.9, core: 1.35, sprawl: 0.8, gap: 0.6, tall: 1.4, block: 0.85 },
};

/**
 * A town's street lattice. Plain grids: lattice point (i, j) lies at origin + u * gu[i + n] + v * gv[j + n]
 * with u = (sin angle, cos angle), v = (cos angle, -sin angle). Other layouts store every point in `pts`.
 * Block (i, j) spans lattice points i..i+1, j..j+1.
 */
export interface TownGrid {
  ox: number; oz: number;
  angle: number;
  n: number;
  gu: number[];
  gv: number[];
  /** lattice segments that could not be built (see latticeKey) */
  failed: number[];
  /** the central block (0, 0) is a plaza (radial towns: the disc inside ring 1) */
  plaza: boolean;
  /** street layout (old saves: grid) */
  layout?: TownLayout;
  /** warped layouts: positions of all lattice points, [x, z] per point, index ((i + n) * (2n + 1) + j + n) */
  pts?: number[];
  /** linear towns: streets reach this many blocks across the main street, and `stretch` times further along it */
  across?: number;
  stretch?: number;
  /** lattice segments never built (deliberate gaps: lanes of an old town, left-out cross streets, spokes into a round square) */
  omit?: number[];
  /** lattice segments built as a bent street through a point beside the straight line (terrain, water, obstacles) */
  bent?: number[];
  /** running game: day from which failed segments are tried again */
  retry?: number;
}

export interface Town {
  id: number;
  name: string;
  x: number; z: number;
  angle: number;
  pop: number;
  buildings: Set<number>;
  radius: number;
  nextGrowthDay: number;
  hasChurch: boolean;
  passGenMonth: number; passTransMonth: number; passGenLast: number; passTransLast: number;
  /** passengers who gave up waiting at the town's stations this / last month (Stations.trimWaiting; old saves: none) */
  passLostMonth?: number; passLostLast?: number;
  /** active stations near the town at its last growth step (see townService) */
  served: number;
  /** street grid (towns from old saves get one on their next growth step) */
  grid?: TownGrid;
  /** growth profile (old saves: balanced) */
  profile?: GrowthProfile;
  /** size by which the town claims land against its neighbours (planned size, then its population) */
  claim?: number;
}

// ---------------------------------------------------------------- growth by public transport service
/**
 * How often a town grows follows its public transport, roughly as in OpenTTD: the stations near it that vehicles
 * called at recently (active stations), the share of its residents within their walking catchment weighted by how
 * often vehicles call (reach), the share of their passengers transported rather than giving up waiting, and the
 * stations' ratings. A town without public transport still grows, slowly. The growth step itself (lots, streets,
 * densification) is Towns.growStep; this only sets how often a town takes its steps (scripts/growth.ts: over 20
 * years well-served towns grow about 1.6-2.5x, poorly served ones 1.3-1.6x, towns without service 1.1-1.3x).
 */
/** A station near a town is active when a line serves it and a vehicle called within this many days (v2 calendar; building it is no call). */
export const GROWTH_ACTIVE_DAYS = 90;
/** Mean days between growth steps without public transport (about 1 % a year for a balanced town) and with the best service. */
export const GROWTH_DAYS_UNSERVED = 100, GROWTH_DAYS_BEST = 6;
/** Share of the residents reached by frequent service at which the reach counts fully (walking catchments are small). */
export const GROWTH_FULL_REACH = 0.12;
/** Service frequency that counts fully: vehicles called on this share of the last 30 days (Stations.callShare; 0.05: on two). */
export const GROWTH_FULL_CALLS = 0.05;
/** An active station without a call in the last 30 days still counts this much (a train every ~2 months still serves a town). */
export const GROWTH_MIN_CALLS = 0.15;
/** Station ratings from this (by catchment) count fully; lower ones slow growth. */
export const GROWTH_FULL_RATING = 0.7;
/** Growth speed labels by service score (index: score below 0.01, 0.2, 0.4, 0.6, else). */
const GROWTH_LABELS = ['slow', 'moderate', 'good', 'fast', 'very fast'];

/** A town's public transport and what it does for its growth (townService). */
export interface TownService {
  /** active stations near the town */
  stations: number;
  /** share of the residents in the walking catchment of the active stations (0..1) */
  coverage: number;
  /** that share weighted by how often vehicles called in the last 30 days (GROWTH_MIN_CALLS .. 1 from GROWTH_FULL_CALLS; 0..1) */
  reach: number;
  /** share of the passengers at the active stations who boarded rather than gave up waiting, this and last month (0..1) */
  transported: number;
  /** mean rating of the active stations (by their catchment) */
  rating: number;
  /** 0 (no service) .. 1 (frequent service for enough of the town, nobody left behind, good ratings) */
  score: number;
  /** how many times as often as a town without public transport the town takes its growth steps */
  speed: number;
  /** 'slow' .. 'very fast' */
  label: string;
}

/**
 * A town's public transport service and growth speed (Towns.daily schedules growth steps by it; the town window
 * shows it): score = reach (up to GROWTH_FULL_REACH) x (0.3 + 0.7 transported) x (0.4 + 0.6 rating, up to
 * GROWTH_FULL_RATING); the speed goes from 1 (no service) to GROWTH_DAYS_UNSERVED / GROWTH_DAYS_BEST (score 1). Each
 * active station reaches its catchment by how often vehicles called in the last 30 days (Stations.callShare), from
 * GROWTH_MIN_CALLS (none) to fully (GROWTH_FULL_CALLS).
 */
export function townService(g: Game, town: Town): TownService {
  let stations = 0, catchPop = 0, reached = 0, rated = 0, boarded = 0, lost = 0;
  const R = town.radius + 10;
  for (const st of g.stations.map.values()) {
    if (st.lastCall < 0 || g.day - st.lastCall > GROWTH_ACTIVE_DAYS || !g.lines.stationServed(st.id)) continue;
    if (Math.hypot(st.x - town.x, st.z - town.z) > R) continue;
    stations++;
    catchPop += st.catchPop;
    reached += st.catchPop * (GROWTH_MIN_CALLS + (1 - GROWTH_MIN_CALLS) * Math.min(1, g.stations.callShare(st) / GROWTH_FULL_CALLS));
    rated += st.catchPop * st.rating;
    boarded += st.pickupMonth + st.pickupLast;
    lost += (st.lostMonth || 0) + (st.lostLast || 0);
  }
  const pop = Math.max(1, town.pop);
  const coverage = Math.min(1, catchPop / pop), reach = Math.min(1, reached / pop);
  const rating = catchPop > 0 ? rated / catchPop : 0;
  const transported = boarded + lost > 0 ? boarded / (boarded + lost) : 1;
  const score = stations ? Math.min(1, reach / GROWTH_FULL_REACH) * (0.3 + 0.7 * transported) * (0.4 + 0.6 * Math.min(1, rating / GROWTH_FULL_RATING)) : 0;
  const speed = 1 + (GROWTH_DAYS_UNSERVED / GROWTH_DAYS_BEST - 1) * score;
  const label = GROWTH_LABELS[score < 0.01 ? 0 : score < 0.2 ? 1 : score < 0.4 ? 2 : score < 0.6 ? 3 : 4];
  return { stations, coverage, reach, transported, rating, score, speed, label };
}

/** Town traffic (ambient cars): about one car per TRAFFIC_PER_CAR inhabitants, between TRAFFIC_MIN and TRAFFIC_MAX cars on the map. */
export const TRAFFIC_PER_CAR = 150, TRAFFIC_MIN = 120, TRAFFIC_MAX = 900;

const TOWN_OPTS = (): BuildOptions => ({ kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: -1, town: true });
/** Towns grade their streets into the slopes: cuttings and banks up to this deep / high (9i). */
const TOWN_GRADE = 2;
/** Building lots are levelled to within this (9e: no tall plinths); lots that cannot be stay gardens. */
const PLINTH_MAX = 0.12, LOT_DIG = 0.25;
const LOT_SAMPLES: [number, number][] = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

const latticeKey = (g: TownGrid, i: number, j: number, dir: number) => ((i + g.n) * (2 * g.n + 1) + (j + g.n)) * 2 + dir;
/** The lattice segment between two neighbouring points (i, j dir) */
const segBetween = (a: [number, number], b: [number, number]): [number, number, number] =>
  a[0] === b[0] ? [a[0], Math.min(a[1], b[1]), 1] : [Math.min(a[0], b[0]), a[1], 0];

/**
 * Street sides found full (no lot left) per town. Transient: edge ids are never reused; the set is
 * forgotten when the town lost buildings (demolition frees lots) and every two years (terraforming).
 */
const fullSides = new WeakMap<Town, { set: Set<number>; day: number; n: number }>();
const sideKey = (e: NEdge, side: number) => e.id * 2 + (side > 0 ? 1 : 0);
function fullSet(town: Town, day: number): Set<number> {
  let f = fullSides.get(town);
  if (!f || day - f.day > 720 || town.buildings.size < f.n) { f = { set: new Set(), day, n: 0 }; fullSides.set(town, f); }
  f.n = town.buildings.size;
  return f.set;
}

/** A town's own streets, recomputed when the network or the towns' land claims changed (transient). */
const streetCache = new WeakMap<Town, { v: number; claims: number; list: NEdge[] }>();
/**
 * Lattice segments known to be built / lattice points known to have a node, valid for one network version
 * (a town's own new street keeps the cache: it only adds its own segment).
 */
const latticeMemo = new WeakMap<TownGrid, { v: number; built: Map<number, boolean>; nodes: Map<number, number> }>();

/** Transient per-grid caches: reserved (park / plaza) blocks and a lookup of lattice points. */
const reservedCache = new WeakMap<TownGrid, { key: string; quads: { type: number; q: number[] }[] }>();
const pointIndex = new WeakMap<TownGrid, Map<number, number[]>>();
/**
 * Road nodes connected to a town's centre within its lattice's extent (transient). Always the exact component
 * for the network version (a pure function of the saved state): recomputed when anything else changed the
 * network, extended along the town's own new streets.
 */
const connCache = new WeakMap<TownGrid, { v: number; set: Set<number> }>();
const extentCache = new WeakMap<TownGrid, number>();
/** Lattice points tried for the centre node (ring towns with a round square: around the square). */
const CENTRE_PTS: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

/** Oriented rectangle overlap test (SAT) with an extra margin. */
export function rectsOverlap(a: { x: number; z: number; angle: number; w: number; d: number }, b: { x: number; z: number; angle: number; w: number; d: number }, margin = 0): boolean {
  const axes = (r: typeof a) => [[Math.cos(r.angle), -Math.sin(r.angle)], [Math.sin(r.angle), Math.cos(r.angle)]];
  const corners = (r: typeof a) => {
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const hw = r.w / 2 + margin / 2, hd = r.d / 2 + margin / 2;
    return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => [r.x + rx * hw * sx + fx * hd * sz, r.z + rz * hw * sx + fz * hd * sz]);
  };
  const ca = corners(a), cb = corners(b);
  for (const ax of [...axes(a), ...axes(b)]) {
    let amin = Infinity, amax = -Infinity, bmin = Infinity, bmax = -Infinity;
    for (const c of ca) { const p = c[0] * ax[0] + c[1] * ax[1]; amin = Math.min(amin, p); amax = Math.max(amax, p); }
    for (const c of cb) { const p = c[0] * ax[0] + c[1] * ax[1]; bmin = Math.min(bmin, p); bmax = Math.max(bmax, p); }
    if (amax < bmin || bmax < amin) return false;
  }
  return true;
}

/** Point inside a polygon given as [x0, z0, x1, z1, ...]. */
function inPoly(x: number, z: number, q: number[]): boolean {
  let inside = false;
  for (let i = 0, j = q.length - 2; i < q.length; j = i, i += 2) {
    const xi = q[i], zi = q[i + 1], xj = q[j], zj = q[j + 1];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** Square ring k of the lattice mapped onto a circle: angle of lattice point (i, j) (uniform along the ring). */
function ringAngle(i: number, j: number): number {
  const k = Math.max(Math.abs(i), Math.abs(j));
  if (k === 0) return 0;
  let t: number;
  if (i === k && j > -k) t = j + k;
  else if (j === k) t = 2 * k + (k - i);
  else if (i === -k) t = 4 * k + (k - j);
  else t = 6 * k + (i + k);
  return (2 * Math.PI * t) / (8 * k) - Math.PI / 4;
}

export class Towns {
  list: Town[] = [];
  /** planned populations while the world is generated (towns claim land by their final size) */
  private plan = new Map<Town, number>();
  constructor(public game: Game) {}

  get world(): World { return this.game.world; }
  get(id: number): Town { return this.list[id]; }

  nearest(x: number, z: number): Town | null {
    let best: Town | null = null, bd = Infinity;
    for (const t of this.list) {
      const d = Math.hypot(t.x - x, t.z - z) / (1 + Math.sqrt(t.pop) / 60);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }

  /** Growth cache of a town for saving (a loaded game then grows exactly like the original). */
  cacheOf(town: Town): { full: number[]; day: number; n: number } | undefined {
    const f = fullSides.get(town);
    return f ? { full: [...f.set], day: f.day, n: f.n } : undefined;
  }
  restoreCache(town: Town, c: { full?: unknown; day?: unknown; n?: unknown } | undefined) {
    if (c && Array.isArray(c.full)) fullSides.set(town, { set: new Set(c.full as number[]), day: Number(c.day) || 0, n: Number(c.n) || 0 });
  }

  /** The town whose land a point is: nearest centre, weighted by the towns' land claims (size). */
  owner(x: number, z: number): Town | null {
    let best: Town | null = null, bd = Infinity;
    for (const t of this.list) {
      const d = Math.hypot(t.x - x, t.z - z) / (1 + Math.sqrt(t.claim ?? Math.max(t.pop, this.plan.get(t) ?? 0)) / 60);
      if (d < bd) { bd = d; best = t; }
    }
    return best;
  }
  private claimsKey(): number { let k = 0; for (const t of this.list) k += t.claim ?? t.pop; return k; }

  recomputePop(town: Town) {
    let p = 0, r = 4;
    for (const id of town.buildings) {
      const b = this.world.buildings.get(id);
      if (!b) { town.buildings.delete(id); continue; }
      p += b.pop;
      r = Math.max(r, Math.hypot(b.x - town.x, b.z - town.z));
    }
    town.pop = p;
    town.radius = r;
  }

  demolishBuilding(id: number) {
    const b = this.world.buildings.get(id);
    if (!b) return;
    const town = this.list[b.townId];
    this.world.removeBuilding(id);
    if (town) { town.buildings.delete(id); this.recomputePop(town); if (b.type === BT_CHURCH) town.hasChurch = false; }
  }

  profileOf(town: Town): ProfileSpec { return GROWTH_PROFILES[town.profile ?? 'balanced'] ?? GROWTH_PROFILES.balanced; }

  /**
   * Town traffic on the map (Vehicles.manageAmbient): how many cars, and how many inhabitants each town has per car
   * (TRAFFIC_PER_CAR; more once the map reaches TRAFFIC_MAX cars, fewer up to TRAFFIC_MIN cars, but at least 100).
   */
  traffic(): { cars: number; perCar: number } {
    let pop = 0;
    for (const t of this.list) pop += t.pop;
    const cars = Math.max(TRAFFIC_MIN, Math.min(TRAFFIC_MAX, Math.round(pop / TRAFFIC_PER_CAR)));
    return { cars, perCar: Math.max(100, pop / cars) };
  }

  // ---------------------------------------------------------------- generation
  generate(count: number, seed: number, cityFraction = 0.17) {
    const w = this.world;
    const rng = new RNG(seed * 13 + 77);
    const used = new Set<string>();
    const s = w.size;
    // open country between the towns: sites keep a distance of ~3/4 of the mean spacing (relaxed only
    // when a crowded map has no room left)
    let minDist = Math.max(45, Math.sqrt((s * s) / Math.max(1, count)) * 0.76);
    const nCity = Math.max(1, Math.round(count * cityFraction));
    // hill towns: a few of the smaller towns sit on hilltops (if the map has any)
    const nHill = count >= 6 ? 1 + (count >= 16 ? 1 : 0) : 0;
    const sites: { x: number; z: number; hill: boolean }[] = [];
    for (let i = 0; i < count; i++) {
      let best: { x: number; z: number; score: number; hill: boolean } | null = null;
      for (let relax = 0; relax < 4 && !best; relax++) {
      if (relax) minDist *= 0.88;
      for (const hill of i >= count - nHill ? [true, false] : [false]) {
        for (let tries = 0; tries < (hill ? 900 : 400) && !(best && !hill); tries++) {
        const x = 30 + rng.next() * (s - 60), z = 30 + rng.next() * (s - 60);
        if (w.heightAt(x, z) < WATER_Y + (hill ? 2 : 1)) continue;
        if (sites.some((o) => Math.hypot(o.x - x, o.z - z) < minDist)) continue;
        let score: number;
        if (hill) {
          // a hilltop: lower ground all around (no water near), a flat-ish top
          const h0 = w.heightAt(x, z);
          let ring = 0, top = 0, lower = 0, lo = Infinity, above = false;
          for (let k = 0; k < 16; k++) {
            const a = (k / 16) * Math.PI * 2;
            const hr = w.heightAt(x + Math.sin(a) * 16, z + Math.cos(a) * 16);
            ring += hr / 16; if (hr < h0 - 0.2) lower++; lo = Math.min(lo, hr, w.heightAt(x + Math.sin(a) * 24, z + Math.cos(a) * 24));
            top = Math.max(top, Math.abs(w.heightAt(x + Math.sin(a) * 3.5, z + Math.cos(a) * 3.5) - h0));
            // the top itself: no higher ground close by (the rings could not follow the contours)
            if (w.heightAt(x + Math.sin(a) * 7, z + Math.cos(a) * 7) > h0 + 0.3 || w.heightAt(x + Math.sin(a) * 12, z + Math.cos(a) * 12) > h0 + 0.2) above = true;
          }
          if (above) continue;
          // a gentle hill, mostly falling away all around (streets of up to ~10 % between the contour rings)
          if (lower < 12 || lo < WATER_Y + 0.4 || h0 - ring < 0.8 || h0 - ring > 3.2) continue;
          score = Math.min(h0 - ring, 2) + lower * 0.1 - top * 2.5 + rng.next();
        } else {
          let mn = Infinity, mx = -Infinity, water = 0;
          for (let dz = -12; dz <= 12; dz += 4) for (let dx = -12; dx <= 12; dx += 4) {
            const h = w.heightAt(x + dx, z + dz);
            if (h < WATER_Y + 0.3) water++;
            mn = Math.min(mn, h); mx = Math.max(mx, h);
          }
          score = -(mx - mn) * 1.5 - water * 1.5 + rng.next() * 3;
        }
        if (!best || score > best.score) best = { x, z, score, hill };
        }
        if (best) break; // no hilltop on this map: an ordinary site
      }
      }
      if (!best) continue;
      sites.push(best);
    }
    // sizes: a few cities (the largest ~4,000-6,000 people), market towns of 800-2,700 and villages of
    // 200-675 (hill towns are towns); everything smaller on crowded maps
    const land = Math.max(0.55, Math.min(1, (s * s) / Math.max(1, count) / 24576));
    const nVillage = Math.round((sites.length - nCity) * 0.35);
    const tierOf = (i: number): 'city' | 'town' | 'village' => i < nCity ? 'city' : sites[i].hill ? 'town'
      : i >= sites.length - nHill - nVillage ? 'village' : 'town';
    // soften the terrain around town centres (hill towns only flatten their top)
    sites.forEach((site, i) => {
      const tier = tierOf(i);
      this.flatten(site.x, site.z, site.hill ? 8 : tier === 'city' ? 26 : tier === 'town' ? 22 : 16, site.hill ? 0.6 : 0.75);
    });
    // all towns first, so each claims its land (see owner) before any of them is laid out
    const layouts: TownLayout[] = [];
    const axes: { angle: number; ratio: number; coast: boolean; rough: number }[] = [];
    sites.forEach((site, i) => {
      const tier = tierOf(i), isCity = tier === 'city';
      const town: Town = {
        id: this.list.length, name: townName(rng, used), x: site.x, z: site.z, angle: 0,
        pop: 0, buildings: new Set(), radius: 4, nextGrowthDay: rng.int(30), hasChurch: false,
        passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, passLostMonth: 0, passLostLast: 0, served: 0,
      };
      this.list.push(town);
      // fewer but larger towns (9g): every tier 35 % larger than before
      const size = 1.35 * (tier === 'city' ? (i === 0 ? 3000 + rng.int(1500) : 2000 + rng.int(1800)) : tier === 'town' ? 600 + rng.int(1400) : 150 + rng.int(350));
      this.plan.set(town, Math.max(120, Math.round(size * land)));
      town.claim = this.plan.get(town)!;
      // growth profile and layout from size and terrain
      const pick = <T,>(opts: [T, number][]): T => { let r = rng.next() * opts.reduce((a, o) => a + o[1], 0); for (const [v, p] of opts) { r -= p; if (r <= 0) return v; } return opts[0][0]; };
      town.profile = site.hill ? pick<GrowthProfile>([['historic', 0.6], ['compact', 0.4]])
        : isCity ? pick<GrowthProfile>([['industrial', 0.35], ['compact', 0.3], ['balanced', 0.35]])
        : tier === 'town' ? pick<GrowthProfile>([['historic', 0.25], ['suburban', 0.3], ['balanced', 0.35], ['compact', 0.1]])
        : pick<GrowthProfile>([['historic', 0.35], ['suburban', 0.3], ['balanced', 0.35]]);
      const ax = this.terrainAxis(town.x, town.z, isCity ? 36 : 26);
      axes.push(ax);
      let layout: TownLayout = 'grid';
      if (site.hill) layout = 'hill';
      else if ((ax.ratio > 2.2 || ax.coast) && !isCity && rng.chance(0.65)) layout = 'linear';
      else if (isCity && ax.rough < 0.5 && !ax.coast && rng.chance(0.45)) layout = 'radial';
      else if (rng.chance(town.profile === 'historic' ? 0.7 : tier === 'village' ? 0.45 : 0.25)) layout = 'organic';
      layouts.push(layout);
    });
    // a varied map: a radial city (the flattest), a linear town (the most valley-like site) and some
    // organic old towns, when there are enough towns
    if (this.list.length >= 6) {
      const grids = (pred: (i: number) => boolean) => layouts.map((l, i) => i).filter((i) => layouts[i] === 'grid' && pred(i));
      if (!layouts.includes('radial')) {
        const c = grids((i) => i < nCity && !axes[i].coast && axes[i].rough < 0.6).sort((a, b) => axes[a].rough - axes[b].rough)[0];
        if (c !== undefined) layouts[c] = 'radial';
      }
      if (!layouts.includes('linear')) {
        const c = grids((i) => i >= nCity).sort((a, b) => (axes[b].ratio + (axes[b].coast ? 2 : 0)) - (axes[a].ratio + (axes[a].coast ? 2 : 0)))[0];
        if (c !== undefined) layouts[c] = 'linear';
      }
      for (let k = layouts.filter((l) => l === 'organic').length; k < Math.ceil(this.list.length / 5); k++) {
        const c = grids((i) => i >= nCity)[0] ?? grids(() => true)[0];
        if (c === undefined) break;
        layouts[c] = 'organic';
      }
    }
    // ring towns level their ground further out (rings cannot close on steep slopes)
    for (const town of this.list) if (layouts[town.id] === 'radial') this.flatten(town.x, town.z, 46, 0.8);
    for (const town of this.list) {
      const target = this.plan.get(town)!;
      town.grid = this.makeGrid(town, rng, target, layouts[town.id] ?? 'grid');
      town.angle = town.grid.angle;
      this.layoutTown(town, target);
      let guard = 0, misses = 0;
      while (town.pop < target && guard++ < 20000 && misses < 40) misses = this.growStep(town, rng, 0, target) ? 0 : misses + 1;
      this.altBudget = Infinity;
      this.closeDeadEnds(town);
    }
    this.plan.clear();
    this.tidyBridgeEnds();
  }

  /** Level the ground around a town centre towards the centre's height (full weight k0 within 0.35 R). */
  private flatten(cx: number, cz: number, R: number, k0: number) {
    const w = this.world, s = w.size;
    const base = Math.max(WATER_Y + 1, w.heightAt(cx, cz));
    for (let z = Math.floor(cz - R); z <= Math.ceil(cz + R); z++) for (let x = Math.floor(cx - R); x <= Math.ceil(cx + R); x++) {
      if (x < 1 || z < 1 || x >= s || z >= s) continue;
      const d = Math.hypot(x - cx, z - cz);
      const wgt = (1 - smoothstep(R * 0.35, R, d)) * k0;
      if (wgt <= 0) continue;
      const k = w.vi(x, z);
      const h = w.h[k];
      if (h < WATER_Y && d > 8) continue;
      w.h[k] = h + (base - h) * wgt;
    }
    w.heightsVersion++;
    w.terrainVersions.bump([cx - R - 1, cz - R - 1, cx + R + 1, cz + R + 1]);
    w.frontageTerrainVersions.bump([cx - R - 1, cz - R - 1, cx + R + 1, cz + R + 1]);
  }

  /** Flattest direction around a point (valleys, coasts), how anisotropic the ground is and whether water is near. */
  terrainAxis(x: number, z: number, R: number, a0 = 0): { angle: number; ratio: number; coast: boolean; rough: number } {
    const w = this.world;
    const rough = (dx: number, dz: number) => {
      let c = 0, prev = w.heightAt(x - dx * R, z - dz * R);
      for (let s = -R + 2; s <= R; s += 2) {
        const px = x + dx * s, pz = z + dz * s;
        const h = w.heightAt(px, pz);
        c += Math.abs(h - prev) + (h < WATER_Y + 0.3 ? 3 : 0) + (w.inside(px, pz, 5) ? 0 : 3);
        prev = h;
      }
      return c;
    };
    let best = 0, bc = Infinity, worst = 0;
    for (let k = 0; k < 18; k++) {
      const a = a0 + (k / 18) * Math.PI;
      const cu = rough(Math.sin(a), Math.cos(a)), cv = rough(Math.cos(a), -Math.sin(a));
      const cost = cu + 0.6 * cv;
      if (cost < bc - 1e-9) { bc = cost; best = a; worst = cv / Math.max(1, cu); }
    }
    let water = 0;
    for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; if (w.heightAt(x + Math.sin(a) * R * 0.7, z + Math.cos(a) * R * 0.7) < WATER_Y + 0.2) water++; }
    return { angle: best % Math.PI, ratio: worst, coast: water >= 2 && water <= 6, rough: bc / R };
  }

  // ---------------------------------------------------------------- street lattices
  /**
   * A street lattice for a town. The main axis follows the flattest direction; blocks ~8-12 x 6-9
   * (profile scaled, smaller in the core); organic, radial, linear and hill towns warp the lattice.
   */
  makeGrid(town: Town, rng: RNG, target: number, layout: TownLayout = 'grid'): TownGrid {
    const prof = this.profileOf(town);
    const ax = this.terrainAxis(town.x, town.z, 14 + Math.sqrt(Math.max(200, target)) * 0.35, rng.next() * Math.PI);
    const n = 10;
    const scale = prof.block * (layout === 'organic' ? 0.85 : layout === 'hill' ? 0.9 : 1);
    const bu = (8 + rng.next() * 4) * scale, bv = (6 + rng.next() * 3) * scale;
    const big = target > 2500;
    const gu = new Array<number>(2 * n + 1).fill(0), gv = new Array<number>(2 * n + 1).fill(0);
    // blocks vary by +-20 %
    const vary = () => 0.8 + rng.next() * 0.4;
    for (let k = 1; k <= n; k++) {
      // old cores have smaller blocks (cities more so)
      const core = k <= 1 ? (big ? 0.75 : 0.85) : k === 2 ? (big ? 0.85 : 0.93) : k === 3 && big ? 0.95 : 1;
      gu[n + k] = gu[n + k - 1] + bu * core * vary();
      gu[n - k] = gu[n - k + 1] - bu * core * vary();
      gv[n + k] = gv[n + k - 1] + bv * core * vary();
      gv[n - k] = gv[n - k + 1] - bv * core * vary();
    }
    const g: TownGrid = { ox: town.x, oz: town.z, angle: ax.angle, n, gu, gv, failed: [], plaza: false, layout, omit: [] };
    if (layout === 'grid') this.warpGrid(g, rng, bu, bv);
    else if (layout === 'organic') this.warpOrganic(g, rng, target);
    else if (layout === 'radial') this.radialPoints(g, rng, bv * 1.1, null);
    else if (layout === 'hill') this.radialPoints(g, rng, bv * 1.1, town);
    else if (layout === 'linear') this.linearPoints(g, rng, bu, target);
    if (g.pts) for (let k = 0; k < g.pts.length; k++) g.pts[k] = Math.round(g.pts[k] * 100) / 100;
    return g;
  }

  /**
   * A planned grid, but not a perfect one: on top of the varying block sizes the street lines drift by a few
   * degrees and bend gently (smooth low-frequency displacement of the lattice points, different for every
   * line, plus a slight twist growing outwards), and a few cross streets are left out (T junctions).
   */
  private warpGrid(g: TownGrid, rng: RNG, bu: number, bv: number) {
    const n = g.n, sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    const ph = [0, 0, 0].map(() => rng.next() * Math.PI * 2), fr = [0, 0, 0, 0].map(() => 0.3 + rng.next() * 0.3);
    const au = 0.1 * bu, av = 0.11 * bv, twist = (rng.next() - 0.5) * 0.08;
    const R = Math.max(g.gu[2 * n], -g.gu[0], g.gv[2 * n], -g.gv[0]) || 1;
    const pts: number[] = [];
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      // shifting along u bends the cross streets (constant i), along v the long streets (constant j)
      let a = g.gu[i + n] + au * Math.sin(j * fr[0] + i * fr[1] * 0.5 + ph[0]) - au * Math.sin(ph[0]);
      let b = g.gv[j + n] + av * Math.sin(i * fr[2] + j * fr[3] * 0.5 + ph[1]) - av * Math.sin(ph[1]);
      if (i === 0 && j === 0) { a = 0; b = 0; }
      let x = sa * a + ca * b, z = ca * a - sa * b;
      const t = twist * Math.min(1, Math.hypot(x, z) / R), c = Math.cos(t), s = Math.sin(t);
      [x, z] = [x * c - z * s, x * s + z * c];
      pts.push(g.ox + x, g.oz + z);
    }
    g.pts = pts;
    this.omitSome(g, 0.07, 2, ph[2]);
  }

  /**
   * Leave out a share of the lattice segments from ring `minRing` on (never along the main axes, at most one
   * per lattice point, so no point is cut off): irregular blocks and T junctions.
   */
  private omitSome(g: TownGrid, rate: number, minRing: number, seed: number) {
    const n = g.n, s = Math.floor(seed * 1000);
    const used = new Set<number>(), pk = (i: number, j: number) => (i + n) * 64 + j + n;
    for (let i = -n; i < n; i++) for (let j = -n; j < n; j++) for (const dir of [0, 1]) {
      const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
      if (Math.max(Math.abs(i), Math.abs(j), Math.abs(i2), Math.abs(j2)) < minRing) continue;
      if ((dir === 0 && j === 0) || (dir === 1 && i === 0) || used.has(pk(i, j)) || used.has(pk(i2, j2))) continue;
      if (hash2(i + 50, j * 2 + dir + 50, s) >= rate) continue;
      (g.omit ??= []).push(latticeKey(g, i, j, dir));
      used.add(pk(i, j)); used.add(pk(i2, j2));
    }
  }

  /** Organic old town: the grid bent and twisted inside the old core, fading into a regular grid outside. */
  private warpOrganic(g: TownGrid, rng: RNG, target: number) {
    const n = g.n, old = target > 2500 ? 3 : 2;
    const amp = 0.32 * Math.min(g.gu[n + 1] - g.gu[n], g.gv[n + 1] - g.gv[n]);
    const ph = [0, 0, 0, 0, 0, 0].map(() => rng.next() * Math.PI * 2), fr = [0, 0, 0, 0].map(() => 0.7 + rng.next() * 0.7);
    const twist = (rng.chance(0.5) ? 1 : -1) * (0.18 + rng.next() * 0.2);
    const rOld = Math.max(g.gu[n + old], g.gv[n + old]) * 1.1;
    const sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    const pts: number[] = [];
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const a = g.gu[i + n], b = g.gv[j + n];
      let x = sa * a + ca * b, z = ca * a - sa * b;
      const k = Math.max(Math.abs(i), Math.abs(j));
      if (k > 0) {
        const fade = 1 - smoothstep(old - 0.5, old + 1.5, k);
        const r = Math.hypot(x, z), tw = twist * (1 - smoothstep(0, rOld, r));
        const c = Math.cos(tw), s = Math.sin(tw);
        [x, z] = [x * c - z * s, x * s + z * c];
        x += amp * fade * (Math.sin(i * fr[0] + j * fr[1] + ph[0]) + 0.5 * Math.sin(i * fr[2] - j * fr[3] + ph[1])) / 1.5;
        z += amp * fade * (Math.sin(i * fr[1] - j * fr[0] + ph[2]) + 0.5 * Math.sin(-i * fr[3] + j * fr[2] + ph[3])) / 1.5;
      }
      pts.push(g.ox + x, g.oz + z);
    }
    g.pts = pts;
    // irregular blocks: some lanes of the old town were never built (not the main streets)
    for (let i = -old; i < old; i++) for (let j = -old; j <= old; j++) {
      for (const dir of [0, 1]) {
        const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
        if (Math.max(Math.abs(i2), Math.abs(j2)) > old || (dir === 0 && j === 0) || (dir === 1 && i === 0)) continue;
        if (i >= -1 && i <= 1 && j >= -1 && j <= 1) continue; // around the market square
        if (hash2(i + 50, j * 2 + dir + 50, Math.floor(ph[4] * 1000)) < 0.13) (g.omit ??= []).push(latticeKey(g, i, j, dir));
      }
    }
  }

  /**
   * Radial town (avenues from a central square plus ring roads) or, with `hill`, a hill town whose ring
   * streets follow the contours: lattice ring k is mapped onto a closed ring around the centre.
   */
  private radialPoints(g: TownGrid, rng: RNG, spacing: number, hill: Town | null) {
    const w = this.world, n = g.n;
    const R: number[][] = [[0]];
    const h0 = w.heightAt(g.ox, g.oz);
    // contour interval: street grades of ~8 % between rings
    let dh = 0;
    if (hill) {
      let sl = 0;
      for (let k = 0; k < 12; k++) { const a = (k / 12) * Math.PI * 2; sl += Math.abs(h0 - w.heightAt(g.ox + Math.sin(a) * 14, g.oz + Math.cos(a) * 14)) / 14 / 12; }
      dh = Math.max(0.3, Math.min(0.62, sl * 7));
    }
    const dirAt = (phi: number) => ({ x: Math.cos(phi + g.angle), z: Math.sin(phi + g.angle) });
    for (let k = 1; k <= n; k++) {
      const m = 8 * k, ring: number[] = [];
      const base = k === 1 ? spacing * 0.95 : spacing * (k <= 2 ? 0.9 : 1) * (0.94 + rng.next() * 0.12);
      for (let t = 0; t < m; t++) {
        const phi = (2 * Math.PI * t) / m - Math.PI / 4;
        // radius of the previous ring at this angle
        const prev = R[k - 1];
        let rp = 0;
        if (k > 1) {
          const f = (((phi + Math.PI / 4) / (2 * Math.PI)) * prev.length + prev.length) % prev.length;
          const a = Math.floor(f), b = (a + 1) % prev.length;
          rp = prev[a] + (prev[b] - prev[a]) * (f - a);
        }
        let r = rp + base;
        if (hill) {
          const d = dirAt(phi);
          const want = h0 - k * dh;
          // the contour at the wanted height, or (along a ridge) the spot nearest to it
          let bd = Infinity;
          r = rp + base * 1.15;
          for (let q = rp + base * 0.8; q <= rp + base * 1.9; q += 0.5) {
            const h = w.heightAt(g.ox + d.x * q, g.oz + d.z * q);
            if (h <= want) { r = q; break; }
            if (h - want < bd - 0.05) { bd = h - want; r = q; }
          }
        }
        ring.push(r);
      }
      // smooth the ring (no jagged contours)
      R.push(ring.map((r, t) => (ring[(t + m - 1) % m] + 2 * r + ring[(t + 1) % m]) / 4));
    }
    // not perfect circles: slightly elliptical, wobbly rings, and the streets between the rings are not
    // evenly spaced (each point shifted along its ring by up to a sixth of the spacing); hill towns follow
    // their contours as they are
    const soft = hill ? 0 : 1;
    const ell = (0.04 + rng.next() * 0.05) * soft, phE = rng.next() * Math.PI, wob = (0.02 + rng.next() * 0.03) * soft, phW = rng.next() * Math.PI * 2;
    const js = rng.int(1 << 20);
    const pts: number[] = [];
    for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) {
      const k = Math.max(Math.abs(i), Math.abs(j));
      if (k === 0) { pts.push(g.ox, g.oz); continue; }
      const phi = ringAngle(i, j), m = 8 * k;
      const t = Math.round(((phi + Math.PI / 4) / (2 * Math.PI)) * m + m) % m;
      const pj = phi + (hash2(i + 77, j + 77, js) - 0.5) * 0.35 * soft * ((2 * Math.PI) / m);
      const d = dirAt(pj), r = R[k][t] * (1 + ell * Math.cos(2 * (phi - phE)) + wob * Math.sin(3 * phi + phW));
      pts.push(g.ox + d.x * r, g.oz + d.z * r);
    }
    g.pts = pts;
  }

  /** Linear town: the main street follows the valley floor or the coast; short side streets and back lanes. */
  private linearPoints(g: TownGrid, rng: RNG, step: number, target: number) {
    const w = this.world, n = g.n;
    const P: { x: number; z: number }[] = new Array(2 * n + 1);
    P[n] = { x: g.ox, z: g.oz };
    for (const dir of [1, -1]) {
      let h = g.angle + (dir < 0 ? Math.PI : 0), prev = P[n];
      for (let i = 1; i <= n; i++) {
        let best = { x: prev.x + Math.sin(h) * step, z: prev.z + Math.cos(h) * step }, bc = Infinity, bt = 0;
        for (const dt of [-0.3, -0.15, 0, 0.15, 0.3]) {
          const a = h + dt, x = prev.x + Math.sin(a) * step, z = prev.z + Math.cos(a) * step;
          let c = Math.abs(w.heightAt(x, z) - w.heightAt(prev.x, prev.z)) * 4 + Math.abs(dt) * 3 + (w.inside(x, z, 8) ? 0 : 100);
          if (w.heightAt(x, z) < WATER_Y + 0.4) c += 40;
          for (const s of [-3, 3]) if (w.heightAt(x + Math.cos(a) * s, z - Math.sin(a) * s) < WATER_Y + 0.2) c += 8;
          if (c < bc) { bc = c; best = { x, z }; bt = dt; }
        }
        h += bt;
        P[n + dir * i] = best;
        prev = best;
      }
    }
    const pts: number[] = [];
    for (let i = -n; i <= n; i++) {
      const a = P[Math.max(0, i + n - 1)], b = P[Math.min(2 * n, i + n + 1)];
      const dx = b.x - a.x, dz = b.z - a.z, l = Math.hypot(dx, dz) || 1;
      const nx = -dz / l, nz = dx / l;
      for (let j = -n; j <= n; j++) pts.push(P[i + n].x + nx * g.gv[j + n], P[i + n].z + nz * g.gv[j + n]);
    }
    g.pts = pts;
    g.across = target > 2000 ? 3 : 2;
    g.stretch = 2.5;
  }

  /** World position of lattice point (i, j). */
  latticePoint(g: TownGrid, i: number, j: number): { x: number; z: number } {
    if (g.pts) { const k = ((i + g.n) * (2 * g.n + 1) + (j + g.n)) * 2; return { x: g.pts[k], z: g.pts[k + 1] }; }
    const a = g.gu[i + g.n], b = g.gv[j + g.n];
    const sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    return { x: g.ox + sa * a + ca * b, z: g.oz + ca * a - sa * b };
  }

  /** Ring of a lattice point (how far out it is, in blocks; linear towns reach further along than across). */
  ringOf(g: TownGrid, i: number, j: number): number {
    if (g.layout === 'linear') return Math.abs(j) > (g.across ?? 2) ? 99 : Math.max(Math.ceil(Math.abs(i) / (g.stretch ?? 2.5)), Math.abs(j));
    return Math.max(Math.abs(i), Math.abs(j));
  }
  private segRing(g: TownGrid, i: number, j: number, dir: number): number {
    return Math.max(this.ringOf(g, i, j), dir === 0 ? this.ringOf(g, i + 1, j) : this.ringOf(g, i, j + 1));
  }

  /** Block (i, j) containing a point (plain grids only), or null. */
  cellAt(g: TownGrid, x: number, z: number): [number, number] | null {
    if (g.pts) return null;
    const sa = Math.sin(g.angle), ca = Math.cos(g.angle);
    const dx = x - g.ox, dz = z - g.oz;
    const a = dx * sa + dz * ca, b = dx * ca - dz * sa;
    const find = (arr: number[], v: number) => { for (let k = 0; k < arr.length - 1; k++) if (v >= arr[k] && v < arr[k + 1]) return k - g.n; return null; };
    const i = find(g.gu, a), j = find(g.gv, b);
    return i === null || j === null ? null : [i, j];
  }

  /** Planned extent (in rings from the centre) for a population (more for sprawling towns). */
  plannedRing(pop: number, town?: Town): number {
    const sprawl = town ? this.profileOf(town).sprawl : 1;
    return Math.max(1, Math.min(9, Math.ceil((Math.sqrt(Math.max(1, pop) / 120) / 2) * sprawl)));
  }

  private memo(g: TownGrid) {
    const v = this.world.net.version;
    let m = latticeMemo.get(g);
    if (!m || m.v !== v) { m = { v, built: new Map(), nodes: new Map() }; latticeMemo.set(g, m); }
    return m;
  }

  /** The road node at lattice point (i, j), or -1. */
  private latticeNodeId(g: TownGrid, i: number, j: number): number {
    if (Math.abs(i) > g.n || Math.abs(j) > g.n) return -1;
    const m = this.memo(g), key = (i + g.n) * 4096 + j + g.n;
    let v = m.nodes.get(key);
    if (v === undefined) {
      const p = this.latticePoint(g, i, j);
      v = this.world.net.nearestNode(p.x, p.z, 0.9, 'road', (nn) => nn.edges.length > 0)?.id ?? -1;
      m.nodes.set(key, v);
    }
    return v;
  }

  /** The node at the centre of a town's street lattice (towns around a round square: the first one around it). */
  centreNode(town: Town): NNode | null {
    const g = town.grid;
    if (!g) return null;
    for (const [i, j] of CENTRE_PTS) {
      const id = this.latticeNodeId(g, i, j);
      if (id >= 0) return this.world.net.nodes.get(id) ?? null;
    }
    return null;
  }

  /** Road nodes connected to the town's centre (within the extent of its lattice). */
  private connected(town: Town): Set<number> {
    const g = town.grid!, v = this.world.net.version;
    const c = connCache.get(g);
    if (c && c.v === v) return c.set;
    const set = new Set<number>();
    const seed = this.centreNode(town);
    if (seed) { set.add(seed.id); this.flood(g, set, [seed.id]); }
    connCache.set(g, { v, set });
    return set;
  }

  /** Add the nodes reachable from `from` (within the lattice's extent) to a connected set. */
  private flood(g: TownGrid, set: Set<number>, from: number[]) {
    const net = this.world.net;
    let R = extentCache.get(g);
    if (R === undefined) {
      R = 0;
      for (let i = -g.n; i <= g.n; i++) for (let j = -g.n; j <= g.n; j++) { const p = this.latticePoint(g, i, j); R = Math.max(R, Math.hypot(p.x - g.ox, p.z - g.oz)); }
      R += 15;
      extentCache.set(g, R);
    }
    const R2 = R * R, q = [...from];
    while (q.length) {
      const n = net.nodes.get(q.pop()!);
      if (!n) continue;
      for (const eid of n.edges) {
        const e = net.edges.get(eid);
        if (!e || e.kind !== 'road') continue;
        const o = e.a === n.id ? e.b : e.a;
        if (set.has(o)) continue;
        const on = net.nodes.get(o);
        if (!on || (on.x - g.ox) ** 2 + (on.z - g.oz) ** 2 > R2) continue;
        set.add(o);
        q.push(o);
      }
    }
  }

  /** After the town built a street from its network: extend the connected set (keeps it exact). */
  private afterOwnCommit(g: TownGrid, v0: number, e0: number) {
    const net = this.world.net;
    const c = connCache.get(g);
    if (!c || c.v !== v0) return;
    if (!c.set.size) { connCache.delete(g); return; }
    const start: number[] = [];
    for (let id = e0; id < net.nextEdge; id++) {
      const e = net.edges.get(id);
      if (e) for (const nid of [e.a, e.b]) if (c.set.has(nid)) start.push(nid);
    }
    this.flood(g, c.set, start);
    c.v = net.version;
  }

  /** Is lattice point (i, j) on the town's connected street network? */
  private isConnected(town: Town, i: number, j: number): boolean {
    const id = this.latticeNodeId(town.grid!, i, j);
    return id >= 0 && this.connected(town).has(id);
  }

  /** A deliberately left out lattice segment? */
  isOmitted(g: TownGrid, i: number, j: number, dir: number): boolean { return !!g.omit?.includes(latticeKey(g, i, j, dir)); }
  /** A segment that is not to be built (failed or left out). */
  private dead(g: TownGrid, key: number): boolean { return g.failed.includes(key) || !!g.omit?.includes(key); }

  /** Move a lattice point that has nothing built yet (streets that cannot reach the planned spot). */
  private moveLatticePoint(g: TownGrid, i: number, j: number, x: number, z: number) {
    if (!g.pts) {
      const pts: number[] = [];
      for (let a = -g.n; a <= g.n; a++) for (let b = -g.n; b <= g.n; b++) { const p = this.latticePoint(g, a, b); pts.push(p.x, p.z); }
      g.pts = pts;
    }
    const k = ((i + g.n) * (2 * g.n + 1) + (j + g.n)) * 2;
    g.pts[k] = Math.round(x * 100) / 100;
    g.pts[k + 1] = Math.round(z * 100) / 100;
    pointIndex.delete(g);
    reservedCache.delete(g);
    latticeMemo.delete(g);
  }

  /** Is there a road along the lattice segment? */
  private latticeBuilt(g: TownGrid, i: number, j: number, dir: number): boolean {
    if (Math.abs(i) > g.n || Math.abs(j) > g.n || (dir === 0 && i + 1 > g.n) || (dir === 1 && j + 1 > g.n)) return false;
    const m = this.memo(g), key = latticeKey(g, i, j, dir);
    if (g.bent?.includes(key)) return true;
    const known = m.built.get(key);
    if (known !== undefined) return known;
    const v = this.latticeBuiltNow(g, i, j, dir);
    m.built.set(key, v);
    return v;
  }
  private latticeBuiltNow(g: TownGrid, i: number, j: number, dir: number): boolean {
    const p = this.latticePoint(g, i, j), q = dir === 0 ? this.latticePoint(g, i + 1, j) : this.latticePoint(g, i, j + 1);
    const L = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    const tx = (q.x - p.x) / L, tz = (q.z - p.z) / L;
    const net = this.world.net;
    const ne = net.nearestEdge((p.x + q.x) / 2, (p.z + q.z) / 2, 0.6, 'road');
    if (!ne) return false;
    const pt = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, pt, d);
    return Math.abs(d.x * tx + d.z * tz) / (Math.hypot(d.x, d.z) || 1) > 0.9;
  }

  /** All four sides built, or three built and the fourth impossible. */
  private cellClosed(g: TownGrid, i: number, j: number): boolean {
    let built = 0, dead = 0;
    for (const [a, b, d] of this.cellSides(i, j)) {
      if (this.latticeBuilt(g, a, b, d)) built++;
      else if (this.dead(g, latticeKey(g, a, b, d))) dead++;
    }
    return built === 4 || (built === 3 && dead === 1);
  }

  /** Park/plaza reserved for block (i, j), or -1. */
  reservedUse(town: Town, i: number, j: number): number {
    const g = town.grid;
    if (!g) return -1;
    if (g.plaza && (g.layout === 'radial' ? i >= -1 && i <= 0 && j >= -1 && j <= 0 : i === 0 && j === 0)) return BT_PLAZA;
    if (Math.abs(i + 0.5) < 1.6 && Math.abs(j + 0.5) < 1.6) return -1; // the core stays built-up
    if (g.layout === 'linear' && Math.abs(j + 0.5) > (g.across ?? 2)) return -1;
    if (hash2(i + 101, j + 101, town.id * 7 + 13) >= (this.profileOf(town).sprawl > 1.1 ? 1 / 9 : 1 / 12)) return -1;
    // a block that can never get three streets is left to ordinary frontage
    let dead = 0;
    for (const [a, b, d] of this.cellSides(i, j)) if (this.dead(g, latticeKey(g, a, b, d))) dead++;
    return dead <= 1 ? BT_PARK : -1;
  }

  private cellSides(i: number, j: number): [number, number, number][] { return [[i, j, 0], [i, j + 1, 0], [i, j, 1], [i + 1, j, 1]]; }

  /** Outlines of the blocks reserved for parks / the plaza (lots there stay open). Cached per grid. */
  private reservedQuads(town: Town): { type: number; q: number[] }[] {
    const g = town.grid!;
    const key = `${g.plaza}:${g.failed.length}:${g.omit?.length ?? 0}`;
    const c = reservedCache.get(g);
    if (c && c.key === key) return c.quads;
    const quads: { type: number; q: number[] }[] = [];
    const lim = Math.min(g.n - 1, 9);
    for (let i = -lim; i < lim; i++) for (let j = -lim; j < lim; j++) {
      const type = this.reservedUse(town, i, j);
      if (type < 0) continue;
      const p = [this.latticePoint(g, i, j), this.latticePoint(g, i + 1, j), this.latticePoint(g, i + 1, j + 1), this.latticePoint(g, i, j + 1)];
      quads.push({ type, q: p.flatMap((v) => [v.x, v.z]) });
    }
    reservedCache.set(g, { key, quads });
    return quads;
  }
  private inReserved(town: Town, x: number, z: number): boolean {
    for (const r of this.reservedQuads(town)) if (inPoly(x, z, r.q)) return true;
    return false;
  }

  /**
   * Build the street along lattice segment (i, j, dir). Streets grow from the town's network: one end must be
   * connected to the centre (except the very first street). A segment that cannot be built straight tries
   * alternatives (see streetAlternatives) before it is recorded as failed.
   */
  private buildLattice(town: Town, i: number, j: number, dir: number, day = 0, evenOmitted = false): boolean {
    const g = town.grid!;
    const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
    if (Math.max(Math.abs(i), Math.abs(j), Math.abs(i2), Math.abs(j2)) > g.n) return false;
    const k = latticeKey(g, i, j, dir);
    if (evenOmitted ? g.failed.includes(k) : this.dead(g, k)) return false;
    if (this.latticeBuilt(g, i, j, dir)) return true;
    // never into a neighbour's land (its grid has another angle)
    const p = this.latticePoint(g, i, j), q = this.latticePoint(g, i2, j2);
    if (this.owner((p.x + q.x) / 2, (p.z + q.z) / 2) !== town) return false;
    const conn = this.connected(town);
    const na = this.latticeNodeId(g, i, j), nb = this.latticeNodeId(g, i2, j2);
    const ca = na >= 0 && conn.has(na), cb = nb >= 0 && conn.has(nb);
    if (!ca && !cb && conn.size) return false;
    // from the connected end; the alternatives move or bend the far end
    const fwd = ca || !cb;
    const [ti, tj, tn] = fwd ? [i2, j2, nb] : [i, j, na];
    const from = fwd ? p : q, to = fwd ? q : p;
    const net = this.world.net, v0 = net.version, e0 = net.nextEdge, m0 = latticeMemo.get(g);
    let res = this.tryStreet(from, to);
    if (res === 'fail' && this.altBudget > 0) { this.altBudget--; res = this.streetAlternatives(town, k, ti, tj, tn, from, to); }
    if (res === 'busy') return false;
    if (res === 'fail') g.failed.push(k);
    if (res === 'ok') {
      // our own street only added this segment: keep the memo (nodes are looked up again)
      const m = latticeMemo.get(g);
      if (m && m === m0 && m.v === v0) { m.v = net.version; m.built.set(k, true); m.nodes.clear(); }
      this.afterOwnCommit(g, v0, e0);
    }
    // newly closed blocks (or a reserved block with a dead fourth side) may become parks or the plaza
    if (dir === 0) { this.landUse(town, i, j - 1, day); this.landUse(town, i, j, day); }
    else { this.landUse(town, i - 1, j, day); this.landUse(town, i, j, day); }
    return res === 'ok';
  }

  /**
   * Streets ending inside the town (their continuation failed, or an omitted lane): join the end to a
   * neighbouring lattice point already on the network, so the block closes and traffic need not turn back.
   */
  private closeDeadEnds(town: Town, day = 0) {
    const g = town.grid!, net = this.world.net;
    for (let i = -g.n + 1; i < g.n; i++) for (let j = -g.n + 1; j < g.n; j++) {
      const id = this.latticeNodeId(g, i, j);
      if (id < 0 || net.nodes.get(id)?.edges.length !== 1 || !this.isConnected(town, i, j)) continue;
      for (const [a, b, d] of [[i, j, 0], [i - 1, j, 0], [i, j, 1], [i, j - 1, 1]] as [number, number, number][]) {
        const far: [number, number] = a === i && b === j ? (d === 0 ? [a + 1, b] : [a, b + 1]) : [a, b];
        if (this.latticeBuilt(g, a, b, d) || !this.isConnected(town, far[0], far[1])) continue;
        if (this.buildLattice(town, a, b, d, day, true)) {
          const k = latticeKey(g, a, b, d), om = g.omit?.indexOf(k) ?? -1;
          if (om >= 0) g.omit!.splice(om, 1);
          break;
        }
      }
    }
  }

  /** Town edges (streets and country roads, owner -1) with a dead end on a bridge, and which end. */
  bridgeEnds(town?: Town): { e: NEdge; atStart: boolean }[] {
    const net = this.world.net, out: { e: NEdge; atStart: boolean }[] = [];
    const list = town ? this.streets(town, 8) : [...net.edges.values()].filter((e) => e.kind === 'road' && e.owner === -1 && e.station < 0 && e.depot < 0);
    for (const e of list) for (const atStart of [true, false]) {
      const node = net.nodes.get(atStart ? e.a : e.b);
      if (!node || node.edges.length !== 1) continue;
      if (e.sections.some((q) => q.type === 'bridge' && (atStart ? q.s0 <= 0.05 : q.s1 >= e.len - 0.05))) out.push({ e, atStart });
    }
    return out;
  }

  /**
   * Town streets never end on a bridge (9i): a town dead end whose last stretch is a bridge is cut back to a
   * unit of ground before the bridge, or removed when not much would be left. Runs after world generation, on
   * loading old saves and now and then as towns grow (`town`: only its streets). Returns how many changed.
   */
  tidyBridgeEnds(town?: Town): number {
    const g = this.game, w = this.world, net = w.net;
    let changed = 0;
    for (let pass = 0; pass < 4; pass++) {
      let n = 0;
      for (const { e: e0, atStart } of this.bridgeEnds(town)) {
        const e = net.edges.get(e0.id);
        if (!e || g.vehicles.isEdgeBusy(e.id)) continue;
        const node = net.nodes.get(atStart ? e.a : e.b);
        if (!node || node.edges.length !== 1) continue;
        const br = e.sections.filter((q) => q.type === 'bridge' && (atStart ? q.s0 <= 0.05 : q.s1 >= e.len - 0.05));
        if (!br.length) continue;
        const cut = atStart ? Math.max(...br.map((q) => q.s1)) + 1 : Math.min(...br.map((q) => q.s0)) - 1;
        const geo = net.geo(e);
        let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
        for (let i = 0; i < geo.n; i++) { x0 = Math.min(x0, geo.pts[i * 3]); x1 = Math.max(x1, geo.pts[i * 3]); z0 = Math.min(z0, geo.pts[i * 3 + 2]); z1 = Math.max(z1, geo.pts[i * 3 + 2]); }
        if (atStart ? cut > e.len - 1.5 : cut < 1.5) net.removeEdge(e.id);
        else {
          const r = net.splitEdge(e.id, cut);
          if (!r) continue;
          net.removeEdge(atStart ? r.e1.id : r.e2.id);
        }
        recomputeLocks(w, x0 - 3, z0 - 3, x1 + 3, z1 + 3);
        w.markObjArea(x0 - 2, z0 - 2, x1 + 2, z1 + 2);
        n++;
      }
      changed += n;
      if (!n) break;
    }
    if (changed) g.onNetworkChanged();
    return changed;
  }

  /** Lattice segments that may still try alternatives in this growth step (generation: no limit). */
  private altBudget = Infinity;

  /**
   * A lattice street that cannot be built straight (steep, water, obstacles): if nothing is built at its far
   * end yet, move that lattice point by up to a quarter of the block (nearest and flattest spots first);
   * else bend the street through a point beside the straight line.
   */
  private streetAlternatives(town: Town, key: number, ti: number, tj: number, tn: number, from: { x: number; z: number }, to: { x: number; z: number }): 'ok' | 'fail' | 'busy' {
    const g = town.grid!, w = this.world;
    const L = Math.hypot(to.x - from.x, to.z - from.z);
    if (L < 2) return 'fail';
    const ux = (to.x - from.x) / L, uz = (to.z - from.z) / L;
    if (tn < 0) {
      const h0 = w.heightAt(from.x, from.z);
      const cands: { x: number; z: number; c: number }[] = [];
      for (const f of [0.13, 0.25]) for (let a = 0; a < 6; a++) {
        const ang = (a / 6) * Math.PI * 2 + 0.25;
        const x = to.x + Math.cos(ang) * f * L, z = to.z + Math.sin(ang) * f * L;
        if (w.heightAt(x, z) < WATER_Y + 0.2) continue;
        cands.push({ x, z, c: f * 3 + Math.abs(w.heightAt(x, z) - h0) / L * 12 });
      }
      cands.sort((p, q) => p.c - q.c);
      for (const c of cands.slice(0, 5)) {
        if (this.owner(c.x, c.z) !== town) continue;
        const r = this.tryStreet(from, c);
        if (r === 'busy') return 'busy';
        if (r === 'ok') { this.moveLatticePoint(g, ti, tj, c.x, c.z); return 'ok'; }
      }
    }
    for (const off of [0.2, -0.2, 0.34, -0.34]) {
      const m = { x: (from.x + to.x) / 2 - uz * off * L, z: (from.z + to.z) / 2 + ux * off * L };
      if (this.owner(m.x, m.z) !== town) continue;
      const r = this.tryBent(from, m, to);
      if (r === 'busy') return 'busy';
      if (r === 'ok') { (g.bent ??= []).push(key); return 'ok'; }
    }
    return 'fail';
  }

  /** A street bent through m: both legs must be buildable (and cross nothing) before either is built. */
  private tryBent(p: { x: number; z: number }, m: { x: number; z: number }, q: { x: number; z: number }): 'ok' | 'fail' | 'busy' {
    const g = this.game, net = this.world.net;
    if (findSnap(g, 'road', m.x, m.z, 1.2).kind !== 'free') return 'fail';
    if (this.planLeft() < 3) return 'busy';
    const a = this.planStreet(p, m), b = this.planStreet(m, q);
    if (!a || !b || a.crossings.length || b.crossings.length) return 'fail';
    const e0 = net.nextEdge;
    const err = commitProposal(g, a);
    if (err) return err === 'Vehicle in the way' ? 'busy' : 'fail';
    const r = this.tryStreet(m, q);
    if (r !== 'ok') {
      // the second leg failed after all: take the first one away again
      for (let id = e0; id < net.nextEdge; id++) if (net.edges.get(id)?.type === 'street') net.removeEdge(id);
      recomputeLocks(this.world, Math.min(p.x, m.x) - 2, Math.min(p.z, m.z) - 2, Math.max(p.x, m.x) + 2, Math.max(p.z, m.z) + 2);
    }
    return r;
  }

  /**
   * Street plans the towns may still make today (running game: a few per day across all towns, so town
   * growth never stalls a frame; world generation: no limit). Transient, reset every day.
   */
  private planBudget = { day: -1, left: 0 };
  private curDay = 0;
  private planLeft(): number {
    if (this.curDay <= 0) return Infinity;
    if (this.planBudget.day !== this.curDay) this.planBudget = { day: this.curDay, left: 5 };
    return this.planBudget.left;
  }

  /** A straight town street between two points (or null when steep, over water, blocked or crossing rails). */
  private planStreet(p: { x: number; z: number }, q: { x: number; z: number }): Proposal | null {
    const g = this.game, w = this.world, net = w.net;
    if (this.curDay > 0) this.planBudget.left--;
    if (!w.inside(p.x, p.z, 5) || !w.inside(q.x, q.z, 5)) return null;
    if (Math.hypot(q.x - p.x, q.z - p.z) < 2) return null;
    for (let k = 0; k <= 8; k++) {
      const x = p.x + ((q.x - p.x) * k) / 8, z = p.z + ((q.z - p.z) * k) / 8;
      if (w.heightAt(x, z) < WATER_Y + 0.15) return null;
    }
    const sa = findSnap(g, 'road', p.x, p.z, 0.9), sb = findSnap(g, 'road', q.x, q.z, 0.9);
    if (sa.kind === 'node' && sb.kind === 'node' && sa.node === sb.node) return null;
    const prop = planEdge(g, sa, sb, { ...TOWN_OPTS(), straight: true });
    if (!prop.ok || prop.stats.tunnels || prop.stats.minRadius < 3) return null;
    const tp = prop.tracks[0];
    // railways (9k): a level crossing (conventional track, see levelCrossingAllowed), a street bridge over the
    // line, or beneath a railway bridge; never through company roads
    let overRail = false;
    for (const c of prop.crossings) {
      const e = net.edges.get(c.edge);
      if (!e) return null;
      if (e.kind === 'rail') {
        const sec = net.sectionAt(e, c.sOld);
        if (c.mode === 'level') continue;
        if (c.mode === 'over' && sec !== 'bridge') { overRail = true; continue; }
        if (c.mode === 'under' && sec === 'bridge') continue;
        return null;
      }
      if (e.owner >= 0) return null;
    }
    // bridges (9i): a short one over a gully (open water was ruled out above) or over a railway, only strictly
    // inside the street — at least a unit of ground at both ends, never a street ending in mid-air
    let bridged = 0;
    for (const sec of tp.sections) {
      if (sec.type !== 'bridge') continue;
      bridged += sec.s1 - sec.s0;
      if (sec.s0 < 1 || sec.s1 > tp.len - 1) return null;
    }
    if (bridged > (overRail ? 9 : 4)) return null;
    // close to the ground: towns grade their streets into slopes (cuttings and banks of up to ~2, 9i) rather
    // than bridge them; profile samples every PSTEP
    for (let i = 0; i < tp.prof.length; i++) {
      const f = Math.min(1, (i * PSTEP) / Math.max(0.01, tp.len));
      const x = tp.bez.x0 + (tp.bez.x3 - tp.bez.x0) * f, z = tp.bez.z0 + (tp.bez.z3 - tp.bez.z0) * f;
      if (net.sectionAt({ sections: tp.sections, len: tp.len } as NEdge, Math.min(i * PSTEP, tp.len)) !== 'ground') continue;
      if (Math.abs(tp.prof[i] - w.heightAt(x, z)) > TOWN_GRADE) return null;
    }
    return prop;
  }

  /** Build a straight town street (see planStreet); traffic on a street that would be split is only a passing obstacle. */
  private tryStreet(p: { x: number; z: number }, q: { x: number; z: number }): 'ok' | 'fail' | 'busy' {
    if (this.planLeft() < 1) return 'busy';
    const prop = this.planStreet(p, q);
    if (!prop) return 'fail';
    const err = commitProposal(this.game, prop);
    return err === null ? 'ok' : err === 'Vehicle in the way' ? 'busy' : 'fail';
  }

  /** Initial layout: the main streets through the centre (avenues), then the first ring. */
  private layoutTown(town: Town, target: number) {
    const g = town.grid!;
    const ring = this.plannedRing(target, town);
    if (target > (g.layout === 'organic' || g.layout === 'hill' ? 500 : 1500)) g.plaza = true;
    // radial towns with a central square: the ring around it first, the avenues start there
    const k0 = g.layout === 'radial' && g.plaza ? 1 : 0;
    if (k0) {
      for (const [i, j, d] of [[0, 0, 0], [-1, 0, 0], [0, 0, 1], [0, -1, 1]] as [number, number, number][]) (g.omit ??= []).push(latticeKey(g, i, j, d));
      const loop = CENTRE_PTS.slice(1);
      for (let t = 0; t < 8; t++) if (!this.buildLattice(town, ...segBetween(loop[t], loop[(t + 1) % 8]))) break;
      for (let t = 7; t >= 0; t--) if (!this.buildLattice(town, ...segBetween(loop[t], loop[(t + 1) % 8]))) break;
    }
    const alongU = g.layout === 'linear' ? Math.ceil(ring * (g.stretch ?? 2.5)) : ring, alongV = g.layout === 'linear' ? Math.min(ring, g.across ?? 2) : ring;
    for (let k = k0; k <= alongU; k++) if (!this.buildLattice(town, k, 0, 0)) break;
    for (let k = k0; k <= alongU; k++) if (!this.buildLattice(town, -k - 1, 0, 0)) break;
    for (let k = k0; k <= alongV; k++) if (!this.buildLattice(town, 0, k, 1)) break;
    for (let k = k0; k <= alongV; k++) if (!this.buildLattice(town, 0, -k - 1, 1)) break;
    this.fillRing(town, 1);
  }

  /** Build the lattice segments of ring r that connect to the network, block-closing ones first. */
  private fillRing(town: Town, r: number) {
    const g = town.grid!;
    const segs: [number, number, number][] = [];
    const lim = Math.min(g.n - 1, g.layout === 'linear' ? Math.ceil(r * (g.stretch ?? 2.5)) + 1 : r);
    for (let i = -lim; i <= lim; i++) for (let j = -lim; j <= lim; j++) for (const dir of [0, 1]) {
      if (this.segRing(g, i, j, dir) !== r) continue;
      segs.push([i, j, dir]);
    }
    for (let pass = 0; pass < 4; pass++) {
      let progress = false;
      for (const [i, j, dir] of segs) {
        if (this.dead(g, latticeKey(g, i, j, dir)) || this.latticeBuilt(g, i, j, dir)) continue;
        const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
        if (!this.isConnected(town, i, j) && !this.isConnected(town, i2, j2)) continue;
        if (pass === 0 && !this.closesBlock(g, i, j, dir)) continue;
        if (this.buildLattice(town, i, j, dir)) progress = true;
      }
      if (!progress && pass > 0) break;
    }
  }

  /** Would building this segment close one of its two blocks (the other three sides exist)? */
  private closesBlock(g: TownGrid, i: number, j: number, dir: number): boolean {
    const others = (ci: number, cj: number) => {
      const sides: [number, number, number][] = [[ci, cj, 0], [ci, cj + 1, 0], [ci, cj, 1], [ci + 1, cj, 1]];
      return sides.filter(([a, b, d]) => !(a === i && b === j && d === dir)).every(([a, b, d]) => this.latticeBuilt(g, a, b, d));
    };
    return dir === 0 ? others(i, j - 1) || others(i, j) : others(i - 1, j) || others(i, j);
  }

  /**
   * Grow the street lattice by one segment at its edge (closing blocks first, near the centre first),
   * within the planned extent (`bonus` rings more when the town is stuck).
   */
  private extendGrid(town: Town, rng: RNG, day: number, plannedPop = town.pop, bonus = 0): boolean {
    const g = town.grid!;
    const base = this.plannedRing(Math.max(town.pop * 1.25 + 200, plannedPop), town) + bonus;
    const maxRing = Math.min(g.n - 1, base + 1);
    const lim = Math.min(g.n - 1, g.layout === 'linear' ? Math.ceil(maxRing * (g.stretch ?? 2.5)) + 1 : maxRing);
    const has = (i: number, j: number) => this.isConnected(town, i, j);
    const cands: { i: number; j: number; dir: number; score: number }[] = [];
    for (let i = -lim; i <= lim; i++) for (let j = -lim; j <= lim; j++) for (const dir of [0, 1]) {
      const i2 = dir === 0 ? i + 1 : i, j2 = dir === 0 ? j : j + 1;
      if (Math.max(Math.abs(i2), Math.abs(j2)) > g.n) continue;
      // a ragged edge: the planned extent varies by a ring around the town
      const ring = this.segRing(g, i, j, dir);
      if (ring > Math.min(g.n - 1, base + (base >= 2 ? this.edgeVar(town, i + i2, j + j2) : 0)) || this.dead(g, latticeKey(g, i, j, dir))) continue;
      const a = has(i, j), b = has(i2, j2);
      if ((!a && !b) || this.latticeBuilt(g, i, j, dir)) continue;
      // not into a neighbour's land
      const p = this.latticePoint(g, i, j), q = this.latticePoint(g, i2, j2);
      if (this.owner((p.x + q.x) / 2, (p.z + q.z) / 2) !== town) continue;
      cands.push({ i, j, dir, score: (a && b ? 3 : 0) - ring * 1.5 + rng.next() * 1.5 });
    }
    cands.sort((p, q) => q.score - p.score);
    const top = cands.slice(0, 10);
    for (const c of top) if (this.closesBlock(g, c.i, c.j, c.dir)) c.score += 6;
    top.sort((p, q) => q.score - p.score);
    for (const c of top.slice(0, 4)) if (this.buildLattice(town, c.i, c.j, c.dir, day)) return true;
    return false;
  }

  /** Ragged town edges: per sector around the town, the planned extent is a ring smaller, the same or larger. */
  private edgeVar(town: Town, i2: number, j2: number): number {
    const sector = Math.floor(((Math.atan2(j2, i2) + Math.PI) / (2 * Math.PI)) * 7) % 7;
    const h = hash2(sector, town.id, 4242);
    return h < 0.3 ? -1 : h > 0.72 ? 1 : 0;
  }

  /** Place the park/plaza of a closed reserved block (its interior rect, from the block's corners). */
  private landUse(town: Town, i: number, j: number, day = 0) {
    const g = town.grid!;
    if (Math.abs(i) >= g.n || Math.abs(j) >= g.n) return;
    const type = this.reservedUse(town, i, j);
    if (type < 0) return;
    const W = this.world;
    let rect: { x: number; z: number; angle: number; w: number; d: number };
    if (type === BT_PLAZA && g.layout === 'radial') {
      // the round square inside ring 1 (closed once all eight ring segments exist)
      for (const [a, b, d] of [[1, -1, 1], [1, 0, 1], [-1, 1, 0], [0, 1, 0], [-1, -1, 1], [-1, 0, 1], [-1, -1, 0], [0, -1, 0]] as [number, number, number][]) if (!this.latticeBuilt(g, a, b, d)) return;
      let r1 = Infinity;
      for (let t = -1; t <= 1; t++) for (const [a, b] of [[1, t], [-1, t], [t, 1], [t, -1]]) { const p = this.latticePoint(g, a, b); r1 = Math.min(r1, Math.hypot(p.x - g.ox, p.z - g.oz)); }
      const sz = r1 * 1.25 - 1.3;
      if (sz < 3) return;
      rect = { x: g.ox, z: g.oz, angle: g.angle, w: sz, d: sz };
    } else {
      if (!this.cellClosed(g, i, j)) return;
      const p00 = this.latticePoint(g, i, j), p10 = this.latticePoint(g, i + 1, j), p01 = this.latticePoint(g, i, j + 1), p11 = this.latticePoint(g, i + 1, j + 1);
      const ux = (p10.x - p00.x + p11.x - p01.x) / 2, uz = (p10.z - p00.z + p11.z - p01.z) / 2;
      const d = Math.min(Math.hypot(p10.x - p00.x, p10.z - p00.z), Math.hypot(p11.x - p01.x, p11.z - p01.z)) - 1.4;
      const w = Math.min(Math.hypot(p01.x - p00.x, p01.z - p00.z), Math.hypot(p11.x - p10.x, p11.z - p10.z)) - 1.4;
      if (d < 3 || w < 3) return;
      rect = { x: (p00.x + p10.x + p01.x + p11.x) / 4, z: (p00.z + p10.z + p01.z + p11.z) / 4, angle: Math.atan2(ux, uz), w, d };
    }
    const { x, z, angle, w, d } = rect;
    // already used? (buildings or other network inside the block)
    const R = Math.hypot(w, d) / 2 + 1;
    for (const id of W.bgrid.query(x - R, z - R, x + R, z + R)) { const b = W.buildings.get(id); if (b && rectsOverlap(rect, b, 0.05)) return; }
    for (const e of W.net.edgesNear(x - R, z - R, x + R, z + R)) {
      const geo = W.net.geo(e), hw = W.net.halfWidth(e);
      for (let k = 0; k < geo.n; k++) if (distToRect(geo.pts[k * 3], geo.pts[k * 3 + 2], x, z, angle, w / 2, d / 2) < hw - 0.05) return;
    }
    const sa = Math.sin(angle), ca = Math.cos(angle);
    let sum = 0, mn = Infinity;
    for (const [u, v] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const h = W.heightAt(x + ca * w * u + sa * d * v, z - sa * w * u + ca * d * v);
      sum += h; mn = Math.min(mn, h);
    }
    if (mn < WATER_Y + 0.15) return;
    // the renderer draws the park's own trees and the plaza's paving: clear the block
    for (const id of W.treeGrid.query(x - R, z - R, x + R, z + R)) {
      const t = W.trees[id];
      if (t && pointInRect(t.x, t.z, x, z, angle, w / 2 + 0.2, d / 2 + 0.2)) W.removeTreesNear(t.x, t.z, 0.01);
    }
    const b = W.addBuilding({ townId: town.id, x, z, angle, w, d, type, floors: 0, pop: 0, seed: hash2(i, j, town.id) * (1 << 30) | 0, y: sum / 5, built: day });
    town.buildings.add(b.id);
  }

  /** Lattice points (i, j pairs) within r of (x, z), via a coarse lookup cached per grid. */
  private pointsNear(g: TownGrid, x: number, z: number, r: number): number[] {
    let idx = pointIndex.get(g);
    if (!idx) {
      idx = new Map();
      for (let i = -g.n; i <= g.n; i++) for (let j = -g.n; j <= g.n; j++) {
        const p = this.latticePoint(g, i, j), key = Math.floor(p.x / 4) * 4096 + Math.floor(p.z / 4);
        const a = idx.get(key);
        if (a) a.push(i, j); else idx.set(key, [i, j]);
      }
      pointIndex.set(g, idx);
    }
    const out: number[] = [];
    const span = Math.ceil(r / 4);
    for (let dz = -span; dz <= span; dz++) for (let dx = -span; dx <= span; dx++) {
      const a = idx.get((Math.floor(x / 4) + dx) * 4096 + Math.floor(z / 4) + dz);
      if (!a) continue;
      for (let k = 0; k < a.length; k += 2) { const p = this.latticePoint(g, a[k], a[k + 1]); if (Math.hypot(p.x - x, p.z - z) < r) out.push(a[k], a[k + 1]); }
    }
    return out;
  }

  /** Would a lot block a street the town still plans (an unbuilt, possible lattice segment)? */
  private blocksPlan(town: Town, x: number, z: number, angle: number, w: number, d: number): boolean {
    const g = town.grid;
    if (!g) return false;
    const R = Math.hypot(w, d) / 2;
    const near = this.pointsNear(g, x, z, R + 13);
    const seen = new Set<number>();
    for (let k = 0; k < near.length; k += 2) {
      const i = near[k], j = near[k + 1];
      for (const [a, b, dir] of [[i, j, 0], [i, j, 1], [i - 1, j, 0], [i, j - 1, 1]] as [number, number, number][]) {
        if (Math.abs(a) >= g.n || Math.abs(b) >= g.n) continue;
        const key = latticeKey(g, a, b, dir);
        if (seen.has(key)) continue;
        seen.add(key);
        if (this.dead(g, key) || this.segRing(g, a, b, dir) > 9 || this.latticeBuilt(g, a, b, dir)) continue;
        const p = this.latticePoint(g, a, b), q = dir === 0 ? this.latticePoint(g, a + 1, b) : this.latticePoint(g, a, b + 1);
        // distance from the segment to the lot rect (samples along the segment)
        const L = Math.hypot(q.x - p.x, q.z - p.z);
        for (let t = 0; t <= L; t += 0.5) {
          const sx = p.x + ((q.x - p.x) * t) / L, sz = p.z + ((q.z - p.z) * t) / L;
          if (Math.abs(sx - x) > R + 0.8 || Math.abs(sz - z) > R + 0.8) continue;
          if (distToRect(sx, sz, x, z, angle, w / 2, d / 2) < 0.75) return true;
        }
      }
    }
    return false;
  }

  /** Is a (country road) edge a straight piece between two neighbouring lattice points? */
  private onGrid(g: TownGrid, e: NEdge): boolean {
    const b = e.bez;
    const cl = Math.hypot(b.x3 - b.x0, b.z3 - b.z0);
    if (cl < 2 || cl < e.len * 0.995) return false;
    const pa = this.pointsNear(g, b.x0, b.z0, 1.0), pb = this.pointsNear(g, b.x3, b.z3, 1.0);
    for (let s = 0; s < pa.length; s += 2) for (let t = 0; t < pb.length; t += 2) if (Math.abs(pa[s] - pb[t]) + Math.abs(pa[s + 1] - pb[t + 1]) === 1) return true;
    return false;
  }

  /** Town street edges near the town. */
  streets(town: Town, extra = 6): NEdge[] {
    const R = town.radius + extra;
    return this.world.net.edgesNear(town.x - R, town.z - R, town.x + R, town.z + R)
      .filter((e) => e.kind === 'road' && e.owner === -1 && e.station < 0 && e.depot < 0);
  }

  /**
   * Zoning by distance from the centre and (planned) population: an office / apartment core with towers in
   * big cities, a ring of apartment blocks, shops and townhouses, a high street, then houses. The growth
   * profile scales the dense zones, the share of tall buildings and the suburbs. Fresh lots get towers
   * only in big cores (smaller cities get them by redevelopment).
   */
  private chooseType(town: Town, x: number, z: number, rng: RNG, P = town.pop, fresh = false): number {
    const prof = this.profileOf(town);
    const d = Math.hypot(x - town.x, z - town.z) / prof.core;
    const r = rng.next(), sq = Math.sqrt(Math.max(1, P));
    const tall = Math.min(1.6, prof.tall);
    if (P > 2600 && d < 2 + sq * 0.08) {
      // offices from ~4,500 people, towers only in real cities (they come with growth)
      const tw = (P > 9000 ? 0.18 : P > 6000 ? 0.1 : 0) * tall, of = P > 4500 ? 0.25 * Math.min(1.3, tall) : 0;
      return r < tw && (!fresh || P > 7500) ? BT_TOWER : r < tw + of ? BT_OFFICE : r < 0.8 ? BT_APARTMENT : BT_SHOP;
    }
    const ap = P > 3000 ? 0.5 : 0.42;
    if (P > 1100 && d < 2 + sq * (P > 3000 ? 0.21 : 0.19)) return r < ap ? BT_APARTMENT : r < ap + 0.08 * Math.min(1, tall) && P > 4500 ? BT_OFFICE : r < 0.75 ? BT_SHOP : BT_TOWNHOUSE;
    const f = Math.min(1, P / 1200);
    if (P > 220 && d < 2 + sq * 0.27) return r < 0.45 * f ? BT_TOWNHOUSE : r < 0.65 * f ? BT_SHOP : r < 0.75 * f && P > 700 ? BT_APARTMENT : r < 0.82 ? BT_HOUSE_L : BT_HOUSE_S;
    if (P > 600 && d * prof.core / prof.sprawl < 2 + sq * 0.33) return r < 0.3 * f / prof.sprawl ? BT_TOWNHOUSE : r < 0.62 ? BT_HOUSE_L : BT_HOUSE_S;
    return r < 0.35 ? BT_HOUSE_S : BT_HOUSE_L;
  }

  /** Can a building rectangle be placed? Returns its base height or null. */
  canPlace(x: number, z: number, angle: number, w: number, d: number, ignore = -1): number | null {
    const W = this.world;
    if (!W.inside(x, z, 3)) return null;
    const fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx;
    let mn = Infinity, mx = -Infinity;
    for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
      const h = W.heightAt(x + rx * (w / 2) * sx + fx * (d / 2) * sz, z + rz * (w / 2) * sx + fz * (d / 2) * sz);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    if (mn < WATER_Y + 0.15 || mx - mn > 0.7) return null;
    const rect = { x, z, angle, w, d };
    const R = Math.hypot(w, d) / 2 + 0.5;
    for (const id of W.bgrid.query(x - R - 3, z - R - 3, x + R + 3, z + R + 3)) {
      if (id === ignore) continue;
      const b = W.buildings.get(id);
      if (b && rectsOverlap(rect, b, 0.12)) return null;
    }
    const net = W.net;
    for (const e of net.edgesNear(x - R, z - R, x + R, z + R)) {
      const g = net.geo(e);
      const hw = net.halfWidth(e) + 0.06;
      for (let i = 0; i < g.n; i++) {
        const px = g.pts[i * 3], pz = g.pts[i * 3 + 2];
        if (Math.abs(px - x) > R + hw || Math.abs(pz - z) > R + hw) continue;
        if (distToRect(px, pz, x, z, angle, w / 2, d / 2) < hw) return null;
      }
    }
    for (const n of net.nodeGrid.query(x - R, z - R, x + R, z + R)) {
      const nd = net.nodes.get(n);
      if (nd && distToRect(nd.x, nd.z, x, z, angle, w / 2, d / 2) < net.junctionRadius(nd.id) + 0.1) return null;
    }
    if (this.game.stations.footprintsNear(x, z, R).length) return null;
    if (this.game.depots.near(x, z, R + 1).length) return null;
    return mx;
  }

  /** Lowest and highest ground under a building rectangle (corners, edge middles and centre). */
  private lotRange(x: number, z: number, angle: number, w: number, d: number): { min: number; max: number } {
    const W = this.world, fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx;
    let mn = Infinity, mx = -Infinity;
    for (const [sx, sz] of LOT_SAMPLES) {
      const h = W.heightAt(x + rx * (w / 2) * sx + fx * (d / 2) * sz, z + rz * (w / 2) * sx + fz * (d / 2) * sz);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    return { min: mn, max: mx };
  }

  /**
   * Level a building lot (9e): the ground under the footprint and half a unit around it goes to the lot height,
   * blending back to the natural ground over a unit beyond; network formations, other buildings' ground and the
   * shore keep theirs. Returns the base height for the building (the lot height, or the ground left higher under
   * it where it could not be cut).
   */
  /** Span of the ground under the last lot prepared (before levelling): steep lots take low buildings. */
  private lastLotSpan = 0;

  /**
   * Prepare a building lot (9e): level the ground under the footprint and half a unit around it to the street
   * side's height, blending back to the natural ground over a unit beyond. Network formations (except a road's
   * margin beside its carriageway and pavements: roads are draped on the terrain), other buildings' ground and
   * the shore keep theirs. Returns the building's base height, or null (and the ground restored) when the lot
   * is left steeper than PLINTH_MAX + LOT_DIG — such lots stay gardens.
   */
  private prepareLot(x: number, z: number, angle: number, w: number, d: number): number | null {
    const W = this.world, S = W.size, R = Math.hypot(w, d) / 2 + 1.6, net = W.net;
    const lot = this.lotRange(x, z, angle, w, d);
    const fx = Math.sin(angle), fz = Math.cos(angle);
    const y = Math.max(lot.min, Math.min(lot.max, W.heightAt(x + fx * d * 0.5, z + fz * d * 0.5)));
    const free = (k: number, xx: number, zz: number): boolean => {
      const L = W.lock[k];
      if (L & (LOCK.rail | LOCK.building)) return false;
      if (L & LOCK.formation) {
        const ne = net.nearestEdge(xx, zz, 3);
        if (ne && (ne.edge.kind === 'rail' || ne.d < net.halfWidth(ne.edge) + 0.3)) return false;
      }
      return true;
    };
    const undo: [number, number, number][] = [];
    for (let zz = Math.max(1, Math.floor(z - R)); zz <= Math.min(S - 1, Math.ceil(z + R)); zz++) {
      for (let xx = Math.max(1, Math.floor(x - R)); xx <= Math.min(S - 1, Math.ceil(x + R)); xx++) {
        const dd = distToRect(xx, zz, x, z, angle, w / 2 + 0.5, d / 2 + 0.5);
        if (dd > 1) continue;
        const k = W.vi(xx, zz);
        if (W.lock[k] && !free(k, xx, zz)) continue;
        const f = 1 - dd, wgt = f * f * (3 - 2 * f), cur = W.h[k];
        let v = cur + (y - 0.02 - cur) * wgt;
        if (v < cur && v < DRY_MIN) v = Math.min(cur, DRY_MIN);
        // the ground under a neighbour's walls (every grid cell it stands on) barely changes
        if (Math.abs(v - cur) > 0.05 && W.buildingsNear(xx, zz, 1.5).some((b) => distToRect(xx, zz, b.x, b.z, b.angle, b.w / 2, b.d / 2) < 1.42)) v = cur + Math.max(-0.05, Math.min(0.05, v - cur));
        if (Math.abs(v - cur) > 0.003) { undo.push([xx, zz, cur]); W.setVertex(xx, zz, v); }
      }
    }
    const after = this.lotRange(x, z, angle, w, d);
    // what could not be levelled: a low building set into the slope (plinth at most PLINTH_MAX, the uphill side
    // dug in up to LOT_DIG); steeper, the lot stays a garden
    if (after.max - after.min > PLINTH_MAX + LOT_DIG) {
      for (let i = undo.length - 1; i >= 0; i--) W.setVertex(undo[i][0], undo[i][1], undo[i][2]);
      return null;
    }
    this.lastLotSpan = Math.max(lot.max - lot.min, after.max - after.min > PLINTH_MAX ? 1 : 0);
    return Math.min(after.max, after.min + PLINTH_MAX);
  }

  private placeBuilding(town: Town, type: number, x: number, z: number, angle: number, w: number, d: number, y: number, rng: RNG, day: number, maxPop = Infinity, P = town.pop): Building {
    const bt = BUILDING_TYPES[type];
    const ppf = bt.popPerFloor[0] + rng.next() * (bt.popPerFloor[1] - bt.popPerFloor[0]);
    let floors = Math.min(bt.floors[0] + rng.int(bt.floors[1] - bt.floors[0] + 1), floorCap(P));
    // a lot that was steep before levelling only takes a low building (9e)
    if (this.lastLotSpan > 0.4) floors = Math.min(floors, Math.max(bt.floors[0], 2));
    this.lastLotSpan = 0;
    const perFloor = (ppf * (w * d)) / 1.2;
    if (perFloor > 0 && floors * perFloor > maxPop) floors = Math.max(bt.floors[0], Math.floor(maxPop / perFloor));
    this.world.removeTreesNear(x, z, Math.hypot(w, d) / 2 + 0.4);
    const b = this.world.addBuilding({ townId: town.id, x, z, angle, w, d, type, floors, pop: Math.round(floors * ppf * (w * d) / 1.2), seed: rng.int(1 << 30), y, built: day });
    town.buildings.add(b.id);
    town.pop += b.pop;
    town.radius = Math.max(town.radius, Math.hypot(x - town.x, z - town.z));
    if (type === BT_CHURCH) town.hasChurch = true;
    return b;
  }

  /**
   * Perimeter-block frontage: the next free lots on one side of a street, next to the existing row
   * (continuous rows in the centre, detached houses with gaps in the suburbs; block interiors stay open).
   * Places up to `maxLots` buildings; returns how many.
   */
  private frontage(town: Town, e: NEdge, side: number, rng: RNG, day: number, typeOverride = -1, P = town.pop, maxLots = 1): number {
    const W = this.world, net = W.net;
    const geo = net.geo(e);
    const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.street;
    const hw = rt.half + rt.sidewalk;
    const prof = this.profileOf(town);
    const at = (s: number) => {
      const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
      net.pointAt(e, s, p, d);
      const l = Math.hypot(d.x, d.z) || 1;
      return { x: p.x, z: p.z, tx: d.x / l, tz: d.z / l };
    };
    // building type for this stretch
    const mid = at(e.len / 2);
    let type = typeOverride >= 0 ? typeOverride : this.chooseType(town, mid.x - mid.tz * side * 2, mid.z + mid.tx * side * 2, rng, P, true);
    let bt = BUILDING_TYPES[type];
    // usable stretch: rows run through junctions where no street leaves on this side, and town
    // rows (rank >= 2) close the corner where one does; detached houses keep clear of junctions
    const endClear = (nodeId: number, s: number) => {
      const n = net.nodes.get(nodeId);
      if (!n || n.edges.length <= 1) return 0.3;
      const p = at(s), nx = -p.tz * side, nz = p.tx * side;
      let onSide = false;
      for (const id of n.edges) {
        if (id === e.id) continue;
        const o = net.edges.get(id);
        if (!o) continue;
        const ld = net.leaveDir(o, nodeId), l = Math.hypot(ld.x, ld.z) || 1;
        if ((ld.x * nx + ld.z * nz) / l > 0.3) onSide = true;
      }
      if (!onSide) return 0.3;
      return bt.rank >= 2 && bt.rank < 9 ? hw + 0.1 : net.junctionRadius(nodeId) + 0.3;
    };
    const s0 = Math.min(endClear(e.a, 0), e.len * 0.45), s1 = Math.max(e.len - endClear(e.b, e.len), e.len * 0.55);
    const full = fullSet(town, day);
    if (s1 - s0 < 0.9) { if (typeOverride < 0) full.add(sideKey(e, side)); return 0; }
    // town rows are continuous; detached houses stand in gardens, larger towards the suburban fringe (9g)
    const fringe = smoothstep(0.55, 1.05, Math.hypot(mid.x - town.x, mid.z - town.z) / this.maxRadius(town));
    const dims = () => ({ wdt: bt.w[0] + rng.next() * (bt.w[1] - bt.w[0]), dep: bt.d[0] + rng.next() * (bt.d[1] - bt.d[0]), gap: bt.rank >= 2 ? 0.14 + rng.next() * 0.05 : (0.55 + rng.next() * 1.0) * prof.gap * (1 + 0.7 * fringe) });
    let { wdt, dep, gap } = dims();
    // occupied stretches on this side (buildings projected onto the street)
    const box = net.grid.box(e.id);
    if (!box) return 0;
    const occ: [number, number][] = [];
    for (const id of W.bgrid.query(box[0] - 3.5, box[1] - 3.5, box[2] + 3.5, box[3] + 3.5)) {
      const b = W.buildings.get(id);
      if (!b) continue;
      const c = closestOnPolyline(b.x, b.z, geo.pts, 3, geo.n);
      const i1 = Math.min(geo.n - 1, c.i + 1);
      const s = geo.cum[c.i] + (geo.cum[i1] - geo.cum[c.i]) * c.f;
      const tx = geo.tan[c.i * 2], tz = geo.tan[c.i * 2 + 1];
      const px = geo.pts[c.i * 3] + (geo.pts[i1 * 3] - geo.pts[c.i * 3]) * c.f, pz = geo.pts[c.i * 3 + 2] + (geo.pts[i1 * 3 + 2] - geo.pts[c.i * 3 + 2]) * c.f;
      const lat = (b.x - px) * -tz + (b.z - pz) * tx;
      if (lat * side <= 0 || Math.abs(lat) > hw + Math.max(b.w, b.d) + 1) continue;
      const fx = Math.sin(b.angle), fz = Math.cos(b.angle);
      const ext = (Math.abs(fz * tx - fx * tz) * b.w + Math.abs(fx * tx + fz * tz) * b.d) / 2;
      occ.push([s - ext, s + ext]);
    }
    occ.sort((p, q) => p[0] - q[0]);
    const free: [number, number][] = [];
    let cur = s0;
    for (const [a, b] of occ) { if (b <= s0 || a >= s1) continue; if (a > cur) free.push([cur, a]); cur = Math.max(cur, b); }
    if (cur < s1) free.push([cur, s1]);
    // fill from the end nearer the town centre
    const pa = at(s0), pb = at(s1);
    const fromA = Math.hypot(pa.x - town.x, pa.z - town.z) <= Math.hypot(pb.x - town.x, pb.z - town.z);
    if (!fromA) free.reverse();
    if (!free.some(([a, b]) => b - a >= wdt + gap)) { if (typeOverride < 0) full.add(sideKey(e, side)); return 0; }
    let placed = 0;
    for (let [a, b] of free) {
      while (placed < maxLots && b - a >= wdt + gap) {
        let ok = false;
        for (let k = 0; k < 3 && !ok; k++) {
          const s = fromA ? a + gap / 2 + wdt / 2 + k * 0.45 : b - gap / 2 - wdt / 2 - k * 0.45;
          if (s - wdt / 2 < a - 1e-6 || s + wdt / 2 > b + 1e-6) break;
          const p = at(s);
          const nx = -p.tz * side, nz = p.tx * side;
          const off = hw + bt.setback * (bt.rank < 2 ? 1 + 0.8 * fringe : 1) + dep / 2;
          const bx = p.x + nx * off, bz = p.z + nz * off;
          // lots facing a park or the plaza stay open
          if (town.grid && this.inReserved(town, bx, bz)) { if (typeOverride < 0) full.add(sideKey(e, side)); return placed; }
          const angle = Math.atan2(-nx, -nz);
          if (this.canPlace(bx, bz, angle, wdt, dep) === null || this.blocksPlan(town, bx, bz, angle, wdt, dep)) continue;
          const y = this.prepareLot(bx, bz, angle, wdt, dep);
          if (y === null) continue;
          this.placeBuilding(town, type, bx, bz, angle, wdt, dep, y, rng, day, Infinity, P);
          placed++; ok = true;
          // the row continues from this building
          if (fromA) a = s + wdt / 2; else b = s - wdt / 2;
        }
        if (!ok || placed >= maxLots || typeOverride >= 0) break;
        // the next lot of the row (the type may change along the street)
        type = this.chooseType(town, mid.x - mid.tz * side * 2, mid.z + mid.tx * side * 2, rng, P, true);
        bt = BUILDING_TYPES[type];
        ({ wdt, dep, gap } = dims());
      }
      if (placed >= maxLots) return placed;
    }
    if (!placed && typeOverride < 0) full.add(sideKey(e, side));
    return placed;
  }

  /** Compact core radius by population (9g: larger towns with gardens and a suburban fringe reach further). */
  maxRadius(town: Town) { return 11 + Math.sqrt(Math.max(100, town.pop)) * 0.68; }
  /** Radius within which new lots and streets may appear (compact core, or the existing built-up area). */
  growthRadius(town: Town) { const m = this.maxRadius(town); return Math.max(m * 1.15, Math.min(town.radius - 2.5, m * 1.5)); }

  /**
   * Daily (game.ts): towns due to grow take their growth steps and schedule the next ones by their public transport
   * (townService: about every GROWTH_DAYS_UNSERVED days without, down to GROWTH_DAYS_BEST with the best service).
   */
  daily() {
    const g = this.game;
    for (const town of this.list) {
      if (g.day < town.nextGrowthDay) continue;
      const sv = townService(g, town);
      town.served = sv.stations;
      town.nextGrowthDay = g.day + Math.round((GROWTH_DAYS_UNSERVED / sv.speed) * (0.7 + g.rng.next() * 0.6));
      // big towns take more steps (each step is paced to their size: growStep)
      const steps = 1 + Math.floor(town.pop / 2500);
      const before = town.pop;
      for (let i = 0; i < steps; i++) this.growStep(town, g.rng, g.day);
      this.recomputePop(town);
      if (Math.floor(before / 1000) < Math.floor(town.pop / 1000) && town.pop >= 2000) {
        g.postNews(`${town.name} is booming: population passes ${Math.floor(town.pop / 1000) * 1000}!`, 'good', town.x, town.z);
      }
    }
  }

  /** One growth step: frontage lots, a new street at the edge, or densification. */
  growStep(town: Town, rng: RNG, day: number, plannedPop = town.pop): boolean {
    const net = this.world.net;
    // pace growth in the running game (generation grows freely): about 0.3 % of the population per
    // step times the growth profile, independent of how many steps the game schedules for big towns
    if (day > 0 && town.buildings.size > 0 && town.pop > 0) {
      const avg = town.pop / town.buildings.size;
      const gain = (0.003 * town.pop * this.profileOf(town).growth) / (1 + Math.floor(town.pop / 2500));
      if (rng.next() > gain / Math.max(1, avg)) return false;
    }
    if (!town.grid) town.grid = this.makeGrid(town, rng, town.pop);
    const g = town.grid;
    this.curDay = day;
    // in the running game one failing street per step may try its alternatives (no hitches); failed
    // streets are tried again every two years (terrain changes, obstacles go away)
    this.altBudget = day > 0 ? 1 : Infinity;
    if (day > 0) {
      if (g.retry === undefined) g.retry = day + 720;
      else if (day >= g.retry) { g.failed = []; g.retry = day + 720; }
    }
    // land claims follow the population in steps (deterministic, saved with the town)
    if (day > 0 && (town.claim === undefined || Math.abs(town.pop - town.claim) > town.claim * 0.15)) town.claim = town.pop;
    const claims = this.claimsKey();
    let sc = streetCache.get(town);
    if (!sc || sc.v !== net.version || sc.claims !== claims) {
      const list = this.streets(town).filter((e) => {
        if (e.type !== 'street' && !this.onGrid(g, e)) return false;
        const geo = net.geo(e), k = Math.floor(geo.n / 2) * 3;
        return this.owner(geo.pts[k], geo.pts[k + 2]) === town;
      });
      sc = { v: net.version, claims, list };
      streetCache.set(town, sc);
    }
    const streets = sc.list;
    if (!streets.length) return this.extendGrid(town, rng, day, plannedPop);
    // now and then: join streets that end inside the town to their neighbours
    if (day > 0 && rng.chance(0.03)) { this.closeDeadEnds(town, day); this.tidyBridgeEnds(town); }
    // upgrade a building near the centre now and then
    if (town.buildings.size > 20 && rng.chance(0.15) && this.upgrade(town, rng, day, plannedPop)) return true;
    // church once established
    if (!town.hasChurch && town.pop > 500) {
      const near = streets.filter((e) => { const n = net.nodes.get(e.a)!; return Math.hypot(n.x - town.x, n.z - town.z) < 14; });
      for (let k = 0; k < 6 && near.length; k++) if (this.frontage(town, near[rng.int(near.length)], rng.chance(0.5) ? 1 : -1, rng, day, BT_CHURCH)) return true;
    }
    // a plaza once the town is a city (if the central block is still free)
    if (!g.plaza && town.pop > 1500) { g.plaza = true; this.landUse(town, 0, 0, day); if (g.layout === 'radial') this.landUse(town, -1, -1, day); }
    // the next lots along a street side that still has room, nearest the centre first (world
    // generation fills several lots of a row at once)
    const full = fullSet(town, day);
    const cands: { e: NEdge; side: number; d: number }[] = [];
    for (const e of streets) {
      const geo = net.geo(e);
      const mx = geo.pts[Math.floor(geo.n / 2) * 3], mz = geo.pts[Math.floor(geo.n / 2) * 3 + 2];
      const d = Math.hypot(mx - town.x, mz - town.z);
      for (const side of [1, -1]) if (!full.has(sideKey(e, side))) cands.push({ e, side, d: d + rng.next() * 7 });
    }
    cands.sort((a, b) => a.d - b.d);
    // full sides are remembered, so this scan is short once the set is warm; the lattice only
    // grows when every side has been tried
    const lots = day === 0 ? 4 : 1;
    for (const c of cands.slice(0, 60)) if (this.frontage(town, c.e, c.side, rng, day, -1, plannedPop, lots)) return true;
    if (cands.length > 60) return false;
    // new blocks at the edge (their streets bring new lots); else densify; else reach beyond the plan;
    // a town hemmed in by its neighbours, water or hills finally builds denser than planned
    if (this.extendGrid(town, rng, day, plannedPop)) return true;
    if (town.buildings.size > 8 && this.upgrade(town, rng, day, plannedPop)) return true;
    for (let bonus = 1; bonus <= 2; bonus++) if (this.extendGrid(town, rng, day, plannedPop, bonus)) return true;
    return town.buildings.size > 8 && this.upgrade(town, rng, day, plannedPop > 6000 ? plannedPop * 1.5 : Math.min(5900, plannedPop * 1.5), 10);
  }

  /** Replace a building by a higher-ranked one (bigger footprint if there is room, else taller). */
  private upgrade(town: Town, rng: RNG, day: number, P = town.pop, tries = 4): boolean {
    const w = this.world;
    const ids = [...town.buildings];
    for (let k = 0; k < tries; k++) {
      const b = w.buildings.get(ids[rng.int(ids.length)]);
      if (!b || BUILDING_TYPES[b.type].rank >= 9) continue;
      const nt = this.chooseType(town, b.x, b.z, rng, P);
      if (BUILDING_TYPES[nt].rank <= BUILDING_TYPES[b.type].rank) continue;
      const bt = BUILDING_TYPES[nt];
      // densify gradually: the new building may house at most 2.5x the old one
      const maxPop = b.pop * 2.5 + 20;
      if (Math.min(bt.floors[0], floorCap(P)) * bt.popPerFloor[0] * (b.w * b.d) / 1.2 > maxPop) continue;
      const nw = Math.min(bt.w[1], Math.max(bt.w[0], b.w * 1.3)), nd = Math.min(bt.d[1], Math.max(bt.d[0], b.d * 1.3));
      // keep the facade line, grow backwards
      const fx = Math.sin(b.angle), fz = Math.cos(b.angle);
      const cx = b.x - fx * (nd - b.d) / 2, cz = b.z - fz * (nd - b.d) / 2;
      let y = this.canPlace(cx, cz, b.angle, nw, nd, b.id);
      let ux = cx, uz = cz, uw = nw, ud = nd;
      // no room to grow: rebuild taller on the same footprint (only if it suits the new type)
      if (y === null && b.w * b.d >= 0.6 * bt.w[0] * bt.d[0]) { y = this.canPlace(b.x, b.z, b.angle, b.w, b.d, b.id); ux = b.x; uz = b.z; uw = b.w; ud = b.d; }
      if (y === null) continue;
      town.buildings.delete(b.id);
      town.pop -= b.pop;
      w.removeBuilding(b.id);
      const yl = this.prepareLot(ux, uz, b.angle, uw, ud);
      if (yl === null) {
        // the bigger lot cannot be levelled: the old building stays
        const ob = w.addBuilding({ townId: b.townId, x: b.x, z: b.z, angle: b.angle, w: b.w, d: b.d, type: b.type, floors: b.floors, pop: b.pop, seed: b.seed, y: b.y, built: b.built });
        town.buildings.add(ob.id);
        town.pop += ob.pop;
        continue;
      }
      this.placeBuilding(town, nt, ux, uz, b.angle, uw, ud, yl, rng, day, maxPop, P);
      return true;
    }
    return false;
  }
}

/** Most storeys a town of a population builds: 3-6 storey cores, high-rises only in big cities. */
export function floorCap(P: number): number { return P < 1500 ? 4 : P < 3000 ? 5 : P < 6000 ? 6 : P < 9000 ? 10 : P < 14000 ? 18 : 40; }

function smoothstep(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
