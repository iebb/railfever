// Core constants. World scale: 1 unit = 10 metres. Heights are continuous world units.

export const UNIT_M = 10;
/** Real seconds per in-game day at 1x speed. */
export const DAY_SECONDS = 2.0;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
/**
 * Passenger calibration on the compressed calendar. Apply once to BOTH local and long-distance per-day/month
 * demand (demand.ts), never to vehicle capacity or motion. A game year is only 720 physical seconds, so calendar
 * totals and literal physical service-day rates must be reported separately (scripts/ridership.ts).
 */
export const PASSENGER_RATE_SCALE = 1 / 10;
/**
 * Fare compensation in game money (short / long legs). The old services were capacity constrained, so a 10x
 * fare would overpay: fewer passengers also shorten dwell and waits. A smooth distance blend preserves the
 * rail/bus income balance measured by scripts/economy.ts, while retaining the existing speed factor.
 */
export const PASSENGER_FARE_SCALE = 7, PASSENGER_LONG_FARE_SCALE = 1.95;
/** Distance (units, 1 = 10 m) at which the short/long fare compensation is halfway blended. */
export const PASSENGER_FARE_BLEND = 17;
/** Shared local gravity/coverage parameters for demand and project revenue estimates. */
export const LOCAL_DEMAND_DISTANCE = 40, LOCAL_DEMAND_EXP = 0.85, LOCAL_SERVED_SHARE = 0.15;
/** km/h -> world units per (game) second. */
export const KMH_TO_UPS = 1 / 36;

/** Sea level. */
export const WATER_Y = 0;

export type NetKind = 'rail' | 'road';
/** Transport mode of a line (trams run on road edges that carry tram tracks). */
export type LineKind = 'rail' | 'road' | 'tram';

export interface TrackType {
  id: string;
  name: string;
  /** design speed (km/h) */
  speed: number;
  maxGrade: number;
  minRadius: number;
  /** per unit of track, overhead wire included on electrified track */
  costPerUnit: number;
  maintPerUnit: number;
  /** overhead wire: electric traction needs it */
  electrified: boolean;
  /** what the track is for (stations take their mode from their platform track) */
  mode: 'mainline' | 'metro' | 'lightrail';
  /** earthworks of its formation relative to heavy rail (light rail: narrower and lighter) */
  formation: number;
}

/**
 * Track types. `standard` is unelectrified; `electric` is the same main-line track with overhead wire (what
 * `electrify` turns standard track into); `metro` is electrified urban rail (tighter curves, steeper grades,
 * ~100 km/h), `lightrail` light electrified track (tight curves, steep grades, a light formation).
 */
export const TRACK_TYPES: Record<string, TrackType> = {
  standard: { id: 'standard', name: 'Standard track', speed: 160, maxGrade: 0.035, minRadius: 12, costPerUnit: 7500, maintPerUnit: 300, electrified: false, mode: 'mainline', formation: 1 },
  electric: { id: 'electric', name: 'Electrified track', speed: 160, maxGrade: 0.035, minRadius: 12, costPerUnit: 10000, maintPerUnit: 380, electrified: true, mode: 'mainline', formation: 1 },
  highspeed: { id: 'highspeed', name: 'High-speed track (electrified)', speed: 400, maxGrade: 0.03, minRadius: 40, costPerUnit: 22000, maintPerUnit: 900, electrified: true, mode: 'mainline', formation: 1.1 },
  metro: { id: 'metro', name: 'Metro track (electrified)', speed: 100, maxGrade: 0.045, minRadius: 8, costPerUnit: 9500, maintPerUnit: 400, electrified: true, mode: 'metro', formation: 0.9 },
  lightrail: { id: 'lightrail', name: 'Light rail track (electrified)', speed: 80, maxGrade: 0.07, minRadius: 3, costPerUnit: 6500, maintPerUnit: 260, electrified: true, mode: 'lightrail', formation: 0.6 },
};

/** Overhead wire for existing track (`electrify`): standard -> electric, per unit of track. */
export const ELECTRIFY = { costPerUnit: 2500, from: 'standard', to: 'electric' };

/**
 * Levels a line can be built at (BuildOptions.level): viaduct deck height above the ground beneath, and
 * tunnel depth below the ground above (units, 1 = 10 m).
 */
export const LINE_LEVEL = { height: { min: 1.2, max: 1.8, def: 1.5 }, depth: { min: 1.5, max: 3, def: 2.2 } };

export interface RoadType {
  id: string;
  name: string;
  /** carriageway half width */
  half: number;
  sidewalk: number;
  lanes: number;
  speed: number;
  maxGrade: number;
  minRadius: number;
  costPerUnit: number;
  maintPerUnit: number;
}

export const ROAD_TYPES: Record<string, RoadType> = {
  street: { id: 'street', name: 'Town street', half: 0.3, sidewalk: 0.2, lanes: 2, speed: 50, maxGrade: 0.1, minRadius: 1.5, costPerUnit: 3500, maintPerUnit: 80 },
  road: { id: 'road', name: 'Country road', half: 0.34, sidewalk: 0, lanes: 2, speed: 90, maxGrade: 0.08, minRadius: 4, costPerUnit: 3000, maintPerUnit: 60 },
};

/**
 * Tram tracks embedded in a road edge (with overhead wire): `edge.tram`, owned by `edge.tramOwner`.
 * Costs per world unit of road; trams keep to the road's speed limit (max `speed` km/h on tracks).
 */
export const TRAM = { costPerUnit: 4500, maintPerUnit: 90, removePerUnit: 700, speed: 70 };

export const RAIL = {
  gauge: 0.1435,
  spacing: 0.45,
  /** half width of the ballast bed top */
  bedTop: 0.17,
  bedBottom: 0.3,
  bedHeight: 0.05,
  railTop: 0.075,
  /** vertical clearance needed above another line (overpass) */
  clearance: 0.62,
};

export const LANE_OFFSET = 0.16;
export const STATION_RADIUS = 26;
export const BUSSTOP_RADIUS = 14;
/** Horizontal sample spacing of edge height profiles. */
export const PSTEP = 1.0;
