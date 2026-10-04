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
/**
 * Urban trips use the same compressed calendar. Extra local trips apply only inside large, dense towns, by the mode
 * that carries the journey (demand.ts journeyMode): rail is one mode (main-line, metro and light-rail track alike),
 * then tram and bus. Rail three times the tram: faster and more frequent, not a different kind of trip (12 since in-
 * city metro and light-rail stops walk half as far, from 8: the same for every rail station in a dense centre, so a
 * city railway of closer stops still repays; scripts/citycatch.ts, urbanecon.ts).
 */
export const URBAN_DEMAND = { minPop: 3000, fullPop: 8000, density: 0.65, rail: 12, tram: 4, bus: 2 };
/** Small unmodelled car/drop-off feeder share of cross-town rail trips; bus/tram feeders are routed as real transfers. */
export const MAINLINE_FEEDER_SHARE = 0.08;
/**
 * Car/drop-off trips from uncovered street-connected districts, attracted by frequent cross-town rail service (any
 * track type). A separate pool, never a wider walking isochrone. With the 30% shorter walks, more residents use
 * feeders; an ordinary town-to-town timetable remains eligible. Sparse services retain just the allowance above.
 */
export const MAINLINE_FEEDERS = { share: 0.75, fullHeadway: 100, cutoffHeadway: 300, reach: 84 };
/**
 * Rail fares (one model for every track type): the distance fare, but at least `minimum` per journey (fares.ts
 * railLegFare: transfers add none), so very short hops pay sensibly; it binds on rail trips under about 345 m
 * (calibrated game money, before the speed factor; long trips and the high-speed premium follow the distance and the
 * time saved).
 */
export const RAIL_FARE = { minimum: 550 };
/** Tram and bus fares: a boarding charge in calibrated game money, followed by the scaled distance component. */
export const ROAD_FARES = { tram: { boarding: 80, distance: 0.9 }, bus: { boarding: 12, distance: 0.9 } };
/**
 * Years of operating surplus available to repay an urban rail project, by construction style: subway-style tunnels
 * and cross-city links amortise longer than light-rail-style surface or viaduct lines.
 */
export const URBAN_PAYBACK = { metro: 15, lightrail: 9, crosscity: 15 };
/** km/h -> world units per (game) second. */
export const KMH_TO_UPS = 1 / 36;

/**
 * The cargoes lines carry: passengers and mail. Line tables, routing, boarding and headways take a cargo (default
 * passengers); a vehicle carries passengers unless it is mail-only (no seats and room for mail: Vehicle.mailOnly).
 */
export type Cargo = 'pax' | 'mail';
/** Mail is counted in units of this many tonnes (VehicleModel.mail, queues, loads); the UI shows tonnes. */
export const MAIL_UNIT_T = 0.1;
/**
 * Mail calibration (mail.ts): mail units posted per unit of the passenger generation rate (demand.ts GEN_RATE), so
 * mail inherits the passenger recalibration of the compressed calendar. scripts/mailcal.ts on 2.7 (30% shorter walks,
 * so smaller mail catchments too): single intercity railways with a van and three coaches (seeds 7 / 23 / 51, 1950 and
 * 2000) carry mail worth 15-21% of their passenger income, vans 0.44-0.58x as full as the coaches; the AI networks'
 * railways about 50% (their passengers are shared with bus stops and ride the trains only between towns). Below about
 * 0.18 a van no longer pays its way on a single line (the AI's margin: 1.5x its operating cost and price/8). Recalibrate
 * it with mailcal when passenger catchments or generation change (mail shares the walking catchments).
 */
export const MAIL_PER_PAX = 0.2;
/**
 * Mail per person by year (piecewise linear; 1950 = 1): by weight about +30% from 1950 to 2000, then about flat
 * (letters halve, parcels grow two to three times).
 */
export const MAIL_ERA: readonly [number, number][] = [[1870, 0.35], [1900, 0.5], [1925, 0.75], [1950, 1], [1975, 1.2], [2000, 1.35], [2010, 1.25], [2025, 1.35]];
/**
 * Mail stations: a station accepts mail (posts it, and receives its town's mail) when a mail-carrying line serves it
 * and its weighted catchment (mail.ts mailPop) is at least `acceptPop`: a halt that reaches hardly anyone handles none,
 * a town's station at its edge still does. Queue cap: min(`cap`, `base` + `perPop` x mailPop + `perTrack` x platform
 * tracks + `perStop` x stops); mail beyond it is lost.
 */
export const MAIL_STATION = { acceptPop: 25, cap: 400, base: 20, perPop: 0.02, perTrack: 15, perStop: 5 };
/**
 * Mail feeders (mail.ts allocate), the post office's counterpart of the passengers' car feeders (MAINLINE_FEEDERS,
 * the same rules by mail service): mail from the buildings of a town of `minTownPop`+ that no mail station reaches on
 * foot is brought to its railway stations served by mail-carrying trains to other towns, by the quality of that mail
 * service (1 at a combined mail headway of `fullHeadway` s or less, 0 from `cutoffHeadway` s, as the car feeders): this
 * `share` x the quality, from within `reach` units by road, shared by the weight quality / (1 + distance / `decay`).
 * The share is small (the car feeders': 0.75): mail stations keep the whole catchment they reach on foot, passengers
 * share theirs with the bus stops, and frequent mail trains are the networks' (scripts/mailcal.ts).
 */
export const MAIL_FEEDER = { share: 0.1, reach: 84, decay: 30, minTownPop: 1500, fullHeadway: 100, cutoffHeadway: 300 };
/**
 * Mail capture (mail.ts weights), as the passengers' local capture: a station whose mail routes reach the towns that
 * receive `full` of its town's mail (the gravity shares) posts at the full rate; one reaching fewer posts `floor` +
 * (1 - `floor`) x their share / `full` of it (mail for towns beyond is handed over at the railhead and goes on from
 * there), shared out over the towns it reaches by their gravity shares and routed trip factors.
 */
export const MAIL_CAPTURE = { floor: 0.6, full: 0.5 };

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
  /** @deprecated Station construction style belongs to RailPart.mode. */
  mode: 'mainline' | 'metro' | 'lightrail';
  /** earthworks of the common rail formation */
  formation: number;
}

/**
 * One physical track: tight city curves and grades are legal; geometry and the train determine speed.
 * The two ids record only overhead wire. Old ids are aliases for compatibility with saves and other branches.
 */
const TRACK: TrackType = { id: 'standard', name: 'Track', speed: 400, maxGrade: 0.07, minRadius: 3, costPerUnit: 7500, maintPerUnit: 300, electrified: false, mode: 'mainline', formation: 1 };
const WIRED_TRACK: TrackType = { ...TRACK, id: 'electric', electrified: true, costPerUnit: 10000, maintPerUnit: 380 };
export const TRACK_TYPES: Record<string, TrackType> = {
  standard: TRACK,
  electric: WIRED_TRACK,
  /** @deprecated Use electric; high speed is a geometry choice. */
  highspeed: WIRED_TRACK,
  /** @deprecated Use electric and RailPart.mode = 'metro'. */
  metro: WIRED_TRACK,
  /** @deprecated Use electric and RailPart.mode = 'lightrail'. */
  lightrail: WIRED_TRACK,
};

/** Canonical wire state of a rail type, including legacy ids. */
export function trackTypeOf(type?: string): string { return (TRACK_TYPES[type ?? ''] ?? TRACK_TYPES.standard).id; }

/** Overhead wire for existing track (`electrify`): standard -> electric, per unit of track. */
export const ELECTRIFY = { costPerUnit: 2500, from: 'standard', to: 'electric' };

/**
 * Levels a line can be built at (BuildOptions.level): viaduct deck height above the ground beneath, and
 * tunnel depth below the ground above (units, 1 = 10 m).
 */
export const LINE_LEVEL = { height: { min: 1.2, max: 1.8, def: 1.5 }, depth: { min: 1.5, max: 3, def: 2.2 } };

export interface RoadType {
  /** Pedestrians may use country roads as well as streets; false excludes walking. */
  pedestrians?: boolean;
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
