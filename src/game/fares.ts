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
import { DAY_SECONDS, UNIT_M, PASSENGER_FARE_SCALE, PASSENGER_LONG_FARE_SCALE, PASSENGER_FARE_BLEND, LOCAL_DEMAND_DISTANCE, LOCAL_DEMAND_EXP, LOCAL_SERVED_SHARE, RAIL_FARE, ROAD_FARES, URBAN_DEMAND } from './constants';
import type { Station } from './stations';

/**
 * Fare and local-demand modes: rail (one model for main-line, metro and light-rail track and any mix of them on a
 * line), tram and bus. Without a mode a leg pays the plain distance fare (legacy estimates).
 */
export type FareMode = 'rail' | 'tram' | 'bus';
export interface FareContext {
  mode?: FareMode;
  /** 0..1, both ends in a dense city centre */
  centre?: number;
  /**
   * Rail: the distance fares of the journey's earlier rail legs (0: this is its first). A journey's rail legs pay
   * their distance fares, together at least the minimum (railLegFare): splitting a trip over transfers adds none.
   */
  railBefore?: number;
}
export interface DemandSite { x: number; z: number; townId: number }
interface IntensitySeen { townId: number; pop: number; radius: number; x: number; z: number; value: number }
const intensityCache = new WeakMap<Game, { day: number; net: number; next: number; size: number; heights: number;
  values: Map<string, number>; sites: WeakMap<object, IntensitySeen> }>();

/** Actual nearby residents/jobs, rather than town-wide population as a proxy for a dense station neighbourhood. */
export function urbanIntensity(g: Game, site: DemandSite): number {
  const t = g.towns.list[site.townId];
  if (!t || t.pop <= URBAN_DEMAND.minPop) return 0;
  const w = g.world;
  let cache = intensityCache.get(g);
  if (!cache || cache.day !== g.day || cache.net !== w.net.version || cache.next !== w.nextBuildingId || cache.size !== w.buildings.size
    || cache.heights !== w.heightsVersion) {
    cache = { day: g.day, net: w.net.version, next: w.nextBuildingId, size: w.buildings.size, heights: w.heightsVersion, values: new Map(), sites: new WeakMap() };
    intensityCache.set(g, cache);
  }
  // Forecast loops ask for the same site objects many times: check the object's own record before building a key.
  const seen = cache.sites.get(site);
  if (seen && seen.townId === site.townId && seen.pop === t.pop && seen.radius === t.radius && seen.x === site.x && seen.z === site.z) return seen.value;
  const id = `${site.townId}:${t.pop}:${t.radius}:${site.x}:${site.z}`;
  const remember = (value: number) => { cache!.sites.set(site, { townId: site.townId, pop: t.pop, radius: t.radius, x: site.x, z: site.z, value }); return value; };
  const previous = cache.values.get(id); if (previous !== undefined) return remember(previous);
  const size = clamp((t.pop - URBAN_DEMAND.minPop) / (URBAN_DEMAND.fullPop - URBAN_DEMAND.minPop), 0, 1);
  let pop = 0;
  const R = 20;
  for (const b of g.world.buildingsNear(site.x, site.z, R)) if (b.townId === t.id && Math.hypot(b.x - site.x, b.z - site.z) <= R) pop += b.pop;
  const density = clamp(pop / (Math.PI * R * R * URBAN_DEMAND.density), 0, 1);
  const centre = clamp((t.radius * 1.25 - Math.hypot(site.x - t.x, site.z - t.z)) / Math.max(8, t.radius * 0.65), 0, 1);
  const value = size * density * centre;
  cache.values.set(id, value); return remember(value);
}

/** One context for real receipts and AI estimates (rail: the distance fare with its boarding minimum). */
export function stationFareContext(g: Game, from: Station | undefined, to: Station, mode?: FareMode): FareContext {
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
/**
 * speedFactor = clamp((refTime / legTime) ^ SPEED_EXP, SPEED_MIN, cap): the cap is SPEED_MAX_SHORT on trips up to
 * SHORT_TRIP units (a few minutes saved on a walk in town are worth less than the ratio says), rising to SPEED_MAX
 * by SHORT_TRIP * 3 (long trips: the premium of fast and high-speed services).
 */
export const SPEED_EXP = 0.55, SPEED_MIN = 0.35, SPEED_MAX = 2.6, SPEED_MAX_SHORT = 1.8, SHORT_TRIP = 100;
/** tripFactor = clamp((refTime / doorToDoor) ^ TRIP_EXP, TRIP_MIN, TRIP_MAX) (demand elasticity). */
export const TRIP_EXP = 0.7, TRIP_MIN = 0.3, TRIP_MAX = 2.5;
/**
 * Transfers cost income (2.7, replacing the old +20% no-transfer bonus): each change of vehicle takes 10% off the
 * income of the leg that ends in it and of every later leg. Legs are paid one at a time (each operator earns its own
 * leg), so a leg after k changes pays TRANSFER_FARE_FACTOR^k of its fare, and TRANSFER_FARE_FACTOR^(k+1) when its
 * passengers change vehicles at its end: a journey with one change earns 10% less than the same journey made
 * directly, with two 10-19% less (16% for three equal legs). Routing also charges transfers (patterns.ts
 * TRANSFER_PENALTY_S), so direct services are preferred and attract more trips.
 */
export const TRANSFER_FARE_FACTOR = 0.9;
/**
 * Fare multiplier of a leg whose `count` passengers have made `transfers` changes of vehicle, in all, counting a change
 * at the leg's end (a passenger group shares its history: transfers / count changes each). 1 for a direct journey.
 */
export function transferFareFactor(transfers: number, count = 1): number {
  const k = count > 0 && transfers > 0 ? transfers / count : 0;
  return k > 0 ? Math.pow(TRANSFER_FARE_FACTOR, k) : 1;
}
/**
 * Waiting and cargo groups keep passengers apart by the changes of vehicle they made so far (each pays its own
 * transfer reduction): 0, 1, 2, or CHANGE_CLASSES and more in one group, whose fare uses its mean number of changes
 * (journeys with three changes or more are rare; mixing three and four changes stays within 0.2% of the exact fares).
 */
export const CHANGE_CLASSES = 3;
/** The change class of a group of `count` passengers who made `transfers` changes of vehicle so far, in all. */
export function changeClass(transfers: number | undefined, count: number): number {
  const k = count > 0 && transfers && transfers > 0 ? transfers / count : 0;
  return Math.min(CHANGE_CLASSES, Math.round(k));
}
/**
 * Fare level of every leg (distance fare, rail minimum, bus and tram boarding): 1.2 since the transfer reduction
 * replaced the +20% no-transfer bonus, so a direct journey (most of them) pays what it did before, while journeys with
 * changes pay x0.9 per change. Without it direct incomes fell by a sixth and the economy bands failed
 * (scripts/economy.ts: intercity payback 103 years instead of 51, operating results 50% below the calibrated baseline).
 */
export const FARE_LEVEL = 1.2;
/**
 * A leg counts at most this many scheduled headways of its service as waiting: a backlog beyond what the line
 * carries is lost demand (passengers give up), not a slower trip for those who ride.
 */
export const WAIT_CAP_HEADWAYS = 1.5;
/** Walking between linked stations (transfer walks): speed (m/s) and a base for stairs and finding the way (s). */
export const TRANSFER_WALK = { mps: 1.25, baseS: 20 };

/** Continuous sim clock (seconds): day + fraction, DAY_SECONDS each. */
export function simNow(g: Game): number { return (g.day + g.dayFrac) * DAY_SECONDS; }

/**
 * A journey's rail fare history as it matters for later legs: railLegFare gives the same fare for every history at or
 * above the minimum, so histories are capped there. Equal fares, and few distinct waiting / cargo groups.
 */
export function railHistory(rail: number | undefined): number { return Math.min(RAIL_FARE.minimum, Math.max(0, rail ?? 0)); }

/**
 * Waiting (line) or cargo (boarding stop) identity. Different rail histories cannot share a fare minimum, nor
 * different changes of vehicle so far (`changes`: changeClass) a transfer reduction.
 */
export function fareGroupKey(lineOrFrom: number, alight: number, dest: number, rail = 0, changes = 0): string {
  const key = lineOrFrom + ':' + alight + ':' + dest, r = railHistory(rail), c = Math.min(CHANGE_CLASSES, Math.max(0, Math.round(changes)));
  return (r ? key + ':rail:' + r : key) + (c ? ':x' + c : '');
}

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

/** The distance fare of one passenger for a leg of straight-line distance `d` units (before the speed factor). */
export function distanceFare(d: number): number { return FARE_RATE * (fareCalibration(d) / PASSENGER_FARE_SCALE) * effDist(d); }

/**
 * Base fare of a rail leg (before the speed factor): a journey's rail legs pay their distance fares, together at
 * least RAIL_FARE.minimum. `before`: the distance fares of its earlier rail legs (0: none), so the first rail leg pays
 * up to the minimum and a later one only what takes the journey's distance fares beyond it (the operator who carries
 * the first rail leg collects the minimum).
 */
export function railLegFare(d: number, before = 0): number {
  const b = distanceFare(d), min = RAIL_FARE.minimum;
  return before > 0 ? Math.max(min, before + b) - Math.max(min, before) : Math.max(min, b);
}

/**
 * Base fare of one passenger for a leg of straight-line distance `d` units (before the speed factor): rail pays the
 * distance fare with a minimum per journey (railLegFare; `railBefore`: the journey's earlier rail legs), tram and bus
 * a boarding charge plus their distance share.
 */
export function baseFare(d: number, mode?: FareMode, railBefore = 0): number {
  const distance = distanceFare(d);
  if (mode === 'rail') return FARE_LEVEL * (railBefore > 0 ? railLegFare(d, railBefore) : Math.max(RAIL_FARE.minimum, distance));
  const road = mode && ROAD_FARES[mode];
  return FARE_LEVEL * (road ? road.boarding + distance * road.distance : distance);
}

/** Speed / time factor of a leg: (refTime / legTime) ^ 0.55, clamped to 0.35..1.8 on short trips, ..2.6 on long ones. */
export function speedFactor(d: number, legSeconds: number, centre = 0): number {
  if (!(d > 1)) return 1;
  const cap = SPEED_MAX_SHORT + (SPEED_MAX - SPEED_MAX_SHORT) * clamp((d - SHORT_TRIP) / (2 * SHORT_TRIP), 0, 1);
  return clamp(Math.pow(refTime(d, centre) / Math.max(1, legSeconds), SPEED_EXP), SPEED_MIN, cap);
}

/**
 * Income for `count` passengers on a leg of straight-line distance `distUnits` that took `legSeconds` (waiting at
 * the boarding stop + riding + transfer walk): count x base(d) x speedFactor.
 */
export function fareFor(distUnits: number, legSeconds: number, count: number, context: FareContext = {}): number {
  if (!(distUnits > 1) || !(count > 0)) return 0;
  return count * baseFare(distUnits, context.mode, context.railBefore) * speedFactor(distUnits, legSeconds, context.centre);
}

/** The parts of a fare (for the UI): base per passenger, the speed factor, the alternative's time and the leg time. */
export function fareBreakdown(distUnits: number, legSeconds: number, context: FareContext = {}): { base: number; factor: number; refSeconds: number; legSeconds: number; perPassenger: number } {
  const base = baseFare(distUnits, context.mode, context.railBefore), factor = speedFactor(distUnits, legSeconds, context.centre);
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
 * Two-stop projects are direct rides and earn the full fare; `direct=false` prices a journey with one change of vehicle
 * (or either of its legs: both pay TRANSFER_FARE_FACTOR, as vehicle.ts charges them). No second calendar rate scale.
 */
export function estimateLegFare(distUnits: number, avgKmh: number, headwaySec: number, count = 1, detour = 1.15, direct = true, odDemand = true, context: FareContext = {}): number {
  const share = 1 / Math.pow(1 + (Math.max(0, distUnits) / LOCAL_DEMAND_DISTANCE) ** 2, LOCAL_DEMAND_EXP);
  const capture = odDemand ? clamp((0.6 + 0.4 * Math.min(1, share / LOCAL_SERVED_SHARE)) / share, 1, 4) : 1;
  return fareFor(distUnits, estimateLegTime(distUnits, avgKmh, headwaySec, detour), count * capture, context) * (direct ? 1 : TRANSFER_FARE_FACTOR);
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
export function transferWalkTime(gapUnits: number, internal = false): number { return (internal ? 0 : TRANSFER_WALK.baseS) + (Math.max(0, gapUnits) * UNIT_M * 1.2) / TRANSFER_WALK.mps; }

// ------------------------------------------------------------------------------ mail
/**
 * Mail fares, kept apart from the passenger fares so they can be recalibrated on their own (scripts/mailcal.ts). A
 * journey pays once, when the mail is delivered: `rate` per unit of mail (MAIL_UNIT_T, 0.1 t) and unit of effective
 * distance from where it was posted to its destination (d^2 / (d + shortHop), tapering gently beyond taperFrom), times
 * the time factor clamp((mailRefTime(d) / journey time) ^ exp, min, max) and `transfer` for every change of vehicle on
 * the way. The legs share the receipts by the distances they carried (mail.ts settleMail), so splitting a journey
 * never earns more than carrying it direct. No direct bonus, boarding charge or city-centre term.
 */
export const MAIL_FARE = { rate: 13.65, shortHop: 10, taperFrom: 500, taperScale: 5000, exp: 1.0, min: 0.15, max: 1.6, transfer: 0.9 };
/** The alternative for mail: `baseS` collection and sorting, then a van at `kmh` on a `detour` of the straight distance. */
export const MAIL_REF = { baseS: 240, kmh: 50, detour: 1.3 };
/** Demand elasticity of mail (mail.ts): clamp((mailRefTime / expected time) ^ exp, min, max). */
export const MAIL_TRIP = { exp: 0.8, min: 0.3, max: 1.25 };
/** The time mail would take by the alternative (s) over a straight-line distance of `d` units. */
export function mailRefTime(d: number): number { return MAIL_REF.baseS + (Math.max(0, d) * UNIT_M * MAIL_REF.detour) / (MAIL_REF.kmh / 3.6); }
/** Effective distance (units) of a mail journey for its fare. */
export function mailEffDist(d: number): number {
  if (!(d > 1)) return 0;
  const e = (d * d) / (d + MAIL_FARE.shortHop);
  return d <= MAIL_FARE.taperFrom ? e : e / Math.sqrt(1 + (d - MAIL_FARE.taperFrom) / MAIL_FARE.taperScale);
}
/** Time factor of a mail journey of `d` units that took `seconds` from posting to delivery. */
export function mailTimeFactor(d: number, seconds: number): number {
  return clamp(Math.pow(mailRefTime(d) / Math.max(1, seconds), MAIL_FARE.exp), MAIL_FARE.min, MAIL_FARE.max);
}
/**
 * Receipts for `units` of mail delivered `d` units (straight line, from where it was posted) after `seconds` since
 * posting, with `changes` changes of vehicle on the way (waiting counts in full: mail is not "lost demand").
 */
export function mailFare(d: number, seconds: number, units: number, changes = 0): number {
  if (!(d > 1) || !(units > 0)) return 0;
  return units * MAIL_FARE.rate * mailEffDist(d) * mailTimeFactor(d, seconds) * Math.pow(MAIL_FARE.transfer, Math.max(0, changes));
}
/** How much more (or less) mail is sent by a service of expected time `seconds` over `d` units than the alternative's. */
export function mailTripFactor(d: number, seconds: number): number {
  return clamp(Math.pow(mailRefTime(d) / Math.max(1, seconds), MAIL_TRIP.exp), MAIL_TRIP.min, MAIL_TRIP.max);
}
