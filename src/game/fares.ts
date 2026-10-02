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
import { DAY_SECONDS, UNIT_M } from './constants';

/** The alternative to public transport: walking (with a detour factor) and driving (detour, walk to the car, parking). */
export const ALT = { walkKmh: 5, walkDetour: 1.2, carKmh: 60, carDetour: 1.3, carAccessS: 240 };
/** Fare per unit of effective distance (calibrated so typical networks earn about what the distance-only fares paid). */
export const FARE_RATE = 7.0;
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
export function carTime(d: number): number { return ALT.carAccessS + (Math.max(0, d) * UNIT_M * ALT.carDetour) / (ALT.carKmh / 3.6); }

/**
 * Time (sim seconds) the trip of straight-line distance `d` units would take by the alternative: walking for short
 * trips, blending into the car beyond ~300 m (a smooth minimum of the two).
 */
export function refTime(d: number): number {
  const w = walkTime(d), c = carTime(d);
  if (!(w > 0)) return 1;
  return Math.pow(Math.pow(w, -4) + Math.pow(c, -4), -0.25);
}

/** Effective distance (units) for the fare: d^2 / (d + SHORT_HOP), tapering gently beyond TAPER_FROM. */
export function effDist(d: number): number {
  if (!(d > 1)) return 0;
  const e = (d * d) / (d + SHORT_HOP);
  return d <= TAPER_FROM ? e : e / Math.sqrt(1 + (d - TAPER_FROM) / TAPER_SCALE);
}

/** Base fare of one passenger for a leg of straight-line distance `d` units (before the speed factor). */
export function baseFare(d: number): number { return FARE_RATE * effDist(d); }

/** Speed / time factor of a leg: (refTime / legTime) ^ 0.55, clamped to 0.35..2.6. */
export function speedFactor(d: number, legSeconds: number): number {
  if (!(d > 1)) return 1;
  return clamp(Math.pow(refTime(d) / Math.max(1, legSeconds), SPEED_EXP), SPEED_MIN, SPEED_MAX);
}

/**
 * Income for `count` passengers on a leg of straight-line distance `distUnits` that took `legSeconds` (waiting at
 * the boarding stop + riding + transfer walk): count x base(d) x speedFactor.
 */
export function fareFor(distUnits: number, legSeconds: number, count: number): number {
  if (!(distUnits > 1) || !(count > 0)) return 0;
  return count * baseFare(distUnits) * speedFactor(distUnits, legSeconds);
}

/** The parts of a fare (for the UI): base per passenger, the speed factor, the alternative's time and the leg time. */
export function fareBreakdown(distUnits: number, legSeconds: number): { base: number; factor: number; refSeconds: number; legSeconds: number; perPassenger: number } {
  const base = baseFare(distUnits), factor = speedFactor(distUnits, legSeconds);
  return { base, factor, refSeconds: refTime(distUnits), legSeconds, perPassenger: base * factor };
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

/** Expected fare of `count` passengers on such a leg (route evaluation, e.g. the AI's fareAt). Stable API. */
export function estimateLegFare(distUnits: number, avgKmh: number, headwaySec: number, count = 1, detour = 1.15): number {
  return fareFor(distUnits, estimateLegTime(distUnits, avgKmh, headwaySec, detour), count);
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
