// Fares with the value of time. A journey leg pays base(d) — a rate times the effective distance (very short
// hops earn little, a gentle taper on long trips) — times a speed factor comparing the leg's time (waiting at the
// boarding stop + riding + any transfer walk) with the time the trip would take by the alternative: walking for
// short trips, a car (with the walk to it and parking) for longer ones. Faster and more frequent service earns
// more, slow or infrequent service less.
//
// Times are sim seconds: physical motion runs at real speed (1 unit = 10 m, KMH_TO_UPS) while the calendar is
// compressed (DAY_SECONDS per game day), so waits and rides are real-time seconds even though a year passes in
// 360 * DAY_SECONDS of them. `simNow(g)` is the continuous clock.
import type { Game } from './game';
import { DAY_SECONDS, UNIT_M, PASSENGER_FARE_SCALE, PASSENGER_LONG_FARE_SCALE, PASSENGER_FARE_BLEND, LOCAL_DEMAND_DISTANCE, LOCAL_DEMAND_EXP, LOCAL_SERVED_SHARE, URBAN_FARES, URBAN_DEMAND } from './constants';
import type { Station } from './stations';

export type UrbanMode = keyof typeof URBAN_FARES;
export interface FareContext { mode?: UrbanMode; /** 0..1, both ends in a dense city centre */ centre?: number }
export interface DemandSite { x: number; z: number; townId: number }
const intensityCache = new WeakMap<Game, { key: string; values: Map<string, number> }>();

/** Actual nearby residents/jobs, rather than town-wide population as a proxy for a dense station neighbourhood. */
export function urbanIntensity(g: Game, site: DemandSite): number {
  const t = g.towns.list[site.townId];
  if (!t || t.pop <= URBAN_DEMAND.minPop) return 0;
  const key = `${g.day}:${g.world.net.version}:${g.world.nextBuildingId}:${g.world.buildings.size}:${g.world.heightsVersion}`;
  let cache = intensityCache.get(g);
  if (!cache || cache.key !== key) { cache = { key, values: new Map() }; intensityCache.set(g, cache); }
  const id = `${site.townId}:${t.pop}:${t.radius}:${site.x}:${site.z}`;
  const previous = cache.values.get(id); if (previous !== undefined) return previous;
  const size = clamp((t.pop - URBAN_DEMAND.minPop) / (URBAN_DEMAND.fullPop - URBAN_DEMAND.minPop), 0, 1);
  let pop = 0;
  const R = 20;
  for (const b of g.world.buildingsNear(site.x, site.z, R)) if (b.townId === t.id && Math.hypot(b.x - site.x, b.z - site.z) <= R) pop += b.pop;
  const density = clamp(pop / (Math.PI * R * R * URBAN_DEMAND.density), 0, 1);
  const centre = clamp((t.radius * 1.25 - Math.hypot(site.x - t.x, site.z - t.z)) / Math.max(8, t.radius * 0.65), 0, 1);
  const value = size * density * centre;
  cache.values.set(id, value); return value;
}

/** One context for real receipts and AI estimates; main-line/HSR trains retain their distance fare. */
export function stationFareContext(g: Game, from: Station | undefined, to: Station, mode?: UrbanMode): FareContext {
  if (!from) return {};
  const sameTown = from.townId >= 0 && from.townId === to.townId;
  const centre = sameTown ? Math.min(urbanIntensity(g, from), urbanIntensity(g, to)) : 0;
  return { mode, centre };
}

/** The alternative to public transport: walking (with a detour factor) and driving (detour, walk to the car, parking). */
export const ALT = { walkKmh: 5, walkDetour: 1.2, carKmh: 60, carDetour: 1.3, carAccessS: 240 };
/** Short-leg fare per unit of effective distance in game money; baseFare blends to the long-leg compensation. */
export const FARE_RATE = 7.0 * PASSENGER_FARE_SCALE;
/** Effective distance d^2 / (d + SHORT_HOP): very short hops earn little. */
export const SHORT_HOP = 10;
/** Long trips: the rate tapers gently beyond TAPER_FROM units (the effective distance grows ~ sqrt beyond). */
export const TAPER_FROM = 500, TAPER_SCALE = 5000;
/** speedFactor = clamp((refTime / legTime) ^ SPEED_EXP, SPEED_MIN, SPEED_MAX). */
export const SPEED_EXP = 0.55, SPEED_MIN = 0.35, SPEED_MAX = 2.6;
/** tripFactor = clamp((refTime / doorToDoor) ^ TRIP_EXP, TRIP_MIN, TRIP_MAX) (demand elasticity). */
export const TRIP_EXP = 0.7, TRIP_MIN = 0.3, TRIP_MAX = 2.5;
/**
 * No-transfer bonus: passengers whose whole journey is one ride (no change of vehicle) pay this much more on it
 * (routing also charges transfers, patterns.ts TRANSFER_PENALTY_S, so direct services are preferred).
 */
export const NO_TRANSFER_BONUS = 0.2;
/**
 * A leg counts at most this many scheduled headways of its service as waiting: a backlog beyond what the line
 * carries is lost demand (passengers give up), not a slower trip for those who ride.
 */
export const WAIT_CAP_HEADWAYS = 1.5;
/** Walking between linked stations (transfer walks): speed (m/s) and a base for stairs and finding the way (s). */
export const TRANSFER_WALK = { mps: 1.25, baseS: 20 };

/** Continuous sim clock (seconds): day + fraction, DAY_SECONDS each. */
export function simNow(g: Game): number { return (g.day + g.dayFrac) * DAY_SECONDS; }

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Walking time (s) for a straight-line distance of `d` units. */
export function walkTime(d: number): number { return (Math.max(0, d) * UNIT_M * ALT.walkDetour) / (ALT.walkKmh / 3.6); }
/** Driving time (s) incl. getting to the car and parking, for a straight-line distance of `d` units. */
export function carTime(d: number, centre = 0): number {
  const c = clamp(centre, 0, 1);
  return ALT.carAccessS + 360 * c + (Math.max(0, d) * UNIT_M * ALT.carDetour) / ((ALT.carKmh * (1 - 0.65 * c)) / 3.6);
}

/**
 * Time (sim seconds) the trip of straight-line distance `d` units would take by the alternative: walking for short
 * trips, blending into the car beyond ~300 m (a smooth minimum of the two).
 */
export function refTime(d: number, centre = 0): number {
  const w = walkTime(d), c = carTime(d, centre);
  if (!(w > 0)) return 1;
  return Math.pow(Math.pow(w, -4) + Math.pow(c, -4), -0.25);
}

/** Effective distance (units) for the fare: d^2 / (d + SHORT_HOP), tapering gently beyond TAPER_FROM. */
export function effDist(d: number): number {
  if (!(d > 1)) return 0;
  const e = (d * d) / (d + SHORT_HOP);
  return d <= TAPER_FROM ? e : e / Math.sqrt(1 + (d - TAPER_FROM) / TAPER_SCALE);
}

/**
 * Compensation for realistic passenger counts. Saturated railways gain more from shorter queues/dwell than
 * short bus hops; a single inverse-demand multiplier would inflate their income. Blend smoothly by distance.
 */
export function fareCalibration(d: number): number {
  return PASSENGER_LONG_FARE_SCALE + (PASSENGER_FARE_SCALE - PASSENGER_LONG_FARE_SCALE) / (1 + (Math.max(0, d) / PASSENGER_FARE_BLEND) ** 2);
}

/** Base fare of one passenger for a leg of straight-line distance `d` units (before the speed factor). */
export function baseFare(d: number, mode?: UrbanMode): number {
  const distance = FARE_RATE * (fareCalibration(d) / PASSENGER_FARE_SCALE) * effDist(d);
  const urban = mode && URBAN_FARES[mode];
  return urban ? urban.boarding + distance * urban.distance : distance;
}

/** Speed / time factor of a leg: (refTime / legTime) ^ 0.55, clamped to 0.35..2.6. */
export function speedFactor(d: number, legSeconds: number, centre = 0): number {
  if (!(d > 1)) return 1;
  return clamp(Math.pow(refTime(d, centre) / Math.max(1, legSeconds), SPEED_EXP), SPEED_MIN, SPEED_MAX);
}

/**
 * Income for `count` passengers on a leg of straight-line distance `distUnits` that took `legSeconds` (waiting at
 * the boarding stop + riding + transfer walk): count x base(d) x speedFactor.
 */
export function fareFor(distUnits: number, legSeconds: number, count: number, context: FareContext = {}): number {
  if (!(distUnits > 1) || !(count > 0)) return 0;
  return count * baseFare(distUnits, context.mode) * speedFactor(distUnits, legSeconds, context.centre);
}

/** The parts of a fare (for the UI): base per passenger, the speed factor, the alternative's time and the leg time. */
export function fareBreakdown(distUnits: number, legSeconds: number, context: FareContext = {}): { base: number; factor: number; refSeconds: number; legSeconds: number; perPassenger: number } {
  const base = baseFare(distUnits, context.mode), factor = speedFactor(distUnits, legSeconds, context.centre);
  return { base, factor, refSeconds: refTime(distUnits, context.centre), legSeconds, perPassenger: base * factor };
}

/**
 * Demand elasticity (for the demand model): how much more (or less) a door-to-door trip is wanted than with the
 * alternative, from the expected time (in-vehicle + half the headway + transfers) against `refSec`
 * (refTime of the distance): clamp((ref / time) ^ 0.7, 0.3, 2.5).
 */
export function tripFactor(doorToDoorSec: number, refSec: number): number {
  if (!(refSec > 0)) return 1;
  return clamp(Math.pow(refSec / Math.max(1, doorToDoorSec), TRIP_EXP), TRIP_MIN, TRIP_MAX);
}

/**
 * Expected leg time (s) of a service: half the headway waiting plus riding `distUnits` (straight line, times a
 * route detour) at an average speed of `avgKmh` (stops and acceleration included).
 */
export function estimateLegTime(distUnits: number, avgKmh: number, headwaySec: number, detour = 1.15): number {
  return Math.max(0, headwaySec) / 2 + (Math.max(0, distUnits) * UNIT_M * detour) / Math.max(1, avgKmh / 3.6);
}

/**
 * Project revenue per calibrated OD trip (AI town demand already includes the rate scale). Generation in
 * DemandModel.weights normalises the served local OD share to 60..100% of the catchment's rate; using raw OD
 * counts alone understates intercity boardings. Approximate that capture from the same distance decay, bounded
 * at 4x since the estimate lacks the actual catchments and other destinations. This adjusts forecast volume,
 * never the fare a real passenger pays. Set `odDemand=false` when `count` is an actual number of boardings.
 * Two-stop projects are direct rides and earn the actual no-transfer bonus. No second calendar rate scale.
 */
export function estimateLegFare(distUnits: number, avgKmh: number, headwaySec: number, count = 1, detour = 1.15, direct = true, odDemand = true, context: FareContext = {}): number {
  const share = 1 / Math.pow(1 + (Math.max(0, distUnits) / LOCAL_DEMAND_DISTANCE) ** 2, LOCAL_DEMAND_EXP);
  const capture = odDemand ? clamp((0.6 + 0.4 * Math.min(1, share / LOCAL_SERVED_SHARE)) / share, 1, 4) : 1;
  return fareFor(distUnits, estimateLegTime(distUnits, avgKmh, headwaySec, detour), count * capture, context) * (direct ? 1 + NO_TRANSFER_BONUS : 1);
}

/**
 * Legacy fare (v2.2 signature): `days` = game days aboard. A typical wait is added to the ride: on the game's
 * sparse, busy services (a vehicle or two per line) passengers wait about 1.5 times the ride.
 */
export function legacyFare(dist: number, days: number, count: number): number {
  const ride = Math.max(0, days) * DAY_SECONDS;
  return fareFor(dist, 2.5 * ride + 15, count);
}

/** Time (s) of a walking transfer of `gapUnits` between linked stations. */
export function transferWalkTime(gapUnits: number): number { return TRANSFER_WALK.baseS + (Math.max(0, gapUnits) * UNIT_M * 1.2) / TRANSFER_WALK.mps; }
