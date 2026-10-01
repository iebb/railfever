// Core constants. World scale: 1 unit = 10 metres. Heights are continuous world units.

export const UNIT_M = 10;
/** Real seconds per in-game day at 1x speed. */
export const DAY_SECONDS = 2.0;
export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
/** km/h -> world units per (game) second. */
export const KMH_TO_UPS = 1 / 36;

/** Sea level. */
export const WATER_Y = 0;

export type NetKind = 'rail' | 'road';

export interface TrackType {
  id: string;
  name: string;
  /** design speed (km/h) */
  speed: number;
  maxGrade: number;
  minRadius: number;
  costPerUnit: number;
  maintPerUnit: number;
  electrified: boolean;
}

export const TRACK_TYPES: Record<string, TrackType> = {
  standard: { id: 'standard', name: 'Standard track', speed: 160, maxGrade: 0.035, minRadius: 12, costPerUnit: 7500, maintPerUnit: 300, electrified: false },
  highspeed: { id: 'highspeed', name: 'High-speed track (electrified)', speed: 300, maxGrade: 0.03, minRadius: 30, costPerUnit: 14000, maintPerUnit: 600, electrified: true },
};

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
